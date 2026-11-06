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

### 交付记录（-a · HTTP 样板）
- 分支 / PR / Ready：`codex/refactor-cleanup-a` / [#175](https://github.com/wei500L/newwei/pull/175) / Ready（非 draft）
- 代码 head SHA：`3ad1a56859bb40e50310d339b5a4f00d56580e5c`（本交付记录为后续文档提交）
- 普通 CI（`gh run view --json conclusion,headSha,jobs`）：[run 42284231682](https://github.com/wei500L/newwei/actions/runs/42284231682)，head `3ad1a56859`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：readJSON 14 份 → 9 份改调 `httpx.ReadJSON`（crawlfrontierruns/crawlprofile/crawlstrategyruns/crawltemplate/crawlworkflow/newssources/rbacapi/crawlmetadata/exceptioningest），5 份保留独特语义（crawltaskwrite/queueops/newsbehavior/oidclogin/situationsignals）；`httpx.ReadJSON` 新增 `ErrEmptyBody`/`ErrReadBody` 分类并更新测试；`situationsettings` 两处一行转发 wrapper 内联；`writeError` 无字节级相同副本可合并（记录差异）；`toInt64/asFloat/asBool`/时间格式化未收敛（4 种 toInt64 变体，唯一相同组跨被排除的 crawlworker/crawlfrontierllm，按“只收敛完全相同副本/不大面积改”记录为剩余）。
- 有意行为变更：仅 `httpx.ReadJSON` 细分类错误（无生产调用方）；各 readJSON 调用点的 400/413(实为 500)/message/Content-Type/body 字节不变。
- 剩余问题：见 PR #175“未验证项/剩余”。
