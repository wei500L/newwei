# 执行提示词 · REFACTOR-CLEANUP-001 · HTTP 样板、剩余锁副本与迁移期注释收尾

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-CLEANUP-001.md`。worktree slug：`refactor-cleanup`。

**前置**：无。本任务属于第二轮 A 波，可以与 REFACTOR-LLM-CLIENT-001、REFACTOR-CRAWLWORKER-001 并行。

**为避免冲突，不改以下包，它们归 LLM-CLIENT 和 CRAWLWORKER 所有：**

- `publicportal`
- `crawlfrontierllm`
- `llmembed`
- `llmgatewayops`
- `llmlogs`
- `llmgatewayprofiles`
- `graphqlread/history`
- `runtimediagnostics`
- `litellmcompat`
- `crawlworker`
- `bullmq`

`cmd/api` 只允许改注释。main 前进时用 `git merge origin/main` 保留双方的改动。

**背景**：本任务把第一轮 HTTP-KIT、LOCKS、HTTP-ROUTER、RUNTIME-WIRING 四个任务交付记录中的“剩余问题”一起收尾。先读这四份 `tasks/REFACTOR-*-001.md` 的交付记录。

## A. HTTP 样板（HTTP-KIT 剩余）

规划基线 main `67f31754` 已核实：

- `func readJSON` 有 14 份：`newsbehavior/body.go`，以及 crawlprofile、exceptioningest、crawlstrategyruns、crawlfrontierruns、crawltaskwrite、crawltemplate、crawlworkflow、situationsignals、newssources、rbacapi、oidclogin、crawlmetadata、queueops 各自的 `handler.go`。HTTP-KIT 的记录里写的是“8 份不同”，以实际为准。
- `func writeError` 有 6 份：newsnowsources、llmgatewayprofiles（不在本任务范围）、publicportal（不在本任务范围）、llmgatewayops（不在本任务范围）、queueops、authhttp。
- `(h *Handler) authorize` 有 32 份。

要做的事：

1. **`readJSON`**：先逐份读，按“请求体大小上限、空 body 的处理、非 JSON Content-Type 的处理、解码失败时的 400 文案和 `message` 形状”分组。
   - 行为完全相同的分组，改调 `httpx.ReadJSON`（已有分类错误），由各包把分类错误映射为自己原来的 400/413 响应。
   - 只有一份的独特语义可以保留，在差异表中说明。
2. **`writeError`**：只合并字节级完全一致的副本。`authhttp` 的版本有“末尾换行”的约定，保持不变。
3. **`authorize`**：AUTH-CHAIN 之后，只做一行转发的副本（约 6 份），直接内联为调用 `authhttp` 的统一入口。依赖本包 `svc.AuthenticateMachine`/`writeServiceError` 的副本，确认机器令牌部分是否已经委托给共享的 `MachineResolver`：
   - 是，就只保留业务错误映射；
   - 否，就改为委托。
   - 不改变任何 401/403 的状态码和文案。
4. **其余宽松转换和时间格式化**：`toInt64`/`asFloat`/`asBool`，以及布局不同的时间格式化。只收敛完全相同的副本，放进 `internal/jsvalue` 和 `internal/timefmt`；语义不同的保留。

## B. 剩余锁副本（LOCKS 剩余）

1. **MySQL `GET_LOCK` 的 `fn(ctx, *sql.Conn)` 形式**：`contentsubscriptions/store.go:49`、`situationmonitors/store.go:20`、`newsindicator/store.go:292`。
   - 这三处的处理函数需要**在持锁的同一连接上**执行后续 SQL，而 `platform/mysqllock.WithLock` 只给出 `fn(ctx)`。
   - 给 `mysqllock` 增加 `WithConnLock(ctx, db, name, waitSeconds, fn func(context.Context, *sql.Conn) error) error`，与 `WithLock` 共用“获取 → 释放失败时逐出连接（`discard`）”的逻辑。
   - 三处改为调用它，删除各自的 `withUserLock`/`withOrgLock`/`releaseLock`。
   - **这会修复一个缺陷**：这三处的 `releaseLock` 都忽略了 RELEASE_LOCK 的失败，连接带着锁回到连接池，锁就泄漏了。这与第一轮 platformgovernance 的问题相同。在 PR 中写为有意变更。
   - 锁名、等待秒数（`contentsubscriptions.UserLockTimeoutSeconds()` 被 situationmonitors 共享）、超时错误文案保持不变。
2. **缓存重建锁**：`newsnowhottest/cache.go:160`、`crawlreadtelemetry/snapshot.go:175`、`qualityoverview/snapshot.go:268`、`classificationrssops/cache.go:292`。
   - 先逐份读：是不是“SET NX 加 token、执行重建、按 token 比对后删除”这种互斥租约。
   - 如果与 `cronlock` 的租约语义一致（token 比对释放、TTL、不需要续期），就改调 `cronlock`。
   - 如果是“抢不到就直接返回旧缓存或空值”的防击穿语义，而 cronlock 没有等价的非阻塞单次尝试接口，就给 cronlock 增加 `TryAcquire`，或者保留原样。
   - 二者选其一，并在 PR 中逐份论证。
   - `classificationrssops/cache.go:284` 那个 SetNX 是缓存写入，不是锁，不要动。
   - key 名与 TTL 保持不变。

## C. 迁移期注释（ROUTER 与 RUNTIME 剩余）

只改注释，不改代码：

- `internal/httproute/*_routes.go`：约有 66 处 `legacy` 字样。“legacy /api/ 兜底”之类的说法改成当前事实；路由前缀互相遮蔽（shadow）这类正当的技术描述保留。
- `cmd/api/*.go`：注释中约有 157 处 `legacy`/`nest`，例如 “legacy default”、“opened on demand”、“NestJS equivalent”、“when mode is go”。改成当前事实或删除。
- 在 A、B 中被你改过的包里，其包注释和 Handler 注释中失效的迁移叙述，顺手改掉。全仓库约 1,068 个文件提到 Nest，**不要**全量改写；这些属于后续可选工作，在 PR 中给出剩余数量即可。
- 不改 404 响应体等对外契约中保留的 Nest 形状，也不改测试名。
- PR 中给出 grep 前后的计数：`grep -rn -i "legacy\|nestjs\|shadow" apps/api-go/internal/httproute apps/api-go/cmd/api --include='*.go' | grep -v _test`。

## 等价陷阱

1. 响应字节不变：body 末尾换行、HTML 转义、Content-Type 是否带 charset、`message` 是数组还是字符串。各包现有的 handler 测试是主要证据。
2. 读取请求体超限时，原来返回 413 还是 400，保持不变；`http.MaxBytesReader` 的错误类型是 `*http.MaxBytesError`。
3. `GET_LOCK` 返回 0（超时）和返回 NULL（出错）时，原来的区分和文案保持不变。
4. 缓存锁：抢锁失败时的降级行为（返回旧值、等待，还是直接重建）保持不变。

## 交付范围

允许修改：

- `internal/httpx/**`、`internal/jsvalue/**`、`internal/timefmt/**`、`internal/platform/mysqllock/**`、`internal/cronlock/**`；
- A、B 中列出的业务包，只改样板、锁调用点和注释，不改业务逻辑；
- `internal/httproute/*_routes.go` 的注释；
- `cmd/api/**` 的注释。

工作量太大时，可以拆成三个 PR：`-a`（HTTP 样板）、`-b`（锁）、`-c`（注释）。三者文件基本不重叠，可以依次或并行开，每个 PR 都要在任务记录中填写自己的交付记录。

PR 中附上各类副本“删除前 → 删除后”的数量和差异处理表。
