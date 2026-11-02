// api-go 是主后端的 Go 运行时（GO-ONLY-RUNTIME-001 起不再代理到 NestJS）。
//
// 进程直接拥有全部已实现 HTTP/GraphQL/Socket.IO 入口与异步执行：路由表由
// legacyproxy.AllRoutes() 组装，命中的请求交给已注册的 Go handler；未命中的
// 方法/路径由 gateway 以 Nest 等价的 404 返回（CORS/trace/异常记录保留），
// 不存在反向代理、shadow 旁路比对或 canary 分流，也不再有 API_GO_*_MODE
// 迁移开关。
//
// 保留的第二道门（与入口所有权无关，独立控制后台执行）：
//   - SCHEDULE_ENABLED：跨进程调度/定时/Cron/Outbox 回放总开关；
//   - BULLMQ_WORKERS_ENABLED：BullMQ 队列 worker 总开关；
//   - WS_REDIS_ADAPTER_ENABLED / GRAPHQL_SUBSCRIPTION_BUS：实时多实例总线。
//
// 真实资源（DATABASE_URL/REDIS/JWT/Mongo/SMTP/加密密钥等）与鉴权/租户校验
// 仍然生效。Node 后端源码暂留（第三步 GO-NODE-RETIRE-001 删除）；Go 不再
// 支持 mode 回退，Node 只能作为独立旧链启动。
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	"github.com/wei500L/newwei/apps/api-go/internal/classificationalert"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
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
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/notificationssocket"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
	"github.com/wei500L/newwei/apps/api-go/internal/processeditemoutbox"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/queueorgstats"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
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

func run() error {
	cfg, err := config.LoadFromOS()
	if err != nil {
		return err
	}

	// Go-only runtime: api-go owns every entrypoint directly. There is no Nest
	// reverse proxy, no legacy/shadow/canary mode and no migration-mode gating;
	// the gateway always serves the full Go route table.
	economicDataGo := true
	archiveReadingGo := true
	graphqlSubscriptionsGo := true
	notificationsSocketGo := true
	realtimeSocketGo := true
	classificationAlertGo := true
	// The process-wide vector-service circuit state shared by the search client,
	// the two upsert clients and the C-5 diagnostics route. One instance per
	// process mirrors the NestJS VectorClientService counters.
	vectorServiceHealth := &vectorclient.Health{}
	rules := legacyproxy.AllRoutes()
	gateway := legacyproxy.New(rules)

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
			return fmt.Errorf("api-go: go takeover requires a valid DATABASE_URL: %w", err)
		}
		{
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

	// The crawl maintenance and audit retention ownership switches write MySQL;
	// an unusable DATABASE_URL must fail startup instead of silently degrading to
	// a process with no pool.
	if sharedDB == nil {
		return fmt.Errorf("api-go: API_GO_CRAWL_MAINTENANCE_MODE/API_GO_AUDIT_LOG_RETENTION_MODE=go requires a usable DATABASE_URL")
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
	goTakeover := true
	dashboardGo := true
	chartsGo := true
	warMapGo := true
	transportGo := true
	layersGo := true
	spacetimeGeoGo := true
	spacetimePropagationGo := true
	streamGo := true
	healthzGo := true
	// user-settings、dashboard、stream、认证版 healthz、个人内容和分析工作台共用 JWT/Redis/MySQL 鉴权栈。
	graphqlReadGo := true
	// 组织、角色与成员管理的 8 个 mutation 由独立开关控制，与读开关解耦：
	// 只开写入时 queries 仍走 NestJS，也不需要 Mongo。
	graphqlOrgAccessWriteGo := true
	// 工作台交互写入的 8 个 mutation（通知、看板、告警渠道与告警状态）同样由
	// 独立开关控制，与读开关解耦；复用 workspace/alerts/history 的模型不要求
	// Mongo、模型网关或队列。
	graphqlWorkspaceWriteGo := true
	// The alert rule unit is independent of the read switch: alertRules itself
	// writes (default backfill + schedule + evaluation), so the read root and
	// the three rule mutations move together behind one switch.
	graphqlAlertRulesGo := true
	// The source-policy version switch is independent of the read switch and of
	// every other write switch. It needs only the credentialed
	// JWT/MySQL/Redis stack.
	sourcePolicyWriteGo := true
	// 知识图谱证据人工复核的单个 mutation 由独立开关控制，与全部读开关解耦：
	// 只开写入时图谱十个只读 root 仍走 NestJS，也不需要 Mongo。它复用
	// knowledgegraph 的设置缓存端口与 settingscrawl 的复核投影模型。
	graphqlKnowledgeReviewGo := true
	// The RSS translation write switch is independent of the read switches and
	// the other write switches; it needs MySQL, Redis and Mongo and registers
	// only the translateRssItems mutation.
	graphqlRssTranslationGo := true
	// The assistant write takeover registers only the four assistant mutations.
	// It is independent of every read switch; the worker switch is separate and
	// may be enabled in a different process.
	graphqlAssistantWriteGo := true
	assistantWorkerGo := true
	// The two authenticated hot reads and the two background owners are separate
	// switches. The HTTP unit needs the credentialed stack; the background unit
	// needs only MySQL, Redis and Mongo.
	crawlReadTelemetryGo := true
	crawlMetadataGo := true
	// The crawl task lifecycle writes and the queue administration routes are
	// independent switches; both reuse the credentialed JWT/MySQL/Redis stack
	// and the shared BullMQ producer.
	crawlTaskWriteGo := true
	crawlQueueOpsGo := true
	// The two crawl discovery entries are independent switches: the preview GET
	// and the crawl-strategy trial/replay POSTs share the crawl4ai client and the
	// metadata Service but never gate each other.
	// The metadata GraphQL root is a child of the read pilot; it can only be
	// registered when the read executor itself is assembled.
	graphqlCrawlMetadataGo := graphqlReadGo
	itemsReadingGo := true
	// The write switch is independent of every read switch. The raw_item
	// scheduled-replay switch is independent of both write ownership and the
	// other background owners.
	itemsIngestGo := true
	rawItemOutboxGo := true
	// The processed_item compensation owner is independent of the item write
	// and raw_item replay switches.
	processedItemOutboxGo := true
	// The analysis CSV export unit is independent of the item reading switch:
	// it builds its own item and news-event readers and only owns the two exact
	// POST export routes.
	// The three analysis run mutations are an independent GraphQL write unit.
	// The worker owner is separate: it needs no JWT and no GraphQL switch.
	analysisRunsGo := true
	analysisWorkerGo := true
	// The governance/diagnostics group is an independent switch, but it always
	// reuses the shared JWT/Redis/MySQL stack: the twelve routes verify tokens
	// themselves and read the governance envelope from Redis.
	// The storage connection test needs the credentialed stack (JWT, Redis
	// blacklist, MySQL membership re-derivation) but no Mongo.
	storageDiagnosticsGo := true
	// The situation monitor signals takeover needs the same credentialed stack
	// (JWT verification, Redis revocation list, MySQL membership re-derivation)
	// as the other migrated domains, so it participates in the shared assembly.
	// The insights takeover needs the same credentialed stack plus Mongo.
	// The settings takeover needs the credentialed stack plus Mongo (quality
	// summary) and the settings encryption key.
	// The Telegram login takeover serves the two authenticated POSTs, writes the
	// encrypted session into the settings row and returns the controller's
	// quality summary, so it joins the credentialed assembly below.
	// The signals worker consumes the situationMonitorSignals queue and
	// registers its repeat schedules. It serves no HTTP route and needs no JWT;
	// it needs the shared Redis (queue, cached signal state, Telegram lease and
	// the realtime event bridge) and MySQL (settings row and default OREF
	// alert rules). Legacy default constructs nothing.
	// 平行批次追加的模式全部保留（#53 frontier、#54 platform governance、#55
	// infrastructure、#56 model access、#57 situation monitor signals、#58 items
	// reading、#59 llm gateway profiles、#60 account security、#61 data runtime、
	// #62 auth factors、#63 graphql org access write、#64 exception ingest、#65
	// search reindex、#66 proxy load balancing、#67 graphql workspace write、#68 graphql settings write）。
	// 任一变量改成本批所需值都不影响其他批次接线。
	// 任一批次为 go 都需要凭据装配（JWT/Redis/MySQL）。多行 OR 便于并行批次
	// 各自就近追加，减少单行改写造成的合并冲突。
	needsCredentialedGo := true
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
	needsRedis := true
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
			"go", "go")
	}

	// HTTP GraphQL and the WebSocket executor share one limiter instance so
	// their local circuit breaker state cannot disagree about the same Redis
	// bucket.
	var graphqlLimiter *policy.Limiter
	if redisClient != nil {
		graphqlLimiter = policy.NewLimiter(redisClient, cfg.RateLimitLogin, cfg.RateLimitLoginWindow, cfg.RateLimitFailOpen).WithSettingsReader(policy.NewMySQLSettingsReader(sharedDB))
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
		if true {
			if settingsMySQL == nil {
				return fmt.Errorf("api-go: user-settings write takeover requires a mysql repository")
			}
			writeHandler = usersettingswrite.NewHandler(authenticator, settingsMySQL)
			log.Printf("api-go: user-settings PUT write takeover enabled (readMode=%s)", "go")
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
					gateway.Reject(w, r)
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
			cfg.JWTIssuer, "go", "go")
	}

	// 公开首页、频道和故事详情：匿名，不走 JWT/RBAC。只在显式 go 模式
	// 注册。详情冷路径读取与 Nest 相同的 gateway profile 和加密凭据。
	if true {
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
				gateway.Reject(w, r)
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
						gateway.Reject(w, r)
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
					gateway.Reject(w, r)
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
					gateway.Reject(w, r)
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
				gateway.Reject(w, r)
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
	if err := wireSituationMonitors(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}
	if err := gdeltSnapshot.RegisterRoute(gateway, cfg, sharedDB, authenticator); err != nil {
		return err
	}
	if err := wireNewsSources(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
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
	if err := wireCrawlFrontierWrites(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
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
	// C-1/C-7/C-9 wiring. The recorder is built once and shared by the reject
	// fallback 404 and the Go /docs 404 so both write the same exception event;
	// it is only built when one of those Go-owned 404 paths is enabled, so the
	// default (proxy + legacy docs) opens no Mongo connection.
	nestNotFoundRecorder := newNestNotFoundRecorder(cfg, &dashboardMongo, redisClient)
	gateway.SetNotFound(cors.New(cfg.CorsOrigin), nestNotFoundRecorder)
	if err := wireAPIDocs(gateway, cfg, cors.New(cfg.CorsOrigin), nestNotFoundRecorder); err != nil {
		return err
	}
	// The REST and GraphQL exception side channel. It is installed here, before
	// any handler can answer, and is independent of every API_GO_* switch: a
	// failure NestJS would have recorded must still be recorded once Go answers it.
	// The service is built on first use, so the default all-proxy configuration
	// opens no extra Mongo client.
	exceptions := newExceptionRecorder(cfg, &dashboardMongo, redisClient)
	if exceptions != nil {
		authhttp.SetExceptionRecorder(exceptions.rest)
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
	// The NewsNow hottest unit owns the two hot reads and both background
	// owners. It is nil while both switches are legacy; the deferred teardown
	// stops it before the shared Redis/Mongo connections close.
	var newsnowHottestUnit *newsnowHottestUnit
	// The hottest/recommended reads and the two NewsNow schedulers share the
	// source fetch service when the public source switch is go; otherwise this
	// unit builds its own instance over the same cache and locks.
	newsnowHottestUnit, err = newNewsnowHottestUnit(
		gateway, cfg, sharedDB, redisClient, authenticator, &dashboardMongo, newsnowSourcesService)
	if err != nil {
		return err
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
	if crawlReadTelemetryGo || graphqlReadGo || storageDiagnosticsGo {
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
	if err := wireVectorDiagnostics(gateway, cfg, sharedDB, redisClient, authenticator, vectorServiceHealth); err != nil {
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

	// The situation-monitor settings unit reuses the economic-data service so a
	// settings write can hot-sync the same repeatable jobs. It also reuses the
	// shared Mongo client for the insights quality summary.
	if err := wireSituationSettings(gateway, cfg, sharedDB, redisClient, &dashboardMongo, authenticator, economicService); err != nil {
		return err
	}

	// The Telegram login takeover serves the two POSTs with the shared
	// credentialed stack, the settings service and the temporary MTProto client
	// factory. It registers no worker and no other route.
	if err := wireSituationTelegramAuth(gateway, cfg, sharedDB, redisClient, &dashboardMongo, authenticator); err != nil {
		return err
	}

	// /__go/healthz：网关存活探针 + 路由表自省。只渲染稳定的进程事实
	//（路由数量、流式计数器、存储配置类别），不输出任何迁移模式值。
	gateway.SetGoHandler(func(w http.ResponseWriter, _ *http.Request) {
		streamActive, streamCycles := int64(0), int64(0)
		if streamHandler != nil {
			streamActive, streamCycles = streamHandler.Stats()
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"routeCount":   len(gateway.Rules()),
			"streamActive": streamActive,
			"streamCycles": streamCycles,
			"database":     userSettingsDBStatus,
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

	// The news-source scheduler and the four operations POSTs share one service
	// instance. The scheduler switch owns only the 30-second tick; the ops switch
	// owns only the four exact POST routes. Both reuse the existing crawl queue
	// producer, crawl metadata discovery, workflow overlay compiler, items
	// ingest outbox and item pipeline producer, so the queue formats, priorities
	// and job ids stay identical to NestJS.
	var newsSourceScheduler *newssourcescheduler.Scheduler
	newsSourceScheduler, err = wireNewsSourceScheduler(
		gateway, cfg, sharedDB, redisClient, authenticator,
		itemsIngestService, crawlTaskService, &dashboardMongo,
	)
	if err != nil {
		return err
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
	settingsWriteGo := true
	if true {
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
		workspaceGo := true
		settingsCrawlGo := true
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
			newsEventsGo := true
			if newsEventsGo {
				briefOptions := newsevents.Options{}
				// The newsEventBrief sub-switch is exact: when it is legacy
				// the root is not registered, so a document selecting it falls
				// back to NestJS as a whole, while the other five roots keep
				// serving from Go.
				if true {
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
			newsIndicatorsRead := true
			if newsIndicatorsRead {
				newsindicators.Register(reg, sharedDB)
			}
			kgImpactGo := true
			if kgImpactGo {
				kgimpact.Register(reg, sharedDB, mongoDatabase.Database(), redisClient)
			}
			knowledgeGraphGo := true
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
				if true {
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
		if true {
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
			CORS:            cors.New(cfg.CorsOrigin),
			TrustProxy:      cfg.TrustProxy,
			APQEnabled:      cfg.GraphQLAPQEnabled,
			DepthLimit:      cfg.GraphQLDepthLimit,
			ComplexityLimit: cfg.GraphQLComplexity,
			CacheEnabled:    cfg.GraphQLCacheEnabled,
			CacheTTL:        cfg.GraphQLCacheTTL,
			ErrorRecorder:   exceptions.graphql,
		})
		if handlerErr != nil {
			return handlerErr
		}
		graphqlHandler = handler
		gateway.RegisterGoHandler(graphqlread.StatsPath, graphqlHandler.ServeStats)
		if graphqlReadGo {
			log.Printf("api-go: GraphQL read pilot under go (16 queries; mutations and other queries stay on NestJS)")
			if true {
				if true {
					log.Printf("api-go: GraphQL news-event reads registered (newsEvents, newsEvent, newsEventBrief, newsEventReferencedArticles, topicGroups, eventGroups)")
				} else {
					log.Printf("api-go: GraphQL news-event reads registered (newsEvents, newsEvent, newsEventReferencedArticles, topicGroups, eventGroups); newsEventBrief stays on NestJS (API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=legacy)")
				}
			} else {
				log.Printf("api-go: GraphQL news-event reads not registered (API_GO_GRAPHQL_NEWS_EVENTS_MODE=legacy)")
			}
			if true {
				log.Printf("api-go: GraphQL news-indicator reads registered (newsIndicatorAssociations, newsIndicatorAssociation)")
			} else {
				log.Printf("api-go: GraphQL news-indicator reads not registered (API_GO_NEWS_INDICATORS_MODE=legacy)")
			}
			if true {
				log.Printf("api-go: GraphQL knowledge-graph impact reads registered (getExecutiveChangeImpact, getCommodityMoveImpact, getPolicyEventImpact, getEntityImpactGraph)")
			} else {
				log.Printf("api-go: GraphQL knowledge-graph impact reads not registered (API_GO_GRAPHQL_KG_IMPACT_MODE=legacy)")
			}
			if true {
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
				if true {
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
			if true {
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
				gateway.Reject(w, r)
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

	// The notifications transport owns the dedicated /socket.io-notifications
	// path only. Constructing it before the ordered teardown defer lets every
	// later error path close its relay and live sockets.
	var notificationsSocket *notificationssocket.Runtime
	if notificationsSocketGo {
		if sharedDB == nil || redisClient == nil {
			return fmt.Errorf("api-go: API_GO_NOTIFICATIONS_SOCKET_MODE=go requires mysql, jwt, and redis")
		}
		runtime, runtimeErr := notificationssocket.New(notificationssocket.Options{
			DB:                    sharedDB,
			Verifier:              authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience),
			Blacklist:             authn.NewRedisBlacklist(redisClient),
			Authz:                 authz.NewMySQLRepository(sharedDB),
			Redis:                 redisClient,
			CORS:                  cors.New(cfg.CorsOrigin),
			TrustProxy:            strings.TrimSpace(cfg.TrustProxy) != "",
			MaxConnectionsPerUser: cfg.WSMaxConnectionsPerUser,
			MaxConnectionsPerIP:   cfg.WSMaxConnectionsPerIP,
			ConnectLimitPerIP:     cfg.WSConnectRateLimitPerIP,
			ConnectLimitPerUser:   cfg.WSConnectRateLimitPerUser,
			ConnectWindowSeconds:  cfg.WSConnectRateLimitWindowSeconds,
		})
		if runtimeErr != nil {
			return runtimeErr
		}
		notificationsSocket = runtime
		gateway.RegisterGoHandler(notificationssocket.Path, runtime.ServeHTTP)
		log.Printf("api-go: notifications Socket.IO transport under go (%s, namespace %s)", notificationssocket.Path, notificationssocket.Namespace)
	}
	// The realtime transport owns the dedicated /socket.io-realtime path and
	// multiplexes the five remaining console namespaces over one Engine.IO
	// connection. It is constructed before the ordered teardown defer so every
	// later error path stops its event sources and disconnects live sockets.
	var realtimeSocket *realtimeSocketUnit
	if realtimeSocketGo {
		if sharedDB == nil || redisClient == nil || redisOptions == nil {
			return errRealtimeSocketResources
		}
		unit, wireErr := wireRealtimeSocket(cfg, sharedDB, redisClient, redisOptions, &dashboardMongo)
		if wireErr != nil {
			return wireErr
		}
		realtimeSocket = unit
		gateway.RegisterGoHandler(realtimesocket.Path, unit.runtime.ServeHTTP)
		log.Printf("api-go: realtime Socket.IO transport under go (%s, namespaces /newsnow /ops /quality /queue /situation-monitor)", realtimesocket.Path)
	}
	// The classification quality alert cron owns the five-minute evaluation in
	// go mode. It shares the tick gate and per-organization lease with NestJS.
	var classificationAlert *classificationalert.Scheduler
	if classificationAlertGo {
		if sharedDB == nil || redisClient == nil {
			return errClassificationAlertResources
		}
		scheduler, wireErr := wireClassificationAlert(cfg, sharedDB, redisClient, &dashboardMongo)
		if wireErr != nil {
			return wireErr
		}
		classificationAlert = scheduler
		log.Printf("api-go: classification quality alert scheduler under go")
	}
	// A legal graphql-transport-ws upgrade goes to the local executor; every
	// other exact /graphql request keeps the Go read handler or the legacy
	// proxy. Registering this entrypoint is independent of the read switch.
	if graphqlHandler != nil || graphqlSubscriptions != nil {
		entrypoint := graphqlEntrypoint(graphqlSubscriptions, graphqlHandler)
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
	// The realtime signal collection cron is owned by Go when
	// API_GO_REALTIME_SIGNALS_MODE=go. It registers no HTTP route, shares the
	// Redis tick gate and org leases with NestJS, and writes the shared Redis
	// documents plus Mongo transport tracks. The deferred Close drains the
	// in-flight round before the shared connections close below.
	var realtimeSignals *realtimeSignalsUnit
	// The audit-log outbox replay unit owns the per-minute audit recovery when
	// API_GO_AUDIT_OUTBOX_MODE=go. It registers no HTTP route and needs no JWT.
	var auditOutboxScheduler *auditoutbox.Scheduler
	// The raw_item replay owner is a background unit independent of JWT, HTTP
	// and GraphQL switches. Its Close stops new ticks and drains the in-flight
	// batch before the shared Redis/Mongo handles close below.
	var rawItemOutboxScheduler *itemsingest.OutboxScheduler
	// The processed_item compensation owner is a background unit independent of
	// JWT, HTTP and GraphQL switches. It shares the outbox CAS with NestJS.
	var processedItemOutboxScheduler *processeditemoutbox.Scheduler
	// The knowledge-graph automatic construction chain owns the five-minute tick
	// when API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go. It registers no HTTP route
	// and needs no JWT.
	var kgIngestion *kgIngestionRuntime
	// The news-event ingestion Cron owner claims the five-minute tick when
	// API_GO_NEWS_EVENTS_INGESTION_MODE=go. It registers no HTTP route and needs
	// no JWT; the deferred Close stops new ticks and drains in-flight
	// organizations before the shared Redis/Mongo handles close below.
	var newsEventsIngestion *newsEventsIngestionRuntime
	// The news backfill runtime owns the LLM backfill worker/scans and the
	// six-hourly association refresh when their switches are go. It is nil in
	// the legacy default, so no component is constructed.
	var newsBackfill *newsBackfillRuntime
	// The archive preparation worker owns the archivePreparation BullMQ
	// consumer when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go. It is nil in the
	// legacy default, so no client or goroutine is constructed.
	var archivePreparationWorker *archivePreparationRuntime
	// The item pipeline worker owns the itemPipeline BullMQ consumer when
	// API_GO_ITEM_PIPELINE_WORKER_MODE=go: it processes one news item end to end
	// (crawl execution, cleaning, extraction, classification, dedupe, persist
	// and outbox creation). It is nil in the legacy default.
	var itemPipelineWorker *itemPipelineRuntime
	// The crawl worker owns the three crawl4ai BullMQ consumers when
	// API_GO_CRAWL_WORKER_MODE=go: the shared priority concurrency limiter, the
	// meta global concurrency, the queue-level limiter, the C2 concurrency
	// broadcast, the per-queue timeout tier, the memory-pressure cooldown
	// requeue, the exactly-once stalled/completed/failed side effects and the
	// unified notification relay. It is nil in the legacy default. Close stops
	// claiming first, drains the in-flight jobs while their locks keep renewing,
	// flushes the coalesced snapshot refreshes and then releases the dedicated
	// blocking Redis connections before the shared handles close below.
	var crawlWorker *crawlWorkerRuntime
	// The alert worker owns the shared `alerts` queue when
	// API_GO_ALERT_WORKER_MODE=go: the scan schedule, rule evaluation, in-app
	// notification write and email/webhook delivery. It registers no HTTP route
	// and needs no JWT. The deferred Close stops claiming jobs and drains the
	// in-flight ones before the shared Redis/Mongo connections close below.
	var alertWorker *alertworker.Service
	// The queue org-stats tracker owns the per-organization itemPipeline
	// counters when API_GO_QUEUE_ORG_STATS_MODE=go. It reads the event stream
	// behind a Redis lease, so at most one api-go instance applies a
	// transition. The deferred Close stops the read loop and releases the lease
	// while the shared Redis client is still open.
	var queueOrgStats *queueorgstats.Tracker
	// The situation-monitor signals worker owns the situationMonitorSignals
	// queue, its repeat schedules, the Telegram/OREF polls and the realtime
	// event bridge when API_GO_SITUATION_SIGNALS_WORKER_MODE=go. It registers no
	// HTTP route and needs no JWT. The deferred Close stops claiming, disconnects
	// the leased MTProto session and stops the Telegram clear subscription
	// before the shared Redis/MySQL handles close below.
	var situationSignalsWorker *situationSignalsWorkerRuntime
	// The analysis worker owner stops claiming first, drains in-flight jobs
	// while renewing their locks, and only then lets the digest scheduler and
	// the shared Redis/Mongo connections close.
	var analysisWorker *analysisqueue.Worker
	// The crawl maintenance unit owns the janitor, cleanup outbox, adaptive
	// concurrency and quality snapshot crons plus the audit log retention purge
	// when their switches are go. It registers no HTTP route and needs no JWT.
	// The deferred Close stops the loops before the shared Redis/MySQL/Mongo
	// handles close below.
	crawlMaintenance, err := wireCrawlMaintenance(cfg, sharedDB, redisClient, &dashboardMongo)
	if err != nil {
		return err
	}
	// The event-timeline and sentiment snapshot cron units own the ten-minute
	// timeline rebuild and the hourly snapshot rebuild when their switches are
	// go. They register no HTTP route and need no JWT; the deferred Close stops
	// both loops and drains the in-flight organizations before the shared
	// Redis/Mongo connections close below.
	var eventTimelineSentiment *eventTimelineSentimentUnit
	// The Frontier LLM owner consumes the frontier-llm-judge and
	// frontier-llm-learn queues when
	// API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE=go. The three crawl4ai queues stay
	// on NestJS. Close stops claiming and drains the in-flight judge/learn job
	// before the shared Redis/MySQL handles close below.
	var frontierLlmWorker *crawlfrontierllm.Runtime
	// The residual duties migrated out of NestJS: leased retained-job cleanup,
	// the review-seed event consumer, and the startup reconciliation.
	var residualDuties *residualDutiesRuntime
	// Ordered teardown for both the SIGTERM path and every error return after
	// this point, including an HTTP listen failure. The analysis worker stops
	// first, then the digest scheduler, then background search reindex, then the
	// shared Redis/Mongo connections and the request-scoped handlers.
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// Close live notification sockets and the relay before the shared
		// Redis client is closed below.
		if notificationsSocket != nil {
			if closeErr := notificationsSocket.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: notifications socket close: %v", closeErr)
			}
		}
		// Stop the classification alert cron before the in-flight evaluation
		// drains and the realtime sources stop: it must finish its summary and
		// notification write while Redis, MySQL and Mongo are still open.
		if classificationAlert != nil {
			if closeErr := classificationAlert.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: classification quality alert scheduler close: %v", closeErr)
			}
		}
		// Stop the realtime event sources and disconnect the five-namespace
		// sockets before the shared Redis client is closed below.
		if realtimeSocket != nil {
			if closeErr := realtimeSocket.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: realtime socket close: %v", closeErr)
			}
		}
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
		if newsSourceScheduler != nil {
			if closeErr := newsSourceScheduler.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: news source scheduler close: %v", closeErr)
			}
		}
		if realtimeSignals != nil {
			if closeErr := realtimeSignals.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: realtime signals collector close: %v", closeErr)
			}
		}
		if alertWorker != nil {
			if closeErr := alertWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: alert worker close: %v", closeErr)
			}
		}
		if queueOrgStats != nil {
			if closeErr := queueOrgStats.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: queue org stats close: %v", closeErr)
			}
		}
		// The signals worker stops claiming first, then disconnects the leased
		// MTProto session, unsubscribes the clear broadcast and releases the
		// Redis lease while the shared client is still open.
		if situationSignalsWorker != nil {
			if closeErr := situationSignalsWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: situation signals worker close: %v", closeErr)
			}
		}
		if eventTimelineSentiment != nil {
			if closeErr := eventTimelineSentiment.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: event timeline and sentiment snapshot schedulers close: %v", closeErr)
			}
		}
		if analysisWorker != nil {
			if closeErr := analysisWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: analysis worker close: %v", closeErr)
			}
		}
		if frontierLlmWorker != nil {
			if closeErr := frontierLlmWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: frontier LLM worker close: %v", closeErr)
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
		if processedItemOutboxScheduler != nil {
			if closeErr := processedItemOutboxScheduler.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: processed-item outbox scheduler close: %v", closeErr)
			}
		}
		if kgIngestion != nil {
			if closeErr := kgIngestion.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: knowledge graph ingestion scheduler close: %v", closeErr)
			}
		}
		if newsEventsIngestion != nil {
			if closeErr := newsEventsIngestion.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: news event ingestion scheduler close: %v", closeErr)
			}
		}
		if archivePreparationWorker != nil {
			if closeErr := archivePreparationWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: archive preparation worker close: %v", closeErr)
			}
		}
		if itemPipelineWorker != nil {
			if closeErr := itemPipelineWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: item pipeline worker close: %v", closeErr)
			}
		}
		// The crawl worker stops claiming first, drains the in-flight crawl jobs
		// while their BullMQ locks keep renewing, flushes the coalesced ops
		// snapshot refreshes and releases its blocking Redis connections before
		// the shared handles close.
		if crawlWorker != nil {
			if closeErr := crawlWorker.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: crawl worker close: %v", closeErr)
			}
		}
		if searchReindexService != nil {
			searchReindexService.Close()
		}
		// The NewsNow hot schedulers stop before the shared Redis client closes;
		// a timed-out organization lock is left to expire naturally.
		if newsnowHottestUnit != nil {
			if closeErr := newsnowHottestUnit.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: NewsNow hottest unit close: %v", closeErr)
			}
		}
		// The source fetch unit's outbound HTTP transport drains before the
		// shared Redis client closes.
		if newsnowSourcesService != nil {
			newsnowSourcesService.CloseIdleConnections()
		}
		if crawlMaintenance != nil {
			if closeErr := crawlMaintenance.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: crawl maintenance close: %v", closeErr)
			}
		}
		// The residual-duty units stop before the shared Redis/Mongo handles
		// they use are closed.
		if residualDuties != nil {
			if closeErr := residualDuties.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: residual duties close: %v", closeErr)
			}
		}
		// The economic-data worker stops claiming, drains in-flight fetches
		// (keeping their locks renewed) and closes its dedicated Redis client
		// before the shared Redis handle closes.
		if economicRuntime != nil {
			if closeErr := economicRuntime.Close(closeCtx); closeErr != nil {
				log.Printf("api-go: economic-data worker close: %v", closeErr)
			}
		}
		// go 模式下 onboarding 鉴权栈持有的 Redis 连接随进程收口。
		if redisClient != nil {
			if err := redisClient.Close(); err != nil {
				log.Printf("api-go: redis client close: %v", err)
			}
		}
		// Drain the exception side channel before the shared Mongo client closes:
		// the inserts run in their own goroutines and would otherwise fail silently
		// on a closed connection.
		if exceptions != nil {
			exceptions.wait(closeCtx, exceptionRecordTimeout)
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
	// The residual-duty owners register their HTTP handlers and start their
	// background units. They attach the review-seed consumer to the GraphQL
	// subscription observer when that runtime already owns the itemPipeline
	// read loop, so one process keeps one XREAD loop. This runs before the
	// subscription runtime starts reading so no completed event can slip
	// between the two.
	residualDuties, err = startResidualDuties(gateway, cfg, sharedDB, redisClient, redisOptions,
		authenticator, &dashboardMongo, graphqlSubscriptions)
	if err != nil {
		return err
	}
	if graphqlSubscriptions != nil {
		if startErr := graphqlSubscriptions.Start(context.Background()); startErr != nil {
			return startErr
		}
	}
	if notificationsSocket != nil {
		if startErr := notificationsSocket.Start(context.Background()); startErr != nil {
			return startErr
		}
	}
	if realtimeSocket != nil {
		if startErr := realtimeSocket.Start(context.Background()); startErr != nil {
			return startErr
		}
	}
	if classificationAlert != nil {
		classificationAlert.Start(context.Background())
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
	if processedItemOutboxGo {
		if !cfg.ScheduleEnabled {
			log.Printf("api-go: processed-item outbox scheduler not started (SCHEDULE_ENABLED=false)")
		} else {
			if dashboardMongo == nil {
				dashboardMongo = graphqlMongo
			}
			if dashboardMongo == nil {
				opened, openErr := dashboardstats.Open(cfg.MongoURI)
				if openErr != nil {
					return fmt.Errorf("api-go: processed-item outbox go mode requires a valid MONGO_URI")
				}
				dashboardMongo = opened
			}
			processedItemOutboxScheduler, err = wireProcessedItemOutbox(cfg, sharedDB, redisClient, dashboardMongo.Database(), vectorServiceHealth)
			if err != nil {
				return err
			}
			if processedItemOutboxScheduler != nil {
				processedItemOutboxScheduler.Start(context.Background())
				log.Printf("api-go: processed-item outbox compensation owned by Go (batchSize=%d, concurrency=%d, budgetMs=%d)",
					cfg.ProcessedItemOutboxBatchSize, cfg.ProcessedItemOutboxConcurrency, cfg.ProcessedItemOutboxTickBudgetMs)
			}
		}
	}
	kgIngestion, err = wireKGIngestion(cfg, sharedDB, redisClient, sharedKGIngestionMongo(dashboardMongo, graphqlMongo))
	if err != nil {
		return err
	}
	if kgIngestion != nil {
		kgIngestion.scheduler.Start(context.Background())
		log.Printf("api-go: knowledge graph ingestion scheduler enabled mode=%s", "go")
	}
	newsEventsIngestion, err = wireNewsEventsIngestion(cfg, sharedDB, redisClient, sharedKGIngestionMongo(dashboardMongo, graphqlMongo))
	if err != nil {
		return err
	}
	if newsEventsIngestion != nil {
		newsEventsIngestion.scheduler.Start(context.Background())
		log.Printf("api-go: news event ingestion scheduler enabled mode=%s", "go")
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
	archivePreparationWorker, err = wireArchivePreparationWorker(cfg, sharedDB, redisClient, &dashboardMongo)
	if err != nil {
		return err
	}
	if archivePreparationWorker != nil {
		if err := archivePreparationWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	itemPipelineWorker, err = wireItemPipelineWorker(cfg, sharedDB, redisClient, &dashboardMongo, vectorServiceHealth)
	if err != nil {
		return err
	}
	if itemPipelineWorker != nil {
		if err := itemPipelineWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	// The three crawl4ai queue consumers. wireCrawlWorker builds the
	// crawlfrontiernode processor itself from these shared handles and the same
	// crawlexecution.Service, so a construction failure fails startup instead of
	// claiming frontier_node jobs it cannot execute.
	crawlWorker, err = wireCrawlWorker(cfg, sharedDB, redisClient, redisOptions, &dashboardMongo)
	if err != nil {
		return err
	}
	if crawlWorker != nil {
		if err := crawlWorker.Start(context.Background()); err != nil {
			return err
		}
	}
	assistantWorker = startAssistantWorker(cfg, assistantRunService, redisClient)
	gdeltSnapshot.Start(cfg)
	if newsnowHottestUnit != nil {
		newsnowHottestUnit.Start(cfg)
	}

	if newsSourceScheduler != nil {
		newsSourceScheduler.Start(context.Background())
	}

	if crawlMaintenance != nil {
		crawlMaintenance.Start(context.Background())
		log.Printf("api-go: crawl maintenance owned by Go (maintenance=%s, auditRetention=%s)",
			string("go"), string("go"))
	}

	// The realtime signal collector needs Mongo for the transport track writes.
	// Reuse an already-open handle when another unit opened one; otherwise open
	// the same database this process uses elsewhere and let the teardown close it.
	if sharedDB == nil || redisClient == nil {
		return fmt.Errorf("api-go: API_GO_REALTIME_SIGNALS_MODE=go requires mysql and redis")
	}
	if dashboardMongo == nil {
		opened, openErr := dashboardstats.Open(cfg.MongoURI)
		if openErr != nil {
			return fmt.Errorf("api-go: API_GO_REALTIME_SIGNALS_MODE=go requires a valid MONGO_URI")
		}
		dashboardMongo = opened
	}
	realtimeSignals = newRealtimeSignalsUnit(cfg, sharedDB, redisClient, dashboardMongo)
	realtimeSignals.Start(cfg)

	alertWorker, err = wireAlertWorker(cfg, sharedDB, redisClient, &graphqlMongo, &dashboardMongo)
	if err != nil {
		return err
	}
	if alertWorker != nil {
		if startErr := alertWorker.Start(context.Background()); startErr != nil {
			return startErr
		}
	}

	// The queue operations console registers twelve exact routes under
	// /api/admin/queue-ops; legacy (the default) registers nothing and the
	// requests keep reaching NestJS, which answers 404.
	if err := wireQueueOps(gateway, cfg, sharedDB, redisClient, authenticator); err != nil {
		return err
	}

	// The tracker starts before the gateway serves so the first transitions of
	// the switchover window are already applied by api-go.
	queueOrgStats, err = wireQueueOrgStats(cfg, redisClient, redisOptions)
	if err != nil {
		return err
	}
	if queueOrgStats != nil {
		if startErr := queueOrgStats.Start(context.Background()); startErr != nil {
			return startErr
		}
		log.Printf("api-go: itemPipeline org queue stats owned by Go (mode=%s)", "go")
	}

	// The signals worker registers its repeat schedules before claiming jobs, so
	// a flip from the NestJS owner leaves exactly one scheduler in the queue.
	// Legacy default returns nil and constructs nothing.
	situationSignalsWorker, err = wireSituationSignalsWorker(cfg, sharedDB, redisClient)
	if err != nil {
		return err
	}
	if situationSignalsWorker != nil {
		if startErr := situationSignalsWorker.Start(context.Background()); startErr != nil {
			return startErr
		}
	}

	// The manual refresh takeover needs both units above (the Telegram/OREF poll
	// entry points and the immediate scheduler dispatch), so it is registered
	// after they exist. Legacy (default) registers no route.
	if err := wireSituationRefresh(
		gateway,
		cfg,
		sharedDB,
		redisClient,
		dashboardMongo,
		authenticator,
		newsSourceScheduler,
		situationSignalsWorkerService(situationSignalsWorker),
	); err != nil {
		return err
	}

	// The ten-minute news-event timeline rebuild and the hourly sentiment
	// snapshot rebuild. Both share the NestJS tick gate and organization lease
	// keys, so a flip between the processes never runs one organization twice.
	eventTimelineSentiment, err = wireEventTimelineSentiment(cfg, sharedDB, redisClient, &graphqlMongo, &dashboardMongo)
	if err != nil {
		return err
	}
	eventTimelineSentiment.Start(cfg)

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

	frontierLlmWorker, err = wireCrawlFrontierLlmWorker(cfg, sharedDB, redisClient, redisOptions, frontierMongoDatabase(graphqlMongo, dashboardMongo))
	if err != nil {
		return err
	}
	if frontierLlmWorker != nil {
		if startErr := frontierLlmWorker.Start(context.Background()); startErr != nil {
			return startErr
		}
	}

	// The security defaults run outside the trace middleware so they also cover
	// the trace headers' own response and every Go-written error; see
	// httpx.SecurityHeadersMiddleware for why they fill in rather than overwrite.
	//
	// The metrics middleware wraps everything for the same reason: it observes
	// proxied, shadowed, Go-served and rejected requests once each, so
	// http_request_duration_seconds has one series per route rather than one per
	// execution path. Its route label is recorded by the gateway while it matches
	// the route table.
	// IdentityScope installs the per-request box the error exits read the verified
	// identity from; see authhttp.SetVerifiedIdentity. It sits outside the trace
	// middleware so even a failure of the trace wrapper can be attributed.
	handler := authhttp.IdentityScope(httpx.SecurityHeadersMiddleware(httpx.MetricsMiddleware(
		httpx.TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gateway.ServeHTTP(w, r)
		})),
		func(observation httpx.HTTPObservation) {
			metrics.RecordHTTPRequestMetric(metrics.HTTPRequestInput{
				Method:     observation.Method,
				Route:      observation.Route,
				StatusCode: observation.StatusCode,
				DurationMS: float64(observation.Duration.Microseconds()) / 1000,
			})
		},
	)))
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("api-go: listening on %s", server.Addr)
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
		// Stop claiming crawl jobs before the HTTP drain: the three queue
		// workers must not take new jobs while the process is going away, and
		// the in-flight ones drain with renewed locks. The deferred teardown
		// then skips the already-closed runtime.
		if crawlWorker != nil {
			crawlCtx, cancelCrawl := context.WithTimeout(context.Background(), 30*time.Second)
			if closeErr := crawlWorker.Close(crawlCtx); closeErr != nil {
				log.Printf("api-go: crawl worker close: %v", closeErr)
			}
			cancelCrawl()
			crawlWorker = nil
		}
		// http.Server.Shutdown neither waits for nor closes hijacked WebSocket
		// connections. Stop new subscriptions, cancel operations/legacy
		// upstreams and close those sockets before the HTTP drain, then let the
		// deferred idempotent Close cover the shared Redis/Mongo teardown.
		if notificationsSocket != nil {
			notificationCtx, cancelNotifications := context.WithTimeout(context.Background(), 10*time.Second)
			if closeErr := notificationsSocket.Close(notificationCtx); closeErr != nil {
				log.Printf("api-go: notifications socket close: %v", closeErr)
			}
			cancelNotifications()
		}
		if classificationAlert != nil {
			alertCtx, cancelAlert := context.WithTimeout(context.Background(), 10*time.Second)
			if closeErr := classificationAlert.Close(alertCtx); closeErr != nil {
				log.Printf("api-go: classification quality alert scheduler close: %v", closeErr)
			}
			cancelAlert()
		}
		if realtimeSocket != nil {
			realtimeCtx, cancelRealtime := context.WithTimeout(context.Background(), 10*time.Second)
			if closeErr := realtimeSocket.Close(realtimeCtx); closeErr != nil {
				log.Printf("api-go: realtime socket close: %v", closeErr)
			}
			cancelRealtime()
		}
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
