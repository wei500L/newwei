# 执行提示词 · LOGIC-CLASSIFIER-001 · 新闻分类打分与兜底修正

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 和 `tasks/LOGIC-COMMON.md`，再读报告 `docs/refactor/migration-map/LOGIC-REVIEW-01-PROCESSING.md` 的 **L2、L3、L4、L5、L7** 条目，以及任务记录 `tasks/LOGIC-CLASSIFIER-001.md`。worktree slug：`logic-classifier`。

**前置**：无。可以与 LOGIC-EVENTS-001、LOGIC-PIPELINE-STATE-001、LOGIC-TRANSLATION-001 并行。只有本任务修改 `internal/newsclassifier/**`。

用户已确认修复 L2–L5 和 L7。L6（`mismatchPenalty`）没有界面入口，默认值为 0，**本任务不修改**。

## 缺陷与修复（基线 main `0f6e62da`，`internal/newsclassifier/classifier.go`）

### L2：重排没有候选时，只在分类树前 N 个节点里挑（第 188–204 行）

- **现状**：LLM 和 embedding 都没有给出候选时，重排输入是 `taxonomy[:limit]`，即分类树声明顺序的前 N 个，与文章内容无关。
- **修复**：没有候选时，把**全部叶子节点**交给重排。如果分类树很大，超过上游一次能接受的文档数，就按上游限制截断，并记日志。如果你判断全量重排的成本不可接受，可以改为“没有候选就跳过重排、走规则兜底”，但两种方案都要在 PR 中给出理由。

### L3：重排分数做 min-max 归一化，第一名恒为 1.0（第 482–489 行）

- **修复**：直接使用上游返回的相关度分。先核对 `litellmcompat.RerankResponse` 的分数范围：Cohere 和 Jina 风格是 0–1；如果可能出现 logit，就做 sigmoid。分数 clamp 到 [0,1]。删除 min-max 归一化。

### L4：融合时“缺席不扣分”（第 525–569 行），embedding 分数用 `(cos+1)/2`（第 409 行）

修复：

- 在 `combineScores` 中，**已启用并且本次成功**的层，如果没有给某个候选打分，该层按 0 分计入分母。失败或未启用的层，仍然不计入分母。这样“只被一层看到”的候选不会因为分母更小而占便宜。
- embedding 分数改为 `clamp01(cos)`，不再使用 `(cos+1)/2`。
- 层权重（0.5/0.3/0.2）保持不变。

### L5：规则兜底只认英文（第 637–690 行）

修复：

- 为每条规则补充中文关键词，并改用不依赖 `\b` 的匹配方式：英文继续使用 `\b`；中文直接做子串匹配，同时排除过短、容易误伤的单字词。关键词表放在独立文件中，便于以后维护。
- 兜底结果的 `path` 必须存在于**当前组织的分类树**。`classifyByRule` 需要拿到 taxonomy，path 不存在时，按“没有命中”处理（`no-classification-match`）。分类器关闭或分类树为空时，保持现有的硬编码 path 行为。

### L7：查询文本混入来源名和语言代码（`prompt.go:37-46`）

- **修复**：`buildQueryText` 只使用 Title、Subtitle、Summary、Topics 和 KeyPoints，去掉 Source 和 Language。确认 LLM 层的 prompt 是否也使用了它；如果 LLM 层需要来源信息，让它单独拼接。

## 保留项

以下行为全部保持不变：

- `StrictFail` 的语义；
- `MinConfidence` 低置信度回落规则的流程；
- 来源权威规则（`applySourceCategoryAuthority`）；
- Session 的 embedding 缓存；
- 各层日志和 metrics 字段；
- `Result` 的结构。

## 测试

`classifier_test.go` 中需要覆盖：

- L2：LLM 和 embedding 都关闭（或都失败），只开重排时，候选来自全部叶子；
- L3：重排只返回 1 个结果、且原始分为 0.2 时，最终分是 0.2，而不是 1.0；
- L4：LLM 给 A 0.6，embedding 只给 B（cos 0.5），最终 A 胜出；
- L5：中文标题“美联储宣布加息”能命中 finance；自定义分类树里没有 `finance/macro/monetary-policy` 时，结果是 no-match；
- L7：查询文本中不再包含来源名。

另外，用 8–10 条中英文新闻样例构造一张“修复前 → 修复后”的类别与置信度对照表，附在 PR 中。

## 交付范围

允许修改：`internal/newsclassifier/**`、`internal/newspipeline/stages.go`（只在 `classifyByRule` 签名变化需要传入 taxonomy 时修改调用点），以及任何调用 `newsclassifier` 的地方，只改签名适配。
