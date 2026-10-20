// api-go 是主后端的 Go 网关（Strangler Fig，见 docs/refactor/go-migration-adr.md）。
//
// 默认全部流量反向代理到 NestJS apps/api（LEGACY_API_URL，默认
// http://localhost:4000）。已迁移路由按四态路由表分流：
//
//	legacy — 反向代理（当前事实源）
//	shadow — NestJS 响应 + Go 实现异步差分（/api/healthz/live 与
//	         user-settings 只读 GET：rss-reader / spacetime-timeline；
//	         onboarding 在 shadow 模式下亦然）
//	canary — 已验证身份的稳定哈希小比例真实流量切 Go（CANARY_PERCENT）
//	go     — Go 原生 handler（/__go/healthz 自省；以及
//	         API_GO_USER_SETTINGS_READ_MODE=go 时的六个
//	         GET /api/user-settings/ui/*——Go-批3B：onboarding/rss-reader/
//	         spacetime-timeline/war-map/newsnow/situation-monitor 全部由
//	         统一 handler Go 接管：Go 独立 JWT 验签 + Redis blacklist +
//	         MySQL RBAC + 独立响应，不依赖 NestJS 200。兼容：
//	         API_GO_ONBOARDING_MODE=go（批3A，readMode 未设时）只接管
//	         onboarding）
//	         API_GO_PUBLIC_PORTAL_MODE=go 时另接管四个匿名 GET：
//	         /api/public-portal/home、/api/public-portal/channels/:topic、
//	         /api/public-portal/stories/id/:id 与 stories/slug/:slug
//	         （后三个都是恰好一个路径段）。
//	         API_GO_DASHBOARD_STATS_MODE=go 时另接管精确路径
//	         GET /api/dashboard/stats（MySQL + Mongo + Redis 只读）。
//	         API_GO_DASHBOARD_CHARTS_MODE=go 时另接管三个精确 GET：
//	         sector-heatmap、financial-candlestick、war-map/geojson。
//	         API_GO_DASHBOARD_WAR_MAP_MODE=go 时另接管两个精确 GET：
//	         war-map/events 与 war-map/news-markers。
//	         API_GO_DASHBOARD_SPACETIME_GEO_MODE=go 时接管热力图总览与下钻。
//	         API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE=go 时接管传播图总览与下钻。
//	         这两个开关互不影响。
//	         API_GO_DASHBOARD_STREAM_MODE=go 时接管精确 GET /api/dashboard/stream
//	         （SSE；复用 War Map、K 线和热力图服务，不请求 NestJS）。
//	         API_GO_HEALTHZ_MODE=go 时接管精确 GET /api/healthz（认证探针）。
//	         公开 GET /api/healthz/live 保持 shadow，不随该开关变化。
//	         Go-批7：API_GO_CONTENT_SUBSCRIPTIONS_MODE、
//	         API_GO_USER_NEWS_BEHAVIOR_MODE、API_GO_USER_DIGEST_MODE
//	         各自默认 legacy，只切换对应的精确 HTTP。内部订阅、目录和画像
//	         调用不看另外两个 HTTP 开关。每日摘要邮件 Cron 由独立
//	         API_GO_USER_DIGEST_DELIVERY_MODE 控制，默认 legacy 仍由 NestJS
//	         消费；该开关为 go 时 Go 每分钟执行投递链。
//	         API_GO_NEWS_SOURCES_MODE=go 时接管新闻源管理台十五条读写路由。
//	         GET /api/admin/news-sources/:id/preview 仍回 NestJS。
//	         回滚只把 API_GO_NEWS_SOURCES_MODE 改回 legacy。不入队，不启动采集。
//	         API_GO_NEWSNOW_SOURCES_MODE=go 时接管两条公开来源获取路由
//	         （GET /api/news-aggregator/source 与
//	         POST /api/news-aggregator/sources/batch）：Go 真实请求上游、
//	         写兼容 fresh/stale 缓存与刷新锁，并向
//	         newsnow:source-refresh:v1 发布来源增量供 Nest 订阅转发。
//	         只要求 DATABASE_URL/REDIS_HOST；预热与热点 Cron 仍归 Nest。
//	         回滚只把该变量改回 legacy。不启动调度、不入队。
//	         API_GO_CRAWL_WORKFLOWS_MODE=go 时接管采集策略工作流编辑接口
//	         （node-schemas、列表、详情、创建、草稿、发布、版本、对比与
//	         两条 bridge）。trial-run、replay、workflow-runs、profiles
//	         列表/创建/预览/回滚、runs、nodes 仍回 NestJS。
//	         回滚只把 API_GO_CRAWL_WORKFLOWS_MODE 改回 legacy。不入队，
//	         不启动采集 worker。
//	         API_GO_CRAWL_PROFILES_MODE=go 时接管采集站点画像的 8 条编辑
//	         接口（列表、匹配、预览、创建、详情、更新、版本、回滚）。
//	         runs、nodes、workflows 与 workflow-bridge 仍回 NestJS。
//	         回滚只把 API_GO_CRAWL_PROFILES_MODE 改回 legacy。不启用
//	         shadow，不入队，不启动采集 worker。
//	         API_GO_LLM_LOGS_MODE=go 时接管 LLM 请求日志的三条精确 GET：
//	         GET /api/llm-logs（列表）、GET /api/llm-logs/export（CSV）、
//	         GET /api/llm-logs/summary（用量汇总）。三条都要求
//	         settings.manage，orgId 由 membership/机器令牌重推导。导出保留
//	         90 天窗口、50000 行上限、公式注入防护与 MySQL 导出审计。
//	         /api/system-settings/llm-request-logs 会改 Mongo TTL 索引，不在
//	         这个开关里，仍回 NestJS。回滚只把 API_GO_LLM_LOGS_MODE 改回
//	         legacy。不启用 shadow，不调用模型服务，不启动 worker。
//
//	         API_GO_ADMIN_LOGS_MODE=go 时接管管理端日志与异常读取的 7 条
//	         精确 GET：admin/logs 的 task、task/summary、errors、
//	         errors/summary、audit，以及 admin/errors 与 admin/errors/stats。
//	         admin/quality/（含 quality/task-logs）、observability/、metrics
//	         与异常上报 POST 仍回 NestJS。回滚只把 API_GO_ADMIN_LOGS_MODE
//	         改回 legacy。不启用 shadow，不改前端，不改 canary。
//
//	         API_GO_EXCEPTION_INGEST_MODE=go takes over the two
//	         exception-report POSTs: POST /api/observability/exception-events/client
//	         (AllowAuthenticated plus the existing user/IP sliding-window
//	         buckets) and POST /api/internal/observability/exception-events
//	         (LITELLM_CONFIG_INTERNAL_TOKEN). Both write one document into the
//	         existing exceptionevents collection; the client endpoint never
//	         persists a stack and always takes orgId/userId from the
//	         server-side identity. The seven read GETs stay on
//	         API_GO_ADMIN_LOGS_MODE. Rollback only sets
//	         API_GO_EXCEPTION_INGEST_MODE back to legacy; no shadow or worker
//	         is started.
//
//	         API_GO_QUALITY_OVERVIEW_MODE=go 时接管管理端质量面板的 5 条
//	         精确 GET：admin/quality 的 news-sources、pipeline、overview、
//	         task-logs 与 task-logs/summary。新闻源质量与流水线质量复用
//	         MySQL ObservabilitySnapshot 表与 Redis 分布式锁键（与 Nest 共享
//	         60 秒快照）；流水线 quality 与任务日志的 failureTypes.errorName
//	         一样做敏感信息脱敏。admin/quality/classification/* 与
//	         admin/quality/pipeline/runs|replay|rollback 仍回 NestJS。回滚只把
//	         API_GO_QUALITY_OVERVIEW_MODE 改回 legacy。不启用 shadow，
//	         不改前端，不改 canary。
//
//	         API_GO_AUTH_FACTORS_MODE=go 时接管已认证 MFA 管理与组织 OIDC
//	         配置的 7 条精确路由：GET /api/auth/mfa、
//	         POST /api/auth/mfa/enroll|verify-enroll|disable|recovery/rotate、
//	         GET/PUT /api/auth/admin/oidc-config。人类走 JWT 验签 + Redis
//	         blacklist + MySQL membership/权限重推导，机器令牌沿用 mtk_ 查库
//	         路径。四条 MFA 写要求真实人类 User（机器身份 403），GET mfa 对
//	         机器身份仍返回空状态；OIDC 是租户设置，按 settings.manage 判定，
//	         不套全局平台管理员门禁。四条 MFA 写共用每用户 MySQL 会话锁
//	         （Nest/Go 同名互通）。go 要求 JWT_SECRET、DATABASE_URL、
//	         REDIS_HOST，不要求 Mongo。login/refresh/logout/me/
//	         change-password/machine-tokens、公开 MFA 登录与强制 enrollment
//	         挑战，以及 OIDC start/callback/handoff 仍回 NestJS。回滚只把
//	         API_GO_AUTH_FACTORS_MODE 改回 legacy。不访问身份提供方、不签发
//	         token、不启用 shadow、不改 canary。
//
//	         API_GO_CLASSIFICATION_REPORTS_MODE=go 时接管精确路由
//	         POST /api/admin/quality/classification/reports：Go 写
//	         ClassificationReportJob 并入队 classification_quality（任务名与
//	         jobId 都是 classification-quality-report:<jobId>，attempts=3、
//	         指数退避 2000ms、removeOnComplete=true、
//	         removeOnFail={age:7d,count:10000}）；GET /reports/:jobId 仍由
//	         API_GO_CLASSIFICATION_RSS_OPS_MODE 决定。回滚只把该开关改回 legacy。
//	         API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go 时由 Go 消费
//	         classification_quality（报告生成与评审种子写入），NestJS 的
//	         processor 不再建 Worker（Queue 保留，流水线仍会生产评审种子任务），
//	         执行权互斥。并发 max(1,min(4,NEWS_PROCESS_QUEUE_CONCURRENCY))，
//	         未配置为 2。回滚时先关 Go worker，再由 NestJS 继续消费同格式任务。
//	         API_GO_PIPELINE_RECOVERY_MODE=go 时接管精确 GET
//	         /api/admin/quality/pipeline/runs（MySQL ItemMeta + Mongo
//	         processeditems/tasklogs）。replay/rollback 依赖条目流水线生产者
//	         （#96 pipelineenqueue），main 上尚不存在，继续由 NestJS 服务。
//	         三个开关都默认 legacy，互不影响。
//
// 回滚：API_GO_DASHBOARD_WAR_MAP_MODE=legacy 把这两个 GET 交回 NestJS；
// API_GO_DASHBOARD_CHARTS_MODE=legacy 把三个图表交回 NestJS；
// API_GO_DASHBOARD_STATS_MODE=legacy 把 stats 交回 NestJS；
// API_GO_PUBLIC_PORTAL_MODE=legacy 把公开页交回 NestJS；
// API_GO_USER_SETTINGS_READ_MODE=shadow（或未设——回到
// API_GO_ONBOARDING_MODE 控制；或路由表单条规则改回 legacy，或
// CANARY_PERCENT=0）——无数据迁移耦合。
//
// canary 信任边界（重要）：当前分流的 orgId 取自未验签的 JWT payload
// claim，不是经过认证的组织身份。在 Go 侧对全部受保护路由完成真实
// JWT 验签与 org membership 重推导之前，canary 不得承载业务流量
// （fail-safe 一律回 legacy）。当前没有任何路由处于 ModeCanary，
// canary 仅作为待鉴权基础设施接入的分流组件存在。
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/alertqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/alertworker"
	"github.com/wei500L/newwei/apps/api-go/internal/analysisqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/assistantqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/assistantruns"
	"github.com/wei500L/newwei/apps/api-go/internal/auditoutbox"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/canary"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardspacetime"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstream"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
	"github.com/wei500L/newwei/apps/api-go/internal/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	archivereadinggraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/assistantwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	graphqlcrawlmetadata "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/crawlmetadata"
	graphqlcrawltaskwrite "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
	economicdatagraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	itemsingestgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsingest"
	itemsgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/kgimpact"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgereview"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsindicators"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsindicatorwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/orgaccesswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspacewrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/health"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
	"github.com/wei500L/newwei/apps/api-go/internal/shadowidentity"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingswrite"
)

func main() {
	// healthcheck 子命令：容器内健康探测（distroless 无 curl/wget——
	// 生产镜像用同一二进制自探活，见 infra/docker/api-go.Dockerfile）。
	// 仅当 argv[1] 恰为 "healthcheck" 时进入；其余 argv 保持原启动语义。
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck())
	}
	if err := run(); err != nil {
		log.Fatalf("api-go: %v", err)
	}
}

// runHealthcheck 以短超时 GET 本进程监听地址上的 /__go/healthz（网关
// Go 原生自省端点——不经过 legacy 代理，也不产生 shadow 执行，不会
// 污染差分指标）。返回值即进程退出码：2xx → 0；其他状态码、连接
// 失败或超时 → 1。不读取/输出环境变量、DSN、token 或响应正文——
// 失败时只报状态码这一类通用事实。
func runHealthcheck() int {
	port := "4020"
	if raw := strings.TrimSpace(os.Getenv("PORT")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			port = raw
		}
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/__go/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "api-go healthcheck: request failed")
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		fmt.Fprintf(os.Stderr, "api-go healthcheck: unexpected status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}

// dispatcher 装配 shadow runner 与 canary router，实现网关的旁路接口。
type dispatcher struct {
	shadowRunner *shadow.Runner
	canaryRouter *canary.Router
	// shadowUnits 是显式的 shadow 路由分发表（替代逐路由硬编码 if）。
	// 每个单元声明：精确 path、允许的 method、是否要求 legacy 200、
	// executant。四个单元的规模——刻意不做成注册框架。
	shadowUnits []shadowUnit
}

// shadowUnit 是一个 shadow 差分单元的接线声明。
type shadowUnit struct {
	// Path 精确匹配（不做前缀匹配——/api/user-settings/ui/onboarding-x
	// 不得误入）。
	Path string
	// Methods 允许进入差分的方法白名单（写方法绝不双发；双层强制之一）。
	Methods map[string]bool
	// RequireLegacyOK 要求 NestJS 返回 200 才执行（legacy-approved
	// shadow identity 的前提；公开探针不需要）。
	RequireLegacyOK bool
	// Executant Go 侧差分执行者。
	Executant shadow.Executant
}

// ObserveShadow 实现网关的差分观察接口。reason 非空时主链路已判定无法
// 差分（请求/响应超预算或流式响应）——只记账，不执行 Go 实现。
func (d *dispatcher) ObserveShadow(r *http.Request, legacyStatus int, legacyHeader http.Header, legacyBody []byte, reason legacyproxy.ShadowSkipReason) {
	switch legacyproxy.ShadowSkipReason(reason) {
	case legacyproxy.ShadowSkipRequestTooLarge,
		legacyproxy.ShadowSkipResponseTooLarge,
		legacyproxy.ShadowSkipStreaming:
		d.shadowRunner.ObserveSkip(shadow.SkipReason(reason))
		return
	}

	// 差分可执行：按 shadow 单元表精确分发（path + method + legacy 语义
	// 全部匹配才执行，否则静默跳过——该路由不在 shadow 单元表里）。
	for _, unit := range d.shadowUnits {
		if r.URL.Path != unit.Path {
			continue
		}
		if !unit.Methods[strings.ToUpper(r.Method)] {
			return
		}
		if unit.RequireLegacyOK && legacyStatus != http.StatusOK {
			// legacy 未认可身份（401/403/404/5xx 等）→ Go 零执行、零
			// 数据库查询。
			return
		}
		d.shadowRunner.ObserveResult(
			httpx.TraceIDFromContext(r.Context()),
			r,
			legacyStatus,
			legacyHeader,
			legacyBody,
			unit.Executant,
		)
		return
	}
}

// CanaryRoute 实现网关的 canary 分流接口。
//
// 信任边界：orgId claim 未验签。canaryRouter 的 fail-safe 语义（无 token/
// 非 JWT/无 claim → legacy）防的是「无法解析」，防不了「伪造」——伪造的
// orgId 可以选择自己这条请求进哪个实现。因此该接口只可用于：
//  1. 两个实现共享同一鉴权语义的路由（当前仅差分验证过的只读端点）；
//  2. 或在 Go 侧完成验签后（迁移序 5）再启用。
//
// 当前没有任何路由处于 ModeCanary。
func (d *dispatcher) CanaryRoute(r *http.Request) bool {
	return d.canaryRouter.Route(r.Header.Get("Authorization")) == canary.ModeGo
}

// healthLiveExecutant 是 GET /api/healthz/live 的 Go 实现（shadow 差分执行者）。
type healthLiveExecutant struct{}

func (healthLiveExecutant) Execute(_ context.Context, _ *http.Request, _ []byte) *shadow.Result {
	result := health.LiveResult()
	return &shadow.Result{
		StatusCode: result.StatusCode,
		Header:     result.Header,
		Body:       result.Body,
	}
}

// userSettingsExecutant 是六个 user-settings 只读 GET 共享的 Go shadow
// 差分执行者（Go-批2A 起步，批2B/3B 扩展——全部端点信任边界与失败语义
// 完全相同，流程只写一次，各端点注入固定 key 的查询与响应构建）。
//
// 信任边界：身份来自 legacy-approved shadow identity——只有 legacy 已
// 返回 200 时才允许从（未验签的）Bearer JWT payload 读取 sub/orgId，
// 并只用于本次只读查询。这不是「Go 已验证身份」：shadow 模式是回滚
// 兼容路径，Go 独立鉴权由 usersettingsread.Handler 承载（go 模式）。
// permissions claim 不读取。任何失败（payload 解析、数据库不可达、JSON
// 异常）都只返回通用错误 Result（503 + 通用错误体），由 runner 记入
// 差分——不影响客户端已收到的 NestJS 响应。token/orgId/userId 不进入
// 任何日志或差分正文。
type userSettingsExecutant struct {
	// repo 为 nil 表示未配置数据库：跳过（零查询），以通用错误 Result
	// 记入差分缺失——不影响客户端。
	repo usersettings.Repository
	// query 是该端点固定 key 的只读查询（编译期固定 SettingKey，
	// 不来自 URL/query/body/header）。
	query func(ctx context.Context, orgID, userID string) (usersettings.Record, error)
	// build 由数据库记录构建完整响应体（各端点自己的 normalization）。
	build func(record usersettings.Record) any
}

func (e userSettingsExecutant) Execute(ctx context.Context, r *http.Request, _ []byte) *shadow.Result {
	if e.repo == nil {
		return shadowErrorResult()
	}
	identity := shadowidentity.LegacyApprovedIdentity(r, http.StatusOK)
	if identity == nil {
		// dispatcher 已在 legacy 非 200 时拦截；这里的 nil 只可能来自
		// token 缺失/损坏——同样零数据库查询。
		return shadowErrorResult()
	}

	record, err := e.query(ctx, identity.OrgID, identity.UserID)
	if err != nil {
		// 详细错误只进服务端日志（repo 已保证不含凭据），差分结果只给
		// 通用错误体。
		log.Printf("shadow: user-settings query failed: %v", err)
		return shadowErrorResult()
	}

	body, err := json.Marshal(e.build(record))
	if err != nil {
		return shadowErrorResult()
	}
	body = append(body, '\n')
	return &shadow.Result{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}, "Cache-Control": []string{"no-store"}},
		Body:       body,
	}
}

// userSettingsShadowUnits 是 user-settings 只读 GET 的 shadow 单元表：
// 精确 path（不做前缀匹配）+ 仅 GET + RequireLegacyOK（legacy 200 是
// 身份前提）。query 闭包绑定各自端点的 repository 语义方法（key 是
// usersettings 包内的编译期常量）。五个单 key 端点共用
// userSettingsExecutant 流程（表驱动接线）；situation-monitor 是三记录
// 聚合形态，单独 executant（Go-批3B）。
func userSettingsShadowUnits(repo usersettings.Repository) []shadowUnit {
	singleKeyUnits := []struct {
		path  string
		query func(ctx context.Context, orgID, userID string) (usersettings.Record, error)
		build func(record usersettings.Record) any
	}{
		{"/api/user-settings/ui/onboarding",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindOnboarding(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildOnboardingResponse(record) }},
		{"/api/user-settings/ui/rss-reader",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindRSSReader(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildRSSReaderResponse(record) }},
		{"/api/user-settings/ui/spacetime-timeline",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindSpacetimeTimeline(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildSpacetimeTimelineResponse(record) }},
		{"/api/user-settings/ui/war-map",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindWarMap(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildWarMapResponse(record) }},
		{"/api/user-settings/ui/newsnow",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindNewsnow(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildNewsnowResponse(record) }},
	}
	units := make([]shadowUnit, 0, len(singleKeyUnits)+1)
	for _, unit := range singleKeyUnits {
		units = append(units, shadowUnit{
			Path:            unit.path,
			Methods:         map[string]bool{http.MethodGet: true},
			RequireLegacyOK: true, // 受保护端点：legacy 200 是身份前提
			Executant: userSettingsExecutant{
				repo:  repo,
				query: unit.query,
				build: unit.build,
			},
		})
	}
	// situation-monitor：一次三 key 聚合查询（Go-批3B）。
	units = append(units, shadowUnit{
		Path:            "/api/user-settings/ui/situation-monitor",
		Methods:         map[string]bool{http.MethodGet: true},
		RequireLegacyOK: true,
		Executant:       situationMonitorExecutant{repo: repo},
	})
	return units
}

// situationMonitorExecutant 是 situation-monitor GET 的 shadow 差分执行者
// （三记录聚合形态——userSettingsExecutant 是单记录形态，不强行复用）。
type situationMonitorExecutant struct {
	repo usersettings.Repository
}

func (e situationMonitorExecutant) Execute(ctx context.Context, r *http.Request, _ []byte) *shadow.Result {
	if e.repo == nil {
		return shadowErrorResult()
	}
	identity := shadowidentity.LegacyApprovedIdentity(r, http.StatusOK)
	if identity == nil {
		return shadowErrorResult()
	}
	records, err := e.repo.FindSituationMonitor(ctx, identity.OrgID, identity.UserID)
	if err != nil {
		log.Printf("shadow: situation-monitor query failed: %v", err)
		return shadowErrorResult()
	}
	body, err := json.Marshal(usersettings.BuildSituationMonitorResponse(records))
	if err != nil {
		return shadowErrorResult()
	}
	body = append(body, '\n')
	return &shadow.Result{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}, "Cache-Control": []string{"no-store"}},
		Body:       body,
	}
}

// shadowErrorResult 是 Go 侧执行失败的通用差分结果（不含任何身份/凭据/
// 业务数据；进入差分记录成为「执行缺失」信号）。
func shadowErrorResult() *shadow.Result {
	return &shadow.Result{
		StatusCode: http.StatusServiceUnavailable,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"statusCode":503,"message":"user-settings shadow execution unavailable"}` + "\n"),
	}
}

func run() error {
	cfg, err := config.LoadFromOS()
	if err != nil {
		return err
	}

	// onboarding 迁移单元的路由模式（API_GO_ONBOARDING_MODE）：
	// shadow（默认，旧行为）或 go（Go-批3A 真实接管）。
	onboardingMode := legacyproxy.ModeShadow
	if cfg.OnboardingMode == config.OnboardingModeGo {
		onboardingMode = legacyproxy.ModeGo
	}
	// user-settings 六个只读 GET 的统一读模式（API_GO_USER_SETTINGS_READ_MODE，
	// Go-批3B）：空 = 兼容旧行为（onboardingMode 单独控制 onboarding）；
	// go = 六个 GET 全部 Go 接管；shadow = 六个 GET 全部 shadow。
	// 配置层已校验合法值。
	readMode := ""
	switch cfg.UserSettingsReadMode {
	case config.UserSettingsReadModeGo:
		readMode = string(legacyproxy.ModeGo)
	case config.UserSettingsReadModeShadow:
		readMode = string(legacyproxy.ModeShadow)
	}

	writeMode := ""
	if cfg.UserSettingsWriteMode == config.UserSettingsWriteModeGo {
		writeMode = string(legacyproxy.ModeGo)
	}
	portalMode := ""
	if cfg.PublicPortalMode == config.PublicPortalModeGo {
		portalMode = string(legacyproxy.ModeGo)
	}
	dashboardMode := ""
	if cfg.DashboardStatsMode == config.DashboardStatsModeGo {
		dashboardMode = string(legacyproxy.ModeGo)
	}
	chartsMode := ""
	if cfg.DashboardChartsMode == config.DashboardChartsModeGo {
		chartsMode = string(legacyproxy.ModeGo)
	}
	warMapMode := ""
	if cfg.DashboardWarMapMode == config.DashboardWarMapModeGo {
		warMapMode = string(legacyproxy.ModeGo)
	}
	transportMode := ""
	if cfg.DashboardWarMapTransportMode == config.DashboardWarMapTransportModeGo {
		transportMode = string(legacyproxy.ModeGo)
	}
	layersMode := ""
	if cfg.DashboardWarMapLayersMode == config.DashboardWarMapLayersModeGo {
		layersMode = string(legacyproxy.ModeGo)
	}
	spacetimeGeoMode := ""
	if cfg.DashboardSpacetimeGeoMode == config.DashboardSpacetimeGeoModeGo {
		spacetimeGeoMode = string(legacyproxy.ModeGo)
	}
	spacetimePropagationMode := ""
	if cfg.DashboardSpacetimePropagationMode == config.DashboardSpacetimePropagationModeGo {
		spacetimePropagationMode = string(legacyproxy.ModeGo)
	}
	streamMode := ""
	if cfg.DashboardStreamMode == config.DashboardStreamModeGo {
		streamMode = string(legacyproxy.ModeGo)
	}
	healthzMode := ""
	if cfg.HealthzMode == config.HealthzModeGo {
		healthzMode = string(legacyproxy.ModeGo)
	}
	contentSubscriptionsMode := ""
	if cfg.ContentSubscriptionsMode == config.ContentSubscriptionsModeGo {
		contentSubscriptionsMode = string(legacyproxy.ModeGo)
	}
	userNewsBehaviorMode := ""
	if cfg.UserNewsBehaviorMode == config.UserNewsBehaviorModeGo {
		userNewsBehaviorMode = string(legacyproxy.ModeGo)
	}
	userDigestMode := ""
	if cfg.UserDigestMode == config.UserDigestModeGo {
		userDigestMode = string(legacyproxy.ModeGo)
	}
	analysisViewsMode := ""
	if cfg.AnalysisViewsMode == config.AnalysisViewsModeGo {
		analysisViewsMode = string(legacyproxy.ModeGo)
	}
	analysisBoardsMode := ""
	if cfg.AnalysisBoardsMode == config.AnalysisBoardsModeGo {
		analysisBoardsMode = string(legacyproxy.ModeGo)
	}
	analysisThreadsMode := ""
	if cfg.AnalysisThreadsMode == config.AnalysisThreadsModeGo {
		analysisThreadsMode = string(legacyproxy.ModeGo)
	}
	// The CSV export switch only ever adds the two exact POST export rules; it
	// shares no path with the collaboration units above.
	analysisExportMode := ""
	if cfg.AnalysisExportMode == config.AnalysisExportModeGo {
		analysisExportMode = string(legacyproxy.ModeGo)
	}
	archiveReadingMode := ""
	if cfg.ArchiveReadingMode == config.ArchiveReadingModeGo {
		archiveReadingMode = string(legacyproxy.ModeGo)
	}
	archiveReadingGo := cfg.ArchiveReadingMode == config.ArchiveReadingModeGo
	situationMonitorsMode := ""
	if cfg.SituationMonitorsMode == config.SituationMonitorsModeGo {
		situationMonitorsMode = string(legacyproxy.ModeGo)
	}
	situationSignalsMode := ""
	if cfg.SituationSignalsMode == config.SituationSignalsModeGo {
		situationSignalsMode = string(legacyproxy.ModeGo)
	}
	situationInsightsMode := ""
	if cfg.SituationInsightsMode == config.SituationInsightsModeGo {
		situationInsightsMode = string(legacyproxy.ModeGo)
	}
	newsSourcesMode := ""
	if cfg.NewsSourcesMode == config.NewsSourcesModeGo {
		newsSourcesMode = string(legacyproxy.ModeGo)
	}
	crawlWorkflowsMode := ""
	if cfg.CrawlWorkflowsMode == config.CrawlWorkflowsModeGo {
		crawlWorkflowsMode = string(legacyproxy.ModeGo)
	}
	crawlProfilesMode := ""
	if cfg.CrawlProfilesMode == config.CrawlProfilesModeGo {
		crawlProfilesMode = string(legacyproxy.ModeGo)
	}
	crawlFrontierRunsMode := ""
	if cfg.CrawlFrontierRunsMode == config.CrawlFrontierRunsModeGo {
		crawlFrontierRunsMode = string(legacyproxy.ModeGo)
	}
	rbacMode := ""
	if cfg.RbacMode == config.RbacModeGo {
		rbacMode = string(legacyproxy.ModeGo)
	}
	crawlTemplatesMode := ""
	if cfg.CrawlTemplatesMode == config.CrawlTemplatesModeGo {
		crawlTemplatesMode = string(legacyproxy.ModeGo)
	}
	llmLogsMode := ""
	if cfg.LlmLogsMode == config.LlmLogsModeGo {
		llmLogsMode = string(legacyproxy.ModeGo)
	}

	adminLogsMode := ""
	if cfg.AdminLogsMode == config.AdminLogsModeGo {
		adminLogsMode = string(legacyproxy.ModeGo)
	}
	exceptionIngestMode := ""
	if cfg.ExceptionIngestMode == config.ExceptionIngestModeGo {
		exceptionIngestMode = string(legacyproxy.ModeGo)
	}
	newsIndicatorsMode := ""
	if cfg.NewsIndicatorsMode == config.NewsIndicatorsModeGo {
		newsIndicatorsMode = string(legacyproxy.ModeGo)
	}
	qualityOverviewMode := ""
	if cfg.QualityOverviewMode == config.QualityOverviewModeGo {
		qualityOverviewMode = string(legacyproxy.ModeGo)
	}
	classificationRssOpsMode := ""
	if cfg.ClassificationRssOpsMode == config.ClassificationRssOpsModeGo {
		classificationRssOpsMode = string(legacyproxy.ModeGo)
	}
	newsnowClusteringOpsMode := ""
	if cfg.NewsnowClusteringOpsMode == config.NewsnowClusteringOpsModeGo {
		newsnowClusteringOpsMode = string(legacyproxy.ModeGo)
	}
	// The two public source fetch routes are an independent switch: they need
	// only MySQL and Redis, and their ownership does not overlap the nine
	// local-computation/clustering routes above.
	newsnowSourcesMode := ""
	if cfg.NewsnowSourcesMode == config.NewsnowSourcesModeGo {
		newsnowSourcesMode = string(legacyproxy.ModeGo)
	}
	newsClusteringLlmBackfillMode := ""
	if cfg.NewsClusteringLlmBackfillMode == config.NewsClusteringLlmBackfillModeGo {
		newsClusteringLlmBackfillMode = string(legacyproxy.ModeGo)
	}
	crawlReadTelemetryMode := ""
	if cfg.CrawlReadTelemetryMode == config.CrawlReadTelemetryModeGo {
		crawlReadTelemetryMode = string(legacyproxy.ModeGo)
	}
	crawlMetadataMode := ""
	if cfg.CrawlMetadataMode == config.CrawlMetadataModeGo {
		crawlMetadataMode = string(legacyproxy.ModeGo)
	}
	crawlTaskWriteMode := ""
	if cfg.CrawlTaskWriteMode == config.CrawlTaskWriteModeGo {
		crawlTaskWriteMode = string(legacyproxy.ModeGo)
	}
	crawlQueueOpsMode := ""
	if cfg.CrawlQueueOpsMode == config.CrawlQueueOpsModeGo {
		crawlQueueOpsMode = string(legacyproxy.ModeGo)
	}
	newsSourcePreviewMode := ""
	if cfg.NewsSourcePreviewMode == config.NewsSourcePreviewModeGo {
		newsSourcePreviewMode = string(legacyproxy.ModeGo)
	}
	crawlWorkflowTrialMode := ""
	if cfg.CrawlWorkflowTrialMode == config.CrawlWorkflowTrialModeGo {
		crawlWorkflowTrialMode = string(legacyproxy.ModeGo)
	}
	searchReindexMode := ""
	if cfg.SearchReindexMode == config.SearchReindexModeGo {
		searchReindexMode = string(legacyproxy.ModeGo)
	}
	runtimeSettingsMode := ""
	if cfg.RuntimeSettingsMode == config.RuntimeSettingsModeGo {
		runtimeSettingsMode = string(legacyproxy.ModeGo)
	}
	itemsReadingMode := ""
	if cfg.ItemsReadingMode == config.ItemsReadingModeGo {
		itemsReadingMode = string(legacyproxy.ModeGo)
	}
	itemsIngestMode := ""
	if cfg.ItemsIngestMode == config.ItemsIngestModeGo {
		itemsIngestMode = string(legacyproxy.ModeGo)
	}
	platformGovernanceSettingsMode := ""
	if cfg.PlatformGovernanceSettingsMode == config.PlatformGovernanceSettingsModeGo {
		platformGovernanceSettingsMode = string(legacyproxy.ModeGo)
	}
	modelAccessSettingsMode := ""
	if cfg.ModelAccessSettingsMode == config.ModelAccessSettingsModeGo {
		modelAccessSettingsMode = string(legacyproxy.ModeGo)
	}
	llmGatewayProfilesMode := ""
	if cfg.LLMGatewayProfilesMode == config.LLMGatewayProfilesModeGo {
		llmGatewayProfilesMode = string(legacyproxy.ModeGo)
	}
	// The governance/diagnostics group is an independent switch: it can be go
	// while the seven profile routes stay on NestJS, and vice versa.
	llmGatewayOpsMode := ""
	if cfg.LLMGatewayOpsMode == config.LLMGatewayOpsModeGo {
		llmGatewayOpsMode = string(legacyproxy.ModeGo)
	}
	proxyLoadBalancingMode := ""
	if cfg.ProxyLoadBalancingMode == config.ProxyLoadBalancingModeGo {
		proxyLoadBalancingMode = string(legacyproxy.ModeGo)
	}
	infrastructureSettingsMode := ""
	if cfg.InfrastructureSettingsMode == config.InfrastructureSettingsModeGo {
		infrastructureSettingsMode = string(legacyproxy.ModeGo)
	}
	// The storage connection test switch is independent of the infrastructure
	// settings switch: it only ever takes over the exact POST test route.
	storageDiagnosticsMode := ""
	if cfg.StorageDiagnosticsMode == config.StorageDiagnosticsModeGo {
		storageDiagnosticsMode = string(legacyproxy.ModeGo)
	}
	dataRuntimeSettingsMode := ""
	if cfg.DataRuntimeSettingsMode == config.DataRuntimeSettingsModeGo {
		dataRuntimeSettingsMode = string(legacyproxy.ModeGo)
	}
	emailSettingsMode := ""
	if cfg.EmailSettingsMode == config.EmailSettingsModeGo {
		emailSettingsMode = string(legacyproxy.ModeGo)
	}
	geocodingMode := ""
	if cfg.GeocodingMode == config.GeocodingModeGo {
		geocodingMode = string(legacyproxy.ModeGo)
	}
	runtimeDiagnosticsMode := ""
	if cfg.RuntimeDiagnosticsMode == config.RuntimeDiagnosticsModeGo {
		runtimeDiagnosticsMode = string(legacyproxy.ModeGo)
	}
	authFactorsMode := ""
	if cfg.AuthFactorsMode == config.AuthFactorsModeGo {
		authFactorsMode = string(legacyproxy.ModeGo)
	}
	accountSecurityMode := ""
	if cfg.AccountSecurityMode == config.AccountSecurityModeGo {
		accountSecurityMode = string(legacyproxy.ModeGo)
	}
	avatarUploadMode := ""
	if cfg.AvatarUploadMode == config.AvatarUploadModeGo {
		avatarUploadMode = string(legacyproxy.ModeGo)
	}
	userDataExportMode := ""
	if cfg.UserDataExportMode == config.UserDataExportModeGo {
		userDataExportMode = string(legacyproxy.ModeGo)
	}
	authLoginMode := ""
	if cfg.AuthLoginMode == config.AuthLoginModeGo {
		authLoginMode = string(legacyproxy.ModeGo)
	}
	identityOnboardingMode := ""
	if cfg.IdentityOnboardingMode == config.IdentityOnboardingModeGo {
		identityOnboardingMode = string(legacyproxy.ModeGo)
	}
	oidcLoginMode := ""
	if cfg.OIDCLoginMode == config.OIDCLoginModeGo {
		oidcLoginMode = string(legacyproxy.ModeGo)
	}
	economicDataGo := cfg.EconomicDataMode == config.EconomicDataModeGo
	economicDataRouteMode := ""
	if economicDataGo {
		economicDataRouteMode = string(legacyproxy.ModeGo)
	}
	economicDataWorkerGo := cfg.EconomicDataWorkerMode == config.EconomicDataWorkerModeGo
	// The GDELT external snapshot entry has its own switch: it can be go while
	// the scheduler stays on NestJS and vice versa. Both executions share the
	// Redis rebuild lease, so a mixed deployment still rebuilds at most once.
	gdeltSnapshotRefreshMode := ""
	if cfg.GdeltSnapshotRefreshMode == config.GdeltSnapshotRefreshModeGo {
		gdeltSnapshotRefreshMode = string(legacyproxy.ModeGo)
	}
	rules := legacyproxy.DefaultRulesWithWrite(onboardingMode, readMode, writeMode)
	rules = legacyproxy.WithPublicPortal(rules, portalMode)
	rules = legacyproxy.WithDashboardStats(rules, dashboardMode)
	rules = legacyproxy.WithDashboardCharts(rules, chartsMode)
	rules = legacyproxy.WithDashboardWarMap(rules, warMapMode)
	rules = legacyproxy.WithDashboardWarMapTransport(rules, transportMode)
	rules = legacyproxy.WithDashboardWarMapLayers(rules, layersMode)
	rules = legacyproxy.WithDashboardSpacetimeGeo(rules, spacetimeGeoMode)
	rules = legacyproxy.WithDashboardSpacetimePropagation(rules, spacetimePropagationMode)
	rules = legacyproxy.WithDashboardStream(rules, streamMode)
	rules = legacyproxy.WithAuthenticatedHealth(rules, healthzMode)
	rules = legacyproxy.WithContentSubscriptions(rules, contentSubscriptionsMode)
	rules = legacyproxy.WithUserNewsBehavior(rules, userNewsBehaviorMode)
	rules = legacyproxy.WithUserDigest(rules, userDigestMode)
	rules = legacyproxy.WithAnalysisViews(rules, analysisViewsMode)
	rules = legacyproxy.WithAnalysisBoards(rules, analysisBoardsMode)
	rules = legacyproxy.WithAnalysisThreads(rules, analysisThreadsMode)
	rules = legacyproxy.WithAnalysisExport(rules, analysisExportMode)
	// The archive reading switch owns only the exact search export route; the
	// three GraphQL roots are registered with the shared GraphQL handler.
	rules = legacyproxy.WithArchiveReadingSearch(rules, archiveReadingMode)
	// /graphql is routed to the Go handler when the read switch or any of the
	// organization/workspace/settings/source-policy/knowledge-review/RSS
	// translation write
	// switch is go. The registered roots and their own switches decide which
	// documents actually execute in Go; everything else is still proxied to
	// NestJS.
	// Realtime GraphQL subscriptions own only legal graphql-transport-ws
	// upgrades on exact /graphql. They are independent of the HTTP read/write
	// switches: non-upgrade methods keep following those switches and every
	// non-local operation is forwarded whole to NestJS.
	graphqlSubscriptionsGo := cfg.GraphQLSubscriptionsMode == config.GraphQLSubscriptionsModeGo
	graphqlRouteMode := ""
	if cfg.GraphQLReadMode == "go" || cfg.GraphQLOrgAccessWriteMode == "go" || cfg.GraphQLWorkspaceWriteMode == "go" ||
		cfg.GraphQLSettingsWriteMode == "go" || cfg.GraphQLSourcePolicyWriteMode == "go" ||
		cfg.GraphQLKnowledgeReviewMode == "go" || cfg.GraphQLRssTranslationMode == "go" ||
		cfg.ItemsIngestMode == config.ItemsIngestModeGo ||
		archiveReadingGo ||
		economicDataGo ||
		cfg.GraphQLAlertRulesMode == "go" ||
		cfg.CrawlTaskWriteMode == config.CrawlTaskWriteModeGo ||
		cfg.GraphQLNewsIndicatorRefreshMode == "go" ||
		cfg.GraphQLAssistantWriteMode == "go" ||
		cfg.AnalysisRunsMode == config.AnalysisRunsModeGo ||
		graphqlSubscriptionsGo {
		graphqlRouteMode = string(legacyproxy.ModeGo)
	}
	rules = legacyproxy.WithGraphQLRead(rules, graphqlRouteMode)
	rules = legacyproxy.WithSituationMonitors(rules, situationMonitorsMode)
	rules = legacyproxy.WithSituationSignals(rules, situationSignalsMode)
	rules = legacyproxy.WithSituationInsights(rules, situationInsightsMode)
	rules = legacyproxy.WithNewsSources(rules, newsSourcesMode)
	rules = legacyproxy.WithCrawlWorkflows(rules, crawlWorkflowsMode)
	rules = legacyproxy.WithCrawlProfiles(rules, crawlProfilesMode)
	rules = legacyproxy.WithCrawlFrontierRuns(rules, crawlFrontierRunsMode)
	rules = legacyproxy.WithRbac(rules, rbacMode)
	rules = legacyproxy.WithCrawlTemplates(rules, crawlTemplatesMode)
	rules = legacyproxy.WithCrawlMetadata(rules, crawlMetadataMode)
	rules = legacyproxy.WithNewsSourcePreview(rules, newsSourcePreviewMode)
	rules = legacyproxy.WithCrawlWorkflowTrial(rules, crawlWorkflowTrialMode)
	rules = legacyproxy.WithLlmLogs(rules, llmLogsMode)
	rules = legacyproxy.WithAdminLogs(rules, adminLogsMode)
	// The exception ingest takeover is registered next to the admin logs
	// takeover. The two switches are independent and their paths do not
	// overlap, so both may be go at the same time.
	rules = legacyproxy.WithExceptionIngest(rules, exceptionIngestMode)
	rules = legacyproxy.WithNewsIndicators(rules, newsIndicatorsMode)
	rules = legacyproxy.WithQualityOverview(rules, qualityOverviewMode)
	rules = legacyproxy.WithClassificationRssOps(rules, classificationRssOpsMode)
	// The report creation POST and the pipeline recovery runs read are their own
	// switches: each only owns one route, and neither widens the classification
	// read takeover above.
	reportsMode := ""
	if cfg.ClassificationReportsMode == config.ClassificationReportsModeGo {
		reportsMode = string(legacyproxy.ModeGo)
	}
	rules = legacyproxy.WithClassificationReports(rules, reportsMode)
	pipelineRecoveryMode := ""
	if cfg.PipelineRecoveryMode == config.PipelineRecoveryModeGo {
		pipelineRecoveryMode = string(legacyproxy.ModeGo)
	}
	rules = legacyproxy.WithPipelineRecovery(rules, pipelineRecoveryMode)
	rules = legacyproxy.WithNewsnowClusteringOps(rules, newsnowClusteringOpsMode)
	// The two public source fetch routes. Registered after the local-computation
	// rules; the two rule sets share no path.
	rules = legacyproxy.WithNewsnowSources(rules, newsnowSourcesMode)
	// The manual LLM backfill route has its own switch. It is registered next
	// to the nine-route clustering takeover but never widens it.
	rules = legacyproxy.WithNewsClusteringLlmBackfill(rules, newsClusteringLlmBackfillMode)
	rules = legacyproxy.WithCrawlReadTelemetry(rules, crawlReadTelemetryMode)
	// The lifecycle write routes and the queue administration routes are two
	// independent switches. Their rules are method-scoped, so they coexist with
	// the GET-only crawl read rules on the same prefixes.
	rules = legacyproxy.WithCrawlTaskWrite(rules, crawlTaskWriteMode)
	rules = legacyproxy.WithCrawlQueueOps(rules, crawlQueueOpsMode)
	rules = legacyproxy.WithSearchReindex(rules, searchReindexMode)
	rules = legacyproxy.WithRuntimeSettings(rules, runtimeSettingsMode)
	// The platform governance settings group is registered alongside the runtime
	// settings group. The two switches are independent and their paths do not
	// overlap, so both may be go at the same time.
	rules = legacyproxy.WithPlatformGovernanceSettings(rules, platformGovernanceSettingsMode)
	rules = legacyproxy.WithItemsReading(rules, itemsReadingMode)
	// POST /api/items is a separate exact rule from the two reading GETs and
	// shares their handler key; the registered dispatcher below splits methods.
	rules = legacyproxy.WithItemsIngest(rules, itemsIngestMode)
	rules = legacyproxy.WithModelAccessSettings(rules, modelAccessSettingsMode)
	rules = legacyproxy.WithLLMGatewayProfiles(rules, llmGatewayProfilesMode)
	// The governance/diagnostics rules are exact/one-segment rules whose prefixes
	// are longer than the profile dynamic rule, so they win naturally when both
	// switches are go and are ignored entirely when this switch is legacy.
	rules = legacyproxy.WithLLMGatewayOps(rules, llmGatewayOpsMode)
	// The proxy load balancing group is independent of the model access group:
	// only its four routes are registered, and its exact rules win over the
	// llm-gateways :id profile rule because they are longer prefixes.
	rules = legacyproxy.WithProxyLoadBalancing(rules, proxyLoadBalancingMode)
	rules = legacyproxy.WithInfrastructureSettings(rules, infrastructureSettingsMode)
	// The storage connection test is registered by its own switch; it never
	// widens the infrastructure settings route ownership and vice versa.
	rules = legacyproxy.WithStorageDiagnostics(rules, storageDiagnosticsMode)
	rules = legacyproxy.WithDataRuntimeSettings(rules, dataRuntimeSettingsMode)
	// The three settings-diagnostics groups are independent switches with
	// exact paths that never overlap an existing rule; the matcher's
	// longest-prefix rule also keeps them ahead of the platform governance
	// /assistant-safety and data runtime /realtime-signals rules.
	rules = legacyproxy.WithEmailSettings(rules, emailSettingsMode)
	rules = legacyproxy.WithGeocoding(rules, geocodingMode)
	rules = legacyproxy.WithRuntimeDiagnostics(rules, runtimeDiagnosticsMode)
	// The forced GDELT snapshot refresh is one exact POST with its own switch.
	// The scheduler switch is independent and shares only the Redis lease.
	rules = legacyproxy.WithGdeltSnapshotRefresh(rules, gdeltSnapshotRefreshMode)
	rules = legacyproxy.WithAuthFactors(rules, authFactorsMode)
	rules = legacyproxy.WithAccountSecurity(rules, accountSecurityMode)
	// The login/session/email-code unit owns eleven exact POST paths under
	// /api/auth. It is registered after the two neighbouring auth units; the
	// three rule sets share no path, so the order between them is irrelevant.
	rules = legacyproxy.WithAuthLogin(rules, authLoginMode)
	// The registration/invitation unit owns fourteen exact or one-segment paths
	// under /api/auth. It shares no path with the three neighbouring auth units,
	// so the order between them is irrelevant.
	rules = legacyproxy.WithIdentityOnboarding(rules, identityOnboardingMode)
	// The three public organization-SSO entries are an independent auth unit
	// with its own switch; no OIDC configuration CRUD is registered here.
	rules = legacyproxy.WithOIDCLogin(rules, oidcLoginMode)
	rules = legacyproxy.WithEconomicData(rules, economicDataRouteMode)
	// The two remaining identity entries have independent switches and exact
	// method/path rules, so they cannot be shadowed by the account-security,
	// login or onboarding rules.
	rules = legacyproxy.WithAccountData(rules, avatarUploadMode, userDataExportMode)
	gateway, err := legacyproxy.New(cfg.LegacyAPIURL, rules)
	if err != nil {
		return err
	}
	gateway.SetShadowBudget(legacyproxy.ShadowBudget{
		MaxRequestBodyByte:     cfg.ShadowMaxRequestBodyByte,
		MaxResponseCaptureByte: cfg.ShadowMaxResponseCaptureByte,
	})

	// user-settings shadow 的数据库能力（非阻断）：无 DATABASE_URL 时不配置，
	// 网关照常启动代理；差分执行时发现未配置即跳过（不查询、不失败上抛）。
	// onboarding go 模式下同一连接池被 authz/onboarding 复用（config 已
	// 保证 DATABASE_URL 非空；此处 DSN 无效直接启动失败——Go 接管端点
	// 不得带病启动）。
	var userSettingsRepo usersettings.Repository
	var settingsMySQL *usersettings.MySQLRepository
	userSettingsDBStatus := "unconfigured"
	var sharedDB *sql.DB
	if cfg.DatabaseURL != "" {
		db, err := usersettings.OpenMySQLFromURL(cfg.DatabaseURL)
		if err != nil {
			// DSN 无效不阻断启动：网关继续纯代理，shadow 单元执行时跳过
			//（错误不含 DSN 原文）。go 接管模式（两变量任一）下直接启动
			// 失败——Go 接管端点不得带病启动。
			if cfg.OnboardingMode == config.OnboardingModeGo ||
				cfg.UserSettingsReadMode == config.UserSettingsReadModeGo ||
				cfg.PublicPortalMode == config.PublicPortalModeGo ||
				cfg.DashboardStatsMode == config.DashboardStatsModeGo ||
				cfg.DashboardChartsMode == config.DashboardChartsModeGo ||
				cfg.DashboardWarMapMode == config.DashboardWarMapModeGo ||
				cfg.DashboardWarMapTransportMode == config.DashboardWarMapTransportModeGo ||
				cfg.DashboardWarMapLayersMode == config.DashboardWarMapLayersModeGo ||
				cfg.DashboardSpacetimeGeoMode == config.DashboardSpacetimeGeoModeGo ||
				cfg.DashboardSpacetimePropagationMode == config.DashboardSpacetimePropagationModeGo ||
				cfg.DashboardStreamMode == config.DashboardStreamModeGo ||
				cfg.HealthzMode == config.HealthzModeGo ||
				cfg.ContentSubscriptionsMode == config.ContentSubscriptionsModeGo ||
				cfg.UserNewsBehaviorMode == config.UserNewsBehaviorModeGo ||
				cfg.UserDigestMode == config.UserDigestModeGo ||
				cfg.AnalysisViewsMode == config.AnalysisViewsModeGo ||
				cfg.AnalysisBoardsMode == config.AnalysisBoardsModeGo ||
				cfg.AnalysisThreadsMode == config.AnalysisThreadsModeGo ||
				cfg.GraphQLReadMode == "go" ||
				cfg.GraphQLOrgAccessWriteMode == "go" ||
				cfg.GraphQLWorkspaceWriteMode == "go" ||
				cfg.GraphQLAlertRulesMode == "go" ||
				cfg.GraphQLSettingsWriteMode == "go" ||
				cfg.GraphQLSourcePolicyWriteMode == "go" ||
				cfg.GraphQLRssTranslationMode == "go" ||
				cfg.GraphQLAssistantWriteMode == "go" ||
				cfg.AssistantWorkerMode == "go" ||
				cfg.SituationMonitorsMode == config.SituationMonitorsModeGo ||
				cfg.NewsSourcesMode == config.NewsSourcesModeGo ||
				cfg.CrawlWorkflowsMode == config.CrawlWorkflowsModeGo ||
				cfg.CrawlProfilesMode == config.CrawlProfilesModeGo ||
				cfg.CrawlFrontierRunsMode == config.CrawlFrontierRunsModeGo ||
				cfg.RbacMode == config.RbacModeGo ||
				cfg.CrawlTemplatesMode == config.CrawlTemplatesModeGo ||
				cfg.AdminLogsMode == config.AdminLogsModeGo ||
				cfg.QualityOverviewMode == config.QualityOverviewModeGo ||
				cfg.ClassificationRssOpsMode == config.ClassificationRssOpsModeGo ||
				cfg.ClassificationReportsMode == config.ClassificationReportsModeGo ||
				cfg.ClassificationQualityWorkerMode == config.ClassificationQualityWorkerModeGo ||
				cfg.PipelineRecoveryMode == config.PipelineRecoveryModeGo ||
				cfg.NewsnowClusteringOpsMode == config.NewsnowClusteringOpsModeGo ||
				cfg.NewsClusteringLlmBackfillMode == config.NewsClusteringLlmBackfillModeGo ||
				cfg.NewsClusteringRecoveryWorkerMode == config.NewsClusteringRecoveryWorkerModeGo ||
				cfg.GraphQLNewsIndicatorRefreshMode == "go" ||
				cfg.NewsIndicatorAssociationCronMode == config.NewsIndicatorAssociationCronModeGo ||
				cfg.RuntimeSettingsMode == config.RuntimeSettingsModeGo ||
				cfg.ModelAccessSettingsMode == config.ModelAccessSettingsModeGo ||
				cfg.LLMGatewayProfilesMode == config.LLMGatewayProfilesModeGo ||
				cfg.InfrastructureSettingsMode == config.InfrastructureSettingsModeGo ||
				cfg.StorageDiagnosticsMode == config.StorageDiagnosticsModeGo ||
				cfg.DataRuntimeSettingsMode == config.DataRuntimeSettingsModeGo ||
				cfg.AuthFactorsMode == config.AuthFactorsModeGo ||
				cfg.AccountSecurityMode == config.AccountSecurityModeGo ||
				cfg.AuthLoginMode == config.AuthLoginModeGo ||
				cfg.IdentityOnboardingMode == config.IdentityOnboardingModeGo ||
				cfg.OIDCLoginMode == config.OIDCLoginModeGo ||
				cfg.LlmLogsMode == config.LlmLogsModeGo ||
				cfg.CrawlReadTelemetryMode == config.CrawlReadTelemetryModeGo ||
				cfg.CrawlMetadataMode == config.CrawlMetadataModeGo ||
				cfg.CrawlTaskWriteMode == config.CrawlTaskWriteModeGo ||
				cfg.CrawlQueueOpsMode == config.CrawlQueueOpsModeGo ||
				cfg.SearchReindexMode == config.SearchReindexModeGo ||
				cfg.NewsIndicatorsMode == config.NewsIndicatorsModeGo ||
				cfg.ItemsReadingMode == config.ItemsReadingModeGo ||
				cfg.ExceptionIngestMode == config.ExceptionIngestModeGo ||
				cfg.ProxyLoadBalancingMode == config.ProxyLoadBalancingModeGo ||
				cfg.AnalysisExportMode == config.AnalysisExportModeGo ||
				cfg.ArchiveReadingMode == config.ArchiveReadingModeGo ||
				cfg.GdeltSnapshotMode == config.GdeltSnapshotModeGo ||
				cfg.GdeltSnapshotRefreshMode == config.GdeltSnapshotRefreshModeGo ||
				cfg.AnalysisRunsMode == config.AnalysisRunsModeGo ||
				cfg.AnalysisWorkerMode == config.AnalysisWorkerModeGo ||
				cfg.GraphQLKnowledgeReviewMode == "go" ||
				cfg.PlatformGovernanceSettingsMode == config.PlatformGovernanceSettingsModeGo ||
				cfg.UserDigestDeliveryMode == config.UserDigestDeliveryModeGo ||
				cfg.AuditOutboxMode == config.AuditOutboxModeGo ||
				cfg.NewsnowSourcesMode == config.NewsnowSourcesModeGo ||
				cfg.ItemsIngestMode == config.ItemsIngestModeGo ||
				cfg.RawItemOutboxMode == config.RawItemOutboxModeGo ||
				cfg.EconomicDataMode == config.EconomicDataModeGo ||
				cfg.EconomicDataWorkerMode == config.EconomicDataWorkerModeGo ||
				cfg.EmailSettingsMode == config.EmailSettingsModeGo ||
				cfg.GeocodingMode == config.GeocodingModeGo ||
				cfg.RuntimeDiagnosticsMode == config.RuntimeDiagnosticsModeGo ||
				graphqlSubscriptionsGo {
				return fmt.Errorf("api-go: go takeover requires a valid DATABASE_URL: %w", err)
			}
			log.Printf("api-go: user-settings shadow database not initialized (invalid DATABASE_URL): %v", err)
			userSettingsDBStatus = "invalid"
		} else {
			// sql.Open 是惰性初始化：只代表 DSN 成功解析为 driver 配置，
			// 不证明数据库可连接。连接性由真实查询按需建立（失败只影响
			// shadow 差分，不影响 legacy 响应）——不引入启动 Ping/探针/
			// 重试，数据库连通性也不是网关的存活条件。
			settingsMySQL = usersettings.NewMySQLRepository(db)
			userSettingsRepo = settingsMySQL
			userSettingsDBStatus = "configured"
			sharedDB = db
		}
	}

	// go 接管模式的 Go 鉴权/响应栈装配（Go-批3A 引入，批3B 收敛为六个
	// user-settings 只读 GET 的统一 handler）：
	// authn（JWT 验签 + Redis blacklist）→ authz（MySQL membership/
	// permission 重推导，复用同一 *sql.DB 连接池）→ authhttp（契约错误）
	// → usersettingsread handler（六端点共享：固定 repository 查询 +
	// normalization + 响应构造）。
	// 两变量任一为 go 即装配（UserSettingsReadMode=go 是六端点全接管；
	// OnboardingMode=go 单独设置时同一栈也覆盖统一 handler 的 onboarding
	// 分支——但路由表只在 readMode 空时把 onboarding 切 go，此时其余五
	// 端点仍 shadow/legacy，handler 对未接管路径不会被路由命中）。
	// 两者都非 go 时完全不装配（零额外连接、旧行为不变）。
	goTakeover := cfg.OnboardingMode == config.OnboardingModeGo ||
		cfg.UserSettingsReadMode == config.UserSettingsReadModeGo
	dashboardGo := cfg.DashboardStatsMode == config.DashboardStatsModeGo
	chartsGo := cfg.DashboardChartsMode == config.DashboardChartsModeGo
	warMapGo := cfg.DashboardWarMapMode == config.DashboardWarMapModeGo
	transportGo := cfg.DashboardWarMapTransportMode == config.DashboardWarMapTransportModeGo
	layersGo := cfg.DashboardWarMapLayersMode == config.DashboardWarMapLayersModeGo
	spacetimeGeoGo := cfg.DashboardSpacetimeGeoMode == config.DashboardSpacetimeGeoModeGo
	spacetimePropagationGo := cfg.DashboardSpacetimePropagationMode == config.DashboardSpacetimePropagationModeGo
	streamGo := cfg.DashboardStreamMode == config.DashboardStreamModeGo
	healthzGo := cfg.HealthzMode == config.HealthzModeGo
	personalNewsGo := cfg.ContentSubscriptionsMode == config.ContentSubscriptionsModeGo ||
		cfg.UserNewsBehaviorMode == config.UserNewsBehaviorModeGo ||
		cfg.UserDigestMode == config.UserDigestModeGo
	analysisGo := cfg.AnalysisViewsMode == config.AnalysisViewsModeGo ||
		cfg.AnalysisBoardsMode == config.AnalysisBoardsModeGo ||
		cfg.AnalysisThreadsMode == config.AnalysisThreadsModeGo
	// user-settings、dashboard、stream、认证版 healthz、个人内容和分析工作台共用 JWT/Redis/MySQL 鉴权栈。
	graphqlReadGo := cfg.GraphQLReadMode == "go"
	// 组织、角色与成员管理的 8 个 mutation 由独立开关控制，与读开关解耦：
	// 只开写入时 queries 仍走 NestJS，也不需要 Mongo。
	graphqlOrgAccessWriteGo := cfg.GraphQLOrgAccessWriteMode == "go"
	// 工作台交互写入的 8 个 mutation（通知、看板、告警渠道与告警状态）同样由
	// 独立开关控制，与读开关解耦；复用 workspace/alerts/history 的模型不要求
	// Mongo、模型网关或队列。
	graphqlWorkspaceWriteGo := cfg.GraphQLWorkspaceWriteMode == "go"
	// The alert rule unit is independent of the read switch: alertRules itself
	// writes (default backfill + schedule + evaluation), so the read root and
	// the three rule mutations move together behind one switch.
	graphqlAlertRulesGo := cfg.GraphQLAlertRulesMode == "go"
	// The source-policy version switch is independent of the read switch and of
	// every other write switch. It needs only the credentialed
	// JWT/MySQL/Redis stack.
	sourcePolicyWriteGo := cfg.GraphQLSourcePolicyWriteMode == "go"
	// 知识图谱证据人工复核的单个 mutation 由独立开关控制，与全部读开关解耦：
	// 只开写入时图谱十个只读 root 仍走 NestJS，也不需要 Mongo。它复用
	// knowledgegraph 的设置缓存端口与 settingscrawl 的复核投影模型。
	graphqlKnowledgeReviewGo := cfg.GraphQLKnowledgeReviewMode == "go"
	// The RSS translation write switch is independent of the read switches and
	// the other write switches; it needs MySQL, Redis and Mongo and registers
	// only the translateRssItems mutation.
	graphqlRssTranslationGo := cfg.GraphQLRssTranslationMode == "go"
	// The assistant write takeover registers only the four assistant mutations.
	// It is independent of every read switch; the worker switch is separate and
	// may be enabled in a different process.
	graphqlAssistantWriteGo := cfg.GraphQLAssistantWriteMode == "go"
	assistantWorkerGo := cfg.AssistantWorkerMode == "go"
	situationMonitorsGo := cfg.SituationMonitorsMode == config.SituationMonitorsModeGo
	newsSourcesGo := cfg.NewsSourcesMode == config.NewsSourcesModeGo
	crawlWorkflowsGo := cfg.CrawlWorkflowsMode == config.CrawlWorkflowsModeGo
	crawlProfilesGo := cfg.CrawlProfilesMode == config.CrawlProfilesModeGo
	crawlFrontierRunsGo := cfg.CrawlFrontierRunsMode == config.CrawlFrontierRunsModeGo
	rbacGo := cfg.RbacMode == config.RbacModeGo
	crawlTemplatesGo := cfg.CrawlTemplatesMode == config.CrawlTemplatesModeGo
	llmLogsGo := cfg.LlmLogsMode == config.LlmLogsModeGo
	adminLogsGo := cfg.AdminLogsMode == config.AdminLogsModeGo
	newsIndicatorsGo := cfg.NewsIndicatorsMode == config.NewsIndicatorsModeGo
	qualityOverviewGo := cfg.QualityOverviewMode == config.QualityOverviewModeGo
	newsnowClusteringOpsGo := cfg.NewsnowClusteringOpsMode == config.NewsnowClusteringOpsModeGo
	crawlReadTelemetryGo := cfg.CrawlReadTelemetryMode == config.CrawlReadTelemetryModeGo
	crawlMetadataGo := cfg.CrawlMetadataMode == config.CrawlMetadataModeGo
	// The crawl task lifecycle writes and the queue administration routes are
	// independent switches; both reuse the credentialed JWT/MySQL/Redis stack
	// and the shared BullMQ producer.
	crawlTaskWriteGo := cfg.CrawlTaskWriteMode == config.CrawlTaskWriteModeGo
	crawlQueueOpsGo := cfg.CrawlQueueOpsMode == config.CrawlQueueOpsModeGo
	// The two crawl discovery entries are independent switches: the preview GET
	// and the crawl-strategy trial/replay POSTs share the crawl4ai client and the
	// metadata Service but never gate each other.
	newsSourcePreviewGo := cfg.NewsSourcePreviewMode == config.NewsSourcePreviewModeGo
	crawlWorkflowTrialGo := cfg.CrawlWorkflowTrialMode == config.CrawlWorkflowTrialModeGo
	// The metadata GraphQL root is a child of the read pilot; it can only be
	// registered when the read executor itself is assembled.
	graphqlCrawlMetadataGo := graphqlReadGo && cfg.GraphQLCrawlMetadataMode == "go"
	itemsReadingGo := cfg.ItemsReadingMode == config.ItemsReadingModeGo
	// The write switch is independent of every read switch. The raw_item
	// scheduled-replay switch is independent of both write ownership and the
	// other background owners.
	itemsIngestGo := cfg.ItemsIngestMode == config.ItemsIngestModeGo
	rawItemOutboxGo := cfg.RawItemOutboxMode == config.RawItemOutboxModeGo
	// The analysis CSV export unit is independent of the item reading switch:
	// it builds its own item and news-event readers and only owns the two exact
	// POST export routes.
	analysisExportGo := cfg.AnalysisExportMode == config.AnalysisExportModeGo
	// The three analysis run mutations are an independent GraphQL write unit.
	// The worker owner is separate: it needs no JWT and no GraphQL switch.
	analysisRunsGo := cfg.AnalysisRunsMode == config.AnalysisRunsModeGo
	analysisWorkerGo := cfg.AnalysisWorkerMode == config.AnalysisWorkerModeGo
	searchReindexGo := cfg.SearchReindexMode == config.SearchReindexModeGo
	runtimeSettingsGo := cfg.RuntimeSettingsMode == config.RuntimeSettingsModeGo
	llmGatewayProfilesGo := cfg.LLMGatewayProfilesMode == config.LLMGatewayProfilesModeGo
	// The governance/diagnostics group is an independent switch, but it always
	// reuses the shared JWT/Redis/MySQL stack: the twelve routes verify tokens
	// themselves and read the governance envelope from Redis.
	llmGatewayOpsGo := cfg.LLMGatewayOpsMode == config.LLMGatewayOpsModeGo
	infrastructureSettingsGo := cfg.InfrastructureSettingsMode == config.InfrastructureSettingsModeGo
	// The storage connection test needs the credentialed stack (JWT, Redis
	// blacklist, MySQL membership re-derivation) but no Mongo.
	storageDiagnosticsGo := cfg.StorageDiagnosticsMode == config.StorageDiagnosticsModeGo
	dataRuntimeSettingsGo := cfg.DataRuntimeSettingsMode == config.DataRuntimeSettingsModeGo
	emailSettingsGo := cfg.EmailSettingsMode == config.EmailSettingsModeGo
	geocodingGo := cfg.GeocodingMode == config.GeocodingModeGo
	runtimeDiagnosticsGo := cfg.RuntimeDiagnosticsMode == config.RuntimeDiagnosticsModeGo
	authFactorsGo := cfg.AuthFactorsMode == config.AuthFactorsModeGo
	accountSecurityGo := cfg.AccountSecurityMode == config.AccountSecurityModeGo
	authLoginGo := cfg.AuthLoginMode == config.AuthLoginModeGo
	identityOnboardingGo := cfg.IdentityOnboardingMode == config.IdentityOnboardingModeGo
	oidcLoginGo := cfg.OIDCLoginMode == config.OIDCLoginModeGo
	classificationRssOpsGo := cfg.ClassificationRssOpsMode == config.ClassificationRssOpsModeGo
	// The situation monitor signals takeover needs the same credentialed stack
	// (JWT verification, Redis revocation list, MySQL membership re-derivation)
	// as the other migrated domains, so it participates in the shared assembly.
	situationSignalsGo := cfg.SituationSignalsMode == config.SituationSignalsModeGo
	// The insights takeover needs the same credentialed stack plus Mongo.
	situationInsightsGo := cfg.SituationInsightsMode == config.SituationInsightsModeGo
	platformGovernanceGo := cfg.PlatformGovernanceSettingsMode == config.PlatformGovernanceSettingsModeGo
	modelAccessSettingsGo := cfg.ModelAccessSettingsMode == config.ModelAccessSettingsModeGo
	proxyLoadBalancingGo := cfg.ProxyLoadBalancingMode == config.ProxyLoadBalancingModeGo
	exceptionIngestGo := cfg.ExceptionIngestMode == config.ExceptionIngestModeGo
	// 平行批次追加的模式全部保留（#53 frontier、#54 platform governance、#55
	// infrastructure、#56 model access、#57 situation monitor signals、#58 items
	// reading、#59 llm gateway profiles、#60 account security、#61 data runtime、
	// #62 auth factors、#63 graphql org access write、#64 exception ingest、#65
	// search reindex、#66 proxy load balancing、#67 graphql workspace write、#68 graphql settings write）。
	// 任一变量改成本批所需值都不影响其他批次接线。
	// 任一批次为 go 都需要凭据装配（JWT/Redis/MySQL）。多行 OR 便于并行批次
	// 各自就近追加，减少单行改写造成的合并冲突。
	needsCredentialedGo := goTakeover || dashboardGo || chartsGo || warMapGo ||
		transportGo || layersGo || spacetimeGeoGo || spacetimePropagationGo ||
		streamGo || healthzGo || personalNewsGo || analysisGo || graphqlReadGo ||
		situationMonitorsGo || newsSourcesGo || crawlWorkflowsGo ||
		crawlProfilesGo || crawlFrontierRunsGo || rbacGo || crawlTemplatesGo ||
		adminLogsGo || llmLogsGo || newsIndicatorsGo || qualityOverviewGo ||
		newsnowClusteringOpsGo || runtimeSettingsGo || infrastructureSettingsGo ||
		storageDiagnosticsGo || dataRuntimeSettingsGo || accountSecurityGo ||
		crawlReadTelemetryGo || crawlMetadataGo || classificationRssOpsGo ||
		platformGovernanceGo || modelAccessSettingsGo || exceptionIngestGo ||
		situationSignalsGo || situationInsightsGo || itemsReadingGo || llmGatewayProfilesGo || llmGatewayOpsGo ||
		authFactorsGo || authLoginGo || graphqlOrgAccessWriteGo ||
		graphqlWorkspaceWriteGo || graphqlAlertRulesGo || cfg.GraphQLSettingsWriteMode == "go" ||
		sourcePolicyWriteGo ||
		graphqlKnowledgeReviewGo ||
		graphqlRssTranslationGo ||
		graphqlAssistantWriteGo ||
		identityOnboardingGo || oidcLoginGo ||
		searchReindexGo || proxyLoadBalancingGo || analysisExportGo || itemsIngestGo || archiveReadingGo || economicDataGo ||
		crawlTaskWriteGo || crawlQueueOpsGo ||
		emailSettingsGo || geocodingGo || runtimeDiagnosticsGo ||
		// This batch's HTTP entries: report creation and the runs read both
		// verify the caller. The queue worker does not (see needsRedis).
		cfg.ClassificationReportsMode == config.ClassificationReportsModeGo ||
		cfg.PipelineRecoveryMode == config.PipelineRecoveryModeGo ||
		cfg.GdeltSnapshotRefreshMode == config.GdeltSnapshotRefreshModeGo ||
		newsSourcePreviewGo || crawlWorkflowTrialGo || analysisRunsGo ||
		graphqlSubscriptionsGo
	var redisClient *redis.Client
	var redisOptions *redis.Options
	var authenticator *authhttp.Authenticator
	// The background digest delivery needs the shared Redis client (tick gate,
	// organization lease and notification relay) but not the JWT/RBAC stack.
	// Keep the condition additive so delivery-only starts Redis while every
	// other mode is legacy, and the authenticator still exists only when an
	// HTTP takeover needs it. The audit outbox replay reuses the same client
	// for its cron lease and needs no JWT either. The public NewsNow source
	// fetch unit needs it for the compatible cache, refresh lock and
	// source-refresh relay, also without the credentialed JWT/RBAC stack. The
	// raw_item replay owner needs Redis for its cron lease but no JWT, the
	// economic-data worker owns the akshare consumer without JWT too, the
	// knowledge-graph ingestion scheduler takes its tick gate and org locks in
	// Redis, the classification quality/assistant workers consume their queues
	// without authenticating a caller, the GDELT snapshot scheduler shares its
	// rebuild lease in Redis, and the analysis worker consumes its queue while
	// writing Mongo/MySQL without JWT.
	needsRedis := needsCredentialedGo ||
		cfg.UserDigestDeliveryMode == config.UserDigestDeliveryModeGo ||
		cfg.AuditOutboxMode == config.AuditOutboxModeGo ||
		cfg.NewsnowSourcesMode == config.NewsnowSourcesModeGo ||
		rawItemOutboxGo ||
		economicDataWorkerGo ||
		cfg.KnowledgeGraphIngestionMode == config.KnowledgeGraphIngestionModeGo ||
		cfg.ClassificationQualityWorkerMode == config.ClassificationQualityWorkerModeGo ||
		assistantWorkerGo ||
		cfg.GdeltSnapshotMode == config.GdeltSnapshotModeGo ||
		analysisWorkerGo
	if needsRedis {
		// The blocking BullMQ XREAD reader and the queue jobctx cache share
		// this exact Redis configuration but use dedicated connections.
		redisOptions = newRedisOptions(cfg)
		redisClient = redis.NewClient(redisOptions)
	}
	if needsCredentialedGo {
		verifier := authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
		blacklist := authn.NewRedisBlacklist(redisClient)
		authenticator = authhttp.NewAuthenticator(verifier, blacklist, authz.NewMySQLRepository(sharedDB))
	}
	// The GDELT snapshot unit is shared by the optional scheduler and the
	// optional forced-refresh route. It is nil while both switches are legacy.
	gdeltSnapshot := newGdeltSnapshotUnit(cfg, sharedDB, redisClient)
	if gdeltSnapshot != nil {
		log.Printf("api-go: situation-monitor GDELT snapshot unit configured (scheduler=%s, refresh=%s)",
			cfg.GdeltSnapshotMode, cfg.GdeltSnapshotRefreshMode)
	}

	// HTTP GraphQL and the WebSocket executor share one limiter instance so
	// their local circuit breaker state cannot disagree about the same Redis
	// bucket.
	var graphqlLimiter *policy.Limiter
	if redisClient != nil {
		graphqlLimiter = policy.NewLimiter(redisClient, cfg.RateLimitLogin, cfg.RateLimitLoginWindow, cfg.RateLimitFailOpen)
	}
	// The HTTP POST and the GraphQL root share one metadata service instance.
	// It is built once, only when one of the two switches needs it, and reuses
	// the shared MySQL, Redis and outbound HTTP resources.
	var metadataService *crawlmetadata.Service
	if crawlMetadataGo || graphqlCrawlMetadataGo {
		metadataService = crawlmetadata.NewService(sharedDB, redisClient)
	}
	// The crawl task lifecycle producer is built once, only when a crawl task
	// switch is go. It reuses the shared Redis client and needs no separate
	// close; two legacy switches create no Go-side queue resource at all.
	var crawlTaskService *crawltaskwrite.Service
	if crawlTaskWriteGo || crawlQueueOpsGo {
		if sharedDB == nil || redisClient == nil {
			return fmt.Errorf("api-go: crawl task lifecycle go takeover requires mysql, jwt, and redis")
		}
		crawlTaskService = newCrawlTaskWriteService(cfg, sharedDB, redisClient)
	}
	if goTakeover {
		readHandler := usersettingsread.NewHandler(authenticator, userSettingsRepo)
		var writeHandler *usersettingswrite.Handler
		if cfg.UserSettingsWriteMode == config.UserSettingsWriteModeGo {
			if settingsMySQL == nil {
				return fmt.Errorf("api-go: user-settings write takeover requires a mysql repository")
			}
			writeHandler = usersettingswrite.NewHandler(authenticator, settingsMySQL)
			log.Printf("api-go: user-settings PUT write takeover enabled (readMode=%s)", cfg.UserSettingsReadMode)
		}
		// 同一 prefix 只能注册一个 handler。CORS 在鉴权之前：有效预检直接
		// 204；实际 GET/PUT（含 401/400/500）先写上来源头再进入原 handler。
		// 读写模式均为 go 时，路由表才会把精确路径的 OPTIONS 送进来。
		corsPolicy := cors.New(cfg.CorsOrigin)
		for _, path := range usersettingsread.Paths {
			gateway.RegisterGoHandler(path, func(w http.ResponseWriter, r *http.Request) {
				if corsPolicy.FinishOptions(w, r) {
					return
				}
				if r.Method == http.MethodOptions {
					gateway.ServeLegacy(w, r)
					return
				}
				if writeHandler != nil && r.Method == http.MethodPut {
					writeHandler.ServeHTTP(w, r)
					return
				}
				readHandler.ServeHTTP(w, r)
			})
		}
		log.Printf("api-go: user-settings read GET(s) under go takeover (JWT verify + Redis blacklist + MySQL RBAC; issuer=%s, readMode=%s, onboardingMode=%s)",
			cfg.JWTIssuer, cfg.UserSettingsReadMode, cfg.OnboardingMode)
	}

	// 公开首页、频道和故事详情：匿名，不走 JWT/RBAC。只在显式 go 模式
	// 注册。详情冷路径读取与 Nest 相同的 gateway profile 和加密凭据。
	if cfg.PublicPortalMode == config.PublicPortalModeGo {
		if sharedDB == nil {
			return fmt.Errorf("api-go: public portal go takeover requires mysql")
		}
		portal := publicportal.NewHandler(publicportal.NewMySQLStore(sharedDB), publicportal.WithGatewayEnv(publicportal.GatewayEnv{
			EncryptionKey: cfg.SettingsEncryptionKey,
			APIBase:       cfg.LiteLLMAPIBase,
			APIKey:        cfg.LiteLLMAPIKey,
			TimeoutMs:     cfg.LiteLLMTimeoutMs,
			MaxRetries:    cfg.LiteLLMMaxRetries,
		}))
		gateway.RegisterGoHandler("/api/public-portal/home", portal.ServeHome)
		gateway.RegisterGoHandler("/api/public-portal/channels/", portal.ServeChannel)
		gateway.RegisterGoHandler("/api/public-portal/stories/id/", portal.ServeStoryByID)
		gateway.RegisterGoHandler("/api/public-portal/stories/slug/", portal.ServeStoryBySlug)
		log.Printf("api-go: public portal home, channel, and story detail under go takeover")
	}

	// GET /api/dashboard/stats。只读 MySQL/Mongo/Redis，不启动队列 worker。
	// War Map 与 stats 共用这一条 Mongo 连接。
	var dashboardMongo *dashboardstats.Connection
	if dashboardGo {
		if sharedDB == nil || authenticator == nil || redisClient == nil {
			return fmt.Errorf("api-go: dashboard stats go takeover requires mysql, jwt, and redis")
		}
		mongoConn, statsHandler, err := dashboardstats.Connect(authenticator, sharedDB, redisClient, cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: API_GO_DASHBOARD_STATS_MODE=go requires a valid MONGO_URI")
		}
		dashboardMongo = mongoConn
		statsCORS := cors.New(cfg.CorsOrigin)
		gateway.RegisterGoHandler(dashboardstats.Path, func(w http.ResponseWriter, r *http.Request) {
			if statsCORS.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			statsHandler.ServeHTTP(w, r)
		})
		log.Printf("api-go: GET /api/dashboard/stats under go takeover")
	}

	// 三个图表 GET。热力图和 K 线读 MySQL 经济序列；GeoJSON 用编译进
	// 二进制的 world.geo.json。不读 Mongo，不调用 NestJS。
	// stream=go 时也构造同一 handler，供 SSE 直接读 K 线；图表路由仍只在 charts=go 时注册。
	var chartsHandler *dashboardcharts.Handler
	if chartsGo || streamGo {
		if sharedDB == nil || authenticator == nil {
			return fmt.Errorf("api-go: dashboard charts or stream go takeover requires mysql, jwt, and redis")
		}
		chartsHandler = dashboardcharts.NewHandler(authenticator, dashboardcharts.NewMySQLStore(sharedDB))
		if chartsGo {
			chartsCORS := cors.New(cfg.CorsOrigin)
			for _, path := range dashboardcharts.Paths {
				gateway.RegisterGoHandler(path, func(w http.ResponseWriter, r *http.Request) {
					if chartsCORS.FinishOptions(w, r) {
						return
					}
					if r.Method == http.MethodOptions {
						gateway.ServeLegacy(w, r)
						return
					}
					chartsHandler.ServeHTTP(w, r)
				})
			}
			log.Printf("api-go: dashboard chart GETs under go takeover")
		}
	}

	// events/news-markers、transport-detail、layers 各自注册。共用一个 handler，
	// 但未打开的路径不会进入路由表，因此仍回 NestJS。
	// stream=go 时复用这个 handler 的 ReadForStream，不因此打开那三条 HTTP。
	var warHandler *dashboardwarmap.Handler
	if warMapGo || transportGo || layersGo || streamGo {
		if sharedDB == nil || authenticator == nil || redisClient == nil {
			return fmt.Errorf("api-go: dashboard war map or stream go takeover requires mysql, jwt, and redis")
		}
		if dashboardMongo == nil {
			conn, err := dashboardstats.Open(cfg.MongoURI)
			if err != nil {
				return fmt.Errorf("api-go: war map or stream go takeover requires a valid MONGO_URI")
			}
			dashboardMongo = conn
		}
		warHandler = dashboardwarmap.NewHandler(authenticator, sharedDB, redisClient, dashboardMongo.Database(), dashboardwarmap.Runtime{
			NominatimBaseURL:        cfg.NominatimBaseURL,
			NominatimUserAgent:      cfg.NominatimUserAgent,
			NominatimEmail:          cfg.NominatimEmail,
			NominatimAcceptLanguage: cfg.NominatimAcceptLanguage,
			GeocodeTimeout:          time.Duration(cfg.GeocodeTimeoutMs) * time.Millisecond,
			GeocodeCacheTTL:         time.Duration(cfg.GeocodeCacheTTLSeconds) * time.Second,
			GeocodeNegativeTTL:      time.Duration(cfg.GeocodeNegativeTTLSeconds) * time.Second,
			GeocodeRatePerSecond:    cfg.GeocodeRatePerSecond,
			TranslationEnabled:      cfg.TranslationAPIEnabled,
			TranslationBaseURL:      cfg.TranslationAPIBaseURL,
			TranslationTimeout:      time.Duration(cfg.TranslationTimeoutMs) * time.Millisecond,
			TranslationMaxRetries:   cfg.TranslationMaxRetries,
			TranslationFallback:     cfg.TranslationFallbackEnabled,
			TranslationFallbackURL:  cfg.TranslationFallbackBaseURL,
			SettingsEncryptionKey:   cfg.SettingsEncryptionKey,
			SignalsEnabled:          cfg.RealtimeSignalsEnabled,
			SignalsTimeoutMs:        cfg.RealtimeSignalsTimeoutMs,
			OpenskyEnabled:          cfg.OpenskyEnabled,
			OpenskyDailyBudget:      cfg.OpenskyDailyCreditBudget,
			OpenskyDayIntervalSec:   cfg.OpenskyDayIntervalSec,
			OpenskyNightIntervalSec: cfg.OpenskyNightIntervalSec,
			OpenskyDayStartHour:     cfg.OpenskyDayStartHourHKT,
			OpenskyNightStartHour:   cfg.OpenskyNightStartHourHKT,
			OpenskyWarningPct:       cfg.OpenskyWarningRemainingPct,
			OpenskyCriticalPct:      cfg.OpenskyCriticalRemainingPct,
			OpenskyBaseURL:          cfg.OpenskyBaseURL,
			OpenskyTokenURL:         cfg.OpenskyTokenURL,
			OpenskyClientID:         cfg.OpenskyClientID,
			OpenskyClientSecret:     cfg.OpenskyClientSecret,
		})
		warCORS := cors.New(cfg.CorsOrigin)
		register := func(path string) {
			gateway.RegisterGoHandler(path, func(w http.ResponseWriter, r *http.Request) {
				if warCORS.FinishOptions(w, r) {
					return
				}
				if r.Method == http.MethodOptions {
					gateway.ServeLegacy(w, r)
					return
				}
				warHandler.ServeHTTP(w, r)
			})
		}
		if warMapGo {
			for _, path := range dashboardwarmap.Paths {
				register(path)
			}
			log.Printf("api-go: war map events and news-markers under go takeover")
		}
		if transportGo {
			register(dashboardwarmap.TransportPath)
			log.Printf("api-go: war map transport-detail under go takeover")
		}
		if layersGo {
			register(dashboardwarmap.LayersPath)
			log.Printf("api-go: war map layers under go takeover")
		}
	}

	// 热力图与传播图各自注册。未打开的那一组不会进入路由表，仍回 NestJS。
	// stream=go 时复用热力图读取，不因此打开热力图或传播图的 HTTP。
	var spacetimeHandler *dashboardspacetime.Handler
	if spacetimeGeoGo || spacetimePropagationGo || streamGo {
		if sharedDB == nil || authenticator == nil || redisClient == nil {
			return fmt.Errorf("api-go: dashboard spacetime or stream go takeover requires mysql, jwt, and redis")
		}
		if dashboardMongo == nil {
			conn, err := dashboardstats.Open(cfg.MongoURI)
			if err != nil {
				return fmt.Errorf("api-go: spacetime or stream go takeover requires a valid MONGO_URI")
			}
			dashboardMongo = conn
		}
		spacetimeHandler = dashboardspacetime.NewHandler(authenticator, sharedDB, redisClient, dashboardMongo.Database(), dashboardwarmap.PlaceConfig{
			BaseURL: cfg.NominatimBaseURL, UserAgent: cfg.NominatimUserAgent, Email: cfg.NominatimEmail,
			AcceptLanguage: cfg.NominatimAcceptLanguage,
			Timeout:        time.Duration(cfg.GeocodeTimeoutMs) * time.Millisecond,
			CacheTTL:       time.Duration(cfg.GeocodeCacheTTLSeconds) * time.Second,
			NegativeTTL:    time.Duration(cfg.GeocodeNegativeTTLSeconds) * time.Second,
			RatePerSecond:  cfg.GeocodeRatePerSecond,
		})
		spacetimeCORS := cors.New(cfg.CorsOrigin)
		registerSpacetime := func(path string) {
			gateway.RegisterGoHandler(path, func(w http.ResponseWriter, r *http.Request) {
				if spacetimeCORS.FinishOptions(w, r) {
					return
				}
				if r.Method == http.MethodOptions {
					gateway.ServeLegacy(w, r)
					return
				}
				spacetimeHandler.ServeHTTP(w, r)
			})
		}
		if spacetimeGeoGo {
			for _, path := range dashboardspacetime.GeoPaths {
				registerSpacetime(path)
			}
			log.Printf("api-go: spacetime geo heatmap under go takeover")
		}
		if spacetimePropagationGo {
			for _, path := range dashboardspacetime.PropagationPaths {
				registerSpacetime(path)
			}
			log.Printf("api-go: spacetime propagation under go takeover")
		}
	}

	// SSE 直接调用上面的服务。图表、War Map、热力图的 HTTP 开关保持原样。
	var streamHandler *dashboardstream.Handler
	if streamGo {
		if warHandler == nil || chartsHandler == nil || spacetimeHandler == nil {
			return fmt.Errorf("api-go: dashboard stream go takeover requires war map, charts, and spacetime services")
		}
		streamPolicy := cors.New(cfg.CorsOrigin)
		streamHandler = dashboardstream.NewHandler(authenticator, warHandler, chartsHandler, spacetimeHandler, streamPolicy)
		gateway.RegisterGoHandler(dashboardstream.Path, func(w http.ResponseWriter, r *http.Request) {
			if streamPolicy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			streamHandler.ServeHTTP(w, r)
		})
		log.Printf("api-go: GET /api/dashboard/stream under go takeover")
	}

	// 认证版健康检查。探针在请求里运行，不作为启动或 /api/healthz/live 的条件。
	// 已有的 Mongo 连接可以复用；没有时第一次探针再连接，并在退出时关闭。
	var readyHandler *health.ReadyHandler
	if healthzGo {
		if sharedDB == nil || authenticator == nil || redisClient == nil {
			return fmt.Errorf("api-go: authenticated healthz go takeover requires mysql, jwt, and redis")
		}
		deps := health.Deps{
			DB:           sharedDB,
			Redis:        redisClient,
			MongoURI:     cfg.MongoURI,
			CrawlBase:    cfg.CrawlBaseURL,
			CrawlKey:     cfg.CrawlAPIKey,
			CrawlTimeout: time.Duration(cfg.CrawlTimeoutMs) * time.Millisecond,
			CrawlTTL:     time.Duration(cfg.CrawlHealthTTLMs) * time.Millisecond,
			ProxyURL:     cfg.CrawlSSRFProxyURL,
			RerankNeed:   cfg.ItemsSearchRerankEnabled,
		}
		if dashboardMongo != nil {
			deps.Mongo = dashboardMongo.Database()
		}
		readyHandler = health.NewReadyHandler(authenticator, deps)
		gateway.RegisterGoHandler(health.ReadyPath, readyHandler.ServeHTTP)
		log.Printf("api-go: GET /api/healthz under go takeover")
	}

	digestService, err := wirePersonalNews(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo)
	if err != nil {
		return err
	}
	var archiveReadingService *archivereading.Service
	archiveReadingService, err = wireArchiveReadingHTTP(gateway, cfg, sharedDB, redisClient, &dashboardMongo)
	if err != nil {
		return err
	}
	if err := wireAnalysisCollaboration(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireAnalysisExport(gateway, cfg, sharedDB, redisClient, &dashboardMongo); err != nil {
		return err
	}
	if err := wireSituationMonitors(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := gdeltSnapshot.RegisterRoute(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireNewsSources(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireCrawlWorkflows(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireCrawlProfiles(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireCrawlFrontierRuns(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireRbac(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireCrawlTemplates(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireLlmLogs(gateway, cfg, sharedDB, authenticator, &dashboardMongo); err != nil {
		return err
	}

	if err := wireAdminLogs(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo); err != nil {
		return err
	}

	if err := wireExceptionIngest(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo); err != nil {
		return err
	}

	if err := wireNewsIndicators(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireQualityOverview(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo); err != nil {
		return err
	}
	if err := wireClassificationRssOps(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo); err != nil {
		return err
	}
	// Classification report creation, the classification quality worker and the
	// pipeline recovery read share this batch's wiring. Each switch is
	// independent; with all three legacy nothing is registered or started.
	qualityOps, err := wireQualityOps(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo)
	if err != nil {
		return err
	}
	if err := wireNewsnowClusteringOps(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo); err != nil {
		return err
	}
	// The public source fetch unit is anonymous and independent of the nine
	// local-computation routes. It only needs the shared MySQL pool and Redis
	// client; the service keeps the outbound HTTP client for shutdown cleanup.
	newsnowSourcesService, wireSourcesErr := wireNewsnowSources(gateway, cfg, sharedDB, redisClient)
	if wireSourcesErr != nil {
		return wireSourcesErr
	}
	if err := wireCrawlMetadata(gateway, cfg, metadataService, authenticator); err != nil {
		return err
	}
	if err := wireCrawlDiscovery(gateway, cfg, sharedDB, redisClient, metadataService, authenticator); err != nil {
		return err
	}
	// The runtime storage configuration reader is shared by the REST crawl
	// media signing path, the GraphQL crawlTask root (its own crawl read
	// service) and the storage diagnostics handler. It is built once and holds
	// no state, no connection and no S3 client: every request resolves its own
	// snapshot through the shared storage:settings cache.
	var storageConfigReader objectstorage.ConfigReader
	if crawlReadTelemetryGo || (graphqlReadGo && cfg.GraphQLSettingsCrawlReadMode == "go") || storageDiagnosticsGo {
		storageConfigReader = newInfrastructureSettingsService(cfg, sharedDB, redisClient)
	}
	if err := wireCrawlReadTelemetry(gateway, cfg, sharedDB, redisClient, authenticator, storageConfigReader, &dashboardMongo); err != nil {
		return err
	}
	wireCrawlTaskLifecycle(gateway, cfg, crawlTaskService, authenticator)
	if crawlTaskWriteGo {
		log.Printf("api-go: crawl task write routes and GraphQL mutations under go takeover (POST /api/crawl-tasks, DELETE /api/crawl-tasks/:id, POST /api/crawl-tasks/:id/retry, createCrawlTask, deleteCrawlTask, retryCrawlTask)")
	}
	if crawlQueueOpsGo {
		log.Printf("api-go: crawl4ai queue administration under go takeover (GET /api/admin/crawl4ai/queue, pause, resume, concurrency)")
	}
	// The two search index rebuild routes (POST /api/admin/search/reindex and
	// GET /api/admin/search/reindex/:jobId). The background rebuild runs on the
	// service lifetime context and is cancelled and awaited by Close.
	searchReindexService, err := wireSearchReindex(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo)
	if err != nil {
		return err
	}
	if err := wireRuntimeSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wirePlatformGovernanceSettings(gateway, cfg, sharedDB, redisClient, &dashboardMongo, authenticator); err != nil {
		return err
	}
	if err := wireLLMGatewayProfiles(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	// The governance/diagnostics takeover reuses the shared Mongo client for the
	// LLM request log rows of every real probe attempt.
	if err := wireLLMGatewayOps(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo); err != nil {
		return err
	}
	if err := wireInfrastructureSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireStorageDiagnostics(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireDataRuntimeSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
	}
	if err := wireEmailSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireGeocoding(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireRuntimeDiagnostics(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo); err != nil {
		return err
	}
	if err := wireAuthFactors(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireAccountSecurity(gateway, cfg, sharedDB, redisClient); err != nil {
		return err
	}
	if err := wireAccountData(gateway, cfg, sharedDB, redisClient, &dashboardMongo); err != nil {
		return err
	}
	if err := wireAuthLogin(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := wireOIDCLogin(gateway, cfg, sharedDB, redisClient); err != nil {
		return err
	}
	if err := wireIdentityOnboarding(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}

	if err := wireModelAccessSettings(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}

	if err := wireSituationSignals(gateway, cfg, sharedDB, redisClient, &dashboardMongo, authenticator); err != nil {
		return err
	}

	if err := wireSituationInsights(gateway, cfg, sharedDB, redisClient, &dashboardMongo, authenticator); err != nil {
		return err
	}

	// The proxy load balancing takeover reuses the same authenticated stack and
	// registers only its four routes; the two switches stay independent.
	if err := wireProxyLoadBalancing(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	// Economic-data request routes and (separately) the Go queue consumer. The
	// service instance is also handed to the GraphQL mutation registration
	// below; the runtime stays unstarted until the shutdown defer is installed.
	economicService, economicRuntime, err := wireEconomicData(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo)
	if err != nil {
		return err
	}

	// shadow 单元表：路由表中处于 ModeGo 的端点不再是 shadow 差分单元
	//（ModeGo 规则也不会进入 serveShadow——双重收口，保证 go 接管的
	// GET 不再增加 shadow.executed）。readMode=go 时六个端点全部过滤；
	// readMode 空且 onboardingMode=go 时只过滤 onboarding；其余保持
	// 既有 shadow/legacy 去向。
	settingsUnits := userSettingsShadowUnits(userSettingsRepo)
	goPaths := make(map[string]bool, len(usersettingsread.Paths))
	for _, rule := range gateway.Rules() {
		if rule.Mode == legacyproxy.ModeGo {
			goPaths[rule.Prefix] = true
		}
	}
	if len(goPaths) > 0 {
		filtered := make([]shadowUnit, 0, len(settingsUnits))
		for _, unit := range settingsUnits {
			if !goPaths[unit.Path] {
				filtered = append(filtered, unit)
			}
		}
		settingsUnits = filtered
	}

	disp := &dispatcher{
		shadowUnits: append([]shadowUnit{
			{
				Path:            "/api/healthz/live",
				Methods:         map[string]bool{http.MethodGet: true},
				RequireLegacyOK: false, // 公开探针：无需 legacy 认可身份
				Executant:       healthLiveExecutant{},
			},
		}, settingsUnits...),
		shadowRunner: shadow.NewRunner(shadow.Budget{
			TimeoutMs:            cfg.ShadowTimeoutMs,
			MaxRequestBodyByte:   cfg.ShadowMaxRequestBodyByte,
			MaxInflight:          cfg.ShadowMaxInflight,
			MaxPerMin:            cfg.ShadowMaxPerMin,
			DebugBodyLog:         cfg.ShadowDebugBodyLog,
			DebugBodyLogMaxBytes: cfg.ShadowDebugBodyLogMaxBytes,
		}),
		// 生产装配不开 AllowUnverifiedIdentity：未验签 orgId claim 不得
		// 作为受保护路由的分流依据。CANARY_PERCENT 因此当前只是预留——
		// 没有任何路由处于 ModeCanary（见 DefaultRules）。
		canaryRouter: canary.NewRouter(canary.Options{Percent: cfg.CanaryPercent}),
	}

	// /__go/healthz：网关存活探针 + 路由表与 shadow/canary 状态自省。
	// user-settings shadow 状态只报配置类别（unconfigured/invalid/configured
	// ——configured 表示 DSN 已解析为 driver 配置，不承诺可连接），不含
	// DSN/host/凭据/数据库错误详情。onboardingMode 如实展示当前模式
	//（shadow/go）。字段名 userSettingsShadow 覆盖三个只读 GET 共用的
	// 同一 repository（全仓唯一消费者是本文件与 README，无外部契约）。
	gateway.SetGoHandler(func(w http.ResponseWriter, _ *http.Request) {
		routes := make([]map[string]string, 0, len(gateway.Rules()))
		for _, rule := range gateway.Rules() {
			entry := map[string]string{"prefix": rule.Prefix, "mode": string(rule.Mode)}
			if rule.Exact || rule.OneSegment {
				if rule.OneSegment {
					entry["match"] = "one-segment"
				} else {
					entry["match"] = "exact"
				}
				methods := make([]string, 0, len(rule.Methods))
				for method := range rule.Methods {
					methods = append(methods, method)
				}
				sort.Strings(methods)
				entry["methods"] = strings.Join(methods, ",")
			}
			routes = append(routes, entry)
		}
		streamActive, streamCycles := int64(0), int64(0)
		if streamHandler != nil {
			streamActive, streamCycles = streamHandler.Stats()
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"routes": routes,
			"shadow": disp.shadowRunner.Stats(),
			"canary": map[string]int{"percent": disp.canaryRouter.Percent()},
			"onboarding": map[string]any{
				"mode": string(cfg.OnboardingMode),
			},
			// user-settings 统一读模式（Go-批3B）：空 = 兼容旧配置
			//（onboardingMode 单独控制）；shadow/go 如实展示。
			"userSettingsRead": map[string]any{
				"mode":     string(cfg.UserSettingsReadMode),
				"database": userSettingsDBStatus,
			},
			// 写模式只展示 legacy|go，不含 DSN/密钥。
			"userSettingsWrite": map[string]any{
				"mode": string(cfg.UserSettingsWriteMode),
			},
			// 公开首页、频道和两个故事详情。legacy 时这些 GET 仍代理 NestJS。
			"publicPortal": map[string]any{
				"mode":     string(cfg.PublicPortalMode),
				"database": userSettingsDBStatus,
			},
			// dashboard stats。legacy 时该 GET 仍代理 NestJS。不含 Mongo URI。
			"dashboardStats": map[string]any{
				"mode": string(cfg.DashboardStatsMode),
			},
			// 三个图表 GET。legacy 时仍代理 NestJS。不含数据库地址。
			"dashboardCharts": map[string]any{
				"mode": string(cfg.DashboardChartsMode),
			},
			"dashboardWarMap": map[string]any{
				"mode": string(cfg.DashboardWarMapMode),
			},
			"dashboardWarMapTransport": map[string]any{
				"mode": string(cfg.DashboardWarMapTransportMode),
			},
			"dashboardWarMapLayers": map[string]any{
				"mode": string(cfg.DashboardWarMapLayersMode),
			},
			"dashboardSpacetimeGeo": map[string]any{
				"mode": string(cfg.DashboardSpacetimeGeoMode),
			},
			"dashboardSpacetimePropagation": map[string]any{
				"mode": string(cfg.DashboardSpacetimePropagationMode),
			},
			"dashboardStream": map[string]any{
				"mode":   string(cfg.DashboardStreamMode),
				"active": streamActive,
				"cycles": streamCycles,
			},
			"healthz": map[string]any{
				"mode": string(cfg.HealthzMode),
			},
			// NewsNow 本地计算与聚类失败管理的 9 条 HTTP。legacy 时全部
			// 回落 NestJS；不含连接串与密钥。
			"newsnowClusteringOps": map[string]any{
				"mode": string(cfg.NewsnowClusteringOpsMode),
			},
			// The news-event clustering LLM backfill chain and the six-hourly
			// news-indicator association refresh. The four switches are
			// independent; the worker switch also stops the NestJS consumer.
			"newsBackfillJobs": map[string]any{
				"llmBackfillMode":                  string(cfg.NewsClusteringLlmBackfillMode),
				"recoveryWorkerMode":               string(cfg.NewsClusteringRecoveryWorkerMode),
				"graphqlNewsIndicatorRefreshMode":  cfg.GraphQLNewsIndicatorRefreshMode,
				"newsIndicatorAssociationCronMode": string(cfg.NewsIndicatorAssociationCronMode),
			},
			// 账户资料、会话退出与机器令牌的 8 条 HTTP。legacy 时全部回落
			// NestJS；不含连接串、密码、hash 与令牌。
			"accountSecurity": map[string]any{
				"mode": string(cfg.AccountSecurityMode),
			},
			// 存储连接诊断（POST /api/admin/settings/storage/test）的独立开关。
			// legacy 时该路由回落 NestJS；不含任何凭据、bucket 或签名 URL。
			"storageDiagnostics": map[string]any{
				"mode": string(cfg.StorageDiagnosticsMode),
			},
			// 登录、会话刷新、验证码登录、公共 MFA challenge、密码找回与
			// 邮箱变更 11 条 HTTP。legacy 时全部回落 NestJS；不含连接串、
			// 密码、令牌与密钥。
			"authLogin": map[string]any{
				"mode": string(cfg.AuthLoginMode),
			},
			// 注册申请、审批、邀请与入组 14 条 HTTP。legacy 时全部回落
			// NestJS；不含连接串、令牌、hash 与邮件凭据。
			"identityOnboarding": map[string]any{
				"mode": string(cfg.IdentityOnboardingMode),
			},
			// The three public organization-SSO HTTP entries. While legacy they
			// all fall back to NestJS; this diagnostic contains no IdP URL,
			// client secret, state, handoff token or session token.
			"oidcLogin": map[string]any{
				"mode": string(cfg.OIDCLoginMode),
			},
			// Background daily-digest delivery ownership. legacy keeps the
			// NestJS Cron; go moves the tick, org lease, SMTP delivery and
			// digest notification relay to this process.
			"userDigestDelivery": map[string]any{
				"mode": string(cfg.UserDigestDeliveryMode),
			},
		})
	})

	// 首个迁移单元的 go 模式 handler（canary 命中时使用；与 shadow 执行的
	// 是同一实现，保证差分通过即切换可信）。
	gateway.RegisterGoHandler("/api/healthz/live", health.LiveHandler)

	// The write service is built once and shared by the HTTP POST, the five
	// mutations, immediate outbox delivery and the scheduled replay owner. It
	// opens the shared Mongo connection only when one of the two switches needs
	// it; the same dashboardMongo handle is closed by the deferred teardown.
	var itemsIngestService *itemsingest.Service
	if itemsIngestGo || rawItemOutboxGo {
		if err := validateItemsIngestResources(cfg, sharedDB, redisClient, authenticator); err != nil {
			return err
		}
		if dashboardMongo == nil {
			opened, openErr := dashboardstats.Open(cfg.MongoURI)
			if openErr != nil {
				return fmt.Errorf("api-go: items ingest/raw-item outbox go mode requires a valid MONGO_URI")
			}
			dashboardMongo = opened
		}
		itemsIngestService = buildItemsIngestService(cfg, sharedDB, redisClient, dashboardMongo.Database())
	}

	// The assistant write mutations and the assistant worker share one service
	// instance. Mongo is opened here when no other domain has opened it yet, and
	// is closed by the ordered teardown below.
	var assistantRunService *assistantruns.Service
	var assistantWorker *assistantqueue.Worker
	if graphqlAssistantWriteGo || assistantWorkerGo {
		if dashboardMongo == nil {
			opened, openErr := dashboardstats.Open(cfg.MongoURI)
			if openErr != nil {
				return fmt.Errorf("api-go: assistant requires a valid MONGO_URI")
			}
			dashboardMongo = opened
		}
		assistantRunService, err = wireAssistantRuns(cfg, sharedDB, redisClient, dashboardMongo)
		if err != nil {
			return err
		}
	}
	var graphqlHandler *graphqlread.Handler
	var graphqlMongo *dashboardstats.Connection
	// The read switch, the organization/workspace/settings write switches, the
	// source-policy write switch, the knowledge-graph evidence review write and
	// the RSS translation write are independent. Any of them being go assembles
	// the exact /graphql Go handler; write-only combinations must not require
	// Mongo or initialize any read-only Mongo service (the RSS translation write
	// is the exception: it requires Mongo itself).
	settingsWriteGo := cfg.GraphQLSettingsWriteMode == "go"
	if graphqlReadGo || graphqlOrgAccessWriteGo || graphqlWorkspaceWriteGo || graphqlAlertRulesGo || settingsWriteGo ||
		sourcePolicyWriteGo || graphqlKnowledgeReviewGo || graphqlRssTranslationGo || itemsIngestGo || archiveReadingGo || economicDataGo || crawlTaskWriteGo ||
		cfg.GraphQLNewsIndicatorRefreshMode == "go" || graphqlAssistantWriteGo || analysisRunsGo {
		if sharedDB == nil || authenticator == nil || redisClient == nil {
			return fmt.Errorf("api-go: GraphQL go execution requires mysql, jwt, and redis")
		}
		reg := contract.NewRegistry()
		if archiveReadingGo {
			if archiveReadingService == nil {
				return fmt.Errorf("api-go: archive reading GraphQL registration requires the archive service")
			}
			archivereadinggraphql.Register(reg, archiveReadingService)
		}
		// The workspace identity/organization/RBAC/dashboard/queue/sentiment/
		// processed-item roots are opt-in through their own switch; when it is
		// legacy, any document selecting one of them stays on NestJS.
		workspaceGo := cfg.GraphQLWorkspaceReadMode == "go"
		settingsCrawlGo := cfg.GraphQLSettingsCrawlReadMode == "go"
		if graphqlReadGo {
			mongoDatabase := dashboardMongo
			if mongoDatabase == nil {
				mongoDatabase = graphqlMongo
			}
			if mongoDatabase == nil {
				opened, openErr := dashboardstats.Open(cfg.MongoURI)
				if openErr != nil {
					return fmt.Errorf("api-go: API_GO_GRAPHQL_READ_MODE=go requires a valid MONGO_URI")
				}
				graphqlMongo = opened
				mongoDatabase = opened
			}
			alerts.Register(reg, sharedDB)
			history.Register(reg, sharedDB, mongoDatabase.Database(), redisClient)
			economic.Register(reg, sharedDB)
			newsEventsGo := cfg.GraphQLNewsEventsMode == "go"
			if newsEventsGo {
				briefOptions := newsevents.Options{}
				// The newsEventBrief sub-switch is exact: when it is legacy
				// the root is not registered, so a document selecting it falls
				// back to NestJS as a whole, while the other five roots keep
				// serving from Go.
				if cfg.GraphQLNewsEventBriefMode == "go" {
					briefOptions.BriefEnabled = true
					briefOptions.Brief = publicportal.NewBriefCompleter(publicportal.NewMySQLStore(sharedDB), publicportal.GatewayEnv{
						EncryptionKey: cfg.SettingsEncryptionKey,
						APIBase:       cfg.LiteLLMAPIBase,
						APIKey:        cfg.LiteLLMAPIKey,
						TimeoutMs:     cfg.LiteLLMTimeoutMs,
						MaxRetries:    cfg.LiteLLMMaxRetries,
					})
					briefOptions.BriefLogs = llmlogs.NewCompletionWriter(sharedDB, mongoDatabase.Database())
				}
				newsevents.Register(reg, sharedDB, mongoDatabase.Database(), redisClient, briefOptions)
			}
			newsIndicatorsRead := cfg.NewsIndicatorsMode == config.NewsIndicatorsModeGo
			if newsIndicatorsRead {
				newsindicators.Register(reg, sharedDB)
			}
			kgImpactGo := cfg.GraphQLKgImpactMode == "go"
			if kgImpactGo {
				kgimpact.Register(reg, sharedDB, mongoDatabase.Database(), redisClient)
			}
			knowledgeGraphGo := cfg.GraphQLKnowledgeGraphMode == "go"
			if knowledgeGraphGo {
				knowledgegraph.Register(reg, sharedDB, redisClient)
			}
			if workspaceGo {
				workspace.Register(reg, sharedDB, mongoDatabase.Database(), redisClient)
			}
			// The settings center, source policy, sync status, knowledge-graph
			// evidence review queue and crawl task roots are opt-in through
			// their own switch; when it is legacy, any document selecting one
			// of them stays on NestJS.
			// The metadata preview query is registered outside
			// settingscrawl.Register and shares the service instance with the
			// HTTP POST. It adds one root and two models.
			if graphqlCrawlMetadataGo {
				graphqlcrawlmetadata.Register(reg, metadataService)
			}
			if settingsCrawlGo {
				settingscrawl.Register(reg, sharedDB, settingscrawl.Options{
					JWTSecret: cfg.JWTSecret,
					// The crawlTask root builds its own crawl read service, so
					// the shared storage configuration reader must be injected
					// here as well; otherwise its S3 media URLs stay unset.
					StorageConfig: storageConfigReader,
					Mongo:         mongoDatabase.Database(),
					Redis:         redisClient,
				})
			}
			// The item reading roots (item, itemFacets, rssSources,
			// rssTranslationStatus, searchSuggestions) are opt-in through the
			// items-reading switch; when it is legacy, or the GraphQL read switch
			// is legacy, any document selecting one of them stays on NestJS.
			if itemsReadingGo {
				itemReadService := itemsreading.NewService(itemsreading.Options{
					DB:                    sharedDB,
					Mongo:                 mongoDatabase.Database(),
					Redis:                 redisClient,
					ReadModelEnabled:      cfg.ItemsReadModelEnabled,
					VectorHardFailEnabled: cfg.ItemsVectorHardFailEnabled,
					// The personalized ordering reuses the behavior profile
					// service lazily; the switch only gates the items list
					// root, not the behavior endpoints.
					Personalization: newsbehavior.NewService(sharedDB, redisClient),
				})
				itemsgraphql.Register(reg, itemReadService, workspaceGo)
				// The items connection root is opt-in through its own
				// sub-switch on top of the two parents; while it is legacy, any
				// document selecting items stays on NestJS.
				if cfg.GraphQLItemsListMode == "go" {
					itemsgraphql.RegisterList(reg, itemReadService)
				}
			}
		}
		// The five item/crawl writes are independent of the read switch. They
		// reuse the read-side ItemModel projection for their response and the
		// settingscrawl CrawlTask model, and never open a read root.
		if itemsIngestGo {
			if itemsIngestService == nil || dashboardMongo == nil {
				return fmt.Errorf("api-go: API_GO_ITEMS_INGEST_MODE=go requires the items ingest service and mongo")
			}
			writeItemReadService := itemsreading.NewService(itemsreading.Options{
				DB:               sharedDB,
				Mongo:            dashboardMongo.Database(),
				Redis:            redisClient,
				ReadModelEnabled: cfg.ItemsReadModelEnabled,
			})
			itemsingestgraphql.Register(reg, itemsIngestService, writeItemReadService)
		}
		// Economic mutations reuse the read models when the read switch is go.
		// Register them after the read package so type registration happens once.
		if economicDataGo {
			if economicService == nil {
				return fmt.Errorf("api-go: economic-data GraphQL takeover requires the service")
			}
			economicdatagraphql.Register(reg, economicService)
		}
		// The model sets shared by the read roots and the write batches may be
		// registered exactly once each, so the workspace, alert and history
		// models are registered here only when the matching read registration
		// did not already do it. The workspace write batch reuses all three.
		workspaceModelsRegistered := graphqlReadGo && workspaceGo
		if graphqlOrgAccessWriteGo && !workspaceModelsRegistered {
			workspace.RegisterModels(reg)
			workspaceModelsRegistered = true
		}
		// The eight organization, role and membership mutations share the
		// workspace models.
		if graphqlOrgAccessWriteGo {
			orgaccesswrite.Register(reg, sharedDB, redisClient)
		}
		// The assistant mutations return history.AssistantRunModel. The model
		// set is registered by the read registration when it is go, otherwise by
		// the workspace write registration when that switch is go; only when
		// neither runs does this batch register history models itself.
		if graphqlAssistantWriteGo {
			if !graphqlReadGo && !graphqlWorkspaceWriteGo {
				history.RegisterModels(reg)
			}
			assistantwrite.Register(reg, assistantRunService)
		}
		if graphqlWorkspaceWriteGo {
			if !workspaceModelsRegistered {
				workspace.RegisterModels(reg)
				workspaceModelsRegistered = true
			}
			if !graphqlReadGo {
				alerts.RegisterModels(reg)
				history.RegisterModels(reg)
			}
			workspacewrite.Register(reg, sharedDB)
		}
		// The alert rule unit registers alertRules and the three rule mutations.
		// AlertChannelModel is shared with the alert reads and the workspace
		// writes, so it is registered here only when neither of those batches
		// did it. The queue producer is built only in go mode and reuses the
		// shared Redis client (same REDIS_DB as NestJS); it owns no connection.
		if graphqlAlertRulesGo {
			if !graphqlReadGo && !graphqlWorkspaceWriteGo {
				alerts.RegisterModels(reg)
			}
			alerts.RegisterRules(reg, sharedDB, alertqueue.New(redisClient))
		}
		// The thirteen settings mutations reuse the settings center read
		// models. The models must be registered exactly once: the settings/
		// crawl read registration already did it when that switch is go, so the
		// write path only registers them otherwise.
		if settingsWriteGo {
			// The settings/crawl read roots only register these models when the
			// read switch is go as well; otherwise the write path must do it.
			if !graphqlReadGo || !settingsCrawlGo {
				settingscrawl.RegisterSettingsModelTypes(reg)
			}
			settingswrite.Register(reg, sharedDB, redisClient, settingswrite.Options{
				RateLimitSettingsCacheTTLSeconds: cfg.RateLimitSettingsCacheTTLSeconds,
			})
		}
		// The three crawl task mutations reuse the CrawlTaskModel graph. The
		// settings/crawl read registration already added it when both that read
		// switch and the settings/crawl switch are go; otherwise the narrow
		// registration adds it exactly once here.
		if crawlTaskWriteGo {
			if !graphqlReadGo || !settingsCrawlGo {
				settingscrawl.RegisterCrawlTaskModelTypes(reg)
			}
			graphqlcrawltaskwrite.Register(reg, crawlTaskService)
		}
		// The news-indicator association refresh mutation reuses
		// newsindicator.RefreshOrg and its per-organization MySQL session lock.
		// It is independent of the news-indicator read switch: when only this
		// switch is go the two read queries stay on NestJS while this mutation
		// is served by Go.
		if cfg.GraphQLNewsIndicatorRefreshMode == "go" {
			newsindicatorwrite.Register(reg, sharedDB, redisClient)
		}
		// The four source-policy mutations return the policy models and two
		// nested category-authority models. The narrow registration is used
		// when settingscrawl.Register did not already add them; it never opens
		// a read root and never registers crawl/Mongo types.
		if sourcePolicyWriteGo {
			if !graphqlReadGo || !settingsCrawlGo {
				settingscrawl.RegisterSourcePolicyModelTypes(reg)
			}
			settingswrite.RegisterSourcePolicy(reg, sharedDB, redisClient)
		}
		// The knowledge-graph evidence review mutation reuses the evidence
		// review models of the settings/crawl read roots. Those models are only
		// registered when both the read switch and the settings/crawl switch are
		// go, so the write path registers them otherwise.
		if graphqlKnowledgeReviewGo {
			registerKnowledgeReview(reg, sharedDB, redisClient, graphqlReadGo && settingsCrawlGo)
		}
		// The RSS translation mutation registers only translateRssItems and its
		// two models. It reuses an already-open Mongo connection when there is
		// one; otherwise it opens its own and hands it to the shared
		// graphqlMongo lifecycle so shutdown closes it. Opening Mongo here (and
		// not inside the helper) keeps the connection ownership with main.
		if graphqlRssTranslationGo {
			mongoDatabase := graphqlMongo
			if mongoDatabase == nil {
				mongoDatabase = dashboardMongo
			}
			var rssTranslationMongo *dashboardstats.Connection
			if mongoDatabase == nil {
				opened, openErr := dashboardstats.Open(cfg.MongoURI)
				if openErr != nil {
					return fmt.Errorf("api-go: API_GO_GRAPHQL_RSS_TRANSLATION_MODE=go requires a valid MONGO_URI")
				}
				rssTranslationMongo = opened
				mongoDatabase = opened
			}
			if err := registerGraphQLRssTranslation(reg, cfg, sharedDB, redisClient, mongoDatabase.Database()); err != nil {
				return err
			}
			if rssTranslationMongo != nil {
				graphqlMongo = rssTranslationMongo
			}
		}
		// The three analysis run mutations insert pending Mongo documents and
		// enqueue BullMQ jobs. They reuse an already-open connection and hand a
		// newly opened one to the shared graphqlMongo lifecycle.
		if analysisRunsGo {
			mongoDatabase := dashboardMongo
			if mongoDatabase == nil {
				mongoDatabase = graphqlMongo
			}
			if mongoDatabase == nil {
				opened, openErr := dashboardstats.Open(cfg.MongoURI)
				if openErr != nil {
					return fmt.Errorf("api-go: API_GO_ANALYSIS_RUNS_MODE=go requires a valid MONGO_URI")
				}
				graphqlMongo = opened
				mongoDatabase = opened
			}
			if err := registerAnalysisRunMutations(reg, cfg, sharedDB, redisClient, mongoDatabase.Database()); err != nil {
				return err
			}
		}
		handler, handlerErr := graphqlread.NewHandler(graphqlread.Options{
			Registry:        reg,
			Authenticator:   authenticator,
			Limiter:         graphqlLimiter,
			Cache:           policy.NewResponseCache(redisClient),
			Legacy:          gateway.ServeLegacy,
			CORS:            cors.New(cfg.CorsOrigin),
			TrustProxy:      cfg.TrustProxy,
			APQEnabled:      cfg.GraphQLAPQEnabled,
			DepthLimit:      cfg.GraphQLDepthLimit,
			ComplexityLimit: cfg.GraphQLComplexity,
			CacheEnabled:    cfg.GraphQLCacheEnabled,
			CacheTTL:        cfg.GraphQLCacheTTL,
		})
		if handlerErr != nil {
			return handlerErr
		}
		graphqlHandler = handler
		gateway.RegisterGoHandler(graphqlread.StatsPath, graphqlHandler.ServeStats)
		if graphqlReadGo {
			log.Printf("api-go: GraphQL read pilot under go (16 queries; mutations and other queries stay on NestJS)")
			if cfg.GraphQLNewsEventsMode == "go" {
				if cfg.GraphQLNewsEventBriefMode == "go" {
					log.Printf("api-go: GraphQL news-event reads registered (newsEvents, newsEvent, newsEventBrief, newsEventReferencedArticles, topicGroups, eventGroups)")
				} else {
					log.Printf("api-go: GraphQL news-event reads registered (newsEvents, newsEvent, newsEventReferencedArticles, topicGroups, eventGroups); newsEventBrief stays on NestJS (API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=legacy)")
				}
			} else {
				log.Printf("api-go: GraphQL news-event reads not registered (API_GO_GRAPHQL_NEWS_EVENTS_MODE=legacy)")
			}
			if cfg.NewsIndicatorsMode == config.NewsIndicatorsModeGo {
				log.Printf("api-go: GraphQL news-indicator reads registered (newsIndicatorAssociations, newsIndicatorAssociation)")
			} else {
				log.Printf("api-go: GraphQL news-indicator reads not registered (API_GO_NEWS_INDICATORS_MODE=legacy)")
			}
			if cfg.GraphQLKgImpactMode == "go" {
				log.Printf("api-go: GraphQL knowledge-graph impact reads registered (getExecutiveChangeImpact, getCommodityMoveImpact, getPolicyEventImpact, getEntityImpactGraph)")
			} else {
				log.Printf("api-go: GraphQL knowledge-graph impact reads not registered (API_GO_GRAPHQL_KG_IMPACT_MODE=legacy)")
			}
			if cfg.GraphQLKnowledgeGraphMode == "go" {
				log.Printf("api-go: GraphQL knowledge-graph reads registered (getKnowledgeGraphSubgraph, articleEntityLinks, knowledgeGraphEdgeEvidence, entityIntelligenceCard, entityIntelligenceEvidence, knowledgeEntityByName)")
			} else {
				log.Printf("api-go: GraphQL knowledge-graph reads not registered (API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE=legacy)")
			}
			if workspaceGo {
				log.Printf("api-go: GraphQL workspace reads registered (me, myOrganizations, users, userLoginRecords, roles, permissions, memberships, dashboards, queueStats, entitySentimentSeries, topicSentimentSeries, processedItemById)")
			} else {
				log.Printf("api-go: GraphQL workspace reads not registered (API_GO_GRAPHQL_WORKSPACE_READ_MODE=legacy)")
			}
			if itemsReadingGo {
				log.Printf("api-go: GraphQL item reading roots registered (item, itemFacets, rssSources, rssTranslationStatus, searchSuggestions)")
				if cfg.GraphQLItemsListMode == "go" {
					log.Printf("api-go: GraphQL items list registered (items connection; page/after cursors, CREATED_DESC/PUBLISHED_DESC/PERSONALIZED, relevance rerank)")
				} else {
					log.Printf("api-go: GraphQL items list not registered (API_GO_GRAPHQL_ITEMS_LIST_MODE=legacy)")
				}
			} else {
				log.Printf("api-go: GraphQL item reading roots not registered (API_GO_ITEMS_READING_MODE=legacy)")
			}
			if graphqlCrawlMetadataGo {
				log.Printf("api-go: GraphQL crawl metadata root registered (crawlMetadata)")
			} else {
				log.Printf("api-go: GraphQL crawl metadata root not registered (API_GO_GRAPHQL_CRAWL_METADATA_MODE=legacy)")
			}
			if cfg.GraphQLSettingsCrawlReadMode == "go" {
				log.Printf("api-go: GraphQL settings/crawl reads registered (rateLimitSettings, entityImpactGraphSettings, knowledgeGraphSettings, newsEventSettings, newsEventSourcePolicy, newsEventSourcePolicyPresets, newsEventSourcePolicyRevisionDiff, newsClassificationSettings, classificationQualitySettings, newsDedupeSettings, newsIndicatorSettings, authCacheSettings, crawlClientSettings, auditLogRetention, newsExtractionSettings, newsPromptConfig, newsEventSourcePolicySyncStatus, knowledgeGraphEvidenceReviewQueue, crawlTasks, crawlTask)")
			} else {
				log.Printf("api-go: GraphQL settings/crawl reads not registered (API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE=legacy)")
			}
		}
		if graphqlOrgAccessWriteGo {
			log.Printf("api-go: GraphQL org-access writes registered (%s)", strings.Join(orgaccesswrite.RegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL org-access writes not registered (API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=legacy)")
		}
		if graphqlWorkspaceWriteGo {
			log.Printf("api-go: GraphQL workspace writes registered (%s)", strings.Join(workspacewrite.RegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL workspace writes not registered (API_GO_GRAPHQL_WORKSPACE_WRITE_MODE=legacy)")
		}
		if itemsIngestGo {
			log.Printf("api-go: GraphQL item/crawl writes registered (%s)", strings.Join(itemsingestgraphql.RegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL item/crawl writes not registered (API_GO_ITEMS_INGEST_MODE=legacy)")
		}
		if graphqlAlertRulesGo {
			log.Printf("api-go: GraphQL alert rules registered (%s)", strings.Join(alerts.RegisteredRoots, ", "))
		} else {
			log.Printf("api-go: GraphQL alert rules not registered (API_GO_GRAPHQL_ALERT_RULES_MODE=legacy)")
		}
		if crawlTaskWriteGo {
			log.Printf("api-go: GraphQL crawl task writes registered (%s)", strings.Join(graphqlcrawltaskwrite.RegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL crawl task writes not registered (API_GO_CRAWL_TASK_WRITE_MODE=legacy)")
		}
		if settingsWriteGo {
			log.Printf("api-go: GraphQL settings writes registered (%s)", strings.Join(settingswrite.RegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL settings writes not registered (API_GO_GRAPHQL_SETTINGS_WRITE_MODE=legacy)")
		}
		if sourcePolicyWriteGo {
			log.Printf("api-go: GraphQL source-policy writes registered (%s)", strings.Join(settingswrite.SourcePolicyRegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL source-policy writes not registered (API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE=legacy)")
		}
		if economicDataGo {
			log.Printf("api-go: GraphQL economic-data mutations registered (%s)", strings.Join(economicdatagraphql.RegisteredMutations, ", "))
		}
		if graphqlKnowledgeReviewGo {
			log.Printf("api-go: GraphQL knowledge-graph evidence review write registered (%s)", strings.Join(knowledgereview.RegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL knowledge-graph evidence review write not registered (API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE=legacy)")
		}
		if graphqlAssistantWriteGo {
			log.Printf("api-go: GraphQL assistant writes registered (%s)", strings.Join(assistantwrite.RegisteredMutations, ", "))
		} else {
			log.Printf("api-go: GraphQL assistant writes not registered (API_GO_GRAPHQL_ASSISTANT_WRITE_MODE=legacy)")
		}
	}

	var itemsReadingHandler *itemsreading.Handler
	if itemsReadingGo {
		if sharedDB == nil || authenticator == nil || redisClient == nil {
			return fmt.Errorf("api-go: API_GO_ITEMS_READING_MODE=go requires mysql, jwt, and redis")
		}
		mongoDatabase := dashboardMongo
		if mongoDatabase == nil {
			mongoDatabase = graphqlMongo
		}
		var itemsReadingMongo *dashboardstats.Connection
		if mongoDatabase == nil {
			opened, openErr := dashboardstats.Open(cfg.MongoURI)
			if openErr != nil {
				return fmt.Errorf("api-go: API_GO_ITEMS_READING_MODE=go requires a valid MONGO_URI")
			}
			itemsReadingMongo = opened
			mongoDatabase = opened
		}
		itemsReadingService := itemsreading.NewService(itemsreading.Options{
			DB:                    sharedDB,
			Mongo:                 mongoDatabase.Database(),
			Redis:                 redisClient,
			ReadModelEnabled:      cfg.ItemsReadModelEnabled,
			VectorHardFailEnabled: cfg.ItemsVectorHardFailEnabled,
		})
		itemsReadingHandler = itemsreading.NewHandler(authenticator, sharedDB, itemsReadingService)
		itemsReadingCORS := cors.New(cfg.CorsOrigin)
		gateway.RegisterGoHandler(legacyproxy.ItemsReadingKey, func(w http.ResponseWriter, r *http.Request) {
			if itemsReadingCORS.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			itemsReadingHandler.ServeHTTP(w, r)
		})
		if itemsReadingMongo != nil {
			graphqlMongo = itemsReadingMongo
		}
		log.Printf("api-go: item reading REST routes under go takeover (GET /api/items, GET /api/items/:id; readModel=%t)", cfg.ItemsReadModelEnabled)
	}

	if itemsIngestGo {
		if itemsIngestService == nil || authenticator == nil {
			return fmt.Errorf("api-go: API_GO_ITEMS_INGEST_MODE=go requires the items ingest service and JWT authenticator")
		}
		itemsIngestHandler := itemsingest.NewHandler(authenticator, sharedDB, itemsIngestService)
		registerItemsIngestHandler(gateway, cfg, itemsIngestHandler, itemsReadingHandler)
		log.Printf("api-go: item write REST route registered (POST /api/items; GraphQL write mutations declared by API_GO_ITEMS_INGEST_MODE)")
	}

	// The realtime subscription executor registers no root on the HTTP read
	// path. It needs only the credentialed stack: no Mongo, no queue worker and
	// no HTTP read/write switch. Construction happens before the ordered
	// teardown defer and Start after it, so every later error path releases the
	// dedicated pub/sub and XREAD resources.
	var graphqlSubscriptions *graphqlsubscriptions.Runtime
	if graphqlSubscriptionsGo {
		if sharedDB == nil || authenticator == nil || redisClient == nil || graphqlLimiter == nil || redisOptions == nil {
			return errGraphQLSubscriptionsResources
		}
		runtime, runtimeErr := wireGraphQLSubscriptions(cfg, authenticator, redisClient, graphqlLimiter, redisOptions)
		if runtimeErr != nil {
			return runtimeErr
		}
		graphqlSubscriptions = runtime
		log.Printf("api-go: GraphQL subscriptions under go (alertEvents, analysisEvents, assistantEvents, queueEvents; bus=%s)", cfg.GraphQLSubscriptionBus)
	}
	// A legal graphql-transport-ws upgrade goes to the local executor; every
	// other exact /graphql request keeps the Go read handler or the legacy
	// proxy. Registering this entrypoint is independent of the read switch.
	if graphqlHandler != nil || graphqlSubscriptions != nil {
		entrypoint := graphqlEntrypoint(graphqlSubscriptions, graphqlHandler, gateway.ServeLegacy)
		gateway.RegisterGoHandler(graphqlread.Path, func(w http.ResponseWriter, r *http.Request) {
			if economicDataGo {
				r = r.WithContext(economicdata.WithRequestIP(r.Context(), economicRequestIP(r)))
			}
			entrypoint(w, r)
		})
	}

	// The daily-digest background delivery unit owns the per-minute scan when
	// API_GO_USER_DIGEST_DELIVERY_MODE=go. It registers no HTTP route and needs
	// no JWT. The deferred Close stops new ticks and drains in-flight
	// organizations before the shared Redis/Mongo connections are closed below.
	var deliveryScheduler *userdigest.DeliveryScheduler
	// The audit-log outbox replay unit owns the per-minute audit recovery when
	// API_GO_AUDIT_OUTBOX_MODE=go. It registers no HTTP route and needs no JWT.
	var auditOutboxScheduler *auditoutbox.Scheduler
	// The raw_item replay owner is a background unit independent of JWT, HTTP
	// and GraphQL switches. Its Close stops new ticks and drains the in-flight
	// batch before the shared Redis/Mongo handles close below.
	var rawItemOutboxScheduler *itemsingest.OutboxScheduler
	// The knowledge-graph automatic construction chain owns the five-minute tick
	// when API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go. It registers no HTTP route
	// and needs no JWT.
	var kgIngestion *kgIngestionRuntime
	// The news backfill runtime owns the LLM backfill worker/scans and the
	// six-hourly association refresh when their switches are go. It is nil in
	// the legacy default, so no component is constructed.
	var newsBackfill *newsBackfillRuntime
	// The alert worker owns the shared `alerts` queue when
	// API_GO_ALERT_WORKER_MODE=go: the scan schedule, rule evaluation, in-app
	// notification write and email/webhook delivery. It registers no HTTP route
	// and needs no JWT. The deferred Close stops claiming jobs and drains the
	// in-flight ones before the shared Redis/Mongo connections close below.
	var alertWorker *alertworker.Service
	// The analysis worker owner stops claiming first, drains in-flight jobs
	// while renewing their locks, and only then lets the digest scheduler and
	// the shared Redis/Mongo connections close.
	var analysisWorker *analysisqueue.Worker
	// Ordered teardown for both the SIGTERM path and every error return after
	// this point, including an HTTP listen failure. The analysis worker stops
	// first, then the digest scheduler, then background search reindex, then the
	// shared Redis/Mongo connections and the request-scoped handlers.
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// Stop accepting subscriptions, cancel operations and upstream sockets,
		// then stop pub/sub/XREAD before the shared Redis client closes below.
		if graphqlSubscriptions != nil {
			if closeErr := graphqlSubscriptions.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: graphql subscriptions close: %v", closeErr)
			}
		}
		// The classification quality worker stops first: it must finish its
		// in-flight jobs while Redis and Mongo are still open.
		if qualityOps != nil {
			if closeErr := qualityOps.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: classification quality worker stop: %v", closeErr)
			}
		}
		if assistantWorker != nil {
			if closeErr := assistantWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: assistant worker close: %v", closeErr)
			}
		}
		if gdeltSnapshot != nil {
			if closeErr := gdeltSnapshot.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: GDELT snapshot scheduler close: %v", closeErr)
			}
		}
		if alertWorker != nil {
			if closeErr := alertWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: alert worker close: %v", closeErr)
			}
		}
		if analysisWorker != nil {
			if closeErr := analysisWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: analysis worker close: %v", closeErr)
			}
		}
		if deliveryScheduler != nil {
			if closeErr := deliveryScheduler.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: user digest delivery scheduler close: %v", closeErr)
			}
		}
		if auditOutboxScheduler != nil {
			if closeErr := auditOutboxScheduler.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: audit log outbox scheduler close: %v", closeErr)
			}
		}
		if rawItemOutboxScheduler != nil {
			if closeErr := rawItemOutboxScheduler.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: raw-item outbox scheduler close: %v", closeErr)
			}
		}
		if kgIngestion != nil {
			if closeErr := kgIngestion.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: knowledge graph ingestion scheduler close: %v", closeErr)
			}
		}
		if searchReindexService != nil {
			searchReindexService.Close()
		}
		// The source fetch unit's outbound HTTP transport drains before the
		// shared Redis client closes.
		if newsnowSourcesService != nil {
			newsnowSourcesService.CloseIdleConnections()
		}
		// go 模式下 onboarding 鉴权栈持有的 Redis 连接随进程收口。
		if redisClient != nil {
			if err := redisClient.Close(); err != nil {
				log.Printf("api-go: redis client close: %v", err)
			}
		}
		if dashboardMongo != nil {
			if err := dashboardMongo.Disconnect(closeCtx); err != nil {
				log.Printf("api-go: mongo client close failed")
			}
		}
		if graphqlMongo != nil {
			if err := graphqlMongo.Disconnect(closeCtx); err != nil {
				log.Printf("api-go: graphql mongo client close failed")
			}
		}
		if graphqlHandler != nil {
			graphqlHandler.Close()
		}
		if readyHandler != nil {
			readyHandler.Close(closeCtx)
		}
	}()
	if graphqlSubscriptions != nil {
		if startErr := graphqlSubscriptions.Start(context.Background()); startErr != nil {
			return startErr
		}
	}
	if economicRuntime != nil {
		if err := economicRuntime.Start(context.Background()); err != nil {
			return err
		}
	}
	deliveryScheduler, err = wireDigestDelivery(cfg, sharedDB, redisClient, digestService)
	if err != nil {
		return err
	}
	if deliveryScheduler != nil {
		deliveryScheduler.Start(context.Background())
	}
	auditOutboxScheduler, err = wireAuditOutbox(cfg, sharedDB, redisClient)
	if err != nil {
		return err
	}
	if auditOutboxScheduler != nil {
		auditOutboxScheduler.Start(context.Background())
	}
	rawItemOutboxScheduler = wireRawItemOutboxScheduler(cfg, itemsIngestService, redisClient)
	if rawItemOutboxScheduler != nil {
		rawItemOutboxScheduler.Start(context.Background())
		log.Printf("api-go: raw-item outbox scheduled replay owned by Go (SCHEDULE_ENABLED=%t)", cfg.ScheduleEnabled)
	}
	kgIngestion, err = wireKGIngestion(cfg, sharedDB, redisClient, sharedKGIngestionMongo(dashboardMongo, graphqlMongo))
	if err != nil {
		return err
	}
	if kgIngestion != nil {
		kgIngestion.scheduler.Start(context.Background())
		log.Printf("api-go: knowledge graph ingestion scheduler enabled mode=%s", cfg.KnowledgeGraphIngestionMode)
	}
	newsBackfill, err = wireNewsBackfillJobs(gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo)
	if err != nil {
		return err
	}
	if newsBackfill != nil {
		if err := newsBackfill.Start(context.Background()); err != nil {
			return err
		}
	}
	assistantWorker = startAssistantWorker(cfg, assistantRunService, redisClient)
	gdeltSnapshot.Start(cfg)

	alertWorker, err = wireAlertWorker(cfg, sharedDB, redisClient, &graphqlMongo, &dashboardMongo)
	if err != nil {
		return err
	}
	if alertWorker != nil {
		if startErr := alertWorker.Start(context.Background()); startErr != nil {
			return startErr
		}
	}

	// The analysis queue consumer owner. It reuses the already-open Mongo
	// connection when one exists; otherwise startAnalysisWorker opens one and
	// hands it to graphqlMongo so the existing teardown closes it after the
	// worker drain.
	if analysisWorkerGo {
		existingMongo := dashboardMongo
		if existingMongo == nil {
			existingMongo = graphqlMongo
		}
		worker, ownedMongo, workerErr := startAnalysisWorker(cfg, sharedDB, redisClient, existingMongo)
		if workerErr != nil {
			return workerErr
		}
		analysisWorker = worker
		if ownedMongo != nil {
			graphqlMongo = ownedMongo
		}
	}

	handler := httpx.TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gateway.ServeHTTPWithShadow(w, r, disp)
	}))
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf(
			"api-go: listening on %s (legacy=%s, canary=%d%%)",
			server.Addr, cfg.LegacyAPIURL, cfg.CanaryPercent,
		)
		serverErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case sig := <-stop:
		log.Printf("api-go: received %s, shutting down", sig)
		// http.Server.Shutdown neither waits for nor closes hijacked WebSocket
		// connections. Stop new subscriptions, cancel operations/legacy
		// upstreams and close those sockets before the HTTP drain, then let the
		// deferred idempotent Close cover the shared Redis/Mongo teardown.
		if graphqlSubscriptions != nil {
			subscriptionCtx, cancelSubscriptions := context.WithTimeout(context.Background(), 10*time.Second)
			if closeErr := graphqlSubscriptions.Close(subscriptionCtx); closeErr != nil {
				log.Printf("api-go: graphql subscriptions close: %v", closeErr)
			}
			cancelSubscriptions()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			return err
		}
		// The deferred cleanup below owns the ordered teardown: digest
		// scheduler, search reindex, Redis, Mongo and the request-scoped
		// handlers. It also runs on an HTTP listen failure instead of only on
		// SIGTERM.
		return nil
	}
}
