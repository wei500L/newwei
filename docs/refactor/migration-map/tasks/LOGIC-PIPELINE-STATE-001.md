# LOGIC-PIPELINE-STATE-001 · 处理链路状态一致性（S1–S5）

返回[复审报告](../LOGIC-REVIEW-01-PROCESSING.md) · [LOGIC 纪律](LOGIC-COMMON.md) · [执行提示词](LOGIC-PIPELINE-STATE-001.prompt.md)

## 任务记录

- 状态：**pr_open**（[#186](https://github.com/wei500L/newwei/pull/186) Ready，见交付记录）。
- 规划基线：`origin/main = 0f6e62da`；规划时间：2026-11-10。
- 来源：业务逻辑复审 01（处理链路）。行为变更方案已由用户确认（L1 只按文本相似度归并；L2–L5 全部修复）。
- 前置：无（A 波）。
- 分支：`codex/logic-pipeline-state`；worktree：`/Users/oo/project/newwei-logic-pipeline-state`。
- 验证口径：静态自查 + 回归单测 + 普通 CI 精确 head；本机禁止 go build/test；不部署。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/logic-pipeline-state` · [#186](https://github.com/wei500L/newwei/pull/186) · Ready（非 draft）。
- 最终 head SHA：实现提交 `07b709b771f3b1a120ee5386ad4d4a4352888c48`（本文件回填为紧随其后的文档提交，分支 head 以 PR 为准）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：[run 42807243672](https://github.com/wei500L/newwei/actions/runs/42807243672) 在 head `07b709b7` 上 `conclusion=success`；`verify` success、`api-go-user-settings-integration` success、`vector-integration` success，两个 regen job skipped（skipped 不算通过）。
- 实际范围 / 排除项：S1 `processeditemoutbox`；S2 `itemsingest`；S3 `itempipeline` + `pipelinerecovery`；S4 `newspipeline`（`dedupe.go/stages.go/persist.go/process.go` 及其测试）；S5 `itempipeline/processor.go`。排除 `newspipeline/clean.go`（归 LOGIC-PIPELINE-COST-001），未做成本优化。
- 有意行为变更（前 → 后、影响数据、是否需历史处理）：
  - S1：死信条目 MySQL `ItemMeta.status` 前 `processing` → 后 `failed`（`duplicate` 不变）；影响 MySQL 状态统计/筛选/重试入口；历史数据不迁移。
  - S2：死信补偿的 ItemMeta/PipelineJob 更新失败前静默 → 后返回错误并带 outboxId 记录日志；对外契约不变。
  - S3：`duplicate` 常量改用 `itemsreading.ItemStatus*`（仍为小写 `duplicate`），存储格式不变。
  - S4：duplicate 标记从「去重阶段 persist 前」移至「persist 事务内、与 outbox 一起提交」；失败/崩溃不再卡 duplicate；无历史处理。
  - S5：旧任务缺失 processedItemId 时由随机 → 由 `(orgId,itemMetaId)` 确定性解析，避免重复 ProcessedItem；对外契约不变。
- 改动的原有断言：
  - `dedupe_test.go`：删除断言「去重阶段发出 duplicate mark SQL」的用例（`TestDedupeEvaluateContentDuplicateMarksItemMeta` 改为 `...ReturnsDuplicateWithoutWriting` 只断言返回结果；删除 `TestDedupeEvaluateContentDuplicateSwallowsMarkFailure`、`TestDedupeRevertDuplicateMarkOnPersistFailure`、`TestDedupeMarkItemMetaDuplicateSwallowsFailure` 及 harness 的 SQL fake）——这些断言的是被删除的缺陷行为。
  - `process_test.go` / `stages_test.go`：把「persist 失败后 revert duplicate mark」断言改为「persist 收到 duplicateOf」——revert 路径已删除。
- 剩余问题：本机未构建/测试，未连接真实 MySQL/Mongo/Redis/服务；S1/S4 的真实事务行为由 CI 的 `api-go-user-settings-integration` 集成测试覆盖，未做部署或实网验收。
