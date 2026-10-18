# 目标

执行 ANALYSIS-EXPORT-001：把条目与新闻事件的CSV导出完整迁入apps/api-go。用户导出的文件保留当前筛选、排序、个性化/相关性、事件热度/来源可信度、字段补全和CSV契约，每次最多5000行；不能包装交互列表后只导出50条。事件去重增加保持原结果的token索引优化。

只领取POST /api/analysis/exports/items和POST /api/analysis/exports/events。POST exports/search的headlines分支会触发归档准备，整条search继续Nest，不部分接管后宣称完成；不认领archive、采集任务/BullMQ、analysis请求/worker和Subscription。

专注迁移与实际功能，不堆防御性编程，不增加通用导出平台、锁/重试/补偿框架。Go业务DTO、存储投影、行模型、配置和响应使用具名强类型，不用any/interface{}/map[string]any/[]any承载业务，扩展JSON叶子可json.RawMessage。保留鉴权、租户、业务校验与必要事务；源码新增/修改注释用英文，解释排序、候选上限、去重等价性、CSV编码与副作用；文档、提交、PR中文。

# 基线、worktree与占用

- 仓库/Users/oo/project/newwei；最新已核origin/main=90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，普通CI39149114456成功。已合条目完整列表#74、事件简报#72和身份#79不重迁。先fetch origin main，查SHA、开放PR、main最近五次CI、git worktree list并读适用AGENTS.md；不能按旧checkout推断main。main前进只核本批/公共接线变化，不做全仓审计。
- 从fetch后origin/main创建refactor/go-analysis-export，worktree=/Users/oo/project/newwei-go-analysis-export；目录/分支已存在先核归属，不覆盖其他窗口。
- 地图docs/refactor/migration-map/README、PLANNING、tasks/README、GAPS摘要、BACKLOG.BL-08、modules/analysis、AUDIT.analysis、DEPENDENCIES相关items/事件/归档边界均需读取。本任务和稳定提示词在规划分支docs/plan-llm-gateway-ops（Ready规划PR #80，https://github.com/wei500L/newwei/pull/80）；未合时只读该分支文档，不合入其文档历史。
- 网关LLM-GATEWAY-OPS-001已有Ready #81，head0901ca15aa31d5c00e98aa5c0c3f94a201b27219，占用llmgatewayops、llmgatewayprofiles/ports.go、llmlogs和其wire；未合main，不依赖其新API。
- SOURCE-POLICY-WRITE-001正在独立worktree修改settingscrawl policy/register/写端口、settingswrite/sourcepolicy与GraphQL两处旧设置写接线；不改这些业务文件/不抢GAP-GQL-001。OIDC-LOGIN-001已reserved，authlogin/authfactors/oidclogin及SSO三入口不碰，无worktree也不能释放。
- 三批公共main/config/env/compose保留语义并集。本批只加自己的条件/注册，不重写其他接线；后合者正常merge main，不rebase。发出前与执行前都重新核认领/实际diff。不开新对话、不发跨对话消息、不创建定时任务。

# 精确HTTP、权限与响应

两接口仅POST，权限均为analysis.write；源没有再要求items.read、dashboards.read、settings.manage或平台管理员，不增加额外权限。组织/用户来自服务器验证身份，不从queryString/body接受orgId/userId覆盖。保持Nest机器令牌路径：可复用accountsecurity.Authenticator.Authorize(...,"analysis.write")与authn/authz/Redis blacklist，不能直接沿用仅接受人类JWT的analysiscollab.Authenticate就漏掉mtk_。参考cmd/api/account_security.go构造实际认证器，不复制JWT/机器token算法。

Nest Controller没有@HttpCode覆盖，两个POST成功都是201。Content-Type=text/csv; charset=utf-8；Content-Disposition分别为attachment; filename="analysis-items-export.csv"和attachment; filename="analysis-events-export.csv"。直接返回CSV流/字节，不返回JSON包装或rowCount，不新增HTTP路由。

ExportAnalysisQueryDto只有可选queryString：@IsOptional/@IsString/@MaxLength(4000)。omitted/null/空串都是无过滤导出，非字符串/超长沿现有400 DTO错误；不新增必填/非空约束。queryString trim、去开头所有?，按URLSearchParams删除savedView/page/pageSize，其余重复参数及顺序保留；复用analysiscollab.NormalizeQueryString。单值参数取第一次，多值参数取全部，不用逗号拆多选值代替getAll。

所有业务失败发生在提交CSV响应头之前：认证401、权限403、DTO400、数据库/存储异常既有500、rerank失败503等保留现有错误投影，不能失败仍201输出空CSV。真实空结果仍201且只有表头。源导出本身没有新增审计/业务表写入，不凭猜测加导出审计、任务记录或Outbox。

# 源码事实源与Go复用

Nest必须读：
- apps/api/src/modules/analysis-workspace/analysis-workspace.controller.ts的exportItems/exportEvents；dto/saved-analysis-view.dto.ts的ExportAnalysisQueryDto。
- analysis-workspace.service.ts的exportItemsCsvStream/exportEventsCsvStream、buildItemsExportRows/buildEventsExportRows、normalizeQueryString、parseItems*/parseEvents*、sortEnrichedEvents/dedupeEnrichedEvents/buildEventTokenSet/jaccard、resolveEventTitle/toIsoString/buildCsvStream/escapeCsvValue。
- apps/api/src/modules/items/items.service.ts的list→items-list.service.ts的list/maxPageSize、items-search.service.ts相关性与listPersonalizedWithPage；items-read-model读取/个人画像和真实embedding/vector/rerank边界。
- apps/api/src/modules/news-events/news-events.service.ts的getEventHeatMap/getEventAuthorityMap/resolveSourcePolicy；news-events-settings.service.ts和news-event-source-classifier.ts的默认值/来源分类；Prisma/Mongo ItemReadModel字段。

Go复用：
- internal/itemsreading的Service、ItemsListQuery/listItemsPage/listArgs/timeOrderedPage/relevancePage/personalizedPage及同一search scope/read-model/画像逻辑；internal/newsbehavior.NewService提供Personalization。现有REST List不支持完整排序，ListItems又固定MaxCursorPageSize=50，二者不能直接调用后声称导出完成。
- 在itemsreading新增小型具名ListForExport/ExportQuery等端口，内部复用已有页分支，允许本调用take=5000；不放宽REST/GraphQL交互上限，不通过循环50条反复重新排序/重复rerank，不复制第二套搜索/排序服务。导出按page=1、maxPageSize=5000的源语义一次选择候选，最多5000，不要求ranker把有限召回扩大到5000。
- itemsreading的Mongo read-model store及NewsEventItem批量关联能力可借助新具名投影端口复用；现有个人画像关联返回多个eventId，不等同导出所需最新event标题，不能误复用形状。
- internal/graphqlread/newsevents/service.go/store.go已有私有listEventRows/heatMap/authorityMap、publicportal.EventHeat/EventAuthority/ClassifyEventSource；新增newsevents/export.go等窄业务端口返回具名导出数据，不调用GraphQL root以免带入100条/300候选上限、entity截断和不同筛选默认。基础公式复用，不另起新闻服务，不修改brief/日志业务。
- analysiscollab.NormalizeQueryString、现有body/validation/error约定可复用；其Spec校验所需小型导出入口允许增加。认证使用支持人类JWT及机器token的既有端口，analysiscollab的协作业务不重构。

以上导出源码相对地图3cedce9a到当前main无业务变化。所有新增端口需自己实现，不假设已存在或引用开放PR里的新符号。

# 条目导出契约

- 参数q trim后非空作为search；order=published→PUBLISHED_DESC，personalized→PERSONALIZED，其余CREATED_DESC。无search为RECENCY；有search时ranking=recency才RECENCY，其余RELEVANCE，相关性优先于personalized分支，按源真实dispatch。
- region/topic/sentiment/contentType使用重复键所有trim后非空值；from/to有效日期分别start/end，无效忽略；dedup trim小写为hide/1/true时excludeDuplicates=true。其余参数不凭Web UI想象加入筛选。保留源日期解析、历史search payload与显式filters优先级，不能因为导出适配重写list算法。
- page/pageSize不控制导出；上限5000、page=1。ReadModelEnabled开/关、CREATED/PUBLISHED/PERSONALIZED、RELEVANCE的候选、稳定顺序、缺失行行为与既有实现保持。时间排序按sortAt/createdAt和id既有规则，不把输出publishedAt当排序键。Personalization必须传调用者userId，不能由于独立模式没接profile而静默降级。
- 选定itemIds后批量读Mongo itemreadmodels，条件同时有orgId/itemMetaId；同id首次read-model保留。取readModel.processed.id批量查MySQL NewsEventItem，orgId过滤、createdAt DESC、关联event{id,title}，每个processedId取首条。禁止每行N+1查询或跨组织补字段。
- CSV列顺序精确：id,title,source,domain,publishedAt,language,region,sentiment,contentType,eventId,eventTitle,url。
- title=readModel.title ?? item.name（显式空字符串保留，不用空值truthiness回退）；source/domain/language/region/sentiment/contentType/url等缺省空串；publishedAt取readModel.publishedAt ?? item.publishedAt，按源有效Date转UTC毫秒ISO，无效/缺失为空。eventId/title缺省空串，绝不导出内部payload/密码/完整Mongo文档。
- 复用search scope意味着可能触发已有ES/vector/embedding/rerank、Redis缓存、画像读取及read-model准备，不是纯SQL查询。保留既有fail-open/hard-fail配置和真实调用；rerank启用但失败按RERANK_UNAVAILABLE 503，message="Reranker unavailable: failed to rank relevance results."，detail按既有安全投影，不改成词法排序成功。复用itemsreading/rerank.go既有best-effort llmrequestlogs及metadata策略，不另建日志系统、不依赖#81未合writer，不重复写日志。

# 事件导出契约

- window按JS parseInt规则，默认30、有效正数上限365；status仅active/archived，其余无状态过滤；entity trim后contains。sort仅heat/credibility，其余latest；sourceType仅authoritative/mixed/blog/unknown，其余all。minHeat/minCredibility按JS parseFloat接受有限非负数，无效/负数忽略；不要照GraphQL把minCredibility强制压到100或给entity新增120字符截断。
- MySQL先按orgId、status/entity、lastAt>=now-window过滤，lastAt DESC/startAt DESC，最多取5000个候选并带items count。然后批量热度/权威补全→业务筛选→排序→贪心相似去重→最多5000。禁止先取列表默认100/300，禁止去重后额外补采到5000而改变源候选集合。
- 热度使用最近1小时/4小时事件成员、来源数与lastAt，复用已有EventHeat公式/四舍五入；权威统计窗口为导出windowDays，不是其他root的45天默认。复用组织source policy和EventAuthority，输出authoritative/unique来源数。缺map条目按源unknown/0，实际DB错误不伪装为空成功。
- 从news event settings读取forceAuthoritativeMode/forceMinAuthoritativeSources；true时覆盖请求sourceType为authoritative，并将阈值按源Math.max(1,Math.min(10,...))应用。设置读取失败沿源忽略；normalizer已有约束按原服务保持，不创造更宽业务配置。
- 缓存/规则读取按源组织key/回退与主线能力对齐；不得使用未合来源策略写端口。必要的只读适配放newsevents导出端口，不改settingscrawl/policy.go或writer、不更改共享state结构。保存策略/读取缓存不代表新闻生成或归档准备已迁移。
- 筛选sourceType、minHeat、minCredibility、强制权威源数后稳定排序：heat按heat DESC→credibility DESC→lastAt DESC；credibility按credibility DESC→heat DESC→lastAt DESC；latest按lastAt DESC→heat DESC→credibility DESC。保持初始相同键顺序，不新增无关tie-break或改变业务排序。
- title取trim后非空的title→summary→primaryTopic→primaryEntity→id；token去重仍用原primaryEntity/primaryTopic/title，不改成这个fallback标题。
- CSV列顺序精确：id,title,status,primaryTopic,primaryEntity,startAt,lastAt,heatScore,credibilityScore,itemCount,authoritativeSourceCount,uniqueSourceCount。时间UTC毫秒ISO，缺文本为空、源数值默认0，数字字符串不额外固定小数或本地化。

# 具体算法优化：保持等价的事件去重

- 源流程是按上述已排序结果依次考察，仅与已保留事件比较；startAt或lastAt任一距离<=5天且token Jaccard>=0.74即丢弃当前事件，不是聚类后任意保留一个。
- token：entity/topic/title拼接、小写，非[a-z0-9及中文U+4E00..U+9FFF]替换空格；分词后只保留长度>=3或含中文的token，先取前24个再Set去重。空token集合相似度0，保留全部；不能使用向量/LLM或修改阈值。
- 实现“token→已保留事件索引列表”的倒排索引，只对共享至少一个token的已保留候选再做原时间条件和精确Jaccard比较；新事件被保留后才加入索引。保持原输出顺序、5天OR条件、>=边界及贪心语义；不能把被丢弃事件加入索引导致传递去重。
- 5000条事件下可减少无共享token的无效两两比较；不宣称最坏复杂度必然线性。优化限定本导出路径/窄helper，不重写既有GraphQL newsEvents的筛选/候选契约。
- 用少量固定/生成数据对比参考贪心算法的保留id序列，覆盖跨5天、阈值、空集、重复token、被丢弃事件不参与后续判断；这是等价性验证，不建设新benchmark平台。

# CSV编码与错误时机

- 按源使用LF分隔，UTF-8、无BOM、无结尾额外换行；空结果只表头。单元格含逗号/双引号/CR/LF才加双引号，内部双引号加倍；保留原空格/文本。若用encoding/csv，要处理其默认引用/末尾换行与源不同之处，不能只说“合法CSV”就改变字节契约。
- 对字符串先按源JS whitespace跳过开头空白检查：若以=、+、-、@开头且不是^-?\d+(\.\d+)?$的普通数字字符串，则在原全文前加单引号后再CSV转义。合法-12/-0.5保留，+12、-1e3、=SUM(...)按源处理；不要对整行粗暴加引号代替防公式语义。
- 先完成可能失败的查询/真实排序/数据投影，再写201/CSV头。可把已生成行逐行编码到响应，避免构造[header,...rows]和整份CSV大字符串；只在行间写LF。不得为了流式输出先发201再把数据库/上游错误混进CSV。
- 导出没有事务性业务写/直接审计，不新增事务、导出任务或队列；保留复用读取链中原有缓存/外部调用/日志必要副作用。

# 修改范围、独立模式与回退

- 新internal/analysisexport/**、cmd/api/analysis_export.go、独立legacyproxy/analysis_export_routes.go；itemsreading新增export端口及必要最小内部抽取，newsevents新增export端口/只读投影，analysiscollab少量DTO校验复用入口；main/config/env/compose/README的本批增量和一份可选短交付说明。
- 不修改Nest Controller/DTO、Web、旧23协作CRUD、GraphQL签名/Registry/引擎、items交互分页上限/排名参数、newsEventBrief、profiles/llmlogs、来源策略写端或OIDC。不要大规模搬迁共享算法；本批允许必要窄端口，并保留所有旧调用行为。
- 新API_GO_ANALYSIS_EXPORT_MODE接受空串/legacy/go，默认legacy，非法值启动失败。go要求JWT/MySQL/Redis/Mongo；即使ITEMS_READING/GRAPHQL_READ/ITEMS_LIST/ANALYSIS_VIEWS/BOARDS/THREADS等模式legacy，本批也独立初始化items业务服务、Personalization、Mongo和事件读取端口。
- ReadModelEnabled、VectorHardFail与现有ES/vector/model环境/运行配置继续复用；外部客户端按真实查询需要懒调用，不在启动探测模型、不把配置CRUD开关当业务依赖，不新增SMTP/队列要求。
- main覆盖无效DSN失败条件、资源OR、共享Mongo指针/close生命周期、wire/精确handler注册/诊断；复用连接池，不因其他模式未开就给Mongo或画像provider传nil后假装完整。
- 仅精确两个POST及既有CORS预检，legacy不注册；/exports/search及其他方法/路径维持Nest。保留所有并行任务接线并集，不取得来源策略两处GraphQL补线所有权。Web→NestJS/canary默认保持现状，不改部署变量；代码回退只将本模式legacy，无业务数据清理或rollback job。

# 精简验证与交付

- 本机不安装依赖，不运行build/test、Docker或服务，不访问生产ES/vector/model/数据库；可静态检查、gofmt、git diff --check。必要用例交现有普通CI执行，不新增专用smoke workflow。
- 聚焦>50到5000条的time/相关性/个性化选择与上限不影响交互路由、批量补字段/跨租户、事件先5000后过滤/强制权威/稳定排序/等价去重、CSV公式/引号/换行/空结果、rerank503在响应头之前、仅本模式资源及search完整回退。不堆每字段镜像测试；Mock与静态不冒充真实外部验证。
- 保留外部调用/日志实际边界，记录最终head普通CI结果链接；skipped不算通过，修复本批引入问题。真实ES/vector/rerank/大数据导出未验证要明确记录，不写已通过。
- 地图由规划窗口集中维护。编码窗口不要改migration-map共享索引/域页/BACKLOG/其他task，不要求运行中窗口重做文档。PR说明或短交付说明列ANALYSIS-EXPORT-001、两路、CSV/查询契约、去重优化、复用端口、PR/head/CI、开关/回退、外部未验证及search保留Nest，供规划窗口回填；未合并不提前计入main。
- 只提交本批改动，中文emoji+type(scope)正常commit/push，创建Ready PR并提供链接；不合并/auto-merge、不amend/rebase/force-push。交付最终SHA、分支/worktree、两路完成情况、普通CI、优化与限制；不自行启动下一批。
