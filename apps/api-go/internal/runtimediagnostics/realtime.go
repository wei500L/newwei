package runtimediagnostics

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
)

// Realtime settings and diagnostics constants copied from the NestJS module.
var realtimeSources = []string{
	"opensky", "ais", "unrest", "outages", "keyword_spike", "pizzint", "gdelt_tension", "polymarket_leads",
}

var sourceMetricSlug = map[string]string{
	"opensky":          "realtime.opensky.military_flights",
	"ais":              "realtime.ais.disruptions",
	"unrest":           "realtime.unrest.events",
	"outages":          "realtime.outages.internet",
	"keyword_spike":    "realtime.keyword_spike.count",
	"pizzint":          "realtime.pizzint.defcon",
	"gdelt_tension":    "realtime.gdelt_tension.max_score",
	"polymarket_leads": "realtime.polymarket_leads.count",
}

const (
	markerWindowHours       = 24 * 7
	minAdsbStaleThreshold   = 10 * 60
	maxAdsbStaleThreshold   = 30 * 60
	openskyBudgetRecentDays = 7
)

var hktZone = time.FixedZone("Asia/Hong_Kong", 8*60*60)

// RealtimeSettingsPort is the data runtime settings surface. The production
// implementation is *dataruntimesettings.Service.
type RealtimeSettingsPort interface {
	EffectiveRealtimeRuntime(ctx context.Context) (*dataruntimesettings.RealtimeRuntimeSettings, error)
	EnvRealtimeRuntime() *dataruntimesettings.RealtimeRuntimeSettings
	RealtimeSettingsSource(ctx context.Context) (string, error)
}

// RealtimeService serves GET /api/system-settings/realtime-signals/runtime.
// Every operation is read-only: it never refreshes an ACLED token, writes a
// cache entry or triggers a collector.
type RealtimeService struct {
	settings RealtimeSettingsPort
	store    *realtimeStore
	now      func() time.Time
}

// NewRealtimeService wires the settings reader and the shared Redis/MySQL/Mongo
// connections. It opens no connection of its own.
func NewRealtimeService(settings RealtimeSettingsPort, redisClient *redis.Client, db *sql.DB, mongoDB *mongo.Database) *RealtimeService {
	return &RealtimeService{
		settings: settings,
		store:    newRealtimeStore(redisClient, db, mongoDB),
		now:      time.Now,
	}
}

// RealtimeResponse is the diagnostics body.
type realtimeResponse struct {
	CheckedAt       string               `json:"checkedAt"`
	SettingsSource  string               `json:"settingsSource"`
	RuntimeEnabled  bool                 `json:"runtimeEnabled"`
	Sources         []sourceDiagnostics  `json:"sources"`
	Insight         json.RawMessage      `json:"insight"`
	MarkerReadiness markerReadiness      `json:"markerReadiness"`
	OpenSkyBudget   openskyBudgetSummary `json:"openskyBudget"`
}

type sourceDiagnostics struct {
	Source                string                  `json:"source"`
	Enabled               bool                    `json:"enabled"`
	IntervalSec           int                     `json:"intervalSec"`
	ConfiguredIntervalSec *int                    `json:"configuredIntervalSec,omitempty"`
	Status                string                  `json:"status"`
	StatusReason          string                  `json:"statusReason,omitempty"`
	StatusReasonCode      string                  `json:"statusReasonCode,omitempty"`
	LastRunAt             *string                 `json:"lastRunAt,omitempty"`
	LastAttemptAt         *string                 `json:"lastAttemptAt,omitempty"`
	NextEligibleAt        *string                 `json:"nextEligibleAt,omitempty"`
	LastSuccessAt         *string                 `json:"lastSuccessAt,omitempty"`
	LastErrorAt           *string                 `json:"lastErrorAt,omitempty"`
	LastError             *string                 `json:"lastError,omitempty"`
	LastErrorCode         *string                 `json:"lastErrorCode,omitempty"`
	LastErrorKind         *string                 `json:"lastErrorKind,omitempty"`
	LastErrorStatus       *float64                `json:"lastErrorStatus,omitempty"`
	LastRateLimit         json.RawMessage         `json:"lastRateLimit,omitempty"`
	LatestValue           *float64                `json:"latestValue"`
	PreviousValue         *float64                `json:"previousValue"`
	ChangePercent         *float64                `json:"changePercent"`
	Context               diagnosticContext       `json:"context,omitempty"`
	AisDiagnostics        *aisRuntimeDiagnostics  `json:"aisDiagnostics,omitempty"`
	OpenskySnapshot       *adsbRuntimeDiagnostics `json:"openskySnapshot,omitempty"`
	AdsbSnapshot          *adsbRuntimeDiagnostics `json:"adsbSnapshot,omitempty"`
}

type openskyBudgetSummary struct {
	Timezone                     string              `json:"timezone"`
	DateHKT                      string              `json:"dateHkt"`
	DailyBudget                  int                 `json:"dailyBudget"`
	UsedCredits                  float64             `json:"usedCredits"`
	RemainingCredits             float64             `json:"remainingCredits"`
	UsagePct                     float64             `json:"usagePct"`
	RemainingPct                 float64             `json:"remainingPct"`
	RequestCount                 float64             `json:"requestCount"`
	MilitaryCredits              float64             `json:"militaryCredits"`
	AllCredits                   float64             `json:"allCredits"`
	MilitaryCalls                float64             `json:"militaryCalls"`
	AllCalls                     float64             `json:"allCalls"`
	ErrorCalls                   float64             `json:"errorCalls"`
	AuthErrorCalls               float64             `json:"authErrorCalls"`
	RateLimitedErrorCalls        float64             `json:"rateLimitedErrorCalls"`
	ServerErrorCalls             float64             `json:"serverErrorCalls"`
	TimeoutErrorCalls            float64             `json:"timeoutErrorCalls"`
	NetworkErrorCalls            float64             `json:"networkErrorCalls"`
	UnknownErrorCalls            float64             `json:"unknownErrorCalls"`
	BlockedAllModeCount          float64             `json:"blockedAllModeCount"`
	SkippedMilitaryCount         float64             `json:"skippedMilitaryCount"`
	CurrentPeriod                string              `json:"currentPeriod"`
	DayIntervalSec               int                 `json:"dayIntervalSec"`
	NightIntervalSec             int                 `json:"nightIntervalSec"`
	EffectiveMilitaryIntervalSec int                 `json:"effectiveMilitaryIntervalSec"`
	DegradationLevel             string              `json:"degradationLevel"`
	AllModeBlocked               bool                `json:"allModeBlocked"`
	MilitaryPaused               bool                `json:"militaryPaused"`
	WarningRemainingPct          int                 `json:"warningRemainingPct"`
	CriticalRemainingPct         int                 `json:"criticalRemainingPct"`
	RecentDays                   []openskyDaySummary `json:"recentDays"`
}

type openskyDaySummary struct {
	DateHKT               string  `json:"dateHkt"`
	UsedCredits           float64 `json:"usedCredits"`
	RequestCount          float64 `json:"requestCount"`
	MilitaryCredits       float64 `json:"militaryCredits"`
	AllCredits            float64 `json:"allCredits"`
	MilitaryCalls         float64 `json:"militaryCalls"`
	AllCalls              float64 `json:"allCalls"`
	ErrorCalls            float64 `json:"errorCalls"`
	AuthErrorCalls        float64 `json:"authErrorCalls"`
	RateLimitedErrorCalls float64 `json:"rateLimitedErrorCalls"`
	ServerErrorCalls      float64 `json:"serverErrorCalls"`
	TimeoutErrorCalls     float64 `json:"timeoutErrorCalls"`
	NetworkErrorCalls     float64 `json:"networkErrorCalls"`
	UnknownErrorCalls     float64 `json:"unknownErrorCalls"`
	BlockedAllModeCount   float64 `json:"blockedAllModeCount"`
	SkippedMilitaryCount  float64 `json:"skippedMilitaryCount"`
}

// adsbRuntimeDiagnostics is buildAdsbRuntimeDiagnostics.
type adsbRuntimeDiagnostics struct {
	Freshness                   string  `json:"freshness"`
	RawAircraftCount            int     `json:"rawAircraftCount"`
	CurrentValidPositionCount   int     `json:"currentValidPositionCount"`
	SnapshotValidPositionCount  int     `json:"snapshotValidPositionCount"`
	SnapshotUpdatedAt           *string `json:"snapshotUpdatedAt,omitempty"`
	SnapshotAgeSec              *int    `json:"snapshotAgeSec,omitempty"`
	LatestObservedAt            *string `json:"latestObservedAt,omitempty"`
	LatestObservedAgeSec        *int    `json:"latestObservedAgeSec,omitempty"`
	StaleThresholdSec           int     `json:"staleThresholdSec"`
	RetainedPreviousSnapshot    bool    `json:"retainedPreviousSnapshot"`
	DroppedInvalidPositionCount int     `json:"droppedInvalidPositionCount"`
	DroppedMissingIdentityCount int     `json:"droppedMissingIdentityCount"`
	DroppedStalePositionCount   int     `json:"droppedStalePositionCount"`
	DeduplicatedCount           int     `json:"deduplicatedCount"`
}

// aisRuntimeDiagnostics is RealtimeAisRuntimeDiagnostics.
type aisRuntimeDiagnostics struct {
	Configured               bool    `json:"configured"`
	Connected                bool    `json:"connected"`
	HealthState              string  `json:"healthState"`
	SnapshotUpdatedAt        *string `json:"snapshotUpdatedAt,omitempty"`
	AllVesselsAvailable      bool    `json:"allVesselsAvailable"`
	CandidateCount           int     `json:"candidateCount"`
	VesselCount              int     `json:"vesselCount"`
	DisruptionsCount         int     `json:"disruptionsCount"`
	DensityRegions           int     `json:"densityRegions"`
	MessageCount             int     `json:"messageCount"`
	DroppedMessages          int     `json:"droppedMessages"`
	PositionReportsSeen      int     `json:"positionReportsSeen"`
	PositionReportsProcessed int     `json:"positionReportsProcessed"`
	IgnoredPositionReports   int     `json:"ignoredPositionReports"`
	ParseErrors              int     `json:"parseErrors"`
	StatusReasonCode         string  `json:"statusReasonCode,omitempty"`
	StatusReason             string  `json:"statusReason,omitempty"`
	LastHealthyAt            *string `json:"lastHealthyAt,omitempty"`
	LastIssueAt              *string `json:"lastIssueAt,omitempty"`
	LastConnectedAt          *string `json:"lastConnectedAt,omitempty"`
	LastMessageAt            *string `json:"lastMessageAt,omitempty"`
	LastUpstreamErrorAt      *string `json:"lastUpstreamErrorAt,omitempty"`
	LastUpstreamError        *string `json:"lastUpstreamError,omitempty"`
	LastParseErrorAt         *string `json:"lastParseErrorAt,omitempty"`
	LastParseError           *string `json:"lastParseError,omitempty"`
}

type aisRuntimeSemantics struct {
	diagnostics      aisRuntimeDiagnostics
	statusReasonCode string
	statusReason     string
}

type snapshotEvaluation struct {
	latest        *float64
	previous      *float64
	changePercent *float64
	context       diagnosticContext
}

// Run executes the read-only diagnostics.
func (s *RealtimeService) Run(ctx context.Context, orgID string) (realtimeResponse, error) {
	runtime, err := s.settings.EffectiveRealtimeRuntime(ctx)
	if err != nil {
		log.Printf("runtimediagnostics: realtime settings read failed, using env fallback")
		runtime = s.settings.EnvRealtimeRuntime()
	}
	if runtime == nil {
		return realtimeResponse{}, err
	}
	settingsSource, err := s.settings.RealtimeSettingsSource(ctx)
	if err != nil {
		log.Printf("runtimediagnostics: realtime settings source read failed, using unknown")
		settingsSource = "unknown"
	}

	nowMs := s.now().UnixMilli()
	now := s.now()

	insight, err := s.store.insight(ctx, orgID)
	if err != nil {
		return realtimeResponse{}, err
	}
	if len(insight) == 0 {
		insight = emptyInsightSnapshot()
	}
	markerReadiness := s.store.readMarkerReadiness(ctx, orgID, now)
	adsb, err := s.store.latestAdsb(ctx, orgID)
	if err != nil {
		return realtimeResponse{}, err
	}
	ais, err := s.store.latestAis(ctx, orgID)
	if err != nil {
		return realtimeResponse{}, err
	}
	budget, err := s.budgetSummary(ctx, runtime, nowMs)
	if err != nil {
		return realtimeResponse{}, err
	}

	sources := make([]sourceDiagnostics, 0, len(realtimeSources))
	for _, source := range realtimeSources {
		entry, err := s.sourceDiagnostics(ctx, orgID, source, runtime, budget, adsb, ais, nowMs)
		if err != nil {
			return realtimeResponse{}, err
		}
		sources = append(sources, entry)
	}

	return realtimeResponse{
		CheckedAt:       s.now().UTC().Format("2006-01-02T15:04:05.000Z"),
		SettingsSource:  settingsSource,
		RuntimeEnabled:  runtime.Enabled,
		Sources:         sources,
		Insight:         insight,
		MarkerReadiness: markerReadiness,
		OpenSkyBudget:   budget,
	}, nil
}

func (s *RealtimeService) sourceDiagnostics(ctx context.Context, orgID, source string, runtime *dataruntimesettings.RealtimeRuntimeSettings, budget openskyBudgetSummary, adsb *adsbSnapshot, ais *aisSnapshot, nowMs int64) (sourceDiagnostics, error) {
	enabled, intervalSec, configuredInterval := sourceConfig(runtime, source)
	if source == "opensky" {
		// NestJS uses the budget-aware military interval for this source and
		// reports the configured interval separately.
		intervalSec = budget.EffectiveMilitaryIntervalSec
	}
	state, err := s.store.sourceState(ctx, orgID, source)
	if err != nil {
		return sourceDiagnostics{}, err
	}
	lastRunMs, err := s.store.lastRun(ctx, orgID, source)
	if err != nil {
		return sourceDiagnostics{}, err
	}
	evaluation, err := s.evaluateMetric(ctx, orgID, sourceMetricSlug[source], changeWindow(intervalSec), nowMs)
	if err != nil {
		return sourceDiagnostics{}, err
	}

	evaluationContext := evaluation.context
	var stateContext diagnosticContext
	if state != nil {
		stateContext = state.Context
	}
	merged := evaluationContext.merge(stateContext)

	entry := sourceDiagnostics{
		Source:        source,
		Enabled:       enabled,
		IntervalSec:   intervalSec,
		Status:        "",
		LatestValue:   evaluation.latest,
		PreviousValue: evaluation.previous,
		ChangePercent: evaluation.changePercent,
		Context:       merged,
	}
	if configuredInterval != nil {
		entry.ConfiguredIntervalSec = configuredInterval
	}
	if lastRunMs != nil {
		iso := time.UnixMilli(int64(*lastRunMs)).UTC().Format("2006-01-02T15:04:05.000Z")
		entry.LastRunAt = &iso
	}
	if state != nil {
		entry.LastAttemptAt = state.LastAttemptAt
		entry.NextEligibleAt = state.NextEligibleAt
		entry.LastSuccessAt = state.LastSuccessAt
		entry.LastErrorAt = state.LastErrorAt
		entry.LastError = state.LastError
		entry.LastErrorCode = state.LastErrorCode
		entry.LastErrorKind = state.LastErrorKind
		entry.LastErrorStatus = state.LastErrorStatus
		if len(state.LastRateLimit) > 0 {
			entry.LastRateLimit = state.LastRateLimit
		}
	}

	var aisSemantics *aisRuntimeSemantics
	if source == "ais" {
		semantics := buildAisRuntimeSemantics(ais, state)
		aisSemantics = &semantics
		entry.AisDiagnostics = &semantics.diagnostics
	}
	if source == "opensky" {
		raw, valid := 0, 0
		if merged != nil {
			if value, ok := merged.number("totalAircraft"); ok {
				raw = int(value)
			}
			if value, ok := merged.number("validPositionCount"); ok {
				valid = int(value)
			}
		}
		snapshot := buildAdsbRuntimeDiagnostics(adsb, raw, valid, nowMs, intervalSec)
		entry.OpenskySnapshot = &snapshot
		entry.AdsbSnapshot = &snapshot
	}

	status, code, reason := resolveRuntimeSourceStatus(source, enabled, intervalSec, state, lastRunMs, merged, aisSemantics, nowMs)
	entry.Status = status
	entry.StatusReasonCode = code
	entry.StatusReason = reason
	return entry, nil
}

func sourceConfig(runtime *dataruntimesettings.RealtimeRuntimeSettings, source string) (bool, int, *int) {
	switch source {
	case "opensky":
		configured := runtime.OpenskyIntervalSec
		return runtime.OpenskyEnabled, configured, &configured
	case "ais":
		return runtime.AisEnabled, runtime.AisIntervalSec, nil
	case "unrest":
		return runtime.UnrestEnabled, runtime.UnrestIntervalSec, nil
	case "outages":
		return runtime.OutagesEnabled, runtime.OutagesIntervalSec, nil
	case "keyword_spike":
		return runtime.KeywordSpikeEnabled, runtime.KeywordSpikeIntervalSec, nil
	case "pizzint":
		return runtime.PizzintEnabled, runtime.PizzintIntervalSec, nil
	case "gdelt_tension":
		return runtime.GdeltTensionEnabled, runtime.GdeltTensionIntervalSec, nil
	case "polymarket_leads":
		return runtime.PolymarketLeadsEnabled, runtime.PolymarketLeadsIntervalSec, nil
	default:
		return false, 0, nil
	}
}

func changeWindow(intervalSec int) int {
	window := int(math.Round(float64(intervalSec) / 60))
	if window < 60 {
		return 60
	}
	return window
}

func emptyInsightSnapshot() json.RawMessage {
	return json.RawMessage(`{"keywordSpikes":[],"predictionLeads":[],"tensions":[]}`)
}

// evaluateMetric mirrors RealtimeSignalsSnapshotStore.evaluateMetric.
func (s *RealtimeService) evaluateMetric(ctx context.Context, orgID, metricSlug string, windowMin int, nowMs int64) (snapshotEvaluation, error) {
	points, err := s.store.series(ctx, orgID, metricSlug)
	if err != nil {
		return snapshotEvaluation{}, err
	}
	return evaluatePoints(points, windowMin, nowMs), nil
}

// evaluatePoints is the pure evaluation shared by the service and the unit
// tests. It mirrors RealtimeSignalsSnapshotStore.evaluateMetric.
func evaluatePoints(points []metricPoint, windowMin int, nowMs int64) snapshotEvaluation {
	if len(points) == 0 {
		return snapshotEvaluation{}
	}
	latestPoint := points[len(points)-1]
	latestTS, hasLatestTS := parseTimestampMs(latestPoint.TS)
	if windowMin < 1 {
		windowMin = 1
	}
	maxStaleMin := windowMin * 2
	if maxStaleMin < 5 {
		maxStaleMin = 5
	}
	if hasLatestTS && nowMs-latestTS > int64(maxStaleMin)*60_000 {
		context := latestPoint.Context.merge(nil)
		if context == nil {
			context = diagnosticContext{}
		}
		context["stale"] = json.RawMessage("true")
		context["latestTimestamp"] = mustJSON(latestPoint.TS)
		context["maxStaleMinutes"] = mustJSON(maxStaleMin)
		return snapshotEvaluation{context: context}, nil
	}

	var previousPoint *metricPoint
	if hasLatestTS {
		target := latestTS - int64(windowMin)*60_000
		for index := len(points) - 2; index >= 0; index-- {
			candidateTS, ok := parseTimestampMs(points[index].TS)
			if !ok {
				continue
			}
			if candidateTS <= target {
				value := points[index]
				previousPoint = &value
				break
			}
		}
	}
	if previousPoint == nil && len(points) > 1 {
		value := points[len(points)-2]
		previousPoint = &value
	}

	latest := latestPoint.Value
	result := snapshotEvaluation{latest: &latest, context: latestPoint.Context}
	if previousPoint != nil {
		previous := previousPoint.Value
		result.previous = &previous
		if previous != 0 {
			change := ((latest - previous) / previous) * 100
			if !math.IsNaN(change) && !math.IsInf(change, 0) {
				result.changePercent = &change
			}
		}
	}
	return result, nil
}

func mustJSON(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

func parseTimestampMs(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999Z0700", "2006-01-02T15:04:05"} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UnixMilli(), true
		}
	}
	return 0, false
}
