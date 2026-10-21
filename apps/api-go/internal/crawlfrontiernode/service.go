package crawlfrontiernode

// service.go is processQueuedNode (crawl-frontier.service.ts 905-1108): the
// node state machine the two crawl queues call for `jobKind=frontier_node`.
//
// The order of the writes is part of the contract, because a worker that dies
// mid-node must leave the same trail the NestJS worker leaves:
//
//	load node+run  -> not found / cross tenant -> 404
//	run canceled   -> node canceled            -> {inserted:0,skipped:0}
//	resolve profile-> running run              -> startedAt only when empty
//	workflow       -> markRunStatus(running) + frontier_node_started event
//	node           -> running + attempts+1
//	executeNode    -> refreshRunStatus
//
// and on failure: classify the message, either demote a hot retry to the normal
// queue, or mark the node failed, record the run lastError and the
// frontier_node_failed event, refresh the run and rethrow the original error.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// ProcessQueuedNode runs one queued Frontier node and returns the
// CrawlExecutionSummary JSON the worker resolves the BullMQ job with.
//
// requestTimeoutMs <= 0 is the NestJS `undefined`/`null`: the crawl4ai client
// falls back to the settings timeout. The signature matches the
// FrontierNodeProcessor interface the crawl worker defines, so it can be wired
// as a method value.
func (s *Service) ProcessQueuedNode(ctx context.Context, nodeID, orgID string, requestTimeoutMs int) (json.RawMessage, error) {
	node, run, err := s.loadNodeWithRun(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	// A missing node and a node of another organization answer identically, so
	// the worker cannot probe foreign ids.
	if node == nil || run == nil || node.OrgID != orgID {
		return nil, newNodeNotFoundError()
	}

	if run.Status == "canceled" {
		if err := s.markNodeCanceled(ctx, node.ID); err != nil {
			return nil, err
		}
		return marshalSummary(emptySummary())
	}

	profile, err := s.frontier.ResolveEffectiveProfileForURL(ctx, orgID, run.ProfileID, run.SeedURL)
	if err != nil {
		return nil, err
	}
	if profile == nil {
		return nil, newBadRequestError(messageProfileUnresolved)
	}
	crawlTaskID := derefString(run.CrawlTaskID)
	if crawlTaskID == "" {
		return nil, newBadRequestError(messageMissingCrawlTaskID)
	}
	task, err := s.exec.LoadFrontierCrawlTask(ctx, crawlTaskID)
	if err != nil {
		return nil, err
	}
	if task == nil || task.OrgID != orgID {
		return nil, newBadRequestError(messageSyntheticTaskMissing)
	}

	startedAt := run.StartedAt
	if startedAt == nil {
		value := s.now().UTC()
		startedAt = &value
	}
	if err := s.markRunRunning(ctx, run.ID, *startedAt); err != nil {
		return nil, err
	}
	workflowRunID := derefString(run.WorkflowRunID)
	if workflowRunID != "" {
		if err := s.frontier.MarkRunStatus(ctx, workflowRunID, "running", nil, nil); err != nil {
			return nil, err
		}
		if err := s.frontier.AppendEvent(ctx, workflowRunID, s.frontierNodeStartedEvent(node)); err != nil {
			return nil, err
		}
	}
	if err := s.markNodeRunning(ctx, node.ID); err != nil {
		return nil, err
	}

	// The node record passed to executeNode is the one read before the running
	// update, exactly like `this.mapNode(node)` on the findUnique result.
	summary, execErr := s.executeNode(ctx, executeNodeOptions{
		Node:             node,
		Run:              run,
		Profile:          profile,
		Task:             task,
		RequestTimeoutMs: requestTimeoutMs,
	})
	if execErr == nil {
		// refreshRunStatus sits inside the NestJS try block, so a refresh
		// failure runs the same catch path as an execution failure.
		if refreshErr := s.frontier.RefreshRunStatus(ctx, run.ID); refreshErr != nil {
			execErr = refreshErr
		} else {
			return marshalSummary(summary)
		}
	}

	// NestJS: `error instanceof Error ? error.message : "crawl frontier node
	// failed"`. A Go error is always non-nil here, so the message is its text.
	message := execErr.Error()
	if message == "" {
		message = "crawl frontier node failed"
	}
	failureKind := classifyFailureKind(message)

	if s.shouldDemoteHotRetryToNormal(node, failureKind) {
		queuedAt := s.now().UTC()
		metadata := crawlfrontierllm.MergeObjects(node.Metadata, crawlfrontierllm.NewObjectFromPairs(
			"retryDemotedToNormal", true,
			"retryDemotedFromQueue", node.QueueClass,
			"retryDemotedAt", crawlfrontierllm.NestISOString(queuedAt),
			"retryDemotedFailureKind", nullableStringValue(failureKind),
			"retryDemotedLastError", message,
			"warningFlags", warningFlagsWith(
				crawlfrontierllm.CollectNodeWarningFlags(node.Metadata, node.LastError),
				failureKind,
				[]string{"retry_demoted_to_normal"},
			),
		))
		if err := s.demoteNodeToNormal(ctx, node.ID, node.QueueClass, queuedAt, metadata); err != nil {
			return nil, err
		}
		if err := s.frontier.EnqueueFrontierNodeJob(ctx, orgID, crawlTaskID, run.ID, node.ID, "normal"); err != nil {
			return nil, err
		}
		if workflowRunID != "" {
			if err := s.frontier.AppendEvent(ctx, workflowRunID, s.retryDemotedEvent(node, failureKind, queuedAt)); err != nil {
				return nil, err
			}
			if err := s.frontier.MarkRunStatusResetFinishedAt(ctx, workflowRunID, "queued"); err != nil {
				return nil, err
			}
		}
		if err := s.frontier.RefreshRunStatus(ctx, run.ID); err != nil {
			return nil, err
		}
		return marshalSummary(emptySummary())
	}

	failedMetadata := crawlfrontierllm.MergeObjects(node.Metadata, crawlfrontierllm.NewObjectFromPairs(
		"failureKind", nullableStringValue(failureKind),
		"warningFlags", warningFlagsWith(
			crawlfrontierllm.CollectNodeWarningFlags(node.Metadata, node.LastError),
			failureKind,
			nil,
		),
	))
	if err := s.markNodeFailed(ctx, node.ID, message, failedMetadata); err != nil {
		return nil, err
	}
	if err := s.markRunLastError(ctx, run.ID, message); err != nil {
		return nil, err
	}
	if workflowRunID != "" {
		if err := s.frontier.AppendEvent(ctx, workflowRunID, s.nodeFailedEvent(node, message, failureKind)); err != nil {
			return nil, err
		}
	}
	if err := s.frontier.RefreshRunStatus(ctx, run.ID); err != nil {
		return nil, err
	}
	// The original error is rethrown unchanged: a *crawl4ai.Error keeps its
	// Status so the worker can classify retryability with errors.As.
	return nil, execErr
}

// shouldDemoteHotRetryToNormal is shouldDemoteHotRetryToNormal (1444): only a
// hot node whose first network_tunnel_error is demoted once.
func (s *Service) shouldDemoteHotRetryToNormal(node *crawlfrontierllm.NodeRecord, failureKind *string) bool {
	if node.QueueClass != "hot" {
		return false
	}
	if failureKind == nil || *failureKind != "network_tunnel_error" {
		return false
	}
	if node.Metadata != nil {
		if demoted, ok := node.Metadata.Bool("retryDemotedToNormal"); ok && demoted {
			return false
		}
	}
	return true
}

// warningFlagsWith is
// uniqueStringList(collectNodeWarningFlags(...), failureKind ? [failureKind] : undefined, extra) ?? []
func warningFlagsWith(existing []string, failureKind *string, extra []string) []string {
	var kind []string
	if failureKind != nil {
		kind = []string{*failureKind}
	}
	merged := crawlfrontierllm.UniqueStringList(existing, kind, extra)
	if merged == nil {
		return []string{}
	}
	return merged
}

// frontierNodeStartedEvent is the frontier_node_started event (959-972).
func (s *Service) frontierNodeStartedEvent(node *crawlfrontierllm.NodeRecord) crawlfrontierllm.WorkflowEvent {
	details := crawlfrontierllm.NewObjectFromPairs(
		"url", node.URL,
		"pageType", node.PageType,
		"depth", node.Depth,
		"queueClass", node.QueueClass,
	)
	return crawlfrontierllm.WorkflowEvent{
		Level:     "info",
		EventType: "frontier_node_started",
		NodeID:    stringPointer(node.ID),
		NodeType:  stringPointer("legacy.frontier_node"),
		Message:   "Frontier node execution started",
		Details:   details,
		Timestamp: s.frontier.NowISO(),
	}
}

// retryDemotedEvent is the retry_demoted_to_normal event (1039-1055).
func (s *Service) retryDemotedEvent(node *crawlfrontierllm.NodeRecord, failureKind *string, queuedAt time.Time) crawlfrontierllm.WorkflowEvent {
	return crawlfrontierllm.WorkflowEvent{
		Level:         "warn",
		EventType:     "retry_demoted_to_normal",
		NodeID:        stringPointer(node.ID),
		NodeType:      stringPointer("budget-control"),
		Message:       "Frontier node retry was demoted from hot to normal queue",
		TriggerReason: failureKind,
		BeforeCount:   intPointer(1),
		AfterCount:    intPointer(1),
		RescuedCount:  intPointer(1),
		Details: crawlfrontierllm.NewObjectFromPairs(
			"url", node.URL,
			"previousQueueClass", node.QueueClass,
			"nextQueueClass", "normal",
		),
		Timestamp: crawlfrontierllm.NestISOString(queuedAt),
	}
}

// nodeFailedEvent is the frontier_node_failed event (1090-1103).
func (s *Service) nodeFailedEvent(node *crawlfrontierllm.NodeRecord, message string, failureKind *string) crawlfrontierllm.WorkflowEvent {
	return crawlfrontierllm.WorkflowEvent{
		Level:         "error",
		EventType:     "frontier_node_failed",
		NodeID:        stringPointer(node.ID),
		NodeType:      stringPointer("legacy.frontier_node"),
		Message:       message,
		TriggerReason: failureKind,
		Details: crawlfrontierllm.NewObjectFromPairs(
			"url", node.URL,
			"pageType", node.PageType,
			"depth", node.Depth,
		),
		Timestamp: s.frontier.NowISO(),
	}
}
