# 目标

执行 ITEMS-LIST-001：把完整 GraphQL Query items 迁入 apps/api-go，使条目列表的筛选、页码/游标翻页、时间排序、相关性搜索、个性化排序及嵌套内容投影都由 Go 完成。不能只把现有 REST Service.List 包成 connection 后宣称完成。

专注迁移和功能实现，不做防御性编程，不增加与契约无关的校验、锁、重试、熔断、兼容层或框架。保留现有鉴权、租户隔离、业务校验、分页上限和错误语义。新增/修改源码注释全部用英文，关键分页/算法/数据绑定处写清原因与契约；不逐行翻译代码或堆模板注释。文档、提交和 PR 描述用中文。本次只做后端，不改 Web UI/生产入口。

## 一、基线、记录与独立 worktree

- 仓库 /Users/oo/project/newwei；规划代码基线 origin/main 9d0462e16d88d146b8afbf67cdd58d8b7419ff29。日期2026-10-18，Europe/Moscow。地图#69已merged，业务基线3cedce9a至此只有文档/导航变化；最新main普通CI run39127631691 success，最近五次均success。这不代表本批或实网已通过。
- 开始先fetch main取得最新SHA，查开放PR、main五次CI、worktree。读适用AGENTS.md、地图README/PLANNING/tasks/README、GAPS/BACKLOG、本任务及items/AUDIT/DEPENDENCIES相关部分；只查本域增量，不重做全仓审计。
- 任务已reserved，来源BL-05/GAP-LEGACY-001的Query items子范围；认领与本提示词发布在Ready规划PR #71，分支docs/plan-news-event-brief。尚未合main时，fetch该分支，用git show origin/docs/plan-news-event-brief:docs/refactor/migration-map/tasks/ITEMS-LIST-001.md及同目录ITEMS-LIST-001.prompt.md恢复；代码仍以origin/main为准。
- 编码分支 refactor/go-graphql-items-list；worktree /Users/oo/project/newwei-go-graphql-items-list。从当时origin/main创建，已存在先查归属/HEAD/状态并安全复用，不覆盖其他窗口，不在规划目录编码。

## 二、精确接口、权限与返回

POST /graphql，唯一新增接管root：
items(after: String, filters: ItemsFiltersInput, first: Int! = 10, orderBy: ItemsOrderBy! = CREATED_DESC, page: Int, rankingMode: ItemsRankingMode, search: String): ItemConnection!

- 根权限items.read，复用现有GraphQL身份、Redis撤销、membership/权限重推导。orgId和个性化userId只取服务端identity，不信任参数、cursor、父对象或缓存中的组织。
- 返回ItemConnection：edges为ItemEdge列表、pageInfo为PageInfo、totalCount为Int；edge包含cursor与ItemModel。空结果edges=[]、hasNextPage=false、endCursor=null，totalCount按各算法实际候选/过滤总数计算，不固定0或随手用当前页长度。
- ItemModel沿用meta/raw/processed/rawPreview/processedPreview、createdAt/updatedAt/ingestedAt/publishedAt、relevanceScore/searchHighlights等现有模型；原始payload、processed result/resultJson、DateTime、null与空数组形状保持。PublishedAt输出不能误用sortAt；sortAt是排序回退字段。
- Nested内容沿现有ScopedItemsReadingLoader/Go item投影的租户绑定：ItemMeta先orgId约束，ProcessedItem/read-model带orgId；无orgId的RawItem必须绑定已验证ItemMeta的mongoRef与itemMetaId，不能只按可伪造itemMetaId读Mongo。
- 未登录/无权限、参数校验和5xx掩蔽沿现有engine；非法分页400，超offset为400“Pagination offset is too large”。向量硬失败保留VECTOR_SEARCH_UNAVAILABLE；必要rerank失败503/RERANK_UNAVAILABLE及安全detail，不能静默返回RECENCY冒充相关性。

事实源按上述SHA：
- apps/api/src/graphql/resolvers/items.resolver.ts：decodeCursor/encodeCursor、items（351起）、queryRequestsTotalCount、toItemModel及嵌套ResolveField。
- apps/api/src/graphql/dto/item.input.ts：ItemsQueryArgs/ItemsFiltersInput/ItemsDateRangeInput及枚举。
- apps/api/src/modules/items/items-list.service.ts：list/listWithCursor、所有personalized方法、loadCandidateFeatures/画像规范化。
- 同目录items-search.service.ts：resolveScopedIds、listByRelevanceWithPage/Cursor、rankScopedIdsByRelevance、tryRerankCandidates/loadSearchHighlights；items-search.helpers.ts、items.shared.ts。
- items-read-model.service.ts、graphql/loaders/scoped-items-reading.loader.ts、graphql/models/item.model.ts、apps/api/schema.gql。

## 三、DTO、默认值和分页规则

- first默认10，Args校验整数>=1，业务交互页上限50；orderBy默认CREATED_DESC，枚举另有PUBLISHED_DESC/PERSONALIZED。page为可空整数>=1，after/search可空String。显式null与非空SDL约束按engine处理，不自创UUID或cursor格式校验。
- after与page同时为有效truthy值时报400，原消息“Use either 'after' cursor or 'page' pagination, not both.”；不要把空after或null page擅自当冲突。
- resolver先按原始search.trim是否非空选择缺省rankingMode：非空RELEVANCE，否则RECENCY；service解析历史search payload之后，只有RELEVANCE且实际search非空才相关性排序。不能把仅含旧filter JSON的字符串当搜索词。
- filters字段sourceIds/regions/topics/sentiments/contentTypes、excludeDuplicates（默认false）、dateRange.start/end完整支持。显式非null filters优先于历史search内filters，包括{}；null/缺省回退历史filters。现有decodeFilters会把空对象归nil，新root须保留presence，不能误把{}还原为旧filters。不要顺手改变其他roots行为。
- page分支使用safePage和钳制后的take计算offset，复用已有NormalizePagination/checkedOffset的IR2上限2147483647；在搜索/缓存/DB调用前保持此既有业务限制，不加额外最大页数。
- CREATED_DESC排序createdAt DESC,id DESC；PUBLISHED_DESC排序sortAt DESC,id DESC，read-model对应itemMetaId。cursor为base64(JSON)：时间模式带id和createdAt或sortAt；RELEVANCE/PERSONALIZED带id和offset。日期ISO毫秒格式与Nest一致。
- 解码兼容旧base64纯id与新JSON；无法解码、JSON无有效id等按Nest视作无cursor，不统一抛400。可用timestamp缺失时按orgId查询cursor行；受限id集合不包含cursor、cursor行缺失、排序时间缺失等分支及totalCount按源码保留，不能一概返回第一页。
- 时间游标用时间+id复合边界和take+1确定hasNextPage，不能用普通offset替代；page分支hasNextPage为page*pageSize<total。
- RELEVANCE cursor优先在当前排序中找cursor id，再回退offset+1，负offset按原规则归起点；PERSONALIZED优先有效非负offset+1，没有时查id。两种顺序不同，不合并成一个“通用游标”。

## 四、完整查询和算法工作

1. 复用已迁检索/过滤
- Go internal/itemsreading已有ParseSearchPayload、ResolveScopedIDs、MySQL/Mongo/read-model、ES/vector召回。先重用；候选召回顺序不是最终相关性排名。
- 基础集合继续orgId且ItemMeta.status非Duplicate，Mongo完成态/过滤/read-model语义按当前源码。restricted=true且ids为空立即返回合法空；无筛选与空集合不能混淆。
- ITEMS_READ_MODEL_ENABLED两分支均完成：Mongo read-model与MySQL ItemMeta + Mongo内容。不能为方便要求read-model开启或只支持历史数据。

2. RELEVANCE
- 原配置ITEMS_SEARCH_RECALL_MAX_CANDIDATES默认120、RERANK_MAX_CANDIDATES默认40且不超recall、RERANK_ENABLED默认true、RERANK_TIMEOUT_MS默认300、RECENCY_HALFLIFE_HOURS默认48，保留现有env语义。
- 限定召回候选、加载具名feature/document；按Nest从title/summary/topics/entities拼文档，topic/entity各前5；旧processed result字段别名与read-model特征分别处理。
- lexical/recency/sourceTrust/quality算法按helpers；预排lexical*0.7+recency*0.3，取rerankMax；rerank返回score按min/max归一化，跨度很小时按原规则处理。未进入rerank的候选仍用lexical，不把它们删除。
- finalScore=0.55*baseRelevance + 0.25*recency + 0.15*sourceTrust + 0.05*quality，钳制0..1；quality缺省0.5、sourceTrust缺省0.6，来源匹配表照items.shared.ts。recency是指数半衰期，与personalized的36小时公式不同。
- final按score DESC、sortAt DESC、id localeCompare ASC稳定排序，保留relevanceScore与页面ES highlights。只有highlight读取失败按原行为可缺省，不能把rerank失败同样吞掉。
- 使用已有llmembed.NewClient/Rerank基础，必要时新增具名调用options/观测表面以支持该请求的timeout（至少100ms）、每模型maxRetries=1、metadata orgId/source=items-search-rerank及真实日志；旧调用签名/默认行为保留。不能直接使用现有profile长timeout/多次retry来替代本链路契约。
- rerank禁用或没有可用文档按Nest跳过；启用且模型/网络/无有效分数失败时503/RERANK_UNAVAILABLE，原消息“Reranker unavailable: failed to rank relevance results.”。不能回调Nest或改成空结果。

3. PERSONALIZED
- 复用newsbehavior.NewService(db,redis).GetPersonalizationProfile(orgId,userId)已有Redis窗口/衰减画像，不重建行为API，不在读取时记录点击；只把positive/negative六维转为本域具名类型，别把旧Meta动态结构带进新业务。
- 候选MIN=180、MAX=1600、MULTIPLIER=8。total=min(rawTotal,1600)；target取所需窗口；按sortAt DESC,id DESC增量游标召回，过滤/去重后不足再扩大窗口，不能只查固定180条造成深页提前结束。
- batch/read-model读取特征source/domain/topics/entities/eventIds；按当前规范化和条数上限，NewsEventItem带orgId。画像term分数按正有限值排序最多400，保留source/domain回退与ID大小写规则。
- recency=1/(1+ageHours/36)。source/topic/entity/item/event/domain权重为1.15/1/0.9/1.45/1.2/0.75；behavior=log1p(max(0,positiveRaw))-log1p(max(0,negativeRaw*1.15))；final=behavior*0.78+recency*0.22，无画像时直接recency。
- topics/entities各前6、events前4求和，source preference取source/domain匹配较大值；source特征的domain路径不要漏。分差阈值0.0001，其后sortAt DESC、id ASC，rankOffset按最终顺序。无userId时原service才回退CREATED_DESC，不能忽略已认证用户画像。
- page/cursor的total、hasNextPage、去除已不存在行、rankOffset按原分支返回，不擅改成不限量候选或设计跨请求快照缓存。

## 五、Go复用、批量投影和必要副作用

- internal/itemsreading/service.go的Service.List仅REST RECENCY；保留它的现有行为，在同包新增具名GraphQL列表查询/结果、游标与排名能力，复用store/search/read-model函数。不得改变REST接受的排序枚举或默认。
- internal/graphqlread/itemsreading/{register,models,queries}.go已有5个root、ItemModel及嵌套转换。新增RegisterList与ItemConnection/ItemEdge类型，复用PageInfo；Registry.HasType已存在，避免覆盖已注册公共类型与字段权限。
- 不为每个edge循环调用单条item()形成N+1。新增本页批量读取/映射，复用ProcessedByKeys、read-model投影与原文绑定，批量查eventId/duplicateOf，按原status/最新文档优先级和fallback生成嵌套模型。
- 本批具体查询优化：按选中字段决定是否COUNT/加载processed.result及本页批量内容，避免“只取id也加载所有原文/处理结果”；保持已有Nest的选择语义及租户约束。
- 当前contract.Context只有Ctx/Identity/Args，不能声称已有selection表面。允许在graphqlread/contract与exec增加最小只读选择元数据（具名字段/路径集合），利用已解析AST和现有字段收集处理alias、fragment、@skip/@include；只给resolver传递真实选择需求，不重写executor或引入新的DataLoader框架。
- totalCount被选中（含alias/fragment）时计算正确总数；未选中可按Nest省COUNT；不会因此关闭其他必须用于排序/pagination的count。分页投影不得把未加载当作业务不存在。selected raw/processed等字段的null/错误传播应对照现有resolver/loader，不因查询了未选字段而让根失败。
- 数据：MySQL ItemMeta/ProcessedArticle/NewsEventItem/SystemSetting，Mongo rawitems/processeditems/item read-model，Redis既有搜索/embedding缓存及org+user画像。读取可能填充这些已有缓存，保留键/TTL，不新增平行的排序结果缓存或缓存生产者。
- 新rerank请求保留Nest LiteLlmService.rerank的必要请求日志：orgId、实际model/attempt、status、latency、usage/cost未知null、profile/governance/authMode、apiSurface=rerank及过滤后的source metadata，best effort写llmrequestlogs；失败不能改变成功查询结果，不能记录原文/密钥。日志过滤依据既有llm_request_log_settings策略。
- NEWS-BRIEF-001拥有llmlogs writer文件，不能依赖其未合并接口或抢改该包。本批可在itemsreading新增隔离rerank日志文件，通过llmembed具名观测结果写入同一已有集合；只处理本链路的日志，不另建通用日志框架、不统一所有embedding/LLM调用。必要时仅只读llmlogs.MetadataPolicy的既有表面。
- ES、vector与embedding/rerank是实际外部边界；沿已迁召回的fallback/VectorHardFail规则，实网未验证。没有BullMQ、cron、后台索引、RSS翻译、create/update/导入或流水线执行权，不迁移这些任务。

## 六、开关、资源、接线与回滚

- 新增独立子开关API_GO_GRAPHQL_ITEMS_LIST_MODE：空/legacy/go，默认legacy，非法值Load失败。仅决定items root，不能影响已迁5读。
- go明确要求API_GO_GRAPHQL_READ_MODE=go且API_GO_ITEMS_READING_MODE=go；父模式不满足则Load报依赖错误，不静默启父模式。legacy不注册items，含它的operation在任何resolver/副作用前整份回Nest。
- main只在已有itemReadService/ itemsgraphql.Register旁按新子开关调用RegisterList，复用同一service/DB/Mongo/Redis/auth；个人画像在同域懒用已有newsbehavior服务。无需强开USER_NEWS_BEHAVIOR_MODE、WORKSPACE_READ、公共门户或任何写模式。
- 不添加顶层GraphQL路由/资源OR，不修GAP-GQL-001。父模式已保证资源；只开写或禁用items列表不应加载本批业务或调用模型。
- WORKSPACE_READ开/关都能完整注册返回模型，不重复注册ProcessedItem共享模型。与#70/各写模式并存，未知root/Mutation/Subscription仍按原预规划回退。
- Compose/示例只新增本变量默认legacy；Web→NestJS和canary=0不变。回滚仅改ITEMS_LIST_MODE=legacy，其余5读及REST不受影响；不删数据库/缓存，无schema迁移和新后台关闭逻辑。

## 七、允许文件与并行隔离

主要拥有internal/itemsreading的列表/游标/相关性/个性化/批量store与投影；graphqlread/itemsreading新root/模型/批量适配；llmembed仅必要rerank options/观测扩展，newsbehavior只复用现有API。

公共允许范围：
- graphqlread/contract/contract.go与exec的最小只读选择元数据；不改Mutation执行顺序、预规划、权限、错误格式或其他root的默认逻辑。
- config.go仅新子开关及父依赖校验；main.go仅已有items注册块与对应日志；必要README/env/compose单项记录及少量现有CI测试。
- 本任务/提示词、items域、相关GAPS/BACKLOG/AUDIT/DEPENDENCIES/EVIDENCE增量。

并行占用：
- #70 WORKSPACE-WRITE-001 OPEN/Ready，head adb765d0180e8b34910181e8c6fde8be400a2dff，保留工作台8写、alerts/history/workspacewrite与GraphQL顶层接线。本批不改其业务/模型/exec mutation_test.go。
- NEWS-BRIEF-001已发出且本机已见开发差异，保留newsevents/publicportal/llmlogs与news Register块。不能依赖其未合入新API。
- STORAGE-MEDIA-001已发出，worktree已创建，保留objectstorage/infrastructuresettings/crawlreadtelemetry/settingscrawl注入及诊断HTTPmode；本批不改这些包、S3依赖或storage mode。
- 本批不使用go.mod/go.sum，不与S3远端依赖生成抢清单；不改来源策略、导出、REST契约或条目写/worker。
- main/config/compose按语义段最小增量保存所有任务并集；第三批只占items列表段。共享engine选择元数据在规划记录登记本任务所有权，其他任务如新改同段，先做独立业务，再等先行稳定提交/落main后普通merge，不整段覆盖、不rebase。
- 开工和最终接线前重新查PR真实diff/本机工作差异。无PR不代表无占用；若同范围已完成，缩小到具体剩余功能，不重复派发。不要自动创建对话/跨窗口发消息/定时任务。

## 八、精简验证、记录与Ready PR

- Go业务DTO、游标、排名特征/结果、缓存、模型调用/日志用具名强类型；禁止any/interface{}/map[string]any/[]any承载新业务，通用GraphQL/驱动协议边界沿用，扩展JSON叶子可json.RawMessage。
- 英文注释重点覆盖：两阶段ranking默认值、不同游标优先级、分页tie-break、相关性/个性化不同公式、批量原文租户绑定、rerank失败不降级；每处解释必要原因，注释保持与实际代码一致。
- 不装包、不在本机运行build/test（含go build/go test）、Docker或服务；覆盖AGENTS的本地运行要求。允许gofmt、git diff --check及只读静态复核。
- 少量有意义的现有CI行为测试：page/after互斥与旧cursor；同时间id分页；filters显式{}优先；read-model开/关；完整RELEVANCE与失败503；正负画像/候选扩大/深页；batch投影跨租户与alias/fragment/skip选择；开关/模型组合。不要用大量测试、固定bug数、专用smoke或源码快照充当本批工作。
- 对普通CI记录精确head、run URL、verify/适用job结论；旧head/main成功与skipped不算本批通过。外部ES/vector/rerank、真实DB并发、部署/流量未运行则逐项注明，不伪造验证。
- 开工把ITEMS-LIST-001改in_progress，记录实际基线/分支/worktree；交付更新本任务、items精确root/算法/优化/开关、BL-05认领及GAP-LEGACY-001的本子范围。Query仍在PR时不改main覆盖数、不关闭整个跨域GAP；其他窗口任务状态不代填。
- 只stage本批改动，中文emoji + type(scope)提交，正常push，创建Ready PR；不合并、不auto-merge、不amend/rebase/force-push。必要同步用普通merge。
- 最终报告PR/head/普通CI、一个完整Query的具体能力、复用位置、批量查询优化、独立开关/回滚、原排序规则、仍由Nest执行的范围和未做实网验证。不要把REST已有6读、已注册5个root或模型类型数计为本批新增入口。
