# REFACTOR-LOCKS-001 · Redis 租约与 MySQL GET_LOCK 各收敛为一份

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-LOCKS-001.prompt.md)

## 任务记录

- 状态：**planned**（提示词已写好，尚未发出或认领）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-SAFE-GOROUTINE-001 合入且 CI 成功；可与 RUNTIME-WIRING 并行。
- 分支：`codex/refactor-locks`；worktree：`/Users/oo/project/newwei-refactor-locks`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：
- 最终 head SHA：
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：
- 实际范围 / 排除项：
- 有意行为变更：
- 剩余问题：
