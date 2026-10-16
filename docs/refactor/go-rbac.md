# 组织访问控制（RBAC）Go 接管

本批把组织访问控制的六条 HTTP 从 NestJS 迁到 `apps/api-go`，默认仍由
NestJS 响应。开关 `API_GO_RBAC_MODE` 默认 `legacy`，只有显式设为 `go`
时这六条才由 Go 执行。回滚只改这一个开关。

## 开关与路由

`API_GO_RBAC_MODE` 只接受空字符串、`legacy` 或 `go`（空串与 `legacy`
等价；其他值启动失败，错误文本含变量名）。`go` 时由
`internal/legacyproxy/rbac_routes.go` 的 `WithRbac` 追加六条精确规则：

| 方法 | 路径 | 权限 | 成功 |
| --- | --- | --- | --- |
| GET | `/api/rbac/permissions` | `permissions.read` | 200 |
| GET | `/api/rbac/roles` | `roles.read` | 200 |
| POST | `/api/rbac/roles` | `roles.write` | 201 |
| POST | `/api/rbac/assign` | `roles.write` | 201 |
| GET | `/api/rbac/members` | `users.read` | 200 |
| GET | `/api/rbac/audit-logs` | `settings.manage` | 200 |

其他方法与更长/更短路径（例如 `DELETE /api/rbac/roles`、
`/api/rbac/roles/:id`）继续回落 NestJS——Go 不返回自己的 404。预检
`OPTIONS` 交给 Go；非预检 `OPTIONS` 仍代理 NestJS。本开关不新增
`updateRole` 的 HTTP（`rbac.service.ts` 的 `updateRole` 没有对应控制器
路由）。

生产 Web 仍指向 NestJS；canary 保持关闭（路由表没有任何 `ModeCanary`
条目）。回滚：`API_GO_RBAC_MODE=legacy`。

## 鉴权

与 newssources / crawlprofile / crawlworkflow 相同的 `authorize`：

- 缺少 `Authorization` 或不是 Bearer → 401；
- `mtk_` 前缀 → `Service.AuthenticateMachine`（SHA-256 查
  `MachineAccessToken.tokenHash`，连 `Org.isActive`；撤销/过期/组织停用
  → 401 `Invalid machine token`）。权限与 `orgId` 只来自令牌行，不调用会
  拒绝机器令牌的 `authhttp.Authenticate`；
- 其他 token → `authhttp.Authenticate`：JWT 验签 + Redis 撤销名单 +
  membership/permission 重推导。人类用户的 `orgId` 来自 membership 重
  推导，不看 JWT 的 `permissions`，也不看 body 里的 `orgId`；
- 缺少方法要求的权限 → 403 `INSUFFICIENT_PERMISSIONS`。

`GET /api/rbac/audit-logs` 暴露 actor、ip、metadata，因此必须是
`settings.manage`，不回退到分析师也持有的 `roles.read`。

## 读接口

- `GET /permissions`：全局权限目录，`orderBy name asc`，不按组织过滤。
- `GET /roles`：只查该 `orgId`。`includeSystem` 是字面量规则，不做通用
  布尔解析：参数不出现 → `true`（系统角色也返回）；参数正好是字符串
  `true` → `true`；参数是 `false`、`FALSE`、`1`、`yes` 或其他值 →
  `false`（只返回 `isSystem=false`）。响应带 `permissions` 以及每条
  `rolePermission` 的 `permission`，排序 `name asc`。
- `GET /members`：只查该 `orgId`，包含 `user`、`role.permissions.permission`
  与 `roles.role.permissions.permission`。
- `GET /audit-logs`：只查该 `orgId`，`createdAt desc`。`limit` 算法：
  `Number(query)`；有限且大于 0 → `Math.min(Math.trunc(n), 200)`；否则
  20。所以缺省、`0`、负数、非数字都是 20；`1.9` → 1；`201` → 200。

## 写接口

`POST /roles` 与 `POST /assign` 的检查顺序一致，缺一不可（迁到 Go 也不
少一道检查）：

1. `enforceRbacWrite`：键 `rbac:write:<orgId>:<actorId>`，限额与窗口来自
   现有 `rbacWrite` 桶（Redis `rate_limit:settings` 优先，否则
   `RATE_LIMIT_RBAC_WRITE` / `RATE_LIMIT_RBAC_WRITE_WINDOW`，默认
   20 / 600）。超限 429 `Too many RBAC changes were attempted. Please try
   again later.`
2. `assertActorIsOrgAdmin`（`user-admin.service.ts:130`）：非成员 403
   `Actor is not a member of the organization`；成员但没有系统管理员角色
   （`isSystem=true` 且 `name` 忽略大小写等于 `admin`）→ 403
   `Admin access required`。
3. 取操作者权限集合（来自鉴权重推导）。
4. 名字 / 请求校验、权限存在性、权限范围。

### POST /roles

- 名字 trim 后空 → 400 `Role name is required`。
- trim 后忽略大小写等于 `admin` → 400 `System administrator role name is reserved`。
- `permissions` 数组里的名字必须都能在 `Permission` 表找到。数量对不上
  （含重复名字导致 `find` 结果变少）→ 404 `One or more permissions not found`。
  不去重后成功。
- 每个权限名必须已经在操作者自己的权限集合里，否则 403
  `Insufficient permission scope for RBAC change`。
- 新角色 `isSystem=false`，`orgId` 是当前组织。
- 唯一冲突（`@@unique([orgId, name])`）→ 409 `Role name already exists`。
- 成功后写审计：`resource=roles`、`action=create`。审计走
  `writeAuditLogBestEffort`，失败不把已经创建的角色改成 500。
- 响应带 `permissions`。

### POST /assign

- 目标用户是操作者自己，或目标已有系统管理员角色 → 403
  `System administrators cannot be managed`。
- `roleId` 必须属于当前 `orgId`，否则 404 `Role not found`。
- 该角色是系统管理员角色 → 403
  `System administrator role cannot be assigned from user management`。
- 操作者必须拥有该角色上的每一个权限，否则 403
  `Insufficient permission scope for RBAC change`。
- 目标还不是本组织成员时，保持 NestJS 的 upsert 创建行为（不是 404）。
- 然后删掉该 membership 的全部 `membershipRole`，再插入这一条 `roleId`；
  `membership.roleId` 也改成这个 `roleId`。
- 成功后 `invalidateUsersWithRole`（`user-admin.service.ts:460`）：删
  `profile:<userId>:<orgId>`，以及该用户每个 membership 的
  `profile:<userId>:<那个 orgId>`。
- 审计 `resource=users`、`action=assign_role`；失败不回滚已分配的角色。

## 成员行锁（缺陷修复）

`assignRole` 原实现（`rbac.service.ts:248-277`）在事务里先 upsert
membership，再 `deleteMany` membershipRole，再 `createMany`。两条并发
请求可以都通过前置检查，然后互相删掉对方刚插入的角色，成员最后没有
角色。

Nest 与 Go 都在事务里先锁住该成员：

```sql
SELECT id FROM Membership WHERE userId = ? AND orgId = ? FOR UPDATE
```

- 有行时：锁住后再替换 `membershipRole`。
- 没有行时：仍按现有 upsert 创建，创建后在同一事务里再次锁住新行，再
  替换 `membershipRole`。
- 锁是当前读（`FOR UPDATE`），不用应用层 mutex。不改「非成员会被创建进
  组织」这个结果。

两次并发分配结束后，`membershipRole` 恰好是后提交的那一个 `roleId`，
不是 0 条。

Nest 侧行号：`apps/api/src/modules/rbac/rbac.service.ts:248`（事务开始）、
`:253`（首次 `FOR UPDATE`）、`:276`（创建后再次 `FOR UPDATE`）。
Go 侧：`apps/api-go/internal/rbacapi/service.go` 的 `AssignRole`。

## 未做 / 边界

- 不改前端，不改登录、刷新、MFA、OIDC。
- 不新增 `updateRole` 的 HTTP。
- 不放宽组织管理员、权限范围、写限流；不把 `includeSystem` 改成只认布尔。
- 不打开 canary，不改其他 `API_GO_*` 的默认值。
- 不处理 FE-TPL-02。
- SEC-01 的真实登录态未在本批验证。
- 本批未写登录、MFA 或生产流量已经切换：生产 Web 仍指向 NestJS，
  canary 关闭。

## 验证

- 普通 CI：lint / typecheck / 单测（`api-go` 路由规则测试 +
  `apps/web` 组件测试）。
- 远端 smoke：`api-go-rbac-smoke.yml`（手动 `workflow_dispatch` 或 PR 上
  打 `api-go-rbac-smoke` 标签），真实 MySQL/Redis + NestJS + api-go 容器，
  使用隔离组织。
