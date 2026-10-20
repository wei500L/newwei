# ITEMS-INGEST-001 · 条目写入、采集结果入库与原文补偿

- 状态 **pr_open**，2026-10-19 Europe/Moscow；业务 [Ready PR #96](https://github.com/wei500L/newwei/pull/96)，分支 `refactor/go-items-ingest`。认领与稳定提示词来自[Ready 规划 PR #93](https://github.com/wei500L/newwei/pull/93) 的最新 docs/plan-newsnow-feed 分支（规划 head `76f6d06ecf5ac0300249b611f57f4cf192302972`）；本窗口从该 PR 只带入本任务 `ITEMS-INGEST-001.md` 与原始 prompt，未把其他未合业务分支当前提。
- 业务分支 `refactor/go-items-ingest`，worktree `/Users/oo/project/newwei-go-items-ingest`；从 `origin/main` `91e759b449c4511dc96d86539ea0eb258754d07e` 创建。该精确 SHA 的[普通 CI39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593) 成功；旧主工作目录 c70b0373 不作为本批基线。
- 本任务来源 BL-24 条目写/导入与 BL-20 raw_item 必要补偿；关联 GAP-LEGACY-001 / GAP-ASYNC-001 及具体 GAP-ITEMS-001。代码 head `e66052d66c0b1dbf36a7f1af3fff70ae95070ade` 的[普通 CI39308942328](https://github.com/wei500L/newwei/actions/runs/39308942328) success；前序代码 head `8582fb29a1e4ce9e9aef0c784239921e72e9e4ca` 的[普通 CI39306302625](https://github.com/wei500L/newwei/actions/runs/39306302625) 也 success。e66052d6 仅追加机器令牌混合权限数组过滤与审计 JSON 写入修正。最终 doc-only head 的 CI 以 PR 当前值为准。verify、vector-integration、api-go-user-settings-integration 均 success，两个 regen job 因无 label 而 skipped（不作为通过项）。`api-go-user-settings-integration` 实际执行了新增的真实 Redis producer 命令与 MySQL ItemMeta/raw_item Outbox 命令。此前 `a98b3f7fdd595a3bdf85bef916c61cfee13e9f12` 是 `go-modules-regen` bot 生成的 go.mod/go.sum（msgpack v5.4.1、tagparser v2.0.0），label 已移除。pr_open 不代表已合 main 或已启用；部署/真实 Mongo/Nest worker 仍未验证。

## 完整范围与执行所有权

POST /api/items（items.write/201/ItemMeta+rawItemId）；Mutation createItem/updateItem（items.write/ItemModel!）；createItemFromCrawlResult/ingestCrawlTaskResultsToItems（crawl.read AND items.write/ItemModel! 与 CrawlIngestBatchModel!）；updateCrawlTaskIngestToItems（crawl.write，启用另需 items.write/CrawlTaskModel!）。limit 与批量统计沿 SDL Float；五个写入 root 不要求读开关 go。

人工创建/编辑：MySQL ItemMeta+raw_item MongoOutbox 事务→即时 Mongo→官方 BullMQ 原子 producer→读模型水合/审计。采集结果入库：直接 unordered Mongo insert→按 ID 回读确认→空 mongoRef CAS；CAS 输家只删自己新建的 raw，不删赢家；已有 ref 只对 pending/processing/failed 入队。保留分页前进、并发 8、输入顺序、部分失败、清理 org+空引用条件。RawItem Mongoose strict payload 字段与 URL comparable 钩子按实际模型复现。

本批新增受限 BullMQ 5.63.2 producer（standard/priority 两条官方 Lua + 递归 include 展平 + MessagePack + pending ProcessedItem upsert + org 计数 Lua），不迁 worker；Nest process-item、QueueEvents、org-stats 后续状态和外部内容处理继续拥有。

两个默认 legacy 独立开关：`API_GO_ITEMS_INGEST_MODE` 接六入口/请求内即时投递，需 JWT/MySQL/Redis/Mongo；`API_GO_RAW_ITEM_OUTBOX_MODE` 仅 raw_item 定时重放 owner，单开需 MySQL/Redis/Mongo、不要求 JWT。`SCHEDULE_ENABLED=false` 只停定时重放，不停请求内即时投递；切后台 owner 先停旧 Cron 并 drain，再启新 Go，回滚反向，无需清表。Nest 同步 deliverNow/deliverPendingForItemMeta 继续服务旧请求，按既有行 CAS 与 Go 竞争。

## 复用、改善、并行

复用 itemsreading 的 hydrate/UpsertReadModels、raw 绑定、sourceId 推导与 selection 投影；新增窄 `Hydrator` 端口，后台 owner 不需要 JWT/HTTP 读/ES/LLM。GAP-ITEMS-001 修复在 hydration 专用路径：按 org+item IDs 在 Mongo 侧 sort/group 取每 item 最新**任意状态**和完整 snapshot（rawItemId/pipelineJobId/sourceId/error/llm/updatedAt 等），保留 raw 双向绑定与缺 snapshot `$unset`；搜索/RSS 的 completed-only helper 不变。第二项改善 deliverPendingForItemMeta 先在 SQL 中按 org/type/status/JSON itemMetaId 过滤再取 50，避免旧条目遮挡当前目标。

ItemModel 五个可读字段 meta/raw/processed/rawPreview/processedPreview 补 items.read 字段权限，由现有 executor 的 field permission 机制执行；写 root 只检查 items.write（或 crawl.read AND items.write），不打开读 root、不改 contract/exec、不发布第二份 queueEvents。

## 并行任务并集

审计 AUDIT-OUTBOX-001（#92，head `28c8f761a2ce4a447080414f154b567648cc6bd1`，普通 CI39248452603 成功）拥有 AuditLogOutbox consumer/双端 gate；本批只在共享 config/env/compose 追加自己的键并保留 `ScheduleEnabled` 增量，不迁其业务。NewsNow NEWSNOW-SOURCES-001（#94，head `cf25026ff99b26fb3bf2122cd240d4ac4021889a`；任务记录要求最终 head/CI 另查）拥有来源 HTTP/secret-reader/providers；与本批无文件交叉。GRAPHQL-SUBSCRIPTIONS-001 在 `/Users/oo/project/newwei-go-graphql-subscriptions` 的 HEAD `91e759b4` 已有 contract/exec Subscription 开发；本批不修改 contract/exec，AND 权限在新 adapter 内用现有 contract.Failure 构造。

## 核对深度与交接

只深读本链 Nest Controller/DTO/Resolver/model、ItemsIngestService 全方法、ItemsService 写、RawItemOutboxService 全方法、NormalizedNewsPayloadSchema、RawItem Mongoose/URL hook、Prisma ItemMeta/MongoOutbox/CrawlTask/CrawlResult/PipelineJob、QueueService/org-stats/retention、CrawlTaskService 入库/配置/视图、Go itemsreading 水合/投影/身份、legacyproxy/main/config/生命周期与现有 CI。未扩大到其他 item/crawl/全部 worker。

一手兼容依据：BullMQ 5.63.2 `addStandardJob-9.lua`、`addPrioritizedJob-9.lua` 与其递归 include、`Scripts.addJob`、`Job.validateOptions`、`QueueService.enqueueItem`、`QueueOrgStatsService.upsertJobMetaAndCount`。Lua 以固定版本资源内嵌并保留出处/许可证/摘要；运行时不下载代码。

本窗口按用户要求不安装依赖、不运行 build/test、Docker 或服务，不读真实 .env/生产凭据，不调用真实 Mongo/Redis/模型/crawl4ai/ES/vector/SMTP。允许静态 review、普通格式化与 git diff --check。少量行为验证交现有普通 CI；producer 在现有 `api-go-user-settings-integration` job 复用 Redis 7.2 增加真实 Redis 命令用例。没有真实 Mongo/双端 owner 切换/Nest 完整 worker/外部服务/部署证据即明确未验证，不伪造。共享地图索引/模块/AUDIT/GAPS/BACKLOG/DEPENDENCIES 由规划窗口集中回填。
