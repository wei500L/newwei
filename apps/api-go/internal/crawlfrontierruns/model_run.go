package crawlfrontierruns

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"time"
)

// RunStatus is the CrawlFrontierRunStatus enum.
type RunStatus string

const (
	RunStatusPending   RunStatus = "pending"
	RunStatusQueued    RunStatus = "queued"
	RunStatusRunning   RunStatus = "running"
	RunStatusCompleted RunStatus = "completed"
	RunStatusFailed    RunStatus = "failed"
	RunStatusCanceled  RunStatus = "canceled"
)

// NodeStatus is the CrawlFrontierNodeStatus enum.
type NodeStatus string

const (
	NodeStatusPending   NodeStatus = "pending"
	NodeStatusQueued    NodeStatus = "queued"
	NodeStatusRunning   NodeStatus = "running"
	NodeStatusCompleted NodeStatus = "completed"
	NodeStatusFailed    NodeStatus = "failed"
	NodeStatusSkipped   NodeStatus = "skipped"
	NodeStatusCanceled  NodeStatus = "canceled"
)

// ExecutionMode is the CrawlSiteExecutionMode enum.
type ExecutionMode string

const (
	ExecutionModeLayered ExecutionMode = "layered"
	ExecutionModeNative  ExecutionMode = "native"
	ExecutionModeHybrid  ExecutionMode = "hybrid"
)

// PageType is the CrawlFrontierPageType enum.
type PageType string

const (
	PageTypeHome     PageType = "home"
	PageTypeCategory PageType = "category"
	PageTypeList     PageType = "list"
	PageTypeArticle  PageType = "article"
)

// QueueClass is the CrawlQueueClass enum.
type QueueClass string

const (
	QueueClassHot    QueueClass = "hot"
	QueueClassNormal QueueClass = "normal"
)

// TraceStepStatus is the status of one admin trace step.
type TraceStepStatus string

const (
	TraceStepStatusCompleted TraceStepStatus = "completed"
	TraceStepStatusWarning   TraceStepStatus = "warning"
	TraceStepStatusActive    TraceStepStatus = "active"
	TraceStepStatusSkipped   TraceStepStatus = "skipped"
)

// nestTime serializes timestamps exactly like JavaScript Date.toISOString()
// (millisecond UTC).
type nestTime time.Time

// MarshalJSON writes the millisecond UTC ISO string used by NestJS.
func (t *nestTime) MarshalJSON() ([]byte, error) {
	if t == nil {
		return []byte("null"), nil
	}
	return json.Marshal(time.Time(*t).UTC().Format("2006-01-02T15:04:05.000Z"))
}

// nestFromTime wraps a non-null timestamp.
func nestFromTime(value time.Time) *nestTime {
	out := nestTime(value)
	return &out
}

// nestFromNullTime converts a nullable SQL timestamp; NULL becomes nil so the
// field serializes as JSON null.
func nestFromNullTime(value sql.NullTime) *nestTime {
	if !value.Valid {
		return nil
	}
	return nestFromTime(value.Time)
}

// runFields is the CrawlFrontierRun column projection in Prisma schema order.
// It is embedded in the list item and the detail response so both keep the
// same leading key order.
type runFields struct {
	ID             string        `json:"id"`
	OrgID          string        `json:"orgId"`
	ProfileID      *string       `json:"profileId"`
	WorkflowRunID  *string       `json:"workflowRunId"`
	SeedURL        string        `json:"seedUrl"`
	CrawlTaskID    *string       `json:"crawlTaskId"`
	ExecutionMode  ExecutionMode `json:"executionMode"`
	Status         RunStatus     `json:"status"`
	MaxDepth       int           `json:"maxDepth"`
	MaxPages       int           `json:"maxPages"`
	Keywords       RawJSON       `json:"keywords"`
	PageCount      int           `json:"pageCount"`
	NodeCount      int           `json:"nodeCount"`
	ArticleCount   int           `json:"articleCount"`
	FailedCount    int           `json:"failedCount"`
	DuplicateCount int           `json:"duplicateCount"`
	NativeRunID    *string       `json:"nativeRunId"`
	LastError      *string       `json:"lastError"`
	Metadata       RawJSON       `json:"metadata"`
	CreatedByID    string        `json:"createdById"`
	StartedAt      *nestTime     `json:"startedAt"`
	FinishedAt     *nestTime     `json:"finishedAt"`
	CreatedAt      *nestTime     `json:"createdAt"`
	UpdatedAt      *nestTime     `json:"updatedAt"`
}

// runProfileSummary is the profile projection used by the list response
// (Prisma select: id, name, matchHost, executionMode, version).
type runProfileSummary struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	MatchHost     string        `json:"matchHost"`
	ExecutionMode ExecutionMode `json:"executionMode"`
	Version       int           `json:"version"`
}

// runListItem is one row of GET /runs: the run columns followed by profile.
type runListItem struct {
	runFields
	Profile *runProfileSummary `json:"profile"`
}

// isDocument marks runListItem as a JSON payload.
func (runListItem) isDocument() {}

// runListDocument is the array returned by GET /runs.
type runListDocument []runListItem

// isDocument marks runListDocument as a JSON payload.
func (runListDocument) isDocument() {}

// profileRecord is the full CrawlSiteProfile row in Prisma schema order. Its
// config is replaced with the normalized configuration JSON.
type profileRecord struct {
	ID                  string        `json:"id"`
	OrgID               string        `json:"orgId"`
	Name                string        `json:"name"`
	Description         *string       `json:"description"`
	MatchHost           string        `json:"matchHost"`
	IsActive            bool          `json:"isActive"`
	ExecutionMode       ExecutionMode `json:"executionMode"`
	WorkflowID          *string       `json:"workflowId"`
	WorkflowVersionID   *string       `json:"workflowVersionId"`
	WorkflowBindingMode string        `json:"workflowBindingMode"`
	Version             int           `json:"version"`
	Config              RawJSON       `json:"config"`
	CreatedByID         string        `json:"createdById"`
	UpdatedByID         *string       `json:"updatedById"`
	PublishedAt         *nestTime     `json:"publishedAt"`
	CreatedAt           *nestTime     `json:"createdAt"`
	UpdatedAt           *nestTime     `json:"updatedAt"`
}

// runDetail is GET /runs/:id: run columns, profile, nodes and admin summary.
type runDetail struct {
	runFields
	Profile *profileRecord `json:"profile"`
	Nodes   []nodeRecord   `json:"nodes"`
	Summary runSummary     `json:"summary"`
}

// isDocument marks runDetail as a JSON payload.
func (runDetail) isDocument() {}

// bulkCancelResult is POST /runs/cancel: the ids that actually changed state,
// ordered ascending, and their count.
type bulkCancelResult struct {
	CanceledIDs   []string `json:"canceledIds"`
	CanceledCount int      `json:"canceledCount"`
}

// isDocument marks bulkCancelResult as a JSON payload.
func (bulkCancelResult) isDocument() {}

// runColumns is the CrawlFrontierRun projection in Prisma schema order.
const runColumns = "id, orgId, profileId, workflowRunId, seedUrl, crawlTaskId, executionMode, status, maxDepth, maxPages, keywords, pageCount, nodeCount, articleCount, failedCount, duplicateCount, nativeRunId, lastError, metadata, createdById, startedAt, finishedAt, createdAt, updatedAt"

// scanRunFields scans one run row. The caller owns the *sql.Rows cursor.
func scanRunFields(rows *sql.Rows) (runFields, error) {
	var fields runFields
	var profileID, workflowRunID, crawlTaskID, nativeRunID, lastError sql.NullString
	var keywords, metadata []byte
	var startedAt, finishedAt sql.NullTime
	var createdAt, updatedAt time.Time
	err := rows.Scan(
		&fields.ID, &fields.OrgID, &profileID, &workflowRunID, &fields.SeedURL, &crawlTaskID,
		&fields.ExecutionMode, &fields.Status, &fields.MaxDepth, &fields.MaxPages, &keywords,
		&fields.PageCount, &fields.NodeCount, &fields.ArticleCount, &fields.FailedCount,
		&fields.DuplicateCount, &nativeRunID, &lastError, &metadata, &fields.CreatedByID,
		&startedAt, &finishedAt, &createdAt, &updatedAt,
	)
	if err != nil {
		return runFields{}, err
	}
	fields.ProfileID = nullStringPtr(profileID)
	fields.WorkflowRunID = nullStringPtr(workflowRunID)
	fields.CrawlTaskID = nullStringPtr(crawlTaskID)
	fields.NativeRunID = nullStringPtr(nativeRunID)
	fields.LastError = nullStringPtr(lastError)
	fields.Keywords = rawOrNil(keywords)
	fields.Metadata = objectJSONOrNull(metadata)
	fields.StartedAt = nestFromNullTime(startedAt)
	fields.FinishedAt = nestFromNullTime(finishedAt)
	fields.CreatedAt = nestFromTime(createdAt)
	fields.UpdatedAt = nestFromTime(updatedAt)
	return fields, nil
}

// rawOrNil keeps a schema-less JSON column verbatim and maps SQL NULL to nil.
func rawOrNil(raw []byte) RawJSON {
	if raw == nil {
		return nil
	}
	return RawJSON(raw)
}

// nullStringPtr converts a nullable text column to a JSON null/string pointer.
func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

// newRowID builds a cuid-shaped identifier (c + 24 hex characters), matching
// the ids written by the other Go migrations and by Prisma cuid().
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}
