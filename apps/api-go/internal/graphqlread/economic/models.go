package economic

import (
	"encoding/json"
	"time"
)

// EconomicDataItemModel is the GraphQL EconomicDataItemModel object.
type EconomicDataItemModel struct {
	Slug        string  `graphql:"slug"`
	DisplayName string  `graphql:"displayName"`
	GroupLabel  *string `graphql:"groupLabel"`
	DefaultUnit *string `graphql:"defaultUnit"`
	Metadata    any     `graphql:"metadata"`
}

// EconomicDataPointModel is one sampled or bucketed observation.
type EconomicDataPointModel struct {
	Timestamp            time.Time             `graphql:"timestamp"`
	EffectiveGranularity string                `graphql:"effectiveGranularity"`
	Value                float64               `graphql:"value"`
	Unit                 *string               `graphql:"unit"`
	SourceField          *string               `graphql:"sourceField"`
	DataType             string                `graphql:"dataType"`
	Item                 EconomicDataItemModel `graphql:"item"`
}

// EconomicSeriesInsightModel is one series summary from computeEconomicSeriesInsights.
type EconomicSeriesInsightModel struct {
	ItemSlug       string   `graphql:"itemSlug"`
	SeriesKey      string   `graphql:"seriesKey"`
	SourceField    *string  `graphql:"sourceField"`
	Unit           *string  `graphql:"unit"`
	SampleCount    int      `graphql:"sampleCount"`
	CurrentValue   *float64 `graphql:"currentValue"`
	PreviousValue  *float64 `graphql:"previousValue"`
	Change         *float64 `graphql:"change"`
	PercentChange  *float64 `graphql:"percentChange"`
	Mean           *float64 `graphql:"mean"`
	StdDev         *float64 `graphql:"stdDev"`
	ZScore         *float64 `graphql:"zScore"`
	Direction      string   `graphql:"direction"`
	Classification string   `graphql:"classification"`
	Message        string   `graphql:"message"`
}

// EconomicDataWithInsightsModel is the points plus their series insights.
type EconomicDataWithInsightsModel struct {
	Points   []EconomicDataPointModel     `graphql:"points"`
	Insights []EconomicSeriesInsightModel `graphql:"insights"`
}

// PaginationMetaModel is cursor metadata. totalCount is set only for a bucketed page.
type PaginationMetaModel struct {
	HasMore    bool    `graphql:"hasMore"`
	NextCursor *string `graphql:"nextCursor"`
	TotalCount *int    `graphql:"totalCount"`
}

// PaginatedEconomicDataPointsModel is one page of economic points.
type PaginatedEconomicDataPointsModel struct {
	Data       []EconomicDataPointModel `graphql:"data"`
	Pagination PaginationMetaModel      `graphql:"pagination"`
}

// EconomicDataFetchConfigModel is one EconomicDataFetchConfig row.
type EconomicDataFetchConfigModel struct {
	ID         string                `graphql:"id"`
	Frequency  string                `graphql:"frequency"`
	RepeatCron *string               `graphql:"repeatCron"`
	IsEnabled  bool                  `graphql:"isEnabled"`
	LastRunAt  *time.Time            `graphql:"lastRunAt"`
	LastStatus *string               `graphql:"lastStatus"`
	LastError  *string               `graphql:"lastError"`
	Item       EconomicDataItemModel `graphql:"item"`
}

// EconomicDataRefreshPresetStatusModel is the live preset summary.
type EconomicDataRefreshPresetStatusModel struct {
	Preset       string     `graphql:"preset"`
	CategoryKey  string     `graphql:"categoryKey"`
	TotalItems   int        `graphql:"totalItems"`
	EnabledItems int        `graphql:"enabledItems"`
	LastRunAt    *time.Time `graphql:"lastRunAt"`
	LastStatus   *string    `graphql:"lastStatus"`
	LastError    *string    `graphql:"lastError"`
}

// parseMetadata matches parseMetadata in economic-data.schema.ts.
// A JSON object becomes a map. Null, arrays, scalars, and invalid JSON become nil.
func parseMetadata(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return object
}

func stringPtr(value string) *string {
	return &value
}

func floatPtr(value float64) *float64 {
	return &value
}

func intPtr(value int) *int {
	return &value
}
