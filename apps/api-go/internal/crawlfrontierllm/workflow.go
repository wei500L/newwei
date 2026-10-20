package crawlfrontierllm

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// workflow.go ports the CrawlStrategyRunRecorderService methods the judge and
// learn chains call: appendEvent, upsertStep, recordCandidateTrace,
// updateRunCounts and markRunStatus. createRun/finalizeRun are out of scope
// (frontier run creation belongs to the runs batch); the shared shapes match
// crawlfrontierruns/strategy_run_write.go where that batch already wrote them.

// WorkflowEvent is appendEvent's input.
type WorkflowEvent struct {
	Level         string
	EventType     string
	NodeID        *string
	NodeType      *string
	Message       string
	TriggerReason *string
	BeforeCount   *int
	AfterCount    *int
	RescuedCount  *int
	Details       *Object
	Timestamp     string
}

// AppendEvent mirrors appendEvent: the sequence is the existing event count + 1
// and the row is inserted without a transaction, exactly like the recorder
// (concurrent appends can collide on the same sequence, the same behaviour two
// NestJS writers already had).
func (s *Service) AppendEvent(ctx context.Context, runID string, event WorkflowEvent) error {
	var count int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", runID).Scan(&count); err != nil {
		return err
	}
	eventID, err := newRowID()
	if err != nil {
		return err
	}
	details := json.RawMessage("{}")
	if event.Details != nil {
		details, err = event.Details.MarshalJSON()
		if err != nil {
			return err
		}
	}
	createdAt := parseEventTime(event.Timestamp)
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunEvent
  (id, runId, sequence, level, eventType, nodeId, nodeType, message, triggerReason,
   beforeCount, afterCount, rescuedCount, details, createdAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		eventID, runID, count+1, event.Level, event.EventType, nullableString(event.NodeID),
		nullableString(event.NodeType), event.Message, nullableString(event.TriggerReason),
		nullableInt(event.BeforeCount), nullableInt(event.AfterCount), nullableInt(event.RescuedCount),
		details, createdAt)
	return err
}

// WorkflowStep is upsertStep's input.
type WorkflowStep struct {
	StepKey       string
	NodeID        string
	NodeType      string
	Label         string
	Status        string
	DurationMs    int
	InputCount    int
	OutputCount   int
	RejectedCount int
	SampleURLs    []string
	Metrics       *Object
	Error         *string
}

// UpsertStep mirrors upsertStep: an existing (runId, stepKey) keeps its
// sequence, a new step takes the current step count + 1.
func (s *Service) UpsertStep(ctx context.Context, runID string, step WorkflowStep) error {
	stepKey := strings.TrimSpace(step.StepKey)
	if stepKey == "" {
		stepKey = step.NodeID
	}
	var existingSequence sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		"SELECT sequence FROM CrawlStrategyWorkflowRunStep WHERE runId = ? AND stepKey = ? LIMIT 1",
		runID, stepKey).Scan(&existingSequence)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	sequence := int64(0)
	if existingSequence.Valid {
		sequence = existingSequence.Int64
	} else {
		var count int
		if err := s.db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunStep WHERE runId = ?", runID).Scan(&count); err != nil {
			return err
		}
		sequence = int64(count + 1)
	}
	metrics := json.RawMessage("{}")
	if step.Metrics != nil {
		metrics, err = step.Metrics.MarshalJSON()
		if err != nil {
			return err
		}
	}
	sampleURLs, err := json.Marshal(stringListOrEmpty(step.SampleURLs))
	if err != nil {
		return err
	}
	now := truncateMillis(time.Now())
	if existingSequence.Valid {
		_, err = s.db.ExecContext(ctx, `
UPDATE CrawlStrategyWorkflowRunStep
SET workflowNodeId = ?, nodeType = ?, label = ?, status = ?, startedAt = NULL, finishedAt = NULL,
    durationMs = ?, inputCount = ?, outputCount = ?, rejectedCount = ?, sampleUrls = ?,
    metrics = ?, error = ?, metadata = '{}', updatedAt = ?
WHERE runId = ? AND stepKey = ?`,
			step.NodeID, step.NodeType, step.Label, step.Status, step.DurationMs, step.InputCount,
			step.OutputCount, step.RejectedCount, sampleURLs, metrics, nullableString(step.Error),
			now, runID, stepKey)
		return err
	}
	stepID, err := newRowID()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunStep
  (id, runId, stepKey, sequence, workflowNodeId, nodeType, label, status, startedAt, finishedAt,
   durationMs, inputCount, outputCount, rejectedCount, sampleUrls, metrics, error, metadata,
   createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
		stepID, runID, stepKey, sequence, step.NodeID, step.NodeType, step.Label, step.Status,
		step.DurationMs, step.InputCount, step.OutputCount, step.RejectedCount, sampleURLs,
		metrics, nullableString(step.Error), now, now)
	return err
}

// TraceCandidate is CrawlStrategyWorkflowCandidate.
type TraceCandidate struct {
	ID               string
	URL              string
	Title            *string
	Description      *string
	Author           *string
	PageType         *string
	RelevanceScore   *float64
	Score            *float64
	FreshnessScore   *float64
	QualityScore     *float64
	PublishedAt      *string
	CrawledAt        *string
	EffectiveAt      *string
	Status           string
	RejectedByNodeID *string
	RejectedReason   *string
	SourceNodeID     string
	Metadata         *Object
	Trace            []TraceEntry
}

// TraceEntry is CrawlStrategyCandidateTraceEntry.
type TraceEntry struct {
	NodeID         string
	NodeType       string
	Action         string
	Message        string
	Accepted       *bool
	ScoreDelta     *float64
	FreshnessDelta *float64
	RuleHits       []string
	RejectedReason *string
	BeforeSnapshot *Object
	AfterSnapshot  *Object
	Details        *Object
	Timestamp      string
}

// RecordCandidateTrace mirrors recordCandidateTrace: upsert the candidate by
// (runId, candidateKey), append the trace with traceCount+1, then increment
// traceCount. It intentionally does not wrap the three statements in a
// transaction, matching the recorder.
func (s *Service) RecordCandidateTrace(ctx context.Context, runID string, candidate TraceCandidate, trace TraceEntry) error {
	candidateKey := buildCandidateKey(traceCandidateKey(candidate), candidate.URL)
	now := truncateMillis(time.Now())
	metadata := json.RawMessage("{}")
	if candidate.Metadata != nil {
		encoded, err := candidate.Metadata.MarshalJSON()
		if err != nil {
			return err
		}
		metadata = encoded
	}
	sourceNodeType := any(nil)
	if len(candidate.Trace) > 0 {
		sourceNodeType = candidate.Trace[0].NodeType
	}

	var candidateID string
	var traceCount int
	err := s.db.QueryRowContext(ctx,
		"SELECT id, traceCount FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ? AND candidateKey = ? LIMIT 1",
		runID, candidateKey).Scan(&candidateID, &traceCount)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		candidateID, err = newRowID()
		if err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunCandidate
  (id, runId, candidateKey, externalId, sourceNodeId, sourceNodeType, url, title, description,
   author, pageType, relevanceScore, score, freshnessScore, qualityScore, publishedAt,
   crawledAt, effectiveAt, status, rejectedByNodeId, rejectedReason, metadata, traceCount,
   createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			candidateID, runID, candidateKey, candidate.IDValue(), nullableString(stringOrNil(candidate.SourceNodeID)),
			sourceNodeType, candidate.URL, nullableString(candidate.Title), nullableString(candidate.Description),
			nullableString(candidate.Author), nullableString(candidate.PageType), nullableFloat(candidate.RelevanceScore),
			nullableFloat(candidate.Score), nullableFloat(candidate.FreshnessScore), nullableFloat(candidate.QualityScore),
			nullableDate(candidate.PublishedAt), nullableDate(candidate.CrawledAt), nullableDate(candidate.EffectiveAt),
			candidate.Status, nullableString(candidate.RejectedByNodeID), nullableString(candidate.RejectedReason),
			metadata, len(candidate.Trace), now, now)
		if err != nil {
			if !isDuplicateKeyError(err) {
				return err
			}
			// A concurrent writer created the candidate; fall back to the
			// existing row exactly like Prisma's upsert retry.
			if err := s.db.QueryRowContext(ctx,
				"SELECT id, traceCount FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ? AND candidateKey = ? LIMIT 1",
				runID, candidateKey).Scan(&candidateID, &traceCount); err != nil {
				return err
			}
			if err := s.updateCandidate(ctx, candidateID, candidate, metadata); err != nil {
				return err
			}
		} else {
			traceCount = len(candidate.Trace)
		}
	case err != nil:
		return err
	default:
		if err := s.updateCandidate(ctx, candidateID, candidate, metadata); err != nil {
			return err
		}
	}

	traceID, err := newRowID()
	if err != nil {
		return err
	}
	if err := s.insertCandidateTrace(ctx, traceID, candidateID, traceCount+1, trace); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		"UPDATE CrawlStrategyWorkflowRunCandidate SET traceCount = traceCount + 1, updatedAt = ? WHERE id = ?",
		now, candidateID)
	return err
}

func (s *Service) updateCandidate(ctx context.Context, candidateID string, candidate TraceCandidate, metadata json.RawMessage) error {
	now := truncateMillis(time.Now())
	sourceNodeType := any(nil)
	if len(candidate.Trace) > 0 {
		sourceNodeType = candidate.Trace[0].NodeType
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE CrawlStrategyWorkflowRunCandidate
SET externalId = ?, sourceNodeId = ?, sourceNodeType = ?, url = ?, title = ?, description = ?,
    author = ?, pageType = ?, relevanceScore = ?, score = ?, freshnessScore = ?, qualityScore = ?,
    publishedAt = ?, crawledAt = ?, effectiveAt = ?, status = ?, rejectedByNodeId = ?,
    rejectedReason = ?, metadata = ?, updatedAt = ?
WHERE id = ?`,
		candidate.IDValue(), nullableString(stringOrNil(candidate.SourceNodeID)), sourceNodeType,
		candidate.URL, nullableString(candidate.Title), nullableString(candidate.Description),
		nullableString(candidate.Author), nullableString(candidate.PageType), nullableFloat(candidate.RelevanceScore),
		nullableFloat(candidate.Score), nullableFloat(candidate.FreshnessScore), nullableFloat(candidate.QualityScore),
		nullableDate(candidate.PublishedAt), nullableDate(candidate.CrawledAt), nullableDate(candidate.EffectiveAt),
		candidate.Status, nullableString(candidate.RejectedByNodeID), nullableString(candidate.RejectedReason),
		metadata, now, candidateID)
	return err
}

func (s *Service) insertCandidateTrace(ctx context.Context, traceID, candidateID string, sequence int, trace TraceEntry) error {
	ruleHits, err := json.Marshal(stringListOrEmpty(trace.RuleHits))
	if err != nil {
		return err
	}
	before := json.RawMessage("{}")
	if trace.BeforeSnapshot != nil {
		before, err = trace.BeforeSnapshot.MarshalJSON()
		if err != nil {
			return err
		}
	}
	after := json.RawMessage("{}")
	if trace.AfterSnapshot != nil {
		after, err = trace.AfterSnapshot.MarshalJSON()
		if err != nil {
			return err
		}
	}
	details := mergeObjects(trace.Details, nil)
	if details == nil {
		details = NewObject()
	}
	if trace.RejectedReason != nil && jsTrim(*trace.RejectedReason) != "" {
		details.SetString("rejectedReason", *trace.RejectedReason)
	}
	encodedDetails, err := details.MarshalJSON()
	if err != nil {
		return err
	}
	// The Prisma trace table has no rejectedReason column: Nest merges it into
	// details, and the read path surfaces details.rejectedReason.
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunCandidateTrace
  (id, candidateId, sequence, timestamp, nodeId, nodeType, action, message, accepted,
   scoreDelta, freshnessDelta, ruleHits, beforeSnapshot, afterSnapshot, details)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		traceID, candidateID, sequence, parseEventTime(trace.Timestamp), trace.NodeID,
		trace.NodeType, trace.Action, trace.Message, nullableBool(trace.Accepted),
		nullableFloat(trace.ScoreDelta), nullableFloat(trace.FreshnessDelta), ruleHits,
		before, after, encodedDetails)
	return err
}

// UpdateRunCounts mirrors updateRunCounts: recount steps/candidates and rewrite
// the denormalized columns, stepResults, candidates and output.
func (s *Service) UpdateRunCounts(ctx context.Context, runID string, patch *Object) error {
	var stepCount, candidateCount, selectedCount, eventCount int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM CrawlStrategyWorkflowRunStep WHERE runId = ?", runID).Scan(&stepCount); err != nil {
		return err
	}
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ?", runID).Scan(&candidateCount); err != nil {
		return err
	}
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ? AND status = 'selected'", runID).Scan(&selectedCount); err != nil {
		return err
	}
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", runID).Scan(&eventCount); err != nil {
		return err
	}
	steps, err := s.loadStepResults(ctx, runID)
	if err != nil {
		return err
	}
	candidates, err := s.loadCandidateResults(ctx, runID)
	if err != nil {
		return err
	}
	output := objectOrEmpty(patch).Clone()
	output.SetNumber("eventCount", float64(eventCount))
	output.SetNumber("selectedCount", float64(selectedCount))
	output.SetNumber("candidateCount", float64(candidateCount))
	output.SetNumber("stepCount", float64(stepCount))
	encodedSteps, err := steps.MarshalJSON()
	if err != nil {
		return err
	}
	encodedCandidates, err := candidates.MarshalJSON()
	if err != nil {
		return err
	}
	encodedOutput, err := output.MarshalJSON()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
UPDATE CrawlStrategyWorkflowRun
SET stepCount = ?, candidateCount = ?, selectedCount = ?, stepResults = ?, candidates = ?,
    output = ?, updatedAt = ?
WHERE id = ?`,
		stepCount, candidateCount, selectedCount, encodedSteps, encodedCandidates, encodedOutput,
		truncateMillis(time.Now()), runID)
	return err
}

func (s *Service) loadStepResults(ctx context.Context, runID string) (*Array, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT stepKey, workflowNodeId, nodeType, label, status, durationMs, inputCount, outputCount,
       rejectedCount, sampleUrls, metrics, error
FROM CrawlStrategyWorkflowRunStep WHERE runId = ? ORDER BY sequence ASC, createdAt ASC`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := NewArray()
	for rows.Next() {
		var (
			stepKey, nodeType, label, status  string
			workflowNodeID                    sql.NullString
			durationMs                        sql.NullInt64
			inputCount, outputCount, rejected sql.NullInt64
			sampleURLs, metrics               []byte
			errorText                         sql.NullString
		)
		if err := rows.Scan(&stepKey, &workflowNodeID, &nodeType, &label, &status, &durationMs,
			&inputCount, &outputCount, &rejected, &sampleURLs, &metrics, &errorText); err != nil {
			return nil, err
		}
		item := NewObject()
		item.SetString("stepKey", stepKey)
		nodeID := stepKey
		if workflowNodeID.Valid && workflowNodeID.String != "" {
			nodeID = workflowNodeID.String
		}
		item.SetString("nodeId", nodeID)
		item.SetString("nodeType", nodeType)
		item.SetString("label", label)
		item.SetString("status", status)
		item.SetNumber("durationMs", nullIntOrZero(durationMs))
		item.SetNumber("inputCount", nullIntOrZero(inputCount))
		item.SetNumber("outputCount", nullIntOrZero(outputCount))
		item.SetNumber("rejectedCount", nullIntOrZero(rejected))
		item.Set("sampleUrls", stringListOrEmpty(parseStringList(sampleURLs)))
		if object := parseObjectOrNil(metrics); object != nil {
			item.SetRaw("metrics", mustJSON(object))
		}
		if errorText.Valid {
			item.SetString("error", errorText.String)
		} else {
			item.SetNull("error")
		}
		out.Append(mustJSON(item))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) loadCandidateResults(ctx context.Context, runID string) (*Array, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, externalId, sourceNodeId, url, title, description, author, pageType,
       relevanceScore, score, freshnessScore, qualityScore, publishedAt, crawledAt, effectiveAt,
       status, rejectedByNodeId, rejectedReason, metadata
FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ?
ORDER BY updatedAt DESC, createdAt ASC`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type candidateRow struct {
		id, externalID, url, status          string
		sourceNodeID                         sql.NullString
		title, description, author, pageType sql.NullString
		relevance, score, freshness, quality sql.NullFloat64
		publishedAt, crawledAt, effectiveAt  sql.NullTime
		rejectedByNodeID, rejectedReason     sql.NullString
		metadata                             []byte
	}
	scanned := make([]candidateRow, 0)
	for rows.Next() {
		var item candidateRow
		if err := rows.Scan(&item.id, &item.externalID, &item.sourceNodeID, &item.url, &item.title,
			&item.description, &item.author, &item.pageType, &item.relevance, &item.score,
			&item.freshness, &item.quality, &item.publishedAt, &item.crawledAt, &item.effectiveAt,
			&item.status, &item.rejectedByNodeID, &item.rejectedReason, &item.metadata); err != nil {
			return nil, err
		}
		scanned = append(scanned, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := NewArray()
	for _, row := range scanned {
		item := NewObject()
		if row.externalID != "" {
			item.SetString("id", row.externalID)
		} else {
			item.SetString("id", row.id)
		}
		item.SetString("url", row.url)
		setOptionalString(item, "title", row.title)
		setOptionalString(item, "description", row.description)
		setOptionalString(item, "author", row.author)
		setOptionalString(item, "pageType", row.pageType)
		setOptionalNumber(item, "relevanceScore", row.relevance)
		setOptionalNumber(item, "score", row.score)
		setOptionalNumber(item, "freshnessScore", row.freshness)
		setOptionalNumber(item, "qualityScore", row.quality)
		setOptionalTime(item, "publishedAt", row.publishedAt)
		setOptionalTime(item, "crawledAt", row.crawledAt)
		setOptionalTime(item, "effectiveAt", row.effectiveAt)
		item.SetString("status", row.status)
		if row.rejectedByNodeID.Valid {
			item.SetString("rejectedByNodeId", row.rejectedByNodeID.String)
		} else {
			item.SetNull("rejectedByNodeId")
		}
		if row.rejectedReason.Valid {
			item.SetString("rejectedReason", row.rejectedReason.String)
		} else {
			item.SetNull("rejectedReason")
		}
		sourceNode := "unknown"
		if row.sourceNodeID.Valid && row.sourceNodeID.String != "" {
			sourceNode = row.sourceNodeID.String
		}
		item.SetString("sourceNodeId", sourceNode)
		if object := parseObjectOrNil(row.metadata); object != nil {
			item.SetRaw("metadata", mustJSON(object))
		} else {
			item.SetRaw("metadata", json.RawMessage("{}"))
		}
		traces, err := s.loadCandidateTraces(ctx, row.id)
		if err != nil {
			return nil, err
		}
		item.SetRaw("trace", mustJSON(traces))
		out.Append(mustJSON(item))
	}
	return out, nil
}

func (s *Service) loadCandidateTraces(ctx context.Context, candidateID string) (*Array, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT nodeId, nodeType, action, message, accepted, scoreDelta, freshnessDelta, ruleHits,
       beforeSnapshot, afterSnapshot, details, timestamp
FROM CrawlStrategyWorkflowRunCandidateTrace WHERE candidateId = ?
ORDER BY sequence ASC, timestamp ASC`, candidateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := NewArray()
	for rows.Next() {
		var (
			nodeID, nodeType, action, message string
			accepted                          sql.NullBool
			scoreDelta, freshnessDelta        sql.NullFloat64
			ruleHits                          []byte
			beforeSnapshot, afterSnapshot     []byte
			details                           []byte
			timestamp                         time.Time
		)
		if err := rows.Scan(&nodeID, &nodeType, &action, &message, &accepted, &scoreDelta,
			&freshnessDelta, &ruleHits, &beforeSnapshot, &afterSnapshot,
			&details, &timestamp); err != nil {
			return nil, err
		}
		item := NewObject()
		item.SetString("nodeId", nodeID)
		item.SetString("nodeType", nodeType)
		item.SetString("action", action)
		item.SetString("message", message)
		if accepted.Valid {
			item.SetBool("accepted", accepted.Bool)
		}
		if scoreDelta.Valid {
			item.SetNumber("scoreDelta", scoreDelta.Float64)
		}
		if freshnessDelta.Valid {
			item.SetNumber("freshnessDelta", freshnessDelta.Float64)
		}
		if hits := parseStringList(ruleHits); hits != nil {
			item.Set("ruleHits", hits)
		}
		if object := parseObjectOrNil(details); object != nil {
			if reason, ok := object.String("rejectedReason"); ok {
				item.SetString("rejectedReason", reason)
			}
		}
		if object := parseObjectOrNil(beforeSnapshot); object != nil {
			item.SetRaw("beforeSnapshot", mustJSON(object))
		}
		if object := parseObjectOrNil(afterSnapshot); object != nil {
			item.SetRaw("afterSnapshot", mustJSON(object))
		}
		if object := parseObjectOrNil(details); object != nil {
			item.SetRaw("details", mustJSON(object))
		}
		item.SetString("timestamp", nestISOString(timestamp))
		out.Append(mustJSON(item))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
func (s *Service) MarkRunStatus(ctx context.Context, runID, status string, errorText *string, finishedAt *time.Time) error {
	if finishedAt != nil {
		_, err := s.db.ExecContext(ctx,
			"UPDATE CrawlStrategyWorkflowRun SET status = ?, error = ?, finishedAt = ?, updatedAt = ? WHERE id = ?",
			status, nullableString(errorText), truncateMillis(*finishedAt), truncateMillis(time.Now()), runID)
		return err
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE CrawlStrategyWorkflowRun SET status = ?, error = ?, updatedAt = ? WHERE id = ?",
		status, nullableString(errorText), truncateMillis(time.Now()), runID)
	return err
}

// buildCandidateKey mirrors buildCandidateKey: a trimmed non-empty
// metadata.candidateKey capped at 191 characters, else sha256(url).
func buildCandidateKey(raw *string, url string) string {
	if raw != nil {
		trimmed := jsTrim(*raw)
		if trimmed != "" {
			return sliceRunes(trimmed, 191)
		}
	}
	sum := sha256.Sum256([]byte(url))
	return hex.EncodeToString(sum[:])
}

func traceCandidateKey(candidate TraceCandidate) *string {
	if candidate.Metadata == nil {
		return nil
	}
	value, ok := candidate.Metadata.String("candidateKey")
	if !ok {
		return nil
	}
	return &value
}

// IDValue is candidate.id. The workflow candidate always carries an explicit
// external id (`${sourceNodeId}:${url}`); the empty fallback keeps the column
// nullable.
func (c TraceCandidate) IDValue() any {
	if strings.TrimSpace(c.ID) == "" {
		return nil
	}
	return c.ID
}

func stringOrNil(value string) *string {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func stringListOrEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableBool(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableDate(value *string) any {
	if value == nil {
		return nil
	}
	parsed, ok := parseJSONTime(*value)
	if !ok {
		return nil
	}
	return parsed
}

func setOptionalString(item *Object, key string, value sql.NullString) {
	if value.Valid {
		item.SetString(key, value.String)
	}
}

func setOptionalNumber(item *Object, key string, value sql.NullFloat64) {
	if value.Valid {
		item.SetNumber(key, value.Float64)
	}
}

func setOptionalTime(item *Object, key string, value sql.NullTime) {
	if value.Valid {
		item.SetString(key, nestISOString(value.Time))
	} else {
		item.SetNull(key)
	}
}

func nullIntOrZero(value sql.NullInt64) float64 {
	if !value.Valid {
		return 0
	}
	return float64(value.Int64)
}

func parseEventTime(value string) time.Time {
	parsed, ok := parseJSONTime(value)
	if !ok {
		return truncateMillis(time.Now())
	}
	return truncateMillis(parsed)
}

func mustJSON(value any) json.RawMessage {
	encoded, err := marshalJSON(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}
