# news · 新闻事件、指标、聚类与内容流水线

最近核对：2026-10-18 13:51 MSK（UTC+03:00）；`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

事件六读与指标两读已有 Go 注册，指标 HTTP、NewsNow 本地计算/聚类失败管理已有 Go。**newsEventBrief 仅缓存命中路径已实现，冷生成与 forceRefresh 是真实业务缺口**。聚类管理 LLM backfill 与新闻源真实抓取未被本地管理接口替代。LLM 日志归运维文档；分类/去重/抽取设置 root 归设置中心。

关键数据与副作用：MySQL NewsEvent*/NewsIndicator*/Article/ProcessedArticle、Mongo 内容、Redis 缓存与聚类恢复队列、LLM/向量模型。采集→清洗→抽取/分类/去重→索引/outbox 仍有 Nest 消费者。

真实剩余缺口：新闻源 source/batch/recommended/hottest-analysis 读取可访问上游或模型；指标 refresh Mutation、LLM backfill、流水线 worker/outbox 仍需独立迁移。

`newsEventBrief` 证据：Go [newsevents.newsEventBrief](../../../../apps/api-go/internal/graphqlread/newsevents/brief.go) 在缓存 miss 或 forceRefresh 时直接返回 Internal server error，没有调用模型或写 briefV1；Nest [NewsEventBriefService](../../../../apps/api/src/modules/news-events/news-event-brief.service.ts) 调 generateBriefWithLlm 并更新 metadata。这是尚未实现，不能只标成“外部验证未核实”。它仍计入 root 注册覆盖，业务覆盖必须记为部分。与公共门户 publicportal 的已实现模型冷路径是两套实现，不能相互替代。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[news-events](../../../../apps/api/src/modules/news-events)、[news-indicator](../../../../apps/api/src/modules/news-indicator)、[news-pipeline](../../../../apps/api/src/modules/news-pipeline)、[news-aggregator](../../../../apps/api/src/modules/news-aggregator)、[news-signals](../../../../apps/api/src/modules/news-signals)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithNewsIndicators](../../../../apps/api-go/internal/legacyproxy/news_indicator_routes.go) | `API_GO_NEWS_INDICATORS_MODE` | [newsindicator](../../../../apps/api-go/internal/newsindicator) | `legacy` |
| [WithNewsnowClusteringOps](../../../../apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go) | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE` | [newsnowclusteringops](../../../../apps/api-go/internal/newsnowclusteringops) | `legacy` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 17：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/news-aggregator/domestic-opinion-index` | items.read | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `getDomesticOpinionIndex` | WithNewsnowClusteringOps |
| `GET /api/news-aggregator/hottest-analysis` | items.read | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `getHottestAnalysis` | Nest；尚未接管 |
| `GET /api/news-aggregator/metadata` | 公开 | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `getMetadata` | WithNewsnowClusteringOps |
| `GET /api/news-aggregator/recommended` | items.read | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `getRecommendedFeed` | Nest；尚未接管 |
| `GET /api/news-aggregator/resolve` | 公开 | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `resolveByUrl` | WithNewsnowClusteringOps |
| `GET /api/news-aggregator/source` | 公开 | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `getSource` | Nest；尚未接管 |
| `POST /api/news-aggregator/sources/batch` | 公开 | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `getSourcesBatch` | Nest；尚未接管 |
| `POST /api/news-aggregator/sources/order` | items.read | [news-aggregator.controller.ts](../../../../apps/api/src/modules/news-aggregator/news-aggregator.controller.ts) · `getPersonalizedSourcesOrder` | WithNewsnowClusteringOps |
| `GET /api/news-indicator/associations` | dashboards.read | [news-indicator.controller.ts](../../../../apps/api/src/modules/news-indicator/news-indicator.controller.ts) · `listAssociations` | WithNewsIndicators |
| `GET /api/news-indicator/associations/:id` | dashboards.read | [news-indicator.controller.ts](../../../../apps/api/src/modules/news-indicator/news-indicator.controller.ts) · `getAssociation` | WithNewsIndicators |
| `POST /api/news-indicator/refresh` | settings.manage | [news-indicator.controller.ts](../../../../apps/api/src/modules/news-indicator/news-indicator.controller.ts) · `refresh` | WithNewsIndicators |
| `GET /api/system-settings/news-events/clustering/failures` | settings.manage | [news-event-clustering-admin.controller.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts) · `listFailures` | WithNewsnowClusteringOps |
| `POST /api/system-settings/news-events/clustering/failures/:groupId/ignore` | settings.manage | [news-event-clustering-admin.controller.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts) · `ignoreFailure` | WithNewsnowClusteringOps |
| `POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill` | settings.manage | [news-event-clustering-admin.controller.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts) · `llmBackfill` | Nest；尚未接管 |
| `POST /api/system-settings/news-events/clustering/failures/:groupId/vector-backfill` | settings.manage | [news-event-clustering-admin.controller.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts) · `vectorBackfill` | WithNewsnowClusteringOps |
| `GET /api/system-settings/news-events/clustering/overview` | settings.manage | [news-event-clustering-admin.controller.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts) · `getOverview` | WithNewsnowClusteringOps |
| `GET /api/system-settings/news-events/clustering/readiness` | settings.manage | [news-event-clustering-admin.controller.ts](../../../../apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts) · `getReadiness` | WithNewsnowClusteringOps |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `refreshNewsIndicatorAssociations` | settings.manage | [news-indicator.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-indicator.resolver.ts) · `refreshNewsIndicatorAssociations` | Nest；未注册 |
| Query `eventGroups` | items.read | [topics.resolver.ts](../../../../apps/api/src/graphql/resolvers/topics.resolver.ts) · `eventGroups` | [newsevents.Register](../../../../apps/api-go/internal/graphqlread/newsevents/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_NEWS_EVENTS_MODE` |
| Query `newsEvent` | items.read | [news-events.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-events.resolver.ts) · `newsEvent` | [newsevents.Register](../../../../apps/api-go/internal/graphqlread/newsevents/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_NEWS_EVENTS_MODE` |
| Query `newsEventBrief` | items.read | [news-events.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-events.resolver.ts) · `newsEventBrief` | [newsevents.Register](../../../../apps/api-go/internal/graphqlread/newsevents/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_NEWS_EVENTS_MODE`  **部分：冷生成/forceRefresh 未实现** |
| Query `newsEventReferencedArticles` | items.read | [news-events.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-events.resolver.ts) · `newsEventReferencedArticles` | [newsevents.Register](../../../../apps/api-go/internal/graphqlread/newsevents/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_NEWS_EVENTS_MODE` |
| Query `newsEventSourcePolicySyncStatus` | items.read | [news-events.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-events.resolver.ts) · `newsEventSourcePolicySyncStatus` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsEvents` | items.read | [news-events.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-events.resolver.ts) · `newsEvents` | [newsevents.Register](../../../../apps/api-go/internal/graphqlread/newsevents/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_NEWS_EVENTS_MODE` |
| Query `newsIndicatorAssociation` | dashboards.read | [news-indicator.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-indicator.resolver.ts) · `newsIndicatorAssociation` | [newsindicators.Register](../../../../apps/api-go/internal/graphqlread/newsindicators/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_NEWS_INDICATORS_MODE` |
| Query `newsIndicatorAssociations` | dashboards.read | [news-indicator.resolver.ts](../../../../apps/api/src/graphql/resolvers/news-indicator.resolver.ts) · `newsIndicatorAssociations` | [newsindicators.Register](../../../../apps/api-go/internal/graphqlread/newsindicators/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_NEWS_INDICATORS_MODE` |
| Query `topicGroups` | items.read | [topics.resolver.ts](../../../../apps/api/src/graphql/resolvers/topics.resolver.ts) · `topicGroups` | [newsevents.Register](../../../../apps/api-go/internal/graphqlread/newsevents/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_NEWS_EVENTS_MODE` |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#33](https://github.com/wei500L/newwei/pull/33) | [ee0d31ddebac](https://github.com/wei500L/newwei/commit/ee0d31ddebacf19ad6d79a1a68107443712b70e8) | ✨ feat(api-go): 用独立开关登记新闻事件六个只读查询 |
| [#45](https://github.com/wei500L/newwei/pull/45) | [3dad6ac441e9](https://github.com/wei500L/newwei/commit/3dad6ac441e99e595485eb11aedd1c0474acbe32) | ✨ feat(api-go): 迁移新闻指标关联分析 3 条 HTTP 与 2 个 GraphQL 只读 query |
| [#49](https://github.com/wei500L/newwei/pull/49) | [0dbfc0d0e15a](https://github.com/wei500L/newwei/commit/0dbfc0d0e15a43ac7863dc97704111a1fa886002) | ✨ feat(api-go): NewsNow 本地计算与聚类失败管理 9 条接口迁入 Go（开关 API_GO_NEWSNOW_CLUSTERING_OPS_MODE） |

- [docs/refactor/go-news-events-read.md](../../go-news-events-read.md)

- [docs/refactor/go-news-indicators.md](../../go-news-indicators.md)

- [docs/refactor/go-newsnow-clustering-ops.md](../../go-newsnow-clustering-ops.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
