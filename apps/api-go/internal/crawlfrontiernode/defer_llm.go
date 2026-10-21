package crawlfrontiernode

// defer_llm.go ports the two crawl-frontier.service.ts methods that hand a
// candidate set to the BullMQ LLM judge queue instead of materializing it:
//
//	deferLlmJudgeForDiscovery   3157-3249
//	deferLlmJudgeForSeed        3251-3373
//
// Both follow the same shape: capture queuedAt, build the
// CrawlFrontierLlmJudgeJobPayload, enqueue it, and then — only when a workflow
// run is known — record the queued candidate traces, the workflow step and the
// llm_judge_deferred event. The return value is the metadata the caller merges
// into the node (the discovery branch returns the payload diagnostics, the seed
// branch returns a SeedDiscoveryOutcome with an empty page-type count record).
//
// The judge payload is built as an ordered crawlfrontierllm.Object so the raw
// JSON has the NestJS member order and the same optional-key behaviour:
// JSON.stringify drops a key whose value is undefined, so those keys are not
// inserted at all, while `?? null` keys are written as explicit nulls.

import (
	"context"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// deferLlmJudgeForDiscovery ports deferLlmJudgeForDiscovery (3157-3249).
//
// The payload key order is mode, runId, nodeId, taskId, maxDepth, maxPages,
// candidates, diagnostics, maxDepthOverride, maxNewNodes, metadataPatch;
// maxDepthOverride, maxNewNodes and metadataPatch are the optional keys NestJS
// only serializes when the crawl-frontier.service.ts caller supplied them.
//
// The returned object is the extraction diagnostics spread with the deferred
// judge markers, exactly like the NestJS object literal at 3235-3248.
func (s *Service) deferLlmJudgeForDiscovery(ctx context.Context, input deferJudgeDiscoveryInput) (*crawlfrontierllm.Object, error) {
	queuedAt := s.frontier.NowISO()
	// `options.workflowRunId ?? await this.resolveWorkflowRunId(options.runId)`:
	// an empty Go string is the Prisma null, so it is the value that resolves.
	workflowRunID := input.WorkflowRunID
	if workflowRunID == "" {
		resolved, err := s.resolveWorkflowRunID(ctx, input.RunID)
		if err != nil {
			return nil, err
		}
		workflowRunID = resolved
	}

	mode := string(crawlfrontierllm.JudgeModeDiscovery)
	payload := crawlfrontierllm.NewObjectFromPairs(
		"mode", mode,
		"runId", input.RunID,
		"nodeId", input.Node.ID,
		"taskId", input.TaskID,
		"maxDepth", input.MaxDepth,
		"maxPages", input.MaxPages,
		"candidates", rootCandidatePayload(input.Candidates),
		"diagnostics", rootOrEmptyObject(input.ExtractionDiagnostics),
	)
	if input.MaxDepthOverride != nil {
		payload.SetNumber("maxDepthOverride", float64(*input.MaxDepthOverride))
	}
	if input.MaxNewNodes != nil {
		payload.SetNumber("maxNewNodes", float64(*input.MaxNewNodes))
	}
	if input.MetadataPatch != nil {
		payload.Set("metadataPatch", input.MetadataPatch)
	}
	encoded, err := payload.MarshalJSON()
	if err != nil {
		return nil, err
	}
	if err := s.frontier.EnqueueFrontierLlmJudgeJob(ctx, input.Node.OrgID, input.TaskID, input.RunID, input.Node.ID, mode, encoded); err != nil {
		return nil, err
	}

	if workflowRunID != "" {
		if err := s.recordQueuedLlmCandidateDecisions(ctx, workflowRunID, input.Node, mode, input.Candidates, queuedAt); err != nil {
			return nil, err
		}
		discoveryStepMetrics := crawlfrontierllm.NewObjectFromPairs("mode", mode)
		if input.ExtractionDiagnostics != nil {
			discoveryStepMetrics.Set("extractionDiagnostics", input.ExtractionDiagnostics)
		}
		if err := s.frontier.UpsertStep(ctx, workflowRunID, crawlfrontierllm.WorkflowStep{
			StepKey:       "frontier:" + input.Node.ID + ":llm-judge:" + mode,
			NodeID:        "legacy::llm-judge:" + input.Node.ID + ":" + mode,
			NodeType:      "branch",
			Label:         "Deferred discovery LLM judge",
			Status:        "queued",
			DurationMs:    0,
			InputCount:    len(input.Candidates),
			OutputCount:   0,
			RejectedCount: 0,
			SampleURLs:    rootFirstCandidateURLs(input.Candidates, 5),
			Metrics:       discoveryStepMetrics,
		}); err != nil {
			return nil, err
		}
		if err := s.frontier.AppendEvent(ctx, workflowRunID, crawlfrontierllm.WorkflowEvent{
			Level:         "info",
			EventType:     "llm_judge_deferred",
			NodeID:        stringPointer(input.Node.ID),
			NodeType:      stringPointer("branch"),
			Message:       "Discovery candidates deferred to the LLM judge queue",
			TriggerReason: stringPointer("llm_judge_enabled"),
			BeforeCount:   intPointer(len(input.Candidates)),
			AfterCount:    intPointer(len(input.Candidates)),
			RescuedCount:  intPointer(0),
			Details: crawlfrontierllm.NewObjectFromPairs(
				"mode", mode,
				"queuedAt", queuedAt,
				"candidateCount", len(input.Candidates),
			),
			Timestamp: queuedAt,
		}); err != nil {
			return nil, err
		}
	}

	warningFlags := crawlfrontierllm.UniqueStringList(
		crawlfrontierllm.ObjectStrings(input.ExtractionDiagnostics, "warningFlags"),
		[]string{"llm_judge_deferred"},
	)
	if warningFlags == nil {
		warningFlags = []string{"llm_judge_deferred"}
	}
	// Spread order: the extraction diagnostics first, the deferred-judge markers
	// after it, so an existing key keeps its position and takes the new value.
	return crawlfrontierllm.MergeObjectsAll(input.ExtractionDiagnostics, crawlfrontierllm.NewObjectFromPairs(
		"llmJudgeEnabled", true,
		"llmJudgeAttempted", false,
		"llmJudgeDeferred", true,
		"llmJudgeDeferredMode", mode,
		"llmJudgeQueuedAt", queuedAt,
		"llmJudgeQueuedCandidateCount", len(input.Candidates),
		"llmJudgeDeferredCount", 1,
		"warningFlags", warningFlags,
	)), nil
}

// deferLlmJudgeForSeed ports deferLlmJudgeForSeed (3251-3373).
//
// The payload is mode, runId, nodeId, taskId, maxDepth, maxPages, candidates,
// seedContext, where seedContext is
// {seedMethod, seedDiscoveryMode, diagnostics, discoveredCount, qualityThresholds}:
// the first two are explicit nulls when the sitemap diagnostics does not carry a
// string, and qualityThresholds is the fully resolved seed discovery gate.
//
// Unlike the discovery branch this method always resolves the workflow run id
// (`await this.resolveWorkflowRunId(options.run.id)` at 3267).
func (s *Service) deferLlmJudgeForSeed(ctx context.Context, input deferJudgeSeedInput) (*seedDiscoveryOutcome, error) {
	queuedAt := s.frontier.NowISO()
	workflowRunID, err := s.resolveWorkflowRunID(ctx, input.Run.ID)
	if err != nil {
		return nil, err
	}

	mode := string(crawlfrontierllm.JudgeModeSeed)
	sitemapDiagnostics := rootOrEmptyObject(input.SitemapDiagnostics)
	seedContext := crawlfrontierllm.NewObject()
	if seedMethod, ok := rootStringLeaf(input.SitemapDiagnostics, "seedMethod"); ok {
		seedContext.SetString("seedMethod", seedMethod)
	} else {
		seedContext.SetNull("seedMethod")
	}
	if seedDiscoveryMode, ok := rootStringLeaf(input.SitemapDiagnostics, "discoveryMode"); ok {
		seedContext.SetString("seedDiscoveryMode", seedDiscoveryMode)
	} else {
		seedContext.SetNull("seedDiscoveryMode")
	}
	seedContext.Set("diagnostics", sitemapDiagnostics)
	seedContext.SetNumber("discoveredCount", float64(input.DiscoveredCount))
	seedContext.Set("qualityThresholds", rootQualityThresholdsObject(input.SeedConfig.QualityThresholds))

	payload := crawlfrontierllm.NewObjectFromPairs(
		"mode", mode,
		"runId", input.Run.ID,
		"nodeId", input.Node.ID,
		"taskId", input.TaskID,
		"maxDepth", input.Run.MaxDepth,
		"maxPages", input.Run.MaxPages,
		"candidates", rootCandidatePayload(input.Candidates),
		"seedContext", seedContext,
	)
	encoded, err := payload.MarshalJSON()
	if err != nil {
		return nil, err
	}
	if err := s.frontier.EnqueueFrontierLlmJudgeJob(ctx, input.Node.OrgID, input.TaskID, input.Run.ID, input.Node.ID, mode, encoded); err != nil {
		return nil, err
	}

	if workflowRunID != "" {
		if err := s.recordQueuedLlmCandidateDecisions(ctx, workflowRunID, input.Node, mode, input.Candidates, queuedAt); err != nil {
			return nil, err
		}
		if err := s.frontier.UpsertStep(ctx, workflowRunID, crawlfrontierllm.WorkflowStep{
			StepKey:       "frontier:" + input.Node.ID + ":llm-judge:" + mode,
			NodeID:        "legacy::llm-judge:" + input.Node.ID + ":" + mode,
			NodeType:      "branch",
			Label:         "Deferred seed LLM judge",
			Status:        "queued",
			DurationMs:    0,
			InputCount:    len(input.Candidates),
			OutputCount:   0,
			RejectedCount: 0,
			SampleURLs:    rootFirstCandidateURLs(input.Candidates, 5),
			Metrics: crawlfrontierllm.NewObjectFromPairs(
				"mode", mode,
				"discoveredCount", input.DiscoveredCount,
				"seedDiagnostics", sitemapDiagnostics,
			),
		}); err != nil {
			return nil, err
		}
		if err := s.frontier.AppendEvent(ctx, workflowRunID, crawlfrontierllm.WorkflowEvent{
			Level:         "info",
			EventType:     "llm_judge_deferred",
			NodeID:        stringPointer(input.Node.ID),
			NodeType:      stringPointer("branch"),
			Message:       "Seed candidates deferred to the LLM judge queue",
			TriggerReason: stringPointer("llm_judge_enabled"),
			BeforeCount:   intPointer(len(input.Candidates)),
			AfterCount:    intPointer(len(input.Candidates)),
			RescuedCount:  intPointer(0),
			Details: crawlfrontierllm.NewObjectFromPairs(
				"mode", mode,
				"queuedAt", queuedAt,
				"candidateCount", len(input.Candidates),
				"discoveredCount", input.DiscoveredCount,
			),
			Timestamp: queuedAt,
		}); err != nil {
			return nil, err
		}
	}

	// Returned outcome: nothing is created, every page-type counter is zero and
	// the diagnostics describe the pending judge (3341-3372).
	diagnostics := crawlfrontierllm.NewObject()
	diagnostics.SetString("seedOrigin", "sitemap")
	if seedMethod, ok := rootStringLeaf(input.SitemapDiagnostics, "seedMethod"); ok {
		diagnostics.SetString("seedMethod", seedMethod)
	} else {
		diagnostics.SetNull("seedMethod")
	}
	if seedDiscoveryMode, ok := rootStringLeaf(input.SitemapDiagnostics, "discoveryMode"); ok {
		diagnostics.SetString("seedDiscoveryMode", seedDiscoveryMode)
	} else {
		diagnostics.SetNull("seedDiscoveryMode")
	}
	diagnostics.Set("seedDiagnostics", sitemapDiagnostics)
	diagnostics.Set("seedYield", crawlfrontierllm.NewObjectFromPairs(
		"discovered", input.DiscoveredCount,
		"selected", len(input.Candidates),
		"created", 0,
		"fresh", deferFreshCandidateCount(input.Candidates),
	))
	diagnostics.SetString("fallbackStage", "llm_judge_pending")
	diagnostics.SetBool("llmJudgeEnabled", true)
	diagnostics.SetBool("llmJudgeAttempted", false)
	diagnostics.SetBool("llmJudgeDeferred", true)
	diagnostics.SetString("llmJudgeDeferredMode", mode)
	diagnostics.SetString("llmJudgeQueuedAt", queuedAt)
	diagnostics.SetNumber("llmJudgeQueuedCandidateCount", float64(len(input.Candidates)))
	diagnostics.SetNumber("llmJudgeDeferredCount", 1)
	diagnostics.Set("warningFlags", []string{"llm_judge_deferred"})

	return &seedDiscoveryOutcome{
		Created:                0,
		SelectedPageTypeCounts: createPageTypeCountRecord(),
		Diagnostics:            diagnostics,
	}, nil
}

// NOTE (deliberate omission): deferLlmJudgeForDiscovery/ForSeed do NOT write
// pendingLlmJudgeJobs. NestJS never increments the counter on the deferred path
// either: the only writer is buildRootBranchSummary's absolute metadataPatch
// (rootExecutor 234-236), which the completed-node merge applies right after
// this branch returns, and processQueuedLlmJudge decrements it
// (crawl-frontier.service.ts 1236-1244). An extra increment here would leave a
// phantom pending judge whenever the node execution fails after deferring, and
// refreshRunStatus would then keep the run active forever.

// rootCandidatePayload is the `candidates: CrawlFrontierCandidatePayload[]` leaf.
// crawlfrontierllm.Candidate carries exactly the five payload fields in the
// NestJS order (url, pageType, score, freshnessScore, metadata), and an empty
// candidate list must serialize as `[]`, not `null`.
func rootCandidatePayload(candidates []crawlfrontierllm.Candidate) []crawlfrontierllm.Candidate {
	if candidates == nil {
		return []crawlfrontierllm.Candidate{}
	}
	return candidates
}

// rootFirstCandidateURLs is `candidates.slice(0, limit).map(c => c.url)`.
func rootFirstCandidateURLs(candidates []crawlfrontierllm.Candidate, limit int) []string {
	out := make([]string, 0, limit)
	for index, candidate := range candidates {
		if index >= limit {
			break
		}
		out = append(out, candidate.URL)
	}
	return out
}

// rootQualityThresholdsObject is the resolved CrawlSeedQualityThresholds leaf in
// interface order (crawl.types.ts 117-122).
func rootQualityThresholdsObject(thresholds crawlfrontierllm.SeedQualityThresholds) *crawlfrontierllm.Object {
	return crawlfrontierllm.NewObjectFromPairs(
		"minCandidates", thresholds.MinCandidates,
		"minArticleRatio", thresholds.MinArticleRatio,
		"maxNoiseRatio", thresholds.MaxNoiseRatio,
		"minFreshRatio", thresholds.MinFreshRatio,
	)
}

// deferFreshCandidateCount is
// `candidates.filter(candidate => candidate.freshnessScore >= 0.75).length`.
func deferFreshCandidateCount(candidates []crawlfrontierllm.Candidate) int {
	count := 0
	for _, candidate := range candidates {
		if candidate.FreshnessScore >= 0.75 {
			count++
		}
	}
	return count
}
