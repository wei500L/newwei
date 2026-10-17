# 采集只读与媒体/遥测（Go 接管说明）

> 本批：`API_GO_CRAWL_READ_TELEMETRY_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源（逐段翻译）：`apps/api/src/modules/crawl/crawl.controller.ts`（仅 `GET /api/crawl-tasks` 与 `GET /api/crawl-tasks/:id`）、`crawl-task.service.ts` 的 `listTasks` / `getTask` / `toView`、`crawl-result.service.ts` 的 `attachResultContent` / `getLatestRunDetails` / `toLatestMemoryStats` / `toLatestExecutionSummary`、`dto/list-crawl-task.dto.ts`、`crawl.utils.ts` 的 `clampResultLimit`、`crawl-media-asset.controller.ts`、`crawl-media-asset.service.ts` 的 `listAssetsByResultIds` / `verifySignedAssetAccess` / `getAssetDeliveryPayload` / `signAssetAccess` / `resolveDeliveryContentType` / `isInlinePreviewContentType` / `buildAssetFileName`、`storage/storage-settings.service.ts`（`presignedUrlTtlSeconds`）、`crawl4ai-quality.controller.ts`、`crawl-quality-metrics.service.ts`、`crawl-quality-task-snapshot.service.ts`、`crawl-quality-task-snapshot.helpers.ts`、`crawl-quality-metrics.types.ts`、`search-telemetry.controller.ts`、`search-telemetry-admin.controller.ts`、`search-telemetry.service.ts`、`search-telemetry.constants.ts` 与两个 DTO、`packages/mongo/src/models/crawl-result-content.ts`。

## 1. 开关与回滚

- 变量：`API_GO_CRAWL_READ_TELEMETRY_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本是 `API_GO_CRAWL_READ_TELEMETRY_MODE must be one of legacy|go`。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（`crawlresultcontents` 与 `tasklogs` 在 Mongo；`CrawlTask` / `CrawlResult` / `CrawlMediaAsset` / `CrawlQualityTaskSnapshot` / `ObservabilitySnapshot` / `AlertRule` / `SystemSetting` 在 MySQL；遥测计数与快照锁在 Redis；`JWT_SECRET` 同时是媒体签名的 HMAC 密钥）。缺失时启动失败，错误文本分别含 `JWT_SECRET` / `DATABASE_URL` / `REDIS_HOST` / `MONGO_URI` 与变量名；`DATABASE_URL` DSN 无效时也启动失败。
- 回滚：**只把 `API_GO_CRAWL_READ_TELEMETRY_MODE` 改回 `legacy`**——纯配置变更；`legacy` 时不注册 handler、不追加路由规则、不额外打开 Mongo 连接。
- 不改任何已有 `API_GO_*` 的默认值；不改 Web 的 API 地址；不打开 canary。**未启用 shadow。**

## 2. 接管的 7 条路径（仅 `go` 时）

| # | 路径 | 权限 | 成功码 | 数据源 |
|---|---|---|---|---|
| 1 | `GET /api/crawl-tasks` | `crawl.read` | 200 | MySQL `CrawlTask`（`_count.results` 映射 `resultCount`） |
| 2 | `GET /api/crawl-tasks/:id` | `crawl.read` | 200 | MySQL `CrawlTask` / `CrawlResult` / `CrawlMediaAsset` / `ItemMeta` + Mongo `crawlresultcontents` / `tasklogs` |
| 3 | `GET /api/crawl-media-assets/:assetId/:mode` | `@Public` + HMAC | 200 二进制 | MySQL `CrawlMediaAsset` LEFT JOIN `CrawlMediaBlob` |
| 4 | `GET /api/admin/crawl4ai/quality` | `crawl.read` | 200 | MySQL `CrawlTask` / `CrawlQualityTaskSnapshot` / `AlertRule` / `ObservabilitySnapshot` + Mongo `tasklogs` / `crawlresultcontents` |
| 5 | `GET /api/admin/crawl4ai/quality/sources/:sourceId` | `crawl.read` | 200 | 复用 #4 的总快照 |
| 6 | `POST /api/search-telemetry` | `items.read` | 201 `{"recorded":true}` | Redis |
| 7 | `GET /api/admin/search-telemetry/summary` | `settings.manage` | 200 | Redis |

路由规则在 `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go`：#1/#4/#7 是精确 path + `GET`，#6 是精确 path + `POST`，`#2`/`#5` 是恰好一段动态段，`#3` 是恰好两段动态段；都带预检 `OPTIONS`（无预检头时回落 legacy）。`:id` 恰好一段，所以 `POST /api/crawl-tasks/metadata` 不是 `GET`、不被 #2 命中。

## 3. 采集任务列表与详情

- **列表**：`page` ≥ 1（默认 1）、`pageSize` 1..50（默认 10）、`status`（`pending|queued|running|completed|failed|paused`）、`search`（`targetUrl` 或 `displayName` contains）。按 `createdAt desc` 分页，返回 `{tasks, total, page, pageSize}`；非法参数按 ValidationPipe 语义返回 400（文案逐条对齐 class-validator）。
- **详情**：`resultLimit` 1..100（缺省走 `clampResultLimit` 的 fallback=20）、`resultSearch`（`sourceUrl` contains）。任务不存在或属于其他 `orgId` → 404 `crawl task not found`（小写 `crawl` 与 Nest 一致）。
- 结果按 `fetchedAt desc` 取 `resultLimit` 条；Mongo 关联 `markdown` / `markdownWithCitations` / `referencesMarkdown` / `fitMarkdown` / `linkAnalysis` / `media` / `tables`；MySQL `CrawlMediaAsset` 生成 `previewUrl`（仅 `inlineSafe`）与 `downloadUrl`：`/api/crawl-media-assets/<assetId>/<mode>?exp=<expiresAtMs>&org=<urlEncodedOrgId>&user=<urlEncodedUserId>&sig=<base64urlHmac>`，签名 payload 是 `<assetId>:<mode>:<expiresAtMs>:<orgId>:<userId>`、密钥 `JWT_SECRET`、`base64url`（与 Node `digest("base64url")` 一致）。
- `ItemMeta` 通过 `externalId = CONCAT('crawlResult:', r.id)` 关联（等价于 Nest 的 `IN (...)`），填 `itemId` / `itemStatus`。
- `tasklogs`（`queue="crawl4ai"`、`jobId=taskId`、`orgId`、`stage="complete"`，`createdAt desc` 取 1 条）产出 `memoryStats` 与 `lastRunSummary`。
- 返回 `{task: {…taskView, results, memoryStats, lastRunSummary}}`。

## 4. 媒体资产签名下发

- `:mode` 只允许 `preview` / `download`，否则 404 `Unsupported crawl media access mode`。
- 验签顺序与文案严格对齐 `verifySignedAssetAccess`：`Missing signature` → `Missing access scope`（org/user 缺失/空白/长于 191）→ `Invalid expires timestamp`（`Number.parseInt` 前缀语义）→ `Signature expired` → `Signature window too large`（> 86400_000ms）→ `Invalid signature`（`hmac` + `subtle.ConstantTimeCompare`）。
- 查询 `CrawlMediaAsset WHERE id=? AND orgId=?` LEFT JOIN `CrawlMediaBlob`；不存在 404 `Crawl media asset not found`。
- `provider="mysql"` 时优先 `blob.blobData`、其次遗留 `record.blobData`，都空则 404 `Crawl media payload is unavailable`。
- Content-Type 经别名映射（`jpg`→`image/jpeg`、`svg`→`image/svg+xml`、`mp3`→`audio/mpeg` 等）后只放行 `image/*`、`video/*`、`audio/*`，其余降级 `application/octet-stream`。
- 仅 `mode="preview"` 且在 inline 白名单（`image/{jpeg,png,webp,gif,avif,bmp}`、`video/{mp4,webm,ogg,quicktime}`、`audio/{mpeg,ogg,wav,webm,aac,flac}`；**`image/svg+xml` 不在白名单**）时 `Content-Disposition: inline` 并加 `Content-Security-Policy: default-src 'none'; sandbox`，否则 `attachment`。
- 固定设置 `Content-Type`、`Content-Length`、`Cache-Control: private, max-age=300`、`X-Content-Type-Options: nosniff`、`Content-Disposition: <disposition>; filename="<escaped>"`。
- `presignedUrlTtlSeconds` 从 MySQL `SystemSetting` 的 `storage_s3_presigned_url_ttl_seconds` 读取并收口到 30..86400（缺省 300）。

## 5. Crawl4AI 质量快照

- `lookbackHours` 缺省 24，收口 1..336。
- 复用 `ObservabilitySnapshot`：`scope="crawl_quality_metrics"`、`variantKey="lookbackHours:<safeHours>"`、TTL 60 秒、Redis 锁键 `observability-snapshot:<orgId>:crawl_quality_metrics:lookbackHours:<safeHours>`（`CacheService.withLock` 的 `lock:` 前缀一致），与 Nest 共享同一缓存。
- 过期/未命中时：解析 `AlertRule`（`orgId`、`status="active"`、`metricProvider="crawl_task"`）得到 `preflightFailureRateHigh`(0.15) / `http304HitRateLow`(0.05) / `orgHashDedupeHitRateHigh`(0.3)；查窗口内 `CrawlTask`，为空直接返回全零快照；否则 `ensureSnapshotsForWindow` 对比 `CrawlQualityTaskSnapshot.taskUpdatedAt` 与 `rolledAt`，对缺失、已更新或 `pending/queued/running` 且距上次滚动超 5 分钟的任务，从 Mongo `tasklogs`（`expansion` / `preflight` / `dedupe`）与 `crawlresultcontents`（markdown）聚合后 `INSERT … ON DUPLICATE KEY UPDATE`；再跑 `queryOverallAggregate` 与 `queryGroupedAggregates` 算比率与分源明细。
- `/quality/sources/:sourceId`：从总快照的 `groupedBySource` 取该 `sourceId`；未命中时计数与比率归零、保留 `orgId` / `from` / `to` / `alertThresholds`，`groupedBySource: []`。

## 6. 检索遥测

- **上报**：`eventType` 必填（`archive_search_submit` / `archive_query_too_short` / `archive_load_more_click`）；`surface`（`search_page` / `events_archive`）、`vertical`（`ArchiveVertical`：`EAST_SEA` / `SOUTH_SEA` / `WEST_FRONT` / `FOREIGN_AFFAIRS` / `DOMESTIC_AFFAIRS`）、`queryLength` 0..500 可选。Redis 日桶键 `search-telemetry:<orgId>:<YYYY-MM-DD>`（UTC），对 `events.total`、`events.<eventType>`、可选 `surface.<surface>`、`archive_load_more_click` + `vertical` 时的 `load_more.vertical.<vertical>`、以及 `query_length.<bucket>`（`<=1`:`len_00_01`、`<=3`:`len_02_03`、`<=7`:`len_04_07`、`<=15`:`len_08_15`、`<=31`:`len_16_31`、否则 `len_32_plus`）`HINCRBY 1` 并 `EXPIRE 2592000`。Redis 失败被吞掉（与 Nest 的 try/catch 一致），仍 201。
- **汇总**：`from`/`to` 必填且 `^\d{4}-\d{2}-\d{2}$`；`surface` 一旦传入即 400 `surface filtering is not supported by the stored telemetry counters`（先于日期校验）；非法日历日 400 `invalid date`；`from > to` 400 `from must be less than or equal to to`；跨度 > 31 天 400 `date range cannot exceed 31 days`。逐日 `HGETALL` 汇总为 `{from, to, surface:"all", totals, daily}`。

## 7. 本批同修的 3 个跨租户隔离缺陷（Nest 与 Go 两侧）

1. **媒体资产列表漏 `orgId`**：`apps/api/src/modules/crawl/crawl-media-asset.service.ts` 第 264–268 行 `where: { resultId: { in: resultIds } }` 完全不按 `accessScope.orgId` 过滤，脏数据/跨租户调用会为不属于该组织的资产签发当前 `accessScope.orgId` 的 HMAC 签名。修复：`where: { orgId: accessScope.orgId, resultId: { in: resultIds } }`；Go 侧按 `orgId AND taskId` 查询并只保留请求结果集的资产。
2. **Mongo 内容详情漏 `orgId`**：`crawl-result.service.ts` 第 754 行 `find({ resultId: { $in: ids } })` 未带 `orgId`。修复：存在 `accessScope.orgId` 时查询补 `$or: [{ orgId }, { orgId: { $exists: false } }]`（兼容极早期无 `orgId` 文档，阻止跨组织读取）；Go 侧同样条件。
3. **质量快照 markdown 聚合漏 `orgId`**：`crawl-quality-task-snapshot.service.ts` 第 350 行调用与第 656–659 行 `$match` 只有 `{ taskId: { $in } }`，而同文件另外三个聚合都传了 `orgId`。修复：`aggregateMarkdownRows` 增加 `orgId` 参数并补同样的 `$or`；Go 侧 `aggregateMarkdownRows(ctx, orgID, taskIDs)` 同步。

## 8. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- `POST /api/crawl-tasks`、`DELETE /api/crawl-tasks/:id`、`POST /api/crawl-tasks/:id/retry`、`POST /api/crawl-tasks/metadata`（写队列与实时抓取器调用）。
- `/api/admin/crawl4ai/queue*`（队列管理，不属于本开关）。
- 上述 7 条的非注册方法（如 `PATCH /api/crawl-tasks/:id`）、更长路径与父路径。

## 9. 已知偏差（诚实登记）

- **`resultLimit` 缺省值**：事实源 `crawl.utils.ts` 的 `clampResultLimit(limit, fallback = 20)` + DTO `Max(100)`，即缺省 20、范围 1..100；任务书正文写的「默认 50 / 1..200」与基线源码不一致，本批以源码为准（Nest 与 Go 一致）。
- **`vertical` 取值**：事实源 `ArchiveVertical` 枚举是 `EAST_SEA|SOUTH_SEA|WEST_FRONT|FOREIGN_AFFAIRS|DOMESTIC_AFFAIRS`，不是任务书正文的 `world|defense|…`；本批以源码为准，Nest 与 Go 都只接受这 5 个值。
- **`lookbackHours` 解析**：严格照抄 `Number.parseInt(raw ?? "24", 10)` 的宽松前缀语义在 Go 侧未完全复刻（Go 用 `strconv.ParseInt`，`"12abc"` 会回退 24 而非 12）；正常输入（纯整数）行为一致。
- **快照 JSON 键序**：空窗口分支 Nest 写 `alertThresholds` 在 `groupedBySource` 之前，Go 结构体固定为 `groupedBySource` 在前；仅键序差异，值一致。
- **S3 provider 资产未实现预签名**：Go 侧没有 AWS SigV4 预签名，`provider="s3"` 的资产不下发 `previewUrl`/`downloadUrl`（等价于 Nest 预签名失败分支），`GET /api/crawl-media-assets/...` 对 S3 资产返回 404；MySQL blob 路径（本批验收覆盖）完整实现。
- **Redis Hash 字段顺序**：Go 的 `HGetAll` 返回 map，`queryLengthBuckets` / `loadMoreVerticalCounts` 的键序按字典序输出；语义与计数一致。

## 10. 验收与未验证项

- 普通 CI：`go test ./...`（编译 + 本批新增的参数规则 / HMAC / Content-Type / 分桶 / 日期范围 / 快照投影单测 + 路由规则测试：默认与 `legacy` 不拦截；`go` 时精确拦截这 7 条；写队列、metadata、`crawl4ai/queue*` 与更长路径仍回落）。
- 真实栈 smoke：`api-go-crawl-read-telemetry-smoke.yml`（`workflow_dispatch` 或 PR 加 label `api-go-crawl-read-telemetry-smoke`），只用隔离组织；构造本组织与另一组织的 `CrawlTask` / `CrawlResult` / Mongo `crawlresultcontents` / MySQL `CrawlMediaBlob` + `CrawlMediaAsset`（`image/png` 与 `image/svg+xml` 各一张）/ `tasklogs`。断言见 workflow。
- **未验证/未发生**：生产流量未切换；canary 保持关闭；未启用 shadow；未改前端；未改 Web 的 API 地址；SEC-01 的真实登录态不在本批验证；未处理 FE-TPL-02。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。
