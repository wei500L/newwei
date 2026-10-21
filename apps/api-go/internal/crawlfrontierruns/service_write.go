package crawlfrontierruns

// This file implements the three crawl-frontier admin write routes that
// NestJS crawl-frontier.controller.ts still owned before
// API_GO_CRAWL_FRONTIER_WRITES_MODE existed:
//
//	POST /api/admin/crawl-frontier/runs              createRun
//	POST /api/admin/crawl-frontier/nodes/retry       retryNodes
//	POST /api/admin/crawl-frontier/nodes/:id/retry   retryNode
//
// All three are permission-gated by crawl.write and answered by the same run
// detail payload the read routes return (getRun), which is why the switch
// requires API_GO_CRAWL_FRONTIER_RUNS_MODE=go: one side must own that payload
// for reads and writes alike during cutover.
//
// The run-creation chain itself lives in internal/crawlfrontierllm
// (createRunFromProfile, shared with the shadow-learning path). This file owns
// the HTTP-service layer NestJS keeps in crawl-frontier.service.ts createRun:
// WHATWG seed-URL normalisation, effective-profile resolution, the keyword
// merge, the layered budget clamp, the runRole/llmAssist metadata patch, and
// the pre-existing behaviours this batch fixes (see B2/B3/B4 notes inline).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// WriteService serves the three write routes. It reuses the read Service for
// the getRun detail so create/retry responses cannot drift from GET /runs/:id.
type WriteService struct {
	reads    *Service
	frontier *crawlfrontierllm.Service
}

// NewWriteService builds the write service around the shared MySQL handle and
// the crawl frontier chain service that owns profile resolution, run creation
// and node enqueueing.
func NewWriteService(db *sql.DB, frontier *crawlfrontierllm.Service) *WriteService {
	return &WriteService{reads: NewService(db), frontier: frontier}
}

// CreateFrontierRun ports createRun.
func (s *WriteService) CreateFrontierRun(ctx context.Context, orgID, actorID string, input createRunInput) (runDetail, error) {
	if s == nil || s.frontier == nil || s.reads == nil {
		return runDetail{}, errors.New("crawlfrontierruns: crawl frontier write service is not configured")
	}
	// normalizeUrl: new URL(value).toString(), 400 "seedUrl must be a valid
	// absolute URL" when the WHATWG parser would throw.
	seedURL, ok := normalizeSeedURL(input.SeedURL)
	if !ok {
		return runDetail{}, newStatus(http.StatusBadRequest, "seedUrl must be a valid absolute URL")
	}
	profile, err := s.frontier.CreateFrontierRunProfile(ctx, orgID, input.ProfileID, seedURL)
	if err != nil {
		return runDetail{}, err
	}
	if profile == nil {
		// crawl-site-profile.service.ts getProfile throws NotFound when the id
		// resolves outside the caller's organization, so an explicit profileId
		// that resolves to nothing is a 404 - not the 400 the URL-match branch
		// produces. loadProfile returns nil for both "absent" and "other org",
		// which is exactly the set that 404 covers.
		if input.ProfileID != nil {
			return runDetail{}, newStatus(http.StatusNotFound, "Crawl site profile not found")
		}
		return runDetail{}, newStatus(http.StatusBadRequest, "No active crawl site profile matches the provided seed URL")
	}

	layeredOptions, hasLayeredOptions := profile.Config.Object("layeredOptions")
	maxDepth := crawlfrontierllm.ClampInt(
		layeredOrInputNumber(input.MaxDepth, layeredOptions, hasLayeredOptions, "maxDepth"), 1, 8, 3)
	maxPages := crawlfrontierllm.ClampInt(
		layeredOrInputNumber(input.MaxPages, layeredOptions, hasLayeredOptions, "maxPages"), 1, 500, 60)

	executionMode := profile.ExecutionMode
	if input.ExecutionMode != nil {
		executionMode = *input.ExecutionMode
	}

	// Array.from(new Set([...input.keywords, ...profile.keywords])): the profile
	// half is read with the keep-empty reader because the merge above does not
	// trim or drop entries either.
	profileKeywords, _ := profile.Config.StringsKeepEmpty("keywords")
	keywords := mergeKeywordList(input.Keywords, profileKeywords)

	runID, err := s.frontier.CreateFrontierRunFromProfile(ctx, crawlfrontierllm.CreateRunOptions{
		OrgID:               orgID,
		ActorID:             actorID,
		SeedURL:             seedURL,
		SeedURLIsNormalized: true,
		Profile:             *profile,
		ExecutionMode:       executionMode,
		MaxDepth:            maxDepth,
		MaxPages:            maxPages,
		Keywords:            keywords,
		RunMetadata:         createRunMetadata(profile.Config),
	})
	if err != nil {
		return runDetail{}, err
	}
	return s.reads.GetRun(ctx, orgID, runID)
}

// layeredOrInputNumber is `input ?? layeredOptions?.key`. A present request value
// wins outright; otherwise the profile's raw JSON leaf is passed through so
// clampInt applies the same Number() coercion the NestJS service applies to
// arbitrary profile JSON.
func layeredOrInputNumber(input *float64, layered *crawlfrontierllm.Object, hasLayered bool, key string) any {
	if input != nil {
		return *input
	}
	if hasLayered && layered != nil {
		if raw, ok := layered.Raw(key); ok {
			return raw
		}
	}
	return nil
}

// createRunMetadata builds the runMetadata patch createRun passes to
// createRunFromProfile:
//
//	runRole:   profile.config.llmAssist?.shadow?.role === "shadow" ? "shadow" : "active"
//	llmAssist: resolveEffectiveLlmAssistConfig(profile.config, "judge")
//	             ? {enabled: true, recallMode: assist.recallMode ?? "high_recall",
//	                synthesized: profile.config.llmAssist?.enabled !== true}
//	             : null
func createRunMetadata(config *crawlfrontierllm.Object) *crawlfrontierllm.Object {
	runRole := "active"
	llmAssistEnabled := false
	if assist, ok := config.Object("llmAssist"); ok {
		if enabled, ok := assist.Bool("enabled"); ok {
			llmAssistEnabled = enabled
		}
		if shadow, ok := assist.Object("shadow"); ok {
			if role, ok := shadow.UntrimmedString("role"); ok && role == "shadow" {
				runRole = "shadow"
			}
		}
	}
	var llmAssist any
	if effective := crawlfrontierllm.ResolveEffectiveLlmAssistConfig(config, "judge"); effective != nil {
		// ResolveEffectiveLlmAssistConfig already applies recallMode ??
		// "high_recall", so the value is used as-is.
		llmAssist = crawlfrontierllm.NewObjectFromPairs(
			"enabled", true,
			"recallMode", effective.RecallMode,
			"synthesized", !llmAssistEnabled,
		)
	}
	return crawlfrontierllm.NewObjectFromPairs("runRole", runRole, "llmAssist", llmAssist)
}

// retryCandidate is one node selected for a requeue, with the run fields the
// protocol needs pre-joined so a bulk retry does not issue a per-node run
// query.
type retryCandidate struct {
	NodeID      string
	OrgID       string
	RunID       string
	CrawlTaskID sql.NullString
}

// errRunTerminal marks a requeue refused because the owning run is terminal.
// The single-node route answers 409; the bulk route reports the id as skipped,
// which is the same per-item signal NestJS uses for a node that cannot be
// requeued.
var errRunTerminal = errors.New("crawl frontier run is terminal")

// RetryNode ports retryNode: the node must exist inside the caller's
// organization (otherwise 404), its run must carry a crawlTaskId (otherwise
// 400), then the node is requeued and the run detail is returned.
//
// B4: a node of a completed or canceled run is refused with 409 instead of
// resurrecting the run. See requeueNode for the reasoning.
func (s *WriteService) RetryNode(ctx context.Context, orgID, nodeID string) (runDetail, error) {
	if s == nil || s.frontier == nil || s.reads == nil {
		return runDetail{}, errors.New("crawlfrontierruns: crawl frontier write service is not configured")
	}
	candidate, err := s.loadRetryCandidate(ctx, nodeID)
	if err != nil {
		return runDetail{}, err
	}
	if candidate == nil || candidate.OrgID != orgID {
		return runDetail{}, newStatus(http.StatusNotFound, "Crawl frontier node not found")
	}
	if !candidate.CrawlTaskID.Valid || candidate.CrawlTaskID.String == "" {
		return runDetail{}, newStatus(http.StatusBadRequest, "Crawl frontier run is missing crawlTaskId")
	}
	if err := s.requeueNode(ctx, orgID, *candidate); err != nil {
		if errors.Is(err, errRunTerminal) {
			return runDetail{}, newStatus(http.StatusConflict, "Crawl frontier run is completed or canceled and cannot be retried")
		}
		return runDetail{}, err
	}
	return s.reads.GetRun(ctx, orgID, candidate.RunID)
}

// bulkRetryResult is POST /nodes/retry: field order matters because the NestJS
// response is an object literal serialised in declaration order.
type bulkRetryResult struct {
	RetriedIDs   []string `json:"retriedIds"`
	RetriedCount int      `json:"retriedCount"`
	SkippedIDs   []string `json:"skippedIds"`
	SkippedCount int      `json:"skippedCount"`
	RunIDs       []string `json:"runIds"`
}

// isDocument marks bulkRetryResult as a JSON payload.
func (bulkRetryResult) isDocument() {}

// RetryNodes ports retryNodes. Ids are trimmed, emptied and deduplicated by the
// service layer even though the DTO already guaranteed a non-empty string
// array; nodes of another organization and unknown ids simply do not come back
// from the query, so they appear in neither list.
//
// Ordering note: NestJS uses findMany without an ORDER BY, so its retriedIds
// order is whatever InnoDB returns (usually primary-key order). This port pins
// it with ORDER BY id, and iterates in that order so the bulk requeue acquires
// row locks ascending exactly like the cancellation protocol does.
func (s *WriteService) RetryNodes(ctx context.Context, orgID string, ids []string) (bulkRetryResult, error) {
	if s == nil || s.frontier == nil || s.reads == nil {
		return bulkRetryResult{}, errors.New("crawlfrontierruns: crawl frontier write service is not configured")
	}
	uniqueIDs := normalizeRetryIDs(ids)
	if len(uniqueIDs) == 0 {
		return bulkRetryResult{}, &inputError{Message: "ids must contain at least one node id"}
	}
	candidates, err := s.loadRetryCandidates(ctx, orgID, uniqueIDs)
	if err != nil {
		return bulkRetryResult{}, err
	}
	result := bulkRetryResult{
		RetriedIDs: []string{},
		SkippedIDs: []string{},
		RunIDs:     []string{},
	}
	for _, candidate := range candidates {
		if !candidate.CrawlTaskID.Valid || candidate.CrawlTaskID.String == "" {
			result.SkippedIDs = append(result.SkippedIDs, candidate.NodeID)
			continue
		}
		if err := s.requeueNode(ctx, orgID, candidate); err != nil {
			// B4: a node whose run already reached a terminal status is reported
			// per item, matching how the bulk response already signals nodes that
			// cannot be requeued.
			if errors.Is(err, errRunTerminal) {
				result.SkippedIDs = append(result.SkippedIDs, candidate.NodeID)
				continue
			}
			// NestJS has already committed the earlier nodes of the batch when a
			// later one fails, so the error is returned as-is and no rollback of
			// the earlier requeues happens here either.
			return bulkRetryResult{}, err
		}
		result.RetriedIDs = append(result.RetriedIDs, candidate.NodeID)
		if !containsString(result.RunIDs, candidate.RunID) {
			result.RunIDs = append(result.RunIDs, candidate.RunID)
		}
	}
	result.RetriedCount = len(result.RetriedIDs)
	result.SkippedCount = len(result.SkippedIDs)
	return result, nil
}

// normalizeRetryIDs trims, drops empty entries and deduplicates while keeping
// first-occurrence order. It runs on the DTO's already-validated strings, whose
// MaxLength(191) applied to the untrimmed value.
func normalizeRetryIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" || containsString(out, trimmed) {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

// loadRetryCandidate reads one node joined with the run fields the protocol
// needs. The read is unlocked on purpose: runId and crawlTaskId are immutable
// after creation, and the mutable columns are re-read under the row lock in
// requeueNode.
func (s *WriteService) loadRetryCandidate(ctx context.Context, nodeID string) (*retryCandidate, error) {
	rows, err := s.reads.db.QueryContext(ctx, `
SELECT n.id, n.orgId, n.runId, r.crawlTaskId
FROM CrawlFrontierNode n
JOIN CrawlFrontierRun r ON r.id = n.runId
WHERE n.id = ?`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates, err := scanRetryCandidates(rows)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	return &candidates[0], nil
}

// loadRetryCandidates reads every node of the caller's organization among ids,
// joined with its run in one query (the bulk-retry query optimisation).
func (s *WriteService) loadRetryCandidates(ctx context.Context, orgID string, ids []string) ([]retryCandidate, error) {
	payload, err := json.Marshal(ids)
	if err != nil {
		return nil, err
	}
	rows, err := s.reads.db.QueryContext(ctx, `
SELECT n.id, n.orgId, n.runId, r.crawlTaskId
FROM CrawlFrontierNode n
JOIN CrawlFrontierRun r ON r.id = n.runId
WHERE n.orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(n.id))
ORDER BY n.id ASC`, orgID, string(payload))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRetryCandidates(rows)
}

// scanRetryCandidates scans retryCandidate rows read by the caller's cursor.
func scanRetryCandidates(rows *sql.Rows) ([]retryCandidate, error) {
	out := make([]retryCandidate, 0)
	for rows.Next() {
		var candidate retryCandidate
		if err := rows.Scan(&candidate.NodeID, &candidate.OrgID, &candidate.RunID, &candidate.CrawlTaskID); err != nil {
			return nil, err
		}
		out = append(out, candidate)
	}
	return out, rows.Err()
}

// requeueNode is requeueNodeRecord with the B2 and B4 fixes:
//
// B2 - the metadata merge now runs against the row-locked document instead of
// the snapshot read before the transaction, so a worker that updated the node
// metadata in between cannot have its keys silently overwritten. The node and
// run status updates commit together; the enqueue happens after the commit.
//
// B4 - a node whose run is already completed or canceled is refused with
// errRunTerminal instead of being requeued. NestJS writes `status:"queued"`,
// `finishedAt:null` unconditionally, which flips a terminal run back to queued
// while its other nodes stay canceled/completed; refreshRunStatus then treats it
// as live again and can end it completed or failed a second time. That
// contradicts the terminal-run invariant this package already documents and
// enforces in the cancellation protocol (cancel.go runStatusIsCancelable,
// `status NOT IN ('completed','canceled')`) and in crawlfrontierllm refresh, and
// the console only ever offers Retry on failed/skipped nodes, so no supported
// flow depends on resurrecting a run. The check is read under the same row lock
// as the update, so a cancel committing concurrently cannot slip past it.
//
// Lock order: the run row is locked before the node row, which is the order the
// cancellation protocol uses (it locks runs, then updates their nodes). Two
// bulk retries therefore acquire locks in the same ascending node-id order and
// a retry cannot deadlock against a bulk cancel.
//
// Enqueue before the workflow event: a failed event write returns an error to
// the caller while the node is already queued, which is exactly what NestJS
// does.
func (s *WriteService) requeueNode(ctx context.Context, orgID string, candidate retryCandidate) error {
	queuedAt := time.Now().UTC().Truncate(time.Millisecond)
	queuedAtISO := crawlfrontierllm.NestISOString(queuedAt)

	tx, err := s.reads.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Lock the run first (ascending order with the cancel protocol), then the
	// node whose metadata is merged below.
	var (
		runStatus     string
		workflowRunID sql.NullString
	)
	if err := tx.QueryRowContext(ctx,
		"SELECT status, workflowRunId FROM CrawlFrontierRun WHERE id = ? AND orgId = ? FOR UPDATE",
		candidate.RunID, orgID).Scan(&runStatus, &workflowRunID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return newStatus(http.StatusNotFound, "Crawl frontier run not found")
		}
		return err
	}
	if !runStatusIsCancelable(RunStatus(runStatus)) {
		return errRunTerminal
	}

	var (
		queueClass  string
		metadataRaw []byte
	)
	if err := tx.QueryRowContext(ctx, `
SELECT queueClass, metadata
FROM CrawlFrontierNode
WHERE id = ? AND orgId = ? AND runId = ?
FOR UPDATE`, candidate.NodeID, orgID, candidate.RunID).Scan(&queueClass, &metadataRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return newStatus(http.StatusNotFound, "Crawl frontier node not found")
		}
		return err
	}

	existing, _ := crawlfrontierllm.ParseObject(json.RawMessage(metadataRaw))
	patch := crawlfrontierllm.NewObject()
	patch.SetNull("failureKind")
	patch.Set("warningFlags", []string{})
	patch.SetString("retryQueuedAt", queuedAtISO)
	merged := crawlfrontierllm.MergeObjects(existing, patch)
	encodedMetadata, err := merged.MarshalJSON()
	if err != nil {
		return err
	}

	// The orgId predicate on both updates keeps a tenant-scoped requeue from
	// ever touching a row outside the caller's organization.
	if _, err := tx.ExecContext(ctx, `
UPDATE CrawlFrontierNode
SET status = 'queued', lastError = NULL, rejectionReason = NULL, queuedAt = ?,
    metadata = ?, updatedAt = ?
WHERE id = ? AND orgId = ?`,
		queuedAt, encodedMetadata, queuedAt, candidate.NodeID, orgID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE CrawlFrontierRun
SET status = 'queued', finishedAt = NULL, updatedAt = ?
WHERE id = ? AND orgId = ?`,
		queuedAt, candidate.RunID, orgID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	// Enqueue after the commit so a BullMQ failure cannot leave the rows marked
	// queued while the transaction is still open and retryable.
	if err := s.frontier.EnqueueFrontierNodeJob(
		ctx, orgID, candidate.CrawlTaskID.String, candidate.RunID, candidate.NodeID, queueClass); err != nil {
		return err
	}

	if !workflowRunID.Valid || workflowRunID.String == "" {
		return nil
	}
	if err := s.appendRequeueEvent(ctx, candidate.NodeID, workflowRunID.String, queueClass, queuedAt); err != nil {
		return err
	}
	return s.frontier.MarkRunStatusResetFinishedAt(ctx, workflowRunID.String, string(RunStatusQueued))
}

// requeueEventDetails is the details payload of the frontier_node_requeued
// workflow event.
type requeueEventDetails struct {
	QueueClass string `json:"queueClass"`
}

// appendRequeueEvent appends the frontier_node_requeued event (sequence =
// count + 1, mirroring recorder.appendEvent).
func (s *WriteService) appendRequeueEvent(ctx context.Context, nodeID, workflowRunID, queueClass string, queuedAt time.Time) error {
	var count int
	if err := s.reads.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", workflowRunID).Scan(&count); err != nil {
		return err
	}
	eventID, err := newRowID()
	if err != nil {
		return err
	}
	details, err := json.Marshal(requeueEventDetails{QueueClass: queueClass})
	if err != nil {
		return err
	}
	_, err = s.reads.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunEvent
  (id, runId, sequence, level, eventType, nodeId, nodeType, message, triggerReason,
   beforeCount, afterCount, rescuedCount, details, createdAt)
VALUES (?, ?, ?, 'info', 'frontier_node_requeued', ?, 'legacy.frontier_node',
        'Frontier node was requeued for another execution attempt', 'manual_retry',
        1, 1, 1, ?, ?)`,
		eventID, workflowRunID, count+1, nodeID, []byte(details), queuedAt)
	return err
}
