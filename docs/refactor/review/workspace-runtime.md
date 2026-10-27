# 工作区、GraphQL 与异步运行时 · Go 对照 Nest 静态审查

> 本文件是本批 5 个并行审查窗口之一（「工作区、GraphQL 与异步运行时」）的交付物。
> 审查方式：**纯静态**。本机未安装依赖、未运行 `go build`/`go vet`/`go test`/`pnpm`/Docker，未启动任何服务，
> 未连接真实 MySQL/Redis/Mongo，未做浏览器连接实测。唯一使用的本地工具是 `gofmt`（允许）与只读浏览仓库内
> 已存在的 `node_modules` 依赖树（用于核对 bullmq 5.63.2、graphql-depth-limit 1.1.0、@apollo/server 4.12.2 的
> 真实源码语义，未执行 `pnpm install`）。所有结论都来自源码阅读，行号取自本报告基线提交。
> 远端验证只走既有普通 GitHub Actions CI。

---

## 0. 摘要

- **基线**：`origin/main = dc48abc18c2a5921ace8189db6471c5a3ef0a3c2`（#141，整合 #138–#140）。
- **分支 / worktree**：`review/go-workspace-runtime` / `/Users/oo/project/newwei-review-workspace-runtime`。
- **分级结果**：P0 **0** 条；P1 **1** 条（已修复）；P2 **10** 条（已修复 **8**，其中 R5-01 为纯补测试、无行为变化；只记录 **2**：R2-03、R4-03）；P3 **33** 条（已修复 **1**：R1-04；只记录 **32**）。另有 **2** 条初疑点经源码核对后推翻（R1-06、R1-11），见 §5。
- **修复**：11 个提交（9 个代码修复 + 2 个测试加固，见 §4.1），每条均带测试；无开关默认值变更，无新增开关。
- **最重要的一条（P1）**：告警投递占用 CAS 的返回值被丢弃，同一 `AlertDelivery` 的两个 attempt 重叠时会重复外发邮件和 webhook。
- **删除 Nest 的结论**：本窗口未发现新的「只能由 Nest 承担」的执行所有权；但 §7 列出的 6 项必须在删除前确认
  （Nest 进程内生产端桥、机器令牌路由口径、TRUST_PROXY 层数、cron 全局停用开关不复读、Bull Board 面板、跨窗口共享文件）。

---

## 1. 范围与基线

**审查范围（本窗口）**

| 侧 | 内容 |
|---|---|
| Nest | `apps/api/src/graphql/**`（16.5k 行：模块配置、插件、guard、filter、scalar、非业务 resolver）、`modules/graphql-subscriptions`、`modules/websocket`、6 个 `@WebSocketGateway`、`modules/dashboard`（8.4k）、`modules/alerts`（5.1k）、`modules/notifications`、`modules/analysis`、`modules/analysis-workspace`、`modules/assistant`、`modules/knowledge-graph`、`modules/observability`（7.2k）、`modules/queue`（除 `queue.processor.ts` 的 itemPipeline 消费逻辑） |
| Go | `graphqlread/{exec,contract,schema,transport,policy,handler.go,envelope.go}`、`graphqlsubscriptions`；`socketio`/`realtimesocket`/`notificationssocket`/`realtimeevents`/`dashboardstream`；`dashboardstats`/`dashboardcharts`/`dashboardspacetime`/`dashboardwarmap`；`alertqueue`/`alertworker`/`graphqlread/alerts`；`analysisboards`/`analysiscollab`/`analysisexport`/`analysisqueue`/`analysisruns`/`analysistasks`/`analysisthreads`/`analysisviews`；`assistantqueue`/`assistantruns`/`graphqlread/assistantwrite`；`kgingestion`/`graphqlread/knowledgegraph`/`graphqlread/kgimpact`/`graphqlread/knowledgereview`；`adminlogs`/`llmlogs`/`exceptioningest`/`runtimediagnostics`/`pipelinerecovery`/`cronlock`/`bullmqcleanup`/`startupreconcile`/`queueops`/`queueorgstats`/`bullmqwire`/`graphqlread/history`/`graphqlread/workspace/queue.go` |

**不在本窗口**：各业务领域 GraphQL 解析器的业务逻辑（由对应领域窗口审查）、身份与设置、爬取、新闻与条目、态势。
`graphqlread/itemsingest`（条目写入）属 items 窗口；本窗口只做了一处跨窗口最小改动（R1-01），已在 §4.2 标明。

**基线复核（开工前）**

- `git fetch origin main` → `origin/main = dc48abc1`；`git log --oneline -5` 顶部为 `dc48abc1 Merge pull request #141`。
- `gh pr list --state open` → 空（无开放 PR）。
- `gh run list --branch main --limit 3` → `dc48abc1` 的 CI（run `39664944449`）`conclusion=success`；其余两条历史 run 同样 success。**该 SHA 的既有 CI 通过**。
- `git worktree list` → 已有 50+ worktree，无 `review/go-workspace-runtime`，目标路径 `/Users/oo/project/newwei-review-workspace-runtime` 未被占用，按计划创建。

---

## 2. 审查方法、证据口径与限制

1. **建立清单**：按 `docs/refactor/cutover/ownership-audit.md` §2/§3/§4/§5/§6 与 `switch-matrix.md` 的开关行，把本窗口的
   HTTP 路由、GraphQL 根字段、Socket 事件、BullMQ 生产者/消费者、Cron/启动任务、Redis pub/sub 频道逐项列出，
   找到 Go 实现与开关，再往下看服务方法与分支。
2. **逐项比对**：A1–A10 清单（入口覆盖、鉴权与租户、输入校验、写路径、副作用与多实例、响应契约、JS 等价陷阱、
   后台任务、安全与资源、代码规范）。
3. **对抗式复核**：每个疑点先写两侧 `file:line`，再主动尝试推翻（别处是否有守卫、中间件、默认值或调用约束让它不成立）。
   推翻不了才计入发现；被推翻的疑点全部记入 §5，避免后续重复审查。
4. **深度标注**：每个入口都标了「全文 / 重点 / 未审查」。**本窗口范围很大，不要求逐行通读**；按「写路径、鉴权、
   后台任务优先，纯读格式化其次」分配精力，§3 与 §6 如实记录留白。
5. **分工**：本窗口由 5 个子审查员按域并行（GraphQL 执行器 / 订阅与实时传输 / dashboard+告警+通知投递 /
   分析与助手+知识图谱 / 可观测与队列运维），各自写作用域不重叠，发现的证据由子审查员先自查再由 Lead 交叉复核。

**限制（不得当作已验证）**

- 未运行任何构建、测试、服务或外部调用；本报告不包含任何运行时观测。
- 未连真实 MySQL/Redis/Mongo/SMTP/模型网关/Nominatim；BullMQ stream 字段、gqlsub 实际收发、
  socket.io-client 4.8.1 互操作、反向代理行为均按源码推断。
- 第三方库语义（复杂度计分实况、Nest guard 每字段限流计数、socket.io 心跳细节）需要
  「同一文档/同一连接对 Nest 与 Go 各发一次」的实测才能定论，已列入 §6。

---

## 3. 入口清单

「深度」列：**全** = 全文审查；**重** = 重点（只看列出的方法/分支）；**未** = 未审查。行号省略公共前缀
（Nest 侧 `apps/api/src/`，Go 侧 `apps/api-go/internal/`）。

### 3.1 GraphQL 执行器与 HTTP 传输（Nest `graphql/graphql.module.ts` + 3 个 guard + 全局异常过滤器）

| # | Nest 入口 / 行为 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|---|
| 1 | 方法分流（非 GET/POST/OPTIONS → 转发） | `graphqlread/handler.go:126-140` | 任一 | 全 | 一致 |
| 2 | body 上限 10MB（`main.ts:111`） | `graphqlread/envelope.go:13,29-49`、`handler.go:141-154` | — | 全 | 上限一致；413 body 形状差异 R1-13（P3） |
| 3 | 批量数组 / multipart → 整份转发 | `handler.go:155-158`、`envelope.go:55-63` | — | 全 | 一致 |
| 4 | CSRF 前置（`graphql.module.ts:354`） | `envelope.go:73-89`、`handler.go:159-162,293` | — | 全 | 逐字对齐 |
| 5 | 请求解析（GET / JSON / `application/graphql`） | `envelope.go:91-178` | — | 全 | 一致；R1-08/R1-09（P3） |
| 6 | APQ（`graphql.module.ts:398`） | `transport/apq.go`、`handler.go:168-172,234-263` | — | 全 | 四分支一致（R1-11 经 Apollo 源码核对后**推翻**） |
| 7 | 深度限制 8（`:397`） | `exec/engine.go:133-147`、`exec/walk.go:287-353` | — | 全 | 一致（R1-06 读真实库源码后**推翻**，见 §5） |
| 8 | 复杂度 2000（`:228-266,309-315,399-444`） | `exec/engine.go:188-201`、`exec/walk.go:355-484` | — | 全 | 计分逐分支等价；输入集合差异 R1-07（P3） |
| 9 | 复杂度拒绝形状（`:428-437`） | `exec/response.go:189-201` | — | 重 | 字段一致，HTTP 500 与 Apollo 兜底一致 |
| 10 | GET + mutation → 405 | `exec/engine.go:166-184`、`handler.go:193-198` | — | 全 | 一致（鉴权前拒绝） |
| 11 | 限流 → 鉴权 → 权限顺序（`:500-515`、`gql-*.guard.ts`） | `handler.go:206-226`、`exec/engine.go:239,366` | 任一 | 全 | 一致；粒度差异 R1-12（P3） |
| 12 | 限流桶 / Lua / 预算 / 熔断（`rate-limiter.service.ts`、`rate-limit-config.service.ts`） | `policy/limit.go`、`envelope.go:204-239` | 任一 | 全 | Lua/key/预算等价；**R1-02（P2，已修复）**、R1-03（P3） |
| 13 | 401 未认证（`gql-auth.guard.ts:52-84`） | `handler.go:214-225`、`exec/engine.go:594-638` | 任一 | 重 | 一致 |
| 14 | 权限 any/all/元数据缺失（`permissions.decorator.ts:17-20`、`gql-permissions.guard.ts:26-85`） | `contract/contract.go:145-151`、`exec/engine.go:517-569`、`exec/project.go:121-132` | 任一 | 全 | 一致（含 `@PermissionsAll`） |
| 15 | 错误格式（`global-exception.filter.ts:37,119-192,350-356`） | `exec/response.go:8-17,39-187`、`exec/engine.go:594-673` | 任一 | 全 | 主体等价；**R1-05（P2，已修复）**、R1-10/R1-14（P3） |
| 16 | 可空/非空错误冒泡（含 list item、non-null list、顶层 null） | `exec/project.go` 全文、`exec/engine.go:296-330,406-430` | 任一 | 全 | 与 spec 等价（唯一有意差异：nil slice → `[]`） |
| 17 | Mutation 串行 + `data:null` | `exec/engine.go:338-431` | — | 全 | 一致 |
| 18 | 响应缓存白名单 / 会话隔离 / maxAge 30（`:124-137,170-226,319-349,485-491`） | `exec/engine.go:433-515`、`policy/cache.go`、`handler.go:203-226` | 任一 | 全 | **R1-04（P3，已修复）** |
| 19 | 生产 introspection / playground（`:355-356`、`env.schema.ts:504-510,1462-1463`） | 由 Nest 决定；Go 未注册 → 整份转发 | 任一 | 重 | 一致（疑点被推翻，见 §5-A） |
| 20 | 未注册根 / 未实现特性 → 整份回退 | `exec/engine.go:108-141`、`exec/walk.go:9-141`、`handler.go:178-183` | 任一 | 全 | 一致；参数级未实现不可判定 R1-15（P3） |
| 21 | Subscription upgrade 分流 | `exec/subscription.go`、`graphqlsubscriptions/handler.go:149-160` | SUB | 全 | 一致（见 §3.2） |

### 3.2 GraphQL Subscription 与实时传输

| # | Nest 入口 / 行为 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|---|
| 22 | WS upgrade 分流（`graphql.module.ts:376-395`、`cmd/api/graphql_subscriptions.go:65-81`） | `graphqlsubscriptions/handler.go:149-160,193-231` | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` | 全 | 一致 |
| 23 | `connection_init` 鉴权（`graphql.module.ts:380-390`、`graphql.types.ts:47-55`） | `graphqlsubscriptions/connection.go:222-233,368-412` | 同上 | 全 | 一致（Go 比 Nest 更严：不接受客户端 XFF/orgId） |
| 24 | 4 个根的 envelope 与投影（`alerts.serialization.ts:156-162` 等） | `graphqlsubscriptions/projections.go:121-231,302-365` | 同上 | 全 | 一致（含 `{"$gqlDate":…}`、`deliveries=[]`、非有限数处理） |
| 25 | 按组织过滤（`subscription-org.ts:1-7`） | `graphqlsubscriptions/bus.go:126-160`、`queue.go:565-572` | 同上 | 全 | 一致，无跨租户泄漏 |
| 26 | `gqlsub:*` 频道 payload（`graphql-subscription-bus.ts:10/247-249`） | `graphqlsubscriptions/bus.go:15/127` | 同上 | 全 | **R2-02（P2，已修复）** |
| 27 | `queueEvents` 的 `XREAD` 观察器 | `graphqlsubscriptions/queue.go:61,290-316,318-345,390-465` | 同上 | 全 | 起点 `$`、无消费组、每实例只推本地 → 无重复（多实例疑点被推翻） |
| 28 | `/socket.io-notifications`（`notifications.gateway.ts`） | `notificationssocket/{connection,runtime,source,auth,limiter}.go` | `API_GO_NOTIFICATIONS_SOCKET_MODE` | 全 | 握手顺序/token 顺序/限流键/房间/relay 全部等价 |
| 29 | `/socket.io` 5 个 namespace（newsnow/ops/quality/queue/situation-monitor） | `realtimesocket/{namespaces,runtime,index,revalidate}.go` + `socketio/*` | `API_GO_REALTIME_SOCKET_MODE` | 全 | 等价（per-namespace token 顺序、权限门、房间） |
| 30 | queue/ops/quality 事件源（5 个 publisher） | `realtimeevents/queues.go:74-200`、`queue_payloads.go` | 同上 | 全 | 等价；慢客户端队头阻塞 R2-03（P2，只记录） |
| 31 | newsnow（`newsnow-source-refresh.subscriber.ts`） | `realtimeevents/{adapter,sources,newsnow}.go` | 同上 | 全 | 等价（NX key/TTL 60 逐字符一致、不参与 `-request#` RPC） |
| 32 | situation-monitor 桥（`situation-monitor-signals.gateway.ts:250-351`） | `realtimeevents/situation.go:87-120` | 同上 | 全 | 等价（桥 v1 契约、本地批量、失败回退原始载荷） |
| 33 | SSE `GET /api/dashboard/stream`（`dashboard.controller.ts:375-566`） | `dashboardstream/{handler,shared}.go` | `API_GO_DASHBOARD_STREAM_MODE` | 全 | 等价；**R2-01（P2，已修复）** |
| 34 | Engine.IO 心跳/ping 超时（`socketio/server.go:13-19`） | 同上 | — | 重 | R2-06/R2-07/R2-08/R2-09（P3） |
| 35 | Redis adapter 8.3 频道 `${key}#${nsp}#[room#]`（`redis-io.adapter.ts:48-55`） | `realtimeevents/adapter.go:1-65` | — | 全 | 格式与 msgpack envelope 一致 |

### 3.3 dashboard / alerts / 通知投递

| # | Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|---|
| 36 | `GET /api/dashboard/stats`（`dashboard.service.ts:294-310`） | `dashboardstats/handler.go:85-172`、`source.go:130-201` | `API_GO_DASHBOARD_STATS_MODE` | 全 | 同构；Redis 键 `…:org:<orgId>:counts` |
| 37 | `…/sector-heatmap`、`…/financial-candlestick`、`…/war-map/geojson`（`:361,368,190`） | `dashboardcharts/{handler,mysql,geojson}.go` | `…_CHARTS_MODE` | 重 | 一致（经济序列不分 org，与 Nest 同）；区间校验文案逐字对齐 |
| 38 | `…/war-map/events`、`…/news-markers`（`:227,244`） | `dashboardwarmap/{service,mysql,mongo}.go` | `…_WAR_MAP_MODE` | 全 | 一致（`AlertEvent⨝AlertRule`、`ProcessedArticle` 均带 orgId；MySQL 空→Mongo 回退） |
| 39 | `…/war-map/layers`、`…/transport-detail`（`:206,261`） | `dashboardwarmap/{layers,transport,transport_store}.go` | `…_TRANSPORT/_LAYERS_MODE` | 重 | 一致 |
| 40 | `…/spacetime/geo-heatmap`、`…/propagation`（4 条，`:290,305,325,341`） | `dashboardspacetime/{geo,store,snapshot,rowcache}.go` | `…_SPACETIME_GEO/_PROPAGATION_MODE` | 全 | 一致（每条 SQL 带 orgId；快照/行缓存键含 orgId 且回读校验） |
| 41 | 告警 4 个 Query 根（`alerts.resolver.ts:29/90/105/119`） | `graphqlread/alerts/{channels,events,replay,tuning}.go` | `API_GO_GRAPHQL_READ_MODE` | 全 | 一致（limit 1..500、windowDays 1..365、metricSlug 合并语义） |
| 42 | 告警规则 4 根（`:49/133/182/248`） | `graphqlread/alerts/{rules,rules_write,rules_register}.go` + `alertqueue` | `API_GO_GRAPHQL_ALERT_RULES_MODE` | 全 | 一致（写路径先校验通道归属再写，提交后才碰 Redis；delete/trigger 均带 `orgId`） |
| 43 | 告警通道 4 个 Mutation（`:192/215/238/262`） | `graphqlread/workspacewrite/register.go:47-62` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | 全 | 一致 |
| 44 | `alerts` 队列消费者（`alerts.processor.ts:43-86`） | `cmd/api/alert_worker.go`、`alertworker/{service,queue,delivery,inapp,throttle}.go` | `API_GO_ALERT_WORKER_MODE` | 全 | 一致；**R3-01（P1，已修复）** |
| 45 | `scan-active-rules` + `evaluate-<id>` repeatable + 全量对账（`:1284-1301,2536-2571`） | `alertworker/service.go:189-203`、`producer.go:253-300`、`reconcile.go:66-249` | 同上 | 全 | 一致（#140 已在 main 关闭该缺口，见 §5-D1） |
| 46 | 投递 4 次 + 退避 + 状态机（`:1964-2190`） | `alertworker/{producer,delivery,repository}.go` | 同上 | 全 | 一致（attempts=4、60s/5m/15m、失败落库） |

### 3.4 analysis / assistant / knowledge-graph

| # | Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|---|
| 47 | 分析协作 23 条 HTTP（`analysis-workspace.controller.ts:48-305`） | `analysis{views,boards,tasks,threads}/handler.go` | `API_GO_ANALYSIS_{VIEWS,BOARDS,THREADS}_MODE` | 全 | 一致；**R4-01（P2，已修复）**；机器令牌口径 R4-03（P2，只记录） |
| 48 | exports items/events（`:324-356`，`analysis.write`） | `analysisexport/{handler,service,csv}.go` | `API_GO_ANALYSIS_EXPORT_MODE` | 重 | 一致（5000 行上限、Mongo 投影带 orgId、无 BOM、LF） |
| 49 | exports search（`:307-322`） | `analysisexport/search.go`（由 archive 开关注册） | `API_GO_ARCHIVE_READING_MODE` | 抽查 | 注册边界正确 |
| 50 | 3 个分析 Mutation（`analysis.resolver.ts:53/74/95`，`analysis.run`） | `graphqlread/analysisruns/{register,input}.go` | `API_GO_ANALYSIS_RUNS_MODE` | 全 | 一致 |
| 51 | analysis worker（`analysis.processor.ts:40-121`） | `cmd/api/analysis_runs.go:70-154`、`analysisqueue/worker.go:349-592` | `API_GO_ANALYSIS_WORKER_MODE` | 全 | 一致（Mongo fencing token、stalled 终局只通知一次） |
| 52 | `gqlsub:analysisEvents` / `analysis:notification:v1` | `analysisruns/{events,notifications}.go` | 同上 | 全 | envelope 逐字段一致 |
| 53 | 4 个 assistant Mutation（`assistant.resolver.ts:111-181`） | `graphqlread/assistantwrite/{register,resolver}.go` | `API_GO_GRAPHQL_ASSISTANT_WRITE_MODE` | 重 | 一致 |
| 54 | assistant worker（`assistant.processor.ts:28-58`） | `cmd/api/assistant_runs.go:104-119`、`assistantqueue/worker.go:202-271` | `API_GO_ASSISTANT_WORKER_MODE` | 重 | 一致；**R4-02（P2，已修复）** |
| 55 | KG 读 6 + 冲击传导 4 根（`knowledge-graph.resolver.ts`、`entity-intelligence.resolver.ts`、`knowledge-graph-impact.resolver.ts`、`entity-impact-graph.resolver.ts`） | `knowledgegraph/{subgraph,links,intelligence}.go`、`kgimpact/{impact,entityimpact,pearson}.go` | `API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` / `_KG_IMPACT_MODE` ∧ READ | 重 | 一致（有界、缓存键带 orgId、Pearson 逐行等价） |
| 56 | `reviewKnowledgeGraphEvidence`（`knowledge-graph-review.resolver.ts:98-104`） | `knowledgereview/store.go:68-72` | `API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE` | 全 | 一致（`settings.manage` OR `knowledgegraph.review`；audit→outbox 回退） |
| 57 | KG ingestion Cron（`knowledge-graph.ingestion.service.ts:41-104`） | `kgingestion/scheduler.go:187-416`、`cmd/api/kg_ingestion.go` | `API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE` | 全 | 一致（同 tick gate / 组织锁键 / 游标幂等） |

### 3.5 observability / 队列运维与计数 / BullMQ 协议

| # | Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|---|
| 58 | `/api/admin/queue-ops/*` 12 条（Nest 无对应路由，只有 Bull Board `/admin/queues`） | `queueops/{handler,service,operations,dlq,dto,audit}.go` | `API_GO_QUEUE_OPS_MODE` | 全 | 12 条全部「登录 + `queue.manage` + 平台管理员」；**R5-01（P2，补测试）** |
| 59 | itemPipeline 事件 → 组织计数（`queue-org-stats.{tracker,service}.ts`） | `queueorgstats/**` | `API_GO_QUEUE_ORG_STATS_MODE` | 全 | 三段 Lua 与 Nest byte-equal；单所有者租约 30s；R5-03/R5-04（P3） |
| 60 | 保留 job 清理（`common/bullmq-queue-cleanup.service.ts`） | `bullmqcleanup/**` | `API_GO_BULLMQ_CLEANUP_MODE` | 全 | 15 个 queue 条目对齐；租约 55m > runTimeout 30m；R5-07（P3） |
| 61 | 启动对账（TaskLog/LLM 日志 TTL + ES ensureIndex） | `startupreconcile/reconcile.go` | `API_GO_STARTUP_RECONCILE_MODE` | 全 | 一致（租约 5m > 2m，失败只告警） |
| 62 | adminlogs 7 条 GET（`admin-logs.controller.ts:79-220`、`admin-errors.controller.ts:12-60`） | `adminlogs/**` | `API_GO_ADMIN_LOGS_MODE` | 重 | 一致（orgId 只取身份、pageSize≤100、escapeRegex） |
| 63 | llmlogs 3 条 GET（`llm-request-log.controller.ts:182-320`） | `llmlogs/**` | `API_GO_LLM_LOGS_MODE` | 重 | 一致（where 恒含 orgId、CSV 防公式注入、审计） |
| 64 | 异常上报 2 条 POST（`client/internal-exception-events.controller.ts`） | `exceptioningest/**` | `API_GO_EXCEPTION_INGEST_MODE` | 全 | 一致（403/401 顺序、常数时间比较、10MiB→413、丢弃客户端身份字段） |
| 65 | pipeline runs / replay / rollback（`pipeline-recovery.controller.ts:22-54`） | `pipelinerecovery/**` | `API_GO_PIPELINE_RECOVERY_MODE/_WRITE_MODE` | 重 | 一致（读带 orgId、写单条且校验 orgId）；R5-05（P3） |
| 66 | 运行时诊断 2 条 GET | `runtimediagnostics/**` | `API_GO_RUNTIME_DIAGNOSTICS_MODE` | 重 | 一致（探测目标来自管理员设置、独立 deadline 2s/5s、不回显密钥） |
| 67 | `/api/admin/quality/*` 5 条（`quality-overview.controller.ts` 等） | `qualityoverview/**` | `API_GO_QUALITY_OVERVIEW_MODE` | 抽查 | 60s 快照键/TTL 与 orgId 传递抽查通过，未逐行 |
| 68 | Bull Board `/admin/queues`（`queue-admin.module.ts:40-65`、`bull-board-auth.middleware.ts:22-56`） | 未迁（代理回 Nest） | `BULL_BOARD_ENABLED` | 重 | Go 控制台是替代入口；面板本身不动（见 §7-5） |
| 69 | 通用 BullMQ 协议（`bullmqwire`） | `bullmqwire/**` + 各 worker 的 vendored Lua | — | 全 | `Prefix="bull"`、15 个 hash 字段（含 `atm` 别名）、`KeepsFinishedJob` 均一致；89 个 vendored Lua 与 bullmq 5.63.2 `dist/cjs/scripts/*.js` 的 `content` 逐字节比对：88 个完全相同，1 个命名错 R5-02（P3） |
| 70 | `/api/metrics`（`metrics.controller.ts:33-62`） | `internal/metrics`（其他窗口） | `API_GO_METRICS_MODE` | 未 | 不在本窗口 |

### 3.6 本窗口开关门控核对（A8：两侧是否读同一环境变量）

对 `config.go` 中本窗口相关的 30 个 `API_GO_*` 逐个在 `apps/api/src` 内反查引用（排除 `env.schema.ts`）：

- **Nest 0 引用（纯 Go 执行所有权，符合 `switch-matrix.md` 的「Nest 同读=否」）**：`GRAPHQL_READ_MODE`、`GRAPHQL_SUBSCRIPTIONS_MODE`、
  `GRAPHQL_WORKSPACE_READ/WRITE_MODE`、`GRAPHQL_ALERT_RULES_MODE`、`DASHBOARD_*`（9 个）、`QUEUE_OPS_MODE`、
  `PIPELINE_RECOVERY_MODE/_WRITE_MODE`、`METRICS_MODE`、`ADMIN_LOGS_MODE`、`LLM_LOGS_MODE`、`EXCEPTION_INGEST_MODE`、
  `QUALITY_OVERVIEW_MODE`、`CLASSIFICATION_REPORTS_MODE`、`CLASSIFICATION_RSS_OPS_MODE`。
- **Nest 同读且变量名/取值语义一致**：`ALERT_WORKER_MODE`（`alerts.processor.ts:95`）、`REALTIME_SOCKET_MODE`
  （`situation-monitor-signals.dispatcher.ts:92`）、`NOTIFICATIONS_SOCKET_MODE`（`notification-realtime.relay.ts:41`、
  `generic-notification.subscriber.ts:151`）、`QUEUE_ORG_STATS_MODE`（`queue-org-stats.tracker.ts:86`）、
  `ANALYSIS_WORKER_MODE`、`ASSISTANT_WORKER_MODE`、`KNOWLEDGE_GRAPH_INGESTION_MODE`、`CLASSIFICATION_QUALITY_ALERT_MODE`、
  `CLASSIFICATION_QUALITY_WORKER_MODE`、`CLASSIFICATION_REVIEW_SEED_MODE`、`AUDIT_OUTBOX_MODE`、`AUDIT_LOG_RETENTION_MODE`、
  `BULLMQ_CLEANUP_MODE`、`STARTUP_RECONCILE_MODE`。
- **结论**：本窗口范围内未发现「两侧读不同变量名」或「Nest 读而 Go 不读」的门控错误。唯一的门控类 P3 是
  `BULLMQ_WORKERS_ENABLED` 在 Go 侧的告警 worker 入口不被复读（R3-03），见 §4.3。

---

## 4. 发现列表

### 4.1 汇总

| 编号 | 级别 | 标题 | 处理 |
|---|---|---|---|
| R3-01 | **P1** | 告警投递占用 CAS 结果被丢弃，重叠 attempt 会重复外发 | 已修复 `d09384d1` + 测试加固 `c38b6269` |
| R1-01 | P2 | `ingestCrawlTaskResultsToItems` 的 `limit` 实参类型断言错，永远被忽略 | 已修复 `58311e16`（跨窗口最小改动） |
| R1-02 | P2 | GraphQL 限流预算只读 Redis、无 MySQL 回填，管理员配置在冷缓存后失效 | 已修复 `1375bd26` |
| R1-05 | P2 | graphql-js 级执行期错误被标 HTTP 500，Nest/Apollo 是 200 | 已修复 `e8275d00` |
| R2-01 | P2 | SSE 帧写无超时，停止读取的客户端会永久挂住 publish goroutine | 已修复 `b32d4fa0` |
| R2-02 | P2 | gqlsub 频道 SUBSCRIBE 失败后留下「假在线」feed，该频道在进程内永久失聪 | 已修复 `5a71b6c5`（Nest 既有问题，Go 已修复，行为变化） |
| R2-03 | P2 | 慢客户端在事件源协程上造成队头阻塞（同步写 5s 超时） | 只记录（需 per-connection 出站队列，属重构） |
| R4-01 | P2 | 创建分析任务卡片时显式 `"priority": null` 被 400，Nest 落 `normal` | 已修复 `bc0f71d8` |
| R4-02 | P2 | assistant 流式分片阈值用 UTF-8 字节而非 JS `String#length` | 已修复 `b9213dcb` |
| R4-03 | P2 | 分析协作 23 条 HTTP 拒绝 `mtk_` 机器令牌，Nest REST 接受 | 只记录（跨窗口：鉴权链统一批次） |
| R5-01 | P2 | 队列运维控制台 12 条路由的鉴权链只有 1 条被测 | 已补测试 `90c7ccf7`（无行为变化） |
| R1-04 | P3 | 响应缓存白名单未把根 `__typename` 计入，与 Nest 的缓存判定不一致 | 已修复 `5dbf2330` |
| R1-03/07/08/09/10/12/13/14/15/16/17 | P3 | 见 §4.3 | 只记录 |
| R2-05…R2-11 | P3 | 见 §4.3 | 只记录 |
| R3-02/03/04 | P3 | 见 §4.3 | 只记录 |
| R4-04/05/06/07 | P3 | 见 §4.3 | 只记录 |
| R5-02…R5-08 | P3 | 见 §4.3 | 只记录 |

### 4.2 已修复项（逐条证据）

#### R3-01（P1）告警投递占用 CAS 结果被丢弃 → 同一 delivery 重复外发

- **Nest 证据**：`modules/alerts/alerts.service.ts:2162-2174` 的 `occupyDeliveryForSend` 返回 `updateMany(...).count === 1`；
  `:2099-2105` 的调用点是 `if (!occupied) return;` —— 行已被并发的另一个 attempt 改成非 `pending` 时**不再发送**。
- **Go 证据（修复前）**：`internal/alertworker/delivery.go` 的 `transitionDelivery` 丢掉了条件 UPDATE 的 affected 布尔，
  `occupyDeliveryForSend` 无条件 `return true`；而调用点 `delivery.go:131-136` 已经写着 `if !occupied { return nil }`，
  于是那段分支是死代码。
- **影响**：同一 `AlertDelivery` 的两个 attempt 在「读 pending → 另一 attempt 先 CAS → 本次 CAS 命中 0 行」的交错下
  会发第二封邮件 / 第二个 webhook。触发窗口是 BullMQ stalled 回收与重试重叠（`attempts=4`、`stalled` 检查存在）。
  属于「重复副作用」的 P1。
- **修复**：新增 `transitionDeliveryCAS` 返回条件 UPDATE 的判定，`occupyDeliveryForSend` 直接返回它
  （`internal/alertworker/delivery.go:229-243,280-289`）。顺带修正了一处过时注释（B1 的「Nest 用
  `attemptsMade >= attempts` 永不判定最后一次失败」在当前 main 已不成立，`alerts.service.ts:2136` 已是
  `attemptsMade + 1 >= attempts`）。
- **测试**：`internal/alertworker/integration_test.go` 新增子测试
  「a delivery that lost the send CAS is not sent again」（`//go:build integration`，用竞争事务持行锁制造确定性交错，
  断言 0 次发送、行仍为 `sent`、`error` 为 NULL，并补一条「投递行确实可加载」的断言防用例空转）。
  该子测试位于既有 `TestAlertWorkerIntegration` 内，已被 CI 现有步骤 `go test -tags=integration ./internal/alertworker/ -run 'TestAlertWorkerIntegration'` 覆盖。
- **提交**：`d09384d1`（修复）、`c38b6269`（测试加固）。

#### R1-01（P2）`ingestCrawlTaskResultsToItems` 的 `limit` 永远被忽略

- **Nest 证据**：`graphql/resolvers/crawl.resolver.ts:244-259` 把 `limit` 正常透传到服务。
- **Go 证据（修复前）**：`internal/graphqlread/itemsingest/resolver.go:172-176` 用 `value.(float64)`；
  但执行器传入的是**已强制**的 GraphQL Int：内联字面量与 POST JSON 变量经 `json.Number`→gqlparser 后是 `int64`
  （`gqlparser` 的 `validator/vars.go` `case "Int"` 转 int64），只有 GET 查询串变量才是 `float64`。
  同仓其它 resolver 全部走 `contract.IntArg`/`AsInt`，只有此处是裸断言。
- **影响**：`internal/itemsingest/service.go:283-292` 退回默认 `take=50`；前端 `apps/web/graphql/crawl.graphql:158`
  显式传 `$limit`，于是 `scanned/hasMore/nextCursor` 与「一次入库 N 条」全部静默退化为 50，且不报错。
- **修复**：新增 `internal/graphqlread/itemsingest/ingest_options.go` 的 `parseIngestBatchOptions`，`limit` 改走
  `contract.IntArg`（覆盖 `int64`/`json.Number`/`float64`/`int`），缺失与显式 `null` 仍不设置该选项（等价 Nest 的
  `limit ?? null`）；顺带核对 `after`（String）与 `onlyMissing`（Boolean）无同类断言错。
- **测试**：`TestParseIngestBatchOptionsReadsAllCoercedIntShapes`（6 例）、`TestParseIngestBatchOptionsKeepsAfterAndOnlyMissing`。
- **提交**：`58311e16`。**这是 items 窗口的包**，按「跨窗口最小改动」处理并在提交信息中注明。

#### R1-02（P2）GraphQL 限流预算只读 Redis、无 MySQL 回填

- **Nest 证据**：`modules/config/rate-limit-config.service.ts:47-104` 的读取链是 Redis → 设置仓储（MySQL）→ 环境默认。
- **Go 证据（修复前）**：`internal/graphqlread/policy/limit.go:104-137` 的 `BudgetFor` 只读 Redis 键 `rate_limit:settings`，
  miss 时直接用环境默认；仓内其它限流器都有 DB 回填（`authlogin/ratelimit.go:104`、`crawltaskwrite/ratelimit.go:238`、
  `rbacapi/ratelimit.go:109`、`runtimesettings/ratelimits.go:248-264`）。
- **影响**：`rate_limit:settings` 的 TTL 是 60s，而 GraphQL 限流器自己从不写该键 → 管理员把 GraphQL 预算调低后，
  60 秒后 Go 侧永久回落到环境默认值（`RATE_LIMIT_LOGIN` 默认 5 → 预算 150/min），配置被静默忽略；
  调高时同样不生效。Nest 侧因为会回填，不受影响。
- **修复**：`policy.Limiter` 增加可选设置读取接口，Redis miss → MySQL `SystemSetting`；DB 读带 ≤200ms 超时，
  失败/未命中回落环境默认（不 fail-open）。`cmd/api/main.go` 只新增 **1 行**注入既有 `sharedDB`。
- **测试**：`policy/limit_test.go` 覆盖「Redis miss → DB 命中」「Redis miss → DB 未命中/出错 → 回落默认」两条分支与 clamp 边界。
- **提交**：`1375bd26`。**共享文件改动**：`apps/api-go/cmd/api/main.go`（1 行），见 §7-6。

#### R1-05（P2）graphql-js 级执行期错误返回 HTTP 500，Nest 是 200

- **Nest 证据**（`@apollo/server@4.12.2` 真实源码）：`requestPipeline.js:196-207` 只把 `extensions.http` 合进响应头；
  `ApolloServer.js:639` 对**无 `http` 扩展**的执行期错误保持默认 200；只有预执行错误经 `sendErrorResponse` 兜底 500。
- **Go 证据（修复前）**：`exec/project.go` 多处 + `exec/engine.go:219-231` 给「非空违规冒泡、Int/Float/String 强制
  失败、resolver 抛错归一为内部错误」这类 graphql-js 级错误附了 `http.status=500`。
- **影响**：同样是「部分数据 + errors」，Nest 返回 200（Apollo Client 保留 `data`），Go 返回 500
  （Apollo Client 按网络错误丢弃 `data`）。非空违规冒泡场景下前端会从「局部降级」变成「整页失败」。
- **修复**：这类错误不再附 `http.status`，保留 `code: "INTERNAL_SERVER_ERROR"`、`message`、`path`、`locations`；
  来自 Nest 异常过滤器语义的 `UNAUTHENTICATED(401)`、`FORBIDDEN(403)`、`BAD_USER_INPUT(400)`、`NOT_FOUND(404)`、
  `TOO_MANY_REQUESTS(429)` 仍带 `http.status`（在 `engine.go` 的鉴权/限流/协议分支，未改）。
- **测试**：`exec` 包表驱动断言三类：① 非空冒泡错误 → 无 `extensions.http` 且 `code=INTERNAL_SERVER_ERROR`；
  ② 未认证 → `http.status=401`；③ 限流 → `429`。
- **提交**：`e8275d00`。

#### R2-01（P2）SSE 帧写无超时 → 断线客户端挂住 goroutine

- **Nest 证据**：`modules/dashboard/dashboard.controller.ts:375-566` 的 SSE 写同样是无界 `res.write`（Nest 既有缺陷）。
- **Go 证据（修复前）**：`internal/dashboardstream/handler.go` 的 `writeFrame` 直接 `w.Write` + `Flush`，无写 deadline；
  客户端停止读取（合盖、NAT 断链）时 `w.Write` 永久阻塞，于是 publish goroutine、`writeMu`、ping ticker 与本次连接上
  仍在等待的共享读 waiter 全部被挂住。
- **修复**：新增 `streamSink`（`handler.go:388-440`）：每次写前 `http.NewResponseController(w).SetWriteDeadline(now+15s)`，
  首写失败即置 `failed` 并 `cancel` 该连接的上下文，让 ticker/ping/共享读一起收尾；返回前清 deadline 以免截断
  chunked 尾块。原来裸传的 `*sync.Mutex` 收敛进 `streamSink`。
- **测试**：`internal/dashboardstream/handler_test.go` `TestStreamStopsAfterClientWriteFails`。
- **提交**：`b32d4fa0`。

#### R2-02（P2）gqlsub 频道 SUBSCRIBE 失败后「假在线」

- **Nest 证据**：`modules/graphql-subscriptions/graphql-subscription-bus.ts:141-170` 有同类缺陷（按监听计数推断订阅状态）。
  本次修复标记为「**Nest 既有问题，Go 已修复，行为变化**」。
- **Go 证据（修复前）**：`internal/graphqlsubscriptions/bus.go` 用「本地监听计数」推断 Redis 是否已 SUBSCRIBE。
  若同一频道的第二个订阅者恰好在第一个的 SUBSCRIBE 窗口内注册、而第一个 SUBSCRIBE 失败，失败者释放后计数不为 0，
  该频道**永不重试** → 本进程的告警/分析/助手实时推送静默失效。
- **修复**：显式 `subscribed` 状态 + `subLock` 串行化 subscribe/unsubscribe 往返（带 5s/2s 超时），失败回滚后下一个
  调用者重试；`Start` 允许注入 `pubSubConnection` 以便无 Redis 单测。
- **测试**：`internal/graphqlsubscriptions/bus_test.go` 3 例（失败后重试能收到事件 / 同频道两组织只订一次且不串租户 /
  坏 JSON + 空 orgId + 未知 root 丢弃）。
- **提交**：`5a71b6c5`。

#### R4-01（P2）创建分析任务卡片时 `"priority": null` 被 400

- **Nest 证据**：`modules/analysis-workspace/dto/saved-analysis-view.dto.ts:234-237` 的 `@IsOptional` 让 `null` 通过校验；
  `analysis-workspace.service.ts:847` 是 `input.priority ?? normal`。
- **Go 证据（修复前）**：`internal/analysistasks/service.go` 的 `prepareCreate` 对显式 `null` 直接返回 400。
- **影响**：切换 `API_GO_ANALYSIS_BOARDS_MODE` 后，未选优先级的表单（发 `"priority": null`）创建任务直接失败。
- **修复**：新增 `createTaskPriority`（缺省/`null` → `normal`）；`prepareUpdate` 仍保留 400（Nest 的 update 是把 null
  直接写进非空列、走 Prisma 500，Go 给明确 400 并已在注释说明）。
- **测试**：`internal/analysistasks/service_test.go` `TestPrepareCreateFallsBackToNormalPriority` /
  `TestPrepareCreateKeepsExplicitPriority` / `TestPrepareUpdateRejectsNullPriority`。
- **提交**：`bc0f71d8`。

#### R4-02（P2）assistant 流式分片阈值用字节而非 JS `String#length`

- **Nest 证据**：`modules/assistant/assistant.service.ts:1684` 是 `buffer.length >= flushChars`（默认 80，UTF-16 码元）。
- **Go 证据（修复前）**：`internal/assistantruns/query.go:368` 用 `buffer.Len()`（UTF-8 字节）。同源正确写法在
  `analysisruns/stream.go:117,135`（`utf16Len`）。
- **影响**：assistant 固定输出简体中文（3 字节/码元），实际约 27 字就 flush → `gqlsub:assistantEvents` 的 running 分片
  约为 Nest 的 3 倍（Redis/socket 放大、前端节奏变化）。A7「UTF-16 长度」类。
- **修复**：包内新增 `utf16Len`，按码元累计比较，flush 时归零。
- **测试**：`internal/assistantruns/stream_test.go` `TestStreamMessagesFlushThresholdUsesUTF16Units` /
  `TestStreamMessagesFlushesAtThreshold`。
- **提交**：`b9213dcb`。

#### R5-01（P2）队列运维控制台 12 条路由的鉴权链只有 1 条被测

- **Nest 证据**：`modules/queue/bull-board-auth.middleware.ts:22-56` 只校验 `queue.manage`，而该权限是组织
  manager 的默认权限（`packages/config/src/rbac.ts:72-94`）。
- **Go 证据**：`internal/queueops/handler.go:129-153` 的 `authorize` 在 12 个调用点（`:145,157,174,191,213,235,257,284,321,343,365,396`）
  都要求「登录 + `queue.manage` + 平台管理员」，但旧测试 `internal/queueops/handler_test.go:187-222` 只测了 `pathQueues` 一条。
- **影响**：这是 B1（队列运维从组织级收紧为平台管理员）的收口点。以后新增一条路由若漏接 `authorize`，现有测试发现不了。
- **修复**：新增 `consoleRoutes`（12 条）+ `TestHandlerAuthorizationCoversEveryRoute`，逐条断言 401 → 缺 `queue.manage` 403 →
  非平台管理员 403；请求体故意用非法 JSON，使「鉴权若排在解码之后」退化成 400 从而暴露顺序错误。**纯测试，无行为变化。**
- **提交**：`90c7ccf7`。

#### R1-04（P3）响应缓存白名单未把根 `__typename` 计入

- **Nest 证据**：`graphql/graphql.module.ts:178-196` 的 `getRootFieldNames` 收集操作选择集里所有 `kind=FIELD` 的选择，
  **不过滤** `__typename`，因此「含根 `__typename` 且不在 `CACHEABLE_ROOT_FIELDS` 的文档」Nest 不进响应缓存。
- **Go 证据（修复前）**：`internal/graphqlread/exec/walk.go:497-509` 的 `directRootNames` 跳过 `__typename`，
  于是这类文档被 Go 缓存 30s 而 Nest 会重算。Apollo Client 默认 `addTypename:true`，所以影响面是「所有带根
  `__typename` 的经济/图谱只读文档」。
- **前提更正**：`exec/engine.go:433-437` 的缓存键哈希含**完整 query 文本**，所以「只差根 `__typename` 的两个文档」
  **不会**共享缓存条目；真实差异只是「该文档**是否**进缓存」，故定级 P3 而非 P2。
- **修复**：`directRootNames` 不再跳过 `__typename`（唯一调用点是 `ResponseCacheable`），`engine.go` 补同源注释。
- **测试**：`internal/graphqlread/exec/cache_test.go` `TestResponseCacheableMatchesNestWhitelist`（10 例）+
  `TestCacheKeySeparatesDocumentsAndIdentities`。
- **提交**：`5dbf2330`。

### 4.3 只记录项（未修复，理由见各行）

| 编号 | 级别 | 标题 | 证据 | 未修理由 |
|---|---|---|---|---|
| R1-03 | P3 | 限流器把 6 个 `RATE_LIMIT_REDIS_*` 调参写死 | `policy/limit.go:87-95` vs `rate-limiter.service.ts:88-96` | 观测性调参，不影响判定 |
| R1-07 | P3 | 复杂度计分的输入集合差异（Go 会应用 `@skip/@include` 与强制后的变量，Nest estimator 用原始变量） | `exec/walk.go:355-484` vs `graphql.module.ts:399-444` | 需实测才能定论，方向对结果影响小 |
| R1-08 | P3 | Go 接受 `application/graphql`，Nest 不收 | `envelope.go:91-178` | 更宽容，不产生错误结果 |
| R1-09 | P3 | gzip/deflate 请求体 Go 直接 400，Nest 解压 | 同上 | 反向代理通常已解压 |
| R1-10 | P3 | `graphqlCode` 状态表不全（405/410/412/413/415/422/428/501/502/504 → `INTERNAL_SERVER_ERROR`） | `exec/response.go:8-17` | 冷门状态码，仅影响 `extensions.code` |
| R1-12 | P3 | 限流计数粒度（Go 每 root，Nest 每 field resolver） | `envelope.go:204-239` | 需实测 |
| R1-13 | P3 | 413 body 缺 `traceId/path/timestamp` | `envelope.go:29-49` | 极端请求体的错误体形状 |
| R1-14 | P3 | Go 不设 `x-trace-id`，`traceId` 仅在有时写入错误体 | `exec/response.go` | 前端容错，域文档已把它当契约 |
| R1-15 | P3 | 参数级「未实现」无法在归属判定时发现（`contract.Root` 无参数元数据） | `contract/contract.go` | R1-01 是实例；修根因需扩展 contract 元数据 |
| R1-16 | P3 | `Accept` q 值用子串匹配，`;q=0.5` 会被误判为可接受 | `envelope.go` | 需实测客户端 |
| R1-17 | P3 | 订阅事件投影错误仍带 `http.status=500`（R1-05 只收口了 Query/Mutation 的 HTTP 层） | `exec/subscription.go:132,230` | 订阅帧本身是 graphql-transport-ws `next`+`error`，HTTP 层已是 200，只是 body 多一字段；`exec/subscription.go` 语义归属订阅窗口 |
| R2-05 | P3 | init 前的 `ping/pong/complete` 不返回 4401 | `graphqlsubscriptions/connection.go` | graphql-ws 语义细节 |
| R2-06 | P3 | 心跳 idle 只认 pong，engine.io 是任意包都重置 | `socketio/connection.go` | 客户端正常会发 pong |
| R2-07 | P3 | `connectWait` 10s vs socket.io `connectTimeout` 45s | `socketio/*` | 只在极慢握手时可见 |
| R2-08 | P3 | 两条 path 对未知 namespace 行为不一致（`Invalid namespace` 保连接 vs `Unknown namespace` + 断开），且不支持 polling 回退 | `realtime*.go` / `notificationssocket/connection.go:44-51` | 已知设计差异（`docs/refactor/go-realtime-socket.md`） |
| R2-09 | P3 | `/notifications` 读上限 `1<<20` vs engine.io `1e6` | `notificationssocket/runtime.go` | 差 48576 字节 |
| R2-10 | P3 | 每进程两条 `bull:itemPipeline:events` XREAD（与 `queueorgstats` 各一条）；`QueueObserver.Close` 对注入 Store 的所有权有歧义 | `graphqlsubscriptions/queue.go` | 当前 main 未触发歧义路径 |
| R2-11 | P3 | 投影错误后 Go 继续订阅，graphql-js 会结束订阅 | `graphqlsubscriptions/*` | 语义细节 |
| R3-02 | P3 | `notifyAllMembers` 候选集合含 inactive 用户（Nest 先 `isActive:true` 过滤） | `inapp.go:36-46`、`repository.go:647-657` vs `alerts.service.ts:1678-1687` | 最终投递集合不变（权限判定仍要求 active），只在「组织内全 inactive」时 Nest 回退 `createdById` |
| R3-03 | P3 | alertworker 不复读 `BULLMQ_WORKERS_ENABLED` | `cmd/api/alert_worker.go:33` vs `alerts.processor.ts:33-36` | 部署注意项，见 §7-4 |
| R3-04 | P3 | 规则调度对账只在启动时一次 | `alertworker/service.go:189-203` | Nest 同为启动时；运行期 Redis 键丢失需重启恢复 |
| R4-04 | P3 | stalled 终局前会多发一次 `running` 事件 | `analysisruns/service.go:206` vs `analysis.service.ts:304-359` | 无持久化副作用 |
| R4-05 | P3 | 分析模型流把 `ANALYSIS_LLM_TIMEOUT_MS` 当整段流总时限，Nest 是空闲超时 | `publicportal/analysis_stream.go:259-263` vs `litellm.service.ts:1290-1420` | 跨窗口（`publicportal`），>300s 长分析会失败 |
| R4-06 | P3 | 分析流未复刻 `response_format`（`json_object` 模式） | `publicportal/analysis_stream.go:219-244` vs `litellm.service.ts:2743-2752,1321` | 跨窗口；默认 `json_schema` 一致 |
| R4-07 | P3 | 导出两路先鉴权后读 body，协作路由先读 body | `analysisexport/handler.go:80-96`、`analysiscollab/http.go:51-69` | 「无令牌 + 坏 JSON」Nest 400、导出 Go 401；无安全后果 |
| R5-02 | P3 | `itempipeline/scripts/moveToDelayed-9.lua` 版本名/来源标注错（5.63.2 只有 `moveToDelayed-8`，内容仅多一个行尾空行） | bullmq 5.63.2 `dist/cjs/scripts/*.js` 逐字节比对 | 无行为差异，跨包，只记录 |
| R5-03 | P3 | `clean` 后组织计数不收敛（Lua 只发 `cleaned` 计数，不发逐 job `removed`） | `queueops/scripts/cleanJobsInSet.lua`；tracker 只认 5 状态 + `removed` | **Nest 既有问题**；改 Lua 或让控制台补偿都会破坏单所有者语义 |
| R5-04 | P3 | 单所有者读事件从 `$` 起读，租约丢失窗口的事件永久丢失 | `queueorgstats/tracker.go:55-63,238-243` vs `tracker.ts:45-56` | `switch-matrix.md` 已声明；持久化 last id 属设计取舍 |
| R5-05 | P3 | pipeline replay/rollback 无审计日志 | `pipelinerecovery/{handler_writes,writes}.go`；Nest 同 | **Nest 既有问题**；应两侧一起加，否则回退 legacy 后审计线中断 |
| R5-06 | P3 | 控制台状态视图无 `paused`，但清理视图有 | `queueops/dto.go:47-114` | 只影响可观测性 |
| R5-07 | P3 | cleanup 的 waiting 裁剪只处理 `wait`，Nest 会连带 `paused` | `bullmqcleanup/cleaner.go:201-231` vs `bullmq-queue-cleanup.service.ts:238-262` | 仅 `itemPipelineDlq` 配了 waiting retention，且 DLQ 不会被 pause；Go 更保守 |
| R5-08 | P3 | 计数缓存无重建工具 | 两侧皆无 | Redis 淘汰/TTL 过期后错值要等 30 天；runbook 提到的一次性校正无仓库内脚本 |

### 4.4 R4-03（P2，只记录）分析协作 23 条 HTTP 拒绝 `mtk_` 机器令牌

- **Nest 证据**：`common/guards/jwt-auth.guard.ts:36-41` 对 `mtk_` 前缀放行，`machine-token.service.ts:220-255`
  用令牌自带的 permissions（可含 `analysis.write`）。
- **Go 证据**：`internal/analysiscollab/http.go:33-47` 走 `authhttp.Authenticator` → `internal/authn/jwt.go:50-60`
  对 `mtk_` 前缀直接返回空 → 401。同窗口的导出两路**没有**此问题（`analysisexport/handler.go:80` 用
  `accountsecurity.Authenticator`，支持 `mtk_`），`internal/adminlogs` 等也支持。
- **影响**：用机器令牌调这 23 条协作 REST 的组织，切 `API_GO_ANALYSIS_{VIEWS,BOARDS,THREADS}_MODE=go` 后从 200 变 401。
- **未修理由**：修复点在 `internal/authhttp` / `internal/accountsecurity`（鉴权链统一层），属其他窗口范围；且
  `docs/refactor/go-analysis-collaboration.md:25` 目前明确写着「不额外开放 `mtk_`」，与 Nest 实际行为冲突。
  **建议**：由鉴权层批次统一决定（要么统一支持，要么统一不支持并改域文档），本窗口不引入半支持状态。
  已列入 §7-2。

---

## 5. 被推翻的疑点（不要重复审查）

**GraphQL 执行器**

- 疑点：生产环境 introspection 查询会落到 Go 执行。**不成立**：gqlparser 的 prelude 注入 `__schema`/`__type`，
  但这两个根未注册 → `KindLegacy` 整份转发 Nest（`exec/walk.go:58-64`、`exec/engine.go:126-132`、
  `cutover_roots_test.go:231-236`）。playground/introspection 开关仍由 Nest 决定。
- 疑点：`@PermissionsAll` 被降级成「仅登录」。**不成立**：`itemsingest/register.go:19-21,33-34` 是刻意
  `AllowAuthenticated`，权限在 resolver 内 `requireAll`（`resolver.go:131-137,147-152`），形状同
  `gql-permissions.guard.ts:61-84`。
- 疑点：省略变量被当成显式 `null`。**不成立**：`ast/argmap.go` 缺变量时省略该 key（`ArgMissing`）。
- 疑点：复杂度整数溢出可绕过 2000。**不成立**：SDL 只有 Query 根字段带分页参数（`schema.gql:2327,2355,2394…`），
  单层 `1+child*2^31` 远低于 int64。
- 疑点：批量查询被逐项执行。**不成立**：整份转发（`handler.go:155-158`）。
- 疑点：body 上限不一致。**不成立**：两侧都是 10485760。
- 疑点：CSRF 判定不一致。**不成立**：逐字对齐（`envelope.go:73-89`）。
- 疑点：限流 Lua/key/预算不一致。**不成立**：逐字同构。
- 疑点：interface/union 上的 fragment 被丢弃。**不可达**：SDL 无 interface/union。
- 疑点：校验失败时未注册 root 不回退。**不成立**：`engine.go:109-118` 先判 legacy。
- 疑点：`AllowAuthenticated` root 与装饰器不符。**不成立**：抽查 `me`/`myOrganizations`/4 个 notification root 一致。
- **R1-06 深度限制边界**：疑点「Go 多放行一层」。读真实源码 `graphql-depth-limit@1.1.0/index.js` 后**推翻**：
  `:22` 根字段以 `depthSoFar=0` 进入、`:54` 入口判 `depthSoFar > maxDepth`、`:61-70` 只有带 selectionSet 的 FIELD
  才 `+1`（叶子 `return 0`，`__` 前缀忽略）、`:71-78` fragment/inline/operation 不增层 → 8 的限制等于
  **允许 9 层、拒绝第 10 层**，与 `exec/walk.go:287-342` 逐字等价。
- **R1-11 APQ `version!=1` 形状**：对照 `@apollo/server@4.12.2` 的四个分支（含
  `private, no-cache, must-revalidate`）后**推翻**，与 Go 完全一致。

**订阅与实时传输**

- queueEvents 多实例重复推送：**不成立**，`XREAD` 只推本地连接（`queue.go:290-345`）。
- newsnow 混合模式下重复：**不成立**，NX key/TTL 与 uid 自跳逐字符一致（`realtimeevents/sources.go:140-196`）。
- 跨租户订阅泄漏：**不成立**，`orgId` 只来自服务端 envelope / jobctx，客户端无参数。
- Socket.IO 连接计数跨实例口径：**不成立**，adapter 8.3.0 未覆写 `allSockets`，两侧都是实例本地计数。
- Go 连 adapter `-request#` 会让 Nest `serverCount()` 卡住：**不成立**，Go 只 PSUBSCRIBE 广播频道。
- 需要处理 Nest `disconnectSockets()` 的 adapter DISCONNECT：**不成立**，全仓 0 命中。
- `PublishUser` 多加 orgId 过滤会漏事件：**不成立**，userId 全局唯一，Go 更严。
- token 来源顺序被统一：**不成立**，两种顺序按各 gateway 保留（`realtimesocket/namespaces.go:66-82`）。
- SSE 行缓存跨租户：**不成立**，键含 orgId 且回读校验（`dashboardspacetime/rowcache.go:41-44`）。
- 断线后订阅/goroutine 泄漏：**不成立**，逐个核对幂等释放。
- queueEvents `XREAD` 起点/重连重复：**不成立**。

**dashboard / 告警 / 通知投递**

- **D1（任务提示里的删除阻塞项）「告警规则全量 repeatable 对账仍只在 Nest」**：**不成立，已被 #140 关闭**。
  Nest 两件事在 `alerts.processor.ts:26-32` 的 `onModuleInit`：`scheduleScanJob()`（`alerts.service.ts:2536-2549`）
  与 `ensureAllSchedules()`（`:1284-1301`，先 `ensureDefaultRulesForAllOrgs()` 再全量 `ensureRuleSchedule`）。
  Go 在 `cmd/api/alert_worker.go:33` → `main.go:3270-3278` 构造并 `Start`，`Start` 失败直接让 api-go 启动失败；
  `alertworker/service.go:189-203` 的顺序是 `EnsureScanSchedule` → `ReconcileRuleSchedules` → 建 Worker，
  `reconcile.go:66-249` 有 Redis 租约 `lock:alert:rule-schedule-reconcile`（TTL 5m）、2m 单次超时、按 id keyset
  分页 200/页、并发 16（与 Nest 常量一致）。测试在 `reconcile_test.go` 与 `reconcile_integration_test.go`。
- 疑点：Go 侧有跨租户 IDOR（`triggerAlertRule`/`evaluateRule`/`deleteRule`/`updateEventStatus`/`getEventReplay`）。
  **本基线不成立**：任务描述引用的 `resolver.ts:246`、`service.ts:1123/1169` 已被后续 PR 改写；现在 Nest 侧
  `resolver.ts:257-258`、`service.ts:1227-1236,1013-1091,657-665,1257-1267` 都带 orgId，Go 侧
  `rules_write.go:226-273`、`events.go:174-215`、`replay.go:15` 逐项带 orgId。
- 疑点：dashboard 缓存键跨租户污染。**不成立**：warmap 键含 orgId 哈希（`cache.go:78-91`）、spacetime 快照键含 orgId
  且回读校验（`store.go:358-377`、`snapshot.go:87`）、进程内行缓存键含 orgId（`rowcache.go:41-44`）；
  13 条 SQL 的 orgId 谓词逐条核对。
- 疑点：4 次退避/重试判定缺失。**不成立**（attempts=4、退避表 60s/5m/15m、每次失败落库）。
- 疑点：扫描去重是偏差。**可接受增强**：Nest 每轮全量入队（`:1269-1283`），Go 用 Redis marker 跳过本窗口已评估规则
  （`evaluate.go:184-280`）；已登记为行为变化。
- 疑点：Nominatim 无超时/无降级。**不成立**（`geocoding/geocode.go:176-177,457` 3s 超时 + 按点跳过）。

**分析与助手 / 知识图谱**

- 疑点：视图/看板 owner 校验缺失。**不成立**（`analysiscollab/actor.go:74-81`、`analysisviews/service.go:312-324`）。
- 疑点：列/任务父归属缺失。**不成立**（每条写路径先 `LockBoard(orgId)` 再 `FOR UPDATE` 复查 boardId，跨看板 404）。
- 疑点：stalled/重复 finalize 重复写或重复通知。**不成立**（终态写全部带 `{_id,runToken,status:running}`，
  通知仅 `job.FinalFailure()` 一次）。
- 疑点：失败重试重复计费。**不成立**（每模型仅一次 HTTP，`started` 后禁 fallback）。
- 疑点：Pearson 除零/数值不稳定。**不成立**（`kgimpact/pearson.go:6-48` 与 `entity-impact-graph.service.ts:685-727` 逐行等价）。
- 疑点：KG 缓存键缺 orgId。**不成立**（三处前缀都带 orgId，失效前缀末尾带 `:` 不会误伤 `org-10`）。
- 疑点：kg ingestion 跨租户/重复消歧。**不成立**（单事务写图且全带 orgId；边 1062 重读、证据已存在不再
  `incrementEdge`）。
- 清单中的 `analysis.manage` 权限**不存在**（`packages/config/src/rbac.ts:29-31` 只有 read/write/run）。

**可观测 / 队列运维**

- waiting→`wait` 归一（两侧一致）、`isPaused` 是 `HEXISTS` 而非 `HGET`、`KeepsFinishedJob` 缺键语义一致、
  三段计数 Lua 手抄会漂移（实测 byte-equal）、DLQ 重放重复入队（`replay-<dlqJobId>` + EXISTS + 相等状态分支 → 幂等）、
  批量无上限（retry-failed/clean ≤1000、dlq ≤500、每 100 一批）、CSV 公式注入（已转义）、
  adminlogs 跨组织读（两侧都只用自身 orgId）、Go 接受 `mtk_` 放宽鉴权（Nest 全局 guard 同样分流）、
  内部端点缺 token 应 403（顺序正确：403/401/401）、OPTIONS 漏到 Nest 404（`appendExactKeyed` 恒加 OPTIONS）、
  `QUEUE_ORG_STATS=go` 会连带停 `queueEvents`（只停 tracker 自己的 6 个 listener）、
  cronlock 键与 Nest 不一致（都是 `lock:<key>` + 同样的 PEXPIRE/DEL 脚本 + `max(500ms, ttl/3)`）。

**跨域**

- 疑点：`notification:events:v1` 在删除 Nest 后无人发布。**不成立**：Go 侧多个生产者自行写 Notification 行后发布
  identifiers-only relay（`crawlexecution/service.go:85-100`、`newssourcescheduler/notify_export.go`、
  `classificationrssops/alert_relay.go`、`alertworker/bridge.go`）。

---

## 6. 未覆盖的部分与后续审查建议

**未覆盖（不要当已验证）**

1. **一切运行时行为**：未消费队列、未跑 worker、未触发锁续期/stalled/重试、未发真实 SMTP/webhook/模型请求。
2. **需要一次实测才能定论的项**：R1-07（`graphql-query-complexity` 计分实况）、R1-12（Nest guard 每字段限流计数）。
   方法：同一份 document 对 Nest 与 Go 各发一次，比对 `errors`/状态码/限流计数。
3. `alertworker/providers/**`（9 个 provider、约 4000 行）只核接口契约与 3 个 provider。
4. `dashboardcharts/dataviz.go`（1047 行）的分位计算与 `toFixed` 舍入只抽查；`warmap/assemble.go`、`cluster.go`、
   `spacetime/propagation.go` 为「重点」深度。
5. `analysisqueue/scripts/*.lua`、`assistantqueue/scripts.go` 的 Lua 只核字段名与调用签名，未逐脚本语义审查。
6. `analysisruns/anomaly.go` 四个检测器的阈值边界未逐条对比 `anomaly-detector.ts`。
7. `kgingestion/linker.go` 消歧打分、`kgimpact/{impact,entityimpact}.go` 聚合细节、`knowledgegraph/{normalize,settings}.go` 抽查。
8. `internal/qualityoverview/**` 只抽查；`internal/metrics/**` 属其他窗口。
9. `situationsignals` 的载荷补充实现、assistant 提示词与外部 model-service 契约。
10. SSE/WebSocket 的浏览器互操作（socket.io-client 4.8.1 polling 回退、旧 bundle 缓存）未实测。
11. 未做 `EXPLAIN`；索引覆盖（如 `AlertRule(metricProvider)`、`AlertEvent(ruleId,triggeredAt)`）只观察未结论。

**建议的后续审查**

1. 用「同一 document/同一连接两侧各发一次」的方式收口 R1-07/R1-12 与 `extensions.code` 全表。
2. `alertworker/providers` 逐 provider 对齐时间窗口与重试语义。
3. 为 dashboard 聚合补一次 `EXPLAIN` 审查（大数据量下的性能退化属 P2 类别，本窗口只做到「每条 SQL 带 orgId + 有界」）。
4. BullMQ worker 的优雅停机与 `context` 取消：本窗口只核对了关闭顺序与 `queueorgstats` 的 cancel+wg，
   其余 worker 建议统一审一次 goroutine 泄漏。
5. 机器令牌（`mtk_`）在全部 HTTP 路由上的支持矩阵，由鉴权层批次统一收口（见 §7-2）。

---

## 7. 删除 Nest 前必须确认的事项

1. **Nest 进程内的实时生产端桥**。`API_GO_REALTIME_SOCKET_MODE=go` 时 Nest 的
   `situation-monitor-signals.dispatcher.ts:92` 仍会把事件发布到 `situation-monitor:signals:events:v1`，Go 的
   `realtimeevents/situation.go` 只是订阅方；`API_GO_NOTIFICATIONS_SOCKET_MODE=go` 时
   `generic-notification.subscriber.ts:151` 停止订阅、由 Nest `notification-realtime.relay.ts:41` 改为发 relay。
   删除 Nest 前必须确认：**态势信号事件的产生者**与**所有通知生产端的 relay 发布者**都已由 Go 承担，
   且不会有「Nest 是唯一发布者」的通道。本窗口只核对了订阅侧与 Go 的生产点，未逐通道做生产端盘点。
2. **机器令牌（`mtk_`）路由口径**（R4-03）。Nest 全局 REST guard 接受 `mtk_`，Go 的部分路由不接受
   （分析协作 23 条；`authn/jwt.go:50-60` 直接拒绝 `mtk_` 前缀）。删除 Nest 前要么统一支持、要么确认没有调用方
   依赖这些路由的机器令牌，并同步改 `docs/refactor/go-analysis-collaboration.md:25` 的口径。
3. **`TRUST_PROXY` 层数必须与反代结构一致**。Go 用 stdlib `ReverseProxy` 会自动追加 `XFF`
   （`legacyproxy/proxy.go:500-503`），而 Nest 只有 `TRUST_PROXY` 非空才用 XFF 定 `req.ip`（`main.ts:40-53`、
   `request-ip.ts:11-25`），`infra/docker/docker-compose.yml:822` 默认空。为空时 Node 侧会把所有转发流量归到
   同一个 `rate:graphql:<api-go 地址>` 桶（120/min 后整批 429）。同一变量也被 Go 限流器读取
   （`config.go:4934` → `graphqlread/envelope.go:204-239`）。切 `/graphql` 前必须确认层数。
4. **`BULLMQ_WORKERS_ENABLED` 不是全局停 worker 开关**（R3-03）。Go 的告警 worker 入口只判 `API_GO_ALERT_WORKER_MODE`，
   不复读 `BULLMQ_WORKERS_ENABLED`（Nest `alerts.processor.ts:33-36` 会读）。删除 Nest 后若要「一键停所有 worker」，
   该语义在 Go 侧不成立。
5. **Bull Board `/admin/queues`**（`queue-admin.module.ts:40-65`）未迁。Go 的 `API_GO_QUEUE_OPS_MODE` 控制台是替代入口，
   但 Bull Board 面板本身仍由 Nest 提供；删除 Nest 前需确认面板访问者已切到 Go 控制台（或明确放弃面板）。
6. **共享文件改动**：本批改了 `apps/api-go/cmd/api/main.go` **1 行**（R1-02 注入既有 `sharedDB`）。
   未改 `internal/config/config.go`、未改任何 `API_GO_*` 默认值、未新增开关、未改 compose/env/Web。
   另有一处跨窗口改动：`internal/graphqlread/itemsingest/**`（R1-01，属 items 窗口）。
7. **只有 Nest 才写的数据**：本窗口未发现「只有 Nest 才写」的业务数据。已核对的例外是
   `audit_log_retention` 与 `pipeline_recovery` 的写路径均已有 Go 侧对等实现；未逐表核对全部写路径，见 §6。

---

## 8. 验证

- 静态验证：`gofmt -l` 对全部改动文件无输出；`git diff` 逐条复核；未运行 build/vet/test/pnpm/Docker/服务。
- 远端验证：由既有普通 GitHub Actions CI 执行（`verify` 的 `go test ./...` 覆盖本批全部新增单测；
  `api-go-user-settings-integration` job 中既有的 `./internal/alertworker/ -run 'TestAlertWorkerIntegration'`
  覆盖 R3-01 的新增子测试）。**本批未新增 workflow，未修改 CI 步骤**。
- CI 结论、精确 head SHA 与 run 链接见 PR 描述；skipped 不算通过。
