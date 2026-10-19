# 目标

在 wei500L/newwei 完整迁移“归档摘要与检索 → 月历 → 文章详情 → 搜索结果 CSV 下载”到 apps/api-go。任务 ID：ARCHIVE-READING-001。交付三个 GraphQL Query 和 POST /api/analysis/exports/search 的两种模式，包含显示资格、分类缓存新鲜度、真实 embedding/vector/rerank 调用、缺数据准备入队、状态投影与导出优化。用户能够浏览、搜索、查看关联事件并下载归档结果。

这是工作量偏大的一条产品链，不能缩成缓存读取或 SELECT。本阶段 Go 负责查询和兼容 BullMQ 的准备生产者；现有 Nest ArchivePreparationProcessor 继续唯一拥有准备消费、显示信号补全、分类生成与写回。不把整个归档生成链记为 Go 已迁，不顺带迁 worker/cron。

## 基线、认领与工作目录

- 规划代码基线：fetch 后 origin/main **91e759b449c4511dc96d86539ea0eb258754d07e**；普通 CI39247556593 在该精确 SHA success。地图 #69 已合并，#70 工作台八写早经 #77 合入，不能重复迁移。
- 先在 /Users/oo/project/newwei 执行 git fetch origin main、git rev-parse origin/main、gh pr list --state open、gh run list --branch main --limit 5、git worktree list；读适用 AGENTS.md、docs/refactor/migration-map/{README,PLANNING,GAPS,BACKLOG}.md、tasks/README.md、本 task 与 modules/archive.md、modules/analysis.md、AUDIT 的 archive 段及 DEPENDENCIES 相关链。
- 本认领与稳定提示词发布于 Ready 规划 PR #93，分支 docs/plan-newsnow-feed；若尚未合 main，从其最新分支读取，仅把自己的 task/prompt 记录带入业务分支，不整批复制其他任务。源码始终取最新 origin/main。若 main 已前进，只核候选及共享接线差异，不重做全仓审计；已实现部分剔除，只完成具体剩余。
- 使用独立分支 **refactor/go-archive-reading** 和 worktree **/Users/oo/project/newwei-go-archive-reading**：不存在时 git worktree add -b refactor/go-archive-reading /Users/oo/project/newwei-go-archive-reading origin/main；已有则确认确属本任务后复用。不要在主 checkout、规划目录或其他业务目录写代码。此次后端专项，不扩展 UI。

## 当前事实与复用基础

本基线三 Query 没有 Go 生产注册，search CSV 整路仍 Nest；exports/items 与 exports/events 已在 main，原 ANALYSIS-EXPORT-001 不重迁。GET /api/admin/archive-preparation/status 和设置也已 Go，不重迁。

优先复用以下真实已有实现，只补窄端口，不能假设私有函数已公开：

- internal/newsnowclusteringops/{archive.go,geo.go,data_gen.go,types.go} 已有 ruleVerticalForArticle、ruleArticleInput 的规则打分/实体标签/国家识别、五栏目顺序及词典；目前只服务国内观点索引，**没有完整 region/countryLabel/per-vertical signals 或归档查询**。新增独立 archive_port.go 暴露具名只读输入/结果，复用这些规则与国家表；在新归档包补缺失部分，别复制整份词典、修改生成文件或改旧索引行为。国家英文名可复用 internal/contentsubscriptions.CountryEnglishName 或现有国家表的窄读取。
- internal/publicportal.ClassifyEventSource(label,url,policyJSON)：组织来源策略分类；SystemSetting key=news_event_source_policy:<orgId>，读失败按 Nest 默认策略。不能把公共门户的整套显示过滤直接当归档规则。
- internal/llmembed.NewClient/Embed/ContextWithModel/ContextWithMeta/RerankWithOutcome 与 internal/llmgatewayprofiles/ports.go 的 RuntimeBindings/RuntimeProfileConfig：模型配置、凭据/治理与调用。按 Nest LiteLlmService 的实际 active embedding/rerank 选择复用；配置读取不需要 settings.manage。现有 Embed 会折叠上游与解析错误，若不足以表达本链错误码，新增具名 outcome/typed failure 窄方法并保持旧调用者语义，别另造模型 HTTP 客户端。
- internal/itemsreading/vector.go 已有 VectorSearchRequest/Match 与 SearchBestEffort 的空结果/不可用区分，可仅新增 vector_port.go 暴露窄客户端构造器，复用现有 transport。**归档不要调用会退回 Mongo 的 item recall，也不受 ItemsVectorHardFail 开关改变归档失败语义。** 不修改该包的 hydration/readmodel/搜索算法。
- internal/analysisexport 的 ExportItemsCSV、query.go 参数解析、csv.go 与 handler.go 延迟提交响应；analysiscollab.ExportQuerySpecs/NormalizeQueryString；itemsreading.ListForExport/FindExportReadModels、newsbehavior 个性化。search 的 items 模式复用完整已迁导出，包括5000上限、用户画像和字段补全，不重写原两路。
- internal/dataruntimesettings/archive_status.go 已有状态读取/脱敏依据；可直接复用 internal/adminlogs.RedactSensitiveFields。GraphQL 使用现有 contract.Bind/Root/Failure、认证、选择集投影/别名/fragment/限流；无需修改执行引擎。

## 精确接口、权限与返回契约

1. Query archiveDigest(input: ArchiveQueryInput!): ArchiveDigestModel!，items.read。
2. Query archiveCalendar(input: ArchiveCalendarInput!): [ArchiveCalendarDayModel!]!，items.read。
3. Query archiveDetail(processedArticleId: String!): ArchiveDetailModel，items.read，返回可 null。
4. POST /api/analysis/exports/search，analysis.write，JWT 与既有 mtk_ 支持/吊销/RBAC 组织重推导沿现有 accountsecurity 认证；无额外 items.read、settings.manage 或平台管理员门槛。成功201，Content-Type=text/csv; charset=utf-8，Content-Disposition=attachment; filename="analysis-search-export.csv"。

orgId/userId 均来自已验证身份，输入/缓存命中/向量返回不能越过组织 SQL 和 Mongo 过滤。GraphQL 沿现有身份规则，不另发 token。未登录/权限不足/校验失败按既有传输契约，不用空结果掩盖故障。

事实源均为上述基线对应源码：
- apps/api/src/graphql/{resolvers/archive.resolver.ts,dto/archive.input.ts,models/archive.model.ts} 与 apps/api/schema.gql。
- apps/api/src/modules/archive/{archive.service.ts,archive.classifier.ts,archive-taxonomy.ts,archive-classification.service.ts,archive-classification.constants.ts,archive.types.ts,archive-preparation-queue.service.ts,archive-preparation.constants.ts,archive-preparation.types.ts,archive-preparation.processor.ts,archive.module.ts}。
- apps/api/src/modules/analysis-workspace/{analysis-workspace.controller.ts,analysis-workspace.service.ts,dto/saved-analysis-view.dto.ts} 的 exportSearchCsvStream/buildArchiveSearchRows/parseArchive*。
- apps/api/src/modules/news-pipeline/{news-content-type.ts,litellm.service.ts}、来源策略服务、packages/utils/src/{geo.ts,country-data.ts}、packages/db/prisma/schema.prisma、ProcessedItem Mongo schema、GlobalExceptionFilter。

### DTO、默认值与 null

- ArchiveQueryInput：anchorDate 必填 DateTime；region 必填 APAC/MIDDLE_EAST/AMERICAS/EUROPE/AFRICA/OTHER。search 可缺省/null、String≤200，trim 后空串表示无搜索。weights 可缺省/null/[]→全部 ONE..FIVE，最多5项；pageSize/limitPerVertical 可缺省/null，Int 1..100，优先 pageSize ?? limitPerVertical，均无则12。不能把 GraphQL 类型/DTO 非法值当服务默认。
- cursors 可缺省/null，最多5项；每项 vertical 枚举必填、cursor 可缺省/null且≤256。base64url JSON {v:vertical,o:offset}，按 Nest Number(o) 转换、有限非负取 floor；坏编码/不匹配栏目忽略，同栏目最后一个有效值胜出，不新增400。offset clamp 到该组总数；没有下一页 nextCursor=null。
- Calendar month 必填，DTO /^\d{4}-\d{2}$/；region/vertical 可缺省/null表示不筛该维度。服务校验月1..12，错误400/appCode=ARCHIVE_MONTH_INVALID，message=archiveCalendar month must be in YYYY-MM format.。日期按 UTC，保留 Date.UTC 的年份/毫秒边界语义。
- Detail 的 processedArticleId 为必填 String，不额外发明 trim/非空约束；不存在、其他组织、未 completed 或不具显示资格→null。仅分类缓存缺失时 detail 仍存在、classification=null。
- HTTP body 只有可选 queryString：可缺省/null，String≤4000；JSON/content-type/10MiB/空 body/错误封套复用现有导出 handler。NormalizeQueryString 后 mode trim/lower，只有 headlines 走归档，其余全部 items；两模式都必须实现，不能把 headlines 转发 Nest。
- headlines 参数：archiveDate 缺省/无效→本次 now，合法日期附 T00:00:00.000Z 按 JS Date 语义解析；archiveRegion trim/upper，非法/缺省→APAC；archiveWeights 逗号分隔、JS parseInt，1..5映射，空或全无效→全部5..1；q trim 后长度≥2才搜索。直接 archiveDigest 的非空单字符 search 仍触发搜索，两者不可统一。
- 返回模型逐字段按 archive.model.ts/SDL 保留 null/非空数组/Int/Float/DateTime，不直接序列化数据库行。Digest 包含五组、pageInfo 和 preparation；EventItem 无公开 rerankScore 字段，别因内部计算而扩 SDL。Detail 包含 fullEntities、nullable classification、timeline、relatedArticles。

## 业务实现：查询、分类与显示

- 读取 MySQL ProcessedArticle + Article + 当前组织 NewsEventItem；只 completed，Article.orgId 必须约束。sortAt/publishedAt 展示回退为 ProcessedArticle.publishedAt ?? Article.crawlAt ?? processedAt。事件关联取当前组织第一条，不能自行替换为其他排序策略。
- Digest anchorDate 归 UTC 当日23:59:59.999；无搜索按 processedAt DESC,id DESC 的400条键集批读，初筛 publishedAt/crawlAt/processedAt 任一≤anchor，再按最终 sortAt≤anchor。交互 targetRows=min(12000,max(pageSize*5*6,maxCursorOffset+pageSize,1200))，保留整批读可能超 target 的行为；达12000只告警并返回可用截断结果，不503。
- 每批组织限定读取 ArchiveArticleClassification，运行当前本地 rule signals，生成与 Nest 完全一致的 classificationText（Title/Summary/Topics/Entities/Location/Source/Country hint/Region hint，规范化、去重、换行顺序）和 SHA256。text hash 或 textVersion=archive-text-v2 不匹配直接 miss；非法region/vertical也 miss。taxonomy=archive-vertical-v2、pipeline=archive-hybrid-v2、当前非空 embedding/rerank 模型不一致分别标 stale；无配置模型时不凭空标 model stale。
- Digest/Calendar **只使用 fresh 分类**；Detail 可展示文本仍匹配的 stale 分类，保留存储 region/vertical 与版本/model、isStale/staleReasons/I18n keys。读取存储四类五栏目分数，非法值按0、有效值clamp；复现 selectVerticalOutcome 的强国家规则覆盖(.62/.08)、低语义(.55)/低融合(.5)和1e-9/栏目顺序 tie-break，STALE_CACHED_RESULT 只在 stale 且新判定栏目不同于存储栏目时使用。不是读时重生成或写回分类。
- 缺失的本地 region/countryLabel/full signals 根据 archive.classifier.ts 补全，保留国家候选顺序、规则正负权重、6位舍入、entityTags 前12项与去重；详情 ruleSignals 前12项和各栏目 scoreEntries/decision/stale I18n keys按源码。不要为取 country hint 偷用简化 region 推断，否则缓存 hash 全 miss。
- 显示资格批量读 Mongo ProcessedItem：_id=cleanedMarkdownRef、orgId、status=completed；result 的 content_type/contentType、category_path/categoryPath、category_method/method 具名解析。分类路径小写/去边界斜线/合并重复斜线。文档不存在与已存在但缺字段不同：仅 exists && (!contentType || (!categoryPath && !categoryMethod)) 算需 backfill。
- 来源 blog 或内容 opinion 先排除；intel[/...]、politics/geopolitics[/...] 可放行其他类型，否则只允许 news_fact/mixed。内容类型缺失才按 news-content-type.ts 的 aliases、URL/关键词/来源分数推断，不简化成一串关键词或使用条目预览的另一套归一化。显示信号内存缓存5分钟/最多200项，Go key 带org，避免跨租户缓存复用。
- missingCount=候选中“缺fresh分类 OR 需显示信号backfill”的 ID 并集；readyCount=候选数-missingCount，计数在region/weight/显示过滤之前。missing>0必须 ensureDigestCoverage；失败不抛整页，只令 preparation FAILED（保留当前已准备结果）。无缺失READY；有入队错误或存储FAILED优先FAILED；否则ready>0→PARTIAL；再用存储state或QUEUED，updatedAt存储值或now。存储worker错误脱敏，入队即时错误按现有投影语义处理，新增日志不得带凭据。
- 过滤fresh/显示/sortAt/weight/region后分五组固定顺序 EAST_SEA,SOUTH_SEA,WEST_FRONT,FOREIGN_AFFAIRS,DOMESTIC_AFFAIRS，displayName=【东海】/【南海】/【西面】/【外务】/【内务】，空组仍返回。qualityScore clamp01，缺/非有限→null且weight1；[0,.2)/[.2,.4)/[.4,.6)/[.6,.8)/[.8,1]→1..5。搜索时relevance DESC在先，再weight DESC、sortAt DESC、processedArticleId localeCompare ASC。group.totalCount/摘要totalCount是候选过滤后全组数，不是页面长度；保留每组独立offset。
- Calendar 按 UTC 月首至月末23:59:59.999，600条键集批读至穷尽，不能套摘要12000总上限。精确保留 Nest 对 publishedAt/crawlAt/processedAt 的 OR/null 条件及最终sortAt月过滤；fresh分类+显示资格+可选region/vertical后按UTC日期计数，只返回非零日期升序。发现缺分类/backfill则 ensureCalendarCoverage；入队失败只记录，不使整月失败。
- Detail 已通过组织/显示门槛后读缓存分类诊断；事件timeline按bucketStart ASC最多160，related按NewsEventItem.createdAt DESC最多12并投影各文章字段，所有关联再次组织限定。保留可能包含当前文章的源行为。**当前 getDetail 没有正文翻译、全文生成或分类冷生成调用，不从旧地图描述发明这些步骤。**

## 语义搜索、缓存与错误

- 非空 search 使用配置中的真实 embedding→vector + lexical 召回合并→rerank；无候选不调用rerank。向量限500/minScore=.55，不添加条目查询的lookback或Mongo降级；看 Nest loadSemanticMatches 实际请求，省略字段与Go DTO零值通过窄适配对齐。
- Lexical 先 MySQL MATCH(title,summary) IN BOOLEAN MODE；按源码去除 + - > < ( ) ~ " * @、token长度≥2、后缀*；失败告警后仍尝试 contains。contains以完整query+tokens顺序去重、前8项，匹配title/summary/source/location，上限240；与全文候选合并去重、上限500。所有SQL组织/状态/anchor条件保留，参数化，不拼接不受控SQL。
- semantic按cleanedMarkdownRef映射回组织限定SQL行；semantic候选先、lexical后，ID去重。lexical全文串包含得1，否则命中token比例；semantic clamp01；两者都>0时base=.6*semantic+.4*lexical+.05并clamp，否则max。matchOrigin按召回成员关系区分LEXICAL/SEMANTIC/HYBRID，不按分数是否>0判断。
- 预排base DESC、sortAt DESC，前180构造 title/summary/Source 文档 rerank，topN=本批数、maxRetries=1、source=archive-search-rerank。返回分数按min/max归一，span≤1e-9时max>0→1否则0；有rerank时relevance=.75*rerank+.25*base，其余保留base。不要丢掉180以外的合并候选。
- 复用网关profile/治理凭据、fallback models与transport；新增具名归档调用选项/观测端口保留orgId/source metadata。RerankWithOutcome必须显式传入有效profile timeout，不能以0落到100ms地板；maxRetries=1在Nest指每个模型一次尝试。embedding沿profile的有效尝试数/超时，双路径404/405 fallback仍算同一逻辑尝试。只读分类新鲜度只读配置，不对外调用模型。
- 必要模型日志不能遗漏：Nest LiteLlmService.executeEmbeddingWithRetry/executeRerankWithRetry每次真实逻辑尝试写llmrequestlogs，含success/error、org、实际model/profile/治理、apiSurface=embeddings或rerank、延迟、已上报usage/cost与metadata source。当前Go llmembed不会自动替归档落这些日志，聚合RerankOutcome也不足以还原多模型尝试；用窄typed attempt observer/outcome记录每次结果，新增internal/llmlogs/archive_search.go专用writer，复用completion.go的组织/模型归一、metadata策略过滤与脱敏/collection能力，不套用feature=gateway_probe的ProbeWriter。缺省feature沿Nest为null，未上报usage/cost为null；日志失败best effort，缓存命中不伪造上游日志。不采集凭据或查询/全文作为新日志字段，不扩展成全网关日志重构。
- 保留 archive:search 的内存/Redis两层缓存及源码key/具名payload：embedding TTL5分钟（key配置model、结果含实际model）、vector60秒（key实际model）、rerank90秒（有序候选IDs摘要）；query规范化/hash按源码，组织必在key中。上游实际模型回填不能丢；共享缓存故障best effort。现有archive:metrics:<orgId>:<UTC日期>、30天TTL及requests/rows/origins/rerank/query_length/cache命中计数继续写，不把指标失败升级业务失败。
- 保留503 appCode：ARCHIVE_EMBEDDING_UNAVAILABLE、ARCHIVE_EMBEDDING_FAILED、ARCHIVE_EMBEDDING_INVALID_RESPONSE、ARCHIVE_VECTOR_UNAVAILABLE、ARCHIVE_RERANK_FAILED、ARCHIVE_RERANK_INVALID_RESPONSE。vector (空slice,true)是合法无召回，(nil,false)不可用必须失败；不能用lexical-only、空数组或缓存兜底掩盖。按失败所处阶段映射：LiteLlm内部抛错仍属*_FAILED，只有ArchiveService拿到响应后判无有效向量/分数才属*_INVALID_RESPONSE，不能见parse error就机械用INVALID。
- 通过 GlobalExceptionFilter 与既有 Go contract.Failure 投影：503公开message为Internal server error，GraphQL extensions.code=SERVICE_UNAVAILABLE、appCode及http.status保留；HTTP保留安全code/封套/traceId/path/time。400月份错误保留原message。别把源抛错内部message直接暴露成新的503契约。HTTP必须在CSV首字节前完成全部可能失败的查询/模型步骤，避免201半份错误文件。

## BullMQ 准备生产者与执行所有权

- 新建 internal/archivepreparation，只实现本链 getJob/getState、必要 remove、standard add 与准备状态；现 main 没有可直接复用的Go BullMQ producer。ITEMS-INGEST-001计划的新 internal/pipelineenqueue 尚未落main，不能等待或修改其实现，也不借此抽象通用队列平台。
- 协议以 pnpm-lock.yaml 的 **BullMQ5.63.2** 与 Nest queue service 为准。固定官方 addStandardJob/getState/removeJob 所需Lua及递归includes，保留版本/来源/许可/摘要、运行时不下载；Scripts.addJob 的keys/packed args/opts按固定版本，MessagePack使用核实过的成熟固定版本库，不手写编码器。不能用LPUSH/HSET拼凑、asynq或回调NestHTTP代替兼容队列。官方依据：https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/scripts.ts 与同版本job.ts/commands。
- queue/name=archivePreparation，默认prefix=bull；payload为具名{scope:"digest"|"calendar",orgId,anchorDate?或month?,traceId}，jobId精确保留 <scope>:<orgId>:<date或month>。这个三段冒号格式符合该固定版本Job校验例外，不擅自换hash/id格式。沿现有trace上下文生成/传递traceId。
- 已有job在waiting/active/delayed直接返回，不重置状态TTL；其他状态按官方remove语义移除再add，受锁约束不能直接DEL。保留add的去重与pause/events/marker元数据。add opts：attempts5，backoff exponential/15000ms，removeOnComplete={age:3600,count:1000}，removeOnFail={age:604800,count:10000}；duplicate already exists分支与源一致，无额外分布式锁/自建重试系统。
- 新入队后best-effort写 QUEUED：key=archive:preparation:status:<scope>:<orgId>:<scopeValue>，JSON含orgId/scope/scopeValue/state/updatedAt ISO/errorMessage?，TTL3600；ZADD archive:preparation:status:index，score=毫秒now，全局最多200条，删最老index及对应status。兼容已迁status HTTP的组织快照读取；不要改其路由、状态统计或续期规则。
- SQL业务为只读，无新增事务/审计/分类表写入；Mongo仅另写模型尝试日志，Redis写缓存/指标/准备状态，BullMQ原子脚本是必要副作用。Nest ArchivePreparationProcessor继续 concurrency1、PROCESSING→PARTIAL→READY/FAILED，读取设置并执行分类/回填；不得创建Go消费者或修改worker owner。不要依赖 BULLMQ_WORKERS_ENABLED 停该processor，当前构造路径没有这个gate。本批无新cron/repeat。
- 独立交付前提是Nest归档模块/processor、相同MySQL/Mongo/Redis仍可用；部署文档明确“Go请求生产 + Nest消费”，不能关Nest后声称具备冷生成。回滚只退本批入口，已排队job继续由Nest处理，禁止flush/delete队列。

## 本批具体优化：headlines 导出请求快照

Nest buildArchiveSearchRows 每次getDigest重做候选/分类/显示/排序及可能模型调用，交互targetRows（pageSize100约3000、整批可能3200）也可能让导出在5000前提前结束。为导出新增请求内具名快照/读取端口：固定一次anchor与模型/分类/显示结果；非搜索扫描至既有12000预算或数据穷尽，再分组排序；搜索仍保留500召回/180重排预算，只调用一次搜索链。

从同一五组快照按“每轮每组100条、固定栏目顺序”输出，按processedArticleId去重，合计最多5000；不是把第一个栏目全部写完再写下一个。耗尽的组不重复从0读。准备缺口在本次候选上检查并至多ensure一次；worker后续更新不会在同份CSV中途改变结果，不新增持久化快照表或跨请求session。

这是明确允许的导出行为改善：非搜索可覆盖交互前缀之外、12000扫描预算内的旧结果，仍受5000输出上限；同一已加载候选集应保持原分轮顺序与CSV字节。**交互 archiveDigest 的候选预算/游标/排序不变**。以跨400批边界、旧前缀外仍有匹配、栏目不均衡/空组、>5000截断用例证明；记录新旧候选读取和外部调用次数，别虚报生产性能。

headlines CSV 13列顺序固定：processedArticleId,title,summary,countryLabel,region,vertical,weight,publishedAt,sourceLabel,eventId,matchOrigin,relevanceScore,sourceUrl。null→空cell，日期UTC ISO毫秒，数字遵JS String语义；items模式沿已迁12列。复用CSV的UTF-8无BOM、LF、无尾换行、逗号/引号/CRLF与公式前缀保护，合法负数不加引号前缀。零行返回header，不返回JSON。

## 文件所有权与并行边界

- 主业务允许：新 internal/archivereading/、internal/archivepreparation/、internal/graphqlread/archivereading/、cmd/api/archive_reading.go、独立legacyproxy精确search路由文件；analysisexport新增search相关文件/具名reader注入和必要最小handler扩展，不改变原items/events结果与开关。
- 窄复用允许：newsnowclusteringops新增archive_port.go；itemsreading仅新增vector_port.go；llmembed/llmgatewayprofiles仅本链需要的具名model/outcome/attempt端口及必要最小内部委托，llmlogs仅新archive_search.go复用现有过滤/持久化helper。不改newsnowclusteringops/data_gen.go或registry_port.go，不抽取整个地理/分类/向量框架，不以旧代码有any为由新增业务弱类型。
- 审计 AUDIT-OUTBOX-001：Ready #92 OPEN/head28c8f761a2ce4a447080414f154b567648cc6bd1，普通CI39248452603成功，尚未合main，拥有审计scheduler/owner及相应关闭。
- NewsNow NEWSNOW-SOURCES-001：Ready #94 OPEN/headcf25026ff99b26fb3bf2122cd240d4ac4021889a，普通CI39297914942成功；后续两提交含trace修复/验证文档，仍未合main，拥有source/batch/provider/relay、infra runtime reader、ops registry_port.go。不碰这些核心文件。
- GRAPHQL-SUBSCRIPTIONS-001：/Users/oo/project/newwei-go-graphql-subscriptions 已提交Ready #95 OPEN/head68a4536d37eabde0695edfe152987cadffcc41f7，首轮普通CI39301019113在Go modules drift gate失败，已加go-modules-regen label，最终head/CI须续核；尚未合main。其拥有contract/exec/workspace QueueEventModel端口及graphqlEntrypoint/main/config增量，本批只复用现有Failure.AppCode/Bind，不改contract/exec/WS入口。
- ITEMS-INGEST-001：/Users/oo/project/newwei-go-items-ingest已见itemsingest/pipelineenqueue和go.mod开发，in_progress、无业务PR；拥有上述包、itemsreading hydration/readmodel及GraphQL Item模型/投影、settingscrawl模型端口、raw_item补偿。其go.mod拟加msgpack/v5 v5.4.1，依赖版本/远端regen应核对取并集，不能等其producer落main。不能动其业务文件；本批vector新port与水合端口分开。
- 明确排除：归档准备worker/分类生成和表写入、分类anchor向量生成、ProcessedItem backfill执行器、条目写/采集入库、pipeline worker、四订阅/通用Socket.IO、NewsNow来源/热度/预热、分析三请求与analysis worker、原两CSV重迁、所有Outbox/其他cron。真实外部模型/向量服务验证另记。
- 共享仅最小增量：cmd/api/main.go、internal/config/config.go、legacyproxy规则、.env.example、infra/docker/.env.sample与compose、apps/api-go/README.md、必要go.mod/go.sum及ci.yml。读各开放PR及工作区实际diff，保留开关/资源/注册/关闭/依赖的并集；不整段覆盖。main进展后正常merge再人工解冲突，不rebase/抢改他人目录；核心冲突只暂停冲突部分，继续独立实现。

## 开关、装配与回滚

- 新独立 **API_GO_ARCHIVE_READING_MODE**，空串/legacy→legacy，go接本批四入口，非法值启动失败。所有旧读/导出/设置/worker开关为legacy时，本开关单独go也须注册三Query模型、GraphQL HTTP入口、search HTTP handler和完整资源；不能依赖 API_GO_GRAPHQL_READ_MODE 或 API_GO_ANALYSIS_EXPORT_MODE=go。
- 配置校验、sharedDB创建/错误返回、needsCredentialedGo/needsRedis、Mongo初始化、GraphQL路由OR、handler构建OR和Registry/模型注册条件全部加本开关。使用共享DB/Redis/Mongo连接，身份栈复用；items导出所需画像/现有配置独立装配。embedding/vector/rerank只在实际搜索需要时调用，不让无搜索浏览强制外部服务可达。
- GraphQL只新增本批root/模型，已迁其他读写正常并开；未知root/Mutation/非本批operation在副作用前按现有预检整份回Nest，不把入队副作用做完才回退。保留四订阅任务的graphqlEntrypoint/升级分流，别重新注册覆盖精确/graphql handler。HTTP只接search精确POST及其现有CORS/OPTIONS语义，不抢exports/items/events或/api整前缀。
- 新资源生命周期沿共享关闭顺序；不创建后台goroutine/cron，producer复用共享Redis，不能Close别人的连接。示例/Compose默认legacy、Web→Nest和canary保持现状。改开关为legacy并重启即可回退本批；Nest队列消费不切owner、不清缓存/队列，无schema迁移或数据回滚。

## 实现风格与精简验证

- 以迁移/功能为主，不堆防御代码、锁、重试框架或无关重构。Go业务DTO、结果、SQL/Mongo JSON、缓存、队列与诊断使用具名强类型；禁止any/interface{}/map[string]any/[]any承载新增业务。仅现有通用GraphQL/驱动边界沿用，扩展JSON叶子可json.RawMessage。保留鉴权、组织、校验和必要原子步骤。新增/修改源码注释英文，解释分页/快照/缓存兼容与副作用原因；文档、提交、PR中文。
- **本机不安装依赖、不运行build/test、Docker或服务**；静态审阅、gofmt、git diff --check允许。正常提交后使用已有普通CI。新MessagePack依赖核固定版本，仅改go.mod，复用go-modules-regen label远端tidy生成go.sum、接收正常机器人提交，再移label核最终精确head CI，不本机go get/tidy。
- 少量有意义行为用例覆盖：组织/权限和独立开关接线；分类hash/text失效与model/taxonomy stale的Digest/Detail差别；显示资格/缺文档vs缺字段/权重与月份边界；五组游标/过滤前准备计数；vector空/不可用/模型失败的安全appCode与真实尝试日志/缓存不造日志；快照分轮导出/5000和原CSV字节。使用具名假store/HTTP模型响应，不做源码文本或镜像实现断言，不铺庞大测试平台。
- 新BullMQ wire需要真实Redis证据：在**现有 .github/workflows/ci.yml 的 api-go-user-settings-integration job**复用Redis7.2增加archivepreparation的integration命令，保留原usersettings/authz及条目任务并行新增的命令，不新增job/workflow/容器。验证MessagePack/标准入队hash与options、wait/pause/marker/events、重复job、不移除active、completed/failed后重排、status组织shape/TTL/index与200裁剪。此通过只证明Redis协议，未跑完整Nest worker就写未验证。
- 普通CI记录最终head SHA、run URL、各job结果，skipped≠通过。真实MySQL/Mongo数据、Nest worker消费、模型/向量上游、部署/切流没有执行证据就写未验证，不能以mock/旧smoke替代。

## 文档、提交与交付

- 编码窗口只维护 docs/refactor/migration-map/tasks/ARCHIVE-READING-001.md 和专用 docs/refactor/go-archive-reading.md（必要时带本prompt）；回写实际入口/算法、Nest依赖、开关/独立组合、回滚、剩余问题、PR/head/CI。共享README/AUDIT/DEPENDENCIES/GAPS/BACKLOG/模块覆盖数由规划窗口集中回填，不要求其他运行窗口重做文档。PR未合main不标merged，不关闭整条GAP-ASYNC-001。
- 只stage自己的改动，中文emoji + type(scope)正常提交/push，创建 **Ready PR**；不合并、不auto-merge、不amend/rebase/force-push。PR围绕四入口最终行为/快照优化、兼容Nest准备consumer、独立默认legacy开关和验证证据写，不只贴迁移数量。
- 交付给用户：PR链接、最新head、普通CI及Redis协议覆盖、三个root/HTTP两模式的完成证据、具体优化、新开关与回滚、仍需Nest/未验证外部边界。遇到已有实现或新认领冲突先核事实并缩小具体剩余，不擅自改派其他域，也不要只留计划就结束。
