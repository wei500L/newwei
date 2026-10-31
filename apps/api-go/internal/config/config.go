// Package config loads the api-go gateway environment.
//
// api-go owns every migrated execution unit itself: the gateway no longer keeps
// any API_GO_* migration switch. All resource connections the migrated units
// need are validated unconditionally at startup.
package config

import (
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const (
	defaultPort    = 4020
	readTimeoutSec = 30

	// 与 NestJS env schema 相同的默认值（apps/api/src/modules/config/
	// env.schema.ts：JWT_ISSUER / JWT_AUDIENCE 的 z.string().default）。
	defaultJWTIssuer   = "modular-monolith"
	defaultJWTAudience = "modular-monolith-clients"
	defaultRedisPort   = 6379
)

// DataRuntimeSettingsEnv carries the environment-derived defaults of the data
// runtime settings unit. Names and defaults mirror the NestJS apiEnvSchema
// entries and the EnvService.realtimeSignalsConfig getters exactly, so the two
// implementations agree when no SystemSetting row exists.
//
// This block is independent of the existing RealtimeSignals*/Nominatim* fields on
// Config, which serve the signal collectors and the geocoding client and keep
// their own semantics: nothing here rewrites them.
//
// Optional strings use "" for the NestJS `undefined`. Numeric and boolean values
// are already coerced by the schema (an empty string means "absent", then the
// schema default applies), so boolDefault/intDefault/floatDefault reproduce it.
//
// Note the deliberate OpenSky precedence: apiEnvSchema defaults
// REALTIME_SIGNALS_OPENSKY_ENABLED / _INTERVAL_SEC / _BASE_URL, so the
// `get(OPENSKY_*) ?? get(ADSB_*)` fallback in the NestJS getter can never reach
// the ADSB_* variables, and the ADSB_* names are intentionally not read here
// either.
type DataRuntimeSettingsEnv struct {
	RealtimeEnabled                  bool
	RealtimeRequestTimeoutMs         int
	RealtimeMaxRetries               int
	RealtimeOpenskyEnabled           bool
	RealtimeOpenskyIntervalSec       int
	RealtimeOpenskyDailyCreditBudget int
	RealtimeOpenskyDayIntervalSec    int
	RealtimeOpenskyNightIntervalSec  int
	RealtimeOpenskyDayStartHourHKT   int
	RealtimeOpenskyNightStartHourHKT int
	RealtimeOpenskyWarningRemaining  int
	RealtimeOpenskyCriticalRemaining int
	RealtimeOpenskyBaseURL           string
	RealtimeOpenskyTokenURL          string
	RealtimeOpenskyClientID          string
	RealtimeOpenskyClientSecret      string
	RealtimeAisEnabled               bool
	RealtimeAisIntervalSec           int
	RealtimeUnrestEnabled            bool
	RealtimeUnrestIntervalSec        int
	RealtimeOutagesEnabled           bool
	RealtimeOutagesIntervalSec       int
	RealtimeKeywordSpikeEnabled      bool
	RealtimeKeywordSpikeIntervalSec  int
	RealtimePizzintEnabled           bool
	RealtimePizzintIntervalSec       int
	RealtimeGdeltTensionEnabled      bool
	RealtimeGdeltTensionIntervalSec  int
	RealtimePolymarketLeadsEnabled   bool
	RealtimePolymarketIntervalSec    int
	RealtimeKeywordSpikeMinCount     int
	RealtimeKeywordSpikeMultiplier   float64
	RealtimePredictionShiftThreshold float64
	RealtimePredictionNewsThreshold  int
	RealtimeAisBaseURL               string
	RealtimeAisSharedSecret          string
	RealtimeAcledOauthUsername       string
	RealtimeAcledOauthPassword       string
	RealtimeAcledOauthClientID       string
	RealtimeCloudflareAPIToken       string
	RealtimeWingbitsAPIKey           string
	RealtimePolymarketProxyURL       string
	NominatimUserAgentDefault        string
	NominatimEmailDefault            string
}

// AnalysisPromptOverrides carries the six ANALYSIS_PROMPT_* overrides. A nil
// pointer means the variable is absent and the package default is used; a
// non-nil pointer is the configured value verbatim, including the empty string.
// NestJS reads these through ConfigService's process.env fallback (they are not
// in the env schema), and `??` treats only null/undefined as absent.
type AnalysisPromptOverrides struct {
	CorrelationSystem  *string
	CorrelationUser    *string
	AnomalySystem      *string
	AnomalyUser        *string
	GeoTransportSystem *string
	GeoTransportUser   *string
}

// SMTPConfig is the real SMTP transport configuration (the Env.smtpConfig
// equivalent). The login and onboarding units send mail synchronously inside the
// request, so a missing transport is a startup error rather than a per-request
// failure.
type SMTPConfig struct {
	Host                  string
	Port                  int
	Secure                bool
	User                  string
	Pass                  string
	From                  string
	Pool                  bool
	MaxConnections        int
	MaxMessages           int
	RateDeltaMs           int
	RateLimit             int
	ConnectionTimeoutMs   int
	GreetingTimeoutMs     int
	SocketTimeoutMs       int
	TLSRejectUnauthorized bool
}

// NewsSourceSchedulerSettings mirrors EnvService.newsSourceSchedulerConfig
// (apps/api/src/modules/config/config.service.ts) plus the Go-only source
// concurrency knob. Every field is read from the same environment variable
// and default the NestJS getter uses, so switching execution ownership does
// not change nextRunAt, backpressure or circuit-breaker math.
type NewsSourceSchedulerSettings struct {
	Enabled                    bool
	BatchSize                  int
	LockTTLMs                  int
	InFlightLookbackMs         int
	InFlightRescheduleDelayMs  int
	JitterMaxMs                int
	MaxEnqueuePerTick          int
	BackpressureMaxPendingJobs int
	BackpressureDelayMs        int
	FailureRecoveryDelayMs     int
	FailureMaxDelayMs          int
	CircuitBreakerThreshold    int
	CircuitBreakerBaseDelayMs  int
	CircuitBreakerMaxDelayMs   int
	// SourceConcurrency is the Go-only per-tick source fan-out
	// (NEWS_SOURCE_SCHEDULER_SOURCE_CONCURRENCY). The default 1 is exactly
	// the serial NestJS loop.
	SourceConcurrency int
}

// Config 是网关运行所需的全部配置。
type Config struct {
	Port int

	// DatabaseURL 是 Prisma 同名环境变量（mysql://user:pass@host:port/db）。
	// 仅供 user-settings 只读 shadow（onboarding/rss-reader/spacetime-timeline
	// 三个 GET）的 MySQL 只读查询使用；为空时这些 shadow 单元跳过执行，
	// 网关照常启动并代理全部请求（非阻断）。
	// 启动时必填（启动失败——Go 接管端点不能依赖缺失的数据库）。
	// 值本身不进入日志/healthz/错误文本。
	DatabaseURL string

	// ScheduleEnabled mirrors the NestJS `process.env.SCHEDULE_ENABLED !==
	// "false"` check. Background units (audit outbox, raw_item replay) use it to
	// stop scheduling without changing their ownership switch; the digest
	// delivery unit keeps its existing behavior.
	ScheduleEnabled bool
	// NewsEventsIngestionSettleMs 是 NEWS_EVENTS_INGESTION_SETTLE_MS：入库读取的
	// processedAt 上界（now - settleMs）。默认 120000 毫秒。它让「processedAt 较
	// 早、但事务提交较晚」的文章不会因为游标越过而被永久跳过。
	NewsEventsIngestionSettleMs int64
	// 告警队列的 ALERT_* 调参（NestJS EnvService.alertingConfig 的等价物）。
	AlertQueueConcurrency     int
	AlertWebhookTimeoutMs     int
	AlertScanIntervalMs       int64
	AlertNotifyGlobalPerSec   float64
	AlertNotifyEmailPerSec    float64
	AlertNotifyWebhookPerSec  float64
	AlertNotifyPerChannelPSec float64
	AlertNotifyLimiterTTLMs   int64
	// BullMQNamespace is BULLMQ_NAMESPACE (default "modular"): it prefixes the
	// alert notification pace keys.
	BullMQNamespace string
	// AnalysisQueueConcurrency, AnalysisMaxRetries, AnalysisPrompts,
	// AnalysisLLMTimeoutMs and the two stream flush bounds are the effective
	// NestJS analysisConfig values. Only concurrency, retries and the
	// auto-trigger flag are validated by the NestJS env schema; the prompt,
	// timeout and flush variables are read through ConfigService's process.env
	// fallback, so Go reads the same environment with the same defaults.
	AnalysisQueueConcurrency int
	AnalysisMaxRetries       int
	AnalysisPrompts          AnalysisPromptOverrides
	AnalysisLLMTimeoutMs     int
	AnalysisStreamFlushChars int
	AnalysisStreamFlushMs    int
	// BullMQWorkersEnabled is the existing shared boolean. False disables the
	// analysis consumer on both NestJS and Go; it is not a queue-owner switch.
	BullMQWorkersEnabled bool
	// GraphQLSubscriptionBus is the NestJS GRAPHQL_SUBSCRIPTION_BUS value. It
	// defaults to redis. The analysis worker and the realtime subscriptions
	// require redis because they publish/consume the existing gqlsub:*
	// channels, so a local bus is rejected at startup.
	GraphQLSubscriptionBus string
	// WebSocket connection caps and connect-window limits share the NestJS
	// environment names and defaults so the Go path enforces the same policy.
	WSMaxConnectionsPerUser         int
	WSMaxConnectionsPerIP           int
	WSConnectRateLimitPerIP         int
	WSConnectRateLimitPerUser       int
	WSConnectRateLimitWindowSeconds int
	// WSRedisAdapterEnabled and WSRedisAdapterKey mirror the NestJS Socket.IO
	// Redis adapter configuration. The newsnow namespace is relayed from the
	// adapter broadcast channel, so Go must know the same switch and key.
	WSRedisAdapterEnabled bool
	WSRedisAdapterKey     string
	// ProcessedItemOutboxTickBudgetMs bounds one Go scan tick. It must stay
	// below the five-minute period.
	ProcessedItemOutboxTickBudgetMs int
	// ProcessedItemOutboxConcurrency is the per-batch delivery worker count.
	ProcessedItemOutboxConcurrency int
	// ProcessedItemOutboxBatchSize is the scan cut of one batch.
	ProcessedItemOutboxBatchSize int
	// AssistantQueueConcurrency mirrors ASSISTANT_QUEUE_CONCURRENCY (default 2).
	AssistantQueueConcurrency int
	// AssistantMaxRetries mirrors ASSISTANT_MAX_RETRIES (default 3).
	AssistantMaxRetries int
	// AssistantLLMTimeoutMs mirrors ASSISTANT_LLM_TIMEOUT_MS (default 300000).
	AssistantLLMTimeoutMs int
	// AssistantStreamFlushChars mirrors ASSISTANT_STREAM_FLUSH_CHARS (default 80).
	AssistantStreamFlushChars int
	// AssistantStreamFlushMs mirrors ASSISTANT_STREAM_FLUSH_MS (default 250).
	AssistantStreamFlushMs int
	// SituationMonitorGdeltEnabled 是 SITUATION_MONITOR_GDELT_ENABLED，默认
	// true。为 false 时定时重建与强制刷新都直接返回，与 isGdeltEnabled 一致。
	SituationMonitorGdeltEnabled bool
	// CrawlTaskJanitor* mirror the NestJS CRAWL_TASK_JANITOR_* environment. The
	// defaults are identical, and both processes read the same values so the
	// stale windows and batch sizes cannot drift while ownership moves.
	CrawlTaskJanitorEnabled        bool
	CrawlTaskRunningTimeoutMs      int
	CrawlTaskQueuedTimeoutMs       int
	CrawlTaskJanitorBatchSize      int
	CrawlTaskJanitorQueueScanLimit int
	CrawlTaskJanitorLockTTLMs      int
	// CrawlMaxConcurrency, CrawlMaxRetries and CrawlRetryBackoffMs mirror
	// EnvService.crawl4aiConfig. They are the environment defaults used when
	// creating a crawl task and when the stored crawl client settings row is
	// absent.
	CrawlMaxConcurrency int
	CrawlMaxRetries     int
	CrawlRetryBackoffMs int
	// NewsSourceScheduler 是 NEWS_SOURCE_SCHEDULER_* 的数值与开关配置，
	// 与 NestJS EnvService.newsSourceSchedulerConfig 同名同默认值；另加
	// Go 专用的 SourceConcurrency。
	NewsSourceScheduler NewsSourceSchedulerSettings
	// The platform governance environment defaults below mirror the NestJS zod
	// schema (apps/api/src/modules/config/env.schema.ts,
	// packages/utils/src/env.ts) exactly, including the .default() values and
	// Number() coercion. They are parsed and validated unconditionally at
	// startup.
	//
	// AssistantGuardrailsEnabled is ASSISTANT_GUARDRAILS_ENABLED
	// (envBoolean, default true).
	PlatformGovernanceAssistantGuardrailsEnabled bool
	// PlatformGovernanceAssistantGuardrailsRaw is the raw ASSISTANT_GUARDRAILS
	// string; unset or whitespace-only becomes "openai-moderation-pre". The
	// comma split / trim / drop-empty step happens in the serving package,
	// matching EnvService.assistantConfig.
	PlatformGovernanceAssistantGuardrailsRaw string
	// PlatformGovernanceAssistantOrgSubmitLimitPerHour is
	// ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR (int, 0..10000, default 30).
	PlatformGovernanceAssistantOrgSubmitLimitPerHour int
	// PlatformGovernanceAssistantOrgMaxInFlight is ASSISTANT_ORG_MAX_IN_FLIGHT
	// (int, 0..100, default 2).
	PlatformGovernanceAssistantOrgMaxInFlight int
	// PlatformGovernanceAssistantOrgMonthlyTokenBudget is
	// ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET (int, 0..1e12, default 2000000).
	PlatformGovernanceAssistantOrgMonthlyTokenBudget int64
	// PlatformGovernanceTaskLogRetentionDays is TASK_LOG_RETENTION_DAYS
	// (positive int, default 14). The 1..3650 clamp is applied where the value
	// is used, matching TaskLogSettingsService.normalizeRetentionDays.
	PlatformGovernanceTaskLogRetentionDays int
	// PlatformGovernanceEncryptionKeyRaw is SYSTEM_SETTINGS_ENCRYPTION_KEY kept
	// verbatim (NOT trimmed): the serving package must distinguish "unset or
	// empty" (present=false) from "whitespace only" (present=true, then
	// "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty"). The existing
	// SettingsEncryptionKey field is trimmed and is used by other domains.
	PlatformGovernanceEncryptionKeyRaw string

	// DataRuntimeSettings holds the environment defaults of that unit. It is
	// independent of the RealtimeSignals*/Nominatim* fields below.
	DataRuntimeSettings DataRuntimeSettingsEnv
	// APIBaseURL is the untrimmed API_BASE_URL used only to build the IdP
	// redirect_uri. It stays optional at startup: the source answers a missing
	// value with the request-time 400 "API_BASE_URL is required for OIDC".
	APIBaseURL string
	// AuthEmailCode* model the AuthEmailCodeSettingsService environment fallback
	// (defaults 300 / 90 / 3) and are clamped to the documented ranges.
	AuthEmailCodeTTLSeconds      int
	AuthEmailCodeCooldownSeconds int
	AuthEmailCodeMaxAttempts     int
	// AuthRefreshGraceSeconds is the refresh rotation grace window (default 10).
	AuthRefreshGraceSeconds int
	// AuthMfaChallengeMaxAttempts is the challenge attempt budget (default 5).
	AuthMfaChallengeMaxAttempts int
	// NextAuthURL builds the password-reset link; the NestJS controller falls back
	// to http://localhost:3000.
	NextAuthURL string
	// SMTP is the real transport (Env.smtpConfig) the login, email-change,
	// password-reset, invitation and application-decision messages use. It is
	// validated unconditionally at startup.
	SMTP SMTPConfig

	// The VECTOR_* / S3_* values below are the environment defaults the
	// infrastructure settings routes fall back to when a SystemSetting row is
	// absent. Names and defaults mirror the NestJS EnvService getters exactly.
	// VectorInternalToken and SettingsEncryptionKeyRaw keep the raw environment
	// value (no trim) because the NestJS contracts distinguish "missing" from
	// "present but blank/invalid".
	VectorServiceEnabled         bool
	VectorServiceFallbackToMongo bool
	VectorServiceBaseURL         string
	VectorInternalToken          string
	VectorServiceTimeoutMs       int
	VectorServiceMaxRetries      int

	S3AccessKeyID            string
	S3SecretAccessKey        string
	S3Region                 string
	S3Bucket                 string
	S3Endpoint               string
	S3PublicBaseURL          string
	S3ForcePathStyle         bool
	S3PresignedURLTTLSeconds int

	// SettingsEncryptionKeyRaw is the untrimmed SYSTEM_SETTINGS_ENCRYPTION_KEY.
	// SettingsEncryptionKeyPresent mirrors the NestJS `if (!raw)` presence test
	// performed before decoding. SettingsEncryptionKey (declared further down)
	// keeps its historical trimmed value and is left unchanged.
	SettingsEncryptionKeyRaw     string
	SettingsEncryptionKeyPresent bool
	// NodeEnv is the raw NODE_ENV the secret-encoding policy compares against
	// the exact string "production".
	NodeEnv string

	AkshareEnabled             bool
	AkshareBaseURL             string
	AkshareTimeoutMs           int
	AkshareMaxRetries          int
	AkshareAdminToken          string
	AkshareQueueConcurrency    int
	AkshareScheduleSmoothing   bool
	AkshareSkipUnchangedLatest bool

	GraphQLAPQEnabled    bool
	GraphQLDepthLimit    int
	GraphQLComplexity    int
	GraphQLCacheEnabled  bool
	GraphQLCacheTTL      int
	TrustProxy           string
	RateLimitFailOpen    bool
	RateLimitLogin       int
	RateLimitLoginWindow int
	// Observability client exception ingest buckets. They mirror the NestJS
	// EnvService observabilityClientExceptionRateLimit getter (defaults
	// 30 / 120 / 60) and are consumed by the exception ingest unit.
	ObservabilityClientExceptionUserRateLimit int
	ObservabilityClientExceptionIPRateLimit   int
	ObservabilityClientExceptionWindowSeconds int
	// The remaining rate limit buckets and the auth profile cache values are
	// the environment defaults the sixteen runtime/governance settings routes
	// return when no SystemSetting row exists. Names and defaults mirror the
	// NestJS EnvService getters exactly.
	RateLimitCrawlTaskCreate         int
	RateLimitCrawlTaskCreateWindow   int
	RateLimitRbacWrite               int
	RateLimitRbacWriteWindow         int
	RateLimitSettingsCacheTTLSeconds int
	AuthProfileCacheTTLSeconds       int
	AuthProfileCacheLockTTLMs        int
	AuthProfileCacheMaxWaitMs        int
	AuthProfileCacheRetryDelayMs     int
	AuditLogRetentionDays            int
	// MongoURI 是 NestJS 同名 MONGO_URI。dashboard stats 与 war map 的 go 模式读取。
	MongoURI string

	// 认证版健康检查沿用 Nest 已有的 crawl / rerank 配置。空值表示未配置，
	// 探针如实失败。URL 和密钥不进入日志或健康响应。
	CrawlBaseURL       string
	CrawlAPIKey        string
	CrawlTimeoutMs     int
	CrawlHealthTTLMs   int
	CrawlSSRFProxyURL  string
	CrawlJSCodeEnabled bool
	// CrawlMediaFetchTimeoutMs, CrawlMediaMaxBytes and CrawlMediaMaxPerResult
	// mirror EnvService.crawl4aiConfig.media (CRAWL_MEDIA_FETCH_TIMEOUT_MS,
	// CRAWL_MEDIA_MAX_BYTES, CRAWL_MEDIA_MAX_PER_RESULT; defaults 15000,
	// 2097152 and 6). The Go crawl worker uses them when storeMedia is set.
	CrawlMediaFetchTimeoutMs int
	CrawlMediaMaxBytes       int
	CrawlMediaMaxPerResult   int
	// NewsSourceInFlightLookbackMs is NEWS_SOURCE_SCHEDULER_INFLIGHT_LOOKBACK_MS
	// (default 21_600_000): the preview's in-flight PipelineJob window.
	NewsSourceInFlightLookbackMs int
	ItemsSearchRerankEnabled     bool
	// ItemsReadModelEnabled mirrors the NestJS ITEMS_READ_MODEL_ENABLED switch
	// (default false). It is a read-model switch, not a migration switch: the
	// migrated endpoints honour it in both modes.
	ItemsReadModelEnabled bool
	// ItemsVectorHardFailEnabled mirrors ITEMS_VECTOR_HARD_FAIL_ENABLED
	// (default false). When true an unavailable vector service fails the search
	// instead of degrading.
	ItemsVectorHardFailEnabled bool

	// OpenSky 运行配置与 Nest env.schema 的默认值一致，供 layers 的
	// flightMode=all 读取。不在这里启动采集。
	RealtimeSignalsEnabled      bool
	RealtimeSignalsTimeoutMs    int
	OpenskyEnabled              bool
	OpenskyDailyCreditBudget    int
	OpenskyDayIntervalSec       int
	OpenskyNightIntervalSec     int
	OpenskyDayStartHourHKT      int
	OpenskyNightStartHourHKT    int
	OpenskyWarningRemainingPct  int
	OpenskyCriticalRemainingPct int
	OpenskyBaseURL              string
	OpenskyTokenURL             string
	OpenskyClientID             string
	OpenskyClientSecret         string

	NominatimBaseURL           string
	NominatimUserAgent         string
	NominatimEmail             string
	NominatimAcceptLanguage    string
	GeocodeTimeoutMs           int
	GeocodeCacheTTLSeconds     int
	GeocodeNegativeTTLSeconds  int
	GeocodeRatePerSecond       int
	TranslationAPIEnabled      bool
	TranslationAPIBaseURL      string
	TranslationTimeoutMs       int
	TranslationMaxRetries      int
	TranslationFallbackEnabled bool
	TranslationFallbackBaseURL string

	// SettingsEncryptionKey 是 Nest 已有的 SYSTEM_SETTINGS_ENCRYPTION_KEY。
	// 只用于解开 SystemSetting 里的模型网关凭据。不进入日志。
	SettingsEncryptionKey string
	// LiteLLMAPIBase / LiteLLMAPIKey / 超时与重试是 Nest 已有的 LITELLM_*。
	// profile 缺字段时才回落。APIKey 不进入日志。
	LiteLLMAPIBase    string
	LiteLLMAPIKey     string
	LiteLLMTimeoutMs  int
	LiteLLMMaxRetries int

	// LiteLLMMasterKey 是 LITELLM_MASTER_KEY 原文，只用于 LiteLLM 管理接口的
	// Authorization。与 LITELLM_CONFIG_INTERNAL_TOKEN 用途不同：后者是内部下发
	// 路由的 bearer 校验。不进入日志。
	LiteLLMMasterKey string
	// LLMGateway* 是本批 profile 默认值所需的 LITELLM_* 投影。它们镜像
	// NestJS env schema 的默认值：LITELLM_MAX_TOKENS 与 LITELLM_RETRY_ATTEMPTS
	// 因为有 schema 默认值，永远优先于 LITELLM_MAX_OUTPUT_TOKENS /
	// LITELLM_MAX_RETRIES。LITELLM_EMBEDDING_MODEL 与 LITELLM_API_KEY 不会
	// 变成新 profile 的字段。
	LLMGatewayModel           string
	LLMGatewayTemperature     float64
	LLMGatewayTopP            float64
	LLMGatewayMaxOutputTokens int
	LLMGatewayMaxRetries      int
	LLMGatewayFallbackModels  []string
	// LLMGatewaySettingsEncryptionKey 是 SYSTEM_SETTINGS_ENCRYPTION_KEY 的原文
	// （不 trim：NestJS 的存在性判断是原始字符串 truthiness）。不进入日志。
	LLMGatewaySettingsEncryptionKey string
	// NodeEnvProduction 是 NODE_ENV === "production"，决定无密钥时是否允许
	// 明文回落。
	NodeEnvProduction bool

	// CorsOrigin 是与 NestJS 相同的 CORS_ORIGIN 原文。空名单不放行任何
	// 浏览器 Origin。只用于 Go 自己写出的 user-settings 响应。
	CorsOrigin string

	// JWT 是 NestJS access token 的验签配置（与 api 服务同一
	// JWT_SECRET/JWT_ISSUER/JWT_AUDIENCE）。JWTSecret 启动时必填；
	// issuer/audience 默认值与 NestJS env schema 一致。
	// Secret 不进入日志/healthz/错误文本。
	JWTSecret   string
	JWTIssuer   string
	JWTAudience string
	// JWTAccessExpiresIn / JWTRefreshExpiresIn keep the raw timespan text
	// (defaults 15m / 7d). The login unit parses them per signing call, exactly
	// like the NestJS EnvService jwtConfig getter, so a malformed value surfaces
	// as the same request-time 400.
	JWTAccessExpiresIn  string
	JWTRefreshExpiresIn string

	// Redis 是 access-token blacklist 所用 Redis（与 NestJS api 服务同一
	// 实例——Go 不建第二套撤销名单）。Host 启动时必填；
	// Port 默认 6379、DB 默认 0、用户名/密码可选（镜像 NestJS env
	// schema 的可选语义）。凭据不进入日志/healthz/错误文本。
	RedisHost     string
	RedisPort     int
	RedisUsername string
	RedisPassword string
	RedisDB       int

	// 模型接入设置本批消费的原始环境值：config 只做读取与保存，
	// envBoolean / Number 的 JavaScript 语义解析放在
	// internal/modelaccesssettings（NewConfigFromEnv）里，且只在 go 模式求值，
	// legacy 模式的启动行为不变。
	ModelServiceEnabledRaw         string
	ModelServiceBaseURLRaw         string
	ModelServiceInternalTokenRaw   string
	ModelServiceTimeoutMsRaw       string
	ModelServiceMaxRetriesRaw      string
	LiteLLMConfigInternalTokenRaw  string
	SystemSettingsEncryptionKeyRaw string
	NodeEnvRaw                     string
	// NewsProcessQueueConcurrency mirrors NEWS_PROCESS_QUEUE_CONCURRENCY
	// (default 8). The clustering recovery worker uses max(1, min(2, value));
	// the quality worker uses max(1, min(4, value)).
	NewsProcessQueueConcurrency int
	// NewsSourceSchedulerFailureRecoveryDelayMs,
	// NewsSourceSchedulerFailureMaxDelayMs,
	// NewsSourceSchedulerCircuitBreakerThreshold,
	// NewsSourceSchedulerCircuitBreakerBaseDelayMs,
	// NewsSourceSchedulerCircuitBreakerMaxDelayMs and
	// NewsSourceSchedulerAutoDisableThreshold mirror the
	// EnvService.newsSourceSchedulerConfig block the item pipeline failure path
	// reads (defaults 600000, 21600000, 3, 3600000, 86400000, 0).
	NewsSourceSchedulerFailureRecoveryDelayMs    int
	NewsSourceSchedulerFailureMaxDelayMs         int
	NewsSourceSchedulerCircuitBreakerThreshold   float64
	NewsSourceSchedulerCircuitBreakerBaseDelayMs int
	NewsSourceSchedulerCircuitBreakerMaxDelayMs  int
	NewsSourceSchedulerAutoDisableThreshold      float64
}

// Load 从 getenv 读取并校验配置。
// loadAlertingConfig reads the ALERT_* tuning and BULLMQ_NAMESPACE. The bounds
// and defaults match apps/api/src/modules/config/env.schema.ts, so a value NestJS
// refuses is also a startup error here. ALERT_MAX_RETRIES is deliberately not
// read: a delivery job's attempts are the fixed length of the backoff table plus
// one, like NOTIFICATION_BACKOFF_DELAYS_MS in alerts.service.ts.
func loadAlertingConfig(getenv func(string) string, cfg *Config) []string {
	errs := make([]string, 0)
	readInt := func(name string, fallback int, positive bool, target *int) {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			*target = fallback
			return
		}
		value, err := strconv.Atoi(raw)
		if err != nil || (positive && value <= 0) || (!positive && value < 0) {
			if positive {
				errs = append(errs, fmt.Sprintf("%s must be a positive integer, got %q", name, raw))
			} else {
				errs = append(errs, fmt.Sprintf("%s must be a non-negative integer, got %q", name, raw))
			}
			*target = fallback
			return
		}
		*target = value
	}
	readInt64 := func(name string, fallback int64, positive bool, target *int64) {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			*target = fallback
			return
		}
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || (positive && value <= 0) || (!positive && value < 0) {
			if positive {
				errs = append(errs, fmt.Sprintf("%s must be a positive integer, got %q", name, raw))
			} else {
				errs = append(errs, fmt.Sprintf("%s must be a non-negative integer, got %q", name, raw))
			}
			*target = fallback
			return
		}
		*target = value
	}
	readPerSecond := func(name string, fallback float64, target *float64) {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			*target = fallback
			return
		}
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil || value < 0 || value != math.Trunc(value) {
			errs = append(errs, fmt.Sprintf("%s must be a non-negative integer, got %q", name, raw))
			*target = fallback
			return
		}
		*target = value
	}
	readInt("ALERT_QUEUE_CONCURRENCY", 4, true, &cfg.AlertQueueConcurrency)
	readInt("ALERT_WEBHOOK_TIMEOUT_MS", 5_000, true, &cfg.AlertWebhookTimeoutMs)
	readInt64("ALERT_SCAN_INTERVAL_MS", 300_000, true, &cfg.AlertScanIntervalMs)
	readPerSecond("ALERT_NOTIFY_GLOBAL_PER_SECOND", 10, &cfg.AlertNotifyGlobalPerSec)
	readPerSecond("ALERT_NOTIFY_EMAIL_PER_SECOND", 2, &cfg.AlertNotifyEmailPerSec)
	readPerSecond("ALERT_NOTIFY_WEBHOOK_PER_SECOND", 10, &cfg.AlertNotifyWebhookPerSec)
	readPerSecond("ALERT_NOTIFY_PER_CHANNEL_PER_SECOND", 2, &cfg.AlertNotifyPerChannelPSec)
	readInt64("ALERT_NOTIFY_LIMITER_TTL_MS", 60_000, true, &cfg.AlertNotifyLimiterTTLMs)
	cfg.BullMQNamespace = strings.TrimSpace(getenv("BULLMQ_NAMESPACE"))
	if cfg.BullMQNamespace == "" {
		cfg.BullMQNamespace = "modular"
	}
	return errs
}

func Load(getenv func(string) string) (Config, error) {
	return load(getenv, nil)
}

// load is the shared implementation. lookup, when non-nil, distinguishes an
// absent environment variable from one configured as the empty string; the
// six ANALYSIS_PROMPT_* overrides use that distinction because NestJS `??`
// only falls back when the variable is undefined.
func load(getenv func(string) string, lookup func(string) (string, bool)) (Config, error) {
	var errs []string

	cfg := Config{}

	port := defaultPort
	if raw := strings.TrimSpace(getenv("PORT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("PORT must be a positive integer, got %q", raw))
		} else {
			port = value
		}
	}
	cfg.Port = port

	// 只读取原文，不做解析（解析在 usersettings.OpenMySQLFromURL，错误
	// 不阻断解析本身）。下方显式要求非空（启动失败）。
	cfg.DatabaseURL = strings.TrimSpace(getenv("DATABASE_URL"))

	// SCHEDULE_ENABLED is the cross-process scheduling stop switch. The exact
	// comparison matches the NestJS `!== "false"` check character for
	// character, so both processes agree on the value.
	cfg.ScheduleEnabled = getenv("SCHEDULE_ENABLED") != "false"

	// The settle window of the ingestion cursor. An absent value keeps the
	// 120 s default; a non-integer or negative value fails startup instead of
	// silently disabling the bound that keeps late commits from being skipped.
	cfg.NewsEventsIngestionSettleMs = 120_000
	if raw := strings.TrimSpace(getenv("NEWS_EVENTS_INGESTION_SETTLE_MS")); raw != "" {
		value, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || value < 0 {
			errs = append(errs, fmt.Sprintf("NEWS_EVENTS_INGESTION_SETTLE_MS must be a non-negative integer, got %q", raw))
		} else {
			cfg.NewsEventsIngestionSettleMs = value
		}
	}
	errs = append(errs, loadAlertingConfig(getenv, &cfg)...)

	if raw := strings.TrimSpace(getenv("NEWS_PROCESS_QUEUE_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("NEWS_PROCESS_QUEUE_CONCURRENCY must be a positive integer, got %q", raw))
		} else {
			cfg.NewsProcessQueueConcurrency = value
		}
	}
	// Janitor defaults are the NestJS env schema defaults. Both processes read
	// the same values while ownership is go, so a stale window cannot differ
	// between the two cron implementations.
	cfg.CrawlTaskJanitorEnabled = boolDefault(getenv("CRAWL_TASK_JANITOR_ENABLED"), true)
	cfg.CrawlTaskRunningTimeoutMs = intDefault(getenv("CRAWL_TASK_RUNNING_TIMEOUT_MS"), 1_800_000)
	cfg.CrawlTaskQueuedTimeoutMs = intDefault(getenv("CRAWL_TASK_QUEUED_TIMEOUT_MS"), 43_200_000)
	cfg.CrawlTaskJanitorBatchSize = intDefault(getenv("CRAWL_TASK_JANITOR_BATCH_SIZE"), 50)
	cfg.CrawlTaskJanitorQueueScanLimit = intDefault(getenv("CRAWL_TASK_JANITOR_QUEUE_SCAN_LIMIT"), 5_000)
	cfg.CrawlTaskJanitorLockTTLMs = intDefault(getenv("CRAWL_TASK_JANITOR_LOCK_TTL_MS"), 120_000)
	// The seven environment defaults the sixteen platform governance settings
	// routes expose. They are parsed and their failures promoted to startup
	// errors unconditionally.
	governanceErrs := parsePlatformGovernanceDefaults(&cfg, getenv)
	errs = append(errs, governanceErrs...)
	// The bus value must be one the NestJS env schema accepts. Go subscriptions
	// and the still-running NestJS producers have to share redis, otherwise a
	// local bus would silently drop every cross-process event.
	switch strings.TrimSpace(getenv("GRAPHQL_SUBSCRIPTION_BUS")) {
	case "", "redis":
		cfg.GraphQLSubscriptionBus = "redis"
	case "local":
		cfg.GraphQLSubscriptionBus = "local"
	default:
		errs = append(errs, "GRAPHQL_SUBSCRIPTION_BUS must be one of redis|local")
	}
	if cfg.GraphQLSubscriptionBus != "redis" {
		errs = append(errs, "GRAPHQL_SUBSCRIPTION_BUS must be redis")
	}
	// The Socket.IO Redis adapter configuration must match NestJS exactly:
	// the newsnow dispatcher publishes into the adapter channel and Go
	// subscribes to the same key. An invalid boolean is a startup error like
	// the NestJS env schema, not a silent fallback.
	cfg.WSRedisAdapterEnabled = true
	if raw := strings.TrimSpace(getenv("WS_REDIS_ADAPTER_ENABLED")); raw != "" {
		switch strings.ToLower(raw) {
		case "true", "1", "yes", "y", "on":
			cfg.WSRedisAdapterEnabled = true
		case "false", "0", "no", "n", "off":
			cfg.WSRedisAdapterEnabled = false
		default:
			errs = append(errs, fmt.Sprintf("WS_REDIS_ADAPTER_ENABLED must be a boolean, got %q", raw))
		}
	}
	cfg.WSRedisAdapterKey = strings.TrimSpace(getenv("WS_REDIS_ADAPTER_KEY"))
	if cfg.WSRedisAdapterKey == "" {
		cfg.WSRedisAdapterKey = "socket.io"
	}
	cfg.WSMaxConnectionsPerUser = 5
	cfg.WSMaxConnectionsPerIP = 50
	cfg.WSConnectRateLimitPerIP = 60
	cfg.WSConnectRateLimitPerUser = 30
	cfg.WSConnectRateLimitWindowSeconds = 60
	for name, target := range map[string]*int{
		"WS_MAX_CONNECTIONS_PER_USER":          &cfg.WSMaxConnectionsPerUser,
		"WS_MAX_CONNECTIONS_PER_IP":            &cfg.WSMaxConnectionsPerIP,
		"WS_CONNECT_RATE_LIMIT_PER_IP":         &cfg.WSConnectRateLimitPerIP,
		"WS_CONNECT_RATE_LIMIT_PER_USER":       &cfg.WSConnectRateLimitPerUser,
		"WS_CONNECT_RATE_LIMIT_WINDOW_SECONDS": &cfg.WSConnectRateLimitWindowSeconds,
	} {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			continue
		}
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("%s must be a positive integer, got %q", name, raw))
			continue
		}
		*target = value
	}
	// Both executions check this flag before doing any work, the same way
	// isGdeltEnabled does. The Go default matches the NestJS schema default.
	cfg.SituationMonitorGdeltEnabled = boolDefault(getenv("SITUATION_MONITOR_GDELT_ENABLED"), true)
	cfg.ProcessedItemOutboxTickBudgetMs = 240000
	if raw := strings.TrimSpace(getenv("PROCESSED_ITEM_OUTBOX_TICK_BUDGET_MS")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("PROCESSED_ITEM_OUTBOX_TICK_BUDGET_MS must be a positive integer, got %q", raw))
		} else {
			cfg.ProcessedItemOutboxTickBudgetMs = value
		}
	}
	cfg.ProcessedItemOutboxConcurrency = 4
	if raw := strings.TrimSpace(getenv("PROCESSED_ITEM_OUTBOX_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("PROCESSED_ITEM_OUTBOX_CONCURRENCY must be a positive integer, got %q", raw))
		} else {
			cfg.ProcessedItemOutboxConcurrency = value
		}
	}
	cfg.ProcessedItemOutboxBatchSize = 10
	if raw := strings.TrimSpace(getenv("PROCESSED_ITEM_OUTBOX_BATCH_SIZE")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("PROCESSED_ITEM_OUTBOX_BATCH_SIZE must be a positive integer, got %q", raw))
		} else {
			cfg.ProcessedItemOutboxBatchSize = value
		}
	}
	cfg.AkshareEnabled = boolDefault(getenv("AKSHARE_ENABLED"), true)
	cfg.AkshareBaseURL = stringDefault(getenv("AKSHARE_HTTP_BASE_URL"), "http://localhost:8081")
	cfg.AkshareTimeoutMs = intDefault(getenv("AKSHARE_HTTP_TIMEOUT_MS"), 20_000)
	if cfg.AkshareTimeoutMs <= 0 {
		cfg.AkshareTimeoutMs = 20_000
	}
	cfg.AkshareMaxRetries = intDefault(getenv("AKSHARE_HTTP_MAX_RETRIES"), 3)
	if cfg.AkshareMaxRetries <= 0 {
		cfg.AkshareMaxRetries = 3
	}
	cfg.AkshareAdminToken = strings.TrimSpace(getenv("AKSHARE_ADMIN_TOKEN"))
	cfg.AkshareQueueConcurrency = intDefault(getenv("AKSHARE_QUEUE_CONCURRENCY"), 2)
	if cfg.AkshareQueueConcurrency <= 0 {
		cfg.AkshareQueueConcurrency = 2
	}
	cfg.AkshareScheduleSmoothing = boolDefault(getenv("AKSHARE_SCHEDULE_SMOOTHING_ENABLED"), false)
	cfg.AkshareSkipUnchangedLatest = boolDefault(getenv("AKSHARE_SKIP_UNCHANGED_LATEST_POINTS"), false)

	// Assistant runtime tuning. The defaults mirror the NestJS env schema.
	cfg.AssistantQueueConcurrency = 2
	if value := positiveInt(getenv("ASSISTANT_QUEUE_CONCURRENCY")); value > 0 {
		cfg.AssistantQueueConcurrency = value
	}
	cfg.AssistantMaxRetries = 3
	if value := positiveInt(getenv("ASSISTANT_MAX_RETRIES")); value > 0 {
		cfg.AssistantMaxRetries = value
	}
	cfg.AssistantLLMTimeoutMs = 300_000
	if value := positiveInt(getenv("ASSISTANT_LLM_TIMEOUT_MS")); value > 0 {
		cfg.AssistantLLMTimeoutMs = value
	}
	cfg.AssistantStreamFlushChars = 80
	if value := positiveInt(getenv("ASSISTANT_STREAM_FLUSH_CHARS")); value > 0 {
		cfg.AssistantStreamFlushChars = value
	}
	cfg.AssistantStreamFlushMs = 250
	if raw := strings.TrimSpace(getenv("ASSISTANT_STREAM_FLUSH_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 0 {
			cfg.AssistantStreamFlushMs = value
		}
	}
	cfg.GraphQLAPQEnabled = boolDefault(getenv("GRAPHQL_APQ_ENABLED"), true)
	cfg.GraphQLDepthLimit = intDefault(getenv("GRAPHQL_DEPTH_LIMIT"), 8)
	cfg.GraphQLComplexity = intDefault(getenv("GRAPHQL_COMPLEXITY_LIMIT"), 2000)
	cfg.GraphQLCacheEnabled = boolDefault(getenv("GRAPHQL_RESPONSE_CACHE_ENABLED"), true)
	cfg.GraphQLCacheTTL = intDefault(getenv("GRAPHQL_RESPONSE_CACHE_MAX_AGE_SECONDS"), 30)
	if cfg.GraphQLDepthLimit <= 0 {
		cfg.GraphQLDepthLimit = 8
	}
	if cfg.GraphQLComplexity <= 0 {
		cfg.GraphQLComplexity = 2000
	}
	if cfg.GraphQLCacheTTL <= 0 {
		cfg.GraphQLCacheTTL = 30
	}
	cfg.TrustProxy = strings.TrimSpace(getenv("TRUST_PROXY"))
	cfg.RateLimitFailOpen = boolDefault(getenv("RATE_LIMIT_REDIS_FAIL_OPEN"), false)
	cfg.RateLimitLogin = intDefault(getenv("RATE_LIMIT_LOGIN"), 5)
	cfg.RateLimitLoginWindow = intDefault(getenv("RATE_LIMIT_LOGIN_WINDOW"), 60)
	// Client exception ingest buckets (mirrors EnvService
	// observabilityClientExceptionRateLimit; defaults 30 / 120 / 60).
	cfg.ObservabilityClientExceptionUserRateLimit = intDefault(getenv("OBSERVABILITY_CLIENT_EXCEPTION_USER_RATE_LIMIT"), 30)
	cfg.ObservabilityClientExceptionIPRateLimit = intDefault(getenv("OBSERVABILITY_CLIENT_EXCEPTION_IP_RATE_LIMIT"), 120)
	cfg.ObservabilityClientExceptionWindowSeconds = intDefault(getenv("OBSERVABILITY_CLIENT_EXCEPTION_RATE_LIMIT_WINDOW_SECONDS"), 60)
	cfg.RateLimitCrawlTaskCreate = intDefault(getenv("RATE_LIMIT_CRAWL_TASK_CREATE"), 10)
	cfg.RateLimitCrawlTaskCreateWindow = intDefault(getenv("RATE_LIMIT_CRAWL_TASK_CREATE_WINDOW"), 300)
	cfg.RateLimitRbacWrite = intDefault(getenv("RATE_LIMIT_RBAC_WRITE"), 20)
	cfg.RateLimitRbacWriteWindow = intDefault(getenv("RATE_LIMIT_RBAC_WRITE_WINDOW"), 600)
	cfg.RateLimitSettingsCacheTTLSeconds = intDefault(getenv("RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS"), 60)
	cfg.AuthProfileCacheTTLSeconds = intDefault(getenv("AUTH_PROFILE_CACHE_TTL_SECONDS"), 600)
	cfg.AuthProfileCacheLockTTLMs = intDefault(getenv("AUTH_PROFILE_CACHE_LOCK_TTL_MS"), 5000)
	cfg.AuthProfileCacheMaxWaitMs = intDefault(getenv("AUTH_PROFILE_CACHE_MAX_WAIT_MS"), 5000)
	cfg.AuthProfileCacheRetryDelayMs = intDefault(getenv("AUTH_PROFILE_CACHE_RETRY_DELAY_MS"), 50)
	cfg.AuditLogRetentionDays = intDefault(getenv("AUDIT_LOG_RETENTION_DAYS"), 90)
	// Login chain defaults. AUTH_EMAIL_CODE_* mirror the EnvService
	// authEmailCodeConfig getter, AUTH_REFRESH_GRACE_SECONDS and
	// AUTH_MFA_CHALLENGE_MAX_ATTEMPTS mirror their getters, and NEXTAUTH_URL
	// builds the password-reset link with the controller's localhost fallback.
	cfg.AuthEmailCodeTTLSeconds = intDefault(getenv("AUTH_EMAIL_CODE_TTL_SECONDS"), 300)
	cfg.AuthEmailCodeCooldownSeconds = intDefault(getenv("AUTH_EMAIL_CODE_COOLDOWN_SECONDS"), 90)
	cfg.AuthEmailCodeMaxAttempts = intDefault(getenv("AUTH_EMAIL_CODE_MAX_ATTEMPTS"), 3)
	cfg.AuthRefreshGraceSeconds = intDefault(getenv("AUTH_REFRESH_GRACE_SECONDS"), 10)
	cfg.AuthMfaChallengeMaxAttempts = intDefault(getenv("AUTH_MFA_CHALLENGE_MAX_ATTEMPTS"), 5)
	cfg.NextAuthURL = strings.TrimSpace(getenv("NEXTAUTH_URL"))
	if cfg.NextAuthURL == "" {
		cfg.NextAuthURL = "http://localhost:3000"
	}
	// API_BASE_URL keeps its raw value. The OIDC redirect_uri builder applies
	// trim and the optional trailing /api removal at request time, exactly like
	// the NestJS controller.
	cfg.APIBaseURL = getenv("API_BASE_URL")
	// SMTP transport. The host/port/user/pass quartet is required by the NestJS
	// EnvService smtpConfig getter (getOrThrow); the remaining values keep the
	// documented defaults, with SMTP_FROM falling back to the authenticated user.
	cfg.SMTP = SMTPConfig{
		Host:                  strings.TrimSpace(getenv("SMTP_HOST")),
		Port:                  intDefault(getenv("SMTP_PORT"), 0),
		Secure:                boolDefault(getenv("SMTP_SECURE"), true),
		User:                  getenv("SMTP_USER"),
		Pass:                  getenv("SMTP_PASS"),
		From:                  strings.TrimSpace(getenv("SMTP_FROM")),
		Pool:                  boolDefault(getenv("SMTP_POOL"), false),
		MaxConnections:        intDefault(getenv("SMTP_MAX_CONNECTIONS"), 5),
		MaxMessages:           intDefault(getenv("SMTP_MAX_MESSAGES"), 100),
		RateDeltaMs:           intDefault(getenv("SMTP_RATE_DELTA_MS"), 1_000),
		RateLimit:             intDefault(getenv("SMTP_RATE_LIMIT"), 10),
		ConnectionTimeoutMs:   intDefault(getenv("SMTP_CONNECTION_TIMEOUT_MS"), 10_000),
		GreetingTimeoutMs:     intDefault(getenv("SMTP_GREETING_TIMEOUT_MS"), 10_000),
		SocketTimeoutMs:       intDefault(getenv("SMTP_SOCKET_TIMEOUT_MS"), 30_000),
		TLSRejectUnauthorized: boolDefault(getenv("SMTP_TLS_REJECT_UNAUTHORIZED"), true),
	}
	if cfg.SMTP.From == "" {
		cfg.SMTP.From = cfg.SMTP.User
	}
	// Infrastructure connection defaults (vector service + S3 storage). The
	// vector token and the settings-encryption key keep their raw environment
	// value: the NestJS contracts distinguish a missing variable from one that
	// is present but blank or undecodable.
	cfg.VectorServiceEnabled = boolDefault(getenv("VECTOR_SERVICE_ENABLED"), false)
	cfg.VectorServiceFallbackToMongo = boolDefault(getenv("VECTOR_SERVICE_FALLBACK_TO_MONGO"), true)
	cfg.VectorServiceBaseURL = strings.TrimSpace(getenv("VECTOR_SERVICE_BASE_URL"))
	cfg.VectorInternalToken = getenv("VECTOR_INTERNAL_TOKEN")
	cfg.VectorServiceTimeoutMs = intDefault(getenv("VECTOR_SERVICE_TIMEOUT_MS"), 5000)
	cfg.VectorServiceMaxRetries = intDefault(getenv("VECTOR_SERVICE_MAX_RETRIES"), 2)
	cfg.S3AccessKeyID = getenv("S3_ACCESS_KEY_ID")
	cfg.S3SecretAccessKey = getenv("S3_SECRET_ACCESS_KEY")
	cfg.S3Region = stringDefault(getenv("S3_REGION"), "us-east-1")
	cfg.S3Bucket = getenv("S3_BUCKET")
	cfg.S3Endpoint = strings.TrimSpace(getenv("S3_ENDPOINT"))
	cfg.S3PublicBaseURL = strings.TrimSpace(getenv("S3_PUBLIC_BASE_URL"))
	cfg.S3ForcePathStyle = boolDefault(getenv("S3_FORCE_PATH_STYLE"), false)
	cfg.S3PresignedURLTTLSeconds = intDefault(getenv("S3_PRESIGNED_URL_TTL_SECONDS"), 300)
	cfg.SettingsEncryptionKeyRaw = getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY")
	cfg.SettingsEncryptionKeyPresent = cfg.SettingsEncryptionKeyRaw != ""
	cfg.NodeEnv = getenv("NODE_ENV")
	cfg.CrawlBaseURL = strings.TrimRight(strings.TrimSpace(getenv("CRAWL4AI_BASE_URL")), "/")
	cfg.CrawlAPIKey = strings.TrimSpace(getenv("CRAWL4AI_API_KEY"))
	cfg.CrawlTimeoutMs = intDefault(getenv("CRAWL4AI_TIMEOUT_MS"), 120_000)
	cfg.CrawlMaxConcurrency = intDefault(getenv("CRAWL4AI_MAX_CONCURRENCY"), 3)
	cfg.CrawlMaxRetries = intDefault(getenv("CRAWL4AI_MAX_RETRIES"), 3)
	cfg.CrawlRetryBackoffMs = intDefault(getenv("CRAWL4AI_RETRY_BACKOFF_MS"), 5_000)
	cfg.CrawlHealthTTLMs = intDefault(getenv("CRAWL4AI_HEALTH_CHECK_TTL_MS"), 60_000)
	cfg.CrawlSSRFProxyURL = strings.TrimSpace(getenv("CRAWL4AI_SSRF_PROXY_URL"))
	cfg.CrawlJSCodeEnabled = boolDefault(getenv("CRAWL4AI_JSCODE_ENABLED"), true)
	cfg.CrawlMediaFetchTimeoutMs = intDefault(getenv("CRAWL_MEDIA_FETCH_TIMEOUT_MS"), 15_000)
	cfg.CrawlMediaMaxBytes = intDefault(getenv("CRAWL_MEDIA_MAX_BYTES"), 2_097_152)
	cfg.CrawlMediaMaxPerResult = intDefault(getenv("CRAWL_MEDIA_MAX_PER_RESULT"), 6)
	cfg.NewsSourceInFlightLookbackMs = intDefault(getenv("NEWS_SOURCE_SCHEDULER_INFLIGHT_LOOKBACK_MS"), 21_600_000)
	// The scheduler settings mirror EnvService.newsSourceSchedulerConfig
	// one-for-one. SourceConcurrency is Go-only: the default 1 keeps exactly
	// the serial NestJS loop and lower values are clamped to 1.
	cfg.NewsSourceScheduler = NewsSourceSchedulerSettings{
		Enabled:                    boolDefault(getenv("NEWS_SOURCE_SCHEDULER_ENABLED"), true),
		BatchSize:                  intDefault(getenv("NEWS_SOURCE_SCHEDULER_BATCH_SIZE"), 20),
		LockTTLMs:                  intDefault(getenv("NEWS_SOURCE_SCHEDULER_LOCK_TTL_MS"), 120_000),
		InFlightLookbackMs:         intDefault(getenv("NEWS_SOURCE_SCHEDULER_INFLIGHT_LOOKBACK_MS"), 21_600_000),
		InFlightRescheduleDelayMs:  intDefault(getenv("NEWS_SOURCE_SCHEDULER_INFLIGHT_RESCHEDULE_DELAY_MS"), 300_000),
		JitterMaxMs:                intDefault(getenv("NEWS_SOURCE_SCHEDULER_JITTER_MAX_MS"), 60_000),
		MaxEnqueuePerTick:          intDefault(getenv("NEWS_SOURCE_SCHEDULER_MAX_ENQUEUE_PER_TICK"), 100),
		BackpressureMaxPendingJobs: intDefault(getenv("NEWS_SOURCE_SCHEDULER_BACKPRESSURE_MAX_PENDING_JOBS"), 100),
		BackpressureDelayMs:        intDefault(getenv("NEWS_SOURCE_SCHEDULER_BACKPRESSURE_DELAY_MS"), 300_000),
		FailureRecoveryDelayMs:     intDefault(getenv("NEWS_SOURCE_SCHEDULER_FAILURE_RECOVERY_DELAY_MS"), 600_000),
		FailureMaxDelayMs:          intDefault(getenv("NEWS_SOURCE_SCHEDULER_FAILURE_MAX_DELAY_MS"), 21_600_000),
		CircuitBreakerThreshold:    intDefault(getenv("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_THRESHOLD"), 3),
		CircuitBreakerBaseDelayMs:  intDefault(getenv("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_BASE_DELAY_MS"), 3_600_000),
		CircuitBreakerMaxDelayMs:   intDefault(getenv("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_MAX_DELAY_MS"), 86_400_000),
	}
	sourceConcurrency := intDefault(getenv("NEWS_SOURCE_SCHEDULER_SOURCE_CONCURRENCY"), 1)
	if sourceConcurrency < 1 {
		sourceConcurrency = 1
	}
	cfg.NewsSourceScheduler.SourceConcurrency = sourceConcurrency
	cfg.ItemsSearchRerankEnabled = boolDefault(getenv("ITEMS_SEARCH_RERANK_ENABLED"), true)
	cfg.ItemsReadModelEnabled = boolDefault(getenv("ITEMS_READ_MODEL_ENABLED"), false)
	cfg.ItemsVectorHardFailEnabled = boolDefault(getenv("ITEMS_VECTOR_HARD_FAIL_ENABLED"), false)
	cfg.RealtimeSignalsEnabled = boolDefault(getenv("REALTIME_SIGNALS_ENABLED"), true)
	cfg.RealtimeSignalsTimeoutMs = intDefault(getenv("REALTIME_SIGNALS_REQUEST_TIMEOUT_MS"), 12000)
	cfg.OpenskyEnabled = boolDefault(getenv("REALTIME_SIGNALS_OPENSKY_ENABLED"), true)
	cfg.OpenskyDailyCreditBudget = intDefault(getenv("REALTIME_SIGNALS_OPENSKY_DAILY_CREDIT_BUDGET"), 4000)
	cfg.OpenskyDayIntervalSec = intDefault(getenv("REALTIME_SIGNALS_OPENSKY_DAY_INTERVAL_SEC"), 600)
	cfg.OpenskyNightIntervalSec = intDefault(getenv("REALTIME_SIGNALS_OPENSKY_NIGHT_INTERVAL_SEC"), 1800)
	cfg.OpenskyDayStartHourHKT = intDefault(getenv("REALTIME_SIGNALS_OPENSKY_DAY_START_HKT"), 8)
	cfg.OpenskyNightStartHourHKT = intDefault(getenv("REALTIME_SIGNALS_OPENSKY_NIGHT_START_HKT"), 22)
	cfg.OpenskyWarningRemainingPct = intDefault(getenv("REALTIME_SIGNALS_OPENSKY_WARNING_REMAINING_PCT"), 20)
	cfg.OpenskyCriticalRemainingPct = intDefault(getenv("REALTIME_SIGNALS_OPENSKY_CRITICAL_REMAINING_PCT"), 10)
	cfg.OpenskyBaseURL = strings.TrimRight(stringDefault(getenv("REALTIME_SIGNALS_OPENSKY_BASE_URL"), "https://opensky-network.org/api"), "/")
	cfg.OpenskyTokenURL = strings.TrimRight(stringDefault(getenv("REALTIME_SIGNALS_OPENSKY_TOKEN_URL"), "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"), "/")
	cfg.OpenskyClientID = strings.TrimSpace(getenv("REALTIME_SIGNALS_OPENSKY_CLIENT_ID"))
	cfg.OpenskyClientSecret = strings.TrimSpace(getenv("REALTIME_SIGNALS_OPENSKY_CLIENT_SECRET"))
	cfg.NominatimBaseURL = stringDefault(getenv("GEO_NOMINATIM_BASE_URL"), "https://nominatim.openstreetmap.org")
	// The data runtime settings unit keeps its own typed defaults so its env
	// semantics stay independent of the signal-collector and geocoding fields
	// above.
	cfg.DataRuntimeSettings = loadDataRuntimeSettingsEnv(getenv)
	cfg.NominatimUserAgent = stringDefault(getenv("GEO_NOMINATIM_USER_AGENT"), "modular-api")
	cfg.NominatimEmail = strings.TrimSpace(getenv("GEO_NOMINATIM_EMAIL"))
	cfg.NominatimAcceptLanguage = stringDefault(getenv("GEO_NOMINATIM_ACCEPT_LANGUAGE"), "zh-CN,zh;q=0.9,en;q=0.7")
	cfg.GeocodeTimeoutMs = intDefault(getenv("GEO_GEOCODE_TIMEOUT_MS"), 3000)
	cfg.GeocodeCacheTTLSeconds = intDefault(getenv("GEO_GEOCODE_CACHE_TTL_SECONDS"), 2592000)
	cfg.GeocodeNegativeTTLSeconds = intDefault(getenv("GEO_GEOCODE_NEGATIVE_TTL_SECONDS"), 86400)
	cfg.GeocodeRatePerSecond = intDefault(getenv("GEO_GEOCODE_RATE_LIMIT_PER_SECOND"), 1)
	cfg.TranslationAPIEnabled = boolDefault(getenv("SITUATION_MONITOR_TRANSLATION_API_ENABLED"), true)
	cfg.TranslationAPIBaseURL = strings.TrimRight(stringDefault(getenv("SITUATION_MONITOR_TRANSLATION_API_BASE_URL"), "https://api.deeplx.org"), "/")
	cfg.TranslationTimeoutMs = intDefault(getenv("SITUATION_MONITOR_TRANSLATION_TIMEOUT_MS"), 15000)
	cfg.TranslationMaxRetries = intDefault(getenv("SITUATION_MONITOR_TRANSLATION_MAX_RETRIES"), 2)
	cfg.TranslationFallbackEnabled = boolDefault(getenv("SITUATION_MONITOR_TRANSLATION_FALLBACK_API_ENABLED"), false)
	cfg.TranslationFallbackBaseURL = strings.TrimRight(strings.TrimSpace(getenv("SITUATION_MONITOR_TRANSLATION_FALLBACK_API_BASE_URL")), "/")
	cfg.MongoURI = strings.TrimSpace(getenv("MONGO_URI"))
	// Effective NestJS analysisConfig. ANALYSIS_QUEUE_CONCURRENCY and
	// ANALYSIS_MAX_RETRIES are validated by the NestJS env schema (positive
	// integers), so invalid values fail Go startup too. The prompt, timeout and
	// flush variables are not in that schema; ConfigService reads them from
	// process.env with the defaults below, which is what Go mirrors.
	cfg.AnalysisQueueConcurrency = 2
	if raw := strings.TrimSpace(getenv("ANALYSIS_QUEUE_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, "ANALYSIS_QUEUE_CONCURRENCY must be a positive integer, got "+strconv.Quote(raw))
		} else {
			cfg.AnalysisQueueConcurrency = value
		}
	}
	cfg.AnalysisMaxRetries = 3
	if raw := strings.TrimSpace(getenv("ANALYSIS_MAX_RETRIES")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, "ANALYSIS_MAX_RETRIES must be a positive integer, got "+strconv.Quote(raw))
		} else {
			cfg.AnalysisMaxRetries = value
		}
	}
	cfg.AnalysisPrompts = AnalysisPromptOverrides{
		CorrelationSystem:  promptOverride(getenv, lookup, "ANALYSIS_PROMPT_CORRELATION_SYSTEM"),
		CorrelationUser:    promptOverride(getenv, lookup, "ANALYSIS_PROMPT_CORRELATION_USER"),
		AnomalySystem:      promptOverride(getenv, lookup, "ANALYSIS_PROMPT_ANOMALY_SYSTEM"),
		AnomalyUser:        promptOverride(getenv, lookup, "ANALYSIS_PROMPT_ANOMALY_USER"),
		GeoTransportSystem: promptOverride(getenv, lookup, "ANALYSIS_PROMPT_GEO_TRANSPORT_SYSTEM"),
		GeoTransportUser:   promptOverride(getenv, lookup, "ANALYSIS_PROMPT_GEO_TRANSPORT_USER"),
	}
	cfg.AnalysisLLMTimeoutMs = 300_000
	if raw := strings.TrimSpace(getenv("ANALYSIS_LLM_TIMEOUT_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 0 {
			cfg.AnalysisLLMTimeoutMs = value
		}
	}
	cfg.AnalysisStreamFlushChars = 80
	if raw := strings.TrimSpace(getenv("ANALYSIS_STREAM_FLUSH_CHARS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			if value < 1 {
				value = 1
			}
			cfg.AnalysisStreamFlushChars = value
		}
	}
	cfg.AnalysisStreamFlushMs = 250
	if raw := strings.TrimSpace(getenv("ANALYSIS_STREAM_FLUSH_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			if value < 0 {
				value = 0
			}
			cfg.AnalysisStreamFlushMs = value
		}
	}
	cfg.BullMQWorkersEnabled = true
	if raw := strings.ToLower(strings.TrimSpace(getenv("BULLMQ_WORKERS_ENABLED"))); raw != "" {
		switch raw {
		case "true", "1", "yes", "y", "on":
			cfg.BullMQWorkersEnabled = true
		case "false", "0", "no", "n", "off":
			cfg.BullMQWorkersEnabled = false
		default:
			errs = append(errs, "BULLMQ_WORKERS_ENABLED must be a boolean, got "+strconv.Quote(raw))
		}
	}
	cfg.GraphQLSubscriptionBus = stringDefault(getenv("GRAPHQL_SUBSCRIPTION_BUS"), "redis")
	cfg.SettingsEncryptionKey = strings.TrimSpace(getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY"))
	// 模型接入设置（本批）的原始环境值。这里保留未 trim 的原文：
	// NestJS 的 env schema 只在「整串为空白」时视为未设置，接受值本身不做
	// trim；SYSTEM_SETTINGS_ENCRYPTION_KEY 也没有 preprocess。解析与 go 模式
	// 的启动校验在 internal/modelaccesssettings.NewConfigFromEnv 内完成，
	// legacy 模式完全不受影响。
	cfg.SystemSettingsEncryptionKeyRaw = getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY")
	cfg.ModelServiceEnabledRaw = getenv("MODEL_SERVICE_ENABLED")
	cfg.ModelServiceBaseURLRaw = getenv("MODEL_SERVICE_BASE_URL")
	cfg.ModelServiceInternalTokenRaw = getenv("MODEL_SERVICE_INTERNAL_TOKEN")
	cfg.ModelServiceTimeoutMsRaw = getenv("MODEL_SERVICE_TIMEOUT_MS")
	cfg.ModelServiceMaxRetriesRaw = getenv("MODEL_SERVICE_MAX_RETRIES")
	cfg.LiteLLMConfigInternalTokenRaw = getenv("LITELLM_CONFIG_INTERNAL_TOKEN")
	cfg.NodeEnvRaw = getenv("NODE_ENV")
	cfg.LiteLLMAPIBase = strings.TrimSpace(getenv("LITELLM_API_URL"))
	if cfg.LiteLLMAPIBase == "" {
		cfg.LiteLLMAPIBase = strings.TrimSpace(getenv("LITELLM_API_BASE"))
	}
	if cfg.LiteLLMAPIBase == "" {
		cfg.LiteLLMAPIBase = "http://localhost:4001"
	}
	cfg.LiteLLMAPIKey = strings.TrimSpace(getenv("LITELLM_API_KEY"))
	cfg.LiteLLMTimeoutMs = 60_000
	if raw := strings.TrimSpace(getenv("LITELLM_TIMEOUT_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			cfg.LiteLLMTimeoutMs = value
		}
	}
	cfg.LiteLLMMaxRetries = 3
	retryRaw := strings.TrimSpace(getenv("LITELLM_RETRY_ATTEMPTS"))
	if retryRaw == "" {
		retryRaw = strings.TrimSpace(getenv("LITELLM_MAX_RETRIES"))
	}
	if retryRaw != "" {
		if value, err := strconv.Atoi(retryRaw); err == nil && value > 0 {
			cfg.LiteLLMMaxRetries = value
		}
	}
	// LITELLM_MASTER_KEY 只用于 LiteLLM 管理接口。保留原文，使用时再 trim/去
	// Bearer，与 NestJS normalizeSecret 一致；空串与纯空白都等于未配置。
	cfg.LiteLLMMasterKey = getenv("LITELLM_MASTER_KEY")
	// 本批 profile 默认值的 LITELLM_* 投影（镜像 NestJS env schema）。
	cfg.LLMGatewayModel = stringDefault(getenv("LITELLM_MODEL"), "openai/gpt-4o-mini")
	cfg.LLMGatewayTemperature = floatDefault(getenv("LITELLM_TEMPERATURE"), 0.2)
	cfg.LLMGatewayTopP = floatDefault(getenv("LITELLM_TOP_P"), 0.9)
	// LITELLM_MAX_TOKENS 在 env schema 里有默认值 2048，所以
	// LITELLM_MAX_OUTPUT_TOKENS 永远不会生效；Go 侧同样优先 MAX_TOKENS 本身。
	cfg.LLMGatewayMaxOutputTokens = 2048
	if value := positiveInt(getenv("LITELLM_MAX_TOKENS")); value > 0 {
		cfg.LLMGatewayMaxOutputTokens = value
	}
	// LITELLM_RETRY_ATTEMPTS 同理（schema 默认 3）。
	cfg.LLMGatewayMaxRetries = 3
	if value := positiveInt(getenv("LITELLM_RETRY_ATTEMPTS")); value > 0 {
		cfg.LLMGatewayMaxRetries = value
	}
	cfg.LLMGatewayFallbackModels = splitCommaList(getenv("LITELLM_FALLBACK_MODELS"))
	cfg.LLMGatewaySettingsEncryptionKey = getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY")
	cfg.NodeEnvProduction = strings.TrimSpace(getenv("NODE_ENV")) == "production"
	cfg.CorsOrigin = getenv("CORS_ORIGIN")

	// JWT 验签配置（issuer/audience 默认值与 NestJS env schema 一致——
	// 保证与同一套 env 部署的 api 服务行为等价）。
	cfg.JWTSecret = strings.TrimSpace(getenv("JWT_SECRET"))
	cfg.JWTIssuer = strings.TrimSpace(getenv("JWT_ISSUER"))
	if cfg.JWTIssuer == "" {
		cfg.JWTIssuer = defaultJWTIssuer
	}
	cfg.JWTAudience = strings.TrimSpace(getenv("JWT_AUDIENCE"))
	if cfg.JWTAudience == "" {
		cfg.JWTAudience = defaultJWTAudience
	}
	cfg.JWTAccessExpiresIn = strings.TrimSpace(getenv("JWT_ACCESS_EXPIRES_IN"))
	if cfg.JWTAccessExpiresIn == "" {
		cfg.JWTAccessExpiresIn = "15m"
	}
	cfg.JWTRefreshExpiresIn = strings.TrimSpace(getenv("JWT_REFRESH_EXPIRES_IN"))
	if cfg.JWTRefreshExpiresIn == "" {
		cfg.JWTRefreshExpiresIn = "7d"
	}

	// Redis（blacklist）配置。Port/DB 有默认值；Username/Password 可空
	//（镜像 NestJS 的可选语义）。
	cfg.RedisHost = strings.TrimSpace(getenv("REDIS_HOST"))
	cfg.RedisPort = defaultRedisPort
	if raw := strings.TrimSpace(getenv("REDIS_PORT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 || value > 65535 {
			errs = append(errs, fmt.Sprintf("REDIS_PORT must be a valid port number, got %q", raw))
		} else {
			cfg.RedisPort = value
		}
	}
	cfg.RedisUsername = strings.TrimSpace(getenv("REDIS_USERNAME"))
	cfg.RedisPassword = strings.TrimSpace(getenv("REDIS_PASSWORD"))
	if raw := strings.TrimSpace(getenv("REDIS_DB")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			errs = append(errs, fmt.Sprintf("REDIS_DB must be a non-negative integer, got %q", raw))
		} else {
			cfg.RedisDB = value
		}
	}

	// The clustering recovery worker reads the same process-queue concurrency
	// the NestJS processor uses and clamps it to max(1, min(2, value)).
	cfg.NewsProcessQueueConcurrency = intDefault(getenv("NEWS_PROCESS_QUEUE_CONCURRENCY"), 8)
	cfg.NewsSourceSchedulerFailureRecoveryDelayMs = intDefault(getenv("NEWS_SOURCE_SCHEDULER_FAILURE_RECOVERY_DELAY_MS"), 600_000)
	cfg.NewsSourceSchedulerFailureMaxDelayMs = intDefault(getenv("NEWS_SOURCE_SCHEDULER_FAILURE_MAX_DELAY_MS"), 21_600_000)
	cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs = intDefault(getenv("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_BASE_DELAY_MS"), 3_600_000)
	cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs = intDefault(getenv("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_MAX_DELAY_MS"), 86_400_000)
	cfg.NewsSourceSchedulerCircuitBreakerThreshold = floatDefault(getenv("NEWS_SOURCE_SCHEDULER_CIRCUIT_BREAKER_THRESHOLD"), 3)
	cfg.NewsSourceSchedulerAutoDisableThreshold = floatDefault(getenv("NEWS_SOURCE_SCHEDULER_AUTO_DISABLE_THRESHOLD"), 0)

	// 依赖前置校验：不得在依赖缺失时启动一个必然失败的「Go 接管端点」——
	// 启动即失败，错误只指出缺失的配置项名，不打印值。
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	appendSpacetimeRequirements(&errs, cfg)
	appendSpacetimeRequirements(&errs, cfg)
	appendSpacetimeRequirements(&errs, cfg)
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The public liveness probe and the Swagger takeover are self-contained
	// handlers: neither needs JWT, MySQL, Redis or Mongo at startup.
	//
	// The vector diagnostics route reuses the shared settings read path and the
	// ordinary authentication chain, so it needs exactly the same resources as
	// the infrastructure settings takeover.
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The background digest delivery unit owns the Cron without JWT/RBAC: it
	// reads MySQL, Redis, Mongo and the real SMTP transport, so no HTTP
	// takeover switch or JWT_SECRET is required for it.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.SMTP.Host == "" {
		errs = append(errs, "SMTP_HOST is required")
	}
	if cfg.SMTP.Port == 0 {
		errs = append(errs, "SMTP_PORT is required")
	}
	if cfg.SMTP.User == "" {
		errs = append(errs, "SMTP_USER is required")
	}
	if cfg.SMTP.Pass == "" {
		errs = append(errs, "SMTP_PASS is required")
	}
	// The audit outbox replay unit is a background owner like digest delivery:
	// it reads and writes MySQL and takes the cron lease in Redis. It verifies
	// no JWT, reads no Mongo collection, sends no mail and registers no route,
	// so every HTTP switch can stay legacy.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The knowledge-graph ingestion chain owns the Cron without JWT/RBAC: it
	// reads MySQL, Redis and the same gateway profiles publicportal uses. The
	// model gateway itself is resolved at request time, so it is not a startup
	// requirement (a missing profile only skips validation/disambiguation and
	// still writes the graph). Mongo is optional: the LLM request log is
	// best-effort, exactly like every other writer.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The news-event ingestion scheduler owns the five-minute Cron without
	// JWT/RBAC: it reads MySQL (cursor, events), Redis (tick gate, organization
	// leases, active-org cache) and Mongo (ProcessedItem, TaskLog, clustering
	// failures). The vector and model services are resolved per call, so they are
	// not startup requirements: a missing service only degrades the assignment
	// path exactly like a missing service degrades the NestJS path.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The alert worker owns the shared `alerts` queue without JWT/RBAC: it reads
	// MySQL, Redis and Mongo and sends through the real SMTP transport, so it
	// needs no HTTP takeover switch. The model service is optional: the economic
	// anomaly provider falls back to its local detector when it is unavailable.
	// The Frontier LLM worker owner consumes the two LLM queues without
	// JWT/RBAC. The model gateway profile and the managed governance key are
	// decrypted with SYSTEM_SETTINGS_ENCRYPTION_KEY, so an empty key would make
	// every judge/learn call fail at runtime instead of at startup.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.SystemSettingsEncryptionKeyRaw == "" {
		errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required")
	}
	// The three crawl4ai queue workers write CrawlTask/CrawlResult/PipelineJob/
	// NewsSource/Notification rows in MySQL, the BullMQ protocol and the crawl
	// activity/cooldown keys in Redis, CrawlResultContent/TaskLog/media asset
	// documents in Mongo, request crawl4ai over HTTP and upload stored media to
	// object storage. The storage settings may hold an encrypted S3 secret, so
	// the settings key is required as well; the frontier node processor is
	// checked at wiring time because config cannot see Go values.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if strings.TrimSpace(cfg.CrawlBaseURL) == "" {
		errs = append(errs, "CRAWL4AI_BASE_URL is required")
	}
	if strings.TrimSpace(cfg.SettingsEncryptionKeyRaw) == "" {
		errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.SMTP.Host == "" {
		errs = append(errs, "SMTP_HOST is required")
	}
	if cfg.SMTP.Port == 0 {
		errs = append(errs, "SMTP_PORT is required")
	}
	if cfg.SMTP.User == "" {
		errs = append(errs, "SMTP_USER is required")
	}
	if cfg.SMTP.Pass == "" {
		errs = append(errs, "SMTP_PASS is required")
	}
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	// The CSV export takeover reads MySQL (NewsEvent/NewsEventItem and the
	// membership chain), Redis (revocation list and the behavior profile) and
	// Mongo (the read-model projection), and it verifies JWTs (including the
	// mtk_ machine tokens) before selecting candidates.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The archive reading unit verifies JWTs (human and mtk_), reads the Redis
	// revocation list, re-derives membership from MySQL, reads Mongo display
	// signals and writes Mongo model attempt logs. It also uses the shared Redis
	// cache/metrics and the BullMQ preparation queue.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The request producer needs JWT (permission and identity), MySQL
	// (membership re-derivation), Redis (the analysis queue) and Mongo (the
	// pending analysisresults row).
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The residual-duty switches. The cleanup, review-seed and startup units are
	// Redis-only; the two HTTP units need the credentialed stack, and both
	// pipeline writes also read and write Mongo.
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The worker owner needs no JWT: it consumes jobs, computes, streams the
	// model, writes Mongo/MySQL and publishes the GraphQL subscription event.
	// The event must reach the existing Redis backplane, so a local bus is not
	// a valid owner configuration.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.GraphQLSubscriptionBus != "redis" {
		errs = append(errs, "GRAPHQL_SUBSCRIPTION_BUS must be redis")
	}
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}

	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The exception ingest takeover writes into the existing exceptionevents
	// Mongo collection, so it needs Mongo on top of the JWT/MySQL/Redis
	// requirements. A missing LITELLM_CONFIG_INTERNAL_TOKEN is an endpoint
	// contract (403) and must not fail startup.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	appendAuthRequirements(&errs, cfg)
	// The platform governance settings takeover reads Mongo (assistant quota
	// usage, assistant safety metrics) and reconciles Mongo TTL indexes (task
	// logs, llm request logs), so it needs the standard JWT + MySQL + Redis
	// requirements plus MONGO_URI.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}

	// The report creation takeover reports a job through Redis and stores it in
	// Mongo, so it needs the full credentialed stack.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The worker consumes the shared queue: it needs MySQL (source and article
	// context), Redis (the queue) and Mongo (reports, reviews, annotations), but
	// no JWT because it never authenticates a caller.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The runs read joins MySQL and Mongo behind the normal JWT verifier; it
	// never touches Redis.
	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}

	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The two NewsNow hot reading routes need the credentialed stack plus Mongo
	// (rawitems, processeditems, NewsEventItem via MySQL) and the model gateway.
	appendSpacetimeRequirements(&errs, cfg)
	// The background owners synchronize their snapshots and projections through
	// the same MySQL/Redis/Mongo stores. They never authenticate a caller.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The public source fetch takeover needs MySQL for the global runtime-secret
	// row and Redis for the compatible cache, refresh lock and relay. The two
	// routes are public, so JWT_SECRET, Mongo, GraphQL and model switches are
	// deliberately not required.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// Crawl read/telemetry takeover reads crawlresultcontents and tasklogs from
	// Mongo in addition to the standard JWT + MySQL + Redis requirements.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The metadata preview takeover needs the credentialed auth stack plus
	// Redis (the shared discovery conditional HTTP state) and outbound HTTP/DNS.
	// It reads no Mongo collection, so MONGO_URI is not required and the entry
	// can run while every other crawl mode is legacy.
	appendAuthRequirements(&errs, cfg)
	// The crawl task write takeover needs the credentialed stack: JWT verify,
	// Redis revocation/counters and MySQL task/audit writes. It starts no worker
	// and calls no crawl4ai endpoint.
	appendAuthRequirements(&errs, cfg)
	// The queue administration takeover reads and writes Redis queue meta,
	// counts, activity counters and the crawl settings row; MySQL and Redis are
	// both required and Mongo is not.
	appendAuthRequirements(&errs, cfg)
	// The crawl maintenance crons write MySQL rows, take Redis leases and
	// touch Mongo documents, so go requires all three and no JWT.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The audit retention purge reads the shared retention cache and deletes
	// AuditLog rows; Mongo and JWT are not involved.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The news-source preview takeover needs the credentialed auth stack plus
	// Redis (shared with the deep-discovery failure state). crawl4ai is optional
	// at startup, exactly like NestJS.
	appendAuthRequirements(&errs, cfg)
	// The crawl-strategy trial/replay takeover needs the credentialed auth
	// stack plus Redis and MySQL for the run records. crawl4ai is optional.
	appendAuthRequirements(&errs, cfg)
	// The news-source scheduler writes the MySQL due-source state and takes the
	// shared Redis lock, so it needs MySQL and Redis but no JWT: it serves no
	// route.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The four ops POSTs re-derive the caller's crawl.write permission from the
	// credentialed JWT/MySQL/Redis stack.
	appendAuthRequirements(&errs, cfg)
	// The search reindex takeover reads the item read model from Mongo, so
	// MONGO_URI is required in addition to the standard JWT + MySQL + Redis
	// requirements. Elasticsearch is optional at startup: the disabled branch
	// completes with indexed=0.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The runtime/governance settings takeover needs JWT verification, MySQL
	// and Redis only; it reads no Mongo collection and starts no worker.
	appendAuthRequirements(&errs, cfg)
	// The model access settings takeover needs JWT verification, MySQL and Redis
	// only (the model_service and openai_keys rows live in MySQL, the 30 second
	// cache envelopes live in Redis). It reads no Mongo collection, calls no model
	// upstream and starts no worker. Neither the encryption key nor the LiteLLM
	// internal token is a startup requirement: their absence has runtime semantics
	// (a fail-closed 400 at write time and a 403 on the internal endpoints).
	appendAuthRequirements(&errs, cfg)
	// The item reading takeover reads MySQL, Mongo and Redis, and needs JWT
	// verification for both the REST routes and the GraphQL roots.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The items write mode needs the credentialed stack plus Mongo. The
	// immediate raw_item delivery is executed by the request handler.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The raw_item replay owner is a background unit: it needs MySQL, Redis and
	// Mongo for hydration but verifies no JWT and registers no route.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The processed_item compensation owner reads MySQL and Mongo, takes its
	// scan lease in Redis and resolves vector settings at delivery time. It
	// verifies no JWT and registers no route.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The items connection root reuses the item reading service and the shared
	// GraphQL executor, so it has hard parent dependencies instead of silently
	// enabling a parent switch. The Mongo requirement is already implied by the
	// two parents.

	appendAuthRequirements(&errs, cfg)
	// The governance/diagnostics takeover additionally writes the LLM request
	// log through the shared Mongo client, so MONGO_URI is required. Neither the
	// LiteLLM master key nor the settings-encryption key is a startup
	// requirement: a missing master key is a 503 on the management calls and a
	// missing encryption key makes the managed key "unreadable" on read.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The proxy load balancing takeover has exactly the same infrastructure
	// footprint: the litellm_proxy_load_balancing row lives in MySQL, its 30
	// second cache envelope lives in Redis, and it re-reads the existing
	// openai_keys row instead of calling NestJS. LITELLM_CONFIG_INTERNAL_TOKEN
	// and SYSTEM_SETTINGS_ENCRYPTION_KEY keep their runtime semantics and are
	// never startup requirements.
	appendAuthRequirements(&errs, cfg)
	// The infrastructure settings takeover needs JWT verification, MySQL and
	// Redis only. It reads no Mongo collection, starts no worker and does not
	// treat the settings-encryption key as a startup requirement: a missing or
	// invalid key is handled per read/write by the documented fallback and 400
	// contracts.
	appendAuthRequirements(&errs, cfg)
	// The storage connection test takeover needs JWT verification, MySQL (the
	// real SELECT 1 and the settings read) and Redis (the storage settings
	// cache) only. It reads no Mongo collection, requires no other takeover
	// switch, builds no S3 client at startup and performs no startup probe: the
	// diagnostics run inside the request and report failures per step.
	appendAuthRequirements(&errs, cfg)
	// The data runtime settings takeover needs JWT verification, MySQL and Redis
	// only. It reads no Mongo collection, starts no worker, performs no startup
	// network probe and does not treat the settings-encryption key as a startup
	// requirement.
	appendAuthRequirements(&errs, cfg)
	// The email settings takeover performs a real SMTP verify and can send a
	// real test message, so it requires the transport in addition to the
	// credentialed JWT/MySQL/Redis stack.
	appendAuthRequirements(&errs, cfg)
	if cfg.SMTP.Host == "" {
		errs = append(errs, "SMTP_HOST is required")
	}
	if cfg.SMTP.Port == 0 {
		errs = append(errs, "SMTP_PORT is required")
	}
	if cfg.SMTP.User == "" {
		errs = append(errs, "SMTP_USER is required")
	}
	if cfg.SMTP.Pass == "" {
		errs = append(errs, "SMTP_PASS is required")
	}
	// The geocoding takeover needs JWT verification, MySQL and Redis (the
	// identity row and the shared cache/rate-limit keys). It contacts Nominatim
	// only inside a request, so no external endpoint is a startup requirement.
	appendAuthRequirements(&errs, cfg)
	// The runtime diagnostics takeover reads Redis, MySQL and Mongo and probes
	// LiteLLM inside the request. Mongo is required because the marker
	// readiness section aggregates processeditems; no LiteLLM endpoint is a
	// startup requirement.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The authenticated MFA management / OIDC configuration takeover needs JWT
	// verification, MySQL and Redis only. It reads no Mongo collection, starts
	// no worker and never contacts an identity provider. The
	// settings-encryption key stays optional at startup: a missing or invalid
	// key is handled per write by the documented fallback and production-500
	// contracts rather than blocking boot.
	appendAuthRequirements(&errs, cfg)
	// The account/session/machine-token takeover needs JWT verification, MySQL
	// and Redis only. It reads no Mongo collection, starts no worker and does
	// not add a second startup check: it reuses appendAuthRequirements exactly
	// like the other takeover switches.
	appendAuthRequirements(&errs, cfg)
	// The avatar presign route needs JWT verification, MySQL (the storage
	// settings read) and Redis (the settings cache). It signs locally and never
	// requires Mongo or S3 connectivity.
	appendAuthRequirements(&errs, cfg)
	// The data export reads MySQL, Redis (rate limit + behavior profile) and
	// Mongo (assistantruns), and verifies the caller's JWT.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The login/session/email-code takeover needs JWT verification, MySQL, Redis
	// and a real SMTP transport: four of its routes send mail synchronously
	// inside the request. It reads no Mongo collection, starts no worker and
	// keeps the settings-encryption key optional at startup, deferring the
	// existing per-write policy to the reused MFA factor service.
	appendAuthRequirements(&errs, cfg)
	if cfg.SMTP.Host == "" {
		errs = append(errs, "SMTP_HOST is required")
	}
	if cfg.SMTP.Port == 0 {
		errs = append(errs, "SMTP_PORT is required")
	}
	if cfg.SMTP.User == "" {
		errs = append(errs, "SMTP_USER is required")
	}
	if cfg.SMTP.Pass == "" {
		errs = append(errs, "SMTP_PASS is required")
	}
	// The OIDC login takeover needs JWT signing/verification, MySQL and Redis
	// only. It starts no worker and contacts the IdP only when a request needs
	// discovery/token/JWKS, so no IdP URL or secret is a startup condition.
	appendAuthRequirements(&errs, cfg)
	// The registration/invitation takeover needs the same credentialed stack as
	// the login batch plus the real SMTP transport: invitation creation, resend
	// and the two rejection paths send mail synchronously. It reads no Mongo
	// collection, starts no worker and contacts no identity provider.
	appendAuthRequirements(&errs, cfg)
	if cfg.SMTP.Host == "" {
		errs = append(errs, "SMTP_HOST is required")
	}
	if cfg.SMTP.Port == 0 {
		errs = append(errs, "SMTP_PORT is required")
	}
	if cfg.SMTP.User == "" {
		errs = append(errs, "SMTP_USER is required")
	}
	if cfg.SMTP.Pass == "" {
		errs = append(errs, "SMTP_PASS is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The realtime subscription transport verifies JWTs, re-derives membership
	// in MySQL and reads Redis, but never opens Mongo or starts a worker.
	appendAuthRequirements(&errs, cfg)
	// The notifications transport verifies JWTs, re-derives membership in
	// MySQL and reads Redis. It never opens Mongo or starts a worker.
	appendAuthRequirements(&errs, cfg)
	// The five-namespace realtime transport uses the same JWT/MySQL/Redis
	// stack and additionally depends on the Redis adapter broadcast channel
	// for newsnow. Disabling the adapter silently would make Go receive no
	// newsnow events at all, so the combination is rejected at startup.
	appendAuthRequirements(&errs, cfg)
	if !cfg.WSRedisAdapterEnabled {
		errs = append(errs, "WS_REDIS_ADAPTER_ENABLED=true")
	}
	// The classification quality alert scheduler reads the summary documents
	// from Mongo, the active organizations and matcher tables from MySQL and the
	// shared tick gate / organization leases from Redis. It authenticates no
	// caller, so JWT_SECRET is intentionally not required.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The organization access write takeover needs JWT verification, MySQL and
	// Redis only. It reads no Mongo collection and starts no worker, so it does
	// not require MONGO_URI.
	appendAuthRequirements(&errs, cfg)
	// The workspace write takeover needs JWT verification, MySQL and Redis
	// only. Reusing the workspace, alert and history models does not make
	// MONGO_URI, the model gateway or the queue a startup condition.
	appendAuthRequirements(&errs, cfg)
	// The alert rule unit needs JWT verification, MySQL and Redis. The queue
	// writes reuse the shared Redis client and do not require Mongo, the model
	// gateway, SMTP or a worker in this process.
	appendAuthRequirements(&errs, cfg)
	// The settings write takeover needs JWT verification, MySQL and Redis only.
	// It reads no Mongo collection, starts no worker and calls no upstream
	// service, so it does not require MONGO_URI.
	appendAuthRequirements(&errs, cfg)
	// The source-policy write takeover needs the same JWT/MySQL/Redis stack. It
	// stores SystemSetting documents and refreshes shared Redis keys only; there
	// is no Mongo collection, worker, queue or upstream call.
	appendAuthRequirements(&errs, cfg)
	// The knowledge-graph evidence review takeover needs JWT verification, MySQL
	// and Redis only. It reads no Mongo collection, starts no worker and calls
	// no model or crawl upstream, so it does not require MONGO_URI.
	appendAuthRequirements(&errs, cfg)
	// The RSS translation takeover needs JWT verification, MySQL, Redis and
	// Mongo: processeditems and llmrequestlogs live in Mongo, the two
	// translation caches live in Redis and the daily metrics row lives in
	// MySQL. Provider URLs, keys, profiles and the encryption key are resolved
	// per request and are not startup conditions; no provider is probed.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The assistant write takeover needs JWT verification, MySQL, Redis and
	// Mongo: assistantruns and llmrequestlogs live in Mongo, the BullMQ queue
	// and the subscription bus in Redis, and the quota/settings/profiles in
	// MySQL. It starts no worker and does not probe LiteLLM or the model
	// service at startup.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The assistant worker needs MySQL, Redis and Mongo but no JWT: it consumes
	// the queue and writes runs/logs without serving HTTP.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}

	// The situation monitor signals takeover needs the credentialed auth stack
	// plus Redis (the cached signal state) and Mongo (feedback writes
	// situationsignalfeedbacks and situationsignallearningstates).
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}

	if cfg.JWTSecret == "" {
		errs = append(errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The insights takeover reads ProcessedItem/RawItem and the two Mongo
	// learning-state documents, and uses the same JWT/MySQL/Redis stack as the
	// signals routes.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The situation settings takeover reads and writes the settings row (MySQL
	// + Redis envelope), builds the quality summary through the insights
	// pipeline (Mongo) and encrypts credentials with the shared
	// system-settings:v1 envelope. The encryption key is therefore a startup
	// requirement in go mode; a malformed key keeps the per-request 400 /
	// decrypt-as-absent behavior documented by the service.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.SettingsEncryptionKeyRaw == "" {
		errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required")
	}
	// The signals worker consumes the migrated queue and writes the shared
	// Redis state, the single-instance Telegram lease and the event bridge; the
	// settings row and the default OREF alert rules are MySQL. It serves no HTTP
	// route, so JWT_SECRET is not a startup requirement.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The refresh takeover serves authenticated HTTP, reorders the
	// organization's active news sources, counts CrawlTask/PipelineJob rows and
	// writes the 900 second refresh-run record, so it needs the credentialed
	// stack plus MySQL and Redis. Two prerequisite switches must already be go:
	// Telegram sessions may only be used by the Go lease owner (a second
	// connection raises AUTH_KEY_DUPLICATED), and the immediate dispatch entry
	// point lives in the Go news source scheduler under the shared
	// cron:news-source-scheduler lease.
	appendAuthRequirements(&errs, cfg)
	// The Telegram login takeover serves authenticated HTTP, stores the pending
	// request in Redis, encrypts the final session into the settings row and
	// returns the controller's quality summary, so it needs the full
	// settings/vault stack.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.SettingsEncryptionKeyRaw == "" {
		errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required")
	}
	// The manual LLM backfill enqueue route authenticates a human or machine
	// caller, reads the Mongo failure group, writes its claim and adds a BullMQ
	// job, so it needs the full stack. The recovery worker consumes the same
	// queue and writes the same Mongo/MySQL records but serves no HTTP request,
	// so JWT_SECRET is not a startup condition for it. The six-hour association
	// refresh needs MySQL and Redis only: it reuses the newsindicator refresh
	// and its organization session lock, and writes no Mongo document.
	appendAuthRequirements(&errs, cfg)
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if strings.TrimSpace(cfg.SettingsEncryptionKeyRaw) == "" {
		errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if strings.TrimSpace(cfg.SettingsEncryptionKeyRaw) == "" {
		errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required")
	}
	appendAuthRequirements(&errs, cfg)
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// Both cron units are background owners like the GDELT snapshot scheduler:
	// they write MySQL rows under a Redis lease, read the Mongo processed items
	// and register no route, so every HTTP switch (and JWT_SECRET) can stay
	// legacy.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The GDELT snapshot scheduler writes the MySQL history row and both Redis
	// cache layers, so it needs MySQL and Redis but no JWT: it serves no route.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	// The realtime signal collector writes the shared Redis documents and the
	// Mongo transport tracks, and reads settings, organizations and processed
	// articles from MySQL. It serves no route, so it needs no JWT.
	if cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}
	// The forced-refresh route re-derives the caller's settings.manage
	// permission from the credentialed JWT/MySQL/Redis stack.
	appendAuthRequirements(&errs, cfg)

	if len(errs) > 0 {
		return Config{}, errors.New(strings.Join(errs, "; "))
	}
	return cfg, nil
}

// positiveInt parses a decimal environment value and returns 0 when it is absent
// or not a positive integer.
func positiveInt(value string) int {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed <= 0 {
		return 0
	}
	return parsed
}

// splitCommaList mirrors the NestJS LITELLM_FALLBACK_MODELS handling: split on
// commas, trim and drop empty entries.
func splitCommaList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

func appendAuthRequirements(errs *[]string, cfg Config) {
	if cfg.JWTSecret == "" {
		*errs = append(*errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		*errs = append(*errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		*errs = append(*errs, "REDIS_HOST is required")
	}
}

func appendSpacetimeRequirements(errs *[]string, cfg Config) {
	if cfg.JWTSecret == "" {
		*errs = append(*errs, "JWT_SECRET is required")
	}
	if cfg.DatabaseURL == "" {
		*errs = append(*errs, "DATABASE_URL is required")
	}
	if cfg.RedisHost == "" {
		*errs = append(*errs, "REDIS_HOST is required")
	}
	if cfg.MongoURI == "" {
		*errs = append(*errs, "MONGO_URI is required")
	}
}

// loadDataRuntimeSettingsEnv resolves the environment defaults of the data
// runtime settings unit.
//
// Every default below mirrors the NestJS apiEnvSchema entry and the
// EnvService.realtimeSignalsConfig getter one-for-one, including the OpenSky
// "ADSB never applies" precedence documented on DataRuntimeSettingsEnv.
func loadDataRuntimeSettingsEnv(getenv func(string) string) DataRuntimeSettingsEnv {
	return DataRuntimeSettingsEnv{
		RealtimeEnabled:                  boolDefault(getenv("REALTIME_SIGNALS_ENABLED"), true),
		RealtimeRequestTimeoutMs:         intDefault(getenv("REALTIME_SIGNALS_REQUEST_TIMEOUT_MS"), 12_000),
		RealtimeMaxRetries:               intDefault(getenv("REALTIME_SIGNALS_MAX_RETRIES"), 2),
		RealtimeOpenskyEnabled:           boolDefault(getenv("REALTIME_SIGNALS_OPENSKY_ENABLED"), true),
		RealtimeOpenskyIntervalSec:       intDefault(getenv("REALTIME_SIGNALS_OPENSKY_INTERVAL_SEC"), 900),
		RealtimeOpenskyDailyCreditBudget: intDefault(getenv("REALTIME_SIGNALS_OPENSKY_DAILY_CREDIT_BUDGET"), 4000),
		RealtimeOpenskyDayIntervalSec:    intDefault(getenv("REALTIME_SIGNALS_OPENSKY_DAY_INTERVAL_SEC"), 600),
		RealtimeOpenskyNightIntervalSec:  intDefault(getenv("REALTIME_SIGNALS_OPENSKY_NIGHT_INTERVAL_SEC"), 1800),
		RealtimeOpenskyDayStartHourHKT:   intDefault(getenv("REALTIME_SIGNALS_OPENSKY_DAY_START_HKT"), 8),
		RealtimeOpenskyNightStartHourHKT: intDefault(getenv("REALTIME_SIGNALS_OPENSKY_NIGHT_START_HKT"), 22),
		RealtimeOpenskyWarningRemaining:  intDefault(getenv("REALTIME_SIGNALS_OPENSKY_WARNING_REMAINING_PCT"), 20),
		RealtimeOpenskyCriticalRemaining: intDefault(getenv("REALTIME_SIGNALS_OPENSKY_CRITICAL_REMAINING_PCT"), 10),
		RealtimeOpenskyBaseURL:           stringDefault(getenv("REALTIME_SIGNALS_OPENSKY_BASE_URL"), "https://opensky-network.org/api"),
		RealtimeOpenskyTokenURL:          stringDefault(getenv("REALTIME_SIGNALS_OPENSKY_TOKEN_URL"), "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"),
		RealtimeOpenskyClientID:          strings.TrimSpace(getenv("REALTIME_SIGNALS_OPENSKY_CLIENT_ID")),
		RealtimeOpenskyClientSecret:      strings.TrimSpace(getenv("REALTIME_SIGNALS_OPENSKY_CLIENT_SECRET")),
		RealtimeAisEnabled:               boolDefault(getenv("REALTIME_SIGNALS_AIS_ENABLED"), true),
		RealtimeAisIntervalSec:           intDefault(getenv("REALTIME_SIGNALS_AIS_INTERVAL_SEC"), 600),
		RealtimeUnrestEnabled:            boolDefault(getenv("REALTIME_SIGNALS_UNREST_ENABLED"), true),
		RealtimeUnrestIntervalSec:        intDefault(getenv("REALTIME_SIGNALS_UNREST_INTERVAL_SEC"), 600),
		RealtimeOutagesEnabled:           boolDefault(getenv("REALTIME_SIGNALS_OUTAGES_ENABLED"), true),
		RealtimeOutagesIntervalSec:       intDefault(getenv("REALTIME_SIGNALS_OUTAGES_INTERVAL_SEC"), 600),
		RealtimeKeywordSpikeEnabled:      boolDefault(getenv("REALTIME_SIGNALS_KEYWORD_SPIKE_ENABLED"), true),
		RealtimeKeywordSpikeIntervalSec:  intDefault(getenv("REALTIME_SIGNALS_KEYWORD_SPIKE_INTERVAL_SEC"), 600),
		RealtimePizzintEnabled:           boolDefault(getenv("REALTIME_SIGNALS_PIZZINT_ENABLED"), true),
		RealtimePizzintIntervalSec:       intDefault(getenv("REALTIME_SIGNALS_PIZZINT_INTERVAL_SEC"), 600),
		RealtimeGdeltTensionEnabled:      boolDefault(getenv("REALTIME_SIGNALS_GDELT_TENSION_ENABLED"), true),
		RealtimeGdeltTensionIntervalSec:  intDefault(getenv("REALTIME_SIGNALS_GDELT_TENSION_INTERVAL_SEC"), 600),
		RealtimePolymarketLeadsEnabled:   boolDefault(getenv("REALTIME_SIGNALS_POLYMARKET_LEADS_ENABLED"), true),
		RealtimePolymarketIntervalSec:    intDefault(getenv("REALTIME_SIGNALS_POLYMARKET_LEADS_INTERVAL_SEC"), 600),
		RealtimeKeywordSpikeMinCount:     intDefault(getenv("REALTIME_SIGNALS_KEYWORD_SPIKE_MIN_COUNT"), 5),
		RealtimeKeywordSpikeMultiplier:   floatDefault(getenv("REALTIME_SIGNALS_KEYWORD_SPIKE_MULTIPLIER"), 3),
		RealtimePredictionShiftThreshold: floatDefault(getenv("REALTIME_SIGNALS_PREDICTION_SHIFT_THRESHOLD"), 5),
		RealtimePredictionNewsThreshold:  intDefault(getenv("REALTIME_SIGNALS_PREDICTION_NEWS_ACTIVITY_THRESHOLD"), 3),
		// `AIS_BASE_URL ?? RELAY_BASE_URL` and
		// `AIS_SHARED_SECRET ?? AIS_RELAY_SHARED_SECRET ?? RELAY_SHARED_SECRET`:
		// all three name sets are optional with no schema default, so the same
		// fallback order is reproduced here.
		RealtimeAisBaseURL: firstNonEmptyString(
			strings.TrimSpace(getenv("REALTIME_SIGNALS_AIS_BASE_URL")),
			strings.TrimSpace(getenv("REALTIME_SIGNALS_RELAY_BASE_URL")),
		),
		RealtimeAisSharedSecret: firstNonEmptyString(
			strings.TrimSpace(getenv("REALTIME_SIGNALS_AIS_SHARED_SECRET")),
			strings.TrimSpace(getenv("AIS_RELAY_SHARED_SECRET")),
			strings.TrimSpace(getenv("REALTIME_SIGNALS_RELAY_SHARED_SECRET")),
		),
		RealtimeAcledOauthUsername: strings.TrimSpace(getenv("REALTIME_SIGNALS_ACLED_USERNAME")),
		RealtimeAcledOauthPassword: strings.TrimSpace(getenv("REALTIME_SIGNALS_ACLED_PASSWORD")),
		RealtimeAcledOauthClientID: strings.TrimSpace(getenv("REALTIME_SIGNALS_ACLED_CLIENT_ID")),
		RealtimeCloudflareAPIToken: strings.TrimSpace(getenv("REALTIME_SIGNALS_CLOUDFLARE_API_TOKEN")),
		RealtimeWingbitsAPIKey:     strings.TrimSpace(getenv("REALTIME_SIGNALS_WINGBITS_API_KEY")),
		RealtimePolymarketProxyURL: strings.TrimSpace(getenv("REALTIME_SIGNALS_POLYMARKET_PROXY_URL")),
		// Nominatim identity defaults. The e-mail is optional; a value that is
		// not a valid address is normalized to "no override" by the unit.
		NominatimUserAgentDefault: stringDefault(getenv("GEO_NOMINATIM_USER_AGENT"), "modular-api"),
		NominatimEmailDefault:     strings.TrimSpace(getenv("GEO_NOMINATIM_EMAIL")),
	}
}

// firstNonEmptyString returns the first non-empty candidate, reproducing the
// NestJS `a ?? b ?? c` fallback chain over values that are already undefined for
// an absent or empty environment variable.
func firstNonEmptyString(candidates ...string) string {
	for _, candidate := range candidates {
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

// floatDefault parses a float environment value, falling back for an absent or
// unparseable one. It mirrors z.coerce.number() with a default for the schema
// fields that are not integers (the keyword-spike multiplier and the prediction
// shift threshold).
func floatDefault(value string, fallback float64) float64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

// maxEnvRetentionDays is the largest TASK_LOG_RETENTION_DAYS value accepted at
// startup. The zod schema only requires a positive integer, but the value is
// clamped to 1..3650 where it is served, so any larger input produces the same
// observable behaviour while keeping the int conversion in range.
const maxEnvRetentionDays = int64(1)<<31 - 1

// parsePlatformGovernanceDefaults resolves the seven environment variables the
// sixteen platform governance settings routes expose, mirroring the NestJS zod
// schema (apps/api/src/modules/config/env.schema.ts plus
// packages/utils/src/env.ts) one for one, including the .default() values and
// the Number()/envBoolean coercion.
//
// The returned strings are startup errors accumulated unconditionally by Load.
func parsePlatformGovernanceDefaults(cfg *Config, getenv func(string) string) []string {
	var errs []string

	// ASSISTANT_GUARDRAILS_ENABLED: envBoolean.default(true) — an unset or
	// empty value takes the default, a recognised word is accepted, and
	// anything else fails z.boolean() exactly like Nest startup does.
	switch strings.ToLower(strings.TrimSpace(getenv("ASSISTANT_GUARDRAILS_ENABLED"))) {
	case "", "true", "1", "yes", "y", "on":
		cfg.PlatformGovernanceAssistantGuardrailsEnabled = true
	case "false", "0", "no", "n", "off":
		cfg.PlatformGovernanceAssistantGuardrailsEnabled = false
	default:
		// Keep the field usable even though the value is invalid: the error is
		// only promoted to a startup failure in go mode, and a zero value here
		// would otherwise leak a bogus default into a go deployment that was
		// started before the mistake was noticed.
		cfg.PlatformGovernanceAssistantGuardrailsEnabled = true
		errs = append(errs, "ASSISTANT_GUARDRAILS_ENABLED must be a boolean")
	}

	// ASSISTANT_GUARDRAILS: z.preprocess(trim()=="" -> undefined,
	// z.string().default("openai-moderation-pre")). The comma split / trim /
	// drop-empty step lives in EnvService.assistantConfig and is applied by the
	// serving package, so only the default substitution happens here.
	if raw := getenv("ASSISTANT_GUARDRAILS"); strings.TrimSpace(raw) == "" {
		cfg.PlatformGovernanceAssistantGuardrailsRaw = "openai-moderation-pre"
	} else {
		cfg.PlatformGovernanceAssistantGuardrailsRaw = raw
	}

	// ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR:
	// z.coerce.number().int().min(0).max(10000).default(30).
	if value, ok := platformGovernanceEnvInt(getenv("ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR"), 30, 0, 10000); ok {
		cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour = int(value)
	} else {
		cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour = 30
		errs = append(errs, "ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR must be an integer between 0 and 10000")
	}

	// ASSISTANT_ORG_MAX_IN_FLIGHT:
	// z.coerce.number().int().min(0).max(100).default(2).
	if value, ok := platformGovernanceEnvInt(getenv("ASSISTANT_ORG_MAX_IN_FLIGHT"), 2, 0, 100); ok {
		cfg.PlatformGovernanceAssistantOrgMaxInFlight = int(value)
	} else {
		cfg.PlatformGovernanceAssistantOrgMaxInFlight = 2
		errs = append(errs, "ASSISTANT_ORG_MAX_IN_FLIGHT must be an integer between 0 and 100")
	}

	// ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET:
	// z.coerce.number().int().min(0).max(1_000_000_000_000).default(2_000_000).
	if value, ok := platformGovernanceEnvInt(getenv("ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET"), 2_000_000, 0, 1_000_000_000_000); ok {
		cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget = value
	} else {
		cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget = 2_000_000
		errs = append(errs, "ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET must be an integer between 0 and 1000000000000")
	}

	// TASK_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(14).
	// There is no upper bound in the schema; the 1..3650 clamp happens where the
	// value is served, exactly like TaskLogSettingsService.normalizeRetentionDays.
	if value, ok := platformGovernanceEnvInt(getenv("TASK_LOG_RETENTION_DAYS"), 14, 1, maxEnvRetentionDays); ok {
		cfg.PlatformGovernanceTaskLogRetentionDays = int(value)
	} else {
		cfg.PlatformGovernanceTaskLogRetentionDays = 14
		errs = append(errs, "TASK_LOG_RETENTION_DAYS must be a positive integer")
	}

	// SYSTEM_SETTINGS_ENCRYPTION_KEY: z.string().optional(), kept verbatim
	// (never trimmed) so the serving package can tell "unset or empty"
	// (present=false) from "whitespace only" (present=true, then the decoder
	// reports "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty").
	cfg.PlatformGovernanceEncryptionKeyRaw = getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY")

	return errs
}

// platformGovernanceEnvInt mirrors z.coerce.number().int().min(min).max(max)
// plus .default(fallback) for one environment variable. An unset (or empty)
// variable yields the fallback; a set variable is coerced with JavaScript
// Number() semantics and must then be a finite integer inside [min, max].
func platformGovernanceEnvInt(raw string, fallback, min, max int64) (int64, bool) {
	if raw == "" {
		return fallback, true
	}
	value := jsEnvNumber(raw)
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
		return 0, false
	}
	if value < float64(min) || value > float64(max) {
		return 0, false
	}
	return int64(value), true
}

// jsDecimalEnvPattern is the ECMAScript StrDecimalLiteral grammar (without the
// Infinity alternative, which is handled separately). It is deliberately
// narrower than Go's number syntax: Number("inf"), Number("nan"),
// Number("0x1p3") and Number("1_000") are all NaN.
var jsDecimalEnvPattern = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsEnvNumber mirrors JavaScript's Number(string) for environment values.
//
// It validates against the ECMAScript grammar instead of calling
// strconv.ParseFloat directly, because ParseFloat also accepts "inf", "nan",
// hexadecimal floats and digit separators that Number() rejects.
func jsEnvNumber(raw string) float64 {
	trimmed := jsTrimEnvSpace(raw)
	if trimmed == "" {
		return 0
	}
	switch strings.ToLower(trimmed) {
	case "infinity", "+infinity":
		return math.Inf(1)
	case "-infinity":
		return math.Inf(-1)
	}
	if len(trimmed) > 2 && trimmed[0] == '0' {
		switch trimmed[1] {
		case 'x', 'X':
			return jsRadixInteger(trimmed[2:], 16)
		case 'o', 'O':
			return jsRadixInteger(trimmed[2:], 8)
		case 'b', 'B':
			return jsRadixInteger(trimmed[2:], 2)
		}
	}
	if !jsDecimalEnvPattern.MatchString(trimmed) {
		return math.NaN()
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
			// Number("1e999") is Infinity, not an error.
			return value
		}
		return math.NaN()
	}
	return value
}

// jsRadixInteger mirrors Number() for the 0x/0o/0b integer literal forms. An
// empty or malformed literal is NaN; a literal too large for uint64 saturates to
// a large finite double (Number() returns the nearest double, never Infinity,
// and every caller compares against a far smaller window).
func jsRadixInteger(digits string, base int) float64 {
	if digits == "" {
		return math.NaN()
	}
	for _, r := range digits {
		if envDigitValue(r) >= base {
			return math.NaN()
		}
	}
	value, err := strconv.ParseUint(digits, base, 64)
	if err != nil {
		return float64(^uint64(0))
	}
	return float64(value)
}

// envDigitValue returns the digit value of one ASCII character, or 16 for a
// character that is not a digit in any supported base.
func envDigitValue(r rune) int {
	switch {
	case r >= '0' && r <= '9':
		return int(r - '0')
	case r >= 'a' && r <= 'f':
		return int(r-'a') + 10
	case r >= 'A' && r <= 'F':
		return int(r-'A') + 10
	default:
		return 16
	}
}

// jsTrimEnvSpace mirrors JavaScript's String.prototype.trim, which also strips
// the U+FEFF byte order mark that unicode.IsSpace does not classify as space.
func jsTrimEnvSpace(raw string) string {
	return strings.TrimFunc(raw, func(r rune) bool {
		return r == '\uFEFF' || strings.ContainsRune(" \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000", r)
	})
}

func stringDefault(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func intDefault(value string, fallback int) int {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

// promptOverride returns the configured prompt when the variable exists. A nil
// return means "not configured": the caller uses the package default. The
// returned pointer may point at the empty string, which is a real override.
func promptOverride(getenv func(string) string, lookup func(string) (string, bool), key string) *string {
	if lookup != nil {
		if value, ok := lookup(key); ok {
			configured := value
			return &configured
		}
		return nil
	}
	if value := getenv(key); value != "" {
		configured := value
		return &configured
	}
	return nil
}

func boolDefault(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off":
		return false
	default:
		return fallback
	}
}

// LoadFromOS 是生产入口的便捷封装。
func LoadFromOS() (Config, error) {
	return load(os.Getenv, os.LookupEnv)
}

// ReadTimeoutSec 导出给 main 组装 http.Server 使用。
func ReadTimeoutSec() int { return readTimeoutSec }

// QualityWorkerConcurrency is the classification quality worker concurrency:
// max(1, min(4, NEWS_PROCESS_QUEUE_CONCURRENCY)) where an unset value means 2.
//
// The formula is the one classification-quality.processor.ts applies to
// env.newsPipelineEnv.processQueueConcurrency. Keeping it here makes it
// testable without starting a worker.
func (c Config) QualityWorkerConcurrency() int {
	configured := c.NewsProcessQueueConcurrency
	if configured <= 0 {
		configured = 2
	}
	if configured > 4 {
		configured = 4
	}
	if configured < 1 {
		configured = 1
	}
	return configured
}
