package crawlstrategyruns

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierruns"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// This file ports CrawlStrategyRuntimeService.executeNode and every node
// executor (:358-1032) plus the candidate registry helpers
// (mapDiscoveryCandidates :1050, collectInputCandidates :1034,
// flattenOutputs :1235, dedupeCandidates :1243, pushTrace :1340,
// buildCandidateSnapshot :1350) and the small value readers (:1381-1413).
//
// The registry and the node outputs share *StrategyRunCandidate pointers, so a
// trace appended by a later node is visible through the outputs of the node
// that first discovered the candidate, exactly like the NestJS object graph.

// ---------------------------------------------------------------------------
// ordered node outputs

// nodeOutputs keeps the output-bucket insertion order because Object.values in
// flattenOutputs follows the first insertion of each key.
type nodeOutputs struct {
	keys   []string
	values map[string][]*crawlfrontierruns.StrategyRunCandidate
}

func newNodeOutputs() *nodeOutputs {
	return &nodeOutputs{values: map[string][]*crawlfrontierruns.StrategyRunCandidate{}}
}

func (o *nodeOutputs) set(key string, values []*crawlfrontierruns.StrategyRunCandidate) {
	if o.values == nil {
		o.values = map[string][]*crawlfrontierruns.StrategyRunCandidate{}
	}
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = values
}

func (o *nodeOutputs) get(key string) ([]*crawlfrontierruns.StrategyRunCandidate, bool) {
	if o == nil || o.values == nil {
		return nil, false
	}
	values, ok := o.values[key]
	return values, ok
}

func (o *nodeOutputs) rejected() []*crawlfrontierruns.StrategyRunCandidate {
	values, _ := o.get("rejected")
	return values
}

func (o *nodeOutputs) valuesInOrder() []*crawlfrontierruns.StrategyRunCandidate {
	out := []*crawlfrontierruns.StrategyRunCandidate{}
	if o == nil {
		return out
	}
	for _, key := range o.keys {
		out = append(out, o.values[key]...)
	}
	return out
}

// flattenOutputs ports `Object.values(outputs).flat()` followed by dedupe.
func flattenOutputs(outputs *nodeOutputs) []*crawlfrontierruns.StrategyRunCandidate {
	if outputs == nil {
		return []*crawlfrontierruns.StrategyRunCandidate{}
	}
	return dedupeCandidates(outputs.valuesInOrder())
}

// candidateRegistry mirrors the Map<string, Candidate> registry and its size
// based candidate ids.
type candidateRegistry struct {
	byURL map[string]*crawlfrontierruns.StrategyRunCandidate
	order []string
}

func newCandidateRegistry() *candidateRegistry {
	return &candidateRegistry{byURL: map[string]*crawlfrontierruns.StrategyRunCandidate{}}
}

func (r *candidateRegistry) get(url string) (*crawlfrontierruns.StrategyRunCandidate, bool) {
	candidate, ok := r.byURL[url]
	return candidate, ok
}

func (r *candidateRegistry) set(url string, candidate *crawlfrontierruns.StrategyRunCandidate) {
	if _, exists := r.byURL[url]; !exists {
		r.order = append(r.order, url)
	}
	r.byURL[url] = candidate
}

func (r *candidateRegistry) size() int { return len(r.byURL) }

// nodeExecutionResult is NodeExecutionResult.
type nodeExecutionResult struct {
	outputs *nodeOutputs
	metrics json.RawMessage
}

// executeNode ports executeNode.
func (r *Runtime) executeNode(ctx context.Context, runtime *runtimeContext, node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate, registry *candidateRegistry) (nodeExecutionResult, error) {
	switch node.Type {
	case "seed-discovery":
		return r.executeSeedDiscovery(ctx, runtime, node, registry)
	case "list-discovery":
		return r.executeListDiscovery(ctx, runtime, node, registry)
	case "deep-discovery":
		return r.executeDeepDiscovery(ctx, runtime, node, registry)
	case "url-filter":
		return executeURLFilter(node, inputCandidates), nil
	case "content-filter":
		return r.executeContentFilter(ctx, runtime, node, inputCandidates)
	case "page-type-classifier":
		return r.executePageTypeClassifier(runtime, node, inputCandidates), nil
	case "url-scorer":
		return r.executeURLScorer(runtime, node, inputCandidates), nil
	case "freshness-scorer":
		return r.executeFreshnessScorer(runtime, node, inputCandidates), nil
	case "branch":
		return executeBranch(node, inputCandidates), nil
	case "budget-control":
		return executeBudgetControl(node, inputCandidates), nil
	case "fallback-strategy":
		return r.executeFallbackStrategy(ctx, runtime, node, inputCandidates, registry)
	case "persist-result":
		return executePersistResult(node, inputCandidates), nil
	default:
		outputs := newNodeOutputs()
		outputs.set("default", inputCandidates)
		return nodeExecutionResult{outputs: outputs}, nil
	}
}

func (r *Runtime) executeSeedDiscovery(ctx context.Context, runtime *runtimeContext, node crawlworkflow.WorkflowNode, registry *candidateRegistry) (nodeExecutionResult, error) {
	config := objectOfValue(node.Config)
	mode := "sitemap"
	if stringValueOf(config["mode"]) == "rss" {
		mode = "rss"
	}
	maxURLs := int(toNumberValue(config["maxUrls"], 40))
	seedURL := firstNonEmptyString(stringValueOf(config["seedUrl"]), stringValue(runtime.seedURL), newsSourceURL(runtime))
	domain := stringValueOf(config["domain"])
	if domain == "" {
		domain = resolveOrigin(seedURL)
	}
	pattern := stringValueOf(config["pattern"])
	feedURL := stringValueOf(config["feedUrl"])
	if feedURL == "" {
		feedURL = seedURL
	}

	var discovered []crawlmetadata.DiscoveryCandidate
	var err error
	if mode == "rss" {
		discovered, err = r.discovery.DiscoverRSSCandidates(ctx, crawlmetadata.RSSDiscoveryInput{
			FeedURL: feedURL,
			MaxURLs: intPointerValue(maxURLs),
		})
	} else {
		discovered, err = r.discovery.DiscoverSitemapCandidates(ctx, domain, pattern, intPointerValue(maxURLs))
	}
	if err != nil {
		return nodeExecutionResult{}, err
	}
	outputs := newNodeOutputs()
	outputs.set("default", r.mapDiscoveryCandidates(node.ID, node.Type, discovered, registry))
	return nodeExecutionResult{
		outputs: outputs,
		metrics: rawOf(map[string]any{"mode": mode, "discoveredCount": len(discovered)}),
	}, nil
}

func (r *Runtime) executeListDiscovery(ctx context.Context, runtime *runtimeContext, node crawlworkflow.WorkflowNode, registry *candidateRegistry) (nodeExecutionResult, error) {
	config := objectOfValue(node.Config)
	listURL := firstNonEmptyString(stringValueOf(config["listUrl"]), stringValue(runtime.seedURL), newsSourceURL(runtime))
	maxURLs := int(toNumberValue(config["maxUrls"], 60))
	listMaxPages := int(toNumberValue(config["listMaxPages"], 6))
	listPageConcurrency := int(toNumberValue(config["listPageConcurrency"], 2))
	followPagination := !isStrictFalseValue(config["followPagination"])
	discovered, err := r.discovery.DiscoverListCandidates(ctx, crawlmetadata.ListDiscoveryInput{
		URL:                 listURL,
		Domain:              stringValueOf(config["domain"]),
		Pattern:             stringValueOf(config["pattern"]),
		MaxURLs:             intPointerValue(maxURLs),
		ListMaxPages:        intPointerValue(listMaxPages),
		ListPageConcurrency: intPointerValue(listPageConcurrency),
		FollowPagination:    boolPointerValue(followPagination),
		CrawlOptions:        crawlOptionsOrNil(config["crawlOptions"]),
	})
	if err != nil {
		return nodeExecutionResult{}, err
	}
	outputs := newNodeOutputs()
	outputs.set("default", r.mapDiscoveryCandidates(node.ID, node.Type, discovered, registry))
	return nodeExecutionResult{
		outputs: outputs,
		metrics: rawOf(map[string]any{"discoveredCount": len(discovered)}),
	}, nil
}

func (r *Runtime) executeDeepDiscovery(ctx context.Context, runtime *runtimeContext, node crawlworkflow.WorkflowNode, registry *candidateRegistry) (nodeExecutionResult, error) {
	config := objectOfValue(node.Config)
	seedURL := firstNonEmptyString(stringValueOf(config["seedUrl"]), stringValue(runtime.seedURL), newsSourceURL(runtime))
	maxURLs := int(toNumberValue(config["maxUrls"], 60))
	discovered, err := r.discovery.DiscoverDeepCandidates(ctx, crawlmetadata.DeepDiscoveryInput{
		URL:          seedURL,
		Domain:       stringValueOf(config["domain"]),
		Pattern:      stringValueOf(config["pattern"]),
		Query:        stringValueOf(config["query"]),
		MaxURLs:      intPointerValue(maxURLs),
		Deep:         config["deep"],
		CrawlOptions: crawlOptionsOrNil(config["crawlOptions"]),
	})
	if err != nil {
		return nodeExecutionResult{}, err
	}
	outputs := newNodeOutputs()
	outputs.set("default", r.mapDiscoveryCandidates(node.ID, node.Type, discovered, registry))
	return nodeExecutionResult{
		outputs: outputs,
		metrics: rawOf(map[string]any{"discoveredCount": len(discovered)}),
	}, nil
}

func executeURLFilter(node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) nodeExecutionResult {
	config := objectOfValue(node.Config)
	includePatterns := toStringArrayValue(config["includePatterns"])
	excludePatterns := toStringArrayValue(config["excludePatterns"])
	blockedDomains := toStringArrayValue(config["blockedDomains"])
	allowedHosts := toStringArrayValue(config["allowedHosts"])
	denyKeywords := toStringArrayValue(config["denyKeywords"])

	accepted := []*crawlfrontierruns.StrategyRunCandidate{}
	rejected := []*crawlfrontierruns.StrategyRunCandidate{}
	for _, candidate := range inputCandidates {
		before := buildCandidateSnapshot(candidate)
		reason := resolveURLFilterReason(candidate.URL, includePatterns, excludePatterns, blockedDomains, allowedHosts, denyKeywords)
		if reason != "" {
			candidate.Status = "rejected"
			candidate.RejectedByNodeID = stringPointer(node.ID)
			candidate.RejectedReason = stringPointer(reason)
			pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
				NodeID: node.ID, NodeType: node.Type, Action: "filtered",
				Message: "Rejected by URL filter: " + reason, Accepted: boolPointer(false),
				RuleHits: []string{reason}, RejectedReason: stringPointer(reason),
				BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
			})
			rejected = append(rejected, candidate)
			continue
		}
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "filtered",
			Message: "Accepted by URL filter", Accepted: boolPointer(true),
			BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
		})
		accepted = append(accepted, candidate)
	}
	outputs := newNodeOutputs()
	outputs.set("default", accepted)
	outputs.set("rejected", rejected)
	return nodeExecutionResult{outputs: outputs, metrics: rawOf(map[string]any{"acceptedCount": len(accepted), "rejectedCount": len(rejected)})}
}

func (r *Runtime) executeContentFilter(ctx context.Context, runtime *runtimeContext, node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) (nodeExecutionResult, error) {
	if len(inputCandidates) == 0 {
		outputs := newNodeOutputs()
		outputs.set("default", []*crawlfrontierruns.StrategyRunCandidate{})
		return nodeExecutionResult{outputs: outputs}, nil
	}
	config := objectOfValue(node.Config)
	maxFetch := int(toNumberValue(config["maxFetch"], 20))
	if maxFetch > len(inputCandidates) {
		maxFetch = len(inputCandidates)
	}
	urls := make([]string, 0, maxFetch)
	for index, candidate := range inputCandidates {
		if index >= maxFetch {
			break
		}
		urls = append(urls, candidate.URL)
	}
	concurrency := 4
	if len(urls) < concurrency {
		concurrency = len(urls)
	}
	zero := 0.0
	trueValue := true
	results, err := r.discovery.Service().Extract(ctx, crawlmetadata.ExtractionInput{
		Source:              string(crawlmetadata.SourceURLs),
		URLs:                urls,
		MaxURLs:             intPointerValue(maxFetch),
		Concurrency:         intPointerValue(concurrency),
		Query:               stringValueOf(config["query"]),
		ScoreThreshold:      &zero,
		ExtractOpenGraph:    &trueValue,
		ExtractStandardMeta: &trueValue,
	})
	if err != nil {
		return nodeExecutionResult{}, err
	}
	resultByURL := map[string]crawlmetadata.Result{}
	for _, result := range results {
		resultByURL[result.URL] = result
	}

	accepted := []*crawlfrontierruns.StrategyRunCandidate{}
	rejected := []*crawlfrontierruns.StrategyRunCandidate{}
	for _, candidate := range inputCandidates {
		before := buildCandidateSnapshot(candidate)
		extracted, hasExtracted := resultByURL[candidate.URL]
		if hasExtracted {
			applyMetadataResult(candidate, extracted)
		}
		reason := resolveContentFilterReason(candidate, config)
		if reason != "" {
			candidate.Status = "rejected"
			candidate.RejectedByNodeID = stringPointer(node.ID)
			candidate.RejectedReason = stringPointer(reason)
			pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
				NodeID: node.ID, NodeType: node.Type, Action: "filtered",
				Message: "Rejected by content filter: " + reason, Accepted: boolPointer(false),
				RuleHits: []string{reason}, RejectedReason: stringPointer(reason),
				BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
			})
			rejected = append(rejected, candidate)
			continue
		}
		trace := crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "filtered",
			Message: "Accepted by content filter", Accepted: boolPointer(true),
			BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
		}
		if hasExtracted {
			trace.Details = rawOf(map[string]any{"status": extracted.Status})
		}
		pushTrace(candidate, trace)
		accepted = append(accepted, candidate)
	}
	outputs := newNodeOutputs()
	outputs.set("default", accepted)
	outputs.set("rejected", rejected)
	return nodeExecutionResult{outputs: outputs, metrics: rawOf(map[string]any{
		"extractedCount": len(results), "acceptedCount": len(accepted), "rejectedCount": len(rejected),
	})}, nil
}

func (r *Runtime) executePageTypeClassifier(runtime *runtimeContext, node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) nodeExecutionResult {
	config := objectOfValue(node.Config)
	classifierConfig := ParseProfileConfig(runtime.effectiveProfileConfig)
	if patterns, ok := objectOf(config["urlPatterns"]); ok {
		overrides := map[string][]string{}
		for key, value := range patterns {
			overrides[key] = stringList(value)
		}
		classifierConfig = classifierConfig.WithURLPatterns(overrides)
	}
	if signals, ok := objectOf(config["pageTypeSignals"]); ok {
		overrides := map[string]PageTypeSignal{}
		for key, value := range signals {
			var record map[string]json.RawMessage
			if err := json.Unmarshal(value, &record); err != nil {
				continue
			}
			overrides[key] = PageTypeSignal{Patterns: stringList(record["patterns"]), Keywords: stringList(record["keywords"])}
		}
		classifierConfig = classifierConfig.WithPageTypeSignals(overrides)
	}
	for _, candidate := range inputCandidates {
		before := buildCandidateSnapshot(candidate)
		nextPageType := InferFrontierPageType(candidate.URL, "home", classifierConfig, resolveTimestamp(candidate.PublishedAt))
		candidate.PageType = stringPointer(nextPageType)
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "classified",
			Message: "Classified as " + nextPageType, Accepted: boolPointer(true),
			BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
			Details: rawOf(map[string]any{"pageType": nextPageType}),
		})
	}
	outputs := newNodeOutputs()
	outputs.set("default", inputCandidates)
	return nodeExecutionResult{outputs: outputs}
}

func (r *Runtime) executeURLScorer(runtime *runtimeContext, node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) nodeExecutionResult {
	config := objectOfValue(node.Config)
	scoringConfig := ParseProfileConfig(runtime.effectiveProfileConfig).WithKeywords(toStringArrayValue(config["keywordBoosts"]))
	for _, candidate := range inputCandidates {
		before := buildCandidateSnapshot(candidate)
		previous := valueOrZero(candidate.Score)
		pageType := "article"
		if candidate.PageType != nil && *candidate.PageType != "" {
			pageType = *candidate.PageType
		}
		next := ScoreFrontierCandidate(candidate.URL, pageType, scoringConfig, candidate.Score, candidate.FreshnessScore)
		candidate.Score = floatPointer(next)
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "scored",
			Message:    fmt.Sprintf("URL score %.3f -> %.3f", previous, next),
			Accepted:   boolPointer(true),
			ScoreDelta: floatPointer(roundToFixed(next-previous, 4)), RuleHits: []string{"url_scored"},
			BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
		})
	}
	outputs := newNodeOutputs()
	outputs.set("default", inputCandidates)
	return nodeExecutionResult{outputs: outputs}
}

func (r *Runtime) executeFreshnessScorer(runtime *runtimeContext, node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) nodeExecutionResult {
	config := objectOfValue(node.Config)
	scoringConfig := ParseProfileConfig(runtime.effectiveProfileConfig).WithFreshnessRules(FreshnessRules{
		RecentHours: toNumberValue(config["recentHours"], 24),
		WeekHours:   toNumberValue(config["weekHours"], 24*7),
		MonthHours:  toNumberValue(config["monthHours"], 24*30),
	})
	for _, candidate := range inputCandidates {
		before := buildCandidateSnapshot(candidate)
		previous := valueOrZero(candidate.FreshnessScore)
		next := EstimateFreshnessScore(candidate.URL, scoringConfig)
		candidate.FreshnessScore = floatPointer(next)
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "scored",
			Message:        fmt.Sprintf("Freshness %.3f -> %.3f", previous, next),
			Accepted:       boolPointer(true),
			FreshnessDelta: floatPointer(roundToFixed(next-previous, 4)), RuleHits: []string{"freshness_scored"},
			BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
		})
	}
	outputs := newNodeOutputs()
	outputs.set("default", inputCandidates)
	return nodeExecutionResult{outputs: outputs}
}

func executeBranch(node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) nodeExecutionResult {
	config := objectOfValue(node.Config)
	field := stringValueOf(config["field"])
	if field == "" {
		field = "pageType"
	}
	operator := stringValueOf(config["operator"])
	if operator == "" {
		operator = "equals"
	}
	value := config["value"]
	pass := []*crawlfrontierruns.StrategyRunCandidate{}
	fail := []*crawlfrontierruns.StrategyRunCandidate{}
	for _, candidate := range inputCandidates {
		before := buildCandidateSnapshot(candidate)
		matched := evaluateBranch(candidateFieldValue(candidate, field), operator, value)
		hit := "branch_miss"
		if matched {
			hit = "branch_match"
		}
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "branched",
			Message: branchMessage(matched), Accepted: boolPointer(matched),
			RuleHits: []string{hit}, BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate),
			Details: rawOf(map[string]any{"field": field, "operator": operator, "value": jsonValue(value)}),
		})
		if matched {
			pass = append(pass, candidate)
		} else {
			fail = append(fail, candidate)
		}
	}
	outputs := newNodeOutputs()
	outputs.set("pass", pass)
	outputs.set("fail", fail)
	return nodeExecutionResult{outputs: outputs, metrics: rawOf(map[string]any{"passCount": len(pass), "failCount": len(fail)})}
}

func executeBudgetControl(node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) nodeExecutionResult {
	config := objectOfValue(node.Config)
	minScore := toNumberValue(config["minScore"], 0)
	keepTopK := int(toNumberValue(config["keepTopK"], 20))
	sorted := sortCandidatesByComposite(inputCandidates)
	accepted := []*crawlfrontierruns.StrategyRunCandidate{}
	rejected := []*crawlfrontierruns.StrategyRunCandidate{}
	for index, candidate := range sorted {
		before := buildCandidateSnapshot(candidate)
		composite := compositeScore(candidate)
		belowThreshold := valueOrZero(candidate.Score) < minScore
		beyondBudget := index >= keepTopK
		details := rawOf(map[string]any{"compositeScore": composite, "minScore": minScore, "keepTopK": keepTopK, "rank": index + 1})
		if belowThreshold || beyondBudget {
			reason := "budget_trim"
			if belowThreshold {
				reason = "min_score"
			}
			candidate.Status = "rejected"
			candidate.RejectedByNodeID = stringPointer(node.ID)
			candidate.RejectedReason = stringPointer(reason)
			message := "Rejected by budget trim"
			if belowThreshold {
				message = "Rejected by min score threshold"
			}
			pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
				NodeID: node.ID, NodeType: node.Type, Action: "budgeted", Message: message,
				Accepted: boolPointer(false), RuleHits: []string{reason}, RejectedReason: stringPointer(reason),
				BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate), Details: details,
			})
			rejected = append(rejected, candidate)
			continue
		}
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "budgeted", Message: "Kept by budget control",
			Accepted: boolPointer(true), RuleHits: []string{"kept_by_budget"},
			BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate), Details: details,
		})
		accepted = append(accepted, candidate)
	}
	outputs := newNodeOutputs()
	outputs.set("default", accepted)
	outputs.set("rejected", rejected)
	return nodeExecutionResult{outputs: outputs, metrics: rawOf(map[string]any{"keptCount": len(accepted), "rejectedCount": len(rejected)})}
}

func (r *Runtime) executeFallbackStrategy(ctx context.Context, runtime *runtimeContext, node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate, registry *candidateRegistry) (nodeExecutionResult, error) {
	config := objectOfValue(node.Config)
	activateWhen := stringValueOf(config["activateWhen"])
	if activateWhen == "" {
		activateWhen = "empty"
	}
	shouldRun := activateWhen == "always" || len(inputCandidates) == 0
	if !shouldRun {
		outputs := newNodeOutputs()
		outputs.set("default", inputCandidates)
		return nodeExecutionResult{outputs: outputs}, nil
	}
	mode := stringValueOf(config["mode"])
	if mode == "" {
		mode = "list"
	}
	discoveryType := "list-discovery"
	switch mode {
	case "deep":
		discoveryType = "deep-discovery"
	case "rss", "sitemap":
		discoveryType = "seed-discovery"
	}

	discoveryConfig := map[string]json.RawMessage{}
	seedURL := stringValueOf(config["seedUrl"])
	if seedURL == "" {
		seedURL = stringValue(runtime.seedURL)
	}
	if mode == "list" {
		discoveryConfig["listUrl"] = rawOf(seedURL)
	}
	if mode == "deep" || mode == "rss" || mode == "sitemap" {
		discoveryConfig["seedUrl"] = rawOf(seedURL)
	}
	for key, value := range config {
		discoveryConfig[key] = value
	}
	discoveryNode := crawlworkflow.WorkflowNode{
		ID:       node.ID + "::fallback",
		Type:     discoveryType,
		Label:    node.Label,
		Position: node.Position,
		Config:   rawOf(discoveryConfig),
		UIState:  node.UIState,
	}
	result, err := r.executeNode(ctx, runtime, discoveryNode, []*crawlfrontierruns.StrategyRunCandidate{}, registry)
	if err != nil {
		return nodeExecutionResult{}, err
	}
	fallbackCandidates := flattenOutputs(result.outputs)
	triggerReason := "empty_input"
	if activateWhen == "always" {
		triggerReason = "fallback_always"
	}
	runtime.systemEvents = append(runtime.systemEvents, crawlfrontierruns.StrategyRunEvent{
		Level: "info", EventType: "fallback_strategy_activated",
		NodeID: stringPointer(node.ID), NodeType: stringPointer(node.Type),
		Message: "Fallback strategy activated", TriggerReason: stringPointer(triggerReason),
		BeforeCount: intPointer(len(inputCandidates)), AfterCount: intPointer(len(fallbackCandidates)),
		RescuedCount: intPointer(len(fallbackCandidates)),
		Details:      rawOf(map[string]any{"mode": mode, "activateWhen": activateWhen}),
		Timestamp:    isoNow(r.now()),
	})
	for _, candidate := range fallbackCandidates {
		before := buildCandidateSnapshot(candidate)
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "fallback",
			Message: "Fallback produced candidate via " + mode, Accepted: boolPointer(true),
			RuleHits: []string{"fallback_activated"}, BeforeSnapshot: before,
			AfterSnapshot: buildCandidateSnapshot(candidate),
			Details:       rawOf(map[string]any{"activateWhen": activateWhen, "mode": mode}),
		})
	}
	return result, nil
}

func executePersistResult(node crawlworkflow.WorkflowNode, inputCandidates []*crawlfrontierruns.StrategyRunCandidate) nodeExecutionResult {
	config := objectOfValue(node.Config)
	selectTopK := int(toNumberValue(config["selectTopK"], float64(len(inputCandidates))))
	sorted := sortCandidatesByComposite(inputCandidates)
	selected := []*crawlfrontierruns.StrategyRunCandidate{}
	rejected := []*crawlfrontierruns.StrategyRunCandidate{}
	for index, candidate := range sorted {
		before := buildCandidateSnapshot(candidate)
		composite := compositeScore(candidate)
		details := rawOf(map[string]any{"selectTopK": selectTopK, "rank": index + 1, "compositeScore": composite})
		if index < selectTopK {
			candidate.Status = "selected"
			pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
				NodeID: node.ID, NodeType: node.Type, Action: "persisted",
				Message: "Selected for persistence", Accepted: boolPointer(true),
				RuleHits: []string{"selected_for_persistence"}, BeforeSnapshot: before,
				AfterSnapshot: buildCandidateSnapshot(candidate), Details: details,
			})
			selected = append(selected, candidate)
			continue
		}
		candidate.Status = "rejected"
		candidate.RejectedByNodeID = stringPointer(node.ID)
		candidate.RejectedReason = stringPointer("persist_trim")
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: node.ID, NodeType: node.Type, Action: "persisted",
			Message: "Dropped by persistence limit", Accepted: boolPointer(false),
			RuleHits: []string{"persist_trim"}, RejectedReason: stringPointer("persist_trim"),
			BeforeSnapshot: before, AfterSnapshot: buildCandidateSnapshot(candidate), Details: details,
		})
		rejected = append(rejected, candidate)
	}
	outputs := newNodeOutputs()
	outputs.set("default", selected)
	outputs.set("rejected", rejected)
	return nodeExecutionResult{outputs: outputs, metrics: rawOf(map[string]any{"selectedCount": len(selected), "rejectedCount": len(rejected)})}
}

// mapDiscoveryCandidates ports mapDiscoveryCandidates: the first 500 candidates
// are mapped, an already-registered URL gets a trace and its existing pointer,
// and a new candidate is stored in the registry.
func (r *Runtime) mapDiscoveryCandidates(nodeID, nodeType string, candidates []crawlmetadata.DiscoveryCandidate, registry *candidateRegistry) []*crawlfrontierruns.StrategyRunCandidate {
	limited := candidates
	if len(limited) > 500 {
		limited = limited[:500]
	}
	out := make([]*crawlfrontierruns.StrategyRunCandidate, 0, len(limited))
	for _, entry := range limited {
		if existing, ok := registry.get(entry.URL); ok {
			pushTrace(existing, crawlfrontierruns.StrategyRunTrace{
				NodeID: nodeID, NodeType: nodeType, Action: "discovered",
				Message: "Rediscovered candidate", Accepted: boolPointer(true),
			})
			out = append(out, existing)
			continue
		}
		candidate := &crawlfrontierruns.StrategyRunCandidate{
			ID:             fmt.Sprintf("candidate:%d", registry.size()+1),
			URL:            entry.URL,
			RelevanceScore: entry.RelevanceScore,
			PublishedAt:    isoFromMillis(entry.PublishedAtTs),
			CrawledAt:      isoFromMillis(entry.CrawledAtTs),
			EffectiveAt:    firstISOTimestamp(entry.PublishedAtTs, entry.CrawledAtTs),
			Status:         "active",
			SourceNodeID:   nodeID,
			Metadata:       prefetchedMetadata(entry.PrefetchedArticle),
			Trace:          []crawlfrontierruns.StrategyRunTrace{},
		}
		if entry.PrefetchedArticle != nil {
			candidate.Title = entry.PrefetchedArticle.Title
			candidate.Description = entry.PrefetchedArticle.Description
			candidate.Author = entry.PrefetchedArticle.Author
		}
		beforeSnapshot := buildCandidateSnapshot(&crawlfrontierruns.StrategyRunCandidate{
			URL: entry.URL, Status: "active", RejectedReason: nil,
		})
		pushTrace(candidate, crawlfrontierruns.StrategyRunTrace{
			NodeID: nodeID, NodeType: nodeType, Action: "discovered",
			Message: "Candidate discovered", Accepted: boolPointer(true),
			BeforeSnapshot: beforeSnapshot, AfterSnapshot: buildCandidateSnapshot(candidate),
			Details: rawOf(map[string]any{"relevanceScore": entry.RelevanceScore}),
		})
		registry.set(candidate.URL, candidate)
		out = append(out, candidate)
	}
	return out
}

// applyMetadataResult ports applyMetadataResult.
func applyMetadataResult(candidate *crawlfrontierruns.StrategyRunCandidate, result crawlmetadata.Result) {
	if result.Title != nil {
		candidate.Title = result.Title
	}
	if result.Description != nil {
		candidate.Description = result.Description
	}
	if result.Author != nil {
		candidate.Author = result.Author
	}
	if result.RelevanceScore != nil {
		candidate.RelevanceScore = result.RelevanceScore
	}
	if result.FetchedAt != nil {
		fetchedAt := isoTime(*result.FetchedAt)
		candidate.CrawledAt = &fetchedAt
		if candidate.EffectiveAt == nil {
			candidate.EffectiveAt = &fetchedAt
		}
	}
	candidate.Metadata = mergeCandidateMetadata(candidate.Metadata, map[string]json.RawMessage{
		"metadataStatus": rawOf(result.Status),
		"metaTags":       metaTagsJSON(result.MetaTags),
		"openGraph":      metaTagsJSON(result.OpenGraph),
	})
}

// resolveContentFilterReason ports resolveContentFilterReason.
func resolveContentFilterReason(candidate *crawlfrontierruns.StrategyRunCandidate, config map[string]json.RawMessage) string {
	minRelevanceScore := toNumberValue(config["minRelevanceScore"], 0)
	titleIncludes := toStringArrayValue(config["titleIncludes"])
	descriptionIncludes := toStringArrayValue(config["descriptionIncludes"])
	requireTitle := strings.TrimSpace(string(config["requireTitle"])) == "true"

	if requireTitle && (candidate.Title == nil || strings.TrimSpace(*candidate.Title) == "") {
		return "missing_title"
	}
	if valueOrZero(candidate.RelevanceScore) < minRelevanceScore {
		return "low_relevance"
	}
	if len(titleIncludes) > 0 && !someContains(candidate.Title, titleIncludes) {
		return "title_miss"
	}
	if len(descriptionIncludes) > 0 && !someContains(candidate.Description, descriptionIncludes) {
		return "description_miss"
	}
	return ""
}

func someContains(value *string, terms []string) bool {
	haystack := ""
	if value != nil {
		haystack = strings.ToLower(*value)
	}
	for _, term := range terms {
		if strings.Contains(haystack, strings.ToLower(term)) {
			return true
		}
	}
	return false
}

// resolveURLFilterReason ports resolveUrlFilterReason.
func resolveURLFilterReason(rawURL string, includePatterns, excludePatterns, blockedDomains, allowedHosts, denyKeywords []string) string {
	lower := strings.ToLower(rawURL)
	for _, pattern := range excludePatterns {
		if matchesFrontierPattern(rawURL, pattern) {
			return "exclude_pattern"
		}
	}
	host := resolveHost(rawURL)
	for _, domain := range blockedDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return "blocked_domain"
		}
	}
	if len(allowedHosts) > 0 {
		allowed := false
		for _, entry := range allowedHosts {
			if resolveHost(rawURL) == entry {
				allowed = true
				break
			}
		}
		if !allowed {
			return "host_out_of_scope"
		}
	}
	for _, keyword := range denyKeywords {
		if strings.Contains(lower, strings.ToLower(keyword)) {
			return "deny_keyword"
		}
	}
	if len(includePatterns) > 0 {
		matched := false
		for _, pattern := range includePatterns {
			if matchesFrontierPattern(rawURL, pattern) {
				matched = true
				break
			}
		}
		if !matched {
			return "include_miss"
		}
	}
	return ""
}

var runtimePatternEscape = regexp.MustCompile(`[.+?^${}()|[\]\\]`)

// matchesFrontierPattern ports the runtime's matchesPattern helper.
func matchesFrontierPattern(rawURL, pattern string) bool {
	if strings.TrimSpace(pattern) == "" {
		return false
	}
	escaped := runtimePatternEscape.ReplaceAllStringFunc(pattern, func(match string) string {
		return "\\" + match
	})
	escaped = strings.ReplaceAll(escaped, "*", ".*")
	compiled, err := regexp.Compile("(?i)" + escaped)
	if err != nil {
		return false
	}
	return compiled.MatchString(rawURL)
}

// ---------------------------------------------------------------------------
// candidate snapshots and traces

type candidateSnapshot struct {
	URL            string   `json:"url"`
	PageType       *string  `json:"pageType"`
	Score          *float64 `json:"score"`
	FreshnessScore *float64 `json:"freshnessScore"`
	RelevanceScore *float64 `json:"relevanceScore"`
	Status         *string  `json:"status"`
	RejectedReason *string  `json:"rejectedReason"`
}

func buildCandidateSnapshot(candidate *crawlfrontierruns.StrategyRunCandidate) json.RawMessage {
	snapshot := candidateSnapshot{
		URL:            candidate.URL,
		PageType:       candidate.PageType,
		Score:          finiteOrNil(candidate.Score),
		FreshnessScore: finiteOrNil(candidate.FreshnessScore),
		RelevanceScore: finiteOrNil(candidate.RelevanceScore),
		Status:         stringPointer(candidate.Status),
		RejectedReason: candidate.RejectedReason,
	}
	return rawOf(snapshot)
}

func finiteOrNil(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	return value
}

func pushTrace(candidate *crawlfrontierruns.StrategyRunCandidate, entry crawlfrontierruns.StrategyRunTrace) {
	entry.Timestamp = isoNow(time.Now())
	candidate.Trace = append(candidate.Trace, entry)
}

// ---------------------------------------------------------------------------
// value readers (toString / toStringArray / toNumber)

func stringValueOf(raw json.RawMessage) string {
	var value string
	if len(raw) == 0 {
		return ""
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func toStringArrayValue(raw json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return []string{}
	}
	var values []json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &values); err != nil {
		return []string{}
	}
	out := []string{}
	for _, value := range values {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			continue
		}
		if trimmedText := strings.TrimSpace(text); trimmedText != "" {
			out = append(out, trimmedText)
		}
	}
	return out
}

func toNumberValue(raw json.RawMessage, fallback float64) float64 {
	if value, ok := numberValue(raw); ok {
		return value
	}
	return fallback
}

func objectOfValue(raw json.RawMessage) map[string]json.RawMessage {
	record, ok := objectOf(raw)
	if !ok {
		return map[string]json.RawMessage{}
	}
	return record
}

func jsonValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func crawlOptionsOrNil(raw json.RawMessage) json.RawMessage {
	if _, ok := objectOf(raw); !ok {
		return nil
	}
	return raw
}

func isStrictFalseValue(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "false"
}

// ---------------------------------------------------------------------------
// branch evaluation

func candidateFieldValue(candidate *crawlfrontierruns.StrategyRunCandidate, field string) json.RawMessage {
	switch field {
	case "url":
		return rawOf(candidate.URL)
	case "pageType":
		return rawOf(candidate.PageType)
	case "score":
		return rawOf(candidate.Score)
	case "freshnessScore":
		return rawOf(candidate.FreshnessScore)
	case "relevanceScore":
		return rawOf(candidate.RelevanceScore)
	case "qualityScore":
		return rawOf(candidate.QualityScore)
	case "status":
		return rawOf(candidate.Status)
	case "title":
		return rawOf(candidate.Title)
	case "description":
		return rawOf(candidate.Description)
	case "author":
		return rawOf(candidate.Author)
	case "publishedAt":
		return rawOf(candidate.PublishedAt)
	case "crawledAt":
		return rawOf(candidate.CrawledAt)
	case "effectiveAt":
		return rawOf(candidate.EffectiveAt)
	case "sourceNodeId":
		return rawOf(candidate.SourceNodeID)
	case "rejectedReason":
		return rawOf(candidate.RejectedReason)
	}
	return json.RawMessage("null")
}

func evaluateBranch(target json.RawMessage, operator string, value json.RawMessage) bool {
	switch operator {
	case "gte":
		return toNumberValue(target, math.Inf(-1)) >= toNumberValue(value, 0)
	case "lte":
		return toNumberValue(target, math.Inf(1)) <= toNumberValue(value, 0)
	case "contains":
		return strings.Contains(strings.ToLower(jsStringValue(target)), strings.ToLower(jsStringValue(value)))
	}
	return jsStringValue(target) == jsStringValue(value)
}

// jsStringValue mirrors String(value ?? "").
func jsStringValue(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal([]byte(trimmed), &text); err == nil {
			return text
		}
		return ""
	}
	var value any
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return ""
	}
	switch typed := value.(type) {
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return formatJSNumber(typed)
	case map[string]any:
		return "[object Object]"
	case []any:
		return strings.Join(stringSliceOf(typed), ",")
	default:
		return ""
	}
}

func stringSliceOf(values []any) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, jsStringValue(rawOf(value)))
	}
	return out
}

func formatJSNumber(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return fmt.Sprintf("%.0f", value)
	}
	return fmt.Sprintf("%g", value)
}

func branchMessage(matched bool) string {
	if matched {
		return "Matched branch condition"
	}
	return "Missed branch condition"
}

// ---------------------------------------------------------------------------
// misc helpers

func newsSourceURL(runtime *runtimeContext) string {
	if runtime.newsSource == nil {
		return ""
	}
	return runtime.newsSource.URL
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func resolveOrigin(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func resolveHost(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func resolveTimestamp(value *string) *int64 {
	if value == nil || *value == "" {
		return nil
	}
	if parsed, ok := parseISOTime(*value); ok {
		millis := parsed.UnixMilli()
		return &millis
	}
	return nil
}

func isoFromMillis(millis *int64) *string {
	if millis == nil {
		return nil
	}
	value := time.UnixMilli(*millis).UTC().Format("2006-01-02T15:04:05.000Z")
	return &value
}

func firstISOTimestamp(first, second *int64) *string {
	if value := isoFromMillis(first); value != nil {
		return value
	}
	return isoFromMillis(second)
}

func isoTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func isoNow(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func boolPointer(value bool) *bool { return &value }

func floatPointer(value float64) *float64 { return &value }

func intPointerValue(value int) *int { return &value }

func intPointer(value int) *int { return &value }

func boolPointerValue(value bool) *bool { return &value }

func stringPointerFromValue(value string) *string { return &value }

func prefetchedMetadata(article *crawlmetadata.PrefetchedArticle) json.RawMessage {
	if article == nil {
		return json.RawMessage(`{"prefetchedArticle":null}`)
	}
	encoded, err := json.Marshal(article)
	if err != nil {
		return json.RawMessage(`{"prefetchedArticle":null}`)
	}
	return rawOf(map[string]json.RawMessage{"prefetchedArticle": encoded})
}

func mergeCandidateMetadata(base json.RawMessage, extra map[string]json.RawMessage) json.RawMessage {
	merged := map[string]json.RawMessage{}
	if record, ok := objectOf(base); ok {
		for key, value := range record {
			merged[key] = value
		}
	}
	for key, value := range extra {
		merged[key] = value
	}
	return rawOf(merged)
}

func metaTagsJSON(tags []crawlmetadata.Tag) json.RawMessage {
	encoded, err := json.Marshal(tags)
	if err != nil {
		return json.RawMessage(`[]`)
	}
	return encoded
}
