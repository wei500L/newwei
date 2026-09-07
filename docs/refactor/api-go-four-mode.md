# api-go 四态路由与首个迁移单元（shadow/canary 实现说明）

> 2026-09-03 落地 · 2026-09-07 Go-批3A 增补（exact+method 路由与 onboarding go 接管）
> 关联：docs/refactor/go-migration-adr.md §3/§4/§4.3、roadmap M2

---

## 1. 四态从「类型声明」到可运行实现

`apps/api-go/internal/legacyproxy/proxy.go` 的路由表（`DefaultRules(onboardingMode)`）。**匹配语义（Go-批3A 起）**：迁移单元 = **exact path + method 白名单**——不匹配的方法（如 PUT）与相似路径（`onboarding-x`、`onboarding/other`）回落更短的通用规则（`/api/` legacy，由 NestJS 处理）；通用 fallback 规则 = 前缀匹配 + 任意方法（既有语义不变）：

| 单元 | 匹配 | 模式 | 说明 |
|---|---|---|---|
| `/api/` | 前缀 | legacy | 全量反向代理到 NestJS（事实源；含全部未迁移端点、onboarding 的 PUT 与相似路径） |
| `/api/healthz/live` | exact + GET | **shadow** | 首个迁移单元（见 §2） |
| `/api/user-settings/ui/onboarding` | exact + GET | **shadow \| go**（`API_GO_ONBOARDING_MODE`，默认 shadow） | go 时为首个业务端点 Go 全响应（见 §2.1） |
| `/api/user-settings/ui/rss-reader`、`/api/user-settings/ui/spacetime-timeline` | exact + GET | **shadow** | Go-批2B 扩展单元 |
| `/graphql` `/socket.io/` `/docs` `/admin/queues` | 前缀 | legacy | 无 /api 前缀的挂载点分别声明 |
| `/__go/healthz` | 前缀 | go | 网关自省（路由表 + shadow/canary/onboarding 状态） |

### shadow（`internal/shadow/runner.go` + `legacyproxy` 捕获层）

- **客户端响应始终来自 NestJS，且保留流式语义**：捕获是「直通 + 有界旁录」——上游写入的每个字节即时转发给客户端（含响应头先达与 Flush 转发），同时最多旁录 `SHADOW_MAX_RESPONSE_CAPTURE_BYTES`（默认 1MiB）用于差分。客户端**不需要**等待捕获完成；SSE（text/event-stream）、协议升级（Upgrade 头）、超预算响应自动停止旁录只透传。差分失败/超限/超时都不影响主响应。
- **只读白名单**：GET/HEAD/OPTIONS 之外的请求（POST/PUT/PATCH/DELETE）直接跳过差分，**禁止对写请求双发**（`IsShadowableMethod` 双层强制：legacyproxy + shadow runner）。
- **独立预算**（环境变量可调）：
  - 单次执行超时 `SHADOW_TIMEOUT_MS`（默认 2s，select 强制中止——executant 不响应 ctx 也不拖槽位）；
  - 差分可重放的请求体上限 `SHADOW_MAX_REQUEST_BODY_BYTES`（默认 1MiB；超过时已读前缀经 MultiReader 拼回，**请求仍完整转发**，只放弃差分）；
  - 响应旁录上限 `SHADOW_MAX_RESPONSE_CAPTURE_BYTES`（默认 1MiB；超过即停旁录，主响应完整流式透传）；
  - 并发上限 `SHADOW_MAX_INFLIGHT`（默认 16）与每分钟令牌桶 `SHADOW_MAX_PER_MINUTE`（默认 600，burst 满额起步）。
- **分类丢弃统计**（`/__go/healthz` 的 `shadow.dropped`）：`request-too-large` / `response-too-large` / `streaming-skipped` / `concurrency-limit` / `rate-limit` / `timeout`——六类各自计数，不合并。
- **结构化差异记录（默认不含业务正文）**：JSON 行记录 traceId/method/path/两侧状态码/diffFields/两侧响应体 **sha256 hash**（`legacyBodyHash`/`goBodyHash`）。业务正文默认不进网关日志；显式开启 `SHADOW_DEBUG_BODY_LOG=true` 后才记录截断片段（`SHADOW_DEBUG_BODY_LOG_MAX_BYTES`，默认 2KB）。
- **差分忽略集**（登记制）：`traceId`/`timestamp`/`snapshotAt`/`now`/`generatedAt`/`requestId`——只忽略这些明确登记的非确定字段；扩展需 `RegisterIgnoredField` 且在 PR 说明理由，不允许用它掩盖真实差异。

### canary（`internal/canary/router.go`）——未激活的分流组件

- **信任边界（先读这个）**：分流的 orgId 取自 Bearer JWT payload 的 orgId claim，**未经验签**——不是可靠身份。NestJS 侧该 claim 只有签名验证后才被信任，且真实 org 上下文由 getUserProfile 从 DB membership 重推导（auth.service.ts:1452-1479）。伪造 token 可任选 orgId，从而选择自己这条请求进哪个实现。
- **fail-safe 双层**：
  1. `Options.AllowUnverifiedIdentity` 默认 **false**——Router 一律回 legacy，即使 `CANARY_PERCENT` 被误配为 100。生产装配（cmd/api/main.go）不开该开关；`TestDispatcherCanaryNeverRoutesUnverifiedIdentityToGo`（cmd/api）在远端 CI 锚定该语义；
  2. 无法解析身份（无 token / 非 JWT / mtk_ 机器令牌 / 无 orgId claim）→ legacy。
- **当前没有路由处于 ModeCanary**：`DefaultRules()` 无 canary 条目（`TestDefaultRulesHaveNoCanaryRoutes` 锚定——有人提前切换业务路由到 canary 时测试失败）。`CANARY_PERCENT` 是预留配置，canary 是**待鉴权基础设施接入的分流组件**，不是已激活能力。
- **分流数学**（开关开启后生效，组件级已测）：orgId → `sha256("canary-org:"+orgId)` 前 8 字节 → `[0,100)` 桶位；桶位 < percent → go。同组织恒同桶；比例变化只移动边界不重排组织；越界 clamp。
- **激活前置件**（迁移序 5）：Go 侧真实 JWT 验签（对称 secret + issuer/audience + jti 黑名单）与 org membership 重推导——Go-批3A 已为 onboarding 单元落地该最小闭环（`internal/authn`/`internal/authz`），但 canary router 尚未改造为消费「已验证身份」（仍读未验签 claim）——首个 canary 路由的启用仍待该改造完成。
- **回滚**：`CANARY_PERCENT=0` 或路由表规则改回 `ModeLegacy`——纯配置变更。
- **canary 命中但未注册 handler**：回退 legacy（不 501 客户端）。

## 2. 首个迁移单元：`GET /api/healthz/live`

- **选择理由**（迁移序 2「低副作用只读端点」）：`@Public()`、无副作用、无依赖（不连 MySQL/Redis/Mongo）——NestJS 实现是纯常量返回（`health.controller.ts:75-84`，刻意不含版本/时间戳防泄露）。
- **Go 实现**（`internal/health/handler.go`）：`{"status":"ok"}`、200、非 GET → 404（NestJS 只注册 GET）。shadow 差分执行者与 canary/go 模式 handler 是**同一实现**——差分通过即切换可信。
- **不是 `/__go/healthz`**：那是网关自省端点，不属于业务迁移；本单元是真实业务端点 `/api/healthz/live` 的契约等价实现。
- **迁移边界**：`GET /api/healthz`（AllowAuthenticated + 7 项真实依赖探针 + 5s 缓存）**未迁移**——需要数据库连接层，属后续单元；NestJS 实现保留为事实源。
- **回滚**：路由表 `/api/healthz/live` 改回 `ModeLegacy`（单行配置）。

### 2.1 首个业务端点 go 接管：`GET /api/user-settings/ui/onboarding`（Go-批3A）

`API_GO_ONBOARDING_MODE=go`（compose `api-go-pilot` profile 注入；默认 `shadow`）时，该单元从 shadow 升级为 **ModeGo**——首个由 Go 独立鉴权、独立授权、独立查库、独立响应的业务端点。完整语义（鉴权链、错误契约、路由边界、远端验收）见 ADR §4.3 与 `apps/api-go/README.md`；要点：

- 鉴权链：Bearer 提取（拒绝 mtk_）→ HS256 验签（`internal/authn`，拒 alg=none/混淆，iss/aud/exp/nbf 按 jsonwebtoken 语义，jti 缺失按 NestJS 语义放行）→ 真实 Redis blacklist（同一 key，fail-closed）→ 真实 MySQL membership/RBAC 重推导（`internal/authz`，同序同文案 401）→ `items.read` 判定（JWT permissions claim 结构上不可达）→ `internal/onboarding` 全响应。
- 路由边界：exact + GET——PUT 同路径与相似路径回落 `/api/` legacy（NestJS 单写/404）；RSS/Spacetime 仍是 shadow；`shadowUnits` 在 go 模式下移除 onboarding（`shadow.executed` 不再增长）。
- 回滚：`API_GO_ONBOARDING_MODE=shadow`（配置变更，回到批2A/2B 行为）。

## 3. 与鉴权矩阵/契约快照的关系

- 路由扫描器（`apps/api/tools/scan-routes.ts`）同时驱动 OpenAPI 快照与鉴权矩阵——Go 侧后续单元迁移时，以矩阵行为准（orgId 推导/fail-closed/错误形状逐字段对齐）。
- Go 网关自身的测试（`legacyproxy/proxy_test.go`）覆盖四态行为：legacy 透传、shadow 主响应来自上游且写请求不差分、canary 分流与 fail-safe、go 原生处理与 501 fail-closed。

## 4. 尚未验证项（诚实登记）

- shadow 差分「真实流量 0 差异」验收未做——api-go 未接入生产入口（默认部署 Web → NestJS 直连）；`api-go-entry-smoke` 只覆盖远端真实栈的受控流量
- canary **未激活**（无 ModeCanary 路由、AllowUnverifiedIdentity 默认关闭）；Go-批3A 落地的 onboarding 最小闭环 Go Auth 不改变这一点——canary router 仍消费未验签 claim，尚未改造为已验证身份分流
- onboarding go 接管（Go-批3A）**已完成远端真实栈验证**（含 NestJS 停止后的独立接管证明），但**仅限 pilot 范围**——生产/预发布真实流量未切换；MFA/OIDC/refresh/机器令牌语义未迁移（迁移序 5 余项）
- 本机按任务约束未运行 `go test`/`go vet`/`go build`；全部 Go 测试在远端 CI 执行
