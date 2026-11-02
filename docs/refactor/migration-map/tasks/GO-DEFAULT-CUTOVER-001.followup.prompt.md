# 继续 #151：补齐本地 Go 默认链与显式 legacy 回退

继续 `wei500L/newwei` 的 **GO-DEFAULT-CUTOVER-001**，修复现有 Ready PR **#151** 的默认开发配置缺口。**直接更新 #151，不新建重复业务任务/PR，不重做已完成的领域迁移，不提前删 Node 后端或双轨代码。** 本轮仍只做源码、静态复核与普通 CI，不部署、不连接真实外部服务。

本提示词于 2026-10-31 发布在规划 PR **#149**（`codex/plan-go-cutover-next`）；规划尚未合入时可从 #149 只读取得本提示词与阶段说明，不必先合并整个规划分支。

## 1. 恢复现有任务

先读 `AGENTS.md`、迁移地图 `README.md` / `PLANNING.md` / `GAPS.md` / `tasks/README.md`、`GO-DEFAULT-CUTOVER-001.md`，以及 #150/#151 的 PR 描述。执行 `git fetch origin main`，核对开放 PR、精确 head、`git worktree list` 与现有目录状态。

本次核实：

- main = `385c887e8cda2df6a3fadd2109c6641ae62cb6ee`，#150 已合并；不要重新实现安全头/指标/异常主链/条目 10MiB 修补。
- #151 = `codex/go-default-cutover`，head `b97e181aa7248175ed3c91daf9a258dba6289f96`，worktree `/Users/oo/project/newwei-go-default-cutover`。该 head 的普通 CI [40576119903](https://github.com/wei500L/newwei/actions/runs/40576119903) 三个主要 job success，两个 regen skipped；尚未合并。
- main 普通 CI [40557202479](https://github.com/wei500L/newwei/actions/runs/40557202479) 失败在 Web `queue-ops-content.test.tsx` 的 `deletes a failed job from the detail modal`（找不到 `job-failed`），两个集成 job success。#151 已有相关等待调整并通过自身 CI，不要把不同 SHA 的结果混用，也不要自动认定新失败同属旧竞态。

复用上述 worktree/分支。若 #151 已有后续提交，先读增量并保留其修改；若已经合并，则基于当时最新 main 另开最小修复 PR，并明确这是已合并任务的剩余修复。不要重置、stash、覆盖其他会话改动；普通 merge 同步必要 main 增量，不 rebase/amend/force-push。

## 2. 已确认的问题与核实边界

以下定位取自 #151 的 `b97e181a`，执行时重新核对，不凭报告直接改：

1. **根 `.env.example:57-65` 仍是旧链**：`API_BASE_URL=http://localhost:4000`、`NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api`，两个 Socket.IO 路径仍 `/socket.io`；`:70` onboarding 是 shadow，`:83` 左右 user-settings-write 为 legacy，`:103-119` 订阅、通知/实时传输与调度开关仍 legacy。不能只修这几项后假定其他显式开关均正确，按当前 config 实际开关清单对账。
2. **这不是无效注释**：`apps/web/next.config.mjs:4` 会读根 `.env`，`apps/web/lib/env.ts:48-54` 把这些显式值传给解析器；Zod 的新默认不会覆盖已有值。复制根示例后 Web 仍找 4000/旧传输路径。
3. **Go 的环境来源需要闭合**：新 `pnpm dev` 直接调用两个 Go 包的 `go run`；API `cmd/api/main.go:522` 与 vector `main.go:36` 用 `LoadFromOS`，AIS `cmd/ais-relay/main.go:42` 用 `os.LookupEnv`。现有代码没有证明普通 Go 进程会自动读根 `.env`。请追踪真实启动链、Turbo 环境传递与 cwd，不能用 Web 读了 `.env` 推导 Go 也读了。
4. **普通宿主进程与 Docker 发布端口可能不一致**：根示例当前 vector URL 为 `localhost:4011`、AIS URL 为 `localhost:3005`，但 vector 的 `internal/config/config.go` 默认监听 **4010**，AIS 的 `DefaultListenPort` 与 `AIS_RELAY_PORT` 为 **3004**。4011/3005 来自 Docker 的宿主映射，不能假定 `go run` 有这层映射。需要让本地启动的监听端口、API 调用地址与说明成对一致。
5. **`dev:legacy` 不能只换进程名单**：根示例修成 Go 后，同一 `.env` 下直接启动 Nest/Web 会继续拿 Go 地址、路径和 mode。核对 `pnpm dev:legacy` 的有效配置，给出实际可用、不会污染默认配置的显式回退。

## 3. 实施范围与期望行为

### A. 根示例与新默认一致

根示例改为 Go API `http://localhost:4020` / 浏览器 `http://localhost:4020/api`，通知 `/socket.io-notifications`、实时 `/socket.io-realtime`。现有业务 `API_GO_*_MODE` 示例采用 go，fallback 采用 reject，canary 保持 0；特殊历史 shadow/legacy/proxy 只保留在显式回退配置。对照源码复算实际集合，不用旧计数掩盖漏项或重复键；不为凑齐清单引入新的迁移开关。

同步相邻注释与 README/AGENTS 的现行操作说明，历史报告可以保留原基线，不要把整份历史文档统一改成“最新已验证”。不要修改任何真实 `.env`、`.env.local`、secret 或数据库内 SystemSetting。

### B. 环境加载、资源与进程生命周期

让文档中约定的“复制根示例、填写必需资源/密钥后执行本地开发命令”真实适用于 Go 和 Web。优先复用已有 Node/dotenv/配置能力；如需启动桥，只做最小环境加载和进程启动，不新建通用编排框架、不安装新包、不把 `.env` 当 shell 脚本执行。

明确并验证：根 `.env` 的定位不依赖误用 cwd；已经由调用者显式设置的环境变量按约定优先；必要的服务专属端口/回退选择在对应子进程生效；Turbo 不丢掉资源变量；共享 JWT、加密键、MySQL/Redis/Mongo、向量 token 不被覆盖或打印。`DATABASE_URL` 在根示例可为空而 Nest 曾从 MYSQL_* 派生，需明确 Go 启动的现行要求：保留已有派生契约或把必须填写的值说明准确，不能吞校验/填假密钥让启动看似成功。

保持 Ctrl-C/终止信号传给实际 Go/Node 子进程，退出码能反馈失败；不要遗留孤儿进程。不要给多个并行服务注入同一个全局 `PORT` 导致争用；不要由本地入口自动迁移/seed 数据库、启动 Docker、修改真实配置或联网验证。

### C. 三条本地链与容器链分开对账

- `pnpm dev`：Go API、Go vector、Web 的有效地址/权限与监听端口一致，默认不启动 Node 后端。
- `pnpm dev:ais-relay`：读取同一约定资源，监听端口与 API 的 AIS URL 一致。保留当前单独启动的设计，不强迫没有 AISStream 配置的用户在 `pnpm dev` 时连接上游。
- `pnpm dev:legacy`：显式启动 Node 后端和 Web，并一致切回 API base、两个 Socket.IO 路径、vector/AIS URL、原有业务开关与 fallback；onboarding/user-settings-read 采用各自合法回退值，不能统一写不存在的 legacy。保持执行权唯一，Go 默认命令不能与回退命令同时悄悄拉起对方。

普通本地进程可以沿用 4010/3004 并修正根示例 URL，也可以明确设置进程独立监听端口匹配 4011/3005；选改动最小且与文档一致的方案。Docker 内部仍使用 `vector-go:4010`、`ais-relay-go:3004`，外部映射按 compose；不因修本地启动破坏容器端口、旧覆盖文件、初始化任务、CORS 或生产必填凭据。

### D. 测试验证实际配置路径

现有 `default-resources.env` / all-go 配置测试保留；增加必要行为覆盖，避免只测“不给任何显式值时默认 go”，却没测用户会复制的真实示例。

- 以根示例/实际环境加载流程作为输入，给必需资源注入无秘密的测试值，验证得到全 Go/reject、正确 API/Socket.IO 地址；示例本身不填写真实密钥。
- 验证显式环境覆盖、服务间独立端口、默认与 legacy 两条调用路径、错误退出/信号传递所需的最小行为。可用注入的进程适配器或本地无外网的测试子进程验证，不能在测试里启动完整 Go/Nest/Docker/真实上游。
- Web 断言实际派生 REST/GraphQL/传输地址，复用已有 Vitest。不能用源码字符串/snapshot-of-implementation 代替配置行为；不新增 API Jest/Nest e2e 依赖。

## 4. 边界与交付

主要修改根 `.env.example`、`package.json`、必要应用 dev script/最小启动工具、对应行为测试、README/AGENTS/任务记录。只对本链确需的 compose/env/现有 CI 步骤做最小同步，不新建专用 workflow，不修改 CI runner/调度，不弱化 coverage 或旧门禁。

本机只静态阅读、diff、必要 gofmt；**不安装依赖，不运行 build/test/lint/typecheck/Go vet/Docker/服务**，验证交给已有普通 GitHub Actions。不要沿用原 PR 中本机运行过测试的做法。本轮改完后旧 head 的成功不算新 head 通过；等待并记录新精确 head 的 verify/vector-integration/api-go-user-settings-integration，skipped 不能算通过。失败先看日志，不反复重跑掩盖不稳定。

做纯静态反证复核：默认/显式覆盖、cwd、Turbo、端口、生命周期、错误处理、JWT/租户权限和 GraphQL 契约；证据附当前 `file:line`。本链不应改变业务 DTO/schema/orgId 查询，不借机收紧权限或做重构。源码注释英文；文档/提交/PR 中文。

#150 仍有部分 handler 自写 500 不记异常事件、unknown/stack 不完整的残留，继续如实列出；**不在本次本地配置修补中重写全仓错误出口，也不宣称 GAP-EXCEPTION-WIRING-001 已完整关闭**。删除 `apps/api` / `apps/vector` / `apps/ais-relay`、legacyproxy/shadow/canary 及迁移契约/CI 是 #151 补齐并合入后的下一批，本轮不实施。

只 stage 自己的改动，中文 emoji + `type(scope)` 新提交、正常 push 到现有 #151，更新 PR 标题/描述为最终完整范围、task 的实际 head/CI 与直接运行说明；不另开重复 PR、不合并、不 auto-merge、不 amend/rebase/force-push，不向其他聊天发送消息。

交付请给出“命令 → 配置来源/优先级 → 各进程端口 → 调用地址 → 测试/CI”的简表、修复与残留、最终 head/run/逐 job 结果。只声称源码/配置与 CI 的验证，不声称已部署、真实启动链已实测或外部服务已连通。
