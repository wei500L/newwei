# REFACTOR-BULLMQ-WORKER-001 · 统一 BullMQ Worker 循环

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-BULLMQ-WORKER-001.prompt.md)

## 任务记录

- 状态：**planned**（提示词已写好，尚未发出或认领）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-BULLMQ-PRODUCER-001 与 REFACTOR-SAFE-GOROUTINE-001 合入且 CI 成功。
- 分支：`codex/refactor-bullmq-worker`；worktree：`/Users/oo/project/newwei-refactor-bullmq-worker`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-bullmq-worker` / [#172](https://github.com/wei500L/newwei/pull/172) / Ready（OPEN、MERGEABLE）。
- 最终 head SHA：代码 head `85c376f00f31b460d0d73f34e83aeddc9bc8bde6`（本交付记录为纯文档提交，不改变代码）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：run [41991575247](https://github.com/wei500L/newwei/actions/runs/41991575247)，精确 head `85c376f0`，`conclusion=success`；`verify`、`api-go-user-settings-integration`、`vector-integration`、`globe-vendor` 均 success；`contract-baseline-regen`、`go-modules-regen` skipped（不计通过）。
- 实际范围 / 排除项：**-a**：新增 `internal/bullmq.Worker`（moveToActive/锁续期/finish/retry/stalled/暂停/优雅关闭/错误分类/OnClaim/OnFailure），迁移 `qualityqueue`、`clusteringrecoveryqueue`、`analysisqueue`、`economicqueue`、`itempipeline`。其余 6 包（crawlworker / situationsignalsworker / alertworker / crawlfrontierllm / archivepreparationworker / assistantqueue）留给 **-b**。未改 `cmd/api` 构造签名、未改对外 HTTP/GraphQL/Socket、Redis key、存储与 BullMQ wire 格式。
- 有意行为变更：①`qualityqueue` 获得锁丢失取消（不再继续处理/不再 finish，修复潜在双重执行）；②`analysisqueue`/`clusteringrecoveryqueue` 对 `defa` 任务继续执行处理器以完成业务终态（保持原语义，不重复副作用由 itempipeline 的跳过策略保证）；③`qualityqueue`/`economicqueue` 拉取前显式暂停预检；④`qualityqueue` delay=0 改用 retryJob（其 backoff=2000ms，实际不触发）。
- 剩余问题：-b 待本 PR 合入后另开；各包 `keys`/`job` 解码保留（与 producer 及业务 Payload 共享），worker 循环/续期/finish/retry/stalled 已删除。本机未运行集成测试（无 Redis/MySQL/Mongo），其结论以普通 CI 为准；未部署、未连接真实外部服务。
