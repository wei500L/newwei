# LOGIC-CLASSIFIER-001 · 新闻分类打分与兜底修正（L2–L5、L7）

返回[复审报告](../LOGIC-REVIEW-01-PROCESSING.md) · [LOGIC 纪律](LOGIC-COMMON.md) · [执行提示词](LOGIC-CLASSIFIER-001.prompt.md)

## 任务记录

- 状态：`merged`；[#185](https://github.com/wei500L/newwei/pull/185) → merge `d66ed58c804acb99974ad692bed6425a6c9049c5`（2026-11-10）；分支 head `0d6b19bd1dc1` 的[普通 CI 42806380472](https://github.com/wei500L/newwei/actions/runs/42806380472) success（verify / api-go-user-settings-integration / vector-integration / globe-vendor 均 success，两个 regen skipped 不算通过）。
- 规划基线：`origin/main = 0f6e62da`；规划时间：2026-11-10。
- 来源：业务逻辑复审 01（处理链路）。行为变更方案已由用户确认（L1 只按文本相似度归并；L2–L5 全部修复）。
- 前置：无（A 波）。
- 分支：`codex/logic-classifier`；worktree：`/Users/oo/project/newwei-logic-classifier`。
- 验证口径：静态自查 + 回归单测 + 普通 CI 精确 head；本机禁止 go build/test；不部署。

## 交付记录（合并回填）

- 分支 / PR / Ready：`codex/logic-classifier` / [#185](https://github.com/wei500L/newwei/pull/185) / Ready（非 draft）。
- 最终 head SHA：`0d6b19bd1dc151560571531bd69090ac108bd36a`（该分支仅一个代码提交，无追加文档提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：[run 42806380472](https://github.com/wei500L/newwei/actions/runs/42806380472) 在 head `0d6b19bd` 上 `conclusion=success`；`verify` / `api-go-user-settings-integration` / `vector-integration` / `globe-vendor` 均 success，`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：改 `apps/api-go/internal/newsclassifier/{classifier.go,prompt.go,classifier_test.go,rule_keywords.go}`；无新增设置项，未改 `apps/web` / GraphQL；L6（`applySourceCategoryAuthority` 的 `mismatchPenalty`）无界面入口、默认 0，按任务要求**不修改**。
- 有意行为变更（前 → 后、影响数据、是否需历史处理）：L2 无候选时重排从 `taxonomy[:limit]`（声明顺序前 N）改为全部叶子节点（超 512 截断并告警）；L3 重排分从 min-max（第一名恒 1.0）改为上游原始相关度（越界走 sigmoid）并 clamp [0,1]；L4 融合分母从“出现层权重和”改为“成功层权重和”（缺席层计 0、权重仍进分母），embedding 从 `(cos+1)/2` 改为 `clamp01(cos)`；L5 规则兜底补中文关键词（子串匹配、忽略单字）且 path 必须在当前组织分类树存在，否则 no-match；L7 查询文本去掉 Source/Language，只用 Title/Subtitle/Summary/Topics/KeyPoints。影响分类结果与置信度（`category_path`/`category`/`confidence`）；建议对近 7 天数据离线重跑对比分布，无需数据迁移。
- 改动的原有断言：`TestClassifyFusesThreeLayers` 的 `Confidence` 0.95→0.93、候选 `b.Score` 0.3→0.02；`TestRerankNormalizationEqualScores`→`TestRerankPreservesUpstreamScoreWhenEqual`（1/1→0.42/0.42）；`TestRerankNormalizationMinMax`→`TestRerankUsesAbsoluteUpstreamScores`（1/0→0.8/0.2）；`TestClassifyLowConfidenceFallsBackToRule` 与 `TestClassifyEmptyWeightedFallsBackToRule` 仅补 taxonomy 使 L5 兜底 path 存在，断言不变。以上均为固化了旧缺陷行为的断言。
- 剩余问题：本机未运行 `go build/test/vet`、Docker 或服务，未连接真实 LLM/向量服务；验证仅静态审查 + 普通 CI 精确 head，未部署、未实网验收。
