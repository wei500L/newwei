# REFACTOR-CRAWLWORKER-001 · crawlworker 迁到共享 bullmq.Worker

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-CRAWLWORKER-001.prompt.md)

## 任务记录

- 状态：**pr_open**（#178 Ready；代码 head CI success，待规划窗口回填 merged）。
- 规划基线：`origin/main = 67f31754`；规划时间：2026-11-06。
- 来源：第一轮 REFACTOR 交付记录中的“剩余问题”（见总计划“第一轮结果与第二轮候选”）。
- 前置：无（第二轮 A 波）；并行：与 LLM-CLIENT、CLEANUP 并行。
- 分支：`codex/refactor-crawlworker`；worktree：`/Users/oo/project/newwei-refactor-crawlworker`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-crawlworker` / [#178](https://github.com/wei500L/newwei/pull/178) / Ready（OPEN、MERGEABLE，非 draft）。
- 最终 head SHA：代码 head `ad6535abfdccb0205c0770e256676f0942b102f9`（本交付记录为纯文档提交，不改变代码）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：run [42285272784](https://github.com/wei500L/newwei/actions/runs/42285272784)，精确 head `ad6535ab`，`conclusion=success`；`verify`、`globe-vendor`、`api-go-user-settings-integration`、`vector-integration` 均 success；`contract-baseline-regen`、`go-modules-regen` skipped（不计通过）。
- 实际范围 / 排除项：给 `internal/bullmq.Worker` 增加 `SetConcurrency`/`SetLimiter`/`OnStalled`（可调并发、动态 limiter、stalled 回调）；crawlworker 三个队列（crawl4ai-hot/normal/legacy）改用共享 `bullmq.Worker`，删除 `queueRuntime` 的 fetch 循环、moveToActive、锁续期、stalled 定时器、每队列关闭编排（crawlworker 生产代码净减约 451 行）。保留共享严格优先级 limiter、O1 settings 缓存、C2 订阅、`attempt.run` 业务逻辑与 B1 副作用；`attempt.run` 自行迁移后返回 `bullmq.Handled`，stalled 副作用挂 `OnStalled`。未改 `cmd/api` 构造/关闭签名、对外 HTTP/GraphQL/Socket、Redis key、存储与 BullMQ wire 格式。排除项：未迁移其他队列；未新增 `AcquireSlot` 钩子（用 `Handled` 哨兵表达，见 PR 论证）。
- 有意行为变更：无对外契约变更。内部差异：①三个队列的关闭改为并发各自 `Close`（先停拉取→停 stalled→drain→关阻塞连接），全部 drain 后再停 C2 与 `limiter.close()`，净效果等价；②stalled 处理日志不再带队列名前缀；③`moveToFinished` 的 limiter 成员仍由 crawlworker 的 `finishOptions` 携带（fetchNext=0 时 Lua 不使用），共享 Worker 自身 finish 从不参与（处理器总返回 `Handled`）。
- 剩余问题：本机未运行集成测试（无 Redis/MySQL/Mongo），结论以普通 CI 为准；未部署、未连接真实外部服务、未实网验证。迁移测试适配：`TestJobFromFlat*` 改为 `TestClaimedJobFromBullmq*`（改测新适配器）、`TestPackMoveToActiveOptionsCarriesTheLimiter` 改为 `TestPackFinishOptionsCarriesTheLimiter`（`moveToActiveOptions` 已移入共享 Worker 并删除）。
