# 登录、会话签发与账户验证迁入 Go（AUTH-LOGIN-001）

本批把 NestJS `apps/api/src/modules/auth` 的**公开登录主链**迁入
`apps/api-go/internal/authlogin`，用一个独立开关控制，默认保持 legacy。

## 一、开关

| 变量 | 取值 | 默认 |
| --- | --- | --- |
| `API_GO_AUTH_LOGIN_MODE` | 空串 / `legacy` / `go` | `legacy` |

- 空串与 `legacy` 等价：11 条路由全部代理 NestJS，行为与今日一致。
- 其他任何值（含 `shadow`、`canary`、`Go`、`1`）**启动失败**，绝不静默降级。
- 非法值错误文本：`API_GO_AUTH_LOGIN_MODE must be one of legacy|go`。
- 该开关与其他迁移批次完全独立：`ACCOUNT_SECURITY`、`AUTH_FACTORS`、GraphQL
  以及其余批次均保持 legacy 时本批可单独工作；三者同时为 `go` 时路径互不覆盖
  （注册键分别是 `/api/auth#login`、`/api/auth#account-security`、
  `/api/auth#factors`，路由测试锁定不冲突）。

### go 模式的启动资源

必需：

- `JWT_SECRET`（+ `JWT_ISSUER` / `JWT_AUDIENCE`，默认值与 NestJS env schema 一致）
- `DATABASE_URL`、`REDIS_HOST`
- `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`

不需要：`MONGO_URI`；不启动 worker/cron；不联系 IdP；不发启动邮件。
`SYSTEM_SETTINGS_ENCRYPTION_KEY` 沿用 `authfactors` 既有规则：启动不强制，缺失或
不可解码时由被复用的 MFA 因子服务按写入/读取路径给出既有 500/明文回退语义。

### 回滚

`API_GO_AUTH_LOGIN_MODE=legacy` 即可。DB schema、Redis key、refresh/challenge
协议全部与 NestJS 兼容，因此 **不需要数据回滚**；已完成的密码修改与邮箱变更
不会被回滚。生产 Web 入口仍指向 NestJS，canary 默认关闭。

## 二、接管的 11 条路由

| 方法 + 路径 | 权限 | 成功 |
| --- | --- | --- |
| `POST /api/auth/login` | Public | 200 会话结果 / MFA challenge / 强制绑定 challenge |
| `POST /api/auth/refresh` | Public（refresh 凭据校验身份） | 200 新会话结果 |
| `POST /api/auth/send-login-code` | Public | 200 `{ok:true,cooldownSeconds}` |
| `POST /api/auth/login-with-code` | Public | 200 会话结果 / challenge |
| `POST /api/auth/mfa/verify-login` | Public（challenge + TOTP/恢复码） | 200 会话结果 |
| `POST /api/auth/mfa/enrollment/start` | Public（绑定 challenge） | **201** `{secret,otpauthUri}` |
| `POST /api/auth/mfa/enrollment/complete` | Public（绑定 challenge + code） | 200 会话结果 + `recoveryCodes` |
| `POST /api/auth/password/forgot` | Public | 200 `{ok:true}` |
| `POST /api/auth/password/reset` | Public（reset token） | 200 `{ok:true}` |
| `POST /api/auth/send-verification` | AllowAuthenticated | 200 `{ok:true,cooldownSeconds}` |
| `POST /api/auth/verify-email` | AllowAuthenticated | 200 更新后的完整 profile |

全部是 **exact path + POST 白名单**：不支持的方法、尾部斜杠、相似前缀、更长路径
以及 `/api/auth` 下其他路径一律回落 `/api/` legacy 规则。CORS 预检由 Go 204 回答，
无预检头的 OPTIONS 交回代理。**没有**整段接管 `/api/auth`。

## 三、会话结果与 challenge

- 会话体：`user`、`accessToken`、`refreshToken`、`organizations`、`expiresIn`
  （字段顺序与 NestJS 对象字面量一致，不添加 `tokenType`）。
- `user` 字段沿用 `GET /me` 的同一类型（`accountsecurity.profileResponse` 别名），
  因此可空字段为 `null`、空数组为 `[]`，与既有 profile 契约单源。
- `organizations` 按 `Membership.createdAt` 升序去重（首次出现位置保留，与 JS `Map`
  一致），`isActive = org.isActive && membership.isActive`。
- MFA challenge：`user` + `organizations` + `mfaRequired:true` + `authChallengeId`
  + `challengeExpiresAt`；强制绑定：`mfaEnrollmentRequired:true` +
  `enrollmentChallengeId` + `challengeExpiresAt`。**challenge 响应不预先签发 token**；
  仅在强制绑定完成后附带一次明文 `recoveryCodes`。
- 强制绑定 TTL：login 10 分钟 / enrollment 15 分钟；尝试上限
  `AUTH_MFA_CHALLENGE_MAX_ATTEMPTS`（默认 5），达到上限写 `lockedAt` 并回 429。

## 四、复用的既有 Go 代码

新增两处**窄复用端口**（仅导出本条链需要的具名类型与函数，不改任何既有语义）：

- `internal/accountsecurity/login_port.go`
  `LoginStore`：按 email/id 读用户（含 `passwordHash`）、membership 列表、
  `PickLoginMembership`（`requireExplicitOrg:false`，登录缺省取最早活动 membership）
  与 `PickSessionMembership`（保留原「多活动组织必须显式选择」语义，refresh 使用）、
  `Profile`（角色/权限/全局角色/MFA 状态的同次装配）、`Organizations`、`OrgAdmin`
  （仅按组织内角色名判 admin）、`InvalidateProfileCache`、refresh/access 撤销名单
  读写、`CompareLoginPassword`/`HashLoginPassword`（Node bcrypt 兼容：NUL 截断 + 72
  字节上限）、`IsUniqueConstraint`（MySQL 1062）。
- `internal/authfactors/login_port.go`
  `LoginMfaStatus`、`LoginBeginEnrollment`、`LoginVerifyEnrollment`（既有 TOTP、
  恢复码单次领取、密钥加解密、pending factor 提升、profile 缓存失效一次性复用）、
  `LoginVerifyCredential`（在调用方事务内跑既有凭据校验）、`IsInvalidMfaCode`。

`authhttp.Write*` 错误写入器直接复用（JWT 验签、Redis 撤销名单、MySQL
membership/permission 重推导链也复用 `internal/authhttp`）。

**没有**写第二套 TOTP/恢复码算法，**没有**迁移已完成的七条 MFA 管理接口。

## 五、协议兼容（可与 NestJS 并存 / 随时回滚）

| 协议面 | 兼容性 |
| --- | --- |
| Access JWT | HS256、同一 secret/iss/aud、`sub`/`orgId`/`permissions`、`iat`/`exp`/`jti`（UUID）；默认 15m / 7d，时长按数字+`[smhd]` 解析 |
| Refresh token | 32 字节随机 hex secret；bcrypt cost 10；`tokenId.orgId.secret`，并继续接受 Nest 旧格式 `tokenId.secret`；id 为 UUID |
| Refresh 轮换 | grace 缓存 `auth:refresh:<tokenId>:<sha256(secret)>`、共享锁 `lock:<cacheKey>`（TTL/maxWait ≥10s、retryDelay 50ms、释放/续租 Lua 兼容）、撤销前置于 grace 缓存之外、loader 内二次检查、条件 UPDATE 单次领取、bcrypt 比对、成功后按原过期剩余秒数写 `refresh-token:blacklist:<tokenId>` |
| 验证码 | `auth:email-code:<scene>:<identifier>`(+`:attempts:`/`:cooldown:`)、payload `{codeHash,email,userId?}`、8 位安全随机码只存 SHA256、冷却 SET NX、错误计数、过限删除、单次 `DEL` 消费；配置读 `auth_email_code:settings` → `auth_email_code_settings` → 环境默认（300/90/3），范围 60..1800 / 10..3600 / 1..10，缓存 60s |
| MFA policy | `system_security` + `auth:system-security`（60s），`off`/`admins_only`/`all_users`；`off` 不绕过用户已启用的 MFA |
| Challenge | `AuthChallenge` 表、`mfa_login`/`mfa_enrollment`、payload `{orgId,ipAddress,userAgent,action?}`、`expiresAt`/`consumedAt`/`failedAttempts`/`lockedAt` 语义与领取谓词一致；保留 `action` 标签兼容既有 OIDC challenge（不迁移 OIDC 入口） |
| 限流 | `rate:login:<email>:<ip>`、`rate:login-code:<email>:<ip>`（单一组合键、非两个桶）；配置读 `rate_limit:settings` → `rate_limit_login` → `RATE_LIMIT_LOGIN`/`_WINDOW`（5/60）；`forgot` 用独立 `auth.password_reset` policy（email 3 / IP 10 / 900s） |
| 审计 | `AuditLog` → 失败回退 `AuditLogOutbox`（既有消费者可重放）；保留 orgId/actorId/resource/action/具名 metadata，并且**写入真实 IP**（旧 `accountsecurity` 端口写 NULL，本批不复用其写入口） |

IP 解析沿用既有 Go 批次（`exceptioningest`/`graphqlread`）的地址解析方式：`TRUST_PROXY`
未设置时使用 socket 地址并忽略 `X-Forwarded-For`（避免限流桶被伪造头共享）；配置为
数字跳数时按从右索引取该跳的地址；其他取值按 1 跳处理。Express 的
`trust proxy=true`（取最左值）本批不单独实现，以与既有批次保持同一语义。

## 六、关键事务与顺序（源码注释已说明原因）

1. 可信登录：重载用户 → membership/role/全局角色/MFA 状态 → MFA 决策 → 才
   `finalizeLogin`（签发 access → 持久化 refresh → 更新 `lastLoginAt` → 审计 →
   读组织选项）。返回的 profile 仍携带**更新前**的 `lastLoginAt`。
2. 验证码登录：先限流 → 校验 payload/email/hash/user → **原子 DEL 成功**（返回 1）
   才进入 MFA/签发；不先签 token。
3. refresh：撤销预检（缓存之外）→ 缓存/锁 → 二次撤销检查 → 条件 UPDATE 单次领取
   （必须先于 secret 比对）→ 读记录 → bcrypt → 重校验用户/组织 → 签发新 token 对 →
   旧 token 加撤销名单。
4. challenge：login 先验凭据（事务内恢复码单次领取 + `lastUsedAt`）再条件消费；
   enrollment 先条件领取 challenge 再 `VerifyEnrollment`（避免重复旋转恢复码），
   错误验证码分支归还 challenge 并累计失败，其他错误保留原语义。
5. reset：无效/已用/过期 token 与密码长度先校验，然后**一个事务**内改 bcrypt 密码、
   消费该用户全部未用 reset token、撤销全部未撤销 RefreshToken。
6. 邮箱变更失败清理：清 code/attempt/cooldown，仅在 `pendingEmail` 仍等于本次值时
   清回；唯一约束映射原 400。

## 七、SMTP

真实 SMTP（`net/smtp` + `crypto/tls`，标准库），逐条连接，不引入投递平台：

- `SMTP_SECURE`（默认 true）= 隐式 TLS；false 时若服务端宣告则 STARTTLS。
- `SMTP_TLS_REJECT_UNAUTHORIZED`（默认 true）；SMTP 鉴权 PLAIN；`from` 缺省 `user`。
- 超时：连接 10s / greeting 10s / socket 30s（`SMTP_CONNECTION_TIMEOUT_MS` 等可覆盖）。
- 文本 + HTML 验证码模板，与 `templates/verification-code*.hbs` 内容一致；找回密码
  正文与 NestJS 相同。
- `SMTP_POOL`（及既有的 `SMTP_MAX_CONNECTIONS` 等调度参数）**接受但忽略**：池化是
  nodemailer 的投递调度优化而非协议差异；本批按每条消息一条连接实现，未实现连接池。
- 不打印密码、验证码、refresh secret、TOTP secret 或恢复码。

发送失败语义按原契约区分：`send-login-code` 吞掉失败并清理本次 code/attempt/cooldown
（响应仍为 `{ok:true}`）；`password/forgot` 的邮件失败**原样传播**。

## 八、边界与未完成

- 不迁移：注册/邀请审批、OIDC start/callback/handoff 生产者、头像与数据导出、
  已迁账户管理/登出/机器令牌、已认证 MFA 管理与 OIDC 配置、worker/cron 消费者。
- 未改 DB schema、未改 NestJS 业务/装饰器/签名、未改 Web。
- 限流的 Redis 超时补偿（NestJS `COMPENSATE_TIMED_OUT_LUA`）未移植：仅在
  `RATE_LIMIT_REDIS_FAIL_OPEN=true` 时才可能有配额偏差，默认 fail-closed 路径不受影响。
- 本机未运行 build/test/Docker/服务/真实 SMTP；并发、真实 MySQL/Redis 与真实邮件
  投递未验证，交普通 CI 与后续真实环境验证。
