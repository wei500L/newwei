# analysis · 分析协作工作区与导出

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

保存视图、看板/列/任务、笔记与评论共 23 条 HTTP 已接管；看板列表/详情在缺默认看板时会创建，不能规划为无写入读接口。analysisResults 只读取历史。

关键数据与副作用：MySQL Analysis*（事务、讨论清理、评论计数）、Mongo 历史结果、Redis/BullMQ analysis、LLM。exports 三入口仍为 Nest，导出权限/查询过滤以 Controller 和导出服务为准。

真实剩余缺口：三条导出、requestCorrelationAnalysis/requestAnomalyExplanation/requestGeoTransportAnalysis、analysisEvents Subscription 与 analysis worker 尚在 Nest。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：首次基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；14:22 MSK 最新 main [CI 39122519950](https://github.com/wei500L/newwei/actions/runs/39122519950) 已复核为 success，head 与本页3cedce9a基线一致。#68 的 PR head a1c96172 普通 CI 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[analysis](../../../../apps/api/src/modules/analysis)、[analysis-workspace](../../../../apps/api/src/modules/analysis-workspace)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithAnalysisBoards](../../../../apps/api-go/internal/legacyproxy/analysis_routes.go) | `API_GO_ANALYSIS_BOARDS_MODE` | [analysisboards](../../../../apps/api-go/internal/analysisboards) / [analysiscollab](../../../../apps/api-go/internal/analysiscollab) / [analysistasks](../../../../apps/api-go/internal/analysistasks) | `legacy` |
| [WithAnalysisThreads](../../../../apps/api-go/internal/legacyproxy/analysis_routes.go) | `API_GO_ANALYSIS_THREADS_MODE` | [analysisthreads](../../../../apps/api-go/internal/analysisthreads) | `legacy` |
| [WithAnalysisViews](../../../../apps/api-go/internal/legacyproxy/analysis_routes.go) | `API_GO_ANALYSIS_VIEWS_MODE` | [analysisviews](../../../../apps/api-go/internal/analysisviews) | `legacy` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 26：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/analysis/boards` | analysis.read | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `listBoards` | WithAnalysisBoards |
| `POST /api/analysis/boards` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `createBoard` | WithAnalysisBoards |
| `DELETE /api/analysis/boards/:boardId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `archiveBoard` | WithAnalysisBoards |
| `GET /api/analysis/boards/:boardId` | analysis.read | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `getBoard` | WithAnalysisBoards |
| `PATCH /api/analysis/boards/:boardId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `updateBoard` | WithAnalysisBoards |
| `POST /api/analysis/boards/:boardId/columns` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `createColumn` | WithAnalysisBoards |
| `POST /api/analysis/boards/:boardId/columns/reorder` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `reorderColumns` | WithAnalysisBoards |
| `POST /api/analysis/boards/:boardId/tasks` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `createTask` | WithAnalysisBoards |
| `DELETE /api/analysis/columns/:columnId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `deleteColumn` | WithAnalysisBoards |
| `PATCH /api/analysis/columns/:columnId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `updateColumn` | WithAnalysisBoards |
| `DELETE /api/analysis/comments/:commentId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `deleteComment` | WithAnalysisThreads |
| `PATCH /api/analysis/comments/:commentId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `updateComment` | WithAnalysisThreads |
| `POST /api/analysis/exports/events` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `exportEvents` | Nest；尚未接管 |
| `POST /api/analysis/exports/items` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `exportItems` | Nest；尚未接管 |
| `POST /api/analysis/exports/search` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `exportSearch` | Nest；尚未接管 |
| `DELETE /api/analysis/tasks/:taskId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `deleteTask` | WithAnalysisBoards |
| `PATCH /api/analysis/tasks/:taskId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `updateTask` | WithAnalysisBoards |
| `POST /api/analysis/tasks/:taskId/move` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `moveTask` | WithAnalysisBoards |
| `GET /api/analysis/threads/:subjectType/:subjectId` | analysis.read | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `getThread` | WithAnalysisThreads |
| `PUT /api/analysis/threads/:subjectType/:subjectId` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `upsertThread` | WithAnalysisThreads |
| `POST /api/analysis/threads/:subjectType/:subjectId/comments` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `createComment` | WithAnalysisThreads |
| `GET /api/analysis/views` | analysis.read | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `listViews` | WithAnalysisViews |
| `POST /api/analysis/views` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `createView` | WithAnalysisViews |
| `DELETE /api/analysis/views/:id` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `deleteView` | WithAnalysisViews |
| `GET /api/analysis/views/:id` | analysis.read | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `getView` | WithAnalysisViews |
| `PATCH /api/analysis/views/:id` | analysis.write | [analysis-workspace.controller.ts](../../../../apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts) · `updateView` | WithAnalysisViews |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `requestAnomalyExplanation` | analysis.run | [analysis.resolver.ts](../../../../apps/api/src/graphql/resolvers/analysis.resolver.ts) · `requestAnomalyExplanation` | Nest；未注册 |
| Mutation `requestCorrelationAnalysis` | analysis.run | [analysis.resolver.ts](../../../../apps/api/src/graphql/resolvers/analysis.resolver.ts) · `requestCorrelationAnalysis` | Nest；未注册 |
| Mutation `requestGeoTransportAnalysis` | analysis.run | [analysis.resolver.ts](../../../../apps/api/src/graphql/resolvers/analysis.resolver.ts) · `requestGeoTransportAnalysis` | Nest；未注册 |
| Query `analysisResults` | analysis.read | [analysis.resolver.ts](../../../../apps/api/src/graphql/resolvers/analysis.resolver.ts) · `analysisResults` | [history.Register](../../../../apps/api-go/internal/graphqlread/history/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Subscription `analysisEvents` | analysis.read | [analysis.resolver.ts](../../../../apps/api/src/graphql/resolvers/analysis.resolver.ts) · `analysisEventsSubscription` | Nest Redis backplane；Go 整份回退 |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#31](https://github.com/wei500L/newwei/pull/31) | [48423c28b5bd](https://github.com/wei500L/newwei/commit/48423c28b5bda297efbbcee9e706832f931ea780) | ✨ feat(api-go): 将分析工作台视图、看板与讨论迁入 Go |
| [#32](https://github.com/wei500L/newwei/pull/32) | [7d25a90a03c8](https://github.com/wei500L/newwei/commit/7d25a90a03c8924b637b816595d08c15bcd320dd) | ✨ feat(api-go): GraphQL 读查询试点接管告警、历史与经济数据 |

- [docs/refactor/go-analysis-collaboration.md](../../go-analysis-collaboration.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
