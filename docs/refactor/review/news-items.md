# 新闻、条目与个人化：Go 对照 NestJS 静态审查

> 本文件是「新闻、条目与个人化」领域的 Go ↔ NestJS 全量静态审查报告，为本批 5 个并行审查窗口之一。
> 审查方式：纯静态阅读对照 + 对抗式复核。**本机未连接任何真实 MySQL / Redis / Mongo / Elasticsearch / SMTP / LLM 上游，未运行 `go build`、`go test`、`pnpm`、Docker 或任何服务**，验证全部走现有普通 GitHub Actions CI（见文末）。
> 基线：`origin/main = dc48abc18c2a5921ace8189db6471c5a3ef0a3c2`（#141，整合 #138–#140）。

## 0. 开工前基线核实

| 项 | 结果 |
|---|---|
| `git fetch origin main` / `git rev-parse origin/main` | `dc48abc18c2a5921ace8189db6471c5a3ef0a3c2`，与规划基线一致 |
| `git log --oneline -5 origin/main` | 头为 `dc48abc1 Merge pull request #141 …` |
| `gh pr list --state open` | 无开放 PR |
| `gh run list --branch main --limit 3` | 该 SHA 的普通 CI 为 `39664944449`，conclusion `success` |
| `git worktree list` | `/Users/oo/project/newwei-review-news-items` 未被占用，分支 `review/go-news-items` 为新建 |
| 规划期 CI 记录 | 规划时称"未查到该 SHA 的 CI 运行记录"；**开工复核时已存在且成功**，故以该运行为本批基线 |

**文档定位说明（与任务书的偏差）**：任务书要求阅读 `docs/refactor/cutover/ownership-audit.md` 与 `docs/refactor/cutover/switch-matrix.md`，但**仓库中不存在 `docs/refactor/cutover/` 目录**，也没有这两个文件，全仓 grep `ownership-audit|switch-matrix` 零命中。本报告改用实际存在的等价材料建立对应关系：`docs/refactor/migration-map/{README,PLANNING}.md`、`docs/refactor/api-contract-inventory.md`、`docs/refactor/go-*.md` 域文档、以及源码本体的 `API_GO_*` 开关门控。若这两个文件在其他分支上，需在整合窗口补齐后再交叉核对一次。

## 1. 范围

### 1.1 Go 侧（`apps/api-go`）

`itempipeline`、`pipelineenqueue`、`itemsingest`、`processeditemoutbox`、`newspipeline`、`newsclassifier`、`newseventsingest`、`newseventstimeline`、`newsbackfilljobs`、`clusteringrecoveryqueue`、`newsnowclusteringops`、`newssources`、`newssourcescheduler`、`newsindicator`、`newsbehavior`、`rsstranslation`、`classificationalert`、`classificationreviewseed`、`classificationrssops`、`qualityqueue`、`qualityoverview`、`itemsreading`、`searchreindex`、`sentimentsnapshot`、`gdeltsnapshot`、`kgingestion`、`publicportal`、`contentcatalog`、`contentsubscriptions`、`personalnews`、`userdigest`，以及 `internal/graphqlread` 下的相关解析器。

### 1.2 Nest 侧（`apps/api/src`）

`modules/news-pipeline`（15.8k）、`modules/news-aggregator`（10.5k）、`modules/news-events`（9.6k）、`modules/items`（10.2k）、`modules/news-indicator`、`modules/news-signals`、`modules/search-telemetry`、`modules/sentiment`、`modules/public-portal`、`modules/user-content-subscriptions`、`modules/user-news-behavior`、`modules/user-digest`，以及 `modules/queue` 中 itemPipeline 的生产与消费（`queue.processor.ts`、`queue.service.ts`）与 `news-source.scheduler.service.ts`、`news-source-{dispatch,ops}.controller.ts`。

### 1.3 不属于本窗口

crawl 一侧；队列运维与组织计数（`queueops`、`queueorgstats`、Bull Board）；GraphQL 执行器本身；dashboard；告警域。

## 2. 入口清单

审查深度口径：**全文** = 逐分支读写；**重点** = 写路径 / 鉴权 / 后台任务逐条核对，读格式化抽样；**抽样** = 只核对开关接线与契约形状；**未审查** = 实现不在本窗口结论内。

### 2.1 itemPipeline 生产与消费

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| 生产 `queue.service.ts:74-192` | `pipelineenqueue/producer.go:101-187`（add 脚本 `scripts.go:539`） | 由调用方开关决定性传入 | 全文 | 一致；重复入队分支见 §4.3 |
| Worker 消费 `queue.processor.ts:110-240` | `itempipeline/worker.go:400-460` + `processor.go:100-198` | `API_GO_ITEM_PIPELINE_WORKER_MODE`（+`BULLMQ_WORKERS_ENABLED`） | 全文 | **W1-01 已修** |
| `failed` 监听：TaskLog/状态/DLQ `queue.processor.ts:242-365` | `worker.go:436-460` + `processor.go:202-291` + `dlq.go:24-189` | 同上 | 全文 | 一致；信封差异 W1-02 |
| Worker 门控 `queue.processor.ts:88-105` | `cmd/api/item_pipeline_worker.go:82-88` | 同上 | 全文 | 一致 |
| 错误分类 `queue.error-handling.ts:220-324` | `itempipeline/errors.go:283-399` | 同上 | 全文 | 一致 |
| 状态机 + 源熔断/自动禁用 `queue.processor.ts:372-846` | `state.go:73-279,316-498` | 同上 | 全文 | 一致；Go 用 `SELECT … FOR UPDATE`（有意改善） |
| DLQ 入队 `queue.processor.ts:323-351` | `dlq.go:24-189` | 同上 | 全文 | 一致 |
| 立即投递 `news-pipeline-outbox.service.ts:198-235,325-352` | `processeditemoutbox/deliver_export.go:14-20` → `service.go:185-256` | 随 worker 开关 | 全文 | 一致，共用 CAS claim，无双投 |
| 5 分钟补偿重放 `news-pipeline.service.ts:191-200` | `processeditemoutbox/scheduler.go:53-145` | `API_GO_PROCESSED_ITEM_OUTBOX_MODE` | 全文 | 一致；Go 额外加 Redis 租约 |
| QueueEvents → GraphQL 订阅 / Socket.IO `queue-event.publisher.ts` | **未迁移（Nest 独占）** | 无开关 | 全文 | 无 Go 对照实现，见 §7 |
| pipeline replay / rollback `pipeline-recovery.service.ts:132-249` | `pipelinerecovery/writes.go:250-310`（范围外，仅核入队参数） | `API_GO_PIPELINE_RECOVERY_WRITE_MODE` | 重点 | 入队侧一致 |

### 2.2 新闻事件聚类、时间线与迁移任务

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| `NewsEventsIngestionService.ingestRecentProcessedArticles`（`@Cron` 5min，`news-events-ingestion.service.ts:44`） | `newseventsingest/scheduler.go:256`、`ingest.go:32` | `API_GO_NEWS_EVENTS_INGESTION_MODE` | 全文 | 一致；修 W3-01 |
| `NewsEventsBertopicService.processBatch`（`:53`） | `newseventsingest/bertopic.go:33` | 同上 | 全文 | 一致 |
| `assignNewsSignalToEvent` 及 picker/gate 全部辅助（`:614,744,809,878,1186,1335,1369,1447,1577`） | `newseventsingest/assign.go:116-528`、`categorygate.go:110`、`signal.go:375` | 同上 | 全文 | 一致；修 W3-02 |
| `listAssignmentCandidatesForSignal`（`:864`） | `newsnowclusteringops/llm_backfill_candidates.go:27,67` | `API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE` | 重点 | 一致 |
| `NewsEventsTimelineService.rebuildRecentTimelines` + 全部纯函数（24 处） | `newseventstimeline/{scheduler,rebuild,compute,store,metadata,jsvalue,format,distribution,collate}.go` | `API_GO_NEWS_EVENTS_TIMELINE_MODE` | 全文 | 一致 |
| `NewsEventClusteringAdminController` 5 条（`news-event-clustering-admin.controller.ts:23,29,33,48,73`） | `newsnowclusteringops/handler.go:95-317`、`clusteringfailure.go:76-154` | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE` | 全文 | 一致 |
| `llmBackfill`（`:60`）→ `enqueueLlmBackfill`（`:109,179`） | `newsnowclusteringops/llm_backfill.go:57,63`、`newsbackfilljobs/handler.go` | `API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE` | 重点 | 一致 |
| `NewsEventClusteringRecoveryProcessor`（`:29-75`） | `clusteringrecoveryqueue/{worker,protocol,scripts}.go` | `API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE` | 重点 | 一致 |
| `NewsEventClusteringRecoverySchedulerService`（`@Cron` 5min + `withLock`，`:44-70`） | `newsbackfilljobs/scan_scheduler.go:95`、`lock.go:121` | 同上 | 全文 | 一致 |
| `NewsEventClusteringRecoveryService.processJob`（`:272-405`） | `newsnowclusteringops/llm_backfill.go:274` + `llm_backfill_store.go` | 同上 | 全文 | 一致；Go 独有 R1 恢复规则（已注释） |
| `NewsEventClusteringFailureService` 全量（11 处） | `clusteringfailure.go` + `store_clustering.go:145-314` | 同上 | 全文 | 字段/状态机一致 |
| `NewsAggregatorController` metadata/resolve/sources order/domestic-opinion-index（`:65,86,92,113`） | `newsnowclusteringops/{handler,service,urlresolve,store_resolve,personalization,opinionindex}.go` | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE` | 重点 | 一致 |
| `news-event-source-classifier.ts` / `news-event-source-policy.service.ts` | — | — | **未审查** | 见 §6 |

### 2.3 新闻内容流水线与分类器

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| BullMQ `itemPipeline` 消费者 `queue.processor.ts:104-215`（`:201` → `pipeline.process`），门控 `:93-103` | `cmd/api/item_pipeline_worker.go:75-264` + `newspipeline/process.go:131-155` | `API_GO_ITEM_PIPELINE_WORKER_MODE` | 全文 | 一致 |
| `NewsPipelineService.process` `:184-189`、`retryPendingOutbox` `:191-200` | `process.go:131`；补偿 owner 在 `processeditemoutbox` | 同上 + `API_GO_PROCESSED_ITEM_OUTBOX_MODE` | 全文 / 补偿部分未审查 | 一致 |
| `NewsPipelineStagesService.process` `:64-107` + `processLegacyPipeline` `:109-210` | `stages.go:27-155`、`:27-97` | 同上 | 全文 | 一致（含 persist 失败回滚） |
| `processStagedPipeline` `:212-555` | `stages.go:100-297` | 同上 | 全文 | 一致 |
| 闸门族 `evaluatePreflightGate`/`computePreflightQualityScore`/`clamp01`/`evaluatePostCleanGate`/`buildGateRejectedCleanedNews`/`stripEnrichmentFields` `:557-729` + markdown 工具 `clean.service.ts:319-398,690-835` | `gates.go:239-565` | 同上 | 全文 | 一致；重复实现见 W4-02 |
| `runIndependentEnrichmentStages` `:731-880`、`runClassificationStage` `:901-954` | `stages.go:302-442` | 同上 | 全文 | 一致 |
| `recordStageOutcome`/`updatePipelineJobStageMetadata` `:956-1029`、`runStage`/`logStageFailure` `:1098-1142` | `stage_report.go:93-159`、`process.go:157-183` | 同上 | 全文 | 一致 |
| `fetchArticle` `clean.service.ts:63-198`、`expandListLikeArticle*` `:183-317`、`cleanArticle` `:838-947`、`maybeRepairCleanedArticle` `:957-1152` | `clean.go:124-193,195-297,961-1064,1165-1301` | 同上 | 全文 | 一致 |
| dedupe 全族 `news-pipeline-dedupe.service.ts:48-170,172-341,343-424,501-537,539-684,730-813,820-862` | `dedupe.go:251-814`、`persist.go:336-390` | 同上 | 全文 | **W4-01 已修**；其余一致 |
| `news-dedupe-llm.ts` 全文（含 `NEWS_DEDUPE_RESPONSE_FORMAT`、`NewsDedupeJudgeSchema`） | `dedupe_llm.go:21-228` | 同上 | 全文 | 模板逐字节一致；校验宽松 → W4-01 |
| `createOutboxEntry` `:115-213`、`upsertArticleAndProcessed` `:354-566`、`buildProcessedItemOutboxPayload` `:570-602`、`flushOutboxDeliveryQueue` `:224-323` | `persist.go:93-209,262-542`；`outbox.go:24-169` | 同上 | 全文 | 一致；W4-05、W4-06 |
| TaskLog `writeTaskLogBestEffort` | `tasklog.go:78-239` | 同上 | 全文 | 一致 |
| `news-prompt.builder.ts` 全文、`news-prompt-config.service.ts` 全文 | `promptbuilder.go:67-266`、`promptconfig.go:16-147` | 同上 + `news_pipeline_prompt_config` | 全文 + 脚本逐字节比对 | **9 个模板全部逐字节一致**；W4-03 |
| `news-extraction-stage.service.ts` 全文 | `extraction.go:62-236,374-495` | 同上 | 全文 | 一致 |
| `litellm.service.ts` `acompletion`/`executeWithRetry`/`getCompletionTimeoutMs`/`isRetryable` | `litellmcompat/client.go:81-180`（实体属 model-gateway 窗口，本窗口只核调用点） | 同上 | 重点 | 超时/重试/回退一致 |
| `news-pipeline-crawl-bridge.service.ts` 全文 | `crawlbridge.go:650-1277` | 同上 | 全文 | 一致 |
| `news-content-type.ts` 全文 | `contenttype.go:25-47` → `archivereading/display.go:34-121` | 同上 | 重点 | 一致；W4-02 |
| `news-classifier.service.ts` 全族 | `newsclassifier/{classifier,sourcepolicy,jsonsafe,prompt}.go` | 同上 | 全文 | 一致 |
| `news-extraction-settings` / `news-dedupe-settings` / `news-classification-settings` | `settings.go:81-870` | 同上 + 共享 Redis 键 | 重点 | 一致；W4-04 已修 |
| `backfillProcessedItemClassificationSignals` `:29-174` | `archivepreparationworker/display.go:30-`（跨窗口） | 同上 | 未审查 | 入口有 Go owner |
| `@Cron` `retryPendingOutbox` + 进程内 setTimeout | 由 #116 扫描器补偿 | `API_GO_PROCESSED_ITEM_OUTBOX_MODE` | 重点 | 一致（设计前提已文档化） |

### 2.4 新闻源调度器、指标与分类质量

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| `news-source.controller.ts:43-181`（16 条 `/api/admin/news-sources*`） | `newssources/handler.go:32-64`、`validate.go:122-584`、`store.go:231-456` | `API_GO_NEWS_SOURCES_MODE` | 重点 | 鉴权/`orgId`/未知字段齐备；W5-02 |
| `GET /api/admin/news-sources/:id/preview` | `cmd/api/crawl_discovery.go:66-79` | `API_GO_NEWS_SOURCE_PREVIEW_MODE` | 未审查 | 仅确认接线 |
| `news-source-ops.controller.ts:18-44` + `news-source-dispatch.controller.ts:16-24`（4 条 POST） | `newssourcescheduler/handler.go:44-96`、`ops.go:30-343` | `API_GO_NEWS_SOURCE_OPS_MODE` | 全文 | 一致（含 404/409/201、去重 201） |
| `@Cron("*/30 * * * * *")` `news-source.scheduler.service.ts:266-299` | `newssourcescheduler/scheduler.go:129-148` | `API_GO_NEWS_SOURCE_SCHEDULER_MODE` | 重点 | 锁 key/TTL/续租一致（疑点被推翻，§4.4） |
| **`onModuleInit` → RSS seed TTL 一次性迁移** `:244-246,3471-3645` | **新增** `newssourcescheduler/rsseedttl.go`（挂 `scheduler.go:35-68`） | `API_GO_NEWS_SOURCE_SCHEDULER_MODE` | 全文 | **W5-01 已修**（原先完全缺失） |
| `newsnow-source-warm` / `newsnow-hottest-analysis` / `newsnow-recommended` / `newsnow-domestic-opinion-index` | 仍全在 Nest | — | 抽样 | 未迁，删 Nest 前须处理（§7） |
| `news-indicator.controller.ts`（3 条） | `newsindicator/handler.go:44-84` | `API_GO_NEWS_INDICATORS_MODE` | 全文 | 一致 |
| `news-indicator.resolver.ts`（2 query + refresh mutation） | `graphqlread/newsindicators/*`、`newsindicator/*` | 同上 + `API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE` | 重点（数学全文） | 数学逐段等价（§4.5）；W5-04 |
| `@Cron("0 */6 * * *")` `news-indicator-association.ingestion.service.ts:35-128` | `newsbackfilljobs/association_scheduler.go:17-233`（只读） | `API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE` | 全文 | 一致 |
| 13 条分类质量 + RSS 诊断/翻译指标路由 | `classificationrssops/handler.go:32-983` | `API_GO_CLASSIFICATION_RSS_OPS_MODE` | 重点 | 全部 `settings.manage`、`orgId` 完整、跨租户 404 与 Nest 相同 |
| `POST /api/admin/quality/classification/reports` + processor + `service.ts:873-978,1125-1193` | `classificationrssops/report_jobs.go`、`report_worker.go:354-456`、`qualityqueue/*` | `API_GO_CLASSIFICATION_REPORTS_MODE`、`..._QUALITY_WORKER_MODE` | 全文 | 一致；W5-03 |
| `classification-quality-seed-trigger.service.ts` + `service.ts:942-978` | `classificationreviewseed/{service,parser}.go` | `API_GO_CLASSIFICATION_REVIEW_SEED_MODE` | 全文 | 一致 |
| `@Interval` 5min `classification-quality-alert-scheduler.service.ts:40-140` | `classificationalert/{scheduler,concurrency}.go` | `API_GO_CLASSIFICATION_QUALITY_ALERT_MODE` | 全文 | 一致；W5-05 |
| 5 条 `GET /api/admin/quality/*` | `qualityoverview/*` | `API_GO_QUALITY_OVERVIEW_MODE` | 重点 | 一致 |
| BullMQ `classification_quality` 生产与消费 | `qualityqueue/*`（Lua 为 bullmq 5.x 逐字副本） | 见上 | 重点 | 并发公式、lock/stalled、`atm` 路径已核 |
| RSS 翻译 `situation-monitor-translation.service.ts:420-520`、`items-rss-translation.service.ts` | `rsstranslation/{deeplx,service}.go` | `API_GO_GRAPHQL_RSS_TRANSLATION_MODE` | 重点（DeepLX 全文） | 一致 |

### 2.5 条目入库、检索与搜索重建索引

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| `GET /api/items`（`items.controller.ts:18-25`） | `itemsreading/handler.go:184` → `itemslist.go`/`listtime.go`/`search.go` | `API_GO_ITEMS_READING_MODE` | 全文 | 一致；W2-02、W2-06 已修 |
| `GET /api/items/:id`（`:33-37`） | `itemsreading/handler.go:208` | 同上 | 全文 | 一致（跨组织/缺失 404 `Item not found`） |
| `POST /api/items`（`:27-31`） | `itemsingest/handler.go:34` → `service.go:62` | `API_GO_ITEMS_INGEST_MODE` | 重点 | 事务/Outbox/幂等一致；继承 W2-02 |
| GraphQL `items`（`items.resolver.ts:349-454`） | `graphqlread/itemsreading/list.go:36` → `itemsreading/itemslist.go:204` | `API_GO_GRAPHQL_ITEMS_LIST_MODE` | 重点 | 分页与游标一致；W2-01 已修 |
| GraphQL `item`/`itemFacets`/`rssSources`/`rssTranslationStatus`/`searchSuggestions`（`:460-575`） | `graphqlread/itemsreading/queries.go` + `itemsreading/{facets,rsssources,translation,suggestions}.go` | `API_GO_ITEMS_READING_MODE` | 重点 | 一致；W2-03 已修 |
| GraphQL `createItem`/`updateItem`/`createItemFromCrawlResult`/`ingestCrawlTaskResultsToItems`/`updateCrawlTaskIngestToItems` | `graphqlread/itemsingest/register.go:31-35`、`resolver.go:71-218` | `API_GO_ITEMS_INGEST_MODE` | 重点 | 权限 any/all 形状一致 |
| `search-admin.controller.ts` 全文（reindex 两条） | `searchreindex/handler.go:50,75` → `service.go` | `API_GO_SEARCH_REINDEX_MODE` | 全文 | 索引名/别名/文档 id 一致；W2-04 已修 |
| `POST /api/search-telemetry`、`GET /api/admin/search-telemetry/summary` | `crawlreadtelemetry/service_telemetry.go:83,120` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | 全文 | 键/字段/日桶/Lua 一致；W2-10 |
| Cron `retryPendingRawItemOutbox`（`raw-item-outbox.service.ts:152-183`） | `itemsingest/scheduler.go:106` | `API_GO_RAW_ITEM_OUTBOX_MODE` | 全文 | 锁键/TTL/续租一致 |
| ES 写/索引管理（`items-elasticsearch.service.ts:487-526`） | `searchreindex/elasticsearch.go:184` + `startupreconcile` | `API_GO_STARTUP_RECONCILE_MODE` | 全文 | 映射逐字段一致；W2-09 |

### 2.6 公开门户、个人化与快照摄取

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| `GET /api/public-portal/home`（`public-portal.controller.ts:16`） | `publicportal/handler.go:44` + `service.go:104` | `API_GO_PUBLIC_PORTAL_MODE` | 全文 | 一致；org 只取自 `SystemSetting` |
| `GET /api/public-portal/channels/:topic`（`:23`） | `handler.go:54` + `service.go:137` | 同上 | 全文 | 一致（slug 规范化逐环节比对） |
| `GET /api/public-portal/stories/id/:id`（`:34`） | `handler.go:89` + `story.go:43` | 同上 | 全文 | 一致；写路径 **W6-01 已修** |
| `GET /api/public-portal/stories/slug/:slug`（`:45`） | `handler.go:93` + `story.go:43` | 同上 | 全文 | 同上 |
| 7 条 `/api/user-content-subscriptions*` | `contentsubscriptions/handler.go:34-215` | `API_GO_CONTENT_SUBSCRIPTIONS_MODE` | 重点 | 全部 SQL 同时按 `orgId`+`userId` |
| 3 条 `/api/user-news-behavior*` | `newsbehavior/handler.go:26-108` | `API_GO_USER_NEWS_BEHAVIOR_MODE` | 重点 | 一致（去重 key/TTL、201 契约） |
| 5 条 `/api/user-digest*` | `userdigest/handler.go:47` | `API_GO_USER_DIGEST_MODE` | 重点 | DTO 顺序/文案、`no-store`、200 一致 |
| `@Cron(EVERY_MINUTE)` 摘要投递 | `userdigest/delivery_scheduler.go:97-381` | `API_GO_USER_DIGEST_DELIVERY_MODE` | 全文 | **单发/幂等成立**，见 §3.6 |
| `@Cron("0 */15 * * * *")` GDELT | `gdeltsnapshot/scheduler.go:81` + `service.go:151` | `API_GO_GDELT_SNAPSHOT_MODE` / `..._REFRESH_MODE` | 全文/重点 | 同一物理租约键 |
| `@Cron(EVERY_HOUR)` 情感快照 | `sentimentsnapshot/scheduler.go:111-238` | `API_GO_SENTIMENT_SNAPSHOT_MODE` | 全文/重点 | tick gate 55min、org 锁一致 |
| `@Cron(EVERY_5_MINUTES)` KG ingestion | `kgingestion/scheduler.go:124-387` | `API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE` | 全文/重点 | gate 285s、org 锁一致 |
| 4 个 KG 冲击/共现 GraphQL root | `graphqlread/kgimpact/register.go:39-58` | `API_GO_GRAPHQL_KG_IMPACT_MODE` | 重点 | orgId 来自 `call.Identity`；W6-02/03/04 |

## 3. 发现列表

**统计：P0 = 0，P1 = 1，P2 = 8，P3 = 31。已修复 13 项（含 1 项 P1、8 项 P2、4 项 P3），只记录 27 项。**

### 3.1 P1

#### W1-01（P1，已修 `dc4fa9c3`）stalled 作业的延迟失败被当作正常作业重跑

- **Nest/BullMQ 证据**：`scripts/moveStalledJobsToWait-8.lua:153-157` 在 `stalledCount > maxStalledCount` 时写入 `defa="job stalled more than allowable limit"` 并把作业放回 wait，由下一个 worker 直接失败（`moveToFinished-14.lua:757-759` 失败时 `HDEL defa`）。
- **Go 证据（修复前）**：`itempipeline/worker.go:400-410` 无条件调用 `w.opts.Processor`；`DecodeFailure` 只在**事后**（`worker.go:385-398`）读 `DeferredFailure`，processor 成功时直接走 `finishCompleted`。同仓同语义的兄弟实现 `qualityqueue/worker.go:198-205` 在调用 handler 前已短路，本包是唯一例外。
- **影响**：反复杀死 worker 的"毒丸"作业被无限重跑 —— 每次重跑重复 LLM 调用、向量 upsert 与 outbox 副作用；`itemPipelineDlq` 与 NewsSource 失败计数永远收不到这次终态失败。
- **修复**：新增 `UnrecoverableError`（`ClassifyQueueError` 早有 `case "UnrecoverableError"` 分类分支，见 `errors.go:324-329`，但此前无人产生该类型），并新增 `Job.DeferredFailureError()`；`process()` 在调用 processor 前短路。
- **测试**：`TestDeferredFailureIsTerminalWithoutRunningTheProcessor`（覆盖"attempts 仍剩余但必须终态"与"健康作业不得误判"两个断言）。

### 3.2 P2

#### W2-01（P2，已修 `4c8101ff`）`searchHighlights` 列表顺序不确定

- **Nest**：`items.resolver.ts:914-919` 用 `Object.entries(meta.searchHighlights)`，顺序 = ES `highlight` 成员顺序（`items-elasticsearch.service.ts:117-134`）。
- **Go（修复前）**：`itemsreading/elasticsearch.go:412-445` 解成 `map[string][]string`，`graphqlread/itemsreading/list.go:152-163` 再 range 该 map → 每次请求顺序不同。
- **影响**：同一命中两次调用（甚至同一 operation 内两页）返回顺序随机，违反列表有序语义。
- **修复**：`extractHighlights` 用 `json.Decoder` 保序返回 `[]ItemSearchHighlight`，GraphQL 层 1:1 投影。
- **测试**：`TestExtractHighlightsPreservesResponseOrder`、`TestExtractHighlightsSkipsUnusableFields`。

#### W2-02（P2，已修 `4c8101ff`）Bearer scheme 大小写敏感导致 401

- **Nest**：`auth/strategies/jwt.strategy.ts:17` 用 passport-jwt `ExtractJwt.fromAuthHeaderAsBearerToken()`，其正则 `/^Bearer\s+(.+)$/i` 大小写不敏感。
- **Go（修复前）**：`itemsreading/handler.go:159-165` 用 `strings.HasPrefix(header,"Bearer ")`；该函数经 `ExtractBearerToken` 导出给 `itemsingest/handler.go:50` 使用，故 `GET /api/items`、`GET /api/items/:id`、`POST /api/items` 三条入口同时受影响。同仓其余 20 余个 handler 都是 `EqualFold`。
- **影响**：`bearer xxx` 在 Go 侧 401 而 Nest 200（RFC 7235 规定 scheme 大小写不敏感，部分 SDK/反代发小写）。方向更严不是越权，但是功能错误。
- **测试**：`TestExtractBearerTokenAcceptsCaseInsensitiveScheme`。

#### W3-01（P2，已修 `20396409`）组织活跃列表缓存把未命中当读失败

- **Nest**：`modules/org/active-org-registry.service.ts:27-46` 走 `cache.wrap`，未命中即回填，只有真实异常才回落 DB。
- **Go（修复前）**：`newseventsingest/scheduler.go:378-394` 把 `Get` 的 `redis.Nil` 原样返回，`scheduler.go:323-327` 因此进入"cache read failed → 直接查 MySQL"，`scheduler.go:332-373` 的回填锁与等待预算成为不可达代码。
- **影响**：每 5 分钟一次多余 MySQL 查询 + 一条并未发生的 warning；`org:active:list:v1` 的 15 秒缓存对该调度器永久旁路。不跨租户、不丢数据。
- **修复**：抽出 `decodeActiveOrgCache` 统一分类；同仓 `newsnowhottest/cache.go:46-55`、`newsnowclusteringops/store_resolve.go:225-233` 已是正确写法。
- **测试**：`TestDecodeActiveOrgCacheClassifiesAMissAsAMiss` 等 4 个。

#### W3-02（P2，已修 `9802c1ef`）并发分配败者提交空事件并返回空事件 id

> **Nest 既有问题，Go 已修复，行为变化。**

- **Nest 证据**：`news-events.service.ts:703-719`、`:781-786`、`:918-937` —— 捕获 P2002 后 `return`，Prisma 交互事务随即 commit，本事务内已 `createEvent` 的 `NewsEvent` 落库；`findUnique` 走本事务快照，看不到胜者已提交行，于是 `winner?.eventId ?? eventId` 回落到自己的空事件 id。
- **Go 证据（修复前）**：`newseventsingest/assign.go:373-393`、`newsnowclusteringops/clusteringfailure.go:409-427`、`llm_backfill_assign.go:91-109` 同构；原测试注释已承认该行为（`newseventsingest/integration_test.go:1051-1055`）。
- **影响**：①控制台 `newsEvents` 出现 0 items 的重复空事件（同标题、`status=active`，还会被时间线/统计计入）；②败者把空事件 id 当 anchor 传给 bertopic 成员分配（`bertopic.go:185-193`），虽被 `findActiveEvent` 兜住转全 picker，但同簇成员会被打散。
- **修复**：冲突分支先 `Rollback`（新建空事件永不落库），再用**事务外**读取解析胜者（本事务快照早于胜者提交）；冲突行已消失时返回原始冲突错误，让调用方下一 tick 重试而不是返回不存在的 id。
- **行为变化**：败者不再返回自己的空事件 id，改为返回胜者 id；极罕见"冲突行已消失"时返回原始冲突错误而非悬空 id。
- **测试**：`TestIngestionConcurrentAssignOnlyOneWins`（新增"`NewsEvent` 行数 == 1"与"败者返回胜者 id"两条断言）。**注意：该集成断言需在真实 MySQL 上执行**，本机未运行。

#### W4-01（P2，已修 `12ec9118`）dedupe judge 越界响应被 clamp 成合法判定 → 误标 Duplicate

- **Nest**：`news-dedupe-llm.ts:8-12` `similarity: z.number().min(0).max(1)`、`rationale: z.string().max(280).optional().nullable()`；`news-pipeline-dedupe.service.ts:404-411` `safeParse` 失败即 `return null`；只有成功后才在 `:413-416` clamp。
- **Go（修复前）**：`dedupe_llm.go:104-114` 对任意有限 similarity 直接 clamp 并 `ok=true`；rationale 类型/长度违规静默丢弃但整体仍 ok。调用方 `dedupe.go:590-596` 随即 `isDuplicate = judge.IsDuplicate || similarity >= threshold` → `dedupe.go:781-792` 写 `ItemMeta.status='duplicate'`。
- **影响**：模型返回 `{"similarity":1.4,"is_duplicate":true}` 时 Nest 忽略该 verdict，Go 永久把条目标成 duplicate（`ItemStatus.Duplicate` 会把条目从列表隐藏，只有 persist 失败才回滚）。
- **对抗复核**：`response_format` 只是请求侧提示，`litellmcompat/client.go:544-580` 对 content 不做 schema 校验，上游仍可能越界；下游无第二道范围校验。
- **测试**：`TestParseNewsDedupeJudgeResponse`（含 `similarity above one` / `below zero` / `malformed rationale` / `over-long rationale` 子用例）、`TestDedupeEvaluateLlmJudgeDuplicateVerdicts`（新增 4 子用例）。

#### W4-04（P2 / A10 规则，已修 `39be8851`）设置缓存文档用 `map[string]any` 承载业务数据

- **修复前**：`settings.go:743-778`、`:774-805` 各自返回嵌套 `map[string]any`，写入与 NestJS 共用的 `newsExtraction:settings:*` / `newsDedupe:settings:*`，再 `json.Marshal`。违反"缓存/数据库 JSON 必须具名强类型"。
- **修复**：`writeCachedSettings` 改收 `settingsCacheDocument` 接口；两份文档改具名结构 + 可空成员用 `*string`；删除 `optionalStringValue(any)`。JSON 成员名与取值不变，跨端缓存可互读。
- **说明**：`map` 序列化按 key 字典序、struct 按字段声明序，故缓存里的 **JSON 键顺序**会变；但两侧都以 `JSON.parse` / `json.Unmarshal` 读入，键序无契约意义。
- **测试**：`TestSettingsCacheDocumentRoundTrip`、`TestSettingsCacheDocumentWireShape`（锁定成员集合与 null 语义）。

#### W5-01（P2，已修 `44cc529a`）RSS seed 缓存 TTL 一次性迁移在 Go 侧完全缺失

> 本项的初判由 Lead 在派发前独立复核（Nest 注释 `news-source.scheduler.service.ts:272-273` 明写 "The onModuleInit TTL migration intentionally stays in Nest and is idempotent"），由 W5 窗口完成确认与修复。

- **Nest 证据**：`news-source.scheduler.service.ts:244-246`（`onModuleInit`，**不受调度开关与 `SCHEDULE_ENABLED` 影响**）→ `:3471-3520`（marker → `withLock(120s)` → 扫描 → `delByPrefix("news-source:rss:")` → 写 365 天 marker）→ `:3526-3553`（全表 `findMany` + 逐行条件更新，3 次重试）→ `:3598-3645`（只删 `mode=rss` 且 `round(cacheTtlSeconds)===600`）→ `:87-93`（常量）。
- **Go 证据（修复前）**：`newssourcescheduler/scheduler.go:35-48` 的 `Start` 直接进 loop，包内 grep `migration:` 零命中；而 `seedconfig.go:93-101,221-232` 仍把 600 当合法 `source_override`（`model.go:76` 模式默认 60s，合法区间 10..3600）。
- **影响**：删 Nest 后，历史遗留 `seed.cacheTtlSeconds=600` 的 RSS 源永久停留在 10 分钟发现缓存（应为 60s），`cacheTtlPolicy` 恒为 `source_override`，`news-source:rss:` 发现缓存不再被失效 —— 功能结果错误且只能手工 SQL 修。
- **修复**：新增 `rsseedttl.go`，挂在 `Scheduler.Start`（Nest 也是启动期执行，不依赖 tick）；同一组 Redis 键（`migration:news-source:rss-seed-cache-ttl-600` 锁 120s、`:done` 365 天）、同 3 次乐观重试、同"仅 `updatedCount>0` 才 SCAN 清前缀"条件，与仍在运行的 Nest 互相排斥。迁移不阻塞就绪，`Close` 可取消。MySQL 侧补 `ListSourceConfigs` / `LoadSourceConfig` / `ReplaceSourceConfigIfUnchanged`，用 `CAST(? AS JSON)` 保持结构比较。
- **测试**：`TestRemoveLegacyRSSSeedCacheTTLOverride`、`...RejectsShapes`、`TestMigrateLegacyRSSSeedCacheTTLWritesMarkerAndClearsCache`、`...KeepsCacheWhenNothingChanged`、`...IsIdempotent`、`...SkipsWhenLockHeld`、`...RetriesLostRace`、`...GivesUpAfterRetries`、`...FailureIsNotFatal`。

#### W6-01（P2，已修 `67761c38`）公开门户故事简报对整个 metadata 做读-改-写

- **Go（修复前）**：`publicportal/story.go:214-229` 组装整份 document → `mergeBriefMetadata` → `store.go` 整列 `UPDATE NewsEvent SET metadata = ?`。
- **Nest 对照**：`news-event-brief.service.ts:289-303` 同样是 `mergeMetadata` 后整列写（`public-portal.service.ts:207` 调用）；但同仓 Go 已有正确写法 `graphqlread/newsevents/brief.go:456-472`（只 `JSON_SET('$.briefV1')`）。
- **影响**：**无需登录的 GET** 触发的写路径成为整列读-改-写所有者，读取到写入之间其他 metadata 叶子（timeline、来源策略同步）的写入被覆盖，数据丢失不可恢复。
- **修复**：改为 `SaveBriefV1` 只 `JSON_SET` `$.briefV1`，`CASE WHEN JSON_TYPE(metadata)='OBJECT'` 处理 null/非对象列，`WHERE id = ? AND orgId = ?`；模型调用在事务外不持锁。`briefCacheDocument` / `briefCacheSource` 改具名强类型。
- **测试**：`TestStoryBriefColdPathWritesCacheAndFailureIsNotSuccess`（断言只含 brief 叶子、带 orgId+eventId、不携带 sibling 键）。
- **残留**：Nest 侧仍整列写，混合版本期间 brief 冷路径的整列覆盖仍可能由 Nest 发生；切流完成后消除。

### 3.3 P3（已修 4 项）

| 编号 | 标题 | 证据 | 修复提交 | 测试 |
|---|---|---|---|---|
| W2-03 | `localeCompare` 用"小写+字节序"近似，与 ICU root 不等价（`"a".localeCompare("A")` = −1，旧实现 +1） | Nest `items-search.helpers.ts:302` 等多处；Go `itemsreading/query.go:496-510` | `4c8101ff`（改 `collate.New(language.Und)` + mutex 单例，与 `newsnowhottest/utils.go:100`、`newssourcescheduler/urls.go:62`、`newspipeline/persist.go:873` 一致） | `TestLocaleCompareMatchesICURoot` |
| W2-05 | 读模型 `searchTerms` 口径不同：Nest 先 slice 到 240 再 dedupe；字母表也比 Nest 正则宽 | Nest `item-read-model.utils.ts:425-435`；Go `readmodel.go:610-632,656-675` | `4c8101ff` | `TestBuildSearchTermsSlicesBeforeDeduping`、`TestBuildSearchTermsUsesTheNestJSAlphabet` |
| W2-06 | `GET /api/items` 重复参数报错张冠李戴（`search=a&search=b` → "search must be a number string"） | Nest `dto/list-items.dto.ts:20-24` + `main.ts:69-75`；Go `itemsreading/handler.go:228-231` | `4c8101ff` | `TestParseListQueryReportsPerPropertyMessages` |
| W3-04 | R1 恢复规则 GoDoc「at or before」与实现 `Before(olderThan)` 不符 | `newsnowclusteringops/llm_backfill.go:200-202` vs `:264-271` | `9802c1ef` | —（纯注释） |

另：W2-04（重建索引 error 文本逐字对齐，含 UTF-16 截断与 `\s` 折叠）虽按 P3 记录于原始分派，但属响应契约差异且局部可修，已修入 `9d31210d`，测试 `TestBulkFailureReasonMatchesNestJS`、`TestBulkErrorTypeMatchesNestJS`、`TestBulkFailureErrorUsesTheNestJSWording`。

W6 的摘要投递测试补入 `994dc9e3`：`TestRunTickSecondInstanceSkipsScanAndSend`、`TestRunTickSkipsOrgLeasedByAnotherInstance`。

### 3.4 P3（只记录 27 项）

| 编号 | 标题 | 两侧证据 | 不修理由 |
|---|---|---|---|
| W1-02 | 永久失败的 DLQ/TaskLog `error` 信封形状与 Nest 不同（`name` = `QueuePermanentError` vs `UnrecoverableError`，`reason` 少 `unrecoverable:` 前缀） | Nest `queue.processor.ts:223-232` + `queue.error-handling.ts:247-255`；Go `processor.go:204`、`errors.go:318-335` | `itemPipelineDlq` 当前无消费者，仅 Bull Board 人看；改成合成 `UnrecoverableError` 会丢掉真实错误类名 |
| W1-03 | 完成作业 `returnvalue` 多一个 `_id` 成员 | Nest `news-pipeline-stages.service.ts:207-211`；Go `newspipeline/outbox.go:91-103` | 纯增量字段，Web 端只缓存 `lastEvent`，无消费者依赖键集 |
| W1-04 | 日期解析窄于 `@modular/utils.parseDateTime` | Nest `packages/utils/src/date.ts:354-383`；Go `processeditemoutbox/payload.go:846-866`（仅 6 种 layout） | 完整移植 `parseDateTime` 属跨域改动；主链载荷已被 ISO 归一 |
| W1-05 | `content_type` 归一化多一个别名 `column` + 空白字符集差异 | Go `payload.go:899`、`:923-939`；Nest `news-content-type.ts:8-51` | 主链先经 `withResolvedContentType` 归一为枚举，实际不可达 |
| W1-06 | outbox `duplicateOf` 不接受 Mongoose 合法的 12 字节 ObjectId | Nest `news-pipeline-internal.ts:318-325`；Go `service.go:731-740` | 主链生成的都是 24 hex；同仓 `itempipeline/objectid.go:39-53` 已有兼容实现可复用 |
| W2-07 | ES `query_string` 的 Lucene 语法注入（**两侧一致，非 DSL 注入**） | Nest `items-elasticsearch.service.ts:312-361`；Go `itemsreading/elasticsearch.go:146-198,305-339` | 两侧都把查询体当参数序列化，租户边界由外层 `bool.filter.term.orgId` 强制；加转义会改变检索语义。建议后续在 ES 侧统一加 `timeout`/`max_expansions` |
| W2-08 | JS `\s` 与 UTF-16 长度在检索分词处的细微差异 | Nest `items-search.helpers.ts:325-332`；Go `itemsreading/query.go:408-425`、`suggestions.go:328` | 仅影响含 BOM/NEL 或星平面字符的极端检索词；改分词基线风险大 |
| W2-09 | ES 读路径不再 `ensureIndex`，go 模式下缺 `recordIntegrationEvent` | Nest `items-elasticsearch.service.ts:317,362-380`；Go `itemsreading/elasticsearch.go` | 读路径不写集群是更合理设计；指标需在 `internal/metrics` 接线（跨领域） |
| W2-10 | 检索遥测 3 处边界：Redis 故障 400(Nest)/500(Go)、`queryLength` 非整数文案、未知字段拒绝 | Nest `search-telemetry-admin.controller.ts:20-31`；Go `crawlreadtelemetry/errors.go:63-65` | 都是 400/500 边界；Go 的 500 更正确，不仿制 Nest 的错 |
| W2-11 | raw payload `metadata` 写入 Mongo 时键序随机 | Go `itemsingest/mongo.go:87-118` 遍历 map 构 `bson.D` | JSON 键序无语义，Mongo 读回稳定；修需改成 token 级保序解码 |
| W2-12 | `ObjectId.isValid` 接受 12 字节字符串（Go 只接受 24 hex） | Nest `items.service.ts:221`；Go `itemsreading/mysql.go:217-227` | **Go 有意收紧，方向安全**；应用自身写入的引用都是 24 hex，不可达 |
| W3-03 | LLM prompt 里 `score.toFixed(3)` 用 `strconv.FormatFloat` 近似 | Nest `news-event-clustering-recovery.service.ts:535`；Go `llm_backfill.go:759-761` | 只影响喂给模型的文本；改动会触碰 prompt 基线 |
| W3-05 | 同一 `processedItemId` 多行 `NewsEventItem` 时取值顺序语义不同 | Nest `news-events.service.ts:1023-1028`（无 ORDER BY）；Go `llm_backfill_store.go:418-419` 加了 `ORDER BY id ASC` | 只在数据违反唯一性假设时有差异；Go 侧更确定 |
| W3-06 | `vector-backfill` 兜底时间戳取抢占时刻而非转换时刻 | Nest `news-event-clustering-failure.service.ts:577-578`；Go `clusteringfailure.go:266-275` | 只在失败项三个时间字段全空时触发，概率极低 |
| W4-02 | `clean.go` 与 `gates.go` 各持一份 markdown 质量 helper，`clean.go` 那份用 Go 原生 trim/`Fields`/字节长度，与 JS 语义不等价 | `gates.go:239-561` 用 `pipeline*` 系列；`clean.go:417-424,445-523,732-856` 用 `strings.TrimSpace`/`Fields`/`len()` | 建议后续让 `clean.go` 委托 `gates.go`（同包零导出），一次消除两份实现；本次未动以免扩大面 |
| W4-03 | clean prompt 的 `Metadata:` 块对缺失 `sourceName` 写 `null`，Nest 的 `JSON.stringify` 会省键 | Nest `news-pipeline-clean.service.ts:912-917` + `news-prompt.builder.ts:94`；Go `clean.go:1012-1016` | 仅影响 prompt 文本，不改分支；`contentOrderedJSON.setRaw` 已支持 undefined 语义 |
| W4-05 | itemPipeline 作业 returnvalue 多 `_id`（与 W1-03 同一现象，两窗口独立复现） | 同 W1-03 | 同 W1-03 |
| W4-06 | persist 事务内 3 条语句 Nest 缺 `orgId` 条件，Go 已补（**Nest 既有问题，Go 已修复**） | Nest `news-pipeline-outbox.service.ts:171-194,407-421`；Go `persist.go:185-257` | 上游 id 本身已按 org 过滤，实际不可跨租户触发；Go 更严格，无需回退 |
| W5-02 | 新闻源写 DTO 数值字段不接受 JSON 数字字符串/整值浮点，越界文案不分上下界 | Nest `dto/news-source.dto.ts:88-100` + `main.ts:69-74`（`transform:true`）；Go `newssources/validate.go:556-565,184-199` | 前端只发数字，线上未观察到影响；修需复刻 class-validator 的 `@Type` 语义 |
| W5-03 | 报表结果写入非幂等：BullMQ 重试必然撞 `jobId` 唯一索引 | Go `report_worker.go:430-445`（故意返回错误走 attempts）；Nest `classification-quality.service.ts:1148-1193`（catch 内吞错，不重试）；索引 `packages/mongo/src/models/classification-report-result.ts:31` | 触发窗口窄（Mongo 抖动）；建议后续改 `jobId` upsert 或插入前复用既有 `_id` |
| W5-04 | `newsindicator` 相关系数求和顺序不确定（Go 遍历 map） | Go `newsindicator/math.go:238-262`；Nest `news-indicator-math.ts:213`（Map 插入序，来自无 ORDER BY 的查询） | 两侧都不确定（Nest 查询也无 ORDER BY），Go 只是换了一种不确定 |
| W5-05 | `strictOptionalConcurrency` 的 `Number()` 语义只覆盖十进制 | Go `classificationalert/concurrency.go:190-233` | 正常写入路径由 DTO 校验为 1..16，仅手写库可达；fail-closed 方向 |
| W6-02 | `toFixed` 与 JS 在半值处舍入不同（`FormatFloat` ties→even vs JS ties→larger） | Go `graphqlread/kgimpact/util.go:43-45`；Nest `entity-impact-graph.service.ts:780-781` | 仅影响 Redis 缓存键 `:conf=`/`:corr=` 在精确半值处，值本身正确 |
| W6-03 | `localeCompare` 用 `x/text` collator 近似 V8 `Intl.Collator` | Go `kgimpact/util.go:17-33`；Nest `knowledge-graph-impact.service.ts:469` | CLDR 版本差异无法完全消除；只影响同分候选顺序 |
| W6-04 | A10：kgimpact 内部业务数据仍用 `any`/`map[string]any` | `kgimpact/impact.go:78`、`models.go:12,22`、`entityimpact.go:55` | SDL 侧是 `JSON` 标量属协议边界；具名化要覆盖 3 个 analyze 分支 + 缓存反序列化，超出本窗口性价比 |
| W6-05 | 公开故事详情时间线窗口在读设置失败时行为不同（Go 回退 30 天，Nest 不设窗口） | Go `publicportal/store.go:512-516`；Nest `news-events.service.ts:403-417` | 降级路径；改成"不限窗口"需把 `TimelineWindowDays` 扩成可空语义，收益与风险不对等 |
| W6-06 | 摘要投递遇"认领前"异常时不落 `failed` 状态 | Go `delivery_exec.go:60-67`；Nest `user-digest-delivery.service.ts:221-235` | 仅 DB 错误/库内非法时区；两侧都会每 tick 重试，Go 只是 `lastError` 不更新 |

## 4. 被推翻的疑点

记录这些是为了避免后续重复审查。每项都已按对抗式复核给出不成立的依据。

### 4.1 条目流水线（W1 窗口）

1. **"去重时同一 itemMetaId 的重放会与自身匹配" — 不成立。** 两侧都有三重守卫：内容哈希分支先判"是否自己的历史 run"（Nest `news-pipeline-dedupe.service.ts:61-80` ↔ Go `newspipeline/dedupe.go:257-274,754-762`）；三条候选查询（向量命中校验 / 本地余弦 / LLM 候选）都排除 `itemMetaId`（Nest `:188-199,:576-596,:610-616` ↔ Go `dedupe.go:1181-1223`）。**Lead 已独立复核**：Go 的 `dedupeLLMCandidateFilter` 无条件加 `$ne`、`dedupeVectorAllowedFilter`/`dedupeSemanticCandidateFilter` 按 `excludeItemMetaID != ""` 条件添加 —— 与 Nest 的"LLM 无条件 / 另两条三元条件"逐点对应。
2. **"#138 的共享向量不可用窗口在 Go 侧不等价" — 不成立。** Go 每进程只有一个 `vectorclient.Health`，同时注入 pipeline 立即投递与 5 分钟扫描（`cmd/api/main.go:865,3171,3216`），等价于 Nest 单例 `VectorClientService.unavailableUntilMs`（`vector-client.service.ts:42,244-271`）；`Client.Upsert`（`client.go:143-186`）逐分支复刻 `upsertOrThrow`。
3. **"重复入队分支行为不一致" — 无法证实，不作为发现。** Nest 的 `catch("already exists")` 早退（`queue.service.ts:112-133`）在 BullMQ 5.63.2 是否可达无法静态确认 —— vendored Lua 的 `handleDuplicatedJob`（`pipelineenqueue/scripts.go:463,539`）返回既有 jobId 而非抛错。若不可达，两侧都继续做 pending upsert 与 org 计数，行为一致。
4. **"LLM 超时不等于 180s" — 不成立。** 完成超时两侧都是 `max(getCompletionTimeoutMs(), 180s)`（Nest `news-pipeline-clean.service.ts:892-895` ↔ Go `clean.go:995-998`），重试次数都是 `max(1, maxRetries ?? cfg.maxRetries)`。
5. **"立即投递与按分钟重放会双投" — 不成立。** Go 立即投递走同一 CAS claim（`deliver_export.go:14-20 → service.go:185-190 → store.go:80-120`）；go 模式下 Nest 的 5 分钟 cron 早退（`news-pipeline.service.ts:191-200`），Go 扫描器带 `lock:cron:processed-item-outbox` 租约。任意开关组合下同一行只会被一个执行者 claim。
6. **"PipelineJob 状态机终态判定不一致" — 不成立。** `running(completedAt=NULL)` / `completed(completedAt,error=NULL)` / 非终态 `delayed` / 终态 `failed(attempts)` 逐字段一致（Nest `queue.processor.ts:459-568,747-846` ↔ Go `state.go:167-279`）。
7. **"Source 熔断计数有并发问题" — 反而是 Go 更强。** Go 在事务内 `SELECT … FOR UPDATE` 后自增并只在跨阈值那次发通知（`state.go:316-414`），Nest 是事务内普通 `findUnique` + update（`queue.processor.ts:594-681`）。
8. **"多实例 / stalled / 锁续期 / attemptsMade 不一致" — 除 W1-01 外不成立。** 续期周期 `lockDuration/2`、`extendLock` 参数顺序、stalled 检查 30s、`maxStalledCount=1`、`stalled-check` PX 去重、`retryJob/moveToDelayed/moveToFinished` 的 KEYS/ARGV 顺序逐条比对无偏差。
9. **"stale processing 恢复窗口不一致" — 不成立。** 5 分钟窗口 + `(pending|failed & availableAt<=now) | (processing & lockedAt<cutoff)` 三条 claim 条件完全一致（Nest `news-pipeline-outbox.service.ts:63,873-886` ↔ Go `store.go:20,89-98`）。
10. **"幂等步骤重放不安全" — 不成立。** ProcessedItem 写入是幂等 upsert（Nest `:1074-1106` ↔ Go `service.go:283-368`），outbox 删除是最后一步，`markFailed/markDead` 的 `attempts`/`message.slice(0,2000)`（UTF-16）与 dead 补偿都对齐。
11. **"开关门控两侧读的不是同一个变量" — 不成立。** Go `strings.TrimSpace` + 非法值启动失败（`config.go:5362-5369`），Nest 经 env 归一化后再比较 `=== "go"`，对 `" go "` 判定一致。

### 4.2 条目入库与检索（W2 窗口）

1. **"ES 索引名不一致" — 不成立。** 读走 alias（`ELASTICSEARCH_ITEMS_ALIAS`，默认 `items-current`），写/重建走 index（默认 `items-v1`），文档 id 均为 `<orgId>:<itemMetaId>`，两侧同一组 env、同一份 mappings。
2. **"重建索引的锁会泄漏或被跨组织触发" — 不成立。** 键 `lock:search:reindex:org:<orgId>`、`SET NX PX 5min`、token 比对续租/释放，`runReindex` 的 `defer` 在**所有**返回路径释放（比 Nest 更严：Nest 在 `markRunning` 抛错时只能等 TTL）；触发者只能是本组织 `settings.manage`。
3. **"用户输入造成 ES DSL 注入或跨租户越读" — 不成立。** 见 W2-07：查询体是参数化序列化，租户边界由外层 `bool.filter` 强制，`query_string` 无法覆盖 filter。
4. **"存在无界查询" — 不成立。** 每条召回都有 `MaxSearchMatches`(5000) 或 `normalizeSearchLimit`(≤1000) 上限；`ProcessedArticleSourceFallback` 无上限但那正是 Nest `findMany` 的语义。
5. **"按 itemMetaId 的 Mongo 查询漏 orgId" — 不成立。** `FindReadModels*`/`FindProcessedByKeys`/`FindLatestProcessed`/`ProcessedTextIDs`/`ReadModelTextIDs`/`VectorCandidates`/`SourceCounts`/`SemanticFieldsForItems` 全部带 `orgId`；`rawitems` 无 orgId 字段，靠"org 内 ItemMeta + `_id=mongoRef` 且 `itemMetaId=meta.id`"双绑定隔离。
6. **"CSV 批量分页上限被误改成 50" — 不成立。** cap 由 `maxPageSize` 传入 `min(max(maxPageSize,1),50000)`，交互路径才用 50。
7. **"raw_item 与 outbox 不原子/不幂等" — 不成立。** ItemMeta + `MongoOutbox(pending)` 同事务（`service.go:126-160`、`store.go:73-114`），raw 写入 11000 且同 `_id` 已存在视为幂等，投递按三态 CAS 认领并 `attempts+1`，dead 时仅当 `mongoRef` 仍等于该 rawId 才把 ItemMeta 置 failed —— 与 Nest 逐条对应。
8. **"采集批入库 cursor 语义与 Prisma 不一致" — 不成立。** Prisma `cursor:{id}+skip:1` 在 `orderBy fetchedAt desc,id desc` 下就是"按该行位置之后取"，Go 用 `(fetchedAt,id)` 复合比较等价。
9. **"遥测计数口径不一致" — 不成立。** 键 `search-telemetry:<orgId>:<UTC 日>`、TTL 30 天、字段名/分桶/`archive_load_more_click` 才记 vertical、`from<=to`、≤31 天、错误文案全部逐字一致。

### 4.3 新闻事件聚类（W3 窗口）

1. **"vector-backfill 写回的 `resolvedEventIds` 未排序" — 不成立。** `store_clustering.go:248-252` 在写库前自行复制并排序。
2. **"bertopic 增量批次中途失败会重复分配已分配文章" — 不成立。** 每次分配都是独立事务提交（`assign.go:323-415`），幂等键 `(orgId, processedArticleId)` 唯一键 + 事务内复检（`:341-349`）+ 1062 兜底；游标只在整批成功后推进确实会重放整批，但重放只命中前置幂等检查（`:117-123`），代价是重复模型调用 —— 与 Nest 完全相同。
3. **"`lookbackDays<1` 钳位导致匹配窗不同" — 不成立。** Nest `news-events-settings.service.ts:357-361` 已 `clampInt(…, 1, 180)`，两侧值域相同，Go 的钳位是死代码。
4. **"时间线时间窗口时区/桶聚合可能偏移" — 不成立。** 两侧都用 UTC 日桶（Nest `toUtcDayStart` 用 `Date.UTC` `:1440-1446` ↔ Go `format.go:21-26` 用 `time.UTC` 取 Y/M/D）；窗口与 `windowDays = max(backfillDays, lookbackDays)` 两侧一致。
5. **"`NewsEvent` 窗口的 `SELECT/UPDATE` 未按 orgId 过滤 = 跨租户写" — 不成立。** `eventID` 只来自已按 orgId 过滤的读取；`newseventsingest` 的导出分配方法全仓无包外调用者；Nest 同构。属"与 Nest 一致"而非缺口。
6. **"生产/worker 的 attempts、removeOnComplete、失败保留策略不一致" — 不成立。** Nest 队列级 `removeOnFail = {age:604800,count:10000}` + job 级 `{jobId, removeOnComplete:true, attempts:1}`；Go `clusteringrecoveryqueue/protocol.go:240-249` 完全一致；worker 默认值即 BullMQ 5 默认。
7. **"聚类恢复队列清理只在 Nest，删 Nest 后 Redis 无限增长" — 不成立。** `internal/bullmqcleanup/inventory.go:68,91` 已把 `news_event_clustering_recovery` 列入清理盘点。
8. **"localeCompare 未对齐" — 不成立。** `newseventstimeline/collate.go:10-25` 用 `x/text/collate`（root ICU）；残余 CLDR 版本差异对极端非 ASCII 值可能不同（已降为 P3 并注释）。
9. **"`parseOptionalPositiveInt` 用 Atoi 会拒绝 `24abc`/`0x10`" — 不成立。** `newsnowclusteringops/service.go:203-236` 显式实现 `Number.parseInt` 前缀语义（`"24abc"→24`、`"0x10"→0`、`" 12 "→12`），错误文案与 Nest 逐字一致。
10. **"jsRound / toFixed / ISO 毫秒 Z 未对齐" — 不成立。** `newseventstimeline/jsvalue.go:89-160`（`Math.round` 的 `floor+0.5`、`toFixed` 用 `big.Rat` 精确比较、`-0.000` 符号规则）、`format.go:13-15` 输出三位毫秒 + `Z`、`Object.keys` 整数键前置序 `jsvalue.go:162-210`。
11. **"A10：TaskLog/Mongo 载荷用 `map[string]any`" — 不成立。** 全包 `any` 只出现在驱动/协议边界；TaskLog `data` 全是具名 struct + `bsonDocument` 包装，可扩展叶子用 `json.RawMessage`。

### 4.4 内容流水线（W4 窗口）

1. **"分类器 `getSourcePolicy` 抛错会放大成阶段失败" — 不成立。** Nest `:520-580` 只 catch 缓存读错误，Go `sourcepolicy.go:96-104` 同样抛出；两侧最终都让 classify 阶段失败。
2. **"vector `fallbackToMongo` 开关被忽略" — 不成立。** `dedupe.go:767-776` 的类型断言与真实实现 `vectorclient/search_client.go:482` 签名一致。
3. **"staged 阶段 `stage_meta` 被重建会丢成员" — 不成立。** 后续 6 个成员在两条分支上都会被显式赋值，且 `StageMeta` 结构体声明顺序与 Nest 插入顺序一致（`contract.go:172-184`）。
4. **"taxonomy embedding 缓存改变了 embedding 请求" — 是事实但不构成缺陷。** Nest 每次把 `[query, ...全部文档]` 都发一遍，Go 在"全部命中缓存"时只发 query；`Session` 按任务创建、单任务只分类一次，生产路径等价，跨条目复用时省 token，属规划允许的算法优化。
5. **"进程内 outbox 计时器缺失会让失败投递永久丢失" — 不成立。** #116 扫描器是 go 模式下的唯一补偿 owner，Nest 侧 cron 在 `=go` 时短路。
6. **"persist 事务可能半写" — 未发现。** 单个 `BeginTx`，Article upsert / ProcessedArticle upsert / term 桶重写 / `MongoOutbox` 插入全在同一事务内，提交后才触发投递与快照刷新。
7. **"prompt 模板会静默漂移" — 本次未发现。** 9 个默认模板 + dedupe 2 个模板用脚本逐字节比对全部相同；`CleanedNewsSchema` 的 JSON Schema 字符串字段序、`required`、`additionalProperties` 与 zod 输出一致。
8. **"`buildTags`/`toItemMetaName`/`toArticleUrl`/`ItemStatus` 字面量漂移" — 不成立。** 逐字比对一致。
9. **"`pipelineRuntime` 默认值漂移导致 dedupe 被关" — 不成立。** 11 个默认值逐项相同（`summaryDedupEnabled=true`、阈值 0.9、回看 48h、候选 100、最小 40 字符等）。

### 4.5 新闻源与分类质量（W5 窗口）

1. **"30 秒 cron 锁不一致" — 不成立。** key 同为 `lock:cron:news-source-scheduler`、TTL 同为 `NEWS_SOURCE_SCHEDULER_LOCK_TTL_MS`（默认 120s）、续租 `max(500ms, ttl/3)`、token 比较释放；两侧都在拿锁**之前**判断开关。**Lead 独立复核了 Nest 侧注释**：`news-source.scheduler.service.ts:268-280` 明确"when Go owns the scheduler this callback returns BEFORE taking cron:news-source-scheduler"，与 Go 侧行为一致。
2. **"正忙分支不一致" — 不成立。** Nest 拿不到 per-source 锁时 `withLock` 返回 null → 抛 409 `News source is already being dispatched`；Go `handler.go:73-75` 同码同文案；dedupe 命中时两侧都是 201 且 `reason:"deduped"`。
3. **"通知 relay `news-source:notifications:v1` 的展示类型白名单可能透传未知类型" — 不成立。** **Lead 已独立复核**：Nest `news-source-notification.subscriber.ts:27-35` 的 `NEWS_SOURCE_PRESENTATION_KINDS` 有 5 个 kind（`scheduler_backpressure`/`rss_body_missing_spike`/`pipeline_retry_spike`/`circuit_opened`/`auto_disabled`）；Go `notificationssocket/model.go:110-160` 的 `validateRelayedRow` 的 `relayNewsSource` 分支逐项相同，且**额外加了** `event.Type != "system" || event.UserID != nil` 两条前置拒绝（把用户级行挡在组织级广播之外），比 Nest 更严。
4. **"分类/复核/RSS 运维的组织范围不全" — 不成立。** `classificationrssops` 13 条全部 `settings.manage`、Mongo 过滤一律带 `orgId`，非法/跨租户 ObjectId → 404（与 Nest 同序）；跨租户一律 404 而非 403，与 Nest 相同。
5. **"news-indicator 数学不等价" — 不成立。** `toUtcDayStartMs`/`clampFloat`/`normalCDF`/`approximatePValue`/`pearsonCorrelation`/`buildDailyEconomicValues`/`buildDailyReturns`/`computeBestLagCorrelation`/`runBacktest` 与 `news-indicator-math.ts` 逐段等价，含 `n<2` 与 `sumX2==0` 除零、`Math.sign`、窗口 `>= start && < end`、`jsRound`。仅 W5-04 的顺序不确定性（两侧皆非确定）。
6. **"报表 job 的 BullMQ 协议字段不一致" — 不成立。** job name、jobId 前缀 `classification-quality-report:`、payload 键序、`attempts:3`、`backoff{exponential,2000}`、`removeOnComplete:true`、`removeOnFail{age:7d,count:10000}`、失败时落 `failed{completedAt,error.message}` 并回 500、`expiresAt` 365 天，全部一致。
7. **"qualityqueue worker 门控或 job 名不一致" — 不成立。** Nest `=go` 时不建 Worker、Queue 仍保留，与 Go 互斥；并发公式 `max(1,min(4, or 2))` 两侧同；BullMQ 默认 30s lock / 30s stalled / `maxStalledCount=1` 一致。
8. **"RSS 翻译超时 clamp 不一致" — 原疑点不可达。** `itemsreading/translation.go:288-303` 已先把 timeout 收口到 1000..120000、retries 收口到 0..5，进不到该分支。
9. **"SSRF 内网限制比 Nest 松" — 不成立。** `newssources/ssrf.go` 与 `ssrf-url.validator.ts` 逐条对应（metadata host/path、localhost 变体、十进制/`0x7f`/`0177.`、IPv4 保留段、IPv6 ULA/link-local/mapped、DNS 失败默认放行）。唯一差异是 `999.1.1.1` 这类"四段数字但非法 IP"：Nest 按 IP 处理并拦，Go 当主机名放行后 DNS 解析失败（请求本身失败），不构成可利用绕过。
10. **"鉴权应早于请求体解析"（最初的 P3 候选）— 不成立。** Express 的 body-parser 是全局中间件，在所有 guard 之前执行；畸形 JSON 两侧都是 400、超限两侧 413，因此 `newssources/handler.go` 里"先 `readJSON` 后 `authorize`"不产生 401/400 倒挂，也不是新增 DoS 面。
11. **"`retryLatest`/`cancelQueued`/`clearInFlight` 的租户与状态码不一致" — 不成立。** 三者都先按 `id` 读源再比 `orgId` → 404，后续 `WHERE … AND orgId = ?`；pipeline 字段重置与失败回滚语义一致。
12. **"qualityoverview 四舍五入不一致" — 不成立。** `Math.round(v*1000)/1000` 与 `roundFinite(v,3)` 等价；负数半值差异对非负的 cost/latency 不可达。

### 4.6 公开门户与个人化（W6 窗口）

1. **"公开门户把一个租户的数据带给另一个租户" — 不成立。** 入口无租户参数，org 由 `SystemSetting.public_portal_org_slug` 白名单解析（`store.go:137-191`，含"不得回退到最近组织"注释）；SQL 与内存两层都按该 orgId + active 过滤，服务层还有二次拒绝（`service.go:200`、`story.go:60`）。
2. **"slug 的 NFKD/NFC 与 Nest 不一致导致 404" — 不成立。** 两侧同一条流水线（NFKD → 去 `\p{Mark}` → NFC → 小写 → 非字母数字连续段→`-` → 去首尾 `-` → 空则 `story`）；`extractStoryId` 都是"第一个 `-` 之前"；`\p{Letter}`/`\p{Number}` 与 Go `unicode.IsLetter/IsNumber` 类别相同（`slug.go:12-66` ↔ `public-portal.service.ts:83-104`）。
3. **"频道匹配会因未规范化输入而 404" — 不成立。** `Channel` 先 `sanitizeSlugSegment(topic)` 再比较；未知 topic 两侧都返回 200 + 空数组。
4. **"公开路由 OPTIONS 被 Go handler 吃掉导致 CORS 预检失败" — 不成立。** 路由规则是 `getOnly`（`legacyproxy/proxy.go:183-186`），非 GET（含 OPTIONS）回落 Nest。
5. **"错误响应被公共缓存 60s 与 Nest 不同" — 不成立。** Nest `@Header` 在 handler 前设置头，异常响应同样带该头；两侧一致。
6. **"摘要 Cron 与 Go 调度器可能双跑" — 不成立。** Nest 在抢 gate **之前**判断 `=go` 直接返回（`user-digest-delivery-scheduler.service.ts:37-42`），且双方共用 gate/租约键。
7. **"KG ingestion 里 `UPDATE KnowledgeEdge … WHERE id=?` 是跨租户写" — 不成立。** `id` 来自同事务内 `WHERE orgId=? … FOR UPDATE` 的结果（`graph.go:213-232` → `:309,319`）。
8. **"`getFinancialTimeSeries` 无 orgId 是跨租户" — 不成立。** `EconomicDataPoint` 是平台级经济序列，Nest 同一查询也不带 orgId。
9. **"sentimentsnapshot 在 Mongo 缺失时会清空当天快照" — 不成立。** `store.go:78-81` 的 `nil` 分支不可达，装配处强制要求 `MONGO_URI` 且连接非空。
10. **"`GET_LOCK` 释放失败会让连接把锁带回池并阻塞其他用户" — 影响可忽略。** 锁名由 `(orgId,userId)` 决定，残留锁只影响同一用户的后续请求，且同会话重入返回 1。

### 4.7 Lead 的独立复核（派发前完成）

- **RSS seed TTL 迁移（→ W5-01）**：确认 Nest `onModuleInit` 执行、Go 完全缺失、且 Go 的 `toOptionalSeedCacheTTLSeconds` 仍把 600 当合法 override。不成立的可能性被逐一排除（Go 无 `migration:` 键；`seedconfig.go` 无条件接受区间内值）。
- **去重自匹配（→ §4.1.1）**：读 `newspipeline/dedupe.go` 的 `dedupeLLMCandidateFilter`/`dedupeVectorAllowedFilter`/`dedupeSemanticCandidateFilter`，确认 `$ne` 与条件语义与 Nest 逐点对应。
- **通知 relay 白名单（→ §4.5.3）**：读两侧 5 个 kind 清单，确认 Go 完整且更严。

## 5. 覆盖率与审查深度（如实记录）

本窗口范围约 **12 万行 Go + 5.5 万行 Nest**，**未逐行通读**。按"写路径、鉴权、后台任务优先，纯读格式化其次"分配精力。

### 5.1 全文审查（逐分支读写）的入口

§2 表格中标"全文"的约 60 个入口，覆盖：itemPipeline 生产/消费/失败/DLQ/状态机、processed item outbox 的立即投递与补偿、news-events 聚类的 ingest/bertopic/assign/timeline/failure/recovery、news-pipeline 的全部阶段与闸门、dedupe 全族、persist/outbox 事务、prompt builder 与 config、classifier、news-source 的 ops/dispatch 4 条 POST 与 seed TTL 迁移、classificationrssops 的 13 条 HTTP、report job、seed trigger、alert scheduler、news-indicator 数学与 HTTP、公开门户 4 条 GET、content subscriptions/news behavior/user digest 的 handler、摘要投递调度器、GDELT/sentiment/KG 的调度器。

### 5.2 重点审查（只看了指定方法）

- `itemsreading`（1.4 万行）：`access.go`/`query.go`/`search.go`/`itemslist.go`/`ranking.go`/`relevance.go`/`personalized.go`/`elasticsearch.go`/`mongofilter.go`；`translation.go`/`vector.go`/`rerank.go`/`resultfields.go`/`bsonjson.go`/`rawpayload.go`/`csvexport.go` 抽查。
- `newsnowclusteringops`（1.4 万行）：`clusteringfailure.go`/`llm_backfill*.go`/`store_clustering.go`/`service.go`/`handler.go`/`store_opinion.go`/`urlresolve.go`/`store_resolve.go` 全文；`personalization.go`/`opinionindex.go`/`data_gen.go`/`metadata.go`/`geo.go`/`archive.go` 抽查。
- `newssourcescheduler`（1.16 万行）：`scheduler.go`/`cache.go`/`repo.go`/`ops.go`/`handler.go`/`rsseedttl.go` 全文；`dispatch.go` 只核主序列与 persist→enqueue→mark-queued 顺序；`dedupe.go`/`adaptive.go`/`deepfailure.go`/`snapshot.go`/`discovery.go`/`seedconfig.go` 未逐分支。
- `newspipeline`（1.97 万行）：`process.go`/`stages.go`/`persist.go`/`outbox.go`/`gates.go`/`dedupe*.go`/`extraction.go`/`promptbuilder.go`/`settings.go`/`clean.go` 的调用面；`schema.go`（1028 行）只抽查骨架与 3 个成员解析器；`internal.go`（1269 行）只核 4 个函数的调用面；`clean.go:525-718` 的 URL 规范化未逐条比对。
- `newsclassifier`：`classifier.go`/`sourcepolicy.go`/`jsonsafe.go`/`prompt.go` 全文；`cleaned.go`（545 行）只核外部契约。
- `classificationrssops`（1.05 万行）：`handler.go` 与 `report_*.go` 全文；`classification.go` 前 900 行（summary 直方图/趋势/methodDistribution/告警节流与收件人）与 `rssdiagnostics.go` 只按域文档 + `orgId` 抽查。
- `newssources`（CRUD）：`store.go` 只核 `orgId` 过滤与写入列；未逐字段比对 Prisma 默认值、`@@unique([orgId,url])` 冲突→409、OPML 导入部分失败语义。
- `gdeltsnapshot`：调度/锁/开关/强制刷新分支全文；`fetch.go`/`rebuild.go`/`normalize.go`/`summary.go`/`store.go` 的采集解析与状态汇总抽样。
- `kgingestion`：调度/开关/游标推进/边与证据的租户条件已核；`quality.go`/`linker.go`/`relations.go`/`batch.go` 未审查。
- `newsbehavior`：只做 `orgId` 过滤 grep 与 `record` 写路径阅读（抽样）；`collaborative.go`(849)/`scores.go`(549)/`profile.go` 未逐行。
- `contentsubscriptions`：`dto.go`(548)/`migrate.go`/`model.go` 抽样。
- `graphqlread/kgimpact`：`impact.go` 前 120 行 + `entityimpact.go` 前 210 行；`pearson.go`/`entity.go`/`settings.go` 未审查。
- `sentimentsnapshot`：`store.go` 写路径已读；Mongo 聚合管道 `pipeline.go` 未逐行比对。

### 5.3 未审查

- **`publicportal` 的模型网关/补全族约 6.4k 行**：`gateway.go`、`assistant_completion.go`、`assistant_stream.go`、`analysis_stream.go`、`kg_completion.go`、`hottest_completion.go`、`clustering_completion.go`、`rss_completion.go`、`brief_completion.go`。它们服务于 assistant/kg/trending/翻译域的 LLM 调用，非公开门户产品面。
- **`news-event-source-classifier.ts`（864 行）+ `news-event-source-policy.service.ts`（1587 行）** 与 Go 侧的一致性、`newsEventSourcePolicySyncStatus` 契约 —— 完全未审查。
- **`newsnow-hottest-analysis.*` / `newsnow-active-source-registry` / `newsnow-realtime.dispatcher`**（文档明示仍留在 Nest）。
- **仍留在 Nest 的 `newsnow-source-warm` / `newsnow-hottest-analysis` / `newsnow-recommended` / `newsnow-domestic-opinion-index`** 四个调度器。
- **BullMQ 内嵌 Lua 脚本原文**（`clusteringrecoveryqueue/scripts/`、`qualityqueue` 5 个脚本、`itempipeline` 各脚本）：只核对了 key 布局、调用参数与关键分支，未逐行比对 bullmq 5.63.2 的 digest/版本。
- `internal/startupreconcile`、`internal/legacyproxy`、`cmd/api` 的装配细节（除开关门控与 handler 接线）。
- **`neweventsingest/modelclient.go` ↔ `model-service.client.ts`** 的重试/超时/错误分类/`response.clusters` null 处理。
- **`newseventsingest/vectorsearch.go` ↔ `@modular/vector-client`** 的降级矩阵与 `OrgID` 派生链。
- `itemsreading/personalized.go` 的窗口扩张与分差阈值逐行对照（PERSONALIZED 是唯一有 userId 参与排序的路径）。
- `rsstranslation` 的 LLM 侧（非 DeepLX）与 `markdown.go` 的缓存/去重语义。

### 5.4 验证边界（必须如实说明）

- 本机**未运行** `go build`、`go test`、`pnpm`、Docker 或任何服务；**未连接**真实 MySQL / Redis / Mongo / Elasticsearch / SMTP / LiteLLM。全部结论为静态推导。
- 唯一验证渠道是现有普通 GitHub Actions CI（`go test ./...` 与既有集成 job）。CI 结果见本 PR 描述。
- **W3-02 的并发断言（`TestIngestionConcurrentAssignOnlyOneWins` 新增的两条）理论上需真实 MySQL 才能执行**（InnoDB 对未提交冲突行先阻塞再报 1062 的语义是"胜者必已提交"论证的前提）。普通 CI 里该测试是否在集成 job 中运行需按实际 job 结果确认；若只编译不执行，该修复仍属"逻辑已论证、未在真实依赖上执行"。
- W6-01、W4-01、W5-01、W2-01/02 的修复由纯单测固定，不依赖外部服务。

## 6. 建议的后续审查

按风险从高到低：

1. **`news-event-source-classifier` + `news-event-source-policy`（约 2.5k Nest 行）** —— 本窗口完全未碰，且它们是新闻事件聚类与 RSS 分类的共同上游。
2. **`newspipeline/schema.go`（1028 行）** —— 把 `CleanedNewsSchema` 的 26 个成员做成"输入 → zod 结果 vs Go 结果"对照表。这是内容流水线剩余最大风险面（zod 预处理、错误消息、path 拼接、`optionalNullableIsoDateTimeString`、`kgRelationsMember`）。
3. **`publicportal` 的模型网关/补全族（6.4k 行）** —— 按"凭据解密、超时/重试、JSON 解析宽容度、错误映射"专项审。
4. **`itemsreading/personalized.go` 与 `vector.go` 的降级矩阵** —— PERSONALIZED 是唯一 userId 参与排序的路径。
5. **`newssourcescheduler/dispatch.go`（约 900 行）逐分支** —— 调度选源 → 指纹去重 → RSS/list/deep 三分支 → 退避/熔断。
6. **`neweventsingest/modelclient.go` + `vectorsearch.go`** 的真实网络面与降级。
7. **`sentimentsnapshot/pipeline.go` 聚合管道**与 `kgingestion` 的 `quality/linker/relations/batch`。
8. **W4-02 的 helper 统一**（同包、零导出、可单独提交），消除 `clean.go` 与 `gates.go` 两份 markdown 语义实现。
9. **W2-09 的可观测性缺口** —— 决定 go 模式下是否补 `recordIntegrationEvent`，否则条目 ES/向量召回的告警面缩水。
10. **W5-03 的报表幂等** —— 改 `jobId` upsert 或插入前复用既有 `_id`。

## 7. 删除 Nest 前必须确认的事项

### 7.1 仍只有 Nest 实现、删除后会直接缺失的能力

| # | 能力 | 证据 | 后果 |
|---|---|---|---|
| 1 | **队列事件实时链路**：`queue-event.publisher.ts` + `queue.gateway.ts` + `dashboard.resolver.ts` + `queue-org-stats.tracker.ts` | Nest 独占，无 Go 对照实现 | 删 Nest 会一并失去 `queueEvents` GraphQL 订阅、Socket.IO 广播与 org 级队列计数追踪 —— **即使 `API_GO_ITEM_PIPELINE_WORKER_MODE=go` 也一样** |
| 2 | **`QueueService.stats` 与 Bull Board 管理面板** | `queue.service.ts:224-257` | dashboard 队列面板无数据源 |
| 3 | **`itemPipelineDlq` 无消费者** | Go 只生产 DLQ（`itempipeline/dlq.go`），重放入口 `pipelineenqueue.EnqueueReplay` 无 Nest 对照 | 失败作业只进不出，积压无上限保护 |
| 4 | **四个 newsnow 调度器**：`newsnow-source-warm`（每分钟预热，`lock:cron:newsnow-source-warm`）、`newsnow-hottest-analysis`、`newsnow-recommended`、`newsnow-domestic-opinion-index` | 文档明示仍留在 Nest | 删 Nest 后来源预热与热点/推荐/舆情指数停摆 |
| 5 | **`news-event-brief` 的 GraphQL root**（`API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE`）等一批 root | Go 侧未就位 | 删除后 404 |

### 7.2 开关与执行所有权（源码默认 ≠ 部署值）

1. 删 Nest 后必须 `API_GO_ITEM_PIPELINE_WORKER_MODE=go`（否则没有消费者），且 `API_GO_PROCESSED_ITEM_OUTBOX_MODE=go`（否则**没有任何** 5 分钟补偿扫描，立即投递失败的行会永久停在 `processing`；Nest 的进程内计时器也未移植）。
2. `API_GO_ITEM_PIPELINE_WORKER_MODE=go` 需要 `DATABASE_URL` / `REDIS_HOST` / `MONGO_URI` / `SYSTEM_SETTINGS_ENCRYPTION_KEY` 齐备（`config.go:6466-6478`），并受 `BULLMQ_WORKERS_ENABLED` 二次门控（`item_pipeline_worker.go:86`）。缺任一项则 itemPipeline **无人消费**。
3. 本域相关开关需在生产逐项置 `go`：`ITEM_PIPELINE_WORKER`、`PIPELINE_RECOVERY(_WRITE)`、`ITEMS_INGEST`、`ITEMS_READING`、`GRAPHQL_ITEMS_LIST`、`SEARCH_REINDEX`、`RAW_ITEM_OUTBOX`、`NEWS_EVENTS_INGESTION`、`NEWS_EVENTS_TIMELINE`、`NEWSNOW_CLUSTERING_OPS`、`NEWS_CLUSTERING_LLM_BACKFILL`、`NEWS_CLUSTERING_RECOVERY_WORKER`、`NEWS_SOURCES`、`NEWS_SOURCE_SCHEDULER`、`NEWS_SOURCE_OPS`、`NEWS_SOURCE_PREVIEW`、`NEWSNOW_SOURCES`、`NEWS_INDICATORS`、`NEWS_INDICATOR_ASSOCIATION_CRON`、`GRAPHQL_NEWS_INDICATOR_REFRESH`、`QUALITY_OVERVIEW`、`CLASSIFICATION_RSS_OPS`、`CLASSIFICATION_REPORTS`、`CLASSIFICATION_QUALITY_WORKER`、`CLASSIFICATION_REVIEW_SEED`、`CLASSIFICATION_QUALITY_ALERT`、`GRAPHQL_RSS_TRANSLATION`、`PUBLIC_PORTAL`、`CONTENT_SUBSCRIPTIONS`、`USER_NEWS_BEHAVIOR`、`USER_DIGEST`、`USER_DIGEST_DELIVERY`、`SENTIMENT_SNAPSHOT`、`GDELT_SNAPSHOT(_REFRESH)`、`KNOWLEDGE_GRAPH_INGESTION`、`GRAPHQL_KG_IMPACT`。

### 7.3 本批修复带来的行为变化（切流前需运维知晓）

| 变更 | 来源 | 影响面 |
|---|---|---|
| stalled 作业不再重跑 pipeline 体，直接终态失败 | W1-01 | 毒丸作业不再无限重跑；`itemPipelineDlq` 与失败计数开始收到这次终态失败 |
| 并发分配败者不再返回自己的空事件 id，改返回胜者 id | W3-02（Nest 既有问题） | 控制台不再出现 0 items 空事件；bertopic 同簇成员不再被打散 |
| dedupe judge 越界/畸形响应整条丢弃，不再 clamp 后采用 | W4-01 | 少部分此前被误标 Duplicate 的条目会保留在列表 |
| 公开门户只写 `metadata.briefV1` 叶子 | W6-01 | 不再覆盖 timeline 等 sibling 叶子；**混合版本期 Nest 侧整列写仍可能覆盖** |
| `Scheduler.Start` 会先跑一次 RSS seed TTL 迁移 | W5-01 | 首启多一次 `NewsSource` 全表读；`updatedCount>0` 时有一次 `SCAN news-source:rss:*`；与 Nest 互斥 |
| `searchHighlights` 顺序改为 ES 响应序 | W2-01 | 之前依赖随机序的客户端行为会变得确定 |
| `bearer xxx` 小写 scheme 现在被接受 | W2-02 | 此前 401 的请求变 200 |
| 条目检索的 facet/建议/来源排序改为 ICU root | W2-03 | 并列项次序变化 |
| 组织活跃列表缓存开始真正命中 | W3-01 | 每 tick 少一次 MySQL 查询，少一条假 warning |

### 7.4 共享 Redis 键（删除 Nest 后需确认仍有维护者）

`org:active:list:v1` 及其 `lock:` 填充锁、`lock:cron:news-source-scheduler`、`cron:user-digest-delivery:tick-gate`、`lock:cron:user-digest-delivery:org:<id>`、`lock:cron:processed-item-outbox`、`lock:cron:raw-item-outbox`、`lock:search:reindex:org:<orgId>`、`cron:knowledge-graph-ingestion:tick-gate`、`cron:sentiment-snapshot:*`、`lock:cron:news-event-clustering-recovery`、`migration:news-source:rss-seed-cache-ttl-600(:done)`、`newsExtraction:settings:*`、`newsDedupe:settings:*`、`newsClassification:sourcePolicy:*`、`news_pipeline_prompt_config`。

**特别注意 `org:active:list:v1`**：它的组织变更失效路径目前两侧都有写入者，需确认删除 Nest 后组织增删改仍能触发 Go 侧失效。

### 7.5 只有 Nest 才写的数据

1. **`newsEventSourcePolicySyncStatus` 与来源策略读写**（未审查）。
2. **`queueEvents` / org 级队列计数追踪**（§7.1 第 1 项）。
3. **newsnow 四调度器写出的热点/推荐/舆情指数快照**（§7.1 第 4 项）。
4. **Nest 侧 `news-event-brief.service.ts` 的整列 metadata 写**：W6-01 修复后 Go 只写叶子，但混合版本期 Nest 仍会整列覆盖。**必须在切流完成后才彻底消除。**

## 8. 改动文件清单

### 8.1 源码（14 个文件，全部在 `apps/api-go`）

`itempipeline/{errors,protocol,worker}.go`；`itemsreading/{handler,query,readmodel,elasticsearch,itemslist,relevance}.go`；`graphqlread/itemsreading/list.go`；`searchreindex/{elasticsearch,service}.go`；`newseventsingest/{scheduler,assign}.go`；`newsnowclusteringops/{clusteringfailure,llm_backfill_assign,llm_backfill}.go`；`newspipeline/{dedupe_llm,settings}.go`；`newssourcescheduler/{scheduler,cache,repo}.go` + 新增 `rsseedttl.go`；`publicportal/{store,story,brief}.go`。

### 8.2 测试

`itempipeline/protocol_test.go`；`itemsreading/{query_test,elasticsearch_test,handler_test}.go`（后两个新建）；`searchreindex/service_test.go`；`newseventsingest/{integration_test,activeorgcache_test}.go`（后者新建）；`newspipeline/{dedupe_llm_test,dedupe_test,settings_test}.go`；`newssourcescheduler/{rsseedttl_test,fakes_test}.go`（前者新建）；`publicportal/service_test.go`；`userdigest/delivery_scheduler_test.go`。

### 8.3 共享文件

**未修改** `cmd/api/main.go`、`internal/config/config.go`、任何开关及其默认值、`docker-compose.yml`、`.env.sample`、Nest 与 Web 源码（W5-01 的迁移挂在已被调用的 `Scheduler.Start` 上，无需改 `main.go`）。`graphqlread/itemsreading/list.go` 是唯一跨出主包列表的改动（W2-01 的高亮投影，1 个函数）。

## 9. 验证

- 审查方式：静态阅读 + 对抗式复核，**无运行时验证**。
- 格式：全部改动文件通过 `gofmt -l`（仓库内另有 20 个**既有的**未格式化文件，均在本次改动范围之外）。
- 编译与测试：以本 PR 的普通 GitHub Actions CI 为准（`verify` job 的 `go test ./...`，以及既有集成 job）。
- 未运行、因此不声称通过：真实 MySQL/Redis/Mongo/ES/SMTP/LiteLLM 调用、Docker、前端构建、生产流量、`API_GO_*` 的实际部署取值。
