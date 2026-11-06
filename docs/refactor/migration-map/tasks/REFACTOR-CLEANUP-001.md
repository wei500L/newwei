# REFACTOR-CLEANUP-001 · HTTP 样板、剩余锁副本与迁移期注释收尾

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-CLEANUP-001.prompt.md)

## 任务记录

- 状态：**pr_open**（-a #175 / -b #177 / -c #179 三个 Ready PR；静待合入）。
- 规划基线：`origin/main = 67f31754`；规划时间：2026-11-06。
- 来源：第一轮 REFACTOR 交付记录中的“剩余问题”（见总计划“第一轮结果与第二轮候选”）。
- 前置：无（第二轮 A 波）；并行：与 LLM-CLIENT、CRAWLWORKER 并行。
- 分支：`codex/refactor-cleanup`；worktree：`/Users/oo/project/newwei-refactor-cleanup`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：
- 最终 head SHA：
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：
- 实际范围 / 排除项：
- 有意行为变更：
- 剩余问题：

### 交付记录（-b · 剩余锁副本）
- 分支 / PR / Ready：`codex/refactor-cleanup-b` / [#177](https://github.com/wei500L/newwei/pull/177) / Ready（非 draft）
- 代码 head SHA：`e1497375373b16bc13c44ef4dd8b518ea6b3371c`（本交付记录为后续文档提交）
- 普通 CI（`gh run view --json conclusion,headSha,jobs`）：[run 42285171087](https://github.com/wei500L/newwei/actions/runs/42285171087)，head `e149737537`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，两个 regen skipped（不算通过）。
- 实际范围：`mysqllock` 新增 `WithConnLock` 并与 `WithLock` 共用 acquire/release-discard；contentsubscriptions/situationmonitors/newsindicator 三处 `fn(ctx,*sql.Conn)` GET_LOCK 改调 `WithConnLock`，删除本地 releaseLock；newsnowhottest/crawlreadtelemetry/qualityoverview/classificationrssops 四处缓存重建租约改调 `cronlock`（Acquire+RenewBestEffort+Release），删除本地脚本/续期；分类锁 `setIfAbsent` 与 newsnowhottest 的 activeOrgLock 未动。锁名/TTL/key 不变。
- 有意行为变更：修复三处 releaseLock 忽略 RELEASE_LOCK 失败导致的持锁连接回流（改为 discard 逐出）；续期间隔统一为 cronlock `max(500ms, ttl/3)`；newsnowhottest 锁 token 由 UUID 变 hex（GET==token 比较，无影响）。
- 剩余问题：见 PR #177“未验证项/剩余”。
