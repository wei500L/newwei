package crawlfrontiernode

// store.go holds the CrawlFrontierNode / CrawlFrontierRun reads and writes the
// node state machine performs.
//
// Prisma calls in crawl-frontier.service.ts are column-scoped updates, so every
// statement here names the same columns and leaves the rest alone. updatedAt is
// written explicitly because the Prisma @updatedAt attribute fills it in the
// NestJS process; MySQL has no equivalent.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// loadNodeWithRun is crawlFrontierNode.findUnique({where:{id},
// include:{run:true}}) as one statement, so the node and its run come from the
// same snapshot.
func (s *Service) loadNodeWithRun(ctx context.Context, nodeID string) (*crawlfrontierllm.NodeRecord, *runRecord, error) {
	if s.db == nil {
		return nil, nil, errors.New("crawlfrontiernode: mysql is not configured")
	}
	row := s.db.QueryRowContext(ctx, `
SELECT n.id, n.runId, n.parentNodeId, n.orgId, n.url, n.canonicalUrl, n.urlFingerprint, n.pageType,
       n.depth, n.queueClass, n.status, n.score, n.freshnessScore, n.queuedAt, n.rejectionReason,
       n.lastError, n.metadata, n.discoveredAt,
       r.id, r.orgId, r.profileId, r.workflowRunId, r.seedUrl, r.crawlTaskId, r.executionMode, r.status,
       r.maxDepth, r.maxPages, r.keywords, r.pageCount, r.nodeCount, r.articleCount, r.failedCount,
       r.duplicateCount, r.lastError, r.metadata, r.createdById, r.startedAt
FROM CrawlFrontierNode n
JOIN CrawlFrontierRun r ON r.id = n.runId
WHERE n.id = ?`, nodeID)

	var (
		node                                       crawlfrontierllm.NodeRecord
		parentNodeID, canonicalURL, urlFingerprint sql.NullString
		queuedAt, rejectionReason, nodeLastError   sql.NullString
		score, freshnessScore                      sql.NullFloat64
		nodeMetadata                               []byte
		discoveredAt                               time.Time

		run                                   crawlfrontierllm.RunRecord
		profileID, workflowRunID, crawlTaskID sql.NullString
		runKeywords, runMetadata              []byte
		runLastError                          sql.NullString
		startedAt                             sql.NullTime
	)
	err := row.Scan(
		&node.ID, &node.RunID, &parentNodeID, &node.OrgID, &node.URL, &canonicalURL, &urlFingerprint,
		&node.PageType, &node.Depth, &node.QueueClass, &node.Status, &score, &freshnessScore, &queuedAt,
		&rejectionReason, &nodeLastError, &nodeMetadata, &discoveredAt,
		&run.ID, &run.OrgID, &profileID, &workflowRunID, &run.SeedURL, &crawlTaskID, &run.ExecutionMode,
		&run.Status, &run.MaxDepth, &run.MaxPages, &runKeywords, &run.PageCount, &run.NodeCount,
		&run.ArticleCount, &run.FailedCount, &run.DuplicateCount, &runLastError, &runMetadata,
		&run.CreatedByID, &startedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("crawlfrontiernode: load frontier node: %w", err)
	}

	node.ParentNodeID = nullString(parentNodeID)
	node.CanonicalURL = nullString(canonicalURL)
	node.URLFingerprint = nullString(urlFingerprint)
	node.QueuedAt = nullString(queuedAt)
	node.RejectionReason = nullString(rejectionReason)
	node.LastError = nullString(nodeLastError)
	node.Score = nullFloat(score)
	node.FreshnessScore = nullFloat(freshnessScore)
	node.Metadata = parseObject(nodeMetadata)
	node.DiscoveredAt = crawlfrontierllm.NestISOString(discoveredAt)

	run.ProfileID = nullString(profileID)
	run.WorkflowRunID = nullString(workflowRunID)
	run.CrawlTaskID = nullString(crawlTaskID)
	run.LastError = nullString(runLastError)
	run.Keywords = coerceStringArray(parseStringList(runKeywords))
	run.Metadata = parseObject(runMetadata)

	out := &runRecord{RunRecord: run}
	if startedAt.Valid {
		value := startedAt.Time
		out.StartedAt = &value
	}
	return &node, out, nil
}

// loadRunStartedAt re-reads only the startedAt column.
func (s *Service) loadRunStartedAt(ctx context.Context, runID string) (*time.Time, error) {
	var startedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT startedAt FROM CrawlFrontierRun WHERE id = ?`, runID).Scan(&startedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !startedAt.Valid {
		return nil, nil
	}
	value := startedAt.Time
	return &value, nil
}

// markNodeCanceled is the `run.canceled` short-circuit: only status changes.
func (s *Service) markNodeCanceled(ctx context.Context, nodeID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE CrawlFrontierNode SET status = 'canceled', updatedAt = ? WHERE id = ?`,
		s.truncate(s.now()), nodeID)
	return err
}

// markRunRunning is `crawlFrontierRun.update({status:"running", startedAt})`.
func (s *Service) markRunRunning(ctx context.Context, runID string, startedAt time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE CrawlFrontierRun SET status = 'running', startedAt = ?, updatedAt = ? WHERE id = ?`,
		s.truncate(startedAt), s.truncate(s.now()), runID)
	return err
}

// markNodeRunning is the running update with `attempts: {increment: 1}`. The
// increment is done by the database so two workers cannot lose one attempt.
func (s *Service) markNodeRunning(ctx context.Context, nodeID string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE CrawlFrontierNode SET status = 'running', attempts = attempts + 1, updatedAt = ? WHERE id = ?",
		s.truncate(s.now()), nodeID)
	return err
}

// demoteNodeToNormal is the shouldDemoteHotRetryToNormal update: back to
// queued on the normal queue with the demotion bookkeeping in metadata.
func (s *Service) demoteNodeToNormal(ctx context.Context, nodeID, queueClass string, queuedAt time.Time, metadata *crawlfrontierllm.Object) error {
	encoded, err := encodeObject(metadata)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE CrawlFrontierNode
SET status = 'queued', queueClass = 'normal', queuedAt = ?, lastError = NULL, metadata = ?, updatedAt = ?
WHERE id = ?`,
		s.truncate(queuedAt), encoded, s.truncate(s.now()), nodeID)
	return err
}

// markNodeFailed is the failure update: status, lastError and the merged
// metadata (failureKind + warningFlags).
func (s *Service) markNodeFailed(ctx context.Context, nodeID, message string, metadata *crawlfrontierllm.Object) error {
	encoded, err := encodeObject(metadata)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE CrawlFrontierNode SET status = 'failed', lastError = ?, metadata = ?, updatedAt = ? WHERE id = ?`,
		message, encoded, s.truncate(s.now()), nodeID)
	return err
}

// markRunLastError is `crawlFrontierRun.update({data:{lastError}})`.
func (s *Service) markRunLastError(ctx context.Context, runID, message string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE CrawlFrontierRun SET lastError = ?, updatedAt = ? WHERE id = ?`,
		message, s.truncate(s.now()), runID)
	return err
}

// markNodeCompleted is executeLayeredNode's / executeNativeRootNode's terminal
// node update.
func (s *Service) markNodeCompleted(ctx context.Context, input completedNodeInput) error {
	encoded, err := encodeObject(input.Metadata)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE CrawlFrontierNode
SET status = 'completed', crawledAt = ?, canonicalUrl = ?, urlFingerprint = ?, crawlResultId = ?,
    score = ?, freshnessScore = ?, lastError = NULL, metadata = ?, updatedAt = ?
WHERE id = ?`,
		s.truncate(input.CrawledAt), nullableStringValue(input.CanonicalURL), nullableStringValue(input.URLFingerprint),
		nullableStringValue(input.CrawlResultID), nullableFloatValue(input.Score), nullableFloatValue(input.FreshnessScore),
		encoded, s.truncate(s.now()), input.NodeID)
	return err
}

// completedNodeInput is the terminal node patch. Optional fields follow the
// Prisma column nullability: a nil pointer writes SQL NULL.
type completedNodeInput struct {
	NodeID         string
	CrawledAt      time.Time
	CanonicalURL   *string
	URLFingerprint *string
	CrawlResultID  *string
	Score          *float64
	FreshnessScore *float64
	Metadata       *crawlfrontierllm.Object
}

// truncate converts a timestamp to the DATETIME(3) precision MySQL stores.
func (s *Service) truncate(value time.Time) time.Time {
	return crawlfrontierllm.TruncateMillis(value.UTC())
}

// encodeObject marshals a metadata document; nil writes SQL NULL, like
// toPrismaJsonValue(undefined).
func encodeObject(object *crawlfrontierllm.Object) (any, error) {
	if object == nil {
		return nil, nil
	}
	return object.MarshalJSON()
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func nullFloat(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	out := value.Float64
	return &out
}

func nullableStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableFloatValue(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

// parseObject reads a JSON metadata column; a NULL or non-object column is nil,
// matching `isPlainObject(metadata) ? metadata : null` in mapNode/mapRun.
func parseObject(raw []byte) *crawlfrontierllm.Object {
	if len(raw) == 0 {
		return nil
	}
	object, ok := crawlfrontierllm.ParseObject(json.RawMessage(raw))
	if !ok {
		return nil
	}
	return object
}

// coerceStringArray is coerceStringArray: trim every entry, drop the empty ones
// and return nil when nothing is left (the NestJS `undefined`).
func coerceStringArray(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseStringList reads a JSON string array column.
func parseStringList(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	return values
}
