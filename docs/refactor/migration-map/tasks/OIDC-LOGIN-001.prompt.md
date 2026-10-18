# 目标

执行 OIDC-LOGIN-001：把组织 OIDC 登录完整迁入 apps/api-go，覆盖授权跳转、PKCE/state、回调换码、JWKS验签、既有账户/组织校验、本地MFA或强制绑定、会话签发和一次性handoff交换。用户通过现有SSO按钮和回调页完成登录，不新增前端流程，不把已迁OIDC配置CRUD当登录已完成。

专注迁移和功能，不堆防御性编程，不引入通用认证框架、额外锁、重试平台或补偿系统。保留鉴权、租户边界、MFA和必要事务。Go业务DTO、数据库JSON、Redis、响应和审计用具名强类型；不用any/interface{}/map[string]any/[]any承载业务，协议扩展叶子可json.RawMessage。新增/修改源码注释用英文，解释验签、一次性消费、MFA分支和副作用顺序；文档、提交、PR中文。

# 基线、分支与并行占用

- 仓库/Users/oo/project/newwei；已核origin/main=90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，普通CI39149114456成功。登录11路、身份审批邀请14路已在main，不重复派发。先fetch origin main、读取适用AGENTS.md，查最新SHA、开放PR、main最近五次CI和git worktree list。旧checkout停在历史分支，不能用其工作文件推断最新进度。
- 从fetch后origin/main创建refactor/go-oidc-login，独立worktree=/Users/oo/project/newwei-go-oidc-login。已存在时先核归属/改动，不覆盖。main前进只核本批及共享接线增量，不做全仓审计。
- 地图入口docs/refactor/migration-map/README.md、PLANNING.md、tasks/README.md、GAPS摘要、BACKLOG.BL-06、modules/identity.md、AUDIT.identity与DEPENDENCIES身份/登录部分；本批task和提示词在规划分支docs/plan-llm-gateway-ops（规划PR #80，https://github.com/wei500L/newwei/pull/80），未合时只读该分支文档，不合入文档分支。
- 并行LLM-GATEWAY-OPS-001已有Ready PR #81，head0901ca15aa31d5c00e98aa5c0c3f94a201b27219，实际diff涉及llmgatewayops、profiles端口、llmlogs和其wire/main/config，不涉及本批认证业务；仍未计入main。
- SOURCE-POLICY-WRITE-001已见独立worktree开发，占用settingscrawl政策helper/模型注册、settingswrite/sourcepolicy文件，以及旧13设置写两处剩余接线。不要抢它的GAP-GQL-001修复或GraphQL注册。
- 两批都继续占用，公共main/config/env/compose只做自己的条件增量并保留并集；后合者正常merge最新main，不rebase。执行前再次核开放PR实际diff/认领与worktree，不因没有业务PR释放占用。不开新对话、不发送跨对话消息。

# 精确接口与返回

只接管以下3路，均为Nest @Public，无settings.manage/platform_admin/先登录要求；不能套用OIDC配置管理的权限。

| 接口 | 输入 | 成功契约 |
|---|---|---|
| GET /api/auth/sso/oidc/start | query org：组织id或slug | 302，Location为真实IdP authorization URL |
| GET /api/auth/oidc/callback | query state/code/error | 302，Location为NEXTAUTH_URL下/auth/sso/callback，带handoffToken、enrollmentChallengeId、challengeId或error之一 |
| POST /api/auth/sso/handoff/exchange | JSON {handoffToken:string} | 200，{user,accessToken,refreshToken,organizations,expiresIn} |

DTO ExchangeHandoffTokenDto只有@IsString，无min/max/IsNotEmpty；缺失/null/非字符串为现有400验证错误，空字符串可进入业务后401，不能擅加长度规则。org/state/code/error是Controller query参数，没有额外DTO模式校验，不设置默认组织。org lookup按id原值或slug.toLowerCase；未知/未配置组织start为400，callback中相同问题变成前端error重定向。保留实际缺参/错误边界，不凭空返回一个组织。

callback先构造前端回调URL，再try业务；业务失败也302，把源错误message经URL编码写入error，不能改JSON401或把外部id_token/access_token写入URL。成功只放对应分支参数，不同时放三个。POST exchange失败按现有Nest错误JSON/status投影，不重定向。

NEXTAUTH_URL沿用源缺省http://localhost:3000，/auth/sso/callback是从该origin解析的绝对路径。API_BASE_URL仅用于IdP redirect_uri：trim→去尾斜杠→去末尾/api（不区分大小写）→追加/api/auth/oidc/callback，防止/api/api；缺失时报400 API_BASE_URL is required for OIDC。不要改变其他登录/邮件使用的现有配置语义，不把本批变成部署切流。

# 源码事实源与Go复用

Nest必须读：
- apps/api/src/modules/auth/auth.controller.ts的startOidcLogin/handleOidcCallback/exchangeHandoffToken。
- 同目录oidc-auth.service.ts，尤其buildAuthorizationUrl/handleCallback/exchangeHandoffToken、fetchDiscovery/verifyIdToken/fetchJwks/assertValidVerifiedClaims/assertAllowedOidcUrl和handoff payload/UA绑定。
- auth.service.ts的beginTrustedLogin→completeTrustedLogin→finalizeLogin、MFA分支；mfa.service.ts的共享challenge协议；auth-security.service.ts与auth-flow.utils.ts的secret策略和opaque token/hash。
- dto/identity-admin.dto.ts的ExchangeHandoffTokenDto；apps/api/src/common/validators/ssrf-url.validator.ts及packages/db/prisma/schema.prisma的OrgOidcConfig/AuthChallenge/RefreshToken/User/Membership。
- apps/web/app/(auth)/auth/sso/callback/page.tsx与apps/web/lib/auth.ts：现有三分支消费和NextAuth handoff provider转发浏览器User-Agent，不修改页面/认证方式。

Go已有：
- internal/authlogin/session.go的completeTrustedLogin/finalizeLogin、MFA策略、tokens.go签发/refresh存储、mfa.go的挑战、accountsecurity.LoginStore/公开profile/organizations模型。可信登录核心和结果类型当前私有；新增小型trusted_login_port.go暴露具名session/MFA/enrollment结果及可信入口，必须继续走同一完整业务，不复制第二套JWT、membership/MFA/lastLogin/audit逻辑。
- internal/authfactors/crypto.go与login_port.go已有AuthSecurity兼容的编码/解码、MFA基础；secret方法仍私有，增加窄的secret_port.go等导出复用，不引用网关批次llmgatewayprofiles/ports.go，不复制加密算法或写新的system_security缓存协议。
- authlogin.NewService只构造mailer，不发送SMTP；本批复用可信登录时不需要强开AUTH_LOGIN模式或要求SMTP。复用现有TRUST_PROXY客户端IP语义，不能无条件信任X-Forwarded-For。必要的小型IP/错误投影端口允许导出。
- internal/newssources.ValidateOutboundTargetURL已导出SSRF/DNS策略，crawlmetadata也复用；本批再叠加源OIDC必须HTTPS要求。保留DNS失败默认allowUnresolved=true的源语义，不改共享SSRF策略或为测试允许生产HTTP/localhost。
- go.mod已有github.com/golang-jwt/jwt/v5及标准crypto。优先用现有成熟验签库和具名JWKS公钥解析，不手写签名验算、不把本地HS256 access-token验证器当IdP验证器。若确需新依赖，按仓库既有远端依赖生成机制处理，不在本机安装或新增专用CI。

候选OIDC/AuthSecurity/SSRF源码相对地图3cedce9a到本基线无业务变化；主线仍没有这3路Go接管。读取最新源码优先于旧报告/注释。

# 授权、state与IdP调用

1. 从Org/OrgOidcConfig加载配置，enabled必须true；不重迁配置GET/PUT，不缓存一份会覆盖配置管理的新表。scope非数组或没有非空字符串时默认openid/email/profile；否则过滤空白项但保留原字符串和重复顺序，不强制另加openid。
2. discoveryUrl有非空配置则用其trim值，否则issuerUrl去一个末尾/后追加/.well-known/openid-configuration。URL校验发生在读取discovery cache之前。
3. discovery必须含非空issuer/authorization_endpoint/token_endpoint/jwks_uri。配置issuer与discovery issuer分别trim、去query/hash、去尾/后比较；不匹配400 OIDC discovery issuer does not match configured issuer。四种URL按源解析→HTTPS→SSRF/DNS校验，URL无效/非HTTPS/不允许的错误分别保留OIDC <label> URL is invalid/must use HTTPS/is not allowed。
4. discovery Redis key=oidc:discovery:<validatedDiscoveryUrl>，TTL3600秒；JSON为具名Discovery文档，cache读失败沿源传播，写cache失败可忽略。discovery/JWKS fetch timeout均8000ms，HTTP/JSON失败按源错误分支，不把全部外调包装成固定ok。token exchange源没有这项显式8秒timeout，不擅自声称三个fetch超时配置相同；保留请求取消，不加通用重试。
5. start生成UUID state、UUID nonce、32随机bytes的无padding base64url codeVerifier，codeChallenge=SHA256(verifier)再base64url。Redis key=auth:oidc:state:<state>，TTL600秒，value={orgId,codeVerifier,nonce}。state保存失败不能仍返回可登录URL。
6. authorization URL保留已有参数，再set client_id、response_type=code、scope、redirect_uri、state、nonce、code_challenge、code_challenge_method=S256。不能把client_secret放入浏览器URL，不替换为伪登录页面。
7. callback error非空优先报OIDC login failed: <error>，不消费state；缺state/code为OIDC callback is invalid。正常路径先对state执行原子GETDEL，缺失/过期/重复均OIDC state is invalid or expired。禁止GET后DEL或仅进程内map；随后重读组织配置，保证当前仍启用。
8. 解码clientSecret沿AuthSecurity策略；POST token_endpoint，Content-Type=application/x-www-form-urlencoded，grant_type=authorization_code、code、redirect_uri、client_id、code_verifier，只有解码得到非空secret才增加client_secret，不擅自改成Basic认证。非2xx为OIDC token exchange failed，缺id_token为OIDC response missing id_token。不要用userinfo端点替代验签或信任未经验证的email。

# JWKS与id_token必须真正验证

- JWKS key=oidc:jwks:<validatedJwksUrl>，TTL86400秒，存完整具名JWK set；验证前重新做源JWKS URL检查。不存在则fetch，响应必须keys数组；保留kid/alg/use/key_ops与公钥类型选择语义，不接受oct/HS算法伪装成公开密钥，不拉取token头自报jku/x5u。
- 公开算法允许列表精确为RS256/RS384/RS512、PS256/PS384/PS512、ES256/ES384/ES512、EdDSA，不因首个IdP只用RS256就遗漏其他源支持分支。公钥解析用标准类型/现有库，验证必须执行真实签名检查。
- issuer是discovery.issuer精确值，audience含clientId；required claims为exp/sub/nonce/email，时钟容差60秒，exp/nbf等JWT校验按源jose语义。nonce必须等于state保存值，email必须非空字符串；requireEmailVerified=true时仅接受布尔true，不接受"true"。
- azp若存在必须为clientId字符串；aud为多个受众时必须azp=clientId。requireEmailVerified默认true，不因配置不可读自行关闭。
- 初次verify或claims校验失败后，源会重新fetch一次JWKS并再验证一次，更新缓存写失败忽略；只保留这一次既有刷新，不增加循环重试或单独key-rotation worker。最后统一401 OIDC identity token validation failed；callback随后把它转为error重定向。
- Discovery声明的id_token_signing_alg_values_supported不是源验证allowlist的替代，不能直接按上游声明放行HS或none。

# 既有账户、MFA与会话副作用

- 按已验证claims.email.toLowerCase()查现有User，不做自动注册、不按sub新建绑定表、不自动加membership或角色。找不到为Your account must be invited or approved before using SSO。
- 调用同一trusted login入口，传已确定userId、state中的orgId、可信IP/User-Agent和action=login_with_oidc，skipMfa=false。重新加载User.isActive、该组织membership/isActive、Org.isActive、权限/角色，不能把IdP成功等同租户授权或绕过本地MFA。
- 需要二次验证：沿用mfa_login challenge格式/TTL，callback仅返回challengeId；强制绑定：沿用mfa_enrollment格式/TTL和action，callback仅返回enrollmentChallengeId。不要先发session或创建handoff。旧MFA继续接口由AUTH_LOGIN_MODE决定Go/Nest，保持现有共享challenge兼容，不为了本批强启旧11路或重迁它们。MFA分支的审计action按现有真实调用协议，不假定未传入的action自动存在。
- 无MFA时复用session签发：既有HS256 access claims、RefreshToken格式/hash/期限、User.lastLoginAt更新、best-effort审计/outbox、organizations投影和expiresIn均保持。profile先构建、lastLoginAt后更新，沿原顺序；不复制session SQL/算法，不把失败后已写副作用谎称整体回滚。

# Handoff数据与具体功能修复

- 无MFA且session已签发后，生成32随机bytes的hex opaque token（64个hex字符），AuthChallenge.id=SHA256(rawToken)的hex，type=sso_handoff、userId/orgId、expiresAt=当前时间+5分钟、consumedAt=null，默认attempt字段沿表定义。URL只带raw handoffToken，数据库主键不能存raw token。
- payload具名保存accessToken、refreshToken、expiresIn、user、organizations、userAgent。access/refresh必须经过现有AuthSecurity.encodeSecret，不直接绕过策略存普通token；该策略在显式关闭或非生产缺key时可能保存明文JSON字符串，不能照源注释声称所有配置都强制密文。保留system-settings:v1 envelope、system_security和auth:system-security缓存TTL60语义，生产/key错误按源处理，不新增全局强制key启动条件。
- exchange按输入原字符串hash查AuthChallenge，只接受sso_handoff、未消费、未过期；保留源expiresAt < now判过期的边界。payload缺expiresIn/user/organizations、decode后的token缺失等为401 SSO handoff token is invalid or expired；organizations=[]合法，不能当缺失。解密异常与不可读返回按AuthSecurity原错误边界，不吞所有错误成成功。
- User-Agent只有记录值与请求值两者均存在时才比较trim后的文本，不新增强制UA/IP绑定。NextAuth交换在服务端执行，现有Web已转发浏览器UA，不能改为比较服务端HTTP客户端UA。
- 已确认具体缺口：Nest exchangeHandoffToken在读/检查后仅按id无条件update consumedAt，两次并发可能都返回同一session。Go本批在payload/UA/解密检查后，用一次条件UPDATE领取，包含id/type、consumedAt IS NULL和有效expiry，检查RowsAffected=1才返回session；另一个请求返回原401。无需新锁、重试、事务框架或schema。
- 修复保证Go交换入口单次领取；不修改Nest实现，也不声称旧Nest与Go同时消费同一记录时已获全局原子保证。保持数据/回退兼容，交付说明写清此边界。exchange只消费已签发结果，不再次mint refresh token或重复写登录审计。
- 审计沿trusted login既有实现，失败outbox消费者仍Nest。没有BullMQ/cron/worker、SMTP/Mongo/S3依赖；不发送真实邮件、不实际调用生产IdP。外部IdP连通、真实账号登录均尚未验证。

# 文件范围、接线与回退

- 新internal/oidclogin/**、cmd/api/oidc_login.go、独立legacyproxy/oidc_login_routes.go；authlogin新增可信入口/具名结果/IP或错误窄端口，authfactors新增secret窄端口；必要main/config/env/compose/README增量和本批精简验证/短说明。不要修改密码登录、refresh、MFA算法及其他业务契约。
- 新API_GO_OIDC_LOGIN_MODE接受空串/legacy/go，默认legacy，非法值启动失败；go只要求JWT/MySQL/Redis及本批请求时需要的IdP配置/URL，不要求SMTP、Mongo、已开启AUTH_LOGIN/AUTH_FACTORS/ACCOUNT_SECURITY/IDENTITY_ONBOARDING或GraphQL模式。API_BASE_URL/secret策略按源请求时语义，不能因复用authlogin构造器而套用邮件启动前置。
- 完整覆盖mode解析、MySQL无效DSN失败条件、sharedDB/Redis所需OR、wire、精确路由handler注册、资源关闭与启动诊断；只开本模式即可服务三路。handler是public，不能先要求用户JWT；JWT配置用于本地session签发。
- 只精确接管2GET+1POST及现有CORS预检约定，不接管整个/api/auth；其他方法/路径保持Nest。mode legacy不注册本批规则。保留旧登录11路、配置/MFA、账户安全、身份14路和其他迁移的规则并集，不靠回调Nest业务伪装Go实现。
- 来源策略批次拥有GraphQL两处旧设置写补线，不抢其修复；网关#81拥有profile/日志端口与wire，不改它们。共享文件只合自己的语义增量，正常merge主线，不rebase/amend/force-push。
- Web→NestJS、canary默认保持现状；不改部署开关、不实际启用生产SSO。回退模式legacy，Redis state/discovery/JWKS、AuthChallenge、session/RefreshToken和secret envelope继续由Nest读取；已消费一次性状态不复活，不删除用户或撤销所有会话冒充回滚。

# 精简验证与交付

- 本机不安装依赖，不运行build/test、Docker或服务，不登录真实IdP；可gofmt、静态检查、git diff --check。用现有普通CI执行必要mock用例，不新增专用smoke workflow，不用生产凭据。
- 验证集中三组：授权URL/PKCE/state原子消费与缓存TTL；真实构造签名的JWT/JWKS、issuer/aud/azp/nonce/expiry/email_verified、一次刷新；已有账户租户/MFA三分支、handoff加解密/UA/过期/并发仅一成功、仅本模式资源和三路回退。使用注入HTTP/DNS/时钟，不为本地TLS测试放宽生产HTTPS/SSRF规则；不要仅decode JWT或写镜像源码测试。
- 记录最终head的普通CI真实结果与链接，修复本批问题；skipped不算通过，mock/静态不冒充真实IdP或混合部署实测。
- 地图由规划窗口集中维护，编码窗口不要改migration-map共享索引/域页/BACKLOG/其他task，也不要打断正在运行的窗口。PR说明或一份短交付说明列OIDC-LOGIN-001、3路、复用端口、真实协议/MFA/副作用、单次claim修复、PR/head/CI、开关/回退和外部未验证/混合Nest消费边界，供规划窗口回填；未合并不能提前计入main。
- 只提交本批改动，中文emoji+type(scope)正常commit/push，创建Ready PR；不合并、不auto-merge，不amend/rebase/force-push。创建后附PR链接。
- 最终交付Ready PR、分支/worktree、最终SHA、3路完整迁移与具体修复、普通CI链接/结果、独立开关/回退和未验证项。达到可审查交付，不自动开始下一批。
