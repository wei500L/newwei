// Package config 加载 api-go 网关的环境变量。
//
// api-go 是 Strangler Fig 网关：默认把全部流量反向代理到 NestJS（LEGACY_API_URL），
// 已迁移路由逐步切到 Go 原生 handler（legacy → shadow → canary → go 四态）。
package config

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"regexp"
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

// NewsSourceSchedulerMode controls the 30-second news source cron only. It
// defaults to legacy. Go requires MySQL and Redis. The NestJS @Cron returns
// before taking the shared lock when this is go.
type NewsSourceSchedulerMode string

const (
	NewsSourceSchedulerModeLegacy NewsSourceSchedulerMode = "legacy"
	NewsSourceSchedulerModeGo     NewsSourceSchedulerMode = "go"
)

// NewsSourceOpsMode controls only the four POST /api/admin/news-sources/:id/{dispatch,cancel-queued,clear-inflight,retry-latest}
// routes. It defaults to legacy. Go requires JWT, MySQL and Redis.
type NewsSourceOpsMode string

const (
	NewsSourceOpsModeLegacy NewsSourceOpsMode = "legacy"
	NewsSourceOpsModeGo     NewsSourceOpsMode = "go"
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

// CrawlFrontierRunsMode controls the eleven crawl frontier run monitoring and
// cancellation HTTP routes under /api/admin/crawl-frontier
// (API_GO_CRAWL_FRONTIER_RUNS_MODE). It defaults to legacy and accepts only
// "", "legacy" and "go".
//
// Go mode takes over exactly these routes:
//
//	GET  /api/admin/crawl-frontier/runs
//	GET  /api/admin/crawl-frontier/runs/cancel   (matched as runs/:id)
//	GET  /api/admin/crawl-frontier/runs/:id
//	GET  /api/admin/crawl-frontier/runs/:id/workflow-run
//	GET  /api/admin/crawl-frontier/runs/:id/workflow-candidates
//	GET  /api/admin/crawl-frontier/runs/:id/workflow-candidates/:candidateId
//	POST /api/admin/crawl-frontier/runs/cancel
//	POST /api/admin/crawl-frontier/runs/:id/cancel
//	GET  /api/admin/crawl-frontier/nodes/:id
//	GET  /api/admin/crawl-frontier/workflow-runs/:runId
//	GET  /api/admin/crawl-frontier/workflow-runs/:runId/candidates
//	GET  /api/admin/crawl-frontier/workflow-runs/:runId/candidates/:candidateId/explanation
//
// Every other method, trailing slash and longer path falls back to NestJS.
// The write queue routes (create run, retry, replay, trial-run) are never
// registered here. Go mode requires JWT_SECRET, DATABASE_URL and REDIS_HOST;
// Mongo is not a startup dependency. No shadow, no canary, no worker and no
// crawler process is started, and rolling back only means setting this
// variable back to legacy.
type CrawlFrontierRunsMode string

const (
	CrawlFrontierRunsModeLegacy CrawlFrontierRunsMode = "legacy"
	CrawlFrontierRunsModeGo     CrawlFrontierRunsMode = "go"
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

// ExceptionIngestMode controls only the two exception-report POST endpoints that
// this batch migrates:
//
//	POST /api/observability/exception-events/client
//	POST /api/internal/observability/exception-events
//
// Default legacy. go takes over exactly those two paths; the seven admin log
// and error read GETs stay on their own API_GO_ADMIN_LOGS_MODE switch. Similar
// paths, other methods and every /api/observability/ read route keep falling
// through to NestJS. Shadow is never enabled, no worker is started and the
// missing LITELLM_CONFIG_INTERNAL_TOKEN stays an endpoint-level 403 instead of
// a startup failure.
type ExceptionIngestMode string

const (
	ExceptionIngestModeLegacy ExceptionIngestMode = "legacy"
	ExceptionIngestModeGo     ExceptionIngestMode = "go"
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

// ClassificationReportsMode controls only POST
// /api/admin/quality/classification/reports. The default is legacy.
//
// In go mode Go creates the ClassificationReportJob document and enqueues the
// "classification_quality" BullMQ job that builds the report. The GET
// /reports/:jobId read stays under API_GO_CLASSIFICATION_RSS_OPS_MODE; both
// switches can be combined, and either order is safe because the Mongo
// documents are shared.
//
// go requires JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI. No worker is
// started by this switch: report generation is owned by
// API_GO_CLASSIFICATION_QUALITY_WORKER_MODE so the two can roll out separately.
type ClassificationReportsMode string

const (
	// ClassificationReportsModeLegacy keeps the POST on NestJS.
	ClassificationReportsModeLegacy ClassificationReportsMode = "legacy"
	// ClassificationReportsModeGo serves the POST from Go.
	ClassificationReportsModeGo ClassificationReportsMode = "go"
)

// ClassificationQualityWorkerMode controls who consumes the
// "classification_quality" BullMQ queue. The default is legacy.
//
// The switch is read by both runtimes: NestJS skips creating its
// ClassificationQualityProcessor Worker when it is go (the Queue itself stays,
// because the news pipeline keeps producing review-seed jobs), and api-go starts
// the consumer. Execution is therefore exclusive and a job is never processed
// twice.
//
//	go requires DATABASE_URL, REDIS_HOST and MONGO_URI. It does not need
//	JWT_SECRET: the consumer authenticates nothing, it only reads and writes the
//	organization ids carried by each job.
//
// Concurrency is max(1, min(4, NEWS_PROCESS_QUEUE_CONCURRENCY)) with 2 as the
// unset value, which is the formula classification-quality.processor.ts uses.
type ClassificationQualityWorkerMode string

const (
	// ClassificationQualityWorkerModeLegacy leaves consumption to NestJS.
	ClassificationQualityWorkerModeLegacy ClassificationQualityWorkerMode = "legacy"
	// ClassificationQualityWorkerModeGo consumes the queue in api-go.
	ClassificationQualityWorkerModeGo ClassificationQualityWorkerMode = "go"
)

// PipelineRecoveryMode controls GET /api/admin/quality/pipeline/runs. The
// default is legacy.
//
// go requires JWT_SECRET, DATABASE_URL and MONGO_URI: ItemMeta comes from MySQL,
// ProcessedItem and TaskLog from Mongo, and the route keeps settings.manage.
//
// POST /replay and POST /rollback are not part of this switch; they are owned by
// PipelineRecoveryWriteMode, so the read and the writes can be switched
// independently.
type PipelineRecoveryMode string

const (
	// PipelineRecoveryModeLegacy keeps the read on NestJS.
	PipelineRecoveryModeLegacy PipelineRecoveryMode = "legacy"
	// PipelineRecoveryModeGo serves the read from Go.
	PipelineRecoveryModeGo PipelineRecoveryMode = "go"
)

// BullmqCleanupMode controls ownership of the retained-job cleanup for every
// tracked business queue (API_GO_BULLMQ_CLEANUP_MODE). The default is legacy.
//
// go stops the per-process NestJS timers and lets api-go run one leased cycle
// (lock:cron:bullmq-retained-cleanup) immediately after start and then hourly.
// Cleanup is idempotent, so a brief overlap while switching is harmless.
type BullmqCleanupMode string

const (
	// BullmqCleanupModeLegacy leaves every cleanup timer in NestJS.
	BullmqCleanupModeLegacy BullmqCleanupMode = "legacy"
	// BullmqCleanupModeGo runs the cleanup in api-go.
	BullmqCleanupModeGo BullmqCleanupMode = "go"
)

// ClassificationReviewSeedMode controls who enqueues classification review-seed
// jobs after an itemPipeline job completes
// (API_GO_CLASSIFICATION_REVIEW_SEED_MODE). The default is legacy.
//
// go attaches the consumer to api-go's single itemPipeline events reader and
// stops the NestJS listener. The review-seed job id is stable per organization
// and processed item, so several api-go instances or a switchover overlap still
// enqueue one job.
type ClassificationReviewSeedMode string

const (
	// ClassificationReviewSeedModeLegacy keeps the NestJS listener.
	ClassificationReviewSeedModeLegacy ClassificationReviewSeedMode = "legacy"
	// ClassificationReviewSeedModeGo triggers the enqueue from api-go.
	ClassificationReviewSeedModeGo ClassificationReviewSeedMode = "go"
)

// PipelineRecoveryWriteMode controls POST
// /api/admin/quality/pipeline/replay and /rollback
// (API_GO_PIPELINE_RECOVERY_WRITE_MODE). The default is legacy.
//
// go requires JWT_SECRET, DATABASE_URL, MONGO_URI and REDIS_HOST. It is
// independent of PipelineRecoveryMode, which still owns the runs read.
type PipelineRecoveryWriteMode string

const (
	// PipelineRecoveryWriteModeLegacy keeps both writes on NestJS.
	PipelineRecoveryWriteModeLegacy PipelineRecoveryWriteMode = "legacy"
	// PipelineRecoveryWriteModeGo serves both writes from Go.
	PipelineRecoveryWriteModeGo PipelineRecoveryWriteMode = "go"
)

// MetricsMode controls GET /api/metrics (API_GO_METRICS_MODE). The default is
// legacy, where NestJS serves the prom-client registry.
//
// go requires JWT_SECRET, DATABASE_URL and REDIS_HOST because the endpoint
// requires metrics.read plus a platform administrator, and a machine-token
// bearer is checked against its creator's current platform_admin role.
type MetricsMode string

const (
	// MetricsModeLegacy keeps the scrape on NestJS.
	MetricsModeLegacy MetricsMode = "legacy"
	// MetricsModeGo serves the scrape from the Go registry.
	MetricsModeGo MetricsMode = "go"
)

// StartupReconcileMode controls the asynchronous startup alignment of the
// TaskLog and LLM request log Mongo TTL indexes and, when configured, the
// Elasticsearch items index (API_GO_STARTUP_RECONCILE_MODE). The default is
// legacy.
//
// go requires REDIS_HOST for the startup:reconcile lease. Mongo, MySQL and
// Elasticsearch failures are warnings: they never block startup.
type StartupReconcileMode string

const (
	// StartupReconcileModeLegacy keeps both onModuleInit hooks in NestJS.
	StartupReconcileModeLegacy StartupReconcileMode = "legacy"
	// StartupReconcileModeGo runs the reconciliation in api-go.
	StartupReconcileModeGo StartupReconcileMode = "go"
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

// NewsnowSourcesMode controls the two public NewsNow source fetch endpoints:
//
//	GET  /api/news-aggregator/source
//	POST /api/news-aggregator/sources/batch
//
// It defaults to legacy. In go mode Go performs the real upstream fetch for all
// 64 registry ids, reads the global runtime-secret row from MySQL, writes the
// compatible fresh/stale Redis cache and publishes the source-refresh relay for
// the NestJS socket subscriber. It requires DATABASE_URL and REDIS_HOST only:
// the routes are public, so no JWT/Mongo/queue dependency is added and no
// scheduler, worker or cron is started. The NestJS warm and hottest-analysis
// schedulers keep running unchanged.
type NewsnowSourcesMode string

const (
	// NewsnowSourcesModeLegacy keeps both routes on NestJS and is the default,
	// including when the environment variable is unset or empty.
	NewsnowSourcesModeLegacy NewsnowSourcesMode = "legacy"
	// NewsnowSourcesModeGo performs the fetches in Go.
	NewsnowSourcesModeGo NewsnowSourcesMode = "go"
)

// NewsnowHottestMode controls the two authenticated NewsNow "hot" reading
// endpoints:
//
//	GET /api/news-aggregator/hottest-analysis
//	GET /api/news-aggregator/recommended
//
// It defaults to legacy. In go mode Go builds the global hottest snapshot,
// projects it per organization, optionally auto-imports items when the caller
// holds items.write, scores the recommended feed and writes the same Redis
// documents and locks as NestJS. It requires JWT_SECRET, DATABASE_URL,
// REDIS_HOST and MONGO_URI plus the existing LiteLLM gateway configuration, and
// starts no scheduler by itself.
type NewsnowHottestMode string

const (
	// NewsnowHottestModeLegacy keeps both routes on NestJS and is the default,
	// including when the environment variable is unset or empty.
	NewsnowHottestModeLegacy NewsnowHottestMode = "legacy"
	// NewsnowHottestModeGo serves both routes from Go.
	NewsnowHottestModeGo NewsnowHottestMode = "go"
)

// NewsnowBackgroundMode controls the two NewsNow background owners:
//
//	NewsnowHottestAnalysisScheduler   every 10 minutes
//	NewsnowSourceWarmScheduler        every minute
//
// Both NestJS and Go read it. When it is go the NestJS Cron callbacks return
// before claiming the tick gate or taking the lock. It defaults to legacy and
// requires DATABASE_URL, REDIS_HOST and MONGO_URI (the hottest refresh writes
// projections and domestic opinion snapshots); no JWT is involved.
type NewsnowBackgroundMode string

const (
	// NewsnowBackgroundModeLegacy keeps both Cron jobs on NestJS.
	NewsnowBackgroundModeLegacy NewsnowBackgroundMode = "legacy"
	// NewsnowBackgroundModeGo runs both schedules in Go.
	NewsnowBackgroundModeGo NewsnowBackgroundMode = "go"
)

// NewsClusteringLlmBackfillMode controls the manual LLM backfill enqueue route:
//
//	POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill
//
// Default legacy. go requires JWT_SECRET, DATABASE_URL, REDIS_HOST and
// MONGO_URI, and adds one BullMQ job to the shared
// news_event_clustering_recovery queue. It does not start the worker: the
// consumer has its own switch. The default (empty or legacy) leaves the route
// on NestJS.
type NewsClusteringLlmBackfillMode string

const (
	NewsClusteringLlmBackfillModeLegacy NewsClusteringLlmBackfillMode = "legacy"
	NewsClusteringLlmBackfillModeGo     NewsClusteringLlmBackfillMode = "go"
)

// NewsClusteringRecoveryWorkerMode controls the BullMQ consumer of the
// news_event_clustering_recovery queue, its five-minute pending scan and the
// stale-processing recovery rule (R1). Default legacy. go requires
// DATABASE_URL, REDIS_HOST and MONGO_URI; it serves no HTTP request, so
// JWT_SECRET is not a startup condition. NestJS reads the same variable and
// creates no Worker and runs no scan tick while it is go, so the queue never
// has two owners.
type NewsClusteringRecoveryWorkerMode string

const (
	NewsClusteringRecoveryWorkerModeLegacy NewsClusteringRecoveryWorkerMode = "legacy"
	NewsClusteringRecoveryWorkerModeGo     NewsClusteringRecoveryWorkerMode = "go"
)

// ArchivePreparationWorkerMode controls the BullMQ consumer of the
// archivePreparation queue. Default legacy. go requires MySQL, Redis, Mongo and
// SYSTEM_SETTINGS_ENCRYPTION_KEY: the worker reads processed articles and cache
// rows from MySQL, the state record and caches from Redis, ProcessedItem display
// signals from Mongo, and decrypts gateway profile api keys. NestJS reads the
// same variable and creates no Worker while it is go, so the queue never has two
// owners.
type ArchivePreparationWorkerMode string

const (
	ArchivePreparationWorkerModeLegacy ArchivePreparationWorkerMode = "legacy"
	ArchivePreparationWorkerModeGo     ArchivePreparationWorkerMode = "go"
)

// NewsIndicatorAssociationCronMode controls the six-hourly news-indicator
// association refresh. Default legacy. go requires DATABASE_URL and REDIS_HOST:
// the refresh writes MySQL and the tick gate and organization leases live in
// Redis, so the cron does not need JWT_SECRET or MONGO_URI. NestJS reads the same
// variable and returns before claiming the tick gate while it is go.
type NewsIndicatorAssociationCronMode string

const (
	NewsIndicatorAssociationCronModeLegacy NewsIndicatorAssociationCronMode = "legacy"
	NewsIndicatorAssociationCronModeGo     NewsIndicatorAssociationCronMode = "go"
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

// CrawlTaskWriteMode controls the three crawl task lifecycle writes
// (API_GO_CRAWL_TASK_WRITE_MODE):
//
//	POST   /api/crawl-tasks
//	DELETE /api/crawl-tasks/:id
//	POST   /api/crawl-tasks/:id/retry
//
// and the three GraphQL mutations createCrawlTask, deleteCrawlTask and
// retryCrawlTask. The accepted values are exactly "", "legacy" and "go"; any
// other value fails startup. go requires JWT_SECRET, DATABASE_URL and
// REDIS_HOST. Go writes the BullMQ job protocol and leaves execution to the
// NestJS CrawlQueueProcessor; it starts no worker, janitor or scheduled job.
type CrawlTaskWriteMode string

const (
	CrawlTaskWriteModeLegacy CrawlTaskWriteMode = "legacy"
	CrawlTaskWriteModeGo     CrawlTaskWriteMode = "go"
)

// CrawlQueueOpsMode controls the four crawl4ai queue administration routes
// (API_GO_CRAWL_QUEUE_OPS_MODE):
//
//	GET  /api/admin/crawl4ai/queue
//	POST /api/admin/crawl4ai/queue/pause
//	POST /api/admin/crawl4ai/queue/resume
//	POST /api/admin/crawl4ai/queue/concurrency
//
// The accepted values are exactly "", "legacy" and "go"; any other value fails
// startup. go requires JWT_SECRET, DATABASE_URL and REDIS_HOST. The switch is
// independent of API_GO_CRAWL_TASK_WRITE_MODE and of the crawl read switch.
type CrawlQueueOpsMode string

const (
	CrawlQueueOpsModeLegacy CrawlQueueOpsMode = "legacy"
	CrawlQueueOpsModeGo     CrawlQueueOpsMode = "go"
)

// CrawlMaintenanceMode controls the execution ownership of the four crawl
// maintenance crons (API_GO_CRAWL_MAINTENANCE_MODE):
//
//	CrawlTaskJanitorService.cleanupCron              every minute
//	CrawlCleanupOutboxService.retryPendingCleanupOutbox every minute
//	CrawlAdaptiveConcurrencyService.adjustCron        every minute
//	CrawlQualityTaskSnapshotService.refreshRecentSnapshots every five minutes
//
// The accepted values are exactly "", "legacy" and "go"; any other value fails
// startup instead of silently degrading. legacy (the default) keeps every
// NestJS @Cron callback. go starts the Go schedulers and makes NestJS return
// from the five callbacks before taking any lock. It requires DATABASE_URL,
// REDIS_HOST and MONGO_URI because the janitor writes TaskLog documents, the
// outbox replay deletes Mongo content and the quality refresh rolls Mongo
// aggregates. It needs no JWT: the crons serve no HTTP route. The shared Redis
// keys are the same in both processes, so a flip cannot double-run a tick.
type CrawlMaintenanceMode string

const (
	// CrawlMaintenanceModeLegacy keeps every NestJS maintenance cron (default,
	// including the empty value).
	CrawlMaintenanceModeLegacy CrawlMaintenanceMode = "legacy"
	// CrawlMaintenanceModeGo runs the four maintenance crons in this process.
	CrawlMaintenanceModeGo CrawlMaintenanceMode = "go"
)

// AuditLogRetentionMode controls the execution ownership of
// AuditLogRetentionService.handleCron (API_GO_AUDIT_LOG_RETENTION_MODE). The
// accepted values are exactly "", "legacy" and "go"; any other value fails
// startup. legacy keeps the NestJS daily 01:00 callback; go runs the purge in
// this process and NestJS returns from the callback. It requires DATABASE_URL
// and REDIS_HOST (the retention cache) and no JWT or Mongo.
type AuditLogRetentionMode string

const (
	// AuditLogRetentionModeLegacy keeps the NestJS @Cron (default, including the
	// empty value).
	AuditLogRetentionModeLegacy AuditLogRetentionMode = "legacy"
	// AuditLogRetentionModeGo runs the hourly-01:00 local purge in this process.
	AuditLogRetentionModeGo AuditLogRetentionMode = "go"
)

// CrawlMetadataMode controls the single HTTP entry of the web page metadata
// preview chain (API_GO_CRAWL_METADATA_MODE):
//
//	POST /api/crawl-tasks/metadata
//
// The accepted values are exactly "", "legacy" and "go"; the empty value and
// "legacy" both keep the route on the NestJS proxy, and any other value fails
// startup instead of silently degrading. go mode takes over exactly this POST
// plus its CORS preflight and answers 201 {orgId,total,results}; every other
// method and the neighbouring crawl task routes keep falling back to NestJS.
//
// The entry performs real robots/sitemap discovery and page fetching, so go
// mode requires JWT_SECRET, DATABASE_URL and REDIS_HOST. It does not require
// Mongo, S3, crawl4ai or STORAGE_MODE. No shadow, no canary, no enqueue, no
// worker and no business database write is started.
type CrawlMetadataMode string

const (
	CrawlMetadataModeLegacy CrawlMetadataMode = "legacy"
	CrawlMetadataModeGo     CrawlMetadataMode = "go"
)

// NewsSourcePreviewMode controls the single news-source preview entry
// (API_GO_NEWS_SOURCE_PREVIEW_MODE):
//
//	GET /api/admin/news-sources/:id/preview
//
// The accepted values are exactly "", "legacy" and "go"; the empty value and
// "legacy" both keep the route on the NestJS proxy, and any other value fails
// startup. go mode requires JWT_SECRET, DATABASE_URL and REDIS_HOST; crawl4ai
// stays optional (deep discovery then reports SEED_DEEP_CRAWL4AI_UNAVAILABLE
// and list discovery falls back to raw HTML, exactly like NestJS). The entry is
// read-only: no row is written and nothing is enqueued.
type NewsSourcePreviewMode string

const (
	NewsSourcePreviewModeLegacy NewsSourcePreviewMode = "legacy"
	NewsSourcePreviewModeGo     NewsSourcePreviewMode = "go"
)

// CrawlWorkflowTrialMode controls the crawl-strategy workflow trial run and
// replay entries (API_GO_CRAWL_WORKFLOW_TRIAL_MODE):
//
//	POST /api/admin/crawl-frontier/workflows/:id/trial-run
//	POST /api/admin/crawl-frontier/workflow-runs/:runId/replay
//
// The accepted values are exactly "", "legacy" and "go"; the empty value and
// "legacy" both keep the two routes on the NestJS proxy, and any other value
// fails startup. go mode requires JWT_SECRET, DATABASE_URL and REDIS_HOST;
// crawl4ai stays optional in the same way as the preview. The entries write the
// crawl-strategy run records and start no queue, worker or timer.
type CrawlWorkflowTrialMode string

const (
	CrawlWorkflowTrialModeLegacy CrawlWorkflowTrialMode = "legacy"
	CrawlWorkflowTrialModeGo     CrawlWorkflowTrialMode = "go"
)

// SearchReindexMode controls the two search index rebuild HTTP routes migrated by
// this unit (API_GO_SEARCH_REINDEX_MODE):
//
//	POST /api/admin/search/reindex
//	GET  /api/admin/search/reindex/:jobId
//
// The accepted values are exactly "", "legacy" and "go"; the empty value and
// "legacy" both keep both routes on the NestJS proxy, and any other value fails
// startup instead of silently degrading. go mode takes over only these two
// routes: every other method, the trailing-slash path and longer paths keep
// falling back to NestJS. It requires JWT_SECRET, DATABASE_URL, REDIS_HOST and
// MONGO_URI (the item read model lives in Mongo). Elasticsearch is not a startup
// requirement: a disabled or unconfigured ELASTICSEARCH_ENABLED keeps the
// existing disabled branch. Search telemetry keeps its own
// API_GO_CRAWL_READ_TELEMETRY_MODE switch. go starts no worker, does not touch
// BullMQ and does not change the production web entry.
type SearchReindexMode string

const (
	// SearchReindexModeLegacy proxies both routes to NestJS (default, including
	// the empty value). Rolling back only means setting
	// API_GO_SEARCH_REINDEX_MODE back to legacy.
	SearchReindexModeLegacy SearchReindexMode = "legacy"
	// SearchReindexModeGo serves both routes from Go with the same
	// authentication chain as NestJS and the same Redis job, list, set and lock
	// layout, so a mixed deployment stays compatible.
	SearchReindexModeGo SearchReindexMode = "go"
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

// StorageDiagnosticsMode controls the single storage connection test route
// migrated by this unit (API_GO_STORAGE_DIAGNOSTICS_MODE):
//
//	POST /api/admin/settings/storage/test
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep the route on the NestJS proxy, and any other value fails
// startup instead of silently degrading.
//
// The switch is deliberately independent of API_GO_INFRASTRUCTURE_SETTINGS_MODE
// and of API_GO_CRAWL_READ_TELEMETRY_MODE: the seven configuration routes keep
// their own switch, and enabling the diagnostics alone takes over only this one
// exact route (plus its CORS preflight). go mode requires JWT_SECRET,
// DATABASE_URL and REDIS_HOST; it never requires MONGO_URI and never requires
// the settings/crawl or GraphQL switches. No S3 client is built at startup and
// no probe runs before a request: the route answers 201 in both modes and
// reports per-step failures inside the response body. Rollback only means
// setting the variable back to legacy.
type StorageDiagnosticsMode string

const (
	// StorageDiagnosticsModeLegacy proxies the route to NestJS (default,
	// including the empty value).
	StorageDiagnosticsModeLegacy StorageDiagnosticsMode = "legacy"
	// StorageDiagnosticsModeGo serves the route from Go with the ordinary
	// settings.manage permission (no platform-admin second gate, matching the
	// NestJS controller) and the shared settings cache and secret decryption.
	StorageDiagnosticsModeGo StorageDiagnosticsMode = "go"
)

// AccountSecurityMode controls the eight authenticated account, session and
// machine-token HTTP routes migrated by this unit
// (API_GO_ACCOUNT_SECURITY_MODE): GET /api/auth/me, PATCH /api/auth/profile,
// POST /api/auth/change-password, POST /api/auth/logout,
// POST /api/auth/machine-tokens, GET /api/auth/machine-tokens,
// DELETE /api/auth/machine-tokens/:tokenId and
// POST /api/auth/machine-tokens/:tokenId/rotate.
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep every request on the NestJS proxy, and any other value
// fails startup instead of silently degrading. go mode requires JWT_SECRET,
// DATABASE_URL and REDIS_HOST (the shared appendAuthRequirements check); it
// never requires MONGO_URI because this unit reads and writes MySQL and Redis
// only, never enables shadow or canary traffic and never starts a worker.
type AccountSecurityMode string

const (
	// AccountSecurityModeLegacy proxies all eight routes to NestJS (default,
	// including the empty value). Rolling back only means setting
	// API_GO_ACCOUNT_SECURITY_MODE back to legacy.
	AccountSecurityModeLegacy AccountSecurityMode = "legacy"
	// AccountSecurityModeGo serves the eight routes from Go with the same
	// authentication chain as NestJS (human JWT verification, Redis access
	// blacklist, MySQL membership re-derivation) plus the mtk_ machine-token
	// path, without changing the JWT format, the refresh rotation protocol or
	// the MFA policy.
	AccountSecurityModeGo AccountSecurityMode = "go"
)

// AvatarUploadMode controls POST /api/auth/avatar/presigned-url
// (API_GO_AVATAR_UPLOAD_MODE). Accepted values are exactly "", "legacy" and
// "go"; empty and legacy keep the route on NestJS, any other value fails
// startup. go requires JWT_SECRET, DATABASE_URL and REDIS_HOST and never
// requires MONGO_URI: the route reads the storage settings from MySQL, uses the
// shared Redis cache and signs locally without contacting S3.
type AvatarUploadMode string

const (
	// AvatarUploadModeLegacy proxies the route to NestJS (default).
	AvatarUploadModeLegacy AvatarUploadMode = "legacy"
	// AvatarUploadModeGo serves the route from Go with the same validation
	// order, messages, status code and response body as NestJS, plus the V1
	// content-length binding.
	AvatarUploadModeGo AvatarUploadMode = "go"
)

// UserDataExportMode controls GET /api/auth/data-export
// (API_GO_USER_DATA_EXPORT_MODE). Accepted values are exactly "", "legacy" and
// "go"; empty and legacy keep the route on NestJS, any other value fails
// startup. go requires JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI
// (assistantruns lives in Mongo).
type UserDataExportMode string

const (
	// UserDataExportModeLegacy proxies the route to NestJS (default).
	UserDataExportModeLegacy UserDataExportMode = "legacy"
	// UserDataExportModeGo serves the route from Go with the same document,
	// filename, headers, rate limit and audit side effects as NestJS.
	UserDataExportModeGo UserDataExportMode = "go"
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

// DataRuntimeSettingsMode controls the nine "data runtime settings and archive
// status" HTTP routes migrated by this unit
// (API_GO_DATA_RUNTIME_SETTINGS_MODE): realtime signals settings, archive
// preparation settings, the archive preparation operational status and the
// Nominatim identity settings.
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep every request on the NestJS proxy, and any other value
// fails startup instead of silently degrading. go mode requires JWT_SECRET,
// DATABASE_URL and REDIS_HOST; it never requires MONGO_URI (this unit reads and
// writes MySQL and Redis only), never enables shadow or canary traffic and never
// starts a worker.
//
// SYSTEM_SETTINGS_ENCRYPTION_KEY is deliberately optional at startup: a missing
// or invalid key is handled per read and write by the documented fallback and 400
// contracts rather than blocking boot.
type DataRuntimeSettingsMode string

const (
	// DataRuntimeSettingsModeLegacy proxies all nine routes to NestJS (default,
	// including the empty value). Rolling back only means setting
	// API_GO_DATA_RUNTIME_SETTINGS_MODE back to legacy.
	DataRuntimeSettingsModeLegacy DataRuntimeSettingsMode = "legacy"
	// DataRuntimeSettingsModeGo serves all nine routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens, and the same
	// platform-admin gate on the five write routes.
	DataRuntimeSettingsModeGo DataRuntimeSettingsMode = "go"
)

// EmailSettingsMode controls the three email settings routes
// (API_GO_EMAIL_SETTINGS_MODE): GET /api/system-settings/email,
// PUT /api/system-settings/email/auth-code and
// POST /api/system-settings/email/test.
//
// The accepted values are exactly "", "legacy" and "go"; any other value fails
// startup instead of silently degrading. The default is legacy. go requires
// JWT_SECRET, DATABASE_URL, REDIS_HOST and the SMTP_* transport, because the
// status route performs a real SMTP verify and the test route sends a real
// message.
type EmailSettingsMode string

const (
	// EmailSettingsModeLegacy proxies the three routes to NestJS (default,
	// including the empty value). Rolling back only changes this variable.
	EmailSettingsModeLegacy EmailSettingsMode = "legacy"
	// EmailSettingsModeGo serves the three routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens. It reads and writes
	// MySQL and Redis and talks to the configured SMTP server.
	EmailSettingsModeGo EmailSettingsMode = "go"
)

// GeocodingMode controls the two geocoding routes (API_GO_GEOCODING_MODE):
// POST /api/geo/geocode (items.read) and
// POST /api/system-settings/geo/nominatim/test (settings.manage).
//
// The accepted values are exactly "", "legacy" and "go"; any other value fails
// startup. The default is legacy. go requires JWT_SECRET, DATABASE_URL and
// REDIS_HOST; it does not require Mongo and contacts Nominatim only inside a
// request.
type GeocodingMode string

const (
	// GeocodingModeLegacy proxies the two routes to NestJS (default, including
	// the empty value).
	GeocodingModeLegacy GeocodingMode = "legacy"
	// GeocodingModeGo serves the two routes from Go, sharing the
	// geo:geocode:v1 cache and the geocode:nominatim rate limit with NestJS.
	GeocodingModeGo GeocodingMode = "go"
)

// RuntimeDiagnosticsMode controls the two read-only runtime diagnostics routes
// (API_GO_RUNTIME_DIAGNOSTICS_MODE):
// GET /api/system-settings/assistant-safety/diagnostics and
// GET /api/system-settings/realtime-signals/runtime.
//
// The accepted values are exactly "", "legacy" and "go"; any other value fails
// startup. The default is legacy. go requires JWT_SECRET, DATABASE_URL,
// REDIS_HOST and MONGO_URI, because the realtime diagnostics read the
// processeditems collection and the assistant safety probe talks to LiteLLM.
type RuntimeDiagnosticsMode string

const (
	// RuntimeDiagnosticsModeLegacy proxies the two routes to NestJS (default,
	// including the empty value).
	RuntimeDiagnosticsModeLegacy RuntimeDiagnosticsMode = "legacy"
	// RuntimeDiagnosticsModeGo serves the two read-only diagnostics from Go.
	// It starts no worker, refreshes no ACLED token, writes no cache and only
	// reads shared MySQL/Redis/Mongo state.
	RuntimeDiagnosticsModeGo RuntimeDiagnosticsMode = "go"
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

// PlatformGovernanceSettingsMode controls the sixteen platform governance
// settings HTTP routes migrated by this unit
// (API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE). The accepted values are exactly
// "", "legacy" and "go"; any other value fails startup with the fixed text
// "API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE must be one of legacy|go" instead
// of silently degrading. The default is legacy.
type PlatformGovernanceSettingsMode string

const (
	// PlatformGovernanceSettingsModeLegacy proxies all sixteen routes to NestJS
	// (default, including the empty value). Rollback only changes this variable
	// back to legacy.
	PlatformGovernanceSettingsModeLegacy PlatformGovernanceSettingsMode = "legacy"
	// PlatformGovernanceSettingsModeGo serves all sixteen routes from Go with
	// the same authentication chain as NestJS (JWT verification, Redis
	// blacklist, MySQL membership re-derivation) plus mtk_ machine tokens. It
	// requires JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI at startup
	// because the assistant-quota usage query and the assistant-safety metrics
	// aggregation read Mongo and the task-log / llm-request-log retention
	// settings reconcile Mongo TTL indexes. It never enables shadow or canary
	// traffic.
	PlatformGovernanceSettingsModeGo PlatformGovernanceSettingsMode = "go"
)

// ModelAccessSettingsMode controls the ten model service configuration and OpenAI
// key distribution HTTP routes (API_GO_MODEL_ACCESS_SETTINGS_MODE).
//
//	go mode takes over exactly these ten routes:
//	  GET    /api/system-settings/model-service
//	  PUT    /api/system-settings/model-service
//	  DELETE /api/system-settings/model-service
//	  GET    /api/system-settings/openai-keys
//	  PUT    /api/system-settings/openai-keys
//	  POST   /api/system-settings/openai-keys
//	  DELETE /api/system-settings/openai-keys/key/:fingerprint
//	  DELETE /api/system-settings/openai-keys
//	  GET    /api/internal/litellm/openai-keys
//	  POST   /api/internal/litellm/openai-keys/applied
//
// /api/system-settings/llm-gateways and every other /api/system-settings route
// keep falling back to NestJS; the load balancing paths have their own
// independent switch (ProxyLoadBalancingMode). go mode
// requires JWT_SECRET, DATABASE_URL and REDIS_HOST only: it reads no Mongo
// collection, calls no model upstream and starts no worker. The accepted values
// are exactly "", "legacy" and "go"; any other value fails startup instead of
// silently degrading. The default is legacy.
type ModelAccessSettingsMode string

const (
	// ModelAccessSettingsModeLegacy proxies all ten routes to NestJS (default,
	// including the empty value). Rollback only changes this variable back to
	// legacy.
	ModelAccessSettingsModeLegacy ModelAccessSettingsMode = "legacy"
	// ModelAccessSettingsModeGo serves all ten routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens, the platform admin gate
	// on the six management writes, and the LITELLM_CONFIG_INTERNAL_TOKEN guard
	// on the two internal routes. It never enables shadow or canary traffic.
	ModelAccessSettingsModeGo ModelAccessSettingsMode = "go"
)

// ItemsReadingMode controls the two item reading REST routes and the five item
// reading GraphQL roots (API_GO_ITEMS_READING_MODE). Default legacy.
type ItemsReadingMode string

const (
	// ItemsReadingModeLegacy serves both REST routes and all five GraphQL
	// roots through NestJS (default, including an unset value).
	ItemsReadingModeLegacy ItemsReadingMode = "legacy"
	// ItemsReadingModeGo serves both REST routes from Go against MySQL, Mongo
	// and Redis, and (together with API_GO_GRAPHQL_READ_MODE) registers the
	// five item reading GraphQL roots.
	ItemsReadingModeGo ItemsReadingMode = "go"
)

// ItemsIngestMode controls the write side of the items domain: the exact
// POST /api/items and the five item/crawl mutations. It defaults to legacy and
// is independent of every read switch. Go requires JWT, MySQL, Redis and Mongo,
// and starts no background scheduler; immediate raw_item delivery is part of
// each request.
type ItemsIngestMode string

const (
	ItemsIngestModeLegacy ItemsIngestMode = "legacy"
	ItemsIngestModeGo     ItemsIngestMode = "go"
)

// RawItemOutboxMode controls the per-minute raw_item replay owner. It defaults
// to legacy and is independent of ItemsIngestMode. Go requires MySQL, Redis and
// Mongo but no JWT, HTTP or GraphQL switch. SCHEDULE_ENABLED=false stops the
// scheduled replay in both processes but never stops request-time delivery.
type RawItemOutboxMode string

const (
	RawItemOutboxModeLegacy RawItemOutboxMode = "legacy"
	RawItemOutboxModeGo     RawItemOutboxMode = "go"
)

// ProcessedItemOutboxMode controls the processed_item MongoOutbox compensation
// owner. The accepted values are exactly "", "legacy" and "go"; empty behaves
// like legacy. go starts the Go five-minute scanner and makes the NestJS Cron
// return before scanning. The synchronous in-worker delivery and in-process
// retry remain in NestJS. Go requires MySQL, Redis and Mongo, but no JWT or any
// HTTP/GraphQL switch; vector settings are resolved from the effective
// SystemSetting row at delivery time.
//
// The throughput knobs are only read in go mode:
// PROCESSED_ITEM_OUTBOX_TICK_BUDGET_MS (default 240000, below the 5-minute
// period), PROCESSED_ITEM_OUTBOX_CONCURRENCY (default 4) and
// PROCESSED_ITEM_OUTBOX_BATCH_SIZE (default 10).
type ProcessedItemOutboxMode string

const (
	ProcessedItemOutboxModeLegacy ProcessedItemOutboxMode = "legacy"
	ProcessedItemOutboxModeGo     ProcessedItemOutboxMode = "go"
)

// LLMGatewayProfilesMode controls the seven LLM gateway profile
// configuration-control routes under /api/system-settings/llm-gateways
// (API_GO_LLM_GATEWAY_PROFILES_MODE). Accepted values are exactly "", "legacy"
// and "go"; any other value fails startup instead of silently degrading. The
// default is legacy. Mode go reuses the shared auth requirements (JWT_SECRET,
// DATABASE_URL, REDIS_HOST) and never requires Mongo or a live model upstream.
type LLMGatewayProfilesMode string

const (
	// LLMGatewayProfilesModeLegacy proxies all seven routes to NestJS
	// (default, including the empty value).
	LLMGatewayProfilesModeLegacy LLMGatewayProfilesMode = "legacy"
	// LLMGatewayProfilesModeGo serves the seven routes from Go with the same
	// authentication chain as NestJS plus the platform-admin gate. It never
	// enables shadow or canary traffic.
	LLMGatewayProfilesModeGo LLMGatewayProfilesMode = "go"
)

// LLMGatewayOpsMode controls the twelve LiteLLM gateway governance and
// diagnostics routes under /api/system-settings/llm-gateways
// (API_GO_LLM_GATEWAY_OPS_MODE). Accepted values are exactly "", "legacy" and
// "go"; any other value fails startup.
//
//	go mode takes over exactly these twelve routes:
//	  GET/PUT/DELETE /proxy-governance
//	  POST           /proxy-governance/preflight
//	  POST           /proxy-governance/rotate-key
//	  POST           /models-config
//	  POST           /test-config
//	  GET            /:id/models
//	  POST           /:id/test
//	  GET            /:id/proxy-health
//	  GET            /:id/proxy-model-info
//	  POST           /:id/proxy-lb-test
//
// The switch is independent of API_GO_LLM_GATEWAY_PROFILES_MODE: governance and
// diagnostics can run on Go while the seven profile CRUD routes stay on NestJS,
// and the other way round. Go mode requires the shared auth resources plus
// MONGO_URI, because every real probe attempt writes one llmrequestlogs row. It
// does NOT require LITELLM_MASTER_KEY or SYSTEM_SETTINGS_ENCRYPTION_KEY at
// startup: their absence is a per-request 503 on the governance management calls
// and a per-read "unreadable" key state.
type LLMGatewayOpsMode string

const (
	// LLMGatewayOpsModeLegacy proxies all twelve routes to NestJS (default,
	// including the empty value).
	LLMGatewayOpsModeLegacy LLMGatewayOpsMode = "legacy"
	// LLMGatewayOpsModeGo serves the twelve routes from Go.
	LLMGatewayOpsModeGo LLMGatewayOpsMode = "go"
)

// ProxyLoadBalancingMode controls the four LiteLLM proxy load balancing
// configuration and distribution HTTP routes
// (API_GO_PROXY_LOAD_BALANCING_MODE).
//
//	go mode takes over exactly these four routes:
//	  GET    /api/system-settings/llm-gateways/proxy-load-balancing
//	  PUT    /api/system-settings/llm-gateways/proxy-load-balancing
//	  DELETE /api/system-settings/llm-gateways/proxy-load-balancing
//	  GET    /api/internal/litellm/proxy-load-balancing
//
// The switch is independent of API_GO_MODEL_ACCESS_SETTINGS_MODE: the Go load
// balancing service reuses the existing OpenAI key reader, but it neither
// requires nor enables the model access takeover. Go mode requires JWT_SECRET,
// DATABASE_URL and REDIS_HOST only: it reads no Mongo collection, calls no model
// upstream and starts no worker. The accepted values are exactly "", "legacy"
// and "go"; any other value fails startup instead of silently degrading. The
// default is legacy.
type ProxyLoadBalancingMode string

const (
	// ProxyLoadBalancingModeLegacy proxies all four routes to NestJS (default,
	// including the empty value). Rollback only changes this variable back to
	// legacy.
	ProxyLoadBalancingModeLegacy ProxyLoadBalancingMode = "legacy"
	// ProxyLoadBalancingModeGo serves all four routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens, the platform admin gate
	// on the two management writes, and the LITELLM_CONFIG_INTERNAL_TOKEN guard
	// on the internal snapshot route. It never enables shadow or canary traffic.
	ProxyLoadBalancingModeGo ProxyLoadBalancingMode = "go"
)

// SituationMonitorsMode 只控制态势监控自定义监控的五条 HTTP。默认 legacy。
// 不接管 insights、catalog、feedback、refresh、telegram、oref、HLS，
// 也不接管已迁走的 /api/user-settings/ui/situation-monitor。
type SituationMonitorsMode string

const (
	SituationMonitorsModeLegacy SituationMonitorsMode = "legacy"
	SituationMonitorsModeGo     SituationMonitorsMode = "go"
)

// SituationSignalsMode controls the seven situation monitor signal read and
// feedback HTTP routes (API_GO_SITUATION_MONITOR_SIGNALS_MODE). The accepted
// values are exactly "", "legacy" and "go"; any other value fails startup
// instead of silently degrading. The default is legacy.
type SituationSignalsMode string

const (
	// SituationSignalsModeLegacy proxies all seven routes to NestJS (default,
	// including the empty value). Rollback only changes this variable back to
	// legacy.
	SituationSignalsModeLegacy SituationSignalsMode = "legacy"
	// SituationSignalsModeGo serves the seven routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis revocation list,
	// MySQL membership re-derivation) plus mtk_ machine tokens. It requires
	// JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI at startup because
	// feedback writes Mongo, refresh-runs reads MySQL and the signal state is
	// read from Redis. Shadow and canary are never enabled by this switch, and
	// no Telegram, OREF or model-gateway request is issued.
	SituationSignalsModeGo SituationSignalsMode = "go"
)

// SituationInsightsMode controls GET /api/situation-monitor/insights
// (API_GO_SITUATION_INSIGHTS_MODE). The accepted values are exactly "",
// "legacy" and "go"; any other value fails startup. The default is legacy.
// The go mode needs JWT, MySQL, Redis and Mongo because the route reads
// ProcessedItem/RawItem, the settings envelope, the external snapshot, the
// realtime insight snapshot and the monitor rules.
type SituationInsightsMode string

const (
	// SituationInsightsModeLegacy proxies the route to NestJS (default,
	// including the empty value). Rollback only changes this variable.
	SituationInsightsModeLegacy SituationInsightsMode = "legacy"
	// SituationInsightsModeGo serves the complete insights read pipeline from
	// Go. It starts no worker and never rebuilds the GDELT snapshot or
	// dispatches news collection.
	SituationInsightsModeGo SituationInsightsMode = "go"
)

// SituationSettingsMode controls the four situation-monitor settings HTTP
// routes (API_GO_SITUATION_SETTINGS_MODE): GET/PUT/DELETE
// /api/system-settings/situation-monitor and DELETE
// /api/system-settings/situation-monitor/telegram-auth.
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep every request on the NestJS proxy, and any other value
// fails startup instead of silently degrading. go mode requires JWT_SECRET,
// DATABASE_URL, REDIS_HOST, MONGO_URI (the quality summary runs the insights
// pipeline) and a non-empty SYSTEM_SETTINGS_ENCRYPTION_KEY (the write path
// encrypts credentials). It starts no worker and never issues a Telegram/OREF
// upstream request.
type SituationSettingsMode string

const (
	// SituationSettingsModeLegacy proxies the four routes to NestJS (default,
	// including the empty value). Rollback only changes this variable.
	SituationSettingsModeLegacy SituationSettingsMode = "legacy"
	// SituationSettingsModeGo serves the four routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens and the controller's
	// settings.manage permission gate.
	SituationSettingsModeGo SituationSettingsMode = "go"
)

// GdeltSnapshotMode controls which process owns the 15-minute GDELT external
// snapshot rebuild (API_GO_GDELT_SNAPSHOT_MODE). The accepted values are exactly
// "", "legacy" and "go"; any other value fails startup instead of silently
// degrading. The default is legacy, which keeps the NestJS @Cron callback and
// its Redis lease.
type GdeltSnapshotMode string

const (
	// GdeltSnapshotModeLegacy keeps the NestJS scheduler (default, including
	// the empty value). Rollback only changes this variable back to legacy.
	GdeltSnapshotModeLegacy GdeltSnapshotMode = "legacy"
	// GdeltSnapshotModeGo runs the rebuild in this process every quarter hour.
	// It requires DATABASE_URL and REDIS_HOST because the rebuild writes the
	// MySQL history row and both Redis cache layers, and it needs no JWT because
	// the scheduler serves no HTTP route. NestJS and Go share one rebuild lease,
	// so a flip cannot rebuild twice.
	GdeltSnapshotModeGo GdeltSnapshotMode = "go"
)

// GdeltSnapshotRefreshMode controls which process owns
// POST /api/system-settings/situation-monitor/external-snapshot/refresh
// (API_GO_GDELT_SNAPSHOT_REFRESH_MODE). Only Go reads this variable; NestJS
// keeps serving the controller route. The accepted values are again "",
// "legacy" and "go", and the default is legacy.
type GdeltSnapshotRefreshMode string

const (
	// GdeltSnapshotRefreshModeLegacy keeps the route on NestJS (default).
	GdeltSnapshotRefreshModeLegacy GdeltSnapshotRefreshMode = "legacy"
	// GdeltSnapshotRefreshModeGo serves the route from Go. It requires
	// JWT_SECRET, DATABASE_URL and REDIS_HOST: the handler re-derives the
	// caller's settings.manage permission and runs the same rebuild as the
	// scheduler under the shared lease.
	GdeltSnapshotRefreshModeGo GdeltSnapshotRefreshMode = "go"
)

// RealtimeSignalsMode controls which process owns the realtime signal collection
// cron, RealtimeSignalsService.refreshScheduled (API_GO_REALTIME_SIGNALS_MODE).
// The accepted values are exactly "", "legacy" and "go"; any other value fails
// startup instead of silently degrading. The default is legacy, which keeps the
// NestJS @Cron callback and its shared Redis tick gate.
//
// Execution ownership is all-or-nothing: the eight sources feed one insight
// snapshot, so the switch cannot split the source set between the two processes.
// Both sides claim the same tick gate and organization leases, so a rolling flip
// still collects at most once per interval.
type RealtimeSignalsMode string

const (
	// RealtimeSignalsModeLegacy keeps the NestJS scheduler (default, including
	// the empty value). Rollback only changes this variable back to legacy.
	RealtimeSignalsModeLegacy RealtimeSignalsMode = "legacy"
	// RealtimeSignalsModeGo runs the collector in this process every minute. It
	// requires DATABASE_URL, REDIS_HOST and MONGO_URI because a round reads MySQL
	// settings, organizations and processed articles, writes the shared Redis
	// documents, and writes Mongo transport tracks. It serves no HTTP route, so
	// JWT_SECRET is not a startup condition.
	RealtimeSignalsModeGo RealtimeSignalsMode = "go"
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

// UserDigestDeliveryMode controls the background daily-digest delivery owner.
// It is independent of the five HTTP switches. The accepted values are exactly
// "", "legacy" and "go"; the empty value behaves like legacy.
//
// legacy: the NestJS Cron keeps owning delivery and no Go scheduler or NestJS
// digest subscriber starts.
// go: Go owns the per-minute scan, due-slot CAS, SMTP delivery, status write-back
// and digest notifications; the NestJS Cron returns before its tick gate and the
// NestJS digest subscriber connects to the relay channel. Go requires
// DATABASE_URL, REDIS_HOST, MONGO_URI and the SMTP_* transport, but not
// JWT_SECRET or any HTTP takeover switch.
type UserDigestDeliveryMode string

const (
	UserDigestDeliveryModeLegacy UserDigestDeliveryMode = "legacy"
	UserDigestDeliveryModeGo     UserDigestDeliveryMode = "go"
)

// AuditOutboxMode controls the AuditLogOutbox replay owner. It is independent
// of every HTTP switch. The accepted values are exactly "", "legacy" and "go";
// the empty value behaves like legacy.
//
// legacy: the NestJS @Cron keeps owning the per-minute replay and no Go
// scheduler starts.
// go: Go owns the per-minute scan, Redis cron lease, conditional claim,
// dedupe insert and failure/dead write-back; the NestJS Cron returns before
// acquiring the lease and scanning. Go requires DATABASE_URL and REDIS_HOST,
// but not JWT_SECRET, MONGO_URI, SMTP or any HTTP takeover switch.
//
// SCHEDULE_ENABLED=false stops this chain in both processes: the NestJS module
// stops registering the Cron and the Go wiring does not start the scheduler.
type AuditOutboxMode string

const (
	AuditOutboxModeLegacy AuditOutboxMode = "legacy"
	AuditOutboxModeGo     AuditOutboxMode = "go"
)

// NewsEventsTimelineMode controls which process owns the ten-minute news-event
// timeline rebuild (API_GO_NEWS_EVENTS_TIMELINE_MODE). The accepted values are
// exactly "", "legacy" and "go"; any other value fails startup instead of
// silently degrading.
//
// legacy: the NestJS @Cron keeps owning the rebuild and no Go scheduler starts.
// go: Go owns the ten-minute wall-clock tick, the Redis tick gate, the
// per-organization lease, the NewsEventTimelineEntry rows and the
// metadata.timeline write; the NestJS @Cron returns before claiming the gate.
// Both processes share the same gate and lease keys, so a brief overlap cannot
// rebuild one organization twice. Go requires DATABASE_URL, REDIS_HOST and
// MONGO_URI, but not JWT_SECRET: the unit serves no HTTP route.
type NewsEventsTimelineMode string

const (
	NewsEventsTimelineModeLegacy NewsEventsTimelineMode = "legacy"
	NewsEventsTimelineModeGo     NewsEventsTimelineMode = "go"
)

// SentimentSnapshotMode controls which process owns the hourly sentiment
// snapshot rebuild (API_GO_SENTIMENT_SNAPSHOT_MODE). The accepted values are
// again "", "legacy" and "go", and the default is legacy.
//
// It is independent of NewsEventsTimelineMode. Go requires DATABASE_URL,
// REDIS_HOST and MONGO_URI, but not JWT_SECRET: the unit serves no HTTP route
// and never reads the HTTP snapshot endpoints.
type SentimentSnapshotMode string

const (
	SentimentSnapshotModeLegacy SentimentSnapshotMode = "legacy"
	SentimentSnapshotModeGo     SentimentSnapshotMode = "go"
)

// EconomicDataMode controls the three economic-data GraphQL mutations and the
// three AkShare gateway admin HTTP routes (API_GO_ECONOMIC_DATA_MODE). The
// empty value is legacy, matching every other migration switch. Go requires
// JWT_SECRET, DATABASE_URL and REDIS_HOST; Mongo is not a request-path startup
// requirement.
type EconomicDataMode string

const (
	EconomicDataModeLegacy EconomicDataMode = "legacy"
	EconomicDataModeGo     EconomicDataMode = "go"
)

// EconomicDataWorkerMode controls catalog synchronization, repeat-job
// synchronization and the akshare-data BullMQ consumer
// (API_GO_ECONOMIC_DATA_WORKER_MODE). It is independent of the request switch
// and of every GraphQL read switch. Go requires DATABASE_URL, REDIS_HOST and
// MONGO_URI, but not JWT_SECRET.
type EconomicDataWorkerMode string

const (
	EconomicDataWorkerModeLegacy EconomicDataWorkerMode = "legacy"
	EconomicDataWorkerModeGo     EconomicDataWorkerMode = "go"
)

// KnowledgeGraphIngestionMode controls the knowledge-graph automatic
// construction background chain (API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE). It is
// independent of every HTTP switch and of the GraphQL read switches. The
// accepted values are exactly "", "legacy" and "go"; the empty value behaves
// like legacy.
//
// legacy: the NestJS Cron keeps owning the five-minute tick and no Go
// scheduler starts.
// go: Go owns the tick gate, the per-organization lock, the cursor, the model
// validation/disambiguation calls and the transactional graph writes; the
// NestJS Cron returns before claiming the tick gate. Go requires DATABASE_URL
// and REDIS_HOST; the model gateway is resolved at request time from the same
// gateway profiles publicportal uses, so no JWT or HTTP takeover switch is
// required.
type KnowledgeGraphIngestionMode string

const (
	KnowledgeGraphIngestionModeLegacy KnowledgeGraphIngestionMode = "legacy"
	KnowledgeGraphIngestionModeGo     KnowledgeGraphIngestionMode = "go"
)

// NewsEventsIngestionMode controls the owner of the news-event ingestion Cron
// (API_GO_NEWS_EVENTS_INGESTION_MODE). It is independent of every HTTP switch
// and of the GraphQL read switches. The accepted values are exactly "",
// "legacy" and "go"; the empty value behaves like legacy and an invalid value
// fails startup.
//
// legacy: NewsEventsIngestionService.ingestRecentProcessedArticles keeps
// owning the five-minute tick and no Go scheduler starts.
// go: Go owns the tick gate, the per-organization lock, the ingestion cursor,
// the per-article assignment and the bertopic_primary batch, and the NestJS
// Cron returns before claiming the tick gate. Go requires DATABASE_URL,
// REDIS_HOST and MONGO_URI: the cursor and the events live in MySQL, the tick
// gate and the organization leases in Redis, and ProcessedItem/TaskLog/the
// clustering failure groups in Mongo. The vector and model services are
// resolved at call time, so they are not startup requirements.
type NewsEventsIngestionMode string

const (
	NewsEventsIngestionModeLegacy NewsEventsIngestionMode = "legacy"
	NewsEventsIngestionModeGo     NewsEventsIngestionMode = "go"
)

// AlertWorkerMode controls the owner of the NestJS `alerts` queue: the
// scan-active-rules scan, the rule evaluation, the in-app notification write and
// the email/webhook delivery. It is independent of every HTTP switch. The
// accepted values are exactly "", "legacy" and "go"; the empty value behaves
// like legacy.
//
// legacy: the NestJS AlertsProcessor keeps consuming the queue and nothing in
// api-go starts.
// go: api-go consumes the queue, schedules the scan, writes the events,
// deliveries and notifications, and publishes the alertEvents and alert
// notification bridges. Go requires DATABASE_URL, REDIS_HOST and MONGO_URI, and
// the SMTP transport for email channels; JWT is not required. The model service
// client is optional (the economic anomaly provider degrades to its local
// fallback).
type AlertWorkerMode string

const (
	AlertWorkerModeLegacy AlertWorkerMode = "legacy"
	AlertWorkerModeGo     AlertWorkerMode = "go"
)

// CrawlFrontierLlmWorkerMode controls the owner of the two Frontier LLM
// BullMQ queues (`frontier-llm-judge` and `frontier-llm-learn`). It is
// independent of every HTTP switch and of the three crawl4ai queue workers,
// which stay on NestJS. The accepted values are exactly "", "legacy" and "go";
// the empty value behaves like legacy and an invalid value fails startup.
//
// legacy: NestJS CrawlQueueProcessor keeps creating both LLM workers.
// go: NestJS creates only the three crawl workers and api-go consumes the two
// LLM queues with concurrency 1 and the shared queue-level limiter
// (max 1 per 1000ms). Go requires DATABASE_URL, REDIS_HOST and
// SYSTEM_SETTINGS_ENCRYPTION_KEY (the gateway profile key and the managed
// governance key are decrypted with it); JWT is not required.
type CrawlFrontierLlmWorkerMode string

const (
	CrawlFrontierLlmWorkerModeLegacy CrawlFrontierLlmWorkerMode = "legacy"
	CrawlFrontierLlmWorkerModeGo     CrawlFrontierLlmWorkerMode = "go"
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

// AnalysisExportMode controls the two CSV export POST routes migrated by this
// unit (API_GO_ANALYSIS_EXPORT_MODE):
//
//	POST /api/analysis/exports/items
//	POST /api/analysis/exports/events
//
// The accepted values are exactly "", "legacy" and "go"; the empty value
// behaves like legacy, so an unset deployment keeps both exports on NestJS.
// The third export route, POST /api/analysis/exports/search, stays on NestJS
// because its headlines mode prepares archive digests. Go requires JWT, MySQL,
// Redis and Mongo: the item candidates are ranked through the shared search
// scope, the read-model projection lives in Mongo and the behavior profile is
// read from MySQL/Redis. The unit initializes the item reading service, the
// personalization provider and the news-event reader on its own, so it works
// even while the other item/analysis/GraphQL switches are legacy. Rolling back
// only means setting this variable back to legacy.
type AnalysisExportMode string

const (
	AnalysisExportModeLegacy AnalysisExportMode = "legacy"
	AnalysisExportModeGo     AnalysisExportMode = "go"
)

// ArchiveReadingMode controls the three archive GraphQL queries and the
// headlines search export (API_GO_ARCHIVE_READING_MODE):
//
//	Query archiveDigest
//	Query archiveCalendar
//	Query archiveDetail
//	POST /api/analysis/exports/search
//
// The accepted values are exactly "", "legacy" and "go"; the empty value
// behaves like legacy. Go needs the credentialed JWT/MySQL/Redis stack and
// Mongo (display eligibility and model attempt logs). The switch is independent
// of API_GO_GRAPHQL_READ_MODE and API_GO_ANALYSIS_EXPORT_MODE: turning it on
// alone assembles the GraphQL handler and the search export. The archive
// preparation consumer stays in NestJS; this switch only produces compatible
// BullMQ jobs.
type ArchiveReadingMode string

const (
	ArchiveReadingModeLegacy ArchiveReadingMode = "legacy"
	ArchiveReadingModeGo     ArchiveReadingMode = "go"
)

// AnalysisRunsMode controls the three analysis run Mutations migrated by this
// unit (API_GO_ANALYSIS_RUNS_MODE):
//
//	requestCorrelationAnalysis
//	requestAnomalyExplanation
//	requestGeoTransportAnalysis
//
// It owns only those three roots and is independent of the GraphQL read switch,
// the analysis CSV export switch and the three collaboration HTTP switches. The
// empty value behaves like legacy. Go mode verifies JWTs, re-derives the
// organization from MySQL membership, inserts the pending result into Mongo and
// adds the BullMQ job to Redis. It does not claim that a worker is running: the
// separate API_GO_ANALYSIS_WORKER_MODE owns consumption.
type AnalysisRunsMode string

const (
	AnalysisRunsModeLegacy AnalysisRunsMode = "legacy"
	AnalysisRunsModeGo     AnalysisRunsMode = "go"
)

// AnalysisWorkerMode controls the owner of the analysis BullMQ consumer
// (API_GO_ANALYSIS_WORKER_MODE). The empty value behaves like legacy, which
// keeps the NestJS AnalysisProcessor. In go mode the NestJS processor returns
// before creating its Worker and this process consumes the same queue, so it
// can process jobs produced by the legacy NestJS mutations as well.
//
// The worker needs MySQL, Redis, Mongo and GRAPHQL_SUBSCRIPTION_BUS=redis, but
// no JWT_SECRET and no GraphQL read/write switch. BULLMQ_WORKERS_ENABLED=false
// still disables consumption on both sides.
type AnalysisWorkerMode string

const (
	AnalysisWorkerModeLegacy AnalysisWorkerMode = "legacy"
	AnalysisWorkerModeGo     AnalysisWorkerMode = "go"
)

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

// GraphQLSubscriptionsMode controls the four realtime Subscription roots
// (alertEvents, analysisEvents, assistantEvents, queueEvents) on an exact GET
// /graphql graphql-transport-ws upgrade. The accepted values are exactly "",
// "legacy" and "go"; empty behaves like legacy.
//
// go owns only legal upgrade requests. HTTP GET/POST/OPTIONS continue through
// the existing GraphQL read/write switches, other subprotocols and longer paths
// continue through legacy proxying, and Query/Mutation or unsupported
// subscription operations on the same socket are forwarded as a whole to
// NestJS. The local executor needs JWT verification, MySQL and Redis but no
// Mongo, regardless of READ or any write switch.
type GraphQLSubscriptionsMode string

const (
	GraphQLSubscriptionsModeLegacy GraphQLSubscriptionsMode = "legacy"
	GraphQLSubscriptionsModeGo     GraphQLSubscriptionsMode = "go"
)

// NotificationsSocketMode controls the dedicated Go Socket.IO transport for
// the /notifications namespace (Engine.IO v4 + Socket.IO v5 over WebSocket).
// The accepted values are exactly "", "legacy" and "go"; empty behaves like
// legacy. go requires JWT, MySQL and Redis and serves the dedicated
// /socket.io-notifications path, so every other Socket.IO namespace keeps the
// NestJS transport and the default Web entrypoint unchanged.
type NotificationsSocketMode string

const (
	NotificationsSocketModeLegacy NotificationsSocketMode = "legacy"
	NotificationsSocketModeGo     NotificationsSocketMode = "go"
)

// AuthFactorsMode controls the seven authenticated MFA management and
// organization OIDC configuration HTTP routes migrated by this unit
// (API_GO_AUTH_FACTORS_MODE).
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep every request on the NestJS proxy, and any other value
// fails startup instead of silently degrading. The default is always legacy.
//
// go mode takes over exactly these seven routes:
//
//	GET  /api/auth/mfa
//	POST /api/auth/mfa/enroll
//	POST /api/auth/mfa/verify-enroll
//	POST /api/auth/mfa/disable
//	POST /api/auth/mfa/recovery/rotate
//	GET  /api/auth/admin/oidc-config
//	PUT  /api/auth/admin/oidc-config
//
// Everything else under /api/auth keeps falling back to NestJS: login, refresh,
// logout, profile, change-password, machine-token management, the public MFA
// login and forced-enrollment challenges, and the OIDC start/callback/handoff
// login chain. go mode requires JWT_SECRET, DATABASE_URL and REDIS_HOST; it
// never requires MONGO_URI (this unit reads and writes MySQL and Redis only),
// never enables shadow or canary traffic, never starts a worker, and never
// contacts an identity provider. Rolling back only means setting this variable
// back to legacy.
type AuthFactorsMode string

const (
	// AuthFactorsModeLegacy proxies all seven routes to NestJS (default,
	// including the empty value).
	AuthFactorsModeLegacy AuthFactorsMode = "legacy"
	// AuthFactorsModeGo serves all seven routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens.
	AuthFactorsModeGo AuthFactorsMode = "go"
)

// AuthLoginMode controls the eleven POST /api/auth routes migrated by this unit
// (API_GO_AUTH_LOGIN_MODE): password login, session refresh, passwordless email
// code login, the two public MFA challenges (verify-login and the forced
// enrollment start/complete pair), password recovery (forgot/reset) and the
// authenticated email-change chain (send-verification/verify-email).
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep every one of the eleven requests on the NestJS proxy, and
// any other value fails startup instead of silently degrading. The default is
// always legacy.
//
// go mode takes over exactly these eleven routes:
//
//	POST /api/auth/login
//	POST /api/auth/refresh
//	POST /api/auth/send-login-code
//	POST /api/auth/login-with-code
//	POST /api/auth/mfa/verify-login
//	POST /api/auth/mfa/enrollment/start
//	POST /api/auth/mfa/enrollment/complete
//	POST /api/auth/password/forgot
//	POST /api/auth/password/reset
//	POST /api/auth/send-verification
//	POST /api/auth/verify-email
//
// Nothing else under /api/auth is registered, so logout, /me, profile,
// change-password, machine tokens, the seven authenticated MFA management /
// OIDC configuration routes and the whole OIDC start/callback/handoff chain keep
// falling back to NestJS regardless of this switch.
//
// go mode requires JWT_SECRET (with issuer/audience) plus a valid DATABASE_URL
// and REDIS_HOST, because every route re-derives the user, membership, role and
// permission state from MySQL and shares the refresh, blacklist and email-code
// state in Redis. It additionally requires the SMTP_* transport: four routes
// send real mail as a synchronous side effect. It never requires MONGO_URI — no
// Mongo collection is read, no worker or scheduled job is started and no
// identity provider is contacted. Rolling back only means setting this variable
// back to legacy; every session, refresh token, challenge and email code it
// wrote stays readable by NestJS because each key and column format is shared.
type AuthLoginMode string

const (
	// AuthLoginModeLegacy proxies all eleven routes to NestJS (default,
	// including the empty value).
	AuthLoginModeLegacy AuthLoginMode = "legacy"
	// AuthLoginModeGo serves all eleven routes from Go with the same session,
	// challenge, email-code, rate-limit and audit protocols NestJS uses.
	AuthLoginModeGo AuthLoginMode = "go"
)

// OIDCLoginMode controls the organization SSO login entries migrated by
// API_GO_OIDC_LOGIN_MODE:
//
//	GET  /api/auth/sso/oidc/start
//	GET  /api/auth/oidc/callback
//	POST /api/auth/sso/handoff/exchange
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" keep all three requests on the NestJS proxy, and any other value
// fails startup instead of silently degrading. The default is always legacy.
//
// go mode requires JWT_SECRET, DATABASE_URL and REDIS_HOST because it reuses the
// migrated trusted-login core (JWT signing, MySQL session/membership state and
// Redis state/discovery/JWKS caches). It never requires MONGO_URI, SMTP_*,
// AUTH_LOGIN/AUTH_FACTORS/ACCOUNT_SECURITY/IDENTITY_ONBOARDING go modes or an
// enabled GraphQL executor. API_BASE_URL stays a request-time requirement: a
// missing value fails the start/callback request with the source 400 and never
// blocks gateway startup. Rolling back only means setting this variable back to
// legacy; state, caches, sessions, refresh tokens and handoff rows stay
// readable by NestJS because every key and column format is shared.
type OIDCLoginMode string

const (
	// OIDCLoginModeLegacy proxies all three routes to NestJS (default,
	// including the empty value).
	OIDCLoginModeLegacy OIDCLoginMode = "legacy"
	// OIDCLoginModeGo serves the three SSO entries from Go.
	OIDCLoginModeGo OIDCLoginMode = "go"
)

// IdentityOnboardingMode controls the fourteen registration, invitation and
// registration-application routes migrated by this unit
// (API_GO_IDENTITY_ONBOARDING_MODE).
//
// The accepted values are exactly "", "legacy" and "go"; an empty value and
// "legacy" both keep every request on the NestJS proxy, and any other value
// fails startup instead of silently degrading. The default is always legacy.
//
// go mode takes over exactly these fourteen routes:
//
//	GET  /api/auth/admin/invites
//	POST /api/auth/admin/invites
//	POST /api/auth/admin/invites/:id/resend
//	POST /api/auth/admin/invites/:id/revoke
//	GET  /api/auth/admin/registration-applications
//	POST /api/auth/admin/registration-applications/:id/approve-join
//	POST /api/auth/admin/registration-applications/:id/reject-join
//	POST /api/auth/admin/registration-applications/:id/approve-org
//	POST /api/auth/admin/registration-applications/:id/reject-org
//	POST /api/auth/register/applications
//	POST /api/auth/register/join-applications
//	GET  /api/auth/invitations/:token
//	POST /api/auth/invitations/:token/accept
//	POST /api/auth/invitations/:token/accept-authenticated
//
// Nothing else under /api/auth is registered: login, refresh, logout, profile,
// change-password, machine tokens, MFA management and the whole OIDC chain keep
// falling back to NestJS regardless of this switch.
//
// go mode requires JWT_SECRET (with issuer/audience), a valid DATABASE_URL, a
// REDIS_HOST and the SMTP_* transport, because invitations and rejected
// applications send real mail synchronously inside the request. It never
// requires MONGO_URI, starts no worker or scheduled job and contacts no identity
// provider. Rolling back only means setting this variable back to legacy; the
// invitation hashes, statuses, applications and memberships stay readable by
// NestJS because every column format is shared.
type IdentityOnboardingMode string

const (
	// IdentityOnboardingModeLegacy proxies all fourteen routes to NestJS
	// (default, including the empty value).
	IdentityOnboardingModeLegacy IdentityOnboardingMode = "legacy"
	// IdentityOnboardingModeGo serves all fourteen routes from Go with the same
	// authentication chain as NestJS (JWT verification, Redis blacklist, MySQL
	// membership re-derivation) plus mtk_ machine tokens.
	IdentityOnboardingModeGo IdentityOnboardingMode = "go"
)

// SMTPConfig is the real SMTP transport configuration (the Env.smtpConfig
// equivalent). It is read when API_GO_AUTH_LOGIN_MODE=go or
// API_GO_IDENTITY_ONBOARDING_MODE=go: those units send mail synchronously inside
// the request, so a missing transport is a startup error rather than a
// per-request failure.
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
	// UserDigestDeliveryMode 见 UserDigestDeliveryMode 常量。默认 legacy。
	// 与五个 HTTP 开关独立；go 需要 MySQL、Redis、Mongo 和 SMTP，不要求 JWT。
	UserDigestDeliveryMode UserDigestDeliveryMode
	// AuditOutboxMode 见 AuditOutboxMode 常量。默认 legacy。
	// 与所有 HTTP 开关独立；go 只要求 MySQL 与 Redis，不要求 JWT、Mongo 或 SMTP。
	AuditOutboxMode AuditOutboxMode
	// NewsEventsTimelineMode 见 NewsEventsTimelineMode 常量。默认 legacy。
	// 与所有 HTTP / GraphQL 开关独立；go 需要 MySQL、Redis 与 Mongo，
	// 不要求 JWT。与 NestJS 共用 tick gate 与组织锁的键名。
	NewsEventsTimelineMode NewsEventsTimelineMode
	// SentimentSnapshotMode 见 SentimentSnapshotMode 常量。默认 legacy。
	// 与 NewsEventsTimelineMode 独立；go 需要 MySQL、Redis 与 Mongo，
	// 不要求 JWT。与 NestJS 共用 tick gate 与组织锁的键名。
	SentimentSnapshotMode SentimentSnapshotMode
	// ScheduleEnabled mirrors the NestJS `process.env.SCHEDULE_ENABLED !==
	// "false"` check. Background units (audit outbox, raw_item replay) use it to
	// stop scheduling without changing their ownership switch; the digest
	// delivery unit keeps its existing behavior.
	ScheduleEnabled bool
	// KnowledgeGraphIngestionMode 见 KnowledgeGraphIngestionMode 常量。默认
	// legacy。与所有 HTTP / GraphQL 读开关独立；go 需要 MySQL 和 Redis，不
	// 要求 JWT、Mongo 或任何接管的 HTTP 开关。
	KnowledgeGraphIngestionMode KnowledgeGraphIngestionMode
	// NewsEventsIngestionMode 见 NewsEventsIngestionMode 常量。默认 legacy。
	// 与所有 HTTP / GraphQL 读开关独立；go 需要 MySQL、Redis 和 Mongo，不要求
	// JWT，也不要求任何接管的 HTTP 开关。
	NewsEventsIngestionMode NewsEventsIngestionMode
	// NewsEventsIngestionSettleMs 是 NEWS_EVENTS_INGESTION_SETTLE_MS：入库读取的
	// processedAt 上界（now - settleMs）。默认 120000 毫秒。它让「processedAt 较
	// 早、但事务提交较晚」的文章不会因为游标越过而被永久跳过。
	NewsEventsIngestionSettleMs int64
	// AlertWorkerMode 见 AlertWorkerMode 常量。默认 legacy。
	// go 需要 MySQL、Redis、Mongo 与 SMTP；ALERT_* 与 BULLMQ_NAMESPACE 只在
	// 该模式被读取。
	AlertWorkerMode AlertWorkerMode
	// CrawlFrontierLlmWorkerMode 见 CrawlFrontierLlmWorkerMode 常量。默认
	// legacy。go 需要 MySQL、Redis 与设置加密密钥；三个爬取队列 worker 仍由
	// NestJS 执行。
	CrawlFrontierLlmWorkerMode CrawlFrontierLlmWorkerMode
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
	// 分析工作台三个 HTTP 开关，彼此独立，默认都是 legacy。
	// 只决定对应精确路由。讨论检查、评论计数和删除清理不看另一个开关。
	// go 要求 JWT、MySQL、Redis，不要求 Mongo。
	AnalysisViewsMode   AnalysisViewsMode
	AnalysisBoardsMode  AnalysisBoardsMode
	AnalysisThreadsMode AnalysisThreadsMode
	// AnalysisExportMode gates the two CSV export POST routes. It defaults to
	// legacy and is independent of the three collaboration switches; go reuses
	// the item reading and news-event readers but builds its own instances and
	// requires JWT, MySQL, Redis and Mongo.
	AnalysisExportMode AnalysisExportMode
	// ArchiveReadingMode gates the three archive queries and the search CSV
	// export. It is independent of every read/export switch and defaults to
	// legacy. Go requires JWT, MySQL, Redis and Mongo.
	ArchiveReadingMode ArchiveReadingMode
	// AnalysisRunsMode gates the three analysis run Mutations. It is
	// independent of the GraphQL read switch and requires JWT, MySQL, Redis and
	// Mongo in go mode.
	AnalysisRunsMode AnalysisRunsMode
	// AnalysisWorkerMode moves the analysis queue consumer from NestJS to this
	// process. It requires MySQL, Redis, Mongo and the Redis subscription bus,
	// but no JWT.
	AnalysisWorkerMode AnalysisWorkerMode
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
	// channels; legacy accepts redis or local with unchanged NestJS semantics.
	GraphQLSubscriptionBus string
	// GraphQLReadMode 控制精确 /graphql 的已迁移 query。默认 legacy。
	// go 只执行本轮 16 个 query；mutation、subscription、未迁移 query 仍代理 NestJS。
	GraphQLReadMode string
	// GraphQLSubscriptionsMode controls the four realtime subscriptions on an
	// exact GET /graphql WebSocket upgrade. It defaults to legacy. go takes
	// over graphql-transport-ws upgrade requests only: HTTP GET/POST/OPTIONS
	// keep their existing read/write switch behavior, other upgrades and longer
	// paths keep proxying to NestJS. It is independent of every read and write
	// switch and requires JWT, MySQL and Redis only (no Mongo).
	GraphQLSubscriptionsMode GraphQLSubscriptionsMode
	// NotificationsSocketMode takes over only the /notifications namespace on
	// the dedicated /socket.io-notifications path. It is independent of every
	// GraphQL switch and defaults to legacy.
	NotificationsSocketMode NotificationsSocketMode
	// WebSocket connection caps and connect-window limits share the NestJS
	// environment names and defaults so the Go path enforces the same policy.
	WSMaxConnectionsPerUser         int
	WSMaxConnectionsPerIP           int
	WSConnectRateLimitPerIP         int
	WSConnectRateLimitPerUser       int
	WSConnectRateLimitWindowSeconds int
	// GraphQLNewsEventsMode 只决定六个新闻事件 root 是否登记。默认 legacy。
	// 读查询为 legacy 时不另挂 /graphql。两个都是 go 才登记；新闻事件为 legacy
	// 时，含这六个 root 的文档整包回 NestJS。回滚只改这个变量。
	GraphQLNewsEventsMode string
	// GraphQLNewsEventBriefMode 是 newsEventBrief 单 root 的子开关，默认
	// legacy。只有 API_GO_GRAPHQL_READ_MODE 与
	// API_GO_GRAPHQL_NEWS_EVENTS_MODE 都为 go 时才允许为 go：此时该 root 走
	// Go 的选源→模型→校验→写回 briefV1 全链路。为 legacy 时只登记其余五个
	// 新闻事件 root，含 newsEventBrief 的文档整包回 NestJS（不再由不完整的
	// Go 单 root 默认接管）。回滚只改这个变量；旧 briefV1 缓存保持兼容。
	GraphQLNewsEventBriefMode string
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
	// GraphQLCrawlMetadataMode only decides whether the crawlMetadata root is
	// registered into the Go GraphQL executor. The accepted values are exactly
	// "", "legacy" and "go"; the empty value behaves like legacy. The root is
	// registered only when both API_GO_GRAPHQL_READ_MODE and this switch are go;
	// while this switch is legacy, any document that selects crawlMetadata
	// falls back to NestJS as a whole. Go requires
	// API_GO_GRAPHQL_READ_MODE=go (which already requires Mongo) and otherwise
	// fails startup. Rolling back only means setting this variable back to
	// legacy.
	GraphQLCrawlMetadataMode string
	// ItemsReadingMode decides whether the two item reading REST routes and the
	// five item reading GraphQL roots are served by Go. The accepted values are
	// exactly "", "legacy" and "go"; the empty value behaves like legacy, so an
	// unset deployment keeps serving through NestJS. Go requires JWT, MySQL,
	// Redis and Mongo (the read model and the processed/raw collections live in
	// Mongo). The five GraphQL roots are registered only when both
	// API_GO_GRAPHQL_READ_MODE and this switch are go; the two REST routes are
	// controlled by this switch alone. Rolling back only means setting this
	// variable back to legacy.
	ItemsReadingMode ItemsReadingMode
	// ItemsIngestMode controls POST /api/items and the five write mutations.
	// Defaults to legacy. go requires JWT_SECRET, DATABASE_URL, REDIS_HOST and
	// MONGO_URI, and registers no read root.
	ItemsIngestMode ItemsIngestMode
	// RawItemOutboxMode controls the scheduled raw_item replay. Defaults to
	// legacy. go requires DATABASE_URL, REDIS_HOST and MONGO_URI but no JWT or
	// HTTP/GraphQL switch. It is independent of ItemsIngestMode.
	RawItemOutboxMode RawItemOutboxMode
	// ProcessedItemOutboxMode controls the processed_item compensation owner.
	// Defaults to legacy; go requires DATABASE_URL, REDIS_HOST and MONGO_URI
	// but no JWT or HTTP/GraphQL switch.
	ProcessedItemOutboxMode ProcessedItemOutboxMode
	// ProcessedItemOutboxTickBudgetMs bounds one Go scan tick. It must stay
	// below the five-minute period.
	ProcessedItemOutboxTickBudgetMs int
	// ProcessedItemOutboxConcurrency is the per-batch delivery worker count.
	ProcessedItemOutboxConcurrency int
	// ProcessedItemOutboxBatchSize is the scan cut of one batch.
	ProcessedItemOutboxBatchSize int
	// GraphQLItemsListMode only decides whether the items connection root
	// (items(after, filters, first, orderBy, page, rankingMode, search)) is
	// registered into the Go GraphQL executor. It defaults to legacy. The
	// accepted values are exactly "", "legacy" and "go"; an empty value behaves
	// like legacy. Go requires API_GO_GRAPHQL_READ_MODE=go and
	// API_GO_ITEMS_READING_MODE=go, because the root reuses the item reading
	// service and the shared GraphQL executor; Load fails when the dependency
	// is missing instead of silently enabling a parent switch. While this switch
	// is legacy, any document selecting items falls back to NestJS as a whole.
	// Rolling back only means setting this variable back to legacy.
	GraphQLItemsListMode string
	// GraphQLOrgAccessWriteMode only decides whether the eight organization,
	// role and membership mutations (createOrg, updateOrg, setOrgActive,
	// createRole, updateRole, assignRole, updateMembershipRoles,
	// setUserActive) are registered into the Go GraphQL executor. It is
	// independent of API_GO_GRAPHQL_READ_MODE: with the read switch legacy only
	// these mutations are taken over, and queries keep serving through NestJS.
	// The accepted values are exactly "", "legacy" and "go"; the empty value
	// behaves like legacy. While this switch is legacy, any document that
	// selects one of those mutations falls back to NestJS as a whole, so the
	// production web entry keeps serving through NestJS. Rolling back only
	// means setting this variable back to legacy.
	GraphQLOrgAccessWriteMode string
	// GraphQLWorkspaceWriteMode only decides whether the eight workspace
	// mutations (markNotificationRead, markAllNotificationsRead,
	// upsertDashboard, deleteDashboard, createAlertChannel,
	// updateAlertChannel, deleteAlertChannel, updateAlertEventStatus) are
	// registered into the Go GraphQL executor. It is independent of
	// API_GO_GRAPHQL_READ_MODE: with the read switch legacy only these
	// mutations are taken over, and queries keep serving through NestJS. The
	// accepted values are exactly "", "legacy" and "go"; the empty value
	// behaves like legacy. While this switch is legacy, any document that
	// selects one of those mutations falls back to NestJS as a whole, so the
	// production web entry keeps serving through NestJS. The takeover needs
	// JWT verification, MySQL and Redis only: it reads no Mongo collection,
	// starts no worker and requires no queue. Rolling back only means setting
	// this variable back to legacy.
	GraphQLWorkspaceWriteMode string
	// GraphQLAlertRulesMode decides whether the alert rule unit (the alertRules
	// query and the upsertAlertRule, deleteAlertRule and triggerAlertRule
	// mutations) is registered into the Go GraphQL executor. It is independent
	// of API_GO_GRAPHQL_READ_MODE on purpose: alertRules itself writes, because
	// it backfills the organization's missing default rules, schedules them and
	// enqueues one evaluation each, so the read and the three writes must move
	// as one unit. The accepted values are exactly "", "legacy" and "go"; the
	// empty value behaves like legacy. While this switch is legacy, every
	// document selecting one of those roots falls back to NestJS as a whole.
	// Go requires JWT verification, MySQL and Redis (the queue writes go
	// through the shared Redis client with the same REDIS_DB as NestJS); it
	// reads no Mongo collection, starts no worker and sends no email or
	// webhook. Rolling back only means setting this variable back to legacy.
	GraphQLAlertRulesMode string
	// GraphQLSettingsWriteMode decides whether the thirteen settings center
	// mutations (updateRateLimitSettings, updateAuthCacheSettings,
	// updateCrawlClientSettings, updateAuditLogRetention,
	// updateEntityImpactGraphSettings, updateKnowledgeGraphSettings,
	// updateNewsEventSettings, updateNewsIndicatorSettings,
	// updateNewsClassificationSettings, updateClassificationQualitySettings,
	// updateNewsDedupeSettings, updateNewsExtractionSettings,
	// updateNewsPromptConfig) are registered into the Go GraphQL executor. It
	// is independent of every read switch: with the settings/crawl read switch
	// legacy, only these mutations are taken over and the twenty read roots
	// keep serving through NestJS. The accepted values are exactly "",
	// "legacy" and "go"; the empty value behaves like legacy. While this switch
	// is legacy, any document that selects one of those mutations falls back to
	// NestJS as a whole, so the production web entry keeps serving through
	// NestJS. Rolling back only means setting this variable back to legacy.
	GraphQLSettingsWriteMode string
	// GraphQLSourcePolicyWriteMode decides whether the four source-policy
	// version mutations (updateNewsEventSourcePolicy,
	// updateNewsEventSourcePolicyPresets, rollbackNewsEventSourcePolicy,
	// resetNewsEventSourcePolicy) are registered into the Go GraphQL executor.
	// It is independent of API_GO_GRAPHQL_READ_MODE,
	// API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE,
	// API_GO_GRAPHQL_SETTINGS_WRITE_MODE and every REST switch. The accepted
	// values are exactly "", "legacy" and "go"; the empty value behaves like
	// legacy. The takeover needs JWT verification, MySQL and Redis only: it
	// reads no Mongo collection, starts no worker and calls no upstream. While
	// this switch is legacy, any document selecting one of these mutations
	// falls back to NestJS as a whole. Rolling back only means setting this
	// variable back to legacy; the stored v2 state, legacy documents, presets
	// and shared cache remain readable by NestJS.
	GraphQLSourcePolicyWriteMode string
	// GraphQLKnowledgeReviewMode decides whether the single
	// reviewKnowledgeGraphEvidence mutation is registered into the Go GraphQL
	// executor. It is independent of every read switch and of the other write
	// switches: with the knowledge-graph read switch legacy, only this mutation
	// is taken over and the eleven knowledge-graph read roots keep serving
	// through NestJS. The accepted values are exactly "", "legacy" and "go";
	// the empty value behaves like legacy. While this switch is legacy, any
	// document that selects the mutation falls back to NestJS as a whole, so
	// the production web entry keeps serving through NestJS. The takeover needs
	// JWT verification, MySQL and Redis only: it reads no Mongo collection and
	// starts no worker, so MONGO_URI is not a startup condition. Rolling back
	// only means setting this variable back to legacy.
	GraphQLKnowledgeReviewMode string
	// GraphQLRssTranslationMode only decides whether the translateRssItems
	// mutation is registered into the Go GraphQL executor. It is independent
	// of every read switch and every other write switch: an empty or legacy
	// value keeps the mutation, with its DeepLX/LLM, cache, metrics and model
	// log side effects, on NestJS. The accepted values are exactly "",
	// "legacy" and "go". Go requires JWT_SECRET, DATABASE_URL, REDIS_HOST and
	// MONGO_URI (processeditems and llmrequestlogs live in Mongo). It starts no
	// worker or Cron, writes no processed document and never probes the
	// providers at startup; the provider URLs, keys, profiles and encryption
	// key keep their request-time semantics. While this switch is legacy, any
	// document that selects translateRssItems falls back to NestJS as a whole
	// before any translation, cache write or metrics side effect. Rolling back
	// only means setting this variable back to legacy.
	GraphQLRssTranslationMode string
	// GraphQLAssistantWriteMode only decides whether the four assistant write
	// mutations (requestAssistantQuery, requestAssistantReport,
	// requestAssistantForecast, deleteAssistantRun) are registered into the Go
	// GraphQL executor. It is independent of every read switch and of the
	// worker switch: with the read switch legacy only these mutations are taken
	// over, and queries keep serving through NestJS. The accepted values are
	// exactly "", "legacy" and "go"; the empty value behaves like legacy. Go
	// needs JWT, MySQL, Redis and Mongo (assistantruns live in Mongo, the queue
	// and subscription bus in Redis) but starts no worker. Rolling back only
	// means setting this variable back to legacy.
	GraphQLAssistantWriteMode string
	// AssistantWorkerMode controls which process consumes the BullMQ assistant
	// queue. It accepts exactly "", "legacy" and "go"; the empty value behaves
	// like legacy, where NestJS AssistantProcessor owns the Worker. When it is
	// go, NestJS keeps the Queue and QueueEvents but does not create a Worker,
	// and api-go starts the worker. The two processes never consume the same
	// queue at the same time. Go needs MySQL, Redis and Mongo; it does not need
	// JWT (no HTTP route is taken over).
	AssistantWorkerMode string
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
	// SituationMonitorsMode 只控制自定义监控五条 HTTP。默认 legacy。
	// go 要求 JWT、MySQL、Redis。模型和 Nominatim 不是启动条件。
	SituationMonitorsMode SituationMonitorsMode
	// SituationSignalsMode controls the seven situation monitor signal read and
	// feedback routes (see SituationSignalsMode). Default legacy. Mode go
	// requires JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI; it starts no
	// worker and never issues a Telegram or OREF upstream request.
	SituationSignalsMode SituationSignalsMode
	// SituationInsightsMode controls GET /api/situation-monitor/insights.
	// Default legacy. Mode go requires JWT, MySQL, Redis and Mongo.
	SituationInsightsMode SituationInsightsMode
	// SituationSettingsMode controls the four situation-monitor settings routes
	// (see SituationSettingsMode). Default legacy. Mode go requires JWT, MySQL,
	// Redis, Mongo and the settings-encryption key; it starts no worker.
	SituationSettingsMode SituationSettingsMode
	// GdeltSnapshotMode 控制 GDELT 外部快照 15 分钟重建的执行权（见
	// GdeltSnapshotMode）。默认 legacy；go 要求 DATABASE_URL 与 REDIS_HOST。
	GdeltSnapshotMode GdeltSnapshotMode
	// GdeltSnapshotRefreshMode 控制强制刷新 POST 的入口执行权（见
	// GdeltSnapshotRefreshMode）。默认 legacy；go 要求 JWT、MySQL、Redis。
	// 与 GdeltSnapshotMode 相互独立。
	GdeltSnapshotRefreshMode GdeltSnapshotRefreshMode
	// RealtimeSignalsMode 控制实时信号采集 Cron 的执行权（见
	// RealtimeSignalsMode）。默认 legacy；go 要求 MySQL、Redis 与 Mongo，
	// 不需要 JWT，也不注册任何 HTTP 路由。
	RealtimeSignalsMode RealtimeSignalsMode
	// SituationMonitorGdeltEnabled 是 SITUATION_MONITOR_GDELT_ENABLED，默认
	// true。为 false 时定时重建与强制刷新都直接返回，与 isGdeltEnabled 一致。
	SituationMonitorGdeltEnabled bool
	// NewsSourcesMode 只控制新闻源管理台十五条 HTTP。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动采集 worker。
	NewsSourcesMode NewsSourcesMode
	// CrawlWorkflowsMode 只控制采集策略工作流编辑接口。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动采集 worker。
	CrawlWorkflowsMode CrawlWorkflowsMode
	// CrawlProfilesMode 只控制采集站点画像编辑接口。默认 legacy。
	// go 要求 JWT、MySQL、Redis。不要求 Mongo，也不启动采集 worker。
	CrawlProfilesMode CrawlProfilesMode
	// CrawlFrontierRunsMode controls the eleven crawl frontier run
	// monitoring and cancellation HTTP routes. It defaults to legacy. Go
	// requires JWT, MySQL and Redis, does not require Mongo, and never
	// starts a crawl worker or enqueues a job.
	CrawlFrontierRunsMode CrawlFrontierRunsMode
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
	// ExceptionIngestMode controls only the two migrated exception-report POST
	// endpoints (client JWT ingest and LiteLLM-internal ingest). Default
	// legacy. go requires JWT, MySQL, Redis and Mongo (the reports are written
	// into the existing exceptionevents collection). Shadow is never enabled
	// and no worker is started.
	ExceptionIngestMode ExceptionIngestMode
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
	// NewsnowSourcesMode controls the two public NewsNow source fetch
	// endpoints. Defaults to legacy. go requires DATABASE_URL and REDIS_HOST;
	// it needs no JWT, Mongo or queue and starts no worker.
	NewsnowSourcesMode NewsnowSourcesMode
	// NewsnowHottestMode controls GET /api/news-aggregator/hottest-analysis and
	// GET /api/news-aggregator/recommended. Defaults to legacy. go requires JWT,
	// MySQL, Redis, Mongo and the existing model gateway configuration.
	NewsnowHottestMode NewsnowHottestMode
	// NewsnowBackgroundMode controls the two NewsNow schedulers. Defaults to
	// legacy. go requires MySQL, Redis and Mongo and is read by NestJS too.
	NewsnowBackgroundMode NewsnowBackgroundMode
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
	// CrawlMetadataMode controls POST /api/crawl-tasks/metadata (see
	// CrawlMetadataMode). Default legacy. go requires JWT_SECRET, DATABASE_URL
	// and REDIS_HOST; it does not require Mongo, S3, crawl4ai or STORAGE_MODE,
	// and it starts no worker, queue or business database write.
	CrawlMetadataMode CrawlMetadataMode
	// CrawlTaskWriteMode controls the three crawl task lifecycle writes and the
	// three crawl task GraphQL mutations (see CrawlTaskWriteMode). Default
	// legacy. go requires JWT_SECRET, DATABASE_URL and REDIS_HOST; it starts no
	// worker and no scheduled job.
	CrawlTaskWriteMode CrawlTaskWriteMode
	// CrawlQueueOpsMode controls the four crawl4ai queue administration routes
	// (see CrawlQueueOpsMode). Default legacy. go requires JWT_SECRET,
	// DATABASE_URL and REDIS_HOST; it only reads queue meta/counts and writes
	// the queue control keys.
	CrawlQueueOpsMode CrawlQueueOpsMode
	// CrawlMaintenanceMode controls the four crawl maintenance crons (see
	// CrawlMaintenanceMode). Default legacy. go requires DATABASE_URL,
	// REDIS_HOST and MONGO_URI and starts no HTTP route.
	CrawlMaintenanceMode CrawlMaintenanceMode
	// AuditLogRetentionMode controls the daily audit log retention purge (see
	// AuditLogRetentionMode). Default legacy. go requires DATABASE_URL and
	// REDIS_HOST.
	AuditLogRetentionMode AuditLogRetentionMode
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
	// NewsSourcePreviewMode controls GET /api/admin/news-sources/:id/preview
	// (see NewsSourcePreviewMode). Default legacy. go requires JWT_SECRET,
	// DATABASE_URL and REDIS_HOST; crawl4ai stays optional.
	NewsSourcePreviewMode NewsSourcePreviewMode
	// CrawlWorkflowTrialMode controls the crawl-strategy trial-run and replay
	// entries (see CrawlWorkflowTrialMode). Default legacy. go requires
	// JWT_SECRET, DATABASE_URL and REDIS_HOST; crawl4ai stays optional.
	CrawlWorkflowTrialMode CrawlWorkflowTrialMode
	// NewsSourceSchedulerMode 控制新闻源 30 秒定时调度的执行权（见
	// NewsSourceSchedulerMode）。默认 legacy；go 要求 DATABASE_URL 与
	// REDIS_HOST。ScheduleEnabled 仍是总开关，false 时该循环不执行。
	NewsSourceSchedulerMode NewsSourceSchedulerMode
	// NewsSourceOpsMode 控制四条新闻源运维 POST 的执行权（见
	// NewsSourceOpsMode）。默认 legacy；go 要求 JWT、MySQL 与 Redis。
	NewsSourceOpsMode NewsSourceOpsMode
	// NewsSourceScheduler 是 NEWS_SOURCE_SCHEDULER_* 的数值与开关配置，
	// 与 NestJS EnvService.newsSourceSchedulerConfig 同名同默认值；另加
	// Go 专用的 SourceConcurrency。
	NewsSourceScheduler NewsSourceSchedulerSettings
	// SearchReindexMode controls the two search index rebuild routes (see
	// SearchReindexMode). Default legacy. go requires JWT_SECRET, DATABASE_URL,
	// REDIS_HOST and MONGO_URI; Elasticsearch stays optional at startup.
	SearchReindexMode SearchReindexMode
	// RuntimeSettingsMode controls the eighteen runtime/governance settings
	// routes (see RuntimeSettingsMode). Default legacy. Mode go requires
	// JWT_SECRET, DATABASE_URL and REDIS_HOST; it does not require Mongo and
	// does not start any worker or scheduled job.
	RuntimeSettingsMode RuntimeSettingsMode
	// PlatformGovernanceSettingsMode controls the sixteen platform governance
	// settings routes (see PlatformGovernanceSettingsMode). Default legacy.
	// Mode go requires JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI; it
	// starts no worker or scheduled job.
	PlatformGovernanceSettingsMode PlatformGovernanceSettingsMode
	// The platform governance environment defaults below mirror the NestJS zod
	// schema (apps/api/src/modules/config/env.schema.ts,
	// packages/utils/src/env.ts) exactly, including the .default() values and
	// Number() coercion. They are parsed unconditionally but only validated
	// (and therefore only able to fail startup) when
	// PlatformGovernanceSettingsMode is go, so a legacy deployment behaves
	// exactly like main even if these variables are set to garbage.
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

	// InfrastructureSettingsMode controls the seven infrastructure connection
	// and crawl-credential settings routes (see InfrastructureSettingsMode).
	// Default legacy. Mode go requires JWT_SECRET, DATABASE_URL and REDIS_HOST;
	// it does not require Mongo and does not start any worker or scheduled job.
	InfrastructureSettingsMode InfrastructureSettingsMode
	// StorageDiagnosticsMode controls the single storage connection test route
	// (see StorageDiagnosticsMode). Default legacy. Mode go requires JWT_SECRET,
	// DATABASE_URL and REDIS_HOST; it does not require Mongo, does not require
	// any other takeover switch and performs no startup probe.
	StorageDiagnosticsMode StorageDiagnosticsMode
	// DataRuntimeSettingsMode controls the nine data runtime settings and
	// archive status routes (see DataRuntimeSettingsMode). Default legacy. Mode
	// go requires JWT_SECRET, DATABASE_URL and REDIS_HOST; it does not require
	// Mongo and does not start any worker or scheduled job.
	DataRuntimeSettingsMode DataRuntimeSettingsMode
	// DataRuntimeSettings holds the environment defaults of that unit. It is
	// independent of the RealtimeSignals*/Nominatim* fields below.
	DataRuntimeSettings DataRuntimeSettingsEnv
	// EmailSettingsMode controls the three email settings routes (see
	// EmailSettingsMode). Default legacy. Mode go requires JWT_SECRET,
	// DATABASE_URL, REDIS_HOST and the SMTP_* transport; it does not require
	// Mongo and starts no worker.
	EmailSettingsMode EmailSettingsMode
	// GeocodingMode controls the two geocoding routes (see GeocodingMode).
	// Default legacy. Mode go requires JWT_SECRET, DATABASE_URL and REDIS_HOST;
	// it does not require Mongo and performs no startup network probe.
	GeocodingMode GeocodingMode
	// RuntimeDiagnosticsMode controls the assistant safety and realtime signal
	// diagnostics (see RuntimeDiagnosticsMode). Default legacy. Mode go requires
	// JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI; it starts no worker and
	// performs no startup network probe.
	RuntimeDiagnosticsMode RuntimeDiagnosticsMode
	// AuthFactorsMode controls the seven authenticated MFA management and
	// organization OIDC configuration routes (see AuthFactorsMode). Default
	// legacy. Mode go requires JWT_SECRET, DATABASE_URL and REDIS_HOST; it does
	// not require Mongo and does not start any worker or scheduled job.
	AuthFactorsMode AuthFactorsMode
	// AccountSecurityMode controls the eight authenticated account, session and
	// machine-token routes (see AccountSecurityMode). Default legacy. Mode go
	// requires JWT_SECRET, DATABASE_URL and REDIS_HOST; it does not require
	// Mongo and does not start any worker or scheduled job.
	AccountSecurityMode AccountSecurityMode
	// AvatarUploadMode controls POST /api/auth/avatar/presigned-url (see
	// AvatarUploadMode). Default legacy. Mode go requires JWT_SECRET,
	// DATABASE_URL and REDIS_HOST; it does not require Mongo and never
	// contacts S3 at startup.
	AvatarUploadMode AvatarUploadMode
	// UserDataExportMode controls GET /api/auth/data-export (see
	// UserDataExportMode). Default legacy. Mode go requires JWT_SECRET,
	// DATABASE_URL, REDIS_HOST and MONGO_URI.
	UserDataExportMode UserDataExportMode
	// AuthLoginMode controls the eleven POST /api/auth login, session, email-code
	// and password-recovery routes (see AuthLoginMode). Default legacy. Mode go
	// requires JWT_SECRET, DATABASE_URL, REDIS_HOST and the SMTP_* transport; it
	// does not require Mongo and does not start any worker or scheduled job.
	AuthLoginMode AuthLoginMode
	// OIDCLoginMode controls the three public organization SSO login entries
	// (see OIDCLoginMode). Default legacy. Mode go requires JWT_SECRET,
	// DATABASE_URL and REDIS_HOST; API_BASE_URL is validated per request.
	OIDCLoginMode OIDCLoginMode
	// APIBaseURL is the untrimmed API_BASE_URL used only to build the IdP
	// redirect_uri. It stays optional at startup: the source answers a missing
	// value with the request-time 400 "API_BASE_URL is required for OIDC".
	APIBaseURL string
	// IdentityOnboardingMode controls the fourteen registration, invitation and
	// registration-application routes (see IdentityOnboardingMode). Default
	// legacy. Mode go requires JWT_SECRET, DATABASE_URL, REDIS_HOST and the
	// SMTP_* transport; it does not require Mongo and does not start any worker
	// or scheduled job.
	IdentityOnboardingMode IdentityOnboardingMode
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
	// validated when AuthLoginMode or IdentityOnboardingMode is go.
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

	// The economic-data request and worker switches are independent. The
	// request switch only registers the three mutations and admin HTTP routes;
	// the worker switch owns catalog/repeat synchronization and the queue
	// consumer. Both default to legacy.
	EconomicDataMode           EconomicDataMode
	EconomicDataWorkerMode     EconomicDataWorkerMode
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
	// 30 / 120 / 60) and are consumed by API_GO_EXCEPTION_INGEST_MODE=go.
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

	// LLMGatewayProfilesMode 控制 LLM 网关 profile 的七条配置/激活路由。默认
	// legacy；go 复用 appendAuthRequirements，不要求 Mongo 或真实模型上游。
	LLMGatewayProfilesMode LLMGatewayProfilesMode
	// LLMGatewayOpsMode 控制 LLM 网关治理与真实探测的十二条路由。默认 legacy；
	// go 复用 appendAuthRequirements 并额外要求 MONGO_URI（每次真实探测都写
	// llmrequestlogs）。LITELLM_MASTER_KEY 与
	// SYSTEM_SETTINGS_ENCRYPTION_KEY 是请求时语义，不是启动前置。
	LLMGatewayOpsMode LLMGatewayOpsMode
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
	// JWT_SECRET/JWT_ISSUER/JWT_AUDIENCE）。OnboardingMode=go 时
	// JWTSecret 必填；issuer/audience 默认值与 NestJS env schema 一致。
	// Secret 不进入日志/healthz/错误文本。
	JWTSecret   string
	JWTIssuer   string
	JWTAudience string
	// JWTAccessExpiresIn / JWTRefreshExpiresIn keep the raw timespan text
	// (defaults 15m / 7d). AuthLoginMode=go parses them per signing call, exactly
	// like the NestJS EnvService jwtConfig getter, so a malformed value surfaces
	// as the same request-time 400.
	JWTAccessExpiresIn  string
	JWTRefreshExpiresIn string

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

	// ModelAccessSettingsMode controls the ten model access settings routes (see
	// ModelAccessSettingsMode). Default legacy. Mode go requires JWT_SECRET,
	// DATABASE_URL and REDIS_HOST; it does not require Mongo and starts no worker
	// or scheduled job. LITELLM_CONFIG_INTERNAL_TOKEN and
	// SYSTEM_SETTINGS_ENCRYPTION_KEY keep their runtime semantics and are never
	// startup requirements.
	ModelAccessSettingsMode ModelAccessSettingsMode
	// ProxyLoadBalancingMode controls the four LiteLLM proxy load balancing
	// routes (see ProxyLoadBalancingMode). Default legacy. Mode go requires
	// JWT_SECRET, DATABASE_URL and REDIS_HOST; it does not require Mongo and
	// starts no worker or scheduled job. It is independent of
	// ModelAccessSettingsMode: the Go service reuses the existing OpenAI key
	// reader without turning the model access takeover on.
	ProxyLoadBalancingMode ProxyLoadBalancingMode
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
	// API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE. Default legacy; see the mode
	// type for the route and requirements.
	NewsClusteringLlmBackfillMode NewsClusteringLlmBackfillMode
	// API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE. Default legacy; see the mode
	// type for the consumer, its scan and the R1 recovery rule.
	NewsClusteringRecoveryWorkerMode NewsClusteringRecoveryWorkerMode
	// API_GO_ARCHIVE_PREPARATION_WORKER_MODE. Default legacy; see the mode type
	// for the consumer and its required connections.
	ArchivePreparationWorkerMode ArchivePreparationWorkerMode
	// API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE. Default legacy. go registers
	// the refreshNewsIndicatorAssociations mutation; it requires JWT_SECRET,
	// DATABASE_URL and REDIS_HOST. It is a string like the other GraphQL write
	// switches.
	GraphQLNewsIndicatorRefreshMode string
	// API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE. Default legacy; see the mode
	// type for the six-hour refresh.
	NewsIndicatorAssociationCronMode NewsIndicatorAssociationCronMode
	// ClassificationReportsMode controls the report creation POST; the worker
	// mode controls queue consumption; the pipeline recovery mode controls the
	// runs read. All three default to legacy and are independent.
	ClassificationReportsMode       ClassificationReportsMode
	ClassificationQualityWorkerMode ClassificationQualityWorkerMode
	PipelineRecoveryMode            PipelineRecoveryMode
	// The five residual-duty switches. All default to legacy, accept only "",
	// "legacy" and "go", and fail startup on any other value.
	BullmqCleanupMode            BullmqCleanupMode
	ClassificationReviewSeedMode ClassificationReviewSeedMode
	PipelineRecoveryWriteMode    PipelineRecoveryWriteMode
	MetricsMode                  MetricsMode
	StartupReconcileMode         StartupReconcileMode
	// NewsProcessQueueConcurrency mirrors NEWS_PROCESS_QUEUE_CONCURRENCY
	// (default 8). The clustering recovery worker uses max(1, min(2, value));
	// the quality worker uses max(1, min(4, value)).
	NewsProcessQueueConcurrency int
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

	// SCHEDULE_ENABLED is the cross-process scheduling stop switch. The exact
	// comparison matches the NestJS `!== "false"` check character for
	// character, so both processes agree on the value.
	cfg.ScheduleEnabled = getenv("SCHEDULE_ENABLED") != "false"

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
	switch strings.TrimSpace(getenv("API_GO_USER_DIGEST_DELIVERY_MODE")) {
	case "", string(UserDigestDeliveryModeLegacy):
		cfg.UserDigestDeliveryMode = UserDigestDeliveryModeLegacy
	case string(UserDigestDeliveryModeGo):
		cfg.UserDigestDeliveryMode = UserDigestDeliveryModeGo
	default:
		errs = append(errs, "API_GO_USER_DIGEST_DELIVERY_MODE must be one of legacy|go")
	}
	// The audit-log outbox replay owner. Empty behaves like legacy; an invalid
	// value fails startup instead of being silently downgraded.
	switch strings.TrimSpace(getenv("API_GO_AUDIT_OUTBOX_MODE")) {
	case "", string(AuditOutboxModeLegacy):
		cfg.AuditOutboxMode = AuditOutboxModeLegacy
	case string(AuditOutboxModeGo):
		cfg.AuditOutboxMode = AuditOutboxModeGo
	default:
		errs = append(errs, "API_GO_AUDIT_OUTBOX_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE")) {
	case "", string(KnowledgeGraphIngestionModeLegacy):
		cfg.KnowledgeGraphIngestionMode = KnowledgeGraphIngestionModeLegacy
	case string(KnowledgeGraphIngestionModeGo):
		cfg.KnowledgeGraphIngestionMode = KnowledgeGraphIngestionModeGo
	default:
		errs = append(errs, "API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWS_EVENTS_INGESTION_MODE")) {
	case "", string(NewsEventsIngestionModeLegacy):
		cfg.NewsEventsIngestionMode = NewsEventsIngestionModeLegacy
	case string(NewsEventsIngestionModeGo):
		cfg.NewsEventsIngestionMode = NewsEventsIngestionModeGo
	default:
		errs = append(errs, "API_GO_NEWS_EVENTS_INGESTION_MODE must be one of legacy|go")
	}
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
	switch strings.TrimSpace(getenv("API_GO_ALERT_WORKER_MODE")) {
	case "", string(AlertWorkerModeLegacy):
		cfg.AlertWorkerMode = AlertWorkerModeLegacy
	case string(AlertWorkerModeGo):
		cfg.AlertWorkerMode = AlertWorkerModeGo
	default:
		errs = append(errs, "API_GO_ALERT_WORKER_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE")) {
	case "", string(CrawlFrontierLlmWorkerModeLegacy):
		cfg.CrawlFrontierLlmWorkerMode = CrawlFrontierLlmWorkerModeLegacy
	case string(CrawlFrontierLlmWorkerModeGo):
		cfg.CrawlFrontierLlmWorkerMode = CrawlFrontierLlmWorkerModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE must be one of legacy|go")
	}
	errs = append(errs, loadAlertingConfig(getenv, &cfg)...)
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
	// The CSV export switch accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy, so an unset deployment keeps both
	// export POST routes on NestJS. The failure names the variable and echoes
	// the rejected value so an operator can see which deployment value was
	// refused.
	analysisExportRaw := strings.TrimSpace(getenv("API_GO_ANALYSIS_EXPORT_MODE"))
	switch analysisExportRaw {
	case "", string(AnalysisExportModeLegacy):
		cfg.AnalysisExportMode = AnalysisExportModeLegacy
	case string(AnalysisExportModeGo):
		cfg.AnalysisExportMode = AnalysisExportModeGo
	default:
		errs = append(errs, "API_GO_ANALYSIS_EXPORT_MODE must be one of legacy|go, got "+strconv.Quote(analysisExportRaw))
	}
	switch archiveReadingRaw := strings.TrimSpace(getenv("API_GO_ARCHIVE_READING_MODE")); archiveReadingRaw {
	case "", string(ArchiveReadingModeLegacy):
		cfg.ArchiveReadingMode = ArchiveReadingModeLegacy
	case string(ArchiveReadingModeGo):
		cfg.ArchiveReadingMode = ArchiveReadingModeGo
	default:
		errs = append(errs, "API_GO_ARCHIVE_READING_MODE must be one of legacy|go, got "+strconv.Quote(archiveReadingRaw))
	}
	analysisRunsRaw := strings.TrimSpace(getenv("API_GO_ANALYSIS_RUNS_MODE"))
	switch analysisRunsRaw {
	case "", string(AnalysisRunsModeLegacy):
		cfg.AnalysisRunsMode = AnalysisRunsModeLegacy
	case string(AnalysisRunsModeGo):
		cfg.AnalysisRunsMode = AnalysisRunsModeGo
	default:
		errs = append(errs, "API_GO_ANALYSIS_RUNS_MODE must be one of legacy|go, got "+strconv.Quote(analysisRunsRaw))
	}
	analysisWorkerRaw := strings.TrimSpace(getenv("API_GO_ANALYSIS_WORKER_MODE"))
	switch analysisWorkerRaw {
	case "", string(AnalysisWorkerModeLegacy):
		cfg.AnalysisWorkerMode = AnalysisWorkerModeLegacy
	case string(AnalysisWorkerModeGo):
		cfg.AnalysisWorkerMode = AnalysisWorkerModeGo
	default:
		errs = append(errs, "API_GO_ANALYSIS_WORKER_MODE must be one of legacy|go, got "+strconv.Quote(analysisWorkerRaw))
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
	switch strings.TrimSpace(getenv("API_GO_NEWS_SOURCE_SCHEDULER_MODE")) {
	case "", string(NewsSourceSchedulerModeLegacy):
		cfg.NewsSourceSchedulerMode = NewsSourceSchedulerModeLegacy
	case string(NewsSourceSchedulerModeGo):
		cfg.NewsSourceSchedulerMode = NewsSourceSchedulerModeGo
	default:
		errs = append(errs, "API_GO_NEWS_SOURCE_SCHEDULER_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWS_SOURCE_OPS_MODE")) {
	case "", string(NewsSourceOpsModeLegacy):
		cfg.NewsSourceOpsMode = NewsSourceOpsModeLegacy
	case string(NewsSourceOpsModeGo):
		cfg.NewsSourceOpsMode = NewsSourceOpsModeGo
	default:
		errs = append(errs, "API_GO_NEWS_SOURCE_OPS_MODE must be one of legacy|go")
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
	switch strings.TrimSpace(getenv("API_GO_CRAWL_FRONTIER_RUNS_MODE")) {
	case "", string(CrawlFrontierRunsModeLegacy):
		cfg.CrawlFrontierRunsMode = CrawlFrontierRunsModeLegacy
	case string(CrawlFrontierRunsModeGo):
		cfg.CrawlFrontierRunsMode = CrawlFrontierRunsModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_FRONTIER_RUNS_MODE must be one of legacy|go")
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
	switch strings.TrimSpace(getenv("API_GO_EXCEPTION_INGEST_MODE")) {
	case "", string(ExceptionIngestModeLegacy):
		cfg.ExceptionIngestMode = ExceptionIngestModeLegacy
	case string(ExceptionIngestModeGo):
		cfg.ExceptionIngestMode = ExceptionIngestModeGo
	default:
		errs = append(errs, "API_GO_EXCEPTION_INGEST_MODE must be one of legacy|go")
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

	switch strings.TrimSpace(getenv("API_GO_CLASSIFICATION_REPORTS_MODE")) {
	case "", string(ClassificationReportsModeLegacy):
		cfg.ClassificationReportsMode = ClassificationReportsModeLegacy
	case string(ClassificationReportsModeGo):
		cfg.ClassificationReportsMode = ClassificationReportsModeGo
	default:
		errs = append(errs, "API_GO_CLASSIFICATION_REPORTS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CLASSIFICATION_QUALITY_WORKER_MODE")) {
	case "", string(ClassificationQualityWorkerModeLegacy):
		cfg.ClassificationQualityWorkerMode = ClassificationQualityWorkerModeLegacy
	case string(ClassificationQualityWorkerModeGo):
		cfg.ClassificationQualityWorkerMode = ClassificationQualityWorkerModeGo
	default:
		errs = append(errs, "API_GO_CLASSIFICATION_QUALITY_WORKER_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_PIPELINE_RECOVERY_MODE")) {
	case "", string(PipelineRecoveryModeLegacy):
		cfg.PipelineRecoveryMode = PipelineRecoveryModeLegacy
	case string(PipelineRecoveryModeGo):
		cfg.PipelineRecoveryMode = PipelineRecoveryModeGo
	default:
		errs = append(errs, "API_GO_PIPELINE_RECOVERY_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_BULLMQ_CLEANUP_MODE")) {
	case "", string(BullmqCleanupModeLegacy):
		cfg.BullmqCleanupMode = BullmqCleanupModeLegacy
	case string(BullmqCleanupModeGo):
		cfg.BullmqCleanupMode = BullmqCleanupModeGo
	default:
		errs = append(errs, "API_GO_BULLMQ_CLEANUP_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CLASSIFICATION_REVIEW_SEED_MODE")) {
	case "", string(ClassificationReviewSeedModeLegacy):
		cfg.ClassificationReviewSeedMode = ClassificationReviewSeedModeLegacy
	case string(ClassificationReviewSeedModeGo):
		cfg.ClassificationReviewSeedMode = ClassificationReviewSeedModeGo
	default:
		errs = append(errs, "API_GO_CLASSIFICATION_REVIEW_SEED_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_PIPELINE_RECOVERY_WRITE_MODE")) {
	case "", string(PipelineRecoveryWriteModeLegacy):
		cfg.PipelineRecoveryWriteMode = PipelineRecoveryWriteModeLegacy
	case string(PipelineRecoveryWriteModeGo):
		cfg.PipelineRecoveryWriteMode = PipelineRecoveryWriteModeGo
	default:
		errs = append(errs, "API_GO_PIPELINE_RECOVERY_WRITE_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_METRICS_MODE")) {
	case "", string(MetricsModeLegacy):
		cfg.MetricsMode = MetricsModeLegacy
	case string(MetricsModeGo):
		cfg.MetricsMode = MetricsModeGo
	default:
		errs = append(errs, "API_GO_METRICS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_STARTUP_RECONCILE_MODE")) {
	case "", string(StartupReconcileModeLegacy):
		cfg.StartupReconcileMode = StartupReconcileModeLegacy
	case string(StartupReconcileModeGo):
		cfg.StartupReconcileMode = StartupReconcileModeGo
	default:
		errs = append(errs, "API_GO_STARTUP_RECONCILE_MODE must be one of legacy|go")
	}
	if raw := strings.TrimSpace(getenv("NEWS_PROCESS_QUEUE_CONCURRENCY")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			errs = append(errs, fmt.Sprintf("NEWS_PROCESS_QUEUE_CONCURRENCY must be a positive integer, got %q", raw))
		} else {
			cfg.NewsProcessQueueConcurrency = value
		}
	}
	switch strings.TrimSpace(getenv("API_GO_NEWSNOW_CLUSTERING_OPS_MODE")) {
	case "", string(NewsnowClusteringOpsModeLegacy):
		cfg.NewsnowClusteringOpsMode = NewsnowClusteringOpsModeLegacy
	case string(NewsnowClusteringOpsModeGo):
		cfg.NewsnowClusteringOpsMode = NewsnowClusteringOpsModeGo
	default:
		errs = append(errs, "API_GO_NEWSNOW_CLUSTERING_OPS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWSNOW_HOTTEST_MODE")) {
	case "", string(NewsnowHottestModeLegacy):
		cfg.NewsnowHottestMode = NewsnowHottestModeLegacy
	case string(NewsnowHottestModeGo):
		cfg.NewsnowHottestMode = NewsnowHottestModeGo
	default:
		errs = append(errs, "API_GO_NEWSNOW_HOTTEST_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWSNOW_BACKGROUND_MODE")) {
	case "", string(NewsnowBackgroundModeLegacy):
		cfg.NewsnowBackgroundMode = NewsnowBackgroundModeLegacy
	case string(NewsnowBackgroundModeGo):
		cfg.NewsnowBackgroundMode = NewsnowBackgroundModeGo
	default:
		errs = append(errs, "API_GO_NEWSNOW_BACKGROUND_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWSNOW_SOURCES_MODE")) {
	case "", string(NewsnowSourcesModeLegacy):
		cfg.NewsnowSourcesMode = NewsnowSourcesModeLegacy
	case string(NewsnowSourcesModeGo):
		cfg.NewsnowSourcesMode = NewsnowSourcesModeGo
	default:
		errs = append(errs, "API_GO_NEWSNOW_SOURCES_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_READ_TELEMETRY_MODE")) {
	case "", string(CrawlReadTelemetryModeLegacy):
		cfg.CrawlReadTelemetryMode = CrawlReadTelemetryModeLegacy
	case string(CrawlReadTelemetryModeGo):
		cfg.CrawlReadTelemetryMode = CrawlReadTelemetryModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_READ_TELEMETRY_MODE must be one of legacy|go")
	}
	// The metadata preview switch accepts exactly "", "legacy" and "go"; any
	// other value must fail startup with this exact text.
	switch strings.TrimSpace(getenv("API_GO_CRAWL_METADATA_MODE")) {
	case "", string(CrawlMetadataModeLegacy):
		cfg.CrawlMetadataMode = CrawlMetadataModeLegacy
	case string(CrawlMetadataModeGo):
		cfg.CrawlMetadataMode = CrawlMetadataModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_METADATA_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_TASK_WRITE_MODE")) {
	case "", string(CrawlTaskWriteModeLegacy):
		cfg.CrawlTaskWriteMode = CrawlTaskWriteModeLegacy
	case string(CrawlTaskWriteModeGo):
		cfg.CrawlTaskWriteMode = CrawlTaskWriteModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_TASK_WRITE_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_CRAWL_QUEUE_OPS_MODE")) {
	case "", string(CrawlQueueOpsModeLegacy):
		cfg.CrawlQueueOpsMode = CrawlQueueOpsModeLegacy
	case string(CrawlQueueOpsModeGo):
		cfg.CrawlQueueOpsMode = CrawlQueueOpsModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_QUEUE_OPS_MODE must be one of legacy|go")
	}
	// The four crawl maintenance crons and the audit retention purge are two
	// independent ownership switches. They accept the empty string, legacy and
	// go; an empty value behaves exactly like legacy.
	switch strings.TrimSpace(getenv("API_GO_CRAWL_MAINTENANCE_MODE")) {
	case "", string(CrawlMaintenanceModeLegacy):
		cfg.CrawlMaintenanceMode = CrawlMaintenanceModeLegacy
	case string(CrawlMaintenanceModeGo):
		cfg.CrawlMaintenanceMode = CrawlMaintenanceModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_MAINTENANCE_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_AUDIT_LOG_RETENTION_MODE")) {
	case "", string(AuditLogRetentionModeLegacy):
		cfg.AuditLogRetentionMode = AuditLogRetentionModeLegacy
	case string(AuditLogRetentionModeGo):
		cfg.AuditLogRetentionMode = AuditLogRetentionModeGo
	default:
		errs = append(errs, "API_GO_AUDIT_LOG_RETENTION_MODE must be one of legacy|go")
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
	// The news-source preview switch accepts exactly "", "legacy" and "go"; any
	// other value must fail startup with this exact text.
	switch strings.TrimSpace(getenv("API_GO_NEWS_SOURCE_PREVIEW_MODE")) {
	case "", string(NewsSourcePreviewModeLegacy):
		cfg.NewsSourcePreviewMode = NewsSourcePreviewModeLegacy
	case string(NewsSourcePreviewModeGo):
		cfg.NewsSourcePreviewMode = NewsSourcePreviewModeGo
	default:
		errs = append(errs, "API_GO_NEWS_SOURCE_PREVIEW_MODE must be one of legacy|go")
	}
	// The crawl-strategy trial/replay switch accepts exactly "", "legacy" and
	// "go"; any other value must fail startup with this exact text.
	switch strings.TrimSpace(getenv("API_GO_CRAWL_WORKFLOW_TRIAL_MODE")) {
	case "", string(CrawlWorkflowTrialModeLegacy):
		cfg.CrawlWorkflowTrialMode = CrawlWorkflowTrialModeLegacy
	case string(CrawlWorkflowTrialModeGo):
		cfg.CrawlWorkflowTrialMode = CrawlWorkflowTrialModeGo
	default:
		errs = append(errs, "API_GO_CRAWL_WORKFLOW_TRIAL_MODE must be one of legacy|go")
	}
	// The search reindex switch accepts exactly "", "legacy" and "go"; any other
	// value must fail startup with this exact text.
	switch strings.TrimSpace(getenv("API_GO_SEARCH_REINDEX_MODE")) {
	case "", string(SearchReindexModeLegacy):
		cfg.SearchReindexMode = SearchReindexModeLegacy
	case string(SearchReindexModeGo):
		cfg.SearchReindexMode = SearchReindexModeGo
	default:
		errs = append(errs, "API_GO_SEARCH_REINDEX_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_RUNTIME_SETTINGS_MODE")) {
	case "", string(RuntimeSettingsModeLegacy):
		cfg.RuntimeSettingsMode = RuntimeSettingsModeLegacy
	case string(RuntimeSettingsModeGo):
		cfg.RuntimeSettingsMode = RuntimeSettingsModeGo
	default:
		errs = append(errs, "API_GO_RUNTIME_SETTINGS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_DATA_RUNTIME_SETTINGS_MODE")) {
	case "", string(DataRuntimeSettingsModeLegacy):
		cfg.DataRuntimeSettingsMode = DataRuntimeSettingsModeLegacy
	case string(DataRuntimeSettingsModeGo):
		cfg.DataRuntimeSettingsMode = DataRuntimeSettingsModeGo
	default:
		errs = append(errs, "API_GO_DATA_RUNTIME_SETTINGS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_EMAIL_SETTINGS_MODE")) {
	case "", string(EmailSettingsModeLegacy):
		cfg.EmailSettingsMode = EmailSettingsModeLegacy
	case string(EmailSettingsModeGo):
		cfg.EmailSettingsMode = EmailSettingsModeGo
	default:
		errs = append(errs, "API_GO_EMAIL_SETTINGS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_GEOCODING_MODE")) {
	case "", string(GeocodingModeLegacy):
		cfg.GeocodingMode = GeocodingModeLegacy
	case string(GeocodingModeGo):
		cfg.GeocodingMode = GeocodingModeGo
	default:
		errs = append(errs, "API_GO_GEOCODING_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_RUNTIME_DIAGNOSTICS_MODE")) {
	case "", string(RuntimeDiagnosticsModeLegacy):
		cfg.RuntimeDiagnosticsMode = RuntimeDiagnosticsModeLegacy
	case string(RuntimeDiagnosticsModeGo):
		cfg.RuntimeDiagnosticsMode = RuntimeDiagnosticsModeGo
	default:
		errs = append(errs, "API_GO_RUNTIME_DIAGNOSTICS_MODE must be one of legacy|go")
	}
	// The platform governance switch accepts exactly "", "legacy" and "go"; any
	// other value must fail startup with this exact text.
	switch strings.TrimSpace(getenv("API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE")) {
	case "", string(PlatformGovernanceSettingsModeLegacy):
		cfg.PlatformGovernanceSettingsMode = PlatformGovernanceSettingsModeLegacy
	case string(PlatformGovernanceSettingsModeGo):
		cfg.PlatformGovernanceSettingsMode = PlatformGovernanceSettingsModeGo
	default:
		errs = append(errs, "API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE must be one of legacy|go")
	}
	// The seven environment defaults the sixteen platform governance settings
	// routes expose. They are parsed unconditionally so that a legacy
	// deployment is untouched, but their parse failures are only promoted to
	// startup errors when the switch is go (see validate()).
	governanceErrs := parsePlatformGovernanceDefaults(&cfg, getenv)
	if cfg.PlatformGovernanceSettingsMode == PlatformGovernanceSettingsModeGo {
		errs = append(errs, governanceErrs...)
	}
	// Model access settings accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy so an unset deployment keeps the NestJS
	// path.
	switch strings.TrimSpace(getenv("API_GO_MODEL_ACCESS_SETTINGS_MODE")) {
	case "", string(ModelAccessSettingsModeLegacy):
		cfg.ModelAccessSettingsMode = ModelAccessSettingsModeLegacy
	case string(ModelAccessSettingsModeGo):
		cfg.ModelAccessSettingsMode = ModelAccessSettingsModeGo
	default:
		errs = append(errs, "API_GO_MODEL_ACCESS_SETTINGS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_LLM_GATEWAY_PROFILES_MODE")) {
	case "", string(LLMGatewayProfilesModeLegacy):
		cfg.LLMGatewayProfilesMode = LLMGatewayProfilesModeLegacy
	case string(LLMGatewayProfilesModeGo):
		cfg.LLMGatewayProfilesMode = LLMGatewayProfilesModeGo
	default:
		errs = append(errs, "API_GO_LLM_GATEWAY_PROFILES_MODE must be one of legacy|go")
	}
	// The governance/diagnostics switch is parsed independently of the profile
	// switch: either one can be go on its own. The empty value behaves exactly
	// like legacy.
	switch strings.TrimSpace(getenv("API_GO_LLM_GATEWAY_OPS_MODE")) {
	case "", string(LLMGatewayOpsModeLegacy):
		cfg.LLMGatewayOpsMode = LLMGatewayOpsModeLegacy
	case string(LLMGatewayOpsModeGo):
		cfg.LLMGatewayOpsMode = LLMGatewayOpsModeGo
	default:
		errs = append(errs, "API_GO_LLM_GATEWAY_OPS_MODE must be one of legacy|go")
	}
	// Proxy load balancing accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy so an unset deployment keeps the NestJS
	// path. It is parsed independently of the model access switch.
	switch strings.TrimSpace(getenv("API_GO_PROXY_LOAD_BALANCING_MODE")) {
	case "", string(ProxyLoadBalancingModeLegacy):
		cfg.ProxyLoadBalancingMode = ProxyLoadBalancingModeLegacy
	case string(ProxyLoadBalancingModeGo):
		cfg.ProxyLoadBalancingMode = ProxyLoadBalancingModeGo
	default:
		errs = append(errs, "API_GO_PROXY_LOAD_BALANCING_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_INFRASTRUCTURE_SETTINGS_MODE")) {
	case "", string(InfrastructureSettingsModeLegacy):
		cfg.InfrastructureSettingsMode = InfrastructureSettingsModeLegacy
	case string(InfrastructureSettingsModeGo):
		cfg.InfrastructureSettingsMode = InfrastructureSettingsModeGo
	default:
		errs = append(errs, "API_GO_INFRASTRUCTURE_SETTINGS_MODE must be one of legacy|go")
	}
	// The storage connection test switch is parsed independently of the
	// infrastructure settings switch: the diagnostics route can be taken over
	// while the seven configuration routes stay on NestJS, and the other way
	// around. An empty value behaves exactly like legacy.
	switch strings.TrimSpace(getenv("API_GO_STORAGE_DIAGNOSTICS_MODE")) {
	case "", string(StorageDiagnosticsModeLegacy):
		cfg.StorageDiagnosticsMode = StorageDiagnosticsModeLegacy
	case string(StorageDiagnosticsModeGo):
		cfg.StorageDiagnosticsMode = StorageDiagnosticsModeGo
	default:
		errs = append(errs, "API_GO_STORAGE_DIAGNOSTICS_MODE must be one of legacy|go")
	}
	// The authenticated MFA management and organization OIDC configuration
	// switch accepts the empty string, legacy and go. An empty value behaves
	// exactly like legacy, so an unset deployment keeps serving all seven
	// routes through NestJS.
	switch strings.TrimSpace(getenv("API_GO_AUTH_FACTORS_MODE")) {
	case "", string(AuthFactorsModeLegacy):
		cfg.AuthFactorsMode = AuthFactorsModeLegacy
	case string(AuthFactorsModeGo):
		cfg.AuthFactorsMode = AuthFactorsModeGo
	default:
		errs = append(errs, "API_GO_AUTH_FACTORS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_ACCOUNT_SECURITY_MODE")) {
	case "", string(AccountSecurityModeLegacy):
		cfg.AccountSecurityMode = AccountSecurityModeLegacy
	case string(AccountSecurityModeGo):
		cfg.AccountSecurityMode = AccountSecurityModeGo
	default:
		errs = append(errs, "API_GO_ACCOUNT_SECURITY_MODE must be one of legacy|go")
	}
	// The two remaining identity entries have independent switches. Each
	// accepts the empty string, legacy and go; an empty value keeps the route
	// on NestJS.
	switch strings.TrimSpace(getenv("API_GO_AVATAR_UPLOAD_MODE")) {
	case "", string(AvatarUploadModeLegacy):
		cfg.AvatarUploadMode = AvatarUploadModeLegacy
	case string(AvatarUploadModeGo):
		cfg.AvatarUploadMode = AvatarUploadModeGo
	default:
		errs = append(errs, "API_GO_AVATAR_UPLOAD_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_USER_DATA_EXPORT_MODE")) {
	case "", string(UserDataExportModeLegacy):
		cfg.UserDataExportMode = UserDataExportModeLegacy
	case string(UserDataExportModeGo):
		cfg.UserDataExportMode = UserDataExportModeGo
	default:
		errs = append(errs, "API_GO_USER_DATA_EXPORT_MODE must be one of legacy|go")
	}
	// The login/session/email-code switch accepts the empty string, legacy and
	// go. An empty value behaves exactly like legacy, so an unset deployment
	// keeps serving all eleven routes through NestJS.
	switch strings.TrimSpace(getenv("API_GO_AUTH_LOGIN_MODE")) {
	case "", string(AuthLoginModeLegacy):
		cfg.AuthLoginMode = AuthLoginModeLegacy
	case string(AuthLoginModeGo):
		cfg.AuthLoginMode = AuthLoginModeGo
	default:
		errs = append(errs, "API_GO_AUTH_LOGIN_MODE must be one of legacy|go")
	}
	// The OIDC login switch accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy, so an unset deployment keeps all three
	// SSO routes on NestJS.
	switch strings.TrimSpace(getenv("API_GO_OIDC_LOGIN_MODE")) {
	case "", string(OIDCLoginModeLegacy):
		cfg.OIDCLoginMode = OIDCLoginModeLegacy
	case string(OIDCLoginModeGo):
		cfg.OIDCLoginMode = OIDCLoginModeGo
	default:
		errs = append(errs, "API_GO_OIDC_LOGIN_MODE must be one of legacy|go")
	}
	// The registration/invitation switch accepts the empty string, legacy and
	// go. An empty value behaves exactly like legacy, so an unset deployment
	// keeps serving all fourteen routes through NestJS.
	switch strings.TrimSpace(getenv("API_GO_IDENTITY_ONBOARDING_MODE")) {
	case "", string(IdentityOnboardingModeLegacy):
		cfg.IdentityOnboardingMode = IdentityOnboardingModeLegacy
	case string(IdentityOnboardingModeGo):
		cfg.IdentityOnboardingMode = IdentityOnboardingModeGo
	default:
		errs = append(errs, "API_GO_IDENTITY_ONBOARDING_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_READ_MODE")) {
	case "", "legacy":
		cfg.GraphQLReadMode = "legacy"
	case "go":
		cfg.GraphQLReadMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_READ_MODE must be one of legacy|go")
	}
	// The realtime subscription transport is an independent switch. An empty
	// value behaves like legacy so an unset deployment keeps upgrade requests
	// on the legacy proxy.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_SUBSCRIPTIONS_MODE")) {
	case "", string(GraphQLSubscriptionsModeLegacy):
		cfg.GraphQLSubscriptionsMode = GraphQLSubscriptionsModeLegacy
	case string(GraphQLSubscriptionsModeGo):
		cfg.GraphQLSubscriptionsMode = GraphQLSubscriptionsModeGo
	default:
		errs = append(errs, "API_GO_GRAPHQL_SUBSCRIPTIONS_MODE must be one of legacy|go")
	}
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
	if cfg.GraphQLSubscriptionsMode == GraphQLSubscriptionsModeGo && cfg.GraphQLSubscriptionBus != "redis" {
		errs = append(errs, "API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go requires GRAPHQL_SUBSCRIPTION_BUS=redis")
	}
	// The notifications Socket.IO transport is independent of the GraphQL WS
	// executor: it has its own path, namespace and Redis relay. An empty value
	// behaves like legacy.
	switch strings.TrimSpace(getenv("API_GO_NOTIFICATIONS_SOCKET_MODE")) {
	case "", string(NotificationsSocketModeLegacy):
		cfg.NotificationsSocketMode = NotificationsSocketModeLegacy
	case string(NotificationsSocketModeGo):
		cfg.NotificationsSocketMode = NotificationsSocketModeGo
	default:
		errs = append(errs, "API_GO_NOTIFICATIONS_SOCKET_MODE must be one of legacy|go")
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
	// The situation monitor signals switch accepts the empty string, legacy and
	// go. An empty value behaves exactly like legacy so an unset deployment
	// keeps the NestJS path for all seven routes.
	switch strings.TrimSpace(getenv("API_GO_SITUATION_MONITOR_SIGNALS_MODE")) {
	case "", string(SituationSignalsModeLegacy):
		cfg.SituationSignalsMode = SituationSignalsModeLegacy
	case string(SituationSignalsModeGo):
		cfg.SituationSignalsMode = SituationSignalsModeGo
	default:
		errs = append(errs, "API_GO_SITUATION_MONITOR_SIGNALS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_SITUATION_INSIGHTS_MODE")) {
	case "", string(SituationInsightsModeLegacy):
		cfg.SituationInsightsMode = SituationInsightsModeLegacy
	case string(SituationInsightsModeGo):
		cfg.SituationInsightsMode = SituationInsightsModeGo
	default:
		errs = append(errs, "API_GO_SITUATION_INSIGHTS_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_SITUATION_SETTINGS_MODE")) {
	case "", string(SituationSettingsModeLegacy):
		cfg.SituationSettingsMode = SituationSettingsModeLegacy
	case string(SituationSettingsModeGo):
		cfg.SituationSettingsMode = SituationSettingsModeGo
	default:
		errs = append(errs, "API_GO_SITUATION_SETTINGS_MODE must be one of legacy|go")
	}
	// The GDELT external snapshot scheduler accepts the empty string, legacy
	// and go. An empty value behaves exactly like legacy so an unset deployment
	// keeps the NestJS @Cron ownership.
	switch strings.TrimSpace(getenv("API_GO_GDELT_SNAPSHOT_MODE")) {
	case "", string(GdeltSnapshotModeLegacy):
		cfg.GdeltSnapshotMode = GdeltSnapshotModeLegacy
	case string(GdeltSnapshotModeGo):
		cfg.GdeltSnapshotMode = GdeltSnapshotModeGo
	default:
		errs = append(errs, "API_GO_GDELT_SNAPSHOT_MODE must be one of legacy|go")
	}
	// The realtime signal collector accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy so an unset deployment keeps the
	// NestJS @Cron ownership.
	switch strings.TrimSpace(getenv("API_GO_REALTIME_SIGNALS_MODE")) {
	case "", string(RealtimeSignalsModeLegacy):
		cfg.RealtimeSignalsMode = RealtimeSignalsModeLegacy
	case string(RealtimeSignalsModeGo):
		cfg.RealtimeSignalsMode = RealtimeSignalsModeGo
	default:
		errs = append(errs, "API_GO_REALTIME_SIGNALS_MODE must be one of legacy|go")
	}
	// The forced-refresh entry switch is read by Go only; while it is legacy the
	// route stays on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GDELT_SNAPSHOT_REFRESH_MODE")) {
	case "", string(GdeltSnapshotRefreshModeLegacy):
		cfg.GdeltSnapshotRefreshMode = GdeltSnapshotRefreshModeLegacy
	case string(GdeltSnapshotRefreshModeGo):
		cfg.GdeltSnapshotRefreshMode = GdeltSnapshotRefreshModeGo
	default:
		errs = append(errs, "API_GO_GDELT_SNAPSHOT_REFRESH_MODE must be one of legacy|go")
	}
	// The news-event timeline rebuild accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy so an unset deployment keeps the
	// NestJS @Cron ownership.
	switch strings.TrimSpace(getenv("API_GO_NEWS_EVENTS_TIMELINE_MODE")) {
	case "", string(NewsEventsTimelineModeLegacy):
		cfg.NewsEventsTimelineMode = NewsEventsTimelineModeLegacy
	case string(NewsEventsTimelineModeGo):
		cfg.NewsEventsTimelineMode = NewsEventsTimelineModeGo
	default:
		errs = append(errs, "API_GO_NEWS_EVENTS_TIMELINE_MODE must be one of legacy|go")
	}
	// The sentiment snapshot rebuild is an independent switch with the same
	// accepted values.
	switch strings.TrimSpace(getenv("API_GO_SENTIMENT_SNAPSHOT_MODE")) {
	case "", string(SentimentSnapshotModeLegacy):
		cfg.SentimentSnapshotMode = SentimentSnapshotModeLegacy
	case string(SentimentSnapshotModeGo):
		cfg.SentimentSnapshotMode = SentimentSnapshotModeGo
	default:
		errs = append(errs, "API_GO_SENTIMENT_SNAPSHOT_MODE must be one of legacy|go")
	}
	// Both executions check this flag before doing any work, the same way
	// isGdeltEnabled does. The Go default matches the NestJS schema default.
	cfg.SituationMonitorGdeltEnabled = boolDefault(getenv("SITUATION_MONITOR_GDELT_ENABLED"), true)
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_NEWS_EVENTS_MODE")) {
	case "", "legacy":
		cfg.GraphQLNewsEventsMode = "legacy"
	case "go":
		cfg.GraphQLNewsEventsMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_NEWS_EVENTS_MODE must be one of legacy|go")
	}
	// The news-event brief sub-switch accepts the empty string, legacy and go.
	// An empty value behaves exactly like legacy, so an unset deployment keeps
	// the whole newsEventBrief operation on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE")) {
	case "", "legacy":
		cfg.GraphQLNewsEventBriefMode = "legacy"
	case "go":
		cfg.GraphQLNewsEventBriefMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE must be one of legacy|go")
	}
	// The brief sub-switch cannot silently enable its parents: it needs both
	// the GraphQL read takeover and the news-event read registration.
	if cfg.GraphQLNewsEventBriefMode == "go" && (cfg.GraphQLReadMode != "go" || cfg.GraphQLNewsEventsMode != "go") {
		errs = append(errs, "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go requires API_GO_GRAPHQL_READ_MODE=go and API_GO_GRAPHQL_NEWS_EVENTS_MODE=go")
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
	// The metadata GraphQL switch accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy so an unset deployment keeps
	// serving crawlMetadata through NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_CRAWL_METADATA_MODE")) {
	case "", "legacy":
		cfg.GraphQLCrawlMetadataMode = "legacy"
	case "go":
		cfg.GraphQLCrawlMetadataMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_CRAWL_METADATA_MODE must be one of legacy|go")
	}
	// The item reading switch accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy so an unset deployment keeps serving
	// both REST routes and all five GraphQL roots through NestJS.
	itemsReadingRaw := strings.TrimSpace(getenv("API_GO_ITEMS_READING_MODE"))
	switch itemsReadingRaw {
	case "", string(ItemsReadingModeLegacy):
		cfg.ItemsReadingMode = ItemsReadingModeLegacy
	case string(ItemsReadingModeGo):
		cfg.ItemsReadingMode = ItemsReadingModeGo
	default:
		// The failure names the variable and echoes the rejected value so an
		// operator can see which deployment value was refused.
		errs = append(errs, "API_GO_ITEMS_READING_MODE must be one of legacy|go, got "+strconv.Quote(itemsReadingRaw))
	}
	// The items ingest switch. Empty behaves like legacy; an invalid value
	// fails startup instead of silently downgrading.
	switch strings.TrimSpace(getenv("API_GO_ITEMS_INGEST_MODE")) {
	case "", string(ItemsIngestModeLegacy):
		cfg.ItemsIngestMode = ItemsIngestModeLegacy
	case string(ItemsIngestModeGo):
		cfg.ItemsIngestMode = ItemsIngestModeGo
	default:
		errs = append(errs, "API_GO_ITEMS_INGEST_MODE must be one of legacy|go")
	}
	// The raw_item replay owner is independent of the write switch.
	switch strings.TrimSpace(getenv("API_GO_RAW_ITEM_OUTBOX_MODE")) {
	case "", string(RawItemOutboxModeLegacy):
		cfg.RawItemOutboxMode = RawItemOutboxModeLegacy
	case string(RawItemOutboxModeGo):
		cfg.RawItemOutboxMode = RawItemOutboxModeGo
	default:
		errs = append(errs, "API_GO_RAW_ITEM_OUTBOX_MODE must be one of legacy|go")
	}
	// The processed_item compensation owner is independent of the write and
	// read switches. Empty behaves like legacy; an invalid value fails startup.
	switch strings.TrimSpace(getenv("API_GO_PROCESSED_ITEM_OUTBOX_MODE")) {
	case "", string(ProcessedItemOutboxModeLegacy):
		cfg.ProcessedItemOutboxMode = ProcessedItemOutboxModeLegacy
	case string(ProcessedItemOutboxModeGo):
		cfg.ProcessedItemOutboxMode = ProcessedItemOutboxModeGo
	default:
		errs = append(errs, "API_GO_PROCESSED_ITEM_OUTBOX_MODE must be one of legacy|go")
	}
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
	// The cross-process scheduling stop switch uses the exact NestJS
	// `!== "false"` comparison.
	// The items list switch accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy, so an unset deployment keeps the items
	// connection root on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_ITEMS_LIST_MODE")) {
	case "", "legacy":
		cfg.GraphQLItemsListMode = "legacy"
	case "go":
		cfg.GraphQLItemsListMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_ITEMS_LIST_MODE must be one of legacy|go")
	}
	// The organization access write switch accepts the empty string, legacy and
	// go. An empty value behaves exactly like legacy, so an unset deployment
	// keeps every mutation on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE")) {
	case "", "legacy":
		cfg.GraphQLOrgAccessWriteMode = "legacy"
	case "go":
		cfg.GraphQLOrgAccessWriteMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE must be one of legacy|go")
	}
	// The workspace write switch accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy, so an unset deployment keeps
	// these eight mutations on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_WORKSPACE_WRITE_MODE")) {
	case "", "legacy":
		cfg.GraphQLWorkspaceWriteMode = "legacy"
	case "go":
		cfg.GraphQLWorkspaceWriteMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_WORKSPACE_WRITE_MODE must be one of legacy|go")
	}
	// The alert rule switch accepts the empty string, legacy and go. An empty
	// value behaves exactly like legacy, so an unset deployment keeps alertRules
	// and the three rule mutations on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_ALERT_RULES_MODE")) {
	case "", "legacy":
		cfg.GraphQLAlertRulesMode = "legacy"
	case "go":
		cfg.GraphQLAlertRulesMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_ALERT_RULES_MODE must be one of legacy|go")
	}
	// The settings write switch accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy, so an unset deployment keeps
	// every settings mutation on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_SETTINGS_WRITE_MODE")) {
	case "", "legacy":
		cfg.GraphQLSettingsWriteMode = "legacy"
	case "go":
		cfg.GraphQLSettingsWriteMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_SETTINGS_WRITE_MODE must be one of legacy|go")
	}
	// The source-policy write switch accepts the empty string, legacy and go.
	// An empty value behaves exactly like legacy, so an unset deployment keeps
	// all four version mutations on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE")) {
	case "", "legacy":
		cfg.GraphQLSourcePolicyWriteMode = "legacy"
	case "go":
		cfg.GraphQLSourcePolicyWriteMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE must be one of legacy|go")
	}
	// The knowledge-graph evidence review switch accepts the empty string,
	// legacy and go. An empty value behaves exactly like legacy, so an unset
	// deployment keeps the mutation on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE")) {
	case "", "legacy":
		cfg.GraphQLKnowledgeReviewMode = "legacy"
	case "go":
		cfg.GraphQLKnowledgeReviewMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE must be one of legacy|go")
	}
	// The RSS translation switch accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy, so an unset deployment keeps
	// translateRssItems, including its cache/metrics/model-log side effects, on
	// NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_RSS_TRANSLATION_MODE")) {
	case "", "legacy":
		cfg.GraphQLRssTranslationMode = "legacy"
	case "go":
		cfg.GraphQLRssTranslationMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_RSS_TRANSLATION_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_ECONOMIC_DATA_MODE")) {
	case "", string(EconomicDataModeLegacy):
		cfg.EconomicDataMode = EconomicDataModeLegacy
	case string(EconomicDataModeGo):
		cfg.EconomicDataMode = EconomicDataModeGo
	default:
		errs = append(errs, "API_GO_ECONOMIC_DATA_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_ECONOMIC_DATA_WORKER_MODE")) {
	case "", string(EconomicDataWorkerModeLegacy):
		cfg.EconomicDataWorkerMode = EconomicDataWorkerModeLegacy
	case string(EconomicDataWorkerModeGo):
		cfg.EconomicDataWorkerMode = EconomicDataWorkerModeGo
	default:
		errs = append(errs, "API_GO_ECONOMIC_DATA_WORKER_MODE must be one of legacy|go")
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

	// The assistant write switch accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy, so an unset deployment keeps the
	// four mutations on NestJS.
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_ASSISTANT_WRITE_MODE")) {
	case "", "legacy":
		cfg.GraphQLAssistantWriteMode = "legacy"
	case "go":
		cfg.GraphQLAssistantWriteMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_ASSISTANT_WRITE_MODE must be one of legacy|go")
	}
	// The assistant worker switch accepts the empty string, legacy and go. An
	// empty value behaves exactly like legacy, so an unset deployment keeps the
	// NestJS Worker.
	switch strings.TrimSpace(getenv("API_GO_ASSISTANT_WORKER_MODE")) {
	case "", "legacy":
		cfg.AssistantWorkerMode = "legacy"
	case "go":
		cfg.AssistantWorkerMode = "go"
	default:
		errs = append(errs, "API_GO_ASSISTANT_WORKER_MODE must be one of legacy|go")
	}
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

	// The four news backfill switches accept exactly "", "legacy" and "go".
	// An empty value behaves like legacy; any other value fails startup. The
	// manual enqueue route and the GraphQL mutation are request switches, while
	// the worker and the six-hour cron switches are also read by NestJS so the
	// two runtimes never own the same background chain.
	switch strings.TrimSpace(getenv("API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE")) {
	case "", string(NewsClusteringLlmBackfillModeLegacy):
		cfg.NewsClusteringLlmBackfillMode = NewsClusteringLlmBackfillModeLegacy
	case string(NewsClusteringLlmBackfillModeGo):
		cfg.NewsClusteringLlmBackfillMode = NewsClusteringLlmBackfillModeGo
	default:
		errs = append(errs, "API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE")) {
	case "", string(NewsClusteringRecoveryWorkerModeLegacy):
		cfg.NewsClusteringRecoveryWorkerMode = NewsClusteringRecoveryWorkerModeLegacy
	case string(NewsClusteringRecoveryWorkerModeGo):
		cfg.NewsClusteringRecoveryWorkerMode = NewsClusteringRecoveryWorkerModeGo
	default:
		errs = append(errs, "API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_ARCHIVE_PREPARATION_WORKER_MODE")) {
	case "", string(ArchivePreparationWorkerModeLegacy):
		cfg.ArchivePreparationWorkerMode = ArchivePreparationWorkerModeLegacy
	case string(ArchivePreparationWorkerModeGo):
		cfg.ArchivePreparationWorkerMode = ArchivePreparationWorkerModeGo
	default:
		errs = append(errs, "API_GO_ARCHIVE_PREPARATION_WORKER_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE")) {
	case "", "legacy":
		cfg.GraphQLNewsIndicatorRefreshMode = "legacy"
	case "go":
		cfg.GraphQLNewsIndicatorRefreshMode = "go"
	default:
		errs = append(errs, "API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE must be one of legacy|go")
	}
	switch strings.TrimSpace(getenv("API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE")) {
	case "", string(NewsIndicatorAssociationCronModeLegacy):
		cfg.NewsIndicatorAssociationCronMode = NewsIndicatorAssociationCronModeLegacy
	case string(NewsIndicatorAssociationCronModeGo):
		cfg.NewsIndicatorAssociationCronMode = NewsIndicatorAssociationCronModeGo
	default:
		errs = append(errs, "API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE must be one of legacy|go")
	}
	// The clustering recovery worker reads the same process-queue concurrency
	// the NestJS processor uses and clamps it to max(1, min(2, value)).
	cfg.NewsProcessQueueConcurrency = intDefault(getenv("NEWS_PROCESS_QUEUE_CONCURRENCY"), 8)

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
	// The background digest delivery unit owns the Cron without JWT/RBAC: it
	// reads MySQL, Redis, Mongo and the real SMTP transport. No HTTP takeover
	// switch or JWT_SECRET is required, so delivery-only can run while every
	// other mode (including API_GO_USER_DIGEST_MODE) is legacy.
	if cfg.UserDigestDeliveryMode == UserDigestDeliveryModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_USER_DIGEST_DELIVERY_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_USER_DIGEST_DELIVERY_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_USER_DIGEST_DELIVERY_MODE=go")
		}
		if cfg.SMTP.Host == "" {
			errs = append(errs, "SMTP_HOST is required when API_GO_USER_DIGEST_DELIVERY_MODE=go")
		}
		if cfg.SMTP.Port == 0 {
			errs = append(errs, "SMTP_PORT is required when API_GO_USER_DIGEST_DELIVERY_MODE=go")
		}
		if cfg.SMTP.User == "" {
			errs = append(errs, "SMTP_USER is required when API_GO_USER_DIGEST_DELIVERY_MODE=go")
		}
		if cfg.SMTP.Pass == "" {
			errs = append(errs, "SMTP_PASS is required when API_GO_USER_DIGEST_DELIVERY_MODE=go")
		}
	}
	// The audit outbox replay unit is a background owner like digest delivery:
	// it reads and writes MySQL and takes the cron lease in Redis. It verifies
	// no JWT, reads no Mongo collection, sends no mail and registers no route,
	// so every HTTP switch can stay legacy.
	if cfg.AuditOutboxMode == AuditOutboxModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_AUDIT_OUTBOX_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_AUDIT_OUTBOX_MODE=go")
		}
	}
	// The knowledge-graph ingestion chain owns the Cron without JWT/RBAC: it
	// reads MySQL, Redis and the same gateway profiles publicportal uses. The
	// model gateway itself is resolved at request time, so it is not a startup
	// requirement (a missing profile only skips validation/disambiguation and
	// still writes the graph). Mongo is optional: the LLM request log is
	// best-effort, exactly like every other writer.
	if cfg.KnowledgeGraphIngestionMode == KnowledgeGraphIngestionModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go")
		}
	}
	// The news-event ingestion scheduler owns the five-minute Cron without
	// JWT/RBAC: it reads MySQL (cursor, events), Redis (tick gate, organization
	// leases, active-org cache) and Mongo (ProcessedItem, TaskLog, clustering
	// failures). The vector and model services are resolved per call, so they are
	// not startup requirements: a missing service only degrades the assignment
	// path exactly like a missing service degrades the NestJS path.
	if cfg.NewsEventsIngestionMode == NewsEventsIngestionModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_NEWS_EVENTS_INGESTION_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_NEWS_EVENTS_INGESTION_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_NEWS_EVENTS_INGESTION_MODE=go")
		}
	}
	// The alert worker owns the shared `alerts` queue without JWT/RBAC: it reads
	// MySQL, Redis and Mongo and sends through the real SMTP transport, so it
	// needs no HTTP takeover switch. The model service is optional: the economic
	// anomaly provider falls back to its local detector when it is unavailable.
	// The Frontier LLM worker owner consumes the two LLM queues without
	// JWT/RBAC. The model gateway profile and the managed governance key are
	// decrypted with SYSTEM_SETTINGS_ENCRYPTION_KEY, so an empty key would make
	// every judge/learn call fail at runtime instead of at startup.
	if cfg.CrawlFrontierLlmWorkerMode == CrawlFrontierLlmWorkerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE=go")
		}
		if cfg.SystemSettingsEncryptionKeyRaw == "" {
			errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required when API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE=go")
		}
	}
	if cfg.AlertWorkerMode == AlertWorkerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ALERT_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ALERT_WORKER_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ALERT_WORKER_MODE=go")
		}
		if cfg.SMTP.Host == "" {
			errs = append(errs, "SMTP_HOST is required when API_GO_ALERT_WORKER_MODE=go")
		}
		if cfg.SMTP.Port == 0 {
			errs = append(errs, "SMTP_PORT is required when API_GO_ALERT_WORKER_MODE=go")
		}
		if cfg.SMTP.User == "" {
			errs = append(errs, "SMTP_USER is required when API_GO_ALERT_WORKER_MODE=go")
		}
		if cfg.SMTP.Pass == "" {
			errs = append(errs, "SMTP_PASS is required when API_GO_ALERT_WORKER_MODE=go")
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
	// The CSV export takeover reads MySQL (NewsEvent/NewsEventItem and the
	// membership chain), Redis (revocation list and the behavior profile) and
	// Mongo (the read-model projection), and it verifies JWTs (including the
	// mtk_ machine tokens) before selecting candidates.
	if cfg.AnalysisExportMode == AnalysisExportModeGo {
		appendAuthRequirements(&errs, "API_GO_ANALYSIS_EXPORT_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ANALYSIS_EXPORT_MODE=go")
		}
	}
	// The archive reading unit verifies JWTs (human and mtk_), reads the Redis
	// revocation list, re-derives membership from MySQL, reads Mongo display
	// signals and writes Mongo model attempt logs. It also uses the shared Redis
	// cache/metrics and the BullMQ preparation queue.
	if cfg.ArchiveReadingMode == ArchiveReadingModeGo {
		appendAuthRequirements(&errs, "API_GO_ARCHIVE_READING_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ARCHIVE_READING_MODE=go")
		}
	}
	// The request producer needs JWT (permission and identity), MySQL
	// (membership re-derivation), Redis (the analysis queue) and Mongo (the
	// pending analysisresults row).
	if cfg.AnalysisRunsMode == AnalysisRunsModeGo {
		appendAuthRequirements(&errs, "API_GO_ANALYSIS_RUNS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ANALYSIS_RUNS_MODE=go")
		}
	}
	// The residual-duty switches. The cleanup, review-seed and startup units are
	// Redis-only; the two HTTP units need the credentialed stack, and both
	// pipeline writes also read and write Mongo.
	if cfg.BullmqCleanupMode == BullmqCleanupModeGo && cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required when API_GO_BULLMQ_CLEANUP_MODE=go")
	}
	if cfg.ClassificationReviewSeedMode == ClassificationReviewSeedModeGo && cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required when API_GO_CLASSIFICATION_REVIEW_SEED_MODE=go")
	}
	if cfg.PipelineRecoveryWriteMode == PipelineRecoveryWriteModeGo {
		appendAuthRequirements(&errs, "API_GO_PIPELINE_RECOVERY_WRITE_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_PIPELINE_RECOVERY_WRITE_MODE=go")
		}
	}
	if cfg.MetricsMode == MetricsModeGo {
		appendAuthRequirements(&errs, "API_GO_METRICS_MODE", cfg)
	}
	if cfg.StartupReconcileMode == StartupReconcileModeGo && cfg.RedisHost == "" {
		errs = append(errs, "REDIS_HOST is required when API_GO_STARTUP_RECONCILE_MODE=go")
	}
	// The worker owner needs no JWT: it consumes jobs, computes, streams the
	// model, writes Mongo/MySQL and publishes the GraphQL subscription event.
	// The event must reach the existing Redis backplane, so a local bus is not
	// a valid owner configuration.
	if cfg.AnalysisWorkerMode == AnalysisWorkerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ANALYSIS_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ANALYSIS_WORKER_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ANALYSIS_WORKER_MODE=go")
		}
		if cfg.GraphQLSubscriptionBus != "redis" {
			errs = append(errs, "GRAPHQL_SUBSCRIPTION_BUS must be redis when API_GO_ANALYSIS_WORKER_MODE=go")
		}
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
	if cfg.CrawlFrontierRunsMode == CrawlFrontierRunsModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_FRONTIER_RUNS_MODE", cfg)
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
	// The exception ingest takeover writes into the existing exceptionevents
	// Mongo collection, so it needs Mongo on top of the JWT/MySQL/Redis
	// requirements. A missing LITELLM_CONFIG_INTERNAL_TOKEN is an endpoint
	// contract (403) and must not fail startup.
	if cfg.ExceptionIngestMode == ExceptionIngestModeGo {
		appendAuthRequirements(&errs, "API_GO_EXCEPTION_INGEST_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_EXCEPTION_INGEST_MODE=go")
		}
	}
	if cfg.NewsIndicatorsMode == NewsIndicatorsModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWS_INDICATORS_MODE", cfg)
	}
	// The platform governance settings takeover reads Mongo (assistant quota
	// usage, assistant safety metrics) and reconciles Mongo TTL indexes (task
	// logs, llm request logs), so it needs the standard JWT + MySQL + Redis
	// requirements plus MONGO_URI.
	if cfg.PlatformGovernanceSettingsMode == PlatformGovernanceSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go")
		}
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

	// The report creation takeover reports a job through Redis and stores it in
	// Mongo, so it needs the full credentialed stack.
	if cfg.ClassificationReportsMode == ClassificationReportsModeGo {
		appendAuthRequirements(&errs, "API_GO_CLASSIFICATION_REPORTS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_CLASSIFICATION_REPORTS_MODE=go")
		}
	}
	// The worker consumes the shared queue: it needs MySQL (source and article
	// context), Redis (the queue) and Mongo (reports, reviews, annotations), but
	// no JWT because it never authenticates a caller.
	if cfg.ClassificationQualityWorkerMode == ClassificationQualityWorkerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go")
		}
	}
	// The runs read joins MySQL and Mongo behind the normal JWT verifier; it
	// never touches Redis.
	if cfg.PipelineRecoveryMode == PipelineRecoveryModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_PIPELINE_RECOVERY_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_PIPELINE_RECOVERY_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_PIPELINE_RECOVERY_MODE=go")
		}
	}

	if cfg.NewsnowClusteringOpsMode == NewsnowClusteringOpsModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWSNOW_CLUSTERING_OPS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_NEWSNOW_CLUSTERING_OPS_MODE=go")
		}
	}
	// The two NewsNow hot reading routes need the credentialed stack plus Mongo
	// (rawitems, processeditems, NewsEventItem via MySQL) and the model gateway.
	if cfg.NewsnowHottestMode == NewsnowHottestModeGo {
		appendSpacetimeRequirements(&errs, "API_GO_NEWSNOW_HOTTEST_MODE", cfg)
	}
	// The background owners synchronize their snapshots and projections through
	// the same MySQL/Redis/Mongo stores. They never authenticate a caller.
	if cfg.NewsnowBackgroundMode == NewsnowBackgroundModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_NEWSNOW_BACKGROUND_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_NEWSNOW_BACKGROUND_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_NEWSNOW_BACKGROUND_MODE=go")
		}
	}
	// The public source fetch takeover needs MySQL for the global runtime-secret
	// row and Redis for the compatible cache, refresh lock and relay. The two
	// routes are public, so JWT_SECRET, Mongo, GraphQL and model switches are
	// deliberately not required.
	if cfg.NewsnowSourcesMode == NewsnowSourcesModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_NEWSNOW_SOURCES_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_NEWSNOW_SOURCES_MODE=go")
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
	// The metadata preview takeover needs the credentialed auth stack plus
	// Redis (the shared discovery conditional HTTP state) and outbound HTTP/DNS.
	// It reads no Mongo collection, so MONGO_URI is not required and the entry
	// can run while every other crawl mode is legacy.
	if cfg.CrawlMetadataMode == CrawlMetadataModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_METADATA_MODE", cfg)
	}
	// The crawl task write takeover needs the credentialed stack: JWT verify,
	// Redis revocation/counters and MySQL task/audit writes. It starts no worker
	// and calls no crawl4ai endpoint.
	if cfg.CrawlTaskWriteMode == CrawlTaskWriteModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_TASK_WRITE_MODE", cfg)
	}
	// The queue administration takeover reads and writes Redis queue meta,
	// counts, activity counters and the crawl settings row; MySQL and Redis are
	// both required and Mongo is not.
	if cfg.CrawlQueueOpsMode == CrawlQueueOpsModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_QUEUE_OPS_MODE", cfg)
	}
	// The crawl maintenance crons write MySQL rows, take Redis leases and
	// touch Mongo documents, so go requires all three and no JWT.
	if cfg.CrawlMaintenanceMode == CrawlMaintenanceModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_CRAWL_MAINTENANCE_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_CRAWL_MAINTENANCE_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_CRAWL_MAINTENANCE_MODE=go")
		}
	}
	// The audit retention purge reads the shared retention cache and deletes
	// AuditLog rows; Mongo and JWT are not involved.
	if cfg.AuditLogRetentionMode == AuditLogRetentionModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_AUDIT_LOG_RETENTION_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_AUDIT_LOG_RETENTION_MODE=go")
		}
	}
	// The news-source preview takeover needs the credentialed auth stack plus
	// Redis (shared with the deep-discovery failure state). crawl4ai is optional
	// at startup, exactly like NestJS.
	if cfg.NewsSourcePreviewMode == NewsSourcePreviewModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWS_SOURCE_PREVIEW_MODE", cfg)
	}
	// The crawl-strategy trial/replay takeover needs the credentialed auth
	// stack plus Redis and MySQL for the run records. crawl4ai is optional.
	if cfg.CrawlWorkflowTrialMode == CrawlWorkflowTrialModeGo {
		appendAuthRequirements(&errs, "API_GO_CRAWL_WORKFLOW_TRIAL_MODE", cfg)
	}
	// The news-source scheduler writes the MySQL due-source state and takes the
	// shared Redis lock, so it needs MySQL and Redis but no JWT: it serves no
	// route.
	if cfg.NewsSourceSchedulerMode == NewsSourceSchedulerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_NEWS_SOURCE_SCHEDULER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_NEWS_SOURCE_SCHEDULER_MODE=go")
		}
	}
	// The four ops POSTs re-derive the caller's crawl.write permission from the
	// credentialed JWT/MySQL/Redis stack.
	if cfg.NewsSourceOpsMode == NewsSourceOpsModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWS_SOURCE_OPS_MODE", cfg)
	}
	// The metadata GraphQL root is a child switch of the GraphQL read pilot:
	// without API_GO_GRAPHQL_READ_MODE=go there is no executor to register into,
	// so startup must fail instead of silently ignoring the switch. Mongo comes
	// from the parent read requirement.
	if cfg.GraphQLCrawlMetadataMode == "go" && cfg.GraphQLReadMode != "go" {
		errs = append(errs, "API_GO_GRAPHQL_CRAWL_METADATA_MODE=go requires API_GO_GRAPHQL_READ_MODE=go")
	}
	// The search reindex takeover reads the item read model from Mongo, so
	// MONGO_URI is required in addition to the standard JWT + MySQL + Redis
	// requirements. Elasticsearch is optional at startup: the disabled branch
	// completes with indexed=0.
	if cfg.SearchReindexMode == SearchReindexModeGo {
		appendAuthRequirements(&errs, "API_GO_SEARCH_REINDEX_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_SEARCH_REINDEX_MODE=go")
		}
	}
	// The runtime/governance settings takeover needs JWT verification, MySQL
	// and Redis only; it reads no Mongo collection and starts no worker.
	if cfg.RuntimeSettingsMode == RuntimeSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_RUNTIME_SETTINGS_MODE", cfg)
	}
	// The model access settings takeover needs JWT verification, MySQL and Redis
	// only (the model_service and openai_keys rows live in MySQL, the 30 second
	// cache envelopes live in Redis). It reads no Mongo collection, calls no model
	// upstream and starts no worker. Neither the encryption key nor the LiteLLM
	// internal token is a startup requirement: their absence has runtime semantics
	// (a fail-closed 400 at write time and a 403 on the internal endpoints).
	if cfg.ModelAccessSettingsMode == ModelAccessSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_MODEL_ACCESS_SETTINGS_MODE", cfg)
	}
	// The item reading takeover reads MySQL, Mongo and Redis, and needs JWT
	// verification for both the REST routes and the GraphQL roots.
	if cfg.ItemsReadingMode == ItemsReadingModeGo {
		appendAuthRequirements(&errs, "API_GO_ITEMS_READING_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ITEMS_READING_MODE=go")
		}
	}
	// The items write mode needs the credentialed stack plus Mongo. The
	// immediate raw_item delivery is executed by the request handler.
	if cfg.ItemsIngestMode == ItemsIngestModeGo {
		appendAuthRequirements(&errs, "API_GO_ITEMS_INGEST_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ITEMS_INGEST_MODE=go")
		}
	}
	// The raw_item replay owner is a background unit: it needs MySQL, Redis and
	// Mongo for hydration but verifies no JWT and registers no route.
	if cfg.RawItemOutboxMode == RawItemOutboxModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_RAW_ITEM_OUTBOX_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_RAW_ITEM_OUTBOX_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_RAW_ITEM_OUTBOX_MODE=go")
		}
	}
	// The processed_item compensation owner reads MySQL and Mongo, takes its
	// scan lease in Redis and resolves vector settings at delivery time. It
	// verifies no JWT and registers no route.
	if cfg.ProcessedItemOutboxMode == ProcessedItemOutboxModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go")
		}
	}
	// The items connection root reuses the item reading service and the shared
	// GraphQL executor, so it has hard parent dependencies instead of silently
	// enabling a parent switch. The Mongo requirement is already implied by the
	// two parents.
	if cfg.GraphQLItemsListMode == "go" {
		if cfg.GraphQLReadMode != "go" {
			errs = append(errs, "API_GO_GRAPHQL_ITEMS_LIST_MODE=go requires API_GO_GRAPHQL_READ_MODE=go")
		}
		if cfg.ItemsReadingMode != ItemsReadingModeGo {
			errs = append(errs, "API_GO_GRAPHQL_ITEMS_LIST_MODE=go requires API_GO_ITEMS_READING_MODE=go")
		}
	}

	if cfg.LLMGatewayProfilesMode == LLMGatewayProfilesModeGo {
		appendAuthRequirements(&errs, "API_GO_LLM_GATEWAY_PROFILES_MODE", cfg)
	}
	// The governance/diagnostics takeover additionally writes the LLM request
	// log through the shared Mongo client, so MONGO_URI is required. Neither the
	// LiteLLM master key nor the settings-encryption key is a startup
	// requirement: a missing master key is a 503 on the management calls and a
	// missing encryption key makes the managed key "unreadable" on read.
	if cfg.LLMGatewayOpsMode == LLMGatewayOpsModeGo {
		appendAuthRequirements(&errs, "API_GO_LLM_GATEWAY_OPS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_LLM_GATEWAY_OPS_MODE=go")
		}
	}
	// The proxy load balancing takeover has exactly the same infrastructure
	// footprint: the litellm_proxy_load_balancing row lives in MySQL, its 30
	// second cache envelope lives in Redis, and it re-reads the existing
	// openai_keys row instead of calling NestJS. LITELLM_CONFIG_INTERNAL_TOKEN
	// and SYSTEM_SETTINGS_ENCRYPTION_KEY keep their runtime semantics and are
	// never startup requirements.
	if cfg.ProxyLoadBalancingMode == ProxyLoadBalancingModeGo {
		appendAuthRequirements(&errs, "API_GO_PROXY_LOAD_BALANCING_MODE", cfg)
	}
	// The infrastructure settings takeover needs JWT verification, MySQL and
	// Redis only. It reads no Mongo collection, starts no worker and does not
	// treat the settings-encryption key as a startup requirement: a missing or
	// invalid key is handled per read/write by the documented fallback and 400
	// contracts.
	if cfg.InfrastructureSettingsMode == InfrastructureSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_INFRASTRUCTURE_SETTINGS_MODE", cfg)
	}
	// The storage connection test takeover needs JWT verification, MySQL (the
	// real SELECT 1 and the settings read) and Redis (the storage settings
	// cache) only. It reads no Mongo collection, requires no other takeover
	// switch, builds no S3 client at startup and performs no startup probe: the
	// diagnostics run inside the request and report failures per step.
	if cfg.StorageDiagnosticsMode == StorageDiagnosticsModeGo {
		appendAuthRequirements(&errs, "API_GO_STORAGE_DIAGNOSTICS_MODE", cfg)
	}
	// The data runtime settings takeover needs JWT verification, MySQL and Redis
	// only. It reads no Mongo collection, starts no worker, performs no startup
	// network probe and does not treat the settings-encryption key as a startup
	// requirement.
	if cfg.DataRuntimeSettingsMode == DataRuntimeSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_DATA_RUNTIME_SETTINGS_MODE", cfg)
	}
	// The email settings takeover performs a real SMTP verify and can send a
	// real test message, so it requires the transport in addition to the
	// credentialed JWT/MySQL/Redis stack.
	if cfg.EmailSettingsMode == EmailSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_EMAIL_SETTINGS_MODE", cfg)
		if cfg.SMTP.Host == "" {
			errs = append(errs, "SMTP_HOST is required when API_GO_EMAIL_SETTINGS_MODE=go")
		}
		if cfg.SMTP.Port == 0 {
			errs = append(errs, "SMTP_PORT is required when API_GO_EMAIL_SETTINGS_MODE=go")
		}
		if cfg.SMTP.User == "" {
			errs = append(errs, "SMTP_USER is required when API_GO_EMAIL_SETTINGS_MODE=go")
		}
		if cfg.SMTP.Pass == "" {
			errs = append(errs, "SMTP_PASS is required when API_GO_EMAIL_SETTINGS_MODE=go")
		}
	}
	// The geocoding takeover needs JWT verification, MySQL and Redis (the
	// identity row and the shared cache/rate-limit keys). It contacts Nominatim
	// only inside a request, so no external endpoint is a startup requirement.
	if cfg.GeocodingMode == GeocodingModeGo {
		appendAuthRequirements(&errs, "API_GO_GEOCODING_MODE", cfg)
	}
	// The runtime diagnostics takeover reads Redis, MySQL and Mongo and probes
	// LiteLLM inside the request. Mongo is required because the marker
	// readiness section aggregates processeditems; no LiteLLM endpoint is a
	// startup requirement.
	if cfg.RuntimeDiagnosticsMode == RuntimeDiagnosticsModeGo {
		appendAuthRequirements(&errs, "API_GO_RUNTIME_DIAGNOSTICS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_RUNTIME_DIAGNOSTICS_MODE=go")
		}
	}
	// The authenticated MFA management / OIDC configuration takeover needs JWT
	// verification, MySQL and Redis only. It reads no Mongo collection, starts
	// no worker and never contacts an identity provider. The
	// settings-encryption key stays optional at startup: a missing or invalid
	// key is handled per write by the documented fallback and production-500
	// contracts rather than blocking boot.
	if cfg.AuthFactorsMode == AuthFactorsModeGo {
		appendAuthRequirements(&errs, "API_GO_AUTH_FACTORS_MODE", cfg)
	}
	// The account/session/machine-token takeover needs JWT verification, MySQL
	// and Redis only. It reads no Mongo collection, starts no worker and does
	// not add a second startup check: it reuses appendAuthRequirements exactly
	// like the other takeover switches.
	if cfg.AccountSecurityMode == AccountSecurityModeGo {
		appendAuthRequirements(&errs, "API_GO_ACCOUNT_SECURITY_MODE", cfg)
	}
	// The avatar presign route needs JWT verification, MySQL (the storage
	// settings read) and Redis (the settings cache). It signs locally and never
	// requires Mongo or S3 connectivity.
	if cfg.AvatarUploadMode == AvatarUploadModeGo {
		appendAuthRequirements(&errs, "API_GO_AVATAR_UPLOAD_MODE", cfg)
	}
	// The data export reads MySQL, Redis (rate limit + behavior profile) and
	// Mongo (assistantruns), and verifies the caller's JWT.
	if cfg.UserDataExportMode == UserDataExportModeGo {
		appendAuthRequirements(&errs, "API_GO_USER_DATA_EXPORT_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_USER_DATA_EXPORT_MODE=go")
		}
	}
	// The login/session/email-code takeover needs JWT verification, MySQL, Redis
	// and a real SMTP transport: four of its routes send mail synchronously
	// inside the request. It reads no Mongo collection, starts no worker and
	// keeps the settings-encryption key optional at startup, deferring the
	// existing per-write policy to the reused MFA factor service.
	if cfg.AuthLoginMode == AuthLoginModeGo {
		appendAuthRequirements(&errs, "API_GO_AUTH_LOGIN_MODE", cfg)
		if cfg.SMTP.Host == "" {
			errs = append(errs, "SMTP_HOST is required when API_GO_AUTH_LOGIN_MODE=go")
		}
		if cfg.SMTP.Port == 0 {
			errs = append(errs, "SMTP_PORT is required when API_GO_AUTH_LOGIN_MODE=go")
		}
		if cfg.SMTP.User == "" {
			errs = append(errs, "SMTP_USER is required when API_GO_AUTH_LOGIN_MODE=go")
		}
		if cfg.SMTP.Pass == "" {
			errs = append(errs, "SMTP_PASS is required when API_GO_AUTH_LOGIN_MODE=go")
		}
	}
	// The OIDC login takeover needs JWT signing/verification, MySQL and Redis
	// only. It starts no worker and contacts the IdP only when a request needs
	// discovery/token/JWKS, so no IdP URL or secret is a startup condition.
	if cfg.OIDCLoginMode == OIDCLoginModeGo {
		appendAuthRequirements(&errs, "API_GO_OIDC_LOGIN_MODE", cfg)
	}
	// The registration/invitation takeover needs the same credentialed stack as
	// the login batch plus the real SMTP transport: invitation creation, resend
	// and the two rejection paths send mail synchronously. It reads no Mongo
	// collection, starts no worker and contacts no identity provider.
	if cfg.IdentityOnboardingMode == IdentityOnboardingModeGo {
		appendAuthRequirements(&errs, "API_GO_IDENTITY_ONBOARDING_MODE", cfg)
		if cfg.SMTP.Host == "" {
			errs = append(errs, "SMTP_HOST is required when API_GO_IDENTITY_ONBOARDING_MODE=go")
		}
		if cfg.SMTP.Port == 0 {
			errs = append(errs, "SMTP_PORT is required when API_GO_IDENTITY_ONBOARDING_MODE=go")
		}
		if cfg.SMTP.User == "" {
			errs = append(errs, "SMTP_USER is required when API_GO_IDENTITY_ONBOARDING_MODE=go")
		}
		if cfg.SMTP.Pass == "" {
			errs = append(errs, "SMTP_PASS is required when API_GO_IDENTITY_ONBOARDING_MODE=go")
		}
	}
	if cfg.GraphQLReadMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_READ_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_GRAPHQL_READ_MODE=go")
		}
	}
	// The realtime subscription transport verifies JWTs, re-derives membership
	// in MySQL and reads Redis, but never opens Mongo or starts a worker.
	if cfg.GraphQLSubscriptionsMode == GraphQLSubscriptionsModeGo {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_SUBSCRIPTIONS_MODE", cfg)
	}
	// The notifications transport verifies JWTs, re-derives membership in
	// MySQL and reads Redis. It never opens Mongo or starts a worker.
	if cfg.NotificationsSocketMode == NotificationsSocketModeGo {
		appendAuthRequirements(&errs, "API_GO_NOTIFICATIONS_SOCKET_MODE", cfg)
	}
	// The organization access write takeover needs JWT verification, MySQL and
	// Redis only. It reads no Mongo collection and starts no worker, so it does
	// not require MONGO_URI.
	if cfg.GraphQLOrgAccessWriteMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE", cfg)
	}
	// The workspace write takeover needs JWT verification, MySQL and Redis
	// only. Reusing the workspace, alert and history models does not make
	// MONGO_URI, the model gateway or the queue a startup condition.
	if cfg.GraphQLWorkspaceWriteMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_WORKSPACE_WRITE_MODE", cfg)
	}
	// The alert rule unit needs JWT verification, MySQL and Redis. The queue
	// writes reuse the shared Redis client and do not require Mongo, the model
	// gateway, SMTP or a worker in this process.
	if cfg.GraphQLAlertRulesMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_ALERT_RULES_MODE", cfg)
	}
	// The settings write takeover needs JWT verification, MySQL and Redis only.
	// It reads no Mongo collection, starts no worker and calls no upstream
	// service, so it does not require MONGO_URI.
	if cfg.GraphQLSettingsWriteMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_SETTINGS_WRITE_MODE", cfg)
	}
	// The source-policy write takeover needs the same JWT/MySQL/Redis stack. It
	// stores SystemSetting documents and refreshes shared Redis keys only; there
	// is no Mongo collection, worker, queue or upstream call.
	if cfg.GraphQLSourcePolicyWriteMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE", cfg)
	}
	// The knowledge-graph evidence review takeover needs JWT verification, MySQL
	// and Redis only. It reads no Mongo collection, starts no worker and calls
	// no model or crawl upstream, so it does not require MONGO_URI.
	if cfg.GraphQLKnowledgeReviewMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE", cfg)
	}
	// The RSS translation takeover needs JWT verification, MySQL, Redis and
	// Mongo: processeditems and llmrequestlogs live in Mongo, the two
	// translation caches live in Redis and the daily metrics row lives in
	// MySQL. Provider URLs, keys, profiles and the encryption key are resolved
	// per request and are not startup conditions; no provider is probed.
	if cfg.GraphQLRssTranslationMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_RSS_TRANSLATION_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_GRAPHQL_RSS_TRANSLATION_MODE=go")
		}
	}
	// The assistant write takeover needs JWT verification, MySQL, Redis and
	// Mongo: assistantruns and llmrequestlogs live in Mongo, the BullMQ queue
	// and the subscription bus in Redis, and the quota/settings/profiles in
	// MySQL. It starts no worker and does not probe LiteLLM or the model
	// service at startup.
	if cfg.GraphQLAssistantWriteMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_ASSISTANT_WRITE_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_GRAPHQL_ASSISTANT_WRITE_MODE=go")
		}
	}
	// The assistant worker needs MySQL, Redis and Mongo but no JWT: it consumes
	// the queue and writes runs/logs without serving HTTP.
	if cfg.AssistantWorkerMode == "go" {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ASSISTANT_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ASSISTANT_WORKER_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ASSISTANT_WORKER_MODE=go")
		}
	}

	// The situation monitor signals takeover needs the credentialed auth stack
	// plus Redis (the cached signal state) and Mongo (feedback writes
	// situationsignalfeedbacks and situationsignallearningstates).
	if cfg.SituationSignalsMode == SituationSignalsModeGo {
		appendAuthRequirements(&errs, "API_GO_SITUATION_MONITOR_SIGNALS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go")
		}
	}

	if cfg.EconomicDataMode == EconomicDataModeGo {
		if cfg.JWTSecret == "" {
			errs = append(errs, "JWT_SECRET is required when API_GO_ECONOMIC_DATA_MODE=go")
		}
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ECONOMIC_DATA_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ECONOMIC_DATA_MODE=go")
		}
	}
	if cfg.EconomicDataWorkerMode == EconomicDataWorkerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ECONOMIC_DATA_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ECONOMIC_DATA_WORKER_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ECONOMIC_DATA_WORKER_MODE=go")
		}
	}
	// The insights takeover reads ProcessedItem/RawItem and the two Mongo
	// learning-state documents, and uses the same JWT/MySQL/Redis stack as the
	// signals routes.
	if cfg.SituationInsightsMode == SituationInsightsModeGo {
		appendAuthRequirements(&errs, "API_GO_SITUATION_INSIGHTS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_SITUATION_INSIGHTS_MODE=go")
		}
	}
	// The situation settings takeover reads and writes the settings row (MySQL
	// + Redis envelope), builds the quality summary through the insights
	// pipeline (Mongo) and encrypts credentials with the shared
	// system-settings:v1 envelope. The encryption key is therefore a startup
	// requirement in go mode; a malformed key keeps the per-request 400 /
	// decrypt-as-absent behavior documented by the service.
	if cfg.SituationSettingsMode == SituationSettingsModeGo {
		appendAuthRequirements(&errs, "API_GO_SITUATION_SETTINGS_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_SITUATION_SETTINGS_MODE=go")
		}
		if cfg.SettingsEncryptionKeyRaw == "" {
			errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required when API_GO_SITUATION_SETTINGS_MODE=go")
		}
	}
	// The manual LLM backfill enqueue route authenticates a human or machine
	// caller, reads the Mongo failure group, writes its claim and adds a BullMQ
	// job, so it needs the full stack. The recovery worker consumes the same
	// queue and writes the same Mongo/MySQL records but serves no HTTP request,
	// so JWT_SECRET is not a startup condition for it. The six-hour association
	// refresh needs MySQL and Redis only: it reuses the newsindicator refresh
	// and its organization session lock, and writes no Mongo document.
	if cfg.NewsClusteringLlmBackfillMode == NewsClusteringLlmBackfillModeGo {
		appendAuthRequirements(&errs, "API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE", cfg)
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE=go")
		}
	}
	if cfg.NewsClusteringRecoveryWorkerMode == NewsClusteringRecoveryWorkerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE=go")
		}
	}
	if cfg.ArchivePreparationWorkerMode == ArchivePreparationWorkerModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go")
		}
		if strings.TrimSpace(cfg.SettingsEncryptionKeyRaw) == "" {
			errs = append(errs, "SYSTEM_SETTINGS_ENCRYPTION_KEY is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go")
		}
	}
	if cfg.GraphQLNewsIndicatorRefreshMode == "go" {
		appendAuthRequirements(&errs, "API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE", cfg)
	}
	if cfg.NewsIndicatorAssociationCronMode == NewsIndicatorAssociationCronModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE=go")
		}
	}
	// Both cron units are background owners like the GDELT snapshot scheduler:
	// they write MySQL rows under a Redis lease, read the Mongo processed items
	// and register no route, so every HTTP switch (and JWT_SECRET) can stay
	// legacy.
	if cfg.NewsEventsTimelineMode == NewsEventsTimelineModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_NEWS_EVENTS_TIMELINE_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_NEWS_EVENTS_TIMELINE_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_NEWS_EVENTS_TIMELINE_MODE=go")
		}
	}
	if cfg.SentimentSnapshotMode == SentimentSnapshotModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_SENTIMENT_SNAPSHOT_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_SENTIMENT_SNAPSHOT_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_SENTIMENT_SNAPSHOT_MODE=go")
		}
	}
	// The GDELT snapshot scheduler writes the MySQL history row and both Redis
	// cache layers, so it needs MySQL and Redis but no JWT: it serves no route.
	if cfg.GdeltSnapshotMode == GdeltSnapshotModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_GDELT_SNAPSHOT_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_GDELT_SNAPSHOT_MODE=go")
		}
	}
	// The realtime signal collector writes the shared Redis documents and the
	// Mongo transport tracks, and reads settings, organizations and processed
	// articles from MySQL. It serves no route, so it needs no JWT.
	if cfg.RealtimeSignalsMode == RealtimeSignalsModeGo {
		if cfg.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when API_GO_REALTIME_SIGNALS_MODE=go")
		}
		if cfg.RedisHost == "" {
			errs = append(errs, "REDIS_HOST is required when API_GO_REALTIME_SIGNALS_MODE=go")
		}
		if cfg.MongoURI == "" {
			errs = append(errs, "MONGO_URI is required when API_GO_REALTIME_SIGNALS_MODE=go")
		}
	}
	// The forced-refresh route re-derives the caller's settings.manage
	// permission from the credentialed JWT/MySQL/Redis stack.
	if cfg.GdeltSnapshotRefreshMode == GdeltSnapshotRefreshModeGo {
		appendAuthRequirements(&errs, "API_GO_GDELT_SNAPSHOT_REFRESH_MODE", cfg)
	}

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
// The returned strings are startup errors. Load only promotes them when
// PlatformGovernanceSettingsMode is go, so a legacy deployment behaves exactly
// like main even when these variables hold garbage.
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
