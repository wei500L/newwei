# REFACTOR-LLM-CLIENT-001 · LLM 补全/流式/嵌入调用上收到 litellmcompat

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-LLM-CLIENT-001.prompt.md)

## 任务记录

- 状态：**pr_open（`-a` 步骤 1：profile 与密钥统一）**；步骤 2/5 与 `-b` 见剩余问题。
- 规划基线：`origin/main = 67f31754`；规划时间：2026-11-06。
- 来源：第一轮 REFACTOR 交付记录中的“剩余问题”（见总计划“第一轮结果与第二轮候选”）。
- 前置：无（第二轮 A 波）；并行：与 CRAWLWORKER、CLEANUP 并行。
- 分支：`codex/refactor-llm-client`；worktree：`/Users/oo/project/newwei-refactor-llm-client`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-llm-client` / [#176](https://github.com/wei500L/newwei/pull/176) / Ready（非 draft）。
- 最终代码 head SHA：`8f273cbc62d56fc83ef75c0dc9f9fc3446c58353`（其后仅追加本交付记录的文档提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：run [42284515418](https://github.com/wei500L/newwei/actions/runs/42284515418)，event `pull_request`，head `8f273cbc`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：**本 PR 只做 `-a` 的步骤 1（profile 与密钥只保留一份）**——导出 `litellmcompat.Profile`/`ProfileKind`/`ResolveProfile`/`ResolveProfileFromSettings` 与 `GovernanceError`，统一 publicportal / crawlfrontierllm / llmembed / graphqlread-history 各自的 `normalizeProfile`/`profileAPIKey`/`decryptSecret`/`normalizeAPIBase`/`applyGovernance` 副本，并在解析后统一 `NormalizeGatewayAPIBase`。**排除（留待后续 PR）**：步骤 2（publicportal 各 completion 表面与 crawlfrontierllm `complete` 上收 `Completion`）、步骤 5（llmgatewayops/llmlogs 探针改调 `PostOnce`/`Probe`）、`-b`（流式 `CompletionStream` 与 llmembed/crawlfrontierllm 的 Embedding/Rerank 上收）。
- 有意行为变更：governance 托管密钥取值统一 `NormalizeGatewaySecret`（剥离 Bearer 前缀）；litellmcompat DB 解析补做 apiBase 归一化（修 bug）。对外 HTTP/GraphQL 状态码与文案、请求体、Redis/Mongo/MySQL 存储、BullMQ wire 格式不变（差异逐条见 PR 差异处理表）。
- 剩余问题：步骤 2、步骤 5、`-b` 未做；本机未安装依赖、未运行 `go build`/`go test`/`go vet`/Docker，运行证据仅为精确 head 的普通 CI，未连接真实 LiteLLM/MySQL/Redis/Mongo。
