# REFACTOR-HTTP-CLIENT-001 · 出站 http.Client 与共享 Transport 收敛

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-HTTP-CLIENT-001.prompt.md)

## 任务记录

- 状态：**planned**（提示词已写好，尚未发出或认领）。
- 规划基线：`origin/main = 67f31754`；规划时间：2026-11-06。
- 来源：第一轮 REFACTOR 交付记录中的“剩余问题”（见总计划“第一轮结果与第二轮候选”）。
- 前置：REFACTOR-LLM-CLIENT-001 的 `-a`（#176，已合）、`-a2`、`-b` 三段全部合入且 CI 成功（第二轮 B 波）。2026-11-07 首次派发时执行窗口核对前置未满足、正确停止，未开工；并行：—。
- 分支：`codex/refactor-http-client`；worktree：`/Users/oo/project/newwei-refactor-http-client`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：
- 最终 head SHA：
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：
- 实际范围 / 排除项：
- 有意行为变更：
- 剩余问题：
