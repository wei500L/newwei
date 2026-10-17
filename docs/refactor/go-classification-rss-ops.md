# 分类质量工作台与 RSS 诊断/翻译指标（Go 接管说明）

> 本批：`API_GO_CLASSIFICATION_RSS_OPS_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源（逐段翻译，未使用简化版）：`apps/api/src/modules/observability/classification-quality.controller.ts` / `classification-quality.service.ts` / `classification-quality.dto.ts`、`apps/api/src/modules/news-pipeline/news-classification-quality-settings.service.ts`、`apps/api/src/modules/news-events/news-event-source-classifier.ts`、`apps/api/src/modules/system-settings/rss-diagnostics.controller.ts` / `rss-diagnostics.service.ts`、`apps/api/src/modules/system-settings/rss-translation-metrics.controller.ts` / `rss-translation-metrics.service.ts`、`apps/api/src/modules/observability/observability-snapshot.service.ts`、`packages/mongo/src/models/classification-review.ts` / `classification-sample.ts` / `classification-annotation.ts` / `classification-report-job.ts` / `classification-report-result.ts` / `processed-item.ts` / `raw-item.ts` / `task-log.ts`。

## 1. 开关与回滚

- 变量：`API_GO_CLASSIFICATION_RSS_OPS_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名（`API_GO_CLASSIFICATION_RSS_OPS_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（`processeditems`、`tasklogs`、`rawitems` 与 5 个 `classification*` 集合在 Mongo；RSS 诊断读 MySQL 与 MySQL `ObservabilitySnapshot`；摘要缓存、告警节流、告警接收人缓存与快照锁在 Redis）。`MONGO_URI` 缺失时启动失败，错误文本是 `MONGO_URI is required when API_GO_CLASSIFICATION_RSS_OPS_MODE=go`；`DATABASE_URL` DSN 无效时启动失败。
- 回滚：**只把 `API_GO_CLASSIFICATION_RSS_OPS_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则、不额外打开 Mongo 连接。
- 不改任何已有 `API_GO_*` 的默认值；不改 Web 的 API 地址；不打开 canary。**未启用 shadow。**
- 本批新增代码共 13 条精确路由规则（10 条静态路径 + 3 条“恰好一段”动态路径），每条都带方法白名单与同路径 `OPTIONS` 预检。

## 2. 接管的路径（仅 `go` 时）

| 方法 | 精确路径 | 成功码 | 数据源 |
|---|---|---|---|
| GET | `/api/admin/quality/classification/summary` | 200 | Mongo `processeditems` / `tasklogs` / `classificationreviews` + MySQL `SystemSetting`/`NewsSource` + Redis |
| GET | `/api/admin/quality/classification/sources/:sourceId/items` | 200 | Mongo `processeditems` + MySQL `ProcessedArticle`/`Article` |
| GET | `/api/admin/quality/classification/reviews/queue` | 200 | Mongo `classificationreviews` |
| POST | `/api/admin/quality/classification/reviews/:reviewId/decision` | 201 | Mongo `classificationreviews` + MySQL `AuditLog` |
| POST | `/api/admin/quality/classification/reviews/batch` | 201 | Mongo `classificationreviews` + MySQL `AuditLog` |
| POST | `/api/admin/quality/classification/sampling/query` | 201 | Mongo `processeditems`/`classificationsamples` + MySQL `NewsSource`/`ProcessedArticle` |
| POST | `/api/admin/quality/classification/sampling/annotations` | 201 | Mongo `classificationsamples`/`classificationannotations` |
| GET | `/api/admin/quality/classification/reports/:jobId` | 200 | Mongo `classificationreportjobs`/`classificationreportresults` |
| GET | `/api/system-settings/rss-diagnostics/overview` | 200 | MySQL `NewsSource`/`Article`/`PipelineJob`/`CrawlTask`/`CrawlResult` + Mongo `processeditems` + `ObservabilitySnapshot` |
| GET | `/api/system-settings/rss-diagnostics/chain` | 200 | 同上（返回 `overview.chain`） |
| GET | `/api/system-settings/rss-diagnostics/sources` | 200 | 同上（返回 `overview.sources`） |
| POST | `/api/system-settings/rss-diagnostics/backfill-source-id` | 201 | Mongo `processeditems`/`rawitems` + MySQL `PipelineJob`/`CrawlTask`/`CrawlResult`/`ItemMeta`/`NewsSource` |
| GET | `/api/system-settings/rss-translation/metrics` | 200 | MySQL `RssTranslationMetricsDaily` |

动态段的匹配规则是“前缀 + 恰好一段非空路径段 +（可选）固定后缀”：

- `sources/:sourceId/items`、`reviews/:reviewId/decision` 要求恰好一段且必须以固定后缀结尾；`sources/a/b/items`、`sources//items`、`reviews/r1/decision/extra` 都不匹配；
- `reports/:jobId` 要求恰好一段；`reports/job-1/results`、`reports/` 都不匹配；
- 静态路径 `reviews/queue`、`reviews/batch`、`sampling/query`、`sampling/annotations` 与动态规则互不遮蔽。

## 3. 分类质量契约

- **配置读取**：先读 Redis `classificationQuality:settings:<orgId>`，未命中读 MySQL `SystemSetting` 键 `classification_quality_settings:<orgId>`，再回退默认值（`lowConfidenceThreshold` 0.4、`llmP95LatencyWarnMs` 8000、`embeddingP95LatencyWarnMs` 3000、`rerankP95LatencyWarnMs` 4000、`gateRejectRateWarn` 0.2、`gatePenalizedRateWarn` 0.35、`reportMinPairCount` 3、`reportMinPairErrorRate` 0.2、`cacheTtlSeconds` 60）。读取失败一律回退默认值，不让请求失败。
- **`GET summary`**：`window` 只接受 `1h`/`24h`/`7d`（默认 `24h`，非法 400 `window must be one of the following values: 1h, 24h, 7d`），桶宽分别为 5/60/360 分钟。Redis 缓存键 `quality:classification:summary:<orgId>:<window>:<sourceId|all>:<categoryPrefix|all>`，TTL 60 秒。从 `processeditems` 聚合匹配总数与最近 3000 条样本，计算 `methodDistribution`（`rule`/`fallback` 前缀归入 `rule_fallback`，其余归入 `llm_embedding_rerank`）、10 桶 `confidenceHistogram`、按桶对齐的 `confidenceTrend`、前 10 `lowConfidenceSources`、前 30 `sourceCategoryBreakdown`（结合组织级 `news_event_source_policy:<orgId>` 判定 `authoritative`/`blog`/`unknown`）；从 `tasklogs` 聚合 `queue=news_pipeline&stage=classify&status=completed`（最多 20000 条）的 P50/P95/P99 与 `queue=news_events&stage=category_gate&status=completed`（最多 20000 条）的 reject/penalized/accepted 与比率；统计 `classificationreviews` 的 `status=pending` 数量。`alertStatus`/`gateAlertStatus` 有触发项时以 Redis NX 键 `quality:classification:alert:notify:<orgId>:<window>:<signature>`（TTL 900 秒）节流，向本组织持有 `settings.manage` 的活跃成员写 `Notification`（`data.presentation.kind=classification_quality_threshold_exceeded`）。Go 只落库通知行，不复制 Nest 进程内的实时推送 fan-out。
- **`GET sources/:sourceId/items`**：查询该源在窗口内 `result.category_confidence <= maxConfidence` 的已完成条目（默认阈值取设置，`limit` 默认 50、上限 200，`cursor` 为 ISO 时间戳），关联 `ProcessedArticle.cleanedMarkdownRef` → `Article` 补齐 `articleUrl`。
- **`GET reviews/queue`**：`onlyUnreviewed` 默认 `true`（`"true"`/`"1"`/`"false"`/`"0"`，其他值 400 `onlyUnreviewed must be a boolean value`），按 `createdAt desc` 返回复核项（`candidatePaths` 原样透传，保留 `legacy_category`/`reason` 的 null 语义）。
- **决策两条**：`status` 必填（`approved`/`rejected`/`corrected`，非法 400 `status must be one of the following values: approved, rejected, corrected`）；`status=corrected` 时 `correctedCategoryPath` 经 `normalizePath` 后必须非空，否则 400 `correctedCategoryPath is required when status=corrected`。单条找不到 404 `Review item not found`，成功写 `AuditLog`（`resource=classification_review`、`action=classification_review_decision`）并返回更新后的 Mongo 原始文档结构；批量去重后最多 500 个 id，写 `AuditLog`（`action=classification_review_batch_decision`），返回 `{matched, modified}`。
- **`POST sampling/query`**：按 `confidenceBand|method` 分层（`<0.4` low、`<0.75` medium、其余 high），每层 Fisher-Yates 打乱后取 `perStratum`（默认 20，1..200）条，写入 `classificationsamples`（`expiresAt` 180 天），返回 `{sampleId, itemCount, strata, items, createdAt}`。`items` 的顺序按层随机，Nest 与 Go 都不保证同一顺序（逐字段比对时需按 `processedItemId` 排序）。
- **`POST sampling/annotations`**：`sampleId` 必须属于当前组织且为合法 ObjectId，否则 404 `Sample not found`；只对存在于 `sample.items` 里的 `processedItemId` 做 `classificationannotations` upsert（`expiresAt` 365 天，并补 Mongoose timestamps 的 `createdAt`/`updatedAt`），随后重算并返回 `{sampleId, updated, total, correct, accuracy, confusionMatrix, problemPathPairs}`（问题对阈值取设置，最多 50 条）。
- **`GET reports/:jobId`**：`jobId` 非法或不存在都返回 200 `null`；`reportResultId` 是服务端写入的合法 ObjectId，若库里被写成非 ObjectId 则按损坏数据处理为 500（与 Nest 的 CastError 行为一致，不额外放宽）。

## 4. RSS 链路诊断与翻译指标

- `windowDays` 收口 1..30（默认 7）、`lookbackHours` 收口 1..720（默认 24），非法数值按 `Number(raw)` 宽松回退，不抛 400。
- 三个读接口共用 `ObservabilitySnapshot`：`scope=rss_diagnostics`、`variantKey=windowDays:<n>:lookbackHours:<n>`、TTL 60 秒、共享锁键 `observability-snapshot:<orgId>:rss_diagnostics:<variantKey>`（`cache.service.ts` 的 `withLock` 前缀 `lock:`）；`chain` 与 `sources` 先取同一份快照再取 `chain`/`sources` 字段，保证与 Nest 命中同一行快照。
- 源集合筛选条件与 Nest 相同：`NewsSource.config.seed.mode === "rss"`（`enabled` 只认布尔 `true`，`mode` 非 `rss`/`list`/`deep` 时按 `sitemap` 处理并被排除），`feedUrl` 为空时回落站点 URL。
- 可见性：`processed`（窗口内有已完成 `processeditems`）→ `article_fallback`（只有窗口内 `Article`）→ `none`；问题标签顺序固定为 `seed_disabled`、`feed_url_missing`、`no_recent_items`/`processed_source_link_missing`、`source_has_failures`；`recommendations` 顺序固定为 `news_source_scheduler_disabled`、`no_rss_sources_configured`、`run_source_id_backfill_for_processed_items`、`high_processed_item_missing_source_id_rate`、`crawl_results_missing_markdown_ref_detected`。
- `newsSourceSchedulerEnabled` 直接读环境变量 `NEWS_SOURCE_SCHEDULER_ENABLED`（`envBoolean` 语义，默认 `true`），不把该变量加进 `config.Config`——本批只允许在 `config.go` 追加自己的开关。
- `POST backfill-source-id`：`dryRun` 默认 `true`（仅显式 `false` 写库），`limit` 收口 1..5000（默认 500）。多跳顺序为 `PipelineJob.sourceId` → `RawItem.payload.metadata.sourceId` → `...pipelineJobId` → `...crawlResultId` → `ItemMeta.externalId`（`crawlResult:`/`crawl:` 前缀查 `CrawlTask.config`），只回填属于本组织 `NewsSource` 的值；写库用 `bulkWrite`（filter 仍带 `sourceId` 为空的三个条件）并失效本组织 `rss_diagnostics` 快照；响应 `{dryRun, limit, scanned, matched, updated, unresolved, unresolvedSamples}`。
- `GET rss-translation/metrics`：`provider` 非空时只允许 `deeplx`/`llm`（否则 400 `provider must be one of: deeplx, llm`）；`from`/`to` 必须严格是 `YYYY-MM-DD`（非法 400 `Invalid date '<raw>', expected YYYY-MM-DD`，`from > to` 400 `'from' must be earlier than or equal to 'to'`，跨度 > 180 天 400 `Date range exceeds 180 days`），默认最近 14 天；`RssTranslationMetricsDaily` 缺表/缺列时返回空 `rows` 与全零 `summary`（对齐 Prisma 的 P2021/P2022/1146/1054 处理）。

## 5. 同批修复的 4 个缺陷（Nest 与 Go 两侧一致）

1. **非 24 位十六进制 ObjectId 触发 Mongoose CastError（500）**：`apps/api/src/modules/observability/classification-quality.service.ts` 的 `submitReviewDecision`（原第 428 行）、`batchReviewDecision`（原第 509 行）、`submitAnnotations`（原第 757 行）、`getReportJob`（原第 940 行）直接把用户字符串当 `_id` 查询。修复：决策前 `Types.ObjectId.isValid` 校验，单条返回 404 `Review item not found`、批量过滤无效 id（全无效时返回 `{matched:0, modified:0}`）、标注返回 404 `Sample not found`、报告返回 `null`。Go 侧对应 `SubmitReviewDecision`/`BatchReviewDecision`/`SubmitAnnotations`/`GetReportJob`。
2. **`status=corrected` 传 `"///"` 绕过 DTO 校验落库成 `null`**：控制器只检查 `!body.correctedCategoryPath`（原第 80、101 行），服务层 `normalizePath`（第 2223 行区域）把 `"///"` 归一化为空。修复：两条决策路径先 `normalizePath` 再判断，空则抛 400 `correctedCategoryPath is required when status=corrected`，并把归一化结果写库。
3. **告警接收人漏判 `Membership.isActive`**：`getAlertRecipientUserIds`（原第 1783-1815 行）只过滤 `orgId` 与 `user.isActive`，组织内已停用成员仍收到阈值通知。修复：`membership.findMany` 的 `where` 补 `isActive: true`；Go 侧 SQL 同步加 `m.isActive = 1`。
4. **`mtk_` 机器令牌写 `AuditLog.actorId` 为 `"machine:<id>"`**：原第 460、531 行原样写入，违反 User 外键。修复：新增 `resolveAuditActorId`，`machine:` 前缀写 `null`；Mongo `reviewerId` 仍保留原 `actorId`。Go 侧对应 `auditActorID`。

## 6. 身份与鉴权（沿用 admin logs / llm logs / quality overview 的同一实现）

- 缺少 `Authorization` 或非 Bearer → 401；token 以 `mtk_` 开头走 `MachineAccessToken`（SHA-256 查 `tokenHash`，连 `Org.isActive`，拒绝已撤销/已过期，更新 `lastUsedAt`，身份 = `machine:<tokenId>`，权限取令牌行）；其他 token 走 JWT 验签 + Redis 撤销名单 + MySQL membership/permission 重推导（忽略 JWT claims 里的 `permissions`）。
- 13 条全部要求 `settings.manage`，缺失 403（契约错误体与 GlobalExceptionFilter 对齐）。`orgId` 一律取自身份，请求参数不能覆盖。

## 7. 强类型与英文注释（铁律落实）

- `apps/api-go/internal/classificationrssops` 内所有请求 DTO、响应模型、Mongo 文档映射（`processeditems`、`tasklogs`、`classificationreviews`、`classificationsamples`、`classificationannotations`、`classificationreportjobs`、`classificationreportresults`、`rawitems`）、MySQL 行扫描、快照载荷、审计 `metadata` 与通知 `data` 都是带精确 `bson`/`json` tag 的具名 `struct`。
- 枚举为具名字符串类型与常量：`QualityWindow`、`ReviewDecisionStatus`、`ConfidenceBand`、`ClassifiedSourceType`、`RssSourceVisibility`；可空字段用指针或专用 `optionalString`/`optionalNumber`/`optionalTime`（区分“字段缺失”与“存储为 null”，JSON 与 Nest 逐字节一致）。
- `any` / `interface{}` / `map[string]any` / `[]any` 零使用：MySQL 语句固定 arity，动态 id 集合用 `JSON_CONTAINS(?, JSON_QUOTE(col))` 匹配，Mongo 过滤与聚合用 `bson.D`/`bson.E` + 类型化解码。修改到的 TypeScript 同样无 `any`。
- 新增与修改的 `.go`/`.ts` 注释全部为英文（GoDoc 以符号名开头）；关键业务分支（分层抽样、混淆矩阵、多跳 `sourceId` 回填、ObjectId 校验、跨租户隔离）都有英文行内注释。

## 8. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- `POST /api/admin/quality/classification/reports`：会向 BullMQ `CLASSIFICATION_QUALITY_QUEUE` 投递异步任务，遵守队列红线**不迁移**。
- `PATCH`/`DELETE` 等未列出的方法与更长路径（`reports/:jobId/results`、`reviews/queue/detail`、`sources/a/b/items`、`rss-diagnostics/backfill-source-id/extra` 等）继续代理到 NestJS。

## 9. 验收与未验证项（诚实登记）

- 本机未安装依赖、未跑测试、未构建、未启动 Docker；所有验证在 GitHub Actions 执行。
- 普通 CI：`pnpm lint`（含 `go vet ./...`）、`pnpm typecheck`、`pnpm --filter @modular/api test`、`pnpm --filter @modular/api-go test`、`pnpm exec turbo run build`。
- smoke：`.github/workflows/api-go-classification-rss-ops-smoke.yml`（`workflow_dispatch` 或 PR label `api-go-classification-rss-ops-smoke`），覆盖 legacy 代理一致性、go 接管逐字段一致性、缺陷 1/2 的 404/400、抽样+标注的混淆矩阵、多跳回填（`dryRun` 前后）与 `rss_diagnostics` 快照、翻译指标与 `provider` 400、跨组织隔离与 `settings.manage` 403、机器令牌、以及停掉 Nest 后 12 个端点仍 200/201 而未迁移的 `POST /reports` 返回 502。
- `SEC-01` 的真实登录态未在本批验证，仅在报告里点名。
