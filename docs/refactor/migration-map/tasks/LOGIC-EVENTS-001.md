# LOGIC-EVENTS-001 · 事件归并只按文本相似度（L1）

返回[复审报告](../LOGIC-REVIEW-01-PROCESSING.md) · [LOGIC 纪律](LOGIC-COMMON.md) · [执行提示词](LOGIC-EVENTS-001.prompt.md)

## 任务记录

- 状态：`merged`；[#187](https://github.com/wei500L/newwei/pull/187) → merge `aabe588c659bc0a7e38c222cb095871719e6b356`（2026-11-10）；分支 head `278386265126` 的[普通 CI 42810696140](https://github.com/wei500L/newwei/actions/runs/42810696140) success（verify / api-go-user-settings-integration / vector-integration / globe-vendor 均 success，两个 regen skipped 不算通过）。
- 规划基线：`origin/main = 0f6e62da`；规划时间：2026-11-10。
- 来源：业务逻辑复审 01（处理链路）。行为变更方案已由用户确认（L1 只按文本相似度归并；L2–L5 全部修复）。
- 前置：无（A 波）。
- 分支：`codex/logic-events`；worktree：`/Users/oo/project/newwei-logic-events`。
- 验证口径：静态自查 + 回归单测 + 普通 CI 精确 head；本机禁止 go build/test；不部署。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/logic-events` / [#187](https://github.com/wei500L/newwei/pull/187) / Ready（非 draft）。
- 最终 head SHA：`01ebe6d60d224df0ebc67ae9e0d520c4436efd09`（代码 head；本条交付记录为随后追加的文档提交，不改代码）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：[run 42807438282](https://github.com/wei500L/newwei/actions/runs/42807438282) — `conclusion=success`，精确 head `01ebe6d6`；`verify` / `api-go-user-settings-integration` / `vector-integration` 均 success，`globe-vendor` success；`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：改 `internal/newseventsingest/{assign.go,settings.go,assign_test.go,integration_test.go}`；设置读取/写入与 GraphQL：`internal/graphqlread/settingscrawl/{models_settings.go,settings.go}`、`internal/graphqlread/settingswrite/{input.go,documents.go,orgsettings.go}`、`internal/graphqlread/schema/schema.gql`；Web：`apps/web/components/settings/news-events-settings-panel.tsx`、`apps/web/graphql/generated.ts`、`apps/web/lib/locales/{zh,en}.json`。**排除** `newsnowclusteringops` 的独立重复 overlap 实现（不在复审范围、不在本任务允许修改清单）。
- 有意行为变更（前 → 后、影响数据、是否需历史处理）：向量可判定且最高分 < `VectorMinScore` → **新建事件**（此前回落 overlap 并归入同 topic/entity 事件）；overlap 兜底仅在向量无法判定（无 embedding / 未配置 / 服务不可用）时生效，且要求 topic 与 entity **同时命中**、候选事件 `lastAt` 在 72 小时内（此前单命中即 0.5 分、无时间约束）。新增设置 `overlapFallbackMaxGapHours`（默认 72，范围 1–720）。仅影响新进入文章的事件归并结果（`NewsEventItem`/`NewsEvent`）；不自动拆分历史巨型事件；无需数据迁移（缺省回落 72h）。对外 HTTP/GraphQL 响应体、Redis key、Mongo/MySQL 结构、`assignedBy` 取值集合不变。
- 改动的原有断言：`integration_test.go::TestIngestionDefaultModeAssignsThroughAllPaths` 原“同 topic（无 entity）→ 归入，similarity 0.5”改为“同 topic+entity → 归入，similarity 1.0”，并改用带 primaryEntity 的事件数据；`assign_test.go::TestScoreOverlapCandidatesMatchesJSOrdering` 替换为 `TestScoreOverlapCandidatesRequiresTopicAndEntityWithinGap`（单命中原 0.5 现排除，新增 72h 与大小写断言）。
- 剩余问题：`newsnowclusteringops`（`clusteringfailure.assignSignalToEvent`、`llm_backfill_candidates.collectOverlapCandidates`+`scoreCandidate`）存在第 N+1 份独立的 overlap 实现，仍按 topic/entity 字面合并且无阈值/72h，本次未收敛（复审将 newsnowclusteringops 留待下一段）；建议后续任务统一。已有巨型事件不在本任务内自动拆分。
