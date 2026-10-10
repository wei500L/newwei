// Package config 加载 api-go 网关的环境变量。
//
// api-go 是 Strangler Fig 网关：默认把全部流量反向代理到 NestJS（LEGACY_API_URL），
// 已迁移路由逐步切到 Go 原生 handler（legacy → shadow → canary → go 四态）。
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

const (
	defaultPort    = 4020
	defaultLegacy  = "http://localhost:4000"
	readTimeoutSec = 30

	// 与 NestJS env schema 相同的默认值（apps/api/src/modules/config/
	// env.schema.ts：JWT_ISSUER / JWT_AUDIENCE 的 z.string().default）。
	defaultJWTIssuer   = "modular-monolith"
	defaultJWTAudience = "modular-monolith-clients"
	defaultRedisPort   = 6379
)

// OnboardingMode 是 onboarding GET 迁移单元的路由模式
// （API_GO_ONBOARDING_MODE——Go-批3A 引入）。
type OnboardingMode string

const (
	// OnboardingModeShadow 是默认值：onboarding GET 保持 Go-批2A/2B 的
	// shadow 语义（NestJS 响应 + Go 差分，legacy-approved 身份）——
	// 直接手工启动 api-go 的旧行为不变。
	OnboardingModeShadow OnboardingMode = "shadow"
	// OnboardingModeGo 是 Go-批3A 的真实接管：onboarding GET 由 Go 独立
	// 鉴权（JWT 验签 + Redis blacklist + MySQL RBAC）并全响应。仅在
	// pilot profile（compose）/ 远端 smoke 显式启用。
	OnboardingModeGo OnboardingMode = "go"
)

// UserSettingsReadMode 是 user-settings 六个只读 GET 的统一路由模式
// （API_GO_USER_SETTINGS_READ_MODE——Go-批3B 引入）。
type UserSettingsReadMode string

const (
	// UserSettingsReadModeShadow：6 个 GET 都由 NestJS 响应，Go 做真实
	// 旁路查询与差分（onboarding/rss/spacetime 是既有 shadow 语义；
	// war-map/newsnow/situation-monitor 在本模式下由 NestJS 响应 + Go
	// 差分——新三端点也作为 shadow 单元接线）。
	UserSettingsReadModeShadow UserSettingsReadMode = "shadow"
	// UserSettingsReadModeGo：6 个 GET 都由 Go 独立响应（JWT 验签 +
	// Redis blacklist + MySQL RBAC + 独立查库 + normalization）。
	UserSettingsReadModeGo UserSettingsReadMode = "go"
)

// UserSettingsWriteMode 是六个 user-settings PUT 的写接管开关
// （API_GO_USER_SETTINGS_WRITE_MODE——Go-批3C）。只有一个开关，不按端点拆。
type UserSettingsWriteMode string

const (
	// UserSettingsWriteModeLegacy：六个 PUT 全部纯代理 NestJS（默认，
	// 含未设置）。旧部署行为不变。
	UserSettingsWriteModeLegacy UserSettingsWriteMode = "legacy"
	// UserSettingsWriteModeGo：六个精确路径 PUT 由 Go 独立鉴权并写入
	// 现有 UserSetting。要求读模式同为 go，否则启动失败——避免 PUT 成功
	// 但响应无法用 Go 读路径构建。
	UserSettingsWriteModeGo UserSettingsWriteMode = "go"
)

// PublicPortalMode 是公开首页、频道和故事详情的接管开关
// （API_GO_PUBLIC_PORTAL_MODE）。默认 legacy。
type PublicPortalMode string

const (
	// PublicPortalModeLegacy：公开 GET 继续代理 NestJS（默认，含未设置）。
	PublicPortalModeLegacy PublicPortalMode = "legacy"
	// PublicPortalModeGo：首页、单段频道，以及 stories/id、stories/slug
	// 各一个路径段的 GET 由 Go 查 MySQL 并完整响应。不要求 JWT/Redis。
	PublicPortalModeGo PublicPortalMode = "go"
)

// DashboardStatsMode 是 GET /api/dashboard/stats 的接管开关
// （API_GO_DASHBOARD_STATS_MODE）。默认 legacy。只这一条精确 GET。
type DashboardStatsMode string

const (
	// DashboardStatsModeLegacy：GET /api/dashboard/stats 继续代理 NestJS。
	DashboardStatsModeLegacy DashboardStatsMode = "legacy"
	// DashboardStatsModeGo：该 GET 由 Go 独立鉴权并查询 MySQL、Mongo、Redis。
	// 要求 JWT_SECRET、DATABASE_URL、REDIS_HOST、MONGO_URI。
	DashboardStatsModeGo DashboardStatsMode = "go"
)

// DashboardChartsMode 是三个只读图表 GET 的接管开关
// （API_GO_DASHBOARD_CHARTS_MODE）。默认 legacy。与 stats 开关互不影响。
type DashboardChartsMode string

const (
	// DashboardChartsModeLegacy：三个图表 GET 继续代理 NestJS。
	DashboardChartsModeLegacy DashboardChartsMode = "legacy"
	// DashboardChartsModeGo：sector-heatmap、financial-candlestick、
	// war-map/geojson 这三个精确 GET 由 Go 鉴权并响应。
	// 要求 JWT_SECRET、DATABASE_URL、REDIS_HOST。不要求 MONGO_URI。
	DashboardChartsModeGo DashboardChartsMode = "go"
)

// DashboardWarMapMode 是 war-map events 与 news-markers 的接管开关
// （API_GO_DASHBOARD_WAR_MAP_MODE）。默认 legacy。与 stats、charts 互不影响。
type DashboardWarMapMode string

const (
	// DashboardWarMapModeLegacy：这两个 GET 继续代理 NestJS。
	DashboardWarMapModeLegacy DashboardWarMapMode = "legacy"
	// DashboardWarMapModeGo：这两个精确 GET 由 Go 查 MySQL，并在 MySQL
	// 新闻为空时回退 Mongo。要求 JWT、MySQL、Redis、MONGO_URI。
	DashboardWarMapModeGo DashboardWarMapMode = "go"
)

// DashboardWarMapTransportMode 只控制 GET /api/dashboard/war-map/transport-detail。
// 与 events/news-markers、layers 开关互不影响。默认 legacy。
type DashboardWarMapTransportMode string

const (
	DashboardWarMapTransportModeLegacy DashboardWarMapTransportMode = "legacy"
	DashboardWarMapTransportModeGo     DashboardWarMapTransportMode = "go"
)

// DashboardWarMapLayersMode 只控制 GET /api/dashboard/war-map/layers。
// 与 events/news-markers、transport-detail 开关互不影响。默认 legacy。
type DashboardWarMapLayersMode string

const (
	DashboardWarMapLayersModeLegacy DashboardWarMapLayersMode = "legacy"
	DashboardWarMapLayersModeGo     DashboardWarMapLayersMode = "go"
)

// Config 是网关运行所需的全部配置。
type Config struct {
	Port         int
	LegacyAPIURL string // NestJS apps/api 的基址（含协议，不含路径）

	// DatabaseURL 是 Prisma 同名环境变量（mysql://user:pass@host:port/db）。
	// 仅供 user-settings 只读 shadow（onboarding/rss-reader/spacetime-timeline
	// 三个 GET）的 MySQL 只读查询使用；为空时这些 shadow 单元跳过执行，
	// 网关照常启动并代理全部请求（非阻断）。
	// OnboardingMode=go 时必填（启动失败——Go 接管端点不能依赖缺失的
	// 数据库）。值本身不进入日志/healthz/错误文本。
	DatabaseURL string

	// OnboardingMode 见 OnboardingMode 常量（默认 shadow）。
	OnboardingMode OnboardingMode

	// UserSettingsReadMode 见 UserSettingsReadMode 常量。未设置（空）时
	// 保持既有行为：API_GO_ONBOARDING_MODE 继续控制 onboarding，RSS/
	// Spacetime 保持 Shadow，War Map/NewsNow/Situation Monitor 保持
	// Legacy（Go-批3B 之前的部署不变）。设置为 go 时六个 GET 统一由 Go
	// 接管（优先级高于 API_GO_ONBOARDING_MODE）。非法值启动失败。
	UserSettingsReadMode UserSettingsReadMode

	// UserSettingsWriteMode 见 UserSettingsWriteMode 常量。默认 legacy。
	// go 要求 UserSettingsReadMode 同为 go，并因此具备 JWT/数据库/Redis。
	UserSettingsWriteMode UserSettingsWriteMode

	// PublicPortalMode 见 PublicPortalMode 常量。默认 legacy。
	// go 只要求 DATABASE_URL（匿名读），不要求 JWT/Redis。
	PublicPortalMode PublicPortalMode

	// DashboardStatsMode 见 DashboardStatsMode 常量。默认 legacy。
	// go 要求 JWT、MySQL、Redis 与 MONGO_URI。URI 不进入日志或错误文本。
	DashboardStatsMode DashboardStatsMode
	// DashboardChartsMode 见 DashboardChartsMode 常量。默认 legacy。
	// go 要求 JWT、MySQL、Redis，不要求 Mongo。与 stats 开关独立。
	DashboardChartsMode DashboardChartsMode
	// DashboardWarMapMode 见 DashboardWarMapMode 常量。默认 legacy。
	// go 要求 JWT、MySQL、Redis、MONGO_URI。与 stats、charts 开关独立。
	DashboardWarMapMode DashboardWarMapMode
	// 下面两个开关各自只接管一条 War Map GET，默认 legacy。
	DashboardWarMapTransportMode DashboardWarMapTransportMode
	DashboardWarMapLayersMode    DashboardWarMapLayersMode
	// MongoURI 是 NestJS 同名 MONGO_URI。dashboard stats 与 war map 的 go 模式读取。
	MongoURI string

	// OpenSky 运行配置与 Nest env.schema 的默认值一致，供 layers 的
	// flightMode=all 读取。不在这里启动采集。
	RealtimeSignalsEnabled          bool
	RealtimeSignalsTimeoutMs        int
	OpenskyEnabled                  bool
	OpenskyDailyCreditBudget        int
	OpenskyDayIntervalSec           int
	OpenskyNightIntervalSec         int
	OpenskyDayStartHourHKT          int
	OpenskyNightStartHourHKT        int
	OpenskyWarningRemainingPct      int
	OpenskyCriticalRemainingPct     int
	OpenskyBaseURL                  string
	OpenskyTokenURL                 string
	OpenskyClientID                 string
	OpenskyClientSecret             string

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

	// CorsOrigin 是与 NestJS 相同的 CORS_ORIGIN 原文。空名单不放行任何
	// 浏览器 Origin。只用于 Go 自己写出的 user-settings 响应。
	CorsOrigin string

	// JWT 是 NestJS access token 的验签配置（与 api 服务同一
	// JWT_SECRET/JWT_ISSUER/JWT_AUDIENCE）。OnboardingMode=go 时
	// JWTSecret 必填；issuer/audience 默认值与 NestJS env schema 一致。
	// Secret 不进入日志/healthz/错误文本。
	JWTSecret   string
	JWTIssuer   string
	JWTAudience string

	// Redis 是 access-token blacklist 所用 Redis（与 NestJS api 服务同一
	// 实例——Go 不建第二套撤销名单）。OnboardingMode=go 时 Host 必填；
	// Port 默认 6379、DB 默认 0、用户名/密码可选（镜像 NestJS env
	// schema 的可选语义）。凭据不进入日志/healthz/错误文本。
	RedisHost     string
	RedisPort     int
	RedisUsername string
	RedisPassword string
	RedisDB       int

	// shadow 差分执行的资源边界（防放大攻击/雪崩）。请求体与响应捕获是
	// 两个独立预算——请求体决定「差分能否重放请求」，响应捕获决定
	// 「差分能否拿到完整 legacy 响应」；两者任一超限只丢弃差分，不影响
	// 主响应。
	ShadowTimeoutMs              int   // 单次 Go 侧执行的硬超时
	ShadowMaxRequestBodyByte     int64 // 差分可重放的请求体上限
	ShadowMaxResponseCaptureByte int64 // 响应差分缓存上限（超过即停捕获，主响应继续流式透传）
	ShadowMaxInflight            int   // 并发中的 shadow 执行数上限，超出直接丢弃
	ShadowMaxPerMin              int   // 每分钟 shadow 执行预算（令牌桶），超出丢弃

	// 差分日志正文：默认只记录响应体 hash 与差异字段，不保存业务正文
	//（避免把业务数据写进网关日志）。显式开启 debug 后才记录截断正文。
	ShadowDebugBodyLog         bool
	ShadowDebugBodyLogMaxBytes int64

	// canary 分流：
	CanaryPercent int // 0=legacy 等价；100=go 等价；中间按 orgId 稳定哈希分流
}

// Load 从 getenv 读取并校验配置。
func Load(getenv func(string) string) (Config, error) {
	var errs []string

	cfg := Config{
		// 资源边界的默认值：足够完成一次真实 handler 执行与小型 JSON
		// 响应捕获，同时把单次失误的代价限制在秒级/兆级以内。
		ShadowTimeoutMs:              2_000,
		ShadowMaxRequestBodyByte:     1 << 20, // 1 MiB
		ShadowMaxResponseCaptureByte: 1 << 20, // 1 MiB
		ShadowMaxInflight:            16,
		ShadowMaxPerMin:              600,
		ShadowDebugBodyLog:           false,
		ShadowDebugBodyLogMaxBytes:   2_048,
		CanaryPercent:                0,
	}

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

	legacy := strings.TrimSpace(getenv("LEGACY_API_URL"))
	if legacy == "" {
		legacy = defaultLegacy
	}
	parsed, err := url.ParseRequestURI(legacy)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		errs = append(errs, fmt.Sprintf("LEGACY_API_URL must be an absolute URL, got %q", legacy))
	}
	cfg.LegacyAPIURL = legacy

	// 只读取原文，不做解析（解析在 usersettings.OpenMySQLFromURL，错误
	// 不阻断启动）。空值在 shadow 模式合法：数据库能力整体不启用；
	// OnboardingMode=go 时下方显式要求非空（启动失败）。
	cfg.DatabaseURL = strings.TrimSpace(getenv("DATABASE_URL"))

	// onboarding 迁移单元的路由模式：默认 shadow（手工启动的旧行为）；
	// 非法值启动失败（不静默降级）。
	switch strings.TrimSpace(getenv("API_GO_ONBOARDING_MODE")) {
	case "":
		cfg.OnboardingMode = OnboardingModeShadow
	case string(OnboardingModeShadow):
		cfg.OnboardingMode = OnboardingModeShadow
	case string(OnboardingModeGo):
		cfg.OnboardingMode = OnboardingModeGo
	default:
		errs = append(errs, "API_GO_ONBOARDING_MODE must be one of shadow|go")
	}

	// user-settings 六个只读 GET 的统一读模式（Go-批3B）：默认空 = 兼容
	//（API_GO_ONBOARDING_MODE 继续控制 onboarding，其余端点旧去向不变）；
	// 非法值启动失败。
	switch strings.TrimSpace(getenv("API_GO_USER_SETTINGS_READ_MODE")) {
	case "":
		cfg.UserSettingsReadMode = ""
	case string(UserSettingsReadModeShadow):
		cfg.UserSettingsReadMode = UserSettingsReadModeShadow
	case string(UserSettingsReadModeGo):
		cfg.UserSettingsReadMode = UserSettingsReadModeGo
	default:
		errs = append(errs, "API_GO_USER_SETTINGS_READ_MODE must be one of shadow|go")
	}

	// 六个 PUT 的写接管（Go-批3C）。未设置 = legacy。go 必须搭配读模式
	// go，否则写成功后的 envelope 无法走同一套 Go 读构建。
	switch strings.TrimSpace(getenv("API_GO_USER_SETTINGS_WRITE_MODE")) {
	case "", string(UserSettingsWriteModeLegacy):
		cfg.UserSettingsWriteMode = UserSettingsWriteModeLegacy
	case string(UserSettingsWriteModeGo):
		cfg.UserSettingsWriteMode = UserSettingsWriteModeGo
	default:
		errs = append(errs, "API_GO_USER_SETTINGS_WRITE_MODE must be one of legacy|go")
	}
	if cfg.UserSettingsWriteMode == UserSettingsWriteModeGo &&
		cfg.UserSettingsReadMode != UserSettingsReadModeGo {
		errs = append(errs, "API_GO_USER_SETTINGS_WRITE_MODE=go requires API_GO_USER_SETTINGS_READ_MODE=go")
	}

	switch strings.TrimSpace(getenv("API_GO_PUBLIC_PORTAL_MODE")) {
	case "", string(PublicPortalModeLegacy):
		cfg.PublicPortalMode = PublicPortalModeLegacy
	case string(PublicPortalModeGo):
		cfg.PublicPortalMode = PublicPortalModeGo
	default:
		errs = append(errs, "API_GO_PUBLIC_PORTAL_MODE must be one of legacy|go")
	}

	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_STATS_MODE")) {
	case "", string(DashboardStatsModeLegacy):
		cfg.DashboardStatsMode = DashboardStatsModeLegacy
	case string(DashboardStatsModeGo):
		cfg.DashboardStatsMode = DashboardStatsModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_STATS_MODE must be one of legacy|go")
	}

	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_CHARTS_MODE")) {
	case "", string(DashboardChartsModeLegacy):
		cfg.DashboardChartsMode = DashboardChartsModeLegacy
	case string(DashboardChartsModeGo):
		cfg.DashboardChartsMode = DashboardChartsModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_CHARTS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_WAR_MAP_MODE")) {
	case "", string(DashboardWarMapModeLegacy):
		cfg.DashboardWarMapMode = DashboardWarMapModeLegacy
	case string(DashboardWarMapModeGo):
		cfg.DashboardWarMapMode = DashboardWarMapModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_WAR_MAP_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE")) {
	case "", string(DashboardWarMapTransportModeLegacy):
		cfg.DashboardWarMapTransportMode = DashboardWarMapTransportModeLegacy
	case string(DashboardWarMapTransportModeGo):
		cfg.DashboardWarMapTransportMode = DashboardWarMapTransportModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE")) {
	case "", string(DashboardWarMapLayersModeLegacy):
		cfg.DashboardWarMapLayersMode = DashboardWarMapLayersModeLegacy
	case string(DashboardWarMapLayersModeGo):
		cfg.DashboardWarMapLayersMode = DashboardWarMapLayersModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE must be one of legacy|go")
	}
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
	cfg.SettingsEncryptionKey = strings.TrimSpace(getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY"))
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

	if raw := strings.TrimSpace(getenv("SHADOW_TIMEOUT_MS")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_TIMEOUT_MS must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowTimeoutMs = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_REQUEST_BODY_BYTES")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_REQUEST_BODY_BYTES must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxRequestBodyByte = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_RESPONSE_CAPTURE_BYTES")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_RESPONSE_CAPTURE_BYTES must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxResponseCaptureByte = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_INFLIGHT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_INFLIGHT must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxInflight = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_MAX_PER_MINUTE")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_MAX_PER_MINUTE must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowMaxPerMin = value
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_DEBUG_BODY_LOG")); raw != "" {
		switch strings.ToLower(raw) {
		case "1", "true", "yes", "on":
			cfg.ShadowDebugBodyLog = true
		case "0", "false", "no", "off":
			cfg.ShadowDebugBodyLog = false
		default:
			errs = append(errs, fmt.Sprintf("SHADOW_DEBUG_BODY_LOG must be a boolean, got %q", raw))
		}
	}

	if raw := strings.TrimSpace(getenv("SHADOW_DEBUG_BODY_LOG_MAX_BYTES")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("SHADOW_DEBUG_BODY_LOG_MAX_BYTES must be a positive integer, got %q", raw))
		} else {
			cfg.ShadowDebugBodyLogMaxBytes = value
		}
	}

	if raw := strings.TrimSpace(getenv("CANARY_PERCENT")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 || value > 100 {
			errs = append(errs, fmt.Sprintf("CANARY_PERCENT must be an integer in [0,100], got %q", raw))
		} else {
			cfg.CanaryPercent = value
		}
	}

	// Go 接管模式的依赖前置校验：不得在依赖缺失时启动一个必然失败的
	// 「Go 接管端点」——启动即失败，错误只指出缺失的配置项名，不打印值。
	// Go-批3B：UserSettingsReadMode=go 触发同一套前置（六个 GET 全部由
	// Go 独立鉴权响应）；API_GO_ONBOARDING_MODE=go 单独设置时沿用批3A
	// 的同一校验（两变量叠加时只校验一次——条件取或）。
	goTakeover := cfg.OnboardingMode == OnboardingModeGo ||
		cfg.UserSettingsReadMode == UserSettingsReadModeGo
	if goTakeover {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_ONBOARDING_MODE=go or API_GO_USER_SETTINGS_READ_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ONBOARDING_MODE=go or API_GO_USER_SETTINGS_READ_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ONBOARDING_MODE=go or API_GO_USER_SETTINGS_READ_MODE=go")
		}
	}
	if cfg.PublicPortalMode == PublicPortalModeGo && cfg.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required when API_GO_PUBLIC_PORTAL_MODE=go")
	}
	if cfg.DashboardStatsMode == DashboardStatsModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_DASHBOARD_STATS_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_DASHBOARD_STATS_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_DASHBOARD_STATS_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_DASHBOARD_STATS_MODE=go")
		}
	}
	if cfg.DashboardChartsMode == DashboardChartsModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_DASHBOARD_CHARTS_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_DASHBOARD_CHARTS_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_DASHBOARD_CHARTS_MODE=go")
		}
	}
	if cfg.DashboardWarMapMode == DashboardWarMapModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_DASHBOARD_WAR_MAP_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_DASHBOARD_WAR_MAP_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_DASHBOARD_WAR_MAP_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_DASHBOARD_WAR_MAP_MODE=go")
		}
	}
	if cfg.DashboardWarMapTransportMode == DashboardWarMapTransportModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE=go")
		}
	}
	if cfg.DashboardWarMapLayersMode == DashboardWarMapLayersModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE=go")
		}
	}

	if len(errs) > 0 {
		return Config{}, errors.New(strings.Join(errs, "; "))
	}
	return cfg, nil
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
	return Load(os.Getenv)
}

// ReadTimeoutSec 导出给 main 组装 http.Server 使用。
func ReadTimeoutSec() int { return readTimeoutSec }
