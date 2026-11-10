# REFACTOR-HTTP-CLIENT-001 · 出站 http.Client 与共享 Transport 收敛

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-HTTP-CLIENT-001.prompt.md)

## 任务记录

- 状态：**merged**（PR #183 → `695d73eb`；2026-11-10 规划窗口核实并合并，main 普通 CI run 42799529511 success）。
- 规划基线：`origin/main = 67f31754`；规划时间：2026-11-06。
- 来源：第一轮 REFACTOR 交付记录中的“剩余问题”（见总计划“第一轮结果与第二轮候选”）。
- 前置：REFACTOR-LLM-CLIENT-001 的 `-a`（#176，已合）、`-a2`、`-b` 三段全部合入且 CI 成功（第二轮 B 波）。2026-11-07 首次派发时执行窗口核对前置未满足、正确停止，未开工；2026-11-10 前置三段均已合入，可重新派发；并行：—。
- 分支：`codex/refactor-http-client`；worktree：`/Users/oo/project/newwei-refactor-http-client`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-http-client` / [#183](https://github.com/wei500L/newwei/pull/183) / Ready（非 draft）。
- 最终代码 head SHA：`c869189c29e393cebbe7ab34834bc462c19817bd`（其后仅追加本交付记录的文档提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：run [42794780165](https://github.com/wei500L/newwei/actions/runs/42794780165)，event `pull_request`，head `c869189c`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`go-modules-regen` / `contract-baseline-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：新增 `internal/platform/outbound`（共享 `*http.Transport` clone 自 `http.DefaultTransport`、`MaxIdleConnsPerHost=32`、`IdleConnTimeout=90s`、`NewClient(timeout, Option...)` 及 `NoRedirect`/`WithTransport`/`WithCheckRedirect`、单测）；替换 `origin/main=63de00cb` 上实测 **44 处** `&http.Client{`（41 文件）的构造/持有方式，超时逐个保留。**例外原样保留**：`alertworker/webhook.go`（SSRF 固定拨号，安全底线）、`llmgatewayops/service.go`（自定义 `net.Dialer` + 50 次探测需 64 空闲/host）。**例外改用 `WithTransport` 保留自有 Transport**：`gdeltsnapshot`/`realtimesignals` 的 IPv4 强制拨号、`situationsignalsworker/oref` 出站代理、`newsnowsources/fetch`（关闭时 `CloseIdleConnections` 需独立池）、`economicdata/provider_yfinance`（复用 service Transport + 3 跳重定向）。只改构造，不改请求逻辑；未改 `apps/web`。
- 有意行为变更：无对外 HTTP/GraphQL/Socket 契约、状态码、请求体、Redis/Mongo/MySQL 存储、BullMQ wire 变更。内部非契约差异：`crawl4ai` 原 `MaxIdleConnsPerHost=50`/`MaxIdleConns=100` 并入共享池 32/100；其余默认 perhost=2 提升至 32——仅连接复用数量，不影响语义。无新增超时（原 `&http.Client{}` 仍为 0）。
- 剩余问题：规划称 43 处、实测 44 处/41 文件（已在 PR 说明差异）；本机未安装依赖、未运行 `go build`/`go test`/`go vet`/Docker，运行证据仅为精确 head 普通 CI；未连接真实 LiteLLM/MySQL/Redis/Mongo/Qdrant，未部署、未实网验证。
