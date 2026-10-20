package realtimesignals

import (
	"encoding/json"
)

// ---- fetch results ----

// SignalContext is the typed diagnostic context attached to one metric point.
// Every implementation is a named struct, so the JSON member order is the struct
// field order and matches the NestJS object literal. Using an interface here (and
// never map[string]any) keeps the writer strongly typed while still letting the
// insight builder type-switch on the source shape.
type SignalContext interface {
	signalContext()
}

// FetchResult is RealtimeSignalFetchResult.
type FetchResult struct {
	MetricSlug string
	Value      float64
	Context    SignalContext
}

// RateLimitDetails is RealtimeSignalRateLimitDetails. Every member is optional in
// NestJS, so a zero value is omitted instead of being written as null.
type RateLimitDetails struct {
	RetryAfterSec   *float64 `json:"retryAfterSec,omitempty"`
	RateLimit       string   `json:"rateLimit,omitempty"`
	RateLimitPolicy string   `json:"rateLimitPolicy,omitempty"`
	CFRay           string   `json:"cfRay,omitempty"`
}

// SourceState is RealtimeSignalSourceState. Optional members use omitempty to
// reproduce JSON.stringify dropping `undefined`; a present zero value (for
// example latestValue 0) is kept because the pointer is non-nil.
type SourceState struct {
	Source          SignalSource      `json:"source"`
	Status          string            `json:"status"`
	LastAttemptAt   string            `json:"lastAttemptAt"`
	NextEligibleAt  string            `json:"nextEligibleAt,omitempty"`
	LastSuccessAt   string            `json:"lastSuccessAt,omitempty"`
	LastErrorAt     string            `json:"lastErrorAt,omitempty"`
	LastError       string            `json:"lastError,omitempty"`
	LastErrorCode   string            `json:"lastErrorCode,omitempty"`
	LastErrorKind   string            `json:"lastErrorKind,omitempty"`
	LastErrorStatus *float64          `json:"lastErrorStatus,omitempty"`
	LastRateLimit   *RateLimitDetails `json:"lastRateLimit,omitempty"`
	MetricSlug      string            `json:"metricSlug,omitempty"`
	LatestValue     *float64          `json:"latestValue,omitempty"`
	Context         json.RawMessage   `json:"context,omitempty"`
}

// signalContextRaw converts a typed context into the stored JSON leaf. NestJS
// stores the same object it attached to the point, so the marshaled bytes are the
// contract.
func signalContextRaw(c SignalContext) json.RawMessage {
	if c == nil {
		return nil
	}
	encoded, err := json.Marshal(c)
	if err != nil {
		return nil
	}
	return encoded
}

// ---- insight snapshot ----

// KeywordSpike is one entry of RealtimeSignalsInsightSnapshot.keywordSpikes.
type KeywordSpike struct {
	ID          string  `json:"id"`
	Term        string  `json:"term"`
	Count       float64 `json:"count"`
	Baseline    float64 `json:"baseline"`
	Multiplier  float64 `json:"multiplier"`
	SourceCount float64 `json:"sourceCount"`
	Confidence  float64 `json:"confidence"`
}

// PredictionLead is one entry of predictionLeads.
type PredictionLead struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Shift        float64 `json:"shift"`
	NewsActivity float64 `json:"newsActivity"`
	Confidence   float64 `json:"confidence"`
}

// PizzintInsight is the optional pizzint block.
type PizzintInsight struct {
	Defcon        float64 `json:"defcon"`
	AdjustedScore float64 `json:"adjustedScore"`
	OpenLocations float64 `json:"openLocations"`
	ActiveSpikes  float64 `json:"activeSpikes"`
	AvgPop        float64 `json:"avgPop"`
	UpdatedAt     string  `json:"updatedAt"`
}

// TensionRow is one entry of tensions.
type TensionRow struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Score         float64  `json:"score"`
	ChangePercent float64  `json:"changePercent"`
	Trend         string   `json:"trend"`
	Countries     []string `json:"countries"`
	UpdatedAt     string   `json:"updatedAt"`
}

// InsightSnapshot is RealtimeSignalsInsightSnapshot. The three arrays are always
// present (empty arrays are significant); pizzint is omitted until a PizzINT run
// has produced it.
type InsightSnapshot struct {
	KeywordSpikes   []KeywordSpike   `json:"keywordSpikes"`
	PredictionLeads []PredictionLead `json:"predictionLeads"`
	Pizzint         *PizzintInsight  `json:"pizzint,omitempty"`
	Tensions        []TensionRow     `json:"tensions"`
}

func emptyInsightSnapshot() InsightSnapshot {
	return InsightSnapshot{
		KeywordSpikes:   []KeywordSpike{},
		PredictionLeads: []PredictionLead{},
		Tensions:        []TensionRow{},
	}
}

// ---- ADS-B snapshot (realtime-signals:opensky-latest:{orgId}) ----

// AdsbAircraft is RealtimeOpenskyAircraftSnapshot.
type AdsbAircraft struct {
	ID            string   `json:"id"`
	ICAO24        string   `json:"icao24"`
	Callsign      string   `json:"callsign,omitempty"`
	Registration  string   `json:"registration,omitempty"`
	AircraftType  string   `json:"aircraftType,omitempty"`
	Lat           float64  `json:"lat"`
	Lng           float64  `json:"lng"`
	Heading       *float64 `json:"heading,omitempty"`
	AltitudeFt    *float64 `json:"altitudeFt,omitempty"`
	GroundSpeedKt *float64 `json:"groundSpeedKt,omitempty"`
	CountryCode   string   `json:"countryCode,omitempty"`
	CountryName   string   `json:"countryName,omitempty"`
	ObservedAt    string   `json:"observedAt"`
	Source        string   `json:"source"`
}

// AdsbSnapshotDiagnostics is RealtimeOpenskySnapshotDiagnostics.
type AdsbSnapshotDiagnostics struct {
	LatestObservedAt            string `json:"latestObservedAt,omitempty"`
	OldestObservedAt            string `json:"oldestObservedAt,omitempty"`
	StaleThresholdSec           int    `json:"staleThresholdSec"`
	DroppedInvalidPositionCount int    `json:"droppedInvalidPositionCount"`
	DroppedMissingIdentityCount int    `json:"droppedMissingIdentityCount"`
	DroppedStalePositionCount   int    `json:"droppedStalePositionCount"`
	DeduplicatedCount           int    `json:"deduplicatedCount"`
	RetainedPreviousSnapshot    bool   `json:"retainedPreviousSnapshot"`
}

// AdsbSnapshot is RealtimeOpenskyLatestSnapshot.
type AdsbSnapshot struct {
	Source             string                  `json:"source"`
	SourceEndpoint     string                  `json:"sourceEndpoint"`
	UpdatedAt          string                  `json:"updatedAt"`
	TotalAircraft      int                     `json:"totalAircraft"`
	ValidPositionCount int                     `json:"validPositionCount"`
	LatestObservedAt   string                  `json:"latestObservedAt,omitempty"`
	Diagnostics        AdsbSnapshotDiagnostics `json:"diagnostics"`
	Aircraft           []AdsbAircraft          `json:"aircraft"`
}

// AdsbRuntimeDiagnostics is RealtimeOpenskyRuntimeDiagnostics.
type AdsbRuntimeDiagnostics struct {
	Freshness                   string `json:"freshness"`
	RawAircraftCount            int    `json:"rawAircraftCount"`
	CurrentValidPositionCount   int    `json:"currentValidPositionCount"`
	SnapshotValidPositionCount  int    `json:"snapshotValidPositionCount"`
	SnapshotUpdatedAt           string `json:"snapshotUpdatedAt,omitempty"`
	SnapshotAgeSec              *int   `json:"snapshotAgeSec,omitempty"`
	LatestObservedAt            string `json:"latestObservedAt,omitempty"`
	LatestObservedAgeSec        *int   `json:"latestObservedAgeSec,omitempty"`
	StaleThresholdSec           int    `json:"staleThresholdSec"`
	RetainedPreviousSnapshot    bool   `json:"retainedPreviousSnapshot"`
	DroppedInvalidPositionCount int    `json:"droppedInvalidPositionCount"`
	DroppedMissingIdentityCount int    `json:"droppedMissingIdentityCount"`
	DroppedStalePositionCount   int    `json:"droppedStalePositionCount"`
	DeduplicatedCount           int    `json:"deduplicatedCount"`
}

// ---- AIS snapshot (realtime-signals:ais-latest:{orgId}) ----

// AisRelayStatus is RealtimeAisRelayStatusSnapshot.
type AisRelayStatus struct {
	Connected       bool    `json:"connected"`
	Vessels         float64 `json:"vessels"`
	Messages        float64 `json:"messages"`
	Clients         float64 `json:"clients"`
	DroppedMessages float64 `json:"droppedMessages"`
}

// AisRelayDiagnostics is RealtimeAisRelayDiagnostics.
type AisRelayDiagnostics struct {
	HealthState              string  `json:"healthState"`
	StatusReasonCode         string  `json:"statusReasonCode,omitempty"`
	StatusReason             string  `json:"statusReason,omitempty"`
	PositionReportsSeen      float64 `json:"positionReportsSeen"`
	PositionReportsProcessed float64 `json:"positionReportsProcessed"`
	IgnoredPositionReports   float64 `json:"ignoredPositionReports"`
	ParseErrors              float64 `json:"parseErrors"`
	LastHealthyAt            string  `json:"lastHealthyAt,omitempty"`
	LastIssueAt              string  `json:"lastIssueAt,omitempty"`
	LastConnectedAt          string  `json:"lastConnectedAt,omitempty"`
	LastMessageAt            string  `json:"lastMessageAt,omitempty"`
	LastUpstreamErrorAt      string  `json:"lastUpstreamErrorAt,omitempty"`
	LastUpstreamError        string  `json:"lastUpstreamError,omitempty"`
	LastParseErrorAt         string  `json:"lastParseErrorAt,omitempty"`
	LastParseError           string  `json:"lastParseError,omitempty"`
}

// AisDisruption is RealtimeAisDisruptionSnapshot. Member order matches the
// NestJS literal (darkShips precedes region/description).
type AisDisruption struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Lat         float64  `json:"lat"`
	Lng         float64  `json:"lng"`
	Severity    string   `json:"severity"`
	ChangePct   *float64 `json:"changePct,omitempty"`
	WindowHours *float64 `json:"windowHours,omitempty"`
	VesselCount *float64 `json:"vesselCount,omitempty"`
	DarkShips   *float64 `json:"darkShips,omitempty"`
	Region      string   `json:"region,omitempty"`
	Description string   `json:"description,omitempty"`
}

// AisDensity is RealtimeAisDensitySnapshot.
type AisDensity struct {
	ID          string   `json:"id"`
	Name        string   `json:"name,omitempty"`
	Lat         float64  `json:"lat"`
	Lng         float64  `json:"lng"`
	Intensity   float64  `json:"intensity"`
	DeltaPct    *float64 `json:"deltaPct,omitempty"`
	ShipsPerDay *float64 `json:"shipsPerDay,omitempty"`
	Note        string   `json:"note,omitempty"`
}

// AisVessel is RealtimeAisVesselSnapshot.
type AisVessel struct {
	MMSI       string   `json:"mmsi"`
	Name       string   `json:"name,omitempty"`
	Lat        float64  `json:"lat"`
	Lng        float64  `json:"lng"`
	ShipType   *float64 `json:"shipType,omitempty"`
	Heading    *float64 `json:"heading,omitempty"`
	Speed      *float64 `json:"speed,omitempty"`
	Course     *float64 `json:"course,omitempty"`
	ObservedAt string   `json:"observedAt"`
}

// AisSnapshot is RealtimeAisLatestSnapshot.
type AisSnapshot struct {
	Source            string              `json:"source"`
	SourceEndpoint    string              `json:"sourceEndpoint"`
	UpdatedAt         string              `json:"updatedAt"`
	Status            AisRelayStatus      `json:"status"`
	Diagnostics       AisRelayDiagnostics `json:"diagnostics"`
	Disruptions       []AisDisruption     `json:"disruptions"`
	Density           []AisDensity        `json:"density"`
	CandidateReports  []AisVessel         `json:"candidateReports"`
	Vessels           []AisVessel         `json:"vessels"`
	HasVesselSnapshot bool                `json:"hasVesselSnapshot"`
}

// ---- OpenSky ----

// OpenSkyStateVector is OpenSkyStateVector. The JSON member order is the order
// NestJS reads and re-writes the region cache with.
type OpenSkyStateVector struct {
	ICAO24        string          `json:"icao24"`
	Callsign      string          `json:"callsign,omitempty"`
	CountryName   string          `json:"countryName,omitempty"`
	LastContactAt string          `json:"lastContactAt,omitempty"`
	LastContactMs int64           `json:"lastContactMs"`
	Longitude     *float64        `json:"longitude,omitempty"`
	Latitude      *float64        `json:"latitude,omitempty"`
	Heading       *float64        `json:"heading,omitempty"`
	AltitudeFt    *float64        `json:"altitudeFt,omitempty"`
	GroundSpeedKt *float64        `json:"groundSpeedKt,omitempty"`
	Raw           json.RawMessage `json:"raw"`
}

// openSkyTokenCache is the cached OAuth value.
type openSkyTokenCache struct {
	AccessToken string `json:"accessToken"`
}

// budgetDay is one day of the OpenSky ledger, read from the Redis hash.
type budgetDay struct {
	DateHKT               string
	UsedCredits           float64
	RequestCount          float64
	MilitaryCredits       float64
	AllCredits            float64
	MilitaryCalls         float64
	AllCalls              float64
	ErrorCalls            float64
	AuthErrorCalls        float64
	RateLimitedErrorCalls float64
	ServerErrorCalls      float64
	TimeoutErrorCalls     float64
	NetworkErrorCalls     float64
	UnknownErrorCalls     float64
	BlockedAllModeCount   float64
	SkippedMilitaryCount  float64
}

// budgetSummary is the subset of RealtimeOpenskyBudgetSummary the collector
// needs. It is computed from the ledger with the same rounding and degradation
// rules the diagnostics endpoint uses.
type budgetSummary struct {
	DateHKT                      string
	DailyBudget                  int
	UsedCredits                  float64
	RemainingCredits             float64
	UsagePct                     float64
	RemainingPct                 float64
	CurrentPeriod                string
	EffectiveMilitaryIntervalSec int
	DegradationLevel             string
	AllModeBlocked               bool
	MilitaryPaused               bool
}

// ---- external request errors ----

// UpstreamError codes mirror UpstreamRequestErrorCode.
const (
	codeDNSResolutionFailed = "dns_resolution_failed"
	codeRequestTimeout      = "request_timeout"
	codeNetworkError        = "network_error"
	codeUpstreamAuthFailed  = "upstream_auth_failed"
	codeUpstreamRateLimited = "upstream_rate_limited"
	codeUpstreamServerError = "upstream_server_error"
	codeFetchError          = "fetch_error"
)

// OpenSky error kinds mirror RealtimeOpenskyErrorKind.
const (
	kindAuth        = "auth"
	kindRateLimited = "rate_limited"
	kindServer      = "server"
	kindTimeout     = "timeout"
	kindNetwork     = "network"
	kindUnknown     = "unknown"
)

// DiagnosticErrorDetails is DiagnosticErrorDetails.
type DiagnosticErrorDetails struct {
	Code    string
	Kind    string
	Status  *float64
	Message string
}
