# GO-DEFAULT-CUTOVER-001 · 仓库默认运行链切到 Go

- 状态：`pr_open`；本批已实现并推送 Ready PR（head/CI 见 PR 与下方回填段）。
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

占用 `apps/api-go/internal/config`、`cmd/api` 最小接线、`apps/web/lib/env.ts` 与连接测试、`infra/docker/*`（compose、env 样例、override、runtime.Dockerfile）、`infra/scripts/src/docker-up.js`、根 `package.json` 与 Go 应用的 `package.json`、README / AGENTS / 本任务。未触碰 `apps/api`、`apps/vector`、`apps/ais-relay` 业务代码。

## 验证

- 本机：只做静态阅读、diff 与 `gofmt`；未部署、未连真实外部服务。
- 远端：普通 GitHub Actions CI 在精确 head 上验证（run / 逐 job 在 PR 回填，skipped 不算通过）。
- 保留 Node 与 Go 对照测试、契约漂移门禁与既有集成 job；未删除 Nest，未改 CI runner/调度。

## 回退

显式回退 = `infra/docker/legacy-rollback.override.yml` + `infra/docker/legacy-rollback.env.sample` + `--profile legacy-node`，三件一起用；本地开发用 `pnpm dev:legacy`。执行权交还顺序（含 `SCHEDULE_ENABLED` / `BULLMQ_WORKERS_ENABLED` / `WS_REDIS_ADAPTER_ENABLED` / `GRAPHQL_SUBSCRIPTION_BUS` 第二道门）写在 override 文件末尾。

## 下一阶段

本批合入后才规划删除 `apps/api` / `apps/vector` / `apps/ais-relay` 与 legacyproxy/shadow/canary，并迁移 GraphQL SDL / OpenAPI / 鉴权快照、生成链与 CI 基线。本批不提前删除。
