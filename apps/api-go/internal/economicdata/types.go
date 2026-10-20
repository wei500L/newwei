package economicdata

import (
	"encoding/json"
	"time"
)

// ValueType mirrors the EconomicDataValueType Prisma enum.
type ValueType string

const (
	ValueTypePrice    ValueType = "price"
	ValueTypeIndex    ValueType = "index"
	ValueTypePercent  ValueType = "percent"
	ValueTypeYield    ValueType = "yield"
	ValueTypeFX       ValueType = "fx"
	ValueTypeFx       ValueType = "fx"
	ValueTypeVolume   ValueType = "volume"
	ValueTypeQuantity ValueType = "quantity"
	ValueTypeSpread   ValueType = "spread"
)

// Frequency mirrors EconomicDataFrequency.
type Frequency string

const (
	FrequencyRealtime Frequency = "realtime"
	FrequencyHourly   Frequency = "hourly"
	FrequencyDaily    Frequency = "daily"
	FrequencyWeekly   Frequency = "weekly"
	FrequencyMonthly  Frequency = "monthly"
)

// RunStatus mirrors EconomicDataRunStatus.
type RunStatus string

const (
	RunStatusPending RunStatus = "pending"
	RunStatusRunning RunStatus = "running"
	RunStatusSuccess RunStatus = "success"
	RunStatusFailed  RunStatus = "failed"
)

// ProviderKind identifies one of the four financial data providers.
type ProviderKind string

const (
	ProviderAkshare  ProviderKind = "akshare"
	ProviderFinnhub  ProviderKind = "finnhub"
	ProviderFred     ProviderKind = "fred"
	ProviderYfinance ProviderKind = "yfinance"
)

// ParserType is the discriminator of the five parser implementations.
type ParserType string

const (
	ParserLatest     ParserType = "latest"
	ParserTimeseries ParserType = "timeseries"
	ParserMacro      ParserType = "macro"
	ParserYearMonth  ParserType = "yearMonth"
	ParserYieldCurve ParserType = "yieldCurve"
)

// DataField describes one parsed value column.
type DataField struct {
	Field        string    `json:"field"`
	Label        string    `json:"label,omitempty"`
	Unit         string    `json:"unit,omitempty"`
	DataType     ValueType `json:"dataType,omitempty"`
	DecimalScale *int      `json:"decimalScale,omitempty"`
}

// ParserConfig is the strongly typed union of the five parser configurations.
// Unused members are omitted so the persisted JSON matches the NestJS parser
// object for each discriminator.
type ParserConfig struct {
	Type            ParserType  `json:"type"`
	TimestampField  string      `json:"timestampField,omitempty"`
	TimestampFormat string      `json:"timestampFormat,omitempty"`
	CategoryField   string      `json:"categoryField,omitempty"`
	ValueFields     []DataField `json:"valueFields,omitempty"`
	DateField       string      `json:"dateField,omitempty"`
	SeriesFields    []DataField `json:"seriesFields,omitempty"`
	PeriodField     string      `json:"periodField,omitempty"`
	YearField       string      `json:"yearField,omitempty"`
	MonthField      string      `json:"monthField,omitempty"`
	DayField        string      `json:"dayField,omitempty"`
}

// PayloadFilter mirrors the Akshare record filter.
type PayloadFilter struct {
	Field              string `json:"field"`
	Equals             string `json:"equals"`
	Mode               string `json:"mode,omitempty"`
	PreferNonZeroField string `json:"preferNonZeroField,omitempty"`
	RankBy             string `json:"rankBy,omitempty"`
	RankOrder          string `json:"rankOrder,omitempty"`
}

// Snapshot is the financial mainline snapshot projection.
type Snapshot struct {
	Group  string `json:"group"`
	Bucket string `json:"bucket"`
	Symbol string `json:"symbol,omitempty"`
	Name   string `json:"name,omitempty"`
	Order  int    `json:"order,omitempty"`
}

// DataViz is the optional visualization projection.
type DataViz struct {
	PreferredSourceFields []string `json:"preferredSourceFields,omitempty"`
	PercentSourceFields   []string `json:"percentSourceFields,omitempty"`
}

// Period2 is the Yahoo chart period2 value: either the literal "now" or epoch
// seconds. The NestJS config permits both shapes.
type Period2 struct {
	Now     bool
	Seconds *int64
}

// MarshalJSON writes "now" or an epoch number.
func (p Period2) MarshalJSON() ([]byte, error) {
	if p.Now {
		return []byte(`"now"`), nil
	}
	if p.Seconds == nil {
		return []byte("0"), nil
	}
	return json.Marshal(*p.Seconds)
}

// UnmarshalJSON accepts "now" or an epoch number.
func (p *Period2) UnmarshalJSON(raw []byte) error {
	if string(raw) == `"now"` {
		p.Now = true
		p.Seconds = nil
		return nil
	}
	var seconds int64
	if err := json.Unmarshal(raw, &seconds); err != nil {
		return err
	}
	p.Now = false
	p.Seconds = &seconds
	return nil
}

// YahooSourceFields maps Yahoo chart series names to persisted source fields.
type YahooSourceFields struct {
	Open   string `json:"open,omitempty"`
	High   string `json:"high,omitempty"`
	Low    string `json:"low,omitempty"`
	Close  string `json:"close,omitempty"`
	Volume string `json:"volume,omitempty"`
}

// ProviderConfig is the typed union of the four provider configurations.
type ProviderConfig struct {
	Kind           ProviderKind       `json:"kind"`
	FunctionName   string             `json:"functionName,omitempty"`
	Symbol         string             `json:"symbol,omitempty"`
	Endpoint       string             `json:"endpoint"`
	DocURL         string             `json:"docUrl"`
	Method         string             `json:"method,omitempty"`
	DefaultParams  map[string]string  `json:"defaultParams,omitempty"`
	Filter         *PayloadFilter     `json:"filter,omitempty"`
	Parser         *ParserConfig      `json:"parser,omitempty"`
	Metric         string             `json:"metric,omitempty"`
	SourceField    string             `json:"sourceField,omitempty"`
	SeriesID       string             `json:"seriesId,omitempty"`
	Lookback       int                `json:"lookback,omitempty"`
	Precision      int                `json:"precision,omitempty"`
	Transform      string             `json:"transform,omitempty"`
	Interval       string             `json:"interval,omitempty"`
	Period1        *int64             `json:"period1,omitempty"`
	Period2        *Period2           `json:"period2,omitempty"`
	IncludePrePost *bool              `json:"includePrePost,omitempty"`
	Events         string             `json:"events,omitempty"`
	SourceFields   *YahooSourceFields `json:"sourceFields,omitempty"`
}

// Definition is one catalog entry. It is the static source of truth for
// ensureCatalog; persisted rows are derived from it but historical rows outside
// the catalog are never deleted.
type Definition struct {
	ID               string
	Slug             string
	DisplayName      string
	Description      string
	Categories       []string
	SourceFunction   string
	Endpoint         string
	DocURL           string
	ValueType        ValueType
	DefaultUnit      string
	DefaultFrequency Frequency
	ProviderKind     ProviderKind
	ProviderConfig   ProviderConfig
	RequiresSecret   string
	DefaultEnabled   bool
	MainlineRole     string
	Snapshot         *Snapshot
	DataViz          *DataViz
	Tags             []string
}

// ItemMetadata is the persisted EconomicDataItem.metadata document. All keys
// are emitted, including explicit nulls, because NestJS normalizeMetadata does
// the same and the catalog comparison depends on that shape.
type ItemMetadata struct {
	Method         string             `json:"method"`
	DefaultParams  *map[string]string `json:"defaultParams"`
	Parser         *ParserConfig      `json:"parser"`
	Tags           []string           `json:"tags"`
	Filter         *PayloadFilter     `json:"filter"`
	ProviderKind   ProviderKind       `json:"providerKind,omitempty"`
	ProviderConfig *ProviderConfig    `json:"providerConfig,omitempty"`
	RequiresSecret *string            `json:"requiresSecret,omitempty"`
	DefaultEnabled *bool              `json:"defaultEnabled,omitempty"`
	MainlineRole   string             `json:"mainlineRole,omitempty"`
	Snapshot       *Snapshot          `json:"snapshot,omitempty"`
	DataViz        *DataViz           `json:"dataViz,omitempty"`
}

// ItemRow is the persisted EconomicDataItem row used by the worker.
type ItemRow struct {
	ID               string
	Slug             string
	DisplayName      string
	Description      *string
	SourceFunction   string
	SourceEndpoint   string
	SourceDocURL     *string
	ValueType        ValueType
	DefaultUnit      *string
	DefaultFrequency Frequency
	IsActive         bool
	GroupLabel       *string
	Metadata         []byte
}

// FetchConfigRow is one EconomicDataFetchConfig joined with its item.
type FetchConfigRow struct {
	ID         string
	ItemID     string
	Frequency  Frequency
	RepeatCron *string
	IsEnabled  bool
	LastRunAt  *time.Time
	LastStatus *RunStatus
	LastError  *string
	Item       ItemRow
}

// ItemConfig is the worker's typed view of one item plus its parsed provider
// configuration.
type ItemConfig struct {
	ItemID           string
	Slug             string
	DisplayName      string
	Description      *string
	Categories       []string
	SourceFunction   string
	Endpoint         string
	DocURL           *string
	ValueType        ValueType
	DefaultUnit      *string
	DefaultFrequency Frequency
	ProviderKind     ProviderKind
	ProviderConfig   ProviderConfig
	RequiresSecret   string
	DefaultEnabled   bool
	MainlineRole     string
	Snapshot         *Snapshot
	DataViz          *DataViz
	Tags             []string
}

// ParsedDataPoint is one provider value before persistence.
type ParsedDataPoint struct {
	RecordedAt  time.Time
	Value       float64
	Unit        *string
	DataType    ValueType
	SourceField string
	Meta        json.RawMessage
}

// ProviderFetchResult is one real upstream response.
type ProviderFetchResult struct {
	Payload          json.RawMessage
	Points           []ParsedDataPoint
	Cleanup          []time.Time
	RequestParams    json.RawMessage
	Method           string
	ProviderIdentity string
}

// ProviderConfigurationError is the Nest FinancialDataProviderConfigurationError
// equivalent. It marks a skipped fetch instead of a retryable job failure.
type ProviderConfigurationError struct {
	Code    string
	Message string
}

func (e *ProviderConfigurationError) Error() string { return e.Message }
