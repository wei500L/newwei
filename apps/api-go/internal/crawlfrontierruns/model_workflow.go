package crawlfrontierruns

import (
	"database/sql"
	"encoding/json"
	"time"
)

// workflowRef is the {id, name} workflow subset of a workflow run.
type workflowRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// workflowVersionRef is the {id, version, name} workflow version subset.
type workflowVersionRef struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Name    string `json:"name"`
}

// stepDocument is one stepResults entry of a workflow run.
type stepDocument struct {
	StepKey       string  `json:"stepKey"`
	NodeID        string  `json:"nodeId"`
	NodeType      string  `json:"nodeType"`
	Label         string  `json:"label"`
	Status        string  `json:"status"`
	DurationMS    int     `json:"durationMs"`
	InputCount    int     `json:"inputCount"`
	OutputCount   int     `json:"outputCount"`
	RejectedCount int     `json:"rejectedCount"`
	SampleURLs    RawJSON `json:"sampleUrls"`
	Metrics       RawJSON `json:"metrics,omitempty"`
	Error         *string `json:"error"`
}

// traceDocument is one candidate trace entry.
type traceDocument struct {
	NodeID         string    `json:"nodeId"`
	NodeType       string    `json:"nodeType"`
	Action         string    `json:"action"`
	Message        string    `json:"message"`
	Accepted       *bool     `json:"accepted,omitempty"`
	ScoreDelta     *float64  `json:"scoreDelta,omitempty"`
	FreshnessDelta *float64  `json:"freshnessDelta,omitempty"`
	RuleHits       RawJSON   `json:"ruleHits,omitempty"`
	RejectedReason *string   `json:"rejectedReason,omitempty"`
	BeforeSnapshot RawJSON   `json:"beforeSnapshot,omitempty"`
	AfterSnapshot  RawJSON   `json:"afterSnapshot,omitempty"`
	Details        RawJSON   `json:"details,omitempty"`
	Timestamp      *nestTime `json:"timestamp"`
}

// candidateDocument is one workflow run candidate with its traces.
type candidateDocument struct {
	ID             string          `json:"id"`
	URL            string          `json:"url"`
	Title          *string         `json:"title,omitempty"`
	Description    *string         `json:"description,omitempty"`
	Author         *string         `json:"author,omitempty"`
	PageType       *string         `json:"pageType,omitempty"`
	RelevanceScore *float64        `json:"relevanceScore,omitempty"`
	Score          *float64        `json:"score,omitempty"`
	FreshnessScore *float64        `json:"freshnessScore,omitempty"`
	QualityScore   *float64        `json:"qualityScore,omitempty"`
	PublishedAt    *nestTime       `json:"publishedAt"`
	CrawledAt      *nestTime       `json:"crawledAt"`
	EffectiveAt    *nestTime       `json:"effectiveAt"`
	Status         string          `json:"status"`
	RejectedByNode *string         `json:"rejectedByNodeId"`
	RejectedReason *string         `json:"rejectedReason"`
	SourceNodeID   string          `json:"sourceNodeId"`
	Metadata       RawJSON         `json:"metadata"`
	Trace          []traceDocument `json:"trace"`
}

// isDocument marks candidateDocument as a JSON payload (GET explanation).
func (candidateDocument) isDocument() {}

// workflowCandidatesDocument is the candidates array (GET candidates routes).
type workflowCandidatesDocument []candidateDocument

// isDocument marks workflowCandidatesDocument as a JSON payload.
func (workflowCandidatesDocument) isDocument() {}

// eventDocument is one systemEvents entry of a workflow run.
type eventDocument struct {
	ID            string    `json:"id"`
	Sequence      int       `json:"sequence"`
	Level         string    `json:"level"`
	EventType     string    `json:"eventType"`
	NodeID        *string   `json:"nodeId"`
	NodeType      *string   `json:"nodeType"`
	Message       string    `json:"message"`
	TriggerReason *string   `json:"triggerReason"`
	BeforeCount   *int      `json:"beforeCount"`
	AfterCount    *int      `json:"afterCount"`
	RescuedCount  *int      `json:"rescuedCount"`
	Details       RawJSON   `json:"details,omitempty"`
	Timestamp     *nestTime `json:"timestamp"`
}

// workflowRunDocument is the mapRun response shape of a CrawlStrategyWorkflowRun.
type workflowRunDocument struct {
	ID               string              `json:"id"`
	OrgID            string              `json:"orgId"`
	WorkflowOrigin   string              `json:"workflowOrigin"`
	Workflow         *workflowRef        `json:"workflow"`
	WorkflowVersion  *workflowVersionRef `json:"workflowVersion"`
	FrontierRunID    *string             `json:"frontierRunId"`
	Status           string              `json:"status"`
	RunKind          string              `json:"runKind"`
	Input            RawJSON             `json:"input"`
	Output           RawJSON             `json:"output"`
	GraphSnapshot    RawJSON             `json:"graphSnapshot"`
	StepResults      []stepDocument      `json:"stepResults"`
	Candidates       []candidateDocument `json:"candidates"`
	ParameterSources RawJSON             `json:"parameterSources"`
	SystemEvents     []eventDocument     `json:"systemEvents"`
	StepCount        int                 `json:"stepCount"`
	CandidateCount   int                 `json:"candidateCount"`
	SelectedCount    int                 `json:"selectedCount"`
	Error            *string             `json:"error"`
	StartedAt        *nestTime           `json:"startedAt"`
	FinishedAt       *nestTime           `json:"finishedAt"`
	CreatedAt        *nestTime           `json:"createdAt"`
	UpdatedAt        *nestTime           `json:"updatedAt"`
}

// isDocument marks workflowRunDocument as a JSON payload.
func (workflowRunDocument) isDocument() {}

// workflowRunRow is the scalar projection of CrawlStrategyWorkflowRun used to
// build the response document.
type workflowRunRow struct {
	ID                string
	OrgID             string
	WorkflowID        sql.NullString
	WorkflowVersionID sql.NullString
	WorkflowOrigin    string
	Status            string
	RunKind           string
	Input             []byte
	Output            []byte
	GraphSnapshot     []byte
	ParameterSources  []byte
	Error             sql.NullString
	StepCount         int
	CandidateCount    int
	SelectedCount     int
	StartedAt         sql.NullTime
	FinishedAt        sql.NullTime
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// scanWorkflowRunRow scans the scalar workflow run projection.
func scanWorkflowRunRow(rows *sql.Rows) (workflowRunRow, error) {
	var row workflowRunRow
	err := rows.Scan(
		&row.ID, &row.OrgID, &row.WorkflowID, &row.WorkflowVersionID, &row.WorkflowOrigin,
		&row.Status, &row.RunKind, &row.Input, &row.Output, &row.GraphSnapshot,
		&row.ParameterSources, &row.Error, &row.StepCount, &row.CandidateCount,
		&row.SelectedCount, &row.StartedAt, &row.FinishedAt, &row.CreatedAt, &row.UpdatedAt,
	)
	if err != nil {
		return workflowRunRow{}, err
	}
	return row, nil
}

// scanStepDocument scans one workflow run step.
func scanStepDocument(rows *sql.Rows) (stepDocument, error) {
	var document stepDocument
	var workflowNodeID, stepError sql.NullString
	var durationMS sql.NullInt64
	var sampleURLs, metrics []byte
	err := rows.Scan(
		&document.StepKey, &workflowNodeID, &document.NodeType, &document.Label,
		&document.Status, &durationMS, &document.InputCount, &document.OutputCount,
		&document.RejectedCount, &sampleURLs, &metrics, &stepError,
	)
	if err != nil {
		return stepDocument{}, err
	}
	document.NodeID = document.StepKey
	if workflowNodeID.Valid {
		document.NodeID = workflowNodeID.String
	}
	if durationMS.Valid {
		document.DurationMS = int(durationMS.Int64)
	}
	document.SampleURLs = arrayJSONOrEmpty(sampleURLs)
	document.Metrics = objectJSONOrNull(metrics)
	document.Error = nullStringPtr(stepError)
	return document, nil
}

// scanCandidateDocument scans one workflow run candidate (traces are loaded
// separately and attached by database row id). The first result is the raw row
// id, which differs from the response id when externalId is set.
func scanCandidateDocument(rows *sql.Rows) (string, candidateDocument, error) {
	var document candidateDocument
	var rowID, externalID, title, description, author, pageType sql.NullString
	var relevanceScore, score, freshnessScore, qualityScore sql.NullFloat64
	var publishedAt, crawledAt, effectiveAt sql.NullTime
	var rejectedByNodeID, rejectedReason, sourceNodeID sql.NullString
	var metadata []byte
	err := rows.Scan(
		&rowID, &externalID, &document.URL, &title, &description, &author, &pageType,
		&relevanceScore, &score, &freshnessScore, &qualityScore, &publishedAt, &crawledAt,
		&effectiveAt, &document.Status, &rejectedByNodeID, &rejectedReason, &sourceNodeID, &metadata,
	)
	if err != nil {
		return "", candidateDocument{}, err
	}
	// id: externalId ?? id — only SQL NULL falls back, an empty string is kept.
	document.ID = rowID.String
	if externalID.Valid {
		document.ID = externalID.String
	}
	document.Title = nullStringPtr(title)
	document.Description = nullStringPtr(description)
	document.Author = nullStringPtr(author)
	document.PageType = nullStringPtr(pageType)
	document.RelevanceScore = nullFloatPtr(relevanceScore)
	document.Score = nullFloatPtr(score)
	document.FreshnessScore = nullFloatPtr(freshnessScore)
	document.QualityScore = nullFloatPtr(qualityScore)
	document.PublishedAt = nestFromNullTime(publishedAt)
	document.CrawledAt = nestFromNullTime(crawledAt)
	document.EffectiveAt = nestFromNullTime(effectiveAt)
	document.RejectedByNode = nullStringPtr(rejectedByNodeID)
	document.RejectedReason = nullStringPtr(rejectedReason)
	document.SourceNodeID = "unknown"
	if sourceNodeID.Valid {
		document.SourceNodeID = sourceNodeID.String
	}
	document.Metadata = objectJSONOrEmpty(metadata)
	document.Trace = make([]traceDocument, 0)
	return rowID.String, document, nil
}

// traceDetailsView reads the rejectedReason out of a trace details object.
type traceDetailsView struct {
	RejectedReason jsonString `json:"rejectedReason"`
}

// scanTraceDocument scans one candidate trace. candidateID is the owning
// candidate key used to group traces.
func scanTraceDocument(rows *sql.Rows) (string, traceDocument, error) {
	var candidateID string
	var document traceDocument
	var accepted sql.NullInt64
	var scoreDelta, freshnessDelta sql.NullFloat64
	var ruleHits, beforeSnapshot, afterSnapshot, details []byte
	var timestamp time.Time
	err := rows.Scan(
		&candidateID, &document.NodeID, &document.NodeType, &document.Action, &document.Message,
		&accepted, &scoreDelta, &freshnessDelta, &ruleHits, &beforeSnapshot, &afterSnapshot,
		&details, &timestamp,
	)
	if err != nil {
		return "", traceDocument{}, err
	}
	if accepted.Valid {
		value := accepted.Int64 != 0
		document.Accepted = &value
	}
	document.ScoreDelta = nullFloatPtr(scoreDelta)
	document.FreshnessDelta = nullFloatPtr(freshnessDelta)
	document.RuleHits = arrayJSONOrNil(ruleHits)
	document.BeforeSnapshot = objectJSONOrNull(beforeSnapshot)
	document.AfterSnapshot = objectJSONOrNull(afterSnapshot)
	document.Details = objectJSONOrNull(details)
	if rawIsObject(details) {
		var view traceDetailsView
		if json.Unmarshal(details, &view) == nil && view.RejectedReason.OK {
			reason := view.RejectedReason.Value
			document.RejectedReason = &reason
		}
	}
	document.Timestamp = nestFromTime(timestamp)
	return candidateID, document, nil
}

// scanEventDocument scans one workflow run event.
func scanEventDocument(rows *sql.Rows) (eventDocument, error) {
	var document eventDocument
	var nodeID, nodeType, triggerReason sql.NullString
	var beforeCount, afterCount, rescuedCount sql.NullInt64
	var details []byte
	var createdAt time.Time
	err := rows.Scan(
		&document.ID, &document.Sequence, &document.Level, &document.EventType, &nodeID,
		&nodeType, &document.Message, &triggerReason, &beforeCount, &afterCount,
		&rescuedCount, &details, &createdAt,
	)
	if err != nil {
		return eventDocument{}, err
	}
	document.NodeID = nullStringPtr(nodeID)
	document.NodeType = nullStringPtr(nodeType)
	document.TriggerReason = nullStringPtr(triggerReason)
	document.BeforeCount = nullIntPtr(beforeCount)
	document.AfterCount = nullIntPtr(afterCount)
	document.RescuedCount = nullIntPtr(rescuedCount)
	document.Details = objectJSONOrNull(details)
	document.Timestamp = nestFromTime(createdAt)
	return document, nil
}

// nullIntPtr converts a nullable integer column to a JSON null/number pointer.
func nullIntPtr(value sql.NullInt64) *int {
	if !value.Valid {
		return nil
	}
	out := int(value.Int64)
	return &out
}
