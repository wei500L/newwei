package crawltemplate

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

// templateRow 是 CrawlTemplate 的一行（列名与 Prisma 模型一致）。
type templateRow struct {
	ID           string
	OrgID        string
	Name         string
	Description  sql.NullString
	IsActive     bool
	CrawlOptions []byte
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const templateSelect = "id, orgId, name, description, isActive, crawlOptions, createdAt, updatedAt"

func scanTemplate(row interface{ Scan(dest ...any) error }) (templateRow, error) {
	var out templateRow
	var active int
	var options []byte
	err := row.Scan(&out.ID, &out.OrgID, &out.Name, &out.Description, &active, &options, &out.CreatedAt, &out.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return templateRow{}, errTemplateMissing
	}
	if err != nil {
		return templateRow{}, err
	}
	out.IsActive = active != 0
	out.CrawlOptions = options
	return out, nil
}

// templateDocument 是响应形状。字段就是表列；crawlOptions 为数据库 NULL
// 时 JSON 是 null，不变成 {}。
type templateDocument struct {
	ID           string          `json:"id"`
	OrgID        string          `json:"orgId"`
	Name         string          `json:"name"`
	Description  *string         `json:"description"`
	IsActive     bool            `json:"isActive"`
	CrawlOptions json.RawMessage `json:"crawlOptions"`
	CreatedAt    *nestTime       `json:"createdAt"`
	UpdatedAt    *nestTime       `json:"updatedAt"`
}

func mapTemplate(row templateRow) templateDocument {
	return templateDocument{
		ID:           row.ID,
		OrgID:        row.OrgID,
		Name:         row.Name,
		Description:  nullString(row.Description),
		IsActive:     row.IsActive,
		CrawlOptions: rawOrNull(row.CrawlOptions),
		CreatedAt:    nestFromTime(row.CreatedAt),
		UpdatedAt:    nestFromTime(row.UpdatedAt),
	}
}

func mapTemplates(rows []templateRow) []templateDocument {
	out := make([]templateDocument, 0, len(rows))
	for _, row := range rows {
		out = append(out, mapTemplate(row))
	}
	return out
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

// rawOrNull 把数据库原文透传为 JSON；NULL（nil/空）输出 null。
func rawOrNull(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(raw)
}
