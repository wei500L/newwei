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
- 最终 head SHA：实现提交 `daa9eb6459ebe1a97eeb5b4ffcc503a270dc139d`；交付记录文档提交 `a9648256e190f102e39d375afa5e9ea5d9e34aaa`（本记录为紧随其后的再一个文档提交，分支最终 head 以 PR 为准）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha,jobs`）：实现 head `daa9eb64` [run 42844152563](https://github.com/wei500L/newwei/actions/runs/42844152563) `conclusion=success`；交付记录 head `a9648256` [run 42847030410](https://github.com/wei500L/newwei/actions/runs/42847030410) `conclusion=success`。两次均为 `verify`（含 Lint/Typecheck/Go tests/Build）、`api-go-user-settings-integration`、`vector-integration`、`globe-vendor` success，`contract-baseline-regen`/`go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：D2 阶段产物 Redis 缓存（`clean.go`、新增 `stagecache.go`）与 D1 在途去重（`dedupe.go`、新增 `inflight.go`）；`contract.go` 新增配置/字段、`config.go` 默认值、`process.go` 接线、`stages.go` 阶段缓存与 provider 标注，测试文件同步。`cmd/api` 无需改动（`Options.Redis` 已注入）。排除：语义近似（非完全一致）在途去重；`apps/web`、GraphQL 设置模型（本任务为环境变量 RuntimeConfig，非 org 设置项）。
- 有意行为变更（前 → 后、影响数据、是否需历史处理）：
  - D2（成本）：修复前后续阶段失败重试会重调 clean/entities/sentiment/kg 全部 LLM；修复后命中 Redis 阶段缓存复用成功产物，`stage_meta` 该阶段 `provider=stage_cache` 且保留 model/token。对外字段/状态码不变，仅 `stage_meta.provider` 新增取值；历史数据不回填、无需处理。
  - D1（去重结果）：修复前并发同源同内容/同标题条目互相看不见、都被保留；修复后后到者 `similarity=1`、`DuplicateOf` 指向登记者 `processedItemId`，由 persist 事务标 `duplicate`。并发/同内容场景 `ItemMeta` 会更多被标 duplicate；历史数据不回溯、无需处理。
- 改动的原有断言：无（仅新增回归用例，未修改既有断言）。
- 剩余问题：语义近似在途重复未覆盖；阶段缓存 key 的 model 取 pipeline 配置模型，不含 org 级 gateway profile，单改 profile 不自动失效；在途键成功后保留至 TTL、失败未清理（低概率指向未落库 id）；legacy 路径无 `stage_meta`，clean 缓存生效但无 `stage_cache` 标注。本机未构建/测试、未连真实服务，仅普通 CI 精确 head 为运行证据。
