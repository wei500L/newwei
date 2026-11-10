# 执行提示词 · LOGIC-TRANSLATION-001 · 单条翻译失败不再丢弃整批

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 和 `tasks/LOGIC-COMMON.md`，再读报告 `docs/refactor/migration-map/LOGIC-REVIEW-01-PROCESSING.md` 的 **T1** 条目，以及任务记录 `tasks/LOGIC-TRANSLATION-001.md`。worktree slug：`logic-translation`。

**前置**：无。可以与 LOGIC 系列的其他 A 波任务并行。只有本任务修改 `internal/rsstranslation/**`。

## 缺陷（基线 main `0f6e62da`）

`internal/rsstranslation/deeplx.go:100-158` 的 `translateHashes` 中，只要有一条翻译失败，`firstErr` 就会让整个函数返回错误，`TranslateBestEffort`（第 53–97 行）随之返回空 map。触发失败的情况包括：

- DeepLX 和兜底接口都失败；
- “不支持的源语言”（第 202–208 行）；
- 翻译成功但**写 Redis 缓存失败**（第 145 行，`taskErr = c.cache.setString(...)`）。

结果是这一页的新闻一条译文都不显示，虽然成功的那些已经写进了缓存。

## 修复

- `translateHashes` 改为按条收集结果：
  - 成功的条目放进结果；
  - 失败的条目跳过，并记录一条汇总日志（失败条数和首个错误信息），不逐条刷屏；
  - 只有**全部**失败时才返回错误，以保留现有“整体不可用”的日志语义。
- 缓存写入失败只记日志，不算翻译失败，译文照样返回。
- `TranslateBestEffort` 返回所有成功条目的译文。
- 检查同包中是否还有其他翻译入口（例如 LLM 翻译 provider、`itemsreading/translation*.go` 中调用 rsstranslation 的地方）使用了同样的“一条失败整批失败”写法。有的话一并修复；如果不在本包内，就在 PR 中列出，交给后续处理。

## 保留项

以下内容保持不变：

- 缓存 key、TTL；
- 并发上限（`sem`）；
- 重试与退避；
- DeepLX 与兜底接口的选择顺序；
- 中文源文本直接返回原文的逻辑。

## 测试

- 3 条文本中 1 条失败时，返回另外 2 条的译文；
- 缓存写入失败时，仍然返回译文；
- 全部失败时，返回空结果并记录日志。

## 交付范围

允许修改：`internal/rsstranslation/**` 及其测试。如果需要修改 `itemsreading` 中的同类问题，只改翻译相关文件。
