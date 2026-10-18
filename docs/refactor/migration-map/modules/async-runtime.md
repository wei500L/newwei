# async-runtime · 队列、调度、Outbox 与实时传输

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

BullMQ worker、Cron、repeat 调度、Outbox 仍以 Nest 为主要事实源。GraphQL 四订阅使用 Nest Redis backplane，Go 协议升级/Subscription 回退。Go SSE 与搜索重建各有自己的 goroutine，不等于 BullMQ 已迁。

关键数据与副作用：MySQL MongoOutbox/AuditLogOutbox、Mongo raw/processed/cleanup、Redis BullMQ/PubSub/socket.io、Email/LLM/crawl4ai/vector/Telegram/Oref/AkShare；副作用切换需明确唯一生产者与消费者。

真实剩余缺口：需沿下方 worker/scheduler 清单逐条规划，核对入队 job name/payload、repeat 清理、DLQ、重试/租约/关闭语义；没有全局 Go 队列接管开关。禁止因接口已迁就再启同一任务的 Go 消费者。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#async-runtime) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[queue](../../../../apps/api/src/modules/queue)、[audit](../../../../apps/api/src/modules/audit)、[cache](../../../../apps/api/src/modules/cache)、[config](../../../../apps/api/src/modules/config)、[email](../../../../apps/api/src/modules/email)、[model-service](../../../../apps/api/src/modules/model-service)、[vector](../../../../apps/api/src/modules/vector)、[websocket](../../../../apps/api/src/modules/websocket)、[graphql-subscriptions](../../../../apps/api/src/modules/graphql-subscriptions)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## 精确 HTTP 清单

分母 4：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `POST /api/admin/news-sources/:id/cancel-queued` | crawl.write | [news-source-ops.controller.ts](../../../../apps/api/src/modules/queue/news-source-ops.controller.ts) · `cancelQueued` | Nest；尚未接管 |
| `POST /api/admin/news-sources/:id/clear-inflight` | crawl.write | [news-source-ops.controller.ts](../../../../apps/api/src/modules/queue/news-source-ops.controller.ts) · `clearInflight` | Nest；尚未接管 |
| `POST /api/admin/news-sources/:id/dispatch` | crawl.write | [news-source-dispatch.controller.ts](../../../../apps/api/src/modules/queue/news-source-dispatch.controller.ts) · `dispatch` | Nest；尚未接管 |
| `POST /api/admin/news-sources/:id/retry-latest` | crawl.write | [news-source-ops.controller.ts](../../../../apps/api/src/modules/queue/news-source-ops.controller.ts) · `retryLatest` | Nest；尚未接管 |

## Worker / repeat / Cron / Outbox 定位

以下是当前源文件与生命周期符号清单；同文件可能创建多个 Worker，不能把文件数当队列数。开关与唯一消费者尚未逐队列设计，全部保留 Nest 消费者状态。

| 类别 | 源码 | 定位符号 / 表达式 |
|---|---|---|
| BullMQ worker | [akshare.processor.ts](../../../../apps/api/src/modules/akshare/akshare.processor.ts) | `AkshareQueueProcessor` · new Worker / onModuleInit |
| repeat / 调度生产者 | [akshare.service.ts](../../../../apps/api/src/modules/akshare/akshare.service.ts) | `AkshareService`；检查 repeat、add 与启动注册 |
| BullMQ worker | [alerts.processor.ts](../../../../apps/api/src/modules/alerts/alerts.processor.ts) | `AlertsProcessor` · new Worker / onModuleInit |
| repeat / 调度生产者 | [alerts.service.ts](../../../../apps/api/src/modules/alerts/alerts.service.ts) | `AlertsService`；检查 repeat、add 与启动注册 |
| BullMQ worker | [analysis.processor.ts](../../../../apps/api/src/modules/analysis/analysis.processor.ts) | `AnalysisProcessor` · new Worker / onModuleInit |
| BullMQ worker | [archive-preparation.processor.ts](../../../../apps/api/src/modules/archive/archive-preparation.processor.ts) | `ArchivePreparationProcessor` · new Worker / onModuleInit |
| BullMQ worker | [assistant.processor.ts](../../../../apps/api/src/modules/assistant/assistant.processor.ts) | `AssistantProcessor` · new Worker / onModuleInit |
| Cron | [audit-log-outbox.service.ts](../../../../apps/api/src/modules/audit/audit-log-outbox.service.ts) | `AuditLogOutboxService` · `@Cron(CronExpression.EVERY_MINUTE)` |
| Cron | [crawl-adaptive-concurrency.service.ts](../../../../apps/api/src/modules/crawl/crawl-adaptive-concurrency.service.ts) | `CrawlAdaptiveConcurrencyService` · `@Cron(CronExpression.EVERY_MINUTE)` |
| Cron | [crawl-cleanup-outbox.service.ts](../../../../apps/api/src/modules/crawl/crawl-cleanup-outbox.service.ts) | `CrawlCleanupOutboxService` · `@Cron(CronExpression.EVERY_MINUTE)` |
| Cron | [crawl-quality-task-snapshot.service.ts](../../../../apps/api/src/modules/crawl/crawl-quality-task-snapshot.service.ts) | `CrawlQualityTaskSnapshotService` · `@Cron(CronExpression.EVERY_5_MINUTES)` |
| Cron | [crawl-task-janitor.service.ts](../../../../apps/api/src/modules/crawl/crawl-task-janitor.service.ts) | `CrawlTaskJanitorService` · `@Cron(CronExpression.EVERY_MINUTE)` |
| BullMQ worker | [crawl.processor.ts](../../../../apps/api/src/modules/crawl/crawl.processor.ts) | `CrawlQueueProcessor` · new Worker / onModuleInit |
| Cron | [raw-item-outbox.service.ts](../../../../apps/api/src/modules/items/raw-item-outbox.service.ts) | `RawItemOutboxService` · `@Cron(CronExpression.EVERY_MINUTE)` |
| Cron | [knowledge-graph.ingestion.service.ts](../../../../apps/api/src/modules/knowledge-graph/knowledge-graph.ingestion.service.ts) | `KnowledgeGraphIngestionService` · `@Cron(CronExpression.EVERY_5_MINUTES)` |
| Cron | [newsnow-hottest-analysis.scheduler.service.ts](../../../../apps/api/src/modules/news-aggregator/newsnow-hottest-analysis.scheduler.service.ts) | `NewsnowHottestAnalysisSchedulerService` · `@Cron(CronExpression.EVERY_10_MINUTES)` |
| Cron | [newsnow-source-warm.scheduler.service.ts](../../../../apps/api/src/modules/news-aggregator/newsnow-source-warm.scheduler.service.ts) | `NewsnowSourceWarmSchedulerService` · `@Cron(CronExpression.EVERY_MINUTE)` |
| Cron | [news-event-clustering-recovery-scheduler.service.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-recovery-scheduler.service.ts) | `NewsEventClusteringRecoverySchedulerService` · `@Cron(CronExpression.EVERY_5_MINUTES)` |
| BullMQ worker | [news-event-clustering-recovery.processor.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-recovery.processor.ts) | `NewsEventClusteringRecoveryProcessor` · new Worker / onModuleInit |
| Cron | [news-events-ingestion.service.ts](../../../../apps/api/src/modules/news-events/news-events-ingestion.service.ts) | `NewsEventsIngestionService` · `@Cron(CronExpression.EVERY_5_MINUTES)` |
| Cron | [news-events-timeline.service.ts](../../../../apps/api/src/modules/news-events/news-events-timeline.service.ts) | `NewsEventsTimelineService` · `@Cron(CronExpression.EVERY_10_MINUTES)` |
| Cron | [news-indicator-association.ingestion.service.ts](../../../../apps/api/src/modules/news-indicator/news-indicator-association.ingestion.service.ts) | `NewsIndicatorAssociationIngestionService` · `@Cron("0 */6 * * *")` |
| Cron | [news-pipeline.service.ts](../../../../apps/api/src/modules/news-pipeline/news-pipeline.service.ts) | `NewsPipelineService` · `@Cron(CronExpression.EVERY_5_MINUTES)` |
| Interval | [classification-quality-alert-scheduler.service.ts](../../../../apps/api/src/modules/observability/classification-quality-alert-scheduler.service.ts) | `ClassificationQualityAlertSchedulerService` · `@Interval(` |
| BullMQ worker | [classification-quality.processor.ts](../../../../apps/api/src/modules/observability/classification-quality.processor.ts) | `ClassificationQualityProcessor` · new Worker / onModuleInit |
| Cron | [news-source.scheduler.service.ts](../../../../apps/api/src/modules/queue/news-source.scheduler.service.ts) | `NewsSourceSchedulerService` · `@Cron("*/30 * * * * *")` |
| BullMQ worker | [queue.processor.ts](../../../../apps/api/src/modules/queue/queue.processor.ts) | `QueueProcessor` · new Worker / onModuleInit |
| Cron | [audit-log-retention.service.ts](../../../../apps/api/src/modules/rbac/audit-log-retention.service.ts) | `AuditLogRetentionService` · `@Cron(CronExpression.EVERY_DAY_AT_1AM)` |
| Cron | [realtime-signals.service.ts](../../../../apps/api/src/modules/realtime-signals/realtime-signals.service.ts) | `RealtimeSignalsService` · `@Cron(CronExpression.EVERY_MINUTE)` |
| Cron | [sentiment-snapshot.ingestion.service.ts](../../../../apps/api/src/modules/sentiment/sentiment-snapshot.ingestion.service.ts) | `SentimentSnapshotIngestionService` · `@Cron(CronExpression.EVERY_HOUR)` |
| BullMQ worker | [situation-monitor-signals.processor.ts](../../../../apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.processor.ts) | `SituationMonitorSignalsProcessor` · new Worker / onModuleInit |
| repeat / 调度生产者 | [situation-monitor-signals.processor.ts](../../../../apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.processor.ts) | `SituationMonitorSignalsProcessor`；检查 repeat、add 与启动注册 |
| Cron | [situation-monitor-external-snapshot.service.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor-external-snapshot.service.ts) | `SituationMonitorExternalSnapshotService` · `@Cron("0 */15 * * * *")` |
| repeat / 调度生产者 | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) | `SituationMonitorSettingsController`；检查 repeat、add 与启动注册 |
| Cron | [user-digest-delivery-scheduler.service.ts](../../../../apps/api/src/modules/user-digest/user-digest-delivery-scheduler.service.ts) | `UserDigestDeliverySchedulerService` · `@Cron(CronExpression.EVERY_MINUTE)` |

Outbox 事实源：[audit-log-outbox.service.ts](../../../../apps/api/src/modules/audit/audit-log-outbox.service.ts)、[crawl-cleanup-outbox.service.ts](../../../../apps/api/src/modules/crawl/crawl-cleanup-outbox.service.ts)、[raw-item-outbox.service.ts](../../../../apps/api/src/modules/items/raw-item-outbox.service.ts)、[news-pipeline-outbox.service.ts](../../../../apps/api/src/modules/news-pipeline/news-pipeline-outbox.service.ts)。

主入队边界：QueueService（itemPipeline/DLQ/来源 dispatch）、CrawlTaskService 与 Frontier 执行服务（crawl4ai/judge/learn）、AnalysisService、AssistantService、AlertsService、ArchivePreparationQueueService、AkshareService、SituationMonitorSignals 服务、分类报告服务。按对应模块 root/HTTP 回溯 Queue.add，队列名、payload 和 repeat key 以源码常量为准。

GraphQL 订阅是 `alertEvents / analysisEvents / assistantEvents / queueEvents`；Nest [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts) 与 [docs/refactor/graphql-subscriptions-multinode.md](../../graphql-subscriptions-multinode.md) 记录 Redis backplane。Socket.IO 网关见 [apps/api/src/modules/websocket](../../../../apps/api/src/modules/websocket)；/socket.io 和 /admin/queues 仍为 legacy。Bull Board 受 BULL_BOARD_ENABLED 控制。

Go 也已有 Outbox **生产者**：例如 [orgaccesswrite.writeAuditLogBestEffort](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/audit.go)、[rbacapi](../../../../apps/api-go/internal/rbacapi/audit.go)、[accountsecurity](../../../../apps/api-go/internal/accountsecurity/audit.go)、[classificationrssops](../../../../apps/api-go/internal/classificationrssops/audit.go) 在审计直写失败时写入同一 AuditLogOutbox，仍由 Nest AuditLogOutboxService 调度消费。不能把“Outbox 消费尚在 Nest”误解为 Go 不会产生 outbox；迁移消费者前先查所有生产者 payload 兼容。

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#29](https://github.com/wei500L/newwei/pull/29) | [146b4b3c1e90](https://github.com/wei500L/newwei/commit/146b4b3c1e902419b443f359facab7e5b565cd61) | 🔀 refactor(api): GraphQL 订阅经 Redis 跨实例投递 |
| [#65](https://github.com/wei500L/newwei/pull/65) | [62ca2adbe6f1](https://github.com/wei500L/newwei/commit/62ca2adbe6f1baaa9ac21490a21207e2524e2116) | ✨ feat(search): 迁移搜索索引重建到 Go 并优化检索遥测读写 |

- [docs/refactor/graphql-subscriptions-multinode.md](../../graphql-subscriptions-multinode.md)

- [docs/refactor/go-search-reindex.md](../../go-search-reindex.md)

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
