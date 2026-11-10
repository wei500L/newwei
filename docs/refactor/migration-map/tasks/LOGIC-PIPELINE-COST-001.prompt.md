# 执行提示词 · LOGIC-PIPELINE-COST-001 · 流水线重试复用 LLM 产物与在途近似重复去重

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 和 `tasks/LOGIC-COMMON.md`，再读报告 `docs/refactor/migration-map/LOGIC-REVIEW-01-PROCESSING.md` 的 **D1、D2** 条目，以及任务记录 `tasks/LOGIC-PIPELINE-COST-001.md`。worktree slug：`logic-pipeline-cost`。

**前置**：LOGIC-PIPELINE-STATE-001 已实际合入 main，并且 CI 成功。它改动了 `newspipeline` 的 dedupe、stages 和 persist，并把 duplicate 标记移进了 persist 事务。先读它的 PR diff 和交付记录。不满足前置就停下报告。

## 缺陷（以开工时的 main 为准，重新核对行号）

### D2：任何阶段失败重试，都会重复调用全部 LLM 阶段（成本）

- 清洗结果的缓存（`newspipeline/clean.go` 中的 `findProcessedArticle`，按 `contentHash` 查 ProcessedArticle）只有在 persist 之后才可见。
- 分类、去重或 persist 的瞬时失败会让整个 BullMQ 任务重试，于是清洗、实体、情感、KG 这些 LLM 调用全部重来一遍。

### D1：并发处理的近似重复文章互相看不见

- 去重候选来自 Mongo 中已完成的 ProcessedItem 和向量服务中的条目，两者都要等 outbox 异步投递之后才会写入。
- worker 并发处理（默认 3）同一来源短时间内推送的近似文章时，它们彼此都不在对方的候选集里，会被同时保留。

## 修复

### D2：阶段产物短期缓存

- 在 Redis 中缓存清洗结果，以及实体、情感、KG 的 LLM 产物。
  - key 为 `pipeline:stage:{orgId}:{stage}:{contentHash}:{promptVersion}:{model}`；
  - TTL 24 小时，做成 RuntimeConfig 项，环境变量带默认值。
- 只缓存**成功**的产物，失败不缓存。
- 命中缓存时，`stage_meta` 中该阶段的 provider 标注为 `stage_cache`，并保留原来的 model 和 token 信息，便于成本统计时区分。
- `contentHash` 使用清洗阶段现有的 hash 规则。promptVersion 或模型变化时，自然就不会命中旧缓存。
- 缓存读写失败一律当作未命中处理，只记日志，不影响流水线。

### D1：在途近似重复

- 在去重阶段之前，做一个轻量的“在途登记”：
  - 用规范化标题（小写、去标点、去空白）和 `contentHash`，在 Redis 中以 `SET NX` 加 TTL（例如 10 分钟，可配置）登记 `pipeline:inflight:{orgId}:{key} → itemMetaId`；
  - 登记失败、并且已有登记者不是自己时，以 `similarity=1`、`DuplicateOf` 指向**已有登记者的 processedItemId** 判为重复。
  - 先确认登记者的 processedItemId 在登记时就已确定。如果做不到，就退而只按 `contentHash` 精确匹配，并在 PR 中说明。
- 只处理“标题或内容完全一致”的在途重复。语义近似的在途重复超出了本任务范围，在 PR 的剩余问题中说明。
- 同一个 itemMetaId 重试时，必须能识别出“登记者是我自己”，不能把自己判为重复。

## 测试

- D2：第一次在分类阶段失败，第二次重试时清洗、实体、情感、KG 都不再调用模型（用替身计数），产物与第一次一致；缓存不可用时，流水线照常完成。
- D1：两个 item 的 contentHash 相同、并发进入时，后到者被判为重复；同一个 item 重试时不判为重复；TTL 过期后不判为重复。

## 交付范围

允许修改：`internal/newspipeline/**`、`cmd/api` 中流水线的构造参数（注入 Redis 与配置），以及 `internal/config/**` 中新增的配置项。
