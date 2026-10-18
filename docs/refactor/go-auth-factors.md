# 认证要素：MFA 管理与组织 OIDC 配置迁入 Go（7 条 HTTP）

分支 `refactor/go-auth-factors`；基线 `origin/main` `57d1d4ba`（PR #55 合并后）。
独立开关 `API_GO_AUTH_FACTORS_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值
启动失败）。生产入口继续 Web → NestJS，Nest 全部路由保留，canary 关闭，不启用
shadow，不改前端。

Go 侧实现：`internal/legacyproxy/auth_factors_routes.go`（路由规则）、
`internal/authfactors/`（handler / 鉴权 / MFA / OIDC / 加密 / 缓存 / 锁）、
`cmd/api/auth_factors.go`（装配）。整包只用命名的强类型 struct 与具名常量；
JSON 只在「存储值本身没有 schema」的边界解码成具名模型，业务代码不接触松散
`map`。

## 1. 范围与开关

- `API_GO_AUTH_FACTORS_MODE` 只接受空字符串、`legacy` 或 `go`：空串与 `legacy`
  等价，缺省永远是 `legacy`；其他任何值让**进程启动失败**，错误文本是
  `API_GO_AUTH_FACTORS_MODE must be one of legacy|go`。
- `go` 时经既有 `appendAuthRequirements` 要求 `JWT_SECRET`、`DATABASE_URL`、
  `REDIS_HOST`（缺一即启动失败，错误文本形如
  `JWT_SECRET is required when API_GO_AUTH_FACTORS_MODE=go`）。**不要求
  `MONGO_URI`**：本批只读写 MySQL 与 Redis。
- 不启动 worker / 定时任务，不打开 shadow，不启用 canary，不改前端，不改
  GraphQL/SDL/controller/DTO/数据库 schema，不新增表，不加 MFA 或密码策略。
- `go` 时由 `WithAuthFactors` 追加七条**精确 path + method 白名单**规则，处理器
  注册键 `AuthFactorsKey = "/api/auth#factors"`。不注册整段前缀：HEAD、未列出的
  方法、尾斜杠、相似前缀与更长路径全部回落 `/api/` legacy 规则（Go 不返回自己的
  404）。预检 `OPTIONS` 由 Go 的 CORS helper 应答，非预检 `OPTIONS` 仍
  `ServeLegacy`。
- 回滚只把 `API_GO_AUTH_FACTORS_MODE` 改回 `legacy`（或删除该变量）并重启
  api-go：七条恢复经 Go 网关代理到 NestJS。Nest 与 Go 读写同一批 MySQL 行与同一
  Redis 键，加密信封格式相同，无数据迁移耦合。

## 2. 七条路由契约与未迁移清单

| # | 方法 | 精确路径 | 权限 | 成功码 |
|---|---|---|---|---|
| 1 | GET | `/api/auth/mfa` | `AllowAuthenticated`（无额外权限） | 200 |
| 2 | POST | `/api/auth/mfa/enroll` | `AllowAuthenticated` | 201 |
| 3 | POST | `/api/auth/mfa/verify-enroll` | `AllowAuthenticated` | 201 |
| 4 | POST | `/api/auth/mfa/disable` | `AllowAuthenticated` | 201 |
| 5 | POST | `/api/auth/mfa/recovery/rotate` | `AllowAuthenticated` | 201 |
| 6 | GET | `/api/auth/admin/oidc-config` | `settings.manage` | 200 |
| 7 | PUT | `/api/auth/admin/oidc-config` | `settings.manage` | 200 |

明确留在 Nest（本批不迁）：

- 登录 / refresh / logout / profile（`/api/auth/me`）/ change-password /
  machine-tokens；
- 公开的 MFA 登录挑战 `POST /api/auth/mfa/verify-login` 与强制注册挑战
  `POST /api/auth/mfa/enrollment/start`、`POST /api/auth/mfa/enrollment/complete`；
- 整条 OIDC 登录链 `GET /api/auth/sso/oidc/start`、
  `GET /api/auth/oidc/callback`、`POST /api/auth/sso/handoff/exchange`。

本批**从不访问身份提供方**：不发 discovery 请求、不取 JWKS、不调用 token
endpoint；**从不签发** access token 或 refresh token；装配时不创建任何 HTTP
client，也不做启动网络探测。OIDC 两条只读写本组织的本地配置行。

## 3. 认证与身份边界

- **人类**：复用 `authhttp` 链——JWT 验签（签名、issuer/audience、exp/nbf）+
  Redis access-token 撤销名单 + MySQL membership/permission 重推导。`orgId` 与
  权限集合只来自数据库重推导，**不信任 JWT 的 permissions claim，也不看
  body/query 里的 `orgId`**。
- **机器令牌**（`mtk_` 前缀）：原文 SHA-256 十六进制查
  `MachineAccessToken.tokenHash`，连 `Org.isActive`，拒绝 `revokedAt` / 过期 /
  组织停用（401 `Invalid machine token`），命中后刷新 `lastUsedAt`；身份为
  `machine:<tokenId>`，权限与 `orgId` 只来自令牌行。
- `GET /api/auth/mfa` 对机器身份**返回空状态**（机器 id 不是 User 行，本来就没有
  factor 行）；四条 MFA 写路由先要求真实人类 `User`，机器身份 403
  `MFA management requires a human user`。
- OIDC 配置是**租户设置**：只要求调用者本组织的 `settings.manage`，**没有全局
  `platform_admin` 门禁**。因此历史机器令牌若其存储权限含 `settings.manage`，
  仍可读写自己组织的 OIDC 配置（既有边界，刻意保留）。
- 不对整个 `/auth` 前缀加人类规则：人类/机器规则只作用于这七条精确路由。
- 失败顺序固定：认证 401 → 权限 403 → DTO 400；无权限响应用既有
  `INSUFFICIENT_PERMISSIONS` 契约，基础设施失败 fail-closed（Redis/MySQL 失败
  500/503，绝不静默放行）。

## 4. 执行顺序

固定顺序，与 Nest 的 Guard 链一致：

1. 认证（人类 JWT 链或 `mtk_` 查库）；
2. 权限（只有 OIDC 两条要求 `settings.manage`；MFA 五条是 `AllowAuthenticated`）；
3. DTO 校验（`verify-enroll`/`disable`/`rotate` 的 `code`，以及 OIDC PUT 的
   `OidcConfigDto`）；
4. MFA 写路由的人类身份检查（AF5 的 403）；
5. 每用户锁 → 业务校验 → 事务/数据库 → 提交后 cache 失效。

`GET /api/auth/mfa` 不取锁、不写库；`POST /api/auth/mfa/enroll` 声明无 `@Body`
DTO，请求体刻意不读不校验（缺失/空/任意 body 不改变结果）。

## 5. 逐接口语义

### GET `/api/auth/mfa`

- 五字段恒在：`enabled`、`enrolledAt`、`verifiedAt`、`lastUsedAt`、
  `recoveryCodesRemaining`。
- 无 factor 行 → 空状态：`enabled=false`、三个时间字段 `null`、
  `recoveryCodesRemaining` 为未使用恢复码计数（无行时为 0），不报错。
- 只用认证得到的用户 id，不接受任何其他 user id；不创建也不更新任何行。

### POST `/api/auth/mfa/enroll`

- 32 字符 Base32 secret：`crypto/rand` 取 20 字节，RFC 4648 无填充、大写字母表
  （A–Z、2–7）编码。
- otpauth URI 逐字节复刻 Nest：
  `otpauth://totp/Modular:<encodeURIComponent(accountName)>?secret=<encodeURIComponent(secret)>&issuer=Modular&algorithm=SHA1&digits=6&period=30`。
  issuer label 固定 `Modular`，accountName 是调用者自己的真实 email；百分号编码
  复刻 JavaScript `encodeURIComponent`（未保留字符集
  `A-Za-z0-9-_.!~*'()`，其余按 UTF-8 字节大写 hex 转义），不用
  `url.QueryEscape`/`url.PathEscape`。
- 已存在 **active** 因子（`verifiedAt` 有值且 `disabledAt` 为空）时只写
  `pendingSecret` / `pendingLabel` / `pendingStartedAt`：已验证的 secret 与当前
  恢复码继续可用，直到 pending 注册被确认。
- 其他状态整体替换 secret 并清空 pending/verified/disabled/lastUsed（一次
  upsert 语句保证分支原子）。
- 成功 201，正文 `{secret, otpauthUri}`；明文 secret 只返回这一次，绝不落日志。

### POST `/api/auth/mfa/verify-enroll`

- DTO：`code` 必填字符串、`@MinLength(6)`，无上限、无数值模式；未知成员
  `property <name> should not exist`；多条消息按 class-validator 声明顺序用
  `"; "` 拼接。
- **AF1 规则**：无 factor 行 → 400 `MFA enrollment is not initialized`；**active
  且无 pending**（已完成注册）→ 同一条 400，绝不再次生成恢复码。
- 取 `pendingSecret ?? secret` 解码；TOTP 校验窗口 `counter-1 / counter /
  counter+1`，六位 ASCII 数字，HMAC-SHA1、30 秒步长；失败 400
  `Invalid MFA verification code`。
- 成功在**同一事务**内：提升（`secret` = 本次注册 secret、`label` =
  `pendingLabel ?? label`、`pendingSecret`/`pendingLabel`/`pendingStartedAt` 清成
  SQL NULL、`disabledAt` 置 NULL、`verifiedAt`/`lastUsedAt` 为当前毫秒）→ 删除该
  用户全部旧恢复码 → 新建 **8** 条恢复码。`enrolledAt` 只在「active 因子的
  pending 替换被提升」时改写为 `verifiedAt`，其他完成路径保留原值。
- 提交后、仍在锁内失效 profile 缓存（见 §10）；事务绝不重放，因此缓存失败不会
  二次生成恢复码。成功 201，正文 `{recoveryCodes, enabled, enrolledAt,
  verifiedAt, lastUsedAt, recoveryCodesRemaining}`。

### 恢复码格式

- 每条 10 位**大写 hex**（5 个 `crypto/rand` 字节），共 8 条；明文只返回一次。
- 存储为**小写 hex 的 SHA-256**（`hashOpaqueToken`），不引入 bcrypt/额外 salt；
  查找时先 `trim + toUpperCase` 再哈希。

### POST `/api/auth/mfa/disable`

- 人类身份检查 → 每用户锁 → **单事务**：校验 TOTP 或一条未使用恢复码（含
  `usedAt` 条件声明与 `lastUsedAt` 刷新）→ 写 `disabledAt` → 删除恢复码 → 提交 →
  失效 profile 缓存。factor 行保留，secret 字段不清空。
- 恢复码声明是条件更新 `usedAt IS NULL` 且要求**恰好影响 1 行**；未命中/被并发
  抢走 → 401 `Invalid MFA verification code`。
- 成功 201，正文是五字段状态。

### POST `/api/auth/mfa/recovery/rotate`

- 人类身份检查 → 锁；明文 8 条码在事务**之前**只生成一次（响应必须等于本次提交
  的集合，重试也不重新生成）。
- 单事务：校验（TOTP 或单次恢复码）→ 删除旧码 → 插入 8 条新码 → 提交。
- 并发语义：两个并发 rotate 不能各自用旧集合授权后再互相覆盖——授权与替换同事务，
  且全程持同一把每用户锁。TOTP secret 不动，不启动新注册。
- 成功 201，正文同 verify-enroll。

### GET / PUT `/api/auth/admin/oidc-config`

- 见 §11；GET 200，PUT 200。

## 6. 每用户全局锁与事务边界

- 锁名：`mfa:` + `sha256(userId)` 十六进制**前 60 字符**，即**恰好 64 个 ASCII
  字符**（MySQL `GET_LOCK` 名称上限）。**不带 org 后缀**：TOTP 因子是全局用户
  状态，同一 `UserTotpFactor` 行被该用户所有 membership 共享；加 org 后缀会让同一
  用户在两个组织里的请求并发交错 begin/verify/disable/rotate。
- Nest（`auth-factors.lock.ts` 的 `mfaUserLockName`）与 Go
  （`internal/authfactors/lock.go` 的 `mfaUserLockName`）计算**同名**字符串，因此
  Nest 写者与 Go 写者对同一用户互相串行。
- 锁覆盖**读取 → 验证 → 事务提交 → cache 失效**全程：
  - Nest：包装既有 `withMysqlSessionLock`，专用 MySQL 会话执行
    `GET_LOCK(name, 10)`，回调 resolve 后释放；
  - Go：专用 `*sql.Conn` 固定整段；`GET_LOCK` 返回值按可空整数扫描（1=取到、
    0=等待超时、NULL=错误）。
- 失败区分：
  - `GET_LOCK` 返回 0（锁被他处持有）→ **409**
    `MFA settings are being updated by another request; retry later`；
  - 其他失败（连接被拒、握手失败、缺 DSN）→ **503**
    `{statusCode:503,message:"Internal server error",error:"Service Unavailable"}`；
  - 业务 `HttpException`（400/401/403）原样重抛，绝不被伪装成锁/基础设施错误。
- 释放：Go 用 `context.WithoutCancel` + 独立 5 秒超时执行 `RELEASE_LOCK`，被取消的
  客户端请求不能留下未释放的锁；`RELEASE_LOCK` 未确认成功时返回
  `driver.ErrBadConn` 驱逐物理连接，绝不把可能仍持锁的会话放回连接池。
- 锁名、MySQL 连接信息与任何密钥都不出现在响应正文。

## 7. AF1–AF5 根因与修法

| 编号 | 修复前证据（基线 `57d1d4ba`） | 影响 | 修法（Nest / Go） |
|---|---|---|---|
| AF1 | `mfa.service.ts:115-157`（`verifyEnrollment` 只判 factor 行存在，随后总是 `pendingSecret ?? secret`） | 已完成注册的 active 因子可被再次「完成」，整组恢复码被替换 | Nest `verifyEnrollment` / Go `VerifyEnrollment`：`active && !pendingSecret` → 400 `MFA enrollment is not initialized`；锁内重读因子，并发 verify 只能完成一次 |
| AF2 | `mfa.service.ts:167`（disable 调用）、`:183`（rotate 调用）、`:414-463`（helper 在自己的 `$transaction` 里提交 `usedAt`） | 后续写失败会留下「码已消费但动作未生效」；并发管理动作可各自用旧集合授权后互相覆盖 | `verifyFactorOrRecoveryCode` 改收显式 `Prisma.TransactionClient`；disable/rotate 的校验 + `lastUsedAt` + 状态变更在**一个事务**内；声明仍是条件 `UPDATE ... WHERE usedAt IS NULL` 且要求恰好 1 行。Go 同边界 |
| AF3 | `auth.service.ts:262-272`（`invalidateProfileCache` 删 `profile:<userId>:default` 与全部 membership org）、`auth.service.ts:1445-1499`（`getUserProfile` 缓存 `buildAuthenticatedUser`）、`auth.service.ts:404-407`（`buildAuthenticatedUser` 读 `mfaService.getStatus`） | `MfaService.verifyEnrollment`/`disable` 从不失效 profile 缓存，`mfaEnabled` 最长可陈旧 600 秒默认 TTL | 新增专用 helper + `MfaService` 注入 `CacheService`；提交后、锁内删除该用户 `default` 与全部 membership 组织条目，只删这些键 |
| AF4 | `oidc-auth.service.ts:116-121`（预读 `existing` 并回落 `existing?.clientSecret`）、`:134-136`（无新 secret 时把预读密文写回 upsert） | 不带 secret 的更新可把并发轮换的新 secret 回退成旧值 | Nest 在无有效 secret 时把 `clientSecret` 字段整体从 `update` payload 省略（create 分支写 SQL NULL）；Go 用第二条 `INSERT ... ON DUPLICATE KEY UPDATE` 语句省略 `clientSecret` 赋值。两者都在**写入期**原子保留 |
| AF5 | `jwt-auth.guard.ts:36-41`（放行 `mtk_`）、`machine-token.service.ts:164`（身份 `machine:<tokenId>`）、`auth.controller.ts:243-274`（MFA 路由 `@AllowAuthenticated()`）、`mfa.service.ts:64-113`（`beginEnrollment` 写 `UserTotpFactor.userId = "machine:<id>"`） | 违反 `User(id)` 外键，泛化成 500 | 四条 MFA 写路由先要求真实人类 `User`，否则 403 `MFA management requires a human user`；`GET /api/auth/mfa` 对机器身份仍返回空状态；OIDC 保持租户机器令牌边界；不施加到其他 `/auth` 路由 |

- **AF1 回归点**：对 active 且无 pending 的因子再次 verify-enroll → 400，且旧恢复码
  集合字节不变；active 因子再 enroll 只写 `pendingSecret`；pending 确认时提升并替换
  码集；并发完成同一注册只有一个成功、只生成一套码。
- **AF2 回归点**：只在测试库注入写失败，证明恢复码消费与管理变更同事务回滚；同一
  恢复码并发最多一个成功；两个不同旧码并发 rotate 不会互相覆盖；公开登录挑战的
  单次使用与尝试锁定行为不变。
- **AF3 回归点**：预热用户在 org A/B 的 profile，verify/disable 后两组织的
  `GET /api/auth/me` 立刻反映 `mfaEnabled`；Nest 写/Go 读与 Go 写/Nest 读都成立；
  其他用户的缓存不被删除；缓存里不含 secret 或恢复码。
- **AF4 回归点**：secret 缺失/null/空白保留；首次无 secret 写 SQL NULL；并发
  Go/Nest 不带 secret 不覆盖刚写入的 secret；响应与日志无 secret。
- **AF5 回归点**：机器令牌四条写 403 且无副作用；`GET /api/auth/mfa` 机器身份空
  状态；无权限人类仍 403；OIDC 机器令牌按自身权限边界读写。

## 8. 密钥策略

- 读全局 `SystemSetting` key `system_security` 与 Redis **`auth:system-security`**
  （**60 秒 TTL**）。缓存的是**原始设置值**（或非对象 JSON 值/null），**不是**
  `system_security:settings` 的 `{exists,value}` 信封——两套缓存不可互换。
- `secretEncryptionEnabled` 是**三态**：`true` / `false` / 未配置。存储值不是对象、
  或成员不是 JSON boolean，一律视为「未配置」，**绝不静默当成 false**（那会把已启用
  的加密策略降级为明文）。缓存命中 JSON 字面量 `null` 视为未命中（JS falsy），回落
  数据库；缓存读失败只记日志并回落 DB。
- 信封格式（与 Nest 完全一致，与实现无关）：
  `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":base64,"tag":base64,"data":base64}`；
  **32 字节 key、每次加密新的 12 字节随机 IV、16 字节 tag 独立保存、无 AAD、标准
  base64**。
- key 解析：trim 后可选 `0x`/`0X` 前缀 + **恰好 64 位 hex**；否则按 **Node 兼容
  base64** 解析（跳过非字母表字符、遇 `=` 终止、长度补 `=`、余 1 丢弃）并要求解出
  **恰好 32 字节**。
- 错误处理差异（刻意保留）：
  - `encodeSecret` 复刻 **AuthSecurityService** 语义，**没有 BadRequest 包装**：
    `secretEncryptionEnabled=true` 且无可用 key → 抛错，按生产 500 呈现；`NODE_ENV`
    精确等于 `production` 且无 key → 同样 500；否则明文落库并记安全 warning；
    `secretEncryptionEnabled` 精确为 `false` 且有有效 key → 明文逃生门。
  - `decodeSecret`：裸字符串原样返回；合法信封但无可用 key → 返回 null（不报错）；
    有 key 时解密失败按**当前错误传播**（绝不伪装成「没有 secret」）。
  - 这与 **SystemSecuritySettingsService**（另一个服务，把错误包成 400
    BadRequest）不同：本批沿用 AuthSecurityService 语义。
- **绝不输出** secret、恢复码、密文、密钥或 otpauth URI 到日志或错误：Go 错误只记
  通用信息（`log.Printf("authfactors: %v", err)`），响应正文只在一次性 enroll 与
  一次性恢复码响应里出现明文。

## 9. SQL NULL 语义

- `UserTotpFactor.pendingSecret`：无 pending 时是 **SQL NULL**；JSON 字面量 `null`
  也按「无 pending」处理（与 Nest 的 `pendingSecret ?? secret` 回退一致）。提升/整体
  替换时清成 SQL NULL。
- `OrgOidcConfig.clientSecret` / `scopes`：无值时是 **SQL NULL**，**不是** JSON 字面量
  null，也不是 `{}` / `[]`。
- `OrgOidcConfig.discoveryUrl` / `buttonLabel`：trim 后为空写 SQL NULL。
- `UserTotpFactor.secret` 是**必填 JSON 列**，总是写入编码后的 JSON 值（信封或明文
  字符串），不写 SQL NULL。
- `hasClientSecret` = `Boolean(存储值)` 的 JSON 真值语义（null/false/0/空串为假），
  不是「能否解密」。

## 10. profile 跨组织失效（AF3）

- 缓存键 `profile:<userId>:<orgId>`，无组织段时为 `profile:<userId>:default`。
- `mfaEnabled` 属于被缓存的认证 profile，而 TOTP 因子是**全局用户状态**，因此
  verify-enroll / disable 成功后必须删除该用户 **`default` 条目 + 每个 membership
  组织条目**，否则其他组织会继续展示陈旧 `mfaEnabled` 直到 TTL 到期。
- 失效在**事务提交之后、每用户锁之内**执行；只碰该用户的这些键，不动其他用户、不动
  其他缓存命名空间。事务不重放：失效失败可以让请求报错，但绝不会再生成一套恢复码。

## 11. OIDC 读写语义

- **GET**：八字段公共形状 `enabled`、`issuerUrl`、`discoveryUrl`、`clientId`、
  `hasClientSecret`、`scopes`、`buttonLabel`、`requireEmailVerified`。无行 → 默认
  `enabled=false`、空字符串、`hasClientSecret=false`、
  `scopes=["openid","email","profile"]`、`requireEmailVerified=true`。**无 Redis
  缓存**，每次读 DB 权威；**绝不解密也不返回 client secret**。
- `scopes` 读规则：不是 JSON 数组、或数组里没有非空白字符串 → 回退默认三条；非空
  字符串**原样保留**（不 trim、不去重、不强制补 `openid`），空白判断用 trim 后文本。
- **PUT**：`orgId` 只来自认证身份。除 `clientSecret` 外按整行替换语义：
  `issuerUrl`/`clientId` trim 后可为空串；`discoveryUrl`/`buttonLabel` trim 后为空
  写 SQL NULL；`requireEmailVerified` 缺省 true；`scopes` 保留每个非空白字符串及其
  顺序（含重复），全部被过滤掉时写 SQL NULL。
- `clientSecret` 仅在请求携带非空 trim 值时替换；否则**整列从写入语句省略**，由
  数据库原子保留当前字节（首次插入无 secret 写 SQL NULL）。写入与回读在同一事务，
  响应描述本次自己提交的行。
- **保存接口不发网络请求**：从不获取 discovery 文档、JWKS 或 token endpoint，也不
  放宽 NestJS 登录路径的 HTTPS/SSRF/issuer/nonce/audience 校验（那些仍在 NestJS）。

## 12. 测试与验收

新增单测：

- `apps/api/src/modules/auth/auth-factors.lock.test.ts`（vitest）：锁名恰好 64 字符
  且确定性、跨用户不碰撞；`machine:` 身份识别；锁被占用 → 409 文案；连接/握手失败
  → 503；业务 HttpException 原样重抛；缺 `DATABASE_URL` fail-closed。
- `apps/api-go/internal/authfactors/totp_test.go`：Base32 往返与字母表、输入归一化、
  RFC 6238 向量、TOTP 窗口、otpauth URI 的 `encodeURIComponent` 逐字节一致。
- `apps/api-go/internal/legacyproxy/auth_factors_routes_test.go`：缺省/空/legacy 不
  注册；go 恰好接管七条；未迁路径仍回 Nest；与基础设施设置批次路由共存。
- `apps/api-go/internal/config/config_test.go`：缺省 legacy、非法值启动失败、go 要求
  三项凭据。

普通 CI：API Vitest（`pnpm --filter @modular/api test`）与 api-go `go test` 覆盖上述
单测；另有 lint/typecheck/契约快照等既有门禁。

**真实栈 smoke**：`.github/workflows/api-go-auth-factors-smoke.yml`，workflow 名
`api-go-auth-factors-smoke`，触发方式 `workflow_dispatch` 或 PR 加 label
`api-go-auth-factors-smoke`，独立并发组 `api-go-auth-factors-smoke-${{ github.ref }}`。
真实 MySQL 8.4 / Mongo 7 / Redis 7.2 service、真实 migrate + seed、真实 NestJS 构建 +
真实 `/api/auth/login` 签发的 JWT、真实 api-go 镜像，阶段 A–H：

- A 开关与路由（unset/空串/legacy/go 四态、非法值启动失败、停 Nest 后未迁路径 502、
  回滚）；
- B MFA 闭环（secret/URI 逐字节、密文落库、AF1 重复完成 400、pending 提升、disable、
  rotate、已用/旧码 401、请求体不能注入 userId、加密策略矩阵）；
- C 跨实现互操作（Go enroll → Nest verify 及反向、双方恢复码互消费、双方密文互解）；
- D 并发/回滚（同一注册并发只有一个成功、同一恢复码并发最多一个成功、写失败同事务
  回滚、同一用户跨 org 共用一把锁、锁竞争 409）；
- E profile 缓存（两组织立即反映 `mfaEnabled`、Nest 写/Go 读与反向、无关用户缓存
  不动、缓存无 secret）；
- F OIDC 配置（默认值、双组织隔离、trim/null/布尔、混合 scopes 过滤、AF4 secret
  保留、首次无 secret 写 SQL NULL、并发不覆盖、无 secret 泄漏、保存端点零网络请求、
  Nest 登录路径的 HTTPS/SSRF 拒绝仍生效）；
- G 停 NestJS 后用阶段 0 的真实 JWT 证明七条仍由 Go 独立服务，公开挑战与 OIDC
  start/callback/handoff 回落 legacy 并 502，重启 Nest 后能消费 Go 写入的因子与恢复码；
- H 回滚：`API_GO_AUTH_FACTORS_MODE=legacy` 把七条全部交回 NestJS。

## 13. 遗留限制与未验证项

- 公开 MFA 登录挑战与强制注册挑战（`verify-login`、`enrollment/start`、
  `enrollment/complete`）仍在 NestJS；OIDC start/callback/handoff 整链仍在 NestJS。
- **真实身份提供方未验证**：本批从不联系 IdP，smoke 只用确定性本地用例，不访问真实
  discovery/JWKS/token endpoint。
- 历史机器令牌若存储权限含 `settings.manage`，仍可读写自己组织的 OIDC 配置（既有
  租户边界，未加全局平台门禁）。
- **本机只做静态检查**：未执行构建、测试或启动任何服务；执行验证全部在 GitHub
  Actions。运行 URL、head SHA 与 conclusion 记录在 PR 描述与 Actions 页面，本文件不
  复制它们以免与最终 head 漂移。
- `infra/docker/docker-compose.yml` 与 `infra/docker/.env.sample` 已按既有惯例补上
  `API_GO_AUTH_FACTORS_MODE` 接线（默认 `legacy`；compose 用
  `${API_GO_AUTH_FACTORS_MODE:-legacy}` 透传）。
