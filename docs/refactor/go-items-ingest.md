# 条目写入、采集结果入库与 raw_item 补偿（ITEMS-INGEST-001）

2026-10-19；基线 `origin/main` `91e759b449c4511dc96d86539ea0eb258754d07e`。本文件记录实现事实、切换/回滚和未验证边界；任务状态与 PR/CI 以 [ITEMS-INGEST-001](migration-map/tasks/ITEMS-INGEST-001.md) 为准。

## 六个入口

| 入口 | 权限 | 返回 | 实现 |
|---|---|---|---|
| `POST /api/items` | `items.write` | 201，ItemMeta + `rawItemId` | `internal/itemsingest/handler.go` |
| `createItem(input:CreateItemInput!)` | `items.write` | `ItemModel!` | `internal/graphqlread/itemsingest/resolver.go` |
| `updateItem(input:UpdateItemInput!)` | `items.write` | `ItemModel!` | 同上 |
| `createItemFromCrawlResult(resultId:String!)` | `crawl.read` AND `items.write` | `ItemModel!` | 同上 + `service_crawl.go` |
| `ingestCrawlTaskResultsToItems(...)` | `crawl.read` AND `items.write` | `CrawlIngestBatchModel!` | 同上 |
| `updateCrawlTaskIngestToItems(id,enabled)` | `crawl.write`，启用另需 `items.write` | `CrawlTaskModel!` | 同上 |

HTTP 复用 `itemsreading.AuthenticateMachineToken`（mtk_：SHA256、Org.isActive、撤销/到期、lastUsedAt、DB 权限、`machine:<id>`），普通 JWT 复用 authhttp；合法但缺 `items.write` 为 403。GraphQL 仍只接受 JWT。五个写 root 用 `AllowAuthenticated` + 显式 Nest 顺序权限检查，AND 失败保留 required/missingPermissions/all 形状。`limit` 保持 GraphQL Float。

`ItemModel` 顶层按 `ItemsResolver.toItemModel`；meta/raw/processed/rawPreview/processedPreview 五个字段通过 `RegisterFieldPermission("ItemModel", ..., "items.read")` 保护。写响应复用现有按 selection 的批量投影（`BuildItemModels`），没有为写返回强制打开读 root。

## 三条写入路径

1. **人工 create/update（MySQL Outbox）**：`ItemsIngestService.create` / `ItemsService.update` 的语义。新建显式 `status=pending`、预分配 ObjectID、`version=1`、同一事务写 ItemMeta 与 `MongoOutbox(type=raw_item,pending,attempts=0,availableAt=now)`；commit 后 best-effort 审计、`deliverNow`。已有 externalId 且 ref 非空时直接尝试 pending 补偿并返回旧值；ref 为空时规范化 payload、`org+id+mongoRef=""` CAS 绑定并同事务插 Outbox；输家重读赢家。唯一键 1062 重查本组织记录。update 只在规范化 payload 存在时分配新 raw、更新 mongoRef 并插 Outbox（source=`graphql`），随后 deliverNow→hydrate→best-effort 审计。
2. **raw_item 即时/补偿（Outbox）**：按 ID 读取、校验 payload（type/org 相等/字段/内层 schema），CAS 认领 pending|failed(availableAt<=now) 或 processing(lockedAt<5min)，同事务 attempts+1；写 RawItem（11000 且 `_id` 存在视为幂等）→ enqueue→hydrate→删除 Outbox。失败按 10 次上限与 `round(30000*2^(min(attempt,5)-1)*(0.5+random))` 退避；dead 时仅当 org+itemMetaId+mongoRef 仍等于该 rawId 才把 ItemMeta 置 failed，有 pipelineJobId 才更新同 org PipelineJob。
3. **采集结果导入（直接 Mongo 批写）**：与 Outbox 不同。先按 org+task 授权；`fetchedAt DESC,id DESC` take+1，after 沿 Prisma row cursor（按 id 解析排序键，缺失 cursor 按 P2025 语义内部失败）；limit 默认 50、floor 后钳制 1..200；onlyMissing 仅显式 false 关闭。批量预载、保序去重、`INSERT IGNORE` 建缺失 meta 后重查；已有 ref 只对 pending/processing/failed 入队，不重写 raw、不补审计；缺 ref 先 build/validate RawItem→unordered insertMany→按 ID 回读确认→SQL `org+id+mongoRef=""` CAS。CAS 输家只删自己插的 raw 并读赢家；校验/插入失败逐项 rejected；只清理本进程新建且仍空的 meta（保留 org 条件）。赢家写 createFromCrawlResult 审计、入队、水合；并发 8、输出按请求 ID 顺序。

`updateCrawlTaskIngestToItems` 在 task 存在后、比较旧状态前检查 `items.write`；同值直接返回；启用合并 `config.ingestToItems=true`，关闭删除该键，删空写 SQL NULL。

## itemPipeline producer（不迁 worker）

`internal/pipelineenqueue` 使用固定版本 BullMQ 5.63.2 的 `addStandardJob-9.lua` / `addPrioritizedJob-9.lua` 与递归 include 展平（`scripts.go` 保存出处、MIT 许可、SHA-256 与版本）。keys 顺序、`cmsgpack.unpack(ARGV[1])` 位置参数、`ARGV[2]` JSON data、`ARGV[3]` MessagePack opts 与官方 `Scripts.addJob` 一致；使用 `github.com/vmihailenco/msgpack/v5 v5.4.1`，不手写编码。保留 pause/maxed、priority/pc、marker、job hash、id、events、重复 job 的官方行为，不单独再发 added/waiting。

job：queue `itemPipeline`、prefix `bull`、name `process-item`、jobId `<itemMetaId>-<rawItemId>`；data 具名 itemMetaId/rawItemId/orgId/traceId/processedItemId 与可选 pipelineJobId/sourceId；opts `removeOnComplete=true`、`removeOnFail={age:604800,count:10000}`、`attempts=5`、`backoff exponential/2000ms`、可选 priority（>2097152 保留 BullMQ 错误）。入队前按 org+itemMetaId 取最新 ProcessedItem `_id`（失败/缺失才新 ObjectID）；入队后 best-effort `$set/$setOnInsert` pending（已有文档不重置 status/result）。另执行 QueueOrgStatsService 原 Lua：`queue:itemPipeline:job:<jobId>:meta` TTL 7 天、`queue:itemPipeline:org:<orgId>:counts` TTL 30 天，初始 waiting、keepCompleted=0/keepFailed=1，重复状态不重复计数。

NestJS `QueueProcessor`/`QueueEvents`/`QueueOrgStatsTracker`/`QueueEventPublisher` 与外部内容处理继续运行；本批没有消费者、worker、repeat/flow 或第二份 queueEvents。

## 水合与查询改善

- `itemsreading.Hydrator`（`internal/itemsreading/hydrate.go`）复用 `hydrateItemReadModelsBatch`/`UpsertReadModels`；后台 owner 只构造 DB/Mongo 依赖，不需要 JWT/HTTP 读/ES/LLM。
- GAP-ITEMS-001：`loadProcessedSnapshots` 改走 `ListLatestProcessedSnapshotsAnyStatus`，在 Mongo 内按 org+item IDs 排序/分组取每 item 最新任意状态与完整 snapshot 投影；搜索/RSS 使用的 completed-only `ListLatestProcessedSnapshots` 未改。缺 snapshot 继续 `$unset`，raw 双向绑定和 sourceId 解析不变。
- `deliverPendingForItemMeta` 在 SQL 中先按 `orgId/type/status/JSON_EXTRACT(payload,'$.itemMetaId')` 过滤，再按 createdAt,id 取 50，避免目标被其他条目遮挡；每行仍走同一个 CAS/到期判定，不扩大全局 retry 批次。

## 两个独立开关与回滚

- `API_GO_ITEMS_INGEST_MODE`：空/legacy/go，空默认 legacy，非法值启动失败。go 需要 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`；注册精确 `POST /api/items` 与五个 mutation。回滚改回 legacy 后新请求回 NestJS；已入队 job 仍由 Nest worker 消费。
- `API_GO_RAW_ITEM_OUTBOX_MODE`：空/legacy/go，默认 legacy，非法值启动失败。go 只需 `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，不要求 JWT/任何 HTTP/GraphQL 开关；Nest `retryPendingRawItemOutbox` 在取锁前退出，Go 每分钟以 `lock:cron:raw-item-outbox` PX55000 token 续租/释放执行三状态合并 50、顺序投递。`SCHEDULE_ENABLED=false` 时 Go 不启动、Nest ScheduleModule 不注册；请求内即时投递不受影响。回滚改回 legacy 并重启即可，已有 raw/Outbox/队列协议不变。
- 四种组合：全 legacy（Nest 写 + Nest 定时）；写 go/后台 legacy（Go 写 + 即时投递，Nest 仍定时重放同表，按行 CAS 竞争）；写 legacy/后台 go（Nest 写 + 即时投递，Go 只做定时重放）；两者 go（Go 写 + 即时 + 定时）。均保留 Nest itemPipeline worker。

## 源码定位

- `apps/api-go/internal/itemsingest/`：`payload.go`（NormalizedNewsPayloadSchema/null/truthiness）、`urlcomparison.go`（Mongoose pre-validate）、`store.go`（MySQL/审计/分页/CAS）、`service.go`（create/update/updateCrawlTaskIngest）、`service_crawl.go`（采集批入库/并发/清理）、`outbox.go`（raw_item 投递/退避/dead）、`scheduler.go`（Redis 租约 owner）、`handler.go`（REST/mtk_）。
- `apps/api-go/internal/pipelineenqueue/`：`producer.go`、`scripts.go`、`orgstats.go`、`producer_integration_test.go`。
- `apps/api-go/internal/graphqlread/itemsingest/`：五个 mutation、输入与 CrawlIngestBatchModel。
- `apps/api-go/internal/graphqlread/itemsreading/write_port.go`、`internal/graphqlread/settingscrawl/crawl_export.go`、`internal/itemsreading/{hydrate.go,mongo.go,readmodel.go}`。
- `cmd/api/items_ingest.go`、`cmd/api/main.go`、`internal/config/config.go`。
- Nest：`apps/api/src/modules/items/raw-item-outbox.service.ts`（Cron gate）、`modules/config/{env.schema.ts,config.service.ts}`。
- Compose/样例：`infra/docker/docker-compose.yml`、`infra/docker/.env.sample`；CI：`.github/workflows/ci.yml` 既有 `api-go-user-settings-integration` job 追加 Redis producer 用例。

## 验证与未验证边界

- 本机未安装依赖、未运行 build/test/Docker/服务，未读真实 .env/凭据，未调用真实 Mongo/Redis/模型/crawl4ai/ES/vector/SMTP。
- 静态检查：`gofmt`、`git diff --check`、类型/事务/org 绑定/raw 引用/幂等竞争/关闭顺序只读 review。
- 远端普通 CI 与新增真实 Redis 命令用例（standard/priority、pause、重复 job、MessagePack 参数/job hash/options/events/marker、org 计数原子语义）状态待推送后回填；skipped 不算通过。
- 未验证：真实 Mongo 副本集/写入、双端 owner 切换/drain、Nest 完整 worker 消费与外部内容处理、生产部署与流量、机器令牌真实数据。
