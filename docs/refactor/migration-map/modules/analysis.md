# analysis · 分析协作工作区与导出

2026-10-19分析执行限定续核（main91e759b4）：新增[ANALYSIS-RUNS-001](../tasks/ANALYSIS-RUNS-001.md) reserved，[完整提示词](../tasks/ANALYSIS-RUNS-001.prompt.md)在Ready规划#93发布，占三analysis.run Mutation与analysis队列完整Go生产/消费/统计和Geo/真实模型SSE/结果与通知。main仍0/3写、Nest执行不变；analysisResults不重迁，analysisEvents传输归Ready #95，search CSV归ARCHIVE-READING-001。包含具体GAP-ANALYSIS-001中断running恢复与Mongo有界top30改善，双开关默认legacy、英文文件注释、禁止占位。仅本链深入，不重审协作域或提前计Go覆盖。

2026-10-19限定续核（main91e759b4）：items/events两CSV已合main（原ANALYSIS-EXPORT-001，历史合并/CI见task索引），不重迁；剩余POST /api/analysis/exports/search整路的items/headlines两模式现由[ARCHIVE-READING-001](../tasks/ARCHIVE-READING-001.md) reserved，和三归档Query/准备producer成一条完整链，[提示词](../tasks/ARCHIVE-READING-001.prompt.md)在Ready规划#93发布。本次只深读search契约/归档调用与已迁导出复用，未重新审阅其他analysis写/worker；下方旧全域统计/表为历史快照。

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

保存视图、看板/列/任务、笔记与评论共 23 条 HTTP 已接管；看板列表/详情在缺默认看板时会创建，不能规划为无写入读接口。analysisResults 只读取历史。

关键数据与副作用：MySQL Analysis*（事务、讨论清理、评论计数）、Mongo历史结果、Redis/BullMQ analysis、LLM。当前items/events CSV已Go；search仍Nest（analysis.write，headlines经归档可入准备队列），权限/过滤以Controller和服务为准。

当前剩余导出为search整路；requestCorrelationAnalysis/requestAnomalyExplanation/requestGeoTransportAnalysis与analysis worker仍Nest，analysisEvents由GRAPHQL-SUBSCRIPTIONS-001占用、未合main，不在新归档任务内。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#analysis) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[analysis](../../../../apps/api/src/modules/analysis)、[analysis-workspace](../../../../apps/api/src/modules/analysis-workspace)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领（2026-10-18，main90765633）：[ANALYSIS-EXPORT-001](../tasks/ANALYSIS-EXPORT-001.md) reserved，[完整提示词](../tasks/ANALYSIS-EXPORT-001.prompt.md)在规划#80发布，负责POST exports/items与events的5000选择/完整投影/CSV及等价去重优化；无本批业务实现/注册新增。exports/search完整保留Nest，归档准备/analysis请求与worker不在本批；其他并行任务/文件边界见[认领核对记录](../tasks/README.md)。

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

## 导出候选的实际边界

15:01–15:08续读Nest导出，main3cedce9a未变：items/events可先组成两路同步完整批次；search的headlines模式循环归档digest并可能触发准备队列，第三路整迁依赖归档执行边界。当前5000行上限、read-model/事件联查、CSV公式处理与逐vertical游标见 [BL-08](../BACKLOG.md#bl-08--analysis--三个-csv-导出)；不把Nest内部实现计入Go迁移。

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#31](https://github.com/wei500L/newwei/pull/31) | [48423c28b5bd](https://github.com/wei500L/newwei/commit/48423c28b5bda297efbbcee9e706832f931ea780) | ✨ feat(api-go): 将分析工作台视图、看板与讨论迁入 Go |
| [#32](https://github.com/wei500L/newwei/pull/32) | [7d25a90a03c8](https://github.com/wei500L/newwei/commit/7d25a90a03c8924b637b816595d08c15bcd320dd) | ✨ feat(api-go): GraphQL 读查询试点接管告警、历史与经济数据 |

- [docs/refactor/go-analysis-collaboration.md](../../go-analysis-collaboration.md)

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
