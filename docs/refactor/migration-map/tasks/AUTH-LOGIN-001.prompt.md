# 目标

在 wei500L/newwei 的 apps/api-go 完整迁移“登录、会话签发与账户验证”主链，任务 ID：AUTH-LOGIN-001。用户能完成密码/验证码登录、刷新会话、MFA 登录或强制绑定、找回密码和邮箱变更。迁移真实业务步骤，不能只注册路由、模拟邮件或返回固定成功。

这是后端编码窗口：直接完成实现、提交、推送并创建 Ready PR，不停在计划。专注功能，不做全仓审计，不堆防御性编程。保留原有鉴权、租户隔离、业务校验、必要事务及单次消费约束；不额外发明锁、重试、熔断、通用兼容框架或新密码规则。新增/修改源码注释使用英文，解释令牌轮换、challenge 消费、缓存和事务顺序等关键原因；文档、提交和 PR 描述使用中文。

## 基线与独立工作目录

仓库 /Users/oo/project/newwei；该 checkout 可能是旧分支。规划核实的 origin/main 为 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；地图 PR #69 已合并，此 SHA 相对地图原基线 3cedce9a 仅文档/导航变化。最近五次 main 普通 CI 均成功。

先读取适用 AGENTS.md，再 fetch origin main，记录最新 SHA，查看开放 PR、main 最近五次 CI、git worktree list。只复查本链相关增量和占用，不全仓扫描。新建 refactor/go-auth-login 分支，worktree 必须为 /Users/oo/project/newwei-go-auth-login，从 fetch 后的 origin/main 起步；不要切换、清理或提交其他窗口目录。若相同目录/分支已存在，先核实其归属，不能覆盖。

规划记录与其他认领在 Ready 文档 PR https://github.com/wei500L/newwei/pull/71；它不是业务依赖，不要 merge 整个规划分支进入业务分支。运行时事实以最新 main 源码为准。

## 精确接口、权限与返回

仅接管以下 11 个 POST，全路径前缀 /api/auth：

| 路径后缀 | 权限 | 成功状态与结果 |
| --- | --- | --- |
| /login | Public | 200：会话结果，或 MFA/强制绑定 challenge |
| /refresh | Public，由 refresh 凭据校验身份 | 200：新会话结果 |
| /send-login-code | Public | 200：{ok:true,cooldownSeconds} |
| /login-with-code | Public | 200：会话结果，或 MFA/强制绑定 challenge |
| /mfa/verify-login | Public，由 challenge + TOTP/恢复码校验 | 200：会话结果 |
| /mfa/enrollment/start | Public，由绑定 challenge 校验 | 201：{secret,otpauthUri} |
| /mfa/enrollment/complete | Public，由绑定 challenge + code 校验 | 200：会话结果加 recoveryCodes |
| /password/forgot | Public | 200：{ok:true} |
| /password/reset | Public，由 reset token 校验 | 200：{ok:true} |
| /send-verification | AllowAuthenticated，无额外根权限 | 200：{ok:true,cooldownSeconds}；这是变更邮箱绑定 |
| /verify-email | AllowAuthenticated，无额外根权限 | 200：更新后的完整账户 profile |

其余方法、相似路径、尾部斜杠与其他 /api/auth 路径沿现有精确规则回退 Nest；预检和普通 OPTIONS 复用已有 CORS/legacy 约定。不得整段接管 /api/auth。已接管请求内的业务失败按契约报错，不能失败后转 Nest 重放副作用。

会话结果以 AuthService.finalizeLogin / refresh 的真实返回为准：user、accessToken、refreshToken、organizations、expiresIn。不要根据简化 LoginResponseDto 丢失 organizations、MFA 分支，也不要自行添加 tokenType。

user 保留 id/email/emailVerified/lastLoginAt/pendingEmail/firstName/lastName/avatarUrl/isActive/orgId/primaryRoleId/roleIds/permissions/planTier/subscriptionStatus/globalRoles/mfaEnabled/mfaRequired/mfaEnrollmentRequired；可空字段保留 null，数组为空仍是 []。organizations 为按 Membership.createdAt 顺序得到并去重的 {id,name,slug,isActive}，isActive 合并组织与 membership 状态，不只返回活动组织。

MFA challenge 返回 user、organizations、challengeExpiresAt，以及 mfaRequired:true + authChallengeId，或 mfaEnrollmentRequired:true + enrollmentChallengeId；这两种响应不得提前签发 token。完成强制绑定只在成功结果附带一次明文 recoveryCodes。

## 最新源码依据与明确复用

先精读以下限定路径，而不是按旧迁移报告照抄：

- apps/api/src/modules/auth/auth.controller.ts：上述 handler、装饰器、HTTP code、IP/UA 传递。
- 同目录 auth.service.ts：validateUser、pickMembership、completeTrustedLogin、finalizeLogin、signAccessToken、signRefreshToken、parseRefreshToken、refresh、sendLoginCode、loginWithCode、sendVerificationCode、verifyEmail、completeMfaLogin、completeMfaEnrollmentLogin。
- 同目录 mfa.service.ts、password-reset.service.ts、auth-flow.utils.ts、auth-security.service.ts、auth-email-code-settings.service.ts、refresh-token-blacklist.service.ts，以及 dto/{login,refresh,login-with-code,password-reset,email-verification,mfa}.dto.ts。
- apps/api/src/modules/{cache,system-settings} 内本链调用的 CacheService、RateLimiterService、ActionRateLimitService、RateLimitConfigService、RateLimitPolicyService；org/org.service.ts 的 listOrganizationOptionsForUser；config/{config.service,env.schema}.ts；email/email.service.ts 与 templates/verification-code*；audit/audit-log.writer.ts；packages/db/prisma/schema.prisma。
- 地图 modules/identity.md、AUDIT.md 的 identity、DEPENDENCIES.md 的鉴权/审计复用与执行所有权，只展开本批。

已有 Go 基础必须复用：

- internal/authn 的 JWT verifier、Redis blacklist，internal/authhttp/authz 的 JWT 验证、服务端 membership/permission 推导和错误响应；已有 golang-jwt/v5、bcrypt 依赖。
- internal/accountsecurity/{profile,password,logout,profile_cache,audit}.go：账户强类型、membership/角色/全局角色查询、密码、撤销名单、profile 缓存和审计 Outbox 协议。多数 helper 是私有的；允许以窄的具名类型接口导出复用，不得假定跨包可直接调用。
- accountsecurity.pickMembership 当前多活动组织无 org 会报错，而密码/验证码登录允许默认选最早活动 membership。不得为登录全局改变 /me、refresh 的已有选择语义。
- internal/authfactors/{mfa,totp,crypto,store,cache}.go：GetStatus、BeginEnrollment、VerifyEnrollment，以及现有恢复码验证/单次消费、密钥加解密、pending factor 提升和 profile 失效。私有凭据验证只做必要的窄导出，不新写第二套 TOTP/恢复码算法，不改已迁七条管理接口。
- internal/runtimesettings 的已迁登录限流/安全设置与 internal/rbacapi/ratelimit.go 的共享滑窗脚本可作复用基础；rbac helper 不是现成登录限流入口，配置、键、失败语义须按 Nest 本链实现。禁止照搬其业务 map 模型。
- accountsecurity.audit 当前 SQL/Outbox 将 ipAddress 写为 NULL；新链须保存 Nest 传入的真实 IP，不能把旧私有 helper 当成已完整满足本批。

建议新增 internal/authlogin 业务包、独立 handler 和 cmd/api/auth_login.go；复用边界保持小而具体。main 没有可直接调用的登录 SMTP 公共服务。PR #70 workspacewrite/email.go 尚未合并且属于另一窗口，不作为依赖或共享文件。

## DTO、缺省/null、错误和租户语义

具名 DTO 显式区分缺失、null、空字符串；DTO 验证顺序及错误 envelope 沿 Nest ValidationPipe 和现有 authhttp，不加原契约没有的 UUID、最大长度或密码复杂度规则。

- login：email 为 IsEmail，password 字符串至少 8，orgId 可选字符串；login-with-code：email、恰好 8 个 ASCII 数字 code、可选 orgId。orgId 的缺失/null 按 IsOptional 跳过，空串不能直接当成 null。
- refreshToken 字符串至少 20，orgId 可选；email 规范化 trim/lowercase。forgot/send-code/send-verification 的 email 均按各自 DTO；verify-email code 恰好 8 位数字，保留前导零。
- reset：token 为字符串，password 字符串至少 8；服务层 trim token，trim 密码后再检查至少 8 并 bcrypt。普通密码登录不擅自 trim 密码，也不额外要求 emailVerified。
- MFA challengeId 只要求字符串；code 字符串至少 6，可使用恢复码，不能缩成六位数字校验。enrollment/start 只有 challengeId。
- User 必须活动；重查 membership 和 Org 的活动性，权限从当前角色关联求并集，不从请求或旧 JWT 直接继承。orgId 可匹配 ID/slug，大小写/trim 按 pickMembership。登录无 org 默认最早活动 membership；refresh 使用 body.orgId ?? token.orgId，保持空串与 nullish 区别及多组织要求显式选择的分支。
- 保留关键错误：401 Invalid credentials、Invalid refresh token、Refresh token expired、User not found，以及组织未加入/组织停用/membership 停用错误；多组织缺 org 的 400 原文；验证码无效/过期在 login-with-code 是 401，在 verify-email 是 400，文本 Verification code is invalid or expired。MFA challenge 过期/已消费/类型不符与达到次数限制的 401/429，均按服务原文。不要把真实 Redis/DB/邮件错误一律改成凭据错误。
- 两条已认证邮箱路由通过已有鉴权链获取 userId/orgId，不接受 body 自选用户或租户；沿现有机器身份行为，不新增假定权限。

## 必须实现的数据、事务与副作用

1. 密码/验证码登录成功后调用同一可信登录流程，重新加载当前用户、membership/role、全局角色及 MFA 状态。system_security 的 MFA policy 为 off/admins_only/all_users；off 不会绕过用户已启用的 MFA；admins_only 依据组织 admin 角色，不是平台全局角色。无需 MFA 才 finalize；更新 User.lastLoginAt、写 auth 登录审计、返回组织选项。保留返回 profile 与更新时间的原先顺序。

2. Access JWT 用现有密钥和 HS256，保持 sub/orgId/permissions、iat/exp/iss/aud/jti，jti 使用 UUID。JWT_ACCESS_EXPIRES_IN 默认 15m，JWT_REFRESH_EXPIRES_IN 默认 7d；时长解析按现有数字+[smhd]语义。Refresh secret 为安全随机 32 字节 hex，bcrypt cost 10 入 RefreshToken，保存 expiresAt/IP/UA；新串 tokenId.orgId.secret，继续接受 Nest 已有 tokenId.secret 格式。新旧实例、已迁 logout/change-password 必须共用协议。

3. refresh：使用 auth:refresh:<tokenId>:<sha256(secret)> 的 JSON 缓存，AUTH_REFRESH_GRACE_SECONDS 默认 10；CacheService.wrap 的共享锁为 lock:<cacheKey>，锁 TTL/maxWait 至少 10 秒、retryDelay 50ms。缓存读取前必须检查 refresh-token:blacklist:<tokenId>，loader 再检查；不能用 grace 缓存绕过撤销。保留 revokedAt IS NULL、expiresAt>now 的条件 UPDATE 单次领取，影响一行后才读记录、比对 bcrypt、重查用户/组织并签发新对；原源码是在 secret 比对前领取，不能顺手改协议。成功将旧 token 加黑名单，TTL 按原过期时间剩余秒数。保留跨 Nest/Go 缓存、锁的 JSON/租约释放格式及原有失败边界，不新建协调框架。

4. 验证码：读取 auth_email_code_settings / auth_email_code:settings，缓存 60 秒；环境默认 ttl=300、cooldown=90、maxAttempts=3，原规范化范围分别 60..1800、10..3600、1..10。共享 Redis 键 auth:email-code:<scene>:<identifier>、auth:email-code:attempts:<scene>:<identifier>、auth:email-code:cooldown:<scene>:<identifier>；login 标识是规范化 email，bind 是 userId。值为具名 {codeHash,email,userId?}，8 位安全随机验证码只存 SHA256；冷却 SET NX、错误计数/过限删除、单次 DEL 消费、TTL 与 Nest 相同。

5. send-login-code：先占冷却，只给活动且 emailVerified 的现有用户真实发信；冷却冲突、用户不合格或发送失败均返回同形 {ok:true,cooldownSeconds}。发送失败清理本次 code/attempt/cooldown；不得假发成功冒充 SMTP 已迁。login-with-code 先按 scene=login-code 限流，校验 payload/email/user/hash、原子 DEL 成功后进入 MFA/签发流程，不能先签 token 再消费 code。

6. 邮箱变更：send-verification 拒绝当前邮箱、已占用邮箱和其他用户 pendingEmail，冷却冲突为 429；更新 User.pendingEmail，写 bind code，真实发信。失败清理 code/attempt/cooldown，并仅在 pendingEmail 仍等于本次值时清回；唯一约束映射既有 400。verify-email 验证后更新 email/emailVerified、清 pendingEmail，清代码/计数/冷却，失效 profile:<userId>:default 和该用户各 org profile，返回完整 profile；保留两个 auth 审计事件。此链不是给当前邮箱简单打 verified 标记。

7. MFA challenge：AuthChallenge 保留 mfa_login/mfa_enrollment 类型、userId/orgId、payload 的 org/IP/UA/action；TTL 分别 10/15 分钟，AUTH_MFA_CHALLENGE_MAX_ATTEMPTS 默认 5。已消费、过期、锁定与错误次数条件原样维护。登录挑战的 TOTP/恢复码验证事务保证恢复码单次使用与 lastUsedAt 同提交，验证成功后再条件消费 challenge。强制绑定 start/complete 校验已有 requester IP/UA 绑定，IP 按源逻辑处理 ::ffff:；仅比较双方都提供的字段，不凭空加强缺失字段约束，也不把该校验推广到 verify-login。complete 先条件领取 challenge 再 VerifyEnrollment，防止重复旋转恢复码；原有错误验证码分支返还 challenge 并累计失败，其他错误保留原语义。成功再加载当前用户/组织签发会话；必要时保留来自 Nest OIDC challenge 的 action 标签，但不迁移 OIDC 入口。

8. 找回密码：依 auth.password_reset 动态策略及禁用状态，分别消费 auth:password-reset:ip:<ip> 与 auth:password-reset:email:<sha256(normalizedEmail)> 桶；默认 email=3、IP=10、窗口900秒。用户不存在/停用返回 ok，不创建 token；合格用户创建 PasswordResetToken（32 字节随机原文、DB SHA256、30分钟、IP/UA），通过 NEXTAUTH_URL（缺省 http://localhost:3000）的 /reset-password?token=... 真实发信。此邮件失败原样传播，不能照 send-login-code 吞掉。reset 在一个事务内更新 bcrypt 密码、消费该用户全部未用 reset token、撤销全部未撤销 RefreshToken，保留两个审计事件；无效/已用/过期 token 为 401 Password reset token is invalid or expired。不要另加全体 access JWT 撤销、密码策略或新表。

9. 登录限流使用 RateLimitConfigService.login，默认5次/60秒，实际键是 login:<normalizedEmail>:<ip或unknown-ip> 和 login-code:<...>；不要按源码注释误拆成两个独立桶。沿用当前 Redis滑窗/配置/超时结果语义，默认失败不放行。forgot 使用独立 policy 协议，不与 login 桶混用。请求 IP 来源按 controller：forgot 用 resolveRequestIp，其余按传入 req.ip，UA 按原逻辑；结合现有 Go 入口/代理信息实现，不能信任 body 的 IP。

10. SMTP 读取实际 Env.smtpConfig，而不是把后台邮件设置 CRUD 当发送能力。实现真实 SMTP/TLS、鉴权、from（缺省 user）、文本+HTML验证码模板及找回密码正文，尊重 SMTP_SECURE、TLS_REJECT_UNAUTHORIZED、connection/greeting/socket timeout 等现有配置。默认 secure=true，证书校验=true，超时10/10/30秒。优先标准库完成本批发送，不为本批引入通用邮件平台或强制连接池；如 SMTP_POOL 等投递调度配置存在实际行为差异，交付中明确说明。不得打印密码、验证码、refresh secret、TOTP secret 或恢复码，不在本机调用真实邮件服务。

11. 审计沿 best-effort AuditLog→失败 AuditLogOutbox 协议，保留 orgId/actor/action/具名 metadata/IP；两者都失败记录结果，不把已完成业务改成失败。Outbox 的既有 Nest 消费者继续运行。本批无 BullMQ、worker 或 cron 迁移权，无 Mongo/S3/LLM/外部 IdP 依赖；SMTP 是同步请求链的真实外部副作用。

## 功能实现与优化边界

主体是上述完整链路。不强制“顺手修 bug”或额外算法任务。身份/角色/组织投影可批量查关联、复用同次装配结果，避免明显逐角色 N+1；但不能省略 refresh 或 MFA 完成时重新校验用户/租户。采用具名强类型表达 DTO、响应、SQL JSON、缓存、challenge payload、配置和审计；不使用 any/interface{}/map[string]any/[]any 承载业务数据，通用驱动协议边界沿现有实践，必要扩展 JSON 叶子用 json.RawMessage。

## 允许范围、并行任务与共享接线

主要允许 apps/api-go/internal/authlogin/**、cmd/api/auth_login.go、legacyproxy 新增本批精确规则；accountsecurity/authfactors 的具名模型及窄复用接口、runtime settings 的本链配置读取按需最小修改。main.go、config.go、apps/api-go/README.md、infra/docker 的示例/env/compose 只做本开关所需增量。原则上不改 DB schema，不改 Nest 业务/装饰器/签名，不改 Web。

已占用且不能重复分配：
- WORKSPACE-WRITE-001：Ready PR #70，head adb765d0180e8b34910181e8c6fde8be400a2dff，工作台8个 GraphQL 写、alerts/history/workspacewrite 及顶层 GraphQL 接线。
- NEWS-BRIEF-001：newsEventBrief 冷生成/强刷，graphqlread/newsevents、publicportal、llmlogs。
- STORAGE-MEDIA-001：storage/test、objectstorage、infrastructuresettings 配置导出、crawlreadtelemetry、settingscrawl S3 URL与 Go依赖清单。
- ITEMS-LIST-001：itemsreading/graphqlread/itemsreading、最小 llmembed rerank 和 contract/exec 只读 selection 元数据。

这几批业务文件与本批分开。共享 main/config/compose/env 只新增本批语义段，保留其他任务的条件并集，不整段覆盖或整理格式；不替 #70 修 GAP-GQL-001，不改 GraphQL 引擎/模型注册，不触碰上述业务包。提交前重新 fetch，必要时正常 merge origin/main 并解决本批冲突，禁止 rebase。不要操作或通知其他对话。

排除邀请/注册审批、OIDC start/callback/handoff 生产者、头像/数据导出、已经迁过的账户管理/登出/机器令牌与已认证 MFA/OIDC配置接口；后续 OIDC/邀请窗口不得在本批期间并行改会话协议。

## 独立开关、资源、注册与回滚

新增 API_GO_AUTH_LOGIN_MODE，空串/legacy/go，默认 legacy，非法值启动失败。它能在 ACCOUNT_SECURITY_MODE、AUTH_FACTORS_MODE、GraphQL及其他新批次均 legacy 时独立工作；必须自行纳入 MySQL/JWT/Redis 初始化、无效 DSN 校验、精确路由选择和 handler 注册。复用同一共享连接，不要求 Mongo；复用 MFA service 不等于依赖其管理路由开关。

go 模式校验本链实际需要的 JWT_SECRET/ISSUER/AUDIENCE、DB/Redis、SMTP 和既有 MFA 加密配置规则；legacy 不额外要求本批资源，不发启动邮件、不访问 IdP。密钥与生产加密要求按现有 authfactors/config 处理，不自行降级。

env/compose 明确默认 legacy；生产 Web→NestJS 与 canary 默认不变。回滚只将 API_GO_AUTH_LOGIN_MODE 改 legacy；DB/Redis/token/challenge 协议须与 Nest 兼容，无 schema/数据回滚步骤，不回滚账户已完成的密码/邮箱变更。记录独立开关及与 account-security/auth-factors 同开时的路径互不覆盖。

## 精简验证

本机不安装依赖，不运行 build/test、Docker、服务或真实 SMTP。允许 gofmt、git diff --check、只读源码/契约检查。先实现，再用已有普通 GitHub Actions CI 验证；不新增专用 smoke workflow，不恢复 Nest/Jest 测试体系。

只补少量有业务价值的 Go 测试，使用现有 harness、交普通 CI 运行：精确11路及默认/非法模式；DTO 的 null/空值与 MFA恢复码；blacklist 在 grace 缓存前、refresh/challenge 单次消费；验证码邮件失败的不同清理/响应语义；reset 的事务更新范围。不要搭新测试基础设施或大规模实现镜像测试。静态复核关键控制流并给 SHA+文件/符号证据；真实 MySQL/Redis/SMTP 并发与投递未验证就明确写未验证，CI 通过不等于真实投递验证。

## 记录与交付

共享迁移地图、BACKLOG、任务索引和全局认领由规划窗口集中维护，编码窗口不修改这些共享文件，也不为本批另建一套规划文档。阅读 task AUTH-LOGIN-001 的已有范围即可；在本 PR 描述（必要时一份简短 docs/refactor/go-auth-login.md）记录实际11路完成情况、开关/资源、复用接口、协议兼容性、未完成分支、PR/head SHA、普通 CI链接、SMTP/运行证据边界，供规划窗口回填 task 和 identity；未合并只能 pr_open，不能提前增加 main 覆盖或宣称生产启用。

实现完只暂存本批改动；中文 emoji + type(scope) 提交，正常 push，创建 Ready PR（非 Draft），不合并、不 auto-merge、不 amend/rebase/force-push。使用现有普通 CI，查看本次精确 head 的结果并修复本批失败；skipped 不算通过，不无限重复无变化检查。若 CI 跳过 Go/SMTP，按实际 job 覆盖明确说明。

最终交付：PR URL、分支/worktree、基线及最终 head、11路和必要副作用的完成情况、实际普通 CI结果/链接、未验证外部行为、回滚方法及需规划窗口更新的任务事实。不要用只发方案、只保存任务文档或空壳注册代替业务交付。
