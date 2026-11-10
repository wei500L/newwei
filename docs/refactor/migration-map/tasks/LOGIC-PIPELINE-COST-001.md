# LOGIC-PIPELINE-COST-001 · 重试复用 LLM 产物与在途重复（D1、D2）

返回[复审报告](../LOGIC-REVIEW-01-PROCESSING.md) · [LOGIC 纪律](LOGIC-COMMON.md) · [执行提示词](LOGIC-PIPELINE-COST-001.prompt.md)

## 任务记录

- 状态：**pr_open**（[#188](https://github.com/wei500L/newwei/pull/188)，Ready）。
- 规划基线：`origin/main = 0f6e62da`；规划时间：2026-11-10。开工时 main = `5a0819e6`。
- 来源：业务逻辑复审 01（处理链路）。行为变更方案已由用户确认（L1 只按文本相似度归并；L2–L5 全部修复）。
- 前置：LOGIC-PIPELINE-STATE-001 合入且 CI 成功（B 波）。已核对 [#186](https://github.com/wei500L/newwei/pull/186) merged（`543533cf`），head `1bb90bebd80e` 普通 CI [42810656809](https://github.com/wei500L/newwei/actions/runs/42810656809) success。
- 分支：`codex/logic-pipeline-cost`；worktree：`/Users/oo/project/newwei-logic-pipeline-cost`。
- 验证口径：静态自查 + 回归单测 + 普通 CI 精确 head；本机禁止 go build/test；不部署。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/logic-pipeline-cost` · [#188](https://github.com/wei500L/newwei/pull/188) · Ready（非 draft）。
- 最终 head SHA：审查修复提交 `822c19aef7fbb62d3778ac31806a50d7e58a13bb`（含 `5b624784` 审查修复与 `822c19ae` 无 Redis 跳过缓存的收尾；本记录为紧随其后的文档提交，分支最终 head 以 PR 为准）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：审查修复 head `822c19ae` [run 42878722748](https://github.com/wei500L/newwei/actions/runs/42878722748) `conclusion=success`；`verify`（含 Lint/Typecheck/Go tests/Build）、`api-go-user-settings-integration`、`vector-integration`、`globe-vendor` success，`contract-baseline-regen`/`go-modules-regen` skipped（skipped 不算通过）。首轮实现 head `daa9eb64` [run 42844152563](https://github.com/wei500L/newwei/actions/runs/42844152563) 同样 success。
- 审查修复（第二轮，已在同一 PR 追加提交）：
  - D1：在途登记去掉「规范化标题」key，只按 `contentHash` 登记（固定栏目标题会误判不同文章）。
  - D1：`itempipeline.HandleFailure` 在最终失败（进死信）时删除该 item 自己的在途登记，用 Lua 比较 value 中 `itemMetaId` 后删除（保证只删自己、且不会误删他人重注册的键）；补测「登记者最终失败后同内容新条目不再判重」「只删自己 key」「仅最终失败才释放」。
  - D2：阶段缓存 key 加入实际 `provider` 与设置解析出的 `completion` 模型（新增 `litellmcompat.RuntimeCompletionModel`，读网关设置而非环境变量全局模型）；补测「换模型后不命中旧缓存」。
- 实际范围 / 排除项：D2 阶段产物 Redis 缓存（`clean.go`、`stagecache.go`）与 D1 在途去重（`dedupe.go`、`inflight.go`）；`contract.go` 新增配置/字段、`config.go` 默认值、`process.go` 接线、`stages.go` 阶段缓存与 provider 标注、`itempipeline/processor.go` 最终失败释放、`litellmcompat/settings.go` 新增 `RuntimeCompletionModel`，测试同步。`cmd/api` 无需改动（`Options.Redis` 已注入）。排除：语义近似（非完全一致）在途去重；`apps/web`、GraphQL 设置模型（本任务为环境变量 RuntimeConfig，非 org 设置项）。
- 有意行为变更（前 → 后、影响数据、是否需历史处理）：
  - D2（成本）：修复前后续阶段失败重试会重调 clean/entities/sentiment/kg 全部 LLM；修复后命中 Redis 阶段缓存复用成功产物，`stage_meta` 该阶段 `provider=stage_cache` 且保留 model/token；key 含 provider 与设置解析模型，改模型/provider 即失配。对外字段/状态码不变，仅 `stage_meta.provider` 新增取值；历史数据不回填、无需处理。
  - D1（去重结果）：修复前并发同源同内容条目互相看不见、都被保留；修复后后到者 `similarity=1`、`DuplicateOf` 指向登记者 `processedItemId`，由 persist 事务标 `duplicate`。并发/同内容场景 `ItemMeta` 会更多被标 duplicate；历史数据不回溯、无需处理。登记者最终失败时释放自身在途登记，避免后续同内容条目被指向未落库的 id。
- 改动的原有断言：无（仅新增回归用例，未修改既有断言）。
- 剩余问题：语义近似（非完全一致 contentHash）的在途重复仍未覆盖（本轮按要求只保留 contentHash 精确匹配）；`RuntimeCompletionModel` 取网关设置模型，若模型解析失败该次跳过缓存（从未命中处理，不影响流水线）；legacy 路径无 `stage_meta`，clean 缓存生效但无 `stage_cache` 标注；在途键成功路径保留至 TTL（10 分钟），仅最终失败释放。本机未构建/测试、未连真实服务，仅普通 CI 精确 head 为运行证据。
