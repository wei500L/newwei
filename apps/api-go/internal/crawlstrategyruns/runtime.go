package crawlstrategyruns

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// This file ports CrawlStrategyRuntimeService
// (apps/api/src/modules/crawl/crawl-strategy-runtime.service.ts:66-264 and
// :266-1414): trialRunWorkflow, replayRun, the graph traversal and every node
// executor.
//
// Graph semantics: nodes run in the source's topological order (definition order
// when the graph has a cycle), each node receives the candidates of its incoming
// edges de-duplicated by URL (first position, last value), and only the outputs of
// terminal nodes become the run's candidate list — truncated to maxCandidates,
// with the `selected` ones reported separately. A node failure records the failed
// step, fails the run and re-throws.
//
// Request pacing: discovery nodes go through the shared crawlmetadata chain, so
// the crawl4ai concurrency, page caps and time budgets are exactly the ported
// ones. The content-filter node keeps the source's effective behaviour; see
// executeContentFilter for the equivalence note.

// TrialRunInput is TrialRunCrawlStrategyWorkflowDto.
type TrialRunInput struct {
	WorkflowVersionID *string
	ProfileID         *string
	NewsSourceID      *string
	SeedURL           *string
	RunKind           *string
	MaxCandidates     *int
	RuntimeOverrides  json.RawMessage
}

// ReplayInput is ReplayCrawlStrategyWorkflowRunDto.
type ReplayInput struct {
	SeedURL       *string
	ProfileID     *string
	NewsSourceID  *string
	MaxCandidates *int
}

// newsSourceRow is the NewsSource subset the runtime reads.
type newsSourceRow struct {
	ID     string
	OrgID  string
	URL    string
	Name   string
	Config json.RawMessage
}

// profileRow is the CrawlSiteProfile subset the runtime reads.
type profileRow struct {
	ID            string
	OrgID         string
	Name          string
	Description   *string
	MatchHost     string
	ExecutionMode string
	Version       int
	Config        json.RawMessage
}

// runtimeContext is RuntimeContext.
type runtimeContext struct {
	orgID            string
	actorID          string
	runID            string
	definition       crawlworkflow.WorkflowDefinition
	seedURL          string
	newsSource       *newsSourceRow
	config           EffectiveProfileConfig
	parameterSources []any
	systemEvents     []SystemEvent
	maxCandidates    int
}

// nodeExecutionResult is NodeExecutionResult.
type nodeExecutionResult struct {
	outputs nodeOutputs
	metrics json.RawMessage
}

// TrialRun ports trialRunWorkflow.
func (s *Service) TrialRun(ctx context.Context, orgID, actorID, workflowID string, input TrialRunInput) (TrialRunResponse, error) {
	resolved, err := s.workflows.ResolveBoundWorkflowVersion(ctx, orgID, workflowID, deref(input.WorkflowVersionID))
	if err != nil {
		return TrialRunResponse{}, err
	}
	if resolved == nil {
		return TrialRunResponse{}, newStatus(404, "Workflow not found")
	}
	if err := crawlworkflow.AssertSupportedWorkflowDefinition(resolved.Definition, "workflow.definition"); err != nil {
		return TrialRunResponse{}, err
	}

	profile, err := s.resolveProfile(ctx, orgID, deref(input.ProfileID))
	if err != nil {
		return TrialRunResponse{}, err
	}
	newsSource, err := s.resolveNewsSource(ctx, orgID, deref(input.NewsSourceID))
	if err != nil {
		return TrialRunResponse{}, err
	}

	baseExecutionMode := resolved.Definition.Settings.ExecutionMode
	baseConfig, err := crawlprofile.NormalizeConfigJSON(nil)
	if err != nil {
		return TrialRunResponse{}, err
	}
	if profile != nil {
		baseExecutionMode = profile.ExecutionMode
		baseConfig, err = crawlprofile.NormalizeConfigJSON(profile.Config)
		if err != nil {
			return TrialRunResponse{}, err
		}
	}

	overlay, err := s.workflows.CompileProfileOverlay(ctx, orgID, baseExecutionMode, baseConfig, workflowID, resolved.VersionID)
	if err != nil {
		return TrialRunResponse{}, err
	}

	effectiveConfigJSON := json.RawMessage("{}")
	if overlay != nil {
		if profile != nil {
			effectiveConfigJSON, err = crawlprofile.NormalizeConfigJSON(
				crawlworkflow.ApplyProfileOverlay(baseConfig, overlay.ConfigPatch))
		} else {
			effectiveConfigJSON, err = crawlprofile.NormalizeConfigJSON(overlay.ConfigPatch)
		}
		if err != nil {
			return TrialRunResponse{}, err
		}
	}
	effectiveConfig, err := parseEffectiveProfileConfig(effectiveConfigJSON)
	if err != nil {
		return TrialRunResponse{}, err
	}

	parameterSources := []any{}
	if overlay != nil {
		parameterSources = parameterSourcesOf(overlay.ParameterSources)
	}

	seedURL := deref(input.SeedURL)
	if seedURL == "" && newsSource != nil {
		seedURL = newsSource.URL
	}
	runKind := RunKindTrial
	if input.RunKind != nil && *input.RunKind != "" {
		runKind = *input.RunKind
	}
	maxCandidates := 100
	if input.MaxCandidates != nil {
		maxCandidates = *input.MaxCandidates
	}

	startedAt := time.Now().UTC()
	runID, err := s.CreateRun(ctx, createRunInput{
		OrgID:             orgID,
		CreatedByID:       actorID,
		WorkflowID:        &resolved.WorkflowID,
		WorkflowVersionID: &resolved.VersionID,
		WorkflowOrigin:    WorkflowOriginBound,
		ProfileID:         profileIDOrNil(profile),
		NewsSourceID:      newsSourceIDOrNil(newsSource),
		Status:            RunStatusRunning,
		RunKind:           runKind,
		Input:             runInputObject(input, profile, newsSource),
		GraphSnapshot:     marshalJSON(resolved.Definition),
		ParameterSources:  parameterSources,
		StartedAt:         &startedAt,
	})
	if err != nil {
		return TrialRunResponse{}, err
	}

	runContext := &runtimeContext{
		orgID:            orgID,
		actorID:          actorID,
		runID:            runID,
		definition:       resolved.Definition,
		seedURL:          seedURL,
		newsSource:       newsSource,
		config:           effectiveConfig,
		parameterSources: parameterSources,
		systemEvents:     []SystemEvent{},
		maxCandidates:    maxCandidates,
	}

	result, execErr := s.execute(ctx, runContext)
	finishedAt := time.Now().UTC()
	if execErr != nil {
		message := execErr.Error()
		if finalizeErr := s.FinalizeRun(ctx, runID, finalizeRunInput{
			Status:     RunStatusFailed,
			Error:      &message,
			FinishedAt: &finishedAt,
		}); finalizeErr != nil {
			return TrialRunResponse{}, finalizeErr
		}
		return TrialRunResponse{}, execErr
	}

	if err := s.FinalizeRun(ctx, runID, finalizeRunInput{
		Status:           RunStatusCompleted,
		Output:           marshalJSON(runOutput{SelectedCount: len(result.SelectedCandidates), CandidateCount: len(result.Candidates)}),
		Steps:            result.Steps,
		Candidates:       result.Candidates,
		ParameterSources: result.ParameterSources,
		Events:           result.SystemEvents,
		FinishedAt:       &finishedAt,
	}); err != nil {
		return TrialRunResponse{}, err
	}

	return TrialRunResponse{
		RunID: runID,
		Workflow: TrialRunWorkflow{
			ID:        resolved.WorkflowID,
			Name:      resolved.WorkflowName,
			VersionID: resolved.VersionID,
			Version:   resolved.Version,
		},
		Definition:         result.Definition,
		Steps:              result.Steps,
		Candidates:         result.Candidates,
		SelectedCandidates: result.SelectedCandidates,
		ParameterSources:   result.ParameterSources,
		SystemEvents:       result.SystemEvents,
	}, nil
}

// runOutput is the completed run's output object.
type runOutput struct {
	SelectedCount  int `json:"selectedCount"`
	CandidateCount int `json:"candidateCount"`
}

// Replay ports replayRun.
func (s *Service) Replay(ctx context.Context, orgID, actorID, runID string, input ReplayInput) (TrialRunResponse, error) {
	existing, err := s.loadRunForReplay(ctx, runID)
	if err != nil {
		return TrialRunResponse{}, err
	}
	if existing.OrgID != orgID {
		return TrialRunResponse{}, errWorkflowRunMissing
	}

	workflowID := ""
	if existing.WorkflowID != nil {
		workflowID = *existing.WorkflowID
	}
	if existing.WorkflowOrigin == WorkflowOriginLegacyBridge || workflowID == "" {
		return TrialRunResponse{}, newStatus(404,
			"Legacy bridge workflow runs are observable but cannot be replayed until they are bound to a published workflow version")
	}
	workflowVersionID := ""
	if existing.WorkflowVersionID != nil {
		workflowVersionID = *existing.WorkflowVersionID
	}
	if workflowVersionID == "" {
		workflowVersionID = deref(inputString(existing.Input, "workflowVersionId"))
		if workflowVersionID == "" {
			return TrialRunResponse{}, newStatus(404, "Workflow run version not found")
		}
	}

	seedURL := input.SeedURL
	if seedURL == nil {
		seedURL = inputString(existing.Input, "seedUrl")
	}
	profileID := input.ProfileID
	if profileID == nil {
		profileID = inputString(existing.Input, "profileId")
	}
	newsSourceID := input.NewsSourceID
	if newsSourceID == nil {
		newsSourceID = inputString(existing.Input, "newsSourceId")
	}
	maxCandidates := input.MaxCandidates
	if maxCandidates == nil {
		maxCandidates = inputInt(existing.Input, "maxCandidates")
	}

	return s.TrialRun(ctx, orgID, actorID, workflowID, TrialRunInput{
		WorkflowVersionID: &workflowVersionID,
		SeedURL:           seedURL,
		ProfileID:         profileID,
		NewsSourceID:      newsSourceID,
		MaxCandidates:     maxCandidates,
		RunKind:           stringPointer(RunKindTrial),
	})
}

// execute is the graph traversal.
func (s *Service) execute(ctx context.Context, run *runtimeContext) (RunResult, error) {
	order := topologicalSort(run.definition)
	nodeByID := map[string]crawlworkflow.WorkflowNode{}
	for _, node := range run.definition.Nodes {
		nodeByID[node.ID] = node
	}
	incoming := map[string][]crawlworkflow.WorkflowEdge{}
	for _, edge := range run.definition.Edges {
		incoming[edge.Target] = append(incoming[edge.Target], edge)
	}

	outputs := map[string]nodeOutputs{}
	steps := []Step{}
	registry := map[string]*Candidate{}
	registryOrder := []string{}

	for _, nodeID := range order {
		node, ok := nodeByID[nodeID]
		if !ok {
			continue
		}
		inputCandidates := collectInputCandidates(incoming[nodeID], outputs)
		start := time.Now()
		result, err := s.executeNode(ctx, run, node, inputCandidates, registry, &registryOrder)
		durationMs := int(time.Since(start).Milliseconds())
		if err != nil {
			message := err.Error()
			steps = append(steps, Step{
				NodeID:        node.ID,
				NodeType:      node.Type,
				Label:         node.Label,
				Status:        RunStatusFailed,
				DurationMs:    durationMs,
				InputCount:    len(inputCandidates),
				OutputCount:   0,
				RejectedCount: 0,
				SampleURLs:    []string{},
				Error:         &message,
			})
			return RunResult{}, err
		}
		outputs[node.ID] = result.outputs
		flat := result.outputs.flatten()
		sampleURLs := []string{}
		for index, candidate := range flat {
			if index >= 5 {
				break
			}
			sampleURLs = append(sampleURLs, candidate.URL)
		}
		steps = append(steps, Step{
			NodeID:        node.ID,
			NodeType:      node.Type,
			Label:         node.Label,
			Status:        RunStatusCompleted,
			DurationMs:    durationMs,
			InputCount:    len(inputCandidates),
			OutputCount:   len(flat),
			RejectedCount: result.outputs.countRejected(),
			SampleURLs:    sampleURLs,
			Metrics:       result.metrics,
		})
	}

	terminalIDs := []string{}
	for _, node := range run.definition.Nodes {
		isSource := false
		for _, edge := range run.definition.Edges {
			if edge.Source == node.ID {
				isSource = true
				break
			}
		}
		if !isSource {
			terminalIDs = append(terminalIDs, node.ID)
		}
	}
	collected := []*Candidate{}
	for _, nodeID := range terminalIDs {
		if output, ok := outputs[nodeID]; ok {
			collected = append(collected, output.flatten()...)
		}
	}
	finalCandidates := dedupeCandidates(collected)
	if len(finalCandidates) > run.maxCandidates {
		finalCandidates = finalCandidates[:run.maxCandidates]
	}
	selected := []*Candidate{}
	for _, candidate := range finalCandidates {
		if candidate.Status == CandidateStatusSelected {
			selected = append(selected, candidate)
		}
	}

	return RunResult{
		Definition:         marshalJSON(run.definition),
		Steps:              steps,
		Candidates:         dereference(finalCandidates),
		SelectedCandidates: dereference(selected),
		ParameterSources:   run.parameterSources,
		SystemEvents:       run.systemEvents,
	}, nil
}

// executeNode dispatches one node type.
func (s *Service) executeNode(ctx context.Context, run *runtimeContext, node crawlworkflow.WorkflowNode, inputCandidates []*Candidate, registry map[string]*Candidate, registryOrder *[]string) (nodeExecutionResult, error) {
	config, _ := rawObject(node.Config)
	switch node.Type {
	case NodeTypeSeedDiscovery:
		return s.executeSeedDiscovery(ctx, run, node, config, registry, registryOrder)
	case NodeTypeListDiscovery:
		return s.executeListDiscovery(ctx, run, node, config, registry, registryOrder)
	case NodeTypeDeepDiscovery:
		return s.executeDeepDiscovery(ctx, run, node, config, registry, registryOrder)
	case NodeTypeURLFilter:
		return executeURLFilter(node, config, inputCandidates), nil
	case NodeTypeContentFilter:
		return s.executeContentFilter(ctx, node, config, inputCandidates)
	case NodeTypePageTypeClassifier:
		return executePageTypeClassifier(run, node, config, inputCandidates), nil
	case NodeTypeURLScorer:
		return executeURLScorer(run, node, config, inputCandidates), nil
	case NodeTypeFreshnessScorer:
		return executeFreshnessScorer(run, node, config, inputCandidates), nil
	case NodeTypeBranch:
		return executeBranch(node, config, inputCandidates), nil
	case NodeTypeBudgetControl:
		return executeBudgetControl(node, config, inputCandidates), nil
	case NodeTypeFallbackStrategy:
		return s.executeFallbackStrategy(ctx, run, node, config, inputCandidates, registry, registryOrder)
	case NodeTypePersistResult:
		return executePersistResult(node, config, inputCandidates), nil
	default:
		return singleOutput(inputCandidates), nil
	}
}

// seedDiscoveryMetrics is the seed node's metrics object.
type seedDiscoveryMetrics struct {
	Mode            string `json:"mode"`
	DiscoveredCount int    `json:"discoveredCount"`
}

// discoveryMetrics is the list/deep node's metrics object.
type discoveryMetrics struct {
	DiscoveredCount int `json:"discoveredCount"`
}

// executeSeedDiscovery ports executeSeedDiscovery (RSS or sitemap).
func (s *Service) executeSeedDiscovery(ctx context.Context, run *runtimeContext, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, registry map[string]*Candidate, registryOrder *[]string) (nodeExecutionResult, error) {
	mode := "sitemap"
	if value, ok := rawStringValue(config["mode"]); ok && value == "rss" {
		mode = "rss"
	}
	maxURLs := rawIntOr(config["maxUrls"], 40)
	seedURL := firstNonEmptyString(rawOptionalString(config["seedUrl"]), run.seedURL, newsSourceURL(run))
	domain := rawOptionalString(config["domain"])
	if domain == "" {
		domain = originOf(seedURL)
	}
	pattern := rawOptionalString(config["pattern"])
	feedURL := rawOptionalString(config["feedUrl"])
	if feedURL == "" {
		feedURL = seedURL
	}
	discovery := s.discoveryService
	if discovery == nil {
		return nodeExecutionResult{}, errDiscoveryUnavailable
	}

	var (
		discovered []crawlmetadata.DiscoveryCandidate
		err        error
	)
	if mode == "rss" {
		discovered, err = discovery.DiscoverRSSCandidates(ctx, crawlmetadata.RSSDiscoveryInput{
			FeedURL: feedURL,
			MaxURLs: intPointer(maxURLs),
		})
	} else {
		discovered, err = discovery.DiscoverSitemapCandidates(ctx, domain, pattern, intPointer(maxURLs))
	}
	if err != nil {
		return nodeExecutionResult{}, err
	}
	result := singleOutput(mapDiscoveryCandidates(node.ID, node.Type, discovered, registry, registryOrder))
	result.metrics = marshalJSON(seedDiscoveryMetrics{Mode: mode, DiscoveredCount: len(discovered)})
	return result, nil
}

// executeListDiscovery ports executeListDiscovery.
func (s *Service) executeListDiscovery(ctx context.Context, run *runtimeContext, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, registry map[string]*Candidate, registryOrder *[]string) (nodeExecutionResult, error) {
	discovery := s.discoveryService
	if discovery == nil {
		return nodeExecutionResult{}, errDiscoveryUnavailable
	}
	listURL := firstNonEmptyString(rawOptionalString(config["listUrl"]), run.seedURL, newsSourceURL(run))
	discovered, err := discovery.DiscoverListCandidates(ctx, crawlmetadata.ListDiscoveryInput{
		URL:                 listURL,
		Domain:              rawOptionalString(config["domain"]),
		Pattern:             rawOptionalString(config["pattern"]),
		MaxURLs:             intPointer(rawIntOr(config["maxUrls"], 60)),
		ListMaxPages:        intPointer(rawIntOr(config["listMaxPages"], 6)),
		ListPageConcurrency: intPointer(rawIntOr(config["listPageConcurrency"], 2)),
		FollowPagination:    rawBoolOr(config["followPagination"], true),
		CrawlOptions:        config["crawlOptions"],
	})
	if err != nil {
		return nodeExecutionResult{}, err
	}
	result := singleOutput(mapDiscoveryCandidates(node.ID, node.Type, discovered, registry, registryOrder))
	result.metrics = marshalJSON(discoveryMetrics{DiscoveredCount: len(discovered)})
	return result, nil
}

// executeDeepDiscovery ports executeDeepDiscovery.
func (s *Service) executeDeepDiscovery(ctx context.Context, run *runtimeContext, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, registry map[string]*Candidate, registryOrder *[]string) (nodeExecutionResult, error) {
	discovery := s.discoveryService
	if discovery == nil {
		return nodeExecutionResult{}, errDiscoveryUnavailable
	}
	seedURL := firstNonEmptyString(rawOptionalString(config["seedUrl"]), run.seedURL, newsSourceURL(run))
	discovered, err := discovery.DiscoverDeepCandidates(ctx, crawlmetadata.DeepDiscoveryInput{
		URL:          seedURL,
		Domain:       rawOptionalString(config["domain"]),
		Pattern:      rawOptionalString(config["pattern"]),
		Query:        rawOptionalString(config["query"]),
		MaxURLs:      intPointer(rawIntOr(config["maxUrls"], 60)),
		RawDeep:      config["deep"],
		CrawlOptions: config["crawlOptions"],
	})
	if err != nil {
		return nodeExecutionResult{}, err
	}
	result := singleOutput(mapDiscoveryCandidates(node.ID, node.Type, discovered, registry, registryOrder))
	result.metrics = marshalJSON(discoveryMetrics{DiscoveredCount: len(discovered)})
	return result, nil
}

// errDiscoveryUnavailable is returned when the runtime was built without the
// discovery chain (misconfiguration, never a legacy-mode request).
var errDiscoveryUnavailable = newStatus(503, "Crawl discovery is not configured")

// filterMetrics is the url/content filter metrics object.
type filterMetrics struct {
	ExtractedCount int `json:"extractedCount,omitempty"`
	AcceptedCount  int `json:"acceptedCount"`
	RejectedCount  int `json:"rejectedCount"`
}

// executeURLFilter ports executeUrlFilter.
func executeURLFilter(node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) nodeExecutionResult {
	includePatterns := rawStringArray(config["includePatterns"])
	excludePatterns := rawStringArray(config["excludePatterns"])
	blockedDomains := rawStringArray(config["blockedDomains"])
	allowedHosts := rawStringArray(config["allowedHosts"])
	denyKeywords := rawStringArray(config["denyKeywords"])
	accepted := []*Candidate{}
	rejected := []*Candidate{}

	for _, candidate := range inputCandidates {
		before := snapshotOf(candidate)
		reason := resolveURLFilterReason(candidate.URL, includePatterns, excludePatterns, blockedDomains, allowedHosts, denyKeywords)
		if reason != "" {
			candidate.Status = CandidateStatusRejected
			candidate.RejectedByNodeID = stringPointer(node.ID)
			candidate.RejectedReason = stringPointer(reason)
			pushTrace(candidate, Trace{
				NodeID:         node.ID,
				NodeType:       node.Type,
				Action:         TraceActionFiltered,
				Message:        "Rejected by URL filter: " + reason,
				Accepted:       boolPointer(false),
				RuleHits:       []string{reason},
				RejectedReason: stringPointer(reason),
				BeforeSnapshot: before,
				AfterSnapshot:  snapshotOf(candidate),
			})
			rejected = append(rejected, candidate)
			continue
		}
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionFiltered,
			Message:        "Accepted by URL filter",
			Accepted:       boolPointer(true),
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
		})
		accepted = append(accepted, candidate)
	}

	output := newNodeOutputs()
	output.set("default", accepted)
	output.set("rejected", rejected)
	result := nodeExecutionResult{outputs: output}
	result.metrics = marshalJSON(filterMetrics{AcceptedCount: len(accepted), RejectedCount: len(rejected)})
	return result
}

// executeContentFilter ports executeContentFilter.
//
// Intentional equivalence note: the source calls metadata.extract({urls, ...})
// WITHOUT `source`, so normalizeInput treats it as "sitemap" and resolveUrls has
// no domain and returns [] — the node never fetches a page and applies its
// title/description/relevance filters to the discovery-time metadata only.
// Passing source:"urls" here would start up to maxFetch real page fetches per run,
// which would raise the outbound request volume above the source's, so this port
// keeps the effective behaviour and reports the discovered pages as "accepted"
// exactly like NestJS. The finding is documented in the PR; fixing it is a
// product decision that also changes the request budget.
func (s *Service) executeContentFilter(ctx context.Context, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) (nodeExecutionResult, error) {
	if len(inputCandidates) == 0 {
		return singleOutput(nil), nil
	}
	extractor := (*crawlmetadata.Service)(nil)
	if s.discoveryService != nil {
		extractor = s.discoveryService.Extractor()
	}
	if extractor == nil {
		return nodeExecutionResult{}, errDiscoveryUnavailable
	}
	maxFetch := minInt(rawIntOr(config["maxFetch"], 20), len(inputCandidates))
	urls := make([]string, 0, maxFetch)
	for index, candidate := range inputCandidates {
		if index >= maxFetch {
			break
		}
		urls = append(urls, candidate.URL)
	}
	// source stays "sitemap" (the source's effective value) and domain is empty,
	// so Extract returns no results and no page is fetched.
	results, err := extractor.Extract(ctx, crawlmetadata.ExtractionInput{
		Source:              string(crawlmetadata.SourceSitemap),
		URLs:                urls,
		MaxURLs:             intPointer(maxFetch),
		Concurrency:         intPointer(minInt(4, len(urls))),
		Query:               rawOptionalString(config["query"]),
		ExtractOpenGraph:    boolPointer(true),
		ExtractStandardMeta: boolPointer(true),
	})
	if err != nil {
		return nodeExecutionResult{}, err
	}
	resultByURL := map[string]crawlmetadata.Result{}
	for _, entry := range results {
		resultByURL[entry.URL] = entry
	}
	accepted := []*Candidate{}
	rejected := []*Candidate{}
	for _, candidate := range inputCandidates {
		before := snapshotOf(candidate)
		extracted, ok := resultByURL[candidate.URL]
		if ok {
			applyMetadataResult(candidate, extracted)
		}
		reason := resolveContentFilterReason(candidate, config)
		if reason != "" {
			candidate.Status = CandidateStatusRejected
			candidate.RejectedByNodeID = stringPointer(node.ID)
			candidate.RejectedReason = stringPointer(reason)
			pushTrace(candidate, Trace{
				NodeID:         node.ID,
				NodeType:       node.Type,
				Action:         TraceActionFiltered,
				Message:        "Rejected by content filter: " + reason,
				Accepted:       boolPointer(false),
				RuleHits:       []string{reason},
				RejectedReason: stringPointer(reason),
				BeforeSnapshot: before,
				AfterSnapshot:  snapshotOf(candidate),
			})
			rejected = append(rejected, candidate)
			continue
		}
		trace := Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionFiltered,
			Message:        "Accepted by content filter",
			Accepted:       boolPointer(true),
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
		}
		if ok {
			trace.Details = marshalJSON(contentFilterDetails{Status: extracted.Status})
		}
		pushTrace(candidate, trace)
		accepted = append(accepted, candidate)
	}

	output := newNodeOutputs()
	output.set("default", accepted)
	output.set("rejected", rejected)
	result := nodeExecutionResult{outputs: output}
	result.metrics = marshalJSON(filterMetrics{
		ExtractedCount: len(results),
		AcceptedCount:  len(accepted),
		RejectedCount:  len(rejected),
	})
	return result, nil
}

// contentFilterDetails is the accepted trace's details object.
type contentFilterDetails struct {
	Status string `json:"status"`
}

// pageTypeDetails is the classified trace's details object.
type pageTypeDetails struct {
	PageType string `json:"pageType"`
}

// executePageTypeClassifier ports executePageTypeClassifier.
func executePageTypeClassifier(run *runtimeContext, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) nodeExecutionResult {
	classifierConfig := run.config
	if _, ok := rawObject(config["urlPatterns"]); ok {
		patterns := map[string][]string{}
		for key, value := range classifierConfig.URLPatterns {
			patterns[key] = value
		}
		for key, list := range rawStringMap(config["urlPatterns"]) {
			patterns[key] = list
		}
		classifierConfig.URLPatterns = patterns
	}
	if _, ok := rawObject(config["pageTypeSignals"]); ok {
		signals := map[string]PageTypeSignal{}
		for key, value := range classifierConfig.PageTypeSignals {
			signals[key] = value
		}
		for key, signal := range rawPageTypeSignals(config["pageTypeSignals"]) {
			signals[key] = signal
		}
		classifierConfig.PageTypeSignals = signals
	}

	for _, candidate := range inputCandidates {
		before := snapshotOf(candidate)
		next := inferPageType(candidate.URL, PageTypeHome, classifierConfig, parseISOMillis(candidate.PublishedAt))
		candidate.PageType = stringPointer(next)
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionClassified,
			Message:        "Classified as " + next,
			Accepted:       boolPointer(true),
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
			Details:        marshalJSON(pageTypeDetails{PageType: next}),
		})
	}
	return singleOutput(inputCandidates)
}

// executeURLScorer ports executeUrlScorer.
func executeURLScorer(run *runtimeContext, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) nodeExecutionResult {
	scoringConfig := run.config
	keywords := rawStringArray(config["keywordBoosts"])
	scoringConfig.Keywords = keywords
	scoringConfig.PriorityKeywords = keywords

	for _, candidate := range inputCandidates {
		before := snapshotOf(candidate)
		previous := 0.0
		if candidate.Score != nil {
			previous = *candidate.Score
		}
		pageType := PageTypeArticle
		if candidate.PageType != nil {
			pageType = *candidate.PageType
		}
		next := scoreCandidate(candidate.URL, pageType, scoringConfig, candidate.Score, candidate.FreshnessScore)
		candidate.Score = &next
		delta := roundToDigits(next-previous, 4)
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionScored,
			Message:        "URL score " + formatFloat(previous, 3) + " -> " + formatFloat(next, 3),
			Accepted:       boolPointer(true),
			ScoreDelta:     &delta,
			RuleHits:       []string{"url_scored"},
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
		})
	}
	return singleOutput(inputCandidates)
}

// executeFreshnessScorer ports executeFreshnessScorer.
func executeFreshnessScorer(run *runtimeContext, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) nodeExecutionResult {
	rules := &FreshnessRules{
		RecentHours: rawNumberOr(config["recentHours"], 24),
		WeekHours:   rawNumberOr(config["weekHours"], 24*7),
		MonthHours:  rawNumberOr(config["monthHours"], 24*30),
	}
	for _, candidate := range inputCandidates {
		before := snapshotOf(candidate)
		previous := 0.0
		if candidate.FreshnessScore != nil {
			previous = *candidate.FreshnessScore
		}
		next := estimateFreshness(candidate.URL, rules)
		candidate.FreshnessScore = &next
		delta := roundToDigits(next-previous, 4)
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionScored,
			Message:        "Freshness " + formatFloat(previous, 3) + " -> " + formatFloat(next, 3),
			Accepted:       boolPointer(true),
			FreshnessDelta: &delta,
			RuleHits:       []string{"freshness_scored"},
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
		})
	}
	return singleOutput(inputCandidates)
}

// branchDetails is the branch trace's details object.
type branchDetails struct {
	Field    string          `json:"field"`
	Operator string          `json:"operator"`
	Value    json.RawMessage `json:"value"`
}

// branchMetrics is the branch node's metrics object.
type branchMetrics struct {
	PassCount int `json:"passCount"`
	FailCount int `json:"failCount"`
}

// executeBranch ports executeBranch.
func executeBranch(node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) nodeExecutionResult {
	field := rawOptionalString(config["field"])
	if field == "" {
		field = "pageType"
	}
	operator := rawOptionalString(config["operator"])
	if operator == "" {
		operator = "equals"
	}
	value := config["value"]
	pass := []*Candidate{}
	fail := []*Candidate{}
	for _, candidate := range inputCandidates {
		before := snapshotOf(candidate)
		matched := evaluateBranch(candidateFieldValue(candidate, field), operator, value)
		ruleHit := "branch_miss"
		message := "Missed branch condition"
		if matched {
			ruleHit = "branch_match"
			message = "Matched branch condition"
		}
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionBranched,
			Message:        message,
			Accepted:       boolPointer(matched),
			RuleHits:       []string{ruleHit},
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
			Details:        marshalJSON(branchDetails{Field: field, Operator: operator, Value: value}),
		})
		if matched {
			pass = append(pass, candidate)
			continue
		}
		fail = append(fail, candidate)
	}
	output := newNodeOutputs()
	output.set("pass", pass)
	output.set("fail", fail)
	result := nodeExecutionResult{outputs: output}
	result.metrics = marshalJSON(branchMetrics{PassCount: len(pass), FailCount: len(fail)})
	return result
}

// budgetDetails is the budget/persist trace details object.
type budgetDetails struct {
	CompositeScore float64 `json:"compositeScore"`
	MinScore       float64 `json:"minScore,omitempty"`
	KeepTopK       int     `json:"keepTopK,omitempty"`
	SelectTopK     int     `json:"selectTopK,omitempty"`
	Rank           int     `json:"rank"`
}

// budgetMetrics is the budget/persist node metrics object.
type budgetMetrics struct {
	KeptCount     int `json:"keptCount,omitempty"`
	SelectedCount int `json:"selectedCount,omitempty"`
	RejectedCount int `json:"rejectedCount"`
}

// executeBudgetControl ports executeBudgetControl.
func executeBudgetControl(node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) nodeExecutionResult {
	minScore := rawNumberOr(config["minScore"], 0)
	keepTopK := rawIntOr(config["keepTopK"], 20)
	sorted := sortedByComposite(inputCandidates)
	accepted := []*Candidate{}
	rejected := []*Candidate{}

	for index, candidate := range sorted {
		before := snapshotOf(candidate)
		composite := compositeScore(candidate)
		belowThreshold := toNumberOr(candidate.Score, 0) < minScore
		beyondBudget := index >= keepTopK
		if belowThreshold || beyondBudget {
			reason := "budget_trim"
			message := "Rejected by budget trim"
			if belowThreshold {
				reason = "min_score"
				message = "Rejected by min score threshold"
			}
			candidate.Status = CandidateStatusRejected
			candidate.RejectedByNodeID = stringPointer(node.ID)
			candidate.RejectedReason = stringPointer(reason)
			pushTrace(candidate, Trace{
				NodeID:         node.ID,
				NodeType:       node.Type,
				Action:         TraceActionBudgeted,
				Message:        message,
				Accepted:       boolPointer(false),
				RuleHits:       []string{reason},
				RejectedReason: stringPointer(reason),
				BeforeSnapshot: before,
				AfterSnapshot:  snapshotOf(candidate),
				Details:        marshalJSON(budgetDetails{CompositeScore: composite, MinScore: minScore, KeepTopK: keepTopK, Rank: index + 1}),
			})
			rejected = append(rejected, candidate)
			continue
		}
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionBudgeted,
			Message:        "Kept by budget control",
			Accepted:       boolPointer(true),
			RuleHits:       []string{"kept_by_budget"},
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
			Details:        marshalJSON(budgetDetails{CompositeScore: composite, MinScore: minScore, KeepTopK: keepTopK, Rank: index + 1}),
		})
		accepted = append(accepted, candidate)
	}

	output := newNodeOutputs()
	output.set("default", accepted)
	output.set("rejected", rejected)
	result := nodeExecutionResult{outputs: output}
	result.metrics = marshalJSON(budgetMetrics{KeptCount: len(accepted), RejectedCount: len(rejected)})
	return result
}

// executePersistResult ports executePersistResult.
func executePersistResult(node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate) nodeExecutionResult {
	selectTopK := rawIntOr(config["selectTopK"], len(inputCandidates))
	sorted := sortedByComposite(inputCandidates)
	selected := []*Candidate{}
	rejected := []*Candidate{}
	for index, candidate := range sorted {
		before := snapshotOf(candidate)
		composite := compositeScore(candidate)
		details := budgetDetails{CompositeScore: composite, SelectTopK: selectTopK, Rank: index + 1}
		if index < selectTopK {
			candidate.Status = CandidateStatusSelected
			pushTrace(candidate, Trace{
				NodeID:         node.ID,
				NodeType:       node.Type,
				Action:         TraceActionPersisted,
				Message:        "Selected for persistence",
				Accepted:       boolPointer(true),
				RuleHits:       []string{"selected_for_persistence"},
				BeforeSnapshot: before,
				AfterSnapshot:  snapshotOf(candidate),
				Details:        marshalJSON(details),
			})
			selected = append(selected, candidate)
			continue
		}
		candidate.Status = CandidateStatusRejected
		candidate.RejectedByNodeID = stringPointer(node.ID)
		candidate.RejectedReason = stringPointer("persist_trim")
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionPersisted,
			Message:        "Dropped by persistence limit",
			Accepted:       boolPointer(false),
			RuleHits:       []string{"persist_trim"},
			RejectedReason: stringPointer("persist_trim"),
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
			Details:        marshalJSON(details),
		})
		rejected = append(rejected, candidate)
	}

	output := newNodeOutputs()
	output.set("default", selected)
	output.set("rejected", rejected)
	result := nodeExecutionResult{outputs: output}
	result.metrics = marshalJSON(budgetMetrics{SelectedCount: len(selected), RejectedCount: len(rejected)})
	return result
}

// fallbackDetails is the fallback trace details object.
type fallbackDetails struct {
	ActivateWhen string `json:"activateWhen"`
	Mode         string `json:"mode"`
}

// fallbackEventDetails is the fallback system event's details object.
type fallbackEventDetails struct {
	Mode         string `json:"mode"`
	ActivateWhen string `json:"activateWhen"`
}

// executeFallbackStrategy ports executeFallbackStrategy.
func (s *Service) executeFallbackStrategy(ctx context.Context, run *runtimeContext, node crawlworkflow.WorkflowNode, config map[string]json.RawMessage, inputCandidates []*Candidate, registry map[string]*Candidate, registryOrder *[]string) (nodeExecutionResult, error) {
	activateWhen := rawOptionalString(config["activateWhen"])
	if activateWhen == "" {
		activateWhen = "empty"
	}
	shouldRun := activateWhen == "always" || len(inputCandidates) == 0
	if !shouldRun {
		return singleOutput(inputCandidates), nil
	}
	mode := rawOptionalString(config["mode"])
	if mode == "" {
		mode = "list"
	}
	discoveryNode := node
	discoveryNode.ID = node.ID + "::fallback"
	switch mode {
	case "deep":
		discoveryNode.Type = NodeTypeDeepDiscovery
	case "rss", "sitemap":
		discoveryNode.Type = NodeTypeSeedDiscovery
	default:
		discoveryNode.Type = NodeTypeListDiscovery
	}
	fallbackConfig := map[string]json.RawMessage{}
	for key, value := range config {
		fallbackConfig[key] = value
	}
	seed := rawOptionalString(config["seedUrl"])
	if seed == "" {
		seed = run.seedURL
	}
	switch mode {
	case "list":
		fallbackConfig["listUrl"] = marshalJSON(seed)
	case "deep", "rss", "sitemap":
		fallbackConfig["seedUrl"] = marshalJSON(seed)
	}
	discoveryNode.Config = marshalJSON(rawJSONMap(fallbackConfig))

	result, err := s.executeNode(ctx, run, discoveryNode, []*Candidate{}, registry, registryOrder)
	if err != nil {
		return nodeExecutionResult{}, err
	}
	fallbackCandidates := result.outputs.flatten()
	triggerReason := "empty_input"
	if activateWhen == "always" {
		triggerReason = "fallback_always"
	}
	run.systemEvents = append(run.systemEvents, SystemEvent{
		Level:         "info",
		EventType:     "fallback_strategy_activated",
		NodeID:        &node.ID,
		NodeType:      &node.Type,
		Message:       "Fallback strategy activated",
		TriggerReason: &triggerReason,
		BeforeCount:   intPointer(len(inputCandidates)),
		AfterCount:    intPointer(len(fallbackCandidates)),
		RescuedCount:  intPointer(len(fallbackCandidates)),
		Details:       marshalJSON(fallbackEventDetails{Mode: mode, ActivateWhen: activateWhen}),
		Timestamp:     isoNow(time.Now().UnixMilli()),
	})
	for _, candidate := range fallbackCandidates {
		before := snapshotOf(candidate)
		pushTrace(candidate, Trace{
			NodeID:         node.ID,
			NodeType:       node.Type,
			Action:         TraceActionFallback,
			Message:        "Fallback produced candidate via " + mode,
			Accepted:       boolPointer(true),
			RuleHits:       []string{"fallback_activated"},
			BeforeSnapshot: before,
			AfterSnapshot:  snapshotOf(candidate),
			Details:        marshalJSON(fallbackDetails{ActivateWhen: activateWhen, Mode: mode}),
		})
	}
	return result, nil
}

// candidateMetadata is the candidate metadata document.
type candidateMetadata struct {
	PrefetchedArticle json.RawMessage `json:"prefetchedArticle"`
	MetadataStatus    *string         `json:"metadataStatus,omitempty"`
	MetaTags          json.RawMessage `json:"metaTags,omitempty"`
	OpenGraph         json.RawMessage `json:"openGraph,omitempty"`
}

// discoveryTraceDetails is the discovery trace's details object.
type discoveryTraceDetails struct {
	RelevanceScore *float64 `json:"relevanceScore"`
}

// mapDiscoveryCandidates ports mapDiscoveryCandidates, including the 500-entry
// cap and the rediscovery trace.
func mapDiscoveryCandidates(nodeID, nodeType string, discovered []crawlmetadata.DiscoveryCandidate, registry map[string]*Candidate, registryOrder *[]string) []*Candidate {
	if len(discovered) > 500 {
		discovered = discovered[:500]
	}
	out := make([]*Candidate, 0, len(discovered))
	for _, entry := range discovered {
		if existing, ok := registry[entry.URL]; ok {
			pushTrace(existing, Trace{
				NodeID:   nodeID,
				NodeType: nodeType,
				Action:   TraceActionDiscovered,
				Message:  "Rediscovered candidate",
				Accepted: boolPointer(true),
			})
			out = append(out, existing)
			continue
		}
		candidate := &Candidate{
			ID:           "candidate:" + itoa(len(*registryOrder)+1),
			URL:          entry.URL,
			Status:       CandidateStatusActive,
			SourceNodeID: nodeID,
			Metadata: marshalJSON(candidateMetadata{
				PrefetchedArticle: prefetchedArticleJSON(entry.PrefetchedArticle),
			}),
			Trace: []Trace{},
		}
		candidate.RelevanceScore = entry.RelevanceScore
		if entry.PublishedAtTs != nil {
			candidate.PublishedAt = isoPointer(*entry.PublishedAtTs)
		}
		if entry.CrawledAtTs != nil {
			candidate.CrawledAt = isoPointer(*entry.CrawledAtTs)
		}
		switch {
		case entry.PublishedAtTs != nil:
			candidate.EffectiveAt = isoPointer(*entry.PublishedAtTs)
		case entry.CrawledAtTs != nil:
			candidate.EffectiveAt = isoPointer(*entry.CrawledAtTs)
		}
		if entry.PrefetchedArticle != nil {
			candidate.Title = entry.PrefetchedArticle.Title
			candidate.Description = entry.PrefetchedArticle.Description
			candidate.Author = entry.PrefetchedArticle.Author
		}
		pushTrace(candidate, Trace{
			NodeID:         nodeID,
			NodeType:       nodeType,
			Action:         TraceActionDiscovered,
			Message:        "Candidate discovered",
			Accepted:       boolPointer(true),
			BeforeSnapshot: marshalJSON(candidateSnapshot{URL: entry.URL, Status: stringPointer(CandidateStatusActive)}),
			AfterSnapshot:  snapshotOf(candidate),
			Details:        marshalJSON(discoveryTraceDetails{RelevanceScore: entry.RelevanceScore}),
		})
		registry[entry.URL] = candidate
		*registryOrder = append(*registryOrder, entry.URL)
		out = append(out, candidate)
	}
	return out
}

// applyMetadataResult ports applyMetadataResult.
func applyMetadataResult(candidate *Candidate, result crawlmetadata.Result) {
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
		fetchedAt := result.FetchedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		candidate.CrawledAt = &fetchedAt
		if candidate.EffectiveAt == nil {
			candidate.EffectiveAt = &fetchedAt
		}
	}
	metadata := candidateMetadata{
		MetadataStatus: stringPointer(result.Status),
		MetaTags:       marshalJSON(result.MetaTags),
		OpenGraph:      marshalJSON(result.OpenGraph),
	}
	if fields, ok := decodeObject(candidate.Metadata); ok {
		if value, exists := fields["prefetchedArticle"]; exists && value != nil {
			metadata.PrefetchedArticle = mustMarshal(value)
		}
	}
	candidate.Metadata = marshalJSON(metadata)
}

// resolveContentFilterReason ports resolveContentFilterReason.
func resolveContentFilterReason(candidate *Candidate, config map[string]json.RawMessage) string {
	minRelevanceScore := rawNumberOr(config["minRelevanceScore"], 0)
	titleIncludes := rawStringArray(config["titleIncludes"])
	descriptionIncludes := rawStringArray(config["descriptionIncludes"])

	requireTitle := rawBoolOr(config["requireTitle"], false)
	if requireTitle != nil && *requireTitle && strings.TrimSpace(deref(candidate.Title)) == "" {
		return "missing_title"
	}
	if toNumberOr(candidate.RelevanceScore, 0) < minRelevanceScore {
		return "low_relevance"
	}
	if len(titleIncludes) > 0 && !containsAnyTerm(deref(candidate.Title), titleIncludes) {
		return "title_miss"
	}
	if len(descriptionIncludes) > 0 && !containsAnyTerm(deref(candidate.Description), descriptionIncludes) {
		return "description_miss"
	}
	return ""
}

func containsAnyTerm(value string, terms []string) bool {
	lower := strings.ToLower(value)
	for _, term := range terms {
		if strings.Contains(lower, strings.ToLower(term)) {
			return true
		}
	}
	return false
}

// resolveURLFilterReason ports resolveUrlFilterReason.
func resolveURLFilterReason(rawURL string, includePatterns, excludePatterns, blockedDomains, allowedHosts, denyKeywords []string) string {
	lower := strings.ToLower(rawURL)
	for _, pattern := range excludePatterns {
		if matchesWildcardPattern(rawURL, pattern) {
			return "exclude_pattern"
		}
	}
	host := hostOf(rawURL)
	for _, domain := range blockedDomains {
		normalized := strings.ToLower(strings.TrimSpace(domain))
		if normalized == "" {
			continue
		}
		if host == normalized || strings.HasSuffix(host, "."+normalized) {
			return "blocked_domain"
		}
	}
	if len(allowedHosts) > 0 {
		allowed := false
		for _, entry := range allowedHosts {
			if host == strings.ToLower(strings.TrimSpace(entry)) {
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
			if matchesWildcardPattern(rawURL, pattern) {
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

// matchesWildcardPattern implements the runtime's private matchesPattern: escape
// everything except `*`, which becomes `.*`, then test case-insensitively.
func matchesWildcardPattern(rawURL, pattern string) bool {
	trimmed := strings.TrimSpace(pattern)
	if trimmed == "" {
		return false
	}
	var builder strings.Builder
	builder.WriteString("(?i)")
	for _, char := range trimmed {
		switch char {
		case '*':
			builder.WriteString(".*")
		case '.', '+', '?', '^', '$', '{', '}', '(', ')', '[', ']', '\\', '|':
			builder.WriteRune('\\')
			builder.WriteRune(char)
		default:
			builder.WriteRune(char)
		}
	}
	compiled, err := regexp.Compile(builder.String())
	if err != nil {
		return false
	}
	return compiled.MatchString(rawURL)
}

// candidateFieldValue implements Reflect.get(candidate, field) for the fields the
// branch node can address.
func candidateFieldValue(candidate *Candidate, field string) any {
	switch field {
	case "url":
		return candidate.URL
	case "title":
		return derefOrNil(candidate.Title)
	case "pageType":
		return derefOrNil(candidate.PageType)
	case "score":
		return floatOrNil(candidate.Score)
	case "freshnessScore":
		return floatOrNil(candidate.FreshnessScore)
	case "relevanceScore":
		return floatOrNil(candidate.RelevanceScore)
	case "qualityScore":
		return floatOrNil(candidate.QualityScore)
	case "status":
		return candidate.Status
	case "rejectedByNodeId":
		return derefOrNil(candidate.RejectedByNodeID)
	case "rejectedReason":
		return derefOrNil(candidate.RejectedReason)
	case "sourceNodeId":
		return candidate.SourceNodeID
	case "publishedAt":
		return derefOrNil(candidate.PublishedAt)
	case "crawledAt":
		return derefOrNil(candidate.CrawledAt)
	case "effectiveAt":
		return derefOrNil(candidate.EffectiveAt)
	default:
		return nil
	}
}

// evaluateBranch ports evaluateBranch.
func evaluateBranch(target any, operator string, value json.RawMessage) bool {
	switch operator {
	case "gte":
		left, ok := numericTarget(target)
		if !ok {
			left = negativeInfinity()
		}
		return left >= rawNumberOr(value, 0)
	case "lte":
		left, ok := numericTarget(target)
		if !ok {
			left = positiveInfinity()
		}
		return left <= rawNumberOr(value, 0)
	case "contains":
		return strings.Contains(strings.ToLower(toStringValue(target)), strings.ToLower(toStringValue(rawJSONValue(value))))
	default:
		return toStringValue(target) == toStringValue(rawJSONValue(value))
	}
}

// topologicalSort is the source's Kahn traversal with the definition-order
// fallback for a cyclic graph.
func topologicalSort(definition crawlworkflow.WorkflowDefinition) []string {
	indegree := map[string]int{}
	next := map[string][]string{}
	for _, node := range definition.Nodes {
		indegree[node.ID] = 0
		next[node.ID] = []string{}
	}
	for _, edge := range definition.Edges {
		indegree[edge.Target] = indegree[edge.Target] + 1
		next[edge.Source] = append(next[edge.Source], edge.Target)
	}
	queue := []string{}
	for _, node := range definition.Nodes {
		if indegree[node.ID] == 0 {
			queue = append(queue, node.ID)
		}
	}
	result := []string{}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		result = append(result, current)
		for _, target := range next[current] {
			indegree[target] = indegree[target] - 1
			if indegree[target] == 0 {
				queue = append(queue, target)
			}
		}
	}
	if len(result) != len(definition.Nodes) {
		fallback := make([]string, 0, len(definition.Nodes))
		for _, node := range definition.Nodes {
			fallback = append(fallback, node.ID)
		}
		return fallback
	}
	return result
}

// collectInputCandidates ports collectInputCandidates.
func collectInputCandidates(edges []crawlworkflow.WorkflowEdge, outputs map[string]nodeOutputs) []*Candidate {
	if len(edges) == 0 {
		return []*Candidate{}
	}
	collected := []*Candidate{}
	for _, edge := range edges {
		output, ok := outputs[edge.Source]
		if !ok {
			continue
		}
		handle := "default"
		if edge.SourceHandle != nil && *edge.SourceHandle != "" {
			handle = *edge.SourceHandle
		}
		if candidates, ok := output.get(handle); ok {
			collected = append(collected, candidates...)
			continue
		}
		if candidates, ok := output.get("default"); ok {
			collected = append(collected, candidates...)
		}
	}
	return dedupeCandidates(collected)
}

// dedupeCandidates keeps the first position and the last value per URL.
func dedupeCandidates(candidates []*Candidate) []*Candidate {
	order := []string{}
	byURL := map[string]*Candidate{}
	for _, candidate := range candidates {
		if _, ok := byURL[candidate.URL]; !ok {
			order = append(order, candidate.URL)
		}
		byURL[candidate.URL] = candidate
	}
	out := make([]*Candidate, 0, len(order))
	for _, url := range order {
		out = append(out, byURL[url])
	}
	return out
}

// sortedByComposite implements the composite descending sort with the URL
// tie-break.
func sortedByComposite(candidates []*Candidate) []*Candidate {
	sorted := make([]*Candidate, len(candidates))
	copy(sorted, candidates)
	sortCandidates(sorted, func(left, right *Candidate) int {
		leftComposite := compositeScore(left)
		rightComposite := compositeScore(right)
		if leftComposite != rightComposite {
			if rightComposite > leftComposite {
				return 1
			}
			return -1
		}
		return strings.Compare(left.URL, right.URL)
	})
	return sorted
}

func compositeScore(candidate *Candidate) float64 {
	score := 0.0
	if candidate.Score != nil {
		score += *candidate.Score
	}
	if candidate.FreshnessScore != nil {
		score += *candidate.FreshnessScore
	}
	if candidate.RelevanceScore != nil {
		score += *candidate.RelevanceScore
	}
	return score
}

// snapshotOf builds the candidate snapshot object.
func snapshotOf(candidate *Candidate) json.RawMessage {
	status := candidate.Status
	return marshalJSON(candidateSnapshot{
		URL:            candidate.URL,
		PageType:       candidate.PageType,
		Score:          candidate.Score,
		FreshnessScore: candidate.FreshnessScore,
		RelevanceScore: candidate.RelevanceScore,
		Status:         &status,
		RejectedReason: candidate.RejectedReason,
	})
}

// pushTrace appends one trace with the current timestamp.
func pushTrace(candidate *Candidate, trace Trace) {
	trace.Timestamp = isoNow(time.Now().UnixMilli())
	candidate.Trace = append(candidate.Trace, trace)
}

// dereference converts the working slice for persistence/response.
func dereference(candidates []*Candidate) []Candidate {
	out := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		out = append(out, *candidate)
	}
	return out
}

// singleOutput builds `{default: candidates}`.
func singleOutput(candidates []*Candidate) nodeExecutionResult {
	output := newNodeOutputs()
	output.set("default", candidates)
	return nodeExecutionResult{outputs: output}
}

// nodeOutputs preserves the handle insertion order, which is the order
// Object.values(...).flat() would use.
type nodeOutputs struct {
	handles []string
	values  map[string][]*Candidate
}

func newNodeOutputs() nodeOutputs {
	return nodeOutputs{values: map[string][]*Candidate{}}
}

func (o *nodeOutputs) set(handle string, candidates []*Candidate) {
	if _, exists := o.values[handle]; !exists {
		o.handles = append(o.handles, handle)
	}
	if candidates == nil {
		candidates = []*Candidate{}
	}
	o.values[handle] = candidates
}

func (o *nodeOutputs) get(handle string) ([]*Candidate, bool) {
	value, ok := o.values[handle]
	return value, ok
}

func (o *nodeOutputs) flatten() []*Candidate {
	collected := []*Candidate{}
	for _, handle := range o.handles {
		collected = append(collected, o.values[handle]...)
	}
	return dedupeCandidates(collected)
}

func (o *nodeOutputs) countRejected() int {
	return len(o.values["rejected"])
}

// ---- small conversions ----

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefOrNil(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func floatOrNil(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func profileIDOrNil(profile *profileRow) *string {
	if profile == nil {
		return nil
	}
	return &profile.ID
}

func newsSourceIDOrNil(source *newsSourceRow) *string {
	if source == nil {
		return nil
	}
	return &source.ID
}

func newsSourceURL(run *runtimeContext) string {
	if run.newsSource == nil {
		return ""
	}
	return run.newsSource.URL
}

func intPointer(value int) *int { return &value }

func stringPointer(value string) *string { return &value }

func boolPointer(value bool) *bool { return &value }

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func rawObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, "{") {
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, false
	}
	return fields, true
}

func rawOptionalString(raw json.RawMessage) string {
	var value string
	if len(raw) == 0 {
		return ""
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func rawStringValue(raw json.RawMessage) (string, bool) {
	var value string
	if len(raw) == 0 {
		return "", false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func rawIntOr(raw json.RawMessage, fallback int) int {
	var value float64
	if len(raw) == 0 {
		return fallback
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	if value != value {
		return fallback
	}
	return int(value)
}

func rawBoolOr(raw json.RawMessage, fallback bool) *bool {
	var value bool
	if len(raw) == 0 {
		return &fallback
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return &fallback
	}
	return &value
}

func rawStringArray(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return []string{}
	}
	var items []string
	if err := json.Unmarshal(raw, &items); err != nil {
		return []string{}
	}
	out := []string{}
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

// rawStringMap decodes an object of string arrays (urlPatterns).
func rawStringMap(raw json.RawMessage) map[string][]string {
	fields, ok := rawObject(raw)
	if !ok {
		return nil
	}
	out := map[string][]string{}
	for key, value := range fields {
		var list []string
		if err := json.Unmarshal(value, &list); err != nil {
			continue
		}
		out[key] = list
	}
	return out
}

// rawPageTypeSignals decodes an object of page type signals.
func rawPageTypeSignals(raw json.RawMessage) map[string]PageTypeSignal {
	fields, ok := rawObject(raw)
	if !ok {
		return nil
	}
	out := map[string]PageTypeSignal{}
	for key, value := range fields {
		var signal PageTypeSignal
		if err := json.Unmarshal(value, &signal); err != nil {
			continue
		}
		out[key] = signal
	}
	return out
}

// rawJSONMap renders a map of raw JSON fields back to one JSON object.
func rawJSONMap(fields map[string]json.RawMessage) json.RawMessage {
	encoded, err := json.Marshal(fields)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

// rawJSONValue decodes a raw JSON value into a typed Go value.
// mustMarshal re-encodes a decoded value (used when a candidate metadata field
// is carried from one document into another).
func mustMarshal(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

func rawJSONValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

// rawNumberOr mirrors `toNumber(value, fallback)`: only a finite JSON number is
// accepted.
func rawNumberOr(raw json.RawMessage, fallback float64) float64 {
	var value float64
	if len(raw) == 0 {
		return fallback
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	if value != value {
		return fallback
	}
	return value
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func originOf(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func hostOf(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func parseISOMillis(value *string) *int64 {
	if value == nil || *value == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if parsed, err := time.Parse(layout, *value); err == nil {
			millis := parsed.UnixMilli()
			return &millis
		}
	}
	return nil
}

func isoPointer(millis int64) *string {
	value := isoNow(millis)
	return &value
}

func prefetchedArticleJSON(article *crawlmetadata.PrefetchedArticle) json.RawMessage {
	if article == nil {
		return nil
	}
	return article.JSON()
}

func parameterSourcesOf(sources []crawlworkflow.ParameterSource) []any {
	out := make([]any, 0, len(sources))
	for _, source := range sources {
		out = append(out, source)
	}
	return out
}

// runInputObject is the persisted `input` object. Undefined source values are
// dropped by JSON.stringify, so only present fields are written.
func runInputObject(input TrialRunInput, profile *profileRow, newsSource *newsSourceRow) json.RawMessage {
	object := map[string]json.RawMessage{}
	if input.SeedURL != nil {
		object["seedUrl"] = marshalJSON(*input.SeedURL)
	}
	if profile != nil {
		object["profileId"] = marshalJSON(profile.ID)
	}
	if newsSource != nil {
		object["newsSourceId"] = marshalJSON(newsSource.ID)
	}
	if input.MaxCandidates != nil {
		object["maxCandidates"] = marshalJSON(*input.MaxCandidates)
	}
	if len(input.RuntimeOverrides) > 0 {
		object["runtimeOverrides"] = input.RuntimeOverrides
	} else {
		object["runtimeOverrides"] = json.RawMessage("{}")
	}
	return rawJSONMap(object)
}

func inputString(raw json.RawMessage, key string) *string {
	fields, ok := decodeObject(raw)
	if !ok {
		return nil
	}
	value, ok := fields[key].(string)
	if !ok {
		return nil
	}
	return &value
}

func inputInt(raw json.RawMessage, key string) *int {
	fields, ok := decodeObject(raw)
	if !ok {
		return nil
	}
	value, ok := fields[key].(float64)
	if !ok {
		return nil
	}
	converted := int(value)
	return &converted
}

// toNumberOr implements `(value ?? 0)` for a float pointer.
func toNumberOr(value *float64, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return *value
}

// numericTarget implements `typeof value === "number" && isFinite(value)`.
func numericTarget(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok {
		return 0, false
	}
	if number != number {
		return 0, false
	}
	return number, true
}

// toStringValue implements String(value ?? "").
func toStringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return formatJSNumber(typed)
	default:
		return ""
	}
}

// formatJSNumber renders a float like JavaScript's String(number).
func formatJSNumber(value float64) string {
	if value == float64(int64(value)) {
		return itoa(int(value))
	}
	return strings.TrimRight(strings.TrimRight(formatFloat(value, 6), "0"), ".")
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func negativeInfinity() float64 {
	return -1.7976931348623157e308
}

func positiveInfinity() float64 {
	return 1.7976931348623157e308
}
