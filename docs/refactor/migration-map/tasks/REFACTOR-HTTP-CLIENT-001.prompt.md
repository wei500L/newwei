# 执行提示词 · REFACTOR-HTTP-CLIENT-001 · 出站 http.Client 与共享 Transport 收敛

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-HTTP-CLIENT-001.md`。worktree slug：`refactor-http-client`。

**前置**：REFACTOR-LLM-CLIENT-001 已实际合入 main，并且 CI 成功。如果它拆成了 `-a`/`-b` 两个 PR，两个都要合入。它会改动 LLM 相关包中的 Client 持有方式，本任务在它之后统一修改。属于第二轮 B 波。

**背景**：这就是第一轮 REFACTOR-OUTBOUND-CLIENTS-001 原定的 `-b` 部分，一直没有开始。原提示词 `tasks/REFACTOR-OUTBOUND-CLIENTS-001.prompt.md` 的“方案 B”仍然适用，先读它。

## 问题（规划基线 main `67f31754` 已核实，开工时重新 grep）

- 非测试代码中有 43 处 `&http.Client{`，分布在约 41 个文件：
  - `cmd/ais-relay/main.go`、`cmd/api/main.go`；
  - `internal/` 下的 alertworker（webhook、forecast）、assistantruns、crawl4ai、crawlexecution（3 处）、crawlfrontierllm、crawlmetadata、dashboardwarmap（opensky、translate）、dataruntimesettings、economicdata（3 处）、gdeltsnapshot（2 处）、geocoding、itemsreading（2 处）、litellmcompat、llmembed、llmgatewayops、newsbackfilljobs、newseventsingest（2 处）、newsnowsources、oidclogin、publicportal（2 处）、realtimesignals（2 处）、rsstranslation、runtimediagnostics、searchreindex、situationsignals（2 处）、situationsignalsworker、userdigest、vectorclient（2 处）。
  - 其中 22 处是 `&http.Client{}`：没有超时，使用默认 Transport，依赖 ctx 超时。
- 各处的超时、重定向策略和 Transport 各不相同。有些在每次调用时新建 Client。只要新建的 Client 带着新 Transport，连接就无法复用。

## 方案

1. 新建 `internal/platform/outbound`：
   - 一个进程级共享的 `*http.Transport`：从 `http.DefaultTransport` clone，`MaxIdleConnsPerHost` 设为合理值（例如 32），`IdleConnTimeout` 90s；
   - `NewClient(timeout time.Duration, opts ...Option) *http.Client`；
   - Option 至少包括：`NoRedirect()`（`CheckRedirect` 返回 `http.ErrUseLastResponse`）和 `WithTransport(rt)`（例外情况使用）。
2. 逐处替换：
   - 超时**逐个保留原值**。原来是 `&http.Client{}` 的，`NewClient(0)` 保持“无客户端超时”，不要擅自加超时。
   - 原有的 `CheckRedirect` 用 Option 保留。
   - “每次调用都新建”的，改为在构造时创建一次。
3. **例外，保留自己的 Transport**：
   - 自定义 TLS、代理、Dialer（例如 SSRF 防护的拨号检查，`crawlexecution`/`alertworker/webhook` 可能有）；
   - Unix socket；
   - 测试注入。
   - 这些情况用 `WithTransport` 包一层，或者原样保留。在 PR 中列出例外清单和理由。
   - **SSRF 防护的拨号器绝不能被共享 Transport 替换掉**，这是安全底线。
4. `cmd/ais-relay` 是独立的二进制，可以同样使用 `outbound`，也可以保持原样，二选一并说明。

## 等价陷阱

1. 默认 Transport 和 clone 出来的 Transport 在 `ForceAttemptHTTP2`、`Proxy: ProxyFromEnvironment` 上必须保持一致。用 clone，不要从零构造。
2. 共享 Transport 之后，`CloseIdleConnections` 的调用（如果有）会影响所有调用方。检查有没有调用方这样做，有就改为不调用，或者给它单独的 Transport。
3. 响应体大小上限、`resp.Body.Close()` 的位置，都不在本任务范围，不要改。
4. 测试中通过 `httptest.Server.Client()` 注入的 Client，注入点保留。

## 测试

- `outbound` 的单元测试：超时、`NoRedirect`、共享 Transport 是同一实例、`WithTransport` 生效。
- 各包现有测试断言不变。

## 交付范围

允许修改：`internal/platform/outbound/**`（新增），以及上面列出的含 `&http.Client{` 的文件，只改 Client 的构造与持有方式，不改请求逻辑；`cmd/api`、`cmd/ais-relay` 中相关的构造参数。

PR 附上逐处对照表：文件 → 原超时、重定向、Transport → 现在的写法 → 是否例外。
