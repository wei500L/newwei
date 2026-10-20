package newssourcescheduler

import (
	"encoding/json"
	"time"
)

// Redis keys. Every key is built exactly like the NestJS service so the two
// implementations are mutually exclusive while a switch flip leaves both
// schedulers alive.
const (
	// schedulerLockKey is CacheService.withLock("cron:news-source-scheduler");
	// withLock adds the physical "lock:" prefix itself.
	schedulerLockKey = "cron:news-source-scheduler"
	// dispatchLockPrefix is CacheService.withLock(`news-source-dispatch:{id}`);
	// the helper adds the "lock:" prefix itself.
	dispatchLockPrefix = "news-source-dispatch:"
	// dispatchLockTTL is the 60s manual dispatch lease.
	dispatchLockTTL = 60 * time.Second
)

// schedulerDispatchDedupeWindowMs is SCHEDULER_DISPATCH_DEDUPE_WINDOW_MS: the
// shared 25-second dispatch window used by BOTH the cron and manual dispatch.
const schedulerDispatchDedupeWindowMs = 25_000

// backpressureKey is the legacy backpressure marker.
func backpressureKey(sourceID string) string {
	return "news-source:backpressure:" + sourceID
}

// backpressureCountKey is the 24h backpressure hit counter.
func backpressureCountKey(sourceID string) string {
	return "news-source:backpressure-count:" + sourceID
}

// backpressureNotifyKey is the per-organization 30-minute notification gate.
func backpressureNotifyKey(orgID string) string {
	return "news-source:backpressure-notify:" + orgID
}

// rssAdaptiveStateKey is the legacy RSS adaptive state key.
func rssAdaptiveStateKey(sourceID string) string {
	return "news-source:rss-adaptive:" + sourceID
}

// listRuntimeKey is NewsSourceOpsSnapshotService.runtimeCacheKey.
func listRuntimeKey(sourceID string) string {
	return "news-source:list-runtime:" + sourceID
}

// runtimeStateTTLSeconds is NEWS_SOURCE_LIST_RUNTIME_TTL_SECONDS.
const runtimeStateTTLSeconds = 30 * 24 * 60 * 60

// backpressureLookbackMs is BACKPRESSURE_LOOKBACK_MS.
const backpressureLookbackMs = 24 * 60 * 60 * 1000

// RSS adaptive state retention and history size.
const (
	rssAdaptiveStateTTLSeconds = 30 * 24 * 60 * 60
	rssAdaptiveHistorySize     = 8
)

// Metric windows and thresholds.
const (
	sourceMetricWindowTTLSeconds     = 24 * 60 * 60
	sourceMetricAlertCooldownSeconds = 60 * 60
	rssNoBodySkipAlertThreshold      = 20
	pipelineRetryAlertThreshold      = 10
)

// Seed defaults (the DEFAULT_* constants of the NestJS service and settings
// service).
const (
	defaultSeedFreshnessWindowDays     = 365
	maxSeedFreshnessWindowDays         = 3_650
	defaultSeedCacheTTLSecondsSitemap  = 60
	defaultSeedCacheTTLSecondsListDeep = 180
	defaultSeedCacheTTLForceGlobal     = false

	defaultRSSAdaptiveHotHitRatePercent               = 60
	defaultRSSAdaptiveWarmHitRatePercent              = 25
	defaultRSSAdaptiveColdConsecutiveNoHitRuns        = 4
	defaultRSSAdaptiveHotIntervalSeconds              = 30
	defaultRSSAdaptiveWarmIntervalDivisor             = 2
	defaultRSSAdaptiveWarmMinIntervalSeconds          = 30
	defaultRSSAdaptiveColdIntervalMultiplier          = 2
	defaultRSSAdaptiveColdMaxIntervalSeconds          = 3_600
	defaultRSSAdaptiveHotDiscoveryCacheTTLCapSeconds  = 30
	defaultRSSAdaptiveWarmDiscoveryCacheTTLCapSeconds = 60
	minRSSAdaptiveIntervalSeconds                     = 10
	maxRSSAdaptiveIntervalSeconds                     = 21_600
	minSeedCacheTTLSeconds                            = 10
	maxSeedCacheTTLSeconds                            = 3_600
	minSeedFreshnessWindowDays                        = 1
	defaultItemQueueName                              = "itemPipeline"
	seedDiscoveryCacheLockTTL                         = 15 * time.Second
	seedDiscoveryCacheMaxWait                         = 15 * time.Second
	seedDiscoveryCacheRetryDelay                      = 100 * time.Millisecond
	minCronIterationsBeforeWindowFallback             = 200
	sourcePriorityMin                                 = -100
	sourcePriorityMax                                 = 100
	crawlHotPriorityThreshold                         = 50
	itemMetaNameMaxLength                             = 191
	displayNameMaxLength                              = 80
	deepDiscoveryFailureStateTTLSeconds               = 7 * 24 * 60 * 60
	deepDiscoveryFailureStatsTTLSeconds               = 24 * 60 * 60
	notificationRelayChannel                          = "news-source:notifications:v1"
	notificationRelayVersion                          = 1
	pipelineDispatchReasonDeduped                     = "deduped"
	pipelineDispatchReasonInFlight                    = "in_flight"
	pipelineDispatchReasonNoNewURLs                   = "no_new_urls"
	pipelineDispatchReasonOK                          = "ok"
	metricsContextSchedule                            = "schedule"
	metricsContextDispatchNow                         = "dispatch_now"
	presentationKindBackpressure                      = "news_source_scheduler_backpressure"
	presentationKindRSSBodyMissingSpike               = "news_source_rss_body_missing_spike"
	presentationKindPipelineRetrySpike                = "news_source_pipeline_retry_spike"
	deepDiscoveryErrorCodePrefix                      = "SEED_DEEP_"
	deepDiscoveryUnknownErrorCode                     = "SEED_DEEP_UNKNOWN"
)

// Settings is the resolved scheduler configuration. It mirrors
// EnvService.newsSourceSchedulerConfig plus the Go-only source concurrency.
type Settings struct {
	Enabled                    bool
	BatchSize                  int
	LockTTL                    time.Duration
	InFlightLookback           time.Duration
	InFlightRescheduleDelay    time.Duration
	JitterMax                  time.Duration
	MaxEnqueuePerTick          int
	BackpressureMaxPendingJobs int
	BackpressureDelay          time.Duration
	FailureRecoveryDelay       time.Duration
	FailureMaxDelay            time.Duration
	CircuitBreakerThreshold    int
	CircuitBreakerBaseDelay    time.Duration
	CircuitBreakerMaxDelay     time.Duration
	SourceConcurrency          int
}

// source is NewsSource plus the crawlTemplate projection the dispatcher reads.
type source struct {
	ID                  string
	OrgID               string
	Name                string
	URL                 string
	SiteType            string
	Language            *string
	CrawlTemplateID     *string
	WorkflowID          *string
	WorkflowVersionID   *string
	WorkflowBindingMode string
	FrequencySeconds    int
	Priority            int
	IsActive            bool
	Config              json.RawMessage
	LastRunAt           *time.Time
	NextRunAt           *time.Time
	UpdatedAt           time.Time

	CrawlTemplateActive  bool
	CrawlTemplateOptions json.RawMessage
}

// seedMode is SeedConfig["mode"].
type seedMode string

const (
	seedModeSitemap seedMode = "sitemap"
	seedModeRSS     seedMode = "rss"
	seedModeList    seedMode = "list"
	seedModeDeep    seedMode = "deep"
)

// seedCacheTTLPolicy is whichever branch resolved the discovery cache TTL.
type seedCacheTTLPolicy string

const (
	seedCacheTTLPolicyModeDefault    seedCacheTTLPolicy = "mode_default"
	seedCacheTTLPolicySourceOverride seedCacheTTLPolicy = "source_override"
	seedCacheTTLPolicyGlobalForced   seedCacheTTLPolicy = "global_forced"
)

// rssFetchConfig is ResolvedRssFetchConfig.
type rssFetchConfig struct {
	Enabled            bool
	RequestTimeoutMs   int
	BodySourceStrategy string
	NoBodyPolicy       string
}

// deepSeedConfig is DeepSeedConfig.
type deepSeedConfig struct {
	MaxPages            int
	MaxDepth            int
	TimeBudgetSeconds   int
	PageConcurrency     int
	ScoreThreshold      float64
	CandidatePoolSize   int
	HeadFetchTopK       int
	PreferPathDate      bool
	EnableSecondaryHubs bool
	IgnoreRobotsTxt     bool
}

// seedConfig is SeedConfig.
type seedConfig struct {
	Enabled             bool
	Mode                seedMode
	RSSAdaptiveEnabled  bool
	Domain              *string
	Pattern             *string
	FeedURL             *string
	RSSFetch            *rssFetchConfig
	MaxURLs             int
	MaxNewURLsPerRun    int
	ListMaxPages        int
	ListPageConcurrency int
	FollowPagination    bool
	QueryTokens         []string
	ScoreThreshold      float64
	DedupeWindowHours   int
	QueryParamAllowlist []string
	CacheTTLSeconds     int
	CacheTTLPolicy      seedCacheTTLPolicy
	Deep                *deepSeedConfig
}

// seedRuntimeSettings is SeedRuntimeSettings.
type seedRuntimeSettings struct {
	SeedFreshnessWindowDays                    int
	SeedCacheTTLSecondsSitemapRSS              int
	SeedCacheTTLSecondsListDeep                int
	SeedCacheTTLForceGlobal                    bool
	SeedURLQueryParamAllowlist                 []string
	RSSAdaptiveHotHitRatePercent               int
	RSSAdaptiveWarmHitRatePercent              int
	RSSAdaptiveColdConsecutiveNoHitRuns        int
	RSSAdaptiveHotIntervalSeconds              int
	RSSAdaptiveWarmIntervalDivisor             int
	RSSAdaptiveWarmMinIntervalSeconds          int
	RSSAdaptiveColdIntervalMultiplier          int
	RSSAdaptiveColdMaxIntervalSeconds          int
	RSSAdaptiveHotDiscoveryCacheTTLCapSeconds  int
	RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds int
}

// defaultSeedRuntimeSettings is DEFAULT_SEED_RUNTIME_SETTINGS.
func defaultSeedRuntimeSettings() seedRuntimeSettings {
	return seedRuntimeSettings{
		SeedFreshnessWindowDays:                    defaultSeedFreshnessWindowDays,
		SeedCacheTTLSecondsSitemapRSS:              defaultSeedCacheTTLSecondsSitemap,
		SeedCacheTTLSecondsListDeep:                defaultSeedCacheTTLSecondsListDeep,
		SeedCacheTTLForceGlobal:                    defaultSeedCacheTTLForceGlobal,
		SeedURLQueryParamAllowlist:                 defaultURLQueryParamAllowlist(),
		RSSAdaptiveHotHitRatePercent:               defaultRSSAdaptiveHotHitRatePercent,
		RSSAdaptiveWarmHitRatePercent:              defaultRSSAdaptiveWarmHitRatePercent,
		RSSAdaptiveColdConsecutiveNoHitRuns:        defaultRSSAdaptiveColdConsecutiveNoHitRuns,
		RSSAdaptiveHotIntervalSeconds:              defaultRSSAdaptiveHotIntervalSeconds,
		RSSAdaptiveWarmIntervalDivisor:             defaultRSSAdaptiveWarmIntervalDivisor,
		RSSAdaptiveWarmMinIntervalSeconds:          defaultRSSAdaptiveWarmMinIntervalSeconds,
		RSSAdaptiveColdIntervalMultiplier:          defaultRSSAdaptiveColdIntervalMultiplier,
		RSSAdaptiveColdMaxIntervalSeconds:          defaultRSSAdaptiveColdMaxIntervalSeconds,
		RSSAdaptiveHotDiscoveryCacheTTLCapSeconds:  defaultRSSAdaptiveHotDiscoveryCacheTTLCapSeconds,
		RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds: defaultRSSAdaptiveWarmDiscoveryCacheTTLCapSeconds,
	}
}

// canonicalSeedJob is CanonicalSeedJob: one deduped, URL-normalized candidate.
type canonicalSeedJob struct {
	URL               string
	URLFingerprint    string
	RelevanceScore    *float64
	PublishedAtTs     *int64
	CrawledAtTs       *int64
	EffectiveTs       *int64
	TimestampSource   string
	PrefetchedArticle *prefetchedArticle
}

// prefetchedArticle is CrawlDiscoveryPrefetchedArticle. The JSON tags are the
// discovery-cache shape both implementations read.
type prefetchedArticle struct {
	Title       *string         `json:"title,omitempty"`
	Description *string         `json:"description,omitempty"`
	Author      *string         `json:"author,omitempty"`
	Markdown    string          `json:"markdown"`
	PublishedAt *string         `json:"publishedAt,omitempty"`
	Metadata    json.RawMessage `json:"metadata,omitempty"`
}

// discoveredCandidate is the normalized CrawlDiscoveryCandidate used between
// discovery and canonicalization.
type discoveredCandidate struct {
	URL               string
	RelevanceScore    *float64
	PublishedAtTs     *int64
	CrawledAtTs       *int64
	PrefetchedArticle *prefetchedArticle
}

// rssAdaptiveTier is RssAdaptiveTier.
type rssAdaptiveTier string

const (
	rssAdaptiveTierHot    rssAdaptiveTier = "hot"
	rssAdaptiveTierWarm   rssAdaptiveTier = "warm"
	rssAdaptiveTierNormal rssAdaptiveTier = "normal"
	rssAdaptiveTierCold   rssAdaptiveTier = "cold"
)

// rssAdaptiveState is RssAdaptiveState.
type rssAdaptiveState struct {
	Outcomes         []bool
	ConsecutiveNoHit int
	UpdatedAt        string
}

// cronWindow is CronWindowConfig.
type cronWindow struct {
	DaysOfWeek []int
	StartHour  *int
	EndHour    *int
}

// cronSchedule is CronScheduleConfig.
type cronSchedule struct {
	Expression string
	Timezone   *string
	Window     *cronWindow
}

// dispatchOutcome is the per-source result of dispatchSource.
type dispatchOutcome struct {
	SourceID              string   `json:"sourceId"`
	Mode                  string   `json:"mode"`
	ScheduledFor          string   `json:"scheduledFor"`
	NextRunAt             string   `json:"nextRunAt"`
	ScheduledCount        int      `json:"scheduledCount"`
	SkippedCount          int      `json:"skippedCount"`
	RSSSkippedNoBodyCount *int     `json:"rssSkippedNoBodyCount,omitempty"`
	EnqueueFailures       int      `json:"enqueueFailures"`
	PipelineJobIDs        []string `json:"pipelineJobIds"`
	CrawlTaskIDs          []string `json:"crawlTaskIds"`
	InFlightCount         *int     `json:"inFlightCount,omitempty"`
	InFlightLimit         *int     `json:"inFlightLimit,omitempty"`
	Reason                string   `json:"reason"`
	DedupeUntil           *string  `json:"dedupeUntil,omitempty"`

	// enqueued is the number of URLs this dispatch actually enqueued. The
	// cron budget arithmetic reads it; it is never serialized.
	enqueued int `json:"-"`
}

// dispatchMode selects the two behaviours of the shared dispatch body.
type dispatchMode string

const (
	dispatchModeCron   dispatchMode = "schedule"
	dispatchModeManual dispatchMode = "dispatch_now"
)

// cancelQueuedOutcome is the POST :id/cancel-queued response.
type cancelQueuedOutcome struct {
	SourceID        string   `json:"sourceId"`
	RemovedJobs     int      `json:"removedJobs"`
	ScannedJobs     int      `json:"scannedJobs"`
	CanceledTaskIDs []string `json:"canceledTaskIds"`
}

// clearInFlightOutcome is the POST :id/clear-inflight response.
type clearInFlightOutcome struct {
	SourceID    string `json:"sourceId"`
	Cutoff      string `json:"cutoff"`
	ClearedJobs int    `json:"clearedJobs"`
}

// retryLatestOutcome is the POST :id/retry-latest response. The two retry kinds
// share one shape with kind-specific optional keys.
type retryLatestOutcome struct {
	SourceID      string  `json:"sourceId"`
	RetryType     string  `json:"retryType"`
	CrawlTaskID   *string `json:"crawlTaskId,omitempty"`
	PipelineJobID *string `json:"pipelineJobId,omitempty"`
	Status        string  `json:"status"`
	Retried       bool    `json:"retried"`
}
