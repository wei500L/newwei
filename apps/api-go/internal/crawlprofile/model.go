package crawlprofile

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

func nestFromNullTime(value sql.NullTime) *nestTime {
	if !value.Valid {
		return nil
	}
	return nestFromTime(value.Time)
}

// profileRow 是 CrawlSiteProfile 的一行（列名与 Prisma 模型一致）。
type profileRow struct {
	ID                  string
	OrgID               string
	Name                string
	Description         sql.NullString
	MatchHost           string
	IsActive            bool
	ExecutionMode       string
	WorkflowID          sql.NullString
	WorkflowVersionID   sql.NullString
	WorkflowBindingMode string
	Version             int
	Config              []byte
	CreatedByID         string
	UpdatedByID         sql.NullString
	PublishedAt         sql.NullTime
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

const profileSelect = "id, orgId, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId, workflowBindingMode, version, config, createdById, updatedById, publishedAt, createdAt, updatedAt"

var errProfileMissing = newStatus(404, "Crawl site profile not found")

func scanProfile(row interface{ Scan(dest ...any) error }) (profileRow, error) {
	var out profileRow
	var active int
	err := row.Scan(
		&out.ID, &out.OrgID, &out.Name, &out.Description, &out.MatchHost, &active,
		&out.ExecutionMode, &out.WorkflowID, &out.WorkflowVersionID, &out.WorkflowBindingMode,
		&out.Version, &out.Config, &out.CreatedByID, &out.UpdatedByID, &out.PublishedAt,
		&out.CreatedAt, &out.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return profileRow{}, errProfileMissing
	}
	if err != nil {
		return profileRow{}, err
	}
	out.IsActive = active != 0
	return out, nil
}

// versionRow 是 CrawlSiteProfileVersion 的一行。
type versionRow struct {
	ID                  string
	ProfileID           string
	OrgID               string
	Version             int
	Name                string
	Description         sql.NullString
	MatchHost           string
	IsActive            bool
	ExecutionMode       string
	WorkflowID          sql.NullString
	WorkflowVersionID   sql.NullString
	WorkflowBindingMode string
	Config              []byte
	CreatedByID         string
	CreatedAt           time.Time
}

const versionSelect = "id, profileId, orgId, version, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId, workflowBindingMode, config, createdById, createdAt"

var errProfileVersionMissing = newStatus(404, "Crawl site profile version not found")

func scanProfileVersion(row interface{ Scan(dest ...any) error }) (versionRow, error) {
	var out versionRow
	var active int
	err := row.Scan(
		&out.ID, &out.ProfileID, &out.OrgID, &out.Version, &out.Name, &out.Description,
		&out.MatchHost, &active, &out.ExecutionMode, &out.WorkflowID, &out.WorkflowVersionID,
		&out.WorkflowBindingMode, &out.Config, &out.CreatedByID, &out.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return versionRow{}, errProfileVersionMissing
	}
	if err != nil {
		return versionRow{}, err
	}
	out.IsActive = active != 0
	return out, nil
}

// profileDocument 是 mapProfile 的响应形状。字段名与 NestJS 完全一致；
// description/workflowId/workflowVersionId/updatedById/publishedAt 为
// null 时保留 null 字段。config 是归一化后的对象。
type profileDocument struct {
	ID                  string         `json:"id"`
	OrgID               string         `json:"orgId"`
	Name                string         `json:"name"`
	Description         *string        `json:"description"`
	MatchHost           string         `json:"matchHost"`
	IsActive            bool           `json:"isActive"`
	ExecutionMode       string         `json:"executionMode"`
	WorkflowID          *string        `json:"workflowId"`
	WorkflowVersionID   *string        `json:"workflowVersionId"`
	WorkflowBindingMode string         `json:"workflowBindingMode"`
	Version             int            `json:"version"`
	Config              map[string]any `json:"config"`
	CreatedByID         string         `json:"createdById"`
	UpdatedByID         *string        `json:"updatedById"`
	PublishedAt         *nestTime      `json:"publishedAt"`
	CreatedAt           *nestTime      `json:"createdAt"`
	UpdatedAt           *nestTime      `json:"updatedAt"`
}

func mapProfile(row profileRow) (profileDocument, error) {
	config, err := normalizeCrawlSiteProfileConfig(row.Config)
	if err != nil {
		return profileDocument{}, err
	}
	return profileDocument{
		ID:                  row.ID,
		OrgID:               row.OrgID,
		Name:                row.Name,
		Description:         nullString(row.Description),
		MatchHost:           row.MatchHost,
		IsActive:            row.IsActive,
		ExecutionMode:       row.ExecutionMode,
		WorkflowID:          nullString(row.WorkflowID),
		WorkflowVersionID:   nullString(row.WorkflowVersionID),
		WorkflowBindingMode: row.WorkflowBindingMode,
		Version:             row.Version,
		Config:              config,
		CreatedByID:         row.CreatedByID,
		UpdatedByID:         nullString(row.UpdatedByID),
		PublishedAt:         nestFromNullTime(row.PublishedAt),
		CreatedAt:           nestFromTime(row.CreatedAt),
		UpdatedAt:           nestFromTime(row.UpdatedAt),
	}, nil
}

// versionDocument 是 listVersions 的响应形状（Prisma 模型字段原样，
// config 是入库原文，不做归一化——与 NestJS 直接返回 Prisma 行一致）。
type versionDocument struct {
	ID                  string          `json:"id"`
	ProfileID           string          `json:"profileId"`
	OrgID               string          `json:"orgId"`
	Version             int             `json:"version"`
	Name                string          `json:"name"`
	Description         *string         `json:"description"`
	MatchHost           string          `json:"matchHost"`
	IsActive            bool            `json:"isActive"`
	ExecutionMode       string          `json:"executionMode"`
	WorkflowID          *string         `json:"workflowId"`
	WorkflowVersionID   *string         `json:"workflowVersionId"`
	WorkflowBindingMode string          `json:"workflowBindingMode"`
	Config              json.RawMessage `json:"config"`
	CreatedByID         string          `json:"createdById"`
	CreatedAt           *nestTime       `json:"createdAt"`
}

func mapProfileVersion(row versionRow) versionDocument {
	return versionDocument{
		ID:                  row.ID,
		ProfileID:           row.ProfileID,
		OrgID:               row.OrgID,
		Version:             row.Version,
		Name:                row.Name,
		Description:         nullString(row.Description),
		MatchHost:           row.MatchHost,
		IsActive:            row.IsActive,
		ExecutionMode:       row.ExecutionMode,
		WorkflowID:          nullString(row.WorkflowID),
		WorkflowVersionID:   nullString(row.WorkflowVersionID),
		WorkflowBindingMode: row.WorkflowBindingMode,
		Config:              rawOrNull(row.Config),
		CreatedByID:         row.CreatedByID,
		CreatedAt:           nestFromTime(row.CreatedAt),
	}
}

func mapProfileVersions(rows []versionRow) []versionDocument {
	out := make([]versionDocument, 0, len(rows))
	for _, row := range rows {
		out = append(out, mapProfileVersion(row))
	}
	return out
}

// draftDocument 是 preview 的 draft 形状（CrawlSiteProfileRecord，不落库）。
type draftDocument struct {
	ID                  string         `json:"id"`
	OrgID               string         `json:"orgId"`
	Name                string         `json:"name"`
	Description         *string        `json:"description"`
	MatchHost           string         `json:"matchHost"`
	IsActive            bool           `json:"isActive"`
	ExecutionMode       string         `json:"executionMode"`
	WorkflowID          *string        `json:"workflowId"`
	WorkflowVersionID   *string        `json:"workflowVersionId"`
	WorkflowBindingMode string         `json:"workflowBindingMode"`
	Version             int            `json:"version"`
	Config              map[string]any `json:"config"`
	CreatedByID         string         `json:"createdById"`
	UpdatedByID         *string        `json:"updatedById"`
	PublishedAt         *nestTime      `json:"publishedAt"`
	CreatedAt           *nestTime      `json:"createdAt"`
	UpdatedAt           *nestTime      `json:"updatedAt"`
}

// matchResult 是 matchProfileForUrl 的响应形状。
type matchResult struct {
	URL        string            `json:"url"`
	Host       string            `json:"host"`
	Match      *profileDocument  `json:"match"`
	Candidates []profileDocument `json:"candidates"`
}

// previewResult 是 previewProfileDraft 的响应形状。
type previewResult struct {
	URL              string            `json:"url"`
	Host             string            `json:"host"`
	Draft            draftDocument     `json:"draft"`
	DraftMatches     bool              `json:"draftMatches"`
	DraftMatchReason string            `json:"draftMatchReason"`
	ActiveMatch      *profileDocument  `json:"activeMatch"`
	ActiveCandidates []profileDocument `json:"activeCandidates"`
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

func rawOrNull(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(raw)
}
