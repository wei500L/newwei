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

### 交付记录（-c · 迁移期注释）
- 分支 / PR / Ready：`codex/refactor-cleanup-c` / [#179](https://github.com/wei500L/newwei/pull/179) / Ready（非 draft）
- 代码 head SHA：`68e7db3c3ade5768a37ba3795b6dd94f1d35d00f`（本交付记录为后续文档提交）
- 普通 CI（`gh run view --json conclusion,headSha,jobs`）：[run 42286075778](https://github.com/wei500L/newwei/actions/runs/42286075778)，head `68e7db3c3a`；`verify` / `vector-integration` / `globe-vendor` success；`api-go-user-settings-integration` 在交付时仍在 `[self-hosted, linux, build-server]` 排队未完成（不称通过，交付后应跑绿）；两个 regen skipped。本 PR 纯注释，diff 无非注释行。
- 实际范围：`internal/httproute/*_routes.go`（46 文件）文档注释重写为“规则 always-on、未命中→unmatched-route 404（Nest 形状）、不代理”；`cmd/api/*.go`（14 文件）最高频两段模板改当前事实。grep（`legacy|nestjs|shadow`，排除 _test）：前 280（httproute 120 / cmd/api 160）→ 后 138（httproute 6 / cmd/api 132）。
- 有意行为变更：无（纯注释）。
- 剩余问题：cmd/api 仍有约 132 处 `legacy/nest`，多为“与 NestJS 行为对齐”的事实性参照，需逐单元判断；未做机械全文替换，见 PR #179。
