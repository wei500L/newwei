package realtimesignals

import "time"

// SignalSource is one entry of REALTIME_SIGNAL_SOURCES. The string values are the
// Redis key segments, the JSON discriminators and the metric-slug owners, so they
// are part of the stored contract.
type SignalSource string

const (
	SourceOpensky         SignalSource = "opensky"
	SourceAis             SignalSource = "ais"
	SourceUnrest          SignalSource = "unrest"
	SourceOutages         SignalSource = "outages"
	SourceKeywordSpike    SignalSource = "keyword_spike"
	SourcePizzint         SignalSource = "pizzint"
	SourceGdeltTension    SignalSource = "gdelt_tension"
	SourcePolymarketLeads SignalSource = "polymarket_leads"
)

// sourceOrder is REALTIME_SIGNAL_SOURCES. Collection order is observable because
// each source writes its own point and state, and the insight snapshot merges in
// this order.
var sourceOrder = []SignalSource{
	SourceOpensky,
	SourceAis,
	SourceUnrest,
	SourceOutages,
	SourceKeywordSpike,
	SourcePizzint,
	SourceGdeltTension,
	SourcePolymarketLeads,
}

// Metric slugs. These are read by the alert worker and by the diagnostics
// endpoint, so they must never change without a data migration.
const (
	metricOpensky               = "realtime.opensky.military_flights"
	metricOpenskySnapshotHealth = "realtime.opensky.snapshot_health"
	metricAis                   = "realtime.ais.disruptions"
	metricUnrest                = "realtime.unrest.events"
	metricOutages               = "realtime.outages.internet"
	metricKeywordSpike          = "realtime.keyword_spike.count"
	metricPizzint               = "realtime.pizzint.defcon"
	metricGdeltTension          = "realtime.gdelt_tension.max_score"
	metricPolymarketLeads       = "realtime.polymarket_leads.count"
)

// Fixed intervals, TTLs and limits from realtime-signals.constants.ts and the
// collector services.
const (
	seriesTTLSeconds   = 60 * 60 * 24 * 2
	seriesMaxPoints    = 2000
	ingestLockTTL      = 5 * 60 * 1000
	tickGateKey        = "cron:realtime-signals:tick-gate"
	tickGateTTL        = 55 * 1000
	sourceLastRunTTL   = 60 * 60 * 24 * 7
	sourceStateTTL     = 60 * 60 * 24 * 7
	insightTTLSeconds  = 60 * 60 * 12
	adsbLatestKeyFmt   = "realtime-signals:opensky-latest:"
	aisLatestKeyFmt    = "realtime-signals:ais-latest:"
	seriesKeyFmt       = "realtime-signals:series:"
	lastRunKeyFmt      = "realtime-signals:last-run:"
	insightKeyFmt      = "realtime-signals:insights:"
	sourceStateKeyFmt  = "realtime-signals:source-state:"
	orgLockKeyFmt      = "cron:realtime-signals:org:"
	allCaptureLockKey  = "cron:realtime-signals:opensky-all-capture"
	minSourceInterval  = 10
	insightFreshMinSec = 5 * 60
)

// Age based thresholds shared with the ADS-B helpers.
const (
	feetPerMeter              = 3.28084
	knotsPerMeterPerSecond    = 1.94384
	minAdsbStaleThresholdSec  = 10 * 60
	maxAdsbStaleThresholdSec  = 30 * 60
	globalAllCaptureInterval  = 15 * 60
	openskyRegionCacheTTL     = 60
	openskyLockTTL            = 20 * time.Second
	openskyLockWait           = 10 * time.Second
	openskyLockRetryDelay     = 100 * time.Millisecond
	openskyBudgetRetentionDay = 14
	openskyBudgetRecentDays   = 7
	openskyHKTOffsetSeconds   = 8 * 60 * 60
	openskyDefaultBaseURL     = "https://opensky-network.org/api"
	openskyDefaultTokenURL    = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
	openskyAllCaptureLastRun  = "realtime-signals:opensky:all-capture:last-run"
	openskyAllCaptureCursor   = "realtime-signals:opensky:all-capture:cursor"
	openskyAllCaptureTTL      = 60 * 60 * 24 * 7
	openskyAllCaptureCursorTT = 60 * 60 * 24 * 30
	openskyRegionKeyFmt       = "realtime-signals:opensky:region:"
	openskyCreditsKeyFmt      = "realtime-signals:opensky:credits:"
	openskyOAuthKeyFmt        = "realtime-signals:opensky:oauth:"
	polymarketPricesKeyFmt    = "realtime-signals:polymarket:prices:"
	polymarketPricesTTL       = 60 * 60 * 24
	processedTermCoverageKey  = "realtime-signals:processed-article-term-coverage:"
	processedTermCoverageTTL  = 300
	aisSnapshotMinTTL         = 10 * 60
	adsbSnapshotMinTTL        = 20 * 60
)

// hktZone is the OpenSky ledger's day boundary. Hong Kong has had no daylight
// saving since 1979, so a fixed +08:00 zone is exact and cheaper than a tz
// database lookup. NestJS uses Intl.DateTimeFormat with Asia/Hong_Kong, which
// resolves to the same offsets for every timestamp this collector handles.
var hktZone = time.FixedZone("Asia/Hong_Kong", openskyHKTOffsetSeconds)

// openskyMilitaryRegions is OPENSKY_MILITARY_QUERY_REGIONS. The credit cost per
// region is fixed at 4 regardless of the bbox area (the same value the NestJS
// constant carries), while viewport/all-capture requests use estimateCredits.
var openskyMilitaryRegions = []struct {
	Key     string
	BBox    [4]float64
	Credits int
}{
	{"america", [4]float64{-130, 24, -60, 55}, 4},
	{"eu", [4]float64{-15, 35, 40, 65}, 4},
	{"mena", [4]float64{-20, 12, 65, 45}, 4},
	{"asia", [4]float64{95, 18, 150, 52}, 4},
	{"oceania", [4]float64{110, -47, 180, 5}, 4},
	{"arctic", [4]float64{-80, 55, 60, 85}, 4},
}

// openskyAllCaptureRegions is OPENSKY_ALL_CAPTURE_QUERY_REGIONS.
var openskyAllCaptureRegions = []struct {
	Key  string
	BBox [4]float64
}{
	{"america", [4]float64{-130, 24, -60, 55}},
	{"eu", [4]float64{-15, 35, 40, 65}},
	{"mena", [4]float64{-20, 12, 65, 45}},
	{"asia", [4]float64{95, 18, 150, 52}},
	{"latam", [4]float64{-120, -60, -30, 25}},
	{"africa", [4]float64{-20, -35, 55, 37}},
	{"oceania", [4]float64{110, -47, 180, 5}},
}

// External endpoints. The collector uses these exact URLs.
const (
	acledAPIURL          = "https://acleddata.com/api/acled/read"
	gdeltUnrestGeoJSON   = "https://api.gdeltproject.org/api/v1/gkg_geojson"
	cloudflareOutagesURL = "https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&limit=50"
	pizzintDashboardURL  = "https://www.pizzint.watch/api/dashboard-data"
	pizzintTensionURL    = "https://www.pizzint.watch/api/gdelt/batch"
	polymarketDefaultURL = "https://gamma-api.polymarket.com"
)

// gdeltTensionPairs order is the batch query order and therefore the insight
// order when two rows share a score.
var gdeltTensionPairs = []string{
	"usa_russia",
	"russia_ukraine",
	"usa_china",
	"china_taiwan",
	"usa_iran",
	"usa_venezuela",
}

// countryTokenToAlpha2 maps the GDELT pair tokens to the two-letter codes the
// insight snapshot stores.
var countryTokenToAlpha2 = map[string]string{
	"usa":       "US",
	"us":        "US",
	"russia":    "RU",
	"ukraine":   "UA",
	"china":     "CN",
	"taiwan":    "TW",
	"iran":      "IR",
	"venezuela": "VE",
}

// simpleStopwords is the processed-article stopword set. It is duplicated from
// the NestJS indexing helper because keyword extraction is part of the stored
// keyword-spike contract.
var simpleStopwords = map[string]struct{}{
	"this": {}, "that": {}, "with": {}, "from": {}, "will": {}, "have": {},
	"about": {}, "their": {}, "there": {}, "after": {}, "before": {}, "where": {},
	"which": {}, "while": {}, "into": {}, "within": {}, "across": {}, "against": {},
	"under": {}, "between": {}, "said": {}, "says": {}, "report": {}, "reports": {},
	"update": {}, "latest": {}, "breaking": {}, "market": {}, "global": {},
	"world": {}, "news": {}, "analysis": {}, "today": {}, "live": {},
}

// Transport persistence thresholds and the Mongo collection names.
const (
	transportStateCollection = "maptransportobjectstates"
	transportTrackCollection = "maptransporttrackpoints"
	transportGeoCellStep     = 0.5
	transportHeartbeatMs     = 10 * 60 * 1000
	transportDistanceKm      = 2
	transportAngleDeg        = 15
	transportSpeedKt         = 5
	transportAltitudeFt      = 1000
	earthRadiusKm            = 6371
)
