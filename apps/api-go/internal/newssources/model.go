package newssources

import (
	"database/sql"
	"encoding/json"
	"time"
)

type nestTime time.Time

func (t *nestTime) MarshalJSON() ([]byte, error) {
	if t == nil {
		return []byte("null"), nil
	}
	return json.Marshal(time.Time(*t).UTC().Format("2006-01-02T15:04:05.000Z"))
}

func nestFromNull(value sql.NullTime) *nestTime {
	if !value.Valid {
		return nil
	}
	out := nestTime(value.Time)
	return &out
}

func nestFromTime(value time.Time) *nestTime {
	out := nestTime(value)
	return &out
}

type sourceRow struct {
	ID                  string
	OrgID               string
	Name                string
	URL                 string
	SiteType            string
	Language            sql.NullString
	CrawlTemplateID     sql.NullString
	WorkflowID          sql.NullString
	WorkflowVersionID   sql.NullString
	WorkflowBindingMode string
	FrequencySeconds    int
	Priority            int
	IsActive            bool
	Config              []byte
	Group               sql.NullString
	LastRunAt           sql.NullTime
	LastSuccessAt       sql.NullTime
	LastFailureAt       sql.NullTime
	ConsecutiveFailures int
	CircuitOpenUntil    sql.NullTime
	NextRunAt           sql.NullTime
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

func (row sourceRow) marshalFull() sourceDocument {
	return sourceDocument{
		ID:                  row.ID,
		OrgID:               row.OrgID,
		Name:                row.Name,
		URL:                 row.URL,
		SiteType:            row.SiteType,
		Language:            nullString(row.Language),
		CrawlTemplateID:     nullString(row.CrawlTemplateID),
		WorkflowID:          nullString(row.WorkflowID),
		WorkflowVersionID:   nullString(row.WorkflowVersionID),
		WorkflowBindingMode: row.WorkflowBindingMode,
		FrequencySeconds:    row.FrequencySeconds,
		Priority:            row.Priority,
		IsActive:            row.IsActive,
		Config:              nullJSON(row.Config),
		Group:               nullString(row.Group),
		LastRunAt:           nestFromNull(row.LastRunAt),
		LastSuccessAt:       nestFromNull(row.LastSuccessAt),
		LastFailureAt:       nestFromNull(row.LastFailureAt),
		ConsecutiveFailures: row.ConsecutiveFailures,
		CircuitOpenUntil:    nestFromNull(row.CircuitOpenUntil),
		NextRunAt:           nestFromNull(row.NextRunAt),
		CreatedAt:           nestFromTime(row.CreatedAt),
		UpdatedAt:           nestFromTime(row.UpdatedAt),
	}
}

type sourceDocument struct {
	ID                  string          `json:"id"`
	OrgID               string          `json:"orgId"`
	Name                string          `json:"name"`
	URL                 string          `json:"url"`
	SiteType            string          `json:"siteType"`
	Language            *string         `json:"language"`
	CrawlTemplateID     *string         `json:"crawlTemplateId"`
	WorkflowID          *string         `json:"workflowId"`
	WorkflowVersionID   *string         `json:"workflowVersionId"`
	WorkflowBindingMode string          `json:"workflowBindingMode"`
	FrequencySeconds    int             `json:"frequencySeconds"`
	Priority            int             `json:"priority"`
	IsActive            bool            `json:"isActive"`
	Config              json.RawMessage `json:"config"`
	Group               *string         `json:"group"`
	LastRunAt           *nestTime       `json:"lastRunAt"`
	LastSuccessAt       *nestTime       `json:"lastSuccessAt"`
	LastFailureAt       *nestTime       `json:"lastFailureAt"`
	ConsecutiveFailures int             `json:"consecutiveFailures"`
	CircuitOpenUntil    *nestTime       `json:"circuitOpenUntil"`
	NextRunAt           *nestTime       `json:"nextRunAt"`
	CreatedAt           *nestTime       `json:"createdAt"`
	UpdatedAt           *nestTime       `json:"updatedAt"`
}

type listItem struct {
	ID                  string          `json:"id"`
	Name                string          `json:"name"`
	URL                 string          `json:"url"`
	SiteType            string          `json:"siteType"`
	Language            *string         `json:"language"`
	CrawlTemplateID     *string         `json:"crawlTemplateId"`
	WorkflowID          *string         `json:"workflowId"`
	WorkflowVersionID   *string         `json:"workflowVersionId"`
	WorkflowBindingMode string          `json:"workflowBindingMode"`
	Group               *string         `json:"group"`
	FrequencySeconds    int             `json:"frequencySeconds"`
	Priority            int             `json:"priority"`
	IsActive            bool            `json:"isActive"`
	LastRunAt           *nestTime       `json:"lastRunAt"`
	LastSuccessAt       *nestTime       `json:"lastSuccessAt"`
	LastFailureAt       *nestTime       `json:"lastFailureAt"`
	ConsecutiveFailures int             `json:"consecutiveFailures"`
	CircuitOpenUntil    *nestTime       `json:"circuitOpenUntil"`
	NextRunAt           *nestTime       `json:"nextRunAt"`
	Config              json.RawMessage `json:"config"`
	OpsSummary          opsSummary      `json:"opsSummary"`
}

type opsSummary struct {
	LatestJob       json.RawMessage `json:"latestJob"`
	LatestCrawlTask json.RawMessage `json:"latestCrawlTask"`
	LatestArticle   json.RawMessage `json:"latestArticle"`
	Stats24h        stats24h        `json:"stats24h"`
	Runtime         runtimeState    `json:"runtime"`
}

type stats24h struct {
	Completed     int      `json:"completed"`
	Failed        int      `json:"failed"`
	SuccessRate   *float64 `json:"successRate"`
	AvgDurationMs *float64 `json:"avgDurationMs"`
}

type runtimeState struct {
	CrawlTaskQueuedCount    int                       `json:"crawlTaskQueuedCount"`
	CrawlTaskRunningCount   int                       `json:"crawlTaskRunningCount"`
	BackpressureUntil       *string                   `json:"backpressureUntil"`
	BackpressurePendingJobs *int                      `json:"backpressurePendingJobs"`
	BackpressureThreshold   *int                      `json:"backpressureThreshold"`
	BackpressureCount24h    int                       `json:"backpressureCount24h"`
	RssAdaptiveState        *rssAdaptiveRuntimeRecord `json:"rssAdaptiveState"`
}

func emptyOps() opsSummary {
	return opsSummary{
		LatestJob:       json.RawMessage("null"),
		LatestCrawlTask: json.RawMessage("null"),
		LatestArticle:   json.RawMessage("null"),
		Stats24h:        stats24h{},
		Runtime:         runtimeState{},
	}
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func nullJSON(value []byte) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(value)
}

func (row sourceRow) listItem(summary opsSummary) listItem {
	return listItem{
		ID:                  row.ID,
		Name:                row.Name,
		URL:                 row.URL,
		SiteType:            row.SiteType,
		Language:            nullString(row.Language),
		CrawlTemplateID:     nullString(row.CrawlTemplateID),
		WorkflowID:          nullString(row.WorkflowID),
		WorkflowVersionID:   nullString(row.WorkflowVersionID),
		WorkflowBindingMode: row.WorkflowBindingMode,
		Group:               nullString(row.Group),
		FrequencySeconds:    row.FrequencySeconds,
		Priority:            row.Priority,
		IsActive:            row.IsActive,
		LastRunAt:           nestFromNull(row.LastRunAt),
		LastSuccessAt:       nestFromNull(row.LastSuccessAt),
		LastFailureAt:       nestFromNull(row.LastFailureAt),
		ConsecutiveFailures: row.ConsecutiveFailures,
		CircuitOpenUntil:    nestFromNull(row.CircuitOpenUntil),
		NextRunAt:           nestFromNull(row.NextRunAt),
		Config:              nullJSON(row.Config),
		OpsSummary:          summary,
	}
}
