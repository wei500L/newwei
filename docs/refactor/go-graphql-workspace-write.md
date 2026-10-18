# 工作台交互 GraphQL 写入迁移（Go）

基线是 `origin/main` 的 `7fc17faa3dc5043537bad4038299d11fdba4758d`。本批把通知、看板与告警渠道/状态的 8 个 Mutation 迁到
`apps/api-go`，并同时修两个真实功能问题（Nest 与 Go 两侧一致）。

## 开关与回滚

- 新增 `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE`，只接受空串 / `legacy` / `go`，默认 `legacy`，非法值启动失败（错误文本含变量名）。
- 与 `API_GO_GRAPHQL_READ_MODE` **完全解耦**。四种组合：

  | READ | WORKSPACE_WRITE | 行为 |
  | --- | --- | --- |
  | `legacy` | `legacy` | GraphQL 全部走 NestJS |
  | `go` | `legacy` | Query 按既有子开关执行，这 8 个 Mutation 仍走 NestJS |
  | `legacy` | `go` | 只有这 8 个 Mutation 由 Go 执行，Query 仍走 NestJS |
  | `go` | `go` | 两类操作各按自己的注册与开关执行 |

- `go` 只需要 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`：**不要求 `MONGO_URI`**，不初始化任何只读域 Mongo service，不启动
  worker，不写队列，不发送邮件或 webhook。可独立开启：

  ```
  API_GO_GRAPHQL_READ_MODE=legacy
  API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=legacy
  API_GO_GRAPHQL_SETTINGS_WRITE_MODE=legacy
  API_GO_GRAPHQL_WORKSPACE_WRITE_MODE=go
  ```

- 生产 Web 入口仍是 `Web -> NestJS`，canary 保持关闭。回滚只把 `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` 改回 `legacy`；不改表、不改
  SDL、不改 Web、不改其他开关默认值。

## 迁入的 8 个 Mutation

| # | Mutation | 参数 | 返回 | 顶层权限 |
| --- | --- | --- | --- | --- |
| 1 | `markNotificationRead` | `id: String!` | `NotificationModel`（可空） | `AllowAuthenticated` |
| 2 | `markAllNotificationsRead` | 无 | `Boolean!` | `AllowAuthenticated` |
| 3 | `upsertDashboard` | `input: UpsertDashboardInput!` | `DashboardModel!` | `dashboards.write` |
| 4 | `deleteDashboard` | `id: String!` | `Boolean!` | `dashboards.write` |
| 5 | `createAlertChannel` | `input: AlertChannelInput!` | `AlertChannelModel!` | `alerts.manage` |
| 6 | `updateAlertChannel` | `input: UpdateAlertChannelInput!` | `AlertChannelModel!` | `alerts.manage` |
| 7 | `deleteAlertChannel` | `channelId: String!` | `Boolean!` | `alerts.manage` |
| 8 | `updateAlertEventStatus` | `input: UpdateAlertEventStatusInput!` | `AlertEventModel!` | `alerts.manage` |

通知两个 root 没有新增 `notifications.manage`；看板没有新增管理员门禁；告警没有改成 `settings.manage`。SDL、装饰器、方法签名与参数结构
未改动。身份、`orgId`、`userId` 一律来自既有鉴权上下文，输入无法覆盖。

未迁（仍回 NestJS）：`upsertAlertRule`、`deleteAlertRule`、`triggerAlertRule`、`alertRules` Query、`deleteAssistantRun`、Assistant/Analysis
请求任务、通知创建/投递 dispatcher、WebSocket/Subscription、告警扫描评估发送 worker、设置中心 13 个 Mutation，以及 items、archive、crawl
等剩余 Query/Mutation。

## 功能优化一：通知重复标记已读保留首次 readAt

原实现每次 `markRead` 都写 `readAt = new Date()`，而且用更新的 `affectedRows` 判断记录是否存在。

两侧现在都：

- 只更新 `readAt IS NULL` 的目标行（`id` + `orgId` + `userId` 同时限定）；
- 再按 `id` + `orgId` + `userId` 读回该行并返回模型，因此已读记录重复标记时仍返回模型，且 `readAt` 与 `updatedAt` 都不再被刷新；
- 他组织、同组织其他用户、`userId` 为 NULL 的组织广播记录都不会被更新或读回；
- 记录不存在或不属于当前用户时返回 `null`。

实现位置：Nest `apps/api/src/modules/notifications/notifications.service.ts` 的 `markRead`；Go
`apps/api-go/internal/graphqlread/workspacewrite/notifications.go` 的 `markNotificationRead`。
`markAllNotificationsRead` 继续单条语句扫全部未读行，本次有行从未读变为已读才返回 `true`，不逐条循环、不返回数量、不发通知、不入队。

## 功能优化二：看板只更新实际变化的组件

原实现给每个带 id 的输入组件都执行一次 Prisma `update`，即使所有字段都没变。现在两侧都用同一套规则先算差异再写：

- 用已加载的 `existing.widgets` 建 id 索引，一次遍历生成「新增 / 变化 / 删除」三组计划；
- 已有组件先按**实际写入规则**规范化目标字段（`title` 的三态、`dataConfig`/`options` 的 `?? {}`、`sortOrder ?? 输入下标`），再与原记录比较；
- 只有真正变化的已有组件执行 `UPDATE`，未变化组件保留原 `updatedAt`，事务内不再产生无效 UPDATE；
- 新增组件仍批量创建（Go 为一条多值 INSERT），删除组件仍按集合删除；
- 不做逐组件 SELECT；JSON 比较忽略对象键顺序，数组顺序仍然有意义；
- 看板本体仍执行 `version = version + 1` 并刷新 `updatedAt`，整次保存不会被改成无操作返回。

语义保留（与迁移前一致）：`id` 存在于当前看板之外报 `Widget not found on dashboard`；输入未包含的旧组件被删除；`description`、`theme`、
`title` 的「缺省 / 显式 null」按 Prisma 写入语义区分（缺省不动该列，null 清空）；`config`、`dataConfig`、`options` 继续遵守 `?? {}`；
乐观版本检查（404 `Dashboard not found` / 400 `Dashboard version is required for update` / 409 `Dashboard has been updated by another user.
Please refresh and retry.`）在执行任何组件写入之前完成，版本不匹配时不写任何组件。

实现位置：Nest `apps/api/src/modules/dashboard/dashboard.service.ts`（`dashboardWidgetChanged` / `jsonValuesEqual` 与 `upsertDashboard`）；
Go `apps/api-go/internal/graphqlread/workspacewrite/dashboards.go`（`planWidgetWrites` / `widgetChanged`、`jsonutil.go` 的 `jsonEqual`）。

`deleteDashboard` 只按 `id` + `orgId` 删除目标看板，不存在或跨组织返回 `false`；组件由 `DashboardWidget` 外键 Cascade 删除，不触碰分析工作台的
`AnalysisBoard` 等不同产品对象。

## 告警渠道管理（3 个 Mutation）

- `createAlertChannel`：`target` 先按 JS `trim` 规范化；`email` 走 `EMAIL_EXTRACT_REGEX` + `isEmail` 过滤 + 首次出现顺序去重 + `", "` 连接，
  无有效地址返回 400 `Invalid email target`；`webhook` 依次执行 DTO 层 `IsSafeUrl`（同步主机名检查 + DNS，错误为该原因本身）与服务层
  `normalizeChannelTarget` 校验（错误为 `Unsafe webhook target: <原因>`）；保存阶段 DNS 失败仍按 `allowUnresolved` 默认放行；`in_app` 只
  `trim`，不改写成当前 `userId`。`name` 保留原值（不 trim、不加非空限制，`MaxLength(80)` 仍是 DTO 实际生效的约束）。`isActive` 缺省或
  null 为 `true`，`config` 缺省或 null 存 `{}`。不发 SMTP、不发 HTTP 探测。
- `updateAlertChannel`：没有 `type` 字段，不能改类型；`target` 用数据库里已有 `type` 规范化；缺省不更新该字段、显式 null 照写（非空列上的
  null 仍走普通数据库错误分支，沿用 Nest 的 500 映射）；渠道不存在或跨组织沿用普通 `Error`，生产仍是 500 `Internal server error`。
- `deleteAlertChannel`：不存在或跨组织返回 `false`；存在时在一个 MySQL 事务内按既有顺序把该渠道 `pending`/`sending` 的投递改为 `failed` 且
  `error = "channel deleted"`，把该渠道全部投递的 `channelId` 置空，再删除渠道行，`AlertRuleChannel` 由外键 Cascade 清理。历史投递、
  `targetSnapshot`、已 `sent`/`failed` 的状态与错误、与其他渠道的规则关联全部保留。不做队列操作。

Go 侧 `AlertDelivery` 没有 `orgId` 列：租户范围通过目标渠道（已按 `orgId` 解析）及其关系确认，没有臆造列。

## 告警状态反馈（1 个 Mutation）

- 只允许 `confirmed` 与 `ignored`，其他 SDL 枚举成员沿用普通 `Error: Unsupported alert event status update`（生产 500）。
- `AlertEvent` 自身没有 `orgId`：归属通过 `AlertRule.orgId` 判断，更新语句也用 `AlertEvent INNER JOIN AlertRule` 限定 `r.orgId`，不存在或
  跨组织沿用普通 `Error: Alert event not found for this org`（生产 500）。
- `context.feedback` 合并规则（与 Nest 一致）：顶层 `context` 是普通对象时保留原字段，否则按空对象；`feedback` 是普通对象时保留原字段，
  否则按空对象；`note` 未提供时保留已有 `feedback.note`；提供非空字符串时保存 `trim` 后的字符串；提供空串、纯空白或 null 时保存 JSON
  `null`；写 `feedback.status`、`feedback.updatedAt`（UTC ISO 毫秒串），有操作人时写 `feedback.updatedById`。已有指标快照与 `feedback`
  其他字段不丢。
- Go 不把整个 `context` 解成 `map[string]any`：用 `jsonMember` 具名结构 + 不透明 JSON 叶子重建对象（`mergeJSONObject`），显式 null 也
  作为叶子原样写回；返回值由 `alerts.LoadEventModel` 复用告警读取的同一套序列化（`metricValue` 必填有限数、可选数值按现有规则、`metricSlug`
  trim/别名、`context` 仅对象时返回、`deliveries` 数组与渠道删除后的 `targetSnapshot`/`userId`/`In-app` 回退）。
- 本操作不改规则、不触发评估、不发反馈消息。

## GraphQL 模型注册与整份回退

- `alerts` 与 `history` 各拆出 `RegisterModels`（只登记对象类型，不登记任何 Query root），原有 `Register` 复用它们；`workspace` 已有
  `RegisterModels`。整份注册规则：

  | 读开关 | 其他写开关 | 注册 |
  | --- | --- | --- |
  | `READ=go 且 WORKSPACE_READ=go` | 任意 | `workspace.Register` 已登记 workspace 模型 |
  | 否则要 workspace 模型 | 组织写或本批写为 `go` | `workspace.RegisterModels` 一次 |
  | `READ=legacy` 且本批写为 `go` | — | 再注册 `alerts.RegisterModels` + `history.RegisterModels` |

  每个类型与字段级权限只登记一次；`workspace.RegisterModels` 已有的字段级权限没有被删改；不为注册返回类型打开任何 Query。
- 复用同名 GraphQL 类型：`NotificationModel`、`DashboardModel`、`DashboardWidgetModel`、`AlertChannelModel`、`AlertEventModel`、
  `AlertDeliveryModel` 都由读侧已有的具名 struct 投影，读写不出现两套结构。本批把三处旧弱类型改成 `*json.RawMessage`：
  `history.NotificationModel.Data`、`alerts.AlertChannelModel.Config`、`alerts.AlertEventModel.Context`，投递 `targetSnapshot` 改为具名叶子结构
  解析；未扩展到整个 history 包或执行器。
- 整份 operation 选择继续由现有执行器决定：任一选中 root 未接管就整包回 NestJS，不存在「先写一部分再转发」；Mutation 顶层字段按文档顺序
  串行执行，后面的字段能读到前面字段已提交的修改；单字段失败与非空传播沿用执行器语义；多字段 Mutation 不包成一个全局事务。GET 上的
  Mutation 仍是 405 + `Allow: POST`，Mutation 一律 `Cache-Control: no-store` 且不读写响应缓存。
- 本批不新增 Redis 缓存键、进程缓存或缓存失效框架。

## 输入契约与校验路径

- SDL 保证的非空、`Int`、枚举、`[DashboardWidgetInput!]!` 由 GraphQL 校验保留。
- 顶层 DTO 约束按 class-validator 的实际行为对齐：`name` 的 `MaxLength(80)`（渠道）、`note` 的 `MaxLength(500)`、
  `version` 的 `Min(0)`、看板 `config` 的 `IsObject`。
- `UpsertDashboardInput.widgets` 没有 `@ValidateNested` / `@Type`，所以**嵌套** `DashboardWidgetInput` 的约束（`IsObject`、`Min`）在 Nest
  目前并不生效；本批不补建 `ValidateNested` 体系，Go 侧同样不额外添加 slug 格式、名称非空、组件数量或布局上限。嵌套字段只保留 SDL
  保证的类型。
- Go 侧没有引入 `any` / `interface{}` / `map[string]any` 承载业务数据；GraphQL 参数边界与数据库驱动变参仍按既有协议边界使用。JSON 列
  （看板 `config`、组件 `dataConfig`/`options`、渠道 `config`、通知 `data`）用 `json.RawMessage` 作不透明叶子，写库统一
  `CAST(? AS JSON)` + 文本参数（对齐既有 Go 批次，避免二进制字符集写入 JSON 列的问题）。

## 事务与错误映射

- 看板保存：整个看板与组件写入在同一个 MySQL 事务内；版本检查通过后 `version = version + 1`，组件计划在该事务内执行；抛错即整体回滚。
- 渠道删除：三步写在同一事务内。
- 其余 5 个入口是单语句或「先查后写」的既有语义，没有额外事务。
- 业务错误仍走已有执行器：`BadRequestException`/`NotFoundException`/`ConflictException` 映射为 400/404/409 与原文；普通 `Error` 与数据库
  错误映射为 500 `INTERNAL_SERVER_ERROR`（与 Nest `GlobalExceptionFilter` 生产输出一致）。没有把业务错误包装成新的 REST JSON envelope。
- 这 8 个入口原本没有审计写入，本批也没有新增 AuditLog/Outbox、重试、分布式锁、幂等键或事件总线。未引入通用重试、分布式锁或新的运行模式。

## 验证

- 普通 GitHub Actions CI（构建、类型检查、Go 测试、Web 测试、SDL/契约漂移检查）结果见 PR 记录；本批不新增专用 smoke workflow。
- 新增 Go 单元测试 `apps/api-go/internal/graphqlread/workspacewrite/workspacewrite_test.go`（纯函数）：未变化组件不产生 UPDATE、对象键顺序
  不影响比较而数组顺序影响、`sortOrder` 缺省取输入下标、未知组件 id 报错、feedback 合并不丢未知字段与显式 null note、`?? {}` 默认、邮箱
  规范化与 webhook SSRF 同步拒绝、错误映射。新增 `internal/config/config_workspacewrite_test.go` 覆盖开关默认值/非法值/凭据要求。
- 本机不运行 `go build` / `go test` / `pnpm` / `docker`：验证以普通 CI 为主。
- 未验证：真实 SMTP 投递、真实 webhook 发送、真实队列消费、真实告警扫描评估。本批只迁移配置保存与本地业务写。
