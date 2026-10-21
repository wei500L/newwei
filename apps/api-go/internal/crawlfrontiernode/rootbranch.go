package crawlfrontiernode

// rootbranch.go ports CrawlStrategyRootExecutorService
// (apps/api/src/modules/crawl/crawl-strategy-root-executor.service.ts 129-441)
// and the crawl-frontier.service.ts wrappers it is called through
// (3447-3508). recordResolvedLlmCandidateDecisions is deliberately absent: it
// belongs to the deferred judge worker that already implements it inside
// internal/crawlfrontierllm, and this package has no caller for it.
//
// Everything below keeps the NestJS value semantics:
//   - an option the NestJS object literal leaves undefined is a nil pointer here;
//   - `x ?? fallback` uses the nullish test, so an explicit JSON null falls back
//     while a zero value does not (see rootNumberOr / rootStringOr);
//   - `x ?? null` writes an explicit JSON null key (SetNull), because the key is
//     present in the serialized object;
//   - `undefined` keys of an object literal are dropped from the JSON, so those
//     keys are simply not inserted.
//
// The metadata patch buildRootBranchSummary returns is applied by the caller, so
// this file never writes CrawlFrontierNode.metadata except through the one
// deferred-judge counter helper in defer_llm.go.

import (
	"context"
	"encoding/json"
	"math"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// resolveSeedStrategy ports rootExecutor.resolveSeedStrategy (129-131):
// `config.seedDiscovery?.strategy ?? "auto"`. The shared resolver already keeps
// the same fallback and trimming, so it is reused instead of re-read here.
func (s *Service) resolveSeedStrategy(config *crawlfrontierllm.Object) string {
	return crawlfrontierllm.ResolveSeedStrategyValue(config)
}

// resolveSeedDiscoveryConfig ports rootExecutor.resolveSeedDiscoveryConfig
// (133-162). The NestJS body is
//
//	mode:  seedDiscovery?.mode ?? "robots"
//	freshnessWindowHours: Math.max(1, seedDiscovery?.freshnessWindowHours ?? 168)
//	maxSeedUrls:          Math.max(1, seedDiscovery?.maxSeedUrls ?? Math.min(120, maxPages))
//	topologyBudgetPages:  Math.max(1, seedDiscovery?.topologyBudgetPages ?? Math.min(12, maxPages))
//	topologyBudgetDepth:  Math.max(1, seedDiscovery?.topologyBudgetDepth ?? Math.min(2, maxDepth))
//	qualityThresholds:    every leaf `?? default`
//
// The resolved struct stores the four budgets as ints (types.go), so the float
// Math.max result is converted with JS Math.round. The profile schema constrains
// all four to integers (crawl-frontier-llm.service.ts 63 and the sibling
// z.number().int() fields), so the rounding only matters for hand-written
// config documents.
func (s *Service) resolveSeedDiscoveryConfig(config *crawlfrontierllm.Object, maxPages, maxDepth int) resolvedSeedDiscoveryConfig {
	seed, _ := config.Object("seedDiscovery")
	thresholds, _ := seed.Object("qualityThresholds")
	return resolvedSeedDiscoveryConfig{
		Mode:                 rootStringOr(seed, "mode", "robots"),
		FreshnessWindowHours: rootMaxFloat(1, rootNumberOr(seed, "freshnessWindowHours", 24*7)),
		MaxSeedURLs:          rootRoundInt(rootMaxFloat(1, rootNumberOr(seed, "maxSeedUrls", float64(rootMinInt(120, maxPages))))),
		TopologyBudgetPages:  rootRoundInt(rootMaxFloat(1, rootNumberOr(seed, "topologyBudgetPages", float64(rootMinInt(12, maxPages))))),
		TopologyBudgetDepth:  rootRoundInt(rootMaxFloat(1, rootNumberOr(seed, "topologyBudgetDepth", float64(rootMinInt(2, maxDepth))))),
		QualityThresholds: crawlfrontierllm.SeedQualityThresholds{
			MinCandidates:   rootNumberOr(thresholds, "minCandidates", 3),
			MinArticleRatio: rootNumberOr(thresholds, "minArticleRatio", 0.4),
			MaxNoiseRatio:   rootNumberOr(thresholds, "maxNoiseRatio", 0.45),
			MinFreshRatio:   rootNumberOr(thresholds, "minFreshRatio", 0.2),
		},
	}
}

// resolveRootSeedPlan ports rootExecutor.resolveRootSeedPlan (164-196). The
// topology budget is only enabled for a depth-0 node whose seed strategy still
// walks the topology; both optional fields and the metadata patch are undefined
// for every other node, which is a nil pointer / nil object here.
func (s *Service) resolveRootSeedPlan(nodeDepth int, profile *crawlfrontierllm.ProfileRecord, maxPages, maxDepth int) rootSeedPlan {
	var config *crawlfrontierllm.Object
	if profile != nil {
		config = profile.Config
	}
	seedStrategy := s.resolveSeedStrategy(config)
	seedConfig := s.resolveSeedDiscoveryConfig(config, maxPages, maxDepth)
	enableTopologyBudget := nodeDepth == 0 &&
		seedStrategy != "frontier_only" &&
		seedStrategy != "frontier_first"
	plan := rootSeedPlan{SeedStrategy: seedStrategy, SeedConfig: seedConfig}
	if enableTopologyBudget {
		plan.TopologyBudgetDepth = intPointer(seedConfig.TopologyBudgetDepth)
		plan.TopologyBudgetPages = intPointer(seedConfig.TopologyBudgetPages)
		plan.TopologyMetadataPatch = crawlfrontierllm.NewObjectFromPairs(
			"topologyChannel", true,
			"topologyDepthLimit", seedConfig.TopologyBudgetDepth,
		)
	}
	return plan
}

// executeRootSeedBranch ports rootExecutor.executeRootSeedBranch (198-213) plus
// the crawl-frontier.service.ts wrapper (3456-3483). NestJS takes a
// `discoverSeedBranch` callback; the Go port calls discoverSeedNodes directly
// with the same five arguments the wrapper closes over.
//
// The branch event is recorded only after a successful discovery: a throwing
// callback propagates without an event, and the error is returned unchanged.
// rootSeedBranchEventInput.SeedPlan and .DiscoveryError are not read here —
// NestJS passes neither (recordRootSeedBranchEvent 261-266 takes only
// workflowRunId, node, seedStrategy and seedDiscovery), so they stay zero.
func (s *Service) executeRootSeedBranch(ctx context.Context, input rootSeedBranchInput) (*seedDiscoveryOutcome, error) {
	seedDiscovery, err := s.discoverSeedNodes(ctx, discoverSeedNodesInput{
		Node:             input.Node,
		Run:              input.Run,
		Profile:          input.Profile,
		TaskID:           input.TaskID,
		RequestTimeoutMs: input.RequestTimeoutMs,
	})
	if err != nil {
		return nil, err
	}
	if err := s.recordRootSeedBranchEvent(ctx, rootSeedBranchEventInput{
		WorkflowRunID: input.WorkflowRunID,
		Node:          input.Node,
		SeedStrategy:  input.SeedStrategy,
		SeedDiscovery: seedDiscovery,
	}); err != nil {
		return nil, err
	}
	return seedDiscovery, nil
}

// buildRootBranchSummary ports rootExecutor.buildRootBranchSummary (214-259).
//
// combinedWarningFlags is one uniqueStringList over five lists, in this order:
// the node's own flags (which already fold failureKind in), the runtime
// metadata flags, extraWarningFlags, the branch metadata flags and the seed
// discovery diagnostics flags. pendingLlmJudgeJobs is the clamped sum of the
// two deferred counters, and the deferred modes are de-duplicated the same way.
//
// Every `?? []` in the NestJS body becomes an empty (non-nil) slice, because the
// value is written into the metadata patch instead of being spread into a
// caller-owned object.
func (s *Service) buildRootBranchSummary(input rootBranchSummaryInput) rootBranchSummary {
	diagnostics := rootDiagnosticsObject(input.SeedDiscovery)
	combinedWarningFlags := crawlfrontierllm.UniqueStringList(
		crawlfrontierllm.CollectNodeWarningFlags(input.NodeMetadata, input.LastError),
		crawlfrontierllm.ObjectStrings(input.RuntimeMetadata, "warningFlags"),
		input.ExtraWarningFlags,
		crawlfrontierllm.ObjectStrings(input.BranchMetadata, "warningFlags"),
		crawlfrontierllm.ObjectStrings(diagnostics, "warningFlags"),
	)
	if combinedWarningFlags == nil {
		combinedWarningFlags = []string{}
	}
	pendingLlmJudgeJobs := crawlfrontierllm.ClampInt(rootRawValue(input.BranchMetadata, "llmJudgeDeferredCount"), 0, 10, 0) +
		crawlfrontierllm.ClampInt(rootRawValue(diagnostics, "llmJudgeDeferredCount"), 0, 10, 0)
	llmJudgeDeferredModes := crawlfrontierllm.UniqueStringList(
		rootDeferredMode(input.BranchMetadata),
		rootDeferredMode(diagnostics),
	)
	if llmJudgeDeferredModes == nil {
		llmJudgeDeferredModes = []string{}
	}
	// Key order matters: seedStrategy, topologyBudgetPages, topologyBudgetDepth
	// are merged into the node metadata after the counters.
	metadataPatch := crawlfrontierllm.NewObjectFromPairs(
		"warningFlags", combinedWarningFlags,
		"pendingLlmJudgeJobs", pendingLlmJudgeJobs,
		"llmJudgeDeferredModes", llmJudgeDeferredModes,
		"seedStrategy", input.SeedPlan.SeedStrategy,
		"topologyBudgetPages", input.SeedPlan.TopologyBudgetPages,
		"topologyBudgetDepth", input.SeedPlan.TopologyBudgetDepth,
	)
	return rootBranchSummary{
		CombinedWarningFlags:  combinedWarningFlags,
		PendingLlmJudgeJobs:   pendingLlmJudgeJobs,
		LlmJudgeDeferredModes: llmJudgeDeferredModes,
		MetadataPatch:         metadataPatch,
	}
}

// recordRootSeedBranchEvent ports rootExecutor.recordRootSeedBranchEvent
// (261-341). Only a depth-0 node of a workflow run records anything, and a
// frontier_only strategy or an absent discovery outcome records the skip event.
//
// beforeCount falls back from diagnostics.candidateStats.accepted to
// diagnostics.seedYield.selected to 0 through toFiniteNumber, so an explicit
// null accepted count resolves to 0 instead of falling through.
func (s *Service) recordRootSeedBranchEvent(ctx context.Context, input rootSeedBranchEventInput) error {
	if input.WorkflowRunID == "" || input.Node == nil || input.Node.Depth != 0 {
		return nil
	}
	if input.SeedStrategy == "frontier_only" || input.SeedDiscovery == nil {
		triggerReason := "seed_branch_unavailable"
		if input.SeedStrategy == "frontier_only" {
			triggerReason = "frontier_only"
		}
		return s.frontier.AppendEvent(ctx, input.WorkflowRunID, crawlfrontierllm.WorkflowEvent{
			Level:         "info",
			EventType:     "seed_branch_skipped",
			NodeID:        stringPointer(input.Node.ID),
			NodeType:      stringPointer("branch"),
			Message:       "Seed branch was skipped for this root execution",
			TriggerReason: &triggerReason,
			BeforeCount:   intPointer(0),
			AfterCount:    intPointer(0),
			RescuedCount:  intPointer(0),
			Details: crawlfrontierllm.NewObjectFromPairs(
				"seedStrategy", input.SeedStrategy,
				"pageType", input.Node.PageType,
			),
			Timestamp: s.frontier.NowISO(),
		})
	}

	diagnostics := rootDiagnosticsObject(input.SeedDiscovery)
	candidateStats := rootObjectLeaf(diagnostics, "candidateStats")
	seedYield := rootObjectLeaf(diagnostics, "seedYield")
	beforeCount, ok := rootFiniteNumber(candidateStats, "accepted")
	if !ok {
		beforeCount, ok = rootFiniteNumber(seedYield, "selected")
	}
	if !ok {
		beforeCount = 0
	}
	afterCount := input.SeedDiscovery.Created
	fallbackStage, hasFallbackStage := rootStringLeaf(diagnostics, "fallbackStage")

	triggerReason := input.SeedStrategy
	rescuedCount := 0
	if hasFallbackStage && fallbackStage == "seed" {
		triggerReason = "seed_selected"
		rescuedCount = afterCount
	} else if hasFallbackStage && fallbackStage == "frontier" {
		triggerReason = "seed_to_frontier"
	}

	// details: { seedStrategy, fallbackStage, seedQuality, seedDiscoveryMode }.
	details := crawlfrontierllm.NewObject()
	details.SetString("seedStrategy", input.SeedStrategy)
	if hasFallbackStage {
		details.SetString("fallbackStage", fallbackStage)
	} else {
		details.SetNull("fallbackStage")
	}
	if seedQuality := rootObjectLeaf(diagnostics, "seedQuality"); seedQuality != nil {
		details.Set("seedQuality", seedQuality)
	} else {
		details.SetNull("seedQuality")
	}
	if seedDiscoveryMode, ok := rootStringLeaf(diagnostics, "seedDiscoveryMode"); ok {
		details.SetString("seedDiscoveryMode", seedDiscoveryMode)
	} else {
		details.SetNull("seedDiscoveryMode")
	}

	level := "warn"
	message := "Seed branch did not materialize frontier candidates"
	if afterCount > 0 {
		level = "info"
		message = "Seed branch materialized frontier candidates"
	}
	return s.frontier.AppendEvent(ctx, input.WorkflowRunID, crawlfrontierllm.WorkflowEvent{
		Level:         level,
		EventType:     "seed_branch_completed",
		NodeID:        stringPointer(input.Node.ID),
		NodeType:      stringPointer("branch"),
		Message:       message,
		TriggerReason: &triggerReason,
		BeforeCount:   intPointer(rootRoundInt(beforeCount)),
		AfterCount:    intPointer(afterCount),
		RescuedCount:  intPointer(rescuedCount),
		Details:       details,
		Timestamp:     s.frontier.NowISO(),
	})
}

// recordNativeFallbackExecution ports rootExecutor.recordNativeFallbackExecution
// (343-407): one fallback-strategy step plus the native_to_layered_fallback
// event. Both are skipped when there is no workflow run or no fallback
// discovery metadata to describe.
func (s *Service) recordNativeFallbackExecution(ctx context.Context, input nativeFallbackInput) error {
	if input.WorkflowRunID == "" || input.FallbackDiscoveryMetadata == nil {
		return nil
	}
	candidateStats := rootObjectLeaf(input.FallbackDiscoveryMetadata, "candidateStats")
	rejectionCounts := rootObjectLeaf(input.FallbackDiscoveryMetadata, "rejectionCounts")
	fallbackSelected := 0.0
	if value, ok := rootFiniteNumber(candidateStats, "selected"); ok {
		fallbackSelected = value
	}
	fallbackRejected := 0.0
	if value, ok := rootFiniteNumber(candidateStats, "rejected"); ok {
		fallbackRejected = value
	}
	selectedCount := rootRoundInt(fallbackSelected)

	status := "failed"
	var stepError *string
	if fallbackSelected > 0 {
		status = "completed"
	} else {
		value := input.TriggerReason
		stepError = &value
	}
	if err := s.frontier.UpsertStep(ctx, input.WorkflowRunID, crawlfrontierllm.WorkflowStep{
		StepKey:       "frontier:" + input.NodeID + ":native-fallback",
		NodeID:        "legacy::native-fallback:" + input.NodeID,
		NodeType:      "fallback-strategy",
		Label:         "Layered fallback for native root discovery",
		Status:        status,
		DurationMs:    0,
		InputCount:    1,
		OutputCount:   selectedCount,
		RejectedCount: rootRoundInt(fallbackRejected),
		SampleURLs:    []string{},
		Metrics: crawlfrontierllm.NewObjectFromPairs(
			"triggerReason", input.TriggerReason,
			"candidateStats", candidateStats,
			"rejectionCounts", rejectionCounts,
		),
		Error: stepError,
	}); err != nil {
		return err
	}
	return s.frontier.AppendEvent(ctx, input.WorkflowRunID, crawlfrontierllm.WorkflowEvent{
		Level:         "warn",
		EventType:     "native_to_layered_fallback",
		NodeID:        stringPointer(input.NodeID),
		NodeType:      stringPointer("fallback-strategy"),
		Message:       "Native root discovery fell back to layered discovery",
		TriggerReason: &input.TriggerReason,
		BeforeCount:   intPointer(input.AcceptedCount),
		AfterCount:    intPointer(input.AcceptedCount + selectedCount),
		RescuedCount:  intPointer(selectedCount),
		Details: crawlfrontierllm.NewObjectFromPairs(
			"minAcceptedResults", input.MinAcceptedResults,
			"minArticleResults", input.MinArticleResults,
			"nativeAcceptedResults", input.AcceptedCount,
			"nativeSelectedResults", input.CreatedCount,
			"nativeAcceptedArticles", input.NativeAcceptedArticles,
			"candidateStats", candidateStats,
			"rejectionCounts", rejectionCounts,
		),
		Timestamp: s.frontier.NowISO(),
	})
}

// recordQueuedLlmCandidateDecisions ports rootExecutor's
// recordQueuedLlmCandidateDecisions (409-441): one "branched" trace per deferred
// candidate, with the same snapshot as before- and after-image and the
// llm_judge_deferred rule hit.
func (s *Service) recordQueuedLlmCandidateDecisions(ctx context.Context, workflowRunID string, node *crawlfrontierllm.NodeRecord, mode string, candidates []crawlfrontierllm.Candidate, queuedAt string) error {
	for _, candidate := range candidates {
		activeSnapshot := s.buildCandidateTraceSnapshot(rootCandidateSnapshotInput{
			URL:            candidate.URL,
			PageType:       candidate.PageType,
			Score:          &candidate.Score,
			FreshnessScore: &candidate.FreshnessScore,
			Status:         "active",
		})
		if err := s.frontier.RecordCandidateDecision(ctx, crawlfrontierllm.CandidateDecision{
			WorkflowRunID:  workflowRunID,
			SourceNodeID:   node.ID,
			Candidate:      candidate,
			NodeID:         node.ID,
			NodeType:       "branch",
			Action:         "branched",
			Message:        "Deferred " + mode + " candidate to the LLM judge queue",
			Status:         "active",
			Accepted:       rootBoolPointer(true),
			RuleHits:       []string{"llm_judge_deferred"},
			BeforeSnapshot: activeSnapshot,
			AfterSnapshot:  activeSnapshot,
			Details: crawlfrontierllm.NewObjectFromPairs(
				"mode", mode,
				"queuedAt", queuedAt,
			),
		}); err != nil {
			return err
		}
	}
	return nil
}

// buildCandidateTraceSnapshot ports rootExecutor.buildCandidateTraceSnapshot
// (620-643): the seven-key candidate snapshot the layered trace table stores.
// A missing score, freshness or relevance is an explicit JSON null, and the
// absent pageType/status string is null as well (`options.x ?? null`).
//
// Only recordQueuedLlmCandidateDecisions calls this, so the argument set is the
// struct below instead of the NestJS spread of a CrawlStrategyLayeredTraceCandidate.
func (s *Service) buildCandidateTraceSnapshot(input rootCandidateSnapshotInput) *crawlfrontierllm.Object {
	snapshot := crawlfrontierllm.NewObject()
	snapshot.SetString("url", input.URL)
	snapshot.Set("pageType", rootNullableStringValue(&input.PageType))
	snapshot.Set("score", rootNullableFloatValue(input.Score))
	snapshot.Set("freshnessScore", rootNullableFloatValue(input.FreshnessScore))
	snapshot.Set("relevanceScore", rootNullableFloatValue(input.RelevanceScore))
	snapshot.Set("status", rootNullableStringValue(&input.Status))
	snapshot.Set("rejectedReason", rootNullableStringValue(input.RejectedReason))
	return snapshot
}

// rootCandidateSnapshotInput is the subset of CrawlStrategyLayeredTraceCandidate
// buildCandidateTraceSnapshot reads (620-643). An empty pageType/status is the
// NestJS null; a nil float pointer is the NestJS null as well.
type rootCandidateSnapshotInput struct {
	URL            string
	PageType       string
	Score          *float64
	FreshnessScore *float64
	RelevanceScore *float64
	Status         string
	RejectedReason *string
}

// rootDiagnosticsObject is `isPlainObject(seedDiscovery?.diagnostics) ? diagnostics : undefined`.
// NestJS substitutes `{}` at that point; the nil result here reads like `{}`
// because every *Object accessor tolerates a nil receiver, so no empty object
// has to be allocated.
func rootDiagnosticsObject(seedDiscovery *seedDiscoveryOutcome) *crawlfrontierllm.Object {
	if seedDiscovery == nil {
		return nil
	}
	return seedDiscovery.Diagnostics
}

// rootObjectLeaf is `isPlainObject(object?.key) ? object.key : undefined`.
func rootObjectLeaf(object *crawlfrontierllm.Object, key string) *crawlfrontierllm.Object {
	value, ok := object.Object(key)
	if !ok {
		return nil
	}
	return value
}

// rootOrEmptyObject is the `?? {}` leaf the two deferred-judge call sites use
// for a diagnostics object: NestJS normalizes a missing sitemap/extraction
// diagnostics value to `{}` before calling in, so the Go port writes `{}` too.
func rootOrEmptyObject(object *crawlfrontierllm.Object) *crawlfrontierllm.Object {
	if object == nil {
		return crawlfrontierllm.NewObject()
	}
	return object
}

// rootStringLeaf is `typeof object?.key === "string" ? object.key : null`.
func rootStringLeaf(object *crawlfrontierllm.Object, key string) (string, bool) {
	if object == nil {
		return "", false
	}
	return object.UntrimmedString(key)
}

// rootFiniteNumber is toFiniteNumber(object?.key): the JS Number() coercion is
// kept (null becomes 0, a numeric string is parsed) and a non-finite result is
// absent.
func rootFiniteNumber(object *crawlfrontierllm.Object, key string) (float64, bool) {
	if object == nil {
		return 0, false
	}
	return object.Number(key)
}

// rootNumberOr is `object?.key ?? fallback`: only a missing or null leaf falls
// back, every other leaf keeps the Number() coercion of toFiniteNumber.
func rootNumberOr(object *crawlfrontierllm.Object, key string, fallback float64) float64 {
	if object == nil {
		return fallback
	}
	raw, ok := object.Raw(key)
	if !ok || rootIsNullRaw(raw) {
		return fallback
	}
	if value, ok := object.Number(key); ok {
		return value
	}
	return fallback
}

// rootStringOr is `object?.key ?? fallback`. An empty string is a value, not a
// fallback, because NestJS only tests for nullishness here.
func rootStringOr(object *crawlfrontierllm.Object, key, fallback string) string {
	if object == nil {
		return fallback
	}
	raw, ok := object.Raw(key)
	if !ok || rootIsNullRaw(raw) {
		return fallback
	}
	if value, ok := object.UntrimmedString(key); ok {
		return value
	}
	return fallback
}

// rootIsNullRaw reports a JSON null leaf.
func rootIsNullRaw(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// rootRawValue returns the raw leaf as the clampInt argument, or nil when the
// key is absent (clampInt then uses its fallback exactly like
// `clampInt(undefined, ...)`).
func rootRawValue(object *crawlfrontierllm.Object, key string) any {
	if object == nil {
		return nil
	}
	raw, ok := object.Raw(key)
	if !ok {
		return nil
	}
	return raw
}

// rootDeferredMode is
// `typeof metadata?.llmJudgeDeferredMode === "string" ? [value] : undefined`.
// The empty string is kept here and dropped by uniqueStringList, which is what
// the NestJS combination of the typeof test and uniqueStringList does.
func rootDeferredMode(object *crawlfrontierllm.Object) []string {
	if value, ok := rootStringLeaf(object, "llmJudgeDeferredMode"); ok {
		return []string{value}
	}
	return nil
}

// rootNullableStringValue is `value ?? null` for the trace snapshot: a nil
// pointer and the empty string both serialize as null, which matches the shared
// buildCandidateSnapshot (an empty pageType/status is the absent value).
func rootNullableStringValue(value *string) any {
	if value == nil || *value == "" {
		return nil
	}
	return *value
}

// rootNullableFloatValue is
// `typeof value === "number" && Number.isFinite(value) ? value : null`.
func rootNullableFloatValue(value *float64) any {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	return *value
}

// rootMaxFloat is Math.max for the two operands resolveSeedDiscoveryConfig uses.
func rootMaxFloat(a, b float64) float64 {
	if b > a {
		return b
	}
	return a
}

// rootMinInt is Math.min for the two int operands resolveSeedDiscoveryConfig
// uses (`Math.min(120, maxPages)` and friends).
func rootMinInt(a, b int) int {
	if b < a {
		return b
	}
	return a
}

// rootRoundInt is Math.round at the struct boundary, where a resolved budget has
// to become an int.
func rootRoundInt(value float64) int {
	return int(crawlfrontierllm.RoundToFixed(value, 0))
}

// rootBoolPointer returns a pointer to value for the optional bool argument sets.
func rootBoolPointer(value bool) *bool {
	return &value
}
