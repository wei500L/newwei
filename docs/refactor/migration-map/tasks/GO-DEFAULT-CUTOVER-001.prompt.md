# 任务提示词：仓库默认运行链切到 Go，保留 Node 回退代码

你在 `wei500L/newwei` 执行 **GO-DEFAULT-CUTOVER-001**。这是“全部后端转 Go、只做静态审查 + 普通 CI、不部署”的默认切换批次。交付的是仓库新默认与可审查的回退路径；不操作生产、不连接真实外部服务。本批保留 Node 后端源码及迁移双轨结构，删除工作等本批合入后另派。

规划记录发布于 Ready PR **#149**（`codex/plan-go-cutover-next`）。如规划记录尚未进入 main，从该 PR 只读取得本任务与阶段说明；仅前置业务修补必须真实合入 main，不要求为读规划而合并整个规划分支。可带入本任务 `.md` 供交付回填，不能因此省略前置业务核实。

## 1. 开工依赖

先读 `AGENTS.md`、迁移地图 `README.md` / `PLANNING.md` / `GAPS.md`、任务索引、本任务，以及 `GO-CUTOVER-PREREQS-001.md`。再读 cutover 三份审计/矩阵/手册及 #148 §7、五份 review 的整合更正。

执行 `git fetch origin main`，核对精确 SHA、开放 PR、worktree、普通 CI。**前置四项（安全头、指标接线、REST/GraphQL 异常事件、POST /api/items 请求体契约）必须已真正合入 main，并在相应精确 head 通过普通 CI**；同时确认当前 main 的普通 CI 状态。不要用源分支存在、PR Ready 或单独 self-hosted smoke 当作完成。如果前置尚未落地，先只读核实并说明缺哪项/哪个 PR，不修改依赖文件、不越过前置。

规划基线 `f15f598d4358b4c9823054ef5a355618e1480a4e` 包含 #148 和普通 CI 转自托管 runner，但尚不包含上述前置修补。不要从该旧 SHA 直接开始切换；不要重发 #142–#147 或把已实现但默认 legacy 的能力再迁一遍。沿用现有普通 CI，不顺手修改 runner/调度配置。

从届时最新 main 创建/复用独立 worktree，分支 `codex/go-default-cutover`。本批独占 config、compose/env、Web 连接默认与启动脚本，保留其他已合并增量。

## 2. 目标行为

在示例明确要求的资源/密钥齐备时，仓库的默认开发/编排入口使用 `api-go`、`vector-go`、`ais-relay-go`：

- 所有接管业务 `API_GO_*_MODE` 的未设置/空值默认 **go**；唯一特殊 fallback 默认 **reject**，canary 为 **0**。当前基线 137 个开关中 136 个业务 mode 和 1 个 fallback，开工重新从 config 源码复算，不硬抄旧计数。
- Web 服务端默认 `http://api-go:4020`，宿主开发入口使用对应 localhost 4020；浏览器默认 API 为 `http://localhost:4020/api`，GraphQL/SSE/WS 派生地址正确。
- `NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH=/socket.io-notifications`；`NEXT_PUBLIC_REALTIME_SOCKET_PATH=/socket.io-realtime`。路径与 Go 开关、构建参数、Web env 解析与实际客户端必须同时一致。
- vector 与 AIS 默认指向 `http://vector-go:4010`、`http://ais-relay-go:3004`，容器端口与宿主端口分开说明，不以宿主 4011/3005 作容器间地址。
- 默认无需开启 pilot profile，不启动 Nest `api`、Node `vector`、Node `ais-relay`。代码保留在显式 legacy 回退配置中，不能“仅 API 入口指 Go、三个 Node 后端仍默认全开”。

旧 PLANNING 中“默认 legacy/Web 保持 Nest”的约束属于此前迁移阶段，本任务是有意改变默认值的明确例外；不据旧约束交付另一份仍需手动开启的 pilot 样例。

## 3. 必须完成的链路

### A. config 默认、资源与显式回退

逐项修改 `apps/api-go/internal/config/config.go` 的实际默认分支，并同步注释、错误前置与现有测试。保留非法值启动失败、父子开关依赖与 JWT/DB/Redis/Mongo/加密键等真实前置，不删除校验，不填生产密钥，不为“默认可启动”而退回 legacy 或吞错。

保留已有合法 legacy/shadow/proxy 显式取值语义；onboarding 与 user-settings-read 的历史特殊值按各自协议保留，不统一发明 legacy。`API_GO_LEGACY_FALLBACK_MODE=reject` 仍要求所有业务 mode=go；未匹配路由直接按既有 reject 404，不能暗中发 Nest 请求。核对空 `LEGACY_API_URL` 的解析、gateway 初始化、健康探针与启动日志：Go 默认不依赖 Nest 地址可达，也不因 reject 自动访问该地址；显式 proxy 回退仍校验 URL。

Go 默认全开后，测试/工具里原先“空环境=纯代理”的假设会变化。按每个用例实际目的提供资源或明确旧模式 fixture，不能把所有用例统一套 all-go.env 只为消错。新增**只给资源、不给任何 mode**的默认配置行为测试；原 all-go fixture 应继续验证名称覆盖与显式组合。默认改 go 后，原来依赖“遗漏开关会留下 legacy”检测遗漏的测试会失效，必须保持其完整性检测能力。

### B. Compose 默认服务、初始化与依赖图

改 `infra/docker/docker-compose.yml`，让三项 Go 服务默认启动，三项 Node 服务置于显式 legacy profile/覆盖配置。逐项清理 api-go 的开关注入：当前同时存在可插值、固定 go、固定 legacy、完全未注入四类；让新默认一致且需要回退的值可显式覆盖。同步 `.env.example`、`infra/docker/.env.sample`、cutover 样例/override 的现行用途，旧样例不能悄悄覆盖成 legacy。保留所有必需资源、跨实例总线和端口安全绑定。

**不能丢掉 Nest 原启动命令的工具职责**：`api` 当前先执行 Prisma migrate，再执行 `pnpm --filter @modular/api run mongo:indexes`，然后才启动 Nest。解开 `api-go depends_on api:service_healthy` 和 `web depends_on api` 时，要给迁移与 Mongo 索引准备明确的独立工具/一次性服务、失败阻断与顺序，且默认运行不需要启动 Nest。允许继续用 Node/Prisma 工具与现有索引脚本，不要求本批重写 Go migrator/seed；也不能因还保留 Node 工具就宣称工具链全 Go。不得自动执行真实迁移/seed、修改 DB schema 或重置数据。

Web 现有启动等待会请求 `${API_BASE_URL}/api/healthz/live`，新默认必须直接由 Go 响应，不再 shadow 回 Nest；检查 Go healthcheck 与 distroless 无 shell/curl 的现有约束。依赖图不得有循环或默认服务硬依赖关闭的 profile，vector-go、AIS、DB/Redis/Mongo/模型/采集等现有边界按实际需要保留。

### C. Web、其他调用方、镜像与本地入口

同步 `apps/web/lib/env.ts`、实际 REST/GraphQL/Socket.IO 客户端、`infra/docker/runtime.Dockerfile` 的 ARG/ENV 与 compose build args/runtime env。浏览器 `NEXT_PUBLIC_*` 是构建期内联，不能只改容器 runtime。NextAuth 密钥仍是运行期，不引入 build ARG。

追踪 vector/AIS 的代码默认、env 默认与持久化系统设置的优先级。已有 SystemSetting 指向旧服务时，不能静默批量改数据库；保留显式配置优先，说明旧值需要怎样转换。检查 LiteLLM 配置回调（如 `LITELLM_CONFIG_API_BASE`）、OIDC redirect、公私 API base、健康等待等默认调用方，不能遗留默认对 Nest hostname 的请求。不要改无关外部源或算法。

闭合根 `pnpm dev` / Turbo 启动行为、必要 workspace 脚本与 `infra/scripts/src/docker-up.js`：该脚本当前把 `api` 镜像用于 Prisma preflight，不能切完 profile 后还默认构建/运行旧 Nest 来做预检，也不能直接删掉原校验。保持 Web 可开发、Go 进程生命周期明确，Node 工具职责有独立入口。不安装新包，不重写整个启动器。

### D. 异步执行权与回退

对照 switch-matrix/ownership-audit，静态追踪生产者、消费者、repeat/cron、outbox、事件桥/订阅与总线配置，不只改 HTTP 路由。明确 `SCHEDULE_ENABLED`、`BULLMQ_WORKERS_ENABLED`、`WS_REDIS_ADAPTER_ENABLED`、`GRAPHQL_SUBSCRIPTION_BUS` 等第二道门与既有语义；不要为了全开而无视用户显式关闭，或把两侧本来不同的门控强行改成新协议。

保留一次可审查的**显式 legacy 回退配置**：含 Node profile/依赖、Web 构建与服务端地址、两个 Socket.IO 路径、vector/AIS 地址、137 项中实际需回切的模式及特殊 shadow 值、fallback=proxy、生产者/消费者交权顺序。默认 all-go/reject 下仅把 Web 指回 Nest 或仅打开 Node profile 不构成完整回退。回退启用不能产生双 worker、双 cron、重复通知/爬取计数；保留用户已有数据和共享键。

## 4. 验证与文件边界

- 本机只静态阅读、diff、必要 gofmt；不装包，不运行 Go/pnpm build/test、Docker、数据库或任何服务，不部署，不接真实外部接口。
- 静态复核 config 默认与 compose/env 的有效值、默认/profile 服务集合、初始化依赖、端口、Web 构建/运行期、所有权与显式回退；有条件解析测试放进**现有普通 CI**，使用临时占位配置，不能读真实 `.env` 或打印秘密。
- 更新必要配置行为测试与 Web 行为测试，在既有普通 CI 验证 lint/typecheck/Web coverage/vector/Go 检查。**保留 Node 与 Go 对照测试、契约漂移门禁和既有集成 job**；本批尚未删除 Nest，不得提前裁掉基线。现有集成 fixture 如有意运行 legacy，应显式指定，不能统一改地址导致对照失效。
- 新默认测试证明省略 mode 后仍全 Go；编排解析验证默认无 Node 后端、Web/API 不依赖 Node profile；必要客户端行为测试验证实际连接路径，不能只检索源码字符串或截图实现。
- 只做切默认直接需要的改动；保留 orgId 权限、具名业务类型、错误格式与事务。源码注释英文，新增文件职责/导出注释准确；文档/提交/PR 中文。
- 做只读静态反证复核，逐项核类型/GraphQL、错误处理、租户隔离、异步执行权、回退；成立问题附精确 `file:line`。已记录 SET-01、mtk_ 口径、EX-05、M-04、AIS 算法、关停测试竞态等不机械塞进本批；若发现某项确实阻断本批目标，以实际触发链说明，不伪称已验证或自动放弃全任务。

## 5. 交付与下一阶段

更新当前任务状态与 PR/精确 head/CI；同步 README、AGENTS 的现行启动命令、服务/端口/工具说明和直接受影响的运行手册。共享迁移地图全域回填由规划窗口负责，历史审查基线不改成“最新已全审”。

只 stage 自己的文件，中文 emoji + `type(scope)` 正常 commit/push，创建 **Ready PR**；不合并、不 auto-merge、不 amend/rebase/force-push。

PR 说明新默认→实际生产调用→验证、显式 rollback 的完整配置、工具职责、旧持久化设置处理方式、仍保留的 Node/双轨文件。记录最终 head 的普通 CI run/逐 job，skipped 不算通过，失败要先找原因。验收措辞为“仓库默认链已改为 Go，静态审查与 CI 完成”，不能写“已部署/已跑真实流量/所有外部服务已验证”。

本批实际合入后，下一批才删除 `apps/api` / `apps/vector` / `apps/ais-relay` 与 legacyproxy/shadow/canary，并迁移 GraphQL SDL/OpenAPI/鉴权快照、生成链与 CI 基线。不要在本批提前删除这些内容。
