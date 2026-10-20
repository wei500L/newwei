package situationsignals

import (
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

// presentValue marks a JSON member that must be present even when its value is
// null. A nil *presentValue omits the member entirely; a non-nil one marshals
// Value (including a nil pointer as `null`). NestJS distinguishes `undefined`
// (omitted) from `null`, and several core members can be null.
type presentValue[T any] struct {
	Value T
}

func (p presentValue[T]) encodeJSON() ([]byte, error) { return json.Marshal(p.Value) }

// MarshalJSON implements json.Marshaler.
func (p presentValue[T]) MarshalJSON() ([]byte, error) { return json.Marshal(p.Value) }

// insightsWarning mirrors SituationMonitorWarning.
type insightsWarning struct {
	Code     string `json:"code"`
	Source   string `json:"source"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Detail   string `json:"detail,omitempty"`
}

// insightsCategoryDiagnostics mirrors SituationMonitorInsightsCategoryDiagnostics.
type insightsCategoryDiagnostics struct {
	InternalCount           int `json:"internalCount"`
	GdeltFallbackCount      int `json:"gdeltFallbackCount"`
	TotalCount              int `json:"totalCount"`
	ClusterCount            int `json:"clusterCount"`
	MixedSourceClusterCount int `json:"mixedSourceClusterCount"`
	DistinctSourceCount     int `json:"distinctSourceCount"`
}

// insightsDiagnosticsCategories mirrors the Record<category, diagnostics>.
type insightsDiagnosticsCategories struct {
	Politics insightsCategoryDiagnostics `json:"politics"`
	Tech     insightsCategoryDiagnostics `json:"tech"`
	Finance  insightsCategoryDiagnostics `json:"finance"`
	Gov      insightsCategoryDiagnostics `json:"gov"`
	AI       insightsCategoryDiagnostics `json:"ai"`
	Intel    insightsCategoryDiagnostics `json:"intel"`
}

// insightsDiagnostics mirrors SituationMonitorInsightsDiagnostics.
type insightsDiagnostics struct {
	RequestedScope string                        `json:"requestedScope"`
	EffectiveScope string                        `json:"effectiveScope"`
	Categories     insightsDiagnosticsCategories `json:"categories"`
}

// insightsCoverageSummary mirrors SituationMonitorCoverageSummary.
type insightsCoverageSummary struct {
	Mode                       string              `json:"mode"`
	ArticleCount               int                 `json:"articleCount"`
	ClusterCount               int                 `json:"clusterCount"`
	InternalAnalyzedItems      int                 `json:"internalAnalyzedItems"`
	ExternalAnalyzedItems      int                 `json:"externalAnalyzedItems"`
	MixedSourceClusterCount    int                 `json:"mixedSourceClusterCount"`
	DedupeRatio                *float64            `json:"dedupeRatio"`
	AvgSourcesPerCluster       *float64            `json:"avgSourcesPerCluster"`
	VisibleCategoryCount       int                 `json:"visibleCategoryCount"`
	MissingCategories          []analysis.Category `json:"missingCategories"`
	HasOlderItemsOutsideWindow bool                `json:"hasOlderItemsOutsideWindow"`
	RecommendedWindowHours     *int                `json:"recommendedWindowHours"`
}

// externalSnapshotCategoryState mirrors
// SituationMonitorExternalSnapshotCategoryState.
type externalSnapshotCategoryState struct {
	Status             string  `json:"status"`
	ArticleCount       int     `json:"articleCount"`
	ContentGeneratedAt *string `json:"contentGeneratedAt"`
	ReasonCode         string  `json:"reasonCode,omitempty"`
}

// externalSnapshotCategories is the category-state record.
type externalSnapshotCategories struct {
	Politics externalSnapshotCategoryState `json:"politics"`
	Tech     externalSnapshotCategoryState `json:"tech"`
	Finance  externalSnapshotCategoryState `json:"finance"`
	Gov      externalSnapshotCategoryState `json:"gov"`
	AI       externalSnapshotCategoryState `json:"ai"`
	Intel    externalSnapshotCategoryState `json:"intel"`
}

// externalSnapshotInfo mirrors the inline externalSnapshot response type.
type externalSnapshotInfo struct {
	Source                 string                     `json:"source"`
	Status                 string                     `json:"status"`
	Stale                  bool                       `json:"stale"`
	Partial                bool                       `json:"partial"`
	GeneratedAt            *string                    `json:"generatedAt"`
	ExpiresAt              *string                    `json:"expiresAt"`
	AvailableCategoryCount int                        `json:"availableCategoryCount"`
	Categories             externalSnapshotCategories `json:"categories"`
	Warnings               []insightsWarning          `json:"warnings"`
}

// translationStatus mirrors response.translation.
type translationStatus struct {
	Target  string `json:"target"`
	Applied bool   `json:"applied"`
	Error   string `json:"error,omitempty"`
}

// marketItem mirrors SituationMonitorMarketItem.
type marketItem struct {
	Symbol        string  `json:"symbol"`
	Name          string  `json:"name"`
	Price         float64 `json:"price"`
	Change        float64 `json:"change"`
	ChangePercent float64 `json:"changePercent"`
	Type          string  `json:"type"`
}

// marketsSnapshot mirrors SituationMonitorMarketsSnapshot.
type marketsSnapshot struct {
	HasFinnhubAPIKey bool         `json:"hasFinnhubApiKey"`
	Indices          []marketItem `json:"indices"`
	Sectors          []marketItem `json:"sectors"`
	Commodities      []marketItem `json:"commodities"`
	VIX              *marketItem  `json:"vix"`
	Error            string       `json:"error,omitempty"`
}

// cryptoItem mirrors SituationMonitorCryptoItem.
type cryptoItem struct {
	ID               string  `json:"id"`
	Symbol           string  `json:"symbol"`
	Name             string  `json:"name"`
	CurrentPriceUSD  float64 `json:"currentPriceUsd"`
	Change24hPercent float64 `json:"change24hPercent"`
}

// fedIndicator mirrors SituationMonitorFedIndicator.
type fedIndicator struct {
	SeriesID string   `json:"seriesId"`
	Name     string   `json:"name"`
	Value    *float64 `json:"value"`
	Change   *float64 `json:"change"`
	Unit     string   `json:"unit"`
}

// fedNewsItem mirrors SituationMonitorFedNewsItem.
type fedNewsItem struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	TitleZh         string `json:"titleZh,omitempty"`
	Link            string `json:"link"`
	Description     string `json:"description"`
	DescriptionZh   string `json:"descriptionZh,omitempty"`
	PubDate         string `json:"pubDate"`
	Timestamp       int64  `json:"timestamp"`
	Type            string `json:"type"`
	TypeLabel       string `json:"typeLabel"`
	TypeLabelZh     string `json:"typeLabelZh,omitempty"`
	IsPowellRelated bool   `json:"isPowellRelated"`
	HasVideo        bool   `json:"hasVideo"`
}

// moneyPrinter mirrors SituationMonitorMoneyPrinter.
type moneyPrinter struct {
	ValueTrillions  float64 `json:"valueTrillions"`
	ChangeTrillions float64 `json:"changeTrillions"`
	ChangePercent   float64 `json:"changePercent"`
	PercentOfMax    float64 `json:"percentOfMax"`
}

// fedSnapshot mirrors SituationMonitorFedSnapshot.
type fedSnapshot struct {
	HasFredAPIKey bool           `json:"hasFredApiKey"`
	Indicators    []fedIndicator `json:"indicators"`
	MoneyPrinter  *moneyPrinter  `json:"moneyPrinter"`
	News          []fedNewsItem  `json:"news"`
	Error         string         `json:"error,omitempty"`
}

// pizzintSnapshot mirrors SituationMonitorPizzintSnapshot.
type pizzintSnapshot struct {
	Defcon        int     `json:"defcon"`
	AdjustedScore float64 `json:"adjustedScore"`
	OpenLocations int     `json:"openLocations"`
	ActiveSpikes  int     `json:"activeSpikes"`
	AvgPop        float64 `json:"avgPop"`
	UpdatedAt     string  `json:"updatedAt"`
}

// tensionPair mirrors SituationMonitorTensionPair.
type tensionPair struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Score         float64  `json:"score"`
	ChangePercent float64  `json:"changePercent"`
	Trend         string   `json:"trend"`
	Countries     []string `json:"countries"`
	UpdatedAt     string   `json:"updatedAt"`
}

// insightsResponse mirrors SituationMonitorInsightsResponse.
//
// Pointer-to-slice fields distinguish "the section was not requested"
// (nil, omitted) from "the section ran but produced an empty array" (non-nil
// pointer to an empty slice). NestJS makes the same distinction.
type insightsResponse struct {
	GeneratedAt          string                                      `json:"generatedAt"`
	WindowHours          int                                         `json:"windowHours"`
	MaxItems             int                                         `json:"maxItems"`
	AnalyzedItems        int                                         `json:"analyzedItems"`
	Diagnostics          *insightsDiagnostics                        `json:"diagnostics,omitempty"`
	CoverageSummary      *insightsCoverageSummary                    `json:"coverageSummary,omitempty"`
	Warnings             []insightsWarning                           `json:"warnings,omitempty"`
	ExternalSnapshot     *externalSnapshotInfo                       `json:"externalSnapshot,omitempty"`
	Translation          *translationStatus                          `json:"translation,omitempty"`
	Headlines            *analysis.HeadlinesByCategory               `json:"headlines,omitempty"`
	Clusters             *analysis.ClustersByCategory                `json:"clusters,omitempty"`
	Alerts               *[]analysis.AlertHeadline                   `json:"alerts,omitempty"`
	Leaders              *[]analysis.WorldLeader                     `json:"leaders,omitempty"`
	Situations           *[]analysis.SituationPanel                  `json:"situations,omitempty"`
	Markets              *marketsSnapshot                            `json:"markets,omitempty"`
	Crypto               *[]cryptoItem                               `json:"crypto,omitempty"`
	Fed                  *fedSnapshot                                `json:"fed,omitempty"`
	Pizzint              *pizzintSnapshot                            `json:"pizzint,omitempty"`
	Tensions             *[]tensionPair                              `json:"tensions,omitempty"`
	Correlation          *presentValue[*analysis.CorrelationResults] `json:"correlation,omitempty"`
	CorrelationSummary   *analysis.CorrelationSummary                `json:"correlationSummary,omitempty"`
	Narrative            *presentValue[*analysis.NarrativeResults]   `json:"narrative,omitempty"`
	NarrativeSummary     *analysis.NarrativeSummary                  `json:"narrativeSummary,omitempty"`
	MainCharacter        *analysis.MainCharacterResults              `json:"mainCharacter,omitempty"`
	MainCharacterSummary *analysis.MainCharacterSummary              `json:"mainCharacterSummary,omitempty"`
	MonitorMatches       []matchResult                               `json:"monitorMatches"`
}

func (r insightsResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }
