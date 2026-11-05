# REFACTOR-OUTBOUND-CLIENTS-001 · 出站 HTTP Client 与 LLM chat 客户端收敛

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-OUTBOUND-CLIENTS-001.prompt.md)

## 任务记录

- 状态：**planned**（提示词已写好，尚未发出或认领）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-HTTP-KIT-001 与 REFACTOR-SETTINGS-CRYPTO-001 合入且 CI 成功。
- 分支：`codex/refactor-outbound-clients`；worktree：`/Users/oo/project/newwei-refactor-outbound-clients`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-outbound-clients` / [#173](https://github.com/wei500L/newwei/pull/173) / Ready（非 draft）。本 PR 为**-a（LLM）的第一批**（出站传输与密钥归一化），不是完整的 -a。
- 最终代码 head SHA：`d6f081e7a9dd6e8e663962220a63ea973b031623`（其后仅追加本交付记录的文档提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：run [41998332152](https://github.com/wei500L/newwei/actions/runs/41998332152)，event `pull_request`，head `d6f081e7a9dd`，`conclusion=success`；`verify` / `vector-integration` / `globe-vendor` / `api-go-user-settings-integration` 均 success，`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：新增 `litellmcompat.PostOnce`（共享 LLM POST 传输：请求构造、Bearer、超时、响应上限、header clone），`publicportal`(gateway/assistant)、`crawlfrontierllm`、`llmembed`(http/archive_port) 的 POST 改调它并删除重复传输；把仅 litellmcompat 使用的加密/归一化 helper 从 `llmembed/export.go` 迁到 `settingscrypto`（删除 export.go），解除 `litellmcompat → llmembed` 依赖。排除（核对后与规划基线描述不符或留待后续）：`graphqlread/history/capabilities.go` / `llmlogs/probe.go` / `llmgatewayprofiles/governance_guard.go` 实为只读能力/日志/治理，不含 chat-completions HTTP 或 profile 解密；`runtimediagnostics/safety.go` 为 GET 健康诊断。
- 有意行为变更：无契约变更；唯一细节为读取失败时 `PostOnce` 返回已读到的部分 body（调用方 err!=nil 时不使用 body）。
- 剩余问题（-a 继续）：publicportal 各 completion 表面的 profile 解析/请求体/响应解析/guardrail/fallback 上收到 `Completion`；`analysis_stream`/`assistant_stream` 上收到新增 `CompletionStream`；crawlfrontierllm `complete/rerank`、llmembed `Embed/Rerank` 上收；`llmgatewayops`/`llmlogs` 探针改调 `PostOnce`（底层 postOnce 备选已暴露）。本机未安装依赖、未运行 go build/test/vet/Docker；运行证据仅为精确 head 的普通 CI，未连接真实 LiteLLM。
