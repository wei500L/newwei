# 身份、权限、设置与网关核心 · Go 对照 Nest 静态审查

> 纯静态审查：本机未安装依赖、未执行 `go build` / `go vet` / `go test` / `pnpm` / Docker / 任何服务，未连接真实 MySQL、Redis、Mongo、SMTP、OIDC IdP、S3 或 vector 上游，未观察生产流量。全部结论来自读源码、`git diff` 核对与 `gofmt`。远端验证只由仓库现有的普通 GitHub Actions CI 承担，结论见第 7 节。

## 1. 范围与基线

| 项 | 值 |
|---|---|
| 基线 | `origin/main = dc48abc1`（#141，整合 #138–#140） |
| 基线普通 CI | [run 39664944449](https://github.com/wei500L/newwei/actions/runs/39664944449) 在精确 head `dc48abc18c2a5921ace8189db6471c5a3ef0a3c2` 上 `conclusion=success` |
| 分支 | `review/go-identity-core` |
| worktree | `/Users/oo/project/newwei-review-identity-core` |
| 开工时开放 PR | 无（`gh pr list --state open` 为空） |
| 审查方法 | `.workflow/reviews/static-audit.md` 的对抗式复核（先取两侧 `file:line` 证据，再主动尝试推翻） |

Nest 侧范围：`modules/auth`、`modules/rbac`、`modules/org`、`modules/audit`、`modules/config`（env schema 与默认值）、`common`（守卫、装饰器、全局异常过滤器、trace 中间件、CORS）、`modules/system-settings`、`modules/storage`、`modules/cache`、`modules/health`、`modules/email`、`modules/user-settings`、`modules/model-service`、`modules/vector`（客户端部分）、`main.ts` 全局中间件。

Go 侧范围：`internal/{authn,authz,authhttp,cors,httpx,config,legacyproxy,shadow,canary,metrics,apidocs,nestnotfound}` 与领域包 `authlogin`、`authfactors`、`oidclogin`、`accountsecurity`、`accountdata`、`identityonboarding`、`rbacapi`、`platformgovernance`、`runtimesettings`、`dataruntimesettings`、`infrastructuresettings`、`modelaccesssettings`、`emailsettings`、`smtpmail`、`objectstorage`、`rediscache`、`settingshttp`、`usersettings`、`usersettingsread`、`usersettingswrite`、`auditoutbox`、`health`、`runtimediagnostics`、`vectorclient`，以及 `cmd/api` 的对应 wire 文件。

不在本窗口（由其他窗口审查）：crawl、新闻与条目、态势与实时信号、GraphQL 执行器与订阅、dashboard、告警、分析、助手、知识图谱、队列运维。

> **开工前复核修正了两条任务书前提**（以代码为准）：
> 1. `API_GO_IDENTITY_ONBOARDING_MODE` **没有 shadow 状态**（`config.go:4382-4389` 只接受 `""/legacy/go`，非法值启动失败；`cmd/api/identity_onboarding.go:31-34` 非 `go` 时 14 条路由完全不注册）。真正默认为 shadow 的是 `API_GO_ONBOARDING_MODE`（`config.go:3534-3542`，只涉及 user-settings 的 onboarding GET）。
> 2. 规划时记载「没有查到 main 上该 SHA 的 CI 运行记录」，实际存在且为 success（见上表）。

## 2. 入口清单

按 Nest 入口**组**（对应一个 Go 接管组 / 一条路由规则族）列出，不是 370 条逐行清单。路由→Go→开关的逐条映射仍以 [`ownership-audit.md`](../cutover/ownership-audit.md) §2/§3 为准，本次逐组复核其与源码一致，未发现映射错误。

| Nest 入口组 | Nest 事实源 | Go 实现 | 开关（默认） | 审查深度 | 结论 |
|---|---|---|---|---|---|
| 登录 11 路（登录/验证码/refresh/MFA 挑战/找回密码/邮箱变更） | `modules/auth/auth.controller.ts` + `auth.service.ts` | `internal/authlogin`（`cmd/api/auth_login.go`） | `API_GO_AUTH_LOGIN_MODE`（legacy） | 全文（14 文件） | AUTH-01 P1 已修；AUTH-04 P2 已修；其余等价 |
| 已认证 MFA / auth-factors 管理 7 路 | `mfa.service.ts`、`auth-factors.lock.ts` | `internal/authfactors`（`cmd/api/auth_factors.go`） | `API_GO_AUTH_FACTORS_MODE`（legacy） | 全文 | MFA-01 P2 已修；MFA-02/03 P2 记录 |
| OIDC 登录 3 路 + 回调 | `oidc-auth.service.ts` | `internal/oidclogin`（`cmd/api/oidc_login.go`） | `API_GO_OIDC_LOGIN_MODE`（legacy） | 全文 | MFA-04/05 P2 记录；handoff 条件领取已验证 |
| 账户安全（会话/安全设置/登出） | `auth.controller.ts` + `auth-security.service.ts` | `internal/accountsecurity` | `API_GO_ACCOUNT_SECURITY_MODE`（legacy） | 重点（会话吊销、改密 CAS、限速、黑名单读侧） | AUTH-02 同款 fail-open 已修 |
| 头像 presign + 数据导出 | `user-data-export.service.ts`、`modules/storage` | `internal/accountdata` | `API_GO_AVATAR_UPLOAD_MODE`、`API_GO_USER_DATA_EXPORT_MODE`（legacy） | 重点（DTO、key 生成、导出范围） | IDENT-02 P2 已修；IDENT-07 P3 |
| 邀请/注册申请/审批 14 路 | `org-invite.service.ts`、`registration-application.service.ts` | `internal/identityonboarding` | `API_GO_IDENTITY_ONBOARDING_MODE`（legacy，**无 shadow**） | 全文 | IDENT-01 P0（Nest 侧，Go 已收窄）；IDENT-03 P2 记录 |
| RBAC 角色/权限/成员 8 路 | `modules/rbac/rbac.controller.ts` | `internal/rbacapi` | `API_GO_RBAC_MODE`（legacy） | 全文（逐 handler 权限对照） | RBAC-01 P2 已修；RBAC-07 P2 已修 |
| 组织读写（GraphQL 八写 + 成员） | `modules/org`、`org.resolver.ts` | `internal/rbacapi` / `orgaccesswrite` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` 等 | 重点（B-2 类跨租户） | 两侧均已按目标组织重推导，无复刻漏洞 |
| 审计日志 + outbox | `modules/audit`、`audit-log-retention.service.ts` | `internal/auditoutbox`（消费）、各域 producer | `API_GO_AUDIT_OUTBOX_MODE`、`API_GO_AUDIT_LOG_RETENTION_MODE`（legacy） | 重点（租约、条件 claim、去重恒等式、attempts/dead、退避） | 恰好一次语义等价 |
| 运行时设置 18 路（登录限流/auth 缓存/调度/新闻源/NewsNow） | `modules/system-settings/*controller*.ts` | `internal/runtimesettings`（`cmd/api/runtime_settings.go`） | `API_GO_RUNTIME_SETTINGS_MODE`（legacy） | 全文 + SEC-01 逐端点表 | SET-01 P1 记录；SET-02..06 P2 已修 |
| 数据运行时设置（S3/vector/realtime/archive） | 同上 | `internal/dataruntimesettings`（`cmd/api/data_runtime_settings.go`） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（legacy） | 全文 + SEC-01 逐端点表 | INFRA-01 P2 已修；其余等价 |
| 基础设施设置 18 路 | 同上 | `internal/infrastructuresettings`（`cmd/api/infrastructure_settings.go`） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（legacy） | 全文 | INFRA-01 已修；INFRA-02/03 P3 |
| 模型接入与密钥（含 openai-keys、proxy-lb） | `modules/system-settings`（model access）、`modules/model-service` | `internal/modelaccesssettings` | `API_GO_MODEL_ACCESS_SETTINGS_MODE`、`API_GO_PROXY_LOAD_BALANCING_MODE`（legacy） | 全文 + 密钥专项 | MOD-03 P3 已修；MOD-05 P3 记录 |
| LLM 网关配置 / 运维 / 日志 | `modules/system-settings` + `prometheus` 外的运维端点 | `internal/{llmgatewayprofiles,llmgatewayops,llmlogs}` | `API_GO_LLM_GATEWAY_PROFILES_MODE`、`API_GO_LLM_GATEWAY_OPS_MODE`、`API_GO_LLM_LOGS_MODE`（legacy） | 重点（相邻域抽查 PA 门禁） | 门禁与 Nest 一致；A10 跨域备注 |
| 邮件设置 + SMTP 发送 | `modules/email`、`auth-email-code-settings.service.ts` | `internal/{emailsettings,smtpmail}` | `API_GO_EMAIL_SETTINGS_MODE`（legacy） | 全文 | MOD-01 P1 已修；MOD-02 P2 已修；MOD-04 P2 记录 |
| 用户设置 6 GET + 6 PUT | `modules/user-settings/user-ui-settings.controller.ts` | `internal/{usersettings,usersettingsread,usersettingswrite}` | `API_GO_USER_SETTINGS_READ_MODE`（空串=兼容）、`API_GO_USER_SETTINGS_WRITE_MODE` | 全文 | SET-06 已修；SET-09/10 P3 |
| 向量服务诊断 | `system-settings` vector diagnostics | `internal/vectorclient` + 诊断 handler | `API_GO_VECTOR_DIAGNOSTICS_MODE`（legacy） | 重点 | `maxRetries` 封顶 10（MOD-07 P3） |
| 存储诊断（S3 连接测试） | `storage-settings.controller.ts` | `internal/objectstorage` + 诊断 handler | `API_GO_STORAGE_DIAGNOSTICS_MODE`（legacy） | 全文 | 无发现 |
| 运行时诊断 | `system-settings` runtime diagnostics | `internal/runtimediagnostics` | `API_GO_RUNTIME_DIAGNOSTICS_MODE`（legacy） | 未审查（仅核对了它读的共享配置键） | — |
| `GET /api/healthz`（认证版七探针） | `modules/health/health.controller.ts` | `internal/health`（`cmd/api/main.go:1789`） | `API_GO_HEALTHZ_MODE`（legacy） | 重点（返回形状、缓存、门禁、503） | 等价 |
| `GET /api/healthz/live`（公开存活） | 同上 | `internal/health.LiveHandler` | `API_GO_HEALTHZ_LIVE_MODE`（legacy；规则默认 shadow） | 全文 | GW-02 P2 已修 |
| `GET /api/metrics` | `observability/metrics.controller.ts` | `internal/metrics`（`cmd/api/main.go`） | `API_GO_METRICS_MODE`（legacy） | 重点（门禁全文、族定义全文、接线） | GW-03 P2 记录（族无写入方） |
| `/docs` + `/docs/json`（Swagger） | `main.ts` SwaggerModule | `internal/apidocs`（`cmd/api/apidocs.go`） | `API_GO_DOCS_MODE`（legacy） | 重点（`SWAGGER_ENABLED` 解析、未匹配 404） | 等价 |
| 异常上报 2 路（client / internal） | `client-exception-events.controller.ts`、`internal-exception-events.controller.ts` | `internal/exceptioningest`（`cmd/api/exception_ingest.go`） | `API_GO_EXCEPTION_INGEST_MODE`（legacy） | 重点（文档形状、归一化） | GW-04 P2（记录口径收窄） |
| 网关 fallback / shadow / canary | 无 Nest 对应（迁移期机制） | `internal/{legacyproxy,shadow,canary}` | `API_GO_LEGACY_FALLBACK_MODE`（proxy）、`CANARY_PERCENT`（0）、shadow 各路由规则 | 全文 | 无回归；reject 覆盖全部 legacy 来源 |
| 全局中间件（helmet/cookie/body 限制/CORS/ValidationPipe/前缀） | `main.ts` | `cmd/api/main.go` 根 handler + `internal/{httpx,cors}` | — | 全文 | CORS/body 上限等价；helmet 无 Go 对应（见 §6） |
| Redis 租约 / 缓存原语 | `cache.service.ts` | `internal/rediscache` | — | 全文 | 等价 |
| BullMQ 消费者 / cron / 队列 | 各 processor / scheduler | 各域 worker 包 | 各 `*_WORKER_MODE` | 只核对了本窗口内与 auth/settings 相关者的门控与租约 | 未逐队列审查（见 §5） |
| Socket.IO 6 namespace | 各 gateway | `internal/{socketio,notificationssocket,realtimesocket}` | 各自开关 | 未审查（其他窗口） | — |
| GraphQL 138 根字段 | resolvers | `internal/graphqlread` | 各 `API_GO_GRAPHQL_*` | 只抽样核对 settings/auth 相关字段的权限 | 未逐字段审查（见 §5） |

## 3. 发现列表

级别口径：P0 数据损坏/越权/鉴权绕过/密钥泄露；P1 功能错误、重复副作用、事务缺失、后台停摆；P2 响应契约（字段、顺序、null、时间格式、错误消息与状态码）与性能退化；P3 可读性、注释、日志。

合计 **63 项**：P0 = 1、P1 = 3、P2 = 24、P3 = 35。其中**已修复 25 项**（P1 2 项、P2 13 项、P3 5 项 + P0 项在 Go 侧早已收窄），**仅记录 38 项**。

### 3.1 P0

| ID | 标题 | 证据 | 影响 | 处理 |
|---|---|---|---|---|
| IDENT-01 | Nest 审批列表 / `approve-join` 回传 reviewer 的 `passwordHash` | Nest：`registration-application.service.ts:139-142,153-155,263-269` 的 `include: { reviewedBy: true }` + `packages/db/prisma/schema.prisma:113`，且 `main.ts` 无全局序列化器 ⇒ 整行 Prisma User 序列化进响应。Go：`identityonboarding/models.go:116-132` 的 `userView` 已收窄为显式字段集 | 任何能读审批列表的角色（`users.write`/平台管理员）可拿到他人 bcrypt 哈希，离线爆破 | **Go 早已收窄，本批未改动**。属「Nest 既有问题，Go 已修复，行为变化」，切流说明需写明。测试：`identityonboarding TestUserViewNeverCarriesCredentials` |

### 3.2 P1

| ID | 标题 | 证据 | 影响 | 处理 |
|---|---|---|---|---|
| AUTH-01 | 密码重置令牌未条件领取 | Nest：`password-reset.service.ts:107-128,134-157`（事务外读 `usedAt` 后无条件写）。Go 修复前：`authlogin/passwordreset.go:134-152`（预检查在事务外）+ `:163-186`（`UPDATE ... WHERE userId = ? AND usedAt IS NULL`，无 `tokenHash` 谓词、无 `RowsAffected` 检查） | 同一 token 的并发两次请求都通过预检查，各自提交 `User.passwordHash`（后写者胜），双方都返回 `{ok:true}`。被盗但仍被受害者使用的重置链接可让攻击方赢得竞态 | **已修复**：事务内先按 `tokenHash + usedAt IS NULL + expiresAt > now` 条件领取，`RowsAffected != 1` 回滚并返回与其他令牌失败一致的 401。提交 `4403c703`。测试：`authlogin TestResetPasswordClaimsTokenExactlyOnce`。**Nest 既有问题，Go 已修复，行为变化**：并发重复使用从「双成功」变为「一成功一 401」 |
| MOD-01 | SMTP 信封发件人直接使用带显示名的 `SMTP_FROM` | 仓库自带示例：`.env.example:47`、`infra/docker/.env.sample:68` 均为 `SMTP_FROM="Wei <wei500l@163.com>"`。Go 修复前：`smtpmail/smtpmail.go` 把该值直接传给 `client.Mail(from)`（`net/smtp` 只拦 CR/LF），`NewMessageID` 也产出 `<...@163.com>>` | 真实 MTA 对 `MAIL FROM:<Wei <addr>>` 回 501 ⇒ 登录邮箱验证码与设置页测试邮件两条链路全部失败；Message-ID 头畸形 | **已修复**：新增 `envelopeAddress()`，信封用裸邮箱、`From:` 头保留显示名（与 nodemailer 的解析一致）。提交 `66a42e9c`。测试：`smtpmail TestEnvelopeAddressExtractsDisplayName`、`TestSendUsesTheMailboxAsEnvelopeSender`、`TestNewMessageIDIgnoresTheDisplayName` |
| SET-01 | 17 条全局设置写接口只要求组织级 `settings.manage` | Nest：各 settings controller 的装饰器（仅 `audit-log-settings.controller.ts:37` 有平台管理员门）；Go：`runtimesettings/handler.go:265`（audit-log 有）、`runtimesettings/auth.go:21,67`（其余 17 条只查 `settings.manage`）。`packages/config/src/rbac.ts:64-72` 显示内置 `admin` 角色持有全部 CORE_PERMISSIONS，而 `SystemSetting` 无组织维度 | 任一组织管理员可改**全平台**的登录限流阈值、auth profile 缓存 TTL、调度并发、新闻源调度、NewsNow 权重 | **仅记录（需产品决策）**。两侧行为完全相同 ⇒ 非回归，且 Go 忠实复刻了既定设计；修它等于给 17 条加 `assertPlatformAdmin` **并同期修改 `apps/web` 设置导航**（否则非平台管理员的后台页面会整片 403），属跨端行为变更。建议：确认 SEC-01 是否只覆盖向量/LLM 网关/存储（本批已逐条确认那三类**都有**平台管理员门），若要把运行时限流等也纳入，另开一批带 UI 变更的任务 |

### 3.3 P2

| ID | 标题 | 证据 | 影响 | 处理 |
|---|---|---|---|---|
| GW-01 | 错误响应 `path` 丢失查询串（4 个窗口独立命中） | Nest：`common/filters/global-exception.filter.ts:112` `path: request?.url`，Express 的 `req.url` 是路径**加**查询串。Go：`authhttp/errors.go:68`、`authfactors/errors.go`、`dataruntimesettings/errors.go`、`infrastructuresettings/errors.go`、`modelaccesssettings/errors.go` 原用 `r.URL.Path`。同仓 `nestnotfound/nestnotfound.go:74` 已固化正确契约 | 所有带查询串的失败请求（403/401/409/503）错误体 `path` 与 Nest 不同；按 path 聚合的日志/前端提示分叉 | **已修复**（authhttp 共享写出器 + 3 个自带 contractError 的域）。提交 `066f2240`。测试 8 个：`authhttp TestAuthenticateWritesPathWithQueryString` 等、`authfactors TestContractErrorPathKeepsTheQueryString`、`dataruntimesettings TestConflictPathKeepsQuery`、`infrastructuresettings TestContractErrorPathKeepsQuery`、`modelaccesssettings TestServiceUnavailableBodyKeepsTheQueryString` |
| GW-02 | `httpx.WriteJSON` 的 content-type 缺 charset 且正文多一个换行 | Express `res.json` = `application/json; charset=utf-8` + `JSON.stringify` 结果（无尾随换行）。Go 修复前 `httpx/middleware.go:80-85` = `application/json` + `json.NewEncoder(...).Encode`（追加 `\n`）。同仓其余错误写出器全部按 Express 形态实现 | 生产影响面：`GET /api/healthz/live`（Nest 契约端点、也是 shadow 差分基线）、`/graphql` 的 413 响应体、`legacyproxy` 的 501/502 | **已修复**（Marshal + 无换行 + charset），`health.LiveResult` 同步为逐字节一致。提交 `0d43ca50`。测试：`health TestLiveResultMatchesHandlerOutput`（已加强为字节 + content-type 断言） |
| GW-03 | NestJS 兼容指标族在 Go 定义但从不观测 | Nest：`observability/prometheus-metrics.ts:52-88` 定义五族，`main.ts:84-96` 在全局中间件里记 `http_request_duration_seconds`。Go：`metrics/families.go:29-70` 同名/同标签/同 help/同桶定义，但 `RecordHTTPRequestMetric`、`RecordJobDurationMetric`、`RecordIntegrationEvent` 在非测试代码中**零调用**（`RecordSchedulerRun` 只被 `classificationalert/scheduler.go:373,381` 调用），根 handler（`cmd/api/main.go:3367`）只包了 `httpx.TraceMiddleware` | 已迁移路由的 HTTP 时延完全不入账；Nest 删除后 `http_request_duration_seconds`、`background_job_duration_seconds`、`integration_events_total` 永久为空，依赖它们的看板与告警静默失效 | **仅记录**。修复需在根 handler 外再加一层记录中间件，必须原样透传 `Flusher`/`Hijacker`（SSE 与 `/socket.io*` upgrade 都经过它）；本机不能编译/运行，写错会破坏流式与 WebSocket。列入 §6 |
| GW-04 | 异常事件记录口径收窄：Go 只记 404 | Nest：`global-exception.filter.ts:88-101`（http）、`:130-152`（graphql）对**每个**异常都 `exceptionEvents.record(...)`（401/403/400/409/5xx 都记）。Go：`cmd/api/legacy_fallback.go:88-105` 的 recorder 只在 reject 模式 / docs 的未匹配 404 上写事件，域 handler 的错误出口不写 | 切流后 `exceptionevents` 只剩 404，admin 端「异常事件」页与按 statusCode/kind 的统计基本归零 | **仅记录**。修复需把 recorder 注入每个域的 auth/error 出口（横切）。列入 §6 |
| AUTH-02 | 撤销名单值按错误的 JS 真值语义判定（fail-open） | Nest：`value ? JSON.parse(value) : null` 再 `Boolean()`——`[]`/`{}` 在 JS 中恒为真（= 已撤销），空串短路成 `null`（= 未撤销）。Go 修复前 `authn/blacklist.go:88-114` 与 `accountsecurity/login_port.go:384-405` 把 `[]`/`{}` 当「未撤销」，把空串当解析失败（500） | 撤销查询出现 fail-open 方向：若键值不是 `"true"`，被撤销的 token 会被放行。当前 Nest 只写 `"true"` ⇒ 不可达，但方向错误 | **已修复**（两份副本一起改）。提交 `24578b94`。测试：`authn TestJSTruthyJSON`、`accountsecurity TestJSTruthyTextMatchesJavaScriptTruthiness` |
| AUTH-03 | `authz` 无 profile 缓存，每请求 4 次 MySQL | Nest：`auth.service.ts getUserProfile` 走 `auth:profile:<userId>:<orgId>` 缓存（`AUTH_PROFILE_CACHE_TTL_SECONDS` 默认 600，`config.service.ts:412`）。Go：`internal/authz/mysql_repository.go` 每请求实查 user/org/membership/role 四表 | 每个受保护请求 4 次 DB 查询，切流后鉴权 QPS 全部压到 MySQL | **仅记录（需共享文件）**。收益是「权限永远来自当前数据库」，安全性优于缓存；引入缓存必须与 `accountsecurity.InvalidateProfileCache` 使用同一 key，否则角色变更后 600s 内仍生效（安全风险）。构造点在 `cmd/api/main.go:1481`（共享文件），且本机无法验证失效链路，故不在本批做 |
| AUTH-04 | 密码长度按 rune 而非 UTF-16 码元计数 | Nest：`@MinLength` 走 validator.js `isLength`，比较 `str.length`；服务层 `password.trim().length` 同理。Go 修复前 `authlogin/dto.go` 与 `passwordreset.go` 用 `len([]rune(...))` | 四个 emoji（rune 4 / UTF-16 8）在 Nest 满足最小长度 8，在 Go 被判过短 | **已修复**：新增 `jsStringLength`（`utf16.Encode` 长度）。提交 `2fb73a41`。测试：`authlogin TestMinLengthCountsUTF16CodeUnits` |
| MFA-02 | TOTP 无重放保护：同一 30 秒 step 可重复使用 | 两侧一致（窗口 ±1）。Nest `mfa.service.ts` 的校验只比较时间步，不记录已用 step；Go `authfactors/mfa.go` 同构 | 截获到的一次 TOTP 在窗口内可重复提交 | **仅记录**。修复需要新增「已用 step」列或 Redis 键（schema/共享资源变更），超出本批「不新增开关、最小改动」边界 |
| MFA-03 | MFA 管理写路由没有失败计数/锁定 | `auth-factors.lock.ts` 是**互斥锁**（GET_LOCK 串行化并发写），不是限流器；只有 `AuthChallenge` 有尝试预算，且仅登录路径 | 通过已认证会话枚举/暴力 TOTP 验证不受限速约束 | **仅记录**。两侧一致（非回归）；建议在文档里不要把 `auth-factors.lock.ts` 描述成限流 |
| MFA-04 | OIDC `state` 未绑定浏览器/会话 | 两侧都没有 state cookie；Go 用 GETDEL 保证单次使用 + 600s TTL | 攻击者若能在自己浏览器完成一次授权并把 `state` 转给受害者，存在登录 CSRF 面 | **仅记录**。两侧一致；无 cookie ⇒ 也没有 Set-Cookie 属性差异可对齐 |
| MFA-05 | OIDC 按 email 关联本地账号，不校验本地 `User.emailVerified` | 只由 `requireEmailVerified`（默认 true）约束 id_token 侧；本地账号是否已验证未检查 | 若 IdP 允许未验证 email，可把 IdP 账号关联到他人未验证的本地账号 | **仅记录**。仅改 Go 会让所有「本地邮箱未验证 + OIDC 登录」的账号直接登不上（Nest 仍是旧行为），必须两侧同期切换 |
| IDENT-02 | 头像 presign 的 DTO 层缺 `@IsIn`/`@IsInt`/`@Min`/`@Max` | Nest：`AvatarPresignRequestDto` 的装饰器在 controller 之前被 ValidationPipe 执行，故 `"Unsupported avatar content type"` 一类文案在 HTTP 上**不可达**。Go 修复前把 accept-list 与 1..2MB 范围放在 service，并有一句「与 StorageService 同序」的错误注释 | 400 文案与 Nest 完全不同（class-validator 文案 vs 服务层文案） | **已修复**：DTO 阶段补齐四个装饰器，按同一属性装饰器自下而上顺序报告；service 判断保留为第二道防线。提交 `afd1985e`。测试：`accountdata TestParseAvatarPresignRequestClassValidatorMessages` |
| IDENT-03 | `approve-org` 在「组织已创建、邀请未落地」时不可重试 | `identityonboarding/application.go:318-372` 与 Nest `registration-application.service.ts:357-412` 同构：补偿只包 `CreateOrg`，邀请失败后申请停在 `approved` 且 `generatedInviteId=null`，重试 404、重发无入口 | 组织成孤儿，需要人工介入 | **仅记录**。修法要么改审批状态机、要么新增补救入口，属产品决策 |
| RBAC-01 | RBAC 写限流桶键缺 `rate:` 命名空间 | Nest：`rate-limiter.service.ts:128` 的 `const bucketKey = \`rate:${key}\``，`action-rate-limit.service.ts:71` 传入 `rbac:write:<org>:<actor>` ⇒ 物理键 `rate:rbac:write:...`。Go 修复前 `rbacapi/ratelimit.go:72` 直接用不带前缀的键，注释还声称「与 NestJS 共享同一桶」 | 混合部署两侧各记一份额度，实际放行翻倍；注释声明与实现矛盾 | **已修复**：`sharedRateLimitPrefix` + `rbacWriteKey()`。提交 `946deead`。测试：`rbacapi TestRbacWriteKeySharesTheNestRateLimitNamespace` |
| RBAC-02 | Go RBAC 限流器没有 Nest 的熔断 / fail-open / 清理阈值 | Nest `rate-limiter.service.ts` 有 `circuitState`、`RATE_LIMIT_REDIS_FAIL_OPEN`、eval 超时、`cleanupLimit`/`cleanupThreshold`；Go `rediscache` 只有滑动窗口脚本 | Redis 故障期若 Nest 配 `fail-open=true`，两侧对同一批 RBAC 写给出不同结论 | **仅记录**。默认 `fail-open=false` 时两侧一致（都 fail-closed） |
| RBAC-07 | `/api/rbac/members` 回传 `user.passwordHash` | Nest：`rbac.service.ts listMembers` 的 `include: { user: true }` 返回整行 Prisma User。Go 修复前 `rbacapi/model.go:73` 原样复刻该字段 | 持 `users.read` 的任何角色（内置 analyst 即有）可读到全部成员的 bcrypt 哈希 | **已修复**：`json:"-"`（列仍扫描，不进响应体）。`apps/web` 对该字段零引用，GraphQL schema 无此字段。提交 `ff054410`。测试：`rbacapi TestUserViewNeverSerializesPasswordHash`。**Nest 既有问题，Go 已修复，行为变化** |
| SET-02 | 同一属性的校验消息顺序反了 | 依据本仓已记录的真实栈实测（`docs/refactor/bug-ledger.md:1086`：`retentionDays must not be greater than 3650; ... less than 1; ... be an integer number`）与 `platformgovernance/dto.go` 已按此实现并在 smoke 逐字节对齐；bug-ledger 当时把本包差异登记为观察项 | 同一属性多条约束同时失败时（如整数字段传字符串），message 顺序与 Nest 不同 | **已修复**（Max→Min→IsInt / Max→Min→IsNumber）。提交 `f7d3ffce`。测试：`runtimesettings TestValidationMessageOrderBottomUp` |
| SET-03 | 数组元素级校验消息措辞与聚合顺序错误 | 缺 `each value in <field> ` 前缀，且首个错误即返回（Nest 收集全部约束） | 400 message 与 Nest 不同 | **已修复**。提交 `f7d3ffce`。测试：`runtimesettings TestNewsSourceAllowlistEachMessages` |
| SET-04 | auth-cache 存储值非对象：Go 500，Nest 降级 | Nest `auth-cache-settings.service.ts:86-96` 用 `{...fallback, ...value}`，非对象展开贡献 0 个字段 ⇒ 全落回 env 默认并返回 200 | 一条脏行让整个 GET 变 500 | **已修复**：降级到 fallback。提交 `f7d3ffce`。测试：`runtimesettings TestStoredAuthCacheSettingsDegrades` |
| SET-05 | 多租户调度存储值 `null`：Go 返回默认 + `source=db`，Nest 409 | Nest `normalizeStoredSettings` 对非普通对象返回 null ⇒ 409 | 脏行被静默当成默认值，掩盖配置损坏 | **已修复**：先判对象形状再 409。提交 `f7d3ffce`。测试：`runtimesettings TestStoredMultiTenantConcurrencyShape` |
| SET-06 | user-settings PUT 的未知字段消息顺序 | Nest ValidationPipe 的 whitelist 消息先于属性约束消息；同仓 `situationsettings`、`crawlprofile` 已按此约定实现 | 同一次 400 的 message 顺序不同 | **已修复**。提交 `f7d3ffce`。测试：`usersettingswrite TestPlanWrongTypeAndUnknownFieldAreDistinct` |
| SET-07 | 运行时设置未知字段只报第一个且吞掉属性消息 | `runtimesettings/dto.go:334` 的 `DisallowUnknownFields` 在解码阶段就中断 | 多个未知字段时只报一条，同请求的属性消息全部丢失 | **仅记录**。修复需重写 7 个域的自定义解码，超出本批最小改动边界 |
| MOD-02 | 邮件设置两个 DTO 静默接受未知字段 | Nest 全局 ValidationPipe = whitelist + forbidNonWhitelisted ⇒ 400 `property X should not exist`；Go 修复前用 `json.Unmarshal` 忽略未知字段 | 本应 400 的请求被接受并落库 | **已修复**：按请求体成员顺序聚合 whitelist 消息（`__proto__` 与 Nest 一样跳过），排在属性消息之前。提交 `584c9549`。测试：`emailsettings TestEmailDTORejectsUnknownProperties` |
| MOD-04 | smtpmail 只支持 AUTH PLAIN，且非 TLS 连接直接拒绝认证 | `net/smtp` 在未加密连接上拒绝 AUTH；只宣告 AUTH LOGIN 的服务器无法登录。Nest/nodemailer 两者都支持。默认 `SMTP_SECURE=true` 不受影响 | `SMTP_SECURE=false` 的内网明文中继或 LOGIN-only 服务器上发信全部失败 | **仅记录**。修需自实现 `smtp.Auth` + 机制协商，且本机无 SMTP 服务器可端到端验证（现有 fixture 恰好绑 127.0.0.1 落在 localhost 白名单） |

### 3.4 P3（仅记录列表，除注明「已修」外本批不改）

| ID | 标题 | 处理 |
|---|---|---|
| AUTH-05 | `authz` 的 DB 错误一律 503，Nest 只对 Prisma 初始化/panic/schema 过期 503（其余 500） | 记录。fail-closed 方向不变 |
| AUTH-06 | `mtk_` 机器令牌在 `authhttp` 链上被拒；Nest 全局 `JwtAuthGuard` 对所有受保护 HTTP 路由接受。本窗口 11 条路由等价，`verify-email` 场景 Nest 400 / Go 401 | 记录 |
| AUTH-07 | `ExtractBearerToken` 比 passport-jwt 宽松（容忍多空格并 trim） | 已修（注释），提交 `9f654dc0` |
| AUTH-08 | 登录限速桶解析边界：cache 文档存在但缺 `login` 桶/非数字时，Go 回落 DB 行、Nest 回落 env | 记录 |
| AUTH-09 | refresh 宽限期缓存把 JSON `null` 当作命中（Nest 把 falsy 当未命中） | 记录（不可达） |
| AUTH-10 | `authhttp.WriteForbidden` 只有 any 模式；`@PermissionsAll` 只用于 GraphQL 两个根字段 | 记录 |
| MFA-06 | 机器令牌 `lastUsedAt` 刷新不更新 `updatedAt`（Prisma `@updatedAt` 会，DDL 无 `ON UPDATE`） | 记录 |
| MFA-07 | 机器令牌 `permissions` 含非字符串项时整体丢弃（Nest 逐项过滤）；经 API 不可达 | 记录 |
| MFA-08 | `bearer mtk_...`（小写 scheme）Go 接受、Nest 不接受；无提权影响 | 记录 |
| IDENT-04 | 匿名接受邀请在事务外建 User，claim 失败留孤立账户（与 Nest 同构） | 记录 |
| IDENT-05 | `/me` 的 `permissions`/`roleIds` 顺序：Nest 依 DB 隐式顺序，Go 强制 `ORDER BY`（确定性更好） | 记录 |
| IDENT-06 | identityonboarding 的审计 actor 未把 `machine:<id>` 归一为 NULL（另两包已归） | 记录 |
| IDENT-07 | `GET /data-export` 未设 Content-Length（有意流式，正文一致） | 记录 |
| IDENT-08 | A10 边角：编码器辅助函数以 `any` 收参、Mongo Mixed 解到 `any` | 记录 |
| RBAC-03 | A10：`rbacapi` 用 `[]any` / `map[string]any` 搬运令牌权限与限流配置 | 已修，提交 `946deead` |
| RBAC-04 | 审计写入「双失败」：Nest 抛错使已提交的写变 500，Go 只记日志（有意改进），注释曾误称「对齐」 | 记录 |
| RBAC-05 | `resetLlmLogMetadataPolicy` 注释与实现不符（实际经公开 update 路径，无嵌套 GET_LOCK） | 已修（注释），提交 `a7eb3344` |
| RBAC-06 | `limit` 的 `Number("0x10")`、`includeSystem` 重复参数两处边角差异 | 记录 |
| INFRA-02 | `infrastructuresettings/model.go:61` 的 `systemSecurityTTLSeconds = 30` 无引用死常量，Nest 为 60s（`system-security-settings.service.ts:40`）；本包只读该缓存 ⇒ 零行为影响 | 记录 |
| INFRA-03 | 三处「契约对齐」注释不精确（route 计数、`sourceId` 正则 `(?i)` 与 JS `/i` 的极端字符折行差异） | 记录 |
| SET-08 | `news_indicator_port.go` 注释把默认值写成 4（实为 2） | 已修（注释），提交 `f7d3ffce` |
| SET-09 | A10：`usersettings/onboarding.go` 的 `map[string]any`、`usersettingsread` 的 `any` | 记录 |
| SET-10 | `completedTours` 键顺序与 Nest 不同 | 记录 |
| SET-11 | 机器令牌 permissions 混合类型数组：Go 全拒、Nest 保留字符串项（fail-closed） | 记录 |
| SET-12 | 多租户调度设置的 30s 进程内缓存不随写失效（上界与 Nest 多实例相同） | 记录 |
| SET-13 | `GET /rate-limit-policies` 缺 Nest 的「表结构过期」容错 | 记录 |
| MOD-03 | `jsNumberFromJSON([true])` 返回 1，JS `Number([true])` 是 NaN（脏行会把 timeoutMs 变成 1ms） | 已修，提交 `955f7d94` |
| MOD-05 | `whatwg_url.go` 序列化与 WHATWG `URL.toString()` 仍有 4 处差异（fragment 编码集、special-query 漏 `'`、非 ASCII 未 `%XX`、`http://host:80:80` 未拒绝） | 记录 |
| MOD-07 | 向量检索把 `maxRetries` 硬性封顶 10（Nest 无上限） | 记录 |
| MOD-08 | 检索请求未透传 `x-trace-id`（Nest 总带 `getCurrentTraceId()`）；`internal/newspipeline/dedupe.go:668` 同类 | 记录 + 转派（见 §5） |
| MOD-09 | 邮件缺 `Date:` 头；`authlogin` 不传 MessageID 时也无 Message-ID | 记录 |
| GW-05 | `legacyproxy/proxy.go:507-514`（502）、`:613-618`（501）用 `map[string]any` 且缺 `timestamp`（Go 独有路径，Nest 无对应） | 记录（A10） |
| GW-06 | 空 `x-trace-id` 头的回退语义不同：Nest 用 `??`（空串不触发回退），Go 用 `== ""`（会回退到 `x-request-id`） | 记录 |
| GW-07 | `EnsureTraceID` 随机源失败时用确定性字节兜底（JS 会抛错） | 记录 |
| GW-08 | `internal/health/{probes.go,ready.go,ready_test.go}` 未 gofmt（基线即如此，CI 未检查 gofmt） | 记录。修复方式：`gofmt -w apps/api-go/internal/health/{probes.go,ready.go,ready_test.go}` |

## 4. 被推翻的疑点

方法要求「先写两侧证据，再尝试推翻」。以下疑点经反证**不成立**，记录下来避免后续重复审查。

### 4.1 JWT / 会话 / 守卫

1. **算法可混淆（alg=none / RS256）**：两侧同拒。Go 用 `jwt.WithValidMethods([]string{"HS256"})`（`authn/jwt.go`）。唯一差异 HS384/HS512：`jsonwebtoken` 对字符串 secret 允许三者，Go 只 HS256 ⇒ Go 更严且不可达（Nest 从不签发），记为刻意收紧。
2. **时钟偏差/`iat` 校验不一致**：`golang-jwt v5.2.3` 的 `verifyIat` 默认 false、`exp` leeway 为 0，与 `jsonwebtoken` 默认一致；已补测试行 `expired-one-second-ago`、`iat-in-future`。
3. **`@Permissions` 被当成「全部满足」**：两个装饰器都存在——`Permissions`（any）、`PermissionsAll`（all）；HTTP 侧**没有任何** `@PermissionsAll` 使用点，Go 的 any-only `WriteForbidden` 无影响。GraphQL 的三个 `@PermissionsAll` 根字段见 4.3。
4. **refresh 并发刷新导致误登出**：`.workflow/reviews/static-audit.md`「Rejected E-4」依赖的 Nest 去重（`cache.wrap` 按旧 token 键、宽限期缓存成功结果）在 Go 侧逐项复刻；Go 另有 loader 内的条件领取。未回归。
5. **`@Public` / 可选认证路由被 Go 改严或改松**：11 条 authlogin 路由的 `@Public`/`@AllowAuthenticated` 与 200/201（`mfa/enrollment/start` 201）逐条一致；`auth` 控制器里 4 类带 `@Permissions` 的路由权限名与模式一致。
6. **登出/改密未吊销令牌**：refresh 按 tokenId 吊销 + 进黑名单，`logoutAll` 按 userId，access 黑名单 TTL = 剩余寿命，改密 CAS + 吊销全部 refresh + 失效 profile 缓存；两侧都**不**吊销当前 access（Nest 既有行为，非缺失）。
7. **机器令牌可以绕过平台管理员门**：`runtimesettings`/`metrics`/`dataruntimesettings`/`infrastructuresettings`/`modelaccesssettings` 的写路径对 `machine:` 身份事前拒绝且不查库（比 Nest 更严），平台管理员判定都是活查 `GlobalRoleAssignment`（`role=platform_admin`）。
8. **`@PermissionsAll` 的三个 GraphQL 根字段在 Go 被降级为「仅认证」**：`graphqlread/itemsingest/register.go:33-35` 注册为 `AllowAuthenticated: true`，初看像丢掉 `crawl.read`+`items.write`。**反证成立**：resolver 每个入口内联 `requireAll(permissions, CrawlRead, WritePermission)`（`resolver.go:140-142`、`:160-162`、`:196` 附近）并映射成 `requiredPermissions/permissionsMode=all` 形状。不构成发现，但说明「执行器本身不强制 all 模式」这一事实必须由每个域自行兑现。

### 4.2 租户与 RBAC

9. **B-2（`updateOrg`/`setOrgActive` 按调用者当前组织判 `org.write`）在 Go 被复刻**：未复刻。Nest 已在 `org.service.ts:379-421` 改为按**目标组织**重推导；Go `orgaccesswrite/org.go:292-312` 经 `rbacapi.ActorHasPermission` 同样重推导。
10. **B-1 类（客户端 id 无 `orgId` 谓词）**：逐条核过 8 条 RBAC 入口 + 16 条 system-settings 入口的所有 SQL，全部带组织谓词；join 申请的 SQL 自带 `orgId`（`identityonboarding/application_store.go:46-58`）+ `users.write` 重推导；`new_org` 走 `platform_admin`。
11. **跨租户 id 返回 404 还是 403 不一致**：本窗口所有入口与 Nest 同码同文案；审计 outbox 的去重恒等式（含 `actorId IS NULL`）与租约键逐字节一致。
12. **邀请/申请令牌可并发双接受**：`invite_store.go:152-167`、`application_store.go:105-118` 都是事务内条件 UPDATE claim ⇒ 不会双 membership；re-accept / 过期 / 撤销分别 401/404。
13. **SEC-01 有写接口漏平台管理员**：逐端点表（`settings-runtime` 18 行 / `settings-data-infra` 18 行 / `model-email-vector` 11 行）核对后，向量服务、存储、realtime、archive、nominatim、model access、openai keys、LLM gateway profiles、email **全部**有平台管理员门，无「只查 `settings.manage` 漏 PA」的写口。两处「看似 Nest 缺 PA」的疑点被推翻：存储 PATCH 与四个服务层的 PA 都在 `service.ts` 方法首行而非 controller。

### 4.3 密钥与凭据

14. **设置里的密钥明文回显/落日志**：46 处 log 全为 keyName/sourceId/key/action；响应侧用 `tokenSource`/`hasToken`/`****` 脱敏；AES-256-GCM 信封（`system-settings:v1`、base64 布局）可跨语言互解；解密失败降级与生产 fail-closed 决策表两侧一致；审计元数据只记指纹（UTF-16 `slice(0,4)+"***"`）。
15. **内部令牌可被 JWT/mtk_ 冒充**：3 条精确路由、常量时间比较、`token` 不 trim、403 先于 401，JWT 与 `mtk_` 都不会被当作内部调用方。

### 4.4 网关 / 契约 / 配置

16. **`METRICS_DEFAULT_BUCKETS` 默认值或解析不同**：Nest `config.service.ts:1347-1367` 解析成 `metricsDefaultBuckets`，但 `grep -rn metricsDefaultBuckets apps/api/src` 只命中 config.service.ts 自身 ⇒ 解析后从未使用，是死配置。Go 的固定桶（`families.go:11,14`）与 Nest **实际**行为等价。
17. **`WS_REDIS_ADAPTER_ENABLED` / `WS_REDIS_ADAPTER_KEY` / `WS_MAX_CONNECTIONS_*` 默认值不同**：逐项一致（默认 true / `socket.io` / 5 / 50），非法布尔值两侧都启动失败。
18. **`SWAGGER_ENABLED` 默认值不同**：Nest 是 `NODE_ENV === "production" ? false : true`；Go `apidocs/swagger_enabled.go:31-46` 逐 case 复刻（含 `yes/on/1`、空串、非法值启动失败）。
19. **`CORS_ORIGIN` 空值时的安全性**：Nest 在 production 缺 `CORS_ORIGIN` 时**拒绝启动**（`env.schema.ts:1423-1436`），Go 允许空串。但 Go 的空名单 = 拒绝一切浏览器 Origin 且从不反射 `*`（`cors/policy.go:78-90`），是更严格的失败安全姿态，不构成安全回归（已记为行为差异）。
20. **CORS 预检细节**：与 `cors@2.8.5` 逐项对齐——方法串 `GET,HEAD,PUT,PATCH,POST,DELETE`、反射 `Access-Control-Request-Headers`、`credentials:true`、预检 204 + `Content-Length: 0`、`Vary: Origin`；空名单下空 OPTIONS 仍写 204（与 `optionsSuccessStatus` 一致）。
21. **有路由组不处理 CORS 预检**：逐文件核对 `cmd/api/*.go` 的 `RegisterGoHandler` 与 `FinishOptions` 配对；`main.go` 里未直接调用的 7 处均有出口——`/graphql` 在 `graphqlread/handler.go:127-133` 自己处理 OPTIONS；`publicportal` 四条只注册 GET（OPTIONS 回落 legacy 由 Nest 应答，reject 模式下由 `nestnotfound.Write` 的 `FinishOptions` 应答 204）；`/__go/*` 与 socket 路径非浏览器预检对象。
22. **shadow 默认配置下会双写**：`shadow.IsShadowableMethod` 只放行 GET/HEAD/OPTIONS，网关侧 `isReadonlyMethod` 同样，写方法直接纯代理；默认 shadow 的规则只有 `/api/healthz/live` 与 3 个 `user-settings/ui/*` GET，且 Go 读路径无 INSERT/UPDATE（upsert 只在 `usersettings/upsert.go`，由写 handler 使用）⇒ 默认配置零写副作用。
23. **canary 默认会分流到 Go**：`AllowUnverifiedIdentity` 默认 false（`Route()` 直接回 legacy），`CanaryPercent` 默认 0，双重 fail-safe；分流依据是未验签的 `orgId` claim，这一点在包注释里被显式声明为不可用于鉴权。
24. **reject 模式漏掉 legacy 来源**：所有 legacy 出口都收敛到 `proxyLegacy`（`proxy.go:563-571`），reject 时改写 404 且不触达反向代理；覆盖 `ModeLegacy` 分支、未匹配路径的兜底规则、`/api/` 兜底、`/graphql`、`/socket.io/`、`/docs`、`/admin/queues`、canary 回落与任何调用 `ServeLegacy` 的 handler。另有启动期反射校验 `validateLegacyRejectModes`（`config.go:6981-7023`）：reject 要求**每个** `*Mode` 字符串字段为 `go`，唯一豁免是 fallback 开关自身，新增开关自动纳入。
25. **请求体上限与 Nest 的 body-parser 不一致**：Nest 全局 `json({limit:"10mb"})` + `urlencoded({extended:true})`（默认 100kb）；Go 无全局中间件，各域自设。本窗口相关包（`platformgovernance`、`dataruntimesettings`、`infrastructuresettings`、`llmgatewayprofiles`、`accountsecurity`、`crawlprofile`、`newsbehavior`、`exceptioningest`、`crawlstrategyruns`、`userdigest`）均为 `10 << 20`。例外见 §5。
26. **`/api/healthz` 就绪响应形状**：`{status,info,error,details,version,now}` 键序、`now` 的 ISO 毫秒 UTC、5s 缓存、任一探针失败 → 503 + `status:"error"`，与 terminus + `health.controller.ts` 一致；`writeReady` 用 `application/json; charset=utf-8` 且不加换行。
27. **`/api/healthz/live` 泄露版本**：两侧都只返回 `{"status":"ok"}`，无 version/timestamp。
28. **开关非法值被静默降级**：抽查 `API_GO_LEGACY_FALLBACK_MODE`、`API_GO_DOCS_MODE`、`API_GO_METRICS_MODE`、`API_GO_HEALTHZ_MODE`、`API_GO_HEALTHZ_LIVE_MODE`、`API_GO_ONBOARDING_MODE`、`API_GO_IDENTITY_ONBOARDING_MODE` 均为 `switch` 全枚举 + default 追加启动错误；空串语义按各单元既定约定（多数 = legacy，`API_GO_USER_SETTINGS_READ_MODE` 空 = 兼容，`API_GO_ONBOARDING_MODE` 空 = shadow）。
29. **`objectstorage` 的签名 URL 有效期/上传限制不一致**：`presignExpiry` 与 `MinExplicitTTLSeconds=30`（`Math.max(30,…)`）对齐；`CreateObjectUploadURL` 把 `ContentLength` 签进签名，S3 会拒绝实际大小不符的对象；凭据只用显式静态值，禁用默认凭据链与实例元数据。
30. **`rediscache` 租约过弱**：`WithLock` = `SET NX PX` + 随机 token + `ttl/3` 续期（下限 500ms）+ compare-and-delete 释放，释放用 background context；`wrap` 续期间隔 `ttl/2`，与 Nest 一致。

## 5. 未覆盖的部分与后续建议

### 5.1 本批未审查（如实记录）

| 对象 | 状态 |
|---|---|
| `internal/runtimediagnostics`（2074 行） | 只核对了它读取的共享配置键；业务分支未审查 |
| `internal/vectorclient` 的检索/写入实现细节 | 只审了配置、认证、重试与 orgId 过滤；嵌入/重排算法未审 |
| BullMQ 消费者、cron 与队列（本窗口相关的 auth/settings 域已核门控与租约，其余队列） | 未逐队列审查 |
| GraphQL 138 个根字段 | 只抽样核对 settings/auth 相关字段的权限与 `@PermissionsAll`（4.1 第 8 条）；未逐字段审查 |
| Socket.IO 6 个 namespace | 未审查（其他窗口） |
| `internal/config/config.go` 的 275 个「两侧都读」变量 | 只逐条核对了核心跨域项与本窗口相关项（PORT、NODE_ENV、CORS_ORIGIN、TRUST_PROXY、LEGACY_API_URL、DATABASE_URL、SCHEDULE_ENABLED、WS_REDIS_ADAPTER_*、SWAGGER_ENABLED、shadow 预算、AUTH_* 与限流相关）；**其余未逐条比对默认值** |
| `cmd/api/*.go` 的 wire 文件 | 只核对 CORS 配对、handler 注册与 metrics 接线；业务分支未逐个读 |
| `modules/storage` 的上传大小/类型/对象键的**调用方**语义 | `objectstorage` 包本身全文审过；对象键组织前缀由调用方构造，落在 items/crawl 窗口 |
| `auth-factors.lock.ts` 的锁粒度与超时 | 已核对锁名/超时/409/503 映射；未审其在多实例下的时钟假设 |

### 5.2 转派给其他窗口（本窗口范围外，仅记录）

1. `internal/itemsingest/handler.go:151` 用 `1 << 20` 作为请求体上限，而 Nest 该路由允许 10mb（`main.ts` 的 `json({limit:"10mb"})`）⇒ 大于 1MB 的请求会被 Go 拒绝。属条目窗口。
2. `internal/graphqlread/handler.go:148-154` 的 413 响应体用 `map[string]any`（A10）且缺 `traceId`/`path`/`timestamp`（Nest 的 body-parser 413 会经全局过滤器补齐三者）。属 GraphQL 窗口。
3. 同一 `path` 契约（GW-01）在以下本窗口外的包仍为 `r.URL.Path`：`itemsingest`、`itemsreading`、`analysisexport`、`llmgatewayops`、`userdigest`、`situationsettings`、`dashboardcharts`。
4. `internal/newspipeline/dedupe.go:668` 未传 TraceID，`x-trace-id` 永远缺失（MOD-08 同款）。属新闻流水线窗口。
5. A10 `[]any` 机器令牌权限解析仍在 `internal/metrics/handler.go:246`（本窗口内，已列 GW-05 之外单独记录）、`internal/adminlogs/service.go:71`、`internal/llmlogs/store.go:634`、`internal/newssources/store.go:526`。
6. `docs/refactor/migration-map/modules/identity.md:41-84` 的路由表已滞后（仍把 14 条入组路由标「Nest；尚未接管」，头像/导出标「未合 main」），与同页 `:7` 及源码矛盾。

### 5.3 建议的后续审查

1. 把「`path` 保留查询串」的契约统一到剩余 7 个包（机制化：抽一个共享写出器，避免再出现第 9、10 份副本）。
2. GW-03（指标族无写入方）与 GW-04（异常事件口径）建议合并为一批「可观测性接线」，因为它们同属「切流后监控静默失效」这一类，且都需要在根 handler / 各域错误出口加横切层。
3. AUTH-03（鉴权 profile 缓存）建议与 `accountsecurity.InvalidateProfileCache` 的失效点一起设计并单独成批，因为失效写错的后果是「已撤销的权限仍生效」。
4. 对 `internal/config` 的 275 个共读变量做一次机器化的默认值/解析对照（本批只做了抽样），这是删除 Nest 前最容易留下静默行为差异的区域。
5. `SET-07`（运行时设置未知字段只报第一个）建议按域逐个重写解码器，可与 3 条 GraphQL 写接线一起做。

## 6. 删除 Nest 之前必须确认的事项

以下是本批确认的、会在 Nest 进程消失后**改变系统行为或失去能力**的点。前 6 项是硬阻塞。

1. **指标族会变成永久空面板（GW-03）**。`http_request_duration_seconds`、`background_job_duration_seconds`、`integration_events_total`、`pipeline_metric_value` 在 Go 侧只有定义没有写入方；今天这些数据全部由 Nest 的全局中间件与 worker 产生。停 Nest 前必须：(a) 给 api-go 根 handler 加 HTTP 时长记录（透传 `Flusher`/`Hijacker`），(b) 给各 worker 加 `RecordJobDurationMetric`/`RecordIntegrationEvent`，或 (c) 明确接受这几个族的永久为空并下线相关看板与告警。
2. **`nodejs_*` 与 `process_*` 系列消失**。Nest 用 `collectDefaultMetrics({register})` 暴露 `nodejs_eventloop_lag_seconds`、`nodejs_heap_*`、`process_resident_memory_bytes` 等；Go 的 `metrics/processmetrics.go` 提供的是 `go_*` / `process_cpu_seconds_total` / `process_start_time_seconds`，映射表写在文件头注释里，但 `nodejs_gc_duration_seconds`、`nodejs_eventloop_lag_seconds`、`nodejs_active_handles/requests` 明确**不再提供**。任何引用这些名字的看板/告警必须先改。
3. **异常事件只剩 404（GW-04）**。停 Nest 后 `exceptionevents` 集合不再有 401/403/400/409/5xx 与 GraphQL 错误记录，admin 端「异常事件」页只剩未匹配路由。需要先决定：接受收窄，或把 recorder 注入各域错误出口。
4. **`helmet()` 的一组安全响应头没有 Go 对应**。Nest 在进程入口 `app.use(helmet())`（`helmet@^7.1.0`，默认配置）注入 `Content-Security-Policy`、`Cross-Origin-Opener-Policy`、`Cross-Origin-Resource-Policy`、`Origin-Agent-Cluster`、`Referrer-Policy`、`Strict-Transport-Security`、`X-Content-Type-Options`、`X-DNS-Prefetch-Control`、`X-Download-Options`、`X-Frame-Options`、`X-Permitted-Cross-Domain-Policies`、`X-XSS-Protection`；`internal/cors` 的包注释明确写了「X-Frame-Options 不在这里补，它来自 NestJS 进程入口的 helmet()」。全仓 Go 侧只有 `internal/crawlreadtelemetry/service_media.go:168,173` 为媒体投递单独设了 `X-Content-Type-Options` 与一条 CSP，**没有全局等价物**。停 Nest 后所有由 Go 直接写出的响应（含 `/api/healthz/live`、`/metrics`、`/docs`、reject 模式的 404）都将失去这些头。必须先在 Go 侧重放同组头（或确认反代统一注入）。
5. **`cookieParser()` 没有 Go 对应**。Nest 在入口装 `cookie-parser@^1.4.6`；Go 侧 `grep -rn "r.Cookie(" apps/api-go` 零命中，即没有任何 Go handler 读取 cookie。因此切流本身不会丢失 Go 已实现的能力，但必须确认**没有残留的 Nest 路由依赖 `req.cookies`**（OIDC state、refresh 若依赖 cookie 则切流后会失效）。
6. **`@PermissionsAll`（all 模式）在执行器层没有表示**。Go 的 `graphqlread/contract.Root` 只有 `Permission`（单个）与 `AnyPermissions`（any）与 `AllowAuthenticated`，all 语义完全靠各域在 resolver 内联 `requireAll`。新增 GraphQL 写字段时若忘记内联，就会**静默降级为「仅认证」**（本批已确认现有 3 个字段都逐一内联，见 4.1 第 8 条）。删除 Nest 前建议把 all 模式提升为 `contract.Root` 的一等字段。
7. **`itemsingest` 的 1MB 请求体上限**（§5.2 第 1 条）与 Nest 的 10mb 不一致；停 Nest 前若该路由的大请求只走 Nest，切流后会开始 413。
8. ~~**仍由 Nest 独占的 5 条 HTTP**（`ownership-audit.md` §2 C 类）~~ → **本条已在 2026-10-27 整合复核中更正，见 §8.1。这 5 条都有 Go handler 与开关，缺的只是「默认未启用」。**原文写于 `dc48abc1` 基线，与本文件同一基线；`ownership-audit.md` 页首与 §2.1 当时已记「C-1…C-5 全部关闭」，本行未同步，属本报告的表述错误，不是代码缺口。
9. **`API_GO_IDENTITY_ONBOARDING_MODE` 没有 shadow 状态**：这意味着这 14 条路由当前只有「Nest 全权」或「Go 全权」两种状态，没有安全差分窗口。切流前应补齐 `API_GO_IDENTITY_ONBOARDING_MODE=go` 的集成验证，而不是依赖 shadow 观察。
10. ~~**审计 outbox 的消费方仍在 Nest**~~ → **本条已在 2026-10-27 整合复核中更正，见 §8.2。**Go 侧 `cmd/api/audit_outbox.go` 的 `wireAuditOutbox` 已在 `cmd/api/main.go` 接线并有消费者实现；原文「Go 只是 producer」与同基线源码矛盾。
11. **兜底代理与 `LEGACY_API_URL`**：`API_GO_LEGACY_FALLBACK_MODE=reject` 才是不触达 Nest 的形态，其启动校验已要求全部 `*Mode=go`（4.4 第 24 条）。停 Nest 前必须切到 `reject`，否则反向代理目标会变成 502（`legacyproxy` 的 `ErrorHandler` 会写 502）。
12. **组织级平台设置写权限（SET-01）**：两侧一致地允许任一组织管理员修改全平台设置。这不是切流阻塞，但是在「Nest 删掉、只有 Go」之后仍然存在的授权面；建议在停 Nest 前决定是否收紧并同期改 Web 导航。

## 7. 交付与验证

| 项 | 值 |
|---|---|
| 基线 | `dc48abc1`（CI run 39664944449 = success） |
| 分支 / worktree | `review/go-identity-core` / `/Users/oo/project/newwei-review-identity-core` |
| 报告提交 | 见本文件所在提交 |
| 提交 | 16 个修复提交 + 2 个报告提交（共 18），逐条 SHA 见 PR 描述 |

**验证口径**：本机只做了静态阅读、`git diff` 逐文件核对与 `gofmt -l`（改动文件全部干净；`internal/health` 的 3 个文件为基线既有问题，已列为 GW-08）。**没有编译、没有运行测试、没有连接任何真实服务**。全部正确性主张都还待普通 CI 验证；精确 head SHA、run 链接与各 job 结论记录在 PR 描述中，`skipped` 不计为通过。

### 7.1 CI 期间发现并修复的问题（本批自己引入的）

第一次 CI（head `b8cbd67a`，run 39819425923）`verify` job 失败，`go test ./...` 报两个测试失败。两者都是本批新代码的问题，已单独提交修复：

| 提交 | 问题 | 性质 |
|---|---|---|
| `7e8ba9c6` | RBAC-03 把 `permissionList` 从 `[]any` 改为 `[]json.RawMessage` 后，`json.Unmarshal` 会把 JSON `null` 成功解进 `string` 并留成空串，于是 `MachineAccessToken.permissions` 里的 `null` 项变成一个空的权限名（改动前的 `item.(string)` 会丢弃它，与 NestJS 的 `typeof === "string"` 过滤一致）。补「必须是字符串字面量」前置判断 | 本批引入的行为回归 |
| `fa5f89db` | GW-01 的测试断言 `traceId` 非空，暴露出 `authhttp.writeError` 只取 context 值、没有 Nest `getCurrentTraceId() ?? ensureTraceId()` 的兜底（同仓 `nestnotfound.Write` 有）。在 TraceMiddleware 之外写出错误时 `traceId` 会是空串 | 本批暴露的契约差异（生产路径不可达，因为根 handler 总经过 TraceMiddleware） |

这次失败也说明：**静态审查无法替代编译与测试**。本批 25 处修复中，只有这 2 处是 CI 能立刻抓到的类型/断言问题，其余全部依赖「按既有惯例逐字模仿」才没有引入编译错误。

## 8. 整合复核更正（2026-10-27）

> **本节性质**：§1–§7 是 `dc48abc1` 基线上的原审查交付，保留原核查基线、审查深度与历史证据。本节只更正**已核实为错误或已过期**的「当前事实」表述，并补做整合后的接线核对；它不是对全文的重新审查，也不能据此认为其余条目已被重新验证。核对基线为整合分支 `integration/go-review-b142-147-4` 在合入 #142–#147 之后的 head。
>
> 更正原因：§6 的两条结论与**同一基线**的源码矛盾。§3/§4 的发现本身不受影响（它们是「Go 与 Nest 的行为差异」判断，与是否接线无关），因此本节不重述这些条目。

### 8.1 §6 第 8 条：五条 HTTP 并非 Nest 独占（现行结论：Go 已实现、默认未启用）

原文把 `GET /api/healthz/live`、三条 crawl-frontier 写入口、vector diagnostics 列为「仍由 Nest 独占」。**该结论错误**：这五条在当前基线都有 Go handler、`legacyproxy` 精确规则与独立开关，`ownership-audit.md` 在同一基线已标 C-1…C-5 全部关闭（该文件页首「计数更新」段与 §2.1）。缺的只是**默认值仍不指向 Go**，不是实现缺失。

| 路由 | Go handler | 规则注册 | 开关与源码默认 | 启用条件 |
|---|---|---|---|---|
| `GET /api/healthz/live` | `internal/health.LiveHandler`（`cmd/api/main.go` 的 `RegisterGoHandler("/api/healthz/live", …)`） | `legacyproxy.WithHealthzLive`（`legacyproxy/healthz_live_routes.go`，exact GET） | `API_GO_HEALTHZ_LIVE_MODE`，默认 **`shadow`**（`config.go` 的 `switch`，空串与 `shadow` 同支） | `=go` 由 Go 响应；`shadow` 保持 Nest 响应的差分观察；`legacy` 纯代理 |
| `POST /api/admin/crawl-frontier/runs` | `internal/crawlfrontierruns` 的 `handler_write.go`（创建 run 复用 `crawlfrontierllm.CreateFrontierRunFromProfile`） | `legacyproxy.WithCrawlFrontierWrites`（`crawl_frontier_writes_routes.go`，exact POST） | `API_GO_CRAWL_FRONTIER_WRITES_MODE`，默认 `legacy` | `=go` **且** `API_GO_CRAWL_FRONTIER_RUNS_MODE=go`（否则启动失败，不静默打开父开关） |
| `POST /api/admin/crawl-frontier/nodes/retry` | 同上 `handler_write.go` | 同上 exact POST | 同上 | 同上 |
| `POST /api/admin/crawl-frontier/nodes/:id/retry` | 同上（动态段） | 同上 one-segment POST | 同上 | 同上 |
| `GET /api/system-settings/vector-service/diagnostics` | `internal/infrastructuresettings` 的 `vector_diagnostics.go`（进程级共享 `vectorclient.Health`，输出同 17 字段） | `legacyproxy.WithVectorDiagnostics`（`vector_diagnostics_routes.go`） | `API_GO_VECTOR_DIAGNOSTICS_MODE`，默认 `legacy` | `=go` 由 Go 报**本进程**状态；多实例之间数字可能不同（与 Nest 的进程内语义一致） |

四条权限与语义复核（只读源码）：三条 crawl-frontier 写入口沿用 `crawl.write`，`WithCrawlFrontierRuns` 的读规则与写规则分属两个开关，写开关打开不会连带读规则；vector diagnostics 需要已认证身份 + 平台管理员门（`wireVectorDiagnostics` 的 `db`/`redis`/`authenticator` 三个依赖缺一即启动失败），不是匿名入口。

**因此正确的「删 Nest 前」表述是**：这五条**不需要迁移**，只需在部署时把四个开关置 `go`（`API_GO_HEALTHZ_LIVE_MODE` 还多一个 `shadow`→`go` 的过渡步）。

> 与 §2 入口清单的一致性：§2 该行的「开关（默认）」列已写 `legacy`/`shadow`，与本节一致；§6 第 8 条的「仍由 Nest 独占」是同一报告内的孤立表述，已按本节更正。

### 8.2 §6 第 10 条：审计 outbox 的 Go 消费者已实现并接线

原文写「Go 只是 producer」。**该结论错误**，同基线即不成立：

- 消费者：`internal/auditoutbox` 有完整 `Scheduler`（`scheduler.go` 的 `Start`/`Close`/`loop`/`runTick`）、`processCandidate` → `deliver` → `writeAuditLog`，含 `(orgId, actorId, resource, action, createdAt)` 去重恒等式、`attempts`/`dead` 阈值、`round(30000 * 2^… * jitter)` 退避与 Redis 续租；测试 `scheduler_test.go` 覆盖租约占用、租户不匹配判死、去重命中、claim 失败不写、退避与死信、Close 后不再领取。
- 接线：`cmd/api/audit_outbox.go` 的 `wireAuditOutbox` 在 `API_GO_AUDIT_OUTBOX_MODE != go` 时返回 `nil, nil`；`go` 时要求 `db` 与 `redisClient` 非空（否则启动失败），并且**还有第二道门 `SCHEDULE_ENABLED`**——`SCHEDULE_ENABLED=false` 时只打一行日志不启动。`cmd/api/main.go` 调用该 wire 并在非 nil 时 `Start(context.Background())`，`Close` 在共享 Redis 关闭之前执行。
- 生产端：各域 producer 写 `AuditOutbox` 行（本文件 §2 已核）。

**正确的剩余事项**是配置而非实现：`API_GO_AUDIT_OUTBOX_MODE=go` **且** `SCHEDULE_ENABLED=true`，两者缺一则 Go 不消费。`SCHEDULE_ENABLED=false` 时 Nest 的审计 outbox 定时器同样停摆（该变量是两端共读的全局调度门），因此这不是 Go 独有的缺口，但停 Nest 前必须确认部署没有用 `SCHEDULE_ENABLED=false` 关掉整批后台任务。

### 8.3 §6 第 6 条（`@PermissionsAll`）与 §5.2 第 1 条（`itemsingest` 1MB）复核结果

这两条**成立，不是过期结论**，此处只补当前实现的准确边界：

1. **all-permission 语义仍靠 resolver 内联**。`graphqlread/contract.Root` 至今没有一等 `AllPermissions` 字段；`graphqlread/itemsingest/register.go` 的三个写 root 仍注册为 `AllowAuthenticated: true`，权限由各自 resolver 第一段的 `requireAll(...)` 兑现（映射成 `requiredPermissions` + `permissionsMode=all`）。**因此「执行器没有 all 字段」本身不构成越权**——现有三个入口都逐条内联了检查。真实风险是**新增** GraphQL 写字段时遗漏内联，属未来准入约束，不是现行 bug。
2. **`itemsingest` 的 1MB 上限仍在**（`internal/itemsingest/handler.go`）。本批未改，属真实契约差异：`>1MB` 的请求在 Go 返回 413、在 Nest 返回 200/400。整合批次未触及该文件，故该条保持「待修」。

### 8.4 与 SET-01 相关的现行判断（不作收紧）

§3.2 的 SET-01（17 条全局设置写只要求组织级 `settings.manage`）**仍然成立且仍是两侧一致**：本批核对了 `runtimesettings` 的权限判定与 `packages/config/src/rbac.ts` 的内置 `admin` 角色权限集，结论不变。**整合批次不收紧**：收紧需同期修改 `apps/web` 设置导航与页面门禁（否则非平台管理员的后台页面整片 403），属跨端产品变更。该条保留为下一阶段的候选事项，不列为本次整合回归。

### 8.5 本节核对方法与限制

- 只读源码 + `git show dc48abc1:…` 对比；未运行 `go build`/`go test`/`pnpm`/Docker，未连接 MySQL/Redis/Mongo/SMTP/OIDC/S3。
- 未重新核对原报告 §3 的 63 条发现（它们不是本节的更正对象）。
- 五条路由的「启用条件」来自 `config.go` 的 `switch` 与 `wire*` 的早退条件，不是部署实测；**没有任何证据表明这些开关在生产是 `go`**。
