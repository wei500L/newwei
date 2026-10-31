# Go 切流文档与配置样例（cutover）

> **状态更新（GO-ONLY-RUNTIME-001，2026-10-31）**：`apps/api-go` 已改为纯 Go 运行时，删除反向代理、shadow/canary、`API_GO_*_MODE` 迁移开关与 GraphQL 整包回退；未命中路由返回 Nest 等价 404。**Go 不再支持 mode 回退**，回退只能把 Node 后端作为独立旧链启动（第三步 GO-NODE-RETIRE-001 再做删除）。目录内文其余内容为历史切流记录。

本目录是「Go 切流准备」批次的交付入口。**本批未在部署环境执行任何切换**；目录内所有命令、验证与时间估计都只写在文档里，没有运行。

## 1. 目录导航

| 文件 | 内容 | 交付物/任务 |
|---|---|---|
| [ownership-audit.md](ownership-audit.md) | T1 执行权审计：Nest 全量 HTTP 路由、GraphQL 根字段、Socket.IO namespace、worker/Cron/Redis 订阅者的 A/B/C 分类与 `file:line` 证据 | T1 执行权审计 |
| [switch-matrix.md](switch-matrix.md) | T3 开关矩阵：137 个 `API_GO_*` 开关（三批共新增 7 个）的域/类别/Nest 是否读取/依赖/资源/切换顺序/回退问题/风险/阶段 | T3 开关矩阵 |
| [runbook.md](runbook.md) | T5 切流手册：前置检查、阶段 0–6 的改法/验证/回退/行为差异、停 Nest 判定、12 项用户在部署环境亲测清单、legacy 回落观测 | T5 切流手册 |
| [`infra/docker/api-go-cutover.env.sample`](../../../infra/docker/api-go-cutover.env.sample) | T4 配置样例：137 个开关（136 个 `go` + `API_GO_LEGACY_FALLBACK_MODE=reject`）+ 资源占位符 + 分阶段中文注释；**不被 compose 默认加载** | T4 配置样例 |
| [`infra/docker/docker-compose.api-go-cutover.sample.yml`](../../../infra/docker/docker-compose.api-go-cutover.sample.yml) | T4 配套 compose override 样例：给 api-go 加 `env_file`，并把 59 个未走 `${VAR}` 插值的开关重新声明；**不被默认加载**，必须 `-f` 指定 | T4 配置样例 |

## 2. 为什么需要三个文件（env 样例 + compose override + runbook）

`infra/docker/docker-compose.yml` 的 `api-go` 服务（`profiles: ["api-go-pilot"]`，约 774 行起）对 `API_GO_*` 的接线不统一（`dcbe563b` 静态核对）：

| 类别 | 数量 | `--env-file` 能否生效 | 说明 |
|---|---:|---|---|
| `API_GO_X: ${API_GO_X:-legacy}` 插值 | 78 | 能 | 直接在 environment 里插值 |
| 写死字面量（`go` / `legacy`） | 49（7 go + 42 legacy） | **不能** | `environment` 优先于 `env_file`，必须重新声明 |
| 完全未注入 | 10 | **不能** | api-go 没有 `env_file`，只能靠 override 注入 |

因此：
- **`api-go-cutover.env.sample`** 只提供「值」（137 个开关 + 资源占位符），本身只是 env 文件；
- **`docker-compose.api-go-cutover.sample.yml`** 提供「注入方式」：`env_file` 注入全部值，并用 `${VAR:-legacy}` 重新声明 49 个写死开关 + 10 个未注入开关（共 59 个）；其余 78 个由 base compose 插值（三批新接入的 7 个都在其中）；
- **`runbook.md`** 管顺序、验证与回退。

> 名单差异：规划窗口留下的临时名单只有 30 条（未随仓库提交，不作为证据），实测 compose 是 49 个写死（缺 19 个，见 runbook §0.2）。override 按 49+10=59 个全列，避免 19 个开关静默保持 compose 原值。

## 3. 默认部署不变（不传这些文件时）

本批只**新增**样例文件，没有修改 `docker-compose.yml`、`infra/docker/.env.sample`、`config.go` 或任何默认值。不显式使用这些文件时：

- 阶段/开关总数以 `switch-matrix.md` 为准：阶段 1=37、2=61、3=18、4=14、5=3、6=4，合计 137（三批共追加 7 个：37+61+18+14+3+4=137）；阶段 0 不翻转开关；
- 137 个 `API_GO_*` 开关仍按 compose/config 的默认：除 `API_GO_HEALTHZ_LIVE_MODE=shadow`、`API_GO_LEGACY_FALLBACK_MODE=proxy` 两个文档化例外，其余默认都是 `legacy`；compose 的 api-go 服务另有 7 个写死 `go`（pilot 既有行为）；
- Web 仍指向 NestJS：`API_BASE_URL=http://api:4000`、`NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api`；
- canary 仍关闭（`CANARY_PERCENT=0`）；
- `api-go` 仍只在 `api-go-pilot` profile 下启动，默认 `docker compose up` 不会启动它；
- 本批没有新增默认 profile、默认 env_file、默认 include 或默认 `-f`。

**开关总数（三批合并后）是 137：** `refactor/go-ops-entrypoints` 新增 `API_GO_HEALTHZ_LIVE_MODE`、`API_GO_VECTOR_DIAGNOSTICS_MODE`、`API_GO_DOCS_MODE`、`API_GO_LEGACY_FALLBACK_MODE`，`refactor/go-crawl-frontier-writes` 新增 `API_GO_CRAWL_FRONTIER_WRITES_MODE`，`refactor/go-queue-ops` 新增 `API_GO_QUEUE_OPS_MODE`、`API_GO_QUEUE_ORG_STATS_MODE`；env 样例与 override 的数量都以 `apps/api-go/internal/config/config.go` 的 `getenv("API_GO_*")` 去重为准（137）。

**业务切流 ≠ 完全停 Nest：** 全部开关 `go` 只能让业务流量完成切流；本批已关闭 C-1（`/api/healthz/live`）、C-2/C-3/C-4（crawl-frontier 写）、C-5（vector diagnostics）、C-7（Swagger）、C-9（根路径/404），完全停 Nest 仍取决于 C-6（`itemPipelineDlq`）、C-8（Bull Board）的处理决定，以及 `depends_on`/Web 探针的工程变更。详见 runbook 阶段 6 与 §4.2。

## 4. 用法

### 4.1 切流/演练命令（仓库根目录）

```bash
# 【未在本批执行】示例命令；按部署环境的 .env 路径与主机名调整
docker compose \
  --env-file infra/docker/.env \
  --env-file infra/docker/api-go-cutover.env.sample \
  -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.api-go-cutover.sample.yml \
  --profile api-go-pilot up -d
```

**必须同时给两个 `--env-file`：** `--env-file` 会替代默认 `.env`，只给样例会丢掉 `.env` 里的 MySQL/Redis/Mongo/SMTP 等必需值。多 `--env-file` 需要 Compose v2.24+（本批未验证部署环境的版本）。

**只想预览合并结果：**

```bash
# 【未在本批执行】只做配置展开，不启动服务
docker compose \
  --env-file infra/docker/.env \
  --env-file infra/docker/api-go-cutover.env.sample \
  -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.api-go-cutover.sample.yml \
  --profile api-go-pilot config
```

**复制到部署环境使用：** 把 `api-go-cutover.env.sample` 复制为部署环境自己的 `*.env` 并替换全部 `<...>` 占位符；把 `docker-compose.api-go-cutover.sample.yml` 复制为 `docker-compose.cutover.yml`，按需修改 `env_file` 路径与凭据引用。**不要提交真实密钥。**

### 4.2 分阶段使用

- 阶段 0（严格全 legacy）：用 runbook §3「0C」的方法生成 `phase0.env`（全 `legacy` + 两个结构性例外），把第二个 `--env-file` 换成它；override 不变。
- 阶段 1–6：每次只把当前批次的开关改为 `go`，其余保持 `legacy`；不要把 all-go 样例一次性生效（会跳过阶段顺序）。
- 其它配套项（Web 入口、Socket.IO 路径、GraphQL bus、WS adapter）见 runbook §3 与样例文件对应小节。

### 4.3 Web 的 `NEXT_PUBLIC_*` 是构建期参数

`NEXT_PUBLIC_API_BASE_URL`、`NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH`、`NEXT_PUBLIC_REALTIME_SOCKET_PATH` 会内联进 Next.js 构建产物（`infra/docker/runtime.Dockerfile:6-10`、`29-32`；`docker-compose.yml` 的 web build args）：

```bash
# 【未在本批执行】改构建参数后必须重建 web
docker compose \
  --env-file infra/docker/.env \
  --env-file infra/docker/api-go-cutover.env.sample \
  -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.api-go-cutover.sample.yml \
  --profile api-go-pilot build web
# 然后只重启 web
docker compose \
  --env-file infra/docker/.env \
  --env-file infra/docker/api-go-cutover.env.sample \
  -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.api-go-cutover.sample.yml \
  up -d web
```

- `API_BASE_URL`（服务端运行期）只需重启 web，不需要重建；
- 两个 `NEXT_PUBLIC_*_SOCKET_PATH` 与 `NEXT_PUBLIC_API_BASE_URL` 必须重建，否则浏览器仍连旧地址；
- `NEXTAUTH_SECRET` 是运行期变量，**不要**作为 Docker build ARG（AGENTS.md 的明确约束）。

## 5. 版本与基线

| 项 | 值 |
|---|---|
| 分支 | `docs/go-cutover-readiness` |
| 基线 | `dcbe563b`（#136） |
| 开关数 | 137（`apps/api-go/internal/config/config.go` 的 `getenv("API_GO_*")` 去重） |
| 阶段定义 | BRIEF 的阶段 0–6（runbook §0.3/§3） |
| 本批执行范围 | 文档、样例与 T2 测试；未运行 go build/test、pnpm、docker、任何服务（Go 测试由 CI 执行） |

> **2026-10-27 整合复核状态（`integration/go-review-b142-147-4`，合入 #142–#147 后）**：本目录的阶段划分、`137` 个开关计数与「默认全部 legacy」的结论**未变化**——整合批次没有新增或删除任何 `API_GO_*` 开关（`config.go` 的 `getenv("API_GO_*")` 去重前后都是 137），也没有改 `infra/docker/api-go-cutover.env.sample`、`docker-compose.api-go-cutover.sample.yml`、`docker-compose.yml` 的任何默认值或 profile。本目录其余内容仍是 `dcbe563b` 基线上的交付，未在本批重新验证。
>
> 与本目录相关、本批已更正的过期事实只涉及**报告**而非开关矩阵：`docs/refactor/review/identity-core.md` §6 原称 5 条 HTTP「仍由 Nest 独占」（实际 C-1…C-5 都已关闭，缺的只是默认未启用）与「审计 outbox 的消费方仍在 Nest」（实际 `wireAuditOutbox` 已接线）已在该报告 §8 更正；`news-items.md` §7.1 原列的四项「未迁」已在同报告 §7.6 逐条更正（含「Bull Board 面板未移植 ≠ 未交付替代能力」）。上述更正对应的开关在本文件 §3 与 `switch-matrix.md` 里的默认值表述本来就是正确的，因此不改。

## 6. 维护方式

1. **新增开关时同步三处：** `switch-matrix.md`（逐开关矩阵）、`api-go-cutover.env.sample`（值 + 阶段注释）、`docker-compose.api-go-cutover.sample.yml`（若该开关在 compose 里不是 `${VAR}` 插值，必须加入 59 个重新声明列表；否则 env 不生效）。
2. **改 compose 的 api-go 块时：** 重新核对「78 插值 / 49 写死 / 10 未注入」的分类与开关总数（137），更新 runbook §0.2 与 override 的数量说明。
3. **legacy 回落指标（已实现）：** `api_go_legacy_proxy_requests_total{route_prefix}` 已由本批 T5.6 落地（`apps/api-go/internal/legacyproxy/proxy.go` + `apps/api-go/internal/metrics/families.go`，含 `cutover_legacy_metric_test.go`）；PromQL 与标签语义见 runbook §4.1/§6。后续改标签/记录点时要同步 runbook 与 `switch-matrix.md`。
4. **文档事实以基线为准：** 行号会随代码漂移；更新文档时同步替换基线 SHA，并在 runbook §10 记录变更。
5. **不把未执行写成通过：** 所有命令保持「未在本批执行」标注；真实外部验证只能由用户在部署环境回填（runbook §5）。

## 7. 快速核对（静态，不启动服务）

```bash
# 137 个开关（136 个 go + reject）、无行尾注释
grep -cE '^API_GO_[A-Z0-9_]+_MODE=go$' infra/docker/api-go-cutover.env.sample   # 136（137 行中 fallback 为 reject）
grep -E '^API_GO_[A-Z0-9_]+=' infra/docker/api-go-cutover.env.sample | grep -v '=go$' || echo OK

# 名单与 config.go 完全一致（只取 getenv("...") 的真实开关，避免命中注释）
diff <(grep -oE '^API_GO_[A-Z0-9_]+_MODE' infra/docker/api-go-cutover.env.sample | sort) \
     <(grep -o 'getenv("API_GO_[A-Z0-9_]*")' apps/api-go/internal/config/config.go \
       | sed 's/getenv("//;s/")//' | sort)

# override 里重新声明的开关数（应为 59：49 写死 + 10 未注入）
grep -cE '^      API_GO_[A-Z0-9_]+:' infra/docker/docker-compose.api-go-cutover.sample.yml
```
