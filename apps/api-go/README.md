# api-go —— 主后端 Go 网关（仓库默认）

NestJS `apps/api` 的渐进替代入口，**现在就是仓库默认后端**：136 个业务 `API_GO_*_MODE` 未设置时取 `go`，`API_GO_LEGACY_FALLBACK_MODE` 未设置时取 `reject`——未被任何规则匹配的请求直接按 NestJS 全局异常过滤器的 404 响应，不会暗中转发给 NestJS。NestJS `apps/api` 只作为显式回退保留（compose 的 `legacy-node` profile、`pnpm dev:legacy`）。

下文各段保留迁移批次的历史说明（"默认 legacy"是当时的事实），当前默认以 `config.go` 的解析分支与 `docs/refactor/cutover/` 为准。回退见 `infra/docker/legacy-rollback.override.yml` 与 `infra/docker/legacy-rollback.env.sample`；四态路由表语义见 `docs/refactor/api-go-four-mode.md`。

Go-批3B 起，**user-settings 六个只读 GET** 在 pilot 中由统一 Go handler 接管（`API_GO_USER_SETTINGS_READ_MODE=go`）。Go-批3C 起，**同一六个 PUT** 在 `API_GO_USER_SETTINGS_WRITE_MODE=go` 时由 Go 写入现有 `UserSetting` 并重读返回；该变量默认 `legacy`，且 `go` 要求读模式同为 `go`。登录、refresh、logout、MFA、OIDC、机器令牌仍是 NestJS。

Go-批4A 起，**公开首页与频道**在 `API_GO_PUBLIC_PORTAL_MODE=go` 时由 Go 查 MySQL 并完整响应（匿名，不走 JWT/RBAC）。Go-批4B 起，同一开关再接管 `GET /api/public-portal/stories/id/:id` 与 `stories/slug/:slug`（各恰好一个路径段，仅 GET）。默认 `legacy`，生产入口仍是 Web → NestJS。缓存命中的故事详情已在真实栈验证；缓存缺失时调用真实模型网关并写回新 brief 已实现，尚未真实调用模型。启用 `go` 前应确认模型网关配置可用。回滚：`API_GO_PUBLIC_PORTAL_MODE=legacy`。public-portal 没有整模块迁完。

Go-批5A 起，**`GET /api/dashboard/stats`** 在 `API_GO_DASHBOARD_STATS_MODE=go` 时由 Go 独立响应：验签后的 orgId 与 `items.read` 来自 MySQL 重推导，再读 `ItemMeta` 计数、Mongo `processeditems` / `tasklogs`，以及 Redis 里已有的组织队列计数。默认 `legacy`。不启动队列 worker，不写 Redis 计数。MySQL 或 Mongo 失败返回 5xx，不用 0 代替。Redis 计数读失败时 `queueCountsAvailable=false` 且五个计数为 0。回滚：`API_GO_DASHBOARD_STATS_MODE=legacy`。其他 dashboard 路径仍是 NestJS。

Go-批5B 起，**三个只读图表 GET** 在 `API_GO_DASHBOARD_CHARTS_MODE=go` 时由 Go 独立响应：`GET /api/dashboard/sector-heatmap`、`GET /api/dashboard/financial-candlestick`、`GET /api/dashboard/war-map/geojson`。三条都验签并重推导 `dashboards.read`，即使 GeoJSON 是静态文件也不能匿名访问。热力图和 K 线读真实 MySQL `EconomicDataItem` / `EconomicDataPoint`（`economic-short` 最多 8 格，K 线固定 `sp500_index`）。GeoJSON 使用编译进二进制的 `world.geo.json`，请求时不访问 NestJS 或外网。日期查询与 NestJS 相同：ISO 校验、缺省 30 天、UTC 日边界。默认 `legacy`。这个开关不改变 `GET /api/dashboard/stats`，也不接管 war-map 的 layers/transport-detail、spacetime 或 `/api/dashboard/stream`。events 与 news-markers 见批5C。回滚：`API_GO_DASHBOARD_CHARTS_MODE=legacy`。

Go-批5C 起，**两个 War Map GET** 在 `API_GO_DASHBOARD_WAR_MAP_MODE=go` 时由 Go 独立响应：`GET /api/dashboard/war-map/events` 与 `GET /api/dashboard/war-map/news-markers`。两条都验签并重推导 `dashboards.read`。orgId 只来自 membership，并贯穿 MySQL、Mongo 和 Redis 缓存键。events 读该组织时间范围内的 `AlertEvent` 和有位置的 `ProcessedArticle`；news-markers 读 `ProcessedArticle` 及其 `Article`。只有 MySQL 新闻结果为空时才回退 Mongo `processeditems`（标记还会读 `rawitems` 的 URL）。日期不按 UTC 整日对齐。新闻标记会走已有地理缓存、最多 3 次 Nominatim，失败后用国家中心点。`translate=zh-CN` 使用 SystemSetting 里的翻译配置和 `SITUATION_MONITOR_TRANSLATION_*`；没有凭据或调用失败时省略中文字段，请求仍然成功。默认 `legacy`。启用 `go` 前需要 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。layers、transport-detail、stream 不在这个开关里。回滚：`API_GO_DASHBOARD_WAR_MAP_MODE=legacy`。

Go-批5D 起，**transport-detail** 与 **layers** 各有独立开关，默认都是 `legacy`。`API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE=go` 只接管精确 `GET /api/dashboard/war-map/transport-detail`：验签并重推导 `dashboards.read`，orgId 只来自 membership，从 Mongo `MapTransportObjectState` / `MapTransportTrackPoint` 读该组织对象。范围内没有轨迹才回退该对象最近轨迹。对象不存在时 `detail` 为 null。`API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE=go` 只接管精确 `GET /api/dashboard/war-map/layers`：静态图层在 Go 内生成，动态图层复用批5C 的 events/news 查询，不回调 NestJS。military 航班读该组织 Redis ADS-B 快照；AIS 读该组织 AIS 快照和 source state。`flightMode=all` 走现有 OpenSky viewport、配置和信用预算，不新开采集 worker。`translate=zh-CN` 复用当前翻译配置，失败则省略中文字段。这两个开关都不改变 events/news-markers，也不接管 `/api/dashboard/stream`。spacetime 见批6A。回滚分别把对应变量改回 `legacy`。

Go-批6A 起，**Spacetime 热力图**与**传播图**各有独立开关，默认都是 `legacy`。`API_GO_DASHBOARD_SPACETIME_GEO_MODE=go` 只接管精确 `GET /api/dashboard/spacetime/geo-heatmap` 和 `GET /api/dashboard/spacetime/geo-heatmap/articles`。`API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE=go` 只接管精确 `GET /api/dashboard/spacetime/propagation` 和 `GET /api/dashboard/spacetime/propagation/articles`。四条都验签并重推导 `dashboards.read`，orgId 只来自 membership。日期按 UTC 整日对齐，不使用 War Map 的非整日范围。热力图读该组织有地点的 `ProcessedArticle`，Mongo 只补充情感；snapshot 写入 `dashboard:spacetime:geo-heatmap:snapshot:<orgId>:<id>`，TTL 一小时，并可被 NestJS 读回。传播图读 `NewsEventItem` 及关联文章，返回节点和传播边。MySQL 失败是 500，不是空数组。这两个开关不改变 stats、图表、War Map 或 `/api/dashboard/stream`。回滚：把对应变量改回 `legacy`。外部地理解析沿用已有缓存和国家中心点，实网 Nominatim 不在本批验收内。

Go-批6B 起，**Dashboard SSE** 与**认证版健康检查**各有独立开关，默认都是 `legacy`。`API_GO_DASHBOARD_STREAM_MODE=go` 只接管精确 `GET /api/dashboard/stream` 和同一路径的合格 CORS 预检。Go 在连接建立时验签、查 Redis 撤销名单，并从 MySQL 重推导 `dashboards.read` 与 orgId；之后按 NestJS 当前会话语义不再周期鉴权。首轮发布 war-map-events、war-map-news-markers、war-map-layers、financial-candlestick、spacetime-geo-heatmap；之后按各事件的稳定指纹只发布变化。geo-heatmap 单独失败发 `spacetime-geo-heatmap-unavailable`。其余更新失败发 `stream-error`，后续周期继续。数据来自已有的 War Map、K 线和 Spacetime 服务，同一次更新里的事件和新闻只查一次。不轮询 NestJS，也不请求 Go 自己的 HTTP。`API_GO_HEALTHZ_MODE=go` 只接管精确 `GET /api/healthz`。人类 access token 复用验签链且不要求业务权限；`mtk_` 机器令牌按 SHA-256 查 `MachineAccessToken`，有效即可访问，不会因此得到 `dashboards.read` 或 user-settings 权限。七项探针（MySQL、Redis、Mongo、crawl4ai、SSRF proxy crawl、LLM 配置、磁盘）只在这个认证请求里运行。整份响应缓存 5 秒；失败也返回 terminus 的 `status/info/error/details` 以及 `version` 和 `now`，HTTP 503。NestJS 的全局异常过滤器会把 503 收成通用错误体，两边的失败正文因此不同，状态码对齐。公开 `GET /api/healthz/live` 仍是 shadow。未配置的 crawl4ai、SSRF proxy 或 LLM 会如实失败，不会被写成全绿。生产入口仍是 Web → NestJS。回滚：`API_GO_DASHBOARD_STREAM_MODE=legacy` 只交回 SSE；`API_GO_HEALTHZ_MODE=legacy` 只交回认证版健康检查。

Go-批7 把个人内容订阅、新闻行为画像、每日摘要和投递设置的 15 条 HTTP 迁入 Go。三个开关各自默认 `legacy`，只决定对应精确路由：`API_GO_CONTENT_SUBSCRIPTIONS_MODE`、`API_GO_USER_NEWS_BEHAVIOR_MODE`、`API_GO_USER_DIGEST_MODE`。权限仍是 `items.read`。摘要开启时直接调用 Go 订阅与目录，推荐开启时直接调用 Go 画像，不看另外两个 HTTP 开关。默认 `legacy` 时邮件 Cron 仍由 NestJS 消费 `UserDigestDeliverySchedule`；启用下面的摘要投递开关后改由 Go 消费。说明见 `docs/refactor/go-personal-news-workspace.md`。

`API_GO_USER_DIGEST_DELIVERY_MODE` 是每日摘要后台投递的独立所有权开关，默认 `legacy`，只接受空串/`legacy`/`go`，空串按 `legacy`，非法值在 Nest 和 Go 都启动失败。它与上面三个 HTTP 开关以及 `API_GO_USER_DIGEST_MODE` 解耦：即使它们全部保持 `legacy`，`go` 也会在 Go 内独立初始化 MySQL、Redis、Mongo、订阅服务、摘要服务、runtime 读取器和既有 SMTP。`go` 时 Go 每分钟扫描 `UserDigestDeliverySchedule`，抢 Redis tick gate、按活动组织限并发、用 `lock:cron:user-digest-delivery:org:<orgId>` 续租锁、按 `nextRunAt/updatedAt/id` 游标分批认领到期日程、调用同一 `GenerateDigest`、真实发送 HTML+text 邮件并回写 `sent/empty_notified/failed`；NestJS 原 Cron 在尝试 tick gate 前直接退出，摘要专用通知 subscriber 启动，共享 Socket.IO 服务保持不变。通知先写 MySQL `Notification`，成功后再发布 `user-digest:notifications:v1`；NestJS 每个实例只向本实例已认证且 orgId/userId 均匹配的 socket 投递一次，不经过会跨实例广播的普通 dispatcher。

切换顺序：1）先部署默认 `legacy` 的新代码；2）所有 Nest 实例改 `go`，停旧 Cron、开 relay；3）等旧 in-flight 退出；4）再启 Go 后台 `go`。回滚顺序：1）停 Go 后台新任务；2）等 in-flight 收口、组织锁释放；3）再把所有 Nest 实例改回 `legacy` 恢复 Cron。共用 tick/组织锁和 SQL CAS 只是混合版本期间的保护，不能代替明确的单一执行权。Go 后台本身不验 JWT，也不要求 `JWT_SECRET` 或任何 HTTP 开关；`go` 要求 `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI` 与既有 `SMTP_*`。SMTP 连接在到期发送时创建，不做启动实网探测；ES 关键词读取沿用既有可选回退。说明见 `docs/refactor/go-digest-delivery.md`。

`API_GO_AUDIT_OUTBOX_MODE` 是审计日志失败补偿链的独立所有权开关，默认 `legacy`，只接受空串/`legacy`/`go`，空串按 `legacy`，非法值在 Nest 和 Go 都启动失败。`legacy` 保留 NestJS 每分钟 `retryPendingAuditLogOutbox`；`go` 时 NestJS 在申请 Redis 锁和扫描之前直接退出，Go 每分钟扫描 `AuditLogOutbox` 的 pending/failed（`availableAt <= now`）与超过 5 分钟未续租的 processing，三路各取 200 条轻字段合并排序后取 200 条，并发 8 条执行条件认领。成功路径按 `(orgId, actorId, resource, action, createdAt)` 查重后写入 `AuditLog`（保留 payload 的业务 `createdAt`、metadata、ipAddress）再删除 outbox；失败路径用认领后的 `attempts` 计算 `round(30000 * 2^max(min(attempt,5)-1,0) * (0.5+random()))` 毫秒退避，第 10 次转 `dead`。payload 无效或 `payload.orgId` 与 outbox 行不一致时不写审计行，直接 `dead` 且 `lastError="Invalid outbox payload"`。租约键为物理键 `lock:cron:audit-log-outbox`（`SET NX PX 55000`、随机 token、约 TTL/3 续租、按 token 释放）。Go 只要求 `DATABASE_URL` 与 `REDIS_HOST`，不要求 JWT、Mongo、SMTP，也不强开任何 HTTP 模式；`SCHEDULE_ENABLED=false` 时 Nest 与 Go 都停止调度本链。启用前先停所有旧 Nest 实例的本链调度并 drain，再把模式切 `go` 并启动 Go；回滚先停 Go 并 drain，再恢复 Nest `legacy`。旧版本不识别该 gate 时必须先升级或停止。说明见 `docs/refactor/go-audit-outbox.md`。

`API_GO_PROCESSED_ITEM_OUTBOX_MODE` 是条目流水线 `processed_item` MongoOutbox 补偿链的独立所有权开关，默认 `legacy`，只接受空串/`legacy`/`go`，空串按 `legacy`，非法值在 Nest 和 Go 都启动失败。`legacy` 保留 NestJS 每 5 分钟、每批 10 条的 `retryPendingOutbox`；`go` 时 NestJS 的 `NewsPipelineService.retryPendingOutbox` 在扫描前直接返回，由 Go 每 5 分钟按墙钟对齐扫描。流水线 worker 内的立即投递、进程内 `setTimeout` 重试和 outbox 创建都不变；Go 与 Nest 通过同一行 `pending/failed(availableAt<=now)` 或 `processing(lockedAt<now-5m)` 的条件更新互斥，因此切换窗口内不会重复投递。Go 成功路径保持原顺序：读取 `ItemMeta` 与 `RawItem`、按 `published_at`→`ItemMeta.publishedAt`→raw payload 顺序取时间、写 `ProcessedItem` upsert（含 `hasLocation`、向量维度、`duplicateOf` 转换）、按条件写 vector-go、更新 `ItemMeta` 完成态/名称/时间、upsert `itemreadmodels`、删除 outbox。失败仍按认领后的 `attempts` 使用 `round(30000 * 2^max(min(attempt,5)-1,0) * (0.5+random()))` 毫秒退避，第 10 次转 `dead` 并把仍为 `processing` 的 `ProcessedItem` 与读模型补偿为 `failed`；payload 不合法时领取后直接 `dead`，尝试次数取领取后的值。向量配置复用 `vector_service` 的 MySQL 行、Redis 缓存与环境默认值；未启用直接跳过，启用但缺 `baseUrl`/token 或调用失败时整次投递失败，Nest 的进程内熔断状态不移植。

B1 是有意变化：Go 的每次 tick 在 `PROCESSED_ITEM_OUTBOX_TICK_BUDGET_MS`（默认 240000，小于 5 分钟周期）内循环处理批次，而不是只取 10 条。每批 `PROCESSED_ITEM_OUTBOX_BATCH_SIZE`（默认 10）条、批内 `PROCESSED_ITEM_OUTBOX_CONCURRENCY`（默认 4）并发。大面积故障后积压可在单轮内推进多批；代价是 MySQL、Mongo 与 vector-go 压力上升，可用三个变量调低速度。扫描按 O1 只取 `id`（按 `createdAt` 升序），领取成功后才读取 payload；不合法 payload 的最终状态仍是 `dead`，只是判定时点从“扫描后、领取前”移到“领取后”。api-go 多副本用 Redis `lock:cron:processed-item-outbox`（PX 290000、token 续租/释放）保证同一时刻只有一个扫描者。Go 只要求 `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，不要求 JWT；`SCHEDULE_ENABLED=false` 时 Go 不启动。切换时先把 `api` 的开关设为 `go` 并重启，再把 `api-go` 设为 `go`；回滚反向。已有数据不回滚，未处理的 outbox 行格式不变，回退后 Nest 仍可按原低吞吐继续补偿。
`API_GO_CRAWL_MAINTENANCE_MODE` 与 `API_GO_AUDIT_LOG_RETENTION_MODE` 是采集维护四个 Cron 与审计日志保留清理的执行权开关，默认均 `legacy`，只接受空串/`legacy`/`go`，空串按 `legacy`，非法值在 Nest 和 Go 都启动失败。`legacy` 保留 NestJS 的 `cleanupCron`（janitor）、`retryPendingCleanupOutbox`、`adjustCron`（自适应并发）、`refreshRecentSnapshots`（每 5 分钟）与 `handleCron`（每天 1:00 本地时间）；`go` 时 NestJS 在读取活动计数、领取锁或 tick gate 之前返回，Go 按同一墙钟执行。四个采集 Cron 共用 `lock:cron:crawl-task-janitor`（默认 120s）、`lock:cron:crawl-cleanup-outbox`（55s）、`lock:cron:crawl-adaptive-concurrency`（45s）、`cron:crawl-quality-task-snapshot:tick-gate`（285s）与 `lock:cron:crawl-quality-task-snapshot:org:{orgId}`（240s），全部与 NestJS 的 `CacheService.withLock`/`claimSchedulerTick` 物理键一致；审计保留使用新键 `lock:cron:audit-log-retention`（30 分钟、自动续租）。写出格式保持等价：`CrawlTask.status/lastError`、`AuditLog`（含 outbox 兜底）、Mongo `tasklogs`、`MongoOutbox` 状态与退避、`CrawlQualityTaskSnapshot` upsert、`crawl:activity` hash、自适应状态 JSON（字段顺序与 `null` 保留）与 `crawl:worker-concurrency:v1` 广播。B1–B5 是 Go 侧有意的修复：队列扫描与积压计数纳入 `wait/paused/delayed/prioritized/active`；活动计数为 0 时仍检查并回收卡住的 `pending`；janitor 在事务内 `SELECT ... FOR UPDATE` 后只对实际更新的任务写审计/TaskLog/扣减计数；自适应降并发后额外广播让所有实例更新本地 worker；审计保留清理加实例租约并用主键游标分批。O1 合并 queued/pending 的一次队列扫描、O2 使用主键游标、O3 合并两条任务查询为 `UNION ALL`。`go` 要求 `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（审计保留只需前两项），不要求 JWT；`SCHEDULE_ENABLED=false` 时两边都停止调度。切换顺序：先 `api` 设 `go` 并重启，再把 `api-go` 设 `go` 并重启；回滚按相反顺序。切换窗口内同名锁/tick gate 保证同一时刻只有一边执行；审计保留在 Nest 侧无锁，但删除幂等。验证状态：单元测试覆盖合并/排序/去重、`lastError` 文案、JS `toFixed`（含 12.25 这类恰好一半）、自适应各分支与状态 JSON、ISO 时间、payload 校验与退避、开关解析；集成测试覆盖 B1/B2/B3、cleanup 投递/退避/死信/Mongo 删除、设置与广播/冷却、tick gate/组织锁/快照 upsert、审计主键游标 2500 行。没有在真实采集负载下运行，也没有在部署环境切换执行权；TZ 一致性只做静态核对（`api` 与 `api-go` 的 compose 服务都没有设置 `TZ`，均使用镜像默认的 UTC）。

分析工作台的保存视图、看板/列/任务、笔记与评论共 23 条 HTTP 由三个默认 `legacy` 的开关分别接管：`API_GO_ANALYSIS_VIEWS_MODE`、`API_GO_ANALYSIS_BOARDS_MODE`、`API_GO_ANALYSIS_THREADS_MODE`。`GET /api/analysis/boards` 与看板详情会在组织没有未归档看板时创建默认看板，不是纯读。讨论检查、评论计数和删除清理直接查库，不看另一个 HTTP 开关，也不回调 NestJS。条目与事件的 CSV 导出共 2 条精确 POST 由独立的 `API_GO_ANALYSIS_EXPORT_MODE` 接管；`POST /api/analysis/exports/search` 由独立的 `API_GO_ARCHIVE_READING_MODE` 接管（连同三个归档 Query）；Redis 订阅、分析/助手 worker、归档准备消费、采集流水线和邮件 Cron 仍由 NestJS 承担。说明见 `docs/refactor/go-analysis-collaboration.md` 与 `docs/refactor/go-analysis-export.md`。
`API_GO_ALERT_WORKER_MODE` 是告警队列（`alerts`）的独立执行权开关，默认 `legacy`，只接受空串/`legacy`/`go`，空串按 `legacy`，非法值在 Nest 和 Go 都启动失败。它与全部 HTTP 开关解耦：规则与通道的配置写入、告警读取接口、`AlertsQueueEventPublisher`、订阅传输层都不看这个变量。`go` 时 Go 消费与 NestJS 相同的 `alerts` 队列：定时 upsert `scan-active-rules` 计划；扫描为所有组织补建默认规则并入队到期规则；评估按 9 个 provider 取值、按冷却期预检并在同一事务里领取 `lastTriggeredAt`、写 `AlertEvent`、为每个活跃通道和有权限的接收人写 `AlertDelivery`；站内通知写 `Notification` 后发布 `alert:notifications:v1`，NestJS 的 alert subscriber 只向本实例 socket 推送一次；外部投递由同一个队列按 `alertNotifications` 退避表（60s/5m/15m，4 次尝试）发送邮件与 Webhook；触发后发布 `gqlsub:alertEvents`，envelope 与 NestJS 的 `GraphqlSubscriptionBus` 逐字节一致。NestJS 侧只保留幂等的 `scheduleScanJob`/`ensureAllSchedules`，并在创建 Worker 前退出。

任务格式不变：队列名 `alerts`、前缀 `bull`、job name（`scan-active-rules`/`evaluate-rule:*`/`deliver-notification:*`）、jobId（`evaluate:<ruleId>:<ms>`/`evaluate-<ruleId>`/`deliver-<deliveryId>`/`repeat:<md5>:<ms>`）、data 字段、opts（`attempts`、`backoff`、`removeOnComplete`、`removeOnFail`）与限速 key（`${BULLMQ_NAMESPACE}:alerts:notify:...`）都与 NestJS 相同，切换前后可以互相消费。延迟语义同样是 5.63.2 的 `moveToDelayed`：限速与间隔用 `skipAttempt=1`（不消耗尝试次数），重试用 `skipAttempt=0`（`atm` 只加一次）。

三处有意的行为变化：1）投递最后一次失败改判 `attemptsMade + 1 >= attempts`，因此最终失败会被正确标为 `failed`，事件也能汇总为 `failed` 或 `delivered`（NestJS 只改这一行）；2）评估只取 `channel.orgId` 等于 `rule.orgId` 的活跃通道，历史的跨组织关联被跳过并记 warn，不写投递记录；3）扫描只为「最近评估时间不存在或已超过 `max(60, checkIntervalSec)`」的活跃规则入队（Redis key `alerts:rule:last-evaluated:<ruleId>`，TTL 为 2×该间隔），因此间隔大于 5 分钟的规则按自己的间隔评估，5 分钟的扫描只作兜底，默认 300 秒的规则不再在每个扫描窗口被评估两次。

`go` 要求 `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI` 与既有 `SMTP_*`，不要求 `JWT_SECRET` 或任何 HTTP 开关。模型服务可选：`MODEL_SERVICE_*` 缺失或不可用时经济异常规则回退本地 z-score/滚动突变判定，与 NestJS 的 best-effort 一致。

切换顺序：1）先把 `api` 服务的开关设为 `go` 并重启，Nest 停止消费、进行中的任务处理完；2）再把 `api-go` 的开关设为 `go` 并重启。回滚按相反顺序，队列里未处理的任务格式相同，Nest 可以继续消费。已写入的事件、投递与通知保留，不回滚；失败时不在 Go 与 legacy 之间自动重放，因为投递可能已经发出。验证状态：单元与集成测试覆盖队列协议、事务领取、延迟与退避、限速 key、订阅 envelope、通知桥、模板快照与 9 个 provider 的 fixture；没有真实发送 SMTP/Webhook，没有调用模型服务，也没有在部署环境切换执行权。


## 运行

```bash
# 仓库默认配置（只给资源、不给开关）：全部业务路由由 Go 接管，fallback=reject
pnpm --filter @modular/api-go run dev
# 等价于
go run ./cmd/api

# 宿主开发时的资源与地址（按需覆盖）
PORT=4020 DATABASE_URL=mysql://user:pass@127.0.0.1:3306/app \
  REDIS_HOST=127.0.0.1 MONGO_URI=mongodb://127.0.0.1:27017/app \
  JWT_SECRET=... go run ./cmd/api

curl http://localhost:4020/api/healthz/live # 默认 go：由 Go 直接响应（Web 启动等待它）
curl http://localhost:4020/api/healthz      # 认证探针：需登录或机器令牌
```

回退到纯代理（NestJS 承载全部业务路由）需要**显式**给出旧值——省略变量不再等于 legacy：

```bash
API_GO_LEGACY_FALLBACK_MODE=proxy \
  + 136 个业务开关逐个设为 legacy（见 infra/docker/legacy-rollback.env.sample）
```

只设 `API_GO_LEGACY_FALLBACK_MODE=proxy` 而业务开关仍为默认 `go` 时，代理模式不会生效在任何已接管路由上。

## 生产容器与真实入口（Go-批2C）

生产镜像 `infra/docker/api-go.Dockerfile`：多阶段构建（`go mod download` → `CGO_ENABLED=0 go build -mod=readonly -trimpath`），运行阶段 distroless static nonroot（无 shell/无源码/无工具链），与 vector-go 同款策略。二进制内置 `healthcheck` 子命令：

```text
/api-go healthcheck   # GET 127.0.0.1:$PORT/__go/healthz；2xx 退出 0，否则非 0
```

distroless 无 curl——不为探针安装任何东西；Dockerfile 的 `HEALTHCHECK` 指令与 compose 服务的 healthcheck 均用 exec 形式调用该子命令（字符串形式 health-cmd 会经 `/bin/sh` 执行，distroless 下必失败）。

### Compose pilot（api-go-pilot profile，默认不启动）

```bash
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml \
  --profile api-go-pilot up -d api-go
```

- 端口：容器 4020，host `${API_GO_HOST_PORT:-4020}`（默认只绑 `DOCKER_PUBLISH_HOST`，即 loopback）；
- `LEGACY_API_URL=http://api:4000`；`DATABASE_URL` 由与 NestJS 相同的 `MYSQL_*` 派生（同一真实 MySQL，不复制数据）；
- `API_GO_USER_SETTINGS_READ_MODE=go`（Go-批3B 统一读模式：pilot 明确接管六个 user-settings 只读 GET；优先级高于 `API_GO_ONBOARDING_MODE`，后者仍注入 `go` 保持批3A 兼容）+ 与 NestJS 同源的 `JWT_SECRET`/`JWT_ISSUER`/`JWT_AUDIENCE` 与 `REDIS_*`（blacklist 共享，不建第二套撤销名单）；
- `CANARY_PERCENT=0`、`SHADOW_DEBUG_BODY_LOG=false` 固定；
- 依赖 `api`（NestJS）与 `mysql`、`redis` 均 healthy；
- 默认 legacy 模式（`Web → api:4000`）不受影响——profile 服务不随普通 `up` 启动。

### 入口切换与回滚

- 服务端（运行期）：`infra/docker/.env` 的 `API_BASE_URL=http://api-go:4020` → `Web → api-go → NestJS`；web 启动等待自动改探 `http://api-go:4020/api/healthz/live`（不再硬编码 `api:4000`，兼容 base 带不带 `/api`）。
- 浏览器端（构建期）：`NEXT_PUBLIC_API_BASE_URL=http://<host>:4020/api` 重建 web 镜像。页面源与 API 不同源时，Go 用与 NestJS 相同的 `CORS_ORIGIN` 回答六个 user-settings GET/PUT 的预检和实际响应（凭据开启，不反射名单外 Origin，不返回 `*`）。`X-Frame-Options` 仍只出现在 NestJS 代理响应上。
- 回滚按序：① `API_GO_USER_SETTINGS_WRITE_MODE=legacy`；② `API_GO_USER_SETTINGS_READ_MODE=shadow`（或删除该变量回到更早的读去向）；③ `API_BASE_URL` 指回 `http://api:4000`；④ 停 pilot。没有新表。

### 远端真实栈 smoke（`api-go-entry-smoke` workflow）

手动触发，不进 push/synchronize 普通 CI。主路径 `workflow_dispatch`（workflow 在默认分支注册后 `gh workflow run`）；PR 期间用 label `api-go-entry-smoke` 显式触发（与 ci.yml 的 regen label 门禁同一模式），运行后移除 label。真实 MySQL/Redis/Mongo service 容器 + 真实 `prisma migrate deploy` + 真实 NestJS 进程 + 构建并启动本 Dockerfile 的 api-go 容器（两阶段：先 `API_GO_USER_SETTINGS_READ_MODE=shadow`，后重启为 `go`）。

Go-批3B 起的四阶段验收（全部经 api-go 入口 + 真实登录 JWT）：

- **Phase A（写入准备）**：六个 PUT（含 situation-monitor 一次写入 monitors/layout/settings 三段）由 NestJS 单写 → MySQL 直查确认 8 个固定 key 均真实存在 → PUT 前后 shadow executed 不增加 → 相似路径（onboarding-x / war-map-x / newsnow/other）不误命中。
- **Phase B（shadow 对比）**：`readMode=shadow` 启动——六个 GET 都由 NestJS 响应，Go 做真实旁路查询与差分：executed 精确 +6（+healthz/live 共 +7）、diffs 零增量、六类 dropped 零增量、inflight 归零——不通过删除字段、宽松比较制造零差异。
- **Phase C（Go 接管）**：`readMode=go` 重启真实容器——六个 GET 与 NestJS 直连逐字段契约对比（status/`Cache-Control: no-store`/content-type/JSON 全等、各端点读自己的 key、situation-monitor 三段 updatedAt 对应正确）；Go 请求不增加 shadow.executed。
- **Phase C 写接管**（`WRITE_MODE=go`）：六个 PUT 由 Go 写入；之后 NestJS GET 与 Go GET 读同一行。空请求不插行。一个 key 的并发 upsert 只有一行。未知字段/错误类型/无权限/撤销 token 不写库。第二个 org/user 行数为 0。
- **Phase D（独立性证明）**：停止 NestJS 后六个 PUT 与六个 GET 仍成功；未迁移 GET（/api/items）返回 502。

共享鉴权链负向用例保留代表性端点（onboarding）：数据库无 `items.read`（JWT claim 仍有）双端 403 契约一致 → membership 停用双端 401 同文案 → 篡改签名与 alg=none 拒绝 → 真实 logout 写入真实 Redis blacklist → 撤销 token 401 "Access token revoked"。

**验证状态分层**：静态代码与单元/MySQL+Redis 集成测试由普通 CI 远端验证；真实入口链（容器 + 真实 NestJS + 真实登录 + Go 鉴权链 + Shadow 指标增量）由 `api-go-entry-smoke` 远端真实栈运行验证完成；**生产/预发布真实流量验证未完成**（api-go 未接入任何生产入口）。

Go-批4B 故事详情在同一真实栈里已验证缓存命中的 id/slug、公开组织边界，以及 NestJS 停止后 Go 独立返回完整缓存详情。缓存缺失时的模型网关调用和 `briefV1` 写回只做了静态审查，尚未真实调用模型。远端没有 `LITELLM_API_BASE` 或 `LITELLM_API_KEY` 时，smoke 跳过这段并写明未执行，不把跳过记为通过；凭据齐备时，真实请求失败、未写回 `briefV1` 或盖掉其他 metadata 仍然失败。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 4020 | 网关监听端口 |
| `LEGACY_API_URL` | http://localhost:4000 | NestJS apps/api 基址 |
| `API_GO_USER_SETTINGS_READ_MODE` | （空） | user-settings 六个只读 GET 的统一读模式（Go-批3B）：`shadow`=六个 GET 全部 NestJS 响应 + Go 差分；`go`=六个 GET 全部由统一 Go handler 接管（独立鉴权 + 独立查库 + normalization + 全响应）。**设置时优先级高于 `API_GO_ONBOARDING_MODE`**（onboarding 也归它管）；**未设置（空）=兼容旧行为**：onboarding 由 `API_GO_ONBOARDING_MODE` 控制，rss/spacetime 保持 shadow，war-map/newsnow/situation-monitor 保持 legacy（批3B 之前的部署不变）。非法值启动失败；`go` 模式要求 `JWT_SECRET`/`DATABASE_URL`/`REDIS_HOST` 齐备（缺失启动失败）。compose pilot 固定注入 `go`。回滚 = 改回 `shadow` 或删除本变量 |
| `API_GO_USER_SETTINGS_WRITE_MODE` | legacy | 六个 PUT（Go-批3C）。`legacy` 代理 NestJS；`go` 由 Go upsert 现有 `UserSetting` 并重读。`go` 要求读模式同为 `go`，否则启动失败。pilot 注入 `go`。回滚先改回 `legacy` |
| `API_GO_PUBLIC_PORTAL_MODE` | legacy | 公开首页、频道和故事详情（Go-批4A/4B）。`legacy` 代理 NestJS；`go` 时 `GET /api/public-portal/home`、`channels/:topic`、`stories/id/:id`、`stories/slug/:slug`（后三个恰好一个路径段，且仅 GET）由 Go 查 MySQL 并完整响应。详情 brief 冷路径读取 `llm_gateway_profiles`，并用已有的 `SYSTEM_SETTINGS_ENCRYPTION_KEY` / `LITELLM_*` 作为凭据与缺省网关。启用 `go` 前应确认模型网关配置可用。`go` 要求 `DATABASE_URL`，不要求 JWT/Redis。pilot 注入 `go`。默认生产入口不切换。回滚改回 `legacy`，不删数据 |
| `API_GO_DASHBOARD_STATS_MODE` | legacy | 只接管精确 `GET /api/dashboard/stats`（Go-批5A）。`go` 时 Go 验签、查 Redis 撤销名单、从 MySQL 重推导 orgId 与 `items.read`，再读 ItemMeta、Mongo processeditems/tasklogs 和 Redis 组织计数 hash。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，缺失则拒绝启动，错误不含连接串。pilot 注入 `go`。其他方法、子路径、`dashboard/stream` 和图表接口仍代理 NestJS。回滚改回 `legacy` |
| `API_GO_DASHBOARD_CHARTS_MODE` | legacy | 只接管三个精确 GET（Go-批5B）：`/api/dashboard/sector-heatmap`、`/api/dashboard/financial-candlestick`、`/api/dashboard/war-map/geojson`。`go` 时验签、查撤销名单、从 MySQL 重推导 `dashboards.read`。热力图和 K 线读 EconomicDataItem/EconomicDataPoint；GeoJSON 来自构建时嵌入的 world.geo.json，并带 `Cache-Control: no-store`。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求 `MONGO_URI`。与 stats 开关独立。pilot 注入 `go`。其他方法、war-map 其余路径、spacetime 和 stream 仍代理 NestJS。回滚改回 `legacy` |
| `CORS_ORIGIN` | （空） | 与 NestJS 相同的逗号分隔来源白名单。读写模式均为 `go` 时，六个精确路径的浏览器预检由 Go 204 回答，GET/PUT（含 401/400）回同一来源头。空名单不放行任何 Origin。pilot 注入与 api 服务相同的值 |
| `API_GO_ONBOARDING_MODE` | shadow | onboarding GET 迁移单元模式（Go-批3A 兼容变量）：`shadow`（默认，批2A/2B 行为——NestJS 响应 + Go 差分）或 `go`（Go 独立鉴权 + 全响应）。仅在 `API_GO_USER_SETTINGS_READ_MODE` 未设置时生效。非法值启动失败；`go` 模式依赖同上；compose pilot 固定注入 `go`（批3A 部署等价） |
| `API_GO_NEWS_SOURCES_MODE` | legacy | 新闻源管理台十五条 HTTP。`legacy` 代理 NestJS；`go` 时列表、options、groups、opml-presets、创建、批量频率、OPML preview/import、批量分组/启停/删除、更新、删除、run、schedule 由 Go 读写 `NewsSource`。读要 `crawl.read`，写要 `crawl.write`。`GET /:id/preview` 仍回 NestJS。run 与 schedule 不入队。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`。pilot 保持 `legacy`。回滚改回 `legacy` |
| `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | legacy | 组织、角色与成员管理 8 个 GraphQL mutation（`createOrg`/`updateOrg`/`setOrgActive`/`createRole`/`updateRole`/`assignRole`/`updateMembershipRoles`/`setUserActive`）。只接受空串/`legacy`/`go`，非法值启动失败。与 `API_GO_GRAPHQL_READ_MODE` 解耦：只开本变量时 query 仍走 NestJS，只有这 8 个 mutation 由 Go 执行；含这 8 个之外的 mutation 的文档整包回 NestJS。GET 上的 mutation 一律 405（`Allow: POST`），不执行任何写入。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不启动 worker。pilot 与样例保持 `legacy`。回滚改回 `legacy` |
| `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | legacy | 工作台交互写入 8 个 GraphQL mutation（`markNotificationRead`/`markAllNotificationsRead`/`upsertDashboard`/`deleteDashboard`/`createAlertChannel`/`updateAlertChannel`/`deleteAlertChannel`/`updateAlertEventStatus`）。只接受空串/`legacy`/`go`，非法值启动失败。与 `API_GO_GRAPHQL_READ_MODE` 解耦：只开本变量时 query 仍走 NestJS，只有这 8 个 mutation 由 Go 执行；含未接管 root 的文档在任何写入前整包回 NestJS。通知两个 root 只要登录（不新增权限），看板要 `dashboards.write`，渠道与告警状态要 `alerts.manage`。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不启动 worker，不发送邮件或 webhook。pilot 与样例保持 `legacy`。回滚改回 `legacy` |
| `API_GO_GRAPHQL_ALERT_RULES_MODE` | legacy | 告警规则配置与手动触发 4 个 GraphQL root（`alertRules` query 与 `upsertAlertRule`/`deleteAlertRule`/`triggerAlertRule` mutation）。只接受空串/`legacy`/`go`，非法值启动失败。与 `API_GO_GRAPHQL_READ_MODE` 刻意解耦：`alertRules` 会补建 17 条默认规则、更新定时计划并排入一次评估，所以读与三个写作为一个整体迁移。只开本变量时其余 query 仍走 NestJS；含未接管 root 的文档整包回 NestJS。读取要 `alerts.read`，写入要 `alerts.manage`。规则与通道关联在一个 MySQL 事务内写入，提交后才写 `bull:alerts:*`；任务格式与 BullMQ 5.63.2 / NestJS 逐字段一致，`AlertsProcessor` 仍是 alerts 队列唯一消费者。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不启动 worker，不发邮件或 webhook。pilot 与样例保持 `legacy`。回滚改回 `legacy` |
| `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | legacy | 设置中心 13 个 GraphQL mutation（`updateRateLimitSettings`/`updateAuthCacheSettings`/`updateCrawlClientSettings`/`updateAuditLogRetention`/`updateEntityImpactGraphSettings`/`updateKnowledgeGraphSettings`/`updateNewsEventSettings`/`updateNewsIndicatorSettings`/`updateNewsClassificationSettings`/`updateClassificationQualitySettings`/`updateNewsDedupeSettings`/`updateNewsExtractionSettings`/`updateNewsPromptConfig`）。只接受空串/`legacy`/`go`，非法值启动失败。与全部读开关解耦：只开本变量时只登记这 13 个 mutation，20 个设置读 query 仍走 NestJS；含未迁移 mutation 的文档整包回 NestJS。除根权限 `settings.manage` 外仍执行 NestJS 的 `assertAdmin` 组织系统管理员门禁。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不启动 worker，不调用模型或采集上游。回滚改回 `legacy` |
| `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE` | legacy | 来源策略 4 个 GraphQL mutation（`updateNewsEventSourcePolicy`/`updateNewsEventSourcePolicyPresets`/`rollbackNewsEventSourcePolicy`/`resetNewsEventSourcePolicy`）及其完整版本链：差量、保留 60 版历史、Mutation 返回最近 20 版、preset 独立文档、active/preset 两组分类权重、共享 Redis 同步 warning 与审计/Outbox。只接受空串/`legacy`/`go`，非法值启动失败。与 `API_GO_GRAPHQL_READ_MODE`、`API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE`、`API_GO_GRAPHQL_SETTINGS_WRITE_MODE` 及全部 REST 开关解耦；只开本变量时只登记这 4 个 mutation 和策略嵌套模型，所有 Query 仍走 NestJS。根权限 `settings.manage`，另执行本组织内置 `isSystem=true` 且名称为 `admin`（大小写不敏感）的 `assertAdmin`。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不启动 worker/cron，不调用模型或采集上游。回滚只把变量改回 `legacy`；已存 v2/legacy 策略、preset 与共享缓存仍由 NestJS 读取 |
| `API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE` | legacy | 知识图谱证据人工复核的单个 mutation `reviewKnowledgeGraphEvidence`。只接受空串/`legacy`/`go`，非法值启动失败。与全部读开关及其他写开关解耦：只开本变量时图谱其他只读 root（含 `knowledgeGraphEvidenceReviewQueue`）仍按各自读开关走 NestJS，只有该 mutation 由 Go 执行；`legacy` 时含该 mutation 的文档整包回 NestJS，不会产生半程写入。根权限为 `settings.manage` OR `knowledgegraph.review`（任一即可，不追加系统管理员要求）。`go` 时单个 MySQL 事务内完成关系规范化、实体与别名 upsert、目标边 upsert、证据更新/迁移/重复合并与被触及边的权重重算，提交后写 `AuditLog`（失败回落到现有 `AuditLogOutbox`，两者都失败才上抛且不回滚已提交的图更新）、按 SCAN+DEL 失效 `knowledgeGraph:subgraph:<orgId>:*` 与 `knowledgeGraph:impact:<orgId>:*` 并按返回的证据 id 重载响应。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不启动 worker/cron，不调用模型/向量/外部 HTTP。已注册的 `knowledgeGraphEvidenceReviewQueue` 只读 root 仍受 `API_GO_GRAPHQL_READ_MODE` + `API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` 控制，本开关不扩大其读注册范围。回滚改回 `legacy`；既有队列算法回滚按 settings/crawl 读开关退回 NestJS |
| `API_GO_GRAPHQL_RSS_TRANSLATION_MODE` | legacy | RSS 阅读批量翻译单个 mutation `translateRssItems(input)`（根权限 `items.read`）。只接受空串/`legacy`/`go`，非法值启动失败。与全部读开关、`API_GO_ITEMS_READING_MODE`、其他写开关解耦：只开本变量时只登记这一个 mutation 与其两个返回模型，旧 items query 仍走 NestJS；含未接管 root/字段的文档在任何翻译、缓存写或指标副作用前整份 operation 回 NestJS。`go` 时按调用方 orgId 读本组织 `processeditems` 最新 completed 记录的四字段，走 DeepLX 主备或 LLM 网关，写外层 `rss:translation:v1`（7 天）与 DeepLX 内层 `situation-monitor:translation:v3`（30 天）两层缓存，按每次真实模型尝试写 `llmrequestlogs`，并在 finally 原子 upsert `RssTranslationMetricsDaily`；不覆盖原文/result、不写 read-model、不重建 ES、不入队、不启动 worker/Cron、不发通知。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`；provider URL/密钥/profile/加密 key 保持请求时语义，不启动实网探测。回滚改回 `legacy` |
| `API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE` | legacy | `newsEventBrief` 单 root 的独立子开关。只接受空串/`legacy`/`go`，非法值启动失败。只有 `API_GO_GRAPHQL_READ_MODE=go` 且 `API_GO_GRAPHQL_NEWS_EVENTS_MODE=go` 时才允许为 `go`，否则启动失败（不静默打开父开关）。`go` 时该 root 由 Go 完成选源→调用模型→校验清洗→写回 `NewsEvent.metadata.briefV1`；缓存命中或合法 null 不调用模型，生成失败是该字段 internal error（治理 503 保留状态）。`legacy`（含空串）时只登记其余五个新闻事件 root，含 `newsEventBrief` 的文档整包回 NestJS。模型配置复用 `llm_gateway_profiles` 与 `litellm_proxy_governance`，日志 best effort 写 `llmrequestlogs`，不要求 `PUBLIC_PORTAL_MODE`/`LLM_LOGS_MODE`/写模式。回滚改回 `legacy`，旧缓存兼容 |
| `API_GO_AUTH_LOGIN_MODE` | legacy | 登录、会话签发与账户验证 11 条精确 HTTP POST：`/api/auth/login`、`/refresh`、`/send-login-code`、`/login-with-code`、`/mfa/verify-login`、`/mfa/enrollment/start`、`/mfa/enrollment/complete`、`/password/forgot`、`/password/reset`、`/send-verification`、`/verify-email`。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时 Go 复用既有 JWT 验签与 MySQL membership/role/permission 重推导，自行签发 access token（HS256 + UUID `jti`）与 refresh token（`tokenId.orgId.secret`，bcrypt cost 10），并与 NestJS 共用 `auth:refresh:*` grace 缓存、`lock:*` 共享锁、`refresh-token:blacklist:*`、`auth:email-code:*`、`auth:system-security`、`rate:login*` 滑窗与 `AuthChallenge` 表；两张已认证邮箱路由走既有鉴权链取 userId/orgId。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST` 及 `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`（真实 SMTP 发信），**不要求 `MONGO_URI`**，不启动 worker/cron，不访问 IdP。与 `API_GO_ACCOUNT_SECURITY_MODE`/`API_GO_AUTH_FACTORS_MODE` 相互独立且路径不重叠；logout、`/me`、profile、change-password、machine-tokens、已认证 MFA 管理与 OIDC 配置以及 OIDC start/callback/handoff 仍回 NestJS。回滚改回 `legacy` |
| `API_GO_IDENTITY_ONBOARDING_MODE` | legacy | 注册申请、审批、邀请与入组 14 条 HTTP：`/api/auth/admin/invites`（GET/POST）、`/admin/invites/:id/resend`、`/admin/invites/:id/revoke`、`/admin/registration-applications`（GET）、`/admin/registration-applications/:id/{approve-join,reject-join,approve-org,reject-org}`、`/register/applications`、`/register/join-applications`、`/invitations/:token`（GET）、`/invitations/:token/accept`、`/invitations/:token/accept-authenticated`。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时复用既有 JWT 验签 + Redis 撤销名单 + MySQL membership/role/permission 重推导（含 `mtk_` 机器令牌），邀请发出真实 SMTP 邮件（`NEXTAUTH_URL` 缺省 `http://localhost:3000`，链接 `/invite/<token>`），数据库只存 token 的 SHA256，7 天有效；接受邀请在单个 MySQL 事务内条件领取 pending 邀请、激活/创建 membership、替换 `MembershipRole` 集合并清理 profile 缓存。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST` 及 `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`，**不要求 `MONGO_URI`**，不启动 worker/cron，不访问 IdP。与 `API_GO_AUTH_LOGIN_MODE`/`API_GO_ACCOUNT_SECURITY_MODE`/`API_GO_AUTH_FACTORS_MODE` 相互独立且路径不重叠；这 14 条以外的 `/api/auth/*` 仍回 NestJS。回滚改回 `legacy` |
| `API_GO_OIDC_LOGIN_MODE` | legacy | 组织 OIDC 登录 3 条公开 HTTP：`GET /api/auth/sso/oidc/start`、`GET /api/auth/oidc/callback`、`POST /api/auth/sso/handoff/exchange`。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时 Go 生成 PKCE S256 verifier/challenge、UUID state/nonce 并以 600 秒 TTL 写入 `auth:oidc:state:<state>`；callback 用一次原子 GETDEL 消费 state，读取/缓存 discovery（3600 秒）与 JWKS（86400 秒），交换 code 并用标准库公钥解析 + `golang-jwt` 真实验签 id_token（RS/PS/ES/EdDSA 允许列表、issuer/aud/azp/nonce/exp/email/email_verified、60 秒容差，失败仅刷新一次 JWKS）；随后复用已迁可信登录/MFA/会话签发，只返回 handoffToken 或 challengeId/enrollmentChallengeId。handoff 行是 `AuthChallenge` 的 `sso_handoff`，主键为 32 字节随机 token 的 SHA-256，payload 用现有 AuthSecurity 策略加密 access/refresh，5 分钟有效；exchange 在解析、UA、解密检查后用一次条件 UPDATE 领取，只有一个并发请求成功。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`/`SMTP_*`**，不启动 worker/cron；`API_BASE_URL` 仅请求时用于 IdP redirect_uri（缺失返回源 400）。与 `API_GO_AUTH_LOGIN_MODE` 等开关独立且路径不重叠，OIDC 配置 GET/PUT 与其他 `/api/auth/*` 仍回 NestJS。回滚改回 `legacy` |
| `API_GO_LLM_GATEWAY_OPS_MODE` | legacy | LLM 网关治理与真实探测 12 条 HTTP：`/api/system-settings/llm-gateways` 下 `proxy-governance`（GET/PUT/DELETE）、`proxy-governance/preflight`（POST）、`proxy-governance/rotate-key`（POST）、`models-config`（POST）、`test-config`（POST）、`:id/models`（GET）、`:id/test`（POST）、`:id/proxy-health`（GET）、`:id/proxy-model-info`（GET）、`:id/proxy-lb-test`（POST）。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时由 Go 独立验签并要求 `settings.manage`（含 `mtk_` 机器令牌），复用全局 `SystemSetting`（`litellm_proxy_governance`）与 Redis 30 秒 envelope，真实调用 LiteLLM `/team/*`、`/key/*`（`LITELLM_MASTER_KEY`）与 `/v1/models`、`/health/*`、`/v1/model/info`、`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`、`/v1/rerank`，每次真实尝试写 `llmrequestlogs`（feature=`gateway_test`）。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`；`LITELLM_MASTER_KEY`/`SYSTEM_SETTINGS_ENCRYPTION_KEY` 是请求时语义（缺失时管理调用 503、密钥状态 unreadable），不是启动前置。与 `API_GO_LLM_GATEWAY_PROFILES_MODE` 相互独立：动态 `:id` 的静态/子资源路由比 profile 规则更具体，两者同为 `go` 时各自接管自己的路径。7 条 profile CRUD、LB 配置下发、model-service/OpenAI keys、publicportal/llmembed 不在本批。pilot 与样例保持 `legacy`。回滚改回 `legacy`（已保存的治理状态与 LiteLLM 远端资源不会自动撤销） |
| `API_GO_ANALYSIS_EXPORT_MODE` | legacy | 条目与事件 CSV 导出两条精确 POST：`/api/analysis/exports/items`、`/api/analysis/exports/events`。只接受空串/`legacy`/`go`，非法值启动失败。权限均为 `analysis.write`（人类 JWT 与既有 `mtk_` 机器令牌同一鉴权链），成功固定 201 + `text/csv; charset=utf-8` 附件；`queryString` 可选、`@IsString @MaxLength(4000)`，省略/null/空串都是无过滤导出。条目按 `q`/`order`/`ranking` 与重复键 `region`/`topic`/`sentiment`/`contentType`/`from`/`to`/`dedup` 复用完整时间/相关性/个性化选择，单次最多 5000 行；事件按 `window`/`status`/`entity`/`sort`/`sourceType`/`minHeat`/`minCredibility` 先取 5000 候选再补热度/权威、过滤排序与等价去重。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，独立初始化条目与事件读取，不依赖 `API_GO_ITEMS_READING_MODE`/`API_GO_GRAPHQL_READ_MODE`/协作三开关。`POST /api/analysis/exports/search`、归档准备、采集生命周期与 worker 仍回 NestJS。回滚改回 `legacy` |
| `API_GO_ARCHIVE_READING_MODE` | legacy | 归档阅读四入口：Query `archiveDigest`/`archiveCalendar`/`archiveDetail`（均 `items.read`）与 `POST /api/analysis/exports/search`（`analysis.write`，201 CSV，headlines 13 列与 items 两模式）。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时 Go 读取组织限定的 ProcessedArticle/Article/NewsEventItem、ArchiveArticleClassification 与新分类文本 hash/模型新鲜度，批量读 Mongo `processeditems` 显示资格并推断缺失 content type；搜索走真实 embedding→vector+lexical→rerank，保留 `archive:search` 双层缓存、`archive:metrics` 与每次真实尝试的 `llmrequestlogs`；缺数据时经 BullMQ 5.63.2 兼容 producer 入 `archivePreparation`，NestJS `ArchivePreparationProcessor` 仍是唯一消费者（分类生成/显示信号回填/SQL 写回）。headlines 导出按单次请求快照五栏目每轮 100 条、去重至 5000，避免逐页重跑；items 模式复用已迁 12 列导出。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，不依赖 `API_GO_GRAPHQL_READ_MODE`/`API_GO_ANALYSIS_EXPORT_MODE`，不启动 worker/cron。回滚改回 `legacy`；已入队 job 继续由 NestJS 消费 |
| `API_GO_CRAWL_TASK_WRITE_MODE` | legacy | 采集任务生命周期 3 条 REST（`POST /api/crawl-tasks`、`DELETE /api/crawl-tasks/:id`、`POST /api/crawl-tasks/:id/retry`）与 3 个 GraphQL Mutation（`createCrawlTask`/`deleteCrawlTask`/`retryCrawlTask`）。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时 Go 负责 DTO 校验与 `normalizeOptions` 等价规范化、限流（`crawl:create:*` 滑窗）、`crawl.write`/`items.write` 判定、MySQL 写入与审计（失败回落 `AuditLogOutbox`）、删除时的事务与 `MongoOutbox(cleanup_crawl_results)`、按 bullmq 5.63.2 协议写入/移除任务、去重键 `crawl-task:<taskId>`、优先级 `101-clamp(sourcePriority,-100,100)` 与 `crawl:activity` 计数；入队失败保持 pending，重试入队失败按 C1 条件回滚。NestJS `CrawlQueueProcessor` 仍是三个队列唯一消费者，janitor 继续回收超时任务；Go 不启动 worker。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求 `MONGO_URI`。回滚只把变量改回 `legacy`，已建任务/审计/队列状态不回滚 |
| `API_GO_CRAWL_QUEUE_OPS_MODE` | legacy | crawl4ai 队列管理 4 条 HTTP：`GET /api/admin/crawl4ai/queue` 与 `POST .../pause`、`.../resume`、`.../concurrency`。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时 Go 按 controller 原样组装 `queueName`/`queueNames`/`counts`（hot+normal+legacy 合并）/`paused`（含 legacyBlocksPause）/`effectiveConcurrency`/`adaptive`，pause/resume 对三个队列执行官方脚本，concurrency 复用设置写入（SystemSetting、30 秒缓存、审计）后写三个队列的 `meta.concurrency` 并发布 `crawl:worker-concurrency:v1`；Nest `CrawlQueueProcessor` 订阅该通道并只修改本进程 worker 并发。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求 `MONGO_URI`。回滚只把变量改回 `legacy`；暂停状态与全局并发保留 |
| `API_GO_EMAIL_SETTINGS_MODE` | legacy | 邮件设置三入口：`GET /api/system-settings/email`、`PUT /api/system-settings/email/auth-code`、`POST /api/system-settings/email/test`。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时复用 JWT/Redis/MySQL 鉴权链（含 `mtk_` 机器令牌）与真实 SMTP：GET 依据进程内 `verifyCached(60s)` 返回 14 字段 SMTP 状态、`verify` 与 `authCode`；PUT 先做 class-validator 等价的整数区间校验，再要求平台管理员，规范化后 upsert `auth_email_code_settings`、写 best-effort 审计（失败回落 `AuditLogOutbox`）并刷新 `auth_email_code:settings` 60 秒缓存；POST 只允许发给 `SMTP_USER`（大小写与域名完全一致），否则 400（D1），verify 失败 500，成功 201 返回 `to/messageId/accepted/rejected`。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST` 与 `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`，**不要求 `MONGO_URI`**，不启动 worker。回滚改回 `legacy` |
| `API_GO_GEOCODING_MODE` | legacy | 地理编码两入口：`POST /api/geo/geocode`（`items.read`）与 `POST /api/system-settings/geo/nominatim/test`（`settings.manage`）。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时使用与 NestJS 相同的 `geo:geocode:v1:{国家}:{sha256}` 缓存、`rate:geocode:nominatim` 滑窗限流、`geo_nominatim_identity` 身份与真实 Nominatim 请求，均返回 201 `{result}`。D2：仅 2xx 且无有效结果才写负缓存，超时/网络错误/非 2xx 返回 `{result:null}` 且不写缓存；D3：管理测试用 Probe，不读缓存、照常经过限流、有结果才写正缓存。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不启动 worker。回滚改回 `legacy` |
| `API_GO_RUNTIME_DIAGNOSTICS_MODE` | legacy | 只读运行诊断两入口：`GET /api/system-settings/assistant-safety/diagnostics` 与 `GET /api/system-settings/realtime-signals/runtime`（均为 `settings.manage`）。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时助理安全诊断读取 assistant-safety、openai-keys（`keysCount`）与 LLM 网关 active 配置（含 LiteLLM 治理托管的 apiBase/apiKey），并发探测 `/health/liveliness`（2s，无鉴权）、`/v1/models`（5s，404 回退 `/models`）与 `/guardrails/list`（5s，404 回退 `/v1/guardrails/list`），外部失败写进字段而非 HTTP 错误；实时信号诊断只读 Redis（insight/series/last-run/source-state/ADSB/AIS/OpenSky credits）、MySQL `ProcessedArticle` 与 Mongo `processeditems`，不刷新 ACLED token、不写缓存、不触发采集。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，不启动 worker。回滚改回 `legacy` |
| `API_GO_SITUATION_INSIGHTS_MODE` | legacy | 态势监控洞察只读链 `GET /api/situation-monitor/insights`（权限 `items.read`）。只接受空串/`legacy`/`go`，非法值启动失败。`go` 时由 Go 完成参数解析、core/external 缓存（45s/300s + 同名 `lock:` 锁）、Mongo `processeditems`/`rawitems` 读取、分类/聚类/关联/叙事/主角/PIZZINT/外部面板/翻译/监控规则标注；要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。不执行 POST refresh、不重建 GDELT 快照、不派发采集、不启动 worker。回滚改回 `legacy` |
| `API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE` | legacy | 知识图谱自动构建后台链（每 5 分钟领取全局时间片、按组织锁、读取 `KnowledgeGraphSettings` 与 `ProcessedArticle` 游标、关系规范化与多模型校验、事务写实体/边/证据、文章实体关联与消歧义、推进游标）。只接受空串/`legacy`/`go`，非法值启动失败。`legacy` 保持 NestJS Cron；`go` 时 Go 用同一 `cron:knowledge-graph-ingestion:tick-gate`（SET NX EX 285）与 `lock:cron:knowledge-graph-ingestion:org:<orgId>`（PX 60000，自动续租）执行，NestJS Cron 在领取时间片前退出。要求 `DATABASE_URL`、`REDIS_HOST`；模型网关复用 `llm_gateway_profiles`，`MONGO_URI` 只用于 best-effort 的 `llmrequestlogs`。`go` 下 K1（失败文章不再被游标跳过，连续 3 次失败后跳过）与 K2（同一文章重复处理不再重复计数边权重）生效；回退 `legacy` 后 NestJS 从当前游标继续，已写数据不回滚，NestJS 之后的写入恢复旧的权重计数方式。pilot 与样例保持 `legacy` |
| `API_GO_NEWS_EVENTS_INGESTION_MODE` | legacy | 新闻事件入库 Cron（`NewsEventsIngestionService.ingestRecentProcessedArticles`：每 5 分钟领取全局时间片、按组织锁、读取共享 `NewsEventIngestionState` 游标、逐篇构建信号并分配事件，或 `bertopic_primary` 模式整批聚类后统一推进游标）。只接受空串/`legacy`/`go`，非法值启动失败。`legacy` 保持 NestJS Cron；`go` 时 Go 用同一 `cron:news-events-ingestion:tick-gate`（SET NX EX 285）与 `lock:cron:news-events-ingestion:org:<orgId>`（PX 60000，自动续租）执行，NestJS Cron 在领取时间片前退出。写入 `NewsEvent`/`NewsEventItem`/`NewsEventIngestionState`/`TaskLog`/`newseventclusteringfailures`，分配结果（选中事件、similarity、assignedBy）与 NestJS 等价。要求 `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`；向量服务（`vector_service` 行 + `VECTOR_SERVICE_*`）与模型服务（`model_service` 行 + `MODEL_SERVICE_*`）按调用读取，不是启动条件。`NEWS_EVENTS_INGESTION_SETTLE_MS`（默认 120000）只由 Go 读取：只处理 `processedAt <= now - settle` 的文章，避免 processedAt 较早但事务提交较晚的文章被游标永久跳过。回退 `legacy` 后 NestJS 从同一游标继续，已写数据不回滚，B1 的跳过风险恢复 |
| `JWT_SECRET` | （空） | NestJS access token 的 HMAC 验签 secret（与 api 服务同一值）。仅 `go` 模式必填。值不进入日志/healthz/错误文本 |
| `JWT_ISSUER` | modular-monolith | 与 NestJS env schema 同默认值；`go` 模式下用于验签 |
| `JWT_AUDIENCE` | modular-monolith-clients | 同上 |
| `REDIS_HOST` | （空） | access-token blacklist 所用 Redis（与 api 服务同一实例）。仅 `go` 模式必填 |
| `REDIS_PORT` | 6379 | Redis 端口 |
| `REDIS_USERNAME` / `REDIS_PASSWORD` | （空） | Redis 凭据（可选，镜像 NestJS 语义）；不进入日志/healthz/错误文本 |
| `REDIS_DB` | 0 | Redis DB 编号 |
| `SHADOW_TIMEOUT_MS` | 2000 | shadow 差分单次执行超时（select 强制中止） |
| `SHADOW_MAX_REQUEST_BODY_BYTES` | 1048576 | 差分可重放的请求体上限（超过仍完整转发，只放弃差分） |
| `SHADOW_MAX_RESPONSE_CAPTURE_BYTES` | 1048576 | 响应差分旁录上限（超过停止旁录，主响应流式透传不变） |
| `SHADOW_MAX_INFLIGHT` | 16 | shadow 并发上限 |
| `SHADOW_MAX_PER_MINUTE` | 600 | shadow 每分钟预算（令牌桶 burst） |
| `SHADOW_DEBUG_BODY_LOG` | false | 差异记录是否保存截断正文（默认只记 sha256 hash） |
| `SHADOW_DEBUG_BODY_LOG_MAX_BYTES` | 2048 | debug 正文的截断长度上限 |
| `CANARY_PERCENT` | 0 | canary 分流比例（0=legacy，100=go；当前无 ModeCanary 路由） |
| `DATABASE_URL` | （空） | MySQL 连接（Prisma 同名同格式 `mysql://user:pass@host:port/db`）。user-settings 只读 shadow（六个 GET 的旁路查询）+ `go` 模式下 authz RBAC 重推导与业务查询共用同一连接池。shadow 模式下**空/无效时网关照常启动并代理全部请求**（shadow 单元跳过，`/__go/healthz` 报 `userSettingsRead.database` 为 `unconfigured`/`invalid`；`configured` 只代表 DSN 已解析为 driver 配置——`sql.Open` 是惰性初始化，不承诺数据库可连接）；`go` 模式下必填且 DSN 无效启动失败。值本身不进入日志/healthz/错误文本 |

## Nest 残留职责（本批五项开关）

五个开关都只接受空串/`legacy`/`go`，默认 `legacy`（行为与合入前的 main 完全一致），
非法值在 Nest 与 Go 启动失败。后台类先把 api 服务设为 `go`，再把 api-go 设为
`go`；回退顺序相反。接口类只需要切 api-go 的开关。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `API_GO_BULLMQ_CLEANUP_MODE` | legacy | 保留任务清理。`go` 时 NestJS 不再启动每进程每小时一次的定时器（`track` 仍登记资源用于关闭），由 api-go 在 `lock:cron:bullmq-retained-cleanup`（55 分钟租约、自动续租）下启动即清理一次、之后每小时一次。要求 `REDIS_HOST`。清理本身幂等，切换窗口短暂重叠不会出错 |
| `API_GO_CLASSIFICATION_REVIEW_SEED_MODE` | legacy | 分类复核样本触发。`go` 时 NestJS 不注册 `itemPipeline` COMPLETED 监听，api-go 把自己的消费者挂到进程内唯一的 `bull:itemPipeline:events` XREAD 循环（GraphQL 订阅运行时已启用时复用它的循环，否则本单元创建并启动一个）。要求 `REDIS_HOST`。复核样本任务 id 为 `classification-quality-review-seed-item:<orgId>:<processedItemId>`，BullMQ 对重复 id 返回已存在任务，因此多实例或切换重叠只入队一次 |
| `API_GO_PIPELINE_RECOVERY_WRITE_MODE` | legacy | `POST /api/admin/quality/pipeline/replay` 与 `/rollback`。`go` 时由 Go 验签（`settings.manage`，含 `mtk_` 机器令牌）、按 orgId 查 ItemMeta、克隆 RawItem 或写 ProcessedItem、更新 ItemMeta 并投递 itemPipeline；成功返回 201，错误文案与 Nest 一致（404 `Item not found` / `Raw item not found`，400 duplicate / `Invalid rawItemId` / `rawItemId does not belong to item`）。要求 `JWT_SECRET`、`DATABASE_URL`、`MONGO_URI`、`REDIS_HOST`。与 `API_GO_PIPELINE_RECOVERY_MODE`（GET runs）独立 |
| `API_GO_METRICS_MODE` | legacy | `GET /api/metrics`。`go` 时由 Go 输出 Prometheus 文本格式（`text/plain; version=0.0.4; charset=utf-8`）。鉴权与 Nest 一致：`metrics.read` + 平台管理员；`mtk_` 机器令牌另查创建者当前是否平台管理员。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST` |
| `API_GO_STARTUP_RECONCILE_MODE` | legacy | 启动对齐。`go` 时 NestJS 跳过 TaskLog、LLM 请求日志与 Elasticsearch 的 `onModuleInit` 索引对齐，api-go 在启动后异步执行（不阻塞监听、失败只记 warn）：读取两个保留设置并应用 Mongo TTL 索引，配置了 Elasticsearch 时执行 `ensureIndex`。`lock:startup:reconcile` 保证多副本只执行一次。要求 `REDIS_HOST`；Mongo/MySQL/Elasticsearch 缺失或失败只记 warn |

### 队列清理清单

`bull:*` 前缀（Nest 未设置自定义 prefix）。所有队列清理 failed；只有
`itemPipelineDlq` 同时清理 wait。

| 队列 | failed | wait |
|---|---|---|
| `assistant`、`analysis`、`archivePreparation`、`classification_quality`、`alerts`、`crawl4ai`、`crawl4ai-hot`、`crawl4ai-normal`、`frontier-llm-judge`、`frontier-llm-learn`、`news_event_clustering_recovery`、`itemPipeline`、`situationMonitorSignals`、`akshare-data` | 7 天 / 10000 | 不清理 |
| `itemPipelineDlq` | 30 天 / 20000 | 30 天 / 20000 |

每个状态先按时间 `clean`（每批 1000，最多 10 批，不足 1000 即停），再按数量从最旧
开始每批 1000 逐个移除（总数最多 10000）。按数量修剪使用 Redis pipeline 每批一次
往返（等价于 Nest 的逐任务 `job.remove()`；被锁住的任务同样跳过）。

### Prometheus 进程指标名称变化

Nest 的 `prom-client` 默认指标是 `nodejs_*`，Go 进程没有事件循环，因此改为
`go_*` / `process_*`。自定义指标族（名称、类型、标签、直方图桶）保持不变：
`http_request_duration_seconds`、`background_job_duration_seconds`、
`integration_events_total`、`scheduler_runs_total`、`pipeline_metric_value`。
其他 Go 迁移单元可直接调用 `internal/metrics` 的 `RecordSchedulerRun` 等函数，
无需再建第二个注册表。

| Nest（`nodejs_*`） | Go |
|---|---|
| `nodejs_process_cpu_seconds_total` | `process_cpu_seconds_total` |
| `nodejs_process_start_time_seconds` | `process_start_time_seconds` |
| `nodejs_heap_size_total_bytes` | `go_memstats_heap_sys_bytes` |
| `nodejs_heap_size_used_bytes` | `go_memstats_heap_alloc_bytes` |
| `nodejs_heap_space_size_available_bytes` | `go_memstats_heap_inuse_bytes` |
| `nodejs_external_memory_bytes` | `go_memstats_sys_bytes` |
| `nodejs_version_info` | `go_info{version="..."}` |
| `nodejs_gc_duration_seconds` | 不提供（summary 类型不在本批范围） |
| `nodejs_eventloop_lag_seconds`、`nodejs_active_handles*`、`nodejs_active_requests*` | 不适用 |

另输出 `go_goroutines`、`go_memstats_*`、`go_gc_cycles_total`。使用 `nodejs_*` 的
监控面板与告警需要按上表调整。

## 四态路由（当前路由表）

路由匹配：**迁移单元 = exact path + method 白名单**。相似路径、POST 以及写模式为 `legacy` 时的 PUT 回落 `/api/`。写模式为 `go` 时，同一六个路径的 PUT 另有 exact+PUT 规则。

| 模式 | 当前路由 | 行为 |
|---|---|---|
| legacy | `/api/`、`/graphql`、`/socket.io/`、`/docs`、`/admin/queues`（含六个 user-settings GET 的 PUT/相似路径、其余全部未迁移端点） | 反向代理到 NestJS（事实源） |
| shadow | `/api/healthz/live`（exact + 仅 GET）；六个 user-settings GET 的模式由 `API_GO_USER_SETTINGS_READ_MODE` 决定：`shadow` 时全部 shadow；未设置时 onboarding（`API_GO_ONBOARDING_MODE=shadow` 默认）与 rss-reader/spacetime-timeline shadow，war-map/newsnow/situation-monitor legacy | NestJS 响应 + Go 实现异步差分 |
| canary | （无） | 待鉴权基础设施接入的分流组件（见下） |
| go | `/__go/healthz`；读模式 `go` 时六个 GET（exact）；写模式 `go` 时六个 PUT（exact） | Go 原生。GET 走 `usersettingsread`；PUT 走 `usersettingswrite`（同一鉴权链，写后重读） |

### user-settings 只读域 Go 接管（Go-批3B，统一六端点）

`API_GO_USER_SETTINGS_READ_MODE=go` 时，六个只读 GET 的完整请求链由 Go 独立完成——不请求 NestJS、不等待 legacy 200、不使用 `LegacyApprovedIdentity`（Go-批3A 曾以 `API_GO_ONBOARDING_MODE=go` 单独接管 onboarding；批3B 起收敛为统一 handler `internal/usersettingsread`，旧 `internal/onboarding` 已删除）：

```text
提取 Bearer（拒绝 mtk_ 机器令牌）
→ JWT 验签（internal/authn：仅 HS256、issuer/audience/exp/nbf 按 jsonwebtoken
  语义、sub/orgId 非空；拒绝 alg=none/HS384/算法混淆；不读 permissions claim）
→ Redis blacklist（internal/authn：access-token:blacklist:<jti>，与 NestJS 同一
  Redis 同一 key；jti 缺失按 NestJS 当前语义放行；查询失败 fail-closed 500）
→ MySQL membership/user/permission 重推导（internal/authz：复用同一 *sql.DB；
  User/Org/Membership active 校验与 getUserProfile 同序同文案 401；
  MembershipRole 多角色优先、空则 primary role 回退；权限名 RolePermission→
  Permission 去重）
→ items.read 判定（usersettingsread：数据库推导的权限集；JWT claim 不参与）
→ 固定 UserSetting 查询（usersettings repository：五个单 key 端点各查一个
  编译期固定 key；situation-monitor 一次聚合查询三个固定 key）
→ normalization（usersettings：六个端点各自的 Build*Response——含批3B 完整
  移植的 war-map-contract / situation-monitor / newsnow 契约）
→ Go 写出响应（internal/authhttp 契约等价错误；200 带 Cache-Control: no-store）
```

- **错误契约**：与 NestJS `GlobalExceptionFilter` 逐字段对齐——JWT 层失败 401 `{"message":"Unauthorized"}`；撤销 401 `"Access token revoked"`；user/org/membership 状态拒绝 401 同文案（`"Organization disabled"` 等）；缺权限 403 `INSUFFICIENT_PERMISSIONS`（any 模式：`detail="Requires any permission: items.read"`，无 `missingPermissions`）；Redis 故障 fail-closed 500、MySQL 故障 fail-closed 503（均通用 `"Internal server error"`，对齐 NestJS 生产环境非 HttpException 路径）。
- **边界**：仅六个只读 GET。登录/refresh/logout/MFA/OIDC/机器令牌仍全部由 NestJS 承载；六个 PUT 与全部其他写请求纯代理 NestJS（exact path + method 白名单：PUT/POST/HEAD 同路径与相似路径回落 legacy）。
- **`/__go/healthz`**：`userSettingsRead.mode` 如实展示当前读模式（空/`shadow`/`go`）、`userSettingsRead.database` 只报 `unconfigured`/`invalid`/`configured`；`go` 模式下六个 GET 不再增加 `shadow.executed`。
- **回滚**：`API_GO_USER_SETTINGS_READ_MODE=shadow`（全部六端点回到 NestJS 响应 + Go 差分）或删除该变量（兼容：onboarding 由 `API_GO_ONBOARDING_MODE` 控制、其余端点回到批3B 前去向）——配置变更，无数据迁移耦合。

### user-settings 只读 shadow（差分阶段，Go-批2A/2B 起步、批3B 扩展）

- **范围**：六个只读 GET 都可处于 shadow（`API_GO_USER_SETTINGS_READ_MODE=shadow`
  时六端点全部 shadow；未设置时 onboarding/rss/spacetime shadow、其余三
  个 legacy——批3B 前的兼容行为）。全部 PUT 始终 legacy（不迁移写入路径）。
- **行为**：客户端响应完全来自 NestJS；Go 在旁路真实读取 MySQL
  `UserSetting` 表（五个单 key 端点 `orgId+userId+固定 key` 三条件参数化
  查询共用同一条私有 SQL；situation-monitor 一次聚合查询三个固定 key，
  对齐 NestJS findMany 语义），并与 NestJS 响应差分（normalization 契约
  逐字段对齐——含批3B 的 war-map 45 layer/legacy key/clamp、newsnow
  有序对象/上限/真值、situation-monitor 三段聚合）。
- **legacy-approved shadow identity（信任边界）**：shadow 是回滚兼容路径，
  不是 Go 的独立鉴权。身份来源是 legacy 信任委托——同一请求先由
  NestJS 执行并返回 200（签名/权限全部通过），此时才从（未验签的）
  Bearer JWT payload 读取 `sub`/`orgId`，只用于本次只读查询。**不是
  「Go 已验证身份」**；不读取、不信任 `permissions` claim；NestJS 非 200
  （401/403/404/5xx）→ Go 零查询。Go 模式（`usersettingsread`）完全不
  经过该身份——但 shadow 回滚能力依赖它，`shadowidentity` 包因此保留。
- **失败非阻断**：MySQL 未配置/不可达/超时、JSON 异常、限流/并发预算
  耗尽——都只跳过本次差分或形成结构化差分记录，客户端始终收到
  NestJS 原响应。
- **回滚**：`API_GO_USER_SETTINGS_READ_MODE=shadow`（六端点全部回 shadow）
  或未设置（兼容行为）——配置变更；路由级单条改回 `ModeLegacy` 亦可
  （纯代码变更，无数据耦合）。

### canary 的信任边界（重要）

当前分流的 orgId 取自**未验签**的 JWT payload claim，不是经过认证的组织
身份。`CANARY_PERCENT` 默认 0，**当前没有任何路由处于 ModeCanary**。
在 Go 侧完成真实 JWT 验签与 org membership 重推导（迁移序 5）之前，
受保护业务路由不得依赖该 claim 决定是否进入 Go——fail-safe 一律回
legacy。详见 `docs/refactor/api-go-four-mode.md`。

## 迁移一个路由（四态）

路由表在 `internal/legacyproxy/proxy.go` 的 `DefaultRules(onboardingMode, readMode)`（迁移单元 = exact path + method 白名单；fallback = 前缀匹配）：

1. shadow 起步：把目标单元改为 `ModeShadow`（exact + method 白名单），在 `cmd/api/main.go` 的 dispatcher 里注册该路由的差分执行者；
2. 差分 0 失败后 canary：改为 `ModeCanary` + 调 `CANARY_PERCENT` 灰度（orgId 稳定哈希——注意当前分流依据仍是未验签 claim，见下）；
3. 全量：改为 `ModeGo` 并 `RegisterGoHandler` 注册处理器（前置件：该路由的 Go 侧鉴权链已落地——参照 Go-批3A 的 authn/authz/authhttp）；
4. 回滚 = 任意阶段改回 `ModeLegacy`（或 `CANARY_PERCENT=0` / 单元模式配置）——纯配置变更，无数据耦合。

## 验证

```bash
pnpm --filter @modular/api-go test    # 网关行为测试（四态/代理透传/go 路由/502/trace/shadow 预算/canary 哈希/user-settings 身份门禁与三端点契约）
pnpm --filter @modular/api-go lint    # go vet
pnpm --filter @modular/api-go build   # go build
```

MySQL + Redis 集成测试（Go-批2A 起步、批2B/批3B 扩展到八个固定 key 与
situation-monitor 三记录聚合、批3A 增加 authz RBAC 重推导与 authn
blacklist，本机禁跑——远端 CI 的 `api-go-user-settings-integration` job
使用固定版本 MySQL + Redis service 执行）：

```bash
cd apps/api-go && go test -tags=integration -count=1 \
  ./internal/usersettings/ ./internal/authz/ \
  -run 'TestUserSettingsMySQLIntegration|TestAuthZMySQLIntegration' -v
```

## 经济数据与 AkShare（`API_GO_ECONOMIC_DATA_MODE` / `API_GO_ECONOMIC_DATA_WORKER_MODE`）

两个变量都默认 `legacy`，接受空串/`legacy`/`go`，非法值在 Nest 与 Go 启动失败。

- `API_GO_ECONOMIC_DATA_MODE=go`：三个 GraphQL Mutation（`updateEconomicDataFetchConfig`、`triggerDataFetch`、`triggerEconomicDataRefreshPreset`）与三条 `settings.manage` HTTP（`/api/admin/akshare/version|status|upgrade`）由 Go 执行。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求 Mongo。`triggerDataFetch` 入队后立即返回；预设刷新按组织每 60 秒 1 次限流并写审计。
- `API_GO_ECONOMIC_DATA_WORKER_MODE=go`：Go 在启动时执行目录同步和重复任务同步，并成为 `akshare-data` 的唯一消费者；要求 `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，不要求 JWT。Nest 在此模式下跳过 `ensureCatalog`/`ensureRepeatableJobs`，且不创建 Worker。
- 切换消费者前先停掉 Nest worker 并等待在途 job；回滚 worker 开关先停 Go 再恢复 Nest。不要 drain 队列或删除已写数据点。
- `updateEconomicDataFetchConfig` 省略 `repeatCron` 时保留数据库原值；显式 `null` 才清空。该修正在 legacy NestJS 路径同样生效。
- 详细契约与未验证边界见 [docs/refactor/go-economic-data.md](../../docs/refactor/go-economic-data.md)。

## 依赖清单（go.mod / go.sum）

`go.sum` 是 tracked file（Go-批2A 起有第三方依赖）。本仓库约束「生成器不在
本机执行」：

- 依赖变更时，给 PR 加 `go-modules-regen` label → CI 的 `go-modules-regen`
  job 远端运行 `go mod tidy` 并把 `go.mod`/`go.sum` 提交回 PR 分支；完成后
  移除 label。
- 平时 verify 的漂移门禁保持 fail-on-drift：go.sum 必须被跟踪、远端
  `go mod tidy` 后 `go.mod`/`go.sum` 零漂移。
- 集成 job 只用 `go mod download` 消费已提交的校验信息，不修改清单。

## 约束

- 不引入 Web 框架/ORM/DI 容器；对象存储只用官方 AWS SDK for Go v2 的
  `service/s3`、`credentials` 与 `smithy-go`（本批新增，经 `go-modules-regen`
  远端固定），不引入上传 manager 或其他 AWS 服务，也不启用默认凭据链/
  IMDS 探测；既有第三方依赖为 `go-sql-driver/mysql`、`golang-jwt/jwt/v5`、
  `redis/go-redis/v9`、`vektah/gqlparser/v2`、`mongo-driver/v2`、
  `golang.org/x/crypto`、`golang.org/x/text`
- `migrations/` 在 Phase 1 禁止 schema 变更（见该目录 README）
- 契约以 `docs/refactor/api-contract-inventory.md` 为冻结基线；鉴权矩阵（`apps/api/tests/contract/auth-matrix.json`）驱动逐端点语义对齐
- shadow 只对 GET/HEAD/OPTIONS 差分——写请求禁止双发（双层强制：legacyproxy + shadow runner；user-settings shadow 单元进一步收窄为仅 GET）
