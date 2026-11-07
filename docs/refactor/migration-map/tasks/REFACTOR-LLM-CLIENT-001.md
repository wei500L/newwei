# REFACTOR-LLM-CLIENT-001 · LLM 补全/流式/嵌入调用上收到 litellmcompat

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-LLM-CLIENT-001.prompt.md)

## 任务记录

- 状态：**部分合入**（`-a` 步骤 1 #176，经整合 #180 → `dba96962`，main CI success）。剩余拆为两段依次执行：**`-a2`**（步骤 2 同步补全上收 + 步骤 5 探针）已提交 [PR #181](https://github.com/wei500L/newwei/pull/181) Ready（head `503a191c`，普通 CI success），待合入；**`-b`** = 步骤 3（`CompletionStream`）+ 步骤 4（Embedding/Rerank 上收），`-b` 等 `-a2` 合入后再开。REFACTOR-HTTP-CLIENT-001 等这两段都合入。
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

## 交付记录 -a2（编码窗口填写：步骤 2 + 步骤 5）

- 分支 / PR / Ready：`codex/refactor-llm-client-a2` / [#181](https://github.com/wei500L/newwei/pull/181) / Ready（非 draft）。
- 最终 head SHA：`503a191c3d8b59575254452049c1a1c28d4c2257`（其后仅追加本交付记录的文档提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：run [42369322352](https://github.com/wei500L/newwei/actions/runs/42369322352)，event `pull_request`，head `503a191c`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：**步骤 2** 在 `internal/litellmcompat/run.go` 新增共享完成引擎 `Attempt`/`AttemptObserver`/`CompletionPlan`/`(*Client).RunCompletion`（主模型→fallback→每模型重试/指数退避→每尝试回调；`Stop` 错误终止整链），并新增 `NewSettingsClient`（从已读快照解析 profile）/`WithHTTP`/`postWithLimit`。publicportal 的 `brief`、`KG`、`rss 翻译`、`hottest`、`clustering`、`assistant`（非流式 `Complete`）与 `crawlfrontierllm.complete` 均改为经 `ResolveProfile` + `RunCompletion`，删除各自重复的 fallback/retry/observer 循环；请求体构造与响应/错误解析保留在各表面，observer 经适配器继续产出原 typed attempt（model/modelIndex/attempt/success/err/latency/usage/apSurface/governance/authMode/targetProfileID 不变，含 `x-litellm-response-cost` 头解析）。**步骤 5** `llmgatewayops` 探针 POST 改走 `postBodyOnce`（`litellmcompat.PostOnce`），管理类 POST 仍走原 `do()`，重建同一 `upstreamResponse`/`upstreamError`（状态码/耗时/错误文案不变）；`llmlogs/probe.go` 为纯 Mongo 日志写入器，无 chat-completions HTTP 或 profile 解密，本步无需修改。**排除**：步骤 3 流式 `CompletionStream` 与步骤 4 Embedding/Rerank 留待 `-b`；`assistant_stream.go` 流式路径未改。
- 有意行为变更：无对外 HTTP/GraphQL/Socket 契约变更。细节：crawl 多 choice 响应仅取首个 choice 的 content（请求从不请求 n>1）；probe POST 不再发送 `Accept: application/json, text/plain, */*`（`PostOnce` 仅设 `Content-Type`/`Authorization`）。
- 剩余问题：`-b`（流式 + Embedding/Rerank，含 assistant 流式与非流式统一）未做；本机具备 Go module cache，已对受影响包执行 `go build`/`go vet`/`go test ./...` 作补充自检并通过，但最终运行证据以精确 head 的普通 CI 为准；未连接真实 LiteLLM/MySQL/Redis/Mongo，未部署、未实网验证。

## 交付记录 -b（编码窗口填写：步骤 3 + 步骤 4）

- 分支 / PR / Ready：`codex/refactor-llm-client-b` / [#182](https://github.com/wei500L/newwei/pull/182) / Ready（非 draft）。
- 最终 head SHA：`83c1aa308c9519c7ed0f54a5c01f698f862a001c`（其后仅追加本交付记录的文档提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：run [42372744624](https://github.com/wei500L/newwei/actions/runs/42372744624)，event `pull_request`，head `83c1aa30`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：**步骤 3** 新增 `internal/litellmcompat/stream.go`（`StreamPlan`/`(*Client).CompletionStream`），统一 SSE 传输、404/405 路径回退、每模型重试+指数退避、ctx 取消即停读并关闭上游 body、chat/responses 两种块解码、usage/cost 合并、每次尝试 `AttemptObserver`；`analysis_stream.go` 与 `assistant_stream.go` 改调它，只保留各自业务事件映射与错误装饰（删除本地 `readSSE`/`sseFrame`/`streamModels`/`consumeStream` 等整套副本）；回退门控用 `FinishStarts` 区分 analysis（finish-only 也算已输出）与 assistant（仅 delta）。**步骤 4** `llmembed.Embed`/`Rerank` 改走 `litellmcompat.Client.Embedding`/`Rerank`（删除 `parseEmbeddings`/`postWithRetry`/`metadataPayload`）；`crawlfrontierllm.rerank` 改走新增的 `litellmcompat.Client.RerankWithProfile` + 每次尝试 `Observer`（保留自带 profile 解析覆盖与 frontier 请求日志），删除 `rerankModel`/`postRerank`/`parseRerankResults`。`archive_port.go` 已使用 litellmcompat，未重复改动。**排除**：无（步骤 5 探针已由 `-a2` 完成；步骤 6 只读能力展示已由 `-a` 完成）。
- 有意行为变更：无对外 HTTP/GraphQL/Socket 契约、状态码、文案、请求体字段名/`omitempty`/`stream` 语义变更。内部细微差异：① assistant 流式单帧行上限由 2MB 改为不设上限（统一采用 analysis 的 `bufio.Reader` 多行 SSE 解析）；② assistant 流式 usage 合并改为 analysis 超集（额外识别根级 token/成本头，标准响应结果不变）；③ `llmembed.Rerank` 经 `litellmcompat.Rerank` 会新增内部 fallback 指标计数（不影响返回与日志文档）；④ `llmembed` 的 embedding/rerank 请求体改用具名结构体序列化，字段集合一致、JSON 键顺序可能不同（无测试断言其字节序）。
- 剩余问题：本任务（`-a`/`-a2`/`-b`）全部完成。本机另执行 `go build ./...`、`go vet ./...`、`go test ./...`（apps/api-go）作为补充自检并通过；最终运行证据以精确 head 的普通 CI 为准；未连接真实 LiteLLM/MySQL/Redis/Mongo，未部署、未实网验证。
