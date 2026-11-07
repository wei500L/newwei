# REFACTOR-CLEANUP-001 · HTTP 样板、剩余锁副本与迁移期注释收尾

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-CLEANUP-001.prompt.md)

## 任务记录

- 状态：**merged**（-a #175 / -b #177 / -c #179，经整合 #180 → `dba96962`；2026-11-07 规划窗口核实，main 普通 CI success）。剩余：5 份独特 readJSON、writeError 无可合并副本、`toInt64` 等未收敛、`cmd/api` 约 132 处事实性 Nest 参照，均不再派发。
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

### 交付记录（-b · 剩余锁副本）
- 分支 / PR / Ready：`codex/refactor-cleanup-b` / [#177](https://github.com/wei500L/newwei/pull/177) / Ready（非 draft）
- 代码 head SHA：`e1497375373b16bc13c44ef4dd8b518ea6b3371c`（本交付记录为后续文档提交）
- 普通 CI（`gh run view --json conclusion,headSha,jobs`）：[run 42285171087](https://github.com/wei500L/newwei/actions/runs/42285171087)，head `e149737537`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，两个 regen skipped（不算通过）。
- 实际范围：`mysqllock` 新增 `WithConnLock` 并与 `WithLock` 共用 acquire/release-discard；contentsubscriptions/situationmonitors/newsindicator 三处 `fn(ctx,*sql.Conn)` GET_LOCK 改调 `WithConnLock`，删除本地 releaseLock；newsnowhottest/crawlreadtelemetry/qualityoverview/classificationrssops 四处缓存重建租约改调 `cronlock`（Acquire+RenewBestEffort+Release），删除本地脚本/续期；分类锁 `setIfAbsent` 与 newsnowhottest 的 activeOrgLock 未动。锁名/TTL/key 不变。
- 有意行为变更：修复三处 releaseLock 忽略 RELEASE_LOCK 失败导致的持锁连接回流（改为 discard 逐出）；续期间隔统一为 cronlock `max(500ms, ttl/3)`；newsnowhottest 锁 token 由 UUID 变 hex（GET==token 比较，无影响）。
- 剩余问题：见 PR #177“未验证项/剩余”。

### 交付记录（-c · 迁移期注释）
- 分支 / PR / Ready：`codex/refactor-cleanup-c` / [#179](https://github.com/wei500L/newwei/pull/179) / Ready（非 draft）
- 代码 head SHA：`68e7db3c3ade5768a37ba3795b6dd94f1d35d00f`（本交付记录为后续文档提交）
- 普通 CI（`gh run view --json conclusion,headSha,jobs`）：[run 42286075778](https://github.com/wei500L/newwei/actions/runs/42286075778)，head `68e7db3c3a`；`verify` / `vector-integration` / `globe-vendor` success；`api-go-user-settings-integration` 在交付时仍在 `[self-hosted, linux, build-server]` 排队未完成（不称通过，交付后应跑绿）；两个 regen skipped。本 PR 纯注释，diff 无非注释行。
- 实际范围：`internal/httproute/*_routes.go`（46 文件）文档注释重写为“规则 always-on、未命中→unmatched-route 404（Nest 形状）、不代理”；`cmd/api/*.go`（14 文件）最高频两段模板改当前事实。grep（`legacy|nestjs|shadow`，排除 _test）：前 280（httproute 120 / cmd/api 160）→ 后 138（httproute 6 / cmd/api 132）。
- 有意行为变更：无（纯注释）。
- 剩余问题：cmd/api 仍有约 132 处 `legacy/nest`，多为“与 NestJS 行为对齐”的事实性参照，需逐单元判断；未做机械全文替换，见 PR #179。
