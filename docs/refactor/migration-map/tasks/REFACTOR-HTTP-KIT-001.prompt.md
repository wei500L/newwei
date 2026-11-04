# 执行提示词 · REFACTOR-HTTP-KIT-001 · HTTP JSON 读写、时间格式与小工具收敛

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-HTTP-KIT-001.md`。worktree slug：`refactor-http-kit`。

**前置**：REFACTOR-HTTP-ROUTER-001 已实际合入 main，并且 CI 成功（包已改名为 `httproute`，handler 头注释已清理）。可以与 REFACTOR-BULLMQ-WORKER-001 并行进行。

## 问题（规划基线 18c41879858d 已核实）

每个包都自带一套小工具，数量（按“定义了该函数的非测试文件数”统计）如下：

| 函数 | 副本数 | 说明 |
|---|---|---|
| `func writeJSON` | 39 | 约 37 个包。签名不统一：有的接收 `any` 再 Marshal（`rbacapi/handler.go:420`），有的接收已编码的 `[]byte`（`newsbehavior/handler.go:152`） |
| `func readJSON` | 14 | |
| `func writeError` | 6 | |
| `(h *Handler) authorize` | 32 | 在 AUTH-CHAIN 合入后，大部分应该只剩一行转发 |
| `nowMillis` | 35 | |
| 时间格式化（`nowUTC`/`isoTime`/`formatISO` 等） | 22 | `internal/graphqlread/contract` 已有 `FormatDateTime`（JS `toISOString`：UTC + 3 位毫秒） |
| `toInt`/`asInt` | 12 | |
| `asString`/`toString` | 13 | |

`internal/httpx` 已存在，但目前只放了中间件、路由标签和响应包装（`writer.go`），没有 JSON 工具。

## 方案

### 1. 在 `internal/httpx` 新增 `json.go`

- `WriteJSON(w, status int, payload any)`：Marshal 失败时返回 500 `"Internal server error"`。
- `WriteRawJSON(w, status int, body []byte)`。
- Content-Type 统一为 `application/json; charset=utf-8`。**但要先核对**：各副本有没有用小写 key、不带 charset、或末尾追加换行（`json.Encoder` 会追加 `\n`，而 `authhttp` 的测试 `bytesEndsWithNewline` 说明错误响应可能有换行约定）。凡是与多数写法不同的副本，就按它原来的字节写法保留：要么在调用点改用另一个专门的函数，要么留在原包内。在差异表中逐个记录。
- `ReadJSON(w, r, maxBytes int64, dst any) error`，或者返回 `json.RawMessage` 的版本，按现有调用模式二选一。
  - 请求体大小上限由调用方传入，因为各包上限不同，例如 `rbacapi` 是 `10 << 20`。
  - 解码错误映射为各包原有的 400 响应形状（Nest ValidationPipe 风格的 `message` 是数组还是字符串，各包可能不同），所以**错误响应仍由各包自己写**，共享函数只返回带分类的错误：`ErrBodyTooLarge` / `ErrInvalidJSON` / `ErrUnsupportedMediaType`。

### 2. 新增 `internal/timefmt`

- 把 `contract.FormatDateTime` 移到这里作为唯一实现，`graphqlread/contract` 改为调用它。
- `NowMillis() time.Time`：UTC，截断到毫秒，用于写入 `DATETIME(3)`。
- 先核对 35 个 `nowMillis` 副本是否都是 `time.Now().UTC().Truncate(time.Millisecond)`。如果有的返回 `int64` 毫秒数，那是不同的函数，不要合并到一起，可以另外提供 `NowUnixMilli()`。

### 3. 宽松类型转换（`toInt`/`asString` 等）

先读每个副本的用途：

- 如果是在解析 `map[string]any` 形式的请求体，正确的做法是改成具名结构体解码。只在**本任务涉及的 handler** 中顺手这样改；涉及面大的就不要动，记入剩余项。
- 如果是在模拟 JS 的 `Number()`/`String()` 强制转换语义，并且多个副本完全一致，就收敛到 `internal/jsvalue`（如果已有同类包，例如 `crawlfrontierllm/jsvalue.go`，就把它提升为共享包）。语义不一致的副本保留在原包，在差异表中说明。

### 4. 替换所有调用点，删除本地副本

调用点逐个替换，然后删除本地副本。`(h *Handler) authorize` 在 AUTH-CHAIN 之后如果只是一行转发，就直接内联为调用 `authhttp` 的统一入口。

## 等价陷阱

1. 响应字节必须逐字节不变：header 名大小写不影响 HTTP 语义，但测试可能断言 `Header().Get`，所以没关系；要注意的是 body 末尾是否带换行、HTML 转义（`json.Marshal` 默认把 `<>&` 转义成 `<` 等，而 `json.Encoder` 加 `SetEscapeHTML(false)` 时不会转义）。先核对每个副本用的是哪一种。
2. `WriteHeader` 之前必须先设置 header。
3. 读取请求体时，`http.MaxBytesReader` 超限后的错误类型是 `*http.MaxBytesError`。原副本中“超限”是返回 413 还是 400，保持原样。
4. 时间格式：有的副本输出 `Z`，有的输出 `+00:00`；有的保留 3 位毫秒，有的保留纳秒。只合并完全相同的副本，其余保留并说明。

## 测试

- `httpx` 和 `timefmt` 的单元测试覆盖上述字节细节。
- 各包原有的 handler 测试断言保持不变，这是等价性的主要证据。

## 交付范围

允许修改：`internal/httpx/**`、`internal/timefmt/**`（新增）、`internal/jsvalue/**`（可选新增）、`internal/graphqlread/contract/**`，以及含有上述副本的各业务包（只改工具函数和调用点，不改业务逻辑）。PR 附上各类副本“删除前数量 → 删除后数量”。
