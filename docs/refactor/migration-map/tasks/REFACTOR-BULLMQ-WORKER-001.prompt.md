# 执行提示词 · REFACTOR-BULLMQ-WORKER-001 · 统一 BullMQ Worker 循环

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-BULLMQ-WORKER-001.md`。worktree slug：`refactor-bullmq-worker`。

**前置**：以下两个任务都已实际合入 main，并且 CI 成功：

- REFACTOR-BULLMQ-PRODUCER-001：已有 `internal/bullmq` 包与单份脚本；
- REFACTOR-SAFE-GOROUTINE-001：处理器 panic 时任务会按失败处理。

## 问题（规划基线 18c41879858d 已核实）

BullMQ 消费循环有 11 份手写实现，每份 480–850 行：

- `qualityqueue/worker.go`
- `archivepreparationworker/worker.go`
- `assistantqueue/worker.go`
- `crawlworker/worker.go` + `queue.go`/`retry.go`/`limiter.go`
- `situationsignalsworker/queue.go`（1385 行）
- `analysisqueue/worker.go`
- `alertworker/queue/worker.go`
- `economicqueue/worker.go`
- `crawlfrontierllm/worker.go`
- `clusteringrecoveryqueue/worker.go`
- `itempipeline/worker.go`

每份都包含同样的部分：标记等待（BZPOPMIN marker）、`moveToActive`、按锁时长续期、完成/失败、退避重试、`moveToDelayed`、stalled 检查、暂停感知、优雅关闭。

**已观察到的语义漂移**：在 `itempipeline` 等 10 个包里，锁续期失败（锁丢失）时会通过 `CancelCause` 取消正在处理的任务。`qualityqueue` 没有这个逻辑：锁丢失后它会继续处理，并且仍然尝试 `moveToFinished`。这时任务可能已经被 stalled 检查转移给了另一个 worker，于是同一个任务会被执行两次。

另外，`economicqueue` 刚在 PR #161 修复了暂停、stalled 恢复和 repeat 守卫的问题，统一后的实现**必须**包含这些修复。先读 #161 的 diff：`gh pr diff 161`。

## 方案

### 1. 在 `internal/bullmq` 中新增 `Worker`

以 BullMQ 5.63.2 `Worker` 的行为为参照，实现目前各副本的并集中**正确**的那部分：

```go
type Processor func(ctx context.Context, job *Job) (json.RawMessage, error)

type WorkerOptions struct {
    Concurrency      int
    LockDuration     time.Duration
    StalledInterval  time.Duration
    MaxStalledCount  int
    DrainDelay       time.Duration
    Limiter          *Limiter // {Max, Duration}，nil 表示不限速
    RemoveOnComplete KeepJobs
    RemoveOnFail     KeepJobs
    Name             string   // 有界，用于日志和 safego
}
```

- 错误分类：
  - `bullmq.Unrecoverable(err)`：直接判为失败，不重试；
  - `bullmq.RetryAfter(err, delay)`：走 `moveToDelayed`；
  - 其他错误：按任务自己的 `attempts`/`backoff` 重试，次数用完后失败。
- 必须具备的行为：
  - 锁续期周期为 `LockDuration/2`；续期失败或返回 0 时，用 `context.WithCancelCause` 取消 processor 的 ctx，并且**不再**对该任务调用 finish；
  - processor 外层用 `safego.Call`，panic 按普通失败处理；
  - 关闭时停止拉取新任务，等待正在处理的任务结束或 ctx 到期，再停止 stalled 检查；
  - 队列暂停时不拉取任务；
  - 实现 #161 中的 stalled/repeat 修复。
- token 格式、`failedReason`/`stacktrace`/`returnvalue`/`finishedOn`/`processedOn` 的写法，沿用现有多数副本（应与 BullMQ 一致）。

### 2. 逐个迁移 11 个包

- 每个包只保留：自己的 Processor（业务处理）、队列名、`WorkerOptions` 取值、业务错误到 `Unrecoverable`/`RetryAfter` 的映射。删除包内的循环、续期、finish、retry、stalled 代码以及对应的 protocol 文件。
- `crawlworker` 的 limiter 逻辑较复杂（88 处），`assistantqueue` 有大量 paused 判断（125 处）。如果它们的需求超出了上面的通用选项，先确认是不是业务语义：
  - 如果是业务语义，就留在包内，在 Processor 之前或之后处理；
  - 如果只是同一协议的不同写法，就统一掉。
  - 两种情况都记入差异表。
- 工作量太大时，可以拆成两个 PR，同一任务 ID 加后缀 `-a`/`-b`：
  - 第一个 PR：Worker 核心，并迁移 `qualityqueue`、`clusteringrecoveryqueue`、`analysisqueue`、`economicqueue`、`itempipeline`；
  - 第二个 PR：迁移其余 6 个包。
  - 第二个 PR 要等第一个合入后再开。

## 有意行为变更

`qualityqueue` 获得锁丢失取消。如果还有其他副本缺少某项正确行为，它们也会随统一而获得。全部逐条列在 PR 中，作为缺陷修复。

## 等价陷阱

1. 每个队列原来的 `concurrency`/`lockDuration`/`stalledInterval`/`maxStalledCount`/`limiter`/`drainDelay`/`removeOnComplete`/`removeOnFail` 取值，必须原样搬进 `WorkerOptions`。逐队列列出“迁移前 → 迁移后”表格。
2. `attemptsMade` 的递增时机，以及 `backoff` 的计算（fixed / exponential：`delay * 2^(attemptsMade-1)`），与现有副本保持一致。
3. `returnvalue` 是 JSON 字符串。processor 返回 nil 时，原来写的是 `null` 还是空串，按现有副本保留。
4. 部分 worker 在 finish 之后还有副作用，例如写 TaskLog、发事件、`queueorgstats` 计数。确认这些副作用仍然按原来的顺序执行，并且只在成功 finish 后执行。
5. 锁丢失后既不能 finish，也不能执行这些副作用。
6. stalled 检查使用的是 `moveStalledJobsToWait`，它的 KEYS 和 ARGV 已经在 `bullmq` 中统一；超过 `maxStalledCount` 的任务会被判为失败。
7. 关闭顺序：`cmd/api` 里 worker 的 `Close` 必须在 Redis 客户端关闭之前完成。阻塞客户端（`redis.NewClient(opts)` 专用连接，例如 `cmd/api/item_pipeline_worker.go:234`）由 Worker 自己创建并关闭，还是由调用方传入，选择一种并保持一致。

## 测试

- `bullmq.Worker` 的单元测试使用现有 worker 测试中的 fake 或脚本替身，覆盖：成功、可重试失败、不可恢复失败、`RetryAfter`、panic、锁丢失取消、暂停、关闭时等待在途任务。
- 各业务包保留 Processor 级别的测试，断言不变；只测循环机制的测试迁到 `bullmq`。

## 交付范围

允许修改：`internal/bullmq/**`、上面 11 个包、`cmd/api` 中 worker 构造与关闭相关的代码。PR 附上删除行数统计和逐队列配置表。
