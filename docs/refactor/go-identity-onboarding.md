# 注册申请、审批、邀请与入组迁入 Go（IDENTITY-ONBOARDING-001）

本批把 NestJS `apps/api/src/modules/auth` 的注册/邀请/审批 14 条 HTTP 迁入
`apps/api-go/internal/identityonboarding`，用独立开关控制，默认保持 legacy。

## 一、开关

| 变量 | 取值 | 默认 |
| --- | --- | --- |
| `API_GO_IDENTITY_ONBOARDING_MODE` | 空串 / `legacy` / `go` | `legacy` |

- 空串与 `legacy` 等价：14 条路由全部代理 NestJS。
- 其他任何值（含 `shadow`、`canary`、`Go`、`1`）启动失败，不静默降级；错误文本
  `API_GO_IDENTITY_ONBOARDING_MODE must be one of legacy|go`。
- 与 `API_GO_AUTH_LOGIN_MODE`、`API_GO_ACCOUNT_SECURITY_MODE`、
  `API_GO_AUTH_FACTORS_MODE`、GraphQL 及其余批次完全独立：它们全为 legacy 时本批
  可单独工作，四组 auth 开关同时为 `go` 时路径互不覆盖（注册键
  `/api/auth#identity-onboarding`）。

### go 模式的启动资源

必需：`JWT_SECRET`（+ `JWT_ISSUER` / `JWT_AUDIENCE`）、`DATABASE_URL`、
`REDIS_HOST`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`。

不需要：`MONGO_URI`；不启动 worker/cron；不访问 IdP；不发启动邮件。

### 回滚

`API_GO_IDENTITY_ONBOARDING_MODE=legacy`。邀请 hash、状态、申请、membership 与
NestJS 完全兼容，因此无 schema/数据回滚；已接受的 membership 与已发出的邮件
不回滚。

## 二、接管的 14 条路由

| 方法 + 路径 | 权限 | 成功 |
| --- | --- | --- |
| `GET /api/auth/admin/invites` | `users.write` + 服务重查当前组织 | 200 |
| `POST /api/auth/admin/invites` | `users.write` + 角色同组织/授予范围 | 201 |
| `POST /api/auth/admin/invites/:id/resend` | `users.write` + 当前组织 | 201 |
| `POST /api/auth/admin/invites/:id/revoke` | `users.write` + 当前组织 | 201 |
| `GET /api/auth/admin/registration-applications` | 已认证；`users.write` / `platform_admin` 分别决定可见列表 | 200 |
| `POST /api/auth/admin/registration-applications/:id/approve-join` | `users.write` + 角色授予校验 | 201 |
| `POST /api/auth/admin/registration-applications/:id/reject-join` | `users.write` + 当前组织 | 201 |
| `POST /api/auth/admin/registration-applications/:id/approve-org` | 已认证；服务查 `GlobalRoleAssignment` | 201 |
| `POST /api/auth/admin/registration-applications/:id/reject-org` | 已认证；服务查 `GlobalRoleAssignment` | 201 |
| `POST /api/auth/register/applications` | 公开 | 200 |
| `POST /api/auth/register/join-applications` | 公开 | 200 |
| `GET /api/auth/invitations/:token` | 公开；token/状态/有效期/组织活动性 | 200 |
| `POST /api/auth/invitations/:token/accept` | 公开；既有账户须登录 | 201 |
| `POST /api/auth/invitations/:token/accept-authenticated` | 已认证；邮箱匹配 | 201 |

精确路径或「固定前缀 + 恰好一个动态段 + 固定后缀」匹配；尾斜杠、更深子路径、
相似前缀与未列方法继续回落 NestJS。组织管理员按 `users.write` 判定，`manager`
同样可管理；`platform_admin` 只从 `GlobalRoleAssignment` 读取。

## 三、新组织审批阻断修复

源 Nest `approveNewOrgApplication` 在组织创建后取系统 `admin` 角色，再调用普通
`OrgInviteService.createInvite`；普通 `assertRolesAssignable` 必然拒绝系统 admin，
流程停在组织已创建、申请人无法接入。

Go 侧改为受控内部路径：

- 先校验全局 `platform_admin`；
- 条件领取 pending `new_org` 申请；
- 复用 `graphqlread/orgaccesswrite` 的组织 bootstrap（Org、默认三角色、
  RolePermission、审批 actor 的 admin Membership/MembershipRole、org/create 审计、
  提交后失效 `org:active:list:v1`）；
- 由服务端从「本次创建的组织 + 申请」推导 admin 角色与收件人，完成角色存在/
  同组织检查、token、真实邮件与 `invite_create` 审计；
- 不接受任何客户端 `skipChecks` / `allowSystemAdmin` 参数；普通 createInvite 与
  approve-join 仍拒绝系统 admin 与超范围角色。

## 四、接受邀请与角色落地

- 事务内先条件领取 `OrgInvite`（`status='pending'` → `accepted`），影响行数必须为 1；
- 创建或重新激活唯一 `(userId, orgId)` membership，`roleId=primaryRoleId`、
  `isActive=true`；
- 删除旧 `MembershipRole` 并插入本次完整角色集合；
- 领取失败 409 并回滚该事务；不重复授予、不改幂等成功；
- commit 后清理该用户 `profile:<id>:default` 与各组织缓存（本批功能一致性改善）；
- 不签发会话/JWT，不新增 accept 审计或通知。

新用户由服务端创建，`emailVerified` 保持 `NULL`；公开 accept 对既有邮箱返回
403 要求先登录，绝不用请求中的密码覆盖既有账户。

## 五、明确的返回差异

- `reviewedBy` 使用具名用户投影，保留非凭据标量与 null，**排除 `passwordHash`**。
  Prisma `include: { reviewedBy: true }` 会透传凭据字段，此处收窄并记录为差异。
- 公开邀请预览不返回 `tokenHash`；其余 invite/application/membership 字段与
  Prisma include 保持一致（列表只带 primaryRole，create/resend 带 org +
  primaryRole，revoke 仅标量）。

## 六、复用端口

| 复用 | 位置 | 用途 |
| --- | --- | --- |
| JWT/blacklist/membership 权限重推导 | `authhttp` + `authn` + `authz` | 真人身份与 401/503 契约 |
| 机器令牌 | `rbacapi.Service.AuthenticateMachine` | `mtk_` 身份，权限只来自令牌行 |
| 授予范围 | `rbacapi.Service.ActorPermissionSet`（新增窄导出） | 读取 actor 完整权限集合 |
| 密码哈希 | `accountsecurity.HashLoginPassword` / `IsUniqueConstraint` | Node bcrypt cost 10 |
| 真实邮件 | `authlogin.MailSender`（新增窄端口，包装原 SMTP transport） | 邀请/重发/驳回邮件 |
| 组织 bootstrap | `orgaccesswrite.OrgBootstrap`（新增窄端口） | 新组织初始化事务 |
| 审计 | 本包具名 writer，`AuditLog` → 失败写 `AuditLogOutbox` | 消费仍由 Nest 执行 |

## 七、副作用与边界

- 邀请：32 字节随机 token，DB 只存 SHA256，7 天有效；创建/重发先落库再发信，
  SMTP 失败按源传播，不伪称回滚。
- 审计：`users/invite_create|resend|revoke`、`registration_application/approve_join|
  reject_join`、`org/registration_application_approved`；IP 保持 NULL。
- 提交申请不发邮件、不建 token/用户；新组织提交不提前创建 Org/User/Invite。
- 无 BullMQ/cron/worker、OIDC/SSO、Mongo、S3、LLM 依赖。

## 八、验证边界

本机未安装依赖、未运行 build/test、未启动 Docker/服务、未调用真实 SMTP。仅执行
`gofmt`、`git diff --check` 与只读静态复核；真实 MySQL/Redis/SMTP 以及 Nest/Go
混合消费未验证，普通 CI 通过不代表真实邮件投递验证通过。
