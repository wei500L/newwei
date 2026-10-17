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

// DashboardSpacetimeGeoMode 只控制热力图总览和下钻两条精确 GET。
// 与传播图开关互不影响。默认 legacy。
type DashboardSpacetimeGeoMode string

const (
	DashboardSpacetimeGeoModeLegacy DashboardSpacetimeGeoMode = "legacy"
	DashboardSpacetimeGeoModeGo     DashboardSpacetimeGeoMode = "go"
)

// DashboardSpacetimePropagationMode 只控制传播图总览和下钻两条精确 GET。
// 与热力图开关互不影响。默认 legacy。
type DashboardSpacetimePropagationMode string

const (
	DashboardSpacetimePropagationModeLegacy DashboardSpacetimePropagationMode = "legacy"
	DashboardSpacetimePropagationModeGo     DashboardSpacetimePropagationMode = "go"
)

// DashboardStreamMode 只控制 GET /api/dashboard/stream。默认 legacy。
// 与图表、War Map、Spacetime 的 HTTP 开关互不影响；go 时复用那些服务，
// 但不因此改写它们的路由。
type DashboardStreamMode string

const (
	DashboardStreamModeLegacy DashboardStreamMode = "legacy"
	DashboardStreamModeGo     DashboardStreamMode = "go"
)

// HealthzMode 只控制认证版 GET /api/healthz。默认 legacy。
// 不改变公开 GET /api/healthz/live。
type HealthzMode string

const (
	HealthzModeLegacy HealthzMode = "legacy"
	HealthzModeGo     HealthzMode = "go"
)

// NewsSourcesMode 只控制新闻源管理台十五条 HTTP。默认 legacy。
// 不接管 GET /api/admin/news-sources/:id/preview，也不启动采集。
type NewsSourcesMode string

const (
	NewsSourcesModeLegacy NewsSourcesMode = "legacy"
	NewsSourcesModeGo     NewsSourcesMode = "go"
)

// CrawlWorkflowsMode 只控制采集策略工作流的编辑接口。默认 legacy。
// go 只接管列表、详情、创建、草稿、发布、版本、对比、节点 schema 和两条
// bridge；trial-run、replay、workflow-runs、profiles 列表/创建/预览/回滚，
// 以及 runs 与 nodes 仍回 NestJS。不启动采集，不入队。
type CrawlWorkflowsMode string

const (
	CrawlWorkflowsModeLegacy CrawlWorkflowsMode = "legacy"
	CrawlWorkflowsModeGo     CrawlWorkflowsMode = "go"
)

// CrawlProfilesMode 只控制采集站点画像的编辑接口。默认 legacy。
// go 只接管列表、匹配、预览、创建、详情、更新、版本列表与回滚这 8 条；
// runs、nodes、workflows 与 workflow-bridge 仍回 NestJS。不启用 shadow，
// 不启动采集，不入队。
type CrawlProfilesMode string

const (
	CrawlProfilesModeLegacy CrawlProfilesMode = "legacy"
	CrawlProfilesModeGo     CrawlProfilesMode = "go"
)

// RbacMode 只控制组织访问控制的六条 HTTP（/api/rbac/*）。默认 legacy。
// go 时只接管 permissions、roles（GET/POST）、assign、members、audit-logs；
// 其他方法与更长路径仍回 NestJS，也不新增 updateRole 的 HTTP。
type RbacMode string

const (
	RbacModeLegacy RbacMode = "legacy"
	RbacModeGo     RbacMode = "go"
)

// CrawlTemplatesMode 只控制采集模板（admin/crawl-templates）的 4 条编辑
// 接口。默认 legacy。go 只接管列表、创建、更新、删除这 4 条；
// crawl-tasks、crawl4ai 队列与 metadata 仍回 NestJS。不启用 shadow，
// 不启动采集，不入队。
type CrawlTemplatesMode string

const (
	CrawlTemplatesModeLegacy CrawlTemplatesMode = "legacy"
	CrawlTemplatesModeGo     CrawlTemplatesMode = "go"
)

// LlmLogsMode 只控制 LLM 请求日志的列表、CSV 导出与用量汇总这 3 条只读
// GET（/api/llm-logs、/api/llm-logs/export、/api/llm-logs/summary）。
// 默认 legacy。go 只接管这三条精确 GET；其他方法与更长路径仍回 NestJS。
// /api/system-settings/llm-request-logs 始终留在 NestJS（它会改 Mongo TTL
// 索引）。不启用 shadow，不调用模型服务，不启动 worker。
type LlmLogsMode string

const (
	LlmLogsModeLegacy LlmLogsMode = "legacy"
	LlmLogsModeGo     LlmLogsMode = "go"
)

// AdminLogsMode 只控制管理端日志与异常读取的 7 条 GET。默认 legacy。
// go 只接管下面这 7 条精确路径，且只匹配 GET；其他方法、更长路径、
// /api/admin/quality/、/api/observability/ 与 /api/metrics 仍回 NestJS。
// 不启用 shadow，不改前端，不改 canary。
type AdminLogsMode string

const (
	AdminLogsModeLegacy AdminLogsMode = "legacy"
	AdminLogsModeGo     AdminLogsMode = "go"
)

// NewsIndicatorsMode 只控制新闻指标关联分析的 3 条 HTTP 与 2 个 GraphQL 只读
// query。默认 legacy。go 时接管
//
//	GET  /api/news-indicator/associations
//	GET  /api/news-indicator/associations/:id
//	POST /api/news-indicator/refresh
//
// 且当 API_GO_GRAPHQL_READ_MODE=go 时为读执行器登记
// newsIndicatorAssociations 与 newsIndicatorAssociation 两个只读 query。
// GraphQL mutation refreshNewsIndicatorAssociations 与设置读写仍回 NestJS。
// 不启用 shadow，不调用 AkShare，不在 refresh 里外网拉经济数据，不启动
// 调度 worker。
type NewsIndicatorsMode string

const (
	NewsIndicatorsModeLegacy NewsIndicatorsMode = "legacy"
	NewsIndicatorsModeGo     NewsIndicatorsMode = "go"
)

// QualityOverviewMode 只控制管理端质量面板的 5 条 GET。默认 legacy。
// go 只接管下面这 5 条精确路径，且只匹配 GET：
// admin/quality 的 news-sources、pipeline、overview、task-logs、
// task-logs/summary。新闻源质量与流水线质量复用 MySQL
// ObservabilitySnapshot 表与 Redis 分布式锁键，与 Nest 共享 60 秒快照。
// /api/admin/quality/classification/* 与
// /api/admin/quality/pipeline/runs|replay|rollback 仍回 NestJS。
// 不启用 shadow，不改前端，不改 canary。
type QualityOverviewMode string

const (
	QualityOverviewModeLegacy QualityOverviewMode = "legacy"
	QualityOverviewModeGo     QualityOverviewMode = "go"
)

// ClassificationRssOpsMode controls the classification quality workbench (7
// HTTP endpoints), the RSS chain diagnostics (4 endpoints) and the RSS
// translation daily metrics (1 endpoint). The default is legacy.
//
// When the mode is go, Go owns exactly these 13 route rules and nothing else:
//
//	GET  /api/admin/quality/classification/summary
//	GET  /api/admin/quality/classification/sources/:sourceId/items
//	GET  /api/admin/quality/classification/reviews/queue
//	POST /api/admin/quality/classification/reviews/:reviewId/decision
//	POST /api/admin/quality/classification/reviews/batch
//	POST /api/admin/quality/classification/sampling/query
//	POST /api/admin/quality/classification/sampling/annotations
//	GET  /api/admin/quality/classification/reports/:jobId
//	GET  /api/system-settings/rss-diagnostics/overview
//	GET  /api/system-settings/rss-diagnostics/chain
//	GET  /api/system-settings/rss-diagnostics/sources
//	POST /api/system-settings/rss-diagnostics/backfill-source-id
//	GET  /api/system-settings/rss-translation/metrics
//
// POST /api/admin/quality/classification/reports stays on NestJS: it enqueues a
// BullMQ job, so the queue red line keeps it out of Go. The mode requires
// JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI (processeditems, tasklogs
// and every classification* collection live in Mongo). Shadow is never enabled
// and canary stays untouched.
type ClassificationRssOpsMode string

const (
	// ClassificationRssOpsModeLegacy proxies every route to NestJS.
	ClassificationRssOpsModeLegacy ClassificationRssOpsMode = "legacy"
	// ClassificationRssOpsModeGo serves the migrated routes from Go.
	ClassificationRssOpsModeGo ClassificationRssOpsMode = "go"
)

// NewsnowClusteringOpsMode controls the nine NewsNow local-computation and
// news-event clustering failure HTTP endpoints. It defaults to legacy. In go
// mode it takes over exactly these nine routes and nothing else:
//
//	GET  /api/news-aggregator/metadata                       (public)
//	GET  /api/news-aggregator/resolve                        (public)
//	POST /api/news-aggregator/sources/order                  (items.read)
//	GET  /api/news-aggregator/domestic-opinion-index         (items.read)
//	GET  /api/system-settings/news-events/clustering/readiness
//	GET  /api/system-settings/news-events/clustering/overview
//	GET  /api/system-settings/news-events/clustering/failures
//	POST /api/system-settings/news-events/clustering/failures/:groupId/vector-backfill
//	POST /api/system-settings/news-events/clustering/failures/:groupId/ignore
//
// The four NewsNow endpoints that fetch external sources are deliberately left
// on NestJS: GET /api/news-aggregator/source,
// POST /api/news-aggregator/sources/batch,
// GET /api/news-aggregator/hottest-analysis and
// GET /api/news-aggregator/recommended. So is
// POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill,
// which enqueues a BullMQ job. shadow and canary are not enabled by this switch.
type NewsnowClusteringOpsMode string

const (
	// NewsnowClusteringOpsModeLegacy keeps all nine routes on NestJS and is the
	// default, including when the environment variable is unset or empty.
	NewsnowClusteringOpsModeLegacy NewsnowClusteringOpsMode = "legacy"
	// NewsnowClusteringOpsModeGo moves the nine routes to Go. It requires
	// JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI.
	NewsnowClusteringOpsModeGo NewsnowClusteringOpsMode = "go"
)

// CrawlReadTelemetryMode controls the seven crawl read/media/telemetry HTTP
// endpoints migrated by this unit. It defaults to legacy.
//
//	go mode takes over exactly these seven routes:
//	  GET  /api/crawl-tasks
//	  GET  /api/crawl-tasks/:id
//	  GET  /api/crawl-media-assets/:assetId/:mode
//	  GET  /api/admin/crawl4ai/quality
//	  GET  /api/admin/crawl4ai/quality/sources/:sourceId
//	  POST /api/search-telemetry
//	  GET  /api/admin/search-telemetry/summary
//
// Every write queue / live crawler route keeps falling back to NestJS:
// POST /api/crawl-tasks, DELETE /api/crawl-tasks/:id,
// POST /api/crawl-tasks/:id/retry, POST /api/crawl-tasks/metadata and
// /api/admin/crawl4ai/queue*. go mode requires JWT_SECRET, DATABASE_URL,
// REDIS_HOST and MONGO_URI. No shadow, no canary and no worker is started.
type CrawlReadTelemetryMode string

const (
	CrawlReadTelemetryModeLegacy CrawlReadTelemetryMode = "legacy"
	CrawlReadTelemetryModeGo     CrawlReadTelemetryMode = "go"
)

// InfrastructureSettingsMode controls the seven infrastructure connection and
// crawl-credential settings HTTP routes migrated by this unit
// (API_GO_INFRASTRUCTURE_SETTINGS_MODE): the three vector-service routes, the
// two storage settings routes and the two news-source runtime secret routes.
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep every request on the NestJS proxy, and any other value
// fails startup instead of silently degrading. go mode requires JWT_SECRET,
// DATABASE_URL and REDIS_HOST; it never requires MONGO_URI (this unit reads and
// writes MySQL and Redis only), never enables shadow or canary traffic and
// never starts a worker. The settings-encryption key is deliberately optional
// at startup: a missing or invalid key is handled per read/write by the
// documented fallback and 400 contracts rather than blocking boot.
type InfrastructureSettingsMode string

const (
	// InfrastructureSettingsModeLegacy proxies all seven routes to NestJS
	// (default, including the empty value). Rolling back only means setting
	// API_GO_INFRASTRUCTURE_SETTINGS_MODE back to legacy.
	InfrastructureSettingsModeLegacy InfrastructureSettingsMode = "legacy"
	// InfrastructureSettingsModeGo serves all seven routes from Go with the
	// same authentication chain as NestJS (JWT verification, Redis blacklist,
	// MySQL membership re-derivation) plus mtk_ machine tokens, and the same
	// platform-admin gate on the four write routes.
	InfrastructureSettingsModeGo InfrastructureSettingsMode = "go"
)

// RuntimeSettingsMode controls the eighteen platform runtime and governance
// settings HTTP routes under /api/system-settings (API_GO_RUNTIME_SETTINGS_MODE).
// The accepted values are exactly "", "legacy" and "go"; any other value fails
// startup instead of silently degrading. The default is legacy.
type RuntimeSettingsMode string

const (
	// RuntimeSettingsModeLegacy proxies all eighteen routes to NestJS
	// (default, including the empty value). Rollback only changes this
	// variable back to legacy.
	RuntimeSettingsModeLegacy RuntimeSettingsMode = "legacy"
	// RuntimeSettingsModeGo serves all eighteen routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens. It requires
	// JWT_SECRET, DATABASE_URL and REDIS_HOST at startup. It never enables
	// shadow or canary traffic.
	RuntimeSettingsModeGo RuntimeSettingsMode = "go"
)

// SituationMonitorsMode 只控制态势监控自定义监控的五条 HTTP。默认 legacy。
// 不接管 insights、catalog、feedback、refresh、telegram、oref、HLS，
// 也不接管已迁走的 /api/user-settings/ui/situation-monitor。
type SituationMonitorsMode string

const (
	SituationMonitorsModeLegacy SituationMonitorsMode = "legacy"
	SituationMonitorsModeGo     SituationMonitorsMode = "go"
)

// ContentSubscriptionsMode 只控制内容订阅 7 条精确 HTTP。默认 legacy。
// 不决定摘要服务能否在进程内调用 Go 订阅查询。
type ContentSubscriptionsMode string

const (
	ContentSubscriptionsModeLegacy ContentSubscriptionsMode = "legacy"
	ContentSubscriptionsModeGo     ContentSubscriptionsMode = "go"
)

// UserNewsBehaviorMode 只控制行为记录、画像读取和清空 3 条精确 HTTP。
// 默认 legacy。推荐在订阅 HTTP 为 go 时仍直接调用 Go 画像服务。
type UserNewsBehaviorMode string

const (
	UserNewsBehaviorModeLegacy UserNewsBehaviorMode = "legacy"
	UserNewsBehaviorModeGo     UserNewsBehaviorMode = "go"
)

// UserDigestMode 只控制摘要偏好、每日摘要和投递设置 5 条精确 HTTP。
// 默认 legacy。不启动邮件调度。
type UserDigestMode string

const (
	UserDigestModeLegacy UserDigestMode = "legacy"
	UserDigestModeGo     UserDigestMode = "go"
)

// AnalysisViewsMode 只控制 5 条保存视图 HTTP。默认 legacy。
type AnalysisViewsMode string

const (
	AnalysisViewsModeLegacy AnalysisViewsMode = "legacy"
	AnalysisViewsModeGo     AnalysisViewsMode = "go"
)

// AnalysisBoardsMode 只控制 13 条看板、列和任务 HTTP。默认 legacy。
// 不决定讨论服务能否直接读任务或视图。
type AnalysisBoardsMode string

const (
	AnalysisBoardsModeLegacy AnalysisBoardsMode = "legacy"
	AnalysisBoardsModeGo     AnalysisBoardsMode = "go"
)

// AnalysisThreadsMode 只控制 5 条笔记和评论 HTTP。默认 legacy。
// 不决定看板详情能否直接数评论，也不决定删除视图/任务时能否清理讨论。
type AnalysisThreadsMode string

const (
	AnalysisThreadsModeLegacy AnalysisThreadsMode = "legacy"
	AnalysisThreadsModeGo     AnalysisThreadsMode = "go"
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
	// 热力图与传播图各自一对 GET。默认 legacy，互不影响。
	DashboardSpacetimeGeoMode         DashboardSpacetimeGeoMode
	DashboardSpacetimePropagationMode DashboardSpacetimePropagationMode
	// DashboardStreamMode 见 DashboardStreamMode。默认 legacy。
	// go 要求 JWT、MySQL、Redis、MONGO_URI。不要求 crawl4ai 或 LLM。
	DashboardStreamMode DashboardStreamMode
	// HealthzMode 见 HealthzMode。默认 legacy。
	// go 只要求 JWT、MySQL、Redis，用来验签。Mongo、crawl4ai、SSRF 和 LLM
	// 不是启动条件，只在认证请求到达时探测。
	HealthzMode HealthzMode
	// 三个个人内容域的 HTTP 开关，彼此独立，默认都是 legacy。
	// 订阅与摘要的 go 模式需要 Mongo（目录候选或相关内容回退）。
	// 行为 go 模式不需要 Mongo。ES、embedding 凭据和 SMTP 都不是启动条件。
	ContentSubscriptionsMode ContentSubscriptionsMode
	UserNewsBehaviorMode     UserNewsBehaviorMode
	UserDigestMode           UserDigestMode
	// 分析工作台三个 HTTP 开关，彼此独立，默认都是 legacy。
	// 只决定对应精确路由。讨论检查、评论计数和删除清理不看另一个开关。
	// go 要求 JWT、MySQL、Redis，不要求 Mongo。
	AnalysisViewsMode   AnalysisViewsMode
	AnalysisBoardsMode  AnalysisBoardsMode
	AnalysisThreadsMode AnalysisThreadsMode
	// GraphQLReadMode 控制精确 /graphql 的已迁移 query。默认 legacy。
	// go 只执行本轮 16 个 query；mutation、subscription、未迁移 query 仍代理 NestJS。
	GraphQLReadMode string
	// GraphQLNewsEventsMode 只决定六个新闻事件 root 是否登记。默认 legacy。
	// 读查询为 legacy 时不另挂 /graphql。两个都是 go 才登记；新闻事件为 legacy
	// 时，含这六个 root 的文档整包回 NestJS。回滚只改这个变量。
	GraphQLNewsEventsMode string
	// NewsIndicatorsMode 只控制新闻指标关联分析的 3 条 HTTP 与 2 个 GraphQL
	// 只读 query。默认 legacy。go 要求 JWT、MySQL、Redis。不要求 Mongo，
	// 不调用 AkShare，也不启动调度。
	NewsIndicatorsMode NewsIndicatorsMode
	// GraphQLKgImpactMode 只决定知识图谱冲击传导与实体共现/相关图这 4 个
	// 只读 root 是否登记。默认 legacy。读查询为 legacy 时不另挂 /graphql。
	// 两个都是 go 才登记；本开关为 legacy 时，含这 4 个 root 的文档整包回
	// NestJS。回滚只改这个变量。
	GraphQLKgImpactMode string
	// GraphQLKnowledgeGraphMode 只决定知识图谱与实体 360 情报的六个 root
	// 是否登记。默认 legacy。读查询为 legacy 时不另挂 /graphql。两个都是
	// go 才登记；知识图谱为 legacy 时，含这六个 root 的文档整包回 NestJS。
	// 回滚只改这个变量。
	GraphQLKnowledgeGraphMode string
	// GraphQLWorkspaceReadMode only decides whether the twelve identity,
	// organization, RBAC, dashboard, queue, sentiment and processed-item
	// read roots are registered into the Go GraphQL executor. It defaults to
	// legacy. The roots are registered only when both
	// API_GO_GRAPHQL_READ_MODE and this switch are go; while this switch is
	// legacy, any document that selects one of those roots falls back to
	// NestJS as a whole. Rolling back only means setting this variable back
	// to legacy.
	GraphQLWorkspaceReadMode string
	// GraphQLSettingsCrawlReadMode decides whether the twenty settings center,
	// source policy, source policy sync status, knowledge-graph evidence review
	// queue and crawl task read roots are registered into the Go GraphQL
	// executor. The accepted values are exactly "", "legacy" and "go"; the empty
	// value behaves like legacy. The roots are registered only when both
	// API_GO_GRAPHQL_READ_MODE and this switch are go; while this switch is
	// legacy, any document selecting one of those roots falls back to NestJS as
	// a whole, so the production web entry keeps serving through NestJS.
	// Rolling back only means setting this variable back to legacy.
	GraphQLSettingsCrawlReadMode string
	// SituationMonitorsMode 只控制自定义监控五条 HTTP。默认 legacy。
	// go 要求 JWT、MySQL、Redis。模型和 Nominatim 不是启动条件。
	SituationMonitorsMode SituationMonitorsMode
	// NewsSourcesMode 只控制新闻源管理台十五条 HTTP。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动采集 worker。
	NewsSourcesMode NewsSourcesMode
	// CrawlWorkflowsMode 只控制采集策略工作流编辑接口。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动采集 worker。
	CrawlWorkflowsMode CrawlWorkflowsMode
	// CrawlProfilesMode 只控制采集站点画像编辑接口。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动采集 worker。
	CrawlProfilesMode CrawlProfilesMode
	// RbacMode 只控制组织访问控制六条 HTTP。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动任何 worker。
	RbacMode RbacMode
	// CrawlTemplatesMode 只控制采集模板编辑接口。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动采集 worker。
	CrawlTemplatesMode CrawlTemplatesMode
	// LlmLogsMode 只控制 LLM 请求日志的列表、CSV 导出与用量汇总。默认
	// legacy。go 要求 JWT、MySQL、Redis 与 Mongo（读 llmrequestlogs）。
	// 不启动 worker，不调用模型服务。
	LlmLogsMode LlmLogsMode
	// AdminLogsMode 只控制管理端日志与异常读取的 7 条 GET。默认 legacy。
	// go 要求 JWT、MySQL、Redis、Mongo（tasklogs 与 exceptionevents 都在
	// Mongo，审计日志在 MySQL）。不启用 shadow，不启动任何 worker。
	AdminLogsMode AdminLogsMode
	// QualityOverviewMode 只控制管理端质量面板的 5 条 GET。默认 legacy。
	// go 要求 JWT、MySQL、Redis、Mongo（processeditems 与 tasklogs 都在
	// Mongo；新闻源/流水线快照与 outbox 在 MySQL）。不启用 shadow，不启动
	// 任何 worker。
	QualityOverviewMode QualityOverviewMode
	// ClassificationRssOpsMode controls the classification quality workbench,
	// the RSS chain diagnostics and the RSS translation daily metrics. Default
	// legacy. go requires JWT, MySQL, Redis and Mongo (processeditems, tasklogs
	// and the five classification* collections are stored in Mongo). Shadow is
	// never enabled and no worker is started.
	ClassificationRssOpsMode ClassificationRssOpsMode
	// NewsnowClusteringOpsMode controls the nine NewsNow local-computation and
	// news-event clustering failure endpoints. Defaults to legacy. go requires
	// JWT, MySQL, Redis and Mongo: NewsNow metadata/resolve/ordering read Redis
	// and Mongo, the domestic opinion index reads MySQL and Mongo, and the
	// clustering failure endpoints read and write the Mongo
	// newseventclusteringfailures collection. No external source fetch, no LLM
	// call and no queue delivery happens in this mode, and no worker is started.
	NewsnowClusteringOpsMode NewsnowClusteringOpsMode
	// CrawlReadTelemetryMode controls the seven crawl read/media/telemetry
	// endpoints migrated by this unit. It defaults to legacy. go mode
	// requires JWT, MySQL, Redis and Mongo (crawlresultcontents and tasklogs
	// live in Mongo; crawl tasks, media assets and quality snapshots live in
	// MySQL). No shadow, no canary and no worker.
	// endpoints migrated by this unit. It defaults to legacy. go mode
	// requires JWT, MySQL, Redis and Mongo (crawlresultcontents and tasklogs
	// live in Mongo; crawl tasks, media assets and quality snapshots live in
	// MySQL). No shadow, no canary and no worker.
	CrawlReadTelemetryMode CrawlReadTelemetryMode
	// RuntimeSettingsMode controls the eighteen runtime/governance settings
	// routes (see RuntimeSettingsMode). Default legacy. Mode go requires
	// JWT_SECRET, DATABASE_URL and REDIS_HOST; it does not require Mongo and
	// does not start any worker or scheduled job.
	RuntimeSettingsMode RuntimeSettingsMode
	// InfrastructureSettingsMode controls the seven infrastructure connection
	// and crawl-credential settings routes (see InfrastructureSettingsMode).
	// Default legacy. Mode go requires JWT_SECRET, DATABASE_URL and REDIS_HOST;
	// it does not require Mongo and does not start any worker or scheduled job.
	InfrastructureSettingsMode InfrastructureSettingsMode

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

	GraphQLAPQEnabled    bool
	GraphQLDepthLimit    int
	GraphQLComplexity    int
	GraphQLCacheEnabled  bool
	GraphQLCacheTTL      int
	TrustProxy           string
	RateLimitFailOpen    bool
	RateLimitLogin       int
	RateLimitLoginWindow int
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
	CrawlBaseURL             string
	CrawlAPIKey              string
	CrawlTimeoutMs           int
	CrawlHealthTTLMs         int
	CrawlSSRFProxyURL        string
	ItemsSearchRerankEnabled bool

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
	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_SPACETIME_GEO_MODE")) {
	case "", string(DashboardSpacetimeGeoModeLegacy):
		cfg.DashboardSpacetimeGeoMode = DashboardSpacetimeGeoModeLegacy
	case string(DashboardSpacetimeGeoModeGo):
		cfg.DashboardSpacetimeGeoMode = DashboardSpacetimeGeoModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_SPACETIME_GEO_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE")) {
	case "", string(DashboardSpacetimePropagationModeLegacy):
		cfg.DashboardSpacetimePropagationMode = DashboardSpacetimePropagationModeLegacy
	case string(DashboardSpacetimePropagationModeGo):
		cfg.DashboardSpacetimePropagationMode = DashboardSpacetimePropagationModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_DASHBOARD_STREAM_MODE")) {
	case "", string(DashboardStreamModeLegacy):
		cfg.DashboardStreamMode = DashboardStreamModeLegacy
	case string(DashboardStreamModeGo):
		cfg.DashboardStreamMode = DashboardStreamModeGo
	default:
		errs = append(errs, "API_GO_DASHBOARD_STREAM_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_HEALTHZ_MODE")) {
	case "", string(HealthzModeLegacy):
		cfg.HealthzMode = HealthzModeLegacy
	case string(HealthzModeGo):
		cfg.HealthzMode = HealthzModeGo
	default:
		errs = append(errs, "API_GO_HEALTHZ_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CONTENT_SUBSCRIPTIONS_MODE")) {
	case "", string(ContentSubscriptionsModeLegacy):
		cfg.ContentSubscriptionsMode = ContentSubscriptionsModeLegacy
	case string(ContentSubscriptionsModeGo):
		cfg.ContentSubscriptionsMode = ContentSubscriptionsModeGo
	default:
		errs = append(errs, "API_GO_CONTENT_SUBSCRIPTIONS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_USER_NEWS_BEHAVIOR_MODE")) {
	case "", string(UserNewsBehaviorModeLegacy):
		cfg.UserNewsBehaviorMode = UserNewsBehaviorModeLegacy
	case string(UserNewsBehaviorModeGo):
		cfg.UserNewsBehaviorMode = UserNewsBehaviorModeGo
	default:
		errs = append(errs, "API_GO_USER_NEWS_BEHAVIOR_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_USER_DIGEST_MODE")) {
	case "", string(UserDigestModeLegacy):
		cfg.UserDigestMode = UserDigestModeLegacy
	case string(UserDigestModeGo):
		cfg.UserDigestMode = UserDigestModeGo
	default:
		errs = append(errs, "API_GO_USER_DIGEST_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_ANALYSIS_VIEWS_MODE")) {
	case "", string(AnalysisViewsModeLegacy):
		cfg.AnalysisViewsMode = AnalysisViewsModeLegacy
	case string(AnalysisViewsModeGo):
		cfg.AnalysisViewsMode = AnalysisViewsModeGo
	default:
		errs = append(errs, "API_GO_ANALYSIS_VIEWS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_ANALYSIS_BOARDS_MODE")) {
	case "", string(AnalysisBoardsModeLegacy):
		cfg.AnalysisBoardsMode = AnalysisBoardsModeLegacy
	case string(AnalysisBoardsModeGo):
		cfg.AnalysisBoardsMode = AnalysisBoardsModeGo
	default:
		errs = append(errs, "API_GO_ANALYSIS_BOARDS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_ANALYSIS_THREADS_MODE")) {
	case "", string(AnalysisThreadsModeLegacy):
		cfg.AnalysisThreadsMode = AnalysisThreadsModeLegacy
	case string(AnalysisThreadsModeGo):
		cfg.AnalysisThreadsMode = AnalysisThreadsModeGo
	default:
		errs = append(errs, "API_GO_ANALYSIS_THREADS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_SITUATION_MONITORS_MODE")) {
	case "", string(SituationMonitorsModeLegacy):
		cfg.SituationMonitorsMode = SituationMonitorsModeLegacy
	case string(SituationMonitorsModeGo):
		cfg.SituationMonitorsMode = SituationMonitorsModeGo
	default:
		errs = append(errs, "API_GO_SITUATION_MONITORS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWS_SOURCES_MODE")) {
	case "", string(NewsSourcesModeLegacy):
		cfg.NewsSourcesMode = NewsSourcesModeLegacy
	case string(NewsSourcesModeGo):
		cfg.NewsSourcesMode = NewsSourcesModeGo
	default:
		errs = append(errs, "API_GO_NEWS_SOURCES_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_WORKFLOWS_MODE")) {
	case "", string(CrawlWorkflowsModeLegacy):
		cfg.CrawlWorkflowsMode = CrawlWorkflowsModeLegacy
	case string(CrawlWorkflowsModeGo):
		cfg.CrawlWorkflowsMode = CrawlWorkflowsModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_WORKFLOWS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_PROFILES_MODE")) {
	case "", string(CrawlProfilesModeLegacy):
		cfg.CrawlProfilesMode = CrawlProfilesModeLegacy
	case string(CrawlProfilesModeGo):
		cfg.CrawlProfilesMode = CrawlProfilesModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_PROFILES_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_RBAC_MODE")) {
	case "", string(RbacModeLegacy):
		cfg.RbacMode = RbacModeLegacy
	case string(RbacModeGo):
		cfg.RbacMode = RbacModeGo
	default:
		errs = append(errs, "API_GO_RBAC_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_TEMPLATES_MODE")) {
	case "", string(CrawlTemplatesModeLegacy):
		cfg.CrawlTemplatesMode = CrawlTemplatesModeLegacy
	case string(CrawlTemplatesModeGo):
		cfg.CrawlTemplatesMode = CrawlTemplatesModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_TEMPLATES_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_LLM_LOGS_MODE")) {
	case "", string(LlmLogsModeLegacy):
		cfg.LlmLogsMode = LlmLogsModeLegacy
	case string(LlmLogsModeGo):
		cfg.LlmLogsMode = LlmLogsModeGo
	default:
		errs = append(errs, "API_GO_LLM_LOGS_MODE must be one of legacy|go")
	}

	switch strings.TrimSpace(getenv("API_GO_ADMIN_LOGS_MODE")) {
	case "", string(AdminLogsModeLegacy):
		cfg.AdminLogsMode = AdminLogsModeLegacy
	case string(AdminLogsModeGo):
		cfg.AdminLogsMode = AdminLogsModeGo
	default:
		errs = append(errs, "API_GO_ADMIN_LOGS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWS_INDICATORS_MODE")) {
	case "", string(NewsIndicatorsModeLegacy):
		cfg.NewsIndicatorsMode = NewsIndicatorsModeLegacy
	case string(NewsIndicatorsModeGo):
		cfg.NewsIndicatorsMode = NewsIndicatorsModeGo
	default:
		errs = append(errs, "API_GO_NEWS_INDICATORS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_QUALITY_OVERVIEW_MODE")) {
	case "", string(QualityOverviewModeLegacy):
		cfg.QualityOverviewMode = QualityOverviewModeLegacy
	case string(QualityOverviewModeGo):
		cfg.QualityOverviewMode = QualityOverviewModeGo
	default:
		errs = append(errs, "API_GO_QUALITY_OVERVIEW_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CLASSIFICATION_RSS_OPS_MODE")) {
	case "", string(ClassificationRssOpsModeLegacy):
		cfg.ClassificationRssOpsMode = ClassificationRssOpsModeLegacy
	case string(ClassificationRssOpsModeGo):
		cfg.ClassificationRssOpsMode = ClassificationRssOpsModeGo
	default:
		errs = append(errs, "API_GO_CLASSIFICATION_RSS_OPS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWSNOW_CLUSTERING_OPS_MODE")) {
	case "", string(NewsnowClusteringOpsModeLegacy):
		cfg.NewsnowClusteringOpsMode = NewsnowClusteringOpsModeLegacy
	case string(NewsnowClusteringOpsModeGo):
		cfg.NewsnowClusteringOpsMode = NewsnowClusteringOpsModeGo
	default:
		errs = append(errs, "API_GO_NEWSNOW_CLUSTERING_OPS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_READ_TELEMETRY_MODE")) {
	case "", string(CrawlReadTelemetryModeLegacy):
		cfg.CrawlReadTelemetryMode = CrawlReadTelemetryModeLegacy
	case string(CrawlReadTelemetryModeGo):
		cfg.CrawlReadTelemetryMode = CrawlReadTelemetryModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_READ_TELEMETRY_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_RUNTIME_SETTINGS_MODE")) {
	case "", string(RuntimeSettingsModeLegacy):
		cfg.RuntimeSettingsMode = RuntimeSettingsModeLegacy
	case string(RuntimeSettingsModeGo):
		cfg.RuntimeSettingsMode = RuntimeSettingsModeGo
	default:
		errs = append(errs, "API_GO_RUNTIME_SETTINGS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_INFRASTRUCTURE_SETTINGS_MODE")) {
	case "", string(InfrastructureSettingsModeLegacy):
		cfg.InfrastructureSettingsMode = InfrastructureSettingsModeLegacy
	case string(InfrastructureSettingsModeGo):
		cfg.InfrastructureSettingsMode = InfrastructureSettingsModeGo
	default:
		errs = append(errs, "API_GO_INFRASTRUCTURE_SETTINGS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_READ_MODE")) {
	case "", "legacy":
		cfg.GraphQLReadMode = "legacy"
	case "go":
		cfg.GraphQLReadMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_READ_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_NEWS_EVENTS_MODE")) {
	case "", "legacy":
		cfg.GraphQLNewsEventsMode = "legacy"
	case "go":
		cfg.GraphQLNewsEventsMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_NEWS_EVENTS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_KG_IMPACT_MODE")) {
	case "", "legacy":
		cfg.GraphQLKgImpactMode = "legacy"
	case "go":
		cfg.GraphQLKgImpactMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_KG_IMPACT_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE")) {
	case "", "legacy":
		cfg.GraphQLKnowledgeGraphMode = "legacy"
	case "go":
		cfg.GraphQLKnowledgeGraphMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE must be one of legacy|go")
	}
	// The workspace switch accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy so an unset deployment keeps the
	// NestJS path.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_WORKSPACE_READ_MODE")) {
	case "", "legacy":
		cfg.GraphQLWorkspaceReadMode = "legacy"
	case "go":
		cfg.GraphQLWorkspaceReadMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_WORKSPACE_READ_MODE must be one of legacy|go")
	}
	// The settings/crawl switch accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy, so an unset deployment keeps
	// serving all twenty roots through NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE")) {
	case "", "legacy":
		cfg.GraphQLSettingsCrawlReadMode = "legacy"
	case "go":
		cfg.GraphQLSettingsCrawlReadMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE must be one of legacy|go")
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
	cfg.CrawlHealthTTLMs = intDefault(getenv("CRAWL4AI_HEALTH_CHECK_TTL_MS"), 60_000)
	cfg.CrawlSSRFProxyURL = strings.TrimSpace(getenv("CRAWL4AI_SSRF_PROXY_URL"))
	cfg.ItemsSearchRerankEnabled = boolDefault(getenv("ITEMS_SEARCH_RERANK_ENABLED"), true)
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
	if cfg.DashboardSpacetimeGeoMode == DashboardSpacetimeGeoModeGo {
		appendSpacetimeRequirements(&errs, "API_GO_DASHBOARD_SPACETIME_GEO_MODE", cfg)
	}
	if cfg.DashboardSpacetimePropagationMode == DashboardSpacetimePropagationModeGo {
		appendSpacetimeRequirements(&errs, "API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE", cfg)
	}
	if cfg.DashboardStreamMode == DashboardStreamModeGo {
		appendSpacetimeRequirements(&errs, "API_GO_DASHBOARD_STREAM_MODE", cfg)
	}
	if cfg.HealthzMode == HealthzModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_HEALTHZ_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_HEALTHZ_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_HEALTHZ_MODE=go")
		}
	}
	if cfg.UserNewsBehaviorMode == UserNewsBehaviorModeGo {
		appendAuthRequirements(&errs, "API_GO_USER_NEWS_BEHAVIOR_MODE", cfg)
	}
	if cfg.ContentSubscriptionsMode == ContentSubscriptionsModeGo {
		appendAuthRequirements(&errs, "API_GO_CONTENT_SUBSCRIPTIONS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_CONTENT_SUBSCRIPTIONS_MODE=go")
		}
	}
	if cfg.UserDigestMode == UserDigestModeGo {
		appendAuthRequirements(&errs, "API_GO_USER_DIGEST_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_USER_DIGEST_MODE=go")
		}
	}
	if cfg.AnalysisViewsMode == AnalysisViewsModeGo {
		appendAuthRequirements(&errs, "API_GO_ANALYSIS_VIEWS_MODE", cfg)
	}
	if cfg.AnalysisBoardsMode == AnalysisBoardsModeGo {
		appendAuthRequirements(&errs, "API_GO_ANALYSIS_BOARDS_MODE", cfg)
	}
	if cfg.AnalysisThreadsMode == AnalysisThreadsModeGo {
		appendAuthRequirements(&errs, "API_GO_ANALYSIS_THREADS_MODE", cfg)
	}
	if cfg.SituationMonitorsMode == SituationMonitorsModeGo {
		appendAuthRequirements(&errs, "API_GO_SITUATION_MONITORS_MODE", cfg)
	}
	if cfg.NewsSourcesMode == NewsSourcesModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWS_SOURCES_MODE", cfg)
	}
	if cfg.CrawlWorkflowsMode == CrawlWorkflowsModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_WORKFLOWS_MODE", cfg)
	}
	if cfg.CrawlProfilesMode == CrawlProfilesModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_PROFILES_MODE", cfg)
	}
	if cfg.RbacMode == RbacModeGo {
		appendAuthRequirements(&errs, "API_GO_RBAC_MODE", cfg)
	}
	if cfg.CrawlTemplatesMode == CrawlTemplatesModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_TEMPLATES_MODE", cfg)
	}
	if cfg.LlmLogsMode == LlmLogsModeGo {
		appendAuthRequirements(&errs, "API_GO_LLM_LOGS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_LLM_LOGS_MODE=go")
		}
	}

	if cfg.AdminLogsMode == AdminLogsModeGo {
		appendAuthRequirements(&errs, "API_GO_ADMIN_LOGS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ADMIN_LOGS_MODE=go")
		}
	}
	if cfg.NewsIndicatorsMode == NewsIndicatorsModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWS_INDICATORS_MODE", cfg)
	}
	if cfg.QualityOverviewMode == QualityOverviewModeGo {
		appendAuthRequirements(&errs, "API_GO_QUALITY_OVERVIEW_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_QUALITY_OVERVIEW_MODE=go")
		}
	}
	if cfg.ClassificationRssOpsMode == ClassificationRssOpsModeGo {
		appendAuthRequirements(&errs, "API_GO_CLASSIFICATION_RSS_OPS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_CLASSIFICATION_RSS_OPS_MODE=go")
		}
	}

	if cfg.NewsnowClusteringOpsMode == NewsnowClusteringOpsModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWSNOW_CLUSTERING_OPS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_NEWSNOW_CLUSTERING_OPS_MODE=go")
		}
	}
	// Crawl read/telemetry takeover reads crawlresultcontents and tasklogs from
	// Mongo in addition to the standard JWT + MySQL + Redis requirements.
	if cfg.CrawlReadTelemetryMode == CrawlReadTelemetryModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_READ_TELEMETRY_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_CRAWL_READ_TELEMETRY_MODE=go")
		}
	}
	// The runtime/governance settings takeover needs JWT verification, MySQL
	// and Redis only; it reads no Mongo collection and starts no worker.
	if cfg.RuntimeSettingsMode == RuntimeSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_RUNTIME_SETTINGS_MODE", cfg)
	}
	// The infrastructure settings takeover needs JWT verification, MySQL and
	// Redis only. It reads no Mongo collection, starts no worker and does not
	// treat the settings-encryption key as a startup requirement: a missing or
	// invalid key is handled per read/write by the documented fallback and 400
	// contracts.
	if cfg.InfrastructureSettingsMode == InfrastructureSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_INFRASTRUCTURE_SETTINGS_MODE", cfg)
	}
	if cfg.GraphQLReadMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_READ_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_GRAPHQL_READ_MODE=go")
		}
	}

	if len(errs) > 0 {
		return Config{}, errors.New(strings.Join(errs, "; "))
	}
	return cfg, nil
}

func appendAuthRequirements(errs *[]string, name string, cfg Config) {
	if cfg.JWTSecret == "" {
		*errs = append(*errs, "JWT_SECRET is required when "+name+"=go")
	}
	if cfg.DatabaseURL == "" {
		*errs = append(*errs, "DATABASE_URL is required when "+name+"=go")
	}
	if cfg.RedisHost == "" {
		*errs = append(*errs, "REDIS_HOST is required when "+name+"=go")
	}
}

func appendSpacetimeRequirements(errs *[]string, name string, cfg Config) {
	if cfg.JWTSecret == "" {
		*errs = append(*errs, "JWT_SECRET is required when "+name+"=go")
	}
	if cfg.DatabaseURL == "" {
		*errs = append(*errs, "DATABASE_URL is required when "+name+"=go")
	}
	if cfg.RedisHost == "" {
		*errs = append(*errs, "REDIS_HOST is required when "+name+"=go")
	}
	if cfg.MongoURI == "" {
		*errs = append(*errs, "MONGO_URI is required when "+name+"=go")
	}
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
