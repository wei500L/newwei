# 执行提示词 · REFACTOR-SAFE-GOROUTINE-001 · 后台 goroutine panic 隔离

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守其中全部纪律，再读本任务文件 `tasks/REFACTOR-SAFE-GOROUTINE-001.md`。worktree slug：`refactor-safe-goroutine`。前置：无。

## 问题（规划基线 18c41879858d 已核实）

`apps/api-go` 是单进程网关：HTTP、14 个 BullMQ worker、约 49 个 ticker 定时任务和各类后台循环都在同一个进程里。

- 非测试代码里约有 232 处 `go func` 和约 50 处 `go f(...)`，但全仓库只有 1 处 `recover()`（`internal/classificationalert/scheduler.go:349`）。
- `net/http` 只会恢复请求处理 goroutine 自身的 panic。任何**由代码自己启动的 goroutine** 一旦 panic（空指针、越界、类型断言、nil map 写入），都会让整个进程退出，API 和所有 worker 一起挂掉。
- 后台 goroutine 最多的包（按 goroutine 启动点所在文件数）：`situationsignals`、`newsnowhottest`、`graphqlsubscriptions`、`crawlmaintenance`、`realtimesignals`、`realtimeevents`、`notificationssocket`、`newssourcescheduler`、`newsnowsources`、`newsbackfilljobs`、`llmgatewayops`、`gdeltsnapshot`、`crawlmetadata`，以及所有 `*queue` / `*worker` 包。完整清单用 `grep -rn --include='*.go' -E '^\s*go ' apps/api-go | grep -v _test` 重新生成。

## 方案

### 1. 新增 `apps/api-go/internal/safego`（单文件即可）

- `func Go(name string, fn func())`：启动 goroutine；用 defer recover 捕获 panic，按 `log.Printf("safego: %s panicked: %v\n%s", name, v, debug.Stack())` 记录，然后让该 goroutine 正常结束，**不**重启。
- `func Call(name string, fn func() error) (err error)`：在**当前** goroutine 里执行 fn；如果 fn panic，就把 panic 转成 `error`（`fmt.Errorf("%s: panic: %v", name, v)`）返回，同时记录带堆栈的日志。供“每轮/每个任务”的循环体使用，这样循环本身可以继续跑。
- `name` 必须是有界的静态字符串（例如 `"itempipeline.worker.process"`），不要把 jobId/orgId 拼进 name；需要的上下文放进 fn 自己的日志里。
- 指标：只有当 `internal/metrics` 已经有可以直接复用的 counter 注册方式（几行代码就能接上）时，才加 `api_go_goroutine_panics_total{name}`；否则只记日志，不要为此新建指标基础设施。

### 2. 按类别替换所有启动点

逐个读每个 `go` 语句，按下面四类处理：

| 类别 | 典型位置 | 处理 |
|---|---|---|
| A. 长循环（ticker/scheduler/fetch loop/stalled checker/订阅读循环） | `*scheduler.go`、worker 的 `fetchLoop`/`run`/`stalledLoop`、`realtimeevents`、`graphqlsubscriptions` | 外层用 `safego.Go` 启动，**同时**把每一轮的循环体包进 `safego.Call`，让单轮 panic 只影响这一轮、循环继续。只包外层的话，一次 panic 就会让这个后台职责静默停摆，这也是错的。 |
| B. 每个任务/每条消息的处理（BullMQ job、Socket 消息、每个 org 的评估） | 各 worker 的 `process`/`handle` | 用 `safego.Call` 包住业务处理函数调用，把 panic 当作该任务的**普通失败**走既有失败路径（BullMQ 走 moveToFinished failed / retry 的现有逻辑，锁续期 goroutine 照常停止）。不能只记日志后把任务留在 active 状态，否则要等 stalled 检查才能回收。 |
| C. 请求内派生的 fire-and-forget（异常事件记录、lastUsedAt、缓存回填等） | `cmd/api/legacy_fallback.go` 的 recorder、各 handler 里的 `go func` | `safego.Go`。 |
| D. 纯同步辅助（`wg.Wait()` 后关闭 channel、`server.ListenAndServe` 这种） | `cmd/api/main.go` 的 server goroutine 等 | 可以不包；如果包了，不得改变关闭顺序。逐个在 PR 中列出你判定为 D 类不包的位置。 |

`internal/classificationalert/scheduler.go:349` 已有的 recover 语义正确（单个 org 失败），改成 `safego.Call` 的写法，保持 `OrgOutcomeFailed` 结果不变。

## 等价陷阱

1. `recover()` 只在**同一个 goroutine** 的 defer 中有效。在外层包一次，捕获不到内层 `go` 出去的 panic。嵌套启动的每一层都要处理。
2. B 类：panic 转成 error 后，必须仍然走到释放锁、停止续期、`wg.Done()`、释放并发信号量等清理逻辑。检查这些清理是不是写在 defer 里；如果是写在函数末尾的顺序代码里，panic 会跳过它们，这时需要先把它们改成 defer。
3. 不要吞掉 `context.Canceled`：正常关闭流程不能被当成 panic 或失败记录。
4. `Call` 返回的 error 不能覆盖调用方已有的具名返回值语义（参考 classificationalert 用具名返回值 `result` 的写法）。
5. 不改变 goroutine 的数量、启动顺序和关闭等待（`Close`/`Stop` 里的 WaitGroup）。
6. 日志里不要输出 token、密钥、请求体。

## 测试

- 给 `safego` 写单元测试：`Call` 把 panic 转成 error；`Go` 里的 panic 不会让测试进程崩溃（用 channel 等待 goroutine 结束）。
- 挑一个已有 fake 的 worker 测试（例如 `qualityqueue` 或 `itempipeline` 的 worker 测试），新增一个用例：处理器 panic → 任务按失败路径结束、worker 继续消费下一个任务。如果某个 worker 没有可用的 fake，就不要为了测试新建大量脚手架。

## 交付范围

- 允许修改：`apps/api-go/internal/safego/**`（新增）、所有包含 `go` 语句的 `apps/api-go/internal/**` 与 `apps/api-go/cmd/**` 文件（只改启动点和必要的 defer 清理）。
- 不改：业务逻辑、Redis key、队列协议、对外契约。
- PR 描述附上 A/B/C/D 四类各自的位置清单（文件:函数），以及“未包裹的 D 类及理由”。
