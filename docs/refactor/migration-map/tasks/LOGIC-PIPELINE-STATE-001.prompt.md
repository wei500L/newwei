# 执行提示词 · LOGIC-PIPELINE-STATE-001 · 处理链路状态一致性修复

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 和 `tasks/LOGIC-COMMON.md`，再读报告 `docs/refactor/migration-map/LOGIC-REVIEW-01-PROCESSING.md` 的 **S1、S2、S3、S4、S5** 条目，以及任务记录 `tasks/LOGIC-PIPELINE-STATE-001.md`。worktree slug：`logic-pipeline-state`。

**前置**：无。可以与 LOGIC-EVENTS-001、LOGIC-CLASSIFIER-001、LOGIC-TRANSLATION-001 并行。

后续任务 LOGIC-PIPELINE-COST-001 会在本任务合入后修改 `newspipeline` 的同一批文件，所以本任务只做状态一致性，不做成本优化。

## 缺陷与修复（基线 main `0f6e62da`）

### S1：投递进入死信后，MySQL 的 ItemMeta 永远停在 processing（高）

- **现状**：
  - `itempipeline/state.go:167-169` 开始处理时，把 ItemMeta 置为 `processing`；
  - 成功时由 `processeditemoutbox` 投递把 ItemMeta 置为 `completed`（`processeditemoutbox/store.go:185-200`）；
  - 但投递失败 10 次进入死信时，`compensateDead`（`processeditemoutbox/service.go:545-595`）只补偿 Mongo，**没有更新 MySQL 的 ItemMeta**。
- **修复**：
  - `compensateDead` 增加 `UPDATE ItemMeta SET status='failed', updatedAt=? WHERE id=? AND orgId=? AND status <> 'duplicate'`，作为第一步补偿。
  - 失败时记录错误日志，不影响后续的 Mongo 补偿。
  - 同时检查 `markDead` 之前的“无效 payload”路径：拿不到可信 id 时不补偿，这一点保持不变。

### S2：原始条目 outbox 进入死信时，状态写入被静默吞掉（中）

- **现状**：`itemsingest/store.go:252-268` 把 ItemMeta 和 PipelineJob 改成 failed 的两条 UPDATE 写成了 `_, _ =`，失败既不报错也不记日志。
- **修复**：
  - 这两条写入失败时返回错误，或者至少记录带 id 的错误日志。根据调用方语义选择：如果调用方会重试，就返回错误。
  - 然后对本任务涉及的包（`itemsingest`、`itempipeline`、`processeditemoutbox`、`newspipeline`）逐一检查所有 `_, _ = ...ExecContext` 和 `_ = ...UpdateOne` 的写法，在 PR 中列表说明哪些属于“必须成功的状态写入”并已修复，哪些是合理的尽力而为（例如事务回滚、清理）并保留。

### S3：Duplicate 状态常量大小写不一致（低）

- **现状**：`itempipeline/state.go:25` 使用 `"Duplicate"`，去重写入的是 `itemsreading.ItemStatusDuplicate = "duplicate"`。现在只是靠 MySQL 的 `utf8mb4_unicode_ci` 排序规则不区分大小写才没有出错。
- **修复**：`itempipeline` 和 `pipelinerecovery` 删除本地的状态字面量，统一使用 `itemsreading.ItemStatus*` 常量。用 grep 确认全仓库不再有 `"Duplicate"` 字面量被当作 ItemMeta 状态使用。

### S4：去重标记先于落库写入，回滚只是尽力而为（中）

- **现状**：
  - `newspipeline/dedupe.go:270/324/355` 在 persist **之前**就通过 `markItemMetaDuplicate` 把 ItemMeta 标成 duplicate；
  - persist 失败时，`stages.go:90-94` 和 `dedupe.go:800-815` 才尽力回滚为 `pending`。
  - 如果回滚失败，或者进程在两步之间崩溃，条目就会卡在 duplicate，却没有对应的处理结果。
- **修复**：
  - 去重阶段**只计算**结果，不写库。删除 `markItemMetaDuplicate` 和 `RevertDuplicateMarkOnPersistFailure` 两条路径。
  - 在 `pipelineMySQLStore.persist`（`persist.go:165-209`）的事务里，当 `DuplicateOf != nil` 时，执行 `UPDATE ItemMeta SET status='duplicate' ... WHERE id=? AND orgId=?`，与 outbox 写入一起提交。
  - 确认 outbox 投递的 `updateItemMeta`（`status <> 'duplicate'` 条件）仍然会保留 duplicate。
  - 确认前端或 API 不依赖“去重阶段结束、persist 之前就是 duplicate”这个中间态。

### S5：没有 processedItemId 时，每次重试都会生成新的 id（低）

- **现状**：`itempipeline/processor.go:123-129` 在任务里没有 `processedItemId`、并且 rawItemId 不是 ObjectId 时，每次尝试都新生成一个 id；`HandleFailure`（第 211–216 行）在同样情况下得到的是空 id。
- **修复**：改为由 `(orgId, itemMetaId)` 确定性地得到 id。可以复用 `pipelineenqueue` 的 `resolveStableProcessedItemID` 思路：先查最新的 ProcessedItem，查不到再生成，并把生成结果写回任务数据，例如通过 `UpdateData`。`Handle` 和 `HandleFailure` 使用同一个解析函数。如果你判断写回任务数据不可行，就在 PR 中说明，并至少让 `HandleFailure` 与 `Handle` 的解析逻辑一致。

## 保留项

以下内容保持不变：

- 各状态的取值；
- 重试与死信的阈值（10 次、30 秒指数退避）；
- outbox 的 CAS 认领；
- `processing` 的写入时机；
- 对外 API 返回的状态字段。

## 测试

- S1：死信补偿后，ItemMeta 为 failed；原本是 duplicate 的条目保持 duplicate。
- S2：UPDATE 失败时，错误被返回或记录。用测试替身断言。
- S3：grep 级别的确认放在 PR 中，不写源码扫描测试。
- S4：persist 事务失败时，ItemMeta 不是 duplicate；persist 成功并且 `DuplicateOf != nil` 时，ItemMeta 为 duplicate；去重阶段本身不发出任何 UPDATE。
- S5：同一个任务两次尝试得到的 processedItemId 相同。

## 交付范围

允许修改：

- `internal/itemsingest/**`、`internal/itempipeline/**`、`internal/processeditemoutbox/**`、`internal/pipelinerecovery/**`；
- `internal/newspipeline/{dedupe.go,stages.go,persist.go,process.go}` 及其测试。

不要修改 `newspipeline/clean.go`，它属于 LOGIC-PIPELINE-COST-001 的范围。
