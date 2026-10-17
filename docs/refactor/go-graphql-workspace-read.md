# 身份、组织、RBAC、仪表盘、队列、情感与已处理条目 GraphQL 读迁移（Go）

基线是 `origin/main` 的 `3dad6ac441e99e595485eb11aedd1c0474acbe32`（main CI run
https://github.com/wei500L/newwei/actions/runs/39029452206 `success`）。

## 开关与回滚

- 新增 `API_GO_GRAPHQL_WORKSPACE_READ_MODE`，只接受空串 / `legacy` / `go`，默认 `legacy`，非法值启动失败。
- 只有 `API_GO_GRAPHQL_READ_MODE=go` 且本开关 `=go` 时，才在既有精确 `/graphql` 执行器登记这 12 个只读 root；本开关为 `legacy`（或读查询为 `legacy`）时，含这 12 个 root 中任意一个的文档整包回 NestJS。
- 生产 Web 入口仍是 `Web -> NestJS`，canary 关闭。回滚只把 `API_GO_GRAPHQL_WORKSPACE_READ_MODE` 改回 `legacy`；不改表、不改 SDL、不改 Web、不改其他开关默认值。

## 迁入的 12 个 Query root

| # | root | 顶层权限 | 内部门禁 |
| --- | --- | --- | --- |
| 1 | `me` | `AllowAuthenticated` | `UserModel` 的 `primaryRoleId` / `isActive` / `emailVerified` / `lastLoginAt` / `roleIds` 需 `users.read` |
| 2 | `myOrganizations` | `AllowAuthenticated` | 成员关系按 `createdAt asc`，按 `orgId` 去重，`isActive = org.isActive && (membership.isActive ?? true)` |
| 3 | `users(first, after, search)` | `users.read` | 额外 `assertActorIsOrgAdmin`（系统 `admin` 角色），否则 403 `Admin access required` |
| 4 | `userLoginRecords(userId, limit)` | `users.read` | `assertActorIsOrgAdmin`；目标非本组织成员 404；目标是系统管理员 403 |
| 5 | `roles(includeSystem)` | `roles.read` | `includeSystem` 默认 `true`，`name asc` |
| 6 | `permissions` | `permissions.read` | 全局表，`name asc` |
| 7 | `memberships` | `users.read` | `RoleModel.permissions` 需 `roles.read` |
| 8 | `dashboards` | `dashboards.read` | `createdAt asc`、widgets `sortOrder asc` |
| 9 | `queueStats` | `queue.manage` | MySQL `ItemMeta`、Mongo `processeditems`、Redis `queue:itemPipeline:org:<orgId>:counts`、最近 10 条 `tasklogs` |
| 10 | `entitySentimentSeries` | `dashboards.read` | `days` 默认 30、clamp 1..365；`entityName` trim；`entityType` trim+小写 |
| 11 | `topicSentimentSeries` | `dashboards.read` | `days` 默认 30、clamp 1..365；`topic` trim |
| 12 | `processedItemById(id)` | `items.read` | 非法 ObjectId 400 `Invalid processed item id`；`duplicateOf` 跨 ID 空间解析；`eventId` 两步回退 |

未迁（仍回 NestJS）：`createOrg`、`updateOrg`、`setOrgActive`、`updateMembershipRoles`、`setUserActive`、`createRole`、`assignRole`、`updateRole`、`upsertDashboard`、`deleteDashboard` 这些 Mutation，以及 `queueEvents` Subscription。

## 强类型建模

- 12 个 root 的 GraphQL 模型、Mongo `processeditems` / `tasklogs` 文档、MySQL 扫描结构、Redis 计数与 `ProcessedItemLlmModel` / `ProcessedItemErrorModelGraph` 全部是带 `graphql` / `json` / `bson` tag 的具名强类型 `struct`；`apps/api-go/internal/graphqlread/workspace` 内不出现 `any`、`interface{}`、`map[string]any` 或 `[]any`。
- 仅 GraphQL SDL 显式声明为 `JSON` 的字段（`config`、`dataConfig`、`options`、`evidenceProcessedItemIds`、`resultJson`）使用 `json.RawMessage`；`result` 通过内置的 BSON→JSON reader 归一化。
- `(doc.llm as any)` 已删除，Nest 与 Go 两侧都走显式强类型 `normalizeProcessedItemLlm`。
- 全部新增/修改的后端代码使用英文注释；Go 包、导出类型、函数、常量都有标准 GoDoc。

## 执行器字段级权限

`apps/api-go/internal/graphqlread/contract` 新增 `RegisterFieldPermission` / `FieldPermission`，`exec` 在字段投影前检查：`UserModel` 的 `primaryRoleId`、`isActive`、`emailVerified`、`lastLoginAt`、`roleIds` 需 `users.read`；`RoleModel.permissions` 需 `roles.read`；`MembershipModel.role` / `roles` / `user` 需 `users.read`。缺少权限时返回与 `GqlPermissionsGuard` 相同形状的 `FORBIDDEN`（403、`appCode: INSUFFICIENT_PERMISSIONS`）。

## 同批修复的缺陷

1. **游标 P2025（Nest + Go）**：`apps/api/src/modules/rbac/user-admin.service.ts` 的 `listUsers` 在 `after` 非空时先确认该 `User.id` 是当前 `orgId` 的成员，否则返回 `[]`；Go 侧 `locateCursorUser` 同样处理。非法 base64 也返回空页，不再 500。
2. **`llm` 非对象 / NaN（Nest + Go）**：`processed-item.resolver.ts` 删除 `as any` 并新增 `normalizeProcessedItemLlm`；Go 用 `processedItemLlmDoc` + `rawFiniteFloat` 逐字段提取，非对象与非有限数值都为 `null`。
3. **情感名称未 trim（Nest + Go）**：`sentiment.service.ts` 对 `entityName` / `topic` 先 `trim()`，空串直接返回 `[]`；Go 侧同样 `jsTrim` 后为空即返回空列表。
4. **队列日志脱敏（Nest + Go）**：`queue.service.ts` 的 `stats` 对每条日志 `message` 调 `redactSensitiveFields`；Go 复用 `internal/adminlogs.RedactSensitiveFields`，`Bearer secret.token.123` 输出为 `Bearer [REDACTED]`。

## 验收

- 普通 CI：`go vet ./...`、`go test ./...`（含新包单测）、Nest typecheck/lint/test。见 PR 上的 CI 链接。
- Smoke：`.github/workflows/api-go-graphql-workspace-read-smoke.yml`（`workflow_dispatch` 或 PR label `api-go-graphql-workspace-read-smoke`），在真实 MySQL/Redis/Mongo 上逐字段对照 Nest 与 Go，并验证管理员门禁、字段级权限、`duplicateOf`/`eventId`、trim 命中与日志脱敏，最后停 Nest 验证 12 个 Query 全 200、`deleteDashboard` mutation 502。
- 本机未安装依赖、未跑测试、未构建、未启动 Docker；所有验证在 GitHub Actions Linux runner 完成。
