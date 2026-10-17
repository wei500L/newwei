package newsindicator

import (
	"database/sql"
	"encoding/json"
	"time"
)

// iso 是 JavaScript Date.toISOString() 等价格式（毫秒 UTC）。
func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// economicItemRecord 是 EconomicDataItem 的原始行。
type economicItemRecord struct {
	id               string
	slug             string
	displayName      string
	groupLabel       sql.NullString
	description      sql.NullString
	sourceFunction   string
	sourceEndpoint   string
	sourceDocURL     sql.NullString
	valueType        string
	defaultUnit      sql.NullString
	defaultFrequency string
	responseAdapter  sql.NullString
	isActive         bool
	metadata         []byte
	createdAt        time.Time
	updatedAt        time.Time
}

// associationRecord 是 NewsIndicatorAssociation 的原始行（含关联 indicatorItem）。
type associationRecord struct {
	id              string
	orgID           string
	scopeType       string
	scopeKey        string
	scopeKeyType    string
	featureMetric   string
	indicatorItemID string
	windowDays      int
	lagDays         int
	correlation     float64
	pValue          sql.NullFloat64
	sampleSize      int
	analyzedStartAt time.Time
	analyzedEndAt   time.Time
	metadata        []byte
	lastEvaluatedAt time.Time
	createdAt       time.Time
	updatedAt       time.Time
	item            economicItemRecord
}

// backtestRecord 是 NewsIndicatorAssociationBacktestRun 的原始行。
type backtestRecord struct {
	id            string
	orgID         string
	associationID string
	status        string
	windowStart   time.Time
	windowEnd     time.Time
	config        []byte
	metrics       []byte
	err           sql.NullString
	createdAt     time.Time
	updatedAt     time.Time
}

// economicItemJSON 逐字段复刻 Prisma 返回的 EconomicDataItem。
type economicItemJSON struct {
	ID               string          `json:"id"`
	Slug             string          `json:"slug"`
	DisplayName      string          `json:"displayName"`
	GroupLabel       *string         `json:"groupLabel"`
	Description      *string         `json:"description"`
	SourceFunction   string          `json:"sourceFunction"`
	SourceEndpoint   string          `json:"sourceEndpoint"`
	SourceDocURL     *string         `json:"sourceDocUrl"`
	ValueType        string          `json:"valueType"`
	DefaultUnit      *string         `json:"defaultUnit"`
	DefaultFrequency string          `json:"defaultFrequency"`
	ResponseAdapter  *string         `json:"responseAdapter"`
	IsActive         bool            `json:"isActive"`
	Metadata         json.RawMessage `json:"metadata"`
	CreatedAt        string          `json:"createdAt"`
	UpdatedAt        string          `json:"updatedAt"`
}

// backtestJSON 逐字段复刻 Prisma 返回的 NewsIndicatorAssociationBacktestRun。
type backtestJSON struct {
	ID            string          `json:"id"`
	OrgID         string          `json:"orgId"`
	AssociationID string          `json:"associationId"`
	Status        string          `json:"status"`
	WindowStart   string          `json:"windowStart"`
	WindowEnd     string          `json:"windowEnd"`
	Config        json.RawMessage `json:"config"`
	Metrics       json.RawMessage `json:"metrics"`
	Error         *string         `json:"error"`
	CreatedAt     string          `json:"createdAt"`
	UpdatedAt     string          `json:"updatedAt"`
}

// associationJSON 逐字段复刻 Prisma 返回的 NewsIndicatorAssociation。
// Backtests 用指针 + omitempty：list/detail(limit>0) 设为非 nil（可为空数组）；
// detail(limit=0) 留 nil（Prisma include:false 时字段不出现）。
type associationJSON struct {
	ID              string           `json:"id"`
	OrgID           string           `json:"orgId"`
	ScopeType       string           `json:"scopeType"`
	ScopeKey        string           `json:"scopeKey"`
	ScopeKeyType    string           `json:"scopeKeyType"`
	FeatureMetric   string           `json:"featureMetric"`
	IndicatorItemID string           `json:"indicatorItemId"`
	WindowDays      int              `json:"windowDays"`
	LagDays         int              `json:"lagDays"`
	Correlation     float64          `json:"correlation"`
	PValue          *float64         `json:"pValue"`
	SampleSize      int              `json:"sampleSize"`
	AnalyzedStartAt string           `json:"analyzedStartAt"`
	AnalyzedEndAt   string           `json:"analyzedEndAt"`
	Metadata        json.RawMessage  `json:"metadata"`
	LastEvaluatedAt string           `json:"lastEvaluatedAt"`
	CreatedAt       string           `json:"createdAt"`
	UpdatedAt       string           `json:"updatedAt"`
	IndicatorItem   economicItemJSON `json:"indicatorItem"`
	Backtests       *[]backtestJSON  `json:"backtests,omitempty"`
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func nullFloatPtr(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	number := value.Float64
	return &number
}

func rawOrNull(value []byte) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(value)
}

func toEconomicItemJSON(record economicItemRecord) economicItemJSON {
	return economicItemJSON{
		ID:               record.id,
		Slug:             record.slug,
		DisplayName:      record.displayName,
		GroupLabel:       nullStringPtr(record.groupLabel),
		Description:      nullStringPtr(record.description),
		SourceFunction:   record.sourceFunction,
		SourceEndpoint:   record.sourceEndpoint,
		SourceDocURL:     nullStringPtr(record.sourceDocURL),
		ValueType:        record.valueType,
		DefaultUnit:      nullStringPtr(record.defaultUnit),
		DefaultFrequency: record.defaultFrequency,
		ResponseAdapter:  nullStringPtr(record.responseAdapter),
		IsActive:         record.isActive,
		Metadata:         rawOrNull(record.metadata),
		CreatedAt:        iso(record.createdAt),
		UpdatedAt:        iso(record.updatedAt),
	}
}

func toBacktestJSON(record backtestRecord) backtestJSON {
	return backtestJSON{
		ID:            record.id,
		OrgID:         record.orgID,
		AssociationID: record.associationID,
		Status:        record.status,
		WindowStart:   iso(record.windowStart),
		WindowEnd:     iso(record.windowEnd),
		Config:        rawOrNull(record.config),
		Metrics:       rawOrNull(record.metrics),
		Error:         nullStringPtr(record.err),
		CreatedAt:     iso(record.createdAt),
		UpdatedAt:     iso(record.updatedAt),
	}
}

func toAssociationJSON(record associationRecord, backtests *[]backtestJSON) associationJSON {
	return associationJSON{
		ID:              record.id,
		OrgID:           record.orgID,
		ScopeType:       record.scopeType,
		ScopeKey:        record.scopeKey,
		ScopeKeyType:    record.scopeKeyType,
		FeatureMetric:   record.featureMetric,
		IndicatorItemID: record.indicatorItemID,
		WindowDays:      record.windowDays,
		LagDays:         record.lagDays,
		Correlation:     record.correlation,
		PValue:          nullFloatPtr(record.pValue),
		SampleSize:      record.sampleSize,
		AnalyzedStartAt: iso(record.analyzedStartAt),
		AnalyzedEndAt:   iso(record.analyzedEndAt),
		Metadata:        rawOrNull(record.metadata),
		LastEvaluatedAt: iso(record.lastEvaluatedAt),
		CreatedAt:       iso(record.createdAt),
		UpdatedAt:       iso(record.updatedAt),
		IndicatorItem:   toEconomicItemJSON(record.item),
		Backtests:       backtests,
	}
}

// refreshResponse 对齐 refreshOrg 的返回结构。
type refreshResponse struct {
	Indicators           int `json:"indicators"`
	AssociationsUpserted int `json:"associationsUpserted"`
	BacktestsCreated     int `json:"backtestsCreated"`
}
