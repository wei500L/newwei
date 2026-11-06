# 执行提示词 · REFACTOR-LLM-CLIENT-001 · LLM 补全/流式/嵌入调用上收到 litellmcompat

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-LLM-CLIENT-001.md`。worktree slug：`refactor-llm-client`。

**前置**：无。本任务属于第二轮 A 波，可以与 REFACTOR-CRAWLWORKER-001、REFACTOR-CLEANUP-001 并行。CLEANUP 不会改本任务拥有的包（见“交付范围”）。

**背景**：第一轮 REFACTOR-OUTBOUND-CLIENTS-001 只完成了 `-a` 的传输层：新增 `litellmcompat.PostOnce`，并让 publicportal/crawlfrontierllm/llmembed 的 POST 改调它。它交付记录中“剩余问题（-a 继续）”列出的内容，就是本任务的范围。先读 `tasks/REFACTOR-OUTBOUND-CLIENTS-001.md` 的交付记录和 PR #173 的 diff（`gh pr diff 173`）。

## 问题（规划基线 main `67f31754` 已核实）

`internal/litellmcompat` 已有完整的 `Client`，包括：

- `Completion`、`Embedding`、`Rerank`；
- profile 解析与 governance（`settings.go` 中的 `resolveCompletion`/`applyGovernance`）；
- fallback 链、guardrail 与错误分类（`errors.go`）；
- 调用日志。

但以下包仍各自维护一整套“读 settings → 归一化 profile → 套 governance → 解密密钥 → 拼请求体 → 解析响应 → guardrail/fallback/重试”：

| 包 | 本地副本（函数） |
|---|---|
| `publicportal/gateway.go`（857 行） | `resolveCompletionProfile`、`normalizeProfile`、`applyGovernance`、`governanceSecret`、`profileAPIKey`、`decryptSecret`、`normalizeAPIBase`、`completeModel`/`postCompletion`、`retryable`、`completionText`、`completionUsage`、`isGuardrailBlockedResponse` |
| `publicportal/{kg,hottest,rss,clustering,assistant}_completion.go` | 各 completion 表面在 gateway 之上的请求构造与响应解析 |
| `publicportal/analysis_stream.go`（744 行）、`assistant_stream.go` | 各自一套 SSE：`openStream`/`postStream`/`consumeStream`（`bufio.Scanner`）、`chatStreamChunk`/`responsesStreamChunk`、usage/cost 合并 |
| `crawlfrontierllm/llm.go` + `llm_profile.go` | `resolveGatewayProfile`、`profileAPIKey`、`decryptSecret`、`normalizeAPIBase`；`complete`/`rerank` |
| `llmembed/http.go`、`crypto.go`、`profile.go`、`archive_port.go` | `normalizeProfile`、`resolveProfileKey`、`decryptSecret`、`normalizeAPIBase`；`Embed`/`Rerank` |
| `graphqlread/history/secret.go`、`capabilities.go` | `decryptSecret`、`normalizeProfile`（只读能力展示） |
| `llmgatewayops/probe_{model,run,lb}.go`、`llmlogs/probe.go` | 探针自行拼 `chat/completions` 请求 |

`decryptSecret` 现在仍有 4 份副本：publicportal、crawlfrontierllm、llmembed、graphqlread/history。它们内部虽然已经调用 `settingscrypto.ParseKey`，但信封校验和解密流程是复制的，而 `settingscrypto.DecryptSettingsSecret` 已经存在。

## 方案

### 1. profile 与密钥只保留一份

- 所有包改为通过 `litellmcompat` 解析 profile，或者在 `litellmcompat` 中导出一个只读的 `ResolveProfile(ctx, kind)`，返回已解密的 `Profile`。
- 删除上表中各包的 `normalizeProfile`/`profileAPIKey`/`decryptSecret`/`normalizeAPIBase`/`applyGovernance` 副本。密钥解密统一使用 `settingscrypto`。
- **差异先核对再合并**：
  - publicportal 的 `GatewayEnv` 默认值（env 回落）与 litellmcompat `Config` 是否一致；
  - governance 规则（目标 profile、密钥覆盖）是否一致；
  - `authMode()` 有几种取值（Bearer/x-api-key 等）。
  - 不一致的地方，以“正确语义”为准，逐条写进 PR 的差异处理表。

### 2. 同步补全

- publicportal 的各 completion 表面和 crawlfrontierllm 的 `complete`，迁到 `litellmcompat.Client.Completion`。
- `CompletionRequest` 缺字段时增加**具名**字段，例如 `Tools`、`ResponsesAPI`、`Surface`/`Feature`（用于日志）、`DisableFallback bool`、`Observer`，不要用 `map[string]any` 透传。
- publicportal 目前有 `BriefCompletionObserver`（每次模型尝试回调，用于运行记录和 usage/cost 统计）。在 litellmcompat 中提供等价的尝试级回调，或者把它映射到现有的 `LogWriter`/`recordFallback`。不能丢失现有的 usage、cost 和 `x-litellm-response-cost` 头解析。

### 3. 流式补全

- 新增 `litellmcompat.Client.CompletionStream(ctx, req) (<-chan StreamEvent, error)`，或者使用回调形式，按现有两个调用方的使用方式二选一。要求：
  - 同时支持 chat 与 responses 两种 SSE 块；
  - ctx 取消时立即停止读取，并关闭上游 body；
  - fallback 只在**尚未向下游输出任何内容**时尝试下一个模型。核对现有 `streamModels` 的语义并保持一致；
  - guardrail 与错误分类同 `Completion`；
  - 合并 usage/cost。
- `analysis_stream.go` 和 `assistant_stream.go` 改调它，只保留各自的业务事件映射。
- 注意 `bufio.Scanner` 默认的 64KB 行上限：现有代码是否调用过 `scanner.Buffer`，保持原上限。

### 4. 嵌入与重排

`llmembed` 的 `Embed`/`Rerank` 和 crawlfrontierllm 的 `rerank`，迁到 `litellmcompat.Client.Embedding`/`Rerank`。`archive_port.go` 已经部分使用了 litellmcompat，确认不要重复。

### 5. 探针

- `llmgatewayops` 和 `llmlogs` 的探针需要拿到原始状态码、耗时和原始错误文本，而且**必须测试指定的 profile 和模型**，不能走 fallback，也不能写入调用日志。
- 提供 `litellmcompat.Probe(ctx, profile, model, req) (ProbeResult, error)`，或者直接让探针调用 `PostOnce`，只复用请求体构造与错误提取。
- 探针返回给前端的字段、状态码和文案保持不变。

### 6. 只读展示

`graphqlread/history/capabilities.go` 只读取 profile 用于能力展示，并不发起调用。它的 `normalizeProfile`/`decryptSecret` 改为调用共享实现即可；返回给 GraphQL 的字段保持不变。

## 等价陷阱

1. **fallback**：原来不做 fallback 的调用方，迁移后也不能做（用 `DisableFallback` 保持）。原来做 fallback 的调用方，链的顺序和终止条件（guardrail 拦截时停止）保持不变。
2. **重试**：publicportal 的 `retryable(status, err)` 与 litellmcompat 的 `MaxRetries` 语义（哪些状态码重试、退避间隔）逐一对比。不同的地方要么通过参数保持，要么列为有意变更并说明理由。
3. **调用日志**：用户可见的调用原来写不写日志，迁移后保持；探针不写日志。在差异表中逐个调用方列出“日志：前 → 后”。
4. **返回给前端的错误**：guardrail 拦截、上游 4xx/5xx、不兼容 Responses API 等情况下，各 handler 返回的状态码和 message 字符串逐字不变。现有 handler 测试是主要证据。
5. **请求体**：字段名、`omitempty`、`response_format`（例如 `briefResponseFormat`/`briefJSONSchema`）以及 `stream: true` 保持字节级语义一致。有 `httptest` 断言请求体的测试，断言不改。
6. **响应上限**：现有 `PostOnce` 各调用点的 `maxBody` 不同（2MB、8MB、`maxResponseBytes`、`archiveResponseLimit`），迁移后保持各自的上限。
7. 本任务无法连接真实的 LiteLLM。PR 中如实写明“未连接真实网关验证”。

## 测试

- 各包现有的 `httptest` 上游测试保持断言不变。
- litellmcompat 新增的 `CompletionStream`、`Probe`/`ResolveProfile` 以及新字段要有单元测试，覆盖：fallback 被禁用、流式中途取消、流式已输出后不 fallback、guardrail、usage/cost 合并。

## 交付范围

- 允许修改：
  - `internal/litellmcompat/**`、`internal/settingscrypto/**`（只做必要导出）；
  - `internal/publicportal/**`、`internal/crawlfrontierllm/**`、`internal/llmembed/**`、`internal/graphqlread/history/**`、`internal/llmgatewayops/**`、`internal/llmlogs/**`；
  - `internal/llmgatewayprofiles/**` 与 `internal/runtimediagnostics/**`（只在需要复用共享 profile 时修改）；
  - `cmd/api` 中上述包的构造参数。
- **不要**改 `&http.Client{` 的构造方式，那属于后续的 REFACTOR-HTTP-CLIENT-001。
- 工作量太大时，可以拆成两个 PR：`-a` 做 profile/密钥统一、同步补全和探针，`-b` 做流式与嵌入/重排。`-b` 等 `-a` 合入后再开。
- PR 附上各副本的“删除前 → 删除后”行数统计和差异处理表。
