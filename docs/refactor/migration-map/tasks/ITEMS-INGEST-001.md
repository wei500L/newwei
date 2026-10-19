# ITEMS-INGEST-001 · 条目写入、采集结果入库与原文补偿

- 状态 **reserved**，2026-10-19 Europe/Moscow；[完整提示词](ITEMS-INGEST-001.prompt.md)在[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)发出。规划分支docs/plan-newsnow-feed、worktree /Users/oo/project/newwei-plan-newsnow-feed；未实施业务。
- 基线origin/main `91e759b449c4511dc96d86539ea0eb258754d07e`，[普通CI39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593)精确head成功。#93旧head c4ae295c839ae211704f38d3bf8161a914b19d05的普通CI39293839565成功，本轮追加head的CI独立查。
- 业务分支refactor/go-items-ingest、worktree /Users/oo/project/newwei-go-items-ingest，尚未创建，无业务提交/PR/merge/CI，执行器活动未核实。
- 来源BL-24条目写/导入及BL-20 raw_item必要补偿；关联GAP-LEGACY-001/GAP-ASYNC-001及具体GAP-ITEMS-001。

## 完整范围与执行所有权

POST /api/items（items.write/201/ItemMeta+rawItemId）；Mutation createItem/updateItem（items.write/ItemModel!）；createItemFromCrawlResult/ingestCrawlTaskResultsToItems（crawl.read AND items.write/ItemModel!与CrawlIngestBatchModel!）；updateCrawlTaskIngestToItems（crawl.write，启用另需items.write/CrawlTaskModel!）。已核当前SDL/Resolver及无Go生产注册；limit/批量统计沿Float。DTO/default/null/错误/字段权限和源码定位在prompt。

人工创建/编辑：MySQL ItemMeta+raw_item Outbox事务→即时Mongo→原子BullMQ producer→水合/审计。采集批入库：直接unordered Mongo插入/回读确认→空ref CAS/输家只删自己raw→逐项入队/水合/审计，不能虚构为同一种Outbox路径；保留并发8/输入顺序/部分失败/分页前进。RawItem Mongoose URL comparable hook和实际strict存储字段不可省略。

当前Go没有BullMQ producer。本批新增internal/pipelineenqueue，按锁文件5.63.2官方standard/priority Lua及递归include/MessagePack接入；保留itemPipeline/process-item/jobId、stable processed ID、pending best-effort upsert、pause/marker/events/去重/优先级及组织计数Lua。不能用asynq/Redis List或NestHTTP代入队，不迁worker。Nest org-stats/QueueEvents/内容处理继续拥有后续执行。

两个默认legacy独立开关：API_GO_ITEMS_INGEST_MODE接六入口/同步投递，需DB/JWT/Redis/Mongo；API_GO_RAW_ITEM_OUTBOX_MODE仅raw_item定时owner，单开DB/Redis/Mongo无JWT。Nest同步deliverNow仍服务旧请求，按既有行CAS竞争；后台go使Nest Cron在取锁前退出，Go每分钟锁lock:cron:raw-item-outbox PX55000、token续租释放、三状态合并50/顺序投递/5分钟stale/10次dead和引用受限失败补偿。SCHEDULE_ENABLED=false只停定时；切后台owner先停旧/drain/启新，回滚反向；不停止Nest itemPipeline worker，不消费processed_item/Cleanup/Audit Outbox。

## 复用、改善、并行

Go itemsreading已有私有hydrate/UpsertReadModels及GraphQL选择集投影，新增窄port和只注册Item/Crawl模型端口。ItemModel五字段meta/raw/processed/rawPreview/processedPreview必须补items.read权限，不能由items.write直接读出；AND权限在新adapter沿现有Root/Failure包装，不碰四订阅占用的contract/exec。

GAP-ITEMS-001：Go hydration当前用completed-only且窄投影helper，Nest用最新任意状态/完整snapshot，会丢pending/failed或沿用旧completed。仅修hydration专用org/item聚合与完整snapshot，保持raw双向绑定/缺快照unset，不改搜索/RSS的completed-only读取。第二项改善deliverPendingForItemMeta：org/type/status/JSON itemMetaId先过滤再取50，避免旧“组织前50再筛item”遮挡。全局retry上限不变。

主包itemsingest/pipelineenqueue/graphqlread-itemsingest/cmd-api-items_ingest，itemsreading hydration/port、GraphQL模型/投影port及公共main/config/env/compose/依赖最小增量；Nest仅Cron gate/owner env。现ci.yml可复用已有Redis integration job加producer命令，不新增workflow/job/服务。

审计Ready #92 OPEN/head28c8f761a2ce4a447080414f154b567648cc6bd1/CI39248452603成功；NewsNow Ready #94 OPEN，续核headb33cc1eab4dd56d08e9a802a2670d363a3227462只增traceId修复，CI[39296327154](https://github.com/wei500L/newwei/actions/runs/39296327154)运行中；四订阅in_progress，worktree在91e759b4已有contract/exec扩展，实际diff已读，无业务PR。实际共享diff已读，核心无交叉；共享资源/开关/关闭/Go依赖取并集，不要求运行窗口重做文档。Nest订阅smoke成功不作为本批Go验收。

## 核对深度与交接

只深读本链Nest Controller/DTO/Resolver/model、ItemsIngest全方法、ItemsService写、RawOutbox全方法、payload Zod、RawItem Mongoose与URL hook、SQL schema/index、CrawlTask入库/配置/视图、Queue.enqueueItem/stableID/org-stats Lua/retention；Go hydration/store/投影/身份及main/config/生命周期/普通CI。相对地图3cedce9a，本链Nest无业务变化，Go列表等已合main但无写/producer/consumer。未扩大到其他item/crawl/全部worker审查。

一手兼容依据：[BullMQ5.63.2 Scripts](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/scripts.ts)、[standard](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/commands/addStandardJob-9.lua)、[priority](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/commands/addPrioritizedJob-9.lua)、[storeJob](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/commands/includes/storeJob.lua)、[重复job](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/commands/includes/handleDuplicatedJob.lua)。只确认实现路线，不称Go已存在或和Nest worker已实跑。

本规划未安装依赖/运行build/test、Docker/服务或真实DB/Redis/WS/外部模型/部署验证。编码窗口少量行为用例+现有普通CI，producer在既有MySQL/Redis job验证原子wire；没有Mongo/完整Nest worker/双端owner运行证据就记未验证。仅维护本task/专用交付文档，共享地图规划窗口回填。下一次核业务PR六入口/必要副作用、两个独立开关/关闭及最终精确headCI；未入main不增加覆盖或关闭跨域GAP。
