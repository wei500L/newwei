# 经济数据与 AkShare 的 Go 所有权

本批把经济数据的配置写、手动抓取、七看板预设刷新、`akshare-data` 队列消费、目录与可重复任务同步，以及三条 AkShare 管理 HTTP 迁到 `apps/api-go`。六个既有经济读 Query 不改算法，仍由 `API_GO_GRAPHQL_READ_MODE` 控制；它们直接读同一批 MySQL `EconomicDataPoint` 与 `EconomicDataFetchConfig`，因此 Go 写入的新点和新状态对 Nest 与 Go 读路径都可见。

## 两个开关

| 变量 | 默认 | 接受值 | Go 模式的前置 | 所有权 |
|---|---|---|---|---|
| `API_GO_ECONOMIC_DATA_MODE` | `legacy` | 空串、`legacy`、`go` | `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST` | 三个 Mutation 与 version/status 两条 GET、upgrade POST |
| `API_GO_ECONOMIC_DATA_WORKER_MODE` | `legacy` | 空串、`legacy`、`go` | `DATABASE_URL`、`REDIS_HOST`、`MONGO_URI` | 目录同步、重复任务同步、`akshare-data` 唯一消费者 |

空串与未设置等同 `legacy`，非法值在 Nest `env.schema.ts` 与 Go `config.Load` 都启动失败。请求开关不要求 Mongo；worker 开关不要求 JWT，也不依赖请求开关或 GraphQL 读开关。

## 目录与调度

worker 为 `go` 时，Go 在开始领取任务前执行与 Nest `AkshareService.onModuleInit` 等价的两步：

1. `ensureCatalog`：按 `financial-data.definitions.ts` 的 183 个定义创建分类、序列、分类关系和缺失的 fetch config，并刷新定义拥有的 source/metadata 字段；不删除目录外的历史 item。
2. `ensureRepeatableJobs`：使用 `akshare:repeatable-jobs:lock`（`PX 60000 NX`，最多等 5 秒、每 250ms 重试）同步 BullMQ `bull:akshare-data:repeat`。队列名、默认 `bull` 前缀、job hash、repeat key、延迟 job id 与 `bullmq@5.63.2` 一致。

重复任务名仍是 `fetch:<itemId>`，job payload 的 `dataItemId` 是 slug。启用但 provider 不可用的配置写 `lastStatus=failed` 与 `missing_api_key:<secret>` 或 `provider_disabled`；禁用、不可用或已从目录消失的重复任务会被移除。平滑开启且无自定义 cron 时按 slug 排序分配固定槽位；realtime 使用六段秒级 cron。平滑关闭时恢复固定 `every`/月 cron。

## 队列与落库

worker 使用独立阻塞 Redis 连接，默认并发 `AKSHARE_QUEUE_CONCURRENCY=2`。关闭时先停止领取，再等待在途抓取。Nest 在 worker 开关为 `go` 时：

- `AkshareQueueProcessor.onApplicationBootstrap` 直接返回，不创建 `Worker`；
- `AkshareService.onModuleInit` 跳过目录与重复任务同步；
- 请求开关仍为 legacy 时，Nest 的 `updateFetchConfig` 继续调用自己的 `ensureRepeatableJobs`。

同一时刻只允许一个消费者；`akshare:repeatable-jobs:lock` 只防止同步互相覆盖，不能代替消费者切换。

每次抓取按顺序：

1. 从 MySQL 读取 item 的 slug、provider metadata 与 parser 配置。
2. 调用 AkShare 网关、Finnhub、FRED 或 Yahoo Finance。
3. 归档 `EconomicProviderResponse`；AkShare 另写 `AkshareResponse`。失败也写 provider 档案。
4. 按 provider cleanup 删除指定 `recordedAt`。
5. 以 `(itemId, recordedAt, sourceField)` 唯一键批量 upsert，批大小 1000 行或约 2MB，MySQL `max_allowed_packet` 错误对半拆分。
6. 成功写 `lastStatus=success`、`lastError=NULL`；普通失败写 `failed` 并截断到 191 字符后让 job 失败；配置错误归档 `skipped`、写 `lastError`，但 job 成功，避免 BullMQ 无限重试。

`AKSHARE_SKIP_UNCHANGED_LATEST_POINTS=true` 只对 AkShare、parser `latest`、无 `timestampField` 且 item 频率为 realtime/hourly 的序列跳过与最新行 value/unit/dataType 相同的点。

## 配置写入与预设刷新

`updateEconomicDataFetchConfig` 使用 GraphQL 参数存在性：

- 省略 `frequency`/`isEnabled`：不改列；
- 省略 `repeatCron`：不改列（本批修正，legacy NestJS 也生效）；
- 显式 `null`：清空 `repeatCron`；
- 显式字符串：写入该 cron。

`repeatCron` 的修正依据是控制台只提交 `slug` 与 `frequency`/`isEnabled`，而 Nest resolver 过去把省略折叠成 `null`；修正后，只切换启用或频率不会再清掉已保存的 cron。

`triggerDataFetch` 对每个 slug 添加 `manual-fetch`，payload 为 `{dataItemId(slug), triggeredById?, traceId}`，`removeOnComplete=true`，不在 Mutation 内等待抓取。空数组返回 `true`，未知 slug 仍入队，失败由 worker 写入 fetch config。

`triggerEconomicDataRefreshPreset` 先按每组织每预设 60 秒 1 次消费 `rate:economic-data:refresh:<orgId>:<preset>`，再选择 `isEnabled=true`、`item.isActive=true` 且属于对应 categoryKey 的 slug，去空白、去重后入队。没有 slug 时返回 400，限流失败返回 429 且不入队。审计写 `AuditLog`（失败回退 `AuditLogOutbox`），审计失败不回滚已入队任务。

## AkShare 管理 HTTP

三条都要求已认证用户与 `settings.manage`，使用精确路径：

- `GET /api/admin/akshare/version`：`<base>/version`，10 秒超时；404 返回两个 `unknown`，其他上游状态透传。
- `GET /api/admin/akshare/status`：无 `AKSHARE_ADMIN_TOKEN` 时返回 200 disabled；有令牌时带 `x-akshare-admin-token` 请求 `<base>/admin/status`，404 返回 disabled；其他状态透传。
- `POST /api/admin/akshare/upgrade`：先消费 `rate:akshare:upgrade:<orgId>`（每小时 1 次），无令牌 503，成功 POST `<base>/admin/upgrade`（15 秒）并返回 `accepted/requestId/beforeVersion`。处理 POST 的 API 进程异步每 2 秒观察最多 15 分钟；`failed` 写 `upgrade_failed`，`restarting` 或状态丢失后版本变化写 `upgrade_succeeded`。观察失败只记日志。

两个限流键使用与 Nest `RateLimiterService.consume` 相同的 Lua 和 `rate:` 前缀，混合部署共享同一 ZSET；`RATE_LIMIT_REDIS_FAIL_OPEN` 默认 false。

## 切换与回退

- 启用消费者：先停所有 Nest 进程的 akshare worker 并等待在途 job，再把 `API_GO_ECONOMIC_DATA_WORKER_MODE` 设为 `go` 并启动 Go；请求开关可同时或稍后再切。Redis 中已有的 repeat job 继续由新消费者执行，不 drain 队列。
- 回退请求开关：新 Mutation 和升级请求回到 Nest；已入队 job、已写数据点和已发给网关的升级不撤销。
- 回退 worker 开关：先停 Go worker 并等待在途抓取，再恢复 Nest worker。Nest 启动时会重新同步目录和 repeat；不要删除数据点。
- 抓取、升级和队列投递一旦发出，不因 Go 返回错误而自动再打一次 Nest。

## 验证边界

已计划由普通 CI 覆盖的 Go 单元测试包括：repeatCron 省略/null/字符串、七个预设映射与去重、平滑槽位、provider fixture 映射与缺配置、upsert 唯一键、latest 跳过条件和限流键/消息、非法开关值。真实 AkShare 网关、Finnhub、FRED、Yahoo Finance、生产 Redis、真实升级后的网关进程未在本批实网验证；外部调用失败、超时和非 2xx 仍按 provider 失败路径记录，不写成已通过。
