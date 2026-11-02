# GO-ONLY-RUNTIME-001 · Go 运行时移除迁移分流

- 状态：`merged`；2026-11-01 核实 [#153](https://github.com/wei500L/newwei/pull/153) 实际 merge `e72440e186acbdf671be904cc98d1dd2f9858cbf`，最终源 head `fd571dac7a09630985af85c12c7b1aa45f5c6773` 已是 main 祖先；[普通 CI 41213872179](https://github.com/wei500L/newwei/actions/runs/41213872179) 三主 job success，两个 regen skipped。下方 pending/Ready 为原交付快照。
- 后继 #154 已合入，当前 `legacyproxy` 是纯 Go 路由器，仅保留旧包名；完整落地/CI/保留边界见 [收口记录](../GO-MIGRATION-CLOSEOUT.md)，不再派同一分流删除任务。
- 前置：[GO-CONTRACT-TOOLING-001](GO-CONTRACT-TOOLING-001.md) 已合入 main：PR #152 → merge `f22e36ae6fabf72c501ae2ad573eb3323fa0db35`，普通 CI（verify / vector-integration / api-go-user-settings-integration）success，两个 regen job skipped。
- 基线：`origin/main = f22e36ae`；规划基线 `fcf1e533` 的 #150/#151 已在 main。
- 分支 / worktree：`codex/go-only-runtime` / `/Users/oo/project/newwei-go-only-runtime`。
- 实现 head（代码）：`91bfc6cca...`（分支 `codex/go-only-runtime`；首个代码提交 `7a627429`，其后 `cf8013d4` go vet 冗余布尔、`e4a8a3a4` 未使用变量、`91bfc6cc` 测试修正）。本文档为唯一后续提交，不改代码。
- PR：[#153](https://github.com/wei500L/newwei/pull/153)（Ready，不合并、不 auto-merge）。
- 普通 CI（代码 head `91bfc6cc`，run `41210516276`）：**verify success**（Lint/go vet、Typecheck、Web component tests + coverage、Vector unit tests、API unit tests、OpenAPI/Auth/SDL drift、Go contract gate、Go tests、Build 全部通过）；`api-go-user-settings-integration` success；`vector-integration` 在自托管 runner 队列 pending（同一分支更早 head `7a627429`/`3cc4a9e7`/`e4a8a3a4` 的 vector-integration 均 success；非代码失败）；`contract-baseline-regen`/`go-modules-regen`/两条 smoke skipped（skipped 不算通过）。
- 规划任务 PR #149 未合并：本批只读取得需求，未合并规划分支代替业务前置。

## 交付内容

### 真实路由入口（Go 独立路由）
- `apps/api-go/internal/legacyproxy/proxy.go` 重写为纯 Go 路由器：`Rule{Prefix,Exact,OneSegment,TwoSegments,Tail,TailSegment,TailSuffix,HandlerKey,Methods}`；`New(rules) *Gateway`；`ServeHTTP` 命中→`RegisterGoHandler` 注册的 handler，未命中→`Reject`（`internal/nestnotfound` 渲染 Nest 等价 404，保留 CORS/trace/异常记录）。
- 路由表由 `BaseRules()` + `AllRoutes()` 组装（六个 user-settings GET/PUT/OPTIONS、`/__go/healthz`，以及 `WithX(rules)` 全部单元）。
- 保留 METHOD+完整路径、exact/prefix/动态段优先级、URL/尾斜杠、HEAD/OPTIONS、CORS、公开探针、Swagger/静态资源、metrics 内部鉴权与未知路径 404 语义；路由标签仍有界（`httpx.RouteFamily`）。

### 删除的迁移结构
- `httputil.ReverseProxy`、`ModeLegacy/Shadow/Canary/Go`、`New(legacyURL,rules)`、`ServeLegacy`、`ServeHTTPWithShadow`、`ShadowBudget/ShadowDispatcher`、shadow 捕获层、`internal/{canary,shadow,shadowidentity}` 包。
- `cmd/api` 的 `dispatcher`/`shadowUnit`/各 `*Executant`/`userSettingsShadowUnits`；全部 `cfg.*Mode` 迁移门槛与 `API_GO_*_MODE`（137 个）解析/枚举/交叉校验/`validateLegacyRejectModes`。
- `LEGACY_API_URL`/`CANARY_PERCENT`/`SHADOW_*` 代理与差分配置依赖（config 字段与解析一并移除）。
- GraphQL `exec.KindLegacy` 整包 operation 回退、`graphqlread.Options.Legacy` 与 `graphqlsubscriptions` 的 graphql-ws legacy upstream 传输（`legacy.go`）。
- 迁移专用指标 `api_go_legacy_proxy_requests_total` / `api_go_legacy_rejected_requests_total`。

### 保留的第二道门与真实校验
- `SCHEDULE_ENABLED`、`BULLMQ_WORKERS_ENABLED`、`WS_REDIS_ADAPTER_ENABLED`、`GRAPHQL_SUBSCRIPTION_BUS` 保留为后台/实时总开关。
- 资源/密钥校验、JWT/blacklist/机器令牌、MySQL RBAC、orgId 范围、事务、真实业务开关与 SMTP/加密密钥/crawl4ai/Mongo 等真实校验保留（迁移门槛删除后为无条件校验）。
- 正常业务上游（LiteLLM/crawl4ai/vector/AIS）HTTP/WebSocket 调用保留，不属于 Nest 回退。
- GraphQL 保留 parse/validation/APQ/GET/POST、depth/complexity/cache/null/default/error/trace、权限 any/all、HTTP 200+errors；未注册/不支持 root 在任何 mutation/入队/外部调用前以 HTTP 200+errors（query/mutation）或 subscription operation error 拒绝。

## 已知残留（如实）
- #150 自写 500 异常记录等既有残留继续保留，未因旧网关删除而额外收窄 REST/GraphQL 记录，未扩为全仓日志重写。
- GraphQL `Stats` JSON 去掉 `legacyForwards` 字段。
- config 资源校验现为无条件（Go-only 全部单元常驻），部署必须提供全部真实资源。
- 未删除 Node 后端源码、`apps/ais-relay` 等，留待 GO-NODE-RETIRE-001。

## 验证边界
- 本机只静态阅读/diff/gofmt，未安装或执行 build/test/lint/typecheck/vet/Docker/服务；由现有普通 CI 验证。
- 未声称部署或实网验证。

## 直接运行说明（本地 / compose）
- `apps/api-go` 现在直接拥有全部入口，不再需要 Nest 后端或 `LEGACY_API_URL`；未命中路由返回 Nest 等价 404。
- `.env` / compose 中的 `API_GO_*_MODE`、`CANARY_PERCENT`、`SHADOW_*`、`LEGACY_API_URL` 已不再被 Go 读取（保留在旧 Node 独立链样例中）；`SCHEDULE_ENABLED`/`BULLMQ_WORKERS_ENABLED`/`WS_REDIS_ADAPTER_ENABLED`/`GRAPHQL_SUBSCRIPTION_BUS` 仍生效。
- 回退旧链：以独立 Node 后端启动（旧 compose profile / 旧命令），不再通过 Go 的 mode 开关回退。

## 后继
- GO-NODE-RETIRE-001：仅在本任务实际合入与 CI 通过后执行；本批不删除 Node 基线。
