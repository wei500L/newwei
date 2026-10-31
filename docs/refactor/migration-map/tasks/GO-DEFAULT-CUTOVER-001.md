# GO-DEFAULT-CUTOVER-001 · 仓库默认运行链切到 Go

- 状态：`pr_open`；Ready PR [#151](https://github.com/wei500L/newwei/pull/151)，实现 head `b15df1c2d57fd77621a33fe0c73abe268264779b`，普通 CI [run 41198396244](https://github.com/wei500L/newwei/actions/runs/41198396244) `success`（`verify` / `vector-integration` / `api-go-user-settings-integration` 均 success，两个 regen job skipped 不计通过）；未合并。
- 规划基线：`f15f598d4358b4c9823054ef5a355618e1480a4e`；开工实际基线 `origin/main = 385c887e8cda2df6a3fadd2109c6641ae62cb6ee`（#150 合入后）。
- 前置：[GO-CUTOVER-PREREQS-001](GO-CUTOVER-PREREQS-001.md) 四项已合入 main。
- 执行提示词：[GO-DEFAULT-CUTOVER-001.prompt.md](GO-DEFAULT-CUTOVER-001.prompt.md)（在规划 PR #149）。
- 编码分支：`codex/go-default-cutover`；worktree：`/Users/oo/project/newwei-go-default-cutover`。
- 来源：用户贴出的“全部转 Go、静态审查 + CI、不上生产”阶段 3；前六批与整合 #148 已 merged。
- 默认 / 部署：本批只改仓库配置与默认值；未部署，未连接真实外部服务，未承接真实流量。

## 前置核实（开工时）

- `origin/main` = `385c887e`（Merge PR #150）。
- #150 head `4f21c0255545f1709a469b7c6c16708a8f25e2ab` 已是 main 祖先；该 head 的普通 CI run 40551203359 `success`（`verify` / `vector-integration` / `api-go-user-settings-integration` 全 pass，两个 regen skipped）。
- 四项源码在 main 上逐项复核存在：`httpx.SecurityHeadersMiddleware`（`apps/api-go/internal/httpx/security.go:113-120`，根链 `cmd/api/main.go:3396`）、`httpx.MetricsMiddleware` + `metrics.RecordHTTPRequestMetric` 生产调用（`cmd/api/main.go:3396-3410`）、异常记录器装配（`cmd/api/exception_recording.go:32-33`、`cmd/api/main.go:1868` 与 `:2568`）、`POST /api/items` 的 10 MiB 边界（`internal/itemsingest/handler.go:184` 的 `createBodyLimit`）。

## 切换后的默认事实

| 项 | 默认 |
|---|---|
| 业务 `API_GO_*_MODE`（136 个） | `go`（未设置/空值） |
| `API_GO_LEGACY_FALLBACK_MODE` | `reject` |
| `CANARY_PERCENT` | `0`（未变） |
| `API_GO_HEALTHZ_LIVE_MODE` | `go`（Web 启动等待该路由由 Go 响应） |
| `API_GO_ONBOARDING_MODE` | `go`（shadow 保留为显式回退） |
| `API_GO_USER_SETTINGS_READ_MODE` | `go`（shadow 保留为显式回退） |
| Web 服务端 | `http://api-go:4020` |
| 浏览器 | `http://localhost:4020/api` |
| 通知 Socket.IO 路径 | `/socket.io-notifications` |
| 实时 Socket.IO 路径 | `/socket.io-realtime` |
| vector 容器内地址 | `http://vector-go:4010`（宿主 4011） |
| AIS 容器内地址 | `http://ais-relay-go:3004`（宿主 3005） |
| compose 默认服务 | api-go / vector-go / ais-relay-go / web / 依赖服务 / migrate / mongo-indexes |
| Node 后端 | 仅 `legacy-node` profile（api / vector / ais-relay） |

## 范围与所有权

占用 `apps/api-go/internal/config`、`cmd/api` 最小接线、`apps/web/lib/env.ts` 与连接测试、`infra/docker/*`（compose、env 样例、override、runtime.Dockerfile）、`infra/scripts/src/docker-up.js` 与新增的 `infra/scripts/src/dev*.ts/mts`、根 `package.json` 与 Go 应用的 `package.json`、README / AGENTS / 本任务。未触碰 `apps/api`、`apps/vector`、`apps/ais-relay` 业务代码。

## 验证

- 原 #151 交付记录（历史，本轮不重复声称）：本机曾做静态阅读、diff、`gofmt`、`go vet ./...` 与 `go test ./internal/config/`；远端普通 CI 曾在当时 head `c3af4125` 成功（旧 head 结果不作为本轮新 head 的证据）。`internal/alertworker` / `crawl4ai` / `crawlexecution` 的本机 DNS 失败已用改动前树复现，与本批无关。
- 本轮 follow-up（2026-10-31）：只做静态阅读、diff 与 `gofmt`；**未运行** build/test/lint/typecheck/Go vet/Docker/服务，未部署、未连真实外部服务。新 head 的普通 CI 逐 job 结果以 PR 描述回填。
- 现有门禁保留：`testdata/default-resources.env`（只给资源、不给任何 mode）+ `TestDefaultConfigIsAllGoWithoutAnyModeSwitch`；`TestAllGoFixtureStillDetectsMissingSwitch` 校验 fixture 键完整性；`TestAllGoFixtureMatchesOmittedSwitches` 要求显式写全与全部省略一致。新增门禁见下方 follow-up 段落。

## 回退

显式回退 = `infra/docker/legacy-rollback.override.yml` + `infra/docker/legacy-rollback.env.sample` + `--profile legacy-node`，三件一起用；本地开发用 `pnpm dev:legacy`。执行权交还顺序（含 `SCHEDULE_ENABLED` / `BULLMQ_WORKERS_ENABLED` / `WS_REDIS_ADAPTER_ENABLED` / `GRAPHQL_SUBSCRIPTION_BUS` 第二道门）写在 override 文件末尾。

## 后续补齐（2026-10-31，GO-DEFAULT-CUTOVER-001 follow-up）

- **根示例与新默认一致**：`.env.example` 的 API base 改为 `http://localhost:4020` / 浏览器 `http://localhost:4020/api`，两个 Socket.IO 路径改为 `/socket.io-notifications`、`/socket.io-realtime`；根示例补齐 137 个 `API_GO_*_MODE` 的完整清单（136 个业务 `go` + `API_GO_LEGACY_FALLBACK_MODE=reject`），并显式给出 `CANARY_PERCENT=0`。宿主 vector/AIS 地址改为 Go 本地监听端口 `4010`/`3004`；Docker 的宿主映射说明仍保留在注释与 `infra/docker/.env.sample`。
- **环境加载与生命周期**：新增 `infra/scripts/src/dev.mts` + `dev-config.ts` + `dev-process.ts`。启动器从模块 URL 推导仓库根并读取根 `.env`（不依赖 cwd），优先级为“调用者进程环境 > 模式 overlay > `.env`”；`go`/`legacy` 的开关与地址来自 `api-go-cutover.env.sample` / `legacy-rollback.env.sample`，每个子进程获得独立 `PORT`；`DATABASE_URL` 为空且 `MYSQL_*` 完整时按 Nest/Prisma 契约派生，不完整则留给 api-go 自身启动校验失败。SIGINT/SIGTERM/SIGHUP 转给子进程组，非零退出码原样返回；不执行迁移、seed、Docker 或网络探测。
- **三条本地链**：`pnpm dev` = api-go(:4020)+vector-go(:4010)+web(:3000)；`pnpm dev:ais-relay` = Go AIS relay(:3004)；`pnpm dev:legacy` = Nest api(:4000)+Node vector(:4010)+Node AIS(:3004)+web(:3000)，并切回两个 `/socket.io` 路径、vector/AIS 本地地址、134 个业务 legacy + onboarding/user-settings-read 的合法 shadow + fallback=proxy。
- **回退配置修正**：`infra/docker/legacy-rollback.env.sample` 的 onboarding / user-settings-read 由不存在的 `legacy` 改为 `shadow`；`legacy-rollback.override.yml` 中 Web 构建参数、vector/AIS/API 地址与 `LITELLM_CONFIG_API_BASE` 改为回退字面量，`web`/`litellm` 的 `depends_on` 用 Compose `!override` 替换，避免被 `infra/docker/.env` 的 Go 默认值或已停的 api-go 依赖覆盖；`infra/docker/.env.sample` 的 `LITELLM_CONFIG_API_BASE` 改指 `http://api-go:4020/api`；`docker-compose.yml` 删除 api-go 内重复的 `API_GO_HEALTHZ_LIVE_MODE` YAML 键（137 个开关仍唯一）。
- **测试**：新增 `apps/api-go/internal/config/cutover_env_example_test.go`（真实根示例 + 占位资源解析为 all-go/reject；回退样例与 config 开关集合逐项对齐、重复键失败），以及 `apps/web/lib/dev-runtime.test.ts`（真实示例输入、显式覆盖、独立端口、Go/legacy/ais-relay 三条计划、退出码与 SIGTERM 进程组转发）；扩展 `env-connection-defaults.test.ts` 从根示例派生 REST/GraphQL/Socket.IO 地址。
- **验证边界**：本轮仍只做静态阅读、diff 与 `gofmt`；未运行 build/test/lint/typecheck/Go vet/Docker/服务，未部署、未连真实外部服务。新 head 的普通 CI 结果见 PR 描述回填；旧 head 的成功不替代新 head。

## 下一阶段

本批合入后才规划删除 `apps/api` / `apps/vector` / `apps/ais-relay` 与 legacyproxy/shadow/canary，并迁移 GraphQL SDL / OpenAPI / 鉴权快照、生成链与 CI 基线。本批不提前删除。
