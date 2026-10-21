# 后端执行权审计（切流准备批 · T1）

> 审计基线：`origin/main = dcbe563b917fde0927637121a91de2186d6177a4`（#136，整合 #133–#135）。
> 计数更新：本文件的 HTTP/C 类计数已由 `refactor/go-crawl-frontier-writes` 在 `origin/main = ed436ead` 之上更新（C-2/C-3/C-4 迁入 api-go，HTTP A 365→368、C 5→2；开关总数 130→131）。除该批新增的 `API_GO_CRAWL_FRONTIER_WRITES_MODE` 与对应 Go handler 外，文中 `path:line` 仍以 `dcbe563b` 为准。
> 审计窗口：2026-10-21。分支 `docs/go-cutover-readiness`，worktree `/Users/oo/project/newwei-go-cutover-readiness`。
> 方法：只做静态阅读（`rg`/`grep`/`sed`/`git show`），**未启动任何服务，未运行 `go build`/`go test`/`pnpm`/Docker/队列**，也没有在部署环境执行任何操作。文中 `path:line` 均以 `dcbe563b` 为准；`legacyproxy/proxy.go` 的行号已按基线校正（本批在该文件新增了 legacy 计数，工作区行号会偏移，合并后需平移，见 §1.3）。
> 本文件的四个部分分别由独立审计产出后合并：HTTP（§2）、GraphQL/Socket.IO（§3–§4）、异步（§5）、其它入口（§6）。合并只做章节层级调整，不改写结论。

---

## 0. 结论摘要

### 0.1 三类计数（注册 / 接线口径，不是部署启用）

| 职责面 | 分母 | A（Go 可完全接管，有开关） | B（仅 Nest 兼容桥，可停用） | C（仍只能由 Nest 提供） |
|---|---:|---:|---:|---:|
| HTTP 路由（METHOD+完整路径去重，SSE 算一条） | 370 | **370** | 0 | **0**（C-1…C-5 全部关闭：C-1/C-5 由 `refactor/go-ops-entrypoints`，C-2…C-4 由 `refactor/go-crawl-frontier-writes`） |
| GraphQL 根字段 | 138（Query 77 / Mutation 57 / Subscription 4） | **138**（77 / 57 / 4） | 0 | 0 |
| Socket.IO namespace | 6 | **6** | 0（transport 层） | 0 |
| BullMQ 队列 | 15 个队列名 = 14 个有消费者 + 1 个 DLQ | **14**（11 个 `*_WORKER_MODE` 开关） | 0 | 1（`itemPipelineDlq` 无消费者） |
| `@Cron`/`@Interval` 回调 | 21 | **21** | 0 | 0 |
| 非装饰器调度 / 启动任务 | 10 | 7 | 1（告警 scan repeat 的幂等注册） | 2 |
| Redis pub/sub 频道（Nest 实际订阅） | 12 + 1 名义 | 0 | **12**（兼容桥 / 共享总线） | 1（`gqlsub:queueEvents` 名义频道） |
| 其它入口 | — | `/api/healthz`、`/api/metrics`、`/api/healthz/live`、`/docs`、根路径/404 语义 | — | `/admin/queues`（C-8，属队列运维窗口） |

要点：
1. **GraphQL 与 Socket.IO 已全量注册**：138/138 根字段都有 Go 注册点并受开关控制；6/6 namespace 由两条独立 Engine.IO path（`/socket.io-notifications`、`/socket.io-realtime`）承接。
2. **HTTP 域已无 C 类**：C-1（`/api/healthz/live`）与 C-5（向量诊断）由 `refactor/go-ops-entrypoints` 关闭，C-2/C-3/C-4 三条 crawl-frontier 管理写由 `refactor/go-crawl-frontier-writes` 迁入 Go 并关闭分类；C-7（`/docs`）与 C-9（根路径/404）不在 370 分母内，也已由前者关闭。
3. **异步侧只剩结构性缺口**：所有有消费者的队列、全部定时回调都有 Go 实现与开关；未迁移的是 DLQ 的**人工消费入口**（Nest Bull Board）与少数 Nest 进程内派生的读侧职责。
4. **「停掉 Nest」的阻塞面已缩小**：C-1/C-5/C-7/C-9 关闭后，仍只剩 3 条 crawl-frontier 写 HTTP（并行窗口）与 `/admin/queues`（队列运维窗口）。阶段 6 因此拆成「停业务流量（可执行）」与「完全停 Nest（待剩余 C 关闭）」，详见 [runbook](runbook.md)。

### 0.2 C 类清单（C-2/C-3/C-4 已关闭；其余仍需用户决定，详细选项见各节）

| 编号 | 项目 | 为什么是 C | 可执行选项（摘要） | 详细 |
|---|---|---|---|---|
| C-1 | `GET /api/healthz/live` | 规则固定 `ModeShadow`（baseline `proxy.go:135`），无开关；Go handler 已实现但不会被调用（`main.go:2130`） | **已关闭：`refactor/go-ops-entrypoints`** 新增 `API_GO_HEALTHZ_LIVE_MODE`（`shadow` 默认 / `legacy` / `go`）＋ `WithHealthzLive` exact GET 规则；go 时由 Go 响应，回退改回 shadow | §2 的「C 类与缺口」、§6 的 4 |
| C-2 | `POST /api/admin/crawl-frontier/runs` | **已在 refactor/go-crawl-frontier-writes 关闭**：新增 `WithCrawlFrontierWrites`（`legacyproxy/crawl_frontier_writes_routes.go`）的 exact POST 规则 + `crawl.write` 校验 + `API_GO_CRAWL_FRONTIER_WRITES_MODE`；创建 run 复用未导出的 `internal/crawlfrontierllm.createRunFromProfile`（`learn.go:774`，本批经 `export_frontier_writes.go` 最小导出）。原缺口是 `WithCrawlFrontierRuns` 只注册 GET 与 `/runs/cancel`（`legacyproxy/crawl_frontier_runs_routes.go`）；注：`internal/crawlfrontierruns` 的 `Service.CreateRun`（`strategy_run_write.go:151`）写的是 strategy-run，不是 Frontier run | —（分类已关闭，无需决策） | §2 的「C 类与缺口」 |
| C-3 | `POST /api/admin/crawl-frontier/nodes/retry` | **已在 refactor/go-crawl-frontier-writes 关闭**：新增 `WithCrawlFrontierWrites` 的 exact POST 规则与 handler（`apps/api-go/internal/crawlfrontierruns/handler_write.go`），沿用 `crawl.write` 权限 | —（分类已关闭，无需决策） | §2 的「C 类与缺口」 |
| C-4 | `POST /api/admin/crawl-frontier/nodes/:id/retry` | **已在 refactor/go-crawl-frontier-writes 关闭**：新增带动态段的 exact POST 规则与 handler（`apps/api-go/internal/crawlfrontierruns/handler_write.go`），沿用 `crawl.write` 权限 | —（分类已关闭，无需决策） | §2 的「C 类与缺口」 |
| C-5 | `GET /api/system-settings/vector-service/diagnostics` | 语义上报告 **Nest 进程内** vector client 计数器（baseline `infrastructuresettings/doc.go:52-54`） | **已关闭：`refactor/go-ops-entrypoints`** 新增 `API_GO_VECTOR_DIAGNOSTICS_MODE`（默认 `legacy`），Go 侧重建进程级共享 vector 健康状态并输出同样的 17 字段；报告的是处理该请求的 api-go 进程状态（多实例可能不同） | §2 的「C 类与缺口」 |
| C-6 | `itemPipelineDlq` 消费 | 两侧都只生产、无 `new Worker`；唯一处理入口是 Nest Bull Board | ① 用 Go 的 queue ops/CLI 提供重放（新功能）；② 保留最小 Node Bull Board；③ 接受人工 Redis 处理 | §5 的队列表、§6 的 Bull Board |
| C-7 | `GET /docs`（Swagger UI/JSON） | 只有 Nest 提供，Go 只按前缀代理（baseline `proxy.go:146`） | **已关闭：`refactor/go-ops-entrypoints`** 新增 `API_GO_DOCS_MODE`（默认 `legacy`）；go 时 api-go 从内嵌的 `openapi.snapshot.json` 与 swagger-ui-dist 5.29.4 资源提供 `/docs`、`/docs/json` 与静态资源，仍受 `SWAGGER_ENABLED` 控制 | §6 的 1 |
| C-8 | `/admin/queues`（Bull Board） | 只有 Nest 提供（`proxy.go:147`），且默认 `BULL_BOARD_ENABLED=false` 时本来就是 404 | ① 独立 Bull Board 进程（连同一 Redis）；② 队列运维改 CLI/Redis 工具，面板下线；③ Nest 边车 | §6 的 2 |
| C-9 | 根路径与未匹配 404 | Go 无 catch-all，未命中规则一律代理 Nest；停 Nest 后变 502（baseline `proxy.go:814-830/560-561`） | **已关闭：`refactor/go-ops-entrypoints`** 新增 `API_GO_LEGACY_FALLBACK_MODE`（`proxy` 默认 / `reject`）；reject 时所有原本走 `proxyLegacy` 的请求由 Go 返回 Nest 等价 404 并计入 `api_go_legacy_rejected_requests_total`，启动校验要求其余开关全为 go | §6 的 8 |

另有 3 项「Nest 进程内派生、无 Go 开关」的读侧职责（QueueEvents 派生的 org stats / GraphQL `queueEvents` / ops 广播 / alerts 指标 provider、告警规则全量 repeatable 对账、News-source RSS seed 的一次性 TTL 迁移），已在 §5 的 Cron/订阅小节逐条列出，停 Nest 前需要逐一确认替代或保留。

### 0.3 至今仍然只有 Nest 能承担的项目（汇总）

- Bull Board（`/admin/queues`）与其对 `itemPipelineDlq` 的人工处理能力（C-6/C-8，队列运维窗口）。
- ~~交互式 Swagger（`/docs`、`/docs/json`）~~、~~公开存活探针 `/api/healthz/live`~~、~~Nest 进程内计数器的诊断接口~~、~~根路径/未知路径的 Nest 404 语义~~：已由 `refactor/go-ops-entrypoints` 关闭（C-1/C-5/C-7/C-9）。
- ~~三条 crawl-frontier 管理写（创建 run、节点批量重试、单节点重试）~~：已由 `refactor/go-crawl-frontier-writes` 关闭（C-2/C-3/C-4），不再阻塞停 Nest。

> 这与「NestJS 的全部业务功能都已经有 Go 实现」的规划前提存在差异：业务执行面确实已全部有 Go 实现，但**运维/诊断面**（Swagger、Bull Board、DLQ 处理、进程内计数器）仍在 Nest；crawl-frontier 的三条管理写（C-2/C-3/C-4）已在本批迁入 Go。本批审计本身没有新增业务迁移，只如实记录；C-2/C-3/C-4 的关闭状态由迁移批次回填。

---

## 1. 审计方法与证据口径

### 1.1 枚举命令（可复现）

```bash
# HTTP：Controller 与路由装饰器
grep -rl '@Controller' apps/api/src --include=*.ts | wc -l          # 71
grep -rhoE '@(Get|Post|Put|Patch|Delete|Sse)\(' apps/api/src --include=*.ts | sort | uniq -c
# GraphQL 根字段（权威 SDL，不是装饰器计数）
grep -n 'type Query\|type Mutation\|type Subscription' apps/api/schema.gql
grep -rhoE '@(Query|Mutation|Subscription)\(\(\)' apps/api/src --include=*.ts | sort | uniq -c
# Socket.IO 网关
grep -rl '@WebSocketGateway' apps/api/src --include=*.ts | wc -l     # 6
# BullMQ 消费者 / Cron / 订阅
grep -rn 'new Worker' apps/api/src --include=*.ts | wc -l            # 11 个构造点
grep -rn '@Cron(\|@Interval(\|@Timeout(' apps/api/src --include=*.ts | wc -l
grep -rn '\.subscribe(\|\.psubscribe(' apps/api/src --include=*.ts
# Go 开关与接线
grep -o 'getenv("API_GO_[A-Z0-9_]*")' apps/api-go/internal/config/config.go | sort -u | wc -l  # 131（本批新增 1 个）
grep -oE 'legacyproxy\.With[A-Za-z]+' apps/api-go/cmd/api/main.go | sort -u | wc -l            # 78 builders（本批新增 WithCrawlFrontierWrites）
```

### 1.2 分类定义

- **A**：Go 可完全接管，存在 `API_GO_*` 开关；go 模式下 Nest 有明确行为（返回 / 不创建 Worker / 不订阅 / 不注册根），并且 `legacyproxy` 规则与 `RegisterGoHandler` 接线在源码层对齐。
- **B**：Nest 侧只是兼容桥（Redis pub/sub 中继、共享总线），对应执行面迁走后可停用；桥本身不是业务执行者。
- **C**：仍然只能由 Nest 提供：未迁移路由、仅 Nest 进程能提供的诊断/UI、或 Go 侧缺规则/开关。C 类必须给出用户可决策的处理选项。

### 1.3 统计口径与限制

- **注册覆盖 ≠ 部署启用**：A 只表示「开关可以把它切到 Go 且接线就位」，不代表已经在任何环境启用；`apps/web` 默认仍指向 NestJS，canary 关闭，`api-go` 仍在 compose 的 `api-go-pilot` profile。
- **HTTP 分母**：`@Controller` 路由去重，SSE 按 GET 算一条；`/docs`、`/admin/queues`、根路径/404 不在 370 内，单列于 §6。
- **GraphQL 分母**：以 `apps/api/schema.gql` 的根类型字段为准（77/57/4），`@Query` 装饰器计数会被 REST 参数装饰器 `@Query()` 污染（全仓 236 个，其中 159 个是 REST），不能直接用。
- **队列分母**：按队列名去重（15 = 14 有消费者 + 1 DLQ），不按 `new Worker` 构造点（11 个，crawl.processor 的两个工厂各建多实例）。
- **行号口径**：本批在 `legacyproxy/proxy.go` 与 `internal/metrics/families.go` 增加了 legacy 回落计数（T5.6），工作区中该文件行号相对 `dcbe563b` 会偏移（导入区 +1，`proxyLegacy` 之后约 +33）。合并后阅读本文档里的 `proxy.go` 行号需要按新提交平移；规则语义未变。本批新增的 `API_GO_CRAWL_FRONTIER_WRITES_MODE` 与 `internal/crawlfrontierruns/`、`internal/crawlfrontierllm/` 写路径行号以代码合并后为准，本文只引用路径。
- 未核实项统一列在各节末尾，并在 §7 汇总；不得把静态结论当作运行验证。

---

## 2. HTTP 路由执行权（T1.1）

<!-- 合并自 T1.1 HTTP 路由审计（task-1 产出）；原文，仅调整标题层级。其它入口见 §6。 -->


> 基线：`dcbe563b917fde0927637121a91de2186d6177a4`（分支 `docs/go-cutover-readiness`，worktree `/Users/oo/project/newwei-go-cutover-readiness`）。本文件由 task-1（T1.1）静态审计生成，所有行号均以 HEAD 基线 `dcbe563b` 为准（校正说明见下），未运行任何服务、未执行 `go build/test`、`pnpm` 或 `docker`。

> 行号口径：所有 `file:line` 以 HEAD `dcbe563b` 为准。本批 T5.6 在同一 PR 给 `apps/api-go/internal/legacyproxy/proxy.go` 增加了 legacy 回落计数、`internal/metrics/families.go` 增加了对应指标，它不改变规则/匹配语义；本文 `proxy.go` 行号按基线记录，合并后需按新 HEAD 平移（导入区 +1，`proxyLegacy` 之后约 +33）。

### 0. 总览

- 枚举范围：`apps/api/src` 下全部 `@Controller` 文件（71 个），路由装饰器共 370 个：GET 170 + SSE 1（Nest `@Sse` 按 GET 注册，SSE 算一条）+ POST 120 + PUT 37 + PATCH 14 + DELETE 28。
- 去重口径：**METHOD + 完整路径**（全局前缀 `/api` 已拼入；`@Controller("prefix")` 与 `@Get("sub")` 用 `/` 连接，`@Get("")` 即控制器前缀本身；动态段保留 Nest 的 `:param` 写法）。去重后 **370 条唯一路由，0 条同 METHOD+路径冲突**。
- Nest 侧读取的 A 类开关只有 `API_GO_NEWSNOW_SOURCES_MODE`（`apps/api/src/modules/config/config.service.ts:534-539` → `newsnow-source-refresh.subscriber.ts:48`）与 `API_GO_NEWS_SOURCE_OPS_MODE`（`news-source-notification.subscriber.ts:142`）；其余 A 类开关在 `apps/api/src` 无读取分支（部分只在 `env.schema.ts` 声明），详见各表“go 模式下 Nest 行为”列。
- 分类：**A = 368**（Go 可完全接管且存在 `API_GO_*` 开关，本表按开关=go 的规则表判定）；**B = 0**（HTTP 层没有“仅兼容桥”的路由；Nest 侧兼容桥只在异步/实时职责出现，见 T1.5/T1.3）；**C = 2**（只能由 Nest 提供或 Go 规则缺失：C-1 `/api/healthz/live`、C-5 vector diagnostics。原 C-2/C-3/C-4 已由 `refactor/go-crawl-frontier-writes` 迁入 Go）。
- 方法分布（去重后）：GET 171（含 SSE 1）、POST 120、PUT 37、PATCH 14、DELETE 28；A 类 368 条、C 类 2 条。
- A 类清单同步写入 `apps/api-go/internal/legacyproxy/testdata/nest-routes.txt`（368 条路由 + 9 行 `#` 头注释，共 377 行；与该表 A 行一一对应，作为 T2 测试数据提交）。
- 计数边界：370 条只统计 `@Controller` 路由；`/docs`、`/admin/queues`、根路径/404 等非 Controller 入口在 T1.7（§6）单列，不计入本表；其中 `/api/healthz/live` 属 Controller 路由，已计入本表 C 类（本批更新后为 2 条）。
- 涉及开关 **78 个**（78 个都有源码默认值；其中 `API_GO_USER_SETTINGS_READ_MODE` 默认空=兼容，其余 A 类开关默认 legacy；本批新增 `API_GO_CRAWL_FRONTIER_WRITES_MODE`）。另有兼容路径开关 `API_GO_ONBOARDING_MODE`（默认 shadow，`config.go:3393`），只在读模式为空时决定 onboarding 这条 GET，不计入 78 个。全文开关默认值与 `config.go` 行号逐条对应。

#### 如何枚举与去重

1. 先读 `apps/api/src/main.ts` 与 `app.module.ts`：`setGlobalPrefix("api", { exclude: [{path:"admin/queues"}] })`（`main.ts:62-67`）；`@Controller` 全部经模块 `controllers` 数组装配（`app.module.ts:62-117`）。
2. 用 `grep "@Controller("` 得到 71 个文件；再逐文件提取 `@Get/@Post/@Put/@Patch/@Delete/@Sse` 装饰器的路径参数，与控制器前缀拼接；对 `@Sse` 按 GET 计（Nest 语义），最后按 METHOD+完整路径去重（本次为 370 条、无重复）。
3. 对每条路由在 `apps/api-go/internal/legacyproxy/*.go` 找 `WithXxx` builder 生成的 `Rule`（`Exact`/`OneSegment`/`TwoSegments`/`Tail`/`TailSegment`/`TailSuffix`/`Methods`），按 `main.go` 的规则装配顺序和 `proxy.go:814-885` 的匹配语义判定命中；再核对 `main.go:848-1041` 的 builder 调用、`config.go` 的开关默认值，以及 `cmd/api/*.go` 的 `RegisterGoHandler` 接线。
4. 影子/兼容判定：`DefaultRulesWithWrite`（`proxy.go:134-148`）固定 `/api/healthz/live` 为 shadow；只有 `WithXxx` 在对应开关=go 时被调用的规则才算 A。
5. 全量规则语义：`Exact` 要求路径完全相等；`OneSegment`/`TwoSegments` 要求前缀后恰好 1/2 个非空段；`Tail` 是动态段后的固定后缀；`TailSegment` 为「动态段/固定段/动态段」；`Methods` 空=任意方法；Go 规则通常额外白名单 `OPTIONS` 供 CORS 预检（本表在证据列标注规则的方法集合，不单列 OPTIONS 行）。

#### Controller 装配核对（回答“哪些 Controller 真的被装配”）

- `app.module.ts` 直接导入 42 个模块类（含 `ScheduleModule`/`QueueAdminModule` 两个条件 spread）；`apps/api/src` 共 47 个 `*.module.ts`，从 `AppModule` 全部可达；71 个 controller 文件全部出现在某个模块的 `controllers` 数组，无重复注册、无未装配 controller。
- 唯一的条件装配：`QueueAdminModule`（Bull Board，**没有 `@Controller`**）仅在 `BULL_BOARD_ENABLED === "true"` 时导入（`app.module.ts:60,82`）；`ScheduleModule.forRoot()` 由 `SCHEDULE_ENABLED !== "false"` 控制（`app.module.ts:76`），但它不注册 HTTP controller。
- `StorageModule` 未直接出现在 `app.module.ts`，但被 `AuthModule`（`auth.module.ts:37`）与 `CrawlModule`（`crawl.module.ts:83`）导入，因此 `StorageSettingsController` 确实装配。`StorageModule` 的 controller 已在模块内注册（`storage.module.ts:13`）。
- 没有 `@Controller()` 空前缀控制器；所有 71 个控制器都有非空前缀。全局前缀排除只影响 `admin/queues*`（Bull Board 自己处理，见 T1.7）。

### 1. 分域路由表

图例：A 类“Go 规则/处理器”列给出 builder → Go handler 包（`cmd/api` 里的注册位置）；`legacyproxy/...:行` 是 Rule 源码位置；“开关”列给出 env、源码默认值与 `config.go` 行号；“go 模式下 Nest 行为”列描述 Nest 是否读取该 env、是否仍注册路由/是否有兼容桥；“证据”列给出 Go 规则文件:行、规则类型/方法集合与开关 `config.go` 行。

#### auth（身份、会话、MFA、OIDC）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/auth/admin/invites | `apps/api/src/modules/auth/auth.controller.ts:346`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:48`（exact；GET,OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/admin/invites | `apps/api/src/modules/auth/auth.controller.ts:352`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:48`（exact；GET,OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/admin/invites/:id/resend | `apps/api/src/modules/auth/auth.controller.ts:365`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:50`（one-segment；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/admin/invites/:id/revoke | `apps/api/src/modules/auth/auth.controller.ts:383`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:52`（one-segment；OPTIONS,POST）；`config.go:4175` |
| GET /api/auth/admin/oidc-config | `apps/api/src/modules/auth/auth.controller.ts:320`（AuthController） | `WithAuthFactors` → `internal/authfactors`（cmd/api/auth_factors.go:42） | `API_GO_AUTH_FACTORS_MODE`（默认 legacy，config.go:4115） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_factors_routes.go:46`（exact；GET,OPTIONS,PUT）；`config.go:4115` |
| PUT /api/auth/admin/oidc-config | `apps/api/src/modules/auth/auth.controller.ts:326`（AuthController） | `WithAuthFactors` → `internal/authfactors`（cmd/api/auth_factors.go:42） | `API_GO_AUTH_FACTORS_MODE`（默认 legacy，config.go:4115） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_factors_routes.go:46`（exact；GET,OPTIONS,PUT）；`config.go:4115` |
| GET /api/auth/admin/registration-applications | `apps/api/src/modules/auth/auth.controller.ts:392`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:54`（exact；GET,OPTIONS）；`config.go:4175` |
| POST /api/auth/admin/registration-applications/:id/approve-join | `apps/api/src/modules/auth/auth.controller.ts:417`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:57`（one-segment；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/admin/registration-applications/:id/approve-org | `apps/api/src/modules/auth/auth.controller.ts:453`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:57`（one-segment；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/admin/registration-applications/:id/reject-join | `apps/api/src/modules/auth/auth.controller.ts:438`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:57`（one-segment；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/admin/registration-applications/:id/reject-org | `apps/api/src/modules/auth/auth.controller.ts:470`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:57`（one-segment；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/avatar/presigned-url | `apps/api/src/modules/auth/auth.controller.ts:606`（AuthController） | `WithAccountData` → `internal/accountdata`（cmd/api/account_data.go:107） | `API_GO_AVATAR_UPLOAD_MODE`（默认 legacy，config.go:4134） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_data_routes.go:27`（exact；OPTIONS,POST）；`config.go:4134` |
| POST /api/auth/change-password | `apps/api/src/modules/auth/auth.controller.ts:629`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:46`（exact；OPTIONS,POST）；`config.go:4123` |
| GET /api/auth/data-export | `apps/api/src/modules/auth/auth.controller.ts:651`（AuthController） | `WithAccountData` → `internal/accountdata`（cmd/api/account_data.go:110） | `API_GO_USER_DATA_EXPORT_MODE`（默认 legacy，config.go:4142） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_data_routes.go:30`（exact；GET,OPTIONS）；`config.go:4142` |
| GET /api/auth/invitations/:token | `apps/api/src/modules/auth/auth.controller.ts:498`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:62`（one-segment；GET,OPTIONS）；`config.go:4175` |
| POST /api/auth/invitations/:token/accept | `apps/api/src/modules/auth/auth.controller.ts:504`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:64`（one-segment；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/invitations/:token/accept-authenticated | `apps/api/src/modules/auth/auth.controller.ts:516`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:66`（one-segment；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/login | `apps/api/src/modules/auth/auth.controller.ts:94`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/login-with-code | `apps/api/src/modules/auth/auth.controller.ts:155`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/logout | `apps/api/src/modules/auth/auth.controller.ts:589`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:47`（exact；OPTIONS,POST）；`config.go:4123` |
| GET /api/auth/machine-tokens | `apps/api/src/modules/auth/auth.controller.ts:182`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:48`（exact；GET,OPTIONS,POST）；`config.go:4123` |
| POST /api/auth/machine-tokens | `apps/api/src/modules/auth/auth.controller.ts:166`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:48`（exact；GET,OPTIONS,POST）；`config.go:4123` |
| DELETE /api/auth/machine-tokens/:tokenId | `apps/api/src/modules/auth/auth.controller.ts:188`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:54`（one-segment；DELETE,OPTIONS）；`config.go:4123` |
| POST /api/auth/machine-tokens/:tokenId/rotate | `apps/api/src/modules/auth/auth.controller.ts:197`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:56`（one-segment；OPTIONS,POST）；`config.go:4123` |
| GET /api/auth/me | `apps/api/src/modules/auth/auth.controller.ts:645`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:44`（exact；GET,OPTIONS）；`config.go:4123` |
| GET /api/auth/mfa | `apps/api/src/modules/auth/auth.controller.ts:236`（AuthController） | `WithAuthFactors` → `internal/authfactors`（cmd/api/auth_factors.go:42） | `API_GO_AUTH_FACTORS_MODE`（默认 legacy，config.go:4115） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_factors_routes.go:41`（exact；GET,OPTIONS）；`config.go:4115` |
| POST /api/auth/mfa/disable | `apps/api/src/modules/auth/auth.controller.ts:257`（AuthController） | `WithAuthFactors` → `internal/authfactors`（cmd/api/auth_factors.go:42） | `API_GO_AUTH_FACTORS_MODE`（默认 legacy，config.go:4115） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_factors_routes.go:44`（exact；OPTIONS,POST）；`config.go:4115` |
| POST /api/auth/mfa/enroll | `apps/api/src/modules/auth/auth.controller.ts:242`（AuthController） | `WithAuthFactors` → `internal/authfactors`（cmd/api/auth_factors.go:42） | `API_GO_AUTH_FACTORS_MODE`（默认 legacy，config.go:4115） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_factors_routes.go:42`（exact；OPTIONS,POST）；`config.go:4115` |
| POST /api/auth/mfa/enrollment/complete | `apps/api/src/modules/auth/auth.controller.ts:305`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/mfa/enrollment/start | `apps/api/src/modules/auth/auth.controller.ts:292`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/mfa/recovery/rotate | `apps/api/src/modules/auth/auth.controller.ts:266`（AuthController） | `WithAuthFactors` → `internal/authfactors`（cmd/api/auth_factors.go:42） | `API_GO_AUTH_FACTORS_MODE`（默认 legacy，config.go:4115） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_factors_routes.go:45`（exact；OPTIONS,POST）；`config.go:4115` |
| POST /api/auth/mfa/verify-enroll | `apps/api/src/modules/auth/auth.controller.ts:248`（AuthController） | `WithAuthFactors` → `internal/authfactors`（cmd/api/auth_factors.go:42） | `API_GO_AUTH_FACTORS_MODE`（默认 legacy，config.go:4115） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_factors_routes.go:43`（exact；OPTIONS,POST）；`config.go:4115` |
| POST /api/auth/mfa/verify-login | `apps/api/src/modules/auth/auth.controller.ts:277`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| GET /api/auth/oidc/callback | `apps/api/src/modules/auth/auth.controller.ts:537`（AuthController） | `WithOIDCLogin` → `internal/oidclogin`（cmd/api/oidc_login.go:69） | `API_GO_OIDC_LOGIN_MODE`（默认 legacy，config.go:4164） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/oidc_login_routes.go:30`（exact；GET,OPTIONS）；`config.go:4164` |
| POST /api/auth/password/forgot | `apps/api/src/modules/auth/auth.controller.ts:208`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/password/reset | `apps/api/src/modules/auth/auth.controller.ts:227`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| PATCH /api/auth/profile | `apps/api/src/modules/auth/auth.controller.ts:620`（AuthController） | `WithAccountSecurity` → `internal/accountsecurity`（cmd/api/account_security.go:65） | `API_GO_ACCOUNT_SECURITY_MODE`（默认 legacy，config.go:4123） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/account_security_routes.go:45`（exact；OPTIONS,PATCH）；`config.go:4123` |
| POST /api/auth/refresh | `apps/api/src/modules/auth/auth.controller.ts:107`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/register/applications | `apps/api/src/modules/auth/auth.controller.ts:484`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:60`（exact；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/register/join-applications | `apps/api/src/modules/auth/auth.controller.ts:491`（AuthController） | `WithIdentityOnboarding` → `internal/identityonboarding`（cmd/api/identity_onboarding.go:61） | `API_GO_IDENTITY_ONBOARDING_MODE`（默认 legacy，config.go:4175） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/identity_onboarding_routes.go:61`（exact；OPTIONS,POST）；`config.go:4175` |
| POST /api/auth/send-login-code | `apps/api/src/modules/auth/auth.controller.ts:146`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/send-verification | `apps/api/src/modules/auth/auth.controller.ts:117`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |
| POST /api/auth/sso/handoff/exchange | `apps/api/src/modules/auth/auth.controller.ts:578`（AuthController） | `WithOIDCLogin` → `internal/oidclogin`（cmd/api/oidc_login.go:69） | `API_GO_OIDC_LOGIN_MODE`（默认 legacy，config.go:4164） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/oidc_login_routes.go:31`（exact；OPTIONS,POST）；`config.go:4164` |
| GET /api/auth/sso/oidc/start | `apps/api/src/modules/auth/auth.controller.ts:530`（AuthController） | `WithOIDCLogin` → `internal/oidclogin`（cmd/api/oidc_login.go:69） | `API_GO_OIDC_LOGIN_MODE`（默认 legacy，config.go:4164） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/oidc_login_routes.go:29`（exact；GET,OPTIONS）；`config.go:4164` |
| POST /api/auth/verify-email | `apps/api/src/modules/auth/auth.controller.ts:133`（AuthController） | `WithAuthLogin` → `internal/authlogin`（cmd/api/auth_login.go:79） | `API_GO_AUTH_LOGIN_MODE`（默认 legacy，config.go:4153） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/auth_login_routes.go:61`（exact；OPTIONS,POST）；`config.go:4153` |

> 本域 45 条：A 45、B 0、C 0。

#### rbac（组织访问控制）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| POST /api/rbac/assign | `apps/api/src/modules/rbac/rbac.controller.ts:38`（RbacController） | `WithRbac` → `internal/rbacapi`（cmd/api/rbac.go:29） | `API_GO_RBAC_MODE`（默认 legacy，config.go:3730） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/rbac_routes.go:28`（exact；OPTIONS,POST）；`config.go:3730` |
| GET /api/rbac/audit-logs | `apps/api/src/modules/rbac/rbac.controller.ts:50`（RbacController） | `WithRbac` → `internal/rbacapi`（cmd/api/rbac.go:29） | `API_GO_RBAC_MODE`（默认 legacy，config.go:3730） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/rbac_routes.go:30`（exact；GET,OPTIONS）；`config.go:3730` |
| GET /api/rbac/members | `apps/api/src/modules/rbac/rbac.controller.ts:44`（RbacController） | `WithRbac` → `internal/rbacapi`（cmd/api/rbac.go:29） | `API_GO_RBAC_MODE`（默认 legacy，config.go:3730） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/rbac_routes.go:29`（exact；GET,OPTIONS）；`config.go:3730` |
| GET /api/rbac/permissions | `apps/api/src/modules/rbac/rbac.controller.ts:19`（RbacController） | `WithRbac` → `internal/rbacapi`（cmd/api/rbac.go:29） | `API_GO_RBAC_MODE`（默认 legacy，config.go:3730） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/rbac_routes.go:26`（exact；GET,OPTIONS）；`config.go:3730` |
| GET /api/rbac/roles | `apps/api/src/modules/rbac/rbac.controller.ts:25`（RbacController） | `WithRbac` → `internal/rbacapi`（cmd/api/rbac.go:29） | `API_GO_RBAC_MODE`（默认 legacy，config.go:3730） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/rbac_routes.go:27`（exact；GET,OPTIONS,POST）；`config.go:3730` |
| POST /api/rbac/roles | `apps/api/src/modules/rbac/rbac.controller.ts:32`（RbacController） | `WithRbac` → `internal/rbacapi`（cmd/api/rbac.go:29） | `API_GO_RBAC_MODE`（默认 legacy，config.go:3730） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/rbac_routes.go:27`（exact；GET,OPTIONS,POST）；`config.go:3730` |

> 本域 6 条：A 6、B 0、C 0。

#### user-settings（工作台 UI 设置）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/user-settings/ui/newsnow | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:77`（UserUiSettingsController） | `DefaultRulesWithWrite(读模式)` → `internal/usersettingsread`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_READ_MODE`（默认空=兼容，config.go:3407） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:142`（exact；GET）；`config.go:3407` |
| PUT /api/user-settings/ui/newsnow | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:84`（UserUiSettingsController） | `DefaultRulesWithWrite(写模式)` → `internal/usersettingswrite`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_WRITE_MODE`（默认 legacy，config.go:3420；要求 READ=go，config.go:3430） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:164`（exact；PUT，位于 proxy.go:153-166 的循环内）；`config.go:3420` |
| GET /api/user-settings/ui/onboarding | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:109`（UserUiSettingsController） | `DefaultRulesWithWrite(读模式)` → `internal/usersettingsread`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_READ_MODE`（默认空=兼容，config.go:3407）；兼容模式下由 `API_GO_ONBOARDING_MODE` 决定（默认 shadow，config.go:3393） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:138`（exact；GET）；`config.go:3407` |
| PUT /api/user-settings/ui/onboarding | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:116`（UserUiSettingsController） | `DefaultRulesWithWrite(写模式)` → `internal/usersettingswrite`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_WRITE_MODE`（默认 legacy，config.go:3420；要求 READ=go，config.go:3430） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:164`（exact；PUT，位于 proxy.go:153-166 的循环内）；`config.go:3420` |
| GET /api/user-settings/ui/rss-reader | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:93`（UserUiSettingsController） | `DefaultRulesWithWrite(读模式)` → `internal/usersettingsread`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_READ_MODE`（默认空=兼容，config.go:3407） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:139`（exact；GET）；`config.go:3407` |
| PUT /api/user-settings/ui/rss-reader | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:100`（UserUiSettingsController） | `DefaultRulesWithWrite(写模式)` → `internal/usersettingswrite`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_WRITE_MODE`（默认 legacy，config.go:3420；要求 READ=go，config.go:3430） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:164`（exact；PUT，位于 proxy.go:153-166 的循环内）；`config.go:3420` |
| GET /api/user-settings/ui/situation-monitor | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:21`（UserUiSettingsController） | `DefaultRulesWithWrite(读模式)` → `internal/usersettingsread`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_READ_MODE`（默认空=兼容，config.go:3407） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:143`（exact；GET）；`config.go:3407` |
| PUT /api/user-settings/ui/situation-monitor | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:28`（UserUiSettingsController） | `DefaultRulesWithWrite(写模式)` → `internal/usersettingswrite`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_WRITE_MODE`（默认 legacy，config.go:3420；要求 READ=go，config.go:3430） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:164`（exact；PUT，位于 proxy.go:153-166 的循环内）；`config.go:3420` |
| GET /api/user-settings/ui/spacetime-timeline | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:57`（UserUiSettingsController） | `DefaultRulesWithWrite(读模式)` → `internal/usersettingsread`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_READ_MODE`（默认空=兼容，config.go:3407） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:140`（exact；GET）；`config.go:3407` |
| PUT /api/user-settings/ui/spacetime-timeline | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:64`（UserUiSettingsController） | `DefaultRulesWithWrite(写模式)` → `internal/usersettingswrite`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_WRITE_MODE`（默认 legacy，config.go:3420；要求 READ=go，config.go:3430） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:164`（exact；PUT，位于 proxy.go:153-166 的循环内）；`config.go:3420` |
| GET /api/user-settings/ui/war-map | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:41`（UserUiSettingsController） | `DefaultRulesWithWrite(读模式)` → `internal/usersettingsread`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_READ_MODE`（默认空=兼容，config.go:3407） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:141`（exact；GET）；`config.go:3407` |
| PUT /api/user-settings/ui/war-map | `apps/api/src/modules/user-settings/user-ui-settings.controller.ts:48`（UserUiSettingsController） | `DefaultRulesWithWrite(写模式)` → `internal/usersettingswrite`（cmd/api/main.go:1476） | `API_GO_USER_SETTINGS_WRITE_MODE`（默认 legacy，config.go:3420；要求 READ=go，config.go:3430） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:164`（exact；PUT，位于 proxy.go:153-166 的循环内）；`config.go:3420` |

> 本域 12 条：A 12、B 0、C 0。

> 读模式说明：`API_GO_USER_SETTINGS_READ_MODE` 默认空=兼容；空值时 onboarding 由 `API_GO_ONBOARDING_MODE` 决定（默认 shadow），rss-reader/spacetime-timeline 仍 shadow，war-map/newsnow/situation-monitor 仍 legacy；显式 `go` 时六个 GET 全部由 Go 响应（`proxy.go:133-143,153-166`）。

#### dashboard（仪表盘、地图与 SSE）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/dashboard/financial-candlestick | `apps/api/src/modules/dashboard/dashboard.controller.ts:368`（DashboardController） | `WithDashboardCharts` → `internal/dashboardcharts`（cmd/api/main.go:1553） | `API_GO_DASHBOARD_CHARTS_MODE`（默认 legacy，config.go:3451） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:249`（exact；GET）；`config.go:3451` |
| GET /api/dashboard/sector-heatmap | `apps/api/src/modules/dashboard/dashboard.controller.ts:361`（DashboardController） | `WithDashboardCharts` → `internal/dashboardcharts`（cmd/api/main.go:1553） | `API_GO_DASHBOARD_CHARTS_MODE`（默认 legacy，config.go:3451） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:249`（exact；GET）；`config.go:3451` |
| GET /api/dashboard/spacetime/geo-heatmap | `apps/api/src/modules/dashboard/dashboard.controller.ts:290`（DashboardController） | `WithDashboardSpacetimeGeo` → `internal/dashboardspacetime`（cmd/api/main.go:1680） | `API_GO_DASHBOARD_SPACETIME_GEO_MODE`（默认 legacy，config.go:3483） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:302`（exact；GET,OPTIONS）；`config.go:3483` |
| GET /api/dashboard/spacetime/geo-heatmap/articles | `apps/api/src/modules/dashboard/dashboard.controller.ts:305`（DashboardController） | `WithDashboardSpacetimeGeo` → `internal/dashboardspacetime`（cmd/api/main.go:1680） | `API_GO_DASHBOARD_SPACETIME_GEO_MODE`（默认 legacy，config.go:3483） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:303`（exact；GET,OPTIONS）；`config.go:3483` |
| GET /api/dashboard/spacetime/propagation | `apps/api/src/modules/dashboard/dashboard.controller.ts:325`（DashboardController） | `WithDashboardSpacetimePropagation` → `internal/dashboardspacetime`（cmd/api/main.go:1686） | `API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE`（默认 legacy，config.go:3491） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:312`（exact；GET,OPTIONS）；`config.go:3491` |
| GET /api/dashboard/spacetime/propagation/articles | `apps/api/src/modules/dashboard/dashboard.controller.ts:341`（DashboardController） | `WithDashboardSpacetimePropagation` → `internal/dashboardspacetime`（cmd/api/main.go:1686） | `API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE`（默认 legacy，config.go:3491） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:313`（exact；GET,OPTIONS）；`config.go:3491` |
| GET /api/dashboard/stats | `apps/api/src/modules/dashboard/dashboard.controller.ts:184`（DashboardController） | `WithDashboardStats` → `internal/dashboardstats`（cmd/api/main.go:1529） | `API_GO_DASHBOARD_STATS_MODE`（默认 legacy，config.go:3442） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:227`（exact；GET）；`config.go:3442` |
| GET /api/dashboard/stream（SSE） | `apps/api/src/modules/dashboard/dashboard.controller.ts:375`（DashboardController） | `WithDashboardStream` → `internal/dashboardstream`（cmd/api/main.go:1701） | `API_GO_DASHBOARD_STREAM_MODE`（默认 legacy，config.go:3499） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:322`（exact；GET,OPTIONS）；`config.go:3499` |
| GET /api/dashboard/war-map/events | `apps/api/src/modules/dashboard/dashboard.controller.ts:227`（DashboardController） | `WithDashboardWarMap` → `internal/dashboardwarmap`（cmd/api/main.go:1629） | `API_GO_DASHBOARD_WAR_MAP_MODE`（默认 legacy，config.go:3459） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:271`（exact；GET）；`config.go:3459` |
| GET /api/dashboard/war-map/geojson | `apps/api/src/modules/dashboard/dashboard.controller.ts:190`（DashboardController） | `WithDashboardCharts` → `internal/dashboardcharts`（cmd/api/main.go:1553） | `API_GO_DASHBOARD_CHARTS_MODE`（默认 legacy，config.go:3451） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:249`（exact；GET）；`config.go:3451` |
| GET /api/dashboard/war-map/layers | `apps/api/src/modules/dashboard/dashboard.controller.ts:206`（DashboardController） | `WithDashboardWarMapLayers` → `internal/dashboardwarmap`（cmd/api/main.go:1639） | `API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE`（默认 legacy，config.go:3475） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:293`（exact；GET,OPTIONS）；`config.go:3475` |
| GET /api/dashboard/war-map/news-markers | `apps/api/src/modules/dashboard/dashboard.controller.ts:244`（DashboardController） | `WithDashboardWarMap` → `internal/dashboardwarmap`（cmd/api/main.go:1629） | `API_GO_DASHBOARD_WAR_MAP_MODE`（默认 legacy，config.go:3459） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:271`（exact；GET）；`config.go:3459` |
| GET /api/dashboard/war-map/transport-detail | `apps/api/src/modules/dashboard/dashboard.controller.ts:261`（DashboardController） | `WithDashboardWarMapTransport` → `internal/dashboardwarmap`（cmd/api/main.go:1635） | `API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE`（默认 legacy，config.go:3467） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:284`（exact；GET,OPTIONS）；`config.go:3467` |

> 本域 13 条：A 13、B 0、C 0。

#### analysis（分析协作与导出）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/analysis/boards | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:95`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:35`（exact；GET,OPTIONS,POST）；`config.go:3618` |
| POST /api/analysis/boards | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:102`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:35`（exact；GET,OPTIONS,POST）；`config.go:3618` |
| DELETE /api/analysis/boards/:boardId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:131`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:37`（one-segment；DELETE,GET,OPTIONS,PATCH）；`config.go:3618` |
| GET /api/analysis/boards/:boardId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:111`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:37`（one-segment；DELETE,GET,OPTIONS,PATCH）；`config.go:3618` |
| PATCH /api/analysis/boards/:boardId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:121`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:37`（one-segment；DELETE,GET,OPTIONS,PATCH）；`config.go:3618` |
| POST /api/analysis/boards/:boardId/columns | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:140`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:39`（one-segment；OPTIONS,POST）；`config.go:3618` |
| POST /api/analysis/boards/:boardId/columns/reorder | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:150`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:41`（one-segment；OPTIONS,POST）；`config.go:3618` |
| POST /api/analysis/boards/:boardId/tasks | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:190`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysistasks`（cmd/api/analysis.go:63） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:43`（one-segment；OPTIONS,POST）；`config.go:3618` |
| DELETE /api/analysis/columns/:columnId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:175`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:45`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3618` |
| PATCH /api/analysis/columns/:columnId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:165`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysisboards`（cmd/api/analysis.go:60） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:45`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3618` |
| DELETE /api/analysis/comments/:commentId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:297`（AnalysisWorkspaceController） | `WithAnalysisThreads` → `internal/analysisthreads`（cmd/api/analysis.go:54） | `API_GO_ANALYSIS_THREADS_MODE`（默认 legacy，config.go:3626） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:63`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3626` |
| PATCH /api/analysis/comments/:commentId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:282`（AnalysisWorkspaceController） | `WithAnalysisThreads` → `internal/analysisthreads`（cmd/api/analysis.go:54） | `API_GO_ANALYSIS_THREADS_MODE`（默认 legacy，config.go:3626） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:63`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3626` |
| POST /api/analysis/exports/events | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:340`（AnalysisWorkspaceController） | `WithAnalysisExport` → `internal/analysisexport`（cmd/api/analysis_export.go:92） | `API_GO_ANALYSIS_EXPORT_MODE`（默认 legacy，config.go:3639） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_export_routes.go:29`（exact；OPTIONS,POST）；`config.go:3639` |
| POST /api/analysis/exports/items | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:323`（AnalysisWorkspaceController） | `WithAnalysisExport` → `internal/analysisexport`（cmd/api/analysis_export.go:92） | `API_GO_ANALYSIS_EXPORT_MODE`（默认 legacy，config.go:3639） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_export_routes.go:28`（exact；OPTIONS,POST）；`config.go:3639` |
| POST /api/analysis/exports/search | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:306`（AnalysisWorkspaceController） | `WithArchiveReadingSearch` → `internal/archivereading`（cmd/api/archive_reading.go:85） | `API_GO_ARCHIVE_READING_MODE`（默认 legacy，config.go:3648） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/archive_reading_routes.go:17`（exact；OPTIONS,POST）；`config.go:3648` |
| DELETE /api/analysis/tasks/:taskId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:210`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysistasks`（cmd/api/analysis.go:63） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:47`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3618` |
| PATCH /api/analysis/tasks/:taskId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:200`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysistasks`（cmd/api/analysis.go:63） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:47`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3618` |
| POST /api/analysis/tasks/:taskId/move | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:219`（AnalysisWorkspaceController） | `WithAnalysisBoards` → `internal/analysistasks`（cmd/api/analysis.go:63） | `API_GO_ANALYSIS_BOARDS_MODE`（默认 legacy，config.go:3618） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:49`（one-segment；OPTIONS,POST）；`config.go:3618` |
| GET /api/analysis/threads/:subjectType/:subjectId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:229`（AnalysisWorkspaceController） | `WithAnalysisThreads` → `internal/analysisthreads`（cmd/api/analysis.go:54） | `API_GO_ANALYSIS_THREADS_MODE`（默认 legacy，config.go:3626） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:59`（two-segments；GET,OPTIONS,PUT）；`config.go:3626` |
| PUT /api/analysis/threads/:subjectType/:subjectId | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:246`（AnalysisWorkspaceController） | `WithAnalysisThreads` → `internal/analysisthreads`（cmd/api/analysis.go:54） | `API_GO_ANALYSIS_THREADS_MODE`（默认 legacy，config.go:3626） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:59`（two-segments；GET,OPTIONS,PUT）；`config.go:3626` |
| POST /api/analysis/threads/:subjectType/:subjectId/comments | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:264`（AnalysisWorkspaceController） | `WithAnalysisThreads` → `internal/analysisthreads`（cmd/api/analysis.go:54） | `API_GO_ANALYSIS_THREADS_MODE`（默认 legacy，config.go:3626） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:61`（two-segments；OPTIONS,POST）；`config.go:3626` |
| GET /api/analysis/views | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:47`（AnalysisWorkspaceController） | `WithAnalysisViews` → `internal/analysisviews`（cmd/api/analysis.go:49） | `API_GO_ANALYSIS_VIEWS_MODE`（默认 legacy，config.go:3610） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:22`（exact；GET,OPTIONS,POST）；`config.go:3610` |
| POST /api/analysis/views | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:67`（AnalysisWorkspaceController） | `WithAnalysisViews` → `internal/analysisviews`（cmd/api/analysis.go:49） | `API_GO_ANALYSIS_VIEWS_MODE`（默认 legacy，config.go:3610） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:22`（exact；GET,OPTIONS,POST）；`config.go:3610` |
| DELETE /api/analysis/views/:id | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:86`（AnalysisWorkspaceController） | `WithAnalysisViews` → `internal/analysisviews`（cmd/api/analysis.go:49） | `API_GO_ANALYSIS_VIEWS_MODE`（默认 legacy，config.go:3610） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:24`（one-segment；DELETE,GET,OPTIONS,PATCH）；`config.go:3610` |
| GET /api/analysis/views/:id | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:57`（AnalysisWorkspaceController） | `WithAnalysisViews` → `internal/analysisviews`（cmd/api/analysis.go:49） | `API_GO_ANALYSIS_VIEWS_MODE`（默认 legacy，config.go:3610） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:24`（one-segment；DELETE,GET,OPTIONS,PATCH）；`config.go:3610` |
| PATCH /api/analysis/views/:id | `apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts:76`（AnalysisWorkspaceController） | `WithAnalysisViews` → `internal/analysisviews`（cmd/api/analysis.go:49） | `API_GO_ANALYSIS_VIEWS_MODE`（默认 legacy，config.go:3610） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/analysis_routes.go:24`（one-segment；DELETE,GET,OPTIONS,PATCH）；`config.go:3610` |

> 本域 26 条：A 26、B 0、C 0。

#### items / geo / search-admin

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| POST /api/admin/search/reindex | `apps/api/src/modules/items/search-admin.controller.ts:13`（SearchAdminController） | `WithSearchReindex` → `internal/searchreindex`（cmd/api/search_reindex.go:58） | `API_GO_SEARCH_REINDEX_MODE`（默认 legacy，config.go:3984） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/search_reindex_routes.go:25`（exact；OPTIONS,POST）；`config.go:3984` |
| GET /api/admin/search/reindex/:jobId | `apps/api/src/modules/items/search-admin.controller.ts:21`（SearchAdminController） | `WithSearchReindex` → `internal/searchreindex`（cmd/api/search_reindex.go:58） | `API_GO_SEARCH_REINDEX_MODE`（默认 legacy，config.go:3984） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/search_reindex_routes.go:26`（one-segment；GET,OPTIONS）；`config.go:3984` |
| POST /api/geo/geocode | `apps/api/src/modules/geo/geo.controller.ts:16`（GeoController） | `WithGeocoding` → `internal/geocoding`（cmd/api/settings_diagnostics.go:102） | `API_GO_GEOCODING_MODE`（默认 legacy，config.go:4016） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/geocoding_routes.go:23`（exact；OPTIONS,POST）；`config.go:4016` |
| GET /api/items | `apps/api/src/modules/items/items.controller.ts:19`（ItemsController） | `WithItemsReading` → `internal/itemsreading`（cmd/api/main.go:2620） | `API_GO_ITEMS_READING_MODE`（默认 legacy，config.go:4476） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/items_reading_routes.go:24`（exact；GET,OPTIONS）；`config.go:4476` |
| POST /api/items | `apps/api/src/modules/items/items.controller.ts:28`（ItemsController） | `WithItemsIngest` → `internal/itemsingest`（cmd/api/items_ingest.go:70） | `API_GO_ITEMS_INGEST_MODE`（默认 legacy，config.go:4489） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/items_ingest_routes.go:18`（exact；OPTIONS,POST）；`config.go:4489` |
| GET /api/items/:id | `apps/api/src/modules/items/items.controller.ts:34`（ItemsController） | `WithItemsReading` → `internal/itemsreading`（cmd/api/main.go:2620） | `API_GO_ITEMS_READING_MODE`（默认 legacy，config.go:4476） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/items_reading_routes.go:25`（one-segment；GET,OPTIONS）；`config.go:4476` |

> 本域 6 条：A 6、B 0、C 0。

#### crawl（采集管理台、任务与媒体）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/admin/crawl-frontier/news-sources/:id/workflow-bridge | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:174`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:44`（one-segment；GET,OPTIONS）；`config.go:3706` |
| GET /api/admin/crawl-frontier/nodes/:id | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:193`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:78`（one-segment；GET,OPTIONS）；`config.go:3722` |
| POST /api/admin/crawl-frontier/nodes/:id/retry | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:211`（CrawlFrontierController） | `WithCrawlFrontierWrites`（`legacyproxy/crawl_frontier_writes_routes.go`）→ `internal/crawlfrontierruns/`（`handler_write.go`） | `API_GO_CRAWL_FRONTIER_WRITES_MODE`（默认 legacy；=go 要求 `API_GO_CRAWL_FRONTIER_RUNS_MODE=go`） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:211`；`apps/api-go/internal/crawlfrontierruns/` |
| POST /api/admin/crawl-frontier/nodes/retry | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:202`（CrawlFrontierController） | `WithCrawlFrontierWrites`（`legacyproxy/crawl_frontier_writes_routes.go`）→ `internal/crawlfrontierruns/`（`handler_write.go`） | `API_GO_CRAWL_FRONTIER_WRITES_MODE`（默认 legacy；=go 要求 `API_GO_CRAWL_FRONTIER_RUNS_MODE=go`） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:202`；`apps/api-go/internal/crawlfrontierruns/` |
| GET /api/admin/crawl-frontier/profiles | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:37`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:30`（exact；GET,OPTIONS,POST）；`config.go:3714` |
| POST /api/admin/crawl-frontier/profiles | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:73`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:30`（exact；GET,OPTIONS,POST）；`config.go:3714` |
| GET /api/admin/crawl-frontier/profiles/:id | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:64`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:37`（one-segment；GET,OPTIONS,PATCH）；`config.go:3714` |
| PATCH /api/admin/crawl-frontier/profiles/:id | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:82`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:37`（one-segment；GET,OPTIONS,PATCH）；`config.go:3714` |
| POST /api/admin/crawl-frontier/profiles/:id/rollback/:version | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:101`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:34`（one-segment；OPTIONS,POST）；`config.go:3714` |
| GET /api/admin/crawl-frontier/profiles/:id/versions | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:92`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:36`（one-segment；GET,OPTIONS）；`config.go:3714` |
| GET /api/admin/crawl-frontier/profiles/:id/workflow-bridge | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:164`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:43`（one-segment；GET,OPTIONS）；`config.go:3706` |
| GET /api/admin/crawl-frontier/profiles/match | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:46`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:31`（exact；GET,OPTIONS）；`config.go:3714` |
| POST /api/admin/crawl-frontier/profiles/preview | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:55`（CrawlFrontierController） | `WithCrawlProfiles` → `internal/crawlprofile`（cmd/api/crawl_profiles.go:27） | `API_GO_CRAWL_PROFILES_MODE`（默认 legacy，config.go:3714） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_profiles_routes.go:32`（exact；OPTIONS,POST）；`config.go:3714` |
| GET /api/admin/crawl-frontier/runs | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:116`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:54`（exact；GET,OPTIONS）；`config.go:3722` |
| POST /api/admin/crawl-frontier/runs | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:125`（CrawlFrontierController） | `WithCrawlFrontierWrites`（`legacyproxy/crawl_frontier_writes_routes.go`）→ `internal/crawlfrontierruns/`（`handler_write.go`；创建 run 复用 `internal/crawlfrontierllm/` 的 `CreateFrontierRunFromProfile`） | `API_GO_CRAWL_FRONTIER_WRITES_MODE`（默认 legacy；=go 要求 `API_GO_CRAWL_FRONTIER_RUNS_MODE=go`） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:125`；`apps/api-go/internal/crawlfrontierruns/`；`apps/api-go/internal/crawlfrontierllm/` |
| GET /api/admin/crawl-frontier/runs/:id | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:134`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:75`（one-segment；GET,OPTIONS）；`config.go:3722` |
| POST /api/admin/crawl-frontier/runs/:id/cancel | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:184`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:72`（one-segment；OPTIONS,POST）；`config.go:3722` |
| GET /api/admin/crawl-frontier/runs/:id/workflow-candidates | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:152`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:70`（one-segment；GET,OPTIONS）；`config.go:3722` |
| GET /api/admin/crawl-frontier/runs/:id/workflow-candidates/:candidateId | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:161`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:60`（one-segment；GET,OPTIONS）；`config.go:3722` |
| GET /api/admin/crawl-frontier/runs/:id/workflow-run | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:143`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:71`（one-segment；GET,OPTIONS）；`config.go:3722` |
| POST /api/admin/crawl-frontier/runs/cancel | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:175`（CrawlFrontierController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:55`（exact；OPTIONS,POST）；`config.go:3722` |
| GET /api/admin/crawl-frontier/workflow-runs/:runId | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:126`（CrawlStrategyController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:92`（one-segment；GET,OPTIONS）；`config.go:3722` |
| GET /api/admin/crawl-frontier/workflow-runs/:runId/candidates | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:135`（CrawlStrategyController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:91`（one-segment；GET,OPTIONS）；`config.go:3722` |
| GET /api/admin/crawl-frontier/workflow-runs/:runId/candidates/:candidateId/explanation | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:144`（CrawlStrategyController） | `WithCrawlFrontierRuns` → `internal/crawlfrontierruns`（cmd/api/crawl_frontier_runs.go:31） | `API_GO_CRAWL_FRONTIER_RUNS_MODE`（默认 legacy，config.go:3722） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go:81`（one-segment；GET,OPTIONS）；`config.go:3722` |
| POST /api/admin/crawl-frontier/workflow-runs/:runId/replay | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:154`（CrawlStrategyController） | `WithCrawlWorkflowTrial` → `internal/crawlstrategyruns`（cmd/api/crawl_discovery.go:90） | `API_GO_CRAWL_WORKFLOW_TRIAL_MODE`（默认 legacy，config.go:3974） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_discovery_routes.go:44`（one-segment；OPTIONS,POST）；`config.go:3974` |
| GET /api/admin/crawl-frontier/workflow-versions/:versionId | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:98`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:42`（one-segment；GET,OPTIONS）；`config.go:3706` |
| GET /api/admin/crawl-frontier/workflows | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:42`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:34`（exact；GET,OPTIONS,POST）；`config.go:3706` |
| POST /api/admin/crawl-frontier/workflows | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:51`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:34`（exact；GET,OPTIONS,POST）；`config.go:3706` |
| GET /api/admin/crawl-frontier/workflows/:id | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:60`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:41`（one-segment；GET,OPTIONS）；`config.go:3706` |
| PATCH /api/admin/crawl-frontier/workflows/:id/draft | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:69`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:37`（one-segment；OPTIONS,PATCH）；`config.go:3706` |
| POST /api/admin/crawl-frontier/workflows/:id/publish | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:79`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:38`（one-segment；OPTIONS,POST）；`config.go:3706` |
| POST /api/admin/crawl-frontier/workflows/:id/trial-run | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:116`（CrawlStrategyController） | `WithCrawlWorkflowTrial` → `internal/crawlstrategyruns`（cmd/api/crawl_discovery.go:90） | `API_GO_CRAWL_WORKFLOW_TRIAL_MODE`（默认 legacy，config.go:3974） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_discovery_routes.go:43`（one-segment；OPTIONS,POST）；`config.go:3974` |
| GET /api/admin/crawl-frontier/workflows/:id/versions | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:89`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:39`（one-segment；GET,OPTIONS）；`config.go:3706` |
| POST /api/admin/crawl-frontier/workflows/compare | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:107`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:35`（exact；OPTIONS,POST）；`config.go:3706` |
| GET /api/admin/crawl-frontier/workflows/node-schemas | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:36`（CrawlStrategyController） | `WithCrawlWorkflows` → `internal/crawlworkflow`（cmd/api/crawl_workflows.go:27） | `API_GO_CRAWL_WORKFLOWS_MODE`（默认 legacy，config.go:3706） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_workflows_routes.go:33`（exact；GET,OPTIONS）；`config.go:3706` |
| GET /api/admin/crawl-templates | `apps/api/src/modules/crawl/crawl-template.controller.ts:16`（CrawlTemplateController） | `WithCrawlTemplates` → `internal/crawltemplate`（cmd/api/crawl_templates.go:27） | `API_GO_CRAWL_TEMPLATES_MODE`（默认 legacy，config.go:3738） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_templates_routes.go:25`（exact；GET,OPTIONS,POST）；`config.go:3738` |
| POST /api/admin/crawl-templates | `apps/api/src/modules/crawl/crawl-template.controller.ts:22`（CrawlTemplateController） | `WithCrawlTemplates` → `internal/crawltemplate`（cmd/api/crawl_templates.go:27） | `API_GO_CRAWL_TEMPLATES_MODE`（默认 legacy，config.go:3738） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_templates_routes.go:25`（exact；GET,OPTIONS,POST）；`config.go:3738` |
| DELETE /api/admin/crawl-templates/:id | `apps/api/src/modules/crawl/crawl-template.controller.ts:38`（CrawlTemplateController） | `WithCrawlTemplates` → `internal/crawltemplate`（cmd/api/crawl_templates.go:27） | `API_GO_CRAWL_TEMPLATES_MODE`（默认 legacy，config.go:3738） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_templates_routes.go:26`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3738` |
| PATCH /api/admin/crawl-templates/:id | `apps/api/src/modules/crawl/crawl-template.controller.ts:28`（CrawlTemplateController） | `WithCrawlTemplates` → `internal/crawltemplate`（cmd/api/crawl_templates.go:27） | `API_GO_CRAWL_TEMPLATES_MODE`（默认 legacy，config.go:3738） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_templates_routes.go:26`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3738` |
| GET /api/admin/crawl4ai/quality | `apps/api/src/modules/crawl/crawl4ai-quality.controller.ts:15`（Crawl4aiQualityController） | `WithCrawlReadTelemetry` → `internal/crawlreadtelemetry`（cmd/api/crawl_read_telemetry.go:55） | `API_GO_CRAWL_READ_TELEMETRY_MODE`（默认 legacy，config.go:3900） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go:41`（exact；GET,OPTIONS）；`config.go:3900` |
| GET /api/admin/crawl4ai/quality/sources/:sourceId | `apps/api/src/modules/crawl/crawl4ai-quality.controller.ts:26`（Crawl4aiQualityController） | `WithCrawlReadTelemetry` → `internal/crawlreadtelemetry`（cmd/api/crawl_read_telemetry.go:55） | `API_GO_CRAWL_READ_TELEMETRY_MODE`（默认 legacy，config.go:3900） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go:39`（one-segment；GET,OPTIONS）；`config.go:3900` |
| GET /api/admin/crawl4ai/queue | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:40`（Crawl4aiQueueController） | `WithCrawlQueueOps` → `internal/crawltaskwrite`（cmd/api/crawl_task_write.go:78） | `API_GO_CRAWL_QUEUE_OPS_MODE`（默认 legacy，config.go:3926） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_queue_ops_routes.go:28`（exact；GET,OPTIONS）；`config.go:3926` |
| POST /api/admin/crawl4ai/queue/concurrency | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:101`（Crawl4aiQueueController） | `WithCrawlQueueOps` → `internal/crawltaskwrite`（cmd/api/crawl_task_write.go:78） | `API_GO_CRAWL_QUEUE_OPS_MODE`（默认 legacy，config.go:3926） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_queue_ops_routes.go:31`（exact；OPTIONS,POST）；`config.go:3926` |
| POST /api/admin/crawl4ai/queue/pause | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:87`（Crawl4aiQueueController） | `WithCrawlQueueOps` → `internal/crawltaskwrite`（cmd/api/crawl_task_write.go:78） | `API_GO_CRAWL_QUEUE_OPS_MODE`（默认 legacy，config.go:3926） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_queue_ops_routes.go:29`（exact；OPTIONS,POST）；`config.go:3926` |
| POST /api/admin/crawl4ai/queue/resume | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:94`（Crawl4aiQueueController） | `WithCrawlQueueOps` → `internal/crawltaskwrite`（cmd/api/crawl_task_write.go:78） | `API_GO_CRAWL_QUEUE_OPS_MODE`（默认 legacy，config.go:3926） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_queue_ops_routes.go:30`（exact；OPTIONS,POST）；`config.go:3926` |
| GET /api/admin/news-sources | `apps/api/src/modules/crawl/news-source.controller.ts:42`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:336`（exact；GET,OPTIONS,POST）；`config.go:3682` |
| POST /api/admin/news-sources | `apps/api/src/modules/crawl/news-source.controller.ts:57`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:336`（exact；GET,OPTIONS,POST）；`config.go:3682` |
| DELETE /api/admin/news-sources/:id | `apps/api/src/modules/crawl/news-source.controller.ts:155`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:346`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3682` |
| PATCH /api/admin/news-sources/:id | `apps/api/src/modules/crawl/news-source.controller.ts:145`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:346`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3682` |
| POST /api/admin/news-sources/:id/cancel-queued | `apps/api/src/modules/queue/news-source-ops.controller.ts:17`（NewsSourceOpsController） | `WithNewsSourceOps` → `internal/newssourcescheduler`（cmd/api/news_source_scheduler.go:126） | `API_GO_NEWS_SOURCE_OPS_MODE`（默认 legacy，config.go:3698） | Nest 不关闭路由；`news-source-notification.subscriber.ts:142` 在 go 时订阅 `news-source:notifications:v1` 转发通知（兼容桥，属 T1.5）。 | `apps/api-go/internal/legacyproxy/news_source_ops_routes.go:29`（one-segment；OPTIONS,POST）；`config.go:3698` |
| POST /api/admin/news-sources/:id/clear-inflight | `apps/api/src/modules/queue/news-source-ops.controller.ts:23`（NewsSourceOpsController） | `WithNewsSourceOps` → `internal/newssourcescheduler`（cmd/api/news_source_scheduler.go:126） | `API_GO_NEWS_SOURCE_OPS_MODE`（默认 legacy，config.go:3698） | Nest 不关闭路由；`news-source-notification.subscriber.ts:142` 在 go 时订阅 `news-source:notifications:v1` 转发通知（兼容桥，属 T1.5）。 | `apps/api-go/internal/legacyproxy/news_source_ops_routes.go:31`（one-segment；OPTIONS,POST）；`config.go:3698` |
| POST /api/admin/news-sources/:id/dispatch | `apps/api/src/modules/queue/news-source-dispatch.controller.ts:15`（NewsSourceDispatchController） | `WithNewsSourceOps` → `internal/newssourcescheduler`（cmd/api/news_source_scheduler.go:126） | `API_GO_NEWS_SOURCE_OPS_MODE`（默认 legacy，config.go:3698） | Nest 不关闭路由；`news-source-notification.subscriber.ts:142` 在 go 时订阅 `news-source:notifications:v1` 转发通知（兼容桥，属 T1.5）。 | `apps/api-go/internal/legacyproxy/news_source_ops_routes.go:27`（one-segment；OPTIONS,POST）；`config.go:3698` |
| GET /api/admin/news-sources/:id/preview | `apps/api/src/modules/crawl/news-source.controller.ts:180`（NewsSourceController） | `WithNewsSourcePreview` → `internal/crawlstrategyruns`（cmd/api/crawl_discovery.go:75） | `API_GO_NEWS_SOURCE_PREVIEW_MODE`（默认 legacy，config.go:3964） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_discovery_routes.go:25`（one-segment；GET,OPTIONS）；`config.go:3964` |
| POST /api/admin/news-sources/:id/retry-latest | `apps/api/src/modules/queue/news-source-ops.controller.ts:29`（NewsSourceOpsController） | `WithNewsSourceOps` → `internal/newssourcescheduler`（cmd/api/news_source_scheduler.go:126） | `API_GO_NEWS_SOURCE_OPS_MODE`（默认 legacy，config.go:3698） | Nest 不关闭路由；`news-source-notification.subscriber.ts:142` 在 go 时订阅 `news-source:notifications:v1` 转发通知（兼容桥，属 T1.5）。 | `apps/api-go/internal/legacyproxy/news_source_ops_routes.go:33`（one-segment；OPTIONS,POST）；`config.go:3698` |
| POST /api/admin/news-sources/:id/run | `apps/api/src/modules/crawl/news-source.controller.ts:164`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:347`（one-segment；OPTIONS,POST）；`config.go:3682` |
| POST /api/admin/news-sources/:id/schedule | `apps/api/src/modules/crawl/news-source.controller.ts:170`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:348`（one-segment；OPTIONS,POST）；`config.go:3682` |
| DELETE /api/admin/news-sources/batch | `apps/api/src/modules/crawl/news-source.controller.ts:136`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:345`（exact；DELETE,OPTIONS）；`config.go:3682` |
| PATCH /api/admin/news-sources/batch/active | `apps/api/src/modules/crawl/news-source.controller.ts:127`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:344`（exact；OPTIONS,PATCH）；`config.go:3682` |
| POST /api/admin/news-sources/batch/frequency | `apps/api/src/modules/crawl/news-source.controller.ts:66`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:340`（exact；OPTIONS,POST）；`config.go:3682` |
| PATCH /api/admin/news-sources/batch/group | `apps/api/src/modules/crawl/news-source.controller.ts:118`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:343`（exact；OPTIONS,PATCH）；`config.go:3682` |
| GET /api/admin/news-sources/groups | `apps/api/src/modules/crawl/news-source.controller.ts:112`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:338`（exact；GET,OPTIONS）；`config.go:3682` |
| GET /api/admin/news-sources/opml-presets | `apps/api/src/modules/crawl/news-source.controller.ts:78`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:339`（exact；GET,OPTIONS）；`config.go:3682` |
| POST /api/admin/news-sources/opml/import | `apps/api/src/modules/crawl/news-source.controller.ts:98`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:342`（exact；OPTIONS,POST）；`config.go:3682` |
| POST /api/admin/news-sources/opml/preview | `apps/api/src/modules/crawl/news-source.controller.ts:84`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:341`（exact；OPTIONS,POST）；`config.go:3682` |
| GET /api/admin/news-sources/options | `apps/api/src/modules/crawl/news-source.controller.ts:51`（NewsSourceController） | `WithNewsSources` → `internal/newssources`（cmd/api/news_sources.go:27） | `API_GO_NEWS_SOURCES_MODE`（默认 legacy，config.go:3682） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:337`（exact；GET,OPTIONS）；`config.go:3682` |
| GET /api/crawl-media-assets/:assetId/:mode | `apps/api/src/modules/crawl/crawl-media-asset.controller.ts:29`（CrawlMediaAssetController） | `WithCrawlReadTelemetry` → `internal/crawlreadtelemetry`（cmd/api/crawl_read_telemetry.go:55） | `API_GO_CRAWL_READ_TELEMETRY_MODE`（默认 legacy，config.go:3900） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go:35`（two-segments；GET,OPTIONS）；`config.go:3900` |
| GET /api/crawl-tasks | `apps/api/src/modules/crawl/crawl.controller.ts:26`（CrawlController） | `WithCrawlReadTelemetry` → `internal/crawlreadtelemetry`（cmd/api/crawl_read_telemetry.go:55） | `API_GO_CRAWL_READ_TELEMETRY_MODE`（默认 legacy，config.go:3900） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go:48`（exact；GET,OPTIONS）；`config.go:3900` |
| POST /api/crawl-tasks | `apps/api/src/modules/crawl/crawl.controller.ts:42`（CrawlController） | `WithCrawlTaskWrite` → `internal/crawltaskwrite`（cmd/api/crawl_task_write.go:74） | `API_GO_CRAWL_TASK_WRITE_MODE`（默认 legacy，config.go:3918） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_task_write_routes.go:35`（exact；OPTIONS,POST）；`config.go:3918` |
| DELETE /api/crawl-tasks/:id | `apps/api/src/modules/crawl/crawl.controller.ts:58`（CrawlController） | `WithCrawlTaskWrite` → `internal/crawltaskwrite`（cmd/api/crawl_task_write.go:74） | `API_GO_CRAWL_TASK_WRITE_MODE`（默认 legacy，config.go:3918） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_task_write_routes.go:33`（one-segment；DELETE,OPTIONS）；`config.go:3918` |
| GET /api/crawl-tasks/:id | `apps/api/src/modules/crawl/crawl.controller.ts:32`（CrawlController） | `WithCrawlReadTelemetry` → `internal/crawlreadtelemetry`（cmd/api/crawl_read_telemetry.go:55） | `API_GO_CRAWL_READ_TELEMETRY_MODE`（默认 legacy，config.go:3900） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go:46`（one-segment；GET,OPTIONS）；`config.go:3900` |
| POST /api/crawl-tasks/:id/retry | `apps/api/src/modules/crawl/crawl.controller.ts:65`（CrawlController） | `WithCrawlTaskWrite` → `internal/crawltaskwrite`（cmd/api/crawl_task_write.go:74） | `API_GO_CRAWL_TASK_WRITE_MODE`（默认 legacy，config.go:3918） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_task_write_routes.go:31`（one-segment；OPTIONS,POST）；`config.go:3918` |
| POST /api/crawl-tasks/metadata | `apps/api/src/modules/crawl/crawl.controller.ts:77`（CrawlController） | `WithCrawlMetadata` → `internal/crawlmetadata`（cmd/api/crawl_metadata.go:33） | `API_GO_CRAWL_METADATA_MODE`（默认 legacy，config.go:3910） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_metadata_routes.go:22`（exact；OPTIONS,POST）；`config.go:3910` |

> 本域 72 条：A 72、B 0、C 0。

#### news（聚合、指标、聚类）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/news-aggregator/domestic-opinion-index | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:113`（NewsAggregatorController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:45`（exact；GET,OPTIONS）；`config.go:3868` |
| GET /api/news-aggregator/hottest-analysis | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:99`（NewsAggregatorController） | `WithNewsnowHottest` → `internal/newsnowhottest`（cmd/api/newsnow_hottest.go:122） | `API_GO_NEWSNOW_HOTTEST_MODE`（默认 legacy，config.go:3876） | 无感（仅 env.schema.ts:185 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/newsnow_hottest_routes.go:25`（exact；GET,OPTIONS）；`config.go:3876` |
| GET /api/news-aggregator/metadata | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:86`（NewsAggregatorController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:42`（exact；GET,OPTIONS）；`config.go:3868` |
| GET /api/news-aggregator/recommended | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:124`（NewsAggregatorController） | `WithNewsnowHottest` → `internal/newsnowhottest`（cmd/api/newsnow_hottest.go:122） | `API_GO_NEWSNOW_HOTTEST_MODE`（默认 legacy，config.go:3876） | 无感（仅 env.schema.ts:185 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/newsnow_hottest_routes.go:26`（exact；GET,OPTIONS）；`config.go:3876` |
| GET /api/news-aggregator/resolve | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:92`（NewsAggregatorController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:43`（exact；GET,OPTIONS）；`config.go:3868` |
| GET /api/news-aggregator/source | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:42`（NewsAggregatorController） | `WithNewsnowSources` → `internal/newsnowsources`（cmd/api/newsnow_sources.go:64） | `API_GO_NEWSNOW_SOURCES_MODE`（默认 legacy，config.go:3892） | Nest 不关闭路由；`newsnow-source-refresh.subscriber.ts:48` 在 go 时额外订阅 Redis `SOURCE_REFRESH_CHANNEL` 做实时 fanout（兼容桥，属 T1.5）。 | `apps/api-go/internal/legacyproxy/newsnow_sources_routes.go:25`（exact；GET,OPTIONS）；`config.go:3892` |
| POST /api/news-aggregator/sources/batch | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:49`（NewsAggregatorController） | `WithNewsnowSources` → `internal/newsnowsources`（cmd/api/newsnow_sources.go:64） | `API_GO_NEWSNOW_SOURCES_MODE`（默认 legacy，config.go:3892） | Nest 不关闭路由；`newsnow-source-refresh.subscriber.ts:48` 在 go 时额外订阅 Redis `SOURCE_REFRESH_CHANNEL` 做实时 fanout（兼容桥，属 T1.5）。 | `apps/api-go/internal/legacyproxy/newsnow_sources_routes.go:26`（exact；OPTIONS,POST）；`config.go:3892` |
| POST /api/news-aggregator/sources/order | `apps/api/src/modules/news-aggregator/news-aggregator.controller.ts:64`（NewsAggregatorController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:44`（exact；OPTIONS,POST）；`config.go:3868` |
| GET /api/news-indicator/associations | `apps/api/src/modules/news-indicator/news-indicator.controller.ts:28`（NewsIndicatorController） | `WithNewsIndicators` → `internal/newsindicator`（cmd/api/news_indicators.go:36） | `API_GO_NEWS_INDICATORS_MODE`（默认 legacy，config.go:3771） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/news_indicator_routes.go:24`（exact；GET,OPTIONS）；`config.go:3771` |
| GET /api/news-indicator/associations/:id | `apps/api/src/modules/news-indicator/news-indicator.controller.ts:49`（NewsIndicatorController） | `WithNewsIndicators` → `internal/newsindicator`（cmd/api/news_indicators.go:36） | `API_GO_NEWS_INDICATORS_MODE`（默认 legacy，config.go:3771） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/news_indicator_routes.go:26`（one-segment；GET,OPTIONS）；`config.go:3771` |
| POST /api/news-indicator/refresh | `apps/api/src/modules/news-indicator/news-indicator.controller.ts:64`（NewsIndicatorController） | `WithNewsIndicators` → `internal/newsindicator`（cmd/api/news_indicators.go:36） | `API_GO_NEWS_INDICATORS_MODE`（默认 legacy，config.go:3771） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/news_indicator_routes.go:25`（exact；OPTIONS,POST）；`config.go:3771` |
| GET /api/system-settings/news-events/clustering/failures | `apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts:31`（NewsEventClusteringAdminController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:50`（exact；GET,OPTIONS）；`config.go:3868` |
| POST /api/system-settings/news-events/clustering/failures/:groupId/ignore | `apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts:74`（NewsEventClusteringAdminController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:54`（one-segment；OPTIONS,POST）；`config.go:3868` |
| POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill | `apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts:65`（NewsEventClusteringAdminController） | `WithNewsClusteringLlmBackfill` → `internal/newsbackfilljobs`（cmd/api/news_backfill_jobs.go:171） | `API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE`（默认 legacy，config.go:5130） | 无感（仅 env.schema.ts:120 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/news_clustering_llm_backfill_routes.go:25`（one-segment；OPTIONS,POST）；`config.go:5130` |
| POST /api/system-settings/news-events/clustering/failures/:groupId/vector-backfill | `apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts:52`（NewsEventClusteringAdminController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:53`（one-segment；OPTIONS,POST）；`config.go:3868` |
| GET /api/system-settings/news-events/clustering/overview | `apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts:25`（NewsEventClusteringAdminController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:51`（exact；GET,OPTIONS）；`config.go:3868` |
| GET /api/system-settings/news-events/clustering/readiness | `apps/api/src/modules/news-events/news-event-clustering-admin.controller.ts:19`（NewsEventClusteringAdminController） | `WithNewsnowClusteringOps` → `internal/newsnowclusteringops`（cmd/api/newsnow_clustering_ops.go:62） | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE`（默认 legacy，config.go:3868） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go:52`（exact；GET,OPTIONS）；`config.go:3868` |

> 本域 17 条：A 17、B 0、C 0。

#### situation（态势监控）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/situation-monitor/catalog | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:224`（SituationMonitorController） | `WithSituationSignals` → `internal/situationsignals`（cmd/api/situation_signals.go:59） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（默认 legacy，config.go:4293） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_signals_routes.go:43`（exact；GET,OPTIONS）；`config.go:4293` |
| POST /api/situation-monitor/feedback | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:272`（SituationMonitorController） | `WithSituationSignals` → `internal/situationsignals`（cmd/api/situation_signals.go:59） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（默认 legacy，config.go:4293） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_signals_routes.go:44`（exact；OPTIONS,POST）；`config.go:4293` |
| GET /api/situation-monitor/insights | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:156`（SituationMonitorController） | `WithSituationInsights` → `internal/situationsignals`（cmd/api/situation_insights.go:58） | `API_GO_SITUATION_INSIGHTS_MODE`（默认 legacy，config.go:4301） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_insights_routes.go:24`（exact；GET,OPTIONS）；`config.go:4301` |
| GET /api/situation-monitor/live-hls-proxy-config | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:336`（SituationMonitorController） | `WithSituationSignals` → `internal/situationsignals`（cmd/api/situation_signals.go:59） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（默认 legacy，config.go:4293） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_signals_routes.go:48`（exact；GET,OPTIONS）；`config.go:4293` |
| GET /api/situation-monitor/monitors | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:180`（SituationMonitorController） | `WithSituationMonitors` → `internal/situationmonitors`（cmd/api/situation_monitors.go:25） | `API_GO_SITUATION_MONITORS_MODE`（默认 legacy，config.go:3674） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:362`（exact；GET,OPTIONS,POST）；`config.go:3674` |
| POST /api/situation-monitor/monitors | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:195`（SituationMonitorController） | `WithSituationMonitors` → `internal/situationmonitors`（cmd/api/situation_monitors.go:25） | `API_GO_SITUATION_MONITORS_MODE`（默认 legacy，config.go:3674） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:362`（exact；GET,OPTIONS,POST）；`config.go:3674` |
| DELETE /api/situation-monitor/monitors/:id | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:214`（SituationMonitorController） | `WithSituationMonitors` → `internal/situationmonitors`（cmd/api/situation_monitors.go:25） | `API_GO_SITUATION_MONITORS_MODE`（默认 legacy，config.go:3674） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:366`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3674` |
| PATCH /api/situation-monitor/monitors/:id | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:204`（SituationMonitorController） | `WithSituationMonitors` → `internal/situationmonitors`（cmd/api/situation_monitors.go:25） | `API_GO_SITUATION_MONITORS_MODE`（默认 legacy，config.go:3674） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:366`（one-segment；DELETE,OPTIONS,PATCH）；`config.go:3674` |
| POST /api/situation-monitor/monitors/preview | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:186`（SituationMonitorController） | `WithSituationMonitors` → `internal/situationmonitors`（cmd/api/situation_monitors.go:25） | `API_GO_SITUATION_MONITORS_MODE`（默认 legacy，config.go:3674） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:364`（exact；OPTIONS,POST）；`config.go:3674` |
| GET /api/situation-monitor/oref-alerts | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:322`（SituationMonitorController） | `WithSituationSignals` → `internal/situationsignals`（cmd/api/situation_signals.go:59） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（默认 legacy，config.go:4293） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_signals_routes.go:46`（exact；GET,OPTIONS）；`config.go:4293` |
| GET /api/situation-monitor/oref-history | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:329`（SituationMonitorController） | `WithSituationSignals` → `internal/situationsignals`（cmd/api/situation_signals.go:59） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（默认 legacy，config.go:4293） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_signals_routes.go:47`（exact；GET,OPTIONS）；`config.go:4293` |
| POST /api/situation-monitor/refresh | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:289`（SituationMonitorController） | `WithSituationRefresh` → `internal/situationsignals`（cmd/api/situation_refresh.go:76） | `API_GO_SITUATION_REFRESH_MODE`（默认 legacy，config.go:4328）；另要求 `API_GO_SITUATION_SIGNALS_WORKER_MODE=go` 与 `API_GO_NEWS_SOURCE_SCHEDULER_MODE=go`（config.go:6174-6180） | 无感（仅 env.schema.ts:976 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/situation_refresh_routes.go:31`（exact；OPTIONS,POST）；`config.go:4328` |
| GET /api/situation-monitor/refresh-runs/:refreshId | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:295`（SituationMonitorController） | `WithSituationSignals` → `internal/situationsignals`（cmd/api/situation_signals.go:59） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（默认 legacy，config.go:4293） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_signals_routes.go:51`（one-segment；GET,OPTIONS）；`config.go:4293` |
| GET /api/situation-monitor/telegram-feed | `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:308`（SituationMonitorController） | `WithSituationSignals` → `internal/situationsignals`（cmd/api/situation_signals.go:59） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（默认 legacy，config.go:4293） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_signals_routes.go:45`（exact；GET,OPTIONS）；`config.go:4293` |

> 本域 14 条：A 14、B 0、C 0。

#### economic（AkShare 经济数据）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/admin/akshare/status | `apps/api/src/modules/akshare/admin-akshare.controller.ts:117`（AdminAkshareController） | `WithEconomicData` → `internal/economicdata`（cmd/api/economic_data.go:135） | `API_GO_ECONOMIC_DATA_MODE`（默认 legacy，config.go:4634） | 无感（仅 env.schema.ts:160 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/economic_data_routes.go:23`（exact；GET,OPTIONS）；`config.go:4634` |
| POST /api/admin/akshare/upgrade | `apps/api/src/modules/akshare/admin-akshare.controller.ts:276`（AdminAkshareController） | `WithEconomicData` → `internal/economicdata`（cmd/api/economic_data.go:135） | `API_GO_ECONOMIC_DATA_MODE`（默认 legacy，config.go:4634） | 无感（仅 env.schema.ts:160 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/economic_data_routes.go:24`（exact；OPTIONS,POST）；`config.go:4634` |
| GET /api/admin/akshare/version | `apps/api/src/modules/akshare/admin-akshare.controller.ts:93`（AdminAkshareController） | `WithEconomicData` → `internal/economicdata`（cmd/api/economic_data.go:135） | `API_GO_ECONOMIC_DATA_MODE`（默认 legacy，config.go:4634） | 无感（仅 env.schema.ts:160 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/economic_data_routes.go:22`（exact；GET,OPTIONS）；`config.go:4634` |

> 本域 3 条：A 3、B 0、C 0。

#### llm-logs（LLM 请求日志）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/llm-logs | `apps/api/src/modules/news-pipeline/llm-request-log.controller.ts:185`（LlmRequestLogController） | `WithLlmLogs` → `internal/llmlogs`（cmd/api/llm_logs.go:44） | `API_GO_LLM_LOGS_MODE`（默认 legacy，config.go:3746） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_logs_routes.go:26`（exact；GET,OPTIONS）；`config.go:3746` |
| GET /api/llm-logs/export | `apps/api/src/modules/news-pipeline/llm-request-log.controller.ts:227`（LlmRequestLogController） | `WithLlmLogs` → `internal/llmlogs`（cmd/api/llm_logs.go:44） | `API_GO_LLM_LOGS_MODE`（默认 legacy，config.go:3746） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_logs_routes.go:27`（exact；GET,OPTIONS）；`config.go:3746` |
| GET /api/llm-logs/summary | `apps/api/src/modules/news-pipeline/llm-request-log.controller.ts:303`（LlmRequestLogController） | `WithLlmLogs` → `internal/llmlogs`（cmd/api/llm_logs.go:44） | `API_GO_LLM_LOGS_MODE`（默认 legacy，config.go:3746） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_logs_routes.go:28`（exact；GET,OPTIONS）；`config.go:3746` |

> 本域 3 条：A 3、B 0、C 0。

#### health（健康检查）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/healthz | `apps/api/src/modules/health/health.controller.ts:37`（HealthController） | `WithAuthenticatedHealth` → `internal/health`（cmd/api/main.go:1736） | `API_GO_HEALTHZ_MODE`（默认 legacy，config.go:3507） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:415`（exact；GET）；`config.go:3507` |
| GET /api/healthz/live | `apps/api/src/modules/health/health.controller.ts:76`（HealthController） | —（Go 处理器已注册但规则为 shadow，见 T1.7） | —（无开关，固定 shadow） | shadow：Nest 响应，Go 旁路执行比对（`proxy.go:135` 固定 `ModeShadow`） | `legacyproxy/proxy.go:135`；`cmd/api/main.go:2130`；`apps/api/src/modules/health/health.controller.ts:76` |

> 本域 2 条：A 1、B 0、C 1。

#### observability（日志、质量、遥测、metrics）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/admin/errors | `apps/api/src/modules/observability/admin-errors.controller.ts:15`（AdminErrorsController） | `WithAdminLogs` → `internal/adminlogs`（cmd/api/admin_logs.go:45） | `API_GO_ADMIN_LOGS_MODE`（默认 legacy，config.go:3755） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/admin_logs_routes.go:36`（exact；GET,OPTIONS）；`config.go:3755` |
| GET /api/admin/errors/stats | `apps/api/src/modules/observability/admin-errors.controller.ts:45`（AdminErrorsController） | `WithAdminLogs` → `internal/adminlogs`（cmd/api/admin_logs.go:45） | `API_GO_ADMIN_LOGS_MODE`（默认 legacy，config.go:3755） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/admin_logs_routes.go:35`（exact；GET,OPTIONS）；`config.go:3755` |
| GET /api/admin/logs/audit | `apps/api/src/modules/observability/admin-logs.controller.ts:193`（AdminLogsController） | `WithAdminLogs` → `internal/adminlogs`（cmd/api/admin_logs.go:45） | `API_GO_ADMIN_LOGS_MODE`（默认 legacy，config.go:3755） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/admin_logs_routes.go:34`（exact；GET,OPTIONS）；`config.go:3755` |
| GET /api/admin/logs/errors | `apps/api/src/modules/observability/admin-logs.controller.ts:142`（AdminLogsController） | `WithAdminLogs` → `internal/adminlogs`（cmd/api/admin_logs.go:45） | `API_GO_ADMIN_LOGS_MODE`（默认 legacy，config.go:3755） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/admin_logs_routes.go:33`（exact；GET,OPTIONS）；`config.go:3755` |
| GET /api/admin/logs/errors/summary | `apps/api/src/modules/observability/admin-logs.controller.ts:171`（AdminLogsController） | `WithAdminLogs` → `internal/adminlogs`（cmd/api/admin_logs.go:45） | `API_GO_ADMIN_LOGS_MODE`（默认 legacy，config.go:3755） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/admin_logs_routes.go:31`（exact；GET,OPTIONS）；`config.go:3755` |
| GET /api/admin/logs/task | `apps/api/src/modules/observability/admin-logs.controller.ts:87`（AdminLogsController） | `WithAdminLogs` → `internal/adminlogs`（cmd/api/admin_logs.go:45） | `API_GO_ADMIN_LOGS_MODE`（默认 legacy，config.go:3755） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/admin_logs_routes.go:32`（exact；GET,OPTIONS）；`config.go:3755` |
| GET /api/admin/logs/task/summary | `apps/api/src/modules/observability/admin-logs.controller.ts:118`（AdminLogsController） | `WithAdminLogs` → `internal/adminlogs`（cmd/api/admin_logs.go:45） | `API_GO_ADMIN_LOGS_MODE`（默认 legacy，config.go:3755） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/admin_logs_routes.go:30`（exact；GET,OPTIONS）；`config.go:3755` |
| POST /api/admin/quality/classification/reports | `apps/api/src/modules/observability/classification-quality.controller.ts:153`（ClassificationQualityController） | `WithClassificationReports` → `internal/classificationrssops`（cmd/api/quality_ops.go:92） | `API_GO_CLASSIFICATION_REPORTS_MODE`（默认 legacy，config.go:3796） | 无感（仅 env.schema.ts:58 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/classification_reports_routes.go:29`（exact；OPTIONS,POST）；`config.go:3796` |
| GET /api/admin/quality/classification/reports/:jobId | `apps/api/src/modules/observability/classification-quality.controller.ts:163`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:62`（one-segment；GET,OPTIONS）；`config.go:3787` |
| POST /api/admin/quality/classification/reviews/:reviewId/decision | `apps/api/src/modules/observability/classification-quality.controller.ts:72`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:60`（one-segment；OPTIONS,POST）；`config.go:3787` |
| POST /api/admin/quality/classification/reviews/batch | `apps/api/src/modules/observability/classification-quality.controller.ts:94`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:48`（exact；OPTIONS,POST）；`config.go:3787` |
| GET /api/admin/quality/classification/reviews/queue | `apps/api/src/modules/observability/classification-quality.controller.ts:56`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:47`（exact；GET,OPTIONS）；`config.go:3787` |
| POST /api/admin/quality/classification/sampling/annotations | `apps/api/src/modules/observability/classification-quality.controller.ts:134`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:50`（exact；OPTIONS,POST）；`config.go:3787` |
| POST /api/admin/quality/classification/sampling/query | `apps/api/src/modules/observability/classification-quality.controller.ts:115`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:49`（exact；OPTIONS,POST）；`config.go:3787` |
| GET /api/admin/quality/classification/sources/:sourceId/items | `apps/api/src/modules/observability/classification-quality.controller.ts:39`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:58`（one-segment；GET,OPTIONS）；`config.go:3787` |
| GET /api/admin/quality/classification/summary | `apps/api/src/modules/observability/classification-quality.controller.ts:28`（ClassificationQualityController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:46`（exact；GET,OPTIONS）；`config.go:3787` |
| GET /api/admin/quality/news-sources | `apps/api/src/modules/observability/news-source-quality.controller.ts:15`（NewsSourceQualityController） | `WithQualityOverview` → `internal/qualityoverview`（cmd/api/quality_overview.go:46） | `API_GO_QUALITY_OVERVIEW_MODE`（默认 legacy，config.go:3779） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/quality_overview_routes.go:32`（exact；GET,OPTIONS）；`config.go:3779` |
| GET /api/admin/quality/overview | `apps/api/src/modules/observability/quality-overview.controller.ts:15`（QualityOverviewController） | `WithQualityOverview` → `internal/qualityoverview`（cmd/api/quality_overview.go:46） | `API_GO_QUALITY_OVERVIEW_MODE`（默认 legacy，config.go:3779） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/quality_overview_routes.go:34`（exact；GET,OPTIONS）；`config.go:3779` |
| GET /api/admin/quality/pipeline | `apps/api/src/modules/observability/pipeline-quality.controller.ts:15`（PipelineQualityController） | `WithQualityOverview` → `internal/qualityoverview`（cmd/api/quality_overview.go:46） | `API_GO_QUALITY_OVERVIEW_MODE`（默认 legacy，config.go:3779） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/quality_overview_routes.go:33`（exact；GET,OPTIONS）；`config.go:3779` |
| POST /api/admin/quality/pipeline/replay | `apps/api/src/modules/observability/pipeline-recovery.controller.ts:47`（PipelineRecoveryController） | `WithPipelineRecoveryWrite` → `internal/pipelinerecovery`（cmd/api/nest_residual_duties.go:215） | `API_GO_PIPELINE_RECOVERY_WRITE_MODE`（默认 legacy，config.go:3836） | 无感（仅 env.schema.ts:96 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/pipeline_recovery_routes.go:46`（exact；OPTIONS,POST）；`config.go:3836` |
| POST /api/admin/quality/pipeline/rollback | `apps/api/src/modules/observability/pipeline-recovery.controller.ts:53`（PipelineRecoveryController） | `WithPipelineRecoveryWrite` → `internal/pipelinerecovery`（cmd/api/nest_residual_duties.go:215） | `API_GO_PIPELINE_RECOVERY_WRITE_MODE`（默认 legacy，config.go:3836） | 无感（仅 env.schema.ts:96 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/pipeline_recovery_routes.go:48`（exact；OPTIONS,POST）；`config.go:3836` |
| GET /api/admin/quality/pipeline/runs | `apps/api/src/modules/observability/pipeline-recovery.controller.ts:25`（PipelineRecoveryController） | `WithPipelineRecovery` → `internal/pipelinerecovery`（cmd/api/quality_ops.go:133） | `API_GO_PIPELINE_RECOVERY_MODE`（默认 legacy，config.go:3812） | 无感（仅 env.schema.ts:72 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/pipeline_recovery_routes.go:30`（exact；GET,OPTIONS）；`config.go:3812` |
| GET /api/admin/quality/task-logs | `apps/api/src/modules/observability/task-logs.controller.ts:24`（TaskLogsController） | `WithQualityOverview` → `internal/qualityoverview`（cmd/api/quality_overview.go:46） | `API_GO_QUALITY_OVERVIEW_MODE`（默认 legacy，config.go:3779） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/quality_overview_routes.go:31`（exact；GET,OPTIONS）；`config.go:3779` |
| GET /api/admin/quality/task-logs/summary | `apps/api/src/modules/observability/task-logs.controller.ts:78`（TaskLogsController） | `WithQualityOverview` → `internal/qualityoverview`（cmd/api/quality_overview.go:46） | `API_GO_QUALITY_OVERVIEW_MODE`（默认 legacy，config.go:3779） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/quality_overview_routes.go:30`（exact；GET,OPTIONS）；`config.go:3779` |
| GET /api/admin/search-telemetry/summary | `apps/api/src/modules/search-telemetry/search-telemetry-admin.controller.ts:13`（SearchTelemetryAdminController） | `WithCrawlReadTelemetry` → `internal/crawlreadtelemetry`（cmd/api/crawl_read_telemetry.go:55） | `API_GO_CRAWL_READ_TELEMETRY_MODE`（默认 legacy，config.go:3900） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go:42`（exact；GET,OPTIONS）；`config.go:3900` |
| POST /api/internal/observability/exception-events | `apps/api/src/modules/observability/internal-exception-events.controller.ts:38`（InternalExceptionEventsController） | `WithExceptionIngest` → `internal/exceptioningest`（cmd/api/exception_ingest.go:65） | `API_GO_EXCEPTION_INGEST_MODE`（默认 legacy，config.go:3763） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/exception_ingest_routes.go:30`（exact；OPTIONS,POST）；`config.go:3763` |
| GET /api/metrics | `apps/api/src/modules/observability/metrics.controller.ts:39`（MetricsController） | `WithMetrics` → `internal/metrics`（cmd/api/nest_residual_duties.go:245） | `API_GO_METRICS_MODE`（默认 legacy，config.go:3844） | 无感（仅 env.schema.ts:103 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/metrics_routes.go:19`（exact；GET,OPTIONS）；`config.go:3844` |
| POST /api/observability/exception-events/client | `apps/api/src/modules/observability/client-exception-events.controller.ts:49`（ClientExceptionEventsController） | `WithExceptionIngest` → `internal/exceptioningest`（cmd/api/exception_ingest.go:65） | `API_GO_EXCEPTION_INGEST_MODE`（默认 legacy，config.go:3763） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/exception_ingest_routes.go:28`（exact；OPTIONS,POST）；`config.go:3763` |
| POST /api/search-telemetry | `apps/api/src/modules/search-telemetry/search-telemetry.controller.ts:13`（SearchTelemetryController） | `WithCrawlReadTelemetry` → `internal/crawlreadtelemetry`（cmd/api/crawl_read_telemetry.go:55） | `API_GO_CRAWL_READ_TELEMETRY_MODE`（默认 legacy，config.go:3900） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go:43`（exact；OPTIONS,POST）；`config.go:3900` |

> 本域 29 条：A 29、B 0、C 0。

#### personal（个人订阅、摘要、公开门户）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/public-portal/channels/:topic | `apps/api/src/modules/public-portal/public-portal.controller.ts:23`（PublicPortalController） | `WithPublicPortal` → `internal/publicportal`（cmd/api/main.go:1509） | `API_GO_PUBLIC_PORTAL_MODE`（默认 legacy，config.go:3433） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:181`（one-segment；GET）；`config.go:3433` |
| GET /api/public-portal/home | `apps/api/src/modules/public-portal/public-portal.controller.ts:16`（PublicPortalController） | `WithPublicPortal` → `internal/publicportal`（cmd/api/main.go:1509） | `API_GO_PUBLIC_PORTAL_MODE`（默认 legacy，config.go:3433） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:180`（exact；GET）；`config.go:3433` |
| GET /api/public-portal/stories/id/:id | `apps/api/src/modules/public-portal/public-portal.controller.ts:34`（PublicPortalController） | `WithPublicPortal` → `internal/publicportal`（cmd/api/main.go:1509） | `API_GO_PUBLIC_PORTAL_MODE`（默认 legacy，config.go:3433） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:182`（one-segment；GET）；`config.go:3433` |
| GET /api/public-portal/stories/slug/:slug | `apps/api/src/modules/public-portal/public-portal.controller.ts:45`（PublicPortalController） | `WithPublicPortal` → `internal/publicportal`（cmd/api/main.go:1509） | `API_GO_PUBLIC_PORTAL_MODE`（默认 legacy，config.go:3433） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:183`（one-segment；GET）；`config.go:3433` |
| GET /api/user-content-subscriptions | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts:24`（UserContentSubscriptionsController） | `WithContentSubscriptions` → `internal/contentsubscriptions`（cmd/api/personal_news.go:94） | `API_GO_CONTENT_SUBSCRIPTIONS_MODE`（默认 legacy，config.go:3515） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:376`（exact；GET,OPTIONS）；`config.go:3515` |
| POST /api/user-content-subscriptions/batch-delete | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts:46`（UserContentSubscriptionsController） | `WithContentSubscriptions` → `internal/contentsubscriptions`（cmd/api/personal_news.go:94） | `API_GO_CONTENT_SUBSCRIPTIONS_MODE`（默认 legacy，config.go:3515） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:378`（exact；OPTIONS,POST）；`config.go:3515` |
| POST /api/user-content-subscriptions/batch-upsert | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts:31`（UserContentSubscriptionsController） | `WithContentSubscriptions` → `internal/contentsubscriptions`（cmd/api/personal_news.go:94） | `API_GO_CONTENT_SUBSCRIPTIONS_MODE`（默认 legacy，config.go:3515） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:377`（exact；OPTIONS,POST）；`config.go:3515` |
| GET /api/user-content-subscriptions/catalog | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts:60`（UserContentSubscriptionsController） | `WithContentSubscriptions` → `internal/contentsubscriptions`（cmd/api/personal_news.go:94） | `API_GO_CONTENT_SUBSCRIPTIONS_MODE`（默认 legacy，config.go:3515） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:379`（exact；GET,OPTIONS）；`config.go:3515` |
| POST /api/user-content-subscriptions/catalog/lookup | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts:85`（UserContentSubscriptionsController） | `WithContentSubscriptions` → `internal/contentsubscriptions`（cmd/api/personal_news.go:94） | `API_GO_CONTENT_SUBSCRIPTIONS_MODE`（默认 legacy，config.go:3515） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:381`（exact；OPTIONS,POST）；`config.go:3515` |
| GET /api/user-content-subscriptions/recommendations | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts:75`（UserContentSubscriptionsController） | `WithContentSubscriptions` → `internal/contentsubscriptions`（cmd/api/personal_news.go:94） | `API_GO_CONTENT_SUBSCRIPTIONS_MODE`（默认 legacy，config.go:3515） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:380`（exact；GET,OPTIONS）；`config.go:3515` |
| GET /api/user-content-subscriptions/related-topics | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts:100`（UserContentSubscriptionsController） | `WithContentSubscriptions` → `internal/contentsubscriptions`（cmd/api/personal_news.go:94） | `API_GO_CONTENT_SUBSCRIPTIONS_MODE`（默认 legacy，config.go:3515） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:382`（exact；GET,OPTIONS）；`config.go:3515` |
| GET /api/user-digest | `apps/api/src/modules/user-digest/user-digest.controller.ts:50`（UserDigestController） | `WithUserDigest` → `internal/userdigest`（cmd/api/personal_news.go:107） | `API_GO_USER_DIGEST_MODE`（默认 legacy，config.go:3531） | 无感（仅 env.schema.ts:34 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/proxy.go:406`（exact；GET,OPTIONS）；`config.go:3531` |
| GET /api/user-digest/delivery | `apps/api/src/modules/user-digest/user-digest.controller.ts:34`（UserDigestController） | `WithUserDigest` → `internal/userdigest`（cmd/api/personal_news.go:107） | `API_GO_USER_DIGEST_MODE`（默认 legacy，config.go:3531） | 无感（仅 env.schema.ts:34 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/proxy.go:404`（exact；GET,OPTIONS）；`config.go:3531` |
| PUT /api/user-digest/delivery | `apps/api/src/modules/user-digest/user-digest.controller.ts:41`（UserDigestController） | `WithUserDigest` → `internal/userdigest`（cmd/api/personal_news.go:107） | `API_GO_USER_DIGEST_MODE`（默认 legacy，config.go:3531） | 无感（仅 env.schema.ts:34 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/proxy.go:405`（exact；OPTIONS,PUT）；`config.go:3531` |
| GET /api/user-digest/preference | `apps/api/src/modules/user-digest/user-digest.controller.ts:21`（UserDigestController） | `WithUserDigest` → `internal/userdigest`（cmd/api/personal_news.go:107） | `API_GO_USER_DIGEST_MODE`（默认 legacy，config.go:3531） | 无感（仅 env.schema.ts:34 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/proxy.go:402`（exact；GET,OPTIONS）；`config.go:3531` |
| PUT /api/user-digest/preference | `apps/api/src/modules/user-digest/user-digest.controller.ts:28`（UserDigestController） | `WithUserDigest` → `internal/userdigest`（cmd/api/personal_news.go:107） | `API_GO_USER_DIGEST_MODE`（默认 legacy，config.go:3531） | 无感（仅 env.schema.ts:34 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/proxy.go:403`（exact；OPTIONS,PUT）；`config.go:3531` |
| POST /api/user-news-behavior | `apps/api/src/modules/user-news-behavior/user-news-behavior.controller.ts:16`（UserNewsBehaviorController） | `WithUserNewsBehavior` → `internal/newsbehavior`（cmd/api/personal_news.go:88） | `API_GO_USER_NEWS_BEHAVIOR_MODE`（默认 legacy，config.go:3523） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:391`（exact；OPTIONS,POST）；`config.go:3523` |
| DELETE /api/user-news-behavior/profile | `apps/api/src/modules/user-news-behavior/user-news-behavior.controller.ts:42`（UserNewsBehaviorController） | `WithUserNewsBehavior` → `internal/newsbehavior`（cmd/api/personal_news.go:88） | `API_GO_USER_NEWS_BEHAVIOR_MODE`（默认 legacy，config.go:3523） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:393`（exact；DELETE,OPTIONS）；`config.go:3523` |
| GET /api/user-news-behavior/profile | `apps/api/src/modules/user-news-behavior/user-news-behavior.controller.ts:36`（UserNewsBehaviorController） | `WithUserNewsBehavior` → `internal/newsbehavior`（cmd/api/personal_news.go:88） | `API_GO_USER_NEWS_BEHAVIOR_MODE`（默认 legacy，config.go:3523） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy.go:392`（exact；GET,OPTIONS）；`config.go:3523` |

> 本域 19 条：A 19、B 0、C 0。

#### settings（系统设置、模型网关、存储）

| 方法与路径 | Nest 源位置 | Go 规则/处理器 | 开关 | go 模式下 Nest 行为 | 证据(file:line) |
|---|---|---|---|---|---|
| GET /api/admin/archive-preparation/status | `apps/api/src/modules/archive/archive-preparation.controller.ts:17`（ArchivePreparationController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:50`（exact；GET,OPTIONS）；`config.go:4000` |
| GET /api/admin/settings/storage | `apps/api/src/modules/storage/storage-settings.controller.ts:20`（StorageSettingsController） | `WithInfrastructureSettings` → `internal/infrastructuresettings`（cmd/api/infrastructure_settings.go:38） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（默认 legacy，config.go:4091） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go:42`（exact；GET,OPTIONS,PATCH）；`config.go:4091` |
| PATCH /api/admin/settings/storage | `apps/api/src/modules/storage/storage-settings.controller.ts:26`（StorageSettingsController） | `WithInfrastructureSettings` → `internal/infrastructuresettings`（cmd/api/infrastructure_settings.go:38） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（默认 legacy，config.go:4091） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go:42`（exact；GET,OPTIONS,PATCH）；`config.go:4091` |
| POST /api/admin/settings/storage/test | `apps/api/src/modules/storage/storage-settings.controller.ts:35`（StorageSettingsController） | `WithStorageDiagnostics` → `internal/infrastructuresettings`（cmd/api/storage_diagnostics.go:41） | `API_GO_STORAGE_DIAGNOSTICS_MODE`（默认 legacy，config.go:4103） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/storage_diagnostics_routes.go:29`（exact；OPTIONS,POST）；`config.go:4103` |
| GET /api/internal/litellm/openai-keys | `apps/api/src/modules/system-settings/openai-keys-internal.controller.ts:32`（OpenAiKeysInternalController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:53`（exact；GET,OPTIONS）；`config.go:4053` |
| POST /api/internal/litellm/openai-keys/applied | `apps/api/src/modules/system-settings/openai-keys-internal.controller.ts:42`（OpenAiKeysInternalController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:51`（exact；OPTIONS,POST）；`config.go:4053` |
| GET /api/internal/litellm/proxy-load-balancing | `apps/api/src/modules/system-settings/openai-keys-internal.controller.ts:53`（OpenAiKeysInternalController） | `WithProxyLoadBalancing` → `internal/modelaccesssettings`（cmd/api/proxy_load_balancing.go:66） | `API_GO_PROXY_LOAD_BALANCING_MODE`（默认 legacy，config.go:4083） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy_load_balancing_routes.go:39`（exact；GET,OPTIONS）；`config.go:4083` |
| DELETE /api/system-settings/archive-preparation | `apps/api/src/modules/system-settings/archive-preparation-settings.controller.ts:33`（ArchivePreparationSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:46`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4000` |
| GET /api/system-settings/archive-preparation | `apps/api/src/modules/system-settings/archive-preparation-settings.controller.ts:18`（ArchivePreparationSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:46`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4000` |
| PUT /api/system-settings/archive-preparation | `apps/api/src/modules/system-settings/archive-preparation-settings.controller.ts:24`（ArchivePreparationSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:46`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4000` |
| DELETE /api/system-settings/assistant-quota | `apps/api/src/modules/system-settings/assistant-quota-settings.controller.ts:39`（AssistantQuotaSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:64`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| GET /api/system-settings/assistant-quota | `apps/api/src/modules/system-settings/assistant-quota-settings.controller.ts:20`（AssistantQuotaSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:64`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| PUT /api/system-settings/assistant-quota | `apps/api/src/modules/system-settings/assistant-quota-settings.controller.ts:26`（AssistantQuotaSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:64`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| DELETE /api/system-settings/assistant-safety | `apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts:57`（AssistantSafetySettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:66`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| GET /api/system-settings/assistant-safety | `apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts:24`（AssistantSafetySettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:66`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| PUT /api/system-settings/assistant-safety | `apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts:30`（AssistantSafetySettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:66`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| GET /api/system-settings/assistant-safety/diagnostics | `apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts:40`（AssistantSafetySettingsController） | `WithRuntimeDiagnostics` → `internal/runtimediagnostics`（cmd/api/settings_diagnostics.go:162） | `API_GO_RUNTIME_DIAGNOSTICS_MODE`（默认 legacy，config.go:4024） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_diagnostics_routes.go:26`（exact；GET,OPTIONS）；`config.go:4024` |
| GET /api/system-settings/assistant-safety/metrics | `apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts:46`（AssistantSafetySettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:57`（exact；GET,OPTIONS）；`config.go:4034` |
| GET /api/system-settings/audit-log | `apps/api/src/modules/system-settings/audit-log-settings.controller.ts:20`（AuditLogSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:60`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| PUT /api/system-settings/audit-log | `apps/api/src/modules/system-settings/audit-log-settings.controller.ts:27`（AuditLogSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:60`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| GET /api/system-settings/auth-cache | `apps/api/src/modules/system-settings/auth-cache-settings.controller.ts:16`（AuthCacheSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:58`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| PUT /api/system-settings/auth-cache | `apps/api/src/modules/system-settings/auth-cache-settings.controller.ts:22`（AuthCacheSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:58`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| GET /api/system-settings/email | `apps/api/src/modules/system-settings/email-settings.controller.ts:39`（EmailSettingsController） | `WithEmailSettings` → `internal/emailsettings`（cmd/api/settings_diagnostics.go:61） | `API_GO_EMAIL_SETTINGS_MODE`（默认 legacy，config.go:4008） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/email_settings_routes.go:29`（exact；GET,OPTIONS）；`config.go:4008` |
| PUT /api/system-settings/email/auth-code | `apps/api/src/modules/system-settings/email-settings.controller.ts:77`（EmailSettingsController） | `WithEmailSettings` → `internal/emailsettings`（cmd/api/settings_diagnostics.go:61） | `API_GO_EMAIL_SETTINGS_MODE`（默认 legacy，config.go:4008） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/email_settings_routes.go:27`（exact；OPTIONS,PUT）；`config.go:4008` |
| POST /api/system-settings/email/test | `apps/api/src/modules/system-settings/email-settings.controller.ts:95`（EmailSettingsController） | `WithEmailSettings` → `internal/emailsettings`（cmd/api/settings_diagnostics.go:61） | `API_GO_EMAIL_SETTINGS_MODE`（默认 legacy，config.go:4008） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/email_settings_routes.go:28`（exact；OPTIONS,POST）；`config.go:4008` |
| GET /api/system-settings/geo/nominatim | `apps/api/src/modules/system-settings/geo-nominatim-settings.controller.ts:16`（GeoNominatimSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:48`（exact；GET,OPTIONS,PUT）；`config.go:4000` |
| PUT /api/system-settings/geo/nominatim | `apps/api/src/modules/system-settings/geo-nominatim-settings.controller.ts:22`（GeoNominatimSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:48`（exact；GET,OPTIONS,PUT）；`config.go:4000` |
| POST /api/system-settings/geo/nominatim/test | `apps/api/src/modules/system-settings/geo-nominatim-test.controller.ts:14`（GeoNominatimTestController） | `WithGeocoding` → `internal/geocoding`（cmd/api/settings_diagnostics.go:102） | `API_GO_GEOCODING_MODE`（默认 legacy，config.go:4016） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/geocoding_routes.go:24`（exact；OPTIONS,POST）；`config.go:4016` |
| GET /api/system-settings/llm-gateways | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:50`（LlmGatewaySettingsController） | `WithLLMGatewayProfiles` → `internal/llmgatewayprofiles`（cmd/api/llm_gateway_profiles.go:50） | `API_GO_LLM_GATEWAY_PROFILES_MODE`（默认 legacy，config.go:4061） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go:46`（exact；GET,OPTIONS,POST）；`config.go:4061` |
| POST /api/system-settings/llm-gateways | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:56`（LlmGatewaySettingsController） | `WithLLMGatewayProfiles` → `internal/llmgatewayprofiles`（cmd/api/llm_gateway_profiles.go:50） | `API_GO_LLM_GATEWAY_PROFILES_MODE`（默认 legacy，config.go:4061） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go:46`（exact；GET,OPTIONS,POST）；`config.go:4061` |
| DELETE /api/system-settings/llm-gateways/:id | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:174`（LlmGatewaySettingsController） | `WithLLMGatewayProfiles` → `internal/llmgatewayprofiles`（cmd/api/llm_gateway_profiles.go:50） | `API_GO_LLM_GATEWAY_PROFILES_MODE`（默认 legacy，config.go:4061） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go:55`（one-segment；DELETE,OPTIONS,PUT）；`config.go:4061` |
| PUT /api/system-settings/llm-gateways/:id | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:164`（LlmGatewaySettingsController） | `WithLLMGatewayProfiles` → `internal/llmgatewayprofiles`（cmd/api/llm_gateway_profiles.go:50） | `API_GO_LLM_GATEWAY_PROFILES_MODE`（默认 legacy，config.go:4061） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go:55`（one-segment；DELETE,OPTIONS,PUT）；`config.go:4061` |
| GET /api/system-settings/llm-gateways/:id/models | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:209`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:55`（one-segment；GET,OPTIONS）；`config.go:4072` |
| GET /api/system-settings/llm-gateways/:id/proxy-health | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:215`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:59`（one-segment；GET,OPTIONS）；`config.go:4072` |
| POST /api/system-settings/llm-gateways/:id/proxy-lb-test | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:232`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:63`（one-segment；OPTIONS,POST）；`config.go:4072` |
| GET /api/system-settings/llm-gateways/:id/proxy-model-info | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:221`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:61`（one-segment；GET,OPTIONS）；`config.go:4072` |
| POST /api/system-settings/llm-gateways/:id/test | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:184`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:57`（one-segment；OPTIONS,POST）；`config.go:4072` |
| PUT /api/system-settings/llm-gateways/active | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:65`（LlmGatewaySettingsController） | `WithLLMGatewayProfiles` → `internal/llmgatewayprofiles`（cmd/api/llm_gateway_profiles.go:50） | `API_GO_LLM_GATEWAY_PROFILES_MODE`（默认 legacy，config.go:4061） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go:48`（exact；OPTIONS,PUT）；`config.go:4061` |
| PUT /api/system-settings/llm-gateways/embedding-active | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:78`（LlmGatewaySettingsController） | `WithLLMGatewayProfiles` → `internal/llmgatewayprofiles`（cmd/api/llm_gateway_profiles.go:50） | `API_GO_LLM_GATEWAY_PROFILES_MODE`（默认 legacy，config.go:4061） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go:50`（exact；OPTIONS,PUT）；`config.go:4061` |
| POST /api/system-settings/llm-gateways/models-config | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:245`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:50`（exact；OPTIONS,POST）；`config.go:4072` |
| DELETE /api/system-settings/llm-gateways/proxy-governance | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:129`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:44`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4072` |
| GET /api/system-settings/llm-gateways/proxy-governance | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:106`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:44`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4072` |
| PUT /api/system-settings/llm-gateways/proxy-governance | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:112`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:44`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4072` |
| POST /api/system-settings/llm-gateways/proxy-governance/preflight | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:121`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:46`（exact；OPTIONS,POST）；`config.go:4072` |
| POST /api/system-settings/llm-gateways/proxy-governance/rotate-key | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:135`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:48`（exact；OPTIONS,POST）；`config.go:4072` |
| DELETE /api/system-settings/llm-gateways/proxy-load-balancing | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:156`（LlmGatewaySettingsController） | `WithProxyLoadBalancing` → `internal/modelaccesssettings`（cmd/api/proxy_load_balancing.go:66） | `API_GO_PROXY_LOAD_BALANCING_MODE`（默认 legacy，config.go:4083） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy_load_balancing_routes.go:35`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4083` |
| GET /api/system-settings/llm-gateways/proxy-load-balancing | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:141`（LlmGatewaySettingsController） | `WithProxyLoadBalancing` → `internal/modelaccesssettings`（cmd/api/proxy_load_balancing.go:66） | `API_GO_PROXY_LOAD_BALANCING_MODE`（默认 legacy，config.go:4083） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy_load_balancing_routes.go:35`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4083` |
| PUT /api/system-settings/llm-gateways/proxy-load-balancing | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:147`（LlmGatewaySettingsController） | `WithProxyLoadBalancing` → `internal/modelaccesssettings`（cmd/api/proxy_load_balancing.go:66） | `API_GO_PROXY_LOAD_BALANCING_MODE`（默认 legacy，config.go:4083） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/proxy_load_balancing_routes.go:35`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4083` |
| PUT /api/system-settings/llm-gateways/rerank-active | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:92`（LlmGatewaySettingsController） | `WithLLMGatewayProfiles` → `internal/llmgatewayprofiles`（cmd/api/llm_gateway_profiles.go:50） | `API_GO_LLM_GATEWAY_PROFILES_MODE`（默认 legacy，config.go:4061） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go:52`（exact；OPTIONS,PUT）；`config.go:4061` |
| POST /api/system-settings/llm-gateways/test-config | `apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts:197`（LlmGatewaySettingsController） | `WithLLMGatewayOps` → `internal/llmgatewayops`（cmd/api/llm_gateway_ops.go:67） | `API_GO_LLM_GATEWAY_OPS_MODE`（默认 legacy，config.go:4072） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/llm_gateway_ops_routes.go:52`（exact；OPTIONS,POST）；`config.go:4072` |
| DELETE /api/system-settings/llm-request-logs | `apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts:40`（LlmRequestLogSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:70`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| GET /api/system-settings/llm-request-logs | `apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts:20`（LlmRequestLogSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:70`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| PUT /api/system-settings/llm-request-logs | `apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts:26`（LlmRequestLogSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:70`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| POST /api/system-settings/llm-request-logs/metadata-policy/reset | `apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts:49`（LlmRequestLogSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:59`（exact；OPTIONS,POST）；`config.go:4034` |
| DELETE /api/system-settings/model-service | `apps/api/src/modules/system-settings/model-service-settings.controller.ts:31`（ModelServiceSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:56`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4053` |
| GET /api/system-settings/model-service | `apps/api/src/modules/system-settings/model-service-settings.controller.ts:16`（ModelServiceSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:56`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4053` |
| PUT /api/system-settings/model-service | `apps/api/src/modules/system-settings/model-service-settings.controller.ts:22`（ModelServiceSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:56`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4053` |
| GET /api/system-settings/multi-tenant-schedulers | `apps/api/src/modules/system-settings/multi-tenant-scheduler-settings.controller.ts:18`（MultiTenantSchedulerSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:62`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| PUT /api/system-settings/multi-tenant-schedulers | `apps/api/src/modules/system-settings/multi-tenant-scheduler-settings.controller.ts:24`（MultiTenantSchedulerSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:62`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| GET /api/system-settings/news-source-runtime-secrets | `apps/api/src/modules/system-settings/news-source-runtime-secrets.controller.ts:16`（NewsSourceRuntimeSecretsController） | `WithInfrastructureSettings` → `internal/infrastructuresettings`（cmd/api/infrastructure_settings.go:38） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（默认 legacy，config.go:4091） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go:40`（exact；GET,OPTIONS,PUT）；`config.go:4091` |
| PUT /api/system-settings/news-source-runtime-secrets | `apps/api/src/modules/system-settings/news-source-runtime-secrets.controller.ts:22`（NewsSourceRuntimeSecretsController） | `WithInfrastructureSettings` → `internal/infrastructuresettings`（cmd/api/infrastructure_settings.go:38） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（默认 legacy，config.go:4091） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go:40`（exact；GET,OPTIONS,PUT）；`config.go:4091` |
| GET /api/system-settings/news-source-scheduler | `apps/api/src/modules/system-settings/news-source-scheduler-settings.controller.ts:18`（NewsSourceSchedulerSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:64`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| PUT /api/system-settings/news-source-scheduler | `apps/api/src/modules/system-settings/news-source-scheduler-settings.controller.ts:24`（NewsSourceSchedulerSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:64`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| GET /api/system-settings/newsnow-personalization | `apps/api/src/modules/system-settings/newsnow-personalization-settings.controller.ts:18`（NewsnowPersonalizationSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:71`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| PUT /api/system-settings/newsnow-personalization | `apps/api/src/modules/system-settings/newsnow-personalization-settings.controller.ts:32`（NewsnowPersonalizationSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:71`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| GET /api/system-settings/newsnow-personalization/metrics | `apps/api/src/modules/system-settings/newsnow-personalization-settings.controller.ts:24`（NewsnowPersonalizationSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:69`（exact；GET,OPTIONS）；`config.go:3992` |
| DELETE /api/system-settings/openai-keys | `apps/api/src/modules/system-settings/openai-keys-settings.controller.ts:43`（OpenAiKeysSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:58`（exact；DELETE,GET,OPTIONS,POST,PUT）；`config.go:4053` |
| GET /api/system-settings/openai-keys | `apps/api/src/modules/system-settings/openai-keys-settings.controller.ts:16`（OpenAiKeysSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:58`（exact；DELETE,GET,OPTIONS,POST,PUT）；`config.go:4053` |
| POST /api/system-settings/openai-keys | `apps/api/src/modules/system-settings/openai-keys-settings.controller.ts:31`（OpenAiKeysSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:58`（exact；DELETE,GET,OPTIONS,POST,PUT）；`config.go:4053` |
| PUT /api/system-settings/openai-keys | `apps/api/src/modules/system-settings/openai-keys-settings.controller.ts:22`（OpenAiKeysSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:58`（exact；DELETE,GET,OPTIONS,POST,PUT）；`config.go:4053` |
| DELETE /api/system-settings/openai-keys/key/:fingerprint | `apps/api/src/modules/system-settings/openai-keys-settings.controller.ts:37`（OpenAiKeysSettingsController） | `WithModelAccessSettings` → `internal/modelaccesssettings`（cmd/api/model_access_settings.go:66） | `API_GO_MODEL_ACCESS_SETTINGS_MODE`（默认 legacy，config.go:4053） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/model_access_settings_routes.go:61`（one-segment；DELETE,OPTIONS）；`config.go:4053` |
| GET /api/system-settings/rate-limit-policies | `apps/api/src/modules/system-settings/rate-limit-policy.controller.ts:16`（RateLimitPolicyController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:54`（exact；GET,OPTIONS,POST）；`config.go:3992` |
| POST /api/system-settings/rate-limit-policies | `apps/api/src/modules/system-settings/rate-limit-policy.controller.ts:32`（RateLimitPolicyController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:54`（exact；GET,OPTIONS,POST）；`config.go:3992` |
| DELETE /api/system-settings/rate-limit-policies/:feature | `apps/api/src/modules/system-settings/rate-limit-policy.controller.ts:52`（RateLimitPolicyController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:76`（one-segment；DELETE,GET,OPTIONS,PUT）；`config.go:3992` |
| GET /api/system-settings/rate-limit-policies/:feature | `apps/api/src/modules/system-settings/rate-limit-policy.controller.ts:22`（RateLimitPolicyController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:76`（one-segment；DELETE,GET,OPTIONS,PUT）；`config.go:3992` |
| PUT /api/system-settings/rate-limit-policies/:feature | `apps/api/src/modules/system-settings/rate-limit-policy.controller.ts:42`（RateLimitPolicyController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:76`（one-segment；DELETE,GET,OPTIONS,PUT）；`config.go:3992` |
| GET /api/system-settings/rate-limits | `apps/api/src/modules/system-settings/rate-limit-settings.controller.ts:16`（RateLimitSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:56`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| PUT /api/system-settings/rate-limits | `apps/api/src/modules/system-settings/rate-limit-settings.controller.ts:22`（RateLimitSettingsController） | `WithRuntimeSettings` → `internal/runtimesettings`（cmd/api/runtime_settings.go:45） | `API_GO_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:3992） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_settings_routes.go:56`（exact；GET,OPTIONS,PUT）；`config.go:3992` |
| DELETE /api/system-settings/realtime-signals | `apps/api/src/modules/system-settings/realtime-signals-settings.controller.ts:31`（RealtimeSignalsSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:44`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4000` |
| GET /api/system-settings/realtime-signals | `apps/api/src/modules/system-settings/realtime-signals-settings.controller.ts:16`（RealtimeSignalsSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:44`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4000` |
| PUT /api/system-settings/realtime-signals | `apps/api/src/modules/system-settings/realtime-signals-settings.controller.ts:22`（RealtimeSignalsSettingsController） | `WithDataRuntimeSettings` → `internal/dataruntimesettings`（cmd/api/data_runtime_settings.go:89） | `API_GO_DATA_RUNTIME_SETTINGS_MODE`（默认 legacy，config.go:4000） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go:44`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4000` |
| GET /api/system-settings/realtime-signals/runtime | `apps/api/src/modules/realtime-signals/realtime-signals-runtime.controller.ts:21`（RealtimeSignalsRuntimeController） | `WithRuntimeDiagnostics` → `internal/runtimediagnostics`（cmd/api/settings_diagnostics.go:162） | `API_GO_RUNTIME_DIAGNOSTICS_MODE`（默认 legacy，config.go:4024） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/runtime_diagnostics_routes.go:28`（exact；GET,OPTIONS）；`config.go:4024` |
| POST /api/system-settings/rss-diagnostics/backfill-source-id | `apps/api/src/modules/system-settings/rss-diagnostics.controller.ts:59`（RssDiagnosticsController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:54`（exact；OPTIONS,POST）；`config.go:3787` |
| GET /api/system-settings/rss-diagnostics/chain | `apps/api/src/modules/system-settings/rss-diagnostics.controller.ts:33`（RssDiagnosticsController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:52`（exact；GET,OPTIONS）；`config.go:3787` |
| GET /api/system-settings/rss-diagnostics/overview | `apps/api/src/modules/system-settings/rss-diagnostics.controller.ts:20`（RssDiagnosticsController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:51`（exact；GET,OPTIONS）；`config.go:3787` |
| GET /api/system-settings/rss-diagnostics/sources | `apps/api/src/modules/system-settings/rss-diagnostics.controller.ts:46`（RssDiagnosticsController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:53`（exact；GET,OPTIONS）；`config.go:3787` |
| GET /api/system-settings/rss-translation/metrics | `apps/api/src/modules/system-settings/rss-translation-metrics.controller.ts:15`（RssTranslationMetricsController） | `WithClassificationRssOps` → `internal/classificationrssops`（cmd/api/classification_rss_ops.go:61） | `API_GO_CLASSIFICATION_RSS_OPS_MODE`（默认 legacy，config.go:3787） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go:55`（exact；GET,OPTIONS）；`config.go:3787` |
| GET /api/system-settings/security | `apps/api/src/modules/system-settings/system-security-settings.controller.ts:20`（SystemSecuritySettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:62`（exact；GET,OPTIONS,PUT）；`config.go:4034` |
| PUT /api/system-settings/security | `apps/api/src/modules/system-settings/system-security-settings.controller.ts:26`（SystemSecuritySettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:62`（exact；GET,OPTIONS,PUT）；`config.go:4034` |
| DELETE /api/system-settings/situation-monitor | `apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts:95`（SituationMonitorSettingsController） | `WithSituationSettings` → `internal/situationsettings`（cmd/api/situation_settings.go:103） | `API_GO_SITUATION_SETTINGS_MODE`（默认 legacy，config.go:4309） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_settings_routes.go:30`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4309` |
| GET /api/system-settings/situation-monitor | `apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts:76`（SituationMonitorSettingsController） | `WithSituationSettings` → `internal/situationsettings`（cmd/api/situation_settings.go:103） | `API_GO_SITUATION_SETTINGS_MODE`（默认 legacy，config.go:4309） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_settings_routes.go:30`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4309` |
| PUT /api/system-settings/situation-monitor | `apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts:84`（SituationMonitorSettingsController） | `WithSituationSettings` → `internal/situationsettings`（cmd/api/situation_settings.go:103） | `API_GO_SITUATION_SETTINGS_MODE`（默认 legacy，config.go:4309） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_settings_routes.go:30`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4309` |
| POST /api/system-settings/situation-monitor/external-snapshot/refresh | `apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts:141`（SituationMonitorSettingsController） | `WithGdeltSnapshotRefresh` → `internal/gdeltsnapshot`（cmd/api/gdelt_snapshot.go:77） | `API_GO_GDELT_SNAPSHOT_REFRESH_MODE`（默认 legacy，config.go:4368） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/gdelt_snapshot_routes.go:29`（exact；OPTIONS,POST）；`config.go:4368` |
| DELETE /api/system-settings/situation-monitor/telegram-auth | `apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts:106`（SituationMonitorSettingsController） | `WithSituationSettings` → `internal/situationsettings`（cmd/api/situation_settings.go:103） | `API_GO_SITUATION_SETTINGS_MODE`（默认 legacy，config.go:4309） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/situation_settings_routes.go:29`（exact；DELETE,OPTIONS）；`config.go:4309` |
| POST /api/system-settings/situation-monitor/telegram-auth/complete | `apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts:125`（SituationMonitorSettingsController） | `WithSituationTelegramAuth` → `internal/situationsettings`（cmd/api/situation_telegram_auth.go:91） | `API_GO_SITUATION_TELEGRAM_AUTH_MODE`（默认 legacy，config.go:4336） | 无感（仅 env.schema.ts:983 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/situation_telegram_auth_routes.go:26`（exact；OPTIONS,POST）；`config.go:4336` |
| POST /api/system-settings/situation-monitor/telegram-auth/start | `apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts:114`（SituationMonitorSettingsController） | `WithSituationTelegramAuth` → `internal/situationsettings`（cmd/api/situation_telegram_auth.go:91） | `API_GO_SITUATION_TELEGRAM_AUTH_MODE`（默认 legacy，config.go:4336） | 无感（仅 env.schema.ts:983 声明；无读取分支，Controller 仍注册） | `apps/api-go/internal/legacyproxy/situation_telegram_auth_routes.go:25`（exact；OPTIONS,POST）；`config.go:4336` |
| DELETE /api/system-settings/task-logs | `apps/api/src/modules/system-settings/task-log-settings.controller.ts:37`（TaskLogSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:68`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| GET /api/system-settings/task-logs | `apps/api/src/modules/system-settings/task-log-settings.controller.ts:20`（TaskLogSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:68`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| PUT /api/system-settings/task-logs | `apps/api/src/modules/system-settings/task-log-settings.controller.ts:26`（TaskLogSettingsController） | `WithPlatformGovernanceSettings` → `internal/platformgovernance`（cmd/api/platform_governance_settings.go:60） | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（默认 legacy，config.go:4034） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go:68`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4034` |
| DELETE /api/system-settings/vector-service | `apps/api/src/modules/system-settings/vector-service-settings.controller.ts:50`（VectorServiceSettingsController） | `WithInfrastructureSettings` → `internal/infrastructuresettings`（cmd/api/infrastructure_settings.go:38） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（默认 legacy，config.go:4091） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go:38`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4091` |
| GET /api/system-settings/vector-service | `apps/api/src/modules/system-settings/vector-service-settings.controller.ts:22`（VectorServiceSettingsController） | `WithInfrastructureSettings` → `internal/infrastructuresettings`（cmd/api/infrastructure_settings.go:38） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（默认 legacy，config.go:4091） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go:38`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4091` |
| PUT /api/system-settings/vector-service | `apps/api/src/modules/system-settings/vector-service-settings.controller.ts:34`（VectorServiceSettingsController） | `WithInfrastructureSettings` → `internal/infrastructuresettings`（cmd/api/infrastructure_settings.go:38） | `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（默认 legacy，config.go:4091） | 无感（apps/api/src 无引用；Controller 仍注册，Go 接管后无流量） | `apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go:38`（exact；DELETE,GET,OPTIONS,PUT）；`config.go:4091` |
| GET /api/system-settings/vector-service/diagnostics | `apps/api/src/modules/system-settings/vector-service-settings.controller.ts:28`（VectorServiceSettingsController） | —（无 Go 规则/处理器） | —（无开关） | Nest 提供；Go 按 `/api/` 兜底规则原样代理（`legacyproxy/proxy.go:134`） | `apps/api/src/modules/system-settings/vector-service-settings.controller.ts:28`；`legacyproxy/proxy.go:134` |

> 本域 103 条：A 102、B 0、C 1。

### 2. C 类与缺口

#### 2.1 C 类 HTTP 路由（原 5 条；C-1…C-5 全部关闭）

| 方法与路径 | Nest 源位置 | Go 侧现状 | 为什么是 C | 证据(file:line) |
|---|---|---|---|---|
| GET /api/healthz/live | `apps/api/src/modules/health/health.controller.ts:76`（`getLiveness`，`@Public`，返回 `{status:"ok"}`） | **已关闭**：Go handler `internal/health.LiveHandler` 已注册（baseline `main.go:2130`），本批新增 `API_GO_HEALTHZ_LIVE_MODE`（默认 `shadow`）与 `WithHealthzLive`；`go` 时 exact GET 由 Go 响应，其他方法继续回落 `/api/` | 原只有 shadow、无开关；现由开关决定，默认行为不变 | `legacyproxy/healthz_live_routes.go`；`cmd/api/main.go`；`health.controller.ts:76` |
| POST /api/admin/crawl-frontier/runs | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:125`（`createRun`） | 已迁移（`refactor/go-crawl-frontier-writes`）：`WithCrawlFrontierWrites`（`legacyproxy/crawl_frontier_writes_routes.go`）新增 exact POST 规则，handler 在 `internal/crawlfrontierruns/`（`handler_write.go`）；创建 run 复用 `internal/crawlfrontierllm/` 导出的 `CreateFrontierRunFromProfile`（`export_frontier_writes.go`，内部调用 `learn.go:774` 的 `createRunFromProfile`） | 分类已关闭（**已在 refactor/go-crawl-frontier-writes 关闭**）；原缺口是无 Rule、无 handler。注：`internal/crawlfrontierruns` 的 `Service.CreateRun`（`strategy_run_write.go:151`）写的是 strategy-run，不是 Frontier run | Nest 源 `apps/api/src/modules/crawl/crawl-frontier.controller.ts:125`；Go 路径 `apps/api-go/internal/crawlfrontierruns/`、`apps/api-go/internal/crawlfrontierllm/` |
| POST /api/admin/crawl-frontier/nodes/retry | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:202`（`retryNodes`） | 已迁移（`refactor/go-crawl-frontier-writes`）：`WithCrawlFrontierWrites` 新增 exact POST 规则与 handler（`internal/crawlfrontierruns/handler_write.go`） | 分类已关闭（**已在 refactor/go-crawl-frontier-writes 关闭**）；原缺口是未迁移写路径 | Nest 源 `apps/api/src/modules/crawl/crawl-frontier.controller.ts:202`；Go 路径 `apps/api-go/internal/crawlfrontierruns/` |
| POST /api/admin/crawl-frontier/nodes/:id/retry | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:211`（`retryNode`） | 已迁移（`refactor/go-crawl-frontier-writes`）：`WithCrawlFrontierWrites` 新增带动态段的 exact POST 规则与 handler（`internal/crawlfrontierruns/handler_write.go`） | 分类已关闭（**已在 refactor/go-crawl-frontier-writes 关闭**）；原缺口是未迁移写路径（动态段） | Nest 源 `apps/api/src/modules/crawl/crawl-frontier.controller.ts:211`；Go 路径 `apps/api-go/internal/crawlfrontierruns/` |
| GET /api/system-settings/vector-service/diagnostics | `apps/api/src/modules/system-settings/vector-service-settings.controller.ts:28`（`getDiagnostics`） | **已关闭**：本批新增 `API_GO_VECTOR_DIAGNOSTICS_MODE`（默认 `legacy`）与 Go handler；进程级共享 `vectorclient.Health` 由 search 与 upsert 客户端共用，输出与 Nest 相同的 17 字段 | 原语义依赖 Nest 进程内计数器；现由 api-go 报告**自身进程**状态，与 Nest 的进程内语义一致（多实例可能不同） | `internal/vectorclient/health.go`；`internal/infrastructuresettings/vector_diagnostics.go`；`legacyproxy/vector_diagnostics_routes.go`；`vector-service-settings.controller.ts:28` |

#### 2.2 用户可决策的处理选项（C 类）

**C1 `/api/healthz/live`（已关闭，采用选项 1）**
- 已实现：`WithHealthzLive(mode)` + `API_GO_HEALTHZ_LIVE_MODE`（默认 `shadow`，允许 `legacy`/`go`）；`go` 时仅接管精确 `GET`，`POST`/`HEAD`/相似路径继续回落 `/api/`，回退改回 `shadow`。验证方式与阶段 6 步骤见 runbook。

**C2/C3 `POST /api/admin/crawl-frontier/runs`、`POST /api/admin/crawl-frontier/nodes/retry`、`POST /api/admin/crawl-frontier/nodes/:id/retry`（已采纳选项 1）**
- 选项 1（后续批次补 Go handler + exact POST 规则 + 独立开关）已由 `refactor/go-crawl-frontier-writes` 落地：三条写入口沿用 Nest 的 `crawl.write` 权限与默认 201 语义；规则由 `WithCrawlFrontierWrites`（`legacyproxy/crawl_frontier_writes_routes.go`）注册，handler 在 `internal/crawlfrontierruns/`，创建 run 复用 `internal/crawlfrontierllm/` 的导出实现；新开关 `API_GO_CRAWL_FRONTIER_WRITES_MODE` 默认 `legacy`，`go` 时要求 `API_GO_CRAWL_FRONTIER_RUNS_MODE=go`。C-2/C-3/C-4 分类关闭，选项 2/3 不再需要决策。

**C-3/C-4 `POST /api/admin/crawl-frontier/nodes/retry` 与 `POST /api/admin/crawl-frontier/nodes/:id/retry`（节点重试）**
- 选项 1：同 C2，阶段 2 补齐 Go handler + 两条规则（含 `nodes/:id/retry` 的动态段）。
- 选项 2：停 Nest 前把重试操作改为由 `POST /api/admin/crawl-frontier/runs/:id/cancel` 等已迁移动作替代（需产品确认）；否则明确不可用。
- 选项 3：保留 Nest 边车处理这两个 POST（与 C2 合并处置）。

**C-5 `GET /api/system-settings/vector-service/diagnostics`（已关闭，采用选项 1 的 Go 计数器实现）**
- 已实现：`API_GO_VECTOR_DIAGNOSTICS_MODE`（默认 `legacy`）；go 时 Go 进程内共享 `vectorclient.Health` 提供 `getDiagnostics()` 的 17 个字段（`snapshotAt`/`source`/`enabled`/…/`lastErrorMessage`），鉴权沿用登录 + `settings.manage`。B1 修复（upsert 共享不可用窗口）与本开关无关，回退后继续生效。

#### 2.3 缺口清单（规则/处理器交叉核对）

- **真实缺口（C）**：HTTP 域已无 C 类——C-1/C-5 由 `refactor/go-ops-entrypoints` 关闭，C-2/C-3/C-4 由 `refactor/go-crawl-frontier-writes` 关闭；C-7/C-9 不在 370 分母内，也已由 #138 关闭。
- **有 Go handler 但 legacyproxy 没有对应 go 规则**：未发现。baseline 74 个 HTTP builder 均有对应 `RegisterGoHandler`（逐条见各表“Go 规则/处理器”列）；`/api/healthz/live` 在 baseline 是“handler 已注册但规则 shadow”的特例，本批已补 `WithHealthzLive`。
- **有规则但 handler 未注册**：未发现。`main.go:848-1041` 的 78 个 `legacyproxy.With*` 调用（75 个 HTTP + GraphQL + 2 个 Socket.IO）全部有对应 handler 注册；两条 socket 路径与 `/graphql` 另有独立注册（`main.go:2689,2706,2728`），不在 HTTP 表内。
- **规则存在但方法未覆盖 Nest 路由**：未发现（按 Method 白名单与 Nest 装饰器逐一比对；仅有的额外方法是每个 Go 规则附带的 `OPTIONS`，以及 socket/GraphQL 专用路径）。
- **可本批最小修复**：无（C-1…C-5 均已落地；C-2/C-3/C-4 属新增 handler，不作为“漏一条规则”）。

#### 2.4 未核实项（不要当成已验证）

- 未启动任何服务：Go/Nest 的运行时行为、鉴权、响应体等价性均未实测；本审计只证明“路由规则与开关/处理器在源码层对齐”。
- Nest/Express 的尾斜杠匹配（默认非 strict routing）未运行验证；本表与 `routes-a.txt` 使用 Nest 契约的规范路径（无尾斜杠）。带尾斜杠的请求在 Go 侧通常不命中 exact 规则而回落 `/api/` 代理，仍由 Nest 处理。
- `@Sse` 按 Nest 语义按 GET 注册，未实测线上 `Content-Type: text/event-stream` 与断线重连行为（由 T1.7/T5 验证）。
- 动态路由冲突只按装饰器文本去重；Nest 运行时的注册顺序/覆盖行为未实测（当前无同 METHOD+路径重复，但未做运行时路由表 dump）。
- `admin/queues` 与 `/docs` 的子路径由第三方库（Bull Board/Swagger UI）决定，未逐条枚举（见 T1.7）。
- 所有开关只按源码默认值记录；部署环境实际 env 值未核实（生产入口仍指向 Nest，compose 仍在 `api-go-pilot` profile）。
- 个别 handler 包名由 `cmd/api` 注册调用与 import 推断（例如 `internal/newssourcescheduler` 同时承载 ops handler）；未逐行阅读每个 handler 的完整响应实现。

### 附录 A：77 个 builder → main.go 调用 → 开关 → handler 接线（可复核完整性；#138 新增 3 个、#139 新增 1 个 builder）

| builder | main.go 调用行 | 开关（源码默认见 §0） | Go handler 包 | handler 注册证据 |
|---|---|---|---|---|
| `WithAccountData` | `cmd/api/main.go:1033` | `API_GO_AVATAR_UPLOAD_MODE` / `API_GO_USER_DATA_EXPORT_MODE` | `internal/accountdata` | `cmd/api/account_data.go:107/110` |
| `WithAccountSecurity` | `cmd/api/main.go:1017` | `API_GO_ACCOUNT_SECURITY_MODE` | `internal/accountsecurity` | `cmd/api/account_security.go:65` |
| `WithAdminLogs` | `cmd/api/main.go:931` | `API_GO_ADMIN_LOGS_MODE` | `internal/adminlogs` | `cmd/api/admin_logs.go:45` |
| `WithAnalysisBoards` | `cmd/api/main.go:871` | `API_GO_ANALYSIS_BOARDS_MODE` | `internal/analysisboards` | `cmd/api/analysis.go:60` |
| `WithAnalysisExport` | `cmd/api/main.go:873` | `API_GO_ANALYSIS_EXPORT_MODE` | `internal/analysisexport` | `cmd/api/analysis_export.go:92` |
| `WithAnalysisThreads` | `cmd/api/main.go:872` | `API_GO_ANALYSIS_THREADS_MODE` | `internal/analysisthreads` | `cmd/api/analysis.go:54` |
| `WithAnalysisViews` | `cmd/api/main.go:870` | `API_GO_ANALYSIS_VIEWS_MODE` | `internal/analysisviews` | `cmd/api/analysis.go:49` |
| `WithArchiveReadingSearch` | `cmd/api/main.go:876` | `API_GO_ARCHIVE_READING_MODE` | `internal/archivereading` | `cmd/api/archive_reading.go:85` |
| `WithAuthFactors` | `cmd/api/main.go:1016` | `API_GO_AUTH_FACTORS_MODE` | `internal/authfactors` | `cmd/api/auth_factors.go:42` |
| `WithAuthLogin` | `cmd/api/main.go:1021` | `API_GO_AUTH_LOGIN_MODE` | `internal/authlogin` | `cmd/api/auth_login.go:79` |
| `WithAuthenticatedHealth` | `cmd/api/main.go:857` | `API_GO_HEALTHZ_MODE` | `internal/health` | `cmd/api/main.go:1736` |
| `WithClassificationReports` | `cmd/api/main.go:946` | `API_GO_CLASSIFICATION_REPORTS_MODE` | `internal/classificationrssops` | `cmd/api/quality_ops.go:92` |
| `WithClassificationRssOps` | `cmd/api/main.go:938` | `API_GO_CLASSIFICATION_RSS_OPS_MODE` | `internal/classificationrssops` | `cmd/api/classification_rss_ops.go:61` |
| `WithContentSubscriptions` | `cmd/api/main.go:858` | `API_GO_CONTENT_SUBSCRIPTIONS_MODE` | `internal/contentsubscriptions` | `cmd/api/personal_news.go:94` |
| `WithCrawlFrontierRuns` | `cmd/api/main.go:924` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` / `API_GO_CRAWL_FRONTIER_WRITES_MODE`（本批新增写开关；读规则仍由本 builder 承担） | `internal/crawlfrontierruns` | `cmd/api/crawl_frontier_runs.go:31` |
| `WithCrawlFrontierWrites` | `cmd/api/main.go:1041` | `API_GO_CRAWL_FRONTIER_WRITES_MODE` | `internal/crawlfrontierruns` | `cmd/api/crawl_frontier_writes.go` |
| `WithCrawlMetadata` | `cmd/api/main.go:927` | `API_GO_CRAWL_METADATA_MODE` | `internal/crawlmetadata` | `cmd/api/crawl_metadata.go:33` |
| `WithCrawlProfiles` | `cmd/api/main.go:923` | `API_GO_CRAWL_PROFILES_MODE` | `internal/crawlprofile` | `cmd/api/crawl_profiles.go:27` |
| `WithCrawlQueueOps` | `cmd/api/main.go:980` | `API_GO_CRAWL_QUEUE_OPS_MODE` | `internal/crawltaskwrite` | `cmd/api/crawl_task_write.go:78` |
| `WithCrawlReadTelemetry` | `cmd/api/main.go:975` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | `internal/crawlreadtelemetry` | `cmd/api/crawl_read_telemetry.go:55` |
| `WithCrawlTaskWrite` | `cmd/api/main.go:979` | `API_GO_CRAWL_TASK_WRITE_MODE` | `internal/crawltaskwrite` | `cmd/api/crawl_task_write.go:74` |
| `WithCrawlTemplates` | `cmd/api/main.go:926` | `API_GO_CRAWL_TEMPLATES_MODE` | `internal/crawltemplate` | `cmd/api/crawl_templates.go:27` |
| `WithCrawlWorkflowTrial` | `cmd/api/main.go:929` | `API_GO_CRAWL_WORKFLOW_TRIAL_MODE` | `internal/crawlstrategyruns` | `cmd/api/crawl_discovery.go:90` |
| `WithCrawlWorkflows` | `cmd/api/main.go:922` | `API_GO_CRAWL_WORKFLOWS_MODE` | `internal/crawlworkflow` | `cmd/api/crawl_workflows.go:27` |
| `WithDashboardCharts` | `cmd/api/main.go:850` | `API_GO_DASHBOARD_CHARTS_MODE` | `internal/dashboardcharts` | `cmd/api/main.go:1553` |
| `WithDashboardSpacetimeGeo` | `cmd/api/main.go:854` | `API_GO_DASHBOARD_SPACETIME_GEO_MODE` | `internal/dashboardspacetime` | `cmd/api/main.go:1680` |
| `WithDashboardSpacetimePropagation` | `cmd/api/main.go:855` | `API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE` | `internal/dashboardspacetime` | `cmd/api/main.go:1686` |
| `WithDashboardStats` | `cmd/api/main.go:849` | `API_GO_DASHBOARD_STATS_MODE` | `internal/dashboardstats` | `cmd/api/main.go:1529` |
| `WithDashboardStream` | `cmd/api/main.go:856` | `API_GO_DASHBOARD_STREAM_MODE` | `internal/dashboardstream` | `cmd/api/main.go:1701` |
| `WithDashboardWarMap` | `cmd/api/main.go:851` | `API_GO_DASHBOARD_WAR_MAP_MODE` | `internal/dashboardwarmap` | `cmd/api/main.go:1629` |
| `WithDashboardWarMapLayers` | `cmd/api/main.go:853` | `API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE` | `internal/dashboardwarmap` | `cmd/api/main.go:1639` |
| `WithDashboardWarMapTransport` | `cmd/api/main.go:852` | `API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE` | `internal/dashboardwarmap` | `cmd/api/main.go:1635` |
| `WithDataRuntimeSettings` | `cmd/api/main.go:1005` | `API_GO_DATA_RUNTIME_SETTINGS_MODE` | `internal/dataruntimesettings` | `cmd/api/data_runtime_settings.go:89` |
| `WithEconomicData` | `cmd/api/main.go:1029` | `API_GO_ECONOMIC_DATA_MODE` | `internal/economicdata` | `cmd/api/economic_data.go:135` |
| `WithEmailSettings` | `cmd/api/main.go:1010` | `API_GO_EMAIL_SETTINGS_MODE` | `internal/emailsettings` | `cmd/api/settings_diagnostics.go:61` |
| `WithExceptionIngest` | `cmd/api/main.go:935` | `API_GO_EXCEPTION_INGEST_MODE` | `internal/exceptioningest` | `cmd/api/exception_ingest.go:65` |
| `WithGdeltSnapshotRefresh` | `cmd/api/main.go:1015` | `API_GO_GDELT_SNAPSHOT_REFRESH_MODE` | `internal/gdeltsnapshot` | `cmd/api/gdelt_snapshot.go:77` |
| `WithGeocoding` | `cmd/api/main.go:1011` | `API_GO_GEOCODING_MODE` | `internal/geocoding` | `cmd/api/settings_diagnostics.go:102` |
| `WithGraphQLRead` | `cmd/api/main.go:906` | `API_GO_GRAPHQL_READ_MODE` 等复合条件（见 main.go:891-905） | `internal/graphqlread` | `cmd/api/main.go:2728` |
| `WithIdentityOnboarding` | `cmd/api/main.go:1025` | `API_GO_IDENTITY_ONBOARDING_MODE` | `internal/identityonboarding` | `cmd/api/identity_onboarding.go:61` |
| `WithInfrastructureSettings` | `cmd/api/main.go:1001` | `API_GO_INFRASTRUCTURE_SETTINGS_MODE` | `internal/infrastructuresettings` | `cmd/api/infrastructure_settings.go:38` |
| `WithItemsIngest` | `cmd/api/main.go:990` | `API_GO_ITEMS_INGEST_MODE` | `internal/itemsingest` | `cmd/api/items_ingest.go:70` |
| `WithItemsReading` | `cmd/api/main.go:987` | `API_GO_ITEMS_READING_MODE` | `internal/itemsreading` | `cmd/api/main.go:2620` |
| `WithLLMGatewayOps` | `cmd/api/main.go:996` | `API_GO_LLM_GATEWAY_OPS_MODE` | `internal/llmgatewayops` | `cmd/api/llm_gateway_ops.go:67` |
| `WithLLMGatewayProfiles` | `cmd/api/main.go:992` | `API_GO_LLM_GATEWAY_PROFILES_MODE` | `internal/llmgatewayprofiles` | `cmd/api/llm_gateway_profiles.go:50` |
| `WithLlmLogs` | `cmd/api/main.go:930` | `API_GO_LLM_LOGS_MODE` | `internal/llmlogs` | `cmd/api/llm_logs.go:44` |
| `WithMetrics` | `cmd/api/main.go:964` | `API_GO_METRICS_MODE` | `internal/metrics` | `cmd/api/nest_residual_duties.go:245` |
| `WithModelAccessSettings` | `cmd/api/main.go:991` | `API_GO_MODEL_ACCESS_SETTINGS_MODE` | `internal/modelaccesssettings` | `cmd/api/model_access_settings.go:66` |
| `WithNewsClusteringLlmBackfill` | `cmd/api/main.go:974` | `API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE` | `internal/newsbackfilljobs` | `cmd/api/news_backfill_jobs.go:171` |
| `WithNewsIndicators` | `cmd/api/main.go:936` | `API_GO_NEWS_INDICATORS_MODE` | `internal/newsindicator` | `cmd/api/news_indicators.go:36` |
| `WithNewsSourceOps` | `cmd/api/main.go:921` | `API_GO_NEWS_SOURCE_OPS_MODE` | `internal/newssourcescheduler` | `cmd/api/news_source_scheduler.go:126` |
| `WithNewsSourcePreview` | `cmd/api/main.go:928` | `API_GO_NEWS_SOURCE_PREVIEW_MODE` | `internal/crawlstrategyruns` | `cmd/api/crawl_discovery.go:75` |
| `WithNewsSources` | `cmd/api/main.go:920` | `API_GO_NEWS_SOURCES_MODE` | `internal/newssources` | `cmd/api/news_sources.go:27` |
| `WithNewsnowClusteringOps` | `cmd/api/main.go:965` | `API_GO_NEWSNOW_CLUSTERING_OPS_MODE` | `internal/newsnowclusteringops` | `cmd/api/newsnow_clustering_ops.go:62` |
| `WithNewsnowHottest` | `cmd/api/main.go:971` | `API_GO_NEWSNOW_HOTTEST_MODE` | `internal/newsnowhottest` | `cmd/api/newsnow_hottest.go:122` |
| `WithNewsnowSources` | `cmd/api/main.go:968` | `API_GO_NEWSNOW_SOURCES_MODE` | `internal/newsnowsources` | `cmd/api/newsnow_sources.go:64` |
| `WithNotificationsSocket` | `cmd/api/main.go:862` | `API_GO_NOTIFICATIONS_SOCKET_MODE` | `internal/notificationssocket` | `cmd/api/main.go:2689` |
| `WithOIDCLogin` | `cmd/api/main.go:1028` | `API_GO_OIDC_LOGIN_MODE` | `internal/oidclogin` | `cmd/api/oidc_login.go:69` |
| `WithPipelineRecovery` | `cmd/api/main.go:951` | `API_GO_PIPELINE_RECOVERY_MODE` | `internal/pipelinerecovery` | `cmd/api/quality_ops.go:133` |
| `WithPipelineRecoveryWrite` | `cmd/api/main.go:959` | `API_GO_PIPELINE_RECOVERY_WRITE_MODE` | `internal/pipelinerecovery` | `cmd/api/nest_residual_duties.go:215` |
| `WithPlatformGovernanceSettings` | `cmd/api/main.go:986` | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE` | `internal/platformgovernance` | `cmd/api/platform_governance_settings.go:60` |
| `WithProxyLoadBalancing` | `cmd/api/main.go:1000` | `API_GO_PROXY_LOAD_BALANCING_MODE` | `internal/modelaccesssettings` | `cmd/api/proxy_load_balancing.go:66` |
| `WithPublicPortal` | `cmd/api/main.go:848` | `API_GO_PUBLIC_PORTAL_MODE` | `internal/publicportal` | `cmd/api/main.go:1509` |
| `WithQualityOverview` | `cmd/api/main.go:937` | `API_GO_QUALITY_OVERVIEW_MODE` | `internal/qualityoverview` | `cmd/api/quality_overview.go:46` |
| `WithRbac` | `cmd/api/main.go:925` | `API_GO_RBAC_MODE` | `internal/rbacapi` | `cmd/api/rbac.go:29` |
| `WithRealtimeSocket` | `cmd/api/main.go:868` | `API_GO_REALTIME_SOCKET_MODE` | `internal/realtimesocket` | `cmd/api/main.go:2706` |
| `WithRuntimeDiagnostics` | `cmd/api/main.go:1012` | `API_GO_RUNTIME_DIAGNOSTICS_MODE` | `internal/runtimediagnostics` | `cmd/api/settings_diagnostics.go:162` |
| `WithRuntimeSettings` | `cmd/api/main.go:982` | `API_GO_RUNTIME_SETTINGS_MODE` | `internal/runtimesettings` | `cmd/api/runtime_settings.go:45` |
| `WithSearchReindex` | `cmd/api/main.go:981` | `API_GO_SEARCH_REINDEX_MODE` | `internal/searchreindex` | `cmd/api/search_reindex.go:58` |
| `WithSituationInsights` | `cmd/api/main.go:912` | `API_GO_SITUATION_INSIGHTS_MODE` | `internal/situationsignals` | `cmd/api/situation_insights.go:58` |
| `WithSituationMonitors` | `cmd/api/main.go:907` | `API_GO_SITUATION_MONITORS_MODE` | `internal/situationmonitors` | `cmd/api/situation_monitors.go:25` |
| `WithSituationRefresh` | `cmd/api/main.go:911` | `API_GO_SITUATION_REFRESH_MODE` | `internal/situationsignals` | `cmd/api/situation_refresh.go:76` |
| `WithSituationSettings` | `cmd/api/main.go:915` | `API_GO_SITUATION_SETTINGS_MODE` | `internal/situationsettings` | `cmd/api/situation_settings.go:103` |
| `WithSituationSignals` | `cmd/api/main.go:908` | `API_GO_SITUATION_MONITOR_SIGNALS_MODE` | `internal/situationsignals` | `cmd/api/situation_signals.go:59` |
| `WithSituationTelegramAuth` | `cmd/api/main.go:919` | `API_GO_SITUATION_TELEGRAM_AUTH_MODE` | `internal/situationsettings` | `cmd/api/situation_telegram_auth.go:91` |
| `WithStorageDiagnostics` | `cmd/api/main.go:1004` | `API_GO_STORAGE_DIAGNOSTICS_MODE` | `internal/infrastructuresettings` | `cmd/api/storage_diagnostics.go:41` |
| `WithUserDigest` | `cmd/api/main.go:860` | `API_GO_USER_DIGEST_MODE` | `internal/userdigest` | `cmd/api/personal_news.go:107` |
| `WithUserNewsBehavior` | `cmd/api/main.go:859` | `API_GO_USER_NEWS_BEHAVIOR_MODE` | `internal/newsbehavior` | `cmd/api/personal_news.go:88` |

> `WithNotificationsSocket` / `WithRealtimeSocket` / `WithGraphQLRead` 不是 HTTP 路由 builder（分别归 T1.3/T1.2），列在此处仅为核对 78 个调用的完整性。`WithAccountData` 一个 builder 承载两条独立开关的 auth 路由。

---

## 3. GraphQL 根字段执行权（T1.2）

<!-- 合并自 T1.2 GraphQL 审计（task-2 产出）；原文，仅调整标题层级。 -->


> 基线：`dcbe563b917fde0927637121a91de2186d6177a4`（worktree `docs/go-cutover-readiness`）。
> 本文为静态审计，未运行 `go build`/`go test`/`pnpm`/Docker/服务；行号均来自基线提交（`git show dcbe563b:…` 核对，见文末「行号口径」）。

### 0. 结论摘要

| 项 | Query | Mutation | Subscription | 合计 |
|---|---:|---:|---:|---:|
| SDL 根字段分母 | **77** | **57** | **4** | **138** |
| A（已注册且开关可 go） | 77 | 57 | 4 | 138 |
| C（未注册 / 只能 Nest 执行） | 0 | 0 | 0 | 0 |

- 当前代码中 **每一个 SDL 根字段都有对应的 Go `RegisterRoot`/`RegisterMutation`/`RegisterSubscription` 注册点**，且注册点在 `cmd/api/main.go` 的开关分支内可达；因此按本任务的 A/C 定义，C=0。
- 4 个 GraphQL Subscription 根 **全部已注册**（`alertEvents`/`analysisEvents`/`assistantEvents`/`queueEvents`），由 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go` 接管 graphql-transport-ws upgrade；硬性依赖 `GRAPHQL_SUBSCRIPTION_BUS=redis`（Go 侧组合校验失败，见 §5；Nest 只校验该变量枚举）。
- `/graphql` 的 **路由** 是「任一相关开关为 go」的 OR；每个根的 **注册** 是「父开关 AND 子开关」或独立写开关。两者不是同一个条件，见 §2。
- 未选中的整份 document（根未注册、选择集含未实现字段/特性）由 Go **整份转发 Nest**，不做半本地半远端执行；已注册且可执行的根不会到达 Nest。
- 迁移地图 README 的旧快照「Go 注册 71 Query / 21 Mutation / 0 Subscription」与当前代码不符（当前 77/57/4）；该快照是历史时点，本文以代码为准，详见 §7。

### 1. 统计口径

1. **权威分母 = SDL**：`apps/api/schema.gql` 的 `type Query`（第 2307 行）、`type Mutation`（第 1583 行）、`type Subscription`（第 2571 行）字段行；文件无 `extend type Query/Mutation/Subscription`。得到 77/57/4。
2. **Go 侧 SDL 副本一致**：`apps/api-go/internal/graphqlread/schema/schema.gql` 与 `apps/api/schema.gql` 均 2925 行、字节一致（`cmp` 无差异）；Go 用 `//go:embed schema.gql` + `gqlparser.LoadSchema` 加载（`apps/api-go/internal/graphqlread/schema/schema.go:22-39`）。Nest 以 `autoSchemaFile: apps/api/schema.gql` 生成（`apps/api/src/graphql/graphql.module.ts:352`）。
3. **Nest code-first 交叉核对**：在 `apps/api/src/graphql/resolvers/*.ts` 中解析 `@Query(() => …)`、`@Mutation(() => …)`、`@Subscription(() => …, { name })` 并取方法名/`name` 覆盖，得到 77/57/4 个根字段，与 SDL 名字集合**逐项相等**（无 SDL 有而装饰器无、也无装饰器有而 SDL 无的项）。
   - **注意统计陷阱**：全仓 `grep -c '@Query('` 为 236，其中 **159 个是 REST 参数装饰器 `@Query()`**（来自 `@nestjs/common`），与 GraphQL 根字段无关；GraphQL 的 `@Query(() =>` 恰为 77。`@Mutation` 57、`@Subscription` 4 无此污染。
   - code-first 中一个装饰器对应一个根字段（本仓没有「一个方法返回多个根字段」的写法）；4 个 Subscription 通过 `name:` 覆盖方法名：`alertEventsSubscription`→`alertEvents`（`apps/api/src/graphql/resolvers/alerts.resolver.ts:276-282`）、`analysisEventsSubscription`→`analysisEvents`（`analysis.resolver.ts:128-134`）、`assistantEventsSubscription`→`assistantEvents`（`assistant.resolver.ts:200-206`）、`queueEventsSubscription`→`queueEvents`（`dashboard.resolver.ts:142-148`）。
4. **Go 注册口径**：只统计非测试的 `reg.RegisterRoot/RegisterMutation/RegisterSubscription` 调用（`apps/api-go/internal/graphqlread/**` 与 `apps/api-go/internal/graphqlsubscriptions/handler.go`）。测试里的假 root 不计；注册名唯一（77/57/4 个注册 = 77/57/4 个唯一名）。
5. **A/C 定义按任务**：A=已注册且存在可把该根置为 go 的 `API_GO_*` 开关；C=未注册或只能 Nest 执行。A 只说明「执行权可切给 Go」，不声明运行期/业务完整性；已知实现缺口单列 §6。

### 2. 路由、注册与整份回退（决定「go 模式下 Nest 行为」的机制）

#### 2.1 `/graphql` 是否交给 Go：OR

- `apps/api-go/cmd/api/main.go:891-906` 计算 `graphqlRouteMode`：`API_GO_GRAPHQL_READ_MODE`、`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE`、`API_GO_GRAPHQL_WORKSPACE_WRITE_MODE`、`API_GO_GRAPHQL_SETTINGS_WRITE_MODE`、`API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE`、`API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE`、`API_GO_GRAPHQL_RSS_TRANSLATION_MODE`、`API_GO_ITEMS_INGEST_MODE`、`API_GO_ARCHIVE_READING_MODE`、`API_GO_ECONOMIC_DATA_MODE`、`API_GO_GRAPHQL_ALERT_RULES_MODE`、`API_GO_CRAWL_TASK_WRITE_MODE`、`API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE`、`API_GO_GRAPHQL_ASSISTANT_WRITE_MODE`、`API_GO_ANALYSIS_RUNS_MODE`、`API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` **任一为 go**，则 `/graphql` 精确 GET/POST/OPTIONS 交给 Go（`legacyproxy.WithGraphQLRead`，`apps/api-go/internal/legacyproxy/proxy.go:432-448`；默认 `/graphql` legacy 规则见 `apps/api-go/internal/legacyproxy/proxy.go:145`）。
- **子读开关本身不在 OR 里**（`API_GO_GRAPHQL_WORKSPACE_READ_MODE`、`API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE`、`API_GO_GRAPHQL_NEWS_EVENTS_MODE`、`API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE`、`API_GO_GRAPHQL_KG_IMPACT_MODE`、`API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE`、`API_GO_NEWS_INDICATORS_MODE`、`API_GO_ITEMS_LIST_MODE`、`API_GO_GRAPHQL_CRAWL_METADATA_MODE`）。只设子开关为 go 且总读为 legacy 时：`/graphql` 仍走 Nest，子开关静默无效（`GRAPHQL_CRAWL_METADATA`、`GRAPHQL_ITEMS_LIST`、`NEWS_EVENT_BRIEF` 例外，config.go 会启动失败，见 §5）。
- 只有 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go` 时也会把 `/graphql` 路由到 Go（`apps/api-go/cmd/api/main.go:903`），但 Go 只处理合法 WebSocket upgrade；HTTP GET/POST/OPTIONS 因 `graphqlHandler==nil` 直接 `ServeLegacy` 回溯 Nest（`apps/api-go/cmd/api/graphql_subscriptions.go:65-82`）。

#### 2.2 注册条件：读=AND；写=独立

- 读根：`apps/api-go/cmd/api/main.go:2211` 的 `if graphqlReadGo` 内注册 alerts/history/economic 等基础根；其余读域在 `graphqlReadGo` 内再叠加子开关（`apps/api-go/cmd/api/main.go:2209-2210` 的 `workspaceGo`/`settingsCrawlGo`，以及 `2245/2249/2253/2257/2270/2273/2299/2304`）。即 **父读开关 AND 子开关**。
- 写根：`apps/api-go/cmd/api/main.go:2311`（items 写）、`2325`（经济写）、`2342`（组织写）、`2349`（Assistant 写）、`2355`（工作台写）、`2371`（告警规则）、`2381`（设置写）、`2395`（采集任务写）、`2406`（新闻指标刷新）、`2413`（来源策略写）、`2423`（知识复核）、`2431`（RSS 翻译）、`2455`（分析运行）各自 `if` 独立，**不需要** `API_GO_GRAPHQL_READ_MODE=go`（除个别模型注册复用外）。
- 模型注册只发生一次的分支（`workspaceModelsRegistered`、`RegisterSettingsModelTypes` 等）只影响类型集合，不影响根的 go 能力；详见 `apps/api-go/cmd/api/main.go:2335-2424` 注释。

#### 2.3 整份 operation 回退（不是按字段回退）

- 根未注册（`e.rootDefinition(op)==nil`）→ `KindLegacy`：`apps/api-go/internal/graphqlread/exec/engine.go:126-135`；选择集含未支持特性（`operationSupported` false）→ `KindLegacy`：`apps/api-go/internal/graphqlread/exec/engine.go:109-120`；`apps/api-go/internal/graphqlread/handler.go:179-185` 对 `KindLegacy` 直接 `h.forward`（`apps/api-go/internal/graphqlread/handler.go:50` 的 `Legacy` 回调 = `gateway.ServeLegacy`，`apps/api-go/cmd/api/main.go:2476` 注入）。
- 因此：**一个 document 只要选中任一未注册根或未支持的字段/特性，整份请求原样到 Nest**；反之，一个已注册根且选择集受支持的 document 完全由 Go 执行，Nest 不参与。前端/测试要按「整份 document」构造，不能假设按字段混合执行。
- 解析失败/变量强转失败属于 Go 直接返回协议错误（`KindProtocol`），不转发；这与「未实现」不同（`apps/api-go/internal/graphqlread/exec/engine.go:100-103/149-154`）。
- **A 类只代表根已注册**：即使根已注册，某个具体 document 的选择集仍可能触发 `operationSupported=false`（例如选中未实现的字段/参数/指令），从而整份回退 Nest。切流验证必须使用真实前端 document，而不能只按根名判断。

#### 2.4 Subscription 的 transport 分流

- Go 只接管 `GET` 精确 `/graphql`、`Upgrade: websocket`、`Sec-WebSocket-Protocol` 含 `graphql-transport-ws` 的请求（`apps/api-go/internal/graphqlsubscriptions/handler.go:149-160`）；其余 upgrade/方法继续读处理器或 legacy 代理（`cmd/api/graphql_subscriptions.go:71-82`）。
- 同一连接上的 Query/Mutation、未注册订阅根、未支持选择集 → `PlanSubscription` 返回 `KindLegacy`，按原 payload 整份转发 Nest 的 graphql-ws upstream（`graphqlread/exec/subscription.go:35-44/43-44`；`graphqlsubscriptions/connection.go:456-464` 懒建 upstream）。
- Go 侧与 Nest 侧都从 Redis `gqlsub:<root>` 读/写事件（Nest：`apps/api/src/modules/graphql-subscriptions/graphql-subscription-bus.ts:10/247-249`；Go：`apps/api-go/internal/graphqlsubscriptions/bus.go:15/127`）；`queueEvents` 例外，由 Go 每进程直接只读 BullMQ stream（`apps/api-go/internal/graphqlsubscriptions/queue.go:61` 的 `XREAD`）。

#### 2.5 go 模式下 Nest 的行为（表内 N1/N2 的图例）

- **N1（Query/Mutation）**：Nest **不读取任何 GraphQL 根执行开关**，所有 resolver 照旧注册；Go 命中并执行时 Nest 不参与；只有整份 document 回退时 Nest 才执行。Nest 侧 `API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE`、`API_GO_ANALYSIS_RUNS_MODE` 只出现在 `env.schema.ts`/未使用的 getter，不改变 resolver 行为（`apps/api/src/modules/config/env.schema.ts:144`、`apps/api/src/modules/config/config.service.ts:1300-1308`；全仓无调用）。
- **N2（Subscription）**：Nest 的 graphql-ws 订阅服务器仍启用（`GRAPHQL_SUBSCRIPTIONS_ENABLED` 默认 true，`apps/api/src/modules/config/config.service.ts:477-479`；Nest 侧无 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` 读取）；合法 upgrade 被 Go 拦截后 Nest 看不到该连接；同一连接上的非本批 operation 由 Go 整份转发到 Nest upstream 执行。
- 由 N1/N2 可推出：**切换 GraphQL 读/写开关不会让 Nest 停止服务任何根**；Nest 仍必须运行以承接整份回退和未迁移的 HTTP/Socket 流量，直到阶段 6。

### 3. 分域根字段表（逐字段证据）

> 列口径：Nest 源位置省略前缀 `apps/api/src/graphql/`；Go 注册包省略前缀 `apps/api-go/internal/graphqlread/`；Subscription 的 Go 注册写全路径（不在 graphqlread 下）。「开关」＝使该根被注册的开关组合；`∧` 表示同时为 go。证据列给出 SDL 行与 `main.go` 注册条件/调用行。

#### 告警（alerts）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `alertChannels` | Query | `resolvers/alerts.resolver.ts:29` | `alerts/register.go:22` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2308`; `apps/api-go/cmd/api/main.go:2224` |
| `alertEventReplay` | Query | `resolvers/alerts.resolver.ts:105` | `alerts/register.go:37` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2309`; `apps/api-go/cmd/api/main.go:2224` |
| `alertEvents` | Query | `resolvers/alerts.resolver.ts:90` | `alerts/register.go:29` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2310`; `apps/api-go/cmd/api/main.go:2224` |
| `alertRuleTuningSuggestion` | Query | `resolvers/alerts.resolver.ts:119` | `alerts/register.go:49` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2311`; `apps/api-go/cmd/api/main.go:2224` |
| `alertRules` | Query | `resolvers/alerts.resolver.ts:49` | `alerts/rules_register.go:45` | `API_GO_GRAPHQL_ALERT_RULES_MODE` | N1 | A | `apps/api/schema.gql:2312`; `apps/api-go/cmd/api/main.go:2375` |
| `upsertAlertRule` | Mutation | `resolvers/alerts.resolver.ts:133` | `alerts/rules_register.go:50` | `API_GO_GRAPHQL_ALERT_RULES_MODE` | N1 | A | `apps/api/schema.gql:1639`; `apps/api-go/cmd/api/main.go:2375` |
| `deleteAlertRule` | Mutation | `resolvers/alerts.resolver.ts:182` | `alerts/rules_register.go:55` | `API_GO_GRAPHQL_ALERT_RULES_MODE` | N1 | A | `apps/api/schema.gql:1592`; `apps/api-go/cmd/api/main.go:2375` |
| `triggerAlertRule` | Mutation | `resolvers/alerts.resolver.ts:248` | `alerts/rules_register.go:60` | `API_GO_GRAPHQL_ALERT_RULES_MODE` | N1 | A | `apps/api/schema.gql:1613`; `apps/api-go/cmd/api/main.go:2375` |

#### 身份与组织（workspace / org-access-write）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `me` | Query | `resolvers/user.resolver.ts:58` | `workspace/register.go:44` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2362`; `apps/api-go/cmd/api/main.go:2260` |
| `myOrganizations` | Query | `resolvers/org.resolver.ts:19` | `workspace/register.go:45` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2364`; `apps/api-go/cmd/api/main.go:2260` |
| `users` | Query | `resolvers/user.resolver.ts:73` | `workspace/register.go:46` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2394`; `apps/api-go/cmd/api/main.go:2260` |
| `userLoginRecords` | Query | `resolvers/user.resolver.ts:142` | `workspace/register.go:47` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2393`; `apps/api-go/cmd/api/main.go:2260` |
| `roles` | Query | `resolvers/rbac.resolver.ts:83` | `workspace/register.go:48` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2386`; `apps/api-go/cmd/api/main.go:2260` |
| `permissions` | Query | `resolvers/rbac.resolver.ts:100` | `workspace/register.go:49` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2382`; `apps/api-go/cmd/api/main.go:2260` |
| `memberships` | Query | `resolvers/rbac.resolver.ts:111` | `workspace/register.go:50` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2363`; `apps/api-go/cmd/api/main.go:2260` |
| `createOrg` | Mutation | `resolvers/org.resolver.ts:31` | `orgaccesswrite/register.go:37` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1589`; `apps/api-go/cmd/api/main.go:2343` |
| `updateOrg` | Mutation | `resolvers/org.resolver.ts:41` | `orgaccesswrite/register.go:38` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1636`; `apps/api-go/cmd/api/main.go:2343` |
| `setOrgActive` | Mutation | `resolvers/org.resolver.ts:51` | `orgaccesswrite/register.go:39` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1610`; `apps/api-go/cmd/api/main.go:2343` |
| `createRole` | Mutation | `resolvers/rbac.resolver.ts:124` | `orgaccesswrite/register.go:40` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1590`; `apps/api-go/cmd/api/main.go:2343` |
| `updateRole` | Mutation | `resolvers/rbac.resolver.ts:163` | `orgaccesswrite/register.go:41` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1638`; `apps/api-go/cmd/api/main.go:2343` |
| `assignRole` | Mutation | `resolvers/rbac.resolver.ts:145` | `orgaccesswrite/register.go:42` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1584`; `apps/api-go/cmd/api/main.go:2343` |
| `updateMembershipRoles` | Mutation | `resolvers/user.resolver.ts:162` | `orgaccesswrite/register.go:43` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1627`; `apps/api-go/cmd/api/main.go:2343` |
| `setUserActive` | Mutation | `resolvers/user.resolver.ts:214` | `orgaccesswrite/register.go:44` | `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1611`; `apps/api-go/cmd/api/main.go:2343` |

#### 看板、通知与情绪序列（history / workspace / workspace-write）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `dashboards` | Query | `resolvers/dashboard.resolver.ts:23` | `workspace/register.go:51` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2328`; `apps/api-go/cmd/api/main.go:2260` |
| `queueStats` | Query | `resolvers/dashboard.resolver.ts:109` | `workspace/register.go:52` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2384`; `apps/api-go/cmd/api/main.go:2260` |
| `entitySentimentSeries` | Query | `resolvers/sentiment.resolver.ts:18` | `workspace/register.go:53` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2338`; `apps/api-go/cmd/api/main.go:2260` |
| `topicSentimentSeries` | Query | `resolvers/sentiment.resolver.ts:34` | `workspace/register.go:54` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2391`; `apps/api-go/cmd/api/main.go:2260` |
| `processedItemById` | Query | `resolvers/processed-item.resolver.ts:92` | `workspace/register.go:55` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_WORKSPACE_READ_MODE` | N1 | A | `apps/api/schema.gql:2383`; `apps/api-go/cmd/api/main.go:2260` |
| `notifications` | Query | `resolvers/notification.resolver.ts:19` | `history/register.go:54` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2381`; `apps/api-go/cmd/api/main.go:2225` |
| `unreadNotificationCount` | Query | `resolvers/notification.resolver.ts:34` | `history/register.go:59` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2392`; `apps/api-go/cmd/api/main.go:2225` |
| `markNotificationRead` | Mutation | `resolvers/notification.resolver.ts:44` | `workspacewrite/register.go:27` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1598`; `apps/api-go/cmd/api/main.go:2364` |
| `markAllNotificationsRead` | Mutation | `resolvers/notification.resolver.ts:58` | `workspacewrite/register.go:32` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1597`; `apps/api-go/cmd/api/main.go:2364` |
| `upsertDashboard` | Mutation | `resolvers/dashboard.resolver.ts:58` | `workspacewrite/register.go:37` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1640`; `apps/api-go/cmd/api/main.go:2364` |
| `deleteDashboard` | Mutation | `resolvers/dashboard.resolver.ts:99` | `workspacewrite/register.go:42` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1595`; `apps/api-go/cmd/api/main.go:2364` |
| `createAlertChannel` | Mutation | `resolvers/alerts.resolver.ts:192` | `workspacewrite/register.go:47` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1585`; `apps/api-go/cmd/api/main.go:2364` |
| `updateAlertChannel` | Mutation | `resolvers/alerts.resolver.ts:215` | `workspacewrite/register.go:52` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1616`; `apps/api-go/cmd/api/main.go:2364` |
| `deleteAlertChannel` | Mutation | `resolvers/alerts.resolver.ts:238` | `workspacewrite/register.go:57` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1591`; `apps/api-go/cmd/api/main.go:2364` |
| `updateAlertEventStatus` | Mutation | `resolvers/alerts.resolver.ts:262` | `workspacewrite/register.go:62` | `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1617`; `apps/api-go/cmd/api/main.go:2364` |

#### 分析与 Assistant（history / analysis-runs / assistant-write）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `analysisResults` | Query | `resolvers/analysis.resolver.ts:30` | `history/register.go:34` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2313`; `apps/api-go/cmd/api/main.go:2225` |
| `assistantRuns` | Query | `resolvers/assistant.resolver.ts:32` | `history/register.go:39` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2319`; `apps/api-go/cmd/api/main.go:2225` |
| `assistantEconomicSeriesSuggestions` | Query | `resolvers/assistant.resolver.ts:56` | `history/register.go:44` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2318`; `apps/api-go/cmd/api/main.go:2225` |
| `assistantRuntimeCapabilities` | Query | `resolvers/assistant.resolver.ts:89` | `history/register.go:49` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2320`; `apps/api-go/cmd/api/main.go:2225` |
| `requestCorrelationAnalysis` | Mutation | `resolvers/analysis.resolver.ts:53` | `analysisruns/register.go:40` | `API_GO_ANALYSIS_RUNS_MODE` | N1 | A | `apps/api/schema.gql:1604`; `apps/api-go/cmd/api/main.go:2468` |
| `requestAnomalyExplanation` | Mutation | `resolvers/analysis.resolver.ts:74` | `analysisruns/register.go:45` | `API_GO_ANALYSIS_RUNS_MODE` | N1 | A | `apps/api/schema.gql:1600`; `apps/api-go/cmd/api/main.go:2468` |
| `requestGeoTransportAnalysis` | Mutation | `resolvers/analysis.resolver.ts:95` | `analysisruns/register.go:50` | `API_GO_ANALYSIS_RUNS_MODE` | N1 | A | `apps/api/schema.gql:1605`; `apps/api-go/cmd/api/main.go:2468` |
| `requestAssistantQuery` | Mutation | `resolvers/assistant.resolver.ts:111` | `assistantwrite/register.go:20` | `API_GO_GRAPHQL_ASSISTANT_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1602`; `apps/api-go/cmd/api/main.go:2353` |
| `requestAssistantReport` | Mutation | `resolvers/assistant.resolver.ts:135` | `assistantwrite/register.go:25` | `API_GO_GRAPHQL_ASSISTANT_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1603`; `apps/api-go/cmd/api/main.go:2353` |
| `requestAssistantForecast` | Mutation | `resolvers/assistant.resolver.ts:158` | `assistantwrite/register.go:30` | `API_GO_GRAPHQL_ASSISTANT_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1601`; `apps/api-go/cmd/api/main.go:2353` |
| `deleteAssistantRun` | Mutation | `resolvers/assistant.resolver.ts:181` | `assistantwrite/register.go:35` | `API_GO_GRAPHQL_ASSISTANT_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1593`; `apps/api-go/cmd/api/main.go:2353` |

#### 归档阅读（archivereading）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `archiveDigest` | Query | `resolvers/archive.resolver.ts:27` | `archivereading/register.go:37` | `API_GO_ARCHIVE_READING_MODE` | N1 | A | `apps/api/schema.gql:2316`; `apps/api-go/cmd/api/main.go:2204` |
| `archiveCalendar` | Query | `resolvers/archive.resolver.ts:37` | `archivereading/register.go:38` | `API_GO_ARCHIVE_READING_MODE` | N1 | A | `apps/api/schema.gql:2314`; `apps/api-go/cmd/api/main.go:2204` |
| `archiveDetail` | Query | `resolvers/archive.resolver.ts:47` | `archivereading/register.go:39` | `API_GO_ARCHIVE_READING_MODE` | N1 | A | `apps/api/schema.gql:2315`; `apps/api-go/cmd/api/main.go:2204` |

#### 采集（crawlmetadata / settingscrawl / crawltaskwrite）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `crawlMetadata` | Query | `resolvers/crawl.resolver.ts:279` | `crawlmetadata/register.go:67` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_CRAWL_METADATA_MODE` | N1 | A | `apps/api/schema.gql:2325`; `apps/api-go/cmd/api/main.go:2270` |
| `crawlTasks` | Query | `resolvers/crawl.resolver.ts:69` | `settingscrawl/register.go:351` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2327`; `apps/api-go/cmd/api/main.go:2273` |
| `crawlTask` | Query | `resolvers/crawl.resolver.ts:153` | `settingscrawl/register.go:369` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2326`; `apps/api-go/cmd/api/main.go:2273` |
| `createCrawlTask` | Mutation | `resolvers/crawl.resolver.ts:170` | `crawltaskwrite/register.go:31` | `API_GO_CRAWL_TASK_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1586`; `apps/api-go/cmd/api/main.go:2399` |
| `deleteCrawlTask` | Mutation | `resolvers/crawl.resolver.ts:268` | `crawltaskwrite/register.go:36` | `API_GO_CRAWL_TASK_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1594`; `apps/api-go/cmd/api/main.go:2399` |
| `retryCrawlTask` | Mutation | `resolvers/crawl.resolver.ts:205` | `crawltaskwrite/register.go:41` | `API_GO_CRAWL_TASK_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1607`; `apps/api-go/cmd/api/main.go:2399` |

#### 条目与 RSS（itemsreading / itemsingest / rsstranslation）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `item` | Query | `resolvers/items.resolver.ts:561` | `itemsreading/register.go:56` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_ITEMS_READING_MODE` | N1 | A | `apps/api/schema.gql:2353`; `apps/api-go/cmd/api/main.go:2299` |
| `itemFacets` | Query | `resolvers/items.resolver.ts:459` | `itemsreading/register.go:57` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_ITEMS_READING_MODE` | N1 | A | `apps/api/schema.gql:2354`; `apps/api-go/cmd/api/main.go:2299` |
| `items` | Query | `resolvers/items.resolver.ts:350` | `itemsreading/list.go:27` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_ITEMS_READING_MODE ∧ API_GO_GRAPHQL_ITEMS_LIST_MODE` | N1 | A | `apps/api/schema.gql:2355`; `apps/api-go/cmd/api/main.go:2304` |
| `rssSources` | Query | `resolvers/items.resolver.ts:473` | `itemsreading/register.go:58` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_ITEMS_READING_MODE` | N1 | A | `apps/api/schema.gql:2387`; `apps/api-go/cmd/api/main.go:2299` |
| `rssTranslationStatus` | Query | `resolvers/items.resolver.ts:491` | `itemsreading/register.go:59` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_ITEMS_READING_MODE` | N1 | A | `apps/api/schema.gql:2388`; `apps/api-go/cmd/api/main.go:2299` |
| `searchSuggestions` | Query | `resolvers/items.resolver.ts:541` | `itemsreading/register.go:60` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_ITEMS_READING_MODE` | N1 | A | `apps/api/schema.gql:2389`; `apps/api-go/cmd/api/main.go:2299` |
| `createItem` | Mutation | `resolvers/items.resolver.ts:576` | `itemsingest/register.go:31` | `API_GO_ITEMS_INGEST_MODE` | N1 | A | `apps/api/schema.gql:1587`; `apps/api-go/cmd/api/main.go:2321` |
| `updateItem` | Mutation | `resolvers/items.resolver.ts:629` | `itemsingest/register.go:32` | `API_GO_ITEMS_INGEST_MODE` | N1 | A | `apps/api/schema.gql:1625`; `apps/api-go/cmd/api/main.go:2321` |
| `createItemFromCrawlResult` | Mutation | `resolvers/items.resolver.ts:604` | `itemsingest/register.go:33` | `API_GO_ITEMS_INGEST_MODE` | N1 | A | `apps/api/schema.gql:1588`; `apps/api-go/cmd/api/main.go:2321` |
| `ingestCrawlTaskResultsToItems` | Mutation | `resolvers/crawl.resolver.ts:245` | `itemsingest/register.go:34` | `API_GO_ITEMS_INGEST_MODE` | N1 | A | `apps/api/schema.gql:1596`; `apps/api-go/cmd/api/main.go:2321` |
| `updateCrawlTaskIngestToItems` | Mutation | `resolvers/crawl.resolver.ts:223` | `itemsingest/register.go:35` | `API_GO_ITEMS_INGEST_MODE` | N1 | A | `apps/api/schema.gql:1622`; `apps/api-go/cmd/api/main.go:2321` |
| `translateRssItems` | Mutation | `resolvers/items.resolver.ts:513` | `rsstranslation/register.go:31` | `API_GO_GRAPHQL_RSS_TRANSLATION_MODE` | N1 | A | `apps/api/schema.gql:1612`; `apps/api-go/cmd/api/main.go:2445` |

#### 经济数据（economic / economicdata）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `getEconomicData` | Query | `resolvers/economic-data.resolver.ts:169` | `economic/register.go:28` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2341`; `apps/api-go/cmd/api/main.go:2226` |
| `getEconomicDataWithInsights` | Query | `resolvers/economic-data.resolver.ts:206` | `economic/register.go:33` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2344`; `apps/api-go/cmd/api/main.go:2226` |
| `getEconomicDataInsights` | Query | `resolvers/economic-data.resolver.ts:277` | `economic/register.go:38` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2342`; `apps/api-go/cmd/api/main.go:2226` |
| `getEconomicDataPaginated` | Query | `resolvers/economic-data.resolver.ts:328` | `economic/register.go:43` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2343`; `apps/api-go/cmd/api/main.go:2226` |
| `economicDataFetchConfigs` | Query | `resolvers/economic-data.resolver.ts:386` | `economic/register.go:48` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2329`; `apps/api-go/cmd/api/main.go:2226` |
| `economicDataRefreshPresetStatus` | Query | `resolvers/economic-data.resolver.ts:402` | `economic/register.go:53` | `API_GO_GRAPHQL_READ_MODE` | N1 | A | `apps/api/schema.gql:2330`; `apps/api-go/cmd/api/main.go:2226` |
| `updateEconomicDataFetchConfig` | Mutation | `resolvers/economic-data.resolver.ts:417` | `economicdata/register.go:36` | `API_GO_ECONOMIC_DATA_MODE` | N1 | A | `apps/api/schema.gql:1623`; `apps/api-go/cmd/api/main.go:2329` |
| `triggerDataFetch` | Mutation | `resolvers/economic-data.resolver.ts:448` | `economicdata/register.go:39` | `API_GO_ECONOMIC_DATA_MODE` | N1 | A | `apps/api/schema.gql:1614`; `apps/api-go/cmd/api/main.go:2329` |
| `triggerEconomicDataRefreshPreset` | Mutation | `resolvers/economic-data.resolver.ts:457` | `economicdata/register.go:42` | `API_GO_ECONOMIC_DATA_MODE` | N1 | A | `apps/api/schema.gql:1615`; `apps/api-go/cmd/api/main.go:2329` |

#### 知识图谱（knowledgegraph / kgimpact / knowledgereview）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `getKnowledgeGraphSubgraph` | Query | `resolvers/knowledge-graph.resolver.ts:48` | `knowledgegraph/register.go:47` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | N1 | A | `apps/api/schema.gql:2351`; `apps/api-go/cmd/api/main.go:2257` |
| `articleEntityLinks` | Query | `resolvers/knowledge-graph.resolver.ts:179` | `knowledgegraph/register.go:48` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | N1 | A | `apps/api/schema.gql:2317`; `apps/api-go/cmd/api/main.go:2257` |
| `knowledgeGraphEdgeEvidence` | Query | `resolvers/knowledge-graph.resolver.ts:217` | `knowledgegraph/register.go:49` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | N1 | A | `apps/api/schema.gql:2359`; `apps/api-go/cmd/api/main.go:2257` |
| `entityIntelligenceCard` | Query | `resolvers/entity-intelligence.resolver.ts:28` | `knowledgegraph/register.go:50` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | N1 | A | `apps/api/schema.gql:2334`; `apps/api-go/cmd/api/main.go:2257` |
| `entityIntelligenceEvidence` | Query | `resolvers/entity-intelligence.resolver.ts:80` | `knowledgegraph/register.go:51` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | N1 | A | `apps/api/schema.gql:2337`; `apps/api-go/cmd/api/main.go:2257` |
| `knowledgeEntityByName` | Query | `resolvers/entity-intelligence.resolver.ts:105` | `knowledgegraph/register.go:52` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | N1 | A | `apps/api/schema.gql:2358`; `apps/api-go/cmd/api/main.go:2257` |
| `getExecutiveChangeImpact` | Query | `resolvers/knowledge-graph-impact.resolver.ts:29` | `kgimpact/register.go:39` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KG_IMPACT_MODE` | N1 | A | `apps/api/schema.gql:2348`; `apps/api-go/cmd/api/main.go:2253` |
| `getCommodityMoveImpact` | Query | `resolvers/knowledge-graph-impact.resolver.ts:49` | `kgimpact/register.go:44` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KG_IMPACT_MODE` | N1 | A | `apps/api/schema.gql:2340`; `apps/api-go/cmd/api/main.go:2253` |
| `getPolicyEventImpact` | Query | `resolvers/knowledge-graph-impact.resolver.ts:69` | `kgimpact/register.go:49` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KG_IMPACT_MODE` | N1 | A | `apps/api/schema.gql:2352`; `apps/api-go/cmd/api/main.go:2253` |
| `getEntityImpactGraph` | Query | `resolvers/entity-impact-graph.resolver.ts:34` | `kgimpact/register.go:54` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_KG_IMPACT_MODE` | N1 | A | `apps/api/schema.gql:2347`; `apps/api-go/cmd/api/main.go:2253` |
| `reviewKnowledgeGraphEvidence` | Mutation | `resolvers/knowledge-graph-review.resolver.ts:100` | `knowledgereview/store.go:68` | `API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE` | N1 | A | `apps/api/schema.gql:1608`; `apps/api-go/cmd/api/main.go:2424` |

#### 新闻（newsevents / newsindicators / newsindicatorwrite）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `newsEvents` | Query | `resolvers/news-events.resolver.ts:83` | `newsevents/register.go:71` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_NEWS_EVENTS_MODE` | N1 | A | `apps/api/schema.gql:2375`; `apps/api-go/cmd/api/main.go:2245` |
| `newsEvent` | Query | `resolvers/news-events.resolver.ts:205` | `newsevents/register.go:72` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_NEWS_EVENTS_MODE` | N1 | A | `apps/api/schema.gql:2367`; `apps/api-go/cmd/api/main.go:2245` |
| `newsEventBrief` | Query | `resolvers/news-events.resolver.ts:260` | `newsevents/register.go:77` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_NEWS_EVENTS_MODE ∧ API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE` | N1 | A | `apps/api/schema.gql:2368`; `apps/api-go/cmd/api/main.go:2245` |
| `newsEventReferencedArticles` | Query | `resolvers/news-events.resolver.ts:317` | `newsevents/register.go:73` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_NEWS_EVENTS_MODE` | N1 | A | `apps/api/schema.gql:2369`; `apps/api-go/cmd/api/main.go:2245` |
| `topicGroups` | Query | `resolvers/topics.resolver.ts:19` | `newsevents/register.go:74` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_NEWS_EVENTS_MODE` | N1 | A | `apps/api/schema.gql:2390`; `apps/api-go/cmd/api/main.go:2245` |
| `eventGroups` | Query | `resolvers/topics.resolver.ts:54` | `newsevents/register.go:75` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_NEWS_EVENTS_MODE` | N1 | A | `apps/api/schema.gql:2339`; `apps/api-go/cmd/api/main.go:2245` |
| `newsIndicatorAssociations` | Query | `resolvers/news-indicator.resolver.ts:23` | `newsindicators/register.go:20` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_NEWS_INDICATORS_MODE` | N1 | A | `apps/api/schema.gql:2378`; `apps/api-go/cmd/api/main.go:2249` |
| `newsIndicatorAssociation` | Query | `resolvers/news-indicator.resolver.ts:45` | `newsindicators/register.go:25` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_NEWS_INDICATORS_MODE` | N1 | A | `apps/api/schema.gql:2377`; `apps/api-go/cmd/api/main.go:2249` |
| `refreshNewsIndicatorAssociations` | Mutation | `resolvers/news-indicator.resolver.ts:64` | `newsindicatorwrite/register.go:37` | `API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE` | N1 | A | `apps/api/schema.gql:1599`; `apps/api-go/cmd/api/main.go:2407` |

#### 设置中心（settingscrawl / settingswrite / source-policy）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `rateLimitSettings` | Query | `resolvers/settings.resolver.ts:121` | `settingscrawl/register.go:184` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2385`; `apps/api-go/cmd/api/main.go:2273` |
| `entityImpactGraphSettings` | Query | `resolvers/settings.resolver.ts:146` | `settingscrawl/register.go:191` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2331`; `apps/api-go/cmd/api/main.go:2273` |
| `knowledgeGraphSettings` | Query | `resolvers/settings.resolver.ts:180` | `settingscrawl/register.go:198` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2361`; `apps/api-go/cmd/api/main.go:2273` |
| `newsEventSettings` | Query | `resolvers/settings.resolver.ts:238` | `settingscrawl/register.go:205` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2370`; `apps/api-go/cmd/api/main.go:2273` |
| `newsEventSourcePolicy` | Query | `resolvers/settings.resolver.ts:318` | `settingscrawl/register.go:212` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2371`; `apps/api-go/cmd/api/main.go:2273` |
| `newsEventSourcePolicyPresets` | Query | `resolvers/settings.resolver.ts:332` | `settingscrawl/register.go:222` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2372`; `apps/api-go/cmd/api/main.go:2273` |
| `newsEventSourcePolicyRevisionDiff` | Query | `resolvers/settings.resolver.ts:446` | `settingscrawl/register.go:232` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2373`; `apps/api-go/cmd/api/main.go:2273` |
| `newsClassificationSettings` | Query | `resolvers/settings.resolver.ts:463` | `settingscrawl/register.go:244` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2365`; `apps/api-go/cmd/api/main.go:2273` |
| `classificationQualitySettings` | Query | `resolvers/settings.resolver.ts:517` | `settingscrawl/register.go:254` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2323`; `apps/api-go/cmd/api/main.go:2273` |
| `newsDedupeSettings` | Query | `resolvers/settings.resolver.ts:555` | `settingscrawl/register.go:264` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2366`; `apps/api-go/cmd/api/main.go:2273` |
| `newsIndicatorSettings` | Query | `resolvers/settings.resolver.ts:625` | `settingscrawl/register.go:274` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2379`; `apps/api-go/cmd/api/main.go:2273` |
| `authCacheSettings` | Query | `resolvers/settings.resolver.ts:668` | `settingscrawl/register.go:281` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2322`; `apps/api-go/cmd/api/main.go:2273` |
| `crawlClientSettings` | Query | `resolvers/settings.resolver.ts:693` | `settingscrawl/register.go:288` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2324`; `apps/api-go/cmd/api/main.go:2273` |
| `auditLogRetention` | Query | `resolvers/settings.resolver.ts:714` | `settingscrawl/register.go:295` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2321`; `apps/api-go/cmd/api/main.go:2273` |
| `newsExtractionSettings` | Query | `resolvers/settings.resolver.ts:741` | `settingscrawl/register.go:302` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2376`; `apps/api-go/cmd/api/main.go:2273` |
| `newsPromptConfig` | Query | `resolvers/settings.resolver.ts:833` | `settingscrawl/register.go:312` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2380`; `apps/api-go/cmd/api/main.go:2273` |
| `newsEventSourcePolicySyncStatus` | Query | `resolvers/news-events.resolver.ts:60` | `settingscrawl/register.go:319` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2374`; `apps/api-go/cmd/api/main.go:2273` |
| `knowledgeGraphEvidenceReviewQueue` | Query | `resolvers/knowledge-graph-review.resolver.ts:28` | `settingscrawl/register.go:332` | `API_GO_GRAPHQL_READ_MODE ∧ API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | N1 | A | `apps/api/schema.gql:2360`; `apps/api-go/cmd/api/main.go:2273` |
| `updateRateLimitSettings` | Mutation | `resolvers/settings.resolver.ts:131` | `settingswrite/service.go:44` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1637`; `apps/api-go/cmd/api/main.go:2387` |
| `updateAuthCacheSettings` | Mutation | `resolvers/settings.resolver.ts:678` | `settingswrite/service.go:45` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1619`; `apps/api-go/cmd/api/main.go:2387` |
| `updateCrawlClientSettings` | Mutation | `resolvers/settings.resolver.ts:703` | `settingswrite/service.go:46` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1621`; `apps/api-go/cmd/api/main.go:2387` |
| `updateAuditLogRetention` | Mutation | `resolvers/settings.resolver.ts:724` | `settingswrite/service.go:47` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1618`; `apps/api-go/cmd/api/main.go:2387` |
| `updateEntityImpactGraphSettings` | Mutation | `resolvers/settings.resolver.ts:155` | `settingswrite/service.go:48` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1624`; `apps/api-go/cmd/api/main.go:2387` |
| `updateKnowledgeGraphSettings` | Mutation | `resolvers/settings.resolver.ts:189` | `settingswrite/service.go:49` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1626`; `apps/api-go/cmd/api/main.go:2387` |
| `updateNewsEventSettings` | Mutation | `resolvers/settings.resolver.ts:247` | `settingswrite/service.go:50` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1630`; `apps/api-go/cmd/api/main.go:2387` |
| `updateNewsIndicatorSettings` | Mutation | `resolvers/settings.resolver.ts:634` | `settingswrite/service.go:51` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1634`; `apps/api-go/cmd/api/main.go:2387` |
| `updateNewsClassificationSettings` | Mutation | `resolvers/settings.resolver.ts:473` | `settingswrite/service.go:52` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1628`; `apps/api-go/cmd/api/main.go:2387` |
| `updateClassificationQualitySettings` | Mutation | `resolvers/settings.resolver.ts:529` | `settingswrite/service.go:53` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1620`; `apps/api-go/cmd/api/main.go:2387` |
| `updateNewsDedupeSettings` | Mutation | `resolvers/settings.resolver.ts:565` | `settingswrite/service.go:54` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1629`; `apps/api-go/cmd/api/main.go:2387` |
| `updateNewsExtractionSettings` | Mutation | `resolvers/settings.resolver.ts:771` | `settingswrite/service.go:55` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1633`; `apps/api-go/cmd/api/main.go:2387` |
| `updateNewsPromptConfig` | Mutation | `resolvers/settings.resolver.ts:843` | `settingswrite/service.go:56` | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1635`; `apps/api-go/cmd/api/main.go:2387` |
| `updateNewsEventSourcePolicy` | Mutation | `resolvers/settings.resolver.ts:345` | `settingswrite/sourcepolicy_service.go:28` | `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1631`; `apps/api-go/cmd/api/main.go:2417` |
| `updateNewsEventSourcePolicyPresets` | Mutation | `resolvers/settings.resolver.ts:371` | `settingswrite/sourcepolicy_service.go:33` | `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1632`; `apps/api-go/cmd/api/main.go:2417` |
| `rollbackNewsEventSourcePolicy` | Mutation | `resolvers/settings.resolver.ts:397` | `settingswrite/sourcepolicy_service.go:38` | `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1609`; `apps/api-go/cmd/api/main.go:2417` |
| `resetNewsEventSourcePolicy` | Mutation | `resolvers/settings.resolver.ts:422` | `settingswrite/sourcepolicy_service.go:43` | `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE` | N1 | A | `apps/api/schema.gql:1606`; `apps/api-go/cmd/api/main.go:2417` |

#### GraphQL Subscription（graphqlsubscriptions）

| 根字段 | 类型 | Nest 源位置 | Go 注册包 file:line | 开关 | go 模式下 Nest 行为 | 分类 | 证据 |
|---|---|---|---|---|---|---|---|
| `alertEvents` | Subscription | `resolvers/alerts.resolver.ts:276` | `apps/api-go/internal/graphqlsubscriptions/handler.go:120` | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` | N2 | A | `apps/api/schema.gql:2572`; `apps/api-go/cmd/api/main.go:2655` |
| `analysisEvents` | Subscription | `resolvers/analysis.resolver.ts:128` | `apps/api-go/internal/graphqlsubscriptions/handler.go:120` | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` | N2 | A | `apps/api/schema.gql:2573`; `apps/api-go/cmd/api/main.go:2655` |
| `assistantEvents` | Subscription | `resolvers/assistant.resolver.ts:200` | `apps/api-go/internal/graphqlsubscriptions/handler.go:120` | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` | N2 | A | `apps/api/schema.gql:2574`; `apps/api-go/cmd/api/main.go:2655` |
| `queueEvents` | Subscription | `resolvers/dashboard.resolver.ts:142` | `apps/api-go/internal/graphqlsubscriptions/handler.go:120` | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` | N2 | A | `apps/api/schema.gql:2575`; `apps/api-go/cmd/api/main.go:2655` |

小计核对：本表 Query 77 + Mutation 57 + Subscription 4 = 138。


### 4. 开关 → 根字段汇总

> 读域开关都不是单独生效：`API_GO_GRAPHQL_*_READ_MODE`/`NEWS_EVENTS`/`KG_IMPACT`/`KNOWLEDGE_GRAPH`/`NEWS_INDICATORS`/`CRAWL_METADATA`/`ITEMS_READING` 必须同时 `API_GO_GRAPHQL_READ_MODE=go`；`ITEMS_LIST` 还需 `ITEMS_READING=go`；`NEWS_EVENT_BRIEF` 还需 `NEWS_EVENTS=go`。

| 开关（=go） | Query 根 | Mutation 根 | Subscription 根 | 根数 |
|---|---:|---:|---:|---:|
| `API_GO_GRAPHQL_READ_MODE`（基础：alerts 4 + history 6 + economic 6） | 16 | 0 | 0 | 16 |
| `API_GO_ARCHIVE_READING_MODE` | 3 | 0 | 0 | 3 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_GRAPHQL_CRAWL_METADATA_MODE` | 1 | 0 | 0 | 1 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_ITEMS_READING_MODE` | 5 | 0 | 0 | 5 |
| `… + API_GO_GRAPHQL_ITEMS_LIST_MODE` | 1 | 0 | 0 | 1 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_GRAPHQL_KG_IMPACT_MODE` | 4 | 0 | 0 | 4 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | 6 | 0 | 0 | 6 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_GRAPHQL_NEWS_EVENTS_MODE` | 5 | 0 | 0 | 5 |
| `… + API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE` | 1 | 0 | 0 | 1 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_NEWS_INDICATORS_MODE` | 2 | 0 | 0 | 2 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | 20 | 0 | 0 | 20 |
| `API_GO_GRAPHQL_READ_MODE` + `API_GO_GRAPHQL_WORKSPACE_READ_MODE` | 12 | 0 | 0 | 12 |
| `API_GO_GRAPHQL_ALERT_RULES_MODE`（独立） | 1 | 3 | 0 | 4 |
| `API_GO_ECONOMIC_DATA_MODE` | 0 | 3 | 0 | 3 |
| `API_GO_ITEMS_INGEST_MODE` | 0 | 5 | 0 | 5 |
| `API_GO_CRAWL_TASK_WRITE_MODE` | 0 | 3 | 0 | 3 |
| `API_GO_ANALYSIS_RUNS_MODE` | 0 | 3 | 0 | 3 |
| `API_GO_GRAPHQL_ASSISTANT_WRITE_MODE` | 0 | 4 | 0 | 4 |
| `API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE` | 0 | 1 | 0 | 1 |
| `API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE` | 0 | 1 | 0 | 1 |
| `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | 0 | 8 | 0 | 8 |
| `API_GO_GRAPHQL_RSS_TRANSLATION_MODE` | 0 | 1 | 0 | 1 |
| `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | 0 | 13 | 0 | 13 |
| `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE` | 0 | 4 | 0 | 4 |
| `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | 0 | 8 | 0 | 8 |
| `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE`（+ `GRAPHQL_SUBSCRIPTION_BUS=redis`） | 0 | 0 | 4 | 4 |
| **合计** | **77** | **57** | **4** | **138** |

#### 4.1 Subscription 专项（4/4 已注册）

| 根 | 权限 | Nest resolver（file:line） | Go 注册（file:line） | 事件来源 | 返回模型 |
|---|---|---|---|---|---|
| `alertEvents` | `alerts.read` | `apps/api/src/graphql/resolvers/alerts.resolver.ts:276-289` | `apps/api-go/internal/graphqlsubscriptions/handler.go:120`（spec `apps/api-go/internal/graphqlsubscriptions/source.go:29`） | Redis `gqlsub:alertEvents` | `AlertEventModel!` |
| `analysisEvents` | `analysis.read` | `apps/api/src/graphql/resolvers/analysis.resolver.ts:128-160` | 同上（spec `apps/api-go/internal/graphqlsubscriptions/source.go:30`） | Redis `gqlsub:analysisEvents` | `AnalysisResultModel!` |
| `assistantEvents` | `assistant.read` | `apps/api/src/graphql/resolvers/assistant.resolver.ts:200-232` | 同上（spec `apps/api-go/internal/graphqlsubscriptions/source.go:31`） | Redis `gqlsub:assistantEvents` | `AssistantRunModel!` |
| `queueEvents` | `queue.manage` | `apps/api/src/graphql/resolvers/dashboard.resolver.ts:142-158` | 同上（spec `apps/api-go/internal/graphqlsubscriptions/source.go:32`） | 每进程只读 BullMQ `bull:itemPipeline:events`（`apps/api-go/internal/graphqlsubscriptions/queue.go:61` 的 `XREAD`） | `QueueEventModel!` |

- 注册表按 Query/Mutation/Subscription 分命名空间（`apps/api-go/internal/graphqlread/contract/contract.go:250-266`），因此 Query `alertEvents` 与 Subscription `alertEvents` 同名不冲突；不要误把 Subscription 根注册成 Query。
- Go 侧 `subscriptionRoots` 的权限与 Nest 装饰器一致（`apps/api-go/internal/graphqlsubscriptions/source.go:25-33`）；Nest 侧权限装饰器 `@HasPermission("alerts.read")` 在 `apps/api/src/graphql/resolvers/alerts.resolver.ts:275`。
- 传输：只有合法 `graphql-transport-ws` upgrade 进 Go（`apps/api-go/internal/graphqlsubscriptions/handler.go:149-160`）；同一连接上的非本批 operation 整份转发 Nest upstream（§2.4）。`queueEvents` 的 Go 观察器在进程启动时即开始 `XREAD`（不等待首个订阅），保证 `removeOnComplete` 前能补全 job context（`apps/api-go/internal/graphqlsubscriptions/handler.go:129-139`）。
- bus 依赖：`GRAPHQL_SUBSCRIPTION_BUS` 默认 `redis`（Nest `apps/api/src/modules/config/env.schema.ts:516`、Go `apps/api-go/internal/config/config.go:4946`）；`API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go` + `local` 在 Go 侧启动失败（`apps/api-go/internal/config/config.go:4213-4214`）。Nest 的 `GraphqlSubscriptionBus` 在 `redis` 模式下用两条独立 Redis 连接发布/订阅 `gqlsub:*`（`apps/api/src/modules/graphql-subscriptions/graphql-subscription-bus.module.ts:40-75`）；Go 用专用 Pub/Sub 连接读同一前缀（`apps/api-go/internal/graphqlsubscriptions/bus.go:15/127`）。
- 生产端前置：`alertEvents`/`analysisEvents`/`assistantEvents` 依赖 `alerts`/`analysis`/`assistant` 队列的 worker 仍会写行并发布 `gqlsub:*`（Nest 的 `AlertsService`/`AnalysisProcessor`/`AssistantProcessor` 或 Go 对应 worker）；`queueEvents` 只依赖 BullMQ stream 本身。worker 执行权属 T1.4/T3，不在本表判定。
- 回退：把 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` 改回 `legacy` 并重启 api-go；浏览器重连后由 Nest graphql-ws 处理。若同时把 `GRAPHQL_SUBSCRIPTION_BUS` 改回 `local`，Nest 也需重启，且 Go 模式必须先关（否则 Go 启动失败）。

### 5. 跨开关硬校验与资源前置（与本批根字段相关）

- `API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go` 需要 `API_GO_GRAPHQL_READ_MODE=go` 且 `API_GO_GRAPHQL_NEWS_EVENTS_MODE=go`：`apps/api-go/internal/config/config.go:4421-4422`。
- `API_GO_GRAPHQL_CRAWL_METADATA_MODE=go` 需要 `API_GO_GRAPHQL_READ_MODE=go`：`apps/api-go/internal/config/config.go:5747-5748`。
- `API_GO_GRAPHQL_ITEMS_LIST_MODE=go` 需要 `API_GO_GRAPHQL_READ_MODE=go` 且 `API_GO_ITEMS_READING_MODE=go`：`apps/api-go/internal/config/config.go:5821-5826`。
- `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go` 需要 `GRAPHQL_SUBSCRIPTION_BUS=redis`：`apps/api-go/internal/config/config.go:4213-4214`；`GRAPHQL_SUBSCRIPTION_BUS` 默认 `redis`（`apps/api-go/internal/config/config.go:4946`；Nest `apps/api/src/modules/config/env.schema.ts:516`，`apps/api/src/modules/config/config.service.ts:497`）；`local` 只在整体回滚 Nest 进程内 bus 时使用（`.env.example:99`）。
- `API_GO_GRAPHQL_READ_MODE=go` 额外需要 `MONGO_URI`（`apps/api-go/internal/config/config.go:5985-5991`），因为读装配会打开 Mongo（`apps/api-go/cmd/api/main.go:2211-2226`）；订阅/写模式不要求 Mongo（订阅见 `apps/api-go/internal/config/config.go:5993-5994`，写按各自资源）。
- 任一 GraphQL 装配为 go 时要求 MySQL/JWT/Redis 齐备（`apps/api-go/cmd/api/main.go:2193-2198`，`apps/api-go` 的 `GraphQL go execution requires mysql, jwt, and redis`）。
- 路由 OR 只覆盖 `GraphQLReadMode` 与各写开关；`GraphQLSettingsWriteMode=go` 已在 OR 内（`apps/api-go/cmd/api/main.go:893`），历史上 GAP-GQL-001 所述「graphqlRouteMode 漏 settingsWrite」在 dcbe563b 的代码中不再存在（`apps/api-go/cmd/api/main.go:1348` 的 `needsCredentialedGo` 也含该开关）；`docs/refactor/migration-map/GAPS.md` 该条为历史记录，留给 Lead 决定如何回填，本文不改正式文档。

### 6. 已注册但需注意的实现/混合态问题（不影响 A/C）

- **`newsEventBrief`（GAP-NEWS-001）**：根已注册，`API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go` 时需要同时具备 read/news-events go；当前代码在模型客户端未注入时返回固定 `Internal server error`（`apps/api-go/internal/graphqlread/newsevents/brief.go:31/66-68`），子开关 go 时由 `apps/api-go/cmd/api/main.go:2234-2243` 注入 `publicportal.BriefCompleter`，静态看冷路径已具备实现；但 GAPS.md 仍把该缺口记为 open，且真实模型调用未验证。**切换前应单独确认此根**，或继续留在 Nest（把 brief 子开关保持 legacy）。
- **Nest 侧未使用的开关声明**：`API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE` 只在 Nest `apps/api/src/modules/config/env.schema.ts:144` 声明，`API_GO_ANALYSIS_RUNS_MODE` 的 getter `apps/api/src/modules/config/config.service.ts:1300-1308` 无调用；两者不会改变 Nest resolver 行为。若期望「Nest 在 go 模式下拒绝执行同根」，当前代码没有这种保护——Nest 仍会执行任何被转发的 document。
- **混合配置风险**：`API_GO_GRAPHQL_SETTINGS_WRITE_MODE=go` + `API_GO_GRAPHQL_READ_MODE=legacy` 能启动并路由（写根可用，读根全部整份回退 Nest）；此时读流量仍全在 Nest，符合回退语义。反之，只设子读开关不会把 `/graphql` 交给 Go（§2.1）。

### 7. 与迁移地图旧快照的差异

- `docs/refactor/migration-map/README.md:75` 记录「合计 370 HTTP / 77 Query / 57 Mutation / 4 Subscription；Go 注册 274 / 71 / 21 / 0」。当前 dcbe563b 的实际注册为 **77 Query / 57 Mutation / 4 Subscription**（§3 全表 + §4 汇总），旧快照的 Go 注册列已过时（该页自身也声明是历史快照、不回填）。
- 差异来源可由本批最近的注册代码看出（例如 `graphqlsubscriptions`、`analysisrunsgraphql`、`assistantwrite`、`knowledgereview`、`rsstranslation`、`settingswrite`、`workspacewrite` 等合计 57 个 Mutation 全部有注册点）；本文不追溯每个历史 PR，只以当前代码复核。

### 8. 未核实项

- 未运行任何构建/测试/服务：Go 注册在真实启动时的 panic/模型重复注册、Nest schema 生成与提交的 SDL 是否完全一致，均未运行验证；只做了静态核对（SDL 与 Go 副本字节一致）。
- `GRAPHQL_SUBSCRIPTIONS_ENABLED` 未出现在 Nest `env.schema.ts`（只在 `apps/api/src/modules/config/config.service.ts:477-479` 读取），其生产默认/校验行为未核实。
- GraphQL 各根的 business 完整性（尤其 `newsEventBrief` 的模型调用、Settings 写的缓存副作用、Analysis/Assistant 的 worker 依赖）不在本轮静态范围内；相关缺口以 GAPS.md/任务页为准（其中部分可能已滞后于代码）。
- 未验证真实客户端/浏览器在 go 模式下经 Go `/graphql` 的连接、APQ、CORS 与回退 upstream 行为。

### 行号口径

- 除 `apps/api-go/internal/legacyproxy/proxy.go` 外，本文引用的文件在 worktree 与 `dcbe563b` 一致；本批 T5.6 给 `proxy.go` 增加了 legacy 计数（`ServeLegacy`→`proxyLegacy` 等），本地行号较基线 +1。本文 `proxy.go` 行号取自 `git show dcbe563b:apps/api-go/internal/legacyproxy/proxy.go`（`/graphql` 默认规则 145、`WithGraphQLRead` 432、`WithNotificationsSocket` 191、`WithRealtimeSocket` 206、`match` 814）。
- 其余行号直接来自当前 worktree 文件（与基线一致）。

---

## 4. Socket.IO 执行权（T1.3）

<!-- 合并自 T1.3 Socket.IO 审计（task-2 产出）；原文，仅调整标题层级。 -->


> 基线：`dcbe563b917fde0927637121a91de2186d6177a4`（worktree `docs/go-cutover-readiness`）。
> 静态审计，未运行 `go build`/`go test`/`pnpm`/Docker/服务，也未做浏览器连接验证。

### 0. 结论摘要

- Nest 侧共 **6 个 `@WebSocketGateway`**：`/newsnow`、`/ops`、`/quality`、`/queue`、`/situation-monitor`、`/notifications`；全部挂在一个 Socket.IO 服务器上，Engine.IO path 为默认的 **`/socket.io`**（Nest 侧没有任何 `path` 选项，Web 默认也传 `/socket.io`）。
- Go 侧用 **2 条独立 Engine.IO path** 覆盖全部 6 个 namespace：
  - `/socket.io-notifications`（`API_GO_NOTIFICATIONS_SOCKET_MODE`）：单 namespace `/notifications`，**不支持 multiplex**；
  - `/socket.io-realtime`（`API_GO_REALTIME_SOCKET_MODE`）：一条 websocket 上 **multiplex 5 个 namespace**（`/newsnow`、`/ops`、`/quality`、`/queue`、`/situation-monitor`）。
- 按本任务分类：**6 个 namespace 均为 A（Go 可接管，开关可 go），C=0，B=0（transport 层）**。Nest 侧通知 relay subscriber（`alert/analysis/digest/news-source/generic`）属于兼容桥，B 类，但它们服务于 Nest 的 `/socket.io` 连接，不是 Go transport 的必需组件；停用条件见 §6。
- **`/socket.io` 仍由 Nest 提供**，Go 的默认规则也继续把它按 legacy 转发（`apps/api-go/internal/legacyproxy/proxy.go:145-146`）。两条 Go 专用 path **没有 Nest 回退**：未覆盖的 namespace 由 Go 返回 `CONNECT_ERROR {"message":"Invalid namespace"}` 并保持连接（`apps/api-go/internal/socketio/connection.go:221-230`），未被反向代理到 Nest。因此「Web 构建参数 + 反向代理 + 两侧开关」必须同时成立。
- 切流后 `/socket.io` 是否还需要 Nest：仓库内 Web 的 8 处 `io()` 全部使用两个 `NEXT_PUBLIC_*_SOCKET_PATH`（默认 `/socket.io`），两条 Go path 都上线并重建 Web 后，**仓库内客户端不再连接 `/socket.io`**；但 Nest 进程仍要运行到阶段 6（承接 GraphQL 整份回退、HTTP 与队列），且旧浏览器 bundle 在缓存刷新前仍可能连 `/socket.io`，所以不能先摘 `/socket.io` 的反向代理再停 Nest。外部/非仓库客户端无法核实。

### 1. Nest 侧 6 个网关

共同点：全部 `@WebSocketGateway({ namespace, cors: { origin: true, credentials: true } })`，无 `path` 选项；Nest 的 `RedisIoAdapter`（`apps/api/src/common/websocket/redis-io.adapter.ts:10`，在 `apps/api/src/main.ts:122-142` 装配）在 **`WS_REDIS_ADAPTER_ENABLED` 默认 true** 时创建 `@socket.io/redis-adapter`，key 默认 `socket.io`（`apps/api/src/modules/config/env.schema.ts:541-542`、`config.service.ts:522-529`）；所有网关共享同一个服务器与适配器。JWT 均为本地 `verify(secret, audience, issuer)`（各文件 `verifyToken`），再查 Redis blacklist（`ensureNotRevoked`），再 `authService.getUserProfile` 从 MySQL 重推导身份/权限；连接注册进 `org:<orgId>`、`user:<userId>`、`ip:<ip>` 房间（`apps/api/src/modules/websocket/user-session-manager.service.ts:24-46`）。

| namespace | Nest 网关（file:line） | namespace 行 | path | 鉴权（token 顺序 / 权限 / 复核） | 房间 | 服务端事件 | 客户端事件 | Redis adapter |
|---|---|---|---|---|---|---|---|---|
| `/notifications` | `apps/api/src/modules/notifications/notifications.gateway.ts:46-52` | 47 | `/socket.io` | header→auth→query（361-383）；仅需已认证（无额外权限码）；blacklist+profile；30s revalidation（200） | org/user/ip（185 调 `sessions.register`） | `notification:connected`（194）、`notification:error`（223）、`notification`（248/256/285/312） | 无 | 共享 |
| `/newsnow` | `apps/api/src/modules/news-aggregator/newsnow.gateway.ts:53-59` | 54 | `/socket.io` | header→auth→query（333-354）；`items.read`（167）；blacklist+profile；30s revalidation（205） | org/user/ip（191） | `newsnow:connected`（200）、`newsnow:error`（107/126/152/227）、`newsnow:update`（265，`sessions.emitToOrg`） | `newsnow:set-active-sources`（177，`client.on`；无 `@SubscribeMessage`） | 共享（生产 `newsnow:update` 走 adapter 广播） |
| `/ops` | `apps/api/src/modules/observability/ops.gateway.ts:59-65` | 60 | `/socket.io` | auth→query→header（353-380）；`crawl.read` **或** `crawl.write`（238-239）；blacklist+profile；30s revalidation（263） | org/user/ip（249） | `ops:connected`（258）、`ops:error`（290）、`ops:event`（423，org 房间） | 无 | 共享 |
| `/quality` | `apps/api/src/modules/observability/quality.gateway.ts:38-44` | 39 | `/socket.io` | auth→query→header（237-258）；`settings.manage`（149）；blacklist+profile；**无 attachTokenRevalidation**（全文件无此调用） | org/user/ip（158） | `quality:connected`（163）、`quality:error`、`quality:event`（300，org 房间） | 无 | 共享 |
| `/queue` | `apps/api/src/modules/queue/queue.gateway.ts:43-49` | 44 | `/socket.io` | header→auth→query（254-276）；`queue.manage`（140）；blacklist+profile；30s revalidation（164） | org/user/ip（150） | `queue:connected`（159）、`queue:error`（191）、`queue:event`（324，org 房间） | 无 | 共享 |
| `/situation-monitor` | `apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.gateway.ts:54-60`（namespace 常量 `:52`） | 52/55 | `/socket.io` | header→auth→query（442-464）；`items.read`（181）；blacklist+profile；30s revalidation（204） | org/user/ip（189）+ `global:situation-monitor-signals`（198，常量见 `situation-monitor-signals.constants.ts:15`） | `situation:connected`（199）、`situation:error`、`situation:telegram.update` / `situation:oref.update`。两条投递路径：进程内 dispatcher → `broadcast()` → `sessions.emitToUser` → `server.to(userRoom)` → **走 adapter**（`situation-monitor-signals.gateway.ts:250-276`）；Go 信号 worker 的 Redis bridge → `emitLocalEvent()` 直推本实例 socket、**有意绕开 adapter**（`situation-monitor-signals.gateway.ts:297-351`） | 无 | 共享（见事件列两条路径） |

补充：
- 6 个网关**都不读取任何 `API_GO_*` 开关**（`grep API_GO` 在这 6 个文件中 0 命中），因此 Go 模式不会让 Nest 停止监听 `/socket.io` 或卸载某个 namespace；只有生产端行为会变（见 §4/§6）。
- `/situation-monitor` 的 Web 客户端 `transports` 为 `["websocket", "polling"]`（`apps/web/app/(app)/situation-monitor/hooks/use-situation-monitor-stream.ts:67`），其余 7 处为 `["websocket"]`；Go 只接受 `transport=websocket` 的 handshake（见 §2），socket.io-client 4.8.1 数组第一项是 websocket，正常路径仍走 websocket；但若 websocket 失败，默认不会回退 polling（未在本机运行验证，见 §8）。

### 2. Go 侧覆盖（逐 namespace）

#### 2.1 路由与开关

| Go path | 开关 | 规则/注册 | Engine.IO 门控 | 未覆盖 namespace 的行为 |
|---|---|---|---|---|
| `/socket.io-notifications` | `API_GO_NOTIFICATIONS_SOCKET_MODE`（默认 legacy；非法值启动失败） | `legacyproxy.WithNotificationsSocket` 追加 GET 规则（`apps/api-go/internal/legacyproxy/proxy.go:191-200`，基线行号）；`main.go:2667-2694` 构造并在 `main.go:2689` `RegisterGoHandler` | `GET` + 精确 path（含尾斜杠）+ `Upgrade: websocket` + `Connection: upgrade` + `EIO=4` + `transport=websocket`（`apps/api-go/internal/notificationssocket/runtime.go:161-181`） | 非 `/notifications` 的 CONNECT：`CONNECT_ERROR {"message":"Unknown namespace"}` + `DISCONNECT`，关闭该连接（`notificationssocket/connection.go:44-51`）；**不转发 Nest** |
| `/socket.io-realtime` | `API_GO_REALTIME_SOCKET_MODE`（默认 legacy；非法值启动失败） | `legacyproxy.WithRealtimeSocket`（`proxy.go:206-215`，基线行号）；`main.go:2697-2708` 构造并在 `main.go:2706` `RegisterGoHandler` | 同上（`apps/api-go/internal/realtimesocket/runtime.go:143-163`） | 未注册 namespace：`CONNECT_ERROR {"message":"Invalid namespace"}`，**Engine.IO 连接保持**（`apps/api-go/internal/socketio/connection.go:221-230`；`Supports` 见 `realtimesocket/runtime.go:227-230`）；**不转发 Nest** |

两条规则只在开关为 `go` 时追加（`With…` 内 `mode != go` 直接返回原规则），`/socket.io/` 的 legacy 前缀规则保持不变（`proxy.go:145-146`，基线行号）。`match` 按 Prefix 长度降序，专用 path 更长，优先于 `/socket.io/` 前缀；两者路径本身也不重叠（`/socket.io-notifications` 不以 `/socket.io/` 开头）。

#### 2.2 每 namespace 的 Go 实现与事件

| namespace | Go path / 实现（file:line） | 开关 | Go 支持的连接与事件 | Go 事件来源（file:line） | go 模式下 Nest 行为 | 分类 |
|---|---|---|---|---|---|---|
| `/notifications` | path `notificationssocket/runtime.go:24`；namespace `notificationssocket/protocol.go:31`；握手/错误 `notificationssocket/connection.go:37-268`；房间索引 `notificationssocket/runtime.go:339-386` | `API_GO_NOTIFICATIONS_SOCKET_MODE` | `notification:connected`（`notificationssocket/connection.go:101`）、`notification:error`（`notificationssocket/connection.go:254`）、`notification`（`notificationssocket/runtime.go:356`）；仅本地 `byUser`/`byOrg` 索引，每连接一次；仅一个 namespace | 5 个 Redis relay 频道：`notification:events:v1`、`alert:notifications:v1`、`analysis:notification:v1`、`user-digest:notifications:v1`、`news-source:notifications:v1`（`notificationssocket/model.go:69-82`；`notificationssocket/source.go:31-75` 订阅） | Nest 网关仍监听 `/socket.io`；Nest `NotificationsService.notify` 在 go 时改发 relay（`notifications.service.ts:42-49`，`notification-realtime.relay.ts:39-58`）；generic subscriber 在 go 时**不订阅**（`generic-notification.subscriber.ts:83-86`、`149-155`） | **A** |
| `/newsnow` | `realtimesocket/namespaces.go:16`（spec `:115-123`）；runtime `realtimesocket/runtime.go:236-310`；`newsnow:update` 由 `realtimeevents/newsnow.go` 推送 | `API_GO_REALTIME_SOCKET_MODE` | `newsnow:connected` / `newsnow:error`（spec 表 `realtimesocket/namespaces.go:115-123`；通用发送 `realtimesocket/runtime.go:359-371`）；`newsnow:update`（`realtimeevents/newsnow.go:173-200` adapter 广播、`realtimeevents/newsnow.go:202+` Go source-refresh relay）；客户端事件 `newsnow:set-active-sources`（`realtimeevents/clientevents.go:16-35`） | Socket.IO Redis adapter 广播频道 `${WS_REDIS_ADAPTER_KEY}#/newsnow#*`（`realtimeevents/newsnow.go:140-170`，`realtimeevents/adapter.go:63-65`）+ Go 拉取 relay `newsnow:source-refresh:v1`（`realtimeevents/newsnow.go:202+`） | Nest 网关仍在；Nest 侧 newsnow 生产链仍走自己的 dispatcher/adapter；Nest 不读取该开关。**注意**：Go 侧无事件当 `API_GO_NEWSNOW_SOURCES_MODE!=go`（`realtimeevents/sources.go:210-212` 打 warn） | **A**（事件需 newsnow sources=go） |
| `/ops` | `realtimesocket/namespaces.go:17`（spec `:124-130`） | `API_GO_REALTIME_SOCKET_MODE` | `ops:connected`/`ops:error`；`ops:event`（`realtimeevents/queues.go:191`，org 房间） | 6 个 BullMQ 队列的 `bull:<queue>:events` stream，`XREAD` 从 `$`、无消费组（`realtimeevents/queues.go:24-31`、`:103-116`、`:119+`） | Nest 网关仍在；Nest 的 QueueEventPublisher/各 event 订阅器仍按自己的模式工作 | **A** |
| `/quality` | `realtimesocket/namespaces.go:18`（spec `:131-141`） | `API_GO_REALTIME_SOCKET_MODE` | `quality:connected`/`quality:error`；`quality:event`（`realtimeevents/queues.go:196`，org 房间） | 同上 6 个队列 stream（pipeline/crawl/analysis/assistant/alerts 的 kind 映射见 `realtimeevents/queues.go:18-50`） | Nest 网关仍在 | **A** |
| `/queue` | `realtimesocket/namespaces.go:19`（spec `:142-148`） | `API_GO_REALTIME_SOCKET_MODE` | `queue:connected`/`queue:error`；`queue:event`（`realtimeevents/queues.go:185`，org 房间） | 同上 6 个队列 stream | Nest 网关仍在 | **A** |
| `/situation-monitor` | `realtimesocket/namespaces.go:20`（spec `:149-156`） | `API_GO_REALTIME_SOCKET_MODE` | `situation:connected`/`situation:error`；`situation:telegram.update`、`situation:oref.update`（`realtimeevents/situation.go:22-23`，按本地用户推送 `realtimeevents/situation.go:87-121`） | Redis 事件桥 `situation-monitor:signals:events:v1`（`realtimeevents/situation.go:67-85`；Nest dispatcher 在 go 模式发布 `situation-monitor-signals.dispatcher.ts:88-118`；Go 信号 worker 也可生产） | Nest 网关仍在，本地 listener 仍按 `/socket.io` 连接推送；Nest dispatcher 额外发布 bridge | **A** |

#### 2.3 传输实现范围（静态）

- **Engine.IO v4 + Socket.IO v5 WebSocket 子集**：`0` open/`2` ping/`3` pong/`1` close/`4` message；`0` CONNECT/`1` DISCONNECT/`2` EVENT/`4` CONNECT_ERROR；不实现 HTTP long-polling、binary、ack、动态 namespace（`apps/api-go/internal/socketio/protocol.go` 顶部注释与解析器；`notificationssocket/connection.go:37+`）。ping 25s / timeout 20s、单消息上限 1 MB（`socketio/server.go:13-19`；notifications 默认在 `notificationssocket/runtime.go:30-33`）。
- **multiplex（只 realtime path）**：同一 Engine.IO 连接可依次 CONNECT 多个 namespace，各自独立 SID/鉴权/房间/`DISCONNECT`；未注册 namespace 回 `Invalid namespace` 且连接保持；`disconnect(true)` 会依 CONNECT 顺序对所有已连接 namespace 写 `41/<ns>,` 后关闭底层传输（`socketio/connection.go:218-260`；设计说明 `docs/refactor/go-realtime-socket.md`）。
- **通知 path 不支持 multiplex**：只接受 `/notifications` 的 CONNECT；其他 namespace 直接 `CONNECT_ERROR` + `DISCONNECT`（`notificationssocket/connection.go:44-51`）。
- **鉴权/限流/房间**：Go 用 `authn.Verifier`（JWT）+ Redis blacklist + MySQL `authz.Repository` 重新推导身份与权限；token 来源顺序按 Nest 每个网关的既有顺序复刻（`realtimesocket/namespaces.go:66-82` 的 `tokenOrderHeaderFirst`/`tokenOrderAuthFirst`；`realtimesocket/runtime.go:236-310`）；每 namespace 的权限门：newsnow `items.read`、ops `crawl.read` OR `crawl.write`、quality `settings.manage`、queue `queue.manage`、situation `items.read`（`realtimesocket/namespaces.go:114-157`）。房间同为 `org:`/`user:`/`ip:`，situation 额外全局房间（`realtimesocket/index.go:43-61`）。连接上限是**本进程实例计数**（`realtimesocket/runtime.go:407-424`；`notificationssocket/runtime.go:362-386`），与 Nest `UserSessionManager` 的 `server.in(room).allSockets()` 语义对齐（Nest 侧用 adapter 时是否跨实例计数未在本轮源码复核）。
- **长连接复核**：Go realtime 对所有 5 个 namespace 统一启用 30s JWT/blacklist/权限复核（`realtimesocket/options.go:76`、`realtimesocket/revalidate.go:10+`）；Nest 的 `/quality` 网关原本没有 `attachTokenRevalidation`，这是 Go 侧的有意安全增强（`realtimesocket/namespaces.go:131-139` 注释）。notifications 也同样 30s 复核（`notificationssocket/connection.go:111/206-210`）。

### 3. Redis adapter 与 `WS_REDIS_ADAPTER_ENABLED`

- Nest：`WS_REDIS_ADAPTER_ENABLED` **默认 true**（`env.schema.ts:541`），`WS_REDIS_ADAPTER_KEY` 默认 `socket.io`（`:542`）；`main.ts:122-142` 连接并 `app.useWebSocketAdapter(redisIoAdapter)`；`redis-io.adapter.ts:48-55` 用 `createAdapter(pub, sub, { key })`。关闭时 Nest 的 `server.to(room).emit` 只在本实例生效（`@socket.io/redis-adapter` 语义）。
- Go：读取同一组变量，`WS_REDIS_ADAPTER_ENABLED` 缺省 true、非法布尔值启动失败（`apps/api-go/internal/config/config.go:4253-4264`）；`WS_REDIS_ADAPTER_KEY` 为空则 `socket.io`（`:4263-4264`）。`API_GO_REALTIME_SOCKET_MODE=go` 且 adapter disabled 时**启动失败**（`apps/api-go/internal/config/config.go:6003-6011`）。Go 只用 adapter key 做 newsnow 的广播频道 pattern 订阅：`${key}#/newsnow#*`（`realtimeevents/sources.go:32/71`，`realtimeevents/adapter.go:63-65`），解码 `@socket.io/redis-adapter 8.3.0` 的 msgpack envelope（`realtimeevents/adapter.go:1-33`）。Go **不订阅** adapter 的 `-request#`/`-response#`（只 pattern 匹配广播频道），因此不会参与 Nest `serverCount()` 的节点 RPC。
- 通知 transport 不使用 adapter：它只在本地 `byUser`/`byOrg` 索引推送（`notificationssocket/runtime.go:339-386`），relay 通过 Redis Pub/Sub channel 分发。
- 依赖关系：只要 Nest 还负责生产 `/newsnow`（或 `/situation-monitor` 的 dispatcher）事件，Nest 的 adapter/生产链就要保持启用；Go 接管 `/newsnow` 后，事件源是 Redis 频道或 Go 的 relay，Go 本身不需要 Nest 的 Socket.IO 服务器，只需要 Redis。

### 4. 生产端与混合态行为（决定何时可以切、何时可以停 Nest）

- `/notifications`：
  - Go 模式改变 Nest 的生产路径：`NotificationsService.notify` 走 identifiers-only relay（`notifications.service.ts:42-49`；`notification-realtime.relay.ts:39-58`），不再走 in-process dispatcher；`generic-notification.subscriber` 在 go 模式不订阅 `notification:events:v1`（`generic-notification.subscriber.ts:83-86/149-155`）。
  - 其余 4 个 relay subscriber（alert/analysis/digest/news-source）只在各自上游生产开关为 go 时订阅（alert→`API_GO_ALERT_WORKER_MODE`、analysis→`API_GO_ANALYSIS_WORKER_MODE`、digest→`API_GO_USER_DIGEST_DELIVERY_MODE`、news-source→`API_GO_NEWS_SOURCE_SCHEDULER_MODE`/`API_GO_NEWS_SOURCE_OPS_MODE`/`API_GO_ITEM_PIPELINE_WORKER_MODE` 任一；`news-source-notification.subscriber.ts:139-148`），并用 `emitLocalNotification/emitLocalOrgNotification` 只发本实例 Nest socket（`alert-notification.subscriber.ts:67/156`、`analysis-notification.subscriber.ts:75/156`、`user-digest-notification.subscriber.ts:65/154`、`news-source-notification.subscriber.ts:75/182`）。
  - **混合态风险**：如果先把 Nest 的 `API_GO_NOTIFICATIONS_SOCKET_MODE=go` 打开、Web 仍旧连 `/socket.io`，则所有经 `NotificationsService.notify` 写入的 generic notification（无论调用方是 Nest 还是 Go）都只发 `notification:events:v1`，而 Nest 的 generic subscriber 已停订 → 仍连 Nest 的浏览器会漏掉这类通知。alert/analysis/digest/news-source 类在此窗口仍可由 Nest subscriber 推到 Nest socket（前提是其 worker 模式 go）。因此通知路径的切换应尽量与 Web 重建同步，并把「generic notification 漏推」写入回滚/验证清单。
- `/newsnow`：Go 的事件来自 adapter 广播与 `newsnow:source-refresh:v1` relay；**只有 `API_GO_NEWSNOW_SOURCES_MODE=go` 时 Go 拉取单元才会产生 relay**（`realtimeevents/sources.go:210-212` 明确 warn）。Nest 侧在没有显式 orgId 时用进程内 active-source 注册表解析目标 org（`apps/api/src/modules/news-aggregator/news-aggregator.service.ts:1242-1251`；注册表由 Nest gateway 的 `newsnow:set-active-sources` 填充，`newsnow-active-source-registry.service.ts:63-71`），Web 全部连到 Go 后 Nest 注册表为空 → Nest 不再产生 newsnow 广播（本轮未逐行复核 Nest 拉取链是否总带显式 orgId）。因此 `/newsnow` 的完整切流前置是 `NEWSNOW_SOURCES=go`；否则 Go 只保持连接、收不到更新。
- `/situation-monitor`：事件桥由 Nest dispatcher 在 `API_GO_REALTIME_SOCKET_MODE=go` 时发布（`situation-monitor-signals.dispatcher.ts:88-118`）；若 worker 移到 Go（`API_GO_SITUATION_SIGNALS_WORKER_MODE=go`），则 Go 直接发布同一 bridge。Nest 侧投递分两条：进程内 dispatcher 事件走 `broadcast()` + `sessions.emitToUser`（adapter 集群广播，`apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.gateway.ts:250-276`）；Go worker 写入 bridge 后由 `apps/api/src/modules/situation-monitor/signals/situation-monitor-signals-events.subscriber.ts:154` 调 `emitLocalEvent`（直推本地 socket、避免每实例重复，`apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.gateway.ts:297-351`）。Go realtime 的 bridge 消费复刻的是后者的本地语义（`realtimeevents/situation.go:87-121`）。两侧都停（Nest 停 + Go worker legacy）时该 namespace 无事件；停 Nest 前必须确认信号 worker 的 owner。
- `/queue`、`/ops`、`/quality`：Go 直接 `XREAD` BullMQ `bull:<queue>:events`（6 队列：`itemPipeline`、`crawl4ai-hot`、`crawl4ai-normal`、`analysis`、`assistant`、`alerts`；`realtimeevents/queues.go:24-31`）。事件是否存在取决于队列 worker 的 owner（阶段 4），与 Socket 传输开关无关；Go 侧只读、不消费/不 ACK（`realtimeevents/queues.go:18-22`）。
- `/socket.io`：Go 的默认 legacy 规则继续把 `/socket.io/` 转发 Nest（`proxy.go:145-146`），专用 path 不转发。也就是说「切流后 `/socket.io` 还需要 Nest」等价于「是否还有客户端连 `/socket.io`」；在 Nest 停之前，GraphQL 整份回退与未迁移 HTTP 也仍然需要 Nest，所以 **`/socket.io` 不能单独停**，它是阶段 6 的一部分。

### 5. Web 构建参数与默认值

- 变量：`NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH`、`NEXT_PUBLIC_REALTIME_SOCKET_PATH`，**默认都是 `/socket.io`**（`apps/web/lib/env.ts:29-43`；`.env.example:61/65`；`infra/docker/.env.sample:86/90`；compose 默认 `${…:-/socket.io}`：`infra/docker/docker-compose.yml:403-404/683-684/1710-1711`）。
- 语义：两个变量是 **构建期内联**（Next.js `NEXT_PUBLIC_*`；`apps/web/lib/env.ts` 在模块顶层读取并导出 `env`）。镜像构建时由 `infra/docker/runtime.Dockerfile:9-10` 的 `ARG` → `:31-32` 的 `ENV` 注入，然后在 `:51` 的 `turbo run build ... --filter=@modular/web` 中被内联；运行期再注入无效。`README.md:349` 明确写了「该变量是构建期内联，运行期注入无效」；compose 对 `NEXT_PUBLIC_API_BASE_URL` 的同义注释见 `infra/docker/docker-compose.yml:1750`。
- 8 处 `io()`（7 realtime + 1 notifications）全部把对应变量传给 `path`，且都使用 `websocket` 传输（除 situation 为 `["websocket","polling"]`）：
  1. `apps/web/app/(app)/newsnow/hooks/use-newsnow-stream.ts:94-99`（`/newsnow`，REALTIME）；
  2. `apps/web/app/(app)/admin/quality/quality-content.tsx:948-953`（`/quality`，REALTIME）；
  3. `apps/web/app/(app)/admin/ops/news-sources/use-news-sources-data.ts:643-648`（`/ops`，REALTIME）；
  4. `apps/web/app/(app)/dashboard/use-queue-events.ts:58-63`（`/queue`，REALTIME）；
  5. `apps/web/app/(app)/crawl/crawl-tasks.tsx:748-753`（`/ops`，REALTIME）；
  6. `apps/web/app/(app)/crawl/[taskId]/hooks/use-crawl-task-ops-live.ts:92-97`（`/ops`，REALTIME）；
  7. `apps/web/app/(app)/situation-monitor/hooks/use-situation-monitor-stream.ts:65-70`（`/situation-monitor`，REALTIME，`transports: ["websocket","polling"]` 在 `:67`）；
  8. `apps/web/app/(app)/components/use-notification-stream.ts:61-66`（`/notifications`，NOTIFICATIONS）。
- 两条 path 的变量独立：可以先切通知、再切实时（或反之），互不影响；但每条 path 的「Go 开关 + 反向代理 + Web 重建」必须成套。

### 6. 切流顺序、回退与 `/socket.io` 判定

建议顺序（两条 path 分别执行）：

1. **准备**：api-go 设置对应 `API_GO_*_SOCKET_MODE=go`；api 设置同一个值（Nest 需要用该值决定通知 relay / situation bridge；其余网关不受影响）。确认 `JWT_SECRET`/`DATABASE_URL`/`REDIS_HOST` 齐备；realtime 还需 `WS_REDIS_ADAPTER_ENABLED!=false`；`/newsnow` 事件还需 `API_GO_NEWSNOW_SOURCES_MODE=go`。
2. **反向代理**：把 `/socket.io-notifications/` 或 `/socket.io-realtime/` 路由到 api-go；`/socket.io/` 路由不变。
3. **重建 Web**：以对应 `NEXT_PUBLIC_*_SOCKET_PATH` 值重建 web 镜像并滚动重启；浏览器拿到新 bundle 后连 Go。
4. **验证**：每个 namespace 的 `*:connected`、错误事件、权限拒绝、断线重连、房间隔离（org/user）、多实例下的本地推送；realtime 还需验证 multiplex（同页多个 namespace 共用一条 websocket）与 newsnow 实际更新。
5. **回退**：先以 `/socket.io` 重建 Web，再摘除专用 path 的反向代理，最后把 api/api-go 两侧开关改回 `legacy` 并重启；浏览器重连回 Nest。无数据迁移/Redis 清理。注意：专用 path 没有 Nest 回退，若只改开关而不重建 Web，客户端会连到不存在的 path（Nest 404/握手失败）。

**`/socket.io` 何时可以停（指不再需要它的业务流量）**：两条 path 都已切 Go 且 Web 已重建、旧 bundle 已基本退场后，仓库内没有任何 `io()` 再指向 `/socket.io`；但 Nest 仍需为 GraphQL 回退/HTTP/队列运行到阶段 6。停 Nest 前建议用「`/socket.io/` 的 legacy 转发计数为 0」作为观测门槛（Go 的 legacy 代理计数器由 Lead 的本批改动引入，见 `proxy.go` 工作区 diff；该指标不在基线上，本审计不将其作为现状证据）。外部客户端/其他调用方无法从仓库核实。

### 7. 未核实项

- 未运行任何 Go 测试/pnpm/Docker/服务，也未做真实浏览器连接；所有协议行为来自源码静态阅读。`docs/refactor/go-realtime-socket.md` 中关于 `@socket.io/redis-adapter@8.3.0` 的 `sockets()`/`allSockets()` 结论未在本轮读 `node_modules` 复核。
- `socket.io-client@^4.8.1` 在 `transports: ["websocket","polling"]` 且未设 `tryAllTransports` 时的失败回退行为未运行验证；Go 只接受 `transport=websocket`，若 websocket 被代理阻断，situation-monitor 可能无 polling 回退。
- 仓库外是否还有客户端连 `/socket.io`（移动端/第三方）未核实。
- Nest 侧 `@socket.io/redis-adapter` 的跨实例连接计数/`serverCount()` 行为未运行验证；Go 的连接上限明确是实例本地计数（源码可证）。
- 通知混合态「generic notification 漏推」是静态推导，未在部署中实测；切换窗口的真实影响取决于 api/api-go/Web 的发布顺序与浏览器缓存。
- 生产反向代理配置不在本仓（未核实），`/socket.io-notifications`、`/socket.io-realtime` 的实际路由规则需部署侧确认。

### 行号口径

- 本文 `legacyproxy/proxy.go` 的行号取自基线 `dcbe563b`（`git show dcbe563b:apps/api-go/internal/legacyproxy/proxy.go`）：`/socket.io/` legacy 规则 145-146、`WithNotificationsSocket` 191-200、`WithRealtimeSocket` 206-215、`match` 814-829。本批 T5.6 的 metrics 增量（`ServeLegacy`→`proxyLegacy`）使本地行号整体 +1，不影响基线引用。
- 其余行号来自当前 worktree 文件（与基线一致；已用 `git diff dcbe563b` 核对 `main.go`/`config.go` 无改动）。

---

## 5. 异步执行权：BullMQ worker / Cron / Redis pub-sub（T1.4–T1.6）

<!-- 合并自 T1.4–T1.6 异步审计（task-3 产出）；原文，仅调整标题层级。 -->


> 审计窗口：2026-10-21；worktree `/Users/oo/project/newwei-go-cutover-readiness`，分支 `docs/go-cutover-readiness`，基线 `dcbe563b`（#136）。全部结论来自当前工作区源码静态阅读；未运行 `go build/test`、`pnpm`、Docker、队列或服务，因此**不声称**任何运行时/部署验证通过。
>
> 分类只使用 T1 定义：**A** = Go 可完全接管且有 `API_GO_*` 开关（go 时 Nest 明确返回/不创建/不订阅）；**B** = Nest 侧仅为兼容桥（Go→Nest 或 Nest→Go 的 Redis 桥），对应执行面迁走后可停用；**C** = 仍只能由 Nest 提供（真实缺口/后续批次）。

### 0. 统计口径与总览

#### 0.1 枚举命令（本文件所有计数可复现）

```bash
# worker：11 个 new Worker 构造点（crawl.processor 两个工厂各建多实例）
grep -rn "new Worker" apps/api/src --include=*.ts | wc -l                      # 11
grep -rn "@Processor" apps/api/src --include=*.ts | wc -l                      # 0
# 队列名：各模块 constants / new Queue(...) 交叉去重
grep -rn "new Queue(\|defaultJobOptions" apps/api/src/modules --include=*.ts
# cron / interval / timeout
grep -rn "@Cron(\|@Interval(\|@Timeout(" apps/api/src --include=*.ts         # 20 / 1 / 0
# Redis 订阅（业务站点）
grep -rn "\.subscribe(" apps/api/src --include=*.ts | grep -v "\.test\.ts"    # 12 处 = 9 业务直连 + 3 bus 内部
# 频道常量
grep -rn "CHANNEL\s*=" apps/api/src --include=*.ts | grep -v test
# Go 开关总数（Lead 已核）
grep -o 'getenv("API_GO_[A-Z0-9_]*")' apps/api-go/internal/config/config.go | sort -u | wc -l  # 131
```

口径说明：
- **队列数**按 BullMQ 队列名去重，不按文件/Worker 实例数。`new Worker` 11 处中，`crawl.processor.ts` 的两处工厂函数分别创建 3 个 crawl4ai Worker 和 2 个 Frontier LLM Worker；其余 9 处各创建 1 个。故 **15 个队列名 = 14 个有人消费的队列 + 1 个无消费者的 `itemPipelineDlq`**。
- **Cron 数**指 `@Cron`/`@Interval` 回调数（21），不含 repeatable 注册、`setInterval`、启动任务；这些单列在第 2.2 节。
- **订阅数**指 Nest 进程内实际执行的 Redis 订阅站点（10 个业务站点）与频道（12 个）。非测试源码中 `.subscribe(` 共 12 处 = 9 处业务直连 `subscriber.subscribe(<频道>)` + 3 处 GraphQL bus 内部（`graphql-subscription-bus.ts:154,183,340`）；Lead 初查的“16 处”应是包含 `unsubscribe`/测试/框架调用的粗计数，本文件以“频道×订阅点”为准。
- “go 模式下 Nest 行为”均按源码中的 gate 行号核对；默认值一律为 `legacy`（空串按 legacy）。

#### 0.2 总览

| 维度 | 数量 | A | B | C |
|---|---|---|---|---|
| BullMQ 队列 | 15（14 可消费 + 1 DLQ） | 14 个队列 / 11 个开关 | 0 | 1（`itemPipelineDlq` 无消费者） |
| `@Cron`/`@Interval` | 21（`@Cron` 20、`@Interval` 1、`@Timeout` 0） | 21 | 0 | 0（另有 10 项非装饰器调度/启动任务：A 7、B 1、C 2，见 2.2） |
| Redis 频道 | 12 个 Nest 实际订阅的频道 + 1 个名义频道 | 0 | 12 | 1（`gqlsub:queueEvents` 名义频道，Nest 用本地 PubSub） |

关键结论（详细证据见后文）：
1. **所有 14 个有消费者的 BullMQ 队列都已有独立 Go worker 开关与完整接线**；go 模式下 Nest 一律在创建 Worker 前退出创建路径（`return` 或 crawl 的 `if/else` 跳过；少数保留幂等 repeatable 注册，见 2.2）。唯一的结构性缺口是 `itemPipelineDlq`：两边都只生产、不消费，只能通过 Nest 的 Bull Board 人工处理。
2. **21 个定时回调全部有 Go 对应实现与执行权开关**；Nest 侧 gate 一律在领取 tick gate/lease 或读取数据**之前**返回。同一 job 不会长期双跑：除审计保留清理（Nest 侧无锁、DELETE 幂等）外，每个定时任务在两侧共用同一 Redis tick gate/lease 键（或同一 BullMQ repeat jobId），切换窗口内最多一边执行一次。
3. **Nest 侧 12 个 Redis 订阅频道全部是执行面迁移后的兼容桥/共享总线**（5 个通知 relay、situation-monitor 事件、NewsNow 源刷新、crawl 并发广播、telegram clear、3 个 `gqlsub:*`）；其中 `notification:events:v1`、`situation-monitor:signals:events:v1`、`gqlsub:*` 是**双向**通道（谁拥有对应执行面谁发布，另一侧消费），不能简单按“Go→Nest”单向理解。
4. **GraphQL Subscription 的 Redis PubSub 归属**：`GRAPHQL_SUBSCRIPTION_BUS=redis` 时 `GraphqlSubscriptionBus` 是 Nest 自己的订阅总线（`gqlsub:{alertEvents|analysisEvents|assistantEvents}`）；Go 有字节一致的 Go 实现并订阅相同频道。`queueEvents` 不走 Redis，Nest 用进程内 `QueueEventPublisher`，Go 用进程内 BullMQ observer。
5. **没有发现“漏接线”级别的最小修复**：11 个 worker 开关、21 个定时开关、10 项非装饰器调度/启动任务在 Nest 与 Go 两端都有读取点或明确的 Nest-only 归类。本批不需要改代码；C 类缺口留给后续业务批次。

### 1. T1.4 BullMQ worker 逐队列对照

#### 1.1 主表

> “依赖资源”以 `config.go` 的 go 模式硬校验为准（`apps/api-go/internal/config/config.go` 行号见每行）；Nest 侧同名的 `BULLMQ_WORKERS_ENABLED` 只被 itemPipeline/analysis/assistant/alerts 四个 processor 读取（见 1.3）。

| 名称（队列名） | Nest 源位置 file:line | Go 实现 file:line | 开关 | go 模式下 Nest 行为 | 依赖资源 | 分类 | 备注 |
|---|---|---|---|---|---|---|---|
| `itemPipeline` | `apps/api/src/modules/queue/queue.processor.ts:96-105`（gate）、`:110`（Worker）、`:106-109`（concurrency）；队列/重试 `apps/api/src/modules/queue/queue.module.ts:55-69`（attempts 5、exponential 1000ms）；DLQ `:334-341` | `apps/api-go/cmd/api/item_pipeline_worker.go:69-238`（gate `:75`、BULLMQ gate `:78`、`NewWorker` `:227`、concurrency `:222-225`）；队列名 `apps/api-go/internal/itempipeline/protocol.go:38`；DLQ 生产 `apps/api-go/internal/itempipeline/dlq.go:132-137` | `API_GO_ITEM_PIPELINE_WORKER_MODE` | `onModuleInit` 在 `:100` 判断后直接 `return`，不创建 Worker；Queue/QueueEvents provider 保留（`queue.module.ts:106`） | MySQL + Redis + Mongo + `SYSTEM_SETTINGS_ENCRYPTION_KEY`（`config.go:6236-6245`）；两端都看 `BULLMQ_WORKERS_ENABLED`（Go `item_pipeline_worker.go:78`） | **A** | 与 Nest 同读 `NEWS_PROCESS_QUEUE_CONCURRENCY`（Nest `queue.processor.ts:106-109`，Go `item_pipeline_worker.go:222-225`）；副作用：raw/processed Mongo、`ItemMeta` 状态、TaskLog、vector/outbox、news-source 快照与通知；最终失败写 `itemPipelineDlq`（jobId 格式 `dlq-itemPipeline-<id>-<attemptsMade>`，`dlq.go:132`） |
| `itemPipelineDlq` | `apps/api/src/modules/queue/queue.module.ts:75-99`（仅 Queue producer）；全仓无该队列的 `new Worker` | `apps/api-go/internal/itempipeline/dlq.go:108-137`（仅 producer） | 无独立开关；由 itemPipeline 失败路径写入 | 无 Worker（Nest 与 Go 都不消费） | 无（Bull Board 展示） | **C** | 唯一消费方式是 Nest Bull Board `/admin/queues`（legacy 代理），属运维人工处理（DLQ producer attempts=1：Nest `queue.module.ts:89`、Go `dlq.go:137`）；若停 Nest 需替代入口（见第 4 节选项） |
| `crawl4ai` | `apps/api/src/modules/crawl/crawl.processor.ts:525`（gate）、`:551-562`（三队列循环）、`:673-872`（`createWorker` 工厂）、`:977`（`registerQueueEvents`）；队列/重试 `apps/api/src/modules/crawl/crawl.module.ts:155-176`（attempts=`CRAWL4AI_MAX_RETRIES`） | `apps/api-go/cmd/api/crawl_worker.go:109-255`（gate `:116`、`crawlworker.New` `:232`）；队列名 `apps/api-go/internal/crawlqueue/model.go:27` | `API_GO_CRAWL_WORKER_MODE` | `onModuleInit` 在 `:525` 走无 Worker 分支（`if/else`，非 `return`）：不建 Worker、不注册 QueueEvents listener、不订阅 C2 通道（注释 `:520-524`） | MySQL + Redis + Mongo + `CRAWL4AI_BASE_URL` + `SYSTEM_SETTINGS_ENCRYPTION_KEY`（`config.go:5409-5421`） | **A** | 共享全局并发限制器、meta concurrency、memory-pressure 冷却重排、per-queue timeout；回调 `crawlExecutionService.runTask` / `crawlFrontierService.processQueuedNode`（`crawl.processor.ts:700-722`）；QueueEvents 的 stalled/completed/failed 副作用（`:977` 起）在 go 时随 Worker 一起消失，由 Go 侧等价实现接管（`crawl_worker.go` 注释 `:59-66`） |
| `crawl4ai-hot` | 同上 `crawl.processor.ts:525`、`:673-872`；队列定义 `crawl.module.ts:179-200`；名 `crawl.constants.ts:2` | 同 `crawl_worker.go:232`；名 `internal/crawlqueue/model.go:25` | `API_GO_CRAWL_WORKER_MODE` | 同上（三队列一起停） | 同上 | **A** | 优先级阈值 `CRAWL_HOT_PRIORITY_THRESHOLD=50`（`crawl.constants.ts:7`） |
| `crawl4ai-normal` | 同上；队列定义 `crawl.module.ts:203-224`；名 `crawl.constants.ts:3` | 同 `crawl_worker.go:232`；名 `internal/crawlqueue/model.go:26` | `API_GO_CRAWL_WORKER_MODE` | 同上 | 同上 | **A** | `CRAWL_QUEUE=CRAWL_QUEUE_NORMAL` 兼容别名（`crawl.constants.ts:19`） |
| `frontier-llm-judge` | `apps/api/src/modules/crawl/crawl.processor.ts:570`（gate）、`:880-921`（`createLlmWorker` 工厂）；队列定义 `crawl.module.ts:227-248`；名 `crawl.constants.ts:4` | `apps/api-go/cmd/api/crawl_frontier_llm.go:27-84`（gate `:34`）；名 `apps/api-go/internal/crawlfrontierllm/protocol.go:43`；worker `internal/crawlfrontierllm/runtime.go:57` | `API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE` | `:570` 判断后不创建两个 LLM Worker（与三个 crawl 队列开关相互独立，注释 `:565-569`） | MySQL + Redis + `SYSTEM_SETTINGS_ENCRYPTION_KEY`（`config.go:5391-5397`）；Mongo 仅用于请求日志（可选） | **A** | concurrency=1、limiter 1/1000ms（`crawl.processor.ts:913-919`；Go 日志 `crawl_frontier_llm.go:81`）；判断分支 `processQueuedLlmJudge` / `processQueuedLlmLearn`（`crawl.processor.ts:890-908`） |
| `frontier-llm-learn` | 同上 `crawl.processor.ts:570`、`:880-921`；队列定义 `crawl.module.ts:251-272`；名 `crawl.constants.ts:5` | `crawl_frontier_llm.go:27-84`；名 `protocol.go:44`；worker `runtime.go:64` | `API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE` | 同上 | 同上 | **A** | 同上 |
| `alerts` | `apps/api/src/modules/alerts/alerts.processor.ts:37-42`（gate）、`:43-74`（Worker、concurrency=`ALERT_QUEUE_CONCURRENCY`）；重复任务注册 `:31-32` + `alerts.service.ts:2538-2549`、`:1284-1301` | `apps/api-go/cmd/api/alert_worker.go:26-98`（gate `:33`）；消费者 `apps/api-go/internal/alertworker/service.go:176-203`；scan repeatable `internal/alertworker/queue/producer.go:260-272`；名 `internal/alertworker/queue/keys.go:9` | `API_GO_ALERT_WORKER_MODE` | 不创建 Worker（`:41` return），但**保留** `scheduleScanJob`/`ensureAllSchedules` 幂等注册（`:31-32`，注释 `:27-30`） | MySQL + Redis + Mongo + SMTP（`config.go:5426-5444`） | **A** | 消费完全可接管；但“活动规则全量 repeatable 对账”仍只在 Nest（`ensureAllSchedules`），Go 只有 scan 与规则变更时的 `EnsureRuleSchedule`（`producer.go:282`）。规则写仍属 Nest 的 workspace Mutation（0/11），本批列为 C 依赖，见第 4 节；扫描/规则 job 用队列默认重试，通知投递为 4 次 + `alertNotifications` 退避（`alerts.service.ts:1971,1981`） |
| `analysis` | `apps/api/src/modules/analysis/analysis.processor.ts:41`（BULLMQ gate）、`:50-60`（gate + bus 校验）、`:61-76`（Worker/concurrency） | `apps/api-go/cmd/api/analysis_runs.go:70-155`（gate `:76`、`analysisqueue.NewWorker` `:132`）；名 `internal/analysisqueue/protocol.go:39` | `API_GO_ANALYSIS_WORKER_MODE` | `:50` 为 go 时：若 `GRAPHQL_SUBSCRIPTION_BUS != redis` 直接抛错（`:51-55`），否则不创建 Worker（`:59` return） | MySQL + Redis + Mongo + `GRAPHQL_SUBSCRIPTION_BUS=redis`（`config.go:5512-5521`） | **A** | 双读同一 `GRAPHQL_SUBSCRIPTION_BUS`；失败/stalled 的最终通知逻辑在 Nest `:96-140`，Go 侧由 `analysisruns` 等价实现；发布 `gqlsub:analysisEvents` + `analysis:notification:v1`；重试 `ANALYSIS_MAX_RETRIES`（`analysis.service.ts:69`） |
| `assistant` | `apps/api/src/modules/assistant/assistant.processor.ts:28`（BULLMQ gate）、`:36-43`（gate）、`:44-58`（Worker） | `apps/api-go/cmd/api/assistant_runs.go:104-119`（gate `:105`）；名 `internal/assistantqueue/types.go:20` | `API_GO_ASSISTANT_WORKER_MODE` | 为 go 时 return，不创建 Worker；Queue/QueueEvents 保留用于提交与 `AssistantQueueEventPublisher`（注释 `:32-35`） | MySQL + Redis + Mongo（`config.go:6088-6094`） | **A** | 发布 `gqlsub:assistantEvents`；重试 `ASSISTANT_MAX_RETRIES`（`assistant.service.ts:175`）；SSE 流式写入由 `assistantruns` 服务承担，不在 worker 内验证 |
| `archivePreparation` | `apps/api/src/modules/archive/archive-preparation.processor.ts:41-50`（gate）、`:51-81`（Worker/concurrency 1）；名 `archive-preparation.constants.ts:3` | `apps/api-go/cmd/api/archive_preparation_worker.go:61-115`（gate `:62`、`NewWorker` `:104`）；名 `internal/archivepreparation/producer.go:29` | `API_GO_ARCHIVE_PREPARATION_WORKER_MODE` | `:41` 判断后 return，不创建 Worker、不注册 failed listener | MySQL + Redis + Mongo + `SYSTEM_SETTINGS_ENCRYPTION_KEY`（`config.go:6222-6231`） | **A** | 队列重试 attempts=5（`archive-preparation-queue.service.ts:138`）；Go 侧 concurrency 1 |
| `akshare-data` | `apps/api/src/modules/akshare/akshare.processor.ts:32-47`（`onApplicationBootstrap` gate `:38-44`、Worker `:47`）；启动重复任务 `akshare.service.ts:153-166`（go 时跳过 catalog/repeatables） | `apps/api-go/cmd/api/economic_data.go:80-176`（`workerGo` `:89`、`economicqueue.NewWorker` `:168`）；名 `internal/economicqueue/job.go:10` | `API_GO_ECONOMIC_DATA_WORKER_MODE` | `onApplicationBootstrap` 直接 return；`AkshareService.onModuleInit` 也不再 `ensureCatalog`/`ensureRepeatableJobs` | MySQL + Redis + Mongo（`config.go:6121-6127`） | **A** | Go 启动时自己 `EnsureCatalog`/`EnsureRepeatableJobs`（`economic_data.go:40-44`）；Nest 在请求开关仍 legacy 时仍可从 `updateFetchConfig` 调 `ensureRepeatableJobs`（`akshare.service.ts:2560`），两边是同一批 repeatable 的幂等 upsert |
| `classification_quality` | `apps/api/src/modules/observability/classification-quality.processor.ts:35-44`（gate）、`:52-96`（Worker/concurrency） | `apps/api-go/cmd/api/quality_ops.go:52-130`（`workerGo` `:61`、`qualityqueue.NewWorker` `:106`）；名 `internal/qualityqueue/keys.go:7` | `API_GO_CLASSIFICATION_QUALITY_WORKER_MODE` | `:39` 判断后 return，不创建 Worker；Queue 保留（news pipeline 仍生产 review-seed 任务，注释 `:30-34`） | MySQL + Redis + Mongo（`config.go:5607-5613`） | **A** | 两种 payload：`report` / `review_seed_item`（`classification-quality.constants.ts:6-25`）；并发取 `NEWS_PROCESS_QUEUE_CONCURRENCY` 后 clamp 1..4（Nest `:46-50`），Go 用 `QualityWorkerConcurrency()`；队列默认 attempts=3（`observability.module.ts:96`） |
| `news_event_clustering_recovery` | `apps/api/src/modules/news-events/news-event-clustering-recovery.processor.ts:24-43`（gate）、`:50-69`（Worker）；5 分钟扫描 `apps/api/src/modules/news-events/news-event-clustering-recovery-scheduler.service.ts:23-40`；名 `apps/api/src/modules/news-events/news-event-clustering-recovery.constants.ts:1-2` | `apps/api-go/cmd/api/news_backfill_jobs.go:91-210`（`workerGo` `:100`、`service.NewWorker` `:186`、scan `:188-189`）；名 `internal/clusteringrecoveryqueue/protocol.go:41` | `API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE` | processor 与 scheduler 均在创建 Worker/抢扫描锁前 return（`:34-43`、`scheduler:29-36`） | MySQL + Redis + Mongo（`config.go:6211-6217`） | **A** | 同一开关同时接管 consumer + 5 分钟扫描；任务 attempts=1（`news-event-clustering-recovery.service.ts:229`）；Go scan 5 分钟（`internal/newsbackfilljobs/scan_scheduler.go:19`） |
| `situationMonitorSignals` | `apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.processor.ts:48-62`（gate）、`:64`（repeatable）、`:66-88`（Worker/concurrency 1）；名 `apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.constants.ts:1` | `apps/api-go/cmd/api/situation_signals_worker.go:45-152`（gate `:46`、`EnsureRepeatables` `:125`、queue `:139`）；名 `internal/situationsignalsworker/job.go:9` | `API_GO_SITUATION_SIGNALS_WORKER_MODE` | go 时**不碰任何 scheduler、不创建 Worker**（注释 `:49-52`） | MySQL + Redis（`config.go:6160-6163`）；Telegram/OREF 由 env/设置决定 | **A** | Nest 侧 repeatable 在 `ensureRepeatableJobs`（`:111-140`，`upsertJobScheduler`/OREF repeat）；Go `EnsureRepeatables`（`internal/situationsignalsworker/repeatables.go:66`）先注册再消费；MTProto 单实例租约 `telegramclient.DefaultLeaseKey`（`situation_signals_worker.go:56`）；队列默认 attempts=3（`situation-monitor-signals.module.ts:48`） |

> **#136 Frontier 接线约束**：`API_GO_CRAWL_WORKER_MODE=go` 时，三个 crawl4ai 队列会 claim `frontier_node` 任务，因此 Go 的 crawl worker 必须在 `wireCrawlWorker` 内自建 `crawlfrontiernode` processor（`apps/api-go/cmd/api/crawl_worker.go:285-351`）；缺失或构造失败会直接让启动失败（`errCrawlWorkerFrontierProcessor` `:57`，检查 `:224-228`），不能 claim 却无法执行。该 processor 复用同一个 `crawlexecution.Service`（媒体/S3、通知 relay；Frontier 路径保持 `ingestToItems=false`），见 `:257-284` 注释。Frontier LLM 两队列的开关独立于三 crawl 队列（`crawl.processor.ts:565-569`；`crawl_worker.go:8-11`）。

#### 1.2 go 模式下 Nest 的具体行为（按开关）

| 开关 | Nest 读取点 | go 时行为 |
|---|---|---|
| `API_GO_ITEM_PIPELINE_WORKER_MODE` | `queue.processor.ts:96-105` | `return`，不建 Worker；Queue/QueueEvents 仍在（`queue.module.ts:55,106`） |
| `API_GO_CRAWL_WORKER_MODE` | `config.service.ts:1337-1344` → `crawl.processor.ts:525` | 走 `if/else` 的无 Worker 分支：三队列都不建 Worker/QueueEvents/C2 订阅（不是 `return`，而是跳过整段创建） |
| `API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE` | `config.service.ts:1324-1331` → `crawl.processor.ts:570` | 不建两个 LLM Worker；三 crawl 队列行为不受影响 |
| `API_GO_ALERT_WORKER_MODE` | `alerts.processor.ts:37-42`（helper `:93-99`） | 不建 Worker，但**继续**注册 scan/rule repeatable（`:31-32`） |
| `API_GO_ANALYSIS_WORKER_MODE` | `config.service.ts:1312-1319` → `analysis.processor.ts:50-60` | 不建 Worker；`GRAPHQL_SUBSCRIPTION_BUS!=redis` 时启动失败 |
| `API_GO_ASSISTANT_WORKER_MODE` | `assistant.processor.ts:36-43` | 不建 Worker；Queue/QueueEvents 保留 |
| `API_GO_ARCHIVE_PREPARATION_WORKER_MODE` | `archive-preparation.processor.ts:41-50` | 不建 Worker、不注册 failed listener |
| `API_GO_ECONOMIC_DATA_WORKER_MODE` | `akshare.processor.ts:38-44`；`akshare.service.ts:157-163` | 不建 Worker；不再 ensure catalog/repeatables |
| `API_GO_CLASSIFICATION_QUALITY_WORKER_MODE` | `classification-quality.processor.ts:35-44` | 不建 Worker；Queue 保留 |
| `API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE` | `apps/api/src/modules/news-events/news-event-clustering-recovery.processor.ts:34-43`；`apps/api/src/modules/news-events/news-event-clustering-recovery-scheduler.service.ts:29-36` | consumer 与 5 分钟扫描都不启动 |
| `API_GO_SITUATION_SIGNALS_WORKER_MODE` | `apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.processor.ts:53-62`；`apps/api/src/modules/situation-monitor/signals/situation-monitor-signals-events.subscriber.ts:139-146` | 不注册 repeatable、不建 Worker；事件桥订阅也关闭 |

#### 1.3 “双读同一开关”与切换顺序

- 以上 11 个 worker 开关都是 **Nest 与 api-go 同时读取的同名环境变量**（Nest 侧读取点见 1.2 表；Go 侧读取点见 1.1 表 gate 行）。两个服务必须读同一个值；混用（例如 api=go、api-go=legacy）会造成该队列**无人消费**，反向混用则**双消费者**（同一 job 被两边 claim，至少重复执行一次）。
- 建议顺序：**先把 `api`（Nest）设 go 并重启，确认 Worker 已退出；再把 `api-go` 设 go 并重启**。回退反向：先 api-go 回 legacy，再 api 回 legacy。理由：先停 Nest 再启 Go 只损失一个切换窗口的消费能力（不重复），反之会双消费。
- 四个 processor 还共同读取 `BULLMQ_WORKERS_ENABLED`（Nest `queue.processor.ts:89`、`analysis.processor.ts:41`、`assistant.processor.ts:28`、`alerts.processor.ts:33`；Go `item_pipeline_worker.go:78`、`crawl_worker.go:119`、`crawl_frontier_llm.go:37`、`analysis_runs.go:79`）。`BULLMQ_WORKERS_ENABLED=false` 时即使 switch=go 也不启动；但 archive/akshare/quality/clustering/situation/alert 的 Go 侧**不检查**该变量，部署时不要只靠它做总开关。
- 队列的并发/重试参数也双读（例：`NEWS_PROCESS_QUEUE_CONCURRENCY`、`CRAWL4AI_MAX_CONCURRENCY`/`MAX_RETRIES`/`RETRY_BACKOFF_MS`、`ALERT_QUEUE_CONCURRENCY`、`ANALYSIS_*`、`ASSISTANT_*`）。这些不需要完全一致才能切换，但并发差异会让切换前后的吞吐/重试次数不同，建议在切换前对齐。

#### 1.4 需要与 worker 区分开的两类“非 Worker 消费者”

1. **QueueEvents 读侧（Nest 保留）**：`queue.module.ts:106`、`crawl.module.ts:275-318`、`alerts.module.ts:133`、`analysis.module.ts:53`、`assistant.module.ts:55`、`archive.module.ts:63`、`akshare.module.ts:79`、`situation-monitor-signals.module.ts:69` 共 10 个 `QueueEvents` provider。它们不是 worker，go 模式下大多仍保留（crawl 三队列的 listener 在 go 时不注册），服务 Nest 的读路径：`queue-org-stats.tracker.ts`、`queue-event.publisher.ts`、`crawl-queue-event.publisher.ts`、alerts metric providers。停 Nest 前这些读路径必须已有 Go 承接（GraphQL/REST 读侧见 T1.1/T1.2；`queueEvents` 订阅 Go 已有本地 observer，`internal/graphqlsubscriptions/source.go:58`）。
2. **BullMQ 清理**：见 2.2 表（`API_GO_BULLMQ_CLEANUP_MODE`），它定时 `clean` 15 个队列的完成/失败任务，不是消费者。

### 2. T1.5 Cron / Interval / 启动任务

#### 2.1 `@Cron` / `@Interval` 全表（21）

| 名称（回调） | Nest 源位置 file:line | Go 实现 file:line | 开关 | go 模式下 Nest 行为 | 依赖资源 | 分类 | 备注 |
|---|---|---|---|---|---|---|---|
| `retryPendingAuditLogOutbox`（每分钟） | `apps/api/src/modules/audit/audit-log-outbox.service.ts:58`（gate `:63`，锁 `:13`=`cron:audit-log-outbox`） | `apps/api-go/cmd/api/audit_outbox.go:21-42`（gate `:22`）；`internal/auditoutbox/scheduler.go:119`（对齐下一分钟）；main 启动 `main.go:3061-3067` | `API_GO_AUDIT_OUTBOX_MODE` | 抢锁前 return | MySQL + Redis（`config.go:5344-5347`）；`SCHEDULE_ENABLED=false` 时 Go 也不启动（`audit_outbox.go:25`） | **A** | 锁键物理名 `lock:cron:audit-log-outbox`（CacheService `cache.service.ts:309` 加 `lock:` 前缀）；审计 Outbox 生产者包括 Go 的多个写路径（见 async-runtime 模块页） |
| `adjustCron`（每分钟） | `apps/api/src/modules/crawl/crawl-adaptive-concurrency.service.ts:86`（gate `:91-95`，锁 `:16`） | `apps/api-go/cmd/api/crawl_maintenance.go:93-206`（`maintenanceGo` `:99`）；`internal/crawlmaintenance/adaptive.go:90` | `API_GO_CRAWL_MAINTENANCE_MODE` | 抢锁前 return | MySQL + Redis + Mongo（`config.go` go 校验）；`SCHEDULE_ENABLED` | **A** | 与 Nest 同用 `cron:crawl-adaptive-concurrency`；Go 额外发布 `crawl:worker-concurrency:v1` |
| `retryPendingCleanupOutbox`（每分钟） | `apps/api/src/modules/crawl/crawl-cleanup-outbox.service.ts:45`（gate `:50-54`，锁 `:13`） | `crawl_maintenance.go:93-206`；`internal/crawlmaintenance/cleanup_outbox.go:78` | `API_GO_CRAWL_MAINTENANCE_MODE` | 抢锁前 return | 同上 | **A** | 清理 Mongo 内容 + `MongoOutbox` 状态/退避 |
| `refreshRecentSnapshots`（每 5 分钟） | `apps/api/src/modules/crawl/crawl-quality-task-snapshot.service.ts:94`（gate `:99-103`，tick gate `:96`） | `crawl_maintenance.go:93-206`；`internal/crawlmaintenance/quality_snapshot.go:62` | `API_GO_CRAWL_MAINTENANCE_MODE` | 抢 tick gate 前 return | 同上 | **A** | 共享 `cron:crawl-quality-task-snapshot:tick-gate` + 组织锁 |
| `cleanupCron`（每分钟） | `apps/api/src/modules/crawl/crawl-task-janitor.service.ts:34`（gate `:39-43`，锁 `:34-48`） | `crawl_maintenance.go:93-206`；`internal/crawlmaintenance/janitor.go:86` | `API_GO_CRAWL_MAINTENANCE_MODE` | 读 activity/抢锁前 return | 同上 | **A** | 共享 `lock:cron:crawl-task-janitor`；activity 计数为 0 时 Go 仍检查 stale pending（注释 `janitor.go:113`） |
| `retryPendingRawItemOutbox`（每分钟） | `apps/api/src/modules/items/raw-item-outbox.service.ts:152`（gate `:160-166`，锁 `:27`） | `apps/api-go/cmd/api/items_ingest.go:46-58`（`wireRawItemOutboxScheduler`，gate `:51`）；`main.go:3068-3071` | `API_GO_RAW_ITEM_OUTBOX_MODE` | 抢锁前 return | MySQL + Redis + Mongo（`config.go:5794-5800`）；`SCHEDULE_ENABLED` | **A** | 只迁“定时重放”；同步 `deliverNow` 仍在 Nest 请求路径，靠行 CAS 与 Go 竞争（注释 `:154-159`） |
| `ingestRecentProcessedArticles`（5 分钟） | `apps/api/src/modules/knowledge-graph/knowledge-graph.ingestion.service.ts:42`（gate `:49-56`，tick gate `cron:knowledge-graph-ingestion:tick-gate`） | `apps/api-go/cmd/api/kg_ingestion.go:57-123`（gate `:63`）；`internal/kgingestion/scheduler.go:29`（5 分钟） | `API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE` | 抢 tick gate 前 return | MySQL + Redis（`config.go:5358-5361`） | **A** | Go 同 tick gate + 组织锁 |
| `refreshScheduled`（10 分钟） | `apps/api/src/modules/news-aggregator/newsnow-hottest-analysis.scheduler.service.ts:32`（gate `:38-42`） | `apps/api-go/cmd/api/newsnow_hottest.go:31-166`（`backgroundGo` `:62`、Start `:155-166`）；`internal/newsnowhottest/scheduler.go:117`（10 分钟，interval `:26`） | `API_GO_NEWSNOW_BACKGROUND_MODE` | 抢 tick gate 前 return | MySQL + Redis + Mongo（unit 构建 `:64-79`） | **A** | 与 source warm 同开关；同 `cron:newsnow-hottest-analysis:tick-gate` |
| `refreshScheduled`（1 分钟，源预热） | `apps/api/src/modules/news-aggregator/newsnow-source-warm.scheduler.service.ts:26`（gate `:31-35`，锁 `cron:newsnow-source-warm`） | `newsnow_hottest.go:31-166`（warm `internal/newsnowhottest/scheduler.go:409`（1 分钟，interval `:32`）） | `API_GO_NEWSNOW_BACKGROUND_MODE` | 抢锁前 return | 同上 | **A** | 同锁键 |
| `enqueuePendingLlmBackfills`（5 分钟） | `apps/api/src/modules/news-events/news-event-clustering-recovery-scheduler.service.ts:23`（gate `:28-36`，锁 `cron:news-event-clustering-recovery`） | `apps/api-go/cmd/api/news_backfill_jobs.go:91-210`（`cronGo` 不控制此 scan；`workerGo` `:100` 启动 scan `:188-189`）；`internal/newsbackfilljobs/scan_scheduler.go:19` | `API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE` | 抢锁前 return | MySQL + Redis + Mongo（`config.go:6211-6217`） | **A** | 同一开关兼管 worker 与扫描 |
| `ingestRecentProcessedArticles`（5 分钟，新闻事件） | `apps/api/src/modules/news-events/news-events-ingestion.service.ts:44`（gate `:52-59`，tick gate `cron:news-events-ingestion:tick-gate`） | `apps/api-go/cmd/api/news_events_ingestion.go:54-110`（gate `:60`）；`internal/newseventsingest/scheduler.go:35`（5 分钟） | `API_GO_NEWS_EVENTS_INGESTION_MODE` | 抢 tick gate 前 return | MySQL + Redis + Mongo（`config.go:5372-5378`） | **A** | 同 tick gate + 组织锁；分配靠唯一键幂等 |
| `rebuildRecentTimelines`（10 分钟） | `apps/api/src/modules/news-events/news-events-timeline.service.ts:184`（gate `:190-197`，tick gate `cron:news-events-timeline:tick-gate`） | `apps/api-go/cmd/api/event_timeline_sentiment.go:42-117`（`timelineOwnedByGo` `:49`、Start `:106-108`）；`internal/newseventtimeline/scheduler.go:19`（10 分钟） | `API_GO_NEWS_EVENTS_TIMELINE_MODE` | 抢 tick gate 前 return | MySQL + Redis + Mongo（`config.go:6265-6271`） | **A** | 同 tick gate + 组织锁 |
| `refreshAssociations`（6 小时） | `apps/api/src/modules/news-indicator/news-indicator-association.ingestion.service.ts:35`（gate `:40-47`，tick gate `cron:news-indicator-association:tick-gate`） | `apps/api-go/cmd/api/news_backfill_jobs.go:196-208`（`cronGo` `:101`、`AssociationScheduler`）；`internal/newsbackfilljobs/association_scheduler.go:23` | `API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE` | 抢 tick gate 前 return | MySQL + Redis（`config.go` 校验） | **A** | 同 tick gate + 组织锁（TTL 5h55m） |
| `retryPendingOutbox`（5 分钟） | `apps/api/src/modules/news-pipeline/news-pipeline.service.ts:191`（gate `:196`，直接读 `process.env`） | `apps/api-go/cmd/api/processed_item_outbox.go:23-49`（gate `:29`）；`main.go:3072-3095`（`ScheduleEnabled` 判断） | `API_GO_PROCESSED_ITEM_OUTBOX_MODE` | 直接 return | MySQL + Redis + Mongo（`config.go:5808-5814`）；`SCHEDULE_ENABLED` | **A** | 只迁“进程级补偿扫描”；Nest 的 immediate/in-process 重试保留；Go itemPipeline 内的 immediate delivery 与补偿共用 CAS |
| `evaluate`（`@Interval` 5 分钟） | `apps/api/src/modules/observability/classification-quality-alert-scheduler.service.ts:40-45`（gate `:48-56`，tick gate `cron:classification-quality-alert:tick-gate`） | `apps/api-go/cmd/api/realtime_socket.go:159`（`wireClassificationAlert`）；`internal/classificationalert/scheduler.go:31`（5 分钟） | `API_GO_CLASSIFICATION_QUALITY_ALERT_MODE` | 抢 tick gate 前 return | MySQL + Redis + Mongo（`realtime_socket.go:41-43` 注释与构造校验） | **A** | `@Interval` 是唯一非 CronExpression 装饰器；Go 同 tick gate + 组织锁 |
| `scheduleCron`（每 30 秒） | `apps/api/src/modules/queue/news-source.scheduler.service.ts:266`（gate `:273-279`，锁 `cron:news-source-scheduler`） | `apps/api-go/cmd/api/news_source_scheduler.go:42`（`schedulerGo` `:52`）；`internal/newssourcescheduler/scheduler.go:15`（30s） | `API_GO_NEWS_SOURCE_SCHEDULER_MODE` | 抢锁前 return | MySQL + Redis（`config.go:5732-5735`）；ops/通知需要 Mongo（`news_source_scheduler.go:58-60`） | **A** | 同锁键；`onModuleInit` 的 RSS seed TTL 迁移**故意保留在 Nest**（`news-source.scheduler.service.ts:244-246`，幂等，双侧可跑） |
| `handleCron`（每天 01:00） | `apps/api/src/modules/rbac/audit-log-retention.service.ts:19`（gate `:24-29`） | `apps/api-go/cmd/api/crawl_maintenance.go:101-108`（`auditGo` `:100`）；`internal/crawlmaintenance/audit_retention.go:36` | `API_GO_AUDIT_LOG_RETENTION_MODE` | 读取保留天数前 return | MySQL + Redis（`config.go:5710-5713`）；`SCHEDULE_ENABLED` | **A** | Nest 侧无锁（注释 `:21-24`），切换窗口可能双跑一次；DELETE 幂等。Go 用 `lock:cron:audit-log-retention`（`audit_retention.go:17`） |
| `refreshScheduled`（每分钟） | `apps/api/src/modules/realtime-signals/realtime-signals.service.ts:112`（gate `:118-123`，tick gate `cron:realtime-signals:tick-gate`） | `apps/api-go/cmd/api/realtime_signals.go:33-63`（构造 gate `:34`、Start `:54-63`）；`internal/realtimesignals/scheduler.go:11`（1 分钟） | `API_GO_REALTIME_SIGNALS_MODE` | 抢 tick gate 前 return | MySQL + Redis + Mongo（`realtime_signals.go:33-52`） | **A** | 同 tick gate + 组织锁 + `cron:realtime-signals:opensky-all-capture` |
| `rebuildRecentSnapshots`（每小时） | `apps/api/src/modules/sentiment/sentiment-snapshot.ingestion.service.ts:57`（gate `:64-71`，tick gate `cron:sentiment-snapshot:tick-gate`） | `event_timeline_sentiment.go:42-117`（`sentimentOwnedByGo` `:50`、Start `:110-112`）；`internal/sentimentsnapshot/model.go:14`（1h） | `API_GO_SENTIMENT_SNAPSHOT_MODE` | 抢 tick gate 前 return | MySQL + Redis + Mongo（`config.go:6276-6282`） | **A** | 同 tick gate + 组织锁 |
| `refreshScheduled`（每 15 分钟，GDELT） | `apps/api/src/modules/situation-monitor/situation-monitor-external-snapshot.service.ts:125`（gate `:135-139`，锁 `cron:situation-monitor:external-snapshot:gdelt`） | `apps/api-go/cmd/api/gdelt_snapshot.go:37-90`（构造 `:37-56`、Start gate `:58`）；`internal/gdeltsnapshot/scheduler.go`（15 分钟） | `API_GO_GDELT_SNAPSHOT_MODE` | 抢 lease 前 return（注意 `isGdeltEnabled()` 在 gate 之前） | MySQL + Redis（`config.go:6289` 起） | **A** | 强制刷新 POST 是独立开关 `API_GO_GDELT_SNAPSHOT_REFRESH_MODE`（`gdelt_snapshot.go:68-69`），与本 cron 无关 |
| `runScheduledDeliveries`（每分钟） | `apps/api/src/modules/user-digest/user-digest-delivery-scheduler.service.ts:32`（gate `:37-43`，tick gate `cron:user-digest-delivery:tick-gate`） | `apps/api-go/cmd/api/digest_delivery.go:23-60`（gate `:29`）；`internal/userdigest/delivery_scheduler.go:143-165`（对齐分钟） | `API_GO_USER_DIGEST_DELIVERY_MODE` | 抢 tick gate 前 return | MySQL + Redis + Mongo + SMTP（`config.go:5317-5335`） | **A** | 同 tick gate + 组织锁；真实 SMTP |

> 21 项均为 **A**：都有 `API_GO_*` 开关，go 时 Nest 在产生副作用前返回，Go 有等价实现和共享租约。没有任何 cron 是“只能 Nest”。（`@Timeout` 装饰器 0 个。）

#### 2.2 非装饰器调度 / repeatable / 启动任务（有副作用）

| 名称 | Nest 源位置 file:line | Go 实现 file:line | 开关 | go 模式下 Nest 行为 | 依赖资源 | 分类 | 备注 |
|---|---|---|---|---|---|---|---|
| 告警 scan repeatable（`scan-active-rules`，每 `ALERT_SCAN_INTERVAL_MS`） | `apps/api/src/modules/alerts/alerts.service.ts:2538-2549`，由 `alerts.processor.ts:31-32` 在 onModuleInit 调用 | `apps/api-go/internal/alertworker/queue/producer.go:260-272`；`internal/alertworker/service.go:176` | `API_GO_ALERT_WORKER_MODE` | **保留注册**（幂等），只停 Worker | Redis（BullMQ） | **B（共享注册）** | 同一 `jobId=scan-active-rules`，双侧 upsert 不会产生两个 repeatable；双跑风险由 BullMQ repeat 去重 + 单 job 消费避免 |
| 告警规则级 repeatable（`evaluate-<ruleId>`） | `apps/api/src/modules/alerts/alerts.service.ts:1284-1301`（`ensureAllSchedules`）、`:2554-2570`（单规则） | 仅单规则：`internal/alertworker/queue/producer.go:282`（`EnsureRuleSchedule`，由规则变更/评估触发） | `API_GO_ALERT_WORKER_MODE` | 保留全量对账（Nest 仍负责所有规则枚举） | MySQL + Redis | **C（残留职责）** | **全量规则对账没有 Go 等价实现**；只要告警规则写仍在 Nest（workspace Mutation 0/11），这是合理依赖。若将来迁规则写，必须补 Go 对账（见第 4 节） |
| 经济数据 catalog + repeatables | `apps/api/src/modules/akshare/akshare.service.ts:153-166`（onModuleInit）、`:949`（`ensureRepeatableJobs`）、`:2560`（设置更新后） | `apps/api-go/cmd/api/economic_data.go:40-44`（`EnsureCatalog`/`EnsureRepeatableJobs`） | `API_GO_ECONOMIC_DATA_WORKER_MODE` | onModuleInit 直接 return（`:157-163`）；设置更新路径仍可按请求开关 legacy 触发 | MySQL + Redis | **A** | 两边写同一批 repeatable，幂等；Go 启动时先注册再消费 |
| situation Telegram/OREF repeatables | `apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.processor.ts:64`、`:111-140`；`situation-monitor-telegram-scheduler.ts:16-67` | `apps/api-go/internal/situationsignalsworker/repeatables.go:66`；`cmd/api/situation_signals_worker.go:118-152` | `API_GO_SITUATION_SIGNALS_WORKER_MODE` | go 时完全不碰 scheduler（`:57-62`） | Redis + 设置行 + MTProto 租约 | **A** | 同一 `telegram-poll:scheduler` + OREF repeat；Go 先 `EnsureRepeatables` 再 claim；MTProto 租约 `telegramclient.DefaultLeaseKey` 防双连接 |
| News-source RSS seed TTL 迁移 | `apps/api/src/modules/queue/news-source.scheduler.service.ts:244-246`（onModuleInit） → `:3471` `ensureLegacyRssSeedCacheTtlMigrated`（锁 `migration:news-source:rss-seed-cache-ttl-600`） | 无 | 无（不受 `API_GO_NEWS_SOURCE_SCHEDULER_MODE` 控制） | **永远执行**（双侧可跑，幂等） | Redis | **C（Nest 自有，低风险）** | 一次性迁移；Nest 停用后不再需要；Go 缺失不造成执行权冲突 |
| BullMQ completed/failed 保留任务清理（`setInterval` 1h + 启动立即一次） | `apps/api/src/common/bullmq-queue-cleanup.service.ts:22-27`（timer）、`:104-118`（interval/immediate）、`:96`（gate） | `apps/api-go/cmd/api/nest_residual_duties.go:107-127`（gate `:108`）；`internal/bullmqcleanup/scheduler.go:18-21`（lease 55m，hourly） | `API_GO_BULLMQ_CLEANUP_MODE` | 不启动 timer（仍 track 资源以便关闭） | Redis | **A** | Nest 无锁 N 实例重复清理（注释 `:90-96`）；Go 用 `cron:bullmq-retained-cleanup` 租约单实例执行 |
| 启动对账：ES `ensureIndex` | `apps/api/src/modules/items/items-elasticsearch.service.ts:219-234`（gate `:223-231`） | `apps/api-go/internal/startupreconcile/reconcile.go:130-160`（`EnsureIndex` 分支 `:157`） | `API_GO_STARTUP_RECONCILE_MODE` | 启动时 return，不建索引 | Redis + ES（可选）+ MySQL/Mongo | **A** | Go 在 `lock:startup:reconcile` 租约下执行（`reconcile.go:31-35`） |
| 启动对账：TaskLog TTL | `apps/api/src/modules/system-settings/task-log-settings.service.ts:61-72`（gate `:65-72`） | `internal/startupreconcile/reconcile.go:145-149` | `API_GO_STARTUP_RECONCILE_MODE` | 启动时 return | MySQL + Mongo + Redis | **A** | 同上 |
| 启动对账：LLM request log TTL | `apps/api/src/modules/system-settings/llm-request-log-settings.service.ts:165-177`（gate `:169-176`） | `internal/startupreconcile/reconcile.go:150-155` | `API_GO_STARTUP_RECONCILE_MODE` | 启动时 return | MySQL + Mongo + Redis | **A** | 同上 |
| Classification review-seed 事件消费（itemPipeline COMPLETED） | `apps/api/src/modules/observability/classification-quality-seed-trigger.service.ts:22-44`（gate `:26-37`） | `apps/api-go/cmd/api/nest_residual_duties.go:154-184`（gate `:160`）；`internal/classificationreviewseed` | `API_GO_CLASSIFICATION_REVIEW_SEED_MODE` | 不注册 QueueEvent listener | Redis（XREAD itemPipeline events） | **A** | Go 复用 GraphQL subscriptions 的单个 XREAD loop 或自建 observer（`:176-182`）；jobId 稳定去重 |
| 队列/订阅关闭（onModuleDestroy） | 例：`queue.processor.ts:848-854`、`crawl.processor.ts:1140-1150`、各 subscriber `unsubscribe` | 各 Go runtime `Close`（例 `item_pipeline_worker.go:48-64`、`crawl_worker.go:83-99`） | 无 | 关闭连接/worker | — | 无冲突 | 不涉及执行权；切换时遵守 “先停 claim 再 drain” |

#### 2.3 租约 / tick gate 归属与双跑分析

| 任务 | 共享 Redis 键（物理键） | Nest 侧领取方式 | Go 侧领取方式 | 双跑结论 |
|---|---|---|---|---|
| 审计 Outbox | `lock:cron:audit-log-outbox` | `CacheService.withLock("cron:audit-log-outbox")`（常量 `audit-log-outbox.service.ts:13`，调用 `:70`） | `auditoutbox` RedisLockStore | 互斥；切换窗口一边拿锁，最多一次 |
| crawl janitor | `lock:cron:crawl-task-janitor` | `cache.withLock("cron:crawl-task-janitor")`（`crawl-task-janitor.service.ts:53`） | `crawlmaintenance` lock（`lock.go:38`） | 互斥 |
| crawl cleanup outbox | `lock:cron:crawl-cleanup-outbox` | `withLock("cron:crawl-cleanup-outbox")`（常量 `crawl-cleanup-outbox.service.ts:13`，调用 `:56`） | 同上 | 互斥 |
| crawl adaptive | `lock:cron:crawl-adaptive-concurrency` | `withLock`（常量 `:16`，调用 `:97`） | 同上 | 互斥 |
| crawl quality snapshot | `cron:crawl-quality-task-snapshot:tick-gate` + `cron:crawl-quality-task-snapshot:org:<orgId>` | `claimSchedulerTick`（`crawl-quality-task-snapshot.service.ts:96`） | `crawlmaintenance` tick gate（`quality_snapshot.go:87-99`） | 互斥 |
| 知识图谱 | `cron:knowledge-graph-ingestion:tick-gate` + org | `claimSchedulerTick`（`knowledge-graph.ingestion.service.ts:58`） | `kgingestion` 同键 | 互斥 |
| 新闻事件入库 | `cron:news-events-ingestion:tick-gate` + org | `claimSchedulerTick`（`news-events-ingestion.service.ts:59`） | `newseventsingest` 同键 | 互斥 |
| 时间线 | `cron:news-events-timeline:tick-gate` + org | `claimSchedulerTick` | `newseventtimeline` 同键 | 互斥 |
| 情绪快照 | `cron:sentiment-snapshot:tick-gate` + org | `claimSchedulerTick` | `sentimentsnapshot` 同键 | 互斥 |
| NewsNow 热门/预热 | `cron:newsnow-hottest-analysis:tick-gate`、`lock:cron:newsnow-source-warm` | `claimSchedulerTick` / `withLock` | `newsnowhottest` 同键 | 互斥 |
| News source 30s | `lock:cron:news-source-scheduler` | `withLock`（`news-source.scheduler.service.ts:287`） | `newssourcescheduler` 同键（`model.go:12-14`） | 互斥 |
| 实时信号 | `cron:realtime-signals:tick-gate` + org + opensky capture | `claimSchedulerTick`（`realtime-signals.service.ts:126`） | `realtimesignals` 同键 | 互斥 |
| GDELT 15m | `lock:cron:situation-monitor:external-snapshot:gdelt` | `withLock` | `gdeltsnapshot` 同键 | 互斥 |
| 摘要投递 | `cron:user-digest-delivery:tick-gate` + org | `claimSchedulerTick` | `userdigest` 同键 | 互斥 |
| 分类质量告警 | `cron:classification-quality-alert:tick-gate` + org | `claimSchedulerTick` | `classificationalert` 同键 | 互斥 |
| 聚类恢复扫描 | `lock:cron:news-event-clustering-recovery` | `withLock`（`news-event-clustering-recovery-scheduler.service.ts:38`） | `newsbackfilljobs` scan lock | 互斥 |
| Raw item outbox | `lock:cron:raw-item-outbox` | `withLock`（`raw-item-outbox.service.ts:27`） | `itemsingest` outbox scheduler | 互斥 |
| Processed item outbox | 无 cron 锁；行级 CAS claim | `NewsPipelineService.retryPendingOutbox`（`news-pipeline.service.ts:191`） | `processeditemoutbox` CAS | 互斥在行级；可能同 tick 两个扫描者但同一行只被一方 claim |
| Audit log retention | Nest 无锁；Go `lock:cron:audit-log-retention` | 直接 DELETE | 租约 | 切换窗口可能两边各跑一次；DELETE 幂等 |
| BullMQ cleanup | `cron:bullmq-retained-cleanup` | Nest 无锁 timer | Go 租约 | Go 模式下仅 Go；legacy 模式 N 个 Nest 实例会重复清理（既有行为） |
| Startup reconcile | `lock:startup:reconcile` | Nest 无锁（启动时各实例执行） | Go 租约 | 既有 Nest 行为为多实例执行；Go 单实例 |
| 告警 repeat | 同一 BullMQ repeat jobId | Nest 幂等 upsert | Go 幂等 upsert + 消费 | 不会出现两个 repeat 任务；消费者唯一 |
| 经济数据 repeat | 同一 repeat key | Nest 在 worker go 时不注册 | Go 注册 | 一致 |
| Situation repeat | `telegram-poll:scheduler` / OREF repeat | worker go 时不注册 | Go 注册 | 一致；MTProto 租约额外防双连接 |

结论：**21 个定时任务均有共享租约/幂等键，或（审计保留清理）在 Nest 侧无锁但操作幂等；不存在会造成业务重复执行的“同一 job 长期双跑”**。Nest 侧无锁的审计保留清理与 Nest 多实例 BullMQ cleanup 都是幂等/既有行为。

#### 2.4 go 模式下 Nest 行为汇总（定时任务）

- 21 个回调全部在**读取设置/抢锁/写库之前**判断 `API_GO_*` 并 return；注释均明确“go 时 Go 拥有该 tick”。
- 例外/注意：
  - `situation-monitor-external-snapshot.service.ts` 在 gate 前先执行 `isGdeltEnabled()`（`:127-129`）；GDELT 关闭时 Nest 不会进入 gate，但这不产生副作用。
  - `news-pipeline.service.ts` 用 `process.env` 直读（`:196`），未走 EnvService；env schema 仍会校验（`env.schema.ts:218`）。
  - `crawl.processor.ts` 在 crawl worker go 时也不订阅 C2 通道；Frontier LLM 开关独立，两个 gate 互不影响。
  - `alerts`/`situation` 的 repeatable 注册在 go 时分别“保留（alerts）”与“完全不碰（situation）”，不要混为一谈。
  - `SCHEDULE_ENABLED=false`：Nest 在模块装配层就不注册 schedule（`app.module.ts:59`、`rbac.module.ts:11`、`audit.module.ts:8`）；Go 对 audit outbox/crawl maintenance/raw & processed outbox 也检查（`audit_outbox.go:25`、`crawl_maintenance.go:105`、`items_ingest.go:51`、`processed_item_outbox.go:29`）。其余 Go 定时器（news source、digest 等）不检查该变量——部署时不要用 `SCHEDULE_ENABLED=false` 作为全局停调度手段来假设 Go 侧全部停止，需逐个关闭开关。

#### 2.5 其余生命周期 hook 的归类（不涉及调度执行权）

| 类别 | 位置 file:line | 副作用 | 结论 |
|---|---|---|---|
| Prisma 连接 | `apps/api/src/modules/config/prisma.service.ts:64` | 建立 MySQL 连接 | 基础设施，无执行权 |
| NewsNow 源目录 | `apps/api/src/modules/news-aggregator/news-aggregator-registry.service.ts:66-74` | 进程内 `genSources`/`genMetadata`，无共享写 | 进程内状态，无执行权 |
| situation signals 状态恢复 | `apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.service.ts:159-161`（`onModuleDestroy` `:163-165`） | 从 Redis 恢复缓存状态、持有 Telegram 运行时 | 这是 `situation-monitor:telegram-clear:v1` 桥存在的原因；属实时/信号状态所有权（T1.2/T1.6），不是 cron |
| Socket.IO 网关 | `notifications/notifications.gateway.ts:75`、`observability/ops.gateway.ts:96`、`observability/quality.gateway.ts:69`、`queue/queue.gateway.ts:72`、`news-aggregator/newsnow.gateway.ts:84`、`situation-monitor/signals/situation-monitor-signals.gateway.ts:87` | 注册本进程 dispatcher/listener，不写库、不发队列 | 实时传输所有权，见 T1.2/T1.6 |
| 订阅型 subscriber | 见 3.2 表 | 打开 Redis 订阅 | 已在 3.2/3.6 分类 |
| `onModuleDestroy` | 例 `queue.processor.ts:848-854`、`crawl.processor.ts:1140-1150`、各 subscriber `unsubscribe` | 关闭 Worker/Queue/订阅 | 无执行权冲突；切换时“先停 claim 再 drain” |
| `onApplicationBootstrap` | 仅 `akshare.processor.ts:34` | 创建 akshare Worker（见 1.1） | 已计入 worker 表 |

> `@Timeout` 0 个；`@Interval` 仅 classification-quality alert 1 个。

### 3. T1.6 Redis pub/sub

#### 3.1 枚举与口径

Nest 业务订阅站点（10 个）：9 个 `subscriber.subscribe(<频道>)` + 1 个 `GraphqlSubscriptionBus.subscribe(triggerName)`；实际频道 12 个（9 个显式 + `gqlsub:alertEvents` / `gqlsub:analysisEvents` / `gqlsub:assistantEvents`）。另有 1 个名义频道 `gqlsub:queueEvents`：Nest 从未把它发布到 Redis（`queueEvents` 用进程内 `PubSub`，`queue-event.publisher.ts:44-52`），Go 用本地 BullMQ observer（`internal/graphqlsubscriptions/source.go:58`），因此不构成订阅/桥。

不使用 `psubscribe`：Nest 业务源码中无 `psubscribe`；Socket.IO Redis adapter 的内部订阅在库内（`common/websocket/redis-io.adapter.ts:28-48`），不是业务频道。

#### 3.2 频道总表

| 名称（频道） | Nest 源位置 file:line | Go 实现 file:line | 开关/条件 | go 模式下 Nest 行为 | 依赖资源 | 分类 | 备注 |
|---|---|---|---|---|---|---|---|
| `notification:events:v1` | 订阅：`apps/api/src/modules/notifications/generic-notification.subscriber.ts:83-109`（gate `:84`，`isGoSocketMode` `:147-155`）；发布：`apps/api/src/modules/notifications/notification-realtime.relay.ts:39-62` | 发布：`internal/classificationrssops/alert_relay.go:23,71`（共享 relay；crawl worker 注入点 `cmd/api/crawl_worker.go:142`）、`internal/newssourcescheduler/notify_export.go:41-66`（generic 变体）；订阅：`internal/notificationssocket/source.go:19-60`（5 频道之一） | Nest 订阅仅在 `API_GO_NOTIFICATIONS_SOCKET_MODE != go`；Nest 发布仅在 `=go` | go socket 时**不再订阅**（`:84` return） | Redis；Nest 侧 re-read MySQL Notification 行 | **B（双向桥）** | 方向 1：Go 写入通知 → Nest legacy socket；方向 2：Nest 写入通知 → Go socket（`relay.ts:47-62`）。两个方向互斥（publisher 与 subscriber 的开关条件互补），不会回环 |
| `alert:notifications:v1` | `apps/api/src/modules/notifications/alert-notification.subscriber.ts:66-92`（gate `:67`） | 发布 `internal/alertworker/bridge.go:82`；订阅 `internal/notificationssocket/source.go:42-46`（5 频道之一） | Nest 订阅：`API_GO_ALERT_WORKER_MODE=go`；Go socket 总是可消费 | 仅 worker go 时订阅；socket go 时 Nest 无本地 socket（订阅变空转，可移除） | Redis + MySQL（re-read） | **B** | Go alert worker 写行后发布；Nest 只向本实例 socket emit，避免经 adapter 每实例重复 |
| `analysis:notification:v1` | `analysis-notification.subscriber.ts:74-100`（gate `:75`） | 发布 `internal/analysisruns/notifications.go:203` | Nest 订阅：`API_GO_ANALYSIS_WORKER_MODE=go` | 仅 worker go 时订阅 | Redis + MySQL | **B** | 同上；analysis 的 `gqlsub` 另见 3.4 |
| `news-source:notifications:v1` | `news-source-notification.subscriber.ts:74-100`（gate `:75`，`isGoOwned` `:140-147`） | 发布 `internal/newssourcescheduler/notify.go:128`、`internal/classificationrssops/alert_relay.go:23,71`（circuit/auto-disable 走 generic） | Nest 订阅：`NEWS_SOURCE_SCHEDULER=go` 或 `NEWS_SOURCE_OPS=go` 或 `ITEM_PIPELINE_WORKER=go`（`:141-146`） | 三者任一 go 时订阅 | Redis + MySQL | **B** | 注意 itemPipeline go 也会写 news-source 通知，所以桥的触发条件包含该开关 |
| `user-digest:notifications:v1` | `user-digest-notification.subscriber.ts:64-90`（gate `:65`） | 发布 `internal/userdigest/delivery_notifier.go:224` | Nest 订阅：`API_GO_USER_DIGEST_DELIVERY_MODE=go` | 仅 go 时订阅 | Redis + MySQL | **B** | 摘要专用通道，故意不复用 dispatcher |
| `situation-monitor:signals:events:v1` | 订阅：`apps/api/src/modules/situation-monitor/signals/situation-monitor-signals-events.subscriber.ts:78-104`（gate `:79`/`isGoWorkerMode` `:139-146`）；发布（Nest→Go）：`apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.dispatcher.ts:88-110`（gate `:92`） | 发布（Go→）：`internal/situationsignalsworker/events.go:80`；订阅（Go socket）：`internal/realtimeevents/situation.go:69` | Nest 订阅：`SITUATION_SIGNALS_WORKER=go`；Nest 发布：`REALTIME_SOCKET=go` | signals worker go 时订阅；realtime socket go 时 dispatcher 发布给 Go | Redis | **B（双向桥）** | 方向 1：Go signals worker → Nest socket（worker go）；方向 2：Nest dispatcher → Go socket（realtime go）。注释明确单向/防回环（subscriber `:26-38`、dispatcher `:19-35`） |
| `situation-monitor:telegram-clear:v1` | `apps/api/src/modules/situation-monitor/signals/situation-monitor-telegram-clear.subscriber.ts:54-76`（**无 go gate，总是订阅**） | 发布 `internal/situationsettings/store.go:403`；Go signals worker 自身也订阅 `internal/situationsignalsworker/service.go:281` | 无桥开关；Go 发布发生在 Go 处理 settings 清空路径时 | 始终连接 Redis（Nest 全停前） | Redis | **B** | 用途：跨实例清空 Telegram 进程内状态；Nest 控制器也会本地 clear + 发布。只有 Nest 不再持有状态（signals worker go + settings go + realtime go 后）才可移除 |
| `newsnow:source-refresh:v1` | `apps/api/src/modules/news-aggregator/newsnow-source-refresh.subscriber.ts:47-65`（gate `:48`：`newsnowSourcesMode==='go'`） | 发布 `internal/newsnowsources/relay.go:86`；订阅（Go socket）`internal/realtimeevents/newsnow.go:154` | Nest 订阅：`API_GO_NEWSNOW_SOURCES_MODE=go` | 仅该开关 go 时订阅 | Redis + MySQL | **B** | Nest 用 `FANOUT SET NX` 去重（注释 `:44-52`）；Go 侧同时有 socket adapter 订阅与 relay 订阅，需注意不重复 emit（Go 注释 `newsnow.go:20-30`） |
| `crawl:worker-concurrency:v1` | `apps/api/src/modules/crawl/crawl.processor.ts:587-623`（订阅）、`:1167`（取消）；仅在 Nest 创建 crawl Worker 时调用 | 发布 `internal/crawlqueue/producer.go:535`；Go 自己订阅 `internal/crawlworker/worker.go:443` | Nest 订阅仅在 `API_GO_CRAWL_WORKER_MODE != go` | go 时**不订阅**（Nest Worker 已不存在） | Redis | **B** | 不是“Go→Nest”而是“执行权在谁谁订阅”；队列并发变更广播 |
| `gqlsub:alertEvents` | `apps/api/src/modules/graphql-subscriptions/graphql-subscription-bus.ts:154/183`（`channel()`=`gqlsub:`+trigger，`:247`）；模块装配 `graphql.module.ts`/`alerts.module.ts:144-146` | 发布 `internal/alertworker/bridge.go:62`；订阅（Go WS）`internal/graphqlsubscriptions/bus.go:15` | Nest 订阅：只要 Nest 还在服务 `/graphql` WS；发布：`ALERT_WORKER=go` 时 Go | Nest 不按开关关闭 bus 订阅（按 WS 连接动态订阅） | Redis | **B** | 共享总线：Nest 发布（worker legacy）↔ Go 订阅，Go 发布 ↔ Nest 订阅；停用条件见 3.6 |
| `gqlsub:analysisEvents` | 同上（`graphql-subscription-bus.ts:154`，`analysis.module.ts:64-66`） | 发布 `internal/analysisruns/events.go:20`；订阅 `internal/graphqlsubscriptions/bus.go:15` | 同上；`ANALYSIS_WORKER=go` 时 Go 发布 | 同上 | Redis + `GRAPHQL_SUBSCRIPTION_BUS=redis` | **B** | 分析 worker go 强制 Nest `GRAPHQL_SUBSCRIPTION_BUS=redis`（`analysis.processor.ts:50-59`） |
| `gqlsub:assistantEvents` | 同上（`assistant.module.ts:66-68`） | 发布 `internal/assistantruns/publisher.go:15`；订阅 `internal/graphqlsubscriptions/bus.go:15` | 同上；`ASSISTANT_WORKER=go` 时 Go 发布 | 同上 | Redis | **B** | 同上 |
| `gqlsub:queueEvents`（名义） | 无 Redis 订阅/发布：Nest `queue-event.publisher.ts:44-52` 用进程内 `PubSub`，`graphql/resolvers/dashboard.resolver.ts:151-156` 用它 | Go `internal/graphqlsubscriptions/source.go:58` 用本地 BullMQ observer | 无 | 与 Go 无桥 | — | **C（Nest 自有）** | 不要把它当成需要迁移的 Redis 频道；停 Nest 前 Go 已能本地提供 `queueEvents` |

#### 3.3 双向桥说明（避免“单向桥”误判）

1. `notification:events:v1`：两侧互为发布者/订阅者，gate 条件互补（Nest 订阅只在 socket legacy；Nest 发布只在 socket go）。任何一侧都不能在“另一侧还服务 socket”时停用自己的角色。
2. `situation-monitor:signals:events:v1`：Go signals worker → Nest socket（`SITUATION_SIGNALS_WORKER=go`），以及 Nest dispatcher → Go socket（`REALTIME_SOCKET=go`）。两侧代码都写明单向、防回环（Nest subscriber 只 `emitLocalEvent`；Go realtimeevents 只 fanout）。
3. `gqlsub:*`：这是**共享订阅总线**，不是单向迁移桥。只要 Nest 还服务 `/graphql` WS，Nest 就必须订阅；只要 Go 服务 `/graphql` WS，Go 就必须订阅。发布方由 worker 开关决定。Nest 停用订阅的条件是“没有 Nest WS 客户端”，而不是“某个 worker 开关变 go”。

#### 3.4 GraphQL Subscription 的 PubSub 归属

- `GRAPHQL_SUBSCRIPTION_BUS` 取值 `redis|local`，默认 `redis`（Nest `env.schema.ts:516`；Nest `config.service.ts:497`；Go `config.go:4205-4214`、`:4946`）。
- `redis` 时，Nest 用 `GraphqlSubscriptionBus`（`apps/api/src/modules/graphql-subscriptions/graphql-subscription-bus.ts:36`；`subscribe` `:109-160`）：
  - 频道名 `gqlsub:<triggerName>`（`:10`、`:247`）；
  - 一个发布连接 + 一个订阅连接（`graphql-subscription-bus.module.ts:32-56`）；
  - 只有 `alertEvents`/`analysisEvents`/`assistantEvents` 三个 trigger 实际经过它；`queueEvents` 走进程内 `QueueEventPublisher`。
- Go 侧 `internal/graphqlsubscriptions/bus.go` 用相同的 `gqlsub:` 前缀订阅三频道，执行 Go 的 `/graphql` WS；`queueEvents` 由 `internal/graphqlsubscriptions/source.go:58` 的本地 BullMQ observer 提供。
- 硬约束：
  - `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go` 要求 `GRAPHQL_SUBSCRIPTION_BUS=redis`（`apps/api-go/internal/config/config.go:4213-4214`）。
  - `API_GO_ANALYSIS_WORKER_MODE=go` 同样要求 `GRAPHQL_SUBSCRIPTION_BUS=redis`（Nest `analysis.processor.ts:50-59`；Go `config.go:5521`）。
  - `API_GO_ASSISTANT_WORKER_MODE`/`ALERT_WORKER_MODE=go` 在 Go 侧发布 `gqlsub:*`，因此部署时也应保持 redis bus（虽然源码没有单独硬校验见 5 节未核实项）。
- 归属结论：**Redis PubSub 本身是 Nest/Go 共享的契约，不属于任何单侧兼容桥**；Nest 的 bus 订阅在“GraphQL subscriptions 迁到 Go 且 Web 改用 Go WS 入口”之前都不能停。`GRAPHQL_SUBSCRIPTION_BUS=local` 只应在两侧都不以 go 模式发布/执行 GraphQL 订阅时使用（analysis worker 与 GraphQL subscriptions 的 go 模式有硬校验，assistant/alert 的 bus 校验静态未见）。

#### 3.5 Nest 自有 / 库内部订阅（无迁移桥）

| 订阅 | 位置 | 说明 | 分类 |
|---|---|---|---|
| GraphQL subscription bus（redis 模式） | `graphql-subscriptions/graphql-subscription-bus.ts:154/183` | Nest `/graphql` WS 的传输层；不是 Go→Nest 桥 | **C（Nest 自有，迁 GraphQL WS 后随 Nest 停）** |
| `queueEvents` 本地 PubSub | `queue/queue-event.publisher.ts:44-52` | 进程内，不写 Redis；Go 用本地 observer | **C** |
| Socket.IO Redis adapter | `common/websocket/redis-io.adapter.ts:28-48` | 库内部 pub/sub，服务 `/socket.io` 多实例广播；Go 的 socket transports 复用同一 adapter key（Go `realtimeevents/newsnow.go:272` PSubscribe） | **C（库职责，随 socket 迁移）** |
| BullMQ QueueEvents 的 Redis stream | 各 module provider | 不是 pub/sub 频道；见 1.4 | 非本表 |

#### 3.6 兼容桥停用条件

> 前提：`apps/web` 默认仍指向 Nest（`API_BASE_URL`/`NEXT_PUBLIC_API_BASE_URL`），所以“生产者迁走”**不等于**“桥可停”。桥只有在**消费端 socket/GraphQL 也迁走且没有存量 legacy 连接**时才可停。

| 桥 | 可停用的最小条件 | 证据/说明 |
|---|---|---|
| `notification:events:v1`（Nest 订阅侧） | `API_GO_NOTIFICATIONS_SOCKET_MODE=go` 且 Web 已连接 `/socket.io-notifications`（Go），Nest 实例无 `/notifications` 连接 | Nest gate 已按该开关自动不订阅（`generic-notification.subscriber.ts:84`）；此时 Nest 侧订阅是空转，可删 |
| `alert:notifications:v1` / `analysis:notification:v1` / `news-source:notifications:v1` / `user-digest:notifications:v1`（Nest 订阅侧） | 同上：`NOTIFICATIONS_SOCKET=go` 且 Nest 无 `/notifications` socket；对应 worker 开关可保持 go | 四个 subscriber 只在各 worker go 时订阅（见 3.2）；socket go 后 Nest 无本地 socket，可安全移除。Go `notificationssocket` 订阅同样 5 频道（`internal/notificationssocket/source.go:42-46`） |
| `situation-monitor:signals:events:v1`（Nest 订阅侧） | `API_GO_REALTIME_SOCKET_MODE=go` 且 Web situation 命名空间已走 `/socket.io-realtime`，Nest 无 legacy socket | Go `realtimeevents/situation.go:69` 已订阅；Nest subscriber 只服务本实例 socket（`:26-38`） |
| `newsnow:source-refresh:v1`（Nest 订阅侧） | `API_GO_REALTIME_SOCKET_MODE=go` 且 Web newsnow 已走 Go `/socket.io-realtime` | Go `realtimeevents/newsnow.go:154` 已订阅；Nest 侧还需 `API_GO_NEWSNOW_SOURCES_MODE=go` 才启动（`:48`） |
| `crawl:worker-concurrency:v1`（Nest 订阅侧） | 无动作：`API_GO_CRAWL_WORKER_MODE=go` 时 Nest 已不订阅 | `crawl.processor.ts:525` return，`:562` 不调用 subscribe |
| `situation-monitor:telegram-clear:v1`（Nest 订阅侧） | `SITUATION_SIGNALS_WORKER=go` + `SITUATION_SETTINGS=go` + `REALTIME_SOCKET=go`，且 Nest 进程已停（或不再持有 Telegram 状态） | Nest subscriber 无 gate（`:54-76`）；为跨实例清理 Nest 本地状态而存在 |
| `gqlsub:alertEvents` / `analysisEvents` / `assistantEvents`（Nest bus 订阅侧） | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go` 且 Web/客户端改用 Go 的 graphql-ws 入口（`API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` 的 Go 入口见 `graphql_subscriptions.go:33-64`），Nest `/graphql` 无 WS 连接 | Nest bus 按连接动态订阅（`:154`）；Go bus 已订阅相同频道（`internal/graphqlsubscriptions/bus.go:15`），频道本身不会消失 |
| `situation-monitor:signals:events:v1`（Nest 发布侧，Nest→Go） | `REALTIME_SOCKET=go` 期间**必须保留**；只有回退 realtime 或停 Go socket 时才自然消失 | dispatcher `:88-110` 的发布 gate 是 `REALTIME_SOCKET=go`，不是可停的兼容层，而是 Go socket 的事件源 |
| `notification:events:v1`（Nest 发布侧，Nest→Go） | `NOTIFICATIONS_SOCKET=go` 期间**必须保留**（Nest 仍写通知时）；Nest 完全停用后自然消失 | `notification-realtime.relay.ts:39-62` |
| `gqlsub:*`（Nest 发布侧） | Nest 仍运行 legacy worker 时必须保留，用于喂 Go WS 客户端 | 由 worker 开关控制发布方 |

**结论**：12 个频道里没有一个可以仅凭“Go 接管了对应 worker/cron”就停用；都要等实时/GraphQL 入口也切到 Go 且确认无 legacy 连接。`notification:events:v1` 的 Nest 订阅侧是唯一已经按 socket 开关自动停用的桥。

### 4. 真实缺口

按“只有漏接线这类最小修复才标可本批最小修复”的要求，本批**未发现**漏接线，以下均为后续业务批次缺口（C），不改代码。

1. **`itemPipelineDlq` 无消费者（C）**
   - 事实：Nest 仅生产（`queue.module.ts:75-99`），Go 仅生产（`apps/api-go/internal/itempipeline/dlq.go:108-137`）；全仓无该队列 Worker。人工处理入口是 Nest Bull Board `/admin/queues`（`queue-admin.module.ts:26,56`），该入口在 legacyproxy 中固定回退 Nest（BRIEF）。
   - 影响：阶段 6 停 Nest 后，DLQ 只能通过 Redis 人工处理，没有 UI/API。不是执行权迁移缺口，而是运维入口缺口。
   - 选项：(a) 保留 Nest Bull Board 作为最后停用的只读运维面；(b) 后续批次给 Go 增加只读 DLQ 列表/重放端点（需要审计与权限）；(c) 文档化 Redis 手工处理流程并接受无 UI。
2. **告警规则级 repeatable 全量对账只在 Nest（C）**
   - 事实：Nest `ensureAllSchedules`（`alerts.service.ts:1284-1301`）在每次启动枚举所有 active 规则并 upsert；Go 只有 `EnsureScanSchedule`（`internal/alertworker/queue/producer.go:260`）和规则变更时的 `EnsureRuleSchedule`（`:282`），没有“启动时全量对账”。
   - 现状可接受：告警规则写仍是 Nest 的 workspace Mutation（迁移地图 0/11），Nest 不会先停；规则变更会触发 Nest 的 `ensureRuleSchedule`。
   - 后续：若规则写迁到 Go，必须补 Go 启动/定期全量对账，否则新规则不会自动注册 repeatable。
3. **QueueEvents 派生的 Nest 读侧职责无 Go 开关（C/依赖）**
   - `QueueOrgStatsTracker`（`queue-org-stats.tracker.ts:45`）、`QueueEventPublisher`（GraphQL `queueEvents`）、`CrawlQueueEventPublisher`（ops 命名空间）、alerts 的 pipeline/crawl metric providers 都消费 QueueEvents 或队列计数，没有 `API_GO_*` 开关。
   - 它们随 Nest 停止一起消失；阶段 5/6 之前必须确认 Go 的对应读路径（`queueEvents` 已有 Go 本地 observer；队列统计 REST/GraphQL 见 T1.1/T1.2）已可服务。本批不修复。
4. **`situation-monitor:telegram-clear:v1` 无模式门（C/低风险）**
   - Nest subscriber 无条件订阅并清本地状态（`:54-76`），即使 signals worker 已迁 Go。它不影响执行权（只清 Nest 进程内缓存），但会让“Nest 完全停用前”始终保留一条 Redis 订阅。属预期桥，不需要本批修。
5. **`gqlsub:queueEvents` 名义频道（文档缺口）**
   - 容易被误计为“第 4 个 GraphQL Redis 频道”，实际两侧都不走 Redis（Nest 本地 PubSub、Go 本地 observer）。已在 3.2/3.4 标明，避免 T3/T4 矩阵把它当桥。
6. **`SCHEDULE_ENABLED=false` 覆盖不完整（部署注意，非 bug）**
   - Nest 在模块装配层停 schedule（`app.module.ts:59` 等）；Go 只在 audit outbox/crawl maintenance/raw & processed outbox 检查（见 2.4）。news source、digest、realtime signals 等 Go 定时器不受 `SCHEDULE_ENABLED` 控制。切流手册应以“逐开关回退”为主，不要依赖 `SCHEDULE_ENABLED=false` 做全局停止。
7. **时区一致性（未核实项，非缺口结论）**
   - Nest `@Cron(CronExpression.EVERY_DAY_AT_1AM)` 使用进程本地时区；Go 审计保留注释声称“daily 01:00 local-time purge”（`internal/crawlmaintenance/audit_retention.go:36`）。仓库 README 记录 compose 未设置 `TZ`，但本次未核对镜像默认时区与 Go `time.Local` 的实际取值，故不对“01:00 是否严格对齐”下结论。切流前建议在部署环境核对 `date`/`TZ` 并观测首个 tick。

### 5. 未核实项（明确列出）

- **运行时行为**：未运行任何队列/服务，未验证 worker 实际消费、并发、重试、stalled 恢复、DLQ 写入；本文件只核对静态接线与协议常量。
- **Go 业务实现的内部等价性**：alert 评估、analysis LLM 流、assistant、archive 分类/embedding、economic 抓取、clustering LLM 回填、situation Telegram/OREF 的内部算法未逐行对照；只核对了队列名、开关、concurrency、回调入口和副作用类别。
- **`API_GO_*` 默认值全集**：本文件只核对与异步执行面相关的开关；完整 131 项矩阵由 task-4 负责。
- **`GRAPHQL_SUBSCRIPTION_BUS` 对 assistant/alert 的硬校验**：源码只看到 analysis worker 的强校验（Nest `analysis.processor.ts:50-59`、Go `config.go:5521`）和 GraphQL subscriptions 的强校验（`config.go:4213`）；未发现 assistant/alert 在 Go 侧对 bus 的硬校验，因此本文件只写“应保持 redis”，不写成“源码强制”。
- **C2 广播的消费方**：`crawl:worker-concurrency:v1` 的 Nest 订阅只在 Nest 有 crawl worker 时存在；Go crawl worker 也订阅（`crawlworker/worker.go:443`）。未验证 Nest/Go 同时存在 worker 时的并发语义（该组合不是合法切换状态）。
- **Bull Board 与 legacyproxy**：`/admin/queues` 的代理规则由 T1.1 核对，本文件只引用 BRIEF。
- **队列优先级/暂停状态**（`meta.paused`、`prioritized`）与 worker 的交互：未在本任务范围内验证（属 crawl 队列管理 T1.1/T3）。

### 6. 交接摘要

- **队列**：15 个队列名；14 个有 Go 消费者（11 个开关），1 个 `itemPipelineDlq` 无消费者（C）。
- **worker**：`new Worker` 11 个构造点 → 14 个 worker 实例；Nest 侧 11 个开关全部在创建 Worker 前退出创建路径（crawl 为 `if/else` 跳过，其余 `return`）；Go 侧 11 个开关全部在 `cmd/api` 接线并启动。
- **Cron**：21 个 `@Cron/@Interval`（0 `@Timeout`）全部 A；另有 10 项非装饰器调度/启动任务（A 7：经济 repeat、situation repeat、BullMQ cleanup、ES/TTL×2 启动对账、review-seed；B 1：告警 scan repeat；C 2：告警规则全量对账、News-source RSS TTL 迁移）。
- **订阅**：12 个 Nest 实际订阅频道 + 1 个名义频道；12 个桥/共享总线（B），1 个 Nest 自有名义频道（C）。5 个通知 relay + situation 事件 + newsnow refresh + crawl 并发 + telegram clear + 3 个 gqlsub。
- **兼容桥停用**：无法仅凭 worker 开关停用；必须等 `NOTIFICATIONS_SOCKET=go`/`REALTIME_SOCKET=go`/`GRAPHQL_SUBSCRIPTIONS_MODE=go` 且 Web 入口切换、无 legacy 连接。唯一已自动停用的是 `notification:events:v1` 的 Nest 订阅侧（socket go 时）。
- **最重要缺口**：`itemPipelineDlq` 无消费者（停 Nest 后无 UI）；告警规则全量 repeatable 对账只在 Nest；QueueEvents 读侧职责无 Go 开关。
- **未核实**：运行时行为、Go 内部业务算法等价性、时区对齐、assistant/alert 对 `GRAPHQL_SUBSCRIPTION_BUS` 是否硬校验（静态未见）。

---

## 6. 其它入口：Swagger、Bull Board、healthz、metrics、静态/上传/SSE/长连接/404（T1.7）

<!-- 合并自 T1.7 其它入口审计（task-1 产出）；原文，仅调整标题层级。 -->


> 基线：`dcbe563b917fde0927637121a91de2186d6177a4`（worktree `/Users/oo/project/newwei-go-cutover-readiness`）。与 §2 同一批静态审计；未启动服务、未运行 `go build/test`、`pnpm`、`docker`。所有 `path:line` 以 HEAD 基线 `dcbe563b` 为准。分类沿用 task-1 定义：A=Go 可完全接管且有 `API_GO_*` 开关；B=仅 Nest 兼容桥；C=只能由 Nest 提供。 行号以 HEAD `dcbe563b` 为准；`proxy.go` 的本批 metrics 改动已按 HEAD 校正（见 §2 的行号口径）。

### 0. 结论摘要

| 入口 | 归属 | 开关 | 停 Nest 后是否可用 |
|---|---|---|---|
| `GET /docs`、`/docs/json`、`/docs/*`（Swagger UI/JSON） | **A（本批关闭 C-7）** | `API_GO_DOCS_MODE`（默认 legacy）；Nest 侧仍由 `SWAGGER_ENABLED` 决定是否挂载 | 可用（go 且 SWAGGER_ENABLED 为真时由 api-go 提供；否则 404） |
| `/admin/queues`、`/admin/queues/*`（Bull Board） | **C**（仅 Nest，且默认不装配） | 无 `API_GO_*`；Nest 用 `BULL_BOARD_ENABLED` | 不可用（Go 只按 `/admin/queues` 前缀代理） |
| `GET /api/healthz`（认证版就绪探针） | **A** | `API_GO_HEALTHZ_MODE`（默认 legacy） | 可用（Go 接管需 MySQL/Redis/JWT） |
| `GET /api/healthz/live`（公开存活探针） | **A（本批关闭 C-1）** | `API_GO_HEALTHZ_LIVE_MODE`（默认 shadow，可 legacy/go） | 可用（go 时由 api-go 精确 GET 响应） |
| `GET /api/metrics`（Prometheus） | **A** | `API_GO_METRICS_MODE`（默认 legacy） | 可用（Go 接管需 MySQL/Redis/JWT） |
| 静态资源（`/static`、`/assets`、根路径文件） | **C / 不存在** | 无 | Nest API 本来就不提供静态资源；Web 由 `apps/web` 提供 |
| 上传（multipart） | 不存在（无 `FileInterceptor`/multer） | — | 头像走 presigned URL（A，`API_GO_AVATAR_UPLOAD_MODE`）；媒体读走 crawl 媒体路由（A） |
| `GET /api/dashboard/stream`（SSE） | **A** | `API_GO_DASHBOARD_STREAM_MODE`（默认 legacy） | 可用（Go handler 直接流式响应） |
| 长连接 `/socket.io/*`、`/socket.io-notifications`、`/socket.io-realtime`、`/graphql` WebSocket | 默认 **legacy → Nest**；两条独立 Engine.IO 路径有 Go 开关 | `API_GO_NOTIFICATIONS_SOCKET_MODE`、`API_GO_REALTIME_SOCKET_MODE`、GraphQL 订阅开关（T1.2/T1.3） | 取决于 T1.2/T1.3；默认 `/socket.io` 在停 Nest 后不可用 |
| 根路径 `/` 与未匹配 404 | **A（本批关闭 C-9）** | `API_GO_LEGACY_FALLBACK_MODE`（默认 proxy，可 reject） | 可用（reject 时 Go 返回 Nest 等价 404，不再代理） |

### 1. Swagger `/docs`（已关闭：`API_GO_DOCS_MODE`）

- **Nest 源位置**：`apps/api/src/main.ts:154-166`。`env.swaggerEnabled` 为真时 `SwaggerModule.createDocument` 并 `SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "docs/json" })`；`DocumentBuilder` 标题/描述/Bearer 在 `main.ts:156-161`。
- **开关**：`SWAGGER_ENABLED`，`EnvService.swaggerEnabled` 默认 `false`（`apps/api/src/modules/config/config.service.ts:500-502`），env schema 默认非生产 `true`、生产强制 `false`（`apps/api/src/modules/config/env.schema.ts:510-512,1464`）；`.env.example:91` 示例为 `true`。不是 `API_GO_*` 开关。
- **路径语义**：`SwaggerModule.setup("docs", ...)` 未传 `useGlobalPrefix`（Nest Swagger 默认不使用全局前缀），因此是 `/docs`、`/docs/json`，不是 `/api/docs`；Swagger UI 子资源（`/docs/swagger-ui*.js/css` 等）同样在 `/docs/*` 下。未运行验证。
- **Go 侧**：只有 `DefaultRulesWithWrite` 的 `{Prefix: "/docs", Mode: ModeLegacy}`（`apps/api-go/internal/legacyproxy/proxy.go:146`），任意方法原样代理到 Nest；没有 Go 实现、没有开关。
- **切流后影响**：阶段 0 起 Web/浏览器若直连 api-go，`/docs` 仍经 api-go 代理到 Nest；阶段 6 停 Nest 后 `/docs` 直接 502。CI/运维不得把 Swagger 当作 api-go 健康检查。
- **本批落地（C-7）**：新增 `API_GO_DOCS_MODE`（默认 `legacy`）。`go` 时 `legacyproxy.WithDocs` 把 `/docs` 前缀规则替换为 `ModeGo`，由 `internal/apidocs` 提供：`/docs`、`/docs/`、`/docs/index.html`（Swagger UI 页面）、`/docs/json`（`apps/api/tests/contract/openapi.snapshot.json` 的逐字节嵌入副本，`info.completeness` 原样保留）、`swagger-ui-dist@5.29.4` 的静态资源（`go:embed`，含 LICENSE/NOTICE 与来源说明），以及 `/docs/swagger-ui-init.js`。未知子路径、`SWAGGER_ENABLED=false`、非 GET/HEAD 均返回与 C-9 相同的 404。`/docs-yaml`（Nest 默认提供 YAML）未实现，属已知差异。
- **回退**：改回 `legacy` 重启 api-go；`/docs` 重新代理 Nest，没有数据需要清理。

### 2. Bull Board `/admin/queues`

- **Nest 源位置**：`apps/api/src/app.module.ts:60,82`（`BULL_BOARD_ENABLED === "true"` 才导入 `QueueAdminModule`）；`apps/api/src/modules/queue/queue-admin.module.ts:40-53`（`BullBoardModule.forRootAsync`，`route: "/admin/queues"`，middleware `createBullBoardAuthMiddleware(...)`）；队列清单 `queue-admin.module.ts:54-65`（itemPipeline、itemPipeline DLQ、crawl、crawl-hot、crawl-normal、akshare、analysis、assistant、alerts、newsEventClusteringRecovery、situationMonitorSignals）。
- **全局前缀排除**：`apps/api/src/main.ts:62-67` 排除 `admin/queues` 与 `admin/queues/*path`（`RequestMethod.ALL`），因此 Bull Board 是 `/admin/queues` 而不是 `/api/admin/queues`。
- **鉴权**：`apps/api/src/modules/queue/bull-board-auth.middleware.ts:9`（`queue.manage`）、`:22-52`（Bearer JWT 验签 + `accessTokenBlacklist` + `getUserProfile` 权限检查；401/403 纯文本）。
- **开关/默认**：`BULL_BOARD_ENABLED` 默认 `false`（`apps/api/src/modules/config/env.schema.ts:28`；`.env.example:394`）。默认部署根本没有这个 controller/模块，`/admin/queues` 在 Nest 是 404。
- **Go 侧**：`{Prefix: "/admin/queues", Mode: ModeLegacy}`（`legacyproxy/proxy.go:147`），任意方法原样代理。没有 Go 实现或开关。
- **切流后影响**：只要 `BULL_BOARD_ENABLED=true` 且 `/admin/queues` 经 api-go 访问，Go 始终代理到 Nest；停 Nest 后 502。若默认 `false`，当前就是 404（Nest）→ 停 Nest 后 502，语义变化需要注意。
- **C 类处理选项**：
  1. 保留一个独立 Bull Board 进程（Bull Board 自身可用 Express/BullMQAdapter 单独起，连同一 Redis），不依赖 Nest 主应用；需要新服务与新鉴权。
  2. 停 Nest 前把队列运维改为 CLI/Redis 工具（`bullmq` 脚本、RedisInsight、`/api/metrics` 告警），接受 `queue.manage` 的 Web 面板下线。
  3. 保留 Nest 仅作为 `/admin/queues` 边车（不推荐：为单一运维页维持整套 Nest 依赖）。

### 3. `GET /api/healthz`（认证版就绪）

- **Nest 源位置**：`apps/api/src/modules/health/health.controller.ts:20`（`@Controller("healthz")`）、`:33-34`（`@AllowAuthenticated()` + `@Get()`）、`:37-72`（`@HealthCheck`，MySQL/Redis/Mongo/crawl4ai/crawl4aiSsrfProxy/llmGateway/disk 七项；5 秒缓存 `HEALTHZ_CACHE_TTL_MS`，`health.controller.ts:18`；返回 `version`/`now`）。
- **Go 侧**：`WithAuthenticatedHealth` 精确 `GET /api/healthz`（`apps/api-go/internal/legacyproxy/proxy.go:411-423`，**不放行 OPTIONS**，也不接管 `/api/healthz/live`）；开关 `API_GO_HEALTHZ_MODE`（默认 `legacy`，`apps/api-go/internal/config/config.go:3507-3513`）；handler 在 `apps/api-go/cmd/api/main.go:1730-1737`（`internal/health.ReadyHandler`，`internal/health/ready.go:19`）。
- **Nest 行为（go 后）**：Nest 不读取 `API_GO_HEALTHZ_MODE`（`apps/api/src` 无引用）；controller 仍注册，但 Go 全量接管后无流量到达。Go handler 自己执行七项探针，整份响应缓存 5 秒（见 `internal/health` 实现）。
- **切流后影响**：阶段 1 可切；切后健康检查不再依赖 Nest。注意 `api-go` 自身容器 healthcheck 走 `/__go/healthz`（`infra/docker/api-go.Dockerfile:47-56`），与本路由不同；compose 的 `api` 服务 healthcheck 目前仍打 `http://localhost:4000/api/healthz/live`（`infra/docker/docker-compose.yml:665`），停 Nest 前必须改。
- **依赖**：go 模式要求 JWT/MySQL/Redis（`apps/api-go/cmd/api/main.go:1731` 附近的资源校验）；未运行验证。

### 4. `GET /api/healthz/live`（公开存活探针，已关闭：`API_GO_HEALTHZ_LIVE_MODE`）

- **Nest 源位置**：`apps/api/src/modules/health/health.controller.ts:75-82`（`@Public()` + `@Get("live")`，只返回 `{ status: "ok" }`，不泄漏版本/依赖）。
- **Go 侧**：`DefaultRulesWithWrite` 固定 `{Prefix: "/api/healthz/live", Mode: ModeShadow, Exact: true, Methods: GET}`（`apps/api-go/internal/legacyproxy/proxy.go:135`）；Go handler 已实现并注册（`internal/health.LiveHandler`，`internal/health/handler.go:21-27`；`cmd/api/main.go:2130`），但规则没有开关、永远 shadow：**Nest 是响应方，Go 仅旁路比对**（`proxy.go:562-565` 的 `ModeShadow` 分支）。
- **开关/默认**：无。`API_GO_HEALTHZ_MODE` 只管 `/api/healthz`，不含 `/live`（`proxy.go:411-423` 注释明确）。
- **切流后影响（重要）**：
  - compose `api` 服务的 healthcheck 就是 `curl -fsS http://localhost:4000/api/healthz/live`（`infra/docker/docker-compose.yml:665`）；Web 启动等待也请求 `${API_BASE_URL}/api/healthz/live`（`docker-compose.yml:1714-1724`）。切到 `API_BASE_URL=http://api-go:4020` 后，这些请求经 Go 代理到 Nest；**阶段 6 停 Nest 前必须改**，否则 api 容器/Web 启动等待全部失败。
  - 阶段 6 需新增 Go 规则（选项见 §2 的「C 类与缺口」C1）：可加 `WithLiveHealthz(mode)` + `API_GO_HEALTHZ_LIVE_MODE`（默认 shadow），或把 `proxy.go:135` 改 `ModeGo`，或把探针直接指向 `/__go/healthz`。
- **本批落地（C-1）**：新增 `API_GO_HEALTHZ_LIVE_MODE`（默认 `shadow`，唯一默认非 legacy 的例外，原因见 config.go 类型注释）与 `WithHealthzLive`；`go` 时 exact GET 由 `health.LiveHandler` 响应，其他方法继续回落。`shadow` 下规则表与 baseline 完全一致（有测试固定）。回退：改回 `shadow` 重启 api-go。
- **停 Nest 前仍需**：compose api healthcheck 与 Web 启动等待的改法见 runbook 阶段 6（本批不改 docker-compose.yml）。

### 5. `GET /api/metrics`（Prometheus）

- **Nest 源位置**：`apps/api/src/modules/observability/metrics.controller.ts:33`（`@Controller("metrics")`）、`:40`（`@Get()`）、`:41`（`@Permissions("metrics.read")`）、`:43-62`（SEC-03：`PlatformAccessService.assertPlatformAdmin` 或机器令牌创建者平台管理员校验；`Content-Type` 由 `prometheusContentType()` 设置）。
- **Go 侧**：`WithMetrics` 精确 `GET /api/metrics`（`apps/api-go/internal/legacyproxy/metrics_routes.go:15-19`）；开关 `API_GO_METRICS_MODE`（默认 `legacy`，`apps/api-go/internal/config/config.go:3844-3850`）；handler 注册 `apps/api-go/cmd/api/nest_residual_duties.go:229-255`（`internal/metrics.NewHandler(authenticator, db, metrics.Default())`）。
- **Nest 行为（go 后）**：Nest **不读取** `API_GO_METRICS_MODE`（只有 `env.schema.ts:103` 声明，无读取分支）；`MetricsController` 仍注册，若直接访问 Nest 仍按 `metrics.read` + 平台管理员返回。切流后正常流量走 api-go，Nest 侧指标不再被 scrape。
- **切流后影响**：Go 接管要求 MySQL/Redis/JWT（`nest_residual_duties.go:241-243`）；Go 的指标集合与 Nest 的 `prometheus-metrics.ts` 是否逐项一致未核实（由 T1.7/T5 验证）。停 Nest 后 `/api/metrics` 仍可用（前提：开关 go）。
- **注意**：`API_GO_METRICS_MODE` 不是“禁用 Nest 指标”的开关；若两个进程都被 scrape，会得到两套不同进程的指标（label/实例不同），需要监控侧按 target 区分。

### 6. 静态资源 / 上传 / 媒体

- **静态资源**：`apps/api` 没有 `ServeStaticModule`、`useStaticAssets` 或静态目录中间件（全仓 grep `useStaticAssets|ServeStaticModule` 无命中）；`main.ts:107-117` 只挂 helmet/cookieParser/json/urlencoded。根路径与 `/assets` 等不属于 Nest API；Web 静态由 `apps/web` 提供。
- **上传**：没有 multipart 上传 controller（无 `FileInterceptor`/`MulterModule`/`multer` 命中）。头像上传是 `POST /api/auth/avatar/presigned-url`（`apps/api/src/modules/auth/auth.controller.ts:606`，A 类，开关 `API_GO_AVATAR_UPLOAD_MODE`，Go 规则 `account_data_routes.go:27`，handler `internal/accountdata`）；实际字节由客户端直传 S3，不经 api。
- **媒体下载/签名**：`GET /api/crawl-media-assets/:assetId/:mode`（`apps/api/src/modules/crawl/crawl-media-asset.controller.ts:29`，**@Public**）由 `WithCrawlReadTelemetry` 的两段动态规则接管（`crawl_read_telemetry_routes.go:35`，开关 `API_GO_CRAWL_READ_TELEMETRY_MODE`，handler `internal/crawlreadtelemetry`）；Go 接管时兼容 MySQL blob/S3 分支。缺失 S3 配置时 Nest 分支的 404 行为见 GAP-CRAWL-001（不在本任务）。
- **切流后影响**：S3 直传和媒体读取不依赖 Nest 进程；但签名 URL 的生成/校验在 Go handler 内，需要 `API_GO_AVATAR_UPLOAD_MODE` / `API_GO_CRAWL_READ_TELEMETRY_MODE` 为 go。停 Nest 后未迁移的上传/下载入口不会自动工作（当前仅上述两条）。

### 7. SSE 与长连接

- **SSE `GET /api/dashboard/stream`**：Nest `apps/api/src/modules/dashboard/dashboard.controller.ts:373-376`（`@Sse("stream")`，`dashboardStream`）。Go 规则 `WithDashboardStream` 精确 `GET`（`legacyproxy/proxy.go:318-323`），开关 `API_GO_DASHBOARD_STREAM_MODE`（默认 `legacy`，`config.go:3499-3505`），handler 注册 `cmd/api/main.go:1692-1704`（`internal/dashboardstream`）。SSE 在 T1.1 表中算一条 GET 路由（共 370 条中的 1 条）。Go 响应直接流式写；`ModeShadow` 对 `text/event-stream` 直接跳过差分（`legacyproxy/proxy.go:729` 附近的 `streaming-skipped`）。切流后 Nest 的 `@Sse` 不再有流量。
- **Socket.IO**：Nest 默认 path `/socket.io`，规则 `{Prefix: "/socket.io/", Mode: ModeLegacy}`（`proxy.go:145`）。Go 另有两条独立 Engine.IO 路径：`/socket.io-notifications`（`WithNotificationsSocket`，`proxy.go:191-202`，开关 `API_GO_NOTIFICATIONS_SOCKET_MODE`）与 `/socket.io-realtime`（`WithRealtimeSocket`，`proxy.go:204-217`，开关 `API_GO_REALTIME_SOCKET_MODE`）；`cmd/api/main.go:2683-2708` 注册 runtime。Nest 侧读取这两个 env 并改发 identifiers-only relay（见 T1.3）；默认 legacy 表示所有 namespace 仍走 Nest，停 Nest 后默认 `/socket.io` 不可用。具体 namespace/兼容桥由 T1.3 审计。
- **GraphQL WebSocket**：`/graphql` 默认 legacy 前缀（`proxy.go:144`）；`WithGraphQLRead` 只在 `graphqlRouteMode=go` 时插入 exact GET/POST/OPTIONS 规则（`proxy.go:428-456`），GraphQL 订阅另有开关（`API_GO_GRAPHQL_SUBSCRIPTIONS_MODE`，要求 `GRAPHQL_SUBSCRIPTION_BUS=redis`，`config.go:4194-4216`）。由 T1.2 审计，T1.7 仅记录“长连接默认在 Nest”。

### 8. 根路径与 404 行为（已关闭：`API_GO_LEGACY_FALLBACK_MODE`）

- **Go 侧**：`Gateway.match` 未命中任何规则时返回 `Rule{Prefix: path, Mode: ModeLegacy}`（`apps/api-go/internal/legacyproxy/proxy.go:814-830`），`ServeHTTP` 的 `ModeLegacy` 分支走 `proxyLegacy`（`proxy.go:560-561`）。因此 `/`、`/favicon.ico`、未知 `/api/...`、`/docs` 之外的任意路径都原样代理到 Nest。
- **Nest 侧**：没有 catch-all controller 或 404 中间件；未匹配路径由 Nest/Express 默认 404 处理（不是 `GlobalExceptionFilter` 的业务错误体）。`main.ts:62-67` 的全局前缀只影响 controller 路由，不影响 404。
- **本批落地（C-9）**：新增 `API_GO_LEGACY_FALLBACK_MODE`（默认 `proxy`）。`reject` 时 `proxyLegacy` 不再建立上游连接，改为写 Nest 全局异常过滤器等价的 404（`x-trace-id` + 字段顺序 `statusCode/message/error/traceId/path/timestamp`，`message=Cannot <METHOD> <request.url>`，`path` 含查询串，`timestamp` 为 ISO 毫秒 Z），并把事件写入 `exceptionevents`（复用 `internal/exceptioningest`，best-effort 异步）。同时新增 `api_go_legacy_rejected_requests_total{route_prefix}`，标签与 `api_go_legacy_proxy_requests_total` 同一前缀函数。CORS 预检由 `internal/cors` 先应答（204），与 Nest 的 cors 中间件顺序一致；无预检头的 OPTIONS 返回 404。
- **启动校验**：`reject` 要求 config 中所有以 `Mode` 结尾的字段为 `go`（豁免表只有 `LegacyFallbackMode` 自身），否则启动失败并列出不满足的开关名。`LEGACY_API_URL` 留空时仍按历史默认填充，但 reject 不使用它。
- **切流后影响**：阶段 0–5 这些请求仍由 Nest 响应；阶段 6b 切 reject 后，未迁移/未知路径稳定返回 404，不再 502。
- **未核实**：Nest 默认 404 的精确 JSON/HTML 体未运行验证；`/api/healthz/live` 之外，是否有 ingress 将 `/` 重写到 Web 也未核实（compose 只暴露 api 4000 与 web，未配置 nginx）。

### 9. 部署/探针联动（切流影响清单）

| 位置 | 当前目标 | 阶段 6 需要 |
|---|---|---|
| `infra/docker/docker-compose.yml:665`（api 服务 healthcheck） | `http://localhost:4000/api/healthz/live`（Nest） | 停 Nest 后必须改到 api-go：`API_GO_HEALTHZ_LIVE_MODE=go` 时 `http://api-go:4020/api/healthz/live`，或 Go 内部端点 `/__go/healthz`；具体改法见 runbook 阶段 6（本批不改 compose） |
| `infra/docker/docker-compose.yml:1714-1724`（web 启动等待） | `${API_BASE_URL}/api/healthz/live` | 同上；`API_BASE_URL=http://api-go:4020` 且 `API_GO_HEALTHZ_LIVE_MODE=go` 时由 Go 响应，不再依赖 Nest |
| `infra/docker/api-go.Dockerfile:47-56`（api-go healthcheck） | `GET 127.0.0.1:$PORT/__go/healthz` | 不变；这是 Go 内部端点，`proxy.go:148` 固定 `ModeGo`，handler 在 `main.go:2001` 附近注册 |
| `infra/docker/docker-compose.yml:774`（api-go 服务） | `profiles: ["api-go-pilot"]`，`LEGACY_API_URL=http://api:4000` | 停 Nest 前必须保证所有经 Go 的请求不再命中 legacy；`LEGACY_API_URL` 可保留但停 Nest 后其余 legacy 路径会 502 |

### 10. 未核实项

- 未启动服务：`/docs` 子资源、`/admin/queues` 的实际 HTML/静态资源、`/api/metrics` 的 Go/Nest 指标等价性、SSE 断线重连、Socket.IO 升级链均未实测。
- Swagger `useGlobalPrefix` 默认值按 Nest Swagger 模块默认行为理解（未传该选项）；本批 Go 实现**没有用真实浏览器打开 `/docs`**，只做了静态与 Go 单元测试；`/docs-yaml` 未实现。
- Bull Board 的子路径（`/admin/queues/*`）、队列 UI API 由第三方库决定，未逐条枚举。
- `BULL_BOARD_ENABLED`、`SWAGGER_ENABLED` 的实际部署值未知（`.env.example` 仅示例；生产可能被 compose/env 覆盖）。
- `/api/metrics` 的 Go 指标集合与 Nest `prometheus-metrics.ts` 是否逐项一致未核实（需要真实 scrape 对比）。
- 根路径 404 的精确响应体已按 Nest 源码实现并有单测；但没有在真实 Nest 实例上做逐字节对比（未启动服务），ingress/反向代理行为未核实。

---

## 7. 未核实项汇总（不得当作已验证）

本审计只做静态阅读，以下项目全部**未运行验证**，在切流前必须由部署环境或专门的验证批次完成：

1. 运行时等价性：Nest 与 Go 的响应体/状态码/错误形状等价性（各节均未实测）；Go handler 的业务分支只做了源码级对照。
2. 路由边界：Nest/Express 的尾斜杠匹配（默认非 strict）未运行验证；本文与 `testdata/nest-routes.txt` 使用规范路径（无尾斜杠），带尾斜杠的请求在 Go 侧通常不命中 exact 规则而回落 `/api/`。
3. SSE 与长连接：`/api/dashboard/stream` 的 `Content-Type`、断线重连；两条 Socket.IO path 的握手、namespace multiplex、polling 回退；`/graphql` WebSocket 升级链。
4. 指标等价性：`GET /api/metrics` 的 Go 指标集合与 Nest `prometheus-metrics.ts` 是否逐项一致（需要真实 scrape 对比）。
5. 队列运行时：消费、重试、stalled、并发与积压行为；`itemPipelineDlq` 的人工处理流程。
6. 外部服务：crawl4ai、LiteLLM、SMTP、Telegram、Oref、AkShare、Nominatim/OpenSky、对象存储均未调用。
7. 部署值：`SWAGGER_ENABLED`、`BULL_BOARD_ENABLED`、各 `API_GO_*` 在真实部署中的实际取值未知；compose 只代表 pilot 默认。
8. 时区：compose 未设置 `TZ`，定时任务的时区对齐未实测。
9. PR 证据：T3 矩阵中的回退/已知问题来自 PR 描述与提交信息，凡未在描述中明确写的均标「未核实」。
10. 行号：本文档中的 `proxy.go` 行号按 `dcbe563b` 记录；本批在该文件增加 legacy 计数后工作区行号偏移，合并后需平移。
11. GraphQL Subscription 的注册可观测性：`graphqlsubscriptions.New` 在包内自建私有 `contract.Registry`（`apps/api-go/internal/graphqlsubscriptions/handler.go:113`）且不导出访问器，所以 T2 测试对这 4 个订阅根采用「真实构造 `New`（内存 stub、不连 Redis/网络）+ 对 `source.go` 的 `subscriptionRoots` 表与 `handler.go` 注册循环做 AST 断言」；Query/Mutation 的 134 个根走真实 `contract.Registry` 断言。限制与理由写在 `apps/api-go/internal/graphqlread/cutover_roots_test.go` 的包注释里。

## 8. 与其它交付物的衔接

| 交付物 | 位置 | 与本审计的关系 |
|---|---|---|
| T2 HTTP 测试 | `apps/api-go/internal/legacyproxy/cutover_coverage_test.go` + `testdata/nest-routes.txt` | 用 §2 的 368 条 A 类路由断言「全量 go 规则下不回落 `/api/`」；测试数据由本审计生成 |
| T2 GraphQL 测试 | `apps/api-go/internal/graphqlread/cutover_roots_test.go` + `testdata/nest-graphql-roots.txt` | 用 §3 的 138 个 A 类根字段断言注册：134 个 Query/Mutation 走真实 `contract.Registry`，4 个 Subscription 走「真实构造 + `subscriptionRoots` AST 断言」（见 §7 第 11 条） |
| T2 配置测试 | `apps/api-go/internal/config/cutover_all_go_test.go` + `testdata/all-go.env` | 断言 131 个开关全 go 时 `config.Load` 通过全部依赖校验 |
| T5.6 legacy 计数 | `apps/api-go/internal/legacyproxy/proxy.go`、`internal/metrics/families.go` | `api_go_legacy_proxy_requests_total{route_prefix}`，供手册判断 legacy 回落是否归零 |
| T3 开关矩阵 | [switch-matrix.md](switch-matrix.md) | 每个开关的资源/依赖/回退/阶段；C 类相关开关见 §0.2 |
| T4 配置样例 | `infra/docker/api-go-cutover.env.sample` + `compose` override 样例 | 全量 go 的可复制样例；说明 compose 硬编码与缺失变量 |
| T5 切流手册 | [runbook.md](runbook.md) | 阶段 0–6、验证、回退、停 Nest 判定；阶段 6 被 §0.2 的 C 类阻塞 |
| T6 迁移地图 | `docs/refactor/migration-map/README.md` | 覆盖表按本审计的 A 类计数回填 |

> T2 的两条覆盖测试由现有普通 CI 的 `verify` job（`go test ./...`）执行；本文档不声称它们已经运行或通过，CI 结论以 PR 描述中的 run 链接与 `gh run view --json conclusion` 为准。
