# workspace · 通知、看板与告警交互

最近核对：2026-10-18 13:51 MSK（UTC+03:00）；`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

看板统计、War Map、Spacetime 和 SSE 已实现。GraphQL 通知/看板/情感及四个告警读 root 已注册；alertRules 和全部交互写尚无生产注册。8 个交互写已预留。

关键数据与副作用：MySQL Dashboard/Alert*/ProcessedArticle/EconomicData*；Mongo 地理与运输状态；Redis 信号/快照；Nominatim、OpenSky、翻译模型。SSE 周期刷新可能访问上游，缓存读取与主动刷新分开。

真实剩余缺口：alertRules Query、告警规则写入/触发及订阅仍为 Nest。交互 8 写由历史任务占用，deleteAssistantRun 不属于这批；告警 worker 与渠道投递单列异步域。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[notifications](../../../../apps/api/src/modules/notifications)、[dashboard](../../../../apps/api/src/modules/dashboard)、[alerts](../../../../apps/api/src/modules/alerts)、[sentiment](../../../../apps/api/src/modules/sentiment)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：[WORKSPACE-WRITE-001](../tasks/WORKSPACE-WRITE-001.md)（in_progress；14:03 MSK 出现 config/alerts 本地开发证据，执行活动未核实）。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithDashboardCharts](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_CHARTS_MODE` | [dashboardcharts](../../../../apps/api-go/internal/dashboardcharts) | `go` |
| [WithDashboardSpacetimeGeo](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_SPACETIME_GEO_MODE` | [dashboardspacetime](../../../../apps/api-go/internal/dashboardspacetime) | `未注入；按 config 缺省` |
| [WithDashboardSpacetimePropagation](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE` | [dashboardspacetime](../../../../apps/api-go/internal/dashboardspacetime) | `未注入；按 config 缺省` |
| [WithDashboardStats](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_STATS_MODE` | [dashboardstats](../../../../apps/api-go/internal/dashboardstats) | `go` |
| [WithDashboardStream](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_STREAM_MODE` | [dashboardstream](../../../../apps/api-go/internal/dashboardstream) | `未注入；按 config 缺省` |
| [WithDashboardWarMap](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_WAR_MAP_MODE` | [dashboardwarmap](../../../../apps/api-go/internal/dashboardwarmap) | `go` |
| [WithDashboardWarMapLayers](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE` | [dashboardwarmap](../../../../apps/api-go/internal/dashboardwarmap) | `未注入；按 config 缺省` |
| [WithDashboardWarMapTransport](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE` | [dashboardwarmap](../../../../apps/api-go/internal/dashboardwarmap) | `未注入；按 config 缺省` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 13：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/dashboard/financial-candlestick` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `financialCandlestick` | WithDashboardCharts |
| `GET /api/dashboard/sector-heatmap` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `sectorHeatmap` | WithDashboardCharts |
| `GET /api/dashboard/spacetime/geo-heatmap` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `spacetimeGeoHeatmap` | WithDashboardSpacetimeGeo |
| `GET /api/dashboard/spacetime/geo-heatmap/articles` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `spacetimeGeoHeatmapArticles` | WithDashboardSpacetimeGeo |
| `GET /api/dashboard/spacetime/propagation` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `spacetimePropagation` | WithDashboardSpacetimePropagation |
| `GET /api/dashboard/spacetime/propagation/articles` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `spacetimePropagationArticles` | WithDashboardSpacetimePropagation |
| `GET /api/dashboard/stats` | items.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `stats` | WithDashboardStats |
| `GET /api/dashboard/stream` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `dashboardStream` | WithDashboardStream |
| `GET /api/dashboard/war-map/events` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `warMapEvents` | WithDashboardWarMap |
| `GET /api/dashboard/war-map/geojson` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `warMapGeoJson` | WithDashboardCharts |
| `GET /api/dashboard/war-map/layers` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `warMapLayers` | WithDashboardWarMapLayers |
| `GET /api/dashboard/war-map/news-markers` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `warMapNewsMarkers` | WithDashboardWarMap |
| `GET /api/dashboard/war-map/transport-detail` | dashboards.read | [dashboard.controller.ts](../../../../apps/api/src/modules/dashboard/dashboard.controller.ts) · `warMapTransportDetail` | WithDashboardWarMapTransport |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `createAlertChannel` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `createAlertChannel` | Nest；未注册 |
| Mutation `deleteAlertChannel` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `deleteAlertChannel` | Nest；未注册 |
| Mutation `deleteAlertRule` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `deleteAlertRule` | Nest；未注册 |
| Mutation `deleteDashboard` | dashboards.write | [dashboard.resolver.ts](../../../../apps/api/src/graphql/resolvers/dashboard.resolver.ts) · `deleteDashboard` | Nest；未注册 |
| Mutation `markAllNotificationsRead` | 已认证 | [notification.resolver.ts](../../../../apps/api/src/graphql/resolvers/notification.resolver.ts) · `markAllNotificationsRead` | Nest；未注册 |
| Mutation `markNotificationRead` | 已认证 | [notification.resolver.ts](../../../../apps/api/src/graphql/resolvers/notification.resolver.ts) · `markNotificationRead` | Nest；未注册 |
| Mutation `triggerAlertRule` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `triggerAlertRule` | Nest；未注册 |
| Mutation `updateAlertChannel` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `updateAlertChannel` | Nest；未注册 |
| Mutation `updateAlertEventStatus` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `updateAlertEventStatus` | Nest；未注册 |
| Mutation `upsertAlertRule` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `upsertAlertRule` | Nest；未注册 |
| Mutation `upsertDashboard` | dashboards.write | [dashboard.resolver.ts](../../../../apps/api/src/graphql/resolvers/dashboard.resolver.ts) · `upsertDashboard` | Nest；未注册 |
| Query `alertChannels` | alerts.read | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `alertChannels` | [alerts.Register](../../../../apps/api-go/internal/graphqlread/alerts/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `alertEventReplay` | alerts.read | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `alertEventReplay` | [alerts.Register](../../../../apps/api-go/internal/graphqlread/alerts/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `alertEvents` | alerts.read | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `alertEvents` | [alerts.Register](../../../../apps/api-go/internal/graphqlread/alerts/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `alertRuleTuningSuggestion` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `alertRuleTuningSuggestion` | [alerts.Register](../../../../apps/api-go/internal/graphqlread/alerts/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `alertRules` | alerts.read | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `alertRules` | Nest；未注册 |
| Query `dashboards` | dashboards.read | [dashboard.resolver.ts](../../../../apps/api/src/graphql/resolvers/dashboard.resolver.ts) · `dashboards` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `entitySentimentSeries` | dashboards.read | [sentiment.resolver.ts](../../../../apps/api/src/graphql/resolvers/sentiment.resolver.ts) · `entitySentimentSeries` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `notifications` | 已认证 | [notification.resolver.ts](../../../../apps/api/src/graphql/resolvers/notification.resolver.ts) · `notifications` | [history.Register](../../../../apps/api-go/internal/graphqlread/history/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `queueStats` | queue.manage | [dashboard.resolver.ts](../../../../apps/api/src/graphql/resolvers/dashboard.resolver.ts) · `queueStats` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `topicSentimentSeries` | dashboards.read | [sentiment.resolver.ts](../../../../apps/api/src/graphql/resolvers/sentiment.resolver.ts) · `topicSentimentSeries` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `unreadNotificationCount` | 已认证 | [notification.resolver.ts](../../../../apps/api/src/graphql/resolvers/notification.resolver.ts) · `unreadNotificationCount` | [history.Register](../../../../apps/api-go/internal/graphqlread/history/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Subscription `alertEvents` | alerts.read | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `alertEventsSubscription` | Nest Redis backplane；Go 整份回退 |
| Subscription `queueEvents` | queue.manage | [dashboard.resolver.ts](../../../../apps/api/src/graphql/resolvers/dashboard.resolver.ts) · `queueEventsSubscription` | Nest Redis backplane；Go 整份回退 |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#22](https://github.com/wei500L/newwei/pull/22) | [a931a1794fd5](https://github.com/wei500L/newwei/commit/a931a1794fd5c704ade692785a6e54b7d8503872) | feat(api-go): Dashboard stats 由 Go 独立响应，并收紧平台指标读取 |
| [#23](https://github.com/wei500L/newwei/pull/23) | [c9275b75135c](https://github.com/wei500L/newwei/commit/c9275b75135c410bd5ce1241e90db204708be153) | feat(api-go): Dashboard 三个只读图表由 Go 接管 |
| [#24](https://github.com/wei500L/newwei/pull/24) | [0a9d66c8be48](https://github.com/wei500L/newwei/commit/0a9d66c8be486634459dbdc973f164400aac35c3) | feat(api-go): War Map 事件与新闻标记由 Go 接管 |
| [#25](https://github.com/wei500L/newwei/pull/25) | [5030c01ab9e7](https://github.com/wei500L/newwei/commit/5030c01ab9e74fec250e9d8fdd921c2805ca139e) | feat(api-go): War Map transport-detail 与 layers 由 Go 接管 |
| [#26](https://github.com/wei500L/newwei/pull/26) | [47e9ae9ca276](https://github.com/wei500L/newwei/commit/47e9ae9ca2766c6879fbc542342c65e592b35f3a) | feat(api-go): Spacetime 热力图与传播图由 Go 接管 |
| [#28](https://github.com/wei500L/newwei/pull/28) | [0e3deec2e53b](https://github.com/wei500L/newwei/commit/0e3deec2e53b64c362a073c4996f248e5116c6df) | ✨ feat(api-go): Dashboard SSE 与认证版健康检查由 Go 接管 |
| [#29](https://github.com/wei500L/newwei/pull/29) | [146b4b3c1e90](https://github.com/wei500L/newwei/commit/146b4b3c1e902419b443f359facab7e5b565cd61) | 🔀 refactor(api): GraphQL 订阅经 Redis 跨实例投递 |
| [#32](https://github.com/wei500L/newwei/pull/32) | [7d25a90a03c8](https://github.com/wei500L/newwei/commit/7d25a90a03c8924b637b816595d08c15bcd320dd) | ✨ feat(api-go): GraphQL 读查询试点接管告警、历史与经济数据 |
| [#48](https://github.com/wei500L/newwei/pull/48) | [11c4c8a826a6](https://github.com/wei500L/newwei/commit/11c4c8a826a655da7fa1a81d0ac4b5d6cff0afc6) | ✨ feat(graphqlread): 迁移 workspace 12 个 GraphQL 只读 Query（Go） |

- [docs/refactor/go-graphql-workspace-read.md](../../go-graphql-workspace-read.md)

- [docs/refactor/graphql-subscriptions-multinode.md](../../graphql-subscriptions-multinode.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
