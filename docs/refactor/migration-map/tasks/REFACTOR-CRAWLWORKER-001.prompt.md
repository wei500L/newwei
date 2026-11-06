# 执行提示词 · REFACTOR-CRAWLWORKER-001 · crawlworker 迁到共享 bullmq.Worker

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-CRAWLWORKER-001.md`。worktree slug：`refactor-crawlworker`。

**前置**：无。本任务属于第二轮 A 波，可以与 REFACTOR-LLM-CLIENT-001、REFACTOR-CLEANUP-001 并行。只有本任务会修改 `internal/bullmq/**`。

**背景**：REFACTOR-BULLMQ-WORKER-001 把 10 个队列迁到了 `internal/bullmq.Worker`（PR #172、#174），唯独 `crawlworker` 没有迁。原因写在 `tasks/REFACTOR-BULLMQ-WORKER-001.md` 的“交付记录 -b · 排除项”中。先读这段，再读 #172/#174 的 diff，以及 `internal/crawlworker/doc.go` 的完整包注释：它准确描述了 crawlworker 的全部语义。

## 问题（规划基线 main `67f31754` 已核实）

`internal/crawlworker` 约有 2,600 行非测试代码，包括 `worker.go`、`queue.go`、`protocol.go`、`attempt.go`、`limiter.go`、`retry.go`。它仍然手写了以下全部逻辑：`moveToActive`、锁续期、finish、retry、stalled 检查和优雅关闭，与 `bullmq.Worker` 重复。

它和通用 Worker 不一样的地方有这些（详见 `doc.go`）：

1. **动态并发（A1/C2）**：初始值来自 settings 的 `maxConcurrency`，并写入 `bull:<queue>:meta`。C2 广播 `crawl:worker-concurrency:v1` 会在运行时同时修改共享 limiter 容量和每个队列的拉取并发。而 `bullmq.Worker` 的 `slots` 是在构造时创建的固定容量 channel（`worker.go` 约第 268 行）。
2. **跨队列共享的严格优先级 limiter**：3 个队列（hot/normal/legacy）共用一个 limiter，hot 优先。在 claim 之后才获取 slot；拿不到 slot 时，任务留给 stalled 恢复处理。关闭时的拒绝文案是对外可见的 Nest 文案。
3. **手工 BullMQ limiter**：`{max: clamp(round(N)*100,1,10000), duration: 1000}`，跟随并发动态变化。
4. **内存压力处理**：在处理器内部，一条 pipeline 同时给本进程的全部 crawl 队列加限速（`SET bull:<queue>:limiter ... PX cooldown`），重写 job data（保持原 key 顺序，`memoryPressureRequeues+1`），再执行 `moveJobFromActiveToWait`（不消耗 attempt）。
5. **处理器内自行迁移状态**：`attempt.run` 直接执行 MoveToCompleted/MoveToFailed/Retry/RetryLater/MoveToWait/UpdateData，然后执行 B1 副作用。
6. **stalled 业务副作用**：`moveStalledJobsToWait` 返回的每个 job id，包括超过 `maxStalledCount` 的那些，都要执行 CrawlTask `running → queued`，并刷新 ops snapshot。

## 方案

### 1. 给 `bullmq.Worker` 补通用能力

只补“属于 BullMQ Worker 本身”的能力，业务逻辑不放进 bullmq。

- **可调并发**：增加 `SetConcurrency(n int)`。BullMQ 5.x 的 `worker.concurrency` setter 也可以在运行时调整。实现上不要依赖固定容量的 channel：
  - 调小时，不中断在途任务，只是不再拉新任务，直到在途数降到 n 以下；
  - 调大时，立即生效。
  - 其余 10 个队列不调用它，行为不变。
- **stalled 回调**：增加 `OnStalled func(ctx, jobIDs []string)`。在 `moveStalledJobsToWait` 返回之后调用，参数包括被判为失败的那部分 job id。核对 BullMQ 5.63.2 的 `stalled` 事件语义，以及 crawlworker 现有的处理范围。
- **动态 limiter**：如果 `WorkerOptions.Limiter` 需要在运行时修改，就提供 `SetLimiter`。只在 crawlworker 使用。
- **slot 获取钩子**：例如 `AcquireSlot func(ctx, job) (release func(), err error)`，在 claim 之后、处理器之前调用。失败时 Worker **不**执行 finish，任务留给 stalled 恢复，与现有语义一致。
  - 如果你判断用 `OnClaim` 加 `Handled` 哨兵就能表达，也可以不新增钩子，但要在 PR 中论证。
- `Handled` 哨兵已经存在：处理器自行完成迁移后返回它，Worker 就不会再次确认。crawlworker 的 `attempt.run` 继续自己做迁移和 B1 副作用，然后返回 `Handled`。这样可以最大程度保持现有语义。

### 2. 迁移 crawlworker

- 每个队列一个 `bullmq.Worker`。crawlworker 只保留以下部分：
  - 共享严格优先级 limiter（`limiter.go`）；
  - settings 缓存与 C2 订阅（订阅到消息后，对 3 个 Worker 调用 `SetConcurrency`/`SetLimiter`）；
  - `attempt.run` 中的业务逻辑：错误分类、内存压力处理、B1 副作用；
  - stalled 副作用（挂到 `OnStalled`）。
- 删除 crawlworker 中的 fetch 循环、`moveToActive`、锁续期、stalled 定时器、关闭编排，以及只服务这些逻辑的 protocol 代码。
- `cmd/api/crawl_worker.go` 中的构造与关闭顺序保持不变。阻塞连接的创建和关闭方式与其他 10 个队列保持一致。
- 顺手把 `doc.go` 改写为当前事实。删除 “when `API_GO_CRAWL_WORKER_MODE=go`”、“NestJS skips”、“mixed rollout” 等已经失效的迁移期叙述，但保留语义描述（A1/A2/A3/B1/O1/O3 的规则）。

## 等价陷阱

1. 现在“拿不到 slot”时，任务留在 active，等锁过期后由 stalled 恢复。迁移后不能变成立即 finish 或重排。
2. hot 优先：normal 队列获取 slot 时，只要有 hot 在排队就要让路。关闭时的两条拒绝文案（`... is shutting down` / `... is closed`）逐字不变。
3. 内存压力路径不消耗 attempt，`ats` 继续增长，这样预算才会终止；job data 重写时保持原 key 顺序（`jsonorder.go`）。
4. B1 副作用只在迁移成功后执行，并且只执行一次。锁丢失（ctx 被 cancel）时既不迁移，也不执行副作用。
5. stalled 副作用覆盖的范围，包括被打上 deferred failure 的 job，保持与现有实现一致。
6. C2 收到畸形消息时只警告、忽略，settings 和 meta 仍然是权威来源。并发调小时，在途任务不受影响。
7. 关闭顺序：先停拉取，等待在途任务（期间锁继续续期），再停 stalled 和 C2 订阅，最后关闭阻塞连接。共享的命令 Redis 客户端不关闭。到期仍在运行的任务被 cancel，留在 active。
8. 其余 10 个队列：`bullmq.Worker` 的新增能力都是可选的，不设置时行为逐字节不变。`bullmq/worker_test.go` 现有断言不改。

## 测试

- `bullmq`：
  - `SetConcurrency` 调大或调小时，在途任务和拉取的行为；
  - `OnStalled` 的调用参数；
  - slot 获取失败时不执行 finish；
  - 以上使用现有 worker 测试的 fake 或脚本替身。
- `crawlworker`：保留 limiter、错误分类、内存压力、B1 副作用和 settings/C2 的现有测试，断言不变。只测循环机制的测试，迁到 `bullmq` 或删除，并在 PR 中列出。
- 现有的 `//go:build integration` 用例由 CI 运行。

## 交付范围

允许修改：`internal/bullmq/**`、`internal/crawlworker/**`、`cmd/api/crawl_worker*.go`。

PR 需要附上：

- 删除行数统计；
- “crawlworker 原语义 → 迁移后承载位置”对照表，逐条对应 `doc.go` 中的 A1/A2/A3/B1/O1/O3、stalled 和 shutdown；
- `bullmq.Worker` 新增 API 清单，并说明为什么其余 10 个队列的行为不变。
