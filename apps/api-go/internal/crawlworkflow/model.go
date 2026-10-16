package crawlworkflow

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// nestTime 是 new Date().toISOString() 等价格式（毫秒 UTC）。
// NestJS 的 Prisma DateTime 经 JSON.stringify 输出该格式；Go 的
// time.Time 默认 RFC3339Nano 小数位不同，必须显式转换。
type nestTime time.Time

func (t *nestTime) MarshalJSON() ([]byte, error) {
	if t == nil {
		return []byte("null"), nil
	}
	return json.Marshal(time.Time(*t).UTC().Format("2006-01-02T15:04:05.000Z"))
}

func nestFromTime(value time.Time) *nestTime {
	out := nestTime(value)
	return &out
}

// workflowRow 是 CrawlStrategyWorkflow 的一行（列名与 Prisma 模型一致）。
type workflowRow struct {
	ID                 string
	OrgID              string
	Name               string
	Description        sql.NullString
	DraftDefinition    []byte
	PublishedVersionID sql.NullString
	CreatedByID        string
	UpdatedByID        sql.NullString
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

const workflowSelect = "id, orgId, name, description, draftDefinition, publishedVersionId, createdById, updatedById, createdAt, updatedAt"

var errWorkflowMissing = newStatus(404, "Workflow not found")

func scanWorkflow(row interface{ Scan(dest ...any) error }) (workflowRow, error) {
	var out workflowRow
	err := row.Scan(
		&out.ID, &out.OrgID, &out.Name, &out.Description, &out.DraftDefinition,
		&out.PublishedVersionID, &out.CreatedByID, &out.UpdatedByID, &out.CreatedAt, &out.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return workflowRow{}, errWorkflowMissing
	}
	if err != nil {
		return workflowRow{}, err
	}
	return out, nil
}

// versionRow 是 CrawlStrategyWorkflowVersion 的一行。
type versionRow struct {
	ID          string
	WorkflowID  string
	OrgID       string
	Version     int
	Name        string
	Description sql.NullString
	Definition  []byte
	CreatedByID string
	CreatedAt   time.Time
}

const versionSelect = "id, workflowId, orgId, version, name, description, definition, createdById, createdAt"

var errVersionMissing = newStatus(404, "Workflow version not found")

func scanVersion(row interface{ Scan(dest ...any) error }) (versionRow, error) {
	var out versionRow
	err := row.Scan(
		&out.ID, &out.WorkflowID, &out.OrgID, &out.Version, &out.Name,
		&out.Description, &out.Definition, &out.CreatedByID, &out.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return versionRow{}, errVersionMissing
	}
	if err != nil {
		return versionRow{}, err
	}
	return out, nil
}

// workflowDocument 是 mapWorkflow 的响应形状。字段名与 NestJS 完全一致；
// description/publishedVersionId/updatedById 为 null 时保留 null 字段，
// publishedVersion 为 null 时同样保留。
type workflowDocument struct {
	ID                 string             `json:"id"`
	OrgID              string             `json:"orgId"`
	Name               string             `json:"name"`
	Description        *string            `json:"description"`
	DraftDefinition    WorkflowDefinition `json:"draftDefinition"`
	PublishedVersionID *string            `json:"publishedVersionId"`
	PublishedVersion   *versionDocument   `json:"publishedVersion"`
	Versions           []versionDocument  `json:"versions"`
	CreatedByID        string             `json:"createdById"`
	UpdatedByID        *string            `json:"updatedById"`
	CreatedAt          *nestTime          `json:"createdAt"`
	UpdatedAt          *nestTime          `json:"updatedAt"`
}

// versionDocument 是 mapWorkflowVersion 的响应形状。
type versionDocument struct {
	ID          string             `json:"id"`
	WorkflowID  string             `json:"workflowId"`
	OrgID       string             `json:"orgId"`
	Version     int                `json:"version"`
	Name        string             `json:"name"`
	Description *string            `json:"description"`
	Definition  WorkflowDefinition `json:"definition"`
	CreatedByID string             `json:"createdById"`
	CreatedAt   *nestTime          `json:"createdAt"`
}

func mapWorkflowVersion(row versionRow) versionDocument {
	return versionDocument{
		ID:          row.ID,
		WorkflowID:  row.WorkflowID,
		OrgID:       row.OrgID,
		Version:     row.Version,
		Name:        row.Name,
		Description: nullString(row.Description),
		Definition:  normalizeDefinition(row.Definition),
		CreatedByID: row.CreatedByID,
		CreatedAt:   nestFromTime(row.CreatedAt),
	}
}

func mapWorkflowVersions(rows []versionRow) []versionDocument {
	out := make([]versionDocument, 0, len(rows))
	for _, row := range rows {
		out = append(out, mapWorkflowVersion(row))
	}
	return out
}

// mapWorkflow 组装 mapWorkflow 的对象（publishedVersion 为 null 时保留 null；
// versions 始终是数组）。
func mapWorkflow(row workflowRow, published *versionRow, versions []versionRow) workflowDocument {
	var publishedVersion *versionDocument
	if published != nil {
		mapped := mapWorkflowVersion(*published)
		publishedVersion = &mapped
	}
	return workflowDocument{
		ID:                 row.ID,
		OrgID:              row.OrgID,
		Name:               row.Name,
		Description:        nullString(row.Description),
		DraftDefinition:    normalizeDefinition(row.DraftDefinition),
		PublishedVersionID: nullString(row.PublishedVersionID),
		PublishedVersion:   publishedVersion,
		Versions:           mapWorkflowVersions(versions),
		CreatedByID:        row.CreatedByID,
		UpdatedByID:        nullString(row.UpdatedByID),
		CreatedAt:          nestFromTime(row.CreatedAt),
		UpdatedAt:          nestFromTime(row.UpdatedAt),
	}
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
