# 组织、角色与成员管理 GraphQL 写迁移（Go）

基线是 `origin/main` 的 `57d1d4baa5f8432686c8db396968633fd559d43e`。

## 开关与回滚

- 新增 `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE`，只接受空串 / `legacy` / `go`，默认 `legacy`，非法值启动失败（错误文本含变量名）。
- 与 `API_GO_GRAPHQL_READ_MODE` **完全解耦**。四种组合：

  | READ | ORG_ACCESS_WRITE | 行为 |
  | --- | --- | --- |
  | `legacy` | `legacy` | GraphQL 全部走 NestJS |
  | `go` | `legacy` | Query 按既有子开关执行，Mutation 仍走 NestJS |
  | `legacy` | `go` | 只有这 8 个 Mutation 由 Go 执行，Query 仍走 NestJS |
  | `go` | `go` | 两类操作各按自己的注册与开关执行 |

- `go` 只要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`；**不要求 `MONGO_URI`**，不初始化任何只读域的 Mongo service。只开写入时不会为了读查询顺带打开别的 root（12 个 query 仍回 NestJS）。
- 生产 Web 入口仍是 `Web -> NestJS`，canary 保持关闭。回滚只把 `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` 改回 `legacy`；不改表、不改 SDL、不改 Web、不改其他开关默认值。

## 迁入的 8 个 Mutation

| # | Mutation | 返回类型 | 顶层权限 |
| --- | --- | --- | --- |
| 1 | `createOrg(input: CreateOrgInput!)` | `OrgModel!` | `org.write` |
| 2 | `updateOrg(input: UpdateOrgInput!)` | `OrgModel!` | `org.write` |
| 3 | `setOrgActive(input: SetOrgActiveInput!)` | `OrgModel!` | `org.write` |
| 4 | `createRole(input: CreateRoleInput!)` | `RoleModel!` | `roles.write` |
| 5 | `updateRole(input: UpdateRoleInput!)` | `RoleModel!` | `roles.write` |
| 6 | `assignRole(input: AssignRoleInput!)` | `MembershipModel!` | `roles.write` |
| 7 | `updateMembershipRoles(input: UpdateMembershipRolesInput!)` | `UserModel!` | `users.write` |
| 8 | `setUserActive(input: SetUserActiveInput!)` | `UserModel!` | `users.write` |

未迁（仍回 NestJS）：`upsertDashboard`、`deleteDashboard` 等其余 Mutation，以及 `queueEvents` Subscription。

## 执行器改动（本批必须完成的部分）

Go 执行器原先明确限制为 `ast.Query`。本批完成最小必要的 Mutation 执行能力，仍使用既有 GraphQL 包、SDL、解析器与响应投影：

1. **Query 与 Mutation 分别登记、分别查找 root。** `contract.Registry` 新增 `RegisterMutation` / `Mutation(name)`；`RegisterRoot` / `Root(name)` 保留为 Query 的兼容入口（`Query(name)` 是等价别名）。
2. **planner 按 operation 类型选择 `schema.Query` 或 `schema.Mutation`。** `rootDefinition`、`rootResolver`、`operationSupported`、选择集遍历（`selectionSupported`）、`typeSupported`、复杂度估算（`complexityOf` / `selectionComplexity`）、顶层字段收集（`collectFields`）、`__typename` 与结果字段定义查找全部按 operation 选根。`docs` 里记录的限制（顶层/投影/复杂度都硬编码 `schema.Query`）已全部消除。
3. **整包接管判断在写入之前完成。** 只要选中的 operation 里含任何一个未迁移 root，整包原样转发 NestJS；不存在"先执行部分 Go 写入再转发"。`operationName`、`variables`、`alias`、fragment、`@skip` / `@include` 沿用现有协议行为。Subscription、WebSocket、multipart 与 HTTP batch 继续原路径。
4. **Mutation 顶层字段按文档顺序串行执行。** 每个字段依次完成限流 + 认证、授权、业务调用与结果投影，再处理下一个字段；不沿用 Query 的"先准备全部字段身份、再批量执行"流程。顶层非空字段失败时返回 `data: null` 并停止后续字段；前面已提交的字段不做整包回滚，也没有 operation 级事务。
5. **GET 不能执行 Mutation。** GET 请求在 `KindExecute` 分支、鉴权与复杂度检查之前被拒绝，返回 Apollo 的 `405`、`Allow: POST` 与 `{"errors":[{"message":"GET requests only support query operations, not mutation operations","extensions":{"code":"BAD_REQUEST"}}]}`。CSRF、CORS、APQ、错误 extensions 与 traceId 行为保持不变。
6. **Mutation 响应 `Cache-Control: no-store`**，不读也不写响应缓存。`exec.ResponseCacheable` 现在先限定 `plan.Op.Operation == ast.Query`，不再只依赖 operationName 或字段名白名单。
7. 新增 `graphqlCode` 的 409 -> `CONFLICT` 映射（`createRole` 的唯一冲突）。

## 启动装配

- `/graphql` 的 Go 路由在此前只由 `API_GO_GRAPHQL_READ_MODE` 决定。现在任一开关为 `go` 就插入精确 `/graphql` 规则；注册了哪些 root 与它们各自的开关决定文档实际在哪执行。
- 只开写入时：`contract.NewRegistry()` 只登记 8 个 Mutation 与共享模型，不打开 Mongo。
- **共享模型注册一次。** `workspace` 导出 `RegisterModels`（只登记模型与字段级权限，不登记任何 query）。装配规则：
  - `READ=go && WORKSPACE_READ=go`：`workspace.Register` 已登记模型，写入路径不再登记；
  - 其他组合且写入为 `go`：先 `workspace.RegisterModels`，再 `orgaccesswrite.Register`。
  这样读写同时开启时不会重复登记字段级权限（`RegisterFieldPermission` 对重复登记 panic）。

## 字段权限

沿用既有注册，不新增也不放宽：`RoleModel.permissions` 需 `roles.read`；`MembershipModel.role` / `roles` / `user` 需 `users.read`；`UserModel.primaryRoleId` / `isActive` / `emailVerified` / `lastLoginAt` / `roleIds` 需 `users.read`。根权限与返回对象的字段权限分别生效，缺少字段权限时返回与 `GqlPermissionsGuard` 相同形状的 `FORBIDDEN`。

## 组织管理（3 个 Mutation）

`createOrg`：

- DTO 层先在**原始值**上校验（`name` 最长 120、`slug` 最长 64 + 正则、`description` 最长 500），消息按 class-validator 的装饰器应用顺序（源码倒序）拼接，多条以 `"; "` 连接；随后 service 层再做 `name.trim()`、`slug.trim().toLowerCase()` 与二次正则。
- 一个事务内创建 `Org`、默认角色 `admin` / `manager` / `analyst`（`DEFAULT_ROLES` 全量，含每个角色的描述与 `isSystem`）、`RolePermission`、创建者的 `Membership` 与 `MembershipRole`，以及 `AuditLog`（`org/create`，metadata `{slug, name}`，有缺失权限时追加 `bootstrapWarnings`）。
- `admin` 关联数据库当前**全部** `Permission`；`manager` / `analyst` 按名单关联，名单里数据库没有的名字静默跳过并记入 `bootstrapWarnings`（与 Nest 一致，admin 的缺失也会记录）。
- 重复 slug 仍是 400 `Organization slug already exists`。
- 提交后失效 `org:active:list:v1`。

`updateOrg` / `setOrgActive`：

- 根权限来自当前请求（活跃组织的 claims 推导），目标组织权限再从 actor 在**目标 org** 的 `Membership` + `MembershipRole` / 主角色重新计算（`rbacapi.ActorHasPermission`），保留既有跨组织管理语义与错误文案（`Missing actor context` / `Organization id is required` / `Not a member of the organization` / `org.write permission required in the target organization`）。
- `updateOrg` 保持字段三态：省略不动，`null` / 空串 / 全空白清空 `description`，其他值 trim 后写入；`updatedAt` 每次刷新。
- `setOrgActive` 实际更新 `Org.isActive`，审计 action 是 `enable` / `disable`。
- 两者都失效 `org:active:list:v1`（`updateOrg` 在 Nest 侧原本不失效；该键只存 id，多一次 `DEL` 不影响任何可观察响应，按任务要求补齐）。
- 禁用组织后逐成员删除 `profile:<userId>:<orgId>`（不区分成员是否 active；删除失败只记日志，与 Nest 的 `Promise.allSettled` 语义一致）。
- 返回真实更新后的 `OrgModel`（`DateTime` 序列化为 UTC 毫秒）。

## 角色与成员管理（5 个 Mutation）

优先复用既有 Go `internal/rbacapi`：`createRole` / `assignRole` 直接复用其 `CreateRole` / `AssignRole`，限流、事务、行锁、缓存失效与审计不重写；`updateRole` / `updateMembershipRoles` / `setUserActive` 在该包内以同一批内部 helper 实现并暴露为强类型 view（`internal/rbacapi/graphql.go`）。没有通过 HTTP 调用自身，也没有序列化后再反序列化搬运模型。

- **限流**：五个入口每个只消费一次 `rbacapi.EnforceRbacWrite`；键 `rbac:write:<orgId>:<actorId>` 与 `:seq`，桶来自 `rate_limit:settings` 的 `rbacWrite`，环境默认 `RATE_LIMIT_RBAC_WRITE=20` / `RATE_LIMIT_RBAC_WRITE_WINDOW=600`，超限 429 `Too many RBAC changes were attempted. Please try again later.`。限流先于鉴权，失败分支同样计数。
- **createRole**：组织管理员检查 → 保留名 400 `System administrator role name is reserved` → 权限存在性（条数不等即 404 `One or more permissions not found`，**不去重**）→ 权限范围 → 事务内建角色与全量 `RolePermission` → 唯一冲突 409 `Role name already exists`。
- **updateRole**：`id + orgId` 查角色（404 `Role not found`）→ 系统角色 403 `System roles cannot be edited` → **原权限**与**新权限**都必须在 actor 范围内 → 同一事务替换 `RolePermission` 并写 `description`（省略 / `null` 写 NULL，空串保持空串，不 trim）→ 提交后按角色失效全部关联成员的 profile 缓存。返回 `permissions` 已展开为 `PermissionModel[]` 的 `RoleModel`，不是 REST 的 Prisma 关系包装结构。
- **assignRole**：目标保护（自己或系统管理员 403 `System administrators cannot be managed`）→ 目标角色归属与系统 admin 角色限制 → 权限范围 → 事务内先 `SELECT id FROM Membership ... FOR UPDATE`（无行时保持 upsert 创建后再锁住新行）→ 替换 `MembershipRole`。非成员目标仍会被创建进组织。返回完整 `MembershipModel`（`role` / `roles` / `user`），`user.permissions` 为有效多角色权限并集。
- **updateMembershipRoles**：目标必须是本组织成员（404 `User is not a member of the organization`）→ 不能改自己（403 `Administrators cannot change their own roles`）→ 不能管理系统管理员（403 `System administrators cannot be managed`）→ `roleIds` trim、去空、去重（空则 400 `At least one role is required`）→ `primaryRoleId` 必须字面属于去重后的 `roleIds`（400 `Primary role must be included in the selected roles`）→ 角色必须属于本组织（404 `One or more roles not found`）→ 不能包含系统 admin 角色（403 `System administrator role cannot be assigned from user management`）→ 权限范围 → 一个事务更新 `Membership.roleId` 并全量替换 `MembershipRole`。返回完整 `UserModel`。
- **setUserActive**：只更新当前组织的 `Membership.isActive`，**不改** `User.isActive`；返回的 `isActive` 是 `User.isActive && Membership.isActive`。错误文案 `Administrators cannot change their own status` / `System administrators cannot be managed`。
- **缓存失效**：`updateRole` / `assignRole` 用 `invalidateUsersWithRole`（按新 / 原角色命中主角色或 membershipRole 的成员，逐用户删本组织与所有 membership 的 `profile:<userId>:<orgId>`）；`updateMembershipRoles` / `setUserActive` 用 `invalidateProfileCache`。Redis 失败只记日志，不回滚已提交的写入。
- **审计**：`roles/create`、`roles/update`、`users/assign_role`、`users/update_membership_roles`、`users/set_active`，metadata 与 Nest 的对象字面量逐字段一致（`updateRole` 的 `description` 写 `dto.description ?? null`；`updateMembershipRoles` 的 `roleIds` 是 trim + 去重后的数组）。审计在事务外 best-effort，失败入 `AuditLogOutbox`。

## 强类型建模

新增的业务输入、返回模型、数据库 JSON 与审计 metadata 全部是具名强类型 `struct`；`orgaccesswrite` 内不出现 `any`、`interface{}`、`map[string]any` 或 `[]any` 承载业务数据。`contract.Context.Args` 与 `contract.MapArg` 仍是既有 GraphQL 协议边界，参数进入 resolver 后立即转成具名输入结构。`json.RawMessage` 未在本批新增使用。审计 writer 用泛型参数承载具名 metadata，避免 `map[string]any`。

## 与 Nest 的已知差异

1. `/graphql` 的 Mutation 一进 Go（`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=go`）就不再经过 NestJS 的 GraphQL 限流守卫；人类身份、撤销名单与权限仍由 Go 独立重推导（读批次建立的同一条链）。
2. RBAC 写限流的 Redis 键沿用既有 Go 实现的 `rbac:write:<orgId>:<actorId>`。Nest 的 `RateLimiterService` 会在逻辑键前加 `rate:`，因此**这一项在既有 rbac REST 接管批次里就已经与 Nest 分桶**；本批不改动共享键，保持与 Go 侧 REST 写同桶、与任务给定的键一致。
3. `updateOrg` 额外失效 `org:active:list:v1`（Nest 原本不失效）。该 `DEL` 是 best-effort：缓存只存 org id，且 Nest 在这里根本不失效，因此不能让一次 Redis 抖动把**已经提交**的更新报成失败。`createOrg` / `setOrgActive` 的失效仍然沿用 Nest 的语义（Redis 异常会向上冒泡）。
4. 名称 / 描述 / roleIds 的 trim 语义：复用路径沿用 `rbacapi` 既有的 `strings.TrimSpace`，本批新增路径用与 JS `trim()` 对齐的空白集合。两者只在 U+0085 / U+00A0 等极少数码点上不同。
5. 审计 writer 在 `AuditLog` 与 `AuditLogOutbox` **都失败**时只记日志：Nest 此时会重抛，而 `createOrg` 的审计写在事务内，重抛会连组织创建一起回滚。Go 侧沿用既有 `rbacapi` 的 best-effort 契约，已提交的组织写入不回滚（这是有意的取舍，不是遗漏）。
6. `invalidateProfileCache`（`updateMembershipRoles` / `setUserActive`）与既有 `invalidateUsersWithRole` 一样忽略 Redis 错误；Nest 会向上冒泡。

## 验证

- 普通 CI：`go vet ./...`、`go test ./...`（含本批新增的 planner / 串行执行 / GET 拒绝 / 输入校验测试）、Nest typecheck/lint/test。见 PR 上的 CI 链接。
- 未新增专用 smoke workflow（按本批要求）。本机只做静态操作：代码阅读、`git diff`、`rg`、`gofmt`；未执行 `go build` / `go test` / `go vet` / Docker / 启动服务。

## 明确的未完成项

- 其余 Mutation（`upsertDashboard` / `deleteDashboard` 等）与 `queueEvents` Subscription 未迁移，始终走 NestJS。
- 邀请、注册申请、登录、MFA、OIDC、SMTP 未迁移。
- 未做真实栈端到端验收（按本批要求不新增 smoke workflow）；8 个 Mutation 的真实数据库读写正确性依赖普通 CI 的编译/静态检查与后续人工验收。
