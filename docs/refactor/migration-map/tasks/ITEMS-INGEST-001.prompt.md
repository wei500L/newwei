# 目标

为 wei500L/newwei 将“人工创建/编辑条目、采集结果单条/批量入库→原文持久化→读模型刷新→现有 itemPipeline 入队”完整迁入 apps/api-go，并迁移这条链的 raw_item MongoOutbox 即时投递与定时失败补偿。用户能创建条目、修改内容、将已有采集结果导入条目并看到正确的待处理/失败状态，任务由现有 Nest 流水线继续执行。

任务 ID：ITEMS-INGEST-001。范围是 1 个 HTTP、5 个 Mutation 与必要的 Mongo/MySQL/Redis、BullMQ producer 和 raw_item 补偿链，工作量在跨存储状态、批量并发/竞争处理和真实入队，不凑无关入口。不把写一个 ItemMeta、只写 Outbox、只开 ingestToItems 配置或返回 pending 当成整链完成。

## 1. 最新基线与独立工作区

- 仓库 /Users/oo/project/newwei；规划核对 origin/main=91e759b449c4511dc96d86539ea0eb258754d07e，普通 CI39247556593 在该精确 SHA success。代码基线不能取旧主工作目录 c70b0373；既有 main CI 也不是本批验证证据。
- 开始先 git fetch origin main、git rev-parse origin/main、gh pr list --state open、gh run list --branch main --limit 5、git worktree list；读适用 AGENTS.md 和 docs/refactor/migration-map/{README.md,PLANNING.md,tasks/README.md,GAPS.md,BACKLOG.md}，再读本任务、modules/{items,crawl,async-runtime,graphql-runtime}.md、AUDIT/DEPENDENCIES 相关段。只增量核本链与公共接线，不重新扫描全仓。
- 从当时最新 origin/main 建分支 refactor/go-items-ingest，worktree /Users/oo/project/newwei-go-items-ingest。存在时先核归属/HEAD/status并续作，不能覆盖或重置。后续主线更新只正常 merge，不 rebase。
- 本任务认领与稳定提示词在 Ready 规划 PR #93 的最新 docs/plan-newsnow-feed 分支。若 main 尚无任务文件，从该 PR 只读取/带入自己的 ITEMS-INGEST-001.md 与原始 prompt，不将其他未合业务分支作为前提。

## 2. 并行任务、文件所有权与排除范围

- 审计 AUDIT-OUTBOX-001：Ready #92 OPEN/head28c8f761a2ce4a447080414f154b567648cc6bd1，普通CI39248452603成功。它拥有 AuditLogOutbox consumer/双端gate/审计scheduler，不重迁、不改其业务/task。
- NewsNow NEWSNOW-SOURCES-001：Ready #94 OPEN，续核headb33cc1eab4dd56d08e9a802a2670d363a3227462（比06542a7f仅增加错误traceId），普通CI39296327154运行中。它拥有来源HTTP/secret-reader/providers/专用Nest来源relay，与本批业务隔离。重新查询最终head/CI，不用旧head成功代替。
- GRAPHQL-SUBSCRIPTIONS-001 已in_progress，/Users/oo/project/newwei-go-graphql-subscriptions HEAD91e759b4，续核contract.go/exec/engine.go已有Subscription注册与Authorize开发，实际diff已读；尚无业务PR，占用有效。它拥有 WebSocket/Subscription、graphqlread contract/exec 的最小扩展及 queueEvents 广播观察。**本批不改 contract/exec**；AND权限在新adapter内用现有contract.Failure实现，不为方便扩引擎。producer job/event字段与现有Nest协议保持，禁止自行发布第二份queueEvents。
- 主业务新增 internal/itemsingest/、internal/pipelineenqueue/、internal/graphqlread/itemsingest/、cmd/api/items_ingest.go 和本批精确路由。原文outbox consumer可放itemsingest内，禁止建通用跨域队列/Outbox框架。
- 允许在 internal/itemsreading 新增窄 hydration port并修本链相关readmodel快照读取；在 graphqlread/itemsreading 拆出只注册返回模型/字段权限及现有选择集投影窄port；settingscrawl仅新增CrawlTask返回模型注册port，复用已有导出模型。保留所有旧Query/列表/翻译/CSV算法与开关。
- 允许main/config/legacyproxy、Go依赖、Nest RawItemOutboxService的Cron gate及env getter/schema、Compose/样例/根README的必要增量；现有ci.yml仅允许为下述Redis兼容验证增补既有integration job的测试命令，不新增workflow/job/服务。
- main/config/env/compose/关闭/依赖共同文件必须保留并集：AuditOutboxMode/ScheduleEnabled、NewsnowSourcesMode、GraphQLSubscriptionsMode及所有既有模式/资源OR。先读#92/#94实际diff与四订阅工作区当前diff，不能整段覆盖。第二批合入者正常merge最新main后再处理并集；不改其他任务核心文件或要求运行窗口重做文档。
- 排除 crawl创建/重试/删除、Frontier/策略执行、自动采集器、新闻pipeline生成、RSS翻译、搜索重建/排序、processed_item/CrawlCleanup/Audit Outbox consumer、itemPipeline worker/QueueEvents observer、Socket.IO/GraphQL订阅executor、ES/vector/模型/SMTP调用。原有入队后的Nest执行器继续运行，不能宣称已迁完整内容处理流水线。

## 3. 精确入口与权限/返回

新独立 API_GO_ITEMS_INGEST_MODE=go 时迁以下六入口：

| 入口 | 权限 | 返回 |
|---|---|---|
| POST /api/items | items.write | 201，原ItemsService.create的ItemMeta字段及rawItemId；不是GraphQL ItemModel |
| Mutation createItem(input:CreateItemInput!) | items.write | ItemModel! |
| Mutation updateItem(input:UpdateItemInput!) | items.write | ItemModel! |
| Mutation createItemFromCrawlResult(resultId:String!) | crawl.read AND items.write | ItemModel! |
| Mutation ingestCrawlTaskResultsToItems(taskId:String!,after:String,limit:Float,onlyMissing:Boolean) | crawl.read AND items.write | CrawlIngestBatchModel! |
| Mutation updateCrawlTaskIngestToItems(id:String!,enabled:Boolean!) | crawl.write；enabled=true还需items.write | CrawlTaskModel! |

事实源 apps/api/src/modules/items/items.controller.ts、graphql/resolvers/{items,crawl}.resolver.ts、graphql/dto/item.input.ts、modules/items/dto/{create-item,update-item}.dto.ts、graphql/models/{item,crawl}.model.ts与嵌入schema.gql。limit是GraphQL Float（Nest未显式Int），不是擅自改Int。crawl.read/items.write的AND不能变OR，权限错误保留ALL/required/missingPermissions形状；可在现有AllowAuthenticated根包装器中按Nest先权限、再参数/业务执行，避免根只检查一个权限改变错误契约。

HTTP沿JwtAuthGuard支持Bearer mtk_：SHA256查MachineAccessToken及Org.isActive、撤销/到期校验，best-effort lastUsedAt更新、DB行里的string权限与machine:<id>身份，再检查items.write；合法但只有metrics.read的token是403，不是401，也不能额外授写权限。现itemsreading/handler.go已有私有authenticateMachine，可最小导出/抽取该窄能力；按Nest MachineTokenService.validate兼容JSON权限数组的string过滤，不新建机器令牌平台。普通JWT复用authhttp；GraphQL仍只JWT，不打开mtk。两入口标准异常体/GraphQL现有限流和错误映射保持；orgId/userId/permissions从服务端身份取，不从DTO/采集metadata取。数据缺失与跨组织均返回对应not found，不泄漏。

ItemModel顶层按ItemsResolver.toItemModel：id/metaId同ItemMeta.id，title=name、status、orgId、ingestedAt/createdAt/updatedAt，publishedAt为ISO字符串或null，relevanceScore/searchHighlights缺省null。**meta/raw/processed/rawPreview/processedPreview五字段都额外需要items.read**（item.model.ts的HasPermission），不能因为根只有items.write而泄漏。现Go注册未显式挂这五字段权限，本批独立模型注册须补；没有items.read选择meta等时按现有non-null/GraphQL权限错误传播。复用既有按选择集批量投影、绑定mongoRef与raw.itemMetaId、processed.orgId；不能为写返回强制打开所有读root，也不能执行写后才因模型未注册整份回退。

CrawlTask返回沿CrawlTaskService.toView→CrawlResolver.toGraphTask：config为JSON字符串或null，resultCount真实查询，memoryStats/lastRunSummary未赋值，时间/nullable字段按SDL；不要把整个配置对象直接当GraphQL字符串或丢未知配置键。CrawlIngestBatch返回taskId/scanned/attempted/ingested/skippedExisting/failed/nextCursor/hasMore，计数字段沿SDL Float。

## 4. DTO、规范化、null与错误事实

- REST CreateItemDto：externalId字符串最大128、name最大255、payload非数组对象、status可选字符串；GraphQL CreateItemInput：title/externalId字符串最少3，payload非空JSON字符串，status可选字符串，title映射name。不要将两个入口限制强行统一或加URL可达性探测；externalId/name/title不额外trim。GraphQL create即使已有externalId也先JSON.parse，只有service进入新建/补空引用分支才继续内层payload schema校验。
- GraphQL UpdateItemInput：id必填、title可选最大255、status可选、payload可选字符串。payload空串/缺省/null不更新原文；真值字符串先JSON.parse，非法→BadRequest "payload must be valid JSON"。JSON.parse结果还须遵循service真值分支和schema：需要内层校验的create分支遇标量/数组/null按NormalizedNewsPayloadSchema失败；update JSON "null"/false/0等走其原有不更新分支，不能一律转空对象。title/status nullish沿用原值，空字符串是实际值；更新不自增version。
- 内层事实源 modules/news-pipeline/news-pipeline.schema.ts的NormalizedNewsPayloadSchema：url仅trim且非空，不要求URL格式/外网；language可选trim空→缺省，sourceName可选null/trim，keywords/tags/summaryHints非数组→[]、数组元素必须string再trim/filter。metadata非对象/数组/null→{}，crawlOptions仅对象才保留；forceRefresh按JS Boolean(value)，不是只认字符串true。prefetchedArticle及内部字段按该schema规范化，去除根部未知字段。
- Mongo存储另有packages/mongo/src/models/raw-item.ts的Mongoose schema/setter：实际RawItem payload只存其声明字段，不把NormalizedNewsPayload的所有键（如未在RawItem schema声明的prefetchedArticle）盲目整包写入。RawItem source默认/显式值、timestamps、URL comparable字段都按实际模型保持；outbox可保留其自身schema允许的字段。
- payload错误保持首条schema错误的 "Invalid payload: ..."，不要新加URL/状态枚举约束；HTTP DTO与GraphQL DTO校验错误沿既有格式。Item缺失 "Item not found"；task缺失 "crawl task not found"；单结果ID resolver trim空→"resultId is required"，service空ID→"crawlResultId is required"，缺结果→"Crawl result not found"。
- ingestToItems启用额外校验在task存在后、比较旧状态前执行，无items.write→403 "items.write permission is required to enable ingestToItems"；关闭只需crawl.write。同值直接返回，不更新/不审计。启用合并config.ingestToItems=true，关闭删除此键，其他键保留，删空后MySQL SQL NULL（Prisma.DbNull），不是JSON null。
- 可扩展metadata/crawlOptions/config叶子用json.RawMessage及小型具名JSON成员辅助；固定业务字段/DTO/数据库行/缓存/job/audit必须具名强类型，不新增any/interface{}/map[string]any/[]any。既有GraphQL/驱动协议边界可沿用。

## 5. 人工创建/编辑：MySQL事务和即时投递

完整依据 ItemsIngestService.create、ItemsService.update、RawItemOutboxService 全方法及 packages/db/prisma/schema.prisma：

- ItemMeta唯一键(orgId,externalId)。新建显式默认status=pending（不要用表默认draft）、mongoRef预分配ObjectID、version=1、sortAt/createdAt/updatedAt；MySQL事务内创建ItemMeta与MongoOutbox raw_item pending/attempts0/availableAt now，提交后best-effort审计，再deliverNow。MySQL不是与Mongo/Redis的分布式事务。
- 已有externalId且mongoRef非空：不覆盖旧名称/status/payload，不先校验新payload，尝试该item的pending补偿后返回旧meta/rawItemId。mongoRef为空时，先规范化payload，再org+id+mongoRef="" CAS绑定新rawId并同事务插Outbox；竞争失败重读赢家引用并返回，不删除赢家。唯一键并发冲突按Nest重新查本组织已有记录，不直接500/409，也不加分布式锁。
- update先查本组织meta；MySQL事务更新name/status，只有规范化后payload存在才分配新rawId、更新mongoRef并插raw_item Outbox(source="graphql")；commit后deliverNow，再hydrate读模型，再best-effort item/update审计。保持返回的是业务更新返回值与新mongoRef，不悄悄等同于处理完成；旧raw不立即删除。
- create原文source="api"，审计resource=item/action=create；仅新建分支写此审计，重用已有externalId不补造。update metadata按原DTO/规范化payload保留缺省差异；审计失败继续写兼容AuditLogOutbox，消费者归#92/Nest，禁止吞掉必要审计生产。
- deliverNow的存储/入队失败应按原Outbox协议记录重试并返回false，人工创建仍可返回已提交meta；不要擅自回滚已提交SQL或承诺processed已完成。update随后的hydrate错误传播与create分支不同，按源码保留。

## 6. 采集结果导入：分页、批处理、竞争与清理

完整依据 CrawlTaskService.ingestResultsToItems、ItemsIngestService.createFromCrawlResult/createFromCrawlResultsBatch及items.shared.ts：

- 先org+task校验；after字符串trim，limit默认50，有限Float先floor再钳制1..200；onlyMissing仅显式false关闭，缺省/null为true。按fetchedAt DESC,id DESC读取take+1，after沿Prisma row cursor语义，不擅自变offset或只按id比较；缺失cursor行为按基线核实复现，不额外发明跨task cursor错误。数据始终限定已授权task。
- scanned是原page长度；onlyMissing按本组织externalId="crawlResult:<id>"且mongoRef非空批查/跳过，不以status或任务计数代替；attempted为剩余候选。nextCursor只在hasMore时取原page末ID，即使全页跳过/失败仍前进；不是成功结果末ID。
- 单条result入口按task.orgId范围查结果；批量内部预载来自已授权task的行。结果ID trim/去空/保序去重；批查已有meta、批量createMany skipDuplicates后重查；现基线批量新meta用UUID，人工create沿既有ID策略，不对已存在ID做格式假设。
- payload来自sourceUrl、task.itemPayload.sourceName/language/tags/summaryHints/metadata、结果metadata与task keywords；sourceName覆盖优先于displayName，language优先payload再metadata.language/lang；metadata按itemPayload→result→明确crawlTaskId/displayName/targetUrl/crawlResultId/fetchedAt/contentHash合并，forceRefresh=false。pipelineJobId从task.config，sourceId从itemPayload.metadata，priority为有限数字Math.round；名称trim后最多191（JS UTF-16切片190再trimEnd加…）。保留toStringArray处理string/number及原去空语义，不暗中去重tags。
- 已有mongoRef仅在status pending/processing/failed时尝试enqueue，completed/duplicate/draft不重入；原行为不自动retry已failed BullMQ job，不能额外打开retryIfFailed。已有ref分支不重新写raw，不补造create审计。
- 缺mongoRef分支是**直接Mongo批量插入**，与人工create的SQL Outbox分支不同，不能假装两者都是Outbox：先RawItem校验/预分配ObjectID→unordered insertMany→按ID读回确认实际成功→SQL CAS mongoRef=""；CAS输家只删自己刚插raw并读赢家，不能删赢家数据。校验/插入失败逐项rejected；只清理由本进程新建且仍mongoRef=""的空meta。清理须保留org与空引用条件，不能删已绑定meta。
- 对CAS赢家按原时点写createFromCrawlResult审计、enqueue、hydrate；单项失败保留部分成功，不整页回滚或全部报成功。并发上限复用CRAWL_RESULT_INGEST_CONCURRENCY=8，输出按请求ID顺序。单条入口将该项reason转对应错误；批量入口聚合ingested/failed，不把个别失败变整页异常。
- updateCrawlTaskIngestToItems保留task视图/count/配置及resource=crawlTask/action=updateIngestToItems、metadata{taskId,enabled}审计；本批只设置开关，未来自动采集仍由原Nest执行器读取，不宣称该执行器已迁。

## 7. 真正兼容的 itemPipeline producer，不迁 worker

事实源 modules/queue/queue.service.ts enqueueItem/resolveStableProcessedItemId、queue.module.ts/queue.constants.ts/queue-org-stats.service.ts、common/bullmq-retention.ts。当前Go没有可复用的BullMQ producer；Redis read/自建List/asynq不等价，不能调用NestHTTP“代入队”并记迁移完成。

- 队列itemPipeline、prefix bull、job name process-item，jobId="<itemMetaId>-<rawItemId>"；job data为具名itemMetaId/rawItemId/orgId/traceId/processedItemId，可选pipelineJobId/sourceId。保留trace传播，不能信任业务payload里的orgId覆盖身份。
- 入队前复用本组织/itemMetaId按createdAt DESC的最新ProcessedItem._id为stable processedItemId，无记录/既有查询降级分支才新ObjectID；入队后按源码best-effort upsert pending ProcessedItem（已有文档不重置status/result，仅更新trace/可选关联/updatedAt），ObjectID/BSON类型与timestamps准确，不每次造一条pending压住旧处理结果。
- opts保持removeOnComplete=true、removeOnFail={age:604800,count:10000}、attempts=5、backoff exponential/2000ms，以及本链可选priority。保留BullMQ对非法priority的错误，不盲目clamp。重复job必须沿BullMQ去重语义，不重复插wait/prioritized，不自动重跑旧failed job。
- 使用锁文件BullMQ5.63.2的官方addStandardJob/addPrioritizedJob及必要includes做限定producer适配，或证明等价的成熟兼容实现；优先把这两条官方Lua及递归include展平为可审查的固定版本资源，保留出处/版本/许可证和摘要，运行时不下载代码。Scripts.addJob的keys顺序、packed args/opts是MessagePack，不是JSON；使用成熟固定版本MessagePack库，不手写编码协议。此链不需要实现repeat/flow/consumer框架。
- 必须保留官方原子脚本对pause/maxed、priority/pc、marker、job hash、id、events及重复任务的行为，不能简化为HSET+LPUSH，也不单独再发added/waiting事件。核实queue.module默认选项及Job.validateOptions；这里只声明标准/priority两分支，不默默扩大支持其他JobsOptions。
- 除BullMQ自身key，还需复现QueueOrgStatsService.upsertJobMetaAndCount原Lua：queue:itemPipeline:job:<jobId>:meta（TTL7天）与queue:itemPipeline:org:<orgId>:counts（TTL30天），初始waiting、keepCompleted=0/keepFailed=1；重复状态不重复计数、转换原子，错误按原日志/best-effort。原Nest org-stats事件订阅、QueueEventPublisher及worker继续负责后续状态，不迁/停止它们，不发布第二份gqlsub事件。
- 入队失败对Outbox走失败补偿，对采集单项走rejected；不能为了返回成功丢入队/计数/ProcessedItem步骤。Node消费者执行后的索引/模型/清洗仍是必要Nest依赖，记录未实跑外部服务。

## 8. RawItem Outbox：同步、补偿与所有权

原协议是MySQL MongoOutbox(type=raw_item)，payload具名type/orgId/itemMetaId/rawItemId/source/NormalizedNewsPayload，可选pipelineJobId/sourceId/整数priority。不得消费processed_item或其他表。payload.orgId必须等于行orgId；非法schema标dead并attempts+1，只有有可信解析payload时才做关联失败补偿。

- deliverNow按ID读/校验后CAS：pending/failed要求availableAt<=now，processing仅lockedAt<now-5分钟；同事务status→processing、lockedAt now、attempts+1、lastError清空并读回。未认领返回false，不额外强行重试未来availableAt。
- 认领后用指定rawId创建RawItem；duplicate-key11000且该_id存在沿原幂等规则处理，不能覆盖原文。Mongo成功→applyRawItemPersisted（兼容enqueueItem→hydrate）→删除该outbox；中间任一步失败保留行供重试，不能先删Outbox或跳过入队。
- Mongo写入还要复现Mongoose pre-validate的urlComparableFull/fullHash/base及字段null语义（packages/mongo/src/url-comparison.ts）：仅HTTP(S)，去fragment、小写host、尾slash规范、full保留query/base去query、SHA256(full)。无效URL三字段null，不能因为不是URL就额外拒绝原已接受payload。
- 每分钟原retry：pending/failed按availableAt、processing按5分钟stale，三组各取50再按createdAt ASC,id ASC去重合并前50，顺序执行；10次dead。退避round(30000*2^(min(attempt,5)-1)*(0.5+random))，失败status=failed、lastError、availableAt、lockedAt清空；错误写状态的失败沿原日志语义，不造新重试框架。
- dead有效payload补偿：只有org+itemMetaId+mongoRef仍等于该rawId才将ItemMeta failed；有pipelineJobId才org范围更新PipelineJob failed/error/completedAt；不能把已被新版本替换的条目回写failed。成功删除、失败保留，与回滚保持协议兼容。
- 后台owner新增API_GO_RAW_ITEM_OUTBOX_MODE（空/legacy/go、默认legacy、非法值双端启动失败），与HTTP/GraphQL写模式分开：可先单独切补偿消费者，API_GO_ITEMS_INGEST_MODE=go不要求必须同时开后台Go；即时deliverNow始终由执行该业务请求的实现负责。Nest原同步deliverNow/forItemMeta继续服务其旧请求，Go同步与定时调用靠既有行CAS竞争，这是原多实例语义，不加全局同步锁。
- 只迁**定时重放owner**：RAW_ITEM_OUTBOX_MODE=go时Nest retryPendingRawItemOutbox在取锁前退出，Go运行该Cron；其他Nest同步调用不被误停。SCHEDULE_ENABLED=false只停定时重放，不停写请求即时投递。不要依赖BULLMQ_WORKERS_ENABLED关闭补偿，也不能停Nest itemPipeline worker。
- 物理Cron锁lock:cron:raw-item-outbox，PX55000，token比较续租/释放，复用现有userdigest.NewRedisDeliveryStore公开Redis端口和既有续租方式，不复制整个digest或审计scheduler。允许多Go实例，后台只一个持锁执行。构造/退出要取消tick并drain本批，随后再关Mongo/Redis/DB。
- 切后台owner先停旧Cron并drain，再启新Go；回滚反向，保持同步CAS和已有raw/Outbox/队列协议，无需清表。两个模式开关切换/四种组合各记录，不把legacy默认当未实现。

## 9. 复用 Go 水合与具体功能/查询改善

- internal/itemsreading/service.go NewService、readmodel.go、mongo.go已有hydrate/UpsertReadModels、raw绑定、sourceId推导、ItemMeta/Processed模型，但hydrateItemReadModelsBatch是私有的。增加具名窄port复用，不重写一套read-model写入；可提供只需DB/Mongo的hydrator构造，避免后台补偿模式强开JWT或HTTP读/ES/LLM客户端。
- 已确认GAP-ITEMS-001：Go hydration的loadProcessedSnapshots调用ListLatestProcessedSnapshots，后者固定status=completed且投影不足；Nest loadProcessedReadModelSnapshots按org+item IDs取createdAt DESC,_id DESC的最新**任意状态**和完整snapshot字段。它会遗漏新pending/failed或沿用旧completed内容，不能直接导出旧helper就当写后水合齐备。
- 本批修hydration专用路径：对本批ID集合用Mongo侧sort/group取每item最新任意状态及所需snapshot字段，含rawItemId/pipelineJobId/sourceId/error/llm/updatedAt等；保留org约束、raw双向绑定、source解析、缺snapshot用$unset而非null，沿用原500批/有序ID映射。不要修改供搜索/RSS/排序使用的completed-only helper或改变其取样语义，不开全库回填。
- 第二项改善deliverPendingForItemMeta：原实现先取本组织三状态前50再筛payload.itemMetaId，目标可能长期被其他条目遮挡。Go查询先加org/type/状态/JSON itemMetaId精确条件，再按createdAt,id取50，保持每行认领/到期判定；只补当前item，不扩大batch/加新扫描服务。非法payload仍按相应投递入口处理，不伪造修复。
- GraphQL返回复用graphqlread/itemsreading/projection.go现有按Selection投影与批读取，增加公开窄入口，补只注册Item/CrawlTask所需模型的方法和五字段权限；不重复实现resolver遍历，不注册原查询，不改四订阅占用的contract/exec。

## 10. 独立开关与公共接线

- API_GO_ITEMS_INGEST_MODE、API_GO_RAW_ITEM_OUTBOX_MODE均接受空/legacy/go、空默认legacy，非法值启动失败。写模式需MySQL/JWT/Redis/Mongo；后台模式单开只需MySQL/Redis/Mongo，不要求JWT/任何HTTP或GraphQL读写模式。资源不足/DSN非法明确启动失败，不能nil服务后回Nest并记完成。
- 写模式独立为POST精确/api/items装配Go handler，不吞GET/OPTIONS/更长路径；GraphQL顶层route/handler OR必须包含本写模式，模型/服务资源同时补齐，READ/ITEMS_READING/SETTINGS_CRAWL_READ全legacy仍能完成五Mutation。含未接管root/嵌套字段整份operation在任何写之前回Nest；不部分执行后代理。
- 检查写模式单开、后台单开、两者go、全legacy，以及与已合写模式/四订阅同时开。shared Mongo只初始化/关闭一次；后台hydrator不因JWT未开而nil，也不强开搜索/模型服务。
- Nest env.schema/getter和Compose只注入后台owner开关及必要已有SCHEDULE_ENABLED，Go注入两个模式；默认legacy，Web→Nest/canary维持现状。ScheduleEnabled若已由#92落地则复用；尚未落地只补最小共享字段并保留并行并集，不复制审计业务。
- 在startup错误、HTTP listen失败、SIGTERM都保证停止新tick/后台任务并drain，再释放本批资源、共享连接；不得漏后台在sharedMongo/Redis关闭后继续enqueue。回滚写模式legacy后新请求回Nest，后台owner另按第8节切换，队列里已入任务继续由Nest消费。

## 11. 精简验证、CI与依赖

- 本机不安装依赖，不运行build/test、Docker或服务，不读真实.env/生产凭据，不调用真实模型/crawl4ai/ES/vector/SMTP。允许静态review、普通格式化和git diff --check。Go业务强类型，新增/修改源码注释英文，文档/提交/PR中文；重点迁移，不堆防御性校验、锁或兼容框架。
- 需要MessagePack等新Go依赖时，选择核实过的固定版本，仅编辑go.mod，复用现有go-modules-regen label远端tidy/build/生成go.sum，普通同步机器人提交、移除label再等最终head CI。本机不go get/tidy，不覆盖他人依赖。
- 少量行为验证交现有普通CI：DTO和payload真值/null差异、幂等externalId/CAS赢家与事务Outbox、跨组织result拒绝、分页全跳过仍前进/部分失败、无items.read写返回字段、原文持久化后入队失败恢复、dead不污染新版引用、最新pending/failed水合与缺snapshot unset。
- producer新协议必须有真实Redis命令验证：在**现有ci.yml api-go-user-settings-integration job**复用Redis7.2增加pipelineenqueue integration测试命令，保留原usersettings/authz命令。覆盖standard/priority、pause、重复job、MessagePack脚本参数/job hash/options/events/marker与org计数原子语义；不新增job/workflow/服务，不把Redis命令通过说成Nest worker/外部内容处理已实跑。普通Go测试可用现有假store验证业务分支，不镜像实现或源码文本断言。
- 按AGENTS只读静态review本批类型/契约/事务、org与raw引用、幂等竞争、真实队列副作用/关闭、共享开关并集。最终精确head普通CI及所新增Redis用例都要记录状态/链接，skipped不算通过。没有真实Mongo/双端owner切换/Nest完整worker/外部服务/部署证据就明确未验证，不伪造。

## 12. 任务记录、Ready PR与交付

只维护自己的docs/refactor/migration-map/tasks/ITEMS-INGEST-001.md和专用docs/refactor/go-items-ingest.md，记录实际基线/范围/状态、两模式资源/回滚、raw补偿与Nest worker所有权、两项改善、源码定位、PR/head/CI及未验证边界；原始prompt保留。编码窗口不重复改共享地图索引/模块/AUDIT/GAPS/BACKLOG/DEPENDENCIES或他人task，由规划窗口集中回填；提供可直接回填的事实。PR开着只标pr_open，未实际main合并不能merged或关闭整个GAP-ASYNC-001。

只提交本任务改动，中文emoji + type(scope)，正常commit/push，创建面向main的Ready PR。说明六入口的用户结果、即时/补偿/直接批写三路径、官方BullMQ producer边界、最新状态水合、两个独立开关及验证证据。远端生成/普通CI失败在本任务内修复后记录最终head；不合并、不auto-merge、不amend/rebase/force-push，不创建其他Codex对话、跨对话消息或定时任务。

最终交付Ready PR URL/最终head/最新main基线、六入口及必要副作用完成表、后台owner与Nest消费边界、普通CI/真实Redis用例结果、回滚和未验证项。完整链路都落地才交付，不以注册数/只写Outbox/只存Mongo/CI绿灯代替真实入队和状态收口。
