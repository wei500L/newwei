# LOGIC-TRANSLATION-001 · 单条翻译失败不再丢弃整批（T1）

返回[复审报告](../LOGIC-REVIEW-01-PROCESSING.md) · [LOGIC 纪律](LOGIC-COMMON.md) · [执行提示词](LOGIC-TRANSLATION-001.prompt.md)

## 任务记录

- 状态：`merged`；[#184](https://github.com/wei500L/newwei/pull/184) → merge `0acc2f63750f291050435fe319667e533550d127`（2026-11-10）；分支 head `ca5f58b416ee` 的[普通 CI 42807835911](https://github.com/wei500L/newwei/actions/runs/42807835911) success（verify / api-go-user-settings-integration / vector-integration / globe-vendor 均 success，两个 regen skipped 不算通过）。
- 规划基线：`origin/main = 0f6e62da`；规划时间：2026-11-10。
- 来源：业务逻辑复审 01（处理链路）。行为变更方案已由用户确认（L1 只按文本相似度归并；L2–L5 全部修复）。
- 前置：无（A 波）。
- 分支：`codex/logic-translation`；worktree：`/Users/oo/project/newwei-logic-translation`。
- 验证口径：静态自查 + 回归单测 + 普通 CI 精确 head；本机禁止 go build/test；不部署。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/logic-translation` / [#184](https://github.com/wei500L/newwei/pull/184) / Ready（非 draft，MERGEABLE）。
- 最终 head SHA（代码）：`fe54a243f73c786406539486e558822f733366fc`（本交付记录为后续文档回填提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：[run 42806113800](https://github.com/wei500L/newwei/actions/runs/42806113800)，headSha `fe54a243`，**conclusion=success**；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`contract-baseline-regen` / `go-modules-regen` 为 skipped（skipped 不算通过）。
- 实际范围 / 排除项：`internal/rsstranslation/deeplx.go`（`translateHashes` 按条收集，失败跳过+一条汇总日志，缓存写失败只记日志，仅全部失败返回错误；更新英文注释）、`internal/rsstranslation/service.go`（`translateTextList` 外层缓存写失败降级为日志）、`internal/rsstranslation/cache.go`（新增 `translationCache` 测试接缝接口，生产仍 `*rssCache`）、新增 `internal/rsstranslation/deeplx_test.go`。排除：`itemsreading/translation*.go`（仅运行时配置读取，无批量入口）；跨包同类 `situationsignals/insights_translate.go` 的 `translateHashesToZh`、`dashboardwarmap/translate.go` 的 `ToZH` 未在本任务范围，已在 PR 中列出交后续处理；未改 `apps/web`。
- 有意行为变更（前 → 后、影响数据、是否需历史处理）：① 单条失败不再使整批返回错误——页面上会出现此前因个别条目失败而缺失的成功译文；② 缓存写入失败只记日志、译文照常返回（此前 `deeplx.go` 内层与 `service.go` 外层缓存写失败都会使该条/整批失败）；③ 全部失败仍返回错误、`TranslateBestEffort` 返回空 map（保留“整体不可用”语义）。缓存 key/TTL、存储格式不变，失败条目本就未缓存，后续请求自然重试，无需处理历史数据。
- 改动的原有断言：无（`internal/rsstranslation` 原本没有 `*_test.go`；新增的 5 个回归测试断言编码修复后的正确行为）。
- 剩余问题：未在本机运行 `go build`/`go test`/`go vet`、Docker 或服务，未连接真实 Redis/DeepLX；验证仅静态审查 + 普通 CI 精确 head。跨包同类（situationsignals、dashboardwarmap）按提示词要求留待后续任务。
