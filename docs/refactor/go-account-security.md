# 账户资料、会话退出与机器令牌（Go）

本单元把「账户资料、会话退出与机器令牌管理」8 条已认证 HTTP 用 Strangler Fig
方式迁入 `apps/api-go`，开关 `API_GO_ACCOUNT_SECURITY_MODE`，默认 `legacy`，
并同批修复 Nest 与 Go 两侧的 AS1–AS4。

- 基线：`57d1d4baa5f8432686c8db396968633fd559d43e`（origin/main，普通 CI run
  39064805065 success）
- 分支 / worktree：`refactor/go-account-security` /
  `/Users/oo/project/newwei-go-account-security`
- 生产入口：仍为 Web → NestJS。canary 与 shadow 一律关闭。回滚只需
  `API_GO_ACCOUNT_SECURITY_MODE=legacy`。

## 1. 开关

| 变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `API_GO_ACCOUNT_SECURITY_MODE` | 空串 / `legacy` / `go` | `legacy`（含未设置与空串） | 非法值启动失败，错误文本 `API_GO_ACCOUNT_SECURITY_MODE must be one of legacy|go` |

`go` 复用既有 `appendAuthRequirements`：要求 `JWT_SECRET`、`DATABASE_URL`、
`REDIS_HOST`。**不要求 `MONGO_URI`**：本批只读写 MySQL 与 Redis。真实栈仍按
main 的部署启动 Mongo 供真实 Nest 使用。

## 2. 接管的 8 条路由

| 方法 | 路径 | 权限 | 成功码 | 处理器键 |
|---|---|---|---|---|
| GET | `/api/auth/me` | AllowAuthenticated | 200 | `/api/auth#account-security` |
| PATCH | `/api/auth/profile` | AllowAuthenticated | 200 | 同上 |
| POST | `/api/auth/change-password` | AllowAuthenticated | 200 | 同上 |
| POST | `/api/auth/logout` | AllowAuthenticated | **201** | 同上 |
| POST | `/api/auth/machine-tokens` | `settings.manage` | 201 | 同上 |
| GET | `/api/auth/machine-tokens` | `settings.manage` | 200 | 同上 |
| DELETE | `/api/auth/machine-tokens/:tokenId` | `settings.manage` | 200 | 同上 |
| POST | `/api/auth/machine-tokens/:tokenId/rotate` | `settings.manage` | 201 | 同上 |

`logout` 与两条机器令牌 POST 没有 `@HttpCode(200)`，成功即 201——**不能**因为
登录/改密是 200 就把所有 POST 统一成 200。

路由形状：4 条精确路径 + 1 条精确集合路径（GET+POST 白名单）+ 1 条单段
`DELETE` 规则 + 1 条单段尾随 `/rotate` 的 `POST` 规则。`tokenId` 只能是恰好一个
非空路径段；`/rotate` 只能是最后一段。未列出的方法、尾斜杠、更长路径、空段
（`//`）与相似前缀（`/api/auth/mefoo`、`machine-tokensx`）继续回落 legacy。

**未迁**（即使 `go` 也回 NestJS）：登录、refresh、邮箱验证码、密码找回、MFA、
OIDC、邀请、注册审核、`avatar/presigned-url`、`data-export`，以及其余
`/api/auth/*`。

## 3. 认证与权限

人类调用方与 `authhttp` 同一条链，但本包自建（因为需要保留已验签的
`jti`/`exp`）：

1. `authn.ExtractBearerToken` → HS256 验签（iss/aud/exp/nbf 按现有语义）；
2. Redis `access-token:blacklist:<jti>`（jti 为空按 Nest 语义跳过，查询失败
   fail-closed 500）；
3. `authz` 从真实 MySQL 重推导 User/Org/Membership 与权限——**JWT 的
   permissions claim 一律不相信**；
4. `AllowAuthenticated` 四条命令路由只做认证；机器令牌三条路由要求
   `settings.manage`（人类来自 DB 重推导，机器来自令牌行）。

机器令牌：按完整 `mtk_` 令牌的 SHA-256 查 `MachineAccessToken`，检查
`revokedAt`、`expiresAt <= now`、`Org.isActive`；无效统一 401
`Invalid machine token`；认证后 best-effort 更新 `lastUsedAt`（失败不让正常请求
变 500）。权限只取存储行 JSON 数组中的 string 项，**不按新建白名单裁剪**——历史
`settings.manage` 机器令牌仍能进入管理接口。

`GET /auth/me` 支持真实机器身份，返回 `MachineTokenService.validate` 的字段形状
（`id="machine:<tokenId>"`、`email="<name>@machine.local"`、
`firstName=name`、`lastName="Machine"`、`planTier/subscriptionStatus` 来自组织、
三个 MFA flag 全 false、无 JWT 元数据）。

## 4. GET /api/auth/me 与 PATCH /api/auth/profile 的差异

- `GET /me`：缓存基础 profile + `accessTokenId`（已验签 jti）与
  `accessTokenExpiresAt`（`exp*1000` 毫秒）；缺失时省略键，不用 0 冒充。
- `PATCH /profile`：返回同一基础 profile，**不追加** `accessTokenId` /
  `accessTokenExpiresAt`。这是有意差异，必须保留。
- 基础 profile 字段：`id、email、emailVerified、lastLoginAt、pendingEmail、
  firstName、lastName、avatarUrl、isActive、orgId、primaryRoleId、roleIds、
  permissions、planTier、subscriptionStatus、globalRoles、mfaEnabled、
  mfaRequired、mfaEnrollmentRequired`；日期为 ISO 毫秒或 null；
  `globalRoles` 按 `createdAt ASC`；`mfaEnabled = verifiedAt 存在且 disabledAt
  不存在`；`mfaRequired`/`mfaEnrollmentRequired` 恒 false（不改成登录挑战策略）；
  `roleIds`/`permissions` 去重且集合与 Nest 一致。

## 5. profile 缓存

- 键：`profile:<userId>:<orgId|default>`（orgId 取已验签 claim，Go 与 Nest 访问
  同一 Redis 条目）。
- 缓存内容是 `buildAuthenticatedUser` 基础 profile：不含当前请求 jti/exp、不含
  `passwordHash`/TOTP secret/token 明文。
- 设置：`SystemSetting.key=auth_profile_cache_settings`、Redis
  `auth_cache:settings`、TTL 60 秒。默认 `AUTH_PROFILE_CACHE_TTL_SECONDS=600`、
  `LOCK_TTL_MS=5000`、`MAX_WAIT_MS=5000`、`RETRY_DELAY_MS=50`；归一化边界
  60..86400 / 100..60000 / 10..1000 / 50..120000（且 `maxWaitMs >= retryDelayMs`）；
  存储值只接受有限 number 并 floor（numeric string 不算 number）；row absent
  直接返回未 clamp 的 env 默认。
- `wrap`：`lock:<profileKey>` 的 `SET NX PX <owner token>`；按配置重试并等待；
  持锁期间按 `max(1000, floor(lockTtlMs/2))` 续租；释放与续租都比较 owner token
  （Lua）。等待超时后仍先做最终缓存检查，再 fallback loader。
- 失效：资料更新与改密后删除当前请求键，再按该 user 的全部 Membership 删除每个
  org 的键；不扫描 Redis、不碰其他用户。
- 授权边界：请求授权始终经 `authhttp/authz` 从 DB 重推导，绝不用缓存里的旧权限
  放宽检查；文档说明 Nest profile 可按配置短期缓存。

## 6. 退出

1. `logoutAll=true` → 该 user 所有 `RefreshToken.revokedAt=now`（跨其全部组织，
   表按 userId 归属，**没有 orgId 列**，不给它添加不存在的列）；
2. 否则给了 `refreshToken` → 取 `split(".")[0]` 作为 tokenId（**不使用 refresh()
   的严格解析器**），仅更新 `id=tokenId AND userId=当前用户`；只对仍属于该用户且
   尚未过期的行写 `refresh-token:blacklist:<tokenId>`；
3. 当前已验签 jti/exp 写 `access-token:blacklist:<jti>`（输入是毫秒，TTL =
   `max(0, ceil((expiresAt-now)/1000))`，非正不写）；
4. 按当前 membership 写 `AuditLog(resource=auth, action=logout)`，保留
   AuditLog → AuditLogOutbox 的 best-effort 回退。

Redis 值均为 `true`（Redis 字符串 `true`，即 JSON true），失败上抛，绝不假成功。
`logoutAll` 只保证 refresh 撤销与当前 access 撤销，**不承诺撤销全部历史 access
JWT**。指向其他用户的 refreshToken 不会撤销对方令牌、也不会写对方黑名单。
机器身份没有 jti/exp 也没有真实用户 refresh 行，退出退化为正常无操作。

JWT 元数据例外：现有 `authn.Token` 只暴露 Subject/OrgID/JTI，本批允许给它追加
可选 `ExpiresAt`，只在既有成功验签路径填充——算法、issuer/audience、
nbf/exp 校验与旧 token 兼容语义全部不变，也不使用未验签 decode 的结果决定
黑名单 TTL。

## 7. 机器令牌

- 创建：DTO `name(1..120)`、`permissions(数组，≤20，元素 string)`、可选
  `expiresAt(IsDateString)`；未知字段拒绝。服务层先归一化权限（trim、去重、
  保留首次出现顺序、只留 `metrics.read`），归一化后为空 → 400
  `At least one supported permission is required`；再检查归一化名称非空 →
  400 `Machine token name cannot be empty`（AS4）。
- 明文 `mtk_` + `crypto/rand` 32 字节 RawURLEncoding；DB 只存完整 token 的
  SHA-256 小写 hex；`createdById` 经 `normalizeAuditActorId`：人类保留、
  `machine:<id>`/空 → SQL NULL；`expiresAt` 缺失/null → SQL NULL；返回且只返回
  `{id,name,token,permissions,expiresAt}`（明文只出现这一次）。
- 列表：按 `orgId`、`createdAt DESC`，空时 `[]`；只返回 `id/name/permissions/
  expiresAt/lastUsedAt/revokedAt/createdAt`；`permissions` 保留既有存储输出
  （不过滤、不裁剪）；不过滤 revoked/expired 行。
- 撤销：条件 `id AND orgId AND revokedAt IS NULL`，影响行数不为 1 → 400
  `Machine token not found or already revoked`（不存在/跨租户/已撤销同一错误）；
  不删除记录；不对 tokenId 做 ObjectId 校验；已过期但未撤销仍可撤销。
- 轮换（AS1）：同一 MySQL 事务内 `SELECT ... FOR UPDATE` + 条件撤销 + 新行
  INSERT；新 ID、新随机明文、新 hash；保留原 name、原 expiresAt、原
  `createdById`（不改成当前操作者——`resolvePlatformMetricsAccess` 按原创建者的
  当前 platform_admin 资格授权）与原权限经新建白名单归一化。任何失败回滚，旧行
  `revokedAt` 保持 null；并发轮换/撤销最多一个成功。

## 8. 改密与 bcrypt 72 字节

- DTO：两个必填 string，`MinLength(8)`、`MaxLength(256)`，不做隐式类型转换、
  不 trim 密码。
- 服务：原始字符串相同 → 400 `New password must be different from current
  password`（先于任何 bcrypt）；缺字段 → 400 `Password fields are required`
  （防御分支；DTO 已保证必填，HTTP 上先被 DTO 拦下）；User 不存在或当前密码错
  → 401 `Invalid credentials`；AS2 的 CAS 失败 → 409
  `Password changed by another request; retry with the current password`。
- 成功：200 `{ok:true}`，bcrypt cost=10，密码更新与该 user 全部未撤销
  `RefreshToken` 的撤销在同一事务；事务提交后失效该 user 所有组织的 profile
  缓存。不新增登录/发邮件/MFA 等副作用。
- 跨语言：Node 依赖 `bcrypt@5.1.1`，对超过 72 字节的密码按 **UTF-8 字节**截断
  （并在第一个 NUL 处截断）。Go 侧统一经 `nodeBcryptPassword` 适配——按字节切
  72，不按字符；`bcrypt.GenerateFromPassword` 对超长输入会报
  `ErrPasswordTooLong`，因此绝不对原始输入直接调用。DTO 长度保持 8..256，不改成
  72。原始字符串是否相同仍先于适配判断。
- 保留会话边界：本接口撤销 refresh token；当前及其他已签发 access token 仍按原有
  到期/黑名单机制处理；不新增 tokenVersion，不改 User schema 或公共 JWT 校验。

## 9. 存储地址校验（头像）

先解析有效存储配置（Redis `storage:settings` TTL 60 → DB 的 `storage_s3_*` →
`S3_*` env fallback；`system-settings:v1` 密钥解密，失败回退 env）。四要素
（`accessKeyId`/`secretAccessKey`/`bucket`/`publicBaseUrl`）不完整 → 400
`Storage configuration is incomplete`；`publicBaseUrl` 只去掉末尾一个斜杠；
`avatarUrl` 必须 `startsWith(publicBaseUrl + "/")`。不请求头像 URL、不访问 S3、
不签上传链接，也不新增「只能自己的 avatars/<userId>」规则。

## 10. AS1–AS4 缺陷修复

| 缺陷 | Nest 修复点 | Go 修复点 |
|---|---|---|
| AS1 轮换非原子 | `machine-token.service.ts` rotate 改为 Prisma interactive transaction；抽出接受 `Prisma.TransactionClient` 的内部创建 helper，事务内绝不调用 public create | `machine_tokens.go` `sql.Tx` + `SELECT ... FOR UPDATE` + 条件 UPDATE + INSERT，错误路径 Rollback，Commit 成功后才返回明文 |
| AS2 并发改密覆盖 | `auth.service.ts` changePassword 在事务内按 `id + 原 passwordHash` CAS，count!=1 → 409 并回滚 refresh 撤销 | `password.go` 同事务 `WHERE id = ? AND passwordHash = ?`，影响行数必须为 1 |
| AS3 null/不存在 User | `auth.service.ts` updateProfile 用可空输入类型，null → 同字段 empty 400；写前确认真实 User 存在，缺失 → 401 `Invalid access token` | `profile.go` 同样的可空处理与存在性检查 |
| AS4 createdById 外键 / 空白名称 | `machine-token.service.ts` 复用 `normalizeAuditActorId`；空白名称在权限检查之后 400 | `machine_tokens.go` 同样的 NULL 归一化与空白名称拒绝 |

详见 `docs/refactor/bug-ledger.md` §8。

## 11. 已知边界与未验证项

- 本机只做 `gofmt` 静态检查（`go build/test/vet`、pnpm 脚本、docker 均未在本机
  运行）；执行验证全部在 GitHub Actions。
- 生产 Web → NestJS 未切换，canary/shadow 关闭。
- `change-password` 的「Password fields are required」在 HTTP 上是防御分支：DTO
  的必填 + `MinLength(8)` 先返回 class-validator 消息。
- go 模式下的 profile 缓存失效与黑名单写入依赖 Redis；Redis 不可用时按既有语义
  fail-closed（500），不伪造成功。

## 12. 远端验证证据

PR #60（Ready，未合并，auto-merge 关闭），最终 head
`c6eb4e068d25feaff77e15d06cab2b4064c86531`：

- 普通 CI：run
  [39079671944](https://github.com/wei500L/newwei/actions/runs/39079671944) success
  （Go 模块漂移门禁、Go tests api-go/vector-go、lint/typecheck、web/vector/api 单测、
  OpenAPI 快照与鉴权矩阵漂移检查、两个真实栈 integration job 全绿）。
- 真实栈 smoke：run
  [39079675913](https://github.com/wei500L/newwei/actions/runs/39079675913) success，
  末行输出 `api-go account security smoke: ALL OK`，阶段依次为：

| 阶段 | 覆盖 |
|---|---|
| A | 非法 `shadow`/`canary` 启动失败（错误文本一致）；legacy 下 8 条经 Go 代理与 Nest 全等；未迁方法/路径仍回落 |
| B/C | go 接管后 GET me 字段/`accessTokenId`/`accessTokenExpiresAt`/MFA flag；`PATCH profile` 有意无 JWT 元数据；Go↔Nest 资料互见；头像地址只做配置校验；A/B 缓存失效而 V 保留且缓存不含 jti/exp/passwordHash；机器令牌双向创建/验证/撤销；历史 `settings.manage` 令牌可管理且 list 保留原始 permissions；跨组织令牌只看本组织；AS4 空白名称/NULL 创建者/creator 继承 |
| D | logout 201 + Redis `true` 值与 TTL、Nest/Go 双侧黑名单、其他会话不受影响、跨用户 refresh 不被动、logoutAll 只撤销本用户 refresh、审计 resource/action/orgId 正确且无凭证 |
| E | AS1（并发轮换唯一 201、触发器 INSERT 失败回滚旧行）、AS2（Nest↔Go 并发改密唯一胜者 + refresh 全撤销）、AS3（null/空白 400 无部分写入、机器身份 401）、AS4 |
| F | 停止 Nest 后清空 profile 缓存仍能读出非空 profile；8 条全部由 Go 执行；未迁路径（login/refresh/mfa/data-export/avatar 签名）502；Go 容器保持 healthy；重启 Nest 后用 Go 设置的新密码真实登录成功、旧密码失败 |
