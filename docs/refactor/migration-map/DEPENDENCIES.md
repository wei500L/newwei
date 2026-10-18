# 开关、执行所有权与复用入口

[入口](README.md) · [缺口](GAPS.md) · [候选](BACKLOG.md)。核对 2026-10-18 14:37–14:42 MSK，源码 `3cedce9aa3200436aba3596f63b559de5490cec8`。这里只记录实际装配与主要链路；各域精确入口、开关名与 Compose 值仍在域页，不抄第二份 HTTP 清单。

## 开关与资源装配

共同事实源：[config.Load](../../../apps/api-go/internal/config/config.go)、[main.run](../../../apps/api-go/cmd/api/main.go)、[wire*](../../../apps/api-go/cmd/api)、[legacyproxy](../../../apps/api-go/internal/legacyproxy)。下表 **A** = DATABASE_URL + JWT_SECRET + REDIS_HOST（含端口/DB/鉴权配置）；**M** = MONGO_URI。A 表示初始化池/客户端/鉴权，不证明网络连通。MySQL Open 是惰性的；Mongo 由使用方按需 Open 并共享，不能用“配置非空”替代启动和真实查询证据。

除最后两行历史例外，HTTP 模式都接受空/legacy/go，空为 legacy、非法值 Load 失败。路由规则和 handler 在本模式 go 时添加；精确 METHOD/路径以域页对应 With* 为准，未知路径/方法仍 Nest。命中 ModeGo 但找不到 handler 返回 **501**，不会自动回退；业务服务错误也不会自动转发 Nest。回滚通常改本模式 legacy（onboarding/read 历史例外见末两行）；普通 OPTIONS 回退不是业务依赖。

| 迁移组 / 精确模式名 | 资源与 handler 条件 | 外部/子开关与当前独立条件 |
|---|---|---|
| `API_GO_ACCOUNT_SECURITY_MODE`、`API_GO_AUTH_FACTORS_MODE`、`API_GO_RBAC_MODE` | A；各 wire 只在本模式 go 创建 handler | 不需要登录模式/Mongo；MFA/OIDC 管理不访问 IdP；加密 key 有写时语义，登录未迁 |
| `API_GO_ANALYSIS_VIEWS_MODE`、`API_GO_ANALYSIS_BOARDS_MODE`、`API_GO_ANALYSIS_THREADS_MODE` | A；wireAnalysisCollaboration 共用 Store，分别注册 views/boards+tasks/threads+comments | 业务主体校验和清理不靠另一个开关；可单组启用，LLM/export/worker 不随之启动 |
| `API_GO_NEWS_SOURCES_MODE`、`API_GO_CRAWL_WORKFLOWS_MODE`、`API_GO_CRAWL_PROFILES_MODE`、`API_GO_CRAWL_TEMPLATES_MODE`、`API_GO_CRAWL_FRONTIER_RUNS_MODE` | A；各 wire 与本模式一致 | 管理配置/运行监控，不自动拥有 crawl4ai/BullMQ 的执行；Frontier create/retry 仍 Nest |
| `API_GO_RUNTIME_SETTINGS_MODE`、`API_GO_INFRASTRUCTURE_SETTINGS_MODE`、`API_GO_DATA_RUNTIME_SETTINGS_MODE` | A；各 wire，新建各域 Service/Authenticator/handler | 配置 CRUD 无须 S3/vector/geocode 实网；密钥/内部 token 不是统一启动条件。data-runtime 吞错观察项见 OBS-DATA-001 |
| `API_GO_MODEL_ACCESS_SETTINGS_MODE`、`API_GO_LLM_GATEWAY_PROFILES_MODE`、`API_GO_PROXY_LOAD_BALANCING_MODE` | A；独立 wire，不强开其他两个模式 | 加密 key 与 LITELLM_CONFIG_INTERNAL_TOKEN 为端点读写/内部授权依赖，真实 LiteLLM 应用/探测另算 |
| `API_GO_NEWS_INDICATORS_MODE`、`API_GO_USER_NEWS_BEHAVIOR_MODE`、`API_GO_DASHBOARD_CHARTS_MODE`、`API_GO_HEALTHZ_MODE` | A；charts 也可因 stream go 创建，但不因此接管 charts HTTP | 指标/行为/图表本地读算；ready 的依赖探测按请求执行，不能把 live shadow 计入此组 |
| `API_GO_DASHBOARD_STATS_MODE`、`API_GO_DASHBOARD_WAR_MAP_MODE`、`API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE`、`API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE` | A+M；stats.Connect，warMap/transport/layers 共用 dashboardwarmap.Handler | 地理 miss 可能 Nominatim、新闻翻译/实时运输可能外部 HTTP；各组路由独立 |
| `API_GO_DASHBOARD_SPACETIME_GEO_MODE`、`API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE`、`API_GO_DASHBOARD_STREAM_MODE` | A+M；stream 会构造 charts/warMap/spacetime 的内部服务 | 无须强开它们的 HTTP 模式；stream 是 SSE，未开启 GraphQL/Socket.IO executor；外部边界同地图 |
| `API_GO_CONTENT_SUBSCRIPTIONS_MODE`、`API_GO_USER_DIGEST_MODE` | A+M；wirePersonalNews 按需创建 behavior/catalog/subscription 服务，未开路由不跟随注册 | catalog 可调用 model/vector，digest 可读 ES；投递 scheduler 仍 Nest；不需要先强开 behavior HTTP |
| `API_GO_LLM_LOGS_MODE`、`API_GO_ADMIN_LOGS_MODE`、`API_GO_EXCEPTION_INGEST_MODE`、`API_GO_QUALITY_OVERVIEW_MODE`、`API_GO_CLASSIFICATION_RSS_OPS_MODE` | A+M；各 wire 共享 Mongo | exception ingest 内部 token 在请求时校验；分类报告创建、pipeline 恢复生产者/worker 未迁 |
| `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`、`API_GO_CRAWL_READ_TELEMETRY_MODE`、`API_GO_ITEMS_READING_MODE`、`API_GO_SEARCH_REINDEX_MODE`、`API_GO_SITUATION_MONITOR_SIGNALS_MODE`、`API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE` | A+M；各 wire/shared Mongo，items HTTP 与其 GraphQL 使用同业务基础 | ES/vector/model 为请求/功能配置依赖，不是所有启动必需；S3/brief 已确认缺口、后台缓存生产者见 GAPS |
| `API_GO_SITUATION_MONITORS_MODE` | A；wireSituationMonitors | 自定义 monitor 管理独立于 signals 读；主动 insight/refresh 与 Telegram 登录仍 Nest |
| `API_GO_PUBLIC_PORTAL_MODE` | DATABASE_URL；main 构造 publicportal.NewHandler/MySQLStore，不需要 A 中 JWT/Redis | public org/来源策略与模型配置从 DB；故事 miss 调模型 HTTP，需可用 gateway/密钥但不启动探测 |
| `API_GO_ONBOARDING_MODE`、`API_GO_USER_SETTINGS_READ_MODE` | 任一个 go 需要 A；main 创建读 handler。onboarding 接受空/shadow/go，默认 shadow；read 接受空/shadow/go，默认空；两者均不接受 legacy | read 空时 onboarding 服从 onboarding 模式，rss-reader/spacetime-timeline 默认 shadow，其余 UI GET legacy；read 显式值决定六读 |
| `API_GO_USER_SETTINGS_WRITE_MODE` | 空/legacy/go 默认 legacy；go **要求 read=go**，Load 直接校验；复用同一 read handler/router 的 PUT 分支 | 这是明确子依赖，不是“独立写开关漏接”。只开写且不满足 read 会启动失败；六 PUT 不启动 worker |

GraphQL 精确开关、默认、路由/handler OR、模型与有意义的独立/组合分支集中在 [graphql-runtime](modules/graphql-runtime.md)。main 没有 `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE`；该名称目前只存在 #70，不可把未来模式写成可部署事实。

仓库可见启用：各域 pilot 列保留原始值；[Compose](../../../infra/docker/docker-compose.yml) 的 api-go 是 opt-in profile，CANARY_PERCENT=0，Web 默认指 api:4000。GraphQL 总读/NEWS_EVENTS/KNOWLEDGE_GRAPH 当前未在 api-go environment 显式注入；KG_IMPACT/WORKSPACE_READ/SETTINGS_CRAWL_READ/ORG_ACCESS_WRITE/SETTINGS_WRITE 为固定 legacy。宿主 .env 设置并不自动覆盖固定值或注入未列变量；须按当时部署入口明确传入，不能只凭变量名存在说可启用。本轮未改配置/未实际部署。

## 产品链路与执行所有权

```mermaid
flowchart LR
  Client[HTTP / GraphQL 请求] --> Gateway[Go 路由与 GraphQL 预规划]
  Gateway -->|已接管| Go[Go 鉴权 / 读写 / 本地计算]
  Gateway -->|未支持整份 operation / 升级| Nest[Nest 业务入口]
  Go --> DB[(MySQL / Mongo / Redis)]
  Nest --> Queue[队列 / Cron / Outbox]
  Queue --> Worker[Nest worker / 调度器]
  Worker --> DB
  Worker --> External[SMTP / 模型 / crawl4ai / AkShare / 其他服务]
  Go -->|已有外部客户端的路径| External
  Worker --> Realtime[Nest PubSub / Subscription / Socket.IO]
```

| 链路 | Go 已拥有 | Nest 仍拥有 / 外部边界 | 下一步前置 |
|---|---|---|---|
| 登录与权限 | authn JWT 验签/Redis 撤销、authz membership/permissions；账户/MFA 配置管理 | [AuthService](../../../apps/api/src/modules/auth/auth.service.ts) 登录/refresh/代码/MFA 登录完成；PasswordReset/OrgInvite/RegistrationApplication/OidcAuth 与 EmailService/IdP | token/session/cache 协议与已迁 logout/密码变更保持一致；先 BL-04，再邀请/审批/OIDC |
| 条目检索 | REST List/Detail、GraphQL item/facets/RSS、local/ES/vector recall、reindex goroutine | [ItemsService](../../../apps/api/src/modules/items/items.service.ts) create/update 与 RawItemOutbox、queue processor/流水线更新 read-model；ES/vector/model 是外部 | BL-05 只补查询；写/导入须和 raw→processed/read-model/index 副作用一起定界 |
| 设置→运行器 | runtime/settingswrite 配置规范化、MySQL+共享 Redis、审计/失败 outbox | [NewsPipelineService](../../../apps/api/src/modules/news-pipeline/news-pipeline.service.ts)、采集/新闻/KG/实时/邮件调度读取配置后执行 | 不把配置保存算运行器迁移；Outbox 消费唯一执行者单独切 |
| 事件 brief | GraphQL 缓存命中；publicportal 独立实现同步生成/写回 | GraphQL brief 冷路径 Go 缺失；模型是外部服务，不是必须回 Nest 的理由 | BL-02 抽取/复用私有能力前明确 DTO/参数差异 |
| 归档 | dataruntimesettings 配置与状态索引读取 | [ArchiveService](../../../apps/api/src/modules/archive/archive.service.ts) 查询/显示资格/分类与翻译；[queue service](../../../apps/api/src/modules/archive/archive-preparation-queue.service.ts) ensure*Coverage；processor 状态推进 | 先决定生产者/消费者分批或整体切，不能只移三读 |
| 分析/Assistant | history 查询、运行能力配置；协作工作区 CRUD | [AnalysisService](../../../apps/api/src/modules/analysis/analysis.service.ts) submit*→Mongo→analysis queue→process→通知/事件；[AssistantService](../../../apps/api/src/modules/assistant/assistant.service.ts) submit*/process/工具/模型 | 核实 job payload、重试与流式 chunk；选择明确仍由 Nest 消费的阶段或完整 Go 执行器，禁止只有 pending 记录 |
| 告警 | 历史/channel/replay/tuning 读取；8交互写仍在 #70 | [AlertsService](../../../apps/api/src/modules/alerts/alerts.service.ts) ensureDefaultRules、规则 CRUD/trigger、评估/投递；[AlertsProcessor](../../../apps/api/src/modules/alerts/alerts.processor.ts)，SMTP/webhook | BL-10 等 #70 共享模型稳定；交互配置不等于扫描/投递迁移 |
| 采集 | source/workflow/profile/template 管理、Frontier 状态/取消、task/results/media 读（S3 除外） | CrawlService→BullMQ→CrawlQueueProcessor、Frontier 发现/入队、crawl4ai、ingest/outbox/清理；metadata 也主动网络 | 分元数据、task 写/ingest、Frontier dispatch、queue 控制；先固定 payload/事务/存储所有权 |
| 经济与图谱 | economic 历史/统计、knowledgegraph/kgimpact 图与证据队列查询 | [AkshareService](../../../apps/api/src/modules/akshare/akshare.service.ts) ensureRepeatableJobs 与 processor；KG ingestion/review，新闻事件/指标 ingestion Cron；AkShare/模型外部 | 配置更新要同步 repeat，review 要同步边/证据与聚合；不能只保存配置/状态 |
| 态势/实时 | monitor 管理、Telegram/Oref/refresh 状态缓存读、feedback；地图已有部分直连外部能力 | [signals processor](../../../apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.processor.ts)、external-snapshot Cron、RealtimeSignalsService、Telegram/Oref polling/登录 | 先识别全局缓存与租户过滤、collector 唯一租约；新增 Go 读不会刷新这些缓存 |
| digest / 审计与清理 | delivery 设置/预览与 AuditLog/失败 Outbox 生产者 | [delivery scheduler](../../../apps/api/src/modules/user-digest/user-digest-delivery-scheduler.service.ts)、AuditLogOutboxService、RawItemOutboxService、CrawlCleanupOutboxService | 核对去重、租约、失败补偿；迁消费者前不能停 Nest Cron |
| 实时传输 | dashboard SSE；Go GraphQL preflight/投影执行 | [graphql-subscriptions](../../../apps/api/src/modules/graphql-subscriptions) Redis backplane，4 Subscription executor；[websocket](../../../apps/api/src/modules/websocket) Socket.IO | Redis 作为 transport 已支持不代表 executor 迁移；保持事件 schema/租户/权限，独立切传输 |
| vector | vector-go 三 HTTP→Qdrant，api-go 有 vector recall 客户端 | 上游配置/真实部署去向未知，独立 vector Nest 仍可服务 | BL-22 先查配置优先级与部署证据；不重复开发已有算法 |

## 可复用能力索引

S3专项认领（2026-10-18，main9d0462e1）：STORAGE-MEDIA-001拥有infrastructuresettings运行配置导出、objectstorage窄包、媒体及两处详情service注入和storage/test；现有storage:settings/cache/crypto可复用，S3客户端尚无。新诊断HTTP模式只需DB/auth/Redis，不应依赖Mongo或其他HTTP模式；媒体REST/GraphQL沿原开关。只有诊断写/删自己的测试对象，无队列/worker所有权；BL-15其余诊断未认领，NEWS-BRIEF-001客户端文件不重叠。

本次brief专项增量（main 9d0462e1，2026-10-18）：[NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md)保留publicportal简报completion最小导出表面与llmlogs新增typed completion writer；既有helper私有、日志writer尚不存在。计划复用父GraphQL读的DB/auth/Redis/Mongo，不依赖PUBLIC_PORTAL_MODE或LLM_LOGS_MODE；新BRIEF子开关尚未实现，不是当前可部署变量。任务无BullMQ/cron执行权，模型与日志/缓存写回属于同步请求链路。

所有位置按页首 SHA。包内小写符号是 **私有**，不能在新包直接调用；需要抽取时先写清所有权和副作用。返回模型共享不代表业务权限可以复用成同一根权限。

| 能力 | 真实 Go 入口 / 路径 | 使用限制与副作用 |
|---|---|---|
| 鉴权/租户 | [authn](../../../apps/api-go/internal/authn) Verifier、RedisBlacklist；[authz](../../../apps/api-go/internal/authz) MySQLRepository；[authhttp](../../../apps/api-go/internal/authhttp) NewAuthenticator | JWT 后从 DB 重推导 membership/permissions；机器令牌是否允许由 HTTP/GraphQL 分别决定，不能信任请求 orgId |
| GraphQL 写与预规划 | [contract.go](../../../apps/api-go/internal/graphqlread/contract/contract.go) Registry.RegisterMutation/Bind/RegisterType/RegisterFieldPermission；[exec](../../../apps/api-go/internal/graphqlread/exec) Engine.PlanDocument/Execute | root 重复 panic；RegisterType 会覆盖类型映射，不是类型兼容检查器；先 plan 所有选中字段再写；模型不自动携带授权 |
| 身份/组织模型与业务 | [workspace.RegisterModels](../../../apps/api-go/internal/graphqlread/workspace/register.go)、[rbacapi](../../../apps/api-go/internal/rbacapi) AssignRoleView/UpdateMembershipRolesView/SetUserActiveView | 模型注册带字段权限；rbac 方法有事务、角色提升限制与缓存失效，别只复用 SQL 片段 |
| 条目读取/检索 | [itemsreading.NewService / Service.List / Detail](../../../apps/api-go/internal/itemsreading/service.go)、Facets/ResolveEventID；graphqlread/itemsreading 适配器 | DB/Mongo/Redis，ES/vector/embedding 配置与回退；List 是 REST RECENCY 入口，不是 GraphQL 全排序实现，不能用它直接宣称 `items` 完成 |
| 查询规范化 | [analysiscollab/query.go](../../../apps/api-go/internal/analysiscollab/query.go) NormalizeQueryString/BuildQueryState/ReadQueryState | 可用于导出解析的基础；不包含导出全量拉取/CSV/归档模式；私有参数 helper 不能跨包直调 |
| 设置规范化/模型 | [settingscrawl/writesupport.go](../../../apps/api-go/internal/graphqlread/settingscrawl/writesupport.go) 导出的 Default*/Normalize*/AssertSystemAdmin；RegisterSettingsModelTypes | 只是 model/normalizer，不自行持久化；返回嵌套类型须注册。SystemSetting/Redis key/TTL 与 Nest 共享 |
| 设置存储/共享缓存 | [runtimesettings](../../../apps/api-go/internal/runtimesettings)、[settingswrite/store.go](../../../apps/api-go/internal/graphqlread/settingswrite/store.go) upsertSetting/cacheSet/writeAuditLogBestEffort | 后者 helper 私有；best effort 审计失败写 AuditLogOutbox，重放仍 Nest；不能把 DB+Redis 审计都视为原子事务 |
| 告警/通知模型 | [alerts/register.go](../../../apps/api-go/internal/graphqlread/alerts/register.go)、[history/register.go](../../../apps/api-go/internal/graphqlread/history/register.go)、workspace.RegisterModels | main 基线 alerts/history 的 Register 同时加 Query；#70 才拆 RegisterModels。新任务不能引用 PR 中尚未合入的导出函数 |
| 简报与模型 HTTP | [publicportal/story.go](../../../apps/api-go/internal/publicportal/story.go) Service.brief、[gateway.go](../../../apps/api-go/internal/publicportal/gateway.go) gatewayClient.Complete；[llmembed](../../../apps/api-go/internal/llmembed) NewClient | 简报 helper/request 私有；有配置/密钥解密/模型 HTTP，非现成 GraphQL 通用服务；llmembed 只表示 embedding/rerank 能力，不能替代 chat completion |
| 存储配置与签名媒体 | [infrastructuresettings/storage.go](../../../apps/api-go/internal/infrastructuresettings/storage.go)、[crawlreadtelemetry/service_media.go](../../../apps/api-go/internal/crawlreadtelemetry/service_media.go) verifySignedAssetAccess/getAssetDeliveryPayload | 两处主要 helper 私有；前者配置管理/解密不等于 S3 对象签名客户端；后者仅 MySQL 下发完整，见 GAP-CRAWL-001 |
| 数据/序列化 | contract.FormatDateTime；[history/runs.go](../../../apps/api-go/internal/graphqlread/history/runs.go) findRuns/map*；[economic/query.go](../../../apps/api-go/internal/graphqlread/economic/query.go) load/queryPoints | UTC 毫秒契约；history/economic reader 私有，业务 JSON 强类型要求继续适用，不能把通用协议 any 搬进新 DTO |
| Go 后台本地任务 | [searchreindex/service.go](../../../apps/api-go/internal/searchreindex/service.go) startReindex/runReindex/reindexOrg、Close | 私有、Redis job 状态+goroutine；不是 BullMQ 协议库，重启不自动恢复；不可直接用来迁其他 queue |
| vector-go | [httpapi.New](../../../apps/vector-go/internal/httpapi/server.go)、[qdrant.Client](../../../apps/vector-go/internal/qdrant/client.go) UpsertPoints/Search | 独立进程 HTTP/内部 token、orgId 过滤；上游调用地址另由配置选择，不跨服务 import 内部包 |
