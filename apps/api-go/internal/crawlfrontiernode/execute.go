package crawlfrontiernode

// execute.go is executeNode (crawl-frontier.service.ts 1459) and
// executeLayeredNode (1488-1640).
//
// executeNode picks the branch:
//
//	useNativeAtRoot = node.depth === 0
//	               && (run.executionMode === "native" || "hybrid")
//	               && Boolean(profile.config.nativeOptions?.deepCrawlStrategy)
//
// Everything else runs the layered branch: one crawl4ai call for the node URL,
// persist the results, derive the runtime metadata, expand the discovery branch
// when the node is not an article and the depth budget allows it, run the root
// seed branch, then write the completed node and the workflow step. The native
// root branch lives in native_execute.go.

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// executeNode dispatches one node to the layered or native root branch.
func (s *Service) executeNode(ctx context.Context, options executeNodeOptions) (CrawlExecutionSummary, error) {
	if s.shouldUseNativeAtRoot(options) {
		return s.executeNativeRootNode(ctx, options)
	}
	return s.executeLayeredNode(ctx, options)
}

// shouldUseNativeAtRoot is the executeNode branch condition, including the
// Boolean() coercion of nativeOptions.deepCrawlStrategy.
func (s *Service) shouldUseNativeAtRoot(options executeNodeOptions) bool {
	if options.Node.Depth != 0 {
		return false
	}
	if options.Run.ExecutionMode != "native" && options.Run.ExecutionMode != "hybrid" {
		return false
	}
	return deepCrawlStrategyConfigured(options.Profile.Config)
}

// deepCrawlStrategyConfigured is Boolean(profile.config.nativeOptions?.deepCrawlStrategy).
// NestJS treats any non-empty object/string/true as truthy and undefined/null/
// false/0/"" as falsy.
func deepCrawlStrategyConfigured(config *crawlfrontierllm.Object) bool {
	if config == nil {
		return false
	}
	nativeOptions, ok := config.Object("nativeOptions")
	if !ok || nativeOptions == nil {
		return false
	}
	raw, ok := nativeOptions.Raw("deepCrawlStrategy")
	if !ok {
		return false
	}
	return jsTruthy(raw)
}

// executeLayeredNode is executeLayeredNode (1488-1640).
func (s *Service) executeLayeredNode(ctx context.Context, options executeNodeOptions) (CrawlExecutionSummary, error) {
	startedAt := s.now()
	crawlOptions, err := buildLayeredCrawlOptions(options.Profile.Config, options.Node.PageType)
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	response, err := s.crawl.CrawlPipeline(ctx, crawl4ai.PipelineRequest{
		URL:              options.Node.URL,
		URLs:             []string{options.Node.URL},
		Keywords:         options.Run.Keywords,
		Options:          crawlOptions.Request,
		RequestTimeoutMs: options.RequestTimeoutMs,
	}, s.settings(ctx))
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	if err := s.recordCrawl4aiSystemEvents(ctx, derefString(options.Run.WorkflowRunID), options.Node, response.SystemEvents); err != nil {
		return CrawlExecutionSummary{}, err
	}

	persisted, err := s.persistFrontierResponse(ctx, persistFrontierOptions{
		Response:      response,
		Node:          options.Node,
		Profile:       options.Profile,
		RunID:         options.Run.ID,
		Task:          options.Task,
		CrawlOptions:  crawlOptions,
		ExecutionMode: options.Run.ExecutionMode,
	})
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	var selfMetadata *crawlfrontierllm.Object
	if persisted.SelfResult != nil {
		selfMetadata = persisted.SelfResult.Metadata
	}
	runtimeMetadata := s.buildNodeRuntimeMetadata(nodeRuntimeMetadataInput{
		Node:         options.Node,
		Profile:      options.Profile,
		Response:     response,
		SelfMetadata: selfMetadata,
		CrawlOptions: crawlOptions,
	})
	rootSeedPlan := s.resolveRootSeedPlan(options.Node.Depth, options.Profile, options.Run.MaxPages, options.Run.MaxDepth)

	var discoveryMetadata *crawlfrontierllm.Object
	if options.Node.PageType != "article" && options.Node.Depth < options.Run.MaxDepth {
		discoveryMetadata, err = s.discoverChildNodes(ctx, discoverChildNodesInput{
			Node:             options.Node,
			RunID:            options.Run.ID,
			TaskID:           options.Task.ID,
			MaxDepth:         options.Run.MaxDepth,
			MaxPages:         options.Run.MaxPages,
			Profile:          options.Profile,
			Results:          response.Results,
			MaxDepthOverride: rootSeedPlan.TopologyBudgetDepth,
			MaxNewNodes:      rootSeedPlan.TopologyBudgetPages,
			MetadataPatch:    rootSeedPlan.TopologyMetadataPatch,
		})
		if err != nil {
			return CrawlExecutionSummary{}, err
		}
	}
	seedDiscovery, err := s.executeRootSeedBranch(ctx, rootSeedBranchInput{
		WorkflowRunID:    derefString(options.Run.WorkflowRunID),
		Node:             options.Node,
		Run:              seedRunRef{ID: options.Run.ID, SeedURL: options.Run.SeedURL, MaxDepth: options.Run.MaxDepth, MaxPages: options.Run.MaxPages},
		Profile:          options.Profile,
		TaskID:           options.Task.ID,
		RequestTimeoutMs: options.RequestTimeoutMs,
		SeedStrategy:     rootSeedPlan.SeedStrategy,
	})
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	branchSummary := s.buildRootBranchSummary(rootBranchSummaryInput{
		NodeMetadata:    options.Node.Metadata,
		LastError:       options.Node.LastError,
		RuntimeMetadata: runtimeMetadata,
		BranchMetadata:  discoveryMetadata,
		SeedDiscovery:   seedDiscovery,
		SeedPlan:        rootSeedPlan,
	})

	var seedDiagnostics *crawlfrontierllm.Object
	if seedDiscovery != nil {
		seedDiagnostics = seedDiscovery.Diagnostics
	}
	metadata := crawlfrontierllm.MergeObjectsAll(
		options.Node.Metadata,
		runtimeMetadata,
		discoveryMetadata,
		seedDiagnostics,
		branchSummary.MetadataPatch,
	)

	canonicalURL := optionalMetadataString(selfMetadata, "canonicalUrl")
	urlFingerprint := options.Node.URLFingerprint
	if value := optionalMetadataString(selfMetadata, "urlFingerprint"); value != nil {
		urlFingerprint = value
	}
	if err := s.markNodeCompleted(ctx, completedNodeInput{
		NodeID:         options.Node.ID,
		CrawledAt:      s.now(),
		CanonicalURL:   canonicalURL,
		URLFingerprint: urlFingerprint,
		CrawlResultID:  selfResultID(persisted),
		Score:          firstFloat(persisted.SelfScore, options.Node.Score),
		FreshnessScore: firstFloat(persisted.SelfFreshnessScore, options.Node.FreshnessScore),
		Metadata:       metadata,
	}); err != nil {
		return CrawlExecutionSummary{}, err
	}

	metrics := crawlfrontierllm.NewObjectFromPairs(
		"pageType", options.Node.PageType,
		"hasDiscoveryBranch", discoveryMetadata != nil,
		"hasSeedBranch", seedDiscovery != nil,
		"warningFlags", branchSummary.CombinedWarningFlags,
	)
	if err := s.recordNodeCompletion(ctx, nodeCompletionInput{
		WorkflowRunID:    derefString(options.Run.WorkflowRunID),
		Node:             options.Node,
		StepKey:          "frontier:" + options.Node.ID + ":crawl",
		WorkflowNodeID:   "legacy::crawl:" + options.Node.ID,
		WorkflowNodeType: "legacy.crawl_fetch",
		Label:            "Fetch " + options.Node.PageType + " node",
		DurationMs:       int(s.now().Sub(startedAt).Milliseconds()),
		OutputURLs:       resultURLs(response.Results),
		OutputCount:      intPointer(len(response.Results)),
		RejectedCount:    0,
		Metrics:          metrics,
	}); err != nil {
		return CrawlExecutionSummary{}, err
	}
	return persisted.Summary, nil
}

// resultURLs is response.results.map(r => r.url).filter(url => typeof url === "string").
func resultURLs(results []crawl4ai.PipelineArticle) []string {
	out := make([]string, 0, len(results))
	for _, result := range results {
		if result.URL != "" {
			out = append(out, result.URL)
		}
	}
	return out
}

// optionalMetadataString is `typeof metadata?.key === "string" ? value : undefined`.
//
// The raw leaf is inspected instead of using Object.UntrimmedString because
// json.Unmarshal("null", &s) succeeds with "", so the string reader reports
// ("", true) for a JSON null while NestJS `typeof null === "object"` reports
// undefined. Only a JSON string literal qualifies here.
func optionalMetadataString(metadata *crawlfrontierllm.Object, key string) *string {
	if metadata == nil {
		return nil
	}
	raw, ok := metadata.Raw(key)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' || trimmed[len(trimmed)-1] != '"' {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
}

// selfResultID is persisted.selfResult?.id ?? null.
func selfResultID(persisted persistFrontierOutcome) *string {
	if persisted.SelfResult == nil {
		return nil
	}
	return stringPointer(persisted.SelfResult.ID)
}

// firstFloat is `a ?? b` for the two optional score columns.
func firstFloat(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// jsTruthy is Boolean(value) for a raw JSON leaf.
func jsTruthy(raw []byte) bool {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || trimmed == "false" || trimmed == "0" || trimmed == `""` {
		return false
	}
	return true
}
