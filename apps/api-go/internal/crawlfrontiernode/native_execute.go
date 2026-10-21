package crawlfrontiernode

// native_execute.go ports the crawl4ai-native half of the Frontier node chain:
//
//   - executeNativeRootNode (crawl-frontier.service.ts 1642-1949): the depth-0
//     branch that lets crawl4ai run its own deep-crawl strategy, materializes
//     the crawled result URLs into frontier nodes directly and optionally falls
//     back to the layered discovery branch when the native yield misses the
//     profile's thresholds;
//   - materializeNativeDiscoveryCandidates
//     (crawl-strategy-layered-executor.service.ts 1661-2163): the URL-by-URL
//     filtering, page-type classification, scoring and node persistence that
//     turns one native crawl response into frontier topology.
//
// Everything shared with the other node files is called, never re-implemented:
// the layered crawl options and native components (options_layered.go), the
// frontier URL utilities (discover.go), the canonical URL matching and runtime
// metadata (metadata.go), the result/system-event/node-completion recorders
// (record.go) and the root seed branch (rootbranch.go).
//
// The NestJS order of awaits is observable — it decides the workflow trace, the
// candidate trace and the node metadata key order — so every write keeps its
// position. Metadata objects are ordered crawlfrontierllm.Object values because
// the persisted JSON is compared byte for byte.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// executeNativeRootNode ports executeNativeRootNode (1642-1949).
//
// The crawl call is the whole discovery effort: crawl4ai's deep-crawl strategy
// walks the site and returns one result entry per crawled URL. Those URLs are
// persisted as CrawlResult rows first (persistFrontierResponse) and only then
// materialized into frontier nodes, so a node always points at an existing
// crawl result through crawlResultId.
//
// requestTimeoutMs: NestJS passes
// `typeof options.requestTimeoutMs === "number" ? options.requestTimeoutMs : undefined`.
// executeNodeOptions.RequestTimeoutMs carries the same contract as
// ProcessQueuedNode's argument — a value <= 0 is the undefined case — and
// crawl4ai's resolveRequestTimeout already reads it that way.
func (s *Service) executeNativeRootNode(ctx context.Context, options executeNodeOptions) (CrawlExecutionSummary, error) {
	startedAt := s.now()

	// const baseOptions = this.buildLayeredCrawlOptions(
	//   options.profile.config, options.node.pageType)
	baseOptions, err := buildLayeredCrawlOptions(options.Profile.Config, options.Node.PageType)
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	// const nativeComponents = this.resolveNativeCrawlComponents(
	//   options.profile.config, options.node.url)
	nativeComponents := resolveNativeCrawlComponents(options.Profile.Config, options.Node.URL)

	// const response = await this.crawlClient.crawl({
	//   url: options.node.url,
	//   keywords: options.run.keywords,
	//   options: {...baseOptions, deepCrawlStrategy, filterChain, urlScorer,
	//             adaptiveCrawling},
	//   requestTimeoutMs, ...})
	//
	// The four component members override the layered options. crawl4ai.CrawlOptions
	// only exposes DeepCrawlStrategy because filterChain/urlScorer/adaptiveCrawling
	// travel inside deep_crawl_strategy.params: resolveNativeCrawlComponents has
	// already placed filter_chain/url_scorer/adaptive_crawling there (NestJS only
	// fills a params member that is still undefined, crawl4ai.client.ts:1181-1195),
	// so nativeDeepCrawlComponent carries the same payload the NestJS client builds.
	requestOptions := baseOptions.Request
	requestOptions.DeepCrawlStrategy = nativeDeepCrawlComponent(nativeComponents)
	response, err := s.crawl.CrawlPipeline(ctx, crawl4ai.PipelineRequest{
		URL:              options.Node.URL,
		URLs:             []string{options.Node.URL},
		Keywords:         options.Run.Keywords,
		Options:          requestOptions,
		RequestTimeoutMs: options.RequestTimeoutMs,
	}, s.settings(ctx))
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	workflowRunID := derefString(options.Run.WorkflowRunID)
	// await this.recordCrawl4aiSystemEvents(run.workflowRunId, node, response.systemEvents)
	if err := s.recordCrawl4aiSystemEvents(ctx, workflowRunID, options.Node, response.SystemEvents); err != nil {
		return CrawlExecutionSummary{}, err
	}

	// const persisted = await this.persistFrontierResponse({...})
	persisted, err := s.persistFrontierResponse(ctx, persistFrontierOptions{
		Response:      response,
		Node:          options.Node,
		Profile:       options.Profile,
		RunID:         options.Run.ID,
		Task:          options.Task,
		CrawlOptions:  baseOptions,
		ExecutionMode: options.Run.ExecutionMode,
	})
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	// selfMetadata = persisted.selfResult?.metadata && isPlainObject(...) ? ... : null
	var selfMetadata *crawlfrontierllm.Object
	if persisted.SelfResult != nil {
		selfMetadata = persisted.SelfResult.Metadata
	}
	runtimeMetadata := s.buildNodeRuntimeMetadata(nodeRuntimeMetadataInput{
		Node:         options.Node,
		Profile:      options.Profile,
		Response:     response,
		SelfMetadata: selfMetadata,
		CrawlOptions: baseOptions,
	})
	rootSeedPlan := s.resolveRootSeedPlan(options.Node.Depth, options.Profile, options.Run.MaxPages, options.Run.MaxDepth)

	// await this.prisma.crawlFrontierRun.update({
	//   where: {id: options.run.id},
	//   data: {nativeRunId: response.runId ?? undefined},
	// })
	if err := s.nativeUpdateRunNativeRunID(ctx, options.Run.ID, response.RunID); err != nil {
		return CrawlExecutionSummary{}, err
	}

	// const rawResultByUrl = new Map<string, Crawl4aiArticle>();
	// for (const entry of response.results) { if (typeof entry.url === "string"
	//   && entry.url.trim().length > 0) set(entry.url.trim(), entry) }
	rawResultsByURL := make(map[string]crawl4ai.PipelineArticle, len(response.Results))
	for _, entry := range response.Results {
		trimmed := crawlfrontierllm.JsTrim(entry.URL)
		if trimmed == "" {
			continue
		}
		rawResultsByURL[trimmed] = entry
	}

	// const nativeMaterialization =
	//   await this.layeredExecutor.materializeNativeDiscoveryCandidates({...})
	//
	// persistedResults is `persisted.results.map(r => ({id, sourceUrl}))`, and
	// the run view is the inline `{id, maxDepth, maxPages}` projection.
	nativeMaterialization, err := s.materializeNativeDiscoveryCandidates(ctx, nativeMaterializeInput{
		WorkflowRunID: workflowRunID,
		Node:          options.Node,
		Run: seedRunRef{
			ID:       options.Run.ID,
			MaxDepth: options.Run.MaxDepth,
			MaxPages: options.Run.MaxPages,
		},
		Profile:          options.Profile,
		PersistedResults: nativePersistedResultRefs(persisted.Results),
		RawResultsByURL:  rawResultsByURL,
	})
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	acceptedCount := nativeMaterialization.AcceptedCount
	createdCount := nativeMaterialization.CreatedCount
	rejectionCounts := nativeMaterialization.RejectionCounts
	selectedPageTypeCounts := nativeMaterialization.SelectedPageTypeCounts
	nativeAcceptedArticles := nativePageTypeCount(selectedPageTypeCounts, "article")
	scannedSourceURLs := nativeMaterialization.ScannedSourceURLs
	nativeWarningFlags := newNativeFlagSet(nativeMaterialization.NativeWarningFlags)

	// const minAcceptedResults = options.profile.config.nativeOptions?.minAcceptedResults ?? 0
	// const minArticleResults = options.profile.config.nativeOptions?.minArticleResults ?? 0
	//
	// The profile normalization clamps both to integers in [0, 500], so the
	// float -> int conversion is exact; the float form is kept for the
	// comparisons because NestJS compares numbers, not integers.
	minAcceptedResults := nativeOptionNumber(options.Profile.Config, "minAcceptedResults", 0)
	minArticleResults := nativeOptionNumber(options.Profile.Config, "minArticleResults", 0)
	shouldFallbackToLayered := options.Run.ExecutionMode == "hybrid" &&
		nativeFallbackToLayered(options.Profile.Config) &&
		(acceptedCount == 0 ||
			(minAcceptedResults > 0 && float64(acceptedCount) < minAcceptedResults) ||
			(minArticleResults > 0 && float64(nativeAcceptedArticles) < minArticleResults))
	if shouldFallbackToLayered {
		nativeWarningFlags.add("native_fallback_layered")
	}
	if acceptedCount == 0 {
		nativeWarningFlags.add("native_zero_accepted")
	}

	// const rootResults = response.results.filter(entry =>
	//   this.isCanonicalUrlMatch(entry.url, options.node.url, options.profile.config))
	rootResults := make([]crawl4ai.PipelineArticle, 0, len(response.Results))
	for _, entry := range response.Results {
		if s.isCanonicalURLMatch(entry.URL, options.Node.URL, options.Profile.Config) {
			rootResults = append(rootResults, entry)
		}
	}
	if len(response.Results) > 0 && len(rootResults) == 0 {
		nativeWarningFlags.add("native_self_result_mismatch")
	}

	// const fallbackDiscoveryMetadata = shouldFallbackToLayered
	//   ? await this.discoverChildNodes({node, runId, taskId, maxDepth, maxPages,
	//       profile, results: rootResults, maxDepthOverride:
	//       rootSeedPlan.topologyBudgetDepth, maxNewNodes:
	//       rootSeedPlan.topologyBudgetPages, metadataPatch:
	//       rootSeedPlan.topologyMetadataPatch})
	//   : undefined;
	var fallbackDiscoveryMetadata *crawlfrontierllm.Object
	if shouldFallbackToLayered {
		fallbackDiscoveryMetadata, err = s.discoverChildNodes(ctx, discoverChildNodesInput{
			Node:             options.Node,
			RunID:            options.Run.ID,
			TaskID:           options.Task.ID,
			MaxDepth:         options.Run.MaxDepth,
			MaxPages:         options.Run.MaxPages,
			Profile:          options.Profile,
			Results:          rootResults,
			MaxDepthOverride: rootSeedPlan.TopologyBudgetDepth,
			MaxNewNodes:      rootSeedPlan.TopologyBudgetPages,
			MetadataPatch:    rootSeedPlan.TopologyMetadataPatch,
		})
		if err != nil {
			return CrawlExecutionSummary{}, err
		}
	}

	// await this.recordNativeFallbackExecution({...})
	// triggerReason: acceptedCount === 0 ? "native_zero_accepted"
	//   : selectedPageTypeCounts.article < minArticleResults
	//     ? "native_article_below_threshold"
	//     : "native_accepted_below_threshold"
	triggerReason := "native_accepted_below_threshold"
	if acceptedCount == 0 {
		triggerReason = "native_zero_accepted"
	} else if float64(nativeAcceptedArticles) < minArticleResults {
		triggerReason = "native_article_below_threshold"
	}
	if err := s.recordNativeFallbackExecution(ctx, nativeFallbackInput{
		WorkflowRunID:             workflowRunID,
		NodeID:                    options.Node.ID,
		AcceptedCount:             acceptedCount,
		CreatedCount:              createdCount,
		MinAcceptedResults:        int(minAcceptedResults),
		MinArticleResults:         int(minArticleResults),
		NativeAcceptedArticles:    nativeAcceptedArticles,
		FallbackDiscoveryMetadata: fallbackDiscoveryMetadata,
		TriggerReason:             triggerReason,
	}); err != nil {
		return CrawlExecutionSummary{}, err
	}

	// const fallbackCandidateStats = toNumericRecord(fallbackDiscoveryMetadata?.candidateStats)
	// const fallbackRejectionCounts = toNumericRecord(fallbackDiscoveryMetadata?.rejectionCounts)
	var fallbackCandidateStats, fallbackRejectionCounts *crawlfrontierllm.Object
	if fallbackDiscoveryMetadata != nil {
		candidateStats, _ := fallbackDiscoveryMetadata.Object("candidateStats")
		fallbackCandidateStats = nativeToNumericRecord(candidateStats)
		rejectionCountsLeaf, _ := fallbackDiscoveryMetadata.Object("rejectionCounts")
		fallbackRejectionCounts = nativeToNumericRecord(rejectionCountsLeaf)
	}

	// const combinedCandidateStats = {
	//   scanned: scannedSourceUrls.size + (fallbackCandidateStats?.scanned ?? 0), ...}
	rejectedTotal := discoverRejectionTotal(rejectionCounts)
	trimmedCount := acceptedCount - createdCount
	if trimmedCount < 0 {
		trimmedCount = 0
	}
	combinedCandidateStats := crawlfrontierllm.NewObject()
	combinedCandidateStats.SetNumber("scanned", float64(len(scannedSourceURLs))+nativeNumericMember(fallbackCandidateStats, "scanned"))
	combinedCandidateStats.SetNumber("unique", float64(len(scannedSourceURLs))+nativeNumericMember(fallbackCandidateStats, "unique"))
	combinedCandidateStats.SetNumber("accepted", float64(acceptedCount)+nativeNumericMember(fallbackCandidateStats, "accepted"))
	combinedCandidateStats.SetNumber("selected", float64(createdCount)+nativeNumericMember(fallbackCandidateStats, "selected"))
	combinedCandidateStats.SetNumber("rejected", float64(rejectedTotal)+nativeNumericMember(fallbackCandidateStats, "rejected"))
	combinedCandidateStats.SetNumber("trimmed", float64(trimmedCount)+nativeNumericMember(fallbackCandidateStats, "trimmed"))

	// const combinedRejectionCounts: Record<string, number> = {...rejectionCounts};
	// for (const [key, value] of Object.entries(fallbackRejectionCounts ?? {})) {
	//   combinedRejectionCounts[key] = (combinedRejectionCounts[key] ?? 0) + value }
	combinedRejectionCounts := crawlfrontierllm.NewObject()
	for _, key := range rejectionCounts.Keys() {
		if value, ok := rejectionCounts.Number(key); ok {
			combinedRejectionCounts.SetNumber(key, value)
		}
	}
	if fallbackRejectionCounts != nil {
		for _, key := range fallbackRejectionCounts.Keys() {
			value, _ := fallbackRejectionCounts.Number(key)
			current, _ := combinedRejectionCounts.Number(key)
			combinedRejectionCounts.SetNumber(key, current+value)
		}
	}

	// const nativeCandidateStats = {scanned: scannedSourceUrls.size, unique: ..., ...}
	nativeCandidateStats := crawlfrontierllm.NewObject()
	nativeCandidateStats.SetNumber("scanned", float64(len(scannedSourceURLs)))
	nativeCandidateStats.SetNumber("unique", float64(len(scannedSourceURLs)))
	nativeCandidateStats.SetNumber("accepted", float64(acceptedCount))
	nativeCandidateStats.SetNumber("selected", float64(createdCount))
	nativeCandidateStats.SetNumber("rejected", float64(rejectedTotal))
	nativeCandidateStats.SetNumber("trimmed", float64(trimmedCount))

	// const nativeDiagnostics = {candidateStats, rejectionCounts,
	//   nativeCandidateStats, nativeAcceptedPageTypeCounts,
	//   nativeSelectedPageTypeCounts, nativeRejectionCounts,
	//   nativeWarningFlags, nativeAcceptedResults, nativeSelectedResults,
	//   nativeAcceptedArticles, nativeFallbackActivated}
	nativeDiagnostics := crawlfrontierllm.NewObject()
	nativeDiagnostics.Set("candidateStats", combinedCandidateStats)
	nativeDiagnostics.Set("rejectionCounts", combinedRejectionCounts)
	nativeDiagnostics.Set("nativeCandidateStats", nativeCandidateStats)
	nativeDiagnostics.Set("nativeAcceptedPageTypeCounts", nativeMaterialization.AcceptedPageTypeCounts)
	nativeDiagnostics.Set("nativeSelectedPageTypeCounts", selectedPageTypeCounts)
	nativeDiagnostics.Set("nativeRejectionCounts", rejectionCounts)
	nativeDiagnostics.Set("nativeWarningFlags", nativeWarningFlags.list())
	nativeDiagnostics.SetNumber("nativeAcceptedResults", float64(acceptedCount))
	nativeDiagnostics.SetNumber("nativeSelectedResults", float64(createdCount))
	nativeDiagnostics.SetNumber("nativeAcceptedArticles", float64(nativeAcceptedArticles))
	nativeDiagnostics.SetBool("nativeFallbackActivated", shouldFallbackToLayered)

	// const seedDiscovery = await this.executeRootSeedBranch({...})
	seedDiscovery, err := s.executeRootSeedBranch(ctx, rootSeedBranchInput{
		WorkflowRunID: workflowRunID,
		Node:          options.Node,
		Run: seedRunRef{
			ID:       options.Run.ID,
			SeedURL:  options.Run.SeedURL,
			MaxDepth: options.Run.MaxDepth,
			MaxPages: options.Run.MaxPages,
		},
		Profile:          options.Profile,
		TaskID:           options.Task.ID,
		RequestTimeoutMs: options.RequestTimeoutMs,
		SeedStrategy:     rootSeedPlan.SeedStrategy,
	})
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	// const branchSummary = this.rootExecutor.buildRootBranchSummary({
	//   nodeMetadata, lastError, runtimeMetadata, branchMetadata:
	//   fallbackDiscoveryMetadata, seedDiscovery,
	//   extraWarningFlags: Array.from(nativeWarningFlags), seedPlan})
	branchSummary := s.buildRootBranchSummary(rootBranchSummaryInput{
		NodeMetadata:      options.Node.Metadata,
		LastError:         options.Node.LastError,
		RuntimeMetadata:   runtimeMetadata,
		ExtraWarningFlags: nativeWarningFlags.list(),
		BranchMetadata:    fallbackDiscoveryMetadata,
		SeedDiscovery:     seedDiscovery,
		SeedPlan:          rootSeedPlan,
	})

	// await this.prisma.crawlFrontierNode.update({where: {id}, data: {
	//   status: "completed", crawledAt: new Date(),
	//   crawlResultId: persisted.selfResult?.id ?? null, lastError: null,
	//   metadata: toPrismaJsonValue(mergeMetadataRecords(
	//     options.node.metadata, runtimeMetadata, fallbackDiscoveryMetadata,
	//     seedDiscovery?.diagnostics, branchSummary.metadataPatch,
	//     {nativeDiscovered: true, sourceTier, discoveryPath: ["home"], ...},
	//     nativeDiagnostics))}})
	//
	// The merge order is the metadata key order, so the native component block
	// and the diagnostics block stay the last two records.
	nativeComponentMetadata := crawlfrontierllm.NewObject()
	nativeComponentMetadata.SetBool("nativeDiscovered", true)
	nativeComponentMetadata.SetString("sourceTier", nativeConfigString(options.Profile.Config, "sourceTier", "tier2"))
	nativeComponentMetadata.Set("discoveryPath", []string{"home"})
	nativeComponentMetadata.Set("frontierPath", []string{"home"})
	nativeSetComponentType(nativeComponentMetadata, "nativeStrategyType", nativeComponents.DeepCrawlStrategy)
	nativeSetOptionalString(nativeComponentMetadata, "nativeStrategyResolvedFrom", nativeComponents.StrategyResolvedFrom)
	nativeComponentMetadata.SetBool("nativeStrategyAutoResolved", nativeComponents.StrategyAutoResolved)
	nativeSetComponentType(nativeComponentMetadata, "nativeFilterChainType", nativeComponents.FilterChain)
	nativeSetComponentType(nativeComponentMetadata, "nativeUrlScorerType", nativeComponents.URLScorer)
	nativeSetComponentType(nativeComponentMetadata, "nativeAdaptiveType", nativeComponents.AdaptiveCrawling)
	nativeComponentMetadata.SetBool("nativeFilterChainSynthesized", nativeComponents.FilterChainSynthesized)
	nativeComponentMetadata.SetBool("nativeUrlScorerSynthesized", nativeComponents.URLScorerSynthesized)

	var seedDiagnostics *crawlfrontierllm.Object
	if seedDiscovery != nil {
		seedDiagnostics = seedDiscovery.Diagnostics
	}
	metadata := crawlfrontierllm.MergeObjectsAll(
		options.Node.Metadata,
		runtimeMetadata,
		fallbackDiscoveryMetadata,
		seedDiagnostics,
		branchSummary.MetadataPatch,
		nativeComponentMetadata,
		nativeDiagnostics,
	)
	// The native update does not touch canonicalUrl/urlFingerprint/score/
	// freshnessScore (unlike executeLayeredNode). markNodeCompleted always writes
	// those columns, so the values read with the node are written back unchanged,
	// which is the same row Prisma leaves alone.
	if err := s.markNodeCompleted(ctx, completedNodeInput{
		NodeID:         options.Node.ID,
		CrawledAt:      s.now(),
		CanonicalURL:   options.Node.CanonicalURL,
		URLFingerprint: options.Node.URLFingerprint,
		CrawlResultID:  selfResultID(persisted),
		Score:          options.Node.Score,
		FreshnessScore: options.Node.FreshnessScore,
		Metadata:       metadata,
	}); err != nil {
		return CrawlExecutionSummary{}, err
	}

	// await this.recordNodeCompletion({stepKey: `frontier:${id}:native-root`,
	//   workflowNodeId: `legacy::native-root:${id}`,
	//   workflowNodeType: "deep-discovery", label: "Native root discovery",
	//   durationMs: Date.now() - startedMs, outputUrls: Array.from(scanned),
	//   outputCount: createdCount, rejectedCount: Object.values(rejectionCounts)
	//     .reduce(...), metrics: {acceptedCount, createdCount,
	//     selectedPageTypeCounts, rejectionCounts, nativeWarningFlags:
	//     branchSummary.combinedWarningFlags, nativeStrategyType}})
	metrics := crawlfrontierllm.NewObject()
	metrics.SetNumber("acceptedCount", float64(acceptedCount))
	metrics.SetNumber("createdCount", float64(createdCount))
	metrics.Set("selectedPageTypeCounts", selectedPageTypeCounts)
	metrics.Set("rejectionCounts", rejectionCounts)
	metrics.Set("nativeWarningFlags", branchSummary.CombinedWarningFlags)
	nativeSetComponentType(metrics, "nativeStrategyType", nativeComponents.DeepCrawlStrategy)
	if err := s.recordNodeCompletion(ctx, nodeCompletionInput{
		WorkflowRunID:    workflowRunID,
		Node:             options.Node,
		StepKey:          "frontier:" + options.Node.ID + ":native-root",
		WorkflowNodeID:   "legacy::native-root:" + options.Node.ID,
		WorkflowNodeType: "deep-discovery",
		Label:            "Native root discovery",
		DurationMs:       int(s.now().Sub(startedAt).Milliseconds()),
		OutputURLs:       scannedSourceURLs,
		OutputCount:      intPointer(createdCount),
		RejectedCount:    rejectedTotal,
		Metrics:          metrics,
	}); err != nil {
		return CrawlExecutionSummary{}, err
	}

	return persisted.Summary, nil
}

// materializeNativeDiscoveryCandidates ports
// layeredExecutor.materializeNativeDiscoveryCandidates (1661-2163).
//
// The native crawl already produced one CrawlResult row per crawled URL, so this
// is the native counterpart of materializeDiscoveredCandidates: instead of
// extracting links it classifies, scores, budgets and persists the crawled URLs
// themselves. Every rejection is recorded as a candidate decision so the
// workflow trace explains why a URL did not become a node.
//
// Unlike the layered materialization the created nodes are stored as
// `completed`: their crawl result already exists (crawlResultId is written right
// after the insert). No BullMQ job is enqueued — NestJS enqueues nothing here.
func (s *Service) materializeNativeDiscoveryCandidates(ctx context.Context, input nativeMaterializeInput) (*nativeDiscoveryMaterialization, error) {
	node := input.Node
	run := input.Run
	var config *crawlfrontierllm.Object
	if input.Profile != nil {
		config = input.Profile.Config
	}

	// const sameDomainHost = new URL(options.node.url).hostname
	sameDomainHost := frontierURLHostname(node.URL)
	// The same-domain filter is skipped when the hostname is empty (NestJS tests
	// `options.requireSameDomainHost` for truthiness).
	var requireSameDomainHost *string
	if sameDomainHost != "" {
		requireSameDomainHost = &sameDomainHost
	}

	// const pageTypeBudgets = computeFrontierPageTypeBudgets({maxDepth, maxPages})
	pageTypeBudgets := crawlfrontierllm.ComputeFrontierPageTypeBudgets(run.MaxDepth, run.MaxPages)

	// const existingNodesForRun = await this.prisma.crawlFrontierNode.findMany({
	//   where: {runId: options.run.id},
	//   select: {canonicalUrl: true, urlFingerprint: true, pageType: true}})
	existingNodes, err := s.nativeListExistingNodes(ctx, run.ID)
	if err != nil {
		return nil, err
	}

	// const seenFingerprints = new Set(existingNodesForRun
	//   .map(entry => entry.urlFingerprint ?? entry.canonicalUrl ?? "")
	//   .filter(entry => entry.length > 0))
	seenFingerprints := make(map[string]struct{}, len(existingNodes))
	for _, existing := range existingNodes {
		key := ""
		if existing.URLFingerprint != nil {
			key = *existing.URLFingerprint
		} else if existing.CanonicalURL != nil {
			key = *existing.CanonicalURL
		}
		if key != "" {
			seenFingerprints[key] = struct{}{}
		}
	}
	// const countsByPageType = this.createPageTypeCountRecord();
	// for (const entry of existingNodesForRun) countsByPageType[entry.pageType] += 1
	countsByPageType := createPageTypeCountRecord()
	for _, existing := range existingNodes {
		discoverIncrementPageType(countsByPageType, existing.PageType)
	}

	// const rootSelfCanonical = buildCanonicalUrlFingerprint(options.node.url,
	//   options.profile.config.urlQueryParamAllowlist);
	// const rootSelfKey = rootSelfCanonical?.fingerprint ??
	//   rootSelfCanonical?.canonicalUrl ?? options.node.url;
	queryParamAllowlist := nativeQueryParamAllowlist(config)
	rootSelfCanonical := crawlfrontierllm.BuildCanonicalURLFingerprint(node.URL, queryParamAllowlist)
	rootSelfKey := nativeDedupeKey(node.URL, rootSelfCanonical)

	// const remainingBudget = Math.max(0, options.run.maxPages - existingNodesForRun.length)
	remainingBudget := run.MaxPages - len(existingNodes)
	if remainingBudget < 0 {
		remainingBudget = 0
	}

	scannedSourceURLs := make([]string, 0, len(input.PersistedResults))
	scannedSourceSet := make(map[string]struct{}, len(input.PersistedResults))
	rejectionCounts := crawlfrontierllm.NewObject()
	acceptedPageTypeCounts := createPageTypeCountRecord()
	selectedPageTypeCounts := createPageTypeCountRecord()
	nativeWarningFlags := newNativeFlagSet(nil)
	acceptedCount := 0
	createdCount := 0

	for _, result := range input.PersistedResults {
		// const sourceUrl = typeof result.sourceUrl === "string" &&
		//   result.sourceUrl.length > 0 ? result.sourceUrl : ""
		sourceURL := ""
		if result.SourceURL != "" {
			sourceURL = result.SourceURL
		}
		if sourceURL == "" {
			discoverBumpCount(rejectionCounts, "invalid_source_url")
			continue
		}

		// const unresolvedSnapshot = this.buildCandidateSnapshot({
		//   url: sourceUrl, status: "active", rejectedReason: null})
		unresolvedSnapshot := crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
			URL:    sourceURL,
			Status: "active",
		})
		// Every decision of this candidate carries the same workflow run and the
		// same source/node id; the branches only override the variable fields.
		baseDecision := crawlfrontierllm.CandidateDecision{
			WorkflowRunID: input.WorkflowRunID,
			SourceNodeID:  node.ID,
			NodeID:        node.ID,
		}

		if _, seen := scannedSourceSet[sourceURL]; seen {
			discoverBumpCount(rejectionCounts, "duplicate_source_url")
			decision := baseDecision
			decision.Candidate = crawlfrontierllm.Candidate{URL: sourceURL, Metadata: json.RawMessage("{}")}
			decision.NodeType = "deep-discovery"
			decision.Action = "filtered"
			decision.Message = "Rejected duplicate source URL from native discovery"
			decision.Status = "rejected"
			decision.Accepted = discoverAccepted(false)
			decision.RejectedReason = stringPointer("duplicate_source_url")
			decision.RuleHits = []string{"duplicate_source_url"}
			decision.BeforeSnapshot = unresolvedSnapshot
			decision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
				URL:            sourceURL,
				Status:         "rejected",
				RejectedReason: stringPointer("duplicate_source_url"),
			})
			if err := s.frontier.RecordCandidateDecision(ctx, decision); err != nil {
				return nil, err
			}
			continue
		}
		scannedSourceSet[sourceURL] = struct{}{}
		scannedSourceURLs = append(scannedSourceURLs, sourceURL)

		if sourceURL == node.URL {
			discoverBumpCount(rejectionCounts, "self_url")
			decision := baseDecision
			decision.Candidate = crawlfrontierllm.Candidate{URL: sourceURL, Metadata: json.RawMessage("{}")}
			decision.NodeType = "deep-discovery"
			decision.Action = "filtered"
			decision.Message = "Rejected self URL from native discovery"
			decision.Status = "rejected"
			decision.Accepted = discoverAccepted(false)
			decision.RejectedReason = stringPointer("self_url")
			decision.RuleHits = []string{"self_url"}
			decision.BeforeSnapshot = unresolvedSnapshot
			decision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
				URL:            sourceURL,
				Status:         "rejected",
				RejectedReason: stringPointer("self_url"),
			})
			if err := s.frontier.RecordCandidateDecision(ctx, decision); err != nil {
				return nil, err
			}
			continue
		}

		// const rejectionReason = shouldRejectFrontierUrl({url: sourceUrl,
		//   config: options.profile.config, requireSameDomainHost: sameDomainHost})
		rejectionReason := frontierShouldRejectURL(frontierRejectURLOptions{
			URL:                   sourceURL,
			Config:                config,
			RequireSameDomainHost: requireSameDomainHost,
		})
		if rejectionReason != nil {
			discoverBumpCount(rejectionCounts, *rejectionReason)
			decision := baseDecision
			decision.Candidate = crawlfrontierllm.Candidate{URL: sourceURL, Metadata: json.RawMessage("{}")}
			decision.NodeType = "url-filter"
			decision.Action = "filtered"
			decision.Message = "Rejected native candidate: " + *rejectionReason
			decision.Status = "rejected"
			decision.Accepted = discoverAccepted(false)
			decision.RejectedReason = rejectionReason
			decision.RuleHits = []string{*rejectionReason}
			decision.BeforeSnapshot = unresolvedSnapshot
			decision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
				URL:            sourceURL,
				Status:         "rejected",
				RejectedReason: rejectionReason,
			})
			if err := s.frontier.RecordCandidateDecision(ctx, decision); err != nil {
				return nil, err
			}
			continue
		}

		// const canonical = buildCanonicalUrlFingerprint(sourceUrl,
		//   options.profile.config.urlQueryParamAllowlist)
		// const dedupeKey = canonical?.fingerprint ?? canonical?.canonicalUrl ?? sourceUrl
		canonical := crawlfrontierllm.BuildCanonicalURLFingerprint(sourceURL, queryParamAllowlist)
		dedupeKey := nativeDedupeKey(sourceURL, canonical)
		if dedupeKey == rootSelfKey {
			discoverBumpCount(rejectionCounts, "self_canonical")
			decision := baseDecision
			decision.Candidate = crawlfrontierllm.Candidate{
				URL:      sourceURL,
				Metadata: nativeObjectJSON(nativeCanonicalMetadata(canonical)),
			}
			decision.NodeType = "url-filter"
			decision.Action = "filtered"
			decision.Message = "Rejected self canonical URL from native discovery"
			decision.Status = "rejected"
			decision.Accepted = discoverAccepted(false)
			decision.RejectedReason = stringPointer("self_canonical")
			decision.RuleHits = []string{"self_canonical"}
			decision.BeforeSnapshot = unresolvedSnapshot
			decision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
				URL:            sourceURL,
				Status:         "rejected",
				RejectedReason: stringPointer("self_canonical"),
			})
			if err := s.frontier.RecordCandidateDecision(ctx, decision); err != nil {
				return nil, err
			}
			continue
		}
		if _, duplicate := seenFingerprints[dedupeKey]; duplicate {
			discoverBumpCount(rejectionCounts, "duplicate")
			decision := baseDecision
			decision.Candidate = crawlfrontierllm.Candidate{
				URL:      sourceURL,
				Metadata: nativeObjectJSON(nativeCanonicalMetadata(canonical)),
			}
			decision.NodeType = "budget-control"
			decision.Action = "budgeted"
			decision.Message = "Rejected duplicate native candidate"
			decision.Status = "rejected"
			decision.Accepted = discoverAccepted(false)
			decision.RejectedReason = stringPointer("duplicate")
			decision.RuleHits = []string{"duplicate"}
			decision.BeforeSnapshot = unresolvedSnapshot
			decision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
				URL:            sourceURL,
				Status:         "rejected",
				RejectedReason: stringPointer("duplicate"),
			})
			if err := s.frontier.RecordCandidateDecision(ctx, decision); err != nil {
				return nil, err
			}
			continue
		}

		// const pageType = inferFrontierPageType({url: sourceUrl,
		//   parentPageType: options.node.pageType, config: options.profile.config})
		pageType := frontierInferPageType(frontierPageTypeOptions{
			URL:            sourceURL,
			ParentPageType: node.PageType,
			Config:         config,
		})
		discoverIncrementPageType(acceptedPageTypeCounts, pageType)
		acceptedCount++
		classifiedCandidate := crawlfrontierllm.Candidate{
			URL:      sourceURL,
			PageType: pageType,
			Metadata: nativeObjectJSON(nativeCanonicalMetadata(canonical)),
		}
		classifiedSnapshot := crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
			URL:      sourceURL,
			PageType: pageType,
			Status:   "active",
		})
		classifiedDecision := baseDecision
		classifiedDecision.Candidate = classifiedCandidate
		classifiedDecision.NodeType = "page-type-classifier"
		classifiedDecision.Action = "classified"
		classifiedDecision.Message = "Classified native candidate as " + pageType
		classifiedDecision.Status = "active"
		classifiedDecision.Accepted = discoverAccepted(true)
		classifiedDecision.BeforeSnapshot = unresolvedSnapshot
		classifiedDecision.AfterSnapshot = classifiedSnapshot
		classifiedDecision.Details = crawlfrontierllm.NewObjectFromPairs("pageType", pageType)
		if err := s.frontier.RecordCandidateDecision(ctx, classifiedDecision); err != nil {
			return nil, err
		}

		// const freshnessScore = estimateFreshnessScore(sourceUrl,
		//   options.profile.config)
		// const score = scoreFrontierCandidate({url: sourceUrl, pageType,
		//   parentPageType: options.node.pageType, config: options.profile.config,
		//   rawScore: 1, freshnessScore})
		//
		// estimateFreshnessScore reads `new Date()` inside its body; the service
		// clock stands in for it so tests can pin the age bands.
		freshnessScore := frontierEstimateFreshnessScore(sourceURL, config, s.now())
		score := frontierScoreCandidate(frontierScoreOptions{
			URL:            sourceURL,
			PageType:       pageType,
			ParentPageType: node.PageType,
			Config:         config,
			RawScore:       1,
			FreshnessScore: &freshnessScore,
		})

		// const rawResult = options.rawResultsByUrl.get(sourceUrl)
		// const statusCode = typeof rawResult?.statusCode === "number"
		//   ? rawResult.statusCode
		//   : typeof rawResult?.status_code === "number" ? rawResult.status_code : null
		//
		// crawl4ai.PipelineArticle already merged statusCode/status_code with the
		// same precedence, so the two reads collapse into one pointer.
		rawResult, hasRawResult := input.RawResultsByURL[sourceURL]
		var statusCode *int
		if hasRawResult {
			statusCode = rawResult.StatusCode
		}
		// const crawlError = typeof rawResult?.error === "string" ? rawResult.error
		//   : typeof rawResult?.errorMessage === "string" ? ...
		//   : typeof rawResult?.error_message === "string" ? ... : null
		//
		// Documented difference: crawl4ai.PipelineArticle keeps a single Error
		// string built as firstNonEmpty(errorMessage, error_message, error), i.e.
		// the camelCase message wins over `error`, while this NestJS read prefers
		// `error`. The two only differ when the server sends both; the failure
		// classification reads either text the same way.
		var crawlError *string
		if hasRawResult && rawResult.Error != "" {
			value := rawResult.Error
			crawlError = &value
		}
		failureKind := crawlfrontierllm.ClassifyFrontierFailureKind(crawlError)
		if failureKind == nil && statusCode != nil {
			switch *statusCode {
			case 401, 403, 429:
				kind := "challenge_detected"
				failureKind = &kind
			}
		}
		// const warningFlags = uniqueStringList(
		//   failureKind ? [failureKind] : undefined,
		//   typeof statusCode === "number" && statusCode >= 400
		//     ? [`http_${statusCode}`] : undefined) ?? []
		var failureFlags []string
		if failureKind != nil {
			failureFlags = []string{*failureKind}
		}
		var statusFlags []string
		if statusCode != nil && *statusCode >= 400 {
			statusFlags = []string{fmt.Sprintf("http_%d", *statusCode)}
		}
		warningFlags := crawlfrontierllm.UniqueStringList(failureFlags, statusFlags)
		if warningFlags == nil {
			warningFlags = []string{}
		}
		for _, flag := range warningFlags {
			nativeWarningFlags.add(flag)
		}

		// const scoredCandidate = {...classifiedCandidate, score, freshnessScore,
		//   metadata: {...classifiedCandidate.metadata, failureKind, warningFlags}}
		scoredMetadata := nativeCanonicalMetadata(canonical)
		if failureKind == nil {
			scoredMetadata.SetNull("failureKind")
		} else {
			scoredMetadata.SetString("failureKind", *failureKind)
		}
		scoredMetadata.Set("warningFlags", warningFlags)
		scoredCandidate := crawlfrontierllm.Candidate{
			URL:            sourceURL,
			PageType:       pageType,
			Score:          score,
			FreshnessScore: freshnessScore,
			Metadata:       nativeObjectJSON(scoredMetadata),
		}
		scoredSnapshot := crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
			URL:            sourceURL,
			PageType:       pageType,
			Score:          &score,
			FreshnessScore: &freshnessScore,
			Status:         "active",
		})
		scoredDecision := baseDecision
		scoredDecision.Candidate = scoredCandidate
		scoredDecision.NodeType = "url-scorer"
		scoredDecision.Action = "scored"
		scoredDecision.Message = "Native discovery candidate scored for persistence"
		scoredDecision.Status = "active"
		scoredDecision.Accepted = discoverAccepted(true)
		scoredDecision.ScoreDelta = &score
		scoredDecision.FreshnessDelta = &freshnessScore
		scoredDecision.RuleHits = []string{"url_scored", "native_scored"}
		scoredDecision.BeforeSnapshot = classifiedSnapshot
		scoredDecision.AfterSnapshot = scoredSnapshot
		if err := s.frontier.RecordCandidateDecision(ctx, scoredDecision); err != nil {
			return nil, err
		}

		// const compositeScore = Number((score + freshnessScore).toFixed(4))
		compositeScore := crawlfrontierllm.RoundToFixed(score+freshnessScore, 4)

		if createdCount >= remainingBudget {
			discoverBumpCount(rejectionCounts, "run_budget_exhausted")
			decision := baseDecision
			decision.Candidate = scoredCandidate
			decision.NodeType = "budget-control"
			decision.Action = "budgeted"
			decision.Message = "Rejected native candidate because run budget was exhausted"
			decision.Status = "rejected"
			decision.Accepted = discoverAccepted(false)
			decision.RejectedReason = stringPointer("run_budget_exhausted")
			decision.RuleHits = []string{"run_budget_exhausted"}
			decision.BeforeSnapshot = scoredSnapshot
			decision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
				URL:            sourceURL,
				PageType:       pageType,
				Score:          &score,
				FreshnessScore: &freshnessScore,
				Status:         "rejected",
				RejectedReason: stringPointer("run_budget_exhausted"),
			})
			decision.Details = crawlfrontierllm.NewObjectFromPairs(
				"compositeScore", compositeScore,
				"existingNodeCount", len(existingNodes),
				"maxPages", run.MaxPages,
			)
			if err := s.frontier.RecordCandidateDecision(ctx, decision); err != nil {
				return nil, err
			}
			break
		}
		if nativePageTypeCount(countsByPageType, pageType) >= pageTypeBudgets.Get(pageType) {
			discoverBumpCount(rejectionCounts, "page_type_budget")
			decision := baseDecision
			decision.Candidate = scoredCandidate
			decision.NodeType = "budget-control"
			decision.Action = "budgeted"
			decision.Message = "Rejected native candidate because page type budget was exhausted"
			decision.Status = "rejected"
			decision.Accepted = discoverAccepted(false)
			decision.RejectedReason = stringPointer("page_type_budget")
			decision.RuleHits = []string{"page_type_budget"}
			decision.BeforeSnapshot = scoredSnapshot
			decision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
				URL:            sourceURL,
				PageType:       pageType,
				Score:          &score,
				FreshnessScore: &freshnessScore,
				Status:         "rejected",
				RejectedReason: stringPointer("page_type_budget"),
			})
			decision.Details = crawlfrontierllm.NewObjectFromPairs(
				"compositeScore", compositeScore,
				"pageType", pageType,
				"pageTypeBudget", pageTypeBudgets.Get(pageType),
				"currentPageTypeCount", nativePageTypeCount(countsByPageType, pageType),
			)
			if err := s.frontier.RecordCandidateDecision(ctx, decision); err != nil {
				return nil, err
			}
			continue
		}

		// const queueClass = resolveNodeQueueClass({pageType, freshnessScore})
		queueClass := crawlfrontierllm.ResolveNodeQueueClass(pageType)
		keptDecision := baseDecision
		keptDecision.Candidate = scoredCandidate
		keptDecision.NodeType = "budget-control"
		keptDecision.Action = "budgeted"
		keptDecision.Message = "Kept native candidate within materialization budget"
		keptDecision.Status = "active"
		keptDecision.Accepted = discoverAccepted(true)
		keptDecision.RuleHits = []string{"kept_by_budget"}
		keptDecision.BeforeSnapshot = scoredSnapshot
		keptDecision.AfterSnapshot = scoredSnapshot
		keptDecision.Details = crawlfrontierllm.NewObjectFromPairs(
			"compositeScore", compositeScore,
			"queueClass", queueClass,
			"pageType", pageType,
		)
		if err := s.frontier.RecordCandidateDecision(ctx, keptDecision); err != nil {
			return nil, err
		}

		// const persisted = await this.persistFrontierNode({
		//   runId, parentNodeId: options.node.id, orgId: options.node.orgId,
		//   url: sourceUrl, canonicalUrl, urlFingerprint, pageType,
		//   depth: Math.min(options.run.maxDepth, pageType === "article" ? 3 : 1),
		//   queueClass, status: "completed", crawledAt: new Date(),
		//   crawlResultId: result.id, score, freshnessScore,
		//   metadata: toPrismaJsonValue({nativeDiscovered: true, sourceTier,
		//     discoveryPath: ["home", pageType], frontierPath: ["home", pageType],
		//     failureKind, warningFlags,
		//     freshnessBucket: resolveFreshnessBucket(freshnessScore)})})
		childDepth := frontierMinInt(run.MaxDepth, 1)
		if pageType == "article" {
			childDepth = frontierMinInt(run.MaxDepth, 3)
		}
		childMetadata := crawlfrontierllm.NewObject()
		childMetadata.SetBool("nativeDiscovered", true)
		childMetadata.SetString("sourceTier", nativeConfigString(config, "sourceTier", "tier2"))
		childMetadata.Set("discoveryPath", []string{"home", pageType})
		childMetadata.Set("frontierPath", []string{"home", pageType})
		if failureKind == nil {
			childMetadata.SetNull("failureKind")
		} else {
			childMetadata.SetString("failureKind", *failureKind)
		}
		childMetadata.Set("warningFlags", warningFlags)
		childMetadata.SetString("freshnessBucket", crawlfrontierllm.ResolveFreshnessBucket(freshnessScore))
		nodeID, _, created, err := s.frontier.PersistFrontierNode(ctx, crawlfrontierllm.PersistNodeInput{
			RunID:          run.ID,
			ParentNodeID:   node.ID,
			OrgID:          node.OrgID,
			URL:            sourceURL,
			CanonicalURL:   nativeCanonicalString(canonical, false),
			URLFingerprint: nativeCanonicalString(canonical, true),
			PageType:       pageType,
			Depth:          childDepth,
			QueueClass:     queueClass,
			Status:         "completed",
			Score:          &score,
			FreshnessScore: &freshnessScore,
			Metadata:       childMetadata,
		})
		if err != nil {
			return nil, err
		}
		if created {
			// The NestJS create() also sets crawledAt and crawlResultId; the shared
			// insert does not carry them, so the two columns are written right after
			// the insert. updatedAt is left alone, exactly like the Prisma insert.
			if err := s.nativeStampNativeNode(ctx, nodeID, result.ID); err != nil {
				return nil, err
			}
			discoverIncrementPageType(countsByPageType, pageType)
			discoverIncrementPageType(selectedPageTypeCounts, pageType)
			createdCount++
		}
		persistedDecision := baseDecision
		persistedDecision.Candidate = scoredCandidate
		persistedDecision.NodeType = "persist-result"
		persistedDecision.Action = "persisted"
		persistedDecision.Message = "Native candidate materialized into frontier topology"
		persistedDecision.Status = "selected"
		persistedDecision.Accepted = discoverAccepted(true)
		persistedDecision.RuleHits = []string{"selected_for_persistence", "native_discovery"}
		persistedDecision.BeforeSnapshot = scoredSnapshot
		persistedDecision.AfterSnapshot = crawlfrontierllm.BuildCandidateSnapshot(crawlfrontierllm.CandidateSnapshot{
			URL:            sourceURL,
			PageType:       pageType,
			Score:          &score,
			FreshnessScore: &freshnessScore,
			Status:         "selected",
		})
		persistedDecision.Details = crawlfrontierllm.NewObjectFromPairs(
			"compositeScore", compositeScore,
			"queueClass", queueClass,
		)
		if err := s.frontier.RecordCandidateDecision(ctx, persistedDecision); err != nil {
			return nil, err
		}
		seenFingerprints[dedupeKey] = struct{}{}
	}

	// if (options.workflowRunId) await this.strategyRecorder.upsertStep(
	//   options.workflowRunId, {stepKey: `frontier:${node.id}:materialize-native`,
	//   nodeId: `legacy::native-materialize:${node.id}`,
	//   nodeType: "persist-result", label: "Materialize native discovery
	//   candidates", status: "completed", durationMs: 0,
	//   inputCount: options.persistedResults.length, outputCount: createdCount,
	//   rejectedCount: Object.values(rejectionCounts).reduce(...),
	//   sampleUrls: Array.from(scannedSourceUrls).slice(0, 5),
	//   metrics: {acceptedCount, createdCount, selectedPageTypeCounts,
	//   rejectionCounts, nativeWarningFlags: Array.from(nativeWarningFlags)}})
	if input.WorkflowRunID != "" {
		sampleURLs := scannedSourceURLs
		if len(sampleURLs) > 5 {
			sampleURLs = sampleURLs[:5]
		}
		metrics := crawlfrontierllm.NewObjectFromPairs(
			"acceptedCount", acceptedCount,
			"createdCount", createdCount,
			"selectedPageTypeCounts", selectedPageTypeCounts,
			"rejectionCounts", rejectionCounts,
			"nativeWarningFlags", nativeWarningFlags.list(),
		)
		if err := s.frontier.UpsertStep(ctx, input.WorkflowRunID, crawlfrontierllm.WorkflowStep{
			StepKey:       "frontier:" + node.ID + ":materialize-native",
			NodeID:        "legacy::native-materialize:" + node.ID,
			NodeType:      "persist-result",
			Label:         "Materialize native discovery candidates",
			Status:        "completed",
			DurationMs:    0,
			InputCount:    len(input.PersistedResults),
			OutputCount:   createdCount,
			RejectedCount: discoverRejectionTotal(rejectionCounts),
			SampleURLs:    sampleURLs,
			Metrics:       metrics,
		}); err != nil {
			return nil, err
		}
	}

	return &nativeDiscoveryMaterialization{
		AcceptedCount:          acceptedCount,
		CreatedCount:           createdCount,
		ScannedSourceURLs:      scannedSourceURLs,
		RejectionCounts:        rejectionCounts,
		AcceptedPageTypeCounts: acceptedPageTypeCounts,
		SelectedPageTypeCounts: selectedPageTypeCounts,
		NativeWarningFlags:     nativeWarningFlags.list(),
	}, nil
}

// nativeUpdateRunNativeRunID is
//
//	this.prisma.crawlFrontierRun.update({where: {id},
//	  data: {nativeRunId: response.runId ?? undefined}})
//
// Prisma drops the undefined member but still writes @updatedAt, so the update
// always touches updatedAt and only writes the column when crawl4ai returned a
// run id.
func (s *Service) nativeUpdateRunNativeRunID(ctx context.Context, runID, nativeRunID string) error {
	if nativeRunID == "" {
		_, err := s.db.ExecContext(ctx,
			"UPDATE CrawlFrontierRun SET updatedAt = ? WHERE id = ?",
			s.truncate(s.now()), runID)
		return err
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE CrawlFrontierRun SET nativeRunId = ?, updatedAt = ? WHERE id = ?",
		nativeRunID, s.truncate(s.now()), runID)
	return err
}

// nativeExistingNode is the `{canonicalUrl, urlFingerprint, pageType}` row
// projection materializeNativeDiscoveryCandidates reads.
type nativeExistingNode struct {
	CanonicalURL   *string
	URLFingerprint *string
	PageType       string
}

// nativeListExistingNodes is
//
//	this.prisma.crawlFrontierNode.findMany({where: {runId},
//	  select: {canonicalUrl: true, urlFingerprint: true, pageType: true}})
//
// which materializeNativeDiscoveryCandidates uses for the fingerprint set, the
// per-page-type counts and the remaining run budget.
func (s *Service) nativeListExistingNodes(ctx context.Context, runID string) ([]nativeExistingNode, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT canonicalUrl, urlFingerprint, pageType FROM CrawlFrontierNode WHERE runId = ?", runID)
	if err != nil {
		return nil, fmt.Errorf("crawlfrontiernode: list frontier nodes for run: %w", err)
	}
	defer rows.Close()
	out := make([]nativeExistingNode, 0)
	for rows.Next() {
		var (
			canonical, fingerprint sql.NullString
			pageType               string
		)
		if err := rows.Scan(&canonical, &fingerprint, &pageType); err != nil {
			return nil, err
		}
		out = append(out, nativeExistingNode{
			CanonicalURL:   nullString(canonical),
			URLFingerprint: nullString(fingerprint),
			PageType:       pageType,
		})
	}
	return out, rows.Err()
}

// nativeStampNativeNode writes the two columns the shared insert does not carry:
// the NestJS create() of materializeNativeDiscoveryCandidates passes
// `crawledAt: new Date()` and `crawlResultId: result.id`.
func (s *Service) nativeStampNativeNode(ctx context.Context, nodeID, crawlResultID string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE CrawlFrontierNode SET crawledAt = ?, crawlResultId = ? WHERE id = ?",
		s.truncate(s.now()), crawlResultID, nodeID)
	return err
}

// nativePersistedResultRefs is
// `persisted.results.map(result => ({id: result.id, sourceUrl: result.sourceUrl}))`.
func nativePersistedResultRefs(results []frontierStoredResult) []persistedResultRef {
	out := make([]persistedResultRef, 0, len(results))
	for _, result := range results {
		out = append(out, persistedResultRef{ID: result.ID, SourceURL: result.SourceURL})
	}
	return out
}

// nativeFlagSet is `new Set<string>()` with insertion order: NestJS keeps the
// first-seen order in Array.from and ignores repeated flags.
type nativeFlagSet struct {
	order []string
	seen  map[string]struct{}
}

// newNativeFlagSet seeds the set from an existing ordered flag list.
func newNativeFlagSet(initial []string) *nativeFlagSet {
	set := &nativeFlagSet{seen: make(map[string]struct{}, len(initial))}
	for _, flag := range initial {
		set.add(flag)
	}
	return set
}

// add inserts a flag, keeping the first position.
func (set *nativeFlagSet) add(flag string) {
	if flag == "" {
		return
	}
	if _, exists := set.seen[flag]; exists {
		return
	}
	set.seen[flag] = struct{}{}
	set.order = append(set.order, flag)
}

// list is Array.from(set): the insertion order as a fresh, non-nil slice.
func (set *nativeFlagSet) list() []string {
	out := make([]string, len(set.order))
	copy(out, set.order)
	return out
}

// nativeToNumericRecord is toNumericRecord: every member that Number() coerces
// to a finite number, in source key order; an object without numeric members is
// undefined (nil here).
func nativeToNumericRecord(object *crawlfrontierllm.Object) *crawlfrontierllm.Object {
	if object == nil {
		return nil
	}
	out := crawlfrontierllm.NewObject()
	for _, key := range object.Keys() {
		value, ok := object.Number(key)
		if !ok {
			continue
		}
		out.SetNumber(key, value)
	}
	if out.Len() == 0 {
		return nil
	}
	return out
}

// nativeNumericMember is `record?.key ?? 0` for a numeric record.
func nativeNumericMember(object *crawlfrontierllm.Object, key string) float64 {
	if object == nil {
		return 0
	}
	value, ok := object.Number(key)
	if !ok {
		return 0
	}
	return value
}

// nativePageTypeCount is `record[pageType]` for a page-type counter record.
func nativePageTypeCount(counts *crawlfrontierllm.Object, pageType string) int {
	if counts == nil {
		return 0
	}
	value, ok := counts.Number(pageType)
	if !ok {
		return 0
	}
	return int(value)
}

// nativeConfigString is `config?.key ?? fallback` for a string member.
func nativeConfigString(config *crawlfrontierllm.Object, key, fallback string) string {
	if value, ok := config.String(key); ok {
		return value
	}
	return fallback
}

// nativeFallbackToLayered is `config.nativeOptions?.fallbackToLayered !== false`.
func nativeFallbackToLayered(config *crawlfrontierllm.Object) bool {
	nativeOptions, ok := config.Object("nativeOptions")
	if !ok || nativeOptions == nil {
		return true
	}
	if value, ok := nativeOptions.Bool("fallbackToLayered"); ok {
		return value
	}
	return true
}

// nativeQueryParamAllowlist is `config.urlQueryParamAllowlist` as
// buildCanonicalUrlFingerprint reads it: the JSON string array, nil when the
// member is absent, in which case the default allowlist applies.
func nativeQueryParamAllowlist(config *crawlfrontierllm.Object) []string {
	values, ok := config.Strings("urlQueryParamAllowlist")
	if !ok {
		return nil
	}
	return values
}

// nativeDedupeKey is `canonical?.fingerprint ?? canonical?.canonicalUrl ?? url`.
func nativeDedupeKey(rawURL string, canonical *crawlfrontierllm.CanonicalURL) string {
	if canonical != nil {
		if canonical.Fingerprint != "" {
			return canonical.Fingerprint
		}
		if canonical.CanonicalURL != "" {
			return canonical.CanonicalURL
		}
	}
	return rawURL
}

// nativeCanonicalString reads one half of buildCanonicalUrlFingerprint's result
// as the nullable column value the insert takes.
func nativeCanonicalString(canonical *crawlfrontierllm.CanonicalURL, fingerprint bool) *string {
	if canonical == nil {
		return nil
	}
	if fingerprint {
		value := canonical.Fingerprint
		return &value
	}
	value := canonical.CanonicalURL
	return &value
}

// nativeCanonicalMetadata is the `{canonicalUrl: canonical?.canonicalUrl ?? null,
// urlFingerprint: canonical?.fingerprint ?? null}` candidate metadata literal.
func nativeCanonicalMetadata(canonical *crawlfrontierllm.CanonicalURL) *crawlfrontierllm.Object {
	metadata := crawlfrontierllm.NewObject()
	if canonical == nil {
		metadata.SetNull("canonicalUrl")
		metadata.SetNull("urlFingerprint")
		return metadata
	}
	metadata.SetString("canonicalUrl", canonical.CanonicalURL)
	metadata.SetString("urlFingerprint", canonical.Fingerprint)
	return metadata
}

// nativeObjectJSON marshals an ordered object into the candidate metadata leaf.
// The encoder cannot fail for an Object of raw JSON leaves; the empty object is
// the defensive fallback.
func nativeObjectJSON(object *crawlfrontierllm.Object) json.RawMessage {
	encoded, err := object.MarshalJSON()
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

// nativeSetComponentType is `component?.type ?? null` for one native component
// member.
func nativeSetComponentType(object *crawlfrontierllm.Object, key string, component *crawlDeepCrawlComponent) {
	if component == nil {
		object.SetNull(key)
		return
	}
	object.SetString(key, component.Type)
}

// frontierMinInt is Math.min for the two int operands used by the materializer
// (`Math.min(options.run.maxDepth, pageType === "article" ? 3 : 1)`).
func frontierMinInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

// nativeSetOptionalString is `value ?? null` for an optional string member.
func nativeSetOptionalString(object *crawlfrontierllm.Object, key string, value *string) {
	if value == nil {
		object.SetNull(key)
		return
	}
	object.SetString(key, *value)
}
