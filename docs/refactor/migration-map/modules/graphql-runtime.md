# GraphQL 传输、生产注册与返回模型

2026-10-19条目入库候选限定续核（main91e759b4）：[ITEMS-INGEST-001](../tasks/ITEMS-INGEST-001.md) reserved，五Mutation及完整[提示词](../tasks/ITEMS-INGEST-001.prompt.md)见task。拟独立写模式接线、Item/CrawlTask模型窄注册、复用现有选择集投影，补ItemModel五字段items.read门禁；两crawl导入根为ALL，不更改contract/exec（该公共扩展仍由四订阅任务占用）。根/返回字段齐备后整份预规划再写，不依赖READ开关；当前main仍未注册本五写，不增加完成数。

2026-10-19仅四订阅限定续核，origin/main `91e759b449c4511dc96d86539ea0eb258754d07e`：当前Subscription/upgrade仍由Nest执行；[GRAPHQL-SUBSCRIPTIONS-001](../tasks/GRAPHQL-SUBSCRIPTIONS-001.md) reserved，[完整提示词](../tasks/GRAPHQL-SUBSCRIPTIONS-001.prompt.md)在Ready规划#93发布，未实施/不计main。alertEvents/alerts.read、analysisEvents/analysis.read、assistantEvents/**assistant.read**、queueEvents/queue.manage，均无参数；新独立WS模式拟默认legacy。任务包含三Redis通道、BullMQ广播读、强类型逐事件投影/取消及同WS非本批operation整份legacy，HTTP订阅仍legacy。已核最新main有alerts/history.RegisterModels和items选择元数据，可独立复用无需READ/Mongo；此事实覆盖下方旧模型复用限制，但不刷新历史全域表/开关组合为新验收。详情见task；#92审计/NewsNow不占本批核心包，共享main/config增量取并集。

**覆盖更新（2026-10-21，基线 `dcbe563b`）**：SDL 根字段 **77 Query / 57 Mutation / 4 Subscription = 138**，Go 生产 Registry 注册 **138/138**（C=0，Subscription 4/4）；本页下方“6 个未注册 Query / 36 个未注册 Mutation / 4 个未注册 Subscription”与“不能关闭 GAP-GQL-001”的结论是 `3cedce9a` 快照，已经过时：GAP-GQL-001 已按 `dcbe563b` 关闭（路由/资源/handler 三处均含设置写），逐字段证据与开关组合见 [README 覆盖表](../README.md#注册覆盖) 与 [执行权审计](../../cutover/ownership-audit.md)。历史段落原样保留。

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
| [itemsreading.RegisterList](../../../../apps/api-go/internal/graphqlread/itemsreading/list.go)（本批候选，PR 未合） | 1 | 0 | 再叠加 `API_GO_GRAPHQL_ITEMS_LIST_MODE` | 注册 `ItemConnection`/`ItemEdge`，`PageInfo` 复用已注册类型；本页批量嵌套投影 |
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

最新 main 普通 CI 39122519950 已于14:22 MSK 复核为 success；CI 成功仍不代表每种开关组合、每个所选返回字段或外部依赖已做额外集成。实际部署、配置与流量未核实。

本文 SETTINGS_WRITE / READ / ORG_ACCESS_WRITE 是 `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` / `API_GO_GRAPHQL_READ_MODE` / `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` 的简写，所有组合以当前 main.run 实际接线为准。

## 本轮有意义的组合复核

2026-10-18 14:37–14:42 MSK，以本页 `3cedce9a` 做静态控制流/模型装配核对；不是实际启动或逐字段运行契约验证。路由声明在 main 681，资源 OR 在877，handler 在1418，模型分支在1439–1509；[config.Load](../../../../apps/api-go/internal/config/config.go) 2468–2485分别校验总读与两写。缩写 A=MySQL/JWT/Redis，M=Mongo；全部需要真实凭据/可用服务才能运行，静态允许不保证连通。

| 有意义的模式分支 | 路由 / handler / 初始化 | 注册与返回模型结论 |
|---|---|---|
| READ/ORG_ACCESS_WRITE/SETTINGS_WRITE 均 legacy | /graphql legacy，无 handler；可选 DATABASE_URL 的池不等于鉴权已创建 | 不装配业务 root；调用仍 Nest |
| 仅读子模式 go，READ=legacy，两写 legacy | 没有因此创建 GraphQL handler/路由 | 所有读子注册均被 READ 外层关闭；items/news-indicators 复用的 HTTP 模式可能单独初始化 A+M/A，不改变 GraphQL 选择 |
| 仅 ORG_ACCESS_WRITE=go | 路由 go、handler、A；无需 M | 8 Mutation；workspace.RegisterModels含嵌套模型/字段权限，不注册 workspace Query |
| 仅 SETTINGS_WRITE=go，其余所有认证接管关闭 | config 只要求 A，不要求M；main 漏该资源 OR，handler 前检查失败，run返回错误 | 未进入监听；不是“自动回 Nest”，见 GAP-GQL-001 |
| SETTINGS_WRITE=go，READ/ORG_ACCESS_WRITE=legacy，其他 HTTP go 补足 A | handler可构造，但graphqlRouteMode仍legacy | settings返回模型已注册也不可从 /graphql 到达，业务由 Nest 执行 |
| READ=go，读子模式均legacy，两写legacy | 路由/handler A+M | 基础16 Query（alerts4/history6/economic6）；子模式不默认跟随打开 |
| READ=go + SETTINGS_WRITE=go，SETTINGS_CRAWL_READ=legacy / go | A+M；两种都到 handler | legacy时单独RegisterSettingsModelTypes；go时由settingscrawl.Register注册20读及模型，writer跳过模型重复装配 |
| READ=legacy，ORG_ACCESS_WRITE=go + SETTINGS_WRITE=go | 路由/handler/A，无需M | 21 Mutation；workspace与settingscrawl的返回模型集合分别装配；不因此打开Query |
| READ=go + WORKSPACE_READ=go + ORG_ACCESS_WRITE=go | A+M | workspace.Register已装配模型，org写跳过RegisterModels；User/Role/Membership嵌套字段权限保留 |
| READ=go + ITEMS_READING=go，WORKSPACE_READ=legacy / go | A+M；items HTTP模式也接管其HTTP | items模型在两种分支都注册；workspace没开时补三个ProcessedItem类型，开时复用。未逐字段运行投影 |
| 全部读子模式与两写go | A+M | 71 Query+21 Mutation；newsindicators复用economic先注册的EconomicDataItemModel，settings/org模型按上述分支取并集。newsEventBrief仍部分实现，不由模型齐备自动补全 |
| 任一组合的operation包含未接管root/所选嵌套字段 | Handler先PlanDocument→operationSupported/selectionSupported；在Execute前整份legacy | 不执行前面的Go mutation再回退；解析/验证错误直接响应与业务回退分开。Subscription/协议升级仍Nest |

模型根与嵌套检查的事实源是各 Register 的 RegisterType、模型 graphql tags 与 exec.walk 的递归检查。Registry.RegisterRoot/RegisterMutation 重复名会 panic；RegisterType 会覆盖同名投影而不证明兼容，因此“能启动”不足以证明两个类型定义一致。本轮重点检查 workspace/org、settingscrawl/settingswrite、items/workspace、newsindicators/economic 的装配分支与必要字段权限；尚未对全部模型每个所选字段逐项做两端契约或运行比对，详见 [AUDIT](../AUDIT.md)。

字段权限：workspace.RegisterModels 同时调用 registerFieldPermissions；settings写根使用 settings.manage 且 assertAdmin，不能只注册返回模型就省略业务门禁。ItemModel.meta/raw/processed/preview 的当前读根已有items.read，后续新写若复用必须保留字段权限含义。未知字段导致回退与无权限导致FORBIDDEN不能混为一类。

### PR #70 的候选增量（不计 main）

14:49 MSK，head `200ab9440bc2c4d217f429999468c90b81a968e0`，已正常 merge #68：新增 WORKSPACE_WRITE 独立路由/资源/handler与8写，alerts/history拆RegisterModels；workspaceModelsRegistered避免组织写/工作台写重复装配。设置写资源 OR 已补，但路由 OR/无效DSN判断仍漏设置写，OBS-DATA-001空错误分支也未改。故当前不能关闭 main 的 GAP-GQL-001，也不能给 main 加8写；#70未逐字段验收范围见任务文件。

14:56 再核 #70 head为`adb765d0180e8b34910181e8c6fde8be400a2dff`，相对200ab944仅报告文档追加；上述业务装配结论不变，CI按各自head分别记录。
