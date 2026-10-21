package crawlfrontiernode

// record.go ports the write-side helpers processQueuedNode's execution branches
// call: persisting the crawl4ai response plus the self-result read-back, the
// crawl4ai system events, the workflow step/event of a completed node, the
// extraction candidate decisions, the run workflowRunId lookup and the run/node
// metadata merges.
//
// Three rules shape this file:
//
//   - every business object is a crawlfrontierllm.Object (ordered keys), never a
//     Go map, because the JSON columns are compared byte for byte with the
//     NestJS worker's output;
//   - the workflow recorder calls (appendEvent/upsertStep/recordCandidateTrace)
//     go through internal/crawlfrontierllm, which already ports
//     CrawlStrategyRunRecorderService;
//   - run/node metadata merges use the B1 row-locked entry points, see the
//     updateRunMetadataLocked/updateNodeMetadataLocked comments below.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// persistFrontierResponse ports persistFrontierResponse (crawl-frontier.service.ts
// 2478-2546): stamp the frontier provenance onto every crawl4ai result, persist
// through CrawlResultService.persistResults, then read the stored CrawlResult
// rows back to locate the result that belongs to this node.
//
// The NestJS call passes neither ingestToItems nor memory, so the returned
// summary has no memory block and no item counters; CrawlExecutionSummary keeps
// only inserted/skipped/reusedResultId/lastFetchedAt/runId.
func (s *Service) persistFrontierResponse(ctx context.Context, options persistFrontierOptions) (persistFrontierOutcome, error) {
	var outcome persistFrontierOutcome

	// `metadata: {...(result.metadata ?? {}), frontierRunId, frontierNodeId,
	// frontierPageType, frontierDepth, frontierExecutionMode}`: an existing
	// object keeps its key order and unknown keys, a same-name frontier key
	// keeps its position and takes the new value, and a missing/non-object
	// metadata behaves like `{...{}}`. Object.Set (SetRaw under the hood) has
	// exactly those semantics, so the clone is edited in place instead of being
	// merged into a fresh map.
	enrichedResults := make([]crawl4ai.PipelineArticle, 0, len(options.Response.Results))
	for _, result := range options.Response.Results {
		metadata := crawlfrontierllm.NewObject()
		if existing, ok := crawlfrontierllm.ParseObject(result.Metadata); ok {
			metadata = existing.Clone()
		}
		metadata.Set("frontierRunId", options.RunID)
		metadata.Set("frontierNodeId", options.Node.ID)
		metadata.Set("frontierPageType", options.Node.PageType)
		metadata.Set("frontierDepth", options.Node.Depth)
		metadata.Set("frontierExecutionMode", options.ExecutionMode)
		encoded, err := metadata.MarshalJSON()
		if err != nil {
			return outcome, fmt.Errorf("crawlfrontiernode: encode frontier result metadata: %w", err)
		}
		result.Metadata = encoded
		enrichedResults = append(enrichedResults, result)
	}

	// CrawlResultService.persistResults(task, enrichedResults, crawlOptions,
	// response.runId): crawlOptions is the normalized CrawlTaskOptions the
	// layered option builder produced, and response.runId is the crawl4ai run id
	// (`?? undefined` is the empty string).
	persisted, err := s.exec.PersistFrontierResults(
		ctx,
		options.Task,
		enrichedResults,
		options.CrawlOptions.Persist,
		options.Response.RunID,
		options.Task.OrgID,
	)
	if err != nil {
		return outcome, err
	}
	outcome.Summary = crawlExecutionSummaryOf(persisted)

	// Array.from(new Set(results.map(r => typeof r.url === "string" ? r.url.trim()
	// : "").filter(url => url.length > 0))): trimmed, empty-free, first-seen
	// order. PersistFrontierResults already trimmed the same way when it derived
	// the stored sourceUrl.
	urls := make([]string, 0, len(enrichedResults))
	for _, result := range enrichedResults {
		urls = append(urls, result.URL)
	}
	sourceURLs := crawlfrontierllm.UniqueStringList(urls)
	if len(sourceURLs) == 0 {
		// `sourceUrls.length ? findMany(...) : []`: no query runs and both the
		// result list and selfResult are empty.
		return outcome, nil
	}

	storedResults, err := s.loadFrontierStoredResults(ctx, options.Task.ID, sourceURLs)
	if err != nil {
		return outcome, err
	}
	outcome.Results = storedResults

	// selfResult = persistedResults.find(result => isCanonicalUrlMatch(
	//   result.sourceUrl, node.url, profile.config)) ?? null.
	//
	// persistedResults is the fetchedAt-desc ordered array, not the
	// resultBySourceUrl map: NestJS builds that map (2520-2525) but never reads
	// it, so there is nothing to port. Go cannot declare an unused local, hence
	// this note instead of a dead map.
	var profileConfig *crawlfrontierllm.Object
	if options.Profile != nil {
		profileConfig = options.Profile.Config
	}
	for index := range storedResults {
		if !s.isCanonicalURLMatch(storedResults[index].SourceURL, options.Node.URL, profileConfig) {
			continue
		}
		selfResult := storedResults[index]
		outcome.SelfResult = &selfResult
		break
	}

	// selfScore / selfFreshnessScore:
	//   selfResult?.metadata && isPlainObject(selfResult.metadata)
	//     ? Number(selfResult.metadata.frontierScore ?? 0)
	//     : undefined.
	// A missing or null key is the `?? 0` fallback; Object.Number applies the
	// same JS Number() coercion NestJS does. A non-numeric value is the only
	// divergence: NestJS would store NaN while Go keeps the 0 fallback, because a
	// NaN score is not a value the node chain can persist or compare.
	if outcome.SelfResult != nil && outcome.SelfResult.Metadata != nil {
		score := 0.0
		if value, ok := outcome.SelfResult.Metadata.Number("frontierScore"); ok {
			score = value
		}
		outcome.SelfScore = &score
		freshnessScore := 0.0
		if value, ok := outcome.SelfResult.Metadata.Number("frontierFreshnessScore"); ok {
			freshnessScore = value
		}
		outcome.SelfFreshnessScore = &freshnessScore
	}

	return outcome, nil
}

// loadFrontierStoredResults is the CrawlResult re-read of persistFrontierResponse
// (2504-2519):
//
//	crawlResult.findMany({
//	  where: {taskId: options.task.id, sourceUrl: {in: sourceUrls}},
//	  orderBy: {fetchedAt: "desc"},
//	})
//
// The full row set is returned in that order; selfResult selection happens on
// the ordered list in the caller. Prisma selects every column, but the node
// chain only reads id/sourceUrl/metadata/fetchedAt, which is the projection the
// frontierStoredResult type carries.
func (s *Service) loadFrontierStoredResults(ctx context.Context, taskID string, sourceURLs []string) ([]frontierStoredResult, error) {
	if s.db == nil {
		return nil, errors.New("crawlfrontiernode: mysql is not configured")
	}
	placeholders := make([]string, len(sourceURLs))
	args := make([]any, 0, len(sourceURLs)+1)
	args = append(args, taskID)
	for index, sourceURL := range sourceURLs {
		placeholders[index] = "?"
		args = append(args, sourceURL)
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, sourceUrl, metadata, fetchedAt FROM CrawlResult WHERE taskId = ? AND sourceUrl IN ("+
			strings.Join(placeholders, ", ")+") ORDER BY fetchedAt DESC",
		args...)
	if err != nil {
		return nil, fmt.Errorf("crawlfrontiernode: read persisted crawl results: %w", err)
	}
	defer func() { _ = rows.Close() }()

	storedResults := make([]frontierStoredResult, 0, len(sourceURLs))
	for rows.Next() {
		var (
			record   frontierStoredResult
			metadata []byte
		)
		if scanErr := rows.Scan(&record.ID, &record.SourceURL, &metadata, &record.FetchedAt); scanErr != nil {
			return nil, fmt.Errorf("crawlfrontiernode: scan persisted crawl result: %w", scanErr)
		}
		record.FetchedAt = record.FetchedAt.UTC()
		// metadata is a nullable Json column: parseObject maps NULL and any
		// non-object leaf to nil, like isPlainObject.
		record.Metadata = parseObject(metadata)
		storedResults = append(storedResults, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("crawlfrontiernode: read persisted crawl results: %w", err)
	}
	return storedResults, nil
}

// crawlExecutionSummaryOf drops the fields the Frontier call site does not
// request from the persistResults result. persistFrontierResponse passes no
// ingestToItems argument, so itemsQueued/itemsQueueFailed stay undefined, and
// there is no memory argument at all; CrawlExecutionSummary carries only the
// five keys the NestJS object literal serializes.
func crawlExecutionSummaryOf(summary crawlexecution.Summary) CrawlExecutionSummary {
	return CrawlExecutionSummary{
		Inserted:       summary.Inserted,
		Skipped:        summary.Skipped,
		ReusedResultID: summary.ReusedResultID,
		LastFetchedAt:  summary.LastFetchedAt,
		RunID:          summary.RunID,
	}
}

// recordCrawl4aiSystemEvents ports recordCrawl4aiSystemEvents
// (crawl-frontier.service.ts 5021-5048): one CrawlStrategyWorkflowRunEvent per
// crawl4ai system event, with the node provenance merged into event.details.
//
// `if (!workflowRunId || !events || events.length === 0) return;` is the empty
// workflowRunID / empty slice early return. triggerReason/beforeCount/
// afterCount/rescuedCount are `?? null`, so their nil pointers write SQL NULL;
// timestamp is the event's own string, written verbatim.
func (s *Service) recordCrawl4aiSystemEvents(ctx context.Context, workflowRunID string, node *crawlfrontierllm.NodeRecord, events []crawl4ai.SystemEvent) error {
	if workflowRunID == "" || len(events) == 0 {
		return nil
	}
	for _, event := range events {
		// details: {url: node.url, pageType: node.pageType, ...(event.details ?? {})}.
		// The spread keeps the node keys first and replaces a same-name event key
		// in place, which is exactly what mergeMetadataRecords does.
		details := crawlfrontierllm.NewObjectFromPairs(
			"url", node.URL,
			"pageType", node.PageType,
		)
		if eventDetails, ok := crawlfrontierllm.ParseObject(event.Details); ok {
			details = crawlfrontierllm.MergeObjects(details, eventDetails)
		}
		if err := s.frontier.AppendEvent(ctx, workflowRunID, crawlfrontierllm.WorkflowEvent{
			Level:         event.Level,
			EventType:     event.EventType,
			NodeID:        stringPointer(node.ID),
			NodeType:      stringPointer("legacy.crawl4ai"),
			Message:       event.Message,
			TriggerReason: event.TriggerReason,
			BeforeCount:   event.BeforeCount,
			AfterCount:    event.AfterCount,
			RescuedCount:  event.RescuedCount,
			Details:       details,
			Timestamp:     event.Timestamp,
		}); err != nil {
			return err
		}
	}
	return nil
}

// recordNodeCompletion ports CrawlFrontierService.recordNodeCompletion
// (crawl-frontier.service.ts 5112-5126), which delegates to
// rootExecutor.recordNodeCompletion (crawl-strategy-root-executor.service.ts
// 576-618).
//
// The step is upserted first and the frontier_node_completed event second.
// `outputCount: options.outputCount ?? options.outputUrls.length`,
// `sampleUrls: options.outputUrls.slice(0, 5)`, `inputCount: 1` and
// `status: "completed"` are all literal values from the NestJS call.
func (s *Service) recordNodeCompletion(ctx context.Context, input nodeCompletionInput) error {
	if input.WorkflowRunID == "" {
		return nil
	}
	outputCount := len(input.OutputURLs)
	if input.OutputCount != nil {
		outputCount = *input.OutputCount
	}
	sampleURLs := input.OutputURLs
	if len(sampleURLs) > 5 {
		sampleURLs = sampleURLs[:5]
	}
	if err := s.frontier.UpsertStep(ctx, input.WorkflowRunID, crawlfrontierllm.WorkflowStep{
		StepKey:       input.StepKey,
		NodeID:        input.WorkflowNodeID,
		NodeType:      input.WorkflowNodeType,
		Label:         input.Label,
		Status:        "completed",
		DurationMs:    input.DurationMs,
		InputCount:    1,
		OutputCount:   outputCount,
		RejectedCount: input.RejectedCount,
		SampleURLs:    sampleURLs,
		Metrics:       input.Metrics,
	}); err != nil {
		return err
	}

	return s.frontier.AppendEvent(ctx, input.WorkflowRunID, crawlfrontierllm.WorkflowEvent{
		Level:     "info",
		EventType: "frontier_node_completed",
		NodeID:    stringPointer(input.Node.ID),
		NodeType:  stringPointer("legacy.frontier_node"),
		Message:   "Frontier node execution completed",
		Details: crawlfrontierllm.NewObjectFromPairs(
			"url", input.Node.URL,
			"pageType", input.Node.PageType,
			"resultCount", len(input.OutputURLs),
		),
		Timestamp: s.frontier.NowISO(),
	})
}

// recordExtractionCandidateDecisions ports
// CrawlFrontierService.recordExtractionCandidateDecisions
// (crawl-frontier.service.ts 5104-5110), which delegates to
// layeredExecutor.recordExtractionCandidateDecisions
// (crawl-strategy-layered-executor.service.ts 2163-2191):
//
//	if (!workflowRunId || decisions.length === 0) return;
//	for (const decision of decisions) {
//	  await this.recordCandidateDecision({
//	    workflowRunId, sourceNodeId,
//	    candidate: decision.candidate,
//	    nodeId: sourceNodeId,
//	    nodeType: decision.nodeType,
//	    ...decision fields...
//	  });
//	}
//
// The extraction pass leaves the workflow provenance out of each decision, so
// this function stamps workflowRunId/sourceNodeId/nodeId from its arguments
// before handing the decision to the shared recorder; the recorder itself
// (crawlfrontierllm.RecordCandidateDecision) applies the NestJS
// `if (!workflowRunId) return` guard and the buildCandidateSnapshot default.
func (s *Service) recordExtractionCandidateDecisions(ctx context.Context, workflowRunID, sourceNodeID string, decisions []crawlfrontierllm.CandidateDecision) error {
	if workflowRunID == "" || len(decisions) == 0 {
		return nil
	}
	for _, decision := range decisions {
		item := decision
		item.WorkflowRunID = workflowRunID
		item.SourceNodeID = sourceNodeID
		// NestJS passes `nodeId: options.sourceNodeId`; the decision's own node
		// type/action/message/status payload is kept as extracted.
		item.NodeID = sourceNodeID
		if err := s.frontier.RecordCandidateDecision(ctx, item); err != nil {
			return err
		}
	}
	return nil
}

// resolveWorkflowRunID ports resolveWorkflowRunId (crawl-frontier.service.ts
// 5050-5058):
//
//	crawlFrontierRun.findUnique({where: {id}, select: {workflowRunId: true}})
//
// A missing column value (`run?.workflowRunId ?? null`) is the empty string, the
// Go spelling of "no workflow run bound to this frontier run". A missing run row
// also resolves to "" because NestJS's optional chain reads it as null.
func (s *Service) resolveWorkflowRunID(ctx context.Context, runID string) (string, error) {
	if s.db == nil {
		return "", errors.New("crawlfrontiernode: mysql is not configured")
	}
	var workflowRunID sql.NullString
	err := s.db.QueryRowContext(ctx,
		"SELECT workflowRunId FROM CrawlFrontierRun WHERE id = ?", runID).Scan(&workflowRunID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return workflowRunID.String, nil
}

// updateRunMetadataLocked is updateRunMetadata (crawl-frontier.service.ts
// 5088-5102) under the B1 row lock.
//
// NestJS updateRunMetadata keeps the unlocked read-modify-write: findUnique the
// metadata document, merge in memory, update the whole column. That is safe only
// while one writer touches a run at a time, which is not true for the node
// chain: every node completion refreshes the same CrawlFrontierRun (and the
// frontier_node_started/failed paths write it too), so two nodes of one run
// finishing together drop each other's patch. The Go port delegates to
// crawlfrontierllm.UpdateRunMetadataLocked, which performs the SELECT ... FOR
// UPDATE, the merge (same mergeMetadataRecords semantics) and the UPDATE inside
// one transaction. NestJS keeps its unlocked implementation; the locked variant
// only removes the lost-update interleaving.
func (s *Service) updateRunMetadataLocked(ctx context.Context, runID string, patch *crawlfrontierllm.Object) error {
	return s.frontier.UpdateRunMetadataLocked(ctx, runID, patch)
}

// updateNodeMetadataLocked is updateNodeMetadata (crawl-frontier.service.ts
// 5128-5151) for a plain patch, under the B1 row lock. The node chain writes
// node metadata from several asynchronous branches (discovery, seed branch,
// judge deferral), so the same lost-update argument as updateRunMetadataLocked
// applies; NestJS keeps the unlocked read-modify-write.
func (s *Service) updateNodeMetadataLocked(ctx context.Context, nodeID string, patch *crawlfrontierllm.Object) error {
	return s.frontier.UpdateNodeMetadataLocked(ctx, nodeID, patch)
}

// updateNodeMetadataFuncLocked is the functional form of
// updateNodeMetadataLocked: NestJS's
// `typeof patch === "function" ? patch(existing) : patch` becomes the build
// callback, which the locked helper runs against the freshly locked document, so
// derived values (for example a pendingLlmJudgeJobs counter) stay correct under
// concurrency.
func (s *Service) updateNodeMetadataFuncLocked(ctx context.Context, nodeID string, build func(existing *crawlfrontierllm.Object) *crawlfrontierllm.Object) error {
	return s.frontier.UpdateNodeMetadataFuncLocked(ctx, nodeID, build)
}
