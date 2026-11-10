# 业务逻辑复审 01 · 处理链路（入库 → 清洗 → 分类 → 去重 → 事件聚类 → 翻译）

- 审查时间：2026-11-10；基线 main `cba7e707`（CI success）。
- 方式：纯静态审查。每条结论都读过源码并核对了调用链。
- 结论分级：**CONFIRMED** 表示代码路径确定会触发；**PLAUSIBLE** 表示逻辑上成立，但触发频率取决于运行时数据或配置。
- 范围：`itemsingest`、`itempipeline`、`newspipeline`（process/stages/dedupe/persist）、`processeditemoutbox`、`newsclassifier`、`newseventsingest`（事件归并）、`rsstranslation`。
- 未覆盖：`newspipeline/clean.go` 的清洗规则细节、`newsnowclusteringops`（运维面板与个性化）、`classificationrssops`、BERTopic 模式。这些放到下一段审查。

两轮 REFACTOR 都以“与 Nest 等价”为准绳。下面多数问题在 Nest 时期就已存在，迁移时被原样复制了过来。修复它们属于**有意的行为变更**。

## 一、事件聚类与分类：产出质量问题（影响最大）

### L1 事件归并的 overlap 兜底没有阈值，会把不相关的新闻并进同一事件 · CONFIRMED · 高

- `newseventsingest/assign.go:209-216`：向量路径找不到相似度 ≥ `VectorMinScore`（默认 0.82）的事件时，回落到 overlap 路径。
- `assign.go:282-309`：overlap 只比较“首个 topic”和“置信度最高的实体”是否**字面相等**，命中一个就得 0.5 分。
- `assign.go:228`：直接取第一名，**没有任何最低分要求**。
- `store.go:532-542`：候选范围是 30 天内（`LookbackDays` 默认 30）最近活跃的事件。

后果是：向量已经判断“不相似”的文章，只要首个 topic 也叫 “Ukraine”、“Politics”、“AI”，或者主实体都是 “United States”，就会被并进最近那个同名事件。时间越长，“巨型事件”越多，向量阈值形同虚设。`pickPrimaryTopic`（`assign.go:569`）只取第一个非空 topic，进一步放大了这个问题。

**建议**：
- overlap 只作为向量不可用时的兜底（没有 summaryEmbedding 或向量服务不可用），向量给出低分时不再回落；
- 或者要求 topic 和 entity 同时命中，并加上时间邻近约束（例如事件 `lastAt` 在 72 小时内）；
- 阈值做成可配置项。

### L2 分类器：重排层没有候选时，只会在分类树最前面几个节点里挑 · CONFIRMED · 高

- `newsclassifier/classifier.go:188-204`：开启 rerank 时，如果 LLM 和 embedding 层都没有给出候选（两层关闭或都失败），重排输入是 `taxonomy[:limit]`，也就是分类树**声明顺序的前 N 个节点**，与文章内容无关。
- 再叠加 L3（min-max 归一化后第一名恒为 1.0），结果就是这类文章总被高置信度地分到前几个类别。

**建议**：没有候选时，重排对整棵分类树打分，或者直接跳过重排，交给规则兜底。

### L3 分类器：重排分数做了 min-max 归一化，第一名恒为 1.0 · CONFIRMED · 中

- `classifier.go:482-489`：重排分数按本次结果做 min-max 归一化，最高分恒为 1，只有一个结果时也是 1。分数失去了绝对含义：即使所有候选都不相关，第一名照样拿满分，`MinConfidence` 拦不住它。

**建议**：使用上游重排的原始相关度分（通常已在 0–1 之间），或者用 sigmoid 映射。

### L4 分类器：融合时“缺席不扣分”，只被一层看到的候选反而容易胜出 · CONFIRMED · 中

- `classifier.go:540-563`：每个候选的分数是“出现过的层的加权平均”（`score / applied`）。
- `classifier.go:409`：embedding 分数映射为 `(cos+1)/2`。常见 embedding 模型对不相关文本的余弦也在 0.3–0.5 之间，映射后是 0.65–0.75。
- 结果：LLM 明确给了 0.6 的类别，可能输给一个**只在 embedding top-K 里出现**、LLM 根本没提的类别。

**建议**：缺席的层按 0 分计（或给一个先验低分）；embedding 分数改用余弦本身，或者按 top-K 内的相对值打分。

### L5 规则兜底只认英文，中文新闻永远匹配不上 · CONFIRMED · 中

- `classifier.go:643-650`：规则是 ASCII 关键词加上 `\b` 词边界，中文文本不可能命中。
- 当分类器关闭、分类树为空、各层都失败或置信度不足时（`classifier.go:113-126`、`242-253`），中文新闻一律得到 `no-classification-match`，没有类别。
- 另外，规则的 6 个 path 是硬编码的，组织使用自定义分类树时，这些 path 可能根本不存在。

**建议**：补充中文关键词（不使用 `\b`）；兜底结果的 path 必须存在于当前分类树，不存在就丢弃。

### L6 来源权威规则中，“mismatch penalty” 对所有博客类来源无条件扣分 · PLAUSIBLE · 低

- `classifier.go:613-615`：`sourceType == "blog"` 时，同时加上 `BlogPenalty`，再减去 `MismatchPenalty`，没有判断是否真的“不匹配”。字段名暗示它应该只在某种不匹配时生效。需要对照设置界面上对这个字段的说明来确认本意。

### L7 分类查询文本混入了来源名和语言代码 · CONFIRMED · 低

- `newsclassifier/prompt.go:37-46`：`buildQueryText` 把 `Source`（如 “Reuters”）和 `Language`（如 “en”）一起拼进 embedding 和重排的查询文本，给相似度引入了与主题无关的噪声。

**建议**：只用标题、副标题、摘要、topics 和要点。

## 二、状态一致性：数据卡在“处理中”或状态错乱

### S1 处理结果投递进入死信时，MySQL 的 ItemMeta 永远停在 processing · CONFIRMED · 高

- `itempipeline/state.go:167-169`：开始处理时，把 ItemMeta 置为 `processing`。
- `itempipeline/state.go:196-214`：流水线成功时，`markSuccessState` **不更新 ItemMeta**，完成状态由异步 outbox 投递负责（`processeditemoutbox/store.go:185-200`）。
- `processeditemoutbox/service.go:545-595`：投递失败 10 次进入死信，`compensateDead` 只把 Mongo 的 ProcessedItem 和阅读模型改成 failed，**没有改 MySQL 的 ItemMeta**。

后果：这类条目在 MySQL 里永远显示“处理中”，基于 MySQL 状态的统计、筛选和重试入口都看不到它失败了，也不会被当作失败处理。

**建议**：`compensateDead` 同时执行 `UPDATE ItemMeta SET status='failed' WHERE id=? AND orgId=? AND status <> 'duplicate'`。

### S2 原始条目 outbox 进入死信时，ItemMeta/PipelineJob 的失败写入被静默吞掉 · CONFIRMED · 中

- `itemsingest/store.go:252-268`：outbox 被标记为 dead 之后，把 ItemMeta 和 PipelineJob 改成 failed 的两条 UPDATE 用了 `_, _ =`，失败不报错，也不记日志。
- 同类写法在全仓库约有 47 处，本段内需要逐一甄别：哪些是合理的尽力而为，哪些是必须成功的状态写入。

### S3 “Duplicate” 状态常量大小写不一致 · CONFIRMED · 低（潜伏）

- 去重阶段写入的是 `itemsreading.ItemStatusDuplicate = "duplicate"`（`newspipeline/dedupe.go:787`），而 `itempipeline/state.go:25` 中保护条件 `status <> ?` 用的是 `"Duplicate"`。
- 现在之所以没出错，是因为 MySQL 排序规则 `utf8mb4_unicode_ci` 不区分大小写。一旦这个比较挪到 Go 或 Mongo 里做，或者排序规则改为区分大小写，重复条目就会被覆盖回 processing/failed。

**建议**：统一使用 `itemsreading.ItemStatus*` 常量，删掉本地字面量。

### S4 去重标记先于落库写入，回滚是尽力而为 · CONFIRMED · 中

- `newspipeline/dedupe.go:270/324/355`：在 persist **之前**就把 ItemMeta 标成 duplicate。
- `stages.go:90-94`、`dedupe.go:800-815`：persist 失败时才尽力回滚为 `pending`。如果回滚失败，或者进程在两步之间崩溃，条目会卡在“duplicate”，却没有对应的处理结果。
- 回滚的目标状态是 `pending`，而不是标记前的 `processing`。

**建议**：把 duplicate 标记移进 persist 事务（`pipelineMySQLStore.persist`），删除提前标记和回滚逻辑。

### S5 没有 processedItemId 时，每次重试都会生成新的 id · PLAUSIBLE · 低

- `itempipeline/processor.go:123-129`：任务里没有 `processedItemId`，而且 rawItemId 也不是合法的 ObjectId 时，每次尝试都会新生成一个 ObjectId。
- `HandleFailure`（`processor.go:211-216`）在同样情况下得到的却是空 id。如果 persist 成功后、确认前发生锁丢失并重试，会产生第二个 ProcessedItem。生产方 `pipelineenqueue/producer.go:123-125` 通常会给出稳定的 id，所以这条路径只在旧任务或回放路径上出现。

## 三、去重与成本

### D1 并发处理的近似重复文章互相看不见 · PLAUSIBLE · 中

- 去重候选来自 Mongo 中 **已完成** 的 ProcessedItem，以及向量服务中的条目（`dedupe.go:648-751`）。这两者都要等 outbox 异步投递之后才会写入（`processeditemoutbox/service.go:214-257`）。
- worker 并发处理（默认 3），同一来源短时间内推送的近似文章同时进入流水线时，彼此都不在对方的候选集里，会被同时保留。投递失败时，这个窗口最长可达数分钟。

**建议**：在去重前，按 `contentHash`/规范化标题加一个短 TTL 的 Redis 去重键，或者对同一 org 的最近 N 条在途摘要做内存或 Redis 比对。

### D2 任何阶段失败重试，都会重复调用所有 LLM 阶段 · CONFIRMED · 中（成本）

- 清洗缓存只在 persist 之后才可见（`clean.go:1461` 按 `contentHash` 查 ProcessedArticle）。
- 分类、去重或 persist 的瞬时失败会让整个任务重试（`stages.go:41-56`、`240-243`），清洗、实体、情感、KG 这些 LLM 调用全部重来一遍。

**建议**：把各阶段的 LLM 产物按 `(orgId, contentHash, promptVersion)` 写入短期缓存（Redis，TTL 1 天），重试时复用。

## 四、翻译

### T1 一条翻译失败，整批翻译结果都丢弃 · CONFIRMED · 中

- `rsstranslation/deeplx.go:100-158`：批量翻译中只要有一条失败（包括“不支持的源语言”`deeplx.go:202-208`，以及**写 Redis 缓存失败** `deeplx.go:145`），`translateHashes` 就返回错误，`TranslateBestEffort` 返回空 map。
- 已经翻译成功的条目虽然写进了缓存，但本次请求页面上一条译文都不显示。

**建议**：按条返回结果，失败的条目单独跳过；缓存写入失败只记日志，不算翻译失败。

## 汇总

| 编号 | 问题 | 级别 | 修复是否改变行为 |
|---|---|---|---|
| L1 | 事件 overlap 归并没有阈值 | 高 | 是（事件归并结果） |
| L2 | 重排无候选时只看分类树前 N 个 | 高 | 是（分类结果） |
| S1 | 投递死信后 ItemMeta 永远 processing | 高 | 是（状态修正） |
| L3 | 重排分数 min-max，第一名恒为 1 | 中 | 是 |
| L4 | 融合时缺席不扣分 | 中 | 是 |
| L5 | 规则兜底不支持中文 | 中 | 是 |
| S2 | 原始条目死信状态写入被吞 | 中 | 否（补日志/错误） |
| S4 | 去重标记先于落库 | 中 | 是（事务化） |
| D1 | 并发近似重复互相看不见 | 中 | 是 |
| D2 | 重试时重复调用全部 LLM | 中 | 否（成本） |
| T1 | 单条翻译失败整批丢弃 | 中 | 是 |
| S3 | Duplicate 大小写不一致 | 低 | 否 |
| S5 | 重试时 processedItemId 不稳定 | 低 | 否 |
| L6 | 博客类来源无条件扣 mismatch 分 | 低（待确认） | 是 |
| L7 | 分类查询文本混入来源名和语言 | 低 | 是 |

分类和聚类相关的修复（L1–L5）会改变已有数据的产出口径。建议修复后：
- 对最近 7 天的数据离线重跑一次，对比事件数量、平均事件规模和各类别分布，再决定默认参数；
- 对已经形成的“巨型事件”，提供重新归并工具，或者在运维面板中支持拆分。

## 修复任务（2026-11-10，用户已确认行为变更方案）

- L1：采用“只按文本相似度归并”。overlap 仅在向量不可用时兜底，而且要求 topic 和 entity 同时命中，时间间隔不超过 72 小时（可配置）。
- L2–L5、L7：全部修复。L6 因为没有界面入口、默认值为 0，不修改。

| 波次 | 任务 | 覆盖 | 前置 |
|---|---|---|---|
| A | [LOGIC-EVENTS-001](tasks/LOGIC-EVENTS-001.md) | L1 | 无 |
| A | [LOGIC-CLASSIFIER-001](tasks/LOGIC-CLASSIFIER-001.md) | L2–L5、L7 | 无 |
| A | [LOGIC-PIPELINE-STATE-001](tasks/LOGIC-PIPELINE-STATE-001.md) | S1–S5 | 无 |
| A | [LOGIC-TRANSLATION-001](tasks/LOGIC-TRANSLATION-001.md) | T1 | 无 |
| B | [LOGIC-PIPELINE-COST-001](tasks/LOGIC-PIPELINE-COST-001.md) | D1、D2 | PIPELINE-STATE |

所有执行窗口都要先读 [LOGIC-COMMON](tasks/LOGIC-COMMON.md)。
