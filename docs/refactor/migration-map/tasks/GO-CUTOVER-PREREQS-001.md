# GO-CUTOVER-PREREQS-001 · 补齐 Go 切默认前的横切能力

- 状态：`pr_open`；编码已完成并推送，等待普通 CI 与复核。
- 规划基线：`f15f598d4358b4c9823054ef5a355618e1480a4e`；编码起点：`origin/main` = `bdbb581ac949dcdf43e7137c7624b6a8b04e8b31`（2026-10-27）。
- 来源：[#148](https://github.com/wei500L/newwei/pull/148) §7 第 1–4 项；四个稳定缺口见 [GAPS](../GAPS.md#2026-10-27-切默认前增量)。
- 执行提示词：[GO-CUTOVER-PREREQS-001.prompt.md](GO-CUTOVER-PREREQS-001.prompt.md)（随规划 PR #149 提供，本分支只带入任务 `.md`）。
- 编码分支：`codex/go-cutover-prereqs`；worktree：`/Users/oo/project/newwei-go-cutover-prereqs`。
- 规划记录：[Ready 规划 PR #149](https://github.com/wei500L/newwei/pull/149)。规划 PR 的 CI 不替代本业务 PR 的 CI。
- 前置事实：#142–#147 的六个源 head 已逐一验证为 `origin/main` 祖先；#148 实际 merge 为 `0a48babea69700c7f9cd1bf2262f25d414469527`。
- 普通 CI（本批 head）：见下方「普通 CI」一节，交付时回填精确 run 与逐 job 结果。
- 默认 / 部署 / 流量：本任务未改任何 `API_GO_*` 默认、compose、Web/vector/AIS 默认；**未部署、未承接真实流量、未连接真实外部服务**。

## 普通 CI

- 基线事实（编码前）：main `bdbb581a`（本分支起点）的 [run 40527760690](https://github.com/wei500L/newwei/actions/runs/40527760690) `conclusion=success`；前一 head `8e978360` 的 [run 40524559427](https://github.com/wei500L/newwei/actions/runs/40524559427) 亦 success。两者三个主要 job 均 success，两个 regen job skipped（skipped 不算通过）。
- 编码前另见 `cc3782c0` / `f15f598d` / `2a42bd30` / `5e44fae1` 数个 cancelled 或 failure 的 run，原因是 runner 内存预算（见 `ci.yml` 顶部注释与 `8e978360`、`5e44fae1` 的提交说明），与源码无关；这些 run 不视为通过，也不作为本批基线。
- **本批最终 head `3b487e58`（HEAD，仅文档回填）的 [run 40544141107 attempt 2](https://github.com/wei500L/newwei/actions/runs/40544141107) `conclusion=success`**：verify success、vector-integration success、api-go-user-settings-integration success；`go-modules-regen` 与 `contract-baseline-regen` skipped（不算通过）。
- 代码 head `896ad1e8` 的 [run 40538923975 attempt 2](https://github.com/wei500L/newwei/actions/runs/40538923975) 亦 `conclusion=success`，三主要 job success、两个 regen job skipped。
- 两次 verify attempt 1 都失败在**同一个未改动的 `apps/web` 测试文件**，每次抖动到不同用例：
  - `896ad1e8`：`disables delete for active jobs and explains why`（找不到 `job-active`）；
  - `3b487e58`：`retries a failed job from the detail modal`（找不到 `job-failed`）与 `promotes a delayed job from the detail modal`（找不到 `job-delayed`）。

  该路径本批完全未改（`git diff origin/main -- apps/web` 为空），main 基线 `bdbb581a` 的 run 40527760690 通过，两次 attempt 2 都在同一 head 通过。判定为 `queue-ops-content.test.tsx` 在负载下的既有计时抖动（`openJobDetail` 用 `findByRole` 等分页/切换后的行按钮），不是本批引入；没有删用例、降低断言或反复重跑。该抖动属独立问题，未在本批修复。
- 更早的 head `8e8a96a1` [run 40535159460](https://github.com/wei500L/newwei/actions/runs/40535159460) verify 失败，暴露的是本批新增测试自身的错误假设（非空根返回 500、operationName 未传、重复注册 root、指标标签来源、traceId 需经中间件）。已在 `896ad1e8` 修正为对真实契约的断言，未改动被测实现。

## 范围与所有权

| 缺口 | 入口与事实源（规划基线） | 本批实现 |
|---|---|---|
| GAP-HTTP-HEADERS-001 | Nest `apps/api/src/main.ts:107` 的 `helmet()`（helmet 7.2.0）；Go `cmd/api/main.go` 根 handler | `internal/httpx/security.go` 的 helmet 默认头 + 能力保留的 writer 包装；挂在根链最外层 |
| GAP-METRICS-WIRING-001 | `internal/metrics/families.go` 三类 API；Nest HTTP、ES、LiteLLM、pipeline provider 的真实调用点 | `internal/httpx/metricsmiddleware.go`（HTTP）、`internal/metrics/producers.go`（ES/vector/LiteLLM/pipeline 的定型入口）及其真实调用点 |
| GAP-EXCEPTION-WIRING-001 | Nest `common/filters/global-exception.filter.ts`；Go `cmd/api/legacy_fallback.go` 仅处理两类 404 | `internal/authhttp/exceptionhook.go`（REST 出口接缝）、`internal/graphqlread/exec/errors.go`（resolver 出口）、`cmd/api/exception_recording.go`（写既有 `exceptionevents`） |
| GAP-ITEMS-BODY-001 | `internal/itemsingest/handler.go` 的 1 MiB parser；Nest `main.ts:110-117` 的 10mb | `internal/itemsingest/handler.go` 的 `parseCreateBody` / `writeCreateBodyTooLarge` |

所有 `API_GO_*` 默认、compose、Web 地址、Socket.IO 路径和 NestJS 服务保持不变。Nest 未删除，迁移代理未改。

## 四项事实源 → 实际调用 → 测试

### A. 全局安全响应头（GAP-HTTP-HEADERS-001）

事实源：`apps/api/src/main.ts:107` 的 `app.use(helmet())`，无参数；版本由 `pnpm-lock.yaml` 固定为 helmet 7.2.0，默认值取自 `node_modules/helmet/index.mjs`。

实际调用：`cmd/api/main.go` 的根链改为

```
authhttp.IdentityScope(
  httpx.SecurityHeadersMiddleware(
    httpx.MetricsMiddleware(
      httpx.TraceMiddleware(gateway.ServeHTTPWithShadow))))
```

`httpx.SecurityHeadersMiddleware` 在响应提交前补齐缺失的头；已存在的头不覆盖，因此：

- 反代到 NestJS 的响应保留 Nest 自己的 helmet 值（`ReverseProxy` 在第一次 `WriteHeader` 前已写好头，填充逻辑看到非空即跳过）；
- 媒体预览的 `Content-Security-Policy: default-src 'none'; sandbox` 保留（比全局策略更严）。

逐项值（测试逐字节固定）：CSP（helmet 默认 11 条指令，`style-src` 含 `'unsafe-inline'`）、COOP `same-origin`、CORP `same-origin`、`Origin-Agent-Cluster: ?1`、`Referrer-Policy: no-referrer`、HSTS `max-age=15552000; includeSubDomains`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`X-Permitted-Cross-Domain-Policies: none`、`X-DNS-Prefetch-Control: off`、`X-Download-Options: noopen`、`X-XSS-Protection: 0`。`Cross-Origin-Embedder-Policy` 不设置：helmet 默认即关闭，NestJS 从不发送。

覆盖路径：业务成功/错误（`authhttp` 全部出口）、公开 live、`/metrics`、Swagger（`/docs` 与 `/docs/*`，含 404）、静态资源、reject 模式的 404、SSE、WebSocket upgrade。`X-Powered-By` 被删除，与 helmet 的 `hidePoweredBy` 一致。

Swagger 兼容性：页面的样式表与脚本全部是 `./docs/…` 相对路径，`script-src 'self'` 放行；内联 `<style>` 需要 `style-src 'unsafe-inline'`（helmet 默认已含）；文档由 `/docs/json` 同源获取，`connect-src` 不出现因而继承 `default-src 'self'`。没有为 docs 放宽任意来源或脚本。

流式与 upgrade：`httpx.Wrap` 按底层 writer 的真实能力选择返回类型，只把底层确实具备的 `Flush` / `Hijack` 暴露出去，并实现 `Unwrap` 让 `http.ResponseController`（`SetWriteDeadline` / `Flush` / `Hijack`）穿透。一个已知语义点：`ReverseProxy` 在升级路径上先 `Hijack` 再复制上游头，因此 `Hijack` 触发的 hook 把 `headersOwned` 置为 false，安全头跳过——否则被代理的 WebSocket 会与 Nest 的头重复。Go 自有的 upgrade（`coder/websocket` 先写 101 再 hijack）仍然拿到安全头。

测试：`internal/httpx/security_test.go`（值逐项、已存在值不被覆盖、成功/错误/空响应、SSE flush 保留）、`writer_test.go`（Flush/Hijack 能力不伪造、Go 自有 vs 代理的 upgrade 归属、`SetWriteDeadline` 穿透、hook 只跑一次）、`internal/apidocs/csp_test.go`（页面/资源/CSP 交叉验证、init 脚本用相对路径、docs 404 仍带头、媒体 CSP 覆盖）。

### B. 接通现有指标生产者（GAP-METRICS-WIRING-001）

| Nest 调用点 | Go 对等调用点 | 标签/单位 |
|---|---|---|
| `apps/api/src/main.ts:82-105` `recordHttpRequestMetric` | `cmd/api/main.go` 根链的 `httpx.MetricsMiddleware` → `metrics.RecordHTTPRequestMetric` | method 原样；route 为网关记录的有界路由族（`/api/<首段>`、`/graphql`…），未路由为 `unmatched`；statusCode 为实际写出的状态；`durationMs` 转秒，负值夹到 0 |
| `items-elasticsearch.service.ts:286,303` `items_search` | `itemsreading/elasticsearch.go` `Search` | `integration="elasticsearch"`, `operation="items_search"`, `status=success/failure` |
| `items-elasticsearch.service.ts:362,376` `items_literal_keyword_search` | `userdigest/elastic.go` `SearchLiteralKeywords` | 同上，`operation="items_literal_keyword_search"` |
| `items-search-query.service.ts:284` `items_vector_search` | `itemsreading/vector.go` `decodeCandidateResult` | `integration="vector"`, `operation="items_vector_search"`, `status="failure"`（Nest 只记这一种） |
| `litellm.service.ts:2372` 四处 `recordModelFallbackOrWarn` | `litellmcompat/client.go` `recordFallback` | `integration="litellm"`, `operation` 为 `completion_fallback` / `responses_fallback` / `rerank_fallback`；`status="fallback"`，仅当还有下一个模型时才记 |
| `pipeline-metric.provider.ts:155,189,219` 三处 `setPipelineMetric` | `alertworker/providers/pipeline.go` 三个分支 | `org_id` = 规则所属组织，`metric` = 规则 slug，值域/NaN 过滤沿用 `SetPipelineMetric` |

边界保持：空白查询、无客户端、无 embedder、过短查询等“根本没发起集成调用”的分支不计数（与 Nest 在 try 之前的 early return 一致）；LiteLLM 的最后一个模型失败只记日志不计数（与 Nest 的 exhausted 分支一致）；vector 的成功路径两边都不记。

`background_job_duration_seconds` 两侧都仍无生产调用，本批未动。

测试：`internal/metrics/producers_test.go`（标签集、状态值、NaN/Inf 过滤、租户隔离）、`internal/itemsreading/elasticsearch_metrics_test.go`（真实 `Search` 对 httptest 服务，成功/非 2xx/不可解析/跳过）、`vector_metrics_test.go`（真实 `RecallIDs` 的降级与 hard-fail、跳过路径不记）、`internal/litellmcompat/client_metrics_test.go`（completion/responses/rerank 各自 operation、成功后不记、耗尽不记）、`internal/alertworker/providers/pipeline_gauge_test.go`（用 stdlib driver 走真实 `Fetch`，断言 gauge 值与租户过滤）、`internal/httpx/metricsmiddleware_test.go`（一次请求一次观测、状态、有界标签、未路由回落、SSE 可观测）。

### C. 服务端异常事件（GAP-EXCEPTION-WIRING-001）

事实源：`apps/api/src/common/filters/global-exception.filter.ts` 的 `catch` / `handleHttpException` / `handleGraphqlException`，以及 `modules/observability/exception-events.service.ts` 的 `record`（`stack.slice(0, 8000)`、`timestamp` 归一化、best-effort `create().catch()`）。

| Nest 记录的类别 | Go 记录位置 | 说明 |
|---|---|---|
| HTTP 认证失败（401，含 revoked / membership 拒绝） | `authhttp.writeError`（经 `Authenticate`） | 事件在响应前构建；未认证成功时 orgId/userId 为空 |
| HTTP 权限失败（403 `INSUFFICIENT_PERMISSIONS`） | 同上 | 身份来自已验证的 `Identity` |
| HTTP 校验失败（400 ValidationPipe） | `itemsingest.writeValidationFailure` 调 `authhttp.RecordFailure`；其余走 `authhttp.WriteBadRequest` | 数组形态的响应由本路由自己写，事件里存 Nest 等价的 `"; "` 拼接文案 |
| HTTP 业务/内部错误（4xx/5xx、503 Prisma 类、body 溢出 500） | 同上 | `message` 与响应一致，5xx 已是 masked 文案 |
| GraphQL resolver/guard/限流错误（无论 HTTP 200 还是 4xx/5xx） | `graphqlread/exec.Engine.recordResolverError` → `Options.ErrorRecorder` | 覆盖 query 与 mutation 两条执行循环、prepare（限流/认证）与 `authorizeRoot`（权限）以及 resolver 返回的错误；`operation` = 根字段名，`operationName` = 客户端 operationName |
| GraphQL 协议拒绝（parse/validation/APQ/GET+mutation/complexity） | **不记录** | Nest 的这些错误不经过 global filter；Go 在 `PlanDocument` / `writeProtocol` 阶段直接回答 |
| reject 模式 404、docs 404 | 保持原有 `nestnotfound` recorder | 本批未改其所有权 |

事件写入既有 `exceptionevents` 集合（`exceptioningest.Service.RecordInternal`），复用进程已打开的 Mongo 连接（`dashboardMongo`，按需延迟打开）、既有集合名与文档形状、既有 best-effort 单次插入（无重试/队列/第二存储）。写入在线程内异步完成，`Context.WithoutCancel` + 5s 上限，退出前 `wait` 排空。

不重复记录：反代到 Nest 的响应由 Nest 自己的 filter 记录，Go 侧不产生事件；reject/docs 404 走各自既有 recorder。orgId/userId 只来自 `authhttp.SetVerifiedIdentity`（`Authenticate` / `Identify` / 机器令牌解析），不接受请求体或伪造 header。

不缓冲/反解响应：REST 事件在 `writeError` 写完契约字段后、真正写 socket 前构建；GraphQL 事件由执行器在错误产生处上报，不解析响应字节。

不改响应契约：所有响应字节、HTTP 状态、GraphQL `data/errors/extensions`、traceId、mask 与流式行为保持原样（测试断言 200+errors 仍是 200）。

显式保留的残留：
- 记录器目前只挂在 `authhttp` 出口、`itemsingest` 的 ValidationPipe 出口和 GraphQL 执行器上。个别 handler 自己 `http.Error(...)` 写 500（约 20 处，例如 `crawlprofile/handler.go:352`）不经过这些接缝，因此不产生事件。它们与 Nest 的对应异常同为“渲染期失败”，但覆盖不完整，记为残留。
- 本批不记录 `unknown` kind（Nest 在非 http/graphql host 上才会用到）。
- 没有 stack：Go 侧无异常对象，写点捕获的栈只会描述渲染函数。`errorName` 由状态映射为 Nest 的异常类名，500 映射为 `Error`。

测试：`internal/authhttp/exceptionhook_test.go`（六个 REST 出口逐个、identity 只认已验证链、未认证为空、`Authenticate` 发布身份、`errorName` 映射）、`internal/graphqlread/exec/errors_test.go`（200+errors 仍记录、权限 403、限流 429、mutation、协议拒绝不记、legacy 不记、nil recorder 安全）、`internal/graphqlread/handler_recorder_test.go`（真实 handler 的 200+errors、legacy 转发不记、parse 400 不记）。

### D. 条目创建请求体契约（GAP-ITEMS-BODY-001）

入口是 `POST /api/items`（Nest `items.controller.ts` 的 `@Controller("items")` + `@Post()`；Go `itemsingest.Path`），不是 `/api/items/ingest`。

事实源：`apps/api/src/main.ts:110-117` 的 `json({limit: "10mb"})`，body-parser 的 `bytes` 语义把 `mb` 当作 1024×1024，所以上限是精确保留 10485760 字节。

改动：`parseCreateBody` 先用 `http.MaxBytesReader(..., createBodyLimit)`（`10 << 20`）读完整个 body（与 raw-body 的“按收到字节判限”一致），再 `json.Unmarshal`。三种结果分开：

- ≤ 10 MiB 且合法：正常解析与字段校验（原先 >1 MiB 会以 400 `Invalid JSON body` 提前失败，现在不再）；
- > 10 MiB：`errCreateBodyTooLarge`，由 `writeCreateBodyTooLarge` 写 `authhttp.WritePayloadTooLarge` 的 Nest 溢出契约（非 HttpException → 生产 500 `Internal server error`，无 `error` 字段），不再是 `Invalid JSON body`；
- 畸形 JSON：仍是 400 `Invalid JSON body`；字段校验仍是 ValidationPipe 的 message 列表。

未改：`items.write` 权限、JWT/机器令牌、orgId 绑定、写入/入队副作用顺序（MySQL 事务 → 审计 → outbox 立即投递 → 读模型水合）、GraphQL 操作、全仓其他请求上限。

测试：`internal/itemsingest/handler_body_test.go`（64 KiB / 1 MiB−1 / 1 MiB+1 / 2 MiB / 恰好 10 MiB 全部通过；10 MiB+1 为溢出；畸形 JSON、`null`、字段校验各自契约；溢出响应逐字节为 500 masked 且不含 `Invalid JSON body`）。

## 纯静态反证审查

复核方式：逐项读改动路径的类型/GraphQL 契约、控制流与错误、租户与权限、SSE/WS 生命周期；每个疑点先尝试推翻。以下为成立项与处置。

1. **（已修）代理 WebSocket 的重复安全头**。`httputil.ReverseProxy.handleUpgradeResponse` 先 `rc.Hijack()` 再 `copyHeader(rw.Header(), res.Header)`。若在 `Hijack` 里触发安全头 hook，默认值会进入随后被上游覆盖的 header map，发出两套同名头。处置：hook 增加 `headersOwned` 参数，`Hijack` 传 false；安全中间件据此跳过。证据：`internal/httpx/writer.go` 的 `hijackOnlyWriter.Hijack` / `flushHijackWriter.Hijack`，`internal/httpx/security.go` 的 hook，测试 `writer_test.go` 的 `TestWrapHijackWithoutWriteHeaderReportsUnownedHeaders`。

2. **（已修）未命中路径的路由标签无界**。网关最初对所有请求都写 `RouteFamily(path)`，于是 `/wp-admin`、随机 token 等未命中路径各建一条 `http_request_duration_seconds` 序列，与 Nest 的 `unmatched` 语义不符。处置：新增 `matchRule` 区分“有规则命中”与“回退”，只有命中才写路由族，未命中保持 `unmatched`。`match` 签名与返回值不变，既有调用点与测试不受影响。已知差异（记录在 `ServeHTTPWithShadow` 注释）：`/api/` 前缀下 Nest 无控制器服务的路径，Nest 记 `unmatched` 而 Go 记 `/api/<首段>`——该族是既有 `api_go_legacy_proxy_requests_total` 的口径，保留它才能让同一路由在切流前后可比。证据：`internal/legacyproxy/proxy.go` 的 `matchRule` / `ServeHTTPWithShadow`，测试 `internal/legacyproxy/route_label_test.go`。

3. **（已修）hijack 连接写入耗时直方图**。Express 对交给 Socket.IO 适配器的连接不触发 `res` 的 `finish`，Nest 的直方图因此没有 upgrade 样本；最初实现在 socket 生命周期结束时记一条等于整段连接时长的观测，会污染延迟分位。处置：`Wrap` 改为返回 `Response{Writer, Done, Hijacked}`，指标中间件在 `Hijacked()` 为真时直接返回；安全头 hook 与 `headersOwned` 语义不变。证据：`internal/httpx/writer.go` 的 `hookWriter.hijacked` / `markHijacked`，`internal/httpx/metricsmiddleware.go`，测试 `TestMetricsMiddlewareSkipsHijackedConnections`。
4. **（成立，记为残留）部分 handler 自写 500 不产生异常事件**。`internal/crawlprofile/handler.go:352`、`internal/adminlogs/handler.go:391`、`internal/newsnowsources/handler.go:152`、`internal/llmlogs/handler.go:236`、`internal/newsindicator/handler.go:127`、`internal/newssourcescheduler/handler.go:184`、`internal/exceptioningest/handler.go:168`、`internal/qualityoverview/handler.go:214`、`internal/crawlstrategyruns/handler.go:227`、`internal/situationmonitors/handler.go:240`、`internal/crawlfrontierruns/handler.go:447`、`internal/crawltemplate/handler.go:227`、`internal/newsbackfilljobs/handler.go:145`、`internal/crawlworkflow/handler.go:399`、`internal/situationsignals/handler.go:357`、`internal/newssources/handler.go:482`、`internal/newsnowclusteringops/handler.go:513`、`internal/rbacapi/handler.go:423`、`internal/itemsingest/handler.go` 的 marshal 分支等仍用 `http.Error`。它们只在这些 handler 自己的 JSON 序列化失败（不可达的固定结构）时触发。不是本批引入，本批不改，列为残留。
5. **（成立，已确认安全）`MetricsMiddleware` 与 `SecurityHeadersMiddleware` 的嵌套顺序**。外层是 `SecurityHeadersMiddleware`，因此它在 trace 头之后、且在 metrics 的 hook 之外运行；两个 hook 各自独立触发，互不影响。`Wrap` 的 `applied` 标志是每个包装实例独立的，嵌套两层不会互相吞掉（`internal/httpx/writer.go` 的 `hookWriter.fire`）。
6. **（成立，已确认安全）`IdentityScope` 的 context 传递**。`handler.go` 里 `gateway.ServeHTTPWithShadow(w, r, disp)` 使用外层传入的 `r`；`IdentityScope` 用 `r.WithContext(...)` 生成新的 `r` 再交给 `next`，所以 `authhttp.Authenticate` 拿到的 `r` 已带 identity box。`AuthScope` 在 trace 之外、`SecurityHeaders` 之外，即使 trace 包装失败也不影响归属。
7. **（成立，已确认安全）租户边界**。指标 `pipeline_metric_value` 的 `org_id` 取自 `rule.OrgID`（数据库行），异常事件的 `orgId` 取自 `authhttp.SetVerifiedIdentity` 写入的已验证身份；两者都不来自请求。`itemsingest.authorize` 新增的 `SetVerifiedIdentity(r, identity)` 只在机器令牌解析成功后执行，且 `identity` 来自 token 行。
8. **（成立，已确认安全）SSE/WS 生命周期**。`dashboardstream` 断言 `http.Flusher`；`Wrap` 只在底层具备时才暴露，所以断言结论与不加包装时一致。`http.NewResponseController(w)` 在 `dashboardstream` 里对包装后的 writer 使用，靠 `Unwrap` 找到真实 writer；`writer_test.go` 的 `TestWrapUnwrapReachesTheRealWriter` 固定这一点。
9. **（成立，已确认安全）GraphQL 200+errors**。`Execute` 在 `nullData` 时 `statusFromErrors(errors, http.StatusOK)`，resolver 的 `contract.Failure{Status:500}` 会带 `extensions.http.status=500`，因此部分场景 HTTP 可能是 500 而非 200；但 `recordResolverError` 在 `errors` 收集处无条件调用，与最终状态无关，所以两种情形都记录。测试 `TestQueryResolverFailureIsRecordedWithA200Response` 固定 200 情形。
10. **（成立，已确认安全）不重复记录**。legacy 转发由 `exec.KindLegacy` 分支处理，不进入 `recordResolverError`（测试 `TestUnregisteredFieldRecordsNothing`）；反代响应完全不经过 `authhttp`。
11. **（成立，记为限制）`body-parser` 的 413 vs Go 的 500**。Nest 的 body-parser 抛 413，但 `RoutesResolver.mapExternalException` 只映射 `SyntaxError` / `URIError`，所以 413 作为非 HttpException 由 `GlobalExceptionFilter` 渲染成 500 masked。Go 侧复用 `authhttp.WritePayloadTooLarge`（已有注释与 smoke run 36270657639 证据），与该行为一致；本批未改为 413。
12. **（成立，已确认安全）`parseCreateBody` 的读法**。`http.MaxBytesReader(nil, ...)` 的第一个参数为 nil 时不会尝试 `requestTooLarge()` 标记，只返回 `*http.MaxBytesError`；`errors.As` 分支因此是唯一判定点。`defer limited.Close()` 关闭的是包装器，底层 body 由 net/http 负责。

类型/契约复核：新增的 `metrics` 定型入口只用字符串常量，无 `any` 业务载荷；`exec.ResolverError` 与 `authhttp.ExceptionRecorder` 均为具名结构/函数类型；`exceptioningest.ExceptionEvent` 复用既有强类型；`WriteJSON` 未改。GraphQL `data/errors/extensions` 未改（`response.go` 未动）。

## 未覆盖项与残留

- **未部署、未承接真实流量、未连接真实外部服务**。ES/vector/LiteLLM/pipeline 指标与异常写入只用进程内 httptest / fake driver 验证生产调用路径，不代表真实集群、真实模型或真实 Mongo 已通。
- 自写 500 的 handler（见审查第 4 条）不产生异常事件。
- 未记录 `unknown` kind；无 stack。
- `Cross-Origin-Embedder-Policy` 有意不发送（与 Nest 一致）。
- `/docs` 的 `connect-src` 未显式声明，依赖 `default-src 'self'`；若将来页面改用绝对 API 地址，需同步评估。
- 本批仍保留的依赖：NestJS 全部路由与执行器、Prisma/seed/index 工具、BullMQ 消费者与 cron（除已迁部分）、Socket.IO 默认传输、Legacy 代理与四态路由表。
- 明确未做：不改任何 `API_GO_*` 默认、不改 compose/Web/vector/AIS 默认、不删 Nest、不收紧全局设置产品权限、不移植 Bull Board、不改 AIS 算法、不重写 Prisma、不新增专用 workflow。

## 交付与下一步

- 四项均已有真实生产调用路径 + 行为测试 + 静态反证。四个 GAP 在合入 main 前**不关闭**；本 PR 合入后需按实际 merge SHA 复核后再关。
- 下一批（[GO-DEFAULT-CUTOVER-001](GO-DEFAULT-CUTOVER-001.md)）的精确前置：
  1. 本 PR 合入 main，并在该 merge SHA 上有普通 CI 三主要 job success；
  2. 复核 `httpx.SecurityHeadersMiddleware` 在最终 main 的根链位置未被其他并行改动覆盖；
  3. 复核 `authhttp.SetExceptionRecorder` 与 `graphqlread.Options.ErrorRecorder` 的装配点在最终 main 仍存在；
  4. 若要关闭 GAP-EXCEPTION-WIRING-001，需先决定第 4 条残留（自写 500）是否纳入下一批。
- 本机未安装依赖、未运行 build/test/pnpm/Docker/服务；验证由既有普通 CI（`.github/workflows/ci.yml` 的 verify / vector-integration / api-go-user-settings-integration）执行。本批未新增 workflow。
