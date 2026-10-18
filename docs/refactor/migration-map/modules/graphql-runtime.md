# GraphQL 传输、生产注册与返回模型

核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[入口](../README.md)。本页是跨域事实，不是额外业务模块，不参与域表求和。

## 真实挂载与整份回退

Nest `ApiGraphqlModule` 挂载 `/graphql`，没有 `/api` 前缀；配置和 Resolver providers 见 [graphql.module.ts](../../../../apps/api/src/graphql/graphql.module.ts)。Go 精确 GET/POST/OPTIONS 由 [legacyproxy.WithGraphQLRead](../../../../apps/api-go/internal/legacyproxy/proxy.go) 进入 [Handler.ServeHTTP](../../../../apps/api-go/internal/graphqlread/handler.go)，main 的路由表当前仅在总读或组织写 go 时将 /graphql 交给 Go；handler 构造虽增加 settingsWriteGo，但路由/资源初始化尚漏该独立条件。参数更长路径、协议升级与未支持 operation 回 Nest。

[Engine.PlanDocument](../../../../apps/api-go/internal/graphqlread/exec/engine.go) 和 [operationSupported/selectionSupported](../../../../apps/api-go/internal/graphqlread/exec/walk.go) 在任何业务 resolver 执行前决定所有权：所选 operation 只要存在未注册 root、返回对象/所选字段不支持，就整份回退 Nest，不把多 root 操作拆到两边。解析/验证错误可能由 Go 协议层直接返回，不能把它计成业务已迁移。Mutation 串行执行的引擎能力也不等于 root 已注册。Subscription 根类型没有 Go executor，四个业务 Subscription 全部回退。

身份、限流、orgId、返回字段权限必须保持；APQ、深度/复杂度、缓存与 CORS 见 handler/policy，不由各域自建另一套协议框架。

## 生产 Registry 与开关组合

以下仅来自 [main.run](../../../../apps/api-go/cmd/api/main.go) 的 Register 调用和各生产 Register 实现（包括 settingswrite/service.go）；排除 *_test.go、SDL 声明和重复类型注册。

| 包/函数 | Query 数 | Mutation 数 | 必须为 go 的开关 | 模型与资源 |
|---|---|---|---|---|
| [alerts.Register](../../../../apps/api-go/internal/graphqlread/alerts/register.go) | 4 | 0 | `API_GO_GRAPHQL_READ_MODE` | Register 同时注册返回模型；总读路径初始化 MySQL/JWT/Redis/Mongo |
| [history.Register](../../../../apps/api-go/internal/graphqlread/history/register.go) | 6 | 0 | `API_GO_GRAPHQL_READ_MODE` | Register 同时注册返回模型；总读路径初始化 MySQL/JWT/Redis/Mongo |
| [economic.Register](../../../../apps/api-go/internal/graphqlread/economic/register.go) | 6 | 0 | `API_GO_GRAPHQL_READ_MODE` | Register 同时注册返回模型；总读路径初始化 MySQL/JWT/Redis/Mongo |
| [newsevents.Register](../../../../apps/api-go/internal/graphqlread/newsevents/register.go) | 6 | 0 | `API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_NEWS_EVENTS_MODE` | Register 同时注册返回模型；总读路径初始化 MySQL/JWT/Redis/Mongo |
| [newsindicators.Register](../../../../apps/api-go/internal/graphqlread/newsindicators/register.go) | 2 | 0 | `API_GO_GRAPHQL_READ_MODE + API_GO_NEWS_INDICATORS_MODE` | Register 同时注册返回模型；总读路径初始化 MySQL/JWT/Redis/Mongo |
| [kgimpact.Register](../../../../apps/api-go/internal/graphqlread/kgimpact/register.go) | 4 | 0 | `API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KG_IMPACT_MODE` | Register 同时注册返回模型；总读路径初始化 MySQL/JWT/Redis/Mongo |
| [knowledgegraph.Register](../../../../apps/api-go/internal/graphqlread/knowledgegraph/register.go) | 6 | 0 | `API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | Register 同时注册返回模型；总读路径初始化 MySQL/JWT/Redis/Mongo |
| [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go) | 12 | 0 | `API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` | RegisterModels + 字段权限；orgaccesswrite 共享 |
| [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go) | 20 | 0 | `API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | 设置/来源策略/采集/复核模型；含 OR 根权限 |
| [itemsreading.Register](../../../../apps/api-go/internal/graphqlread/itemsreading/register.go) | 5 | 0 | `API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE` | workspace 未开时补三个 processed-item 模型，保持类型投影可用 |
| [orgaccesswrite.Register](../../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go) | 0 | 8 | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE（独立）` | 只开写时不需总读/Mongo；workspace.RegisterModels 单独复用 |

| [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go) | 0 | 13 | `SETTINGS_WRITE=go`，当前还需 `READ=go OR ORG_ACCESS_WRITE=go` | settingscrawl.RegisterSettingsModelTypes 复用；独立路由/资源初始化缺口见设置域 |

所有当前 GraphQL 子模式默认 legacy，非法值启动失败；读子模式只有总读 go 才装配。只开组织写时 Query 仍走 Nest；GraphQL 顶层 OR、数据库/鉴权初始化与模型注册必须一起支持写独立性。设置写已合并，main 已识别开关但顶层独立接线有缺口，见[设置域](settings.md)；工作台写开关在 main 尚不存在。

## 必要字段权限与模型复用

- UserModel.primaryRoleId/isActive/emailVerified/lastLoginAt/roleIds 需要 users.read；RoleModel.permissions 需要 roles.read；MembershipModel.role/roles/user 需要 users.read。Nest [user.model.ts](../../../../apps/api/src/graphql/models/user.model.ts)、[rbac.model.ts](../../../../apps/api/src/graphql/models/rbac.model.ts) 与 Go [workspace.registerFieldPermissions](../../../../apps/api-go/internal/graphqlread/workspace/register.go) 对照。
- QueueStatsModel.counts/recentLogs 的 Nest 字段权限 queue.manage，以及 ItemModel.meta/raw/processed/rawPreview/processedPreview 的 items.read 见 [dashboard.model.ts](../../../../apps/api/src/graphql/models/dashboard.model.ts)、[item.model.ts](../../../../apps/api/src/graphql/models/item.model.ts)。当前 Go 对应 Query 根已有同权限保护；若新写 root 复用这些模型，须再次核对字段授权，不能假设根权限永远等价。
- knowledgeGraphEvidenceReviewQueue 允许 settings.manage **OR** knowledgegraph.review；crawl 导入与 createItemFromCrawlResult 使用 crawl.read **AND** items.write。不是字符串连接后任选。
- 返回模型不能只注册根对象；所有选中嵌套对象和字段必须有投影。orgaccesswrite 的八写复用 workspace 模型，itemsreading 按 workspace 是否已注册补充共享模型。只开写、读写同时开、其他子开关 legacy 三种路径都要读当前生产代码。

## 真实缺口与验证

6 个未注册 Query：`alertRules`、`archiveCalendar`、`archiveDetail`、`archiveDigest`、`crawlMetadata`、`items`。57 个 Mutation 里组织/角色/成员 8 写及设置 13 写已有生产 Register，共 21；设置写受上述额外顶层条件限制。其余 36 写未注册，其中工作台 8 写已占用；13 写不重复派发，剩余接线单列。4 个 Subscription：alertEvents、analysisEvents、assistantEvents、queueEvents，由 Nest Redis backplane 处理，详见[异步运行时](async-runtime.md)。

最新 main 普通 CI 在14:18快照仍进行中；此前 PR/main CI 成功也不代表每种开关组合、每个所选返回字段或外部依赖已做额外集成。实际部署、配置与流量未核实。

本文 SETTINGS_WRITE / READ / ORG_ACCESS_WRITE 是 `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` / `API_GO_GRAPHQL_READ_MODE` / `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` 的简写，所有组合以当前 main.run 实际接线为准。
