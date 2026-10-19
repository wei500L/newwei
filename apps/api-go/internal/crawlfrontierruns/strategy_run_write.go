package crawlfrontierruns

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
)

// This file ports the subset of
// apps/api/src/modules/crawl/crawl-strategy-run-recorder.service.ts that the
// crawl-strategy trial-run and replay need: createRun, finalizeRun (the success
// and failure paths) and the replay source read. The recorder is a method set on
// the existing Service so the run-detail / candidate / explanation reads in this
// package stay the single source of truth and the replay can reuse them.
//
// O1: finalizeRun no longer issues one INSERT per candidate plus one createMany
// per candidate trace. Candidate ids are pre-generated (the same cuid shape
// newRowID writes) and every table is written with multi-row INSERT statements
// batched at 300 rows, still inside the one transaction and still delete-first.
// The stored values, their order and the sequence numbers are identical to the
// per-row path.

// strategyInsertBatchSize bounds one multi-row INSERT (O1).
const strategyInsertBatchSize = 300

// StrategyRunTrace is CrawlStrategyCandidateTraceEntry.
type StrategyRunTrace struct {
	NodeID         string          `json:"nodeId"`
	NodeType       string          `json:"nodeType"`
	Action         string          `json:"action"`
	Message        string          `json:"message"`
	Accepted       *bool           `json:"accepted,omitempty"`
	ScoreDelta     *float64        `json:"scoreDelta,omitempty"`
	FreshnessDelta *float64        `json:"freshnessDelta,omitempty"`
	RuleHits       []string        `json:"ruleHits,omitempty"`
	RejectedReason *string         `json:"rejectedReason,omitempty"`
	BeforeSnapshot json.RawMessage `json:"beforeSnapshot,omitempty"`
	AfterSnapshot  json.RawMessage `json:"afterSnapshot,omitempty"`
	Details        json.RawMessage `json:"details,omitempty"`
	Timestamp      string          `json:"timestamp"`
}

// StrategyRunCandidate is CrawlStrategyWorkflowCandidate. The trace slice is
// shared by pointer with the runtime registry, so appending a trace mutates the
// same candidate object the earlier node outputs already reference.
type StrategyRunCandidate struct {
	ID               string             `json:"id"`
	URL              string             `json:"url"`
	Title            *string            `json:"title,omitempty"`
	Description      *string            `json:"description,omitempty"`
	Author           *string            `json:"author,omitempty"`
	PageType         *string            `json:"pageType,omitempty"`
	RelevanceScore   *float64           `json:"relevanceScore,omitempty"`
	Score            *float64           `json:"score,omitempty"`
	FreshnessScore   *float64           `json:"freshnessScore,omitempty"`
	QualityScore     *float64           `json:"qualityScore,omitempty"`
	PublishedAt      *string            `json:"publishedAt"`
	CrawledAt        *string            `json:"crawledAt"`
	EffectiveAt      *string            `json:"effectiveAt"`
	Status           string             `json:"status"`
	RejectedByNodeID *string            `json:"rejectedByNodeId"`
	RejectedReason   *string            `json:"rejectedReason"`
	SourceNodeID     string             `json:"sourceNodeId"`
	Metadata         json.RawMessage    `json:"metadata"`
	Trace            []StrategyRunTrace `json:"trace"`
}

// StrategyRunStep is CrawlStrategyWorkflowStepResult.
type StrategyRunStep struct {
	StepKey       string          `json:"stepKey,omitempty"`
	NodeID        string          `json:"nodeId"`
	NodeType      string          `json:"nodeType"`
	Label         string          `json:"label"`
	Status        string          `json:"status"`
	DurationMs    int             `json:"durationMs"`
	InputCount    int             `json:"inputCount"`
	OutputCount   int             `json:"outputCount"`
	RejectedCount int             `json:"rejectedCount"`
	SampleURLs    []string        `json:"sampleUrls"`
	Metrics       json.RawMessage `json:"metrics,omitempty"`
	Error         *string         `json:"error,omitempty"`
}

// StrategyRunEvent is CrawlStrategyWorkflowRunEvent.
type StrategyRunEvent struct {
	Level         string          `json:"level"`
	EventType     string          `json:"eventType"`
	NodeID        *string         `json:"nodeId,omitempty"`
	NodeType      *string         `json:"nodeType,omitempty"`
	Message       string          `json:"message"`
	TriggerReason *string         `json:"triggerReason,omitempty"`
	BeforeCount   *int            `json:"beforeCount,omitempty"`
	AfterCount    *int            `json:"afterCount,omitempty"`
	RescuedCount  *int            `json:"rescuedCount,omitempty"`
	Details       json.RawMessage `json:"details,omitempty"`
	Timestamp     string          `json:"timestamp"`
}

// StrategyRunCreateInput is the createRun argument set.
type StrategyRunCreateInput struct {
	OrgID             string
	CreatedByID       string
	WorkflowID        *string
	WorkflowVersionID *string
	WorkflowOrigin    string
	ProfileID         *string
	NewsSourceID      *string
	Status            string
	RunKind           string
	Input             json.RawMessage
	GraphSnapshot     json.RawMessage
	ParameterSources  json.RawMessage
	StartedAt         *time.Time
}

// StrategyRunFinalizeInput is the finalizeRun argument set. The Has* flags
// mirror the NestJS truthiness checks: an explicitly empty array still enters
// the branch (and zeroes the corresponding count), an absent array leaves the
// count and the table untouched.
type StrategyRunFinalizeInput struct {
	Status           string
	Output           json.RawMessage
	Steps            []StrategyRunStep
	HasSteps         bool
	Candidates       []StrategyRunCandidate
	HasCandidates    bool
	ParameterSources json.RawMessage
	Events           []StrategyRunEvent
	HasEvents        bool
	Error            *string
	FinishedAt       *time.Time
}

// StrategyRunReplaySource is the minimal original-run projection replay needs.
type StrategyRunReplaySource struct {
	WorkflowID        string
	WorkflowOrigin    string
	WorkflowVersionID string
	Input             json.RawMessage
	GraphSnapshot     json.RawMessage
}

// CreateRun inserts one running run row. input/graphSnapshot/parameterSources
// default to {}, the object and [] exactly like `toPrismaJsonValue(x ?? default)`.
func (s *Service) CreateRun(ctx context.Context, input StrategyRunCreateInput) (string, error) {
	if s == nil || s.db == nil {
		return "", errors.New("crawl frontier runs: no database")
	}
	runID, err := newRowID()
	if err != nil {
		return "", err
	}
	status := input.Status
	if status == "" {
		status = "running"
	}
	origin := input.WorkflowOrigin
	if origin == "" {
		origin = "bound"
	}
	runInput := jsonDefault(input.Input, `{}`)
	graph := jsonDefault(input.GraphSnapshot, `{}`)
	parameterSources := jsonDefault(input.ParameterSources, `[]`)

	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRun
  (id, orgId, workflowId, workflowVersionId, workflowOrigin, profileId, newsSourceId,
   status, runKind, input, output, graphSnapshot, stepResults, candidates, parameterSources,
   error, stepCount, candidateCount, selectedCount, createdById, startedAt, finishedAt,
   createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, 0, 0, 0, ?, ?, NULL, NOW(3), NOW(3))`,
		runID, input.OrgID, nullableStringValue(input.WorkflowID), nullableStringValue(input.WorkflowVersionID),
		origin, nullableStringValue(input.ProfileID), nullableStringValue(input.NewsSourceID),
		status, input.RunKind, []byte(runInput), []byte(graph), []byte(parameterSources),
		input.CreatedByID, nullableTimeValue(input.StartedAt))
	if err != nil {
		return "", err
	}
	return runID, nil
}

// FinalizeRun ports finalizeRun inside one transaction.
func (s *Service) FinalizeRun(ctx context.Context, runID string, input StrategyRunFinalizeInput) error {
	if s == nil || s.db == nil {
		return errors.New("crawl frontier runs: no database")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if input.HasSteps {
		if err := s.replaceRunSteps(ctx, tx, runID, input.Steps); err != nil {
			return err
		}
	}
	if input.HasEvents {
		if err := s.replaceRunEvents(ctx, tx, runID, input.Events); err != nil {
			return err
		}
	}
	if input.HasCandidates {
		if err := s.replaceRunCandidates(ctx, tx, runID, input.Candidates); err != nil {
			return err
		}
	}

	output := jsonDefault(input.Output, `{}`)
	stepResultsJSON := jsonDefault(marshalSteps(input.Steps), `[]`)
	candidatesJSON := jsonDefault(marshalCandidates(input.Candidates), `[]`)
	parameterSources := jsonDefault(input.ParameterSources, `[]`)

	query := `UPDATE CrawlStrategyWorkflowRun
SET status = ?, output = ?, stepResults = ?, candidates = ?, parameterSources = ?, error = ?, finishedAt = ?, updatedAt = NOW(3)`
	args := []any{input.Status, []byte(output), []byte(stepResultsJSON), []byte(candidatesJSON), []byte(parameterSources),
		nullableStringValue(input.Error), nullableTimeValue(input.FinishedAt)}
	if input.HasSteps {
		query += ", stepCount = ?"
		args = append(args, len(input.Steps))
	}
	if input.HasCandidates {
		selected := 0
		for _, candidate := range input.Candidates {
			if candidate.Status == "selected" {
				selected++
			}
		}
		query += ", candidateCount = ?, selectedCount = ?"
		args = append(args, len(input.Candidates), selected)
	}
	query += " WHERE id = ?"
	args = append(args, runID)
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return err
	}
	return tx.Commit()
}

// LoadReplaySource reads the original run for replay. It returns a 404
// "Workflow run not found" error when the run is missing or belongs to another
// organization, exactly like the recorder's getRun.
func (s *Service) LoadReplaySource(ctx context.Context, orgID, runID string) (*StrategyRunReplaySource, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("crawl frontier runs: no database")
	}
	var (
		runOrgID       string
		workflowID     sql.NullString
		workflowOrigin string
		versionID      sql.NullString
		input          []byte
		graphSnapshot  []byte
	)
	err := s.db.QueryRowContext(ctx, `
SELECT orgId, workflowId, workflowOrigin, workflowVersionId, input, graphSnapshot
FROM CrawlStrategyWorkflowRun WHERE id = ?`, runID).Scan(
		&runOrgID, &workflowID, &workflowOrigin, &versionID, &input, &graphSnapshot,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(404, "Workflow run not found")
	}
	if err != nil {
		return nil, err
	}
	if runOrgID != orgID {
		return nil, newStatus(404, "Workflow run not found")
	}
	out := &StrategyRunReplaySource{
		WorkflowOrigin: workflowOrigin,
		Input:          json.RawMessage(input),
		GraphSnapshot:  json.RawMessage(graphSnapshot),
	}
	if workflowID.Valid {
		out.WorkflowID = workflowID.String
	}
	if versionID.Valid {
		out.WorkflowVersionID = versionID.String
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// table writers (O1: batched, delete-first, same transaction)

func (s *Service) replaceRunSteps(ctx context.Context, tx *sql.Tx, runID string, steps []StrategyRunStep) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlStrategyWorkflowRunStep WHERE runId = ?", runID); err != nil {
		return err
	}
	if len(steps) == 0 {
		return nil
	}
	type row struct {
		id            string
		stepKey       string
		sequence      int
		nodeID        any
		nodeType      string
		label         string
		status        string
		durationMs    int
		inputCount    int
		outputCount   int
		rejectedCount int
		sampleURLs    []byte
		metrics       []byte
		errText       any
	}
	rows := make([]row, 0, len(steps))
	for index, step := range steps {
		id, err := newRowID()
		if err != nil {
			return err
		}
		stepKey := step.StepKey
		if strings.TrimSpace(stepKey) == "" {
			stepKey = step.NodeID
		}
		rows = append(rows, row{
			id:            id,
			stepKey:       stepKey,
			sequence:      index + 1,
			nodeID:        nullableStringValue(stringPointerOrNil(step.NodeID)),
			nodeType:      step.NodeType,
			label:         step.Label,
			status:        step.Status,
			durationMs:    step.DurationMs,
			inputCount:    step.InputCount,
			outputCount:   step.OutputCount,
			rejectedCount: step.RejectedCount,
			sampleURLs:    []byte(jsonDefault(marshalStringList(step.SampleURLs), `[]`)),
			metrics:       []byte(jsonDefault(step.Metrics, `{}`)),
			errText:       nullableStringValue(step.Error),
		})
	}
	for start := 0; start < len(rows); start += strategyInsertBatchSize {
		end := start + strategyInsertBatchSize
		if end > len(rows) {
			end = len(rows)
		}
		batch := rows[start:end]
		placeholders := make([]string, 0, len(batch))
		args := make([]any, 0, len(batch)*16)
		for _, item := range batch {
			placeholders = append(placeholders, "(?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))")
			args = append(args, item.id, runID, item.stepKey, item.sequence, item.nodeID, item.nodeType, item.label,
				item.status, item.durationMs, item.inputCount, item.outputCount, item.rejectedCount,
				item.sampleURLs, item.metrics, item.errText, []byte(`{}`))
		}
		query := "INSERT INTO CrawlStrategyWorkflowRunStep (id, runId, stepKey, sequence, workflowNodeId, nodeType, label, status, startedAt, finishedAt, durationMs, inputCount, outputCount, rejectedCount, sampleUrls, metrics, error, metadata, createdAt, updatedAt) VALUES " + strings.Join(placeholders, ", ")
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) replaceRunEvents(ctx context.Context, tx *sql.Tx, runID string, events []StrategyRunEvent) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", runID); err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(events))
	args := make([]any, 0, len(events)*14)
	for index, event := range events {
		id, err := newRowID()
		if err != nil {
			return err
		}
		placeholders = append(placeholders, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		args = append(args, id, runID, index+1, event.Level, event.EventType,
			nullableStringValue(event.NodeID), nullableStringValue(event.NodeType), event.Message,
			nullableStringValue(event.TriggerReason), nullableIntValue(event.BeforeCount), nullableIntValue(event.AfterCount),
			nullableIntValue(event.RescuedCount), []byte(jsonDefault(event.Details, `{}`)), eventTime(event.Timestamp))
	}
	query := "INSERT INTO CrawlStrategyWorkflowRunEvent (id, runId, sequence, level, eventType, nodeId, nodeType, message, triggerReason, beforeCount, afterCount, rescuedCount, details, createdAt) VALUES " + strings.Join(placeholders, ", ")
	_, err := tx.ExecContext(ctx, query, args...)
	return err
}

func (s *Service) replaceRunCandidates(ctx context.Context, tx *sql.Tx, runID string, candidates []StrategyRunCandidate) error {
	if _, err := tx.ExecContext(ctx, `
DELETE t FROM CrawlStrategyWorkflowRunCandidateTrace t
JOIN CrawlStrategyWorkflowRunCandidate c ON t.candidateId = c.id
WHERE c.runId = ?`, runID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ?", runID); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}

	type candidateRow struct {
		id               string
		candidateKey     string
		externalID       string
		sourceNodeID     any
		sourceNodeType   any
		url              string
		title            any
		description      any
		author           any
		pageType         any
		relevanceScore   any
		score            any
		freshnessScore   any
		qualityScore     any
		publishedAt      any
		crawledAt        any
		effectiveAt      any
		status           string
		rejectedByNodeID any
		rejectedReason   any
		metadata         []byte
		traceCount       int
	}
	rows := make([]candidateRow, 0, len(candidates))
	traceArgs := make([]any, 0, len(candidates)*8)
	tracePlaceholders := []string{}
	for _, candidate := range candidates {
		id, err := newRowID()
		if err != nil {
			return err
		}
		sourceNodeType := any(nil)
		if len(candidate.Trace) > 0 {
			sourceNodeType = candidate.Trace[0].NodeType
		}
		rows = append(rows, candidateRow{
			id:               id,
			candidateKey:     candidateKey(candidate),
			externalID:       candidate.ID,
			sourceNodeID:     nullableStringValue(stringPointerOrNil(candidate.SourceNodeID)),
			sourceNodeType:   sourceNodeType,
			url:              candidate.URL,
			title:            nullableStringValue(candidate.Title),
			description:      nullableStringValue(candidate.Description),
			author:           nullableStringValue(candidate.Author),
			pageType:         nullableStringValue(candidate.PageType),
			relevanceScore:   finiteOrNull(candidate.RelevanceScore),
			score:            finiteOrNull(candidate.Score),
			freshnessScore:   finiteOrNull(candidate.FreshnessScore),
			qualityScore:     finiteOrNull(candidate.QualityScore),
			publishedAt:      dateOrNull(candidate.PublishedAt),
			crawledAt:        dateOrNull(candidate.CrawledAt),
			effectiveAt:      dateOrNull(candidate.EffectiveAt),
			status:           candidate.Status,
			rejectedByNodeID: nullableStringValue(candidate.RejectedByNodeID),
			rejectedReason:   nullableStringValue(candidate.RejectedReason),
			metadata:         []byte(jsonDefault(candidate.Metadata, `{}`)),
			traceCount:       len(candidate.Trace),
		})
		for index, trace := range candidate.Trace {
			traceID, err := newRowID()
			if err != nil {
				return err
			}
			tracePlaceholders = append(tracePlaceholders, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			traceArgs = append(traceArgs, traceID, id, index+1, eventTime(trace.Timestamp), trace.NodeID, trace.NodeType,
				trace.Action, trace.Message, nullableBoolValue(trace.Accepted), finiteOrNull(trace.ScoreDelta),
				finiteOrNull(trace.FreshnessDelta), []byte(jsonDefault(marshalStringList(trace.RuleHits), `[]`)),
				[]byte(jsonDefault(trace.BeforeSnapshot, `{}`)), []byte(jsonDefault(trace.AfterSnapshot, `{}`)),
				[]byte(traceDetails(trace)))
		}
	}

	for start := 0; start < len(rows); start += strategyInsertBatchSize {
		end := start + strategyInsertBatchSize
		if end > len(rows) {
			end = len(rows)
		}
		batch := rows[start:end]
		placeholders := make([]string, 0, len(batch))
		args := make([]any, 0, len(batch)*24)
		for _, item := range batch {
			placeholders = append(placeholders, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))")
			args = append(args, item.id, runID, item.candidateKey, item.externalID, item.sourceNodeID, item.sourceNodeType,
				item.url, item.title, item.description, item.author, item.pageType, item.relevanceScore, item.score,
				item.freshnessScore, item.qualityScore, item.publishedAt, item.crawledAt, item.effectiveAt,
				item.status, item.rejectedByNodeID, item.rejectedReason, item.metadata, item.traceCount)
		}
		query := "INSERT INTO CrawlStrategyWorkflowRunCandidate (id, runId, candidateKey, externalId, sourceNodeId, sourceNodeType, url, title, description, author, pageType, relevanceScore, score, freshnessScore, qualityScore, publishedAt, crawledAt, effectiveAt, status, rejectedByNodeId, rejectedReason, metadata, traceCount, createdAt, updatedAt) VALUES " + strings.Join(placeholders, ", ")
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return err
		}
	}
	for start := 0; start < len(tracePlaceholders); start += strategyInsertBatchSize {
		end := start + strategyInsertBatchSize
		if end > len(tracePlaceholders) {
			end = len(tracePlaceholders)
		}
		query := "INSERT INTO CrawlStrategyWorkflowRunCandidateTrace (id, candidateId, sequence, timestamp, nodeId, nodeType, action, message, accepted, scoreDelta, freshnessDelta, ruleHits, beforeSnapshot, afterSnapshot, details) VALUES " + strings.Join(tracePlaceholders[start:end], ", ")
		if _, err := tx.ExecContext(ctx, query, traceArgs[start*15:end*15]...); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// value mapping (buildCandidateCreateData / buildTraceCreateManyData)

func candidateKey(candidate StrategyRunCandidate) string {
	if len(candidate.Metadata) > 0 {
		var record map[string]json.RawMessage
		if err := json.Unmarshal(candidate.Metadata, &record); err == nil {
			if raw, ok := record["candidateKey"]; ok {
				var value string
				if err := json.Unmarshal(raw, &value); err == nil {
					trimmed := strings.TrimSpace(value)
					if trimmed != "" {
						return truncateRunes(trimmed, 191)
					}
				}
			}
		}
	}
	sum := sha256.Sum256([]byte(candidate.URL))
	return hex.EncodeToString(sum[:])
}

func traceDetails(trace StrategyRunTrace) json.RawMessage {
	merged := map[string]json.RawMessage{}
	if len(trace.Details) > 0 {
		var record map[string]json.RawMessage
		if err := json.Unmarshal(trace.Details, &record); err == nil {
			merged = record
		}
	}
	if trace.RejectedReason != nil && strings.TrimSpace(*trace.RejectedReason) != "" {
		encoded, err := json.Marshal(*trace.RejectedReason)
		if err == nil {
			merged["rejectedReason"] = encoded
		}
	}
	if len(merged) == 0 {
		return json.RawMessage(`{}`)
	}
	encoded, err := json.Marshal(merged)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func finiteOrNull(value *float64) any {
	if value == nil {
		return nil
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	return *value
}

func dateOrNull(value *string) any {
	if value == nil {
		return nil
	}
	parsed, ok := parseISOTime(*value)
	if !ok {
		return nil
	}
	return parsed
}

func parseISOTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

func eventTime(value string) any {
	parsed, ok := parseISOTime(value)
	if !ok {
		return time.Now().UTC()
	}
	return parsed
}

func nullableStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableIntValue(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableBoolValue(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTimeValue(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC()
}

func stringPointerOrNil(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func jsonDefault(raw json.RawMessage, fallback string) json.RawMessage {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "" || string(raw) == "null" {
		return json.RawMessage(fallback)
	}
	return raw
}

func marshalSteps(steps []StrategyRunStep) json.RawMessage {
	if steps == nil {
		return nil
	}
	encoded, err := json.Marshal(steps)
	if err != nil {
		return nil
	}
	return encoded
}

func marshalCandidates(candidates []StrategyRunCandidate) json.RawMessage {
	if candidates == nil {
		return nil
	}
	encoded, err := json.Marshal(candidates)
	if err != nil {
		return nil
	}
	return encoded
}

func marshalStringList(values []string) json.RawMessage {
	if values == nil {
		values = []string{}
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return nil
	}
	return encoded
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
