package realtimesignals

// This file declares the typed diagnostic contexts attached to each metric point.
// The field order inside every struct is the order the NestJS object literal
// writes, because the stored JSON is the contract the diagnostics reader and the
// alert worker consume. A field is optional exactly when NestJS writes
// `undefined`, which JSON.stringify drops; a nullable-but-present member would
// need an explicit `json:"name"` and a pointer instead.

// openSkyBudgetContext is buildOpenskyBudgetContext.
type openSkyBudgetContext struct {
	DateHKT              string  `json:"dateHkt"`
	DailyCreditBudget    int     `json:"dailyCreditBudget"`
	UsedCredits          float64 `json:"usedCredits"`
	RemainingCredits     float64 `json:"remainingCredits"`
	UsagePct             float64 `json:"usagePct"`
	CurrentPeriod        string  `json:"currentPeriod"`
	EffectiveIntervalSec int     `json:"effectiveIntervalSec"`
	BudgetDegradation    string  `json:"budgetDegradation"`
	AllModeBlocked       bool    `json:"allModeBlocked"`
	MilitaryPaused       bool    `json:"militaryPaused"`
}

// openSkyNotConfiguredMetricContext is the `!hasOpenskyCredentials` branch of the
// military metric. Its member order differs from the successful branch (scope
// precedes sourceEndpoint), so it needs its own struct.
type openSkyNotConfiguredMetricContext struct {
	Source                     string   `json:"source"`
	Scope                      string   `json:"scope"`
	Configured                 bool     `json:"configured"`
	AuthRequired               bool     `json:"authRequired"`
	AuthMode                   string   `json:"authMode"`
	SourceEndpoint             string   `json:"sourceEndpoint"`
	TotalAircraft              float64  `json:"totalAircraft"`
	MilitaryCount              float64  `json:"militaryCount"`
	ValidPositionCount         float64  `json:"validPositionCount"`
	SnapshotValidPositionCount float64  `json:"snapshotValidPositionCount"`
	CountryCodes               []string `json:"countryCodes"`
	openSkyBudgetContext
}

// openSkyMetricContext is the paused and successful military metric context. The
// budget reservation failure members are only written by the paused branch.
type openSkyMetricContext struct {
	Source                      string   `json:"source"`
	SourceEndpoint              string   `json:"sourceEndpoint"`
	Scope                       string   `json:"scope"`
	Configured                  bool     `json:"configured"`
	AuthRequired                bool     `json:"authRequired"`
	AuthMode                    string   `json:"authMode"`
	TotalAircraft               float64  `json:"totalAircraft"`
	MilitaryCount               float64  `json:"militaryCount"`
	ValidPositionCount          float64  `json:"validPositionCount"`
	SnapshotValidPositionCount  float64  `json:"snapshotValidPositionCount"`
	LatestObservedAt            string   `json:"latestObservedAt,omitempty"`
	SnapshotUpdatedAt           string   `json:"snapshotUpdatedAt,omitempty"`
	SnapshotFreshness           string   `json:"snapshotFreshness,omitempty"`
	SnapshotAgeSec              *float64 `json:"snapshotAgeSec,omitempty"`
	LatestObservedAgeSec        *float64 `json:"latestObservedAgeSec,omitempty"`
	SnapshotRetainedPrevious    bool     `json:"snapshotRetainedPrevious"`
	StaleThresholdSec           int      `json:"staleThresholdSec"`
	DroppedInvalidPositionCount float64  `json:"droppedInvalidPositionCount"`
	DroppedMissingIdentityCount float64  `json:"droppedMissingIdentityCount"`
	DroppedStalePositionCount   float64  `json:"droppedStalePositionCount"`
	DeduplicatedCount           float64  `json:"deduplicatedCount"`
	CountryCodes                []string `json:"countryCodes"`
	openSkyBudgetContext
	BudgetReservationFailed      bool   `json:"budgetReservationFailed,omitempty"`
	BudgetReservationFailureCode string `json:"budgetReservationFailureCode,omitempty"`
}

// openSkyNotConfiguredHealthContext is the `!hasOpenskyCredentials` branch of the
// snapshot health metric.
type openSkyNotConfiguredHealthContext struct {
	Source                     string   `json:"source"`
	Scope                      string   `json:"scope"`
	Configured                 bool     `json:"configured"`
	AuthRequired               bool     `json:"authRequired"`
	AuthMode                   string   `json:"authMode"`
	SourceEndpoint             string   `json:"sourceEndpoint"`
	HealthState                string   `json:"healthState"`
	SnapshotFreshness          string   `json:"snapshotFreshness"`
	Stale                      bool     `json:"stale"`
	RawAircraftCount           float64  `json:"rawAircraftCount"`
	CurrentValidPositionCount  float64  `json:"currentValidPositionCount"`
	SnapshotValidPositionCount float64  `json:"snapshotValidPositionCount"`
	CountryCodes               []string `json:"countryCodes"`
	openSkyBudgetContext
}

// openSkyHealthContext is the paused and successful snapshot health context.
type openSkyHealthContext struct {
	Source                      string   `json:"source"`
	SourceEndpoint              string   `json:"sourceEndpoint"`
	Scope                       string   `json:"scope"`
	Configured                  bool     `json:"configured"`
	AuthRequired                bool     `json:"authRequired"`
	AuthMode                    string   `json:"authMode"`
	HealthState                 string   `json:"healthState"`
	Stale                       bool     `json:"stale"`
	SnapshotRetainedPrevious    bool     `json:"snapshotRetainedPrevious"`
	SnapshotFreshness           string   `json:"snapshotFreshness"`
	SnapshotUpdatedAt           string   `json:"snapshotUpdatedAt,omitempty"`
	LatestTimestamp             string   `json:"latestTimestamp,omitempty"`
	MaxStaleMinutes             float64  `json:"maxStaleMinutes"`
	RawAircraftCount            float64  `json:"rawAircraftCount"`
	CurrentValidPositionCount   float64  `json:"currentValidPositionCount"`
	SnapshotValidPositionCount  float64  `json:"snapshotValidPositionCount"`
	DroppedInvalidPositionCount float64  `json:"droppedInvalidPositionCount"`
	DroppedMissingIdentityCount float64  `json:"droppedMissingIdentityCount"`
	DroppedStalePositionCount   float64  `json:"droppedStalePositionCount"`
	DeduplicatedCount           float64  `json:"deduplicatedCount"`
	CountryCodes                []string `json:"countryCodes"`
	openSkyBudgetContext
	BudgetReservationFailed      bool   `json:"budgetReservationFailed,omitempty"`
	BudgetReservationFailureCode string `json:"budgetReservationFailureCode,omitempty"`
}

func (*openSkyNotConfiguredMetricContext) signalContext() {}
func (*openSkyMetricContext) signalContext()              {}
func (*openSkyNotConfiguredHealthContext) signalContext() {}
func (*openSkyHealthContext) signalContext()              {}

// aisContext is the single AIS metric context. `configured:false` is followed by
// an empty countryCodes array, which is exactly the NestJS literal.
type aisContext struct {
	Source       string   `json:"source"`
	Configured   bool     `json:"configured"`
	CountryCodes []string `json:"countryCodes"`
}

func (*aisContext) signalContext() {}

// unrestFeedErrors is the nested feedErrors object. Both members are always
// present; a nil pointer renders as JSON null, which is what NestJS writes for a
// feed that did not fail.
type unrestFeedErrors struct {
	ACLED *string `json:"acled"`
	GDELT *string `json:"gdelt"`
}

// unrestContext is the unrest metric context.
type unrestContext struct {
	Source                 string           `json:"source"`
	UnrestCount            float64          `json:"unrestCount"`
	ACLEDCount             float64          `json:"acledCount"`
	GDELTCount             float64          `json:"gdeltCount"`
	DedupeReducedBy        float64          `json:"dedupeReducedBy"`
	ACLEDConfigured        bool             `json:"acledConfigured"`
	ACLEDAPIEnabled        bool             `json:"acledApiEnabled"`
	ACLEDAPIDisabledReason string           `json:"acledApiDisabledReason,omitempty"`
	UnrestMode             string           `json:"unrestMode"`
	CountryCodes           []string         `json:"countryCodes"`
	FeedErrors             unrestFeedErrors `json:"feedErrors"`
}

func (*unrestContext) signalContext() {}

// outagesNotConfiguredContext is the `!token` branch of the outages metric.
type outagesNotConfiguredContext struct {
	Configured bool   `json:"configured"`
	Source     string `json:"source"`
}

func (*outagesNotConfiguredContext) signalContext() {}

// outagesContext is the successful outages metric context.
type outagesContext struct {
	Source       string   `json:"source"`
	Outages      float64  `json:"outages"`
	CountryCodes []string `json:"countryCodes"`
}

func (*outagesContext) signalContext() {}

// keywordSpikeContext is the keyword spike metric context. The spikes array is
// the same typed value the insight snapshot copies.
type keywordSpikeContext struct {
	Source               string         `json:"source"`
	RecentArticleCount   float64        `json:"recentArticleCount"`
	BaselineArticleCount float64        `json:"baselineArticleCount"`
	Spikes               []KeywordSpike `json:"spikes"`
}

func (*keywordSpikeContext) signalContext() {}

// pizzintContext is the PizzINT metric context.
type pizzintContext struct {
	Source        string  `json:"source"`
	Defcon        float64 `json:"defcon"`
	AdjustedScore float64 `json:"adjustedScore"`
	OpenLocations float64 `json:"openLocations"`
	ActiveSpikes  float64 `json:"activeSpikes"`
	AvgPop        float64 `json:"avgPop"`
}

func (*pizzintContext) signalContext() {}

// gdeltTensionContext is the GDELT tension metric context. The date range is
// always present, including the empty-tensions branch.
type gdeltTensionContext struct {
	Source       string       `json:"source"`
	Tensions     []TensionRow `json:"tensions"`
	CountryCodes []string     `json:"countryCodes"`
	DateStart    string       `json:"dateStart"`
	DateEnd      string       `json:"dateEnd"`
}

func (*gdeltTensionContext) signalContext() {}

// polymarketContext is the Polymarket leads metric context. The leads array uses
// the same shape as the insight snapshot.
type polymarketContext struct {
	Source string           `json:"source"`
	Leads  []PredictionLead `json:"leads"`
}

func (*polymarketContext) signalContext() {}
