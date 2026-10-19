package crawlstrategyruns

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

// This file ports CrawlStrategyRunRecorderService
// (apps/api/src/modules/crawl/crawl-strategy-run-recorder.service.ts:59-424 and
// :610-714) for the operations the trial/replay chain calls: createRun and
// finalizeRun, plus the incremental helpers (appendEvent, upsertStep,
// recordCandidateTrace, updateRunCounts, markRunStatus) and the
// attachFrontierRun relation update.
//
// Write contract: finalizeRun replaces the per-run rows and then aggregates the
// counts onto the run row in one transaction, exactly like the source. The JSON
// columns receive the same document shapes, so the existing Go and NestJS run
// detail, candidate and explanation reads render identical output.

// CreateRun inserts one running workflow run and optionally links the frontier
// run row.
func (s *Service) CreateRun(ctx context.Context, input createRunInput) (string, error) {
	runID, err := newRowID()
	if err != nil {
		return "", err
	}
	now := nowMillis()
	status := input.Status
	if status == "" {
		status = RunStatusRunning
	}
	origin := input.WorkflowOrigin
	if origin == "" {
		origin = WorkflowOriginBound
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRun
  (id, orgId, workflowId, workflowVersionId, workflowOrigin, profileId, newsSourceId,
   status, runKind, input, graphSnapshot, parameterSources, createdById, startedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		runID, input.OrgID, nullableString(input.WorkflowID), nullableString(input.WorkflowVersionID),
		origin, nullableString(input.ProfileID), nullableString(input.NewsSourceID),
		status, input.RunKind, jsonArg(input.Input), jsonArg(input.GraphSnapshot),
		jsonArg(marshalJSON(input.ParameterSources)), input.CreatedByID,
		nullableTime(input.StartedAt), now, now,
	)
	if err != nil {
		return "", err
	}
	if input.FrontierRunID != nil && *input.FrontierRunID != "" {
		if err := s.AttachFrontierRun(ctx, *input.FrontierRunID, runID); err != nil {
			return "", err
		}
	}
	return runID, nil
}

// AttachFrontierRun sets CrawlFrontierRun.workflowRunId.
func (s *Service) AttachFrontierRun(ctx context.Context, frontierRunID, workflowRunID string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE CrawlFrontierRun SET workflowRunId = ?, updatedAt = ? WHERE id = ?",
		workflowRunID, nowMillis(), frontierRunID)
	return err
}

// FinalizeRun replaces the run's step, event, candidate and trace rows and
// updates the run row in one transaction.
func (s *Service) FinalizeRun(ctx context.Context, runID string, input finalizeRunInput) error {
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback() }()

	if err := replaceSteps(ctx, transaction, runID, input.Steps); err != nil {
		return err
	}
	if err := replaceEvents(ctx, transaction, runID, input.Events); err != nil {
		return err
	}
	if err := replaceCandidates(ctx, transaction, runID, input.Candidates); err != nil {
		return err
	}

	now := nowMillis()
	assignments := []string{
		"status = ?", "output = ?", "stepResults = ?", "candidates = ?",
		"parameterSources = ?", "error = ?", "finishedAt = ?", "updatedAt = ?",
	}
	args := []any{
		input.Status, jsonArg(marshalJSON(jsonObjectOrEmpty(input.Output))),
		jsonArg(jsonArrayOrEmpty(input.Steps)), jsonArg(jsonArrayOrEmpty(input.Candidates)),
		jsonArg(jsonArrayOrEmpty(input.ParameterSources)),
		nullableString(input.Error), nullableTime(input.FinishedAt), now,
	}
	if input.Steps != nil {
		assignments = append(assignments, "stepCount = ?")
		args = append(args, len(input.Steps))
	}
	if input.Candidates != nil {
		assignments = append(assignments, "candidateCount = ?", "selectedCount = ?")
		args = append(args, len(input.Candidates), countSelected(input.Candidates))
	}
	args = append(args, runID)
	if _, err := transaction.ExecContext(ctx,
		"UPDATE CrawlStrategyWorkflowRun SET "+strings.Join(assignments, ", ")+" WHERE id = ?", args...); err != nil {
		return err
	}
	return transaction.Commit()
}

// replaceSteps implements the step deleteMany + createMany pair.
func replaceSteps(ctx context.Context, tx *sql.Tx, runID string, steps []Step) error {
	if steps == nil {
		return nil
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlStrategyWorkflowRunStep WHERE runId = ?", runID); err != nil {
		return err
	}
	if len(steps) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(steps))
	args := make([]any, 0, len(steps)*18)
	for index, step := range steps {
		id, err := newRowID()
		if err != nil {
			return err
		}
		stepKey := step.StepKey
		if stepKey == "" {
			stepKey = step.NodeID
		}
		placeholders = append(placeholders, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		args = append(args,
			id, runID, stepKey, index+1, step.NodeID, step.NodeType, step.Label, step.Status,
			nil, nil, step.DurationMs, step.InputCount, step.OutputCount, step.RejectedCount,
			jsonArg(marshalJSON(step.SampleURLs)), jsonArg(marshalMetrics(step.Metrics)),
			nullableString(step.Error), jsonArg(marshalJSON(struct{}{})),
		)
	}
	_, err := tx.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunStep
  (id, runId, stepKey, sequence, workflowNodeId, nodeType, label, status, startedAt, finishedAt,
   durationMs, inputCount, outputCount, rejectedCount, sampleUrls, metrics, error, metadata)
VALUES `+strings.Join(placeholders, ", "), args...)
	return err
}

// replaceEvents implements the event deleteMany + createMany pair.
func replaceEvents(ctx context.Context, tx *sql.Tx, runID string, events []SystemEvent) error {
	if events == nil {
		return nil
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", runID); err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(events))
	args := make([]any, 0, len(events)*15)
	for index, event := range events {
		id, err := newRowID()
		if err != nil {
			return err
		}
		createdAt := parseNestTime(event.Timestamp)
		placeholders = append(placeholders, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		args = append(args,
			id, runID, index+1, event.Level, event.EventType,
			nullableString(event.NodeID), nullableString(event.NodeType), event.Message,
			nullableString(event.TriggerReason), nullableInt(event.BeforeCount),
			nullableInt(event.AfterCount), nullableInt(event.RescuedCount),
			jsonArg(marshalMetrics(event.Details)), createdAt,
		)
	}
	_, err := tx.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunEvent
  (id, runId, sequence, level, eventType, nodeId, nodeType, message, triggerReason,
   beforeCount, afterCount, rescuedCount, details, createdAt)
VALUES `+strings.Join(placeholders, ", "), args...)
	return err
}

// replaceCandidates implements the trace/candidate deleteMany + per-candidate
// create with batched trace inserts.
func replaceCandidates(ctx context.Context, tx *sql.Tx, runID string, candidates []Candidate) error {
	if candidates == nil {
		return nil
	}
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM CrawlStrategyWorkflowRunCandidateTrace WHERE candidateId IN (SELECT id FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ?)",
		runID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ?", runID); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}
	now := nowMillis()
	for _, candidate := range candidates {
		id, err := newRowID()
		if err != nil {
			return err
		}
		candidateKey := candidateKeyOf(candidate)
		sourceNodeType := (*string)(nil)
		if len(candidate.Trace) > 0 {
			nodeType := candidate.Trace[0].NodeType
			sourceNodeType = &nodeType
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunCandidate
  (id, runId, candidateKey, externalId, sourceNodeId, sourceNodeType, url, title, description,
   author, pageType, relevanceScore, score, freshnessScore, qualityScore, publishedAt, crawledAt,
   effectiveAt, status, rejectedByNodeId, rejectedReason, metadata, traceCount, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, runID, candidateKey, nullableString(&candidate.ID), nullableString(&candidate.SourceNodeID),
			nullableString(sourceNodeType), candidate.URL, nullableString(candidate.Title),
			nullableString(candidate.Description), nullableString(candidate.Author),
			nullableString(candidate.PageType), nullableFloat(candidate.RelevanceScore),
			nullableFloat(candidate.Score), nullableFloat(candidate.FreshnessScore),
			nullableFloat(candidate.QualityScore), nullableTimestamp(candidate.PublishedAt),
			nullableTimestamp(candidate.CrawledAt), nullableTimestamp(candidate.EffectiveAt),
			candidate.Status, nullableString(candidate.RejectedByNodeID),
			nullableString(candidate.RejectedReason), jsonArg(marshalMetrics(candidate.Metadata)),
			len(candidate.Trace), now, now,
		)
		if err != nil {
			return err
		}
		if err := insertTraces(ctx, tx, id, candidate.Trace); err != nil {
			return err
		}
	}
	return nil
}

// insertTraces writes the trace rows for one candidate in a single statement.
func insertTraces(ctx context.Context, tx *sql.Tx, candidateID string, traces []Trace) error {
	if len(traces) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(traces))
	args := make([]any, 0, len(traces)*15)
	for index, trace := range traces {
		id, err := newRowID()
		if err != nil {
			return err
		}
		placeholders = append(placeholders, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		args = append(args,
			id, candidateID, index+1, parseNestTime(trace.Timestamp), trace.NodeID,
			trace.NodeType, trace.Action, trace.Message, nullableBool(trace.Accepted),
			nullableFloat(trace.ScoreDelta), nullableFloat(trace.FreshnessDelta),
			jsonArg(marshalJSON(trace.RuleHits)), jsonArg(marshalMetrics(trace.BeforeSnapshot)),
			jsonArg(marshalMetrics(trace.AfterSnapshot)), jsonArg(traceDetails(trace)),
		)
	}
	_, err := tx.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunCandidateTrace
  (id, candidateId, sequence, timestamp, nodeId, nodeType, action, message, accepted,
   scoreDelta, freshnessDelta, ruleHits, beforeSnapshot, afterSnapshot, details)
VALUES `+strings.Join(placeholders, ", "), args...)
	return err
}

// traceDetails merges the optional rejectedReason into details, like
// buildTraceCreateData.
func traceDetails(trace Trace) json.RawMessage {
	details := map[string]any{}
	if fields, ok := decodeObject(trace.Details); ok {
		details = fields
	}
	if trace.RejectedReason != nil {
		details["rejectedReason"] = *trace.RejectedReason
	}
	return marshalJSON(details)
}

// AppendEvent appends one event with the next sequence number.
func (s *Service) AppendEvent(ctx context.Context, runID string, event SystemEvent) error {
	var count int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", runID).Scan(&count); err != nil {
		return err
	}
	id, err := newRowID()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunEvent
  (id, runId, sequence, level, eventType, nodeId, nodeType, message, triggerReason,
   beforeCount, afterCount, rescuedCount, details, createdAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, runID, count+1, event.Level, event.EventType, nullableString(event.NodeID),
		nullableString(event.NodeType), event.Message, nullableString(event.TriggerReason),
		nullableInt(event.BeforeCount), nullableInt(event.AfterCount),
		nullableInt(event.RescuedCount), jsonArg(marshalMetrics(event.Details)),
		parseNestTime(event.Timestamp),
	)
	return err
}

// UpsertStep writes one step keyed by runId+stepKey, reusing the existing
// sequence.
func (s *Service) UpsertStep(ctx context.Context, runID string, step Step) error {
	stepKey := step.StepKey
	if stepKey == "" {
		stepKey = step.NodeID
	}
	sequence := 0
	err := s.db.QueryRowContext(ctx,
		"SELECT sequence FROM CrawlStrategyWorkflowRunStep WHERE runId = ? AND stepKey = ?", runID, stepKey).Scan(&sequence)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == sql.ErrNoRows {
		var count int
		if err := s.db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunStep WHERE runId = ?", runID).Scan(&count); err != nil {
			return err
		}
		sequence = count + 1
		id, idErr := newRowID()
		if idErr != nil {
			return idErr
		}
		_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunStep
  (id, runId, stepKey, sequence, workflowNodeId, nodeType, label, status, durationMs,
   inputCount, outputCount, rejectedCount, sampleUrls, metrics, error, metadata, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, runID, stepKey, sequence, step.NodeID, step.NodeType, step.Label, step.Status,
			step.DurationMs, step.InputCount, step.OutputCount, step.RejectedCount,
			jsonArg(marshalJSON(step.SampleURLs)), jsonArg(marshalMetrics(step.Metrics)),
			nullableString(step.Error), jsonArg(marshalJSON(struct{}{})), nowMillis(), nowMillis(),
		)
		return err
	}
	_, err = s.db.ExecContext(ctx, `
UPDATE CrawlStrategyWorkflowRunStep
SET workflowNodeId = ?, nodeType = ?, label = ?, status = ?, durationMs = ?, inputCount = ?,
    outputCount = ?, rejectedCount = ?, sampleUrls = ?, metrics = ?, error = ?, updatedAt = ?
WHERE runId = ? AND stepKey = ?`,
		step.NodeID, step.NodeType, step.Label, step.Status, step.DurationMs, step.InputCount,
		step.OutputCount, step.RejectedCount, jsonArg(marshalJSON(step.SampleURLs)),
		jsonArg(marshalMetrics(step.Metrics)), nullableString(step.Error), nowMillis(),
		runID, stepKey,
	)
	return err
}

// RecordCandidateTrace upserts the candidate by candidateKey and appends one
// trace.
func (s *Service) RecordCandidateTrace(ctx context.Context, runID string, candidate Candidate, trace Trace) error {
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback() }()

	candidateKey := candidateKeyOf(candidate)
	var candidateID string
	var traceCount int
	err = transaction.QueryRowContext(ctx,
		"SELECT id, traceCount FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ? AND candidateKey = ?",
		runID, candidateKey).Scan(&candidateID, &traceCount)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	now := nowMillis()
	if err == sql.ErrNoRows {
		candidateID, err = newRowID()
		if err != nil {
			return err
		}
		traceCount = 0
		sourceNodeType := (*string)(nil)
		if len(candidate.Trace) > 0 {
			nodeType := candidate.Trace[0].NodeType
			sourceNodeType = &nodeType
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunCandidate
  (id, runId, candidateKey, externalId, sourceNodeId, sourceNodeType, url, title, description,
   author, pageType, relevanceScore, score, freshnessScore, qualityScore, publishedAt, crawledAt,
   effectiveAt, status, rejectedByNodeId, rejectedReason, metadata, traceCount, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			candidateID, runID, candidateKey, nullableString(&candidate.ID),
			nullableString(&candidate.SourceNodeID), nullableString(sourceNodeType), candidate.URL,
			nullableString(candidate.Title), nullableString(candidate.Description),
			nullableString(candidate.Author), nullableString(candidate.PageType),
			nullableFloat(candidate.RelevanceScore), nullableFloat(candidate.Score),
			nullableFloat(candidate.FreshnessScore), nullableFloat(candidate.QualityScore),
			nullableTimestamp(candidate.PublishedAt), nullableTimestamp(candidate.CrawledAt),
			nullableTimestamp(candidate.EffectiveAt), candidate.Status,
			nullableString(candidate.RejectedByNodeID), nullableString(candidate.RejectedReason),
			jsonArg(marshalMetrics(candidate.Metadata)), len(candidate.Trace), now, now,
		); err != nil {
			return err
		}
	} else {
		sourceNodeType := (*string)(nil)
		if len(candidate.Trace) > 0 {
			nodeType := candidate.Trace[0].NodeType
			sourceNodeType = &nodeType
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE CrawlStrategyWorkflowRunCandidate
SET externalId = ?, sourceNodeId = ?, sourceNodeType = ?, url = ?, title = ?, description = ?,
    author = ?, pageType = ?, relevanceScore = ?, score = ?, freshnessScore = ?, qualityScore = ?,
    publishedAt = ?, crawledAt = ?, effectiveAt = ?, status = ?, rejectedByNodeId = ?,
    rejectedReason = ?, metadata = ?, updatedAt = ?
WHERE id = ?`,
			nullableString(&candidate.ID), nullableString(&candidate.SourceNodeID),
			nullableString(sourceNodeType), candidate.URL, nullableString(candidate.Title),
			nullableString(candidate.Description), nullableString(candidate.Author),
			nullableString(candidate.PageType), nullableFloat(candidate.RelevanceScore),
			nullableFloat(candidate.Score), nullableFloat(candidate.FreshnessScore),
			nullableFloat(candidate.QualityScore), nullableTimestamp(candidate.PublishedAt),
			nullableTimestamp(candidate.CrawledAt), nullableTimestamp(candidate.EffectiveAt),
			candidate.Status, nullableString(candidate.RejectedByNodeID),
			nullableString(candidate.RejectedReason), jsonArg(marshalMetrics(candidate.Metadata)),
			now, candidateID,
		); err != nil {
			return err
		}
	}
	if err := insertTracesWithSequence(ctx, transaction, candidateID, trace, traceCount+1); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx,
		"UPDATE CrawlStrategyWorkflowRunCandidate SET traceCount = traceCount + 1 WHERE id = ?", candidateID); err != nil {
		return err
	}
	return transaction.Commit()
}

// insertTracesWithSequence writes one trace at the given sequence.
func insertTracesWithSequence(ctx context.Context, tx *sql.Tx, candidateID string, trace Trace, sequence int) error {
	id, err := newRowID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRunCandidateTrace
  (id, candidateId, sequence, timestamp, nodeId, nodeType, action, message, accepted,
   scoreDelta, freshnessDelta, ruleHits, beforeSnapshot, afterSnapshot, details)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, candidateID, sequence, parseNestTime(trace.Timestamp), trace.NodeID, trace.NodeType,
		trace.Action, trace.Message, nullableBool(trace.Accepted), nullableFloat(trace.ScoreDelta),
		nullableFloat(trace.FreshnessDelta), jsonArg(marshalJSON(trace.RuleHits)),
		jsonArg(marshalMetrics(trace.BeforeSnapshot)), jsonArg(marshalMetrics(trace.AfterSnapshot)),
		jsonArg(traceDetails(trace)),
	)
	return err
}

// MarkRunStatus updates the status (and optionally the error/finishedAt).
func (s *Service) MarkRunStatus(ctx context.Context, runID, status string, failure *string, finishedAt *time.Time) error {
	assignments := []string{"status = ?", "error = ?", "updatedAt = ?"}
	args := []any{status, nullableString(failure), nowMillis()}
	if finishedAt != nil {
		assignments = append(assignments, "finishedAt = ?")
		args = append(args, nullableTime(finishedAt))
	}
	args = append(args, runID)
	_, err := s.db.ExecContext(ctx, "UPDATE CrawlStrategyWorkflowRun SET "+strings.Join(assignments, ", ")+" WHERE id = ?", args...)
	return err
}

// ---- helpers ----

func nowMillis() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

func jsonArg(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return []byte(value)
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
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

func nullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

// nullableTimestamp accepts the ISO string shapes the candidates carry.
func nullableTimestamp(value *string) any {
	if value == nil || *value == "" {
		return nil
	}
	return parseNestTime(*value)
}

// parseNestTime parses an ISO-8601 timestamp; an unparsable value falls back to
// the zero instant (the source's toDateOrNull returns null, which MySQL rejects
// for a non-null column only in the trace table, whose timestamp is NOT NULL
// with a default — using the current instant keeps the row valid).
func parseNestTime(value string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC()
		}
	}
	return nowMillis()
}

// jsonArrayOrEmpty renders a nil slice as [] (the source's `?? []`), so the JSON
// column never stores null for a collection.
func jsonArrayOrEmpty[T any](value []T) json.RawMessage {
	if value == nil {
		return json.RawMessage("[]")
	}
	return marshalJSON(value)
}

func jsonObjectOrEmpty(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("{}")
	}
	return value
}

func marshalMetrics(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("{}")
	}
	return value
}

func decodeObject(raw json.RawMessage) (map[string]any, bool) {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil, false
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false
	}
	return decoded, true
}

// candidateKeyOf implements buildCandidateKey: metadata.candidateKey when it is
// a non-empty string (trimmed, cut to 191), otherwise the sha256 of the URL.
func candidateKeyOf(candidate Candidate) string {
	if fields, ok := decodeObject(candidate.Metadata); ok {
		if raw, exists := fields["candidateKey"]; exists {
			if text, ok := raw.(string); ok {
				trimmed := strings.TrimSpace(text)
				if trimmed != "" {
					if len(trimmed) > 191 {
						trimmed = trimmed[:191]
					}
					return trimmed
				}
			}
		}
	}
	sum := sha256.Sum256([]byte(candidate.URL))
	return hex.EncodeToString(sum[:])
}

func countSelected(candidates []Candidate) int {
	count := 0
	for _, candidate := range candidates {
		if candidate.Status == CandidateStatusSelected {
			count++
		}
	}
	return count
}
