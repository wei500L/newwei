# 执行提示词 · LOGIC-EVENTS-001 · 事件归并不再按 topic/entity 字面相同合并不相关新闻

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 和 `tasks/LOGIC-COMMON.md`，再读报告 `docs/refactor/migration-map/LOGIC-REVIEW-01-PROCESSING.md` 的 **L1** 条目和任务记录 `tasks/LOGIC-EVENTS-001.md`。worktree slug：`logic-events`。

**前置**：无。可以与 LOGIC-CLASSIFIER-001、LOGIC-PIPELINE-STATE-001、LOGIC-TRANSLATION-001 并行。只有本任务修改 `internal/newseventsingest/**`。

## 缺陷（基线 main `0f6e62da` 已核实）

`internal/newseventsingest/assign.go` 中 `pickEventForSignal`（第 147–217 行）的逻辑如下：

1. **向量路径**：用文章的 summaryEmbedding 找相似文章所在的事件。经过语言惩罚和类别闸门后，最高分 ≥ `VectorMinScore`（默认 0.82）就归入该事件。
2. 向量路径没有命中时，**一律**回落到 **overlap 路径**（第 209 行）：
   - 只要“首个 topic”或“置信度最高的实体”与某个 30 天内活跃事件**字面相等**，就得 0.5 分（第 282–309 行）；
   - 然后**无阈值**地取第一名（第 228 行）。
3. 两条路径都没有命中，才新建事件。

问题在于：向量已经判定“不相似”的文章，仍然会因为首个 topic 同为 “Ukraine”、“AI”，或者主实体同为 “United States”，被并进最近那个事件，于是形成越滚越大的“巨型事件”。

## 已确定的修复方案（用户已选定，不要改成别的方案）

**只按文本相似度归并**：

- 向量路径**可以给出判断**时，以向量结论为准：
  - 达到阈值就归入；
  - 没有达到阈值就**新建事件**，**不再**回落到 overlap。
- 只有在向量路径**无法给出判断**时，才使用 overlap 兜底。“无法给出判断”包括：
  - 文章没有 summaryEmbedding（`summaryVectorOf` 返回 nil）；
  - 向量服务未配置或不可用（`SearchBestEffort` 的第二个返回值为 false，现在被 `_` 丢弃，要用起来）。
  
  “向量服务正常返回但没有匹配”**不算**无法判断，这种情况应当新建事件。
- 兜底时的 overlap 也要收紧：**topic 和 entity 同时命中**才算候选，并且候选事件的 `lastAt` 必须在 72 小时内。72 小时做成设置项 `overlapFallbackMaxGapHours`（默认 72，取值 1–720）。端到端修改设置读取、GraphQL 模型和 `apps/web` 的事件聚类设置区，包括中英文文案。

## 其他调用方

`AssignNewsSignalToEvent` 还被以下调用方使用。确认它们走的都是同一个 `pickEventForSignal`，修复对它们同样生效；如果其中有调用方自己调用 overlap，也一并修正：

- `bertopic.go`；
- `newsnowclusteringops/llm_backfill.go`；
- `newsnowclusteringops/clusteringfailure.go`；
- `clusteringrecoveryqueue`。

## 等价陷阱与保留项

- 语言惩罚、类别闸门（`categorygate.go`）、事务内的竞态复查、`Created` 语义和各类日志，全部保持不变。
- `AssignNewsSignalToSpecificEvent`（人工或指定归并）不受影响。
- 只影响**新进入**的文章。已经形成的“巨型事件”不在本任务内自动拆分，在 PR 中说明，由后续任务处理。

## 测试

在 `assign_test.go` 中新增以下用例：

- 向量可用但最高分低于阈值，即使 topic/entity 相同，也新建事件；
- 文章没有 embedding 时，topic 和 entity 同时命中、并且在 72 小时内，归入该事件；
- 文章没有 embedding 时，只有 topic 命中，新建事件；
- 文章没有 embedding 时，同时命中但超过 72 小时，新建事件；
- 向量服务不可用时，同时命中，归入该事件；
- 向量命中时，原有行为不变。

原有用例中断言“向量低分后回落 overlap 并归入”的，改为新行为，并在 PR 中列出。

## 交付范围

允许修改：

- `internal/newseventsingest/**`；
- 事件聚类设置的读取与 GraphQL 模型（`internal/graphqlread/settingscrawl/**` 中 NewsEvent 聚类设置相关的部分）；
- 设置保存路径（如果写入在别的包，只改新增字段）；
- `apps/web` 事件聚类设置界面与 `lib/locales/{zh,en}.json`，以及前端测试。

PR 附上修复前后的行为对照表。
