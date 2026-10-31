# 任务提示词：Go 切默认前的安全头、可观测性与条目请求体契约

你在 `wei500L/newwei` 仓库执行 **GO-CUTOVER-PREREQS-001**。目标是补齐 #148 整合报告确认的四项真实缺口，让下一批可以把仓库默认后端改为 Go。本批保持默认运行链与所有迁移开关不变；只做源码、静态审查与普通 GitHub Actions CI，不部署、不连接真实外部服务。

规划记录发布于 Ready PR **#149**（`codex/plan-go-cutover-next`）。如果该规划尚未合入 main，先从 PR #149 只读取得本任务和最新阶段说明；业务分支仍从最新 main 创建，可带入本任务 `.md` 供交付回填，不要求合并整个规划分支，也不因 main 暂缺任务文件而重复派发或停工。

## 1. 先恢复当前事实

先读 `AGENTS.md`、`docs/refactor/migration-map/{README,PLANNING,GAPS}.md`、`tasks/README.md` 与本任务 `.md`；再读 #148 PR 描述 §7、五份 `docs/refactor/review/*.md` 的整合更正与删 Nest 前事项。历史报告里被划掉的“未迁”结论不能重新作为缺口。

执行 `git fetch origin main`，读取最新 `origin/main`、开放 PR、main 最近普通 CI 与 `git worktree list`。规划基线 `f15f598d4358b4c9823054ef5a355618e1480a4e` 已包含 #148（实际 merge `0a48babea69700c7f9cd1bf2262f25d414469527`）、两次 runner smoke 提交和一次既有 workflow 转自托管 runner 的提交。#142–#147 已合并，不要再次整合这六批。

交付复核（2026-10-27 17:21 MSK）时 main 普通 CI run 40518886959 已 **cancelled**，verify failure、vector-integration success、api-go-user-settings-integration cancelled，根因尚未证实；先读取精确 head/job 的失败原因，区分环境问题、既有问题与本批改动，不宣称基线全绿。前一 head `cc3782c0` 的普通 CI run 40518448341 亦 cancelled，额外 Self-hosted Smoke success 不代替普通 CI。#148 整合 head `79220a47` 的 run 40513400923 attempt 2 三个主要 job success，只证明那个 head。已知 `realtimesocket` 关停测试曾在 attempt 1 命中基线竞态，不得通过删用例、降低断言或无限重跑掩盖失败；不能未经日志核实就认定本次也属该竞态或 runner 变更。沿用现有普通 CI，不顺手修改 runner/调度配置。

从最新 main 创建/复用本任务独立 worktree，分支 `codex/go-cutover-prereqs`。若已有对应 PR/认领，继续已有任务；与其他窗口共享文件冲突时先核对范围。忽略无关工作区噪声，不碰其他会话的改动。

## 2. 四项必须完整交付

### A. 全局安全响应头（GAP-HTTP-HEADERS-001）

事实源是 Nest `apps/api/src/main.ts` 的 `app.use(helmet())`、lockfile 对应 helmet 版本/已存在依赖源码，以及 Go `cmd/api/main.go` 根 handler、`internal/cors`、`internal/apidocs`、媒体响应头。

补齐 Go 直接响应失去的既有安全头，逐项核对 CSP、COOP、CORP、Origin-Agent-Cluster、Referrer-Policy、HSTS、X-Content-Type-Options、X-Frame-Options、X-Permitted-Cross-Domain-Policies、X-DNS-Prefetch-Control、X-Download-Options、X-XSS-Protection 的实际值和适用路径。不要凭记忆把所有策略写成同一个模板，也不要假设反代会补头。

覆盖业务成功/错误、公开 live、metrics、Swagger、静态资源与 reject 404；保留 CORS、trace、媒体局部 CSP 和允许的嵌入/下载语义。Swagger 的现有 HTML 含 inline style，bootstrap JS 与资源使用自身路径，必须让 CSP 与其实际加载方式兼容；不能为修 docs 全站开放任意来源或脚本。保留 legacy/shadow 路由的代理行为，避免 Go 与 Nest 头部互相冲突。

### B. 接通现有指标生产者（GAP-METRICS-WIRING-001）

Go `internal/metrics/families.go` 已有 `RecordHTTPRequestMetric`、`RecordIntegrationEvent`、`SetPipelineMetric`，当前非测试代码没有调用。**不能只接 HTTP 耗时就宣称本项完成**。

按 Nest 实际调用点建立对应表并接上 Go 对等路径：

- HTTP：`apps/api/src/main.ts` 的 `recordHttpRequestMetric` → Go 最外层请求处理；核对 method、route、statusCode、duration 单位与低基数路由标签，不能把 query、ID、token、原始 URL 当新标签。
- 集成事件：`modules/items/items-{elasticsearch,search-query}.service.ts` 与 `modules/news-pipeline/litellm.service.ts` → Go 对等 ES 查询/索引与模型调用。保留 integration/operation/status 的原有含义、成功/失败与重试计数边界，不凭空给所有外部服务新造一套标签。
- Pipeline gauge：`modules/alerts/providers/pipeline-metric.provider.ts` 三处 `setPipelineMetric` → Go 实际求值路径；保留 `org_id`、metric、有限数过滤，不改变取值查询或跨租户范围。

HTTP writer 包装必须保留底层真实支持的流式与连接能力，包括 Flusher、Hijacker、ResponseController/Unwrap 与写 deadline 等实际调用链；不能伪造不支持的能力、缓存整段响应、吞 status、破坏 WebSocket 101 或改变 SSE flush。核对显式/隐式状态、错误和客户端断开，完成语义保持与 Nest 可比。已有 metrics 读取权限保持不变。

`background_job_duration_seconds` 在两侧都缺少实际生产调用，不属于本批丢失能力；不要把全 worker 埋点或新监控框架混进来。

### C. 服务端异常事件（GAP-EXCEPTION-WIRING-001）

对照 Nest `common/filters/global-exception.filter.ts`、`modules/observability` 的记录/归一化逻辑，复用 Go `internal/exceptioningest.Service`、现有共享 Mongo 与 `exceptionevents` 集合。当前 `cmd/api/legacy_fallback.go` 的记录器仅覆盖 reject/docs 404，不等于覆盖 REST/GraphQL 异常。

把 Go 自有 REST 的认证/权限/校验/业务/内部错误及 GraphQL resolver/执行错误接到适当的现有错误出口；逐类说明 Nest 真正记录什么、Go 对应位置在哪里。GraphQL 的 HTTP 200 也可能含执行错误，仅按 HTTP >=400 或 panic 无法完成本项。解析/校验/限流等协议错误应先核对 Nest 的真实记录边界，不能把所有协议失败武断当成 resolver 异常。

保留原响应字节契约、HTTP 状态、GraphQL `data/errors/extensions`、traceId、错误 mask 与 streaming 行为；不得为取错误消息缓冲/反解所有响应。事件 kind、statusCode、path/method、operation/operationName、message/errorName/stack 按事实源填写；orgId/userId 来自服务端已验证身份，不接受请求 body 或伪造 header。内部 stack 不得泄漏给客户端或新增日志中的敏感数据。

记录失败保持既有 best effort，不改业务结果，不引入队列/重试/第二套存储。复用连接与既有有界生命周期，不在每个错误中新建 Mongo client；同一异常、现有 docs/reject 404 不重复记录。legacy/shadow 的 Nest 应答要有明确的记录所有权，避免双写。允许按需给 `authhttp` 等现有错误出口增加轻量接缝，但不重写全仓 handler。

### D. 条目创建请求体契约（GAP-ITEMS-BODY-001）

**先纠正报告中的定位：真实 REST 入口是 `POST /api/items`，不是 `/api/items/ingest`。** Nest `modules/items/items.controller.ts` 的 `@Controller("items")` + `@Post()`；Go `internal/itemsingest/handler.go` 的 `Path="/api/items"`、`parseCreateBody` 使用 `MaxBytesReader(..., 1<<20)`。当前解析失败经 `writeValidationFailure` 写 **400**，不能沿用报告中“当前必然 413”的说法。

按 Nest 10mb（10 × 1024 × 1024 字节）JSON parser 的实际边界调整此路由：合法的 >1MiB、<=10MiB 创建体不能提前失败；超过 10MiB 按真实 Nest 溢出状态/错误格式处理，不能统一吞成 Invalid JSON；畸形 JSON 与字段校验保持各自契约。保留 `items.write`、JWT/机器令牌与 orgId 绑定、写入/入队副作用顺序；不改 GraphQL 操作或全仓所有请求上限。

## 3. 边界、测试与审查

- 主要改 `apps/api-go/internal/{httpx,metrics,exceptioningest,graphqlread,apidocs,itemsingest}`、必要的 `authhttp`/ES/模型/告警 provider 与 `cmd/api` 最小装配。共享 main 保留其他模块并集，不覆盖整段注册。
- 不改任何 `API_GO_*` 默认、不改 compose/Web/vector/AIS 默认、不删 Nest 或迁移代理，不收紧全局设置产品权限，不移植 Bull Board，不修 AIS 算法或重写 Prisma。明确标出本批仍保留的依赖。
- Go 业务 DTO/事件/数据库 JSON 用具名类型；不新增 `any/interface{}/map[string]any/[]any` 业务载荷，扩展叶子可用 `json.RawMessage`；通用 GraphQL/驱动边界沿用现有设计。
- 新增/修改源码注释用英文，新增文件写准确职责说明与导出 GoDoc；中文文档/提交/PR。保留必要鉴权、校验、事务，避免假设性锁/重试/兼容框架。
- 写必要行为测试：真实 handler 链的安全头、Swagger 资源/CSP、HTTP 状态与 metrics 输出、真实 SSE flush/upgrade 能力；ES/模型成功失败与 gauge 的生产路径；REST/GraphQL 事件（含 200+errors）、去重与记录失败；>1MiB、10MiB 边界和溢出。可以用现有可注入依赖/内存 HTTP 测试服务；不能只直接调用记录 API 或做源码文本测试，也不新建 API Jest/e2e 体系。
- 本机只静态阅读、diff、必要 gofmt；不装包，不运行 build/test/pnpm/Docker/服务，不触发任何真实外部调用。验证由既有普通 CI 执行，含仓库 lint/typecheck/Web coverage/vector 与 Go 检查，不新增专用 workflow。若已有 CI 未覆盖关键新测试，只对现有流程做必要最小补充，不能删弱化旧检查。
- 完成后做纯静态反证审查：逐项核类型/GraphQL 契约、控制流/错误、租户权限、SSE/WS 生命周期；每个成立问题附当前 `file:line`，先尝试推翻。不要复制旧报告当成本批审查。

## 4. 交付

只 stage 自己的文件；中文 emoji + `type(scope)` 提交并正常 push，创建 **Ready PR**，不合并、不 auto-merge、不 amend/rebase/force-push。

更新本任务 `.md` 的状态与 PR/head/普通 CI，PR 里给四项事实源→实际调用→测试的对应表、纯静态审查结论、未覆盖项。共享地图由规划窗口统一回填，不重复改全域统计。未合入 main 不能关闭四个 GAP；给下一批精确前置与残留项，不能只写“已可切流”。

最终报告精确 head、普通 CI run 与逐 job 结果（skipped 不算通过），如实保留“未部署、未承接真实流量、未连接真实外部服务”的边界。
