# observability · 日志、异常、质量、遥测与运维

最近核对：2026-10-18 13:51 MSK（UTC+03:00）；`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

管理日志/异常读、异常上报、LLM 日志、质量概览、分类复核和 RSS 运维部分已迁。异常 ingests 是带限流和持久化的写接口，导出可能记审计，不能算纯读。搜索遥测在条目域。

关键数据与副作用：MySQL 日志/质量/审计、Mongo TaskLog/ExceptionEvent、Redis 限流/状态；分类报告队列和 pipeline replay/rollback 尚在 Nest；metrics 包含平台权限约束。

真实剩余缺口：创建分类质量报告、pipeline recovery runs/replay/rollback 与 metrics 仍见 Nest；普通 CI 不代表真实 crawl4ai/RSS 翻译模型或故障恢复已验证。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[observability](../../../../apps/api/src/modules/observability)、[health](../../../../apps/api/src/modules/health)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithAdminLogs](../../../../apps/api-go/internal/legacyproxy/admin_logs_routes.go) | `API_GO_ADMIN_LOGS_MODE` | [adminlogs](../../../../apps/api-go/internal/adminlogs) | `legacy` |
| [WithAuthenticatedHealth](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_HEALTHZ_MODE` | [health](../../../../apps/api-go/internal/health) | `未注入；按 config 缺省` |
| [WithClassificationRssOps](../../../../apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go) | `API_GO_CLASSIFICATION_RSS_OPS_MODE` | [classificationrssops](../../../../apps/api-go/internal/classificationrssops) | `legacy` |
| [WithExceptionIngest](../../../../apps/api-go/internal/legacyproxy/exception_ingest_routes.go) | `API_GO_EXCEPTION_INGEST_MODE` | [exceptioningest](../../../../apps/api-go/internal/exceptioningest) | `legacy` |
| [WithLlmLogs](../../../../apps/api-go/internal/legacyproxy/llm_logs_routes.go) | `API_GO_LLM_LOGS_MODE` | [llmlogs](../../../../apps/api-go/internal/llmlogs) | `legacy` |
| [WithQualityOverview](../../../../apps/api-go/internal/legacyproxy/quality_overview_routes.go) | `API_GO_QUALITY_OVERVIEW_MODE` | [qualityoverview](../../../../apps/api-go/internal/qualityoverview) | `legacy` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 32：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/admin/errors` | settings.manage | [admin-errors.controller.ts](../../../../apps/api/src/modules/observability/admin-errors.controller.ts) · `list` | WithAdminLogs |
| `GET /api/admin/errors/stats` | settings.manage | [admin-errors.controller.ts](../../../../apps/api/src/modules/observability/admin-errors.controller.ts) · `stats` | WithAdminLogs |
| `GET /api/admin/logs/audit` | settings.manage | [admin-logs.controller.ts](../../../../apps/api/src/modules/observability/admin-logs.controller.ts) · `listAuditLogs` | WithAdminLogs |
| `GET /api/admin/logs/errors` | settings.manage | [admin-logs.controller.ts](../../../../apps/api/src/modules/observability/admin-logs.controller.ts) · `listErrors` | WithAdminLogs |
| `GET /api/admin/logs/errors/summary` | settings.manage | [admin-logs.controller.ts](../../../../apps/api/src/modules/observability/admin-logs.controller.ts) · `summarizeErrors` | WithAdminLogs |
| `GET /api/admin/logs/task` | settings.manage | [admin-logs.controller.ts](../../../../apps/api/src/modules/observability/admin-logs.controller.ts) · `listTaskLogs` | WithAdminLogs |
| `GET /api/admin/logs/task/summary` | settings.manage | [admin-logs.controller.ts](../../../../apps/api/src/modules/observability/admin-logs.controller.ts) · `summarizeTaskLogs` | WithAdminLogs |
| `POST /api/admin/quality/classification/reports` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `createReport` | Nest；尚未接管 |
| `GET /api/admin/quality/classification/reports/:jobId` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `reportJob` | WithClassificationRssOps |
| `POST /api/admin/quality/classification/reviews/:reviewId/decision` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `reviewDecision` | WithClassificationRssOps |
| `POST /api/admin/quality/classification/reviews/batch` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `batchReviewDecision` | WithClassificationRssOps |
| `GET /api/admin/quality/classification/reviews/queue` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `reviewQueue` | WithClassificationRssOps |
| `POST /api/admin/quality/classification/sampling/annotations` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `submitAnnotations` | WithClassificationRssOps |
| `POST /api/admin/quality/classification/sampling/query` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `createSample` | WithClassificationRssOps |
| `GET /api/admin/quality/classification/sources/:sourceId/items` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `sourceItems` | WithClassificationRssOps |
| `GET /api/admin/quality/classification/summary` | settings.manage | [classification-quality.controller.ts](../../../../apps/api/src/modules/observability/classification-quality.controller.ts) · `summary` | WithClassificationRssOps |
| `GET /api/admin/quality/news-sources` | settings.manage | [news-source-quality.controller.ts](../../../../apps/api/src/modules/observability/news-source-quality.controller.ts) · `summary` | WithQualityOverview |
| `GET /api/admin/quality/overview` | settings.manage | [quality-overview.controller.ts](../../../../apps/api/src/modules/observability/quality-overview.controller.ts) · `getOverview` | WithQualityOverview |
| `GET /api/admin/quality/pipeline` | settings.manage | [pipeline-quality.controller.ts](../../../../apps/api/src/modules/observability/pipeline-quality.controller.ts) · `pipelineSummary` | WithQualityOverview |
| `POST /api/admin/quality/pipeline/replay` | settings.manage | [pipeline-recovery.controller.ts](../../../../apps/api/src/modules/observability/pipeline-recovery.controller.ts) · `replay` | Nest；尚未接管 |
| `POST /api/admin/quality/pipeline/rollback` | settings.manage | [pipeline-recovery.controller.ts](../../../../apps/api/src/modules/observability/pipeline-recovery.controller.ts) · `rollback` | Nest；尚未接管 |
| `GET /api/admin/quality/pipeline/runs` | settings.manage | [pipeline-recovery.controller.ts](../../../../apps/api/src/modules/observability/pipeline-recovery.controller.ts) · `runs` | Nest；尚未接管 |
| `GET /api/admin/quality/task-logs` | settings.manage | [task-logs.controller.ts](../../../../apps/api/src/modules/observability/task-logs.controller.ts) · `list` | WithQualityOverview |
| `GET /api/admin/quality/task-logs/summary` | settings.manage | [task-logs.controller.ts](../../../../apps/api/src/modules/observability/task-logs.controller.ts) · `summary` | WithQualityOverview |
| `GET /api/healthz` | 已认证 | [health.controller.ts](../../../../apps/api/src/modules/health/health.controller.ts) · `getHealth` | WithAuthenticatedHealth |
| `GET /api/healthz/live` | 公开 | [health.controller.ts](../../../../apps/api/src/modules/health/health.controller.ts) · `getLiveness` | shadow；Nest 响应 |
| `POST /api/internal/observability/exception-events` | 公开；核对内部 token Guard | [internal-exception-events.controller.ts](../../../../apps/api/src/modules/observability/internal-exception-events.controller.ts) · `report` | WithExceptionIngest |
| `GET /api/llm-logs` | settings.manage | [llm-request-log.controller.ts](../../../../apps/api/src/modules/news-pipeline/llm-request-log.controller.ts) · `list` | WithLlmLogs |
| `GET /api/llm-logs/export` | settings.manage | [llm-request-log.controller.ts](../../../../apps/api/src/modules/news-pipeline/llm-request-log.controller.ts) · `export` | WithLlmLogs |
| `GET /api/llm-logs/summary` | settings.manage | [llm-request-log.controller.ts](../../../../apps/api/src/modules/news-pipeline/llm-request-log.controller.ts) · `summary` | WithLlmLogs |
| `GET /api/metrics` | metrics.read；handler 平台管理员 | [metrics.controller.ts](../../../../apps/api/src/modules/observability/metrics.controller.ts) · `scrape` | Nest；尚未接管 |
| `POST /api/observability/exception-events/client` | 已认证 | [client-exception-events.controller.ts](../../../../apps/api/src/modules/observability/client-exception-events.controller.ts) · `report` | WithExceptionIngest |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#40](https://github.com/wei500L/newwei/pull/40) | [ea3ca4f1ea14](https://github.com/wei500L/newwei/commit/ea3ca4f1ea14a367e6d95ceb321172fea960f862) | ✨ feat(api-go): 管理端日志与异常读取 7 条 GET 接管（默认 legacy） |
| [#41](https://github.com/wei500L/newwei/pull/41) | [a00a64a69553](https://github.com/wei500L/newwei/commit/a00a64a6955347491dbb3cc349323134fa4d8776) | ✨ feat(api-go): LLM 请求日志列表/导出/汇总迁入 Go（默认 legacy） |
| [#42](https://github.com/wei500L/newwei/pull/42) | [e8ae45b5e272](https://github.com/wei500L/newwei/commit/e8ae45b5e27213481e9db56c6c16bcb701b86fc8) | 🐛 fix(ci): 修正 LLM 请求日志 smoke 的导出审计断言 |
| [#43](https://github.com/wei500L/newwei/pull/43) | [a61b063dfb90](https://github.com/wei500L/newwei/commit/a61b063dfb9094a656c73ed40d9a307dd8413ef7) | 🚀 refactor(api-go): 迁移管理端质量面板 5 条 GET |
| [#50](https://github.com/wei500L/newwei/pull/50) | [b0e4c178b2af](https://github.com/wei500L/newwei/commit/b0e4c178b2af54ea6a72f4555973e011877f0e88) | ✨ feat(api-go): 采集只读、媒体下发与检索遥测迁入 7 条接口（默认 legacy） |
| [#51](https://github.com/wei500L/newwei/pull/51) | [39ad5b55adb0](https://github.com/wei500L/newwei/commit/39ad5b55adb07c48ecd197816039cba8316780c4) | ✨ feat(api-go): 迁入分类质量工作台与 RSS 诊断/翻译指标（API_GO_CLASSIFICATION_RSS_OPS_MODE） |
| [#64](https://github.com/wei500L/newwei/pull/64) | [bdbc59fa4a15](https://github.com/wei500L/newwei/commit/bdbc59fa4a154710ab4c24bd3e8d68cfe5fb3f19) | ✨ feat(observability): 异常上报 Go 迁移与管理端日志读取优化 |

- [docs/refactor/go-admin-logs.md](../../go-admin-logs.md)

- [docs/refactor/go-llm-logs.md](../../go-llm-logs.md)

- [docs/refactor/go-quality-overview.md](../../go-quality-overview.md)

- [docs/refactor/go-classification-rss-ops.md](../../go-classification-rss-ops.md)

- [docs/refactor/go-exception-ingest.md](../../go-exception-ingest.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
