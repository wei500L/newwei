# 目标

在 wei500L/newwei 的 apps/api-go 完整迁移“网页元数据预览”链路，任务 ID：CRAWL-METADATA-001。用户输入 URL 列表或站点域名后，能发现 sitemap 中的页面，并获取 title、description、keywords、author、标准 meta、OpenGraph/Twitter、JSON-LD 和相关性分数。

范围是同一业务的一个 HTTP 和一个 GraphQL Query。虽然入口只有两个，实际包含 robots/sitemap 发现、XML/gzip、HTTP条件缓存、重定向、DNS/SSRF校验、HTML解析、并发与评分，作为完整独立批次交付。必须实现真实抓取，不能用空数组、缓存读取或转发 Nest 代替生成链路。

这是后端编码窗口：完成实现、提交、推送并创建 Ready PR。专注迁移和功能，不做全仓审计，不堆防御性编程，不发明新锁/重试/熔断/网络框架。保留源码已有鉴权、权限、URL安全约束、超时和业务校验。新增/修改源码注释用英文，解释发现顺序、缓存304、逐跳校验、解析分支和结果顺序；文档、提交、PR描述用中文。

## 基线、分支与恢复

仓库 /Users/oo/project/newwei 当前可能在旧分支。规划核实的 origin/main 为 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；#69地图已合并，最近五次main普通CI成功。相对地图旧基线3cedce9a仅文档/导航变化，没有相关业务迁移。

开始先读取适用 AGENTS.md，fetch origin main，记录SHA，查询开放PR、main最近五次CI和git worktree list。只核对本链增量，不重新扫描全仓。使用 fetch 后 origin/main 创建：
- 分支 refactor/go-crawl-metadata
- worktree /Users/oo/project/newwei-go-crawl-metadata

不得切换、清理或提交其他窗口目录；同名目录/分支存在时先核归属，不能覆盖。

任务认领/提示词位于规划文档PR https://github.com/wei500L/newwei/pull/71；只读参考，不把整份规划分支merge进业务分支。地图入口为 docs/refactor/migration-map/README.md、PLANNING.md、tasks/README.md、GAPS.md、BACKLOG.md；仅展开modules/crawl.md、AUDIT的crawl与DEPENDENCIES相关部分。

## 精确入口与返回契约

1. POST /api/crawl-tasks/metadata
- 权限 crawl.read，先鉴权/授权再DTO/业务。
- 成功201：{orgId,total,results}，orgId仅来自已认证身份，total=最终results.length。
- 不接受body/query自行指定租户，不额外写CrawlTask、RawItem或ProcessedItem。

2. Query crawlMetadata(input: CrawlMetadataInput!): [CrawlMetadataResultModel!]!
- 权限 crawl.read，SDL已存在，但main的Go Registry尚未注册。
- 返回列表本身，没有REST的orgId/total封装。
- 注册CrawlMetadataResultModel与CrawlMetadataTagModel的具名模型；保留别名、变量、fragment及整份operation预规划/回退。
- 不改GraphQL引擎，不把相邻crawlTasks/crawlTask重新注册一遍。

单项：url、status(success/failed)、httpStatus、fetchedAt、title、description、keywords、author、metaTags、openGraph、jsonLd、relevanceScore、error。
- metaTags/openGraph为{name,value}列表，jsonLd为字符串列表，空时均[]。
- REST保持可选字段缺省时省略；GraphQL按toGraphMetadata映射为null，日期UTC毫秒ISO。
- SDL中的httpStatus/relevanceScore是Float，keywords可null。
- 单个网页失败返回failed项和空三列表，不把整批变500；输入级错误和权限错误仍按原契约报错。
- 未发现URL返回[]，REST对应total=0，不伪造failed项。

精确HTTP规则只接管本POST及沿用的CORS预检；其他方法、相似路径、尾斜杠、创建/重试/删除接口继续Nest。GET /api/crawl-tasks/metadata可能沿既有GET :id规则处理，不能新增规则改变其归属。Go业务失败不能转Nest重放请求。

## 最新源码与复用位置

Nest事实源：
- apps/api/src/modules/crawl/crawl.controller.ts：extractMetadata。
- apps/api/src/graphql/resolvers/crawl.resolver.ts：crawlMetadata、toGraphMetadata。
- apps/api/src/modules/crawl/dto/crawl-metadata.dto.ts。
- apps/api/src/graphql/dto/crawl.input.ts：CrawlMetadataInput。
- apps/api/src/graphql/models/crawl.model.ts：两个metadata模型。
- apps/api/src/modules/crawl/crawl.types.ts：CrawlMetadataExtractionInput/Result/Tag。
- apps/api/src/modules/crawl/crawl-metadata.service.ts：extract→normalizeInput→resolveUrls；discoverFromSitemapsCandidates/extractFromSitemapPayload/resolveSitemapSeedUrls/discoverRobotsSitemapUrls/parseSitemapPayload；fetchMetadata/parseMetadata/fetchWithStatus/fetchMaybe；HTTP state、wildcardMatch、computeRelevance和mapWithConcurrency，以及这些路径实际调用的helper。
- apps/api/src/common/validators/{ssrf-url.validator,is-safe-url.decorator}.ts、modules/cache/cache.service.ts、HTTP验证管线及GraphQL错误映射。

重要范围纠正：extract仅支持urls/sitemap，未调用同服务的discoverRss*、discoverList*、discoverDeep*、Crawl4aiClient或CrawlExecutionService。它们是其他入口/worker的发现能力，不迁移这些未被本两入口调用的分支，不新增crawl4ai依赖、执行权或配置。

已有Go复用：
- internal/authn/authz/authhttp：JWT/blacklist、MySQL membership/权限重推导与HTTP错误；身份不能从请求orgId推导。
- internal/newssources/ssrf.go：已有与Nest相近的同步URL+DNS校验，validateSourceURL等私有。允许新增一个窄的导出包装供本包复用，并对照Nest补齐本链确需的差异；不重构整个newssources或放宽原安全规则。
- internal/legacyproxy的精确keyed路由与cors；以crawl_read_telemetry_routes.go的现有方法匹配为参照，不修改其业务handler。
- internal/graphqlread/contract：具名Bind、RegisterRoot/RegisterType、Failure、FormatDateTime；schema/schema.gql已包含完整metadata契约，不改SDL/生成物。
- 现有sharedDB、Redis、authenticator装配。业务本身不查业务数据库，MySQL用于鉴权；Redis保存与Nest兼容的发现HTTP状态。

建议新增internal/crawlmetadata/**、internal/graphqlread/crawlmetadata/**、cmd/api/crawl_metadata.go与legacyproxy独立规则。不要放进STORAGE-MEDIA-001正在修改的crawlreadtelemetry/settingscrawl包。

HTML采用成熟HTML5 DOM解析器，可使用golang.org/x/net/html，文档 https://pkg.go.dev/golang.org/x/net/html 。不要用整段正则或严格XML解析器冒充Cheerio的HTML语义。主线尚未直接依赖该模块；版本按Go1.27和现有依赖核实，不盲目升级其他依赖。本机不安装/运行go get或tidy；所需go.sum通过已有远端go-modules-regen通道生成，详见后文。

## DTO与默认值：区分REST和GraphQL

两入口验证并不相同，不能共用一套最严格DTO吞掉差异。

REST CrawlMetadataRequestDto：
- source可选，非null时只允许sitemap/urls。
- source!=urls时domain必填字符串，最长255，按原hostname正则拒绝IP/localhost及对应私有后缀；scheme/path形式不能当REST合法domain。
- source==urls时urls数组1..200，各项须带http/https且通过IsSafeUrl异步校验。
- pattern可选字符串最长255；query最长160。
- maxUrls整数1..200；concurrency整数1..10。
- scoreThreshold数字0..1。
- 三个extract*可选boolean；IsOptional对null/缺失的行为按Nest。

GraphQL CrawlMetadataInput：
- source是可选String，不是enum，没有REST的IsIn；不等于urls时服务按sitemap处理。
- domain是可选String，服务normalizeDomain接受带scheme或缺省https并只保留origin；缺失/无效按源逻辑处理。
- urls可选字符串数组，没有REST的1..200和IsSafeUrl装饰器；运行时请求仍逐跳做SSRF。
- maxUrls/concurrency整数且至少1，无REST上界；服务再钳制200/10。
- scoreThreshold为可选数字，无DTO的0..1限制，服务再规范化。
- pattern/query没有REST长度限制，但服务pattern仍有自身限制。
- input参数本身非null；其内部可选null/缺省按源码处理，不变成0/false。

共同normalizeInput：
- source仅输入urls时取urls，否则sitemap。
- URL列表按new URL语义规范化、丢无法解析项、按首次出现去重；不是给URL列表自动补https。
- maxUrls默认50，clamp1..200；concurrency默认5，clamp1..10；按源码round。
- extractJsonLd/extractOpenGraph/extractStandardMeta均缺省true，显式false保留，null按nullish默认true。
- query小写按空白切token，保留重复token。
- scoreThreshold有限数字先保留3位再clamp0..1，默认0。
- requestTimeoutMs固定15000，无新公开参数。
- sitemap无有效domain：400 domain is required when source is sitemap。
- urls无有效URL：400 urls are required when source is urls。

pattern：trim、小写，空值无过滤；服务最大512字符、最多32个*或?，超过时按源码忽略pattern，不新增错误。迁移既有通配算法，*任意串、?单字符，不把输入当正则或改成path glob。REST在此前还有255字符DTO限制。

## sitemap发现、缓存与抓取

1. source=urls：按规范化顺序截前maxUrls。源码不将pattern套到这个分支，不能擅自增加过滤。source=sitemap：从domain origin发现，不遍历任意深度网页链接。

2. extract的sitemap模式默认robots：先GET /robots.txt，按不区分大小写的Sitemap:行收集、规范化并去重，最多256条。若robots发现至少一条就用其列表，不因后续获取失败又偷偷追加common_paths；只有没发现时按DEFAULT_SITEMAP_SEEDS既有11个路径及顺序尝试，不只硬编码sitemap.xml。

3. 解析urlset/url和sitemapindex/sitemap，保留父条目→子sitemap深度优先的既有顺序、visited去重与maxUrls停止规则。URL按normalizeUrl处理并进行pattern筛选；去重后的首次顺序保持，不擅自按日期/相关性重排。支持源XML中的loc文本/CDATA及命名空间等实际形式。

4. 与Nest共享条件缓存：crawl:discover:http-state:<sha1(url)>，TTL7天。具名state字段etag、lastModified、body、parsedSitemapPayload、updatedAt（毫秒）；parsed payload为urls[{loc,lastmodTs?,newsPublishedAtTs?}]、childSitemaps[{loc,lastmodTs?}]。保留新闻发布时间/lastmod解析，避免本包写共享缓存后丢掉其他发现调用所需字段；不引入本入口没有的freshness公开筛选。

5. fetchMaybe只用于robots/sitemap：发送If-None-Match/If-Modified-Since；304有旧body时复用并刷新状态，保留parsed payload；304没有body时按原逻辑再无条件请求一次。200 body相同保留parsed，不同清掉后重解析；body完全相同时可复用parsed sitemap。缓存读写失败按源逻辑降级，不伪装HTTP成功，不新建锁。可选抓取/非法XML失败跳过，最终可合法空列表。

6. fetchWithStatus：真实GET，固定原MetadataBot User-Agent，不带入用户Authorization/Cookie。每一跳先validateSsrfUrlAsync对应的scheme/host/private IP/cloud metadata/DNS规则，再手动跟随相对或绝对Location；最多5次重定向，禁用Go默认自动跟随，整个单次调用共用15秒超时，不能每跳重置。保留原DNS解析失败允许继续、实际HTTP再失败的语义，不擅自新增DNS pinning/重试框架。SSRF是现有必要约束，不能因“不防御性编程”删除。

7. 保留304、非2xx、缺body、非法Location、过多重定向的原错误边界。支持.gz URL/content-encoding/content-type指示的gzip，gunzip失败按源逻辑用原字节UTF-8解码；考虑Go transport自动解压，避免二次解压损坏。不要擅自加入Content-Type白名单、响应大小/站点深度上限等新产品限制。

8. fetchMetadata为每个目标页面直接抓取，不用robots/sitemap条件缓存冒充页面最新内容。单页失败返回{url,status:"failed",error,metaTags:[],openGraph:[],jsonLd:[]}；不填不存在的httpStatus/fetchedAt。成功后填响应status、当前fetchedAt和解析字段。保留错误文本如Metadata request failed with status N、Metadata response body missing、Metadata request failed: too many redirects及Blocked metadata target (potential SSRF): ...；平台网络错误合理映射并说明差异，不伪造Node异常文案。

## HTML解析、评分与必要优化

按Cheerio parseMetadata实际语义：
- 只提取DOM head中的第一title文本trim；不额外用og:title代替。
- meta取name优先，否则property；content trim为空则跳过；保留字段名原大小写和重复条目顺序。
- includeOpenGraph=true且name匹配og:/twitter:时进openGraph并continue；关闭时按源码继续普通meta分支，而非直接丢弃。
- extractStandardMeta=false仅禁止metaTags收集，不禁止description/keywords/author字段提取。
- description/author取首次匹配；keywords首次匹配后按逗号trim、去空、最多15条，不新增去重。
- metaTags/openGraph各截25条，但仍须完成用于单值字段的扫描。
- JSON-LD仅head中type=application/ld+json的非空script，最多5条；合法JSON按JSON.stringify紧凑输出，非法JSON保留trim后的原文。它是string数组，不变成业务map或过滤掉非法项。涉及Go JSON转义/对象顺序/数字的差异须对照现有JS兼容helper与实际样例，不引入通用JS解释器。

相关性：对[url,title,description]拼接小写，逐query token做包含命中，hits/tokens.length保留3位；没有query不返回分数。scoreThreshold>0时用(result.relevanceScore??0)>=threshold过滤，因此失败项和无query结果可能被过滤；threshold=0保留失败项。最后slice(maxUrls)，不能为补足数量额外抓后续页面。

并发限制为config.concurrency，结果按原URL输入/发现顺序保存，不按完成顺序append、不按分数重排。少量失败不阻断其他页面。

具体优化仅做一项有价值的实现优化：一次DOM解析、一次head遍历收集上述字段，保持first/continue/截断语义，避免为title/meta/JSON-LD反复解析或遍历。迁移已有parsed sitemap复用和条件GET；不增加新排名算法、通用网络框架或防御性任务。

业务DTO、返回、缓存、XML记录和配置均用具名强类型；禁止any/interface{}/map[string]any/[]any承载业务数据。GraphQL协议边界沿现有contract转换；JSON-LD叶子可用json.RawMessage及局部序列化处理，不将任意map散入业务。

## 开关、接线、资源与回滚

新增两个默认legacy的开关，均接受空串/legacy/go，非法值启动失败：
- API_GO_CRAWL_METADATA_MODE：只控制上述HTTP POST。
- API_GO_GRAPHQL_CRAWL_METADATA_MODE：只控制crawlMetadata root；go要求API_GO_GRAPHQL_READ_MODE=go，否则启动失败。

二者互不依赖：HTTP可在GraphQL及其他采集模式全legacy时独立工作；GraphQL可在HTTP metadata和SETTINGS_CRAWL_READ都legacy时工作。共享同一个metadata服务实例，任一开关需要时构造，不重复初始化HTTP连接/Redis客户端。

HTTP单开只需既有DB/JWT/Redis鉴权及公网HTTP/DNS，不能强制Mongo、S3、crawl4ai或STORAGE_MODE。GraphQL沿父READ现有DB/auth/Redis/Mongo资源要求；Mongo是父运行时要求，不声称metadata业务要读Mongo。

HTTP模式须纳入main精确路由、DB无效DSN判断、needsCredentialedGo与handler注册，避免校验通过却没有鉴权/Redis。GraphQL只在现有graphqlReadGo注册区块新增本adapter，放在settingscrawl.Register之外，不修改其Options或注册文件、不扩顶层GraphQL接管OR、不顺手修GAP-GQL-001。

保留现有GraphQL响应缓存策略，不将metadata加入全量响应缓存；本批只复用发现HTTP条件缓存。鉴权和整份operation plan须在外部抓取前完成。

无业务DB写、无事务、无入队、无worker/cron、无新增审计事件。公共发现缓存无租户私密数据，不添加租户私有请求头。生产Web→NestJS与canary默认保持现状；env/compose默认legacy。回滚对应开关为legacy，保留兼容共享缓存，无schema/业务数据回滚。

## 并行占用与允许修改范围

主要允许：新crawlmetadata业务包/GraphQL adapter、cmd/api/crawl_metadata.go、本批legacyproxy精确规则、newssources窄URL校验导出及对应少量测试；main/config/README/env/compose仅本开关增量。

不能修改这些已占用核心业务：
- #70 WORKSPACE-WRITE-001：工作台8写、alerts/history/workspacewrite及顶层GraphQL接线，head adb765d0180e8b34910181e8c6fde8be400a2dff。
- #72 NEWS-BRIEF-001：newsEventBrief/newsevents/publicportal/llmlogs，规划读到Ready head517a73f98b495c1664c45fdfaf2bd2692a3b2210，尚未合并。
- STORAGE-MEDIA-001：objectstorage/infrastructuresettings/crawlreadtelemetry/settingscrawl注册及S3媒体；已有本地开发。
- ITEMS-LIST-001：itemsreading及GraphQL adapter、llmembed、contract/exec只读selection元数据；已有本地开发。
- AUTH-LOGIN-001：登录/会话/验证码/MFA challenge/SMTP及accountsecurity/authfactors窄复用；目录已创建，保留占用。

main/config/compose只新增本批语义段并保留各任务并集，不整段覆盖/重新格式化；不修改其他worktree，不发送跨对话消息。提交前重新fetch，必要时正常merge origin/main，禁止rebase。

依赖清单是共享集成文件，按条目分工：本批只负责HTML解析所需golang.org/x/net及tidy必需关联；STORAGE-MEDIA-001负责AWS SDK条目。本批不整理、升级、删除AWS依赖，不复制别的窗口go.mod/go.sum。两分支各用已有go-modules-regen生成自身清单；后合入者正常merge最新main并按需要再次远端生成合并后的依赖并集。不得把并行AWS工作当本批业务前置，也不能手编go.sum或新建生成workflow。

排除任务创建/删除/重试/导入、Frontier、完整采集worker、RSS/list/deep发现、crawl4ai调用、媒体/S3、来源preview、所有相邻GraphQL读写。它们不会因这两入口完成而被标迁完。

## 精简验证与交付

本机不安装依赖，不运行build/test、Docker、服务或真实站点抓取；允许gofmt、git diff --check、只读静态核查。少量有业务价值的测试交现有普通CI执行，不新增专用smoke/Nest测试体系：
- 两入口DTO差异、默认/null、返回封装与权限；默认/非法开关及HTTP/GQL独立组合。
- HTML head/OG开关/关闭standard meta仍有description/JSON-LD非法原文/顺序与阈值。
- robots优先与11路径fallback、嵌套sitemap/重复/顺序、gzip、ETag304有body/无body。
- 手动逐跳校验、5跳上限、单页失败保留/过滤、有界并发且顺序稳定；通过已有HTTP/DNS注入测试边界，不真实外调或放宽生产校验来测本地server。

需要解析依赖时：在自己的PR按既有go-modules-regen label触发远端生成；取回bot提交，完成后移除label并恢复普通CI漂移门禁，核对最终head。生成job的构建不替代普通CI。不得新开专用workflow、在本机go get/tidy或伪造校验和。

共享地图/BACKLOG/任务索引由规划窗口维护，编码窗口不改这些文件、不另写规划任务文档。在PR描述（必要时一份精简docs/refactor/go-crawl-metadata.md）记录两入口/真实分支、开关/资源、解析器依赖与共享文件增量、语义差异、最终head/CI链接及未验证外部行为，供规划窗口回填CRAWL-METADATA-001和crawl域。未合并只能pr_open，不提前增加main覆盖或宣称实站验证。

只提交自己的改动，中文emoji+type(scope)提交，正常push，创建Ready PR（非Draft）；不合并、不auto-merge、不amend/rebase/force-push。查看本次精确head的普通CI，修复本批失败；skipped不算通过，不无限重复检查无变化结果。真实站点/Redis/重定向与投递环境未测就写未验证，不能由mock或CI自动推断。

最终交付PR URL、分支/worktree、基线及最终head、两入口与发现/抓取/解析完成情况、必要语义差异、CI结果/链接、外部验证边界、回滚方式及规划窗口需回填的事实。不要用只保存文档、空壳注册或缓存读取代替迁移交付。
