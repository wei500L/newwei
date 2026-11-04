# 执行提示词 · REFACTOR-OUTBOUND-CLIENTS-001 · 出站 HTTP Client 与 LLM chat 客户端收敛

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-OUTBOUND-CLIENTS-001.md`。worktree slug：`refactor-outbound-clients`。

**前置**：以下两个任务都已实际合入 main，并且 CI 成功：

- REFACTOR-HTTP-KIT-001
- REFACTOR-SETTINGS-CRYPTO-001：网关 profile 的密钥解密已经统一。

## 问题（规划基线 18c41879858d 已核实）

### 1. LLM 网关调用有多套实现

`internal/litellmcompat/client.go`（1006 行）已经是比较完整的客户端，包括：

- profile 与密钥加载；
- 模型 fallback 链；
- guardrail 头解析；
- 上游错误文本提取；
- chat/responses 两种 API；
- embedding、rerank；
- 调用日志写入。

但它目前只被 `newspipeline`、`newsclassifier`、`archivepreparationworker`、`itempipeline` 使用。

另外这些包各自直接拼 `chat/completions` 请求：

- `publicportal`：`gateway.go` 以及 `kg_completion.go`、`hottest_completion.go`、`rss_completion.go`、`assistant_completion.go`、`clustering_completion.go`、`analysis_stream.go`（流式）；
- `crawlfrontierllm/llm.go` + `llm_profile.go`；
- `llmembed/http.go` + `export.go`；
- `graphqlread/history/capabilities.go`；
- `llmgatewayops/probe_*.go`；
- `llmlogs/probe.go`；
- `llmgatewayprofiles/governance_guard.go`；
- `runtimediagnostics/safety.go`。

这些副本各自加载 profile、解密密钥、设置超时和重试、解析错误，fallback 与 guardrail 的行为都不一致。

### 2. 出站 `http.Client` 有 43 处 `&http.Client{...}`

超时、重定向策略、Transport 复用方式各不相同。有的在每次调用时新建 Client，Transport 不复用，连接也就无法复用。

## 方案

### A. LLM 调用

1. 先把每个副本按用途分类，并记入 PR 表格：

   | 类别 | 处理 |
   |---|---|
   | a. 普通补全（同步） | 迁到 `litellmcompat.Client.Completion` |
   | b. 流式补全（`publicportal/analysis_stream.go`） | 如果 litellmcompat 不支持流式，就给它新增 `CompletionStream`。要求：基于 SSE 逐行解析，透传 ctx 取消，guardrail/错误处理与 `Completion` 一致 |
   | c. 探针/诊断（`llmgatewayops/probe_*`、`llmlogs/probe.go`、`runtimediagnostics/safety.go`） | 需要拿到原始状态码、耗时、原始错误文本，而且**不能**走 fallback（探针测的是指定模型或指定 profile）。为它们提供 `litellmcompat.Client.Probe(ctx, profile, model, req) (ProbeResult, error)`，或者暴露底层的 `postOnce`。不要强行套用带 fallback 的 `Completion` |
   | d. embedding（`llmembed`） | 迁到 `litellmcompat.Client.Embedding` |

2. 迁移后删除各包本地的 profile 加载、密钥解密（应该已经调用 settingscrypto）、请求体构造、响应解析和错误提取代码。
3. 调用方原来特有的参数（`temperature`、`max_tokens`、`response_format`、`tools`、超时）作为 `CompletionRequest` 字段传入。如果 `CompletionRequest` 缺少某个字段，就给它增加具名字段，不要用 `map[string]any` 透传。

### B. 出站 HTTP Client

1. 在 `internal/httpx`（或新的 `internal/platform/outbound`）提供一个进程级共享的 `*http.Transport`（合理设置 `MaxIdleConnsPerHost`、`IdleConnTimeout`），以及 `NewClient(timeout time.Duration, opts ...Option) *http.Client`。
2. 每次调用都新建 Client 的地方，改为在构造时创建一次。
3. 超时值逐个保留原值。重定向策略（例如有些地方禁止跟随重定向）作为 Option 保留。
4. 需要代理或自定义 TLS 的地方（如果有，例如走代理负载均衡的抓取），继续使用自己的 Transport，不要强行共享。在 PR 中列出这些例外。

## 等价陷阱

1. **fallback 语义**：`publicportal` 等副本原来可能只调用一个模型，没有 fallback。迁到 `Completion` 后，如果默认会尝试 fallback 链，就是行为变更。必须通过参数保持原语义，或者明确把它记作“有意变更”，并说明理由。
2. **调用日志**：litellmcompat 会写 LLM 调用日志（`LogWriter`）。原来不写日志的调用方，迁移后是否要写，按功能判断：
   - 用户可见的调用，写日志是有益的；
   - 探针调用不要污染调用日志。
   在差异表中说明。
3. **guardrail 拦截**：原副本对“被 guardrail 拦截”的处理（返回什么状态码和文案给前端）保持不变。
4. **流式**：首字节超时与整体超时的区别，客户端断开时的取消，SSE 行缓冲大小。
5. **请求体**：`messages` 的字段顺序和可选字段的省略（`omitempty`）会影响上游行为，例如有的上游对 `null` 与“不传”处理不同。
6. **不要伪造上游验证结果**：本任务无法调用真实的 LiteLLM。在 PR 中如实写明“未连真实网关验证”。

## 测试

- 各包原有使用 `httptest.Server` 模拟上游的测试，断言保持不变；如果它们断言的是请求体，需要确认迁移后的请求体与原来一致。
- litellmcompat 新增的 `CompletionStream`/`Probe` 需要有单元测试。

## 交付范围

允许修改：`internal/litellmcompat/**`、`internal/httpx/**` 或 `internal/platform/outbound/**`、上面列出的 LLM 调用包、含有 `&http.Client{` 的文件（只改 Client 构造），以及 `cmd/api` 中相关的构造参数。工作量很大时，可以拆成 `-a`（LLM）和 `-b`（http.Client）两个 PR，`-b` 等 `-a` 合入后再开。
