# REFACTOR-BULLMQ-PRODUCER-001 · BullMQ Lua 脚本单份 + 统一 Producer

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-BULLMQ-PRODUCER-001.prompt.md)

## 任务记录

- 状态：**pr_open**（Ready PR #170，待规划窗口合并）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-RUNTIME-WIRING-001 合入且 CI 成功；可与 HTTP-ROUTER 并行。
- 分支：`codex/refactor-bullmq-producer`；worktree：`/Users/oo/project/newwei-refactor-bullmq-producer`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-bullmq-producer` / [#170](https://github.com/wei500L/newwei/pull/170) / Ready（非 draft，mergeable）。
- 最终 head SHA（代码）：`8dc9a311de444476336acb94a0cb5f3374ac33d2`（本交付记录为后续文档回填提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：[run 41923549858](https://github.com/wei500L/newwei/actions/runs/41923549858)，headSha `8dc9a311`，**conclusion=success**；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`contract-baseline-regen` / `go-modules-regen` 为 skipped（skipped 不算通过）。
- 实际范围 / 排除项：新增 `internal/bullmq`（25 份唯一 Lua + NOTICE + go:embed 的 `Script*`、合并 `bullmqwire` 的 `Keys`/`ReadJob`、`JobOptions`、`Queue.Add`、`options_test.go`/`scripts_test.go`）；删除 14 个 `scripts/` 目录（96 个 `.lua`）与 `archivepreparation`/`crawlqueue`/`pipelineenqueue` 的 `scripts.go` 及 4 份内联常量；worker 包 `scripts.go` 收敛为引用 `bullmq.Script*` 的薄结构体（循环逻辑未改）；producer 全部改走 `bullmq.Queue.Add`；`queueops`/`bullmqcleanup`/`queueorgstats` 改引用共享脚本/`bullmq`。排除：worker 消费循环（REFACTOR-BULLMQ-WORKER-001）、`queueorgstats` 的 3 个非 BullMQ 自定义计数脚本、`apps/web`。规模 `191 files changed, 7161 insertions(+), 35458 deletions(-)`（net −2.8 万行）。
- 有意行为变更：无（HTTP/GraphQL/Socket、Redis key、存储格式、BullMQ wire 不变）。
- 剩余问题：未在本机连接真实 Redis/MySQL/Mongo；`go test ./...` 中 `alertworker`(webhook DNS)/`crawl4ai`/`crawlexecution` 三个网络相关既有用例在沙箱失败，与本次无关，以普通 CI 为准；未部署、未实网验收。`itempipeline` 的 `moveToDelayed-9.lua` 实数 8 KEYS，已按实际 `moveToDelayed-8.lua` 归并。
