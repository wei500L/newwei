# 执行提示词 · REFACTOR-BULLMQ-PRODUCER-001 · BullMQ Lua 脚本单份 + 统一 Producer

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-BULLMQ-PRODUCER-001.md`。worktree slug：`refactor-bullmq-producer`。

**前置**：REFACTOR-RUNTIME-WIRING-001 已实际合入 main，并且 CI 成功。可以与 REFACTOR-HTTP-ROUTER-001 并行进行。本任务**不**改 worker 消费循环，那是 REFACTOR-BULLMQ-WORKER-001 的范围。

## 问题（规划基线 18c41879858d 已核实）

BullMQ 5.63.2 的 Redis 协议被各个包各自复制了一遍。

**`.lua` 文件**：共 96 个，分布在 14 个目录：

| 目录 | 文件数 |
|---|---|
| `alertqueue/scripts` | 5 |
| `alertworker/queue/scripts` | 13 |
| `analysisqueue` | 6 |
| `archivepreparationworker` | 7 |
| `bullmqcleanup` | 4 |
| `clusteringrecoveryqueue` | 6 |
| `crawlfrontierllm` | 6 |
| `crawlworker` | 8 |
| `economicqueue` | 6 |
| `itempipeline` | 7 |
| `qualityqueue` | 6 |
| `queueops/scripts` | 7 |
| `situationsettings/telegramsched` | 5 |
| `situationsignalsworker` | 10 |

同名脚本的 md5 完全一致：`addStandardJob-9` 有 10 份，`moveToActive-11`、`moveToFinished-14`、`moveStalledJobsToWait-8`、`extendLock-2` 各 9 份，`retryJob-11` 有 8 份。

**Go 字符串常量内联的副本**：

| 文件 | 行数 | 内容 |
|---|---|---|
| `assistantqueue/scripts.go` | 2450 | 包括 `addStandardJobLua`、`moveToActiveLua`、`moveToFinishedLua` 等 |
| `crawlqueue/scripts.go` | 1342 | |
| `pipelineenqueue/scripts.go` | 1129 | |
| `archivepreparation/scripts.go` | 995 | |

**Producer 实现**：大约 15 份，各自编码 msgpack 参数、拼接 KEYS、调用脚本。

- `qualityqueue/producer.go`
- `alertqueue/queue.go`
- `archivepreparation/producer.go`
- `assistantqueue/queue.go`
- `pipelineenqueue/producer.go`、`replay.go`
- `situationsettings/telegramsched/scheduler.go`
- `situationsignalsworker/repeatables.go`、`queue.go`
- `analysisqueue/producer.go`
- `alertworker/queue/producer.go`
- `crawlqueue/producer.go`、`frontier_enqueue.go`
- `economicqueue/producer.go`
- `clusteringrecoveryqueue/producer.go`
- `itempipeline/dlq.go`

`internal/bullmqwire` 目前只有只读的 job 解码和 key 生成（`Keys`、`ReadJob`）。

## 方案

### 1. 新增 `apps/api-go/internal/bullmq`

**`scripts/`**：每个脚本只保留一份 `.lua`，文件名沿用 `<name>-<numKeys>.lua`，附 NOTICE（MIT，来源 BullMQ 5.63.2 dist/cjs/scripts）。

- 用 `//go:embed` 嵌入，给每个脚本导出一个 `*redis.Script`，例如 `bullmq.ScriptAddStandardJob`。
- **入库前必须做一致性校验**：同名脚本的所有 `.lua` 副本和 Go 内联常量，在规范化行尾和首尾空白后，内容必须完全相同。
  - 如果不同，以带有 provenance 头、并且与 BullMQ 5.63.2 发布物一致的那份为准。
  - 仓库里已经没有 node_modules 可供对照，所以按“被更多副本采用 + 有完整 include 展开”来判断。
  - 在 PR 中列出每一处差异和你的选择。
  - 如果差异会影响行为，**停下来在 PR 中说明**，不要自行猜测。

**`Queue`**（producer 端）：`NewQueue(client redis.Cmdable, prefix, name string) *Queue`，内部复用 `bullmqwire.Keys`。提供：

- `Add(ctx, jobName string, data json.RawMessage, opts JobOptions) (jobID string, err error)`：根据 `delay`/`priority` 分发到 standard / delayed / prioritized 三个脚本，与 BullMQ `Queue.add` 的分发规则一致。
- 现有调用点实际用到的其他操作：`UpsertJobScheduler`/`AddRepeatable`、`RemoveRepeatable`、`Remove`、`Pause`/`Resume`、`GetCounts`、`Promote`、`Reprocess`、`CleanJobsInSet`、`GetRanges`、`UpdateData`。只实现有调用方的操作，不要为了完整而实现未使用的。
- `JobOptions` 用具名结构体表达各调用点实际使用的字段：`jobId`、`delay`、`priority`、`attempts`、`backoff{type,delay}`、`removeOnComplete`/`removeOnFail`（bool | number | {age,count}）、`lifo`、`deduplication`、`repeat`……
  - msgpack 编码必须与当前副本**逐字节一致**：字段名相同；“缺省”与“零值”的区分方式相同（例如 `removeOnComplete=false` 和不传，是否都编码）。
  - 先读完全部现有 producer 的编码代码，再设计这个结构体。

**`queueops` / `bullmqcleanup` / `queueorgstats`**：改为使用共享的 scripts 和 Queue 操作。`bullmqwire` 可以并入 `bullmq`（`bullmq.ReadJob` 等），也可以保留为子包，二选一，不要两边都留一份。

### 2. 迁移所有 producer 与脚本调用点

- 删除各包的 `scripts/` 目录、`scripts.go`、内联常量和本地 msgpack 编码函数，改为调用 `bullmq.Queue`。
- **各个 worker 包里 consumer 端用到的脚本**（`moveToActive`/`moveToFinished`/`extendLock`/`retryJob`/`moveToDelayed`/`moveStalledJobsToWait`）也改为引用 `bullmq.Script*`，但 worker 循环逻辑本身不改。这一步只是删除重复的脚本文件，循环逻辑留给下一个任务。

## 等价陷阱

1. **KEYS 顺序与数量**：文件名后缀就是 KEYS 的个数，例如 `addStandardJob-9`。每个脚本的 KEYS 数组顺序必须与现在一致（参考 Lua 注释头里的 `Input: KEYS[1]...`）。
2. `ARGV[1]` 是 msgpack 打包的数组（prefix、customId、name、timestamp、parentKey、parentDepsKey、parent、repeatJobKey、deduplicationKey……），位置不能错。`ARGV[2]` 是 JSON 字符串形式的 data，`ARGV[3]` 是 msgpack 打包的 opts。
3. 时间戳单位是毫秒，来源（`time.Now().UnixMilli()`）保持一致。
4. 自定义 `jobId` 与去重 key 的格式由各业务包决定，例如 `crawlqueue` 的 frontier 去重、`pipelineenqueue` 的 replay 去重。这些格式由调用方传入，共享层不做任何改写。
5. prefix 默认为 `bull`。如果某个队列使用了其他 prefix，或者 key 有特殊的 hash tag，要原样保留。
6. `itempipeline/dlq.go` 是 DLQ 投递，`pipelineenqueue/replay.go` 是重放。确认它们的 opts（例如 `attempts`、`removeOnFail`）与原来一致。
7. 各包现有的 producer 测试是等价性的主要证据。它们通过 fake 捕获脚本参数时，断言保持不变；如果断言写的是包内私有函数名，只调整调用方式，不改期望值。

## 测试

- 在 `bullmq` 中为 `JobOptions` 的 msgpack 编码写表驱动测试，覆盖各调用点实际使用的组合。期望字节以当前副本的编码结果为准：先读原代码推导出字节序列，再写进测试，在测试注释中说明推导依据。
- 加一个测试：所有嵌入脚本都能被加载，并且能从文件名解析出 KEYS 个数。

## 交付范围

允许修改：`internal/bullmq/**`（新增）、`internal/bullmqwire/**`、上面列出的所有队列/producer/worker 包中与**脚本文件和 producer 编码**相关的文件、`internal/queueops/**`、`internal/bullmqcleanup/**`、`internal/queueorgstats/**`、`cmd/api` 中这些构造函数签名变化所需的最小改动。PR 中给出删除的行数统计。
