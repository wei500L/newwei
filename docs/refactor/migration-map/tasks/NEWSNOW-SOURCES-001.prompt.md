# 目标

为 wei500L/newwei 完整迁移 NewsNow 来源获取与批量刷新，任务 `NEWSNOW-SOURCES-001`。用户打开来源卡片、首次读取、缓存到期或手动强刷时，由 Go 实际请求上游、解析条目、更新兼容缓存，并把新增条目提醒送到现有已认证 NewsNow socket。

本批比审计补偿更大：两条完整 HTTP 覆盖当前64个来源ID、41个可达来源族，包含JSON/HTML/RSS/GraphQL上游、Cookie、签名、编码、相对日期、并发调度与实时接缝。来源ID不是64个HTTP入口。注册器导入44个模块，其中ghxi/linuxdo/smzdm元数据disable:true，不恢复它们，也不实现无可达入口的死代码。

## 1. 基线、任务恢复与独立worktree

- 仓库 `/Users/oo/project/newwei`。规划基线 `origin/main 91e759b449c4511dc96d86539ea0eb258754d07e`；不能按旧checkout推断进度。
- 先读最新 `AGENTS.md`、`docs/refactor/migration-map/{README,PLANNING}.md`、`tasks/README.md`、本task和本提示词，再fetch main、查询开放PR/最近5次main普通CI/worktree。只核本候选增量，不重建地图。
- 独立业务分支 `refactor/go-newsnow-sources`；worktree `/Users/oo/project/newwei-go-newsnow-sources`。从执行时最新origin/main创建；已有目录先核对任务身份与改动，不重置其他目录。
- 规划记录在 `docs/plan-newsnow-feed`、`/Users/oo/project/newwei-plan-newsnow-feed`；尚未合main时先 `git fetch origin docs/plan-newsnow-feed`，只取本任务记录/提示词，不覆盖整份旧地图。本批业务目录规划时未创建。
- 上批规划#91已合入main；审计实现Ready #92仍OPEN，head `28c8f761a2ce4a447080414f154b567648cc6bd1`，普通CI39248452603成功，继续占用AuditOutbox。其真实diff已读：与本批只重叠main/config/env schema/compose/README，保留所有条件与关闭顺序并集，不改它的业务文件或记录要求。
- 基线main普通CI39247556593，精确head为上述91e759b4，verify/vector-integration/api-go-user-settings-integration success，两regen skipped。链接 `https://github.com/wei500L/newwei/actions/runs/39247556593`。不是本批CI、真实上游连通或部署证据。

## 2. 精确接口、权限与返回

1. `GET /api/news-aggregator/source?id=<id>&latest=<flag>`，公开，成功200。
2. `POST /api/news-aggregator/sources/batch?latest=<flag>`，公开，body `{sources:[...]}`，成功201。

公开来源内容和缓存是全局的，不伪加orgId/JWT门槛；runtime secret也是全局设置，仅供服务端请求，不向公开返回暴露。实时消息只能进入既有鉴权后的组织room，不能采用HTTP body/query提供的orgId。

返回事实源：`apps/api/src/modules/news-aggregator/news-aggregator.types.ts` 的NewsItem/SourceResponse；单源 `{status:"success"|"cache",id,updatedTime,items}`，items空数组合法。batch `{requested,processed,results,errors:[{id,message}]}`，成功/失败各保持输入相对顺序，不改成对象映射或HTTP207。数字/字符串id、updatedTime、pubDate和extra字段的多形态、false与缺省必须保留，不能全部转字符串或用omitempty丢合法false。

## 3. 已核源码与明确复用

Nest事实源（本基线与地图3cedce9a相比此业务无源码变动）：
- `modules/news-aggregator/news-aggregator.controller.ts`：getSource/getSourcesBatch、validateSourceId/parseBooleanFlag。
- `news-aggregator.service.ts`：fetchSource 101、buildSourceFetchException 204、shouldRetryAfterEmptyCache 236、fetchBatch 253、resolveSourceId 738、normalizeItems 760、safeGetCache/pollForCache/buildCacheKey/buildStaleKey 775–800、publishRealtimeUpdate/resolveRealtimeTargetOrgIds 1170后。
- `news-aggregator-registry.service.ts:buildGetters`、`data/pre-sources.ts:genSources`、`news-aggregator.constants.ts`、`news-aggregator.errors.ts`、`news-source-runtime-secrets.catalog.ts`。
- `sources/`中可达getter及fetch/source/rss2json/date/crypto/base64、cls/utils、coolapk/utils。须逐getter迁请求和解析，不用缓存读取或代理Nest冒充实现。
- `modules/system-settings/news-source-runtime-secrets.service.ts:getSecretsForSource/applySourceSecrets/loadStoredSettingsStrict/decodeSecretValue`。
- `common/filters/global-exception.filter.ts:normalizeResponse/extractSafePayload/getErrorFromResponse`，不能把service原始异常对象直接当HTTP契约。
- `newsnow-realtime.dispatcher.ts`、`newsnow-active-source-registry.service.ts`、`newsnow.gateway.ts`、`modules/websocket/user-session-manager.service.ts`、Socket.IO Redis adapter。

Go已有基础：
- `internal/newsnowclusteringops/{data_gen,metadata}.go`已有genSources后的64项元数据/redirect/interval，但变量和类型私有；新增窄只读导出端口，复用当前registry，不能复制第二份来源表或实例化需要Mongo的完整Service。禁止手改生成文件。
- `internal/infrastructuresettings/{runtime_secrets,runtime_parse,crypto}.go`已有严格读取/解析和AES-GCM解密，helper私有。新增独立runtime-reader窄端口，复用同包helper，不重写管理CRUD或改其权限；需要的30秒进程缓存放本reader，避免改变管理端强制读DB语义。
- `cmd/api/main.go`已有sharedDB/Redis；复用 `usersettings.OpenMySQLFromURL`。不创建另一套DB池。
- 已有 `golang.org/x/net/html`、`golang.org/x/text`可处理HTML和GB2312/GBK，不默认增加依赖；可参考crawlmetadata已有HTML读取，但不把来源固定站点请求误接成crawl metadata业务。
- `notifications/user-digest-notification.subscriber.ts`提供已合Redis订阅生命周期参考；不能复用摘要通道、通知表或其具体业务。

## 4. DTO、缺省/null和错误语义

- 单源id必须string且trim后非空，否则400 `id query is required`；trim后匹配`^[a-z0-9_-]+$`，否则400 `invalid source id format`。大小写匹配不代表转小写：registry仍精确查键。
- latest缺省/null/原始空串为false；string trim后转小写，true/1/yes/y/on为true，false/0/no/n/off为false。非string为400 `latest must be a boolean string`，其余为400 `latest must be one of true/false, 1/0, yes/no, y/n, on/off`。纯空白串不等同原始空串。
- batch只有sources不是array时400 `sources must be an array of source ids`；数组内非string或trim后格式不符的成员被过滤，不让整批400。保留有效项的大小写/重复，requested为Controller过滤后长度；Service按原顺序去重，再截前100，processed为截断后长度。空数组合法，results/errors均[]；格式合法但未知的ID进入该项errors。
- 先查requestedID元数据，再解析redirect链，再找getter；循环回到原ID的行为与现有逻辑一致。未知源404 `Unknown source: <id>`，无getter404 `Source getter not found: <resolvedId>`。`disable:true`不在registry，`disable:"cf"`仍在，不能擅自禁用cf项。
- 必须区分单源HTTP错误与batch内捕获的Error.message。缺运行凭据service抛424/NEWS_SOURCE_RUNTIME_SECRET_REQUIRED；外调/解析等一般错误包装502/NEWS_SOURCE_FETCH_FAILED，detail最长240个JS字符（前237+...），已有HttpException且status<500保持。
- GlobalExceptionFilter把502 HTTP message改成`Internal server error`，保留安全code/detail；424保留业务message/code/detail。它的安全字段白名单没有sourceId/requiredKeys，不能在HTTP响应额外泄露这两项；batch errors.message仍是Service异常message，不套单源HTTP脱敏文案。traceId/path/timestamp/error名遵循现有过滤器，path包含原请求URL/query。
- Go DTO/业务/缓存/上游结构均具名强类型。id/时间/extra.info/icon等用具名union与自定义JSON边界；扩展JSON叶子可RawMessage，不用any/interface{}/map[string]any/[]any承载业务。

## 5. 来源覆盖和实际工作

完整支持以下64个当前来源ID（最终仍以执行时Nest genSources及增量为准）：
v2ex, v2ex-share, zhihu, weibo, zaobao, coolapk, mktnews, mktnews-flash,
wallstreetcn, wallstreetcn-quick, wallstreetcn-news, wallstreetcn-hot,
36kr, 36kr-quick, 36kr-renqi, douyin, hupu, tieba, toutiao, ithome,
thepaper, sputniknewscn, cankaoxiaoxi, pcbeta, pcbeta-windows11,
cls, cls-telegraph, cls-depth, cls-hot, xueqiu, xueqiu-hotstock,
gelonghui, fastbull, fastbull-express, fastbull-news, solidot, hackernews,
producthunt, github, github-trending-today, bilibili, bilibili-hot-search,
bilibili-hot-video, bilibili-ranking, kuaishou, kaopu, jin10, baidu,
nowcoder, sspai, juejin, ifeng, chongbuluo, chongbuluo-latest,
chongbuluo-hot, douban, steam, tencent, tencent-hot, freebuf,
qqvideo, qqvideo-tv-hotsearch, iqiyi, iqiyi-hot-ranklist。

重点分支不能遗漏：
- JSON API按各provider的filter/map/sort迁移，包括广告/置顶过滤、id类型、移动链接、数字格式、pubDate与extra.date各自位置；不是拿一个通用JSON路径覆盖所有源。
- HTML getter保留实际选择器/相对URL拼接/文本和缺字段分支；Baidu注释JSON、Ifeng内嵌allData、Kuaishou Apollo引用、Jin10 JS变量包装均需真实解析，不执行上游JavaScript。
- cankaoxiaoxi三个频道、v2ex四feed的并发聚合和排序；pcbeta/chongbuluo RSS与RSS/Atom字段；Freebuf两RSSHub实例各web/system并发，任一实例有结果即采用，再原生feed分类回退、去重/日期排序。
- Douyin/Xueqiu的前置Cookie获取与后续请求；Weibo Cookie三别名/环境回退；ProductHunt token四别名/去Bearer前缀/GraphQL POST。
- CLS排序query→SHA1→MD5签名；Coolapk随机设备ID、四舍五入秒级时间、base64/MD5 token与请求头。
- Zaobao GB2312响应解码；Asia/Shanghai显式日期与相对日期；dayjs未指定时区的格式化按现有运行时选择，不一律改UTC。坏日期的原字段形态和筛选分支不能静默捏造当前时间。
- `myFetch`明确UA、timeout=10000、retry=3；直接`$fetch.raw`获取Cookie并非同一封装。按锁定ofetch版本1.5.1补齐必要请求/响应行为，不为每层再叠重试，不将全部请求都套同一Cookie或header。保留各getter原POST body、Referer、User-Agent、响应类型及错误分支。
- normalizeItems只过滤nullish id、空/非string title、空/非string URL及非http(s)URL，保留剩余条目顺序，截前50。不能额外做全源去重、标题trim、排序或把数值0当缺id。

## 6. DB、运行凭据、缓存和刷新副作用

- 只读MySQL `SystemSetting` 的全局`news_source_runtime_secrets`；不写业务表、审计、原文、read-model或索引，无事务、Mongo、入队或BullMQ。
- reader保留严格存储解析、重复项规则和30秒进程缓存。取requestedSourceId条目后，再应用resolvedSourceId条目，后者同key覆盖前者；只有精确source匹配，不擅自继承base前缀。存储读失败按Nest warning+空secret集合；逐项解密失败跳过；明文/解密后trim，仅非空采用。
- 解密仍用SYSTEM_SETTINGS_ENCRYPTION_KEY已有格式；缺/坏key不阻止不需要secret的源。Weibo和ProductHunt在runtime无可用值时再用WEIBO_COOKIE/PRODUCTHUNT_API_TOKEN；不要要求所有源的凭据在启动时齐全。只增加必要环境透传，不读取真实.env或把secret放入文档。
- requestedID独立cache key `news-aggregator:source:<requestedId>`，stale为该key+`:stale`；即便redirect到同getter，不能改用resolvedID合并这些缓存/锁/事件身份。
- fresh TTL=max(1,floor(source.interval/1000))，默认10分钟，stale TTL86400秒。持久化完整SourceResponse；返回命中仅把status改cache，不回写窄投影。
- 非force先读fresh，读失败当miss并warning；Freebuf空缓存updatedTime无效或距今>=2分钟时忽略并重试。其他源合法空结果正常缓存。
- refresh内重新读previous fresh→读runtime secret→真正调用getter→normalize→构造status=success/updatedTime毫秒数→并行写fresh和stale，均成功后计算并发布增量。缓存写错会使本次失败，不能擅改best-effort成功。
- 物理刷新锁 `lock:news-aggregator:source:<requestedId>:refresh`，NX PX45000，token比较续租/释放，保持CacheService.withLock协议。它是既有业务锁，不再增source级锁平台。
- 锁竞争时每200ms轮询fresh至45秒，再看stale，再无可用结果才最后refresh；Freebuf空缓存分支保持。force仍可能在锁竞争时返回cache。不是任何上游失败都可以返回stale，不擅自扩大降级语义。
- 缓存/锁与Nest预热、热点分析、推荐所调用的原fetchSource保持协议兼容；本任务不把这些Nest调用入口伪装成Go所有权。

## 7. 保持顺序的批量并发优化

现有fetchBatch按10项整块Promise.allSettled；一个慢源会挡住下一整块。改为最多10个fetchSource并发的持续worker pool：任一完成即领取下一项，结果写回原index，最后按输入序分别形成results/errors。维持去重、100上限、requested/processed、部分成功及稳定顺序；getter内部已有多子请求并发独立保留，10不是所有底层HTTP请求的全局上限。

用受控慢/快getter完成序列验证：第11项可在第一块慢项结束前启动；峰值fetchSource<=10；输出顺序和错误归属不变。只验证调度和契约，不建设基准平台或新增重试层。

## 8. 必要实时接缝与Nest所有权

已确认NewsnowRealtimeDispatcher和ActiveSourceRegistry都是Nest进程内，Go不能直接调用。刷新成功只写Redis缓存会漏新增提醒，须补来源专用Redis接缝。

- previous缺失/无items不发；按previous的String(id)集合比较current，每个新增item计数，前3个非空title trim后截200个JS字符；newItemsCount=0不发。updatedTime按当前SourceResponse转ISO或保留非空string；intervalMs至少1000。保留原算法，不擅自对current再去重。
- 拟新增通道 `newsnow:source-refresh:v1`，具名message含version=1、refreshId、sourceId、newItemsCount、topTitles、updatedTime、intervalMs；无orgId/用户/secret。一次refresh只发布一次。失败warning，已成功缓存/HTTP不因此回滚，与原publish best-effort一致；不称耐久事件/恰好一次。
- Nest新增专用subscriber，在本模式go时duplicate共享Redis订阅；legacy不打开该订阅。收到已知source事件后，用本实例ActiveSourceRegistry.getOrgIdsForSource找真实订阅组织，再通过现有dispatcher→gateway→组织room发送`newsnow:update`。orgId只来自认证socket登记。
- 不能让每个subscriber都经Socket.IO Redis adapter广播相同组织事件：adapter.enabled=true时，对每个(refreshId,orgId)用短TTL60秒的SET NX去重标记，只由获准的subscriber走原组织广播；键前缀本任务专属，如`newsnow:source-refresh:fanout:<refreshId>:<orgId>`。这是该跨进程广播必需的有限去重，不建outbox/幂等平台，也不宣称强投递保证。
- adapter.enabled=false时，不做跨实例全局fanout去重，各实例只经原本地组织广播，防止一个实例领取后其他实例本地客户端漏收。沿用既有统一adapter配置，不增加混合拓扑框架。
- 不把refreshId/version内部字段塞入原Web事件；既有事件orgId/sourceId/newItemsCount/topTitles/updatedTime/intervalMs/timestamp保持。不要把每个订阅的socket改成全公开广播，不改WS鉴权/重新验token/连接限流。
- Redis订阅失败不能静默宣布接缝已就绪；按现有subscriber模式处理初始化错误和关闭，先unsubscribe/quit专用连接，再关闭共享资源。
- 唯一后台所有权不变：NewsnowSourceWarmSchedulerService仍Nest每分钟、锁`lock:cron:newsnow-source-warm`、并发6；HottestAnalysisScheduler仍Nest每10分钟。这些仍运行原Nest fetchSource，不添加Go Cron，不停Nest预热，不接管其锁；本批没有BullMQ/cron迁移。实时接缝只消费Go发布，不重发Nest本地已发事件。

## 9. 文件边界、开关与公共接线

拥有新增Go `internal/newsnowsources/`（包括providers）、`cmd/api/newsnow_sources.go`、`legacyproxy/newsnow_sources_routes.go`；已有newsnowclusteringops仅新增registry只读port，infrastructuresettings仅新增runtime-reader窄port和必要测试；不改两包现有HTTP业务。

Nest仅新增来源subscriber及news-aggregator.module.ts注册、env.schema.ts模式校验；只有确需接缝时允许dispatcher的最小typed扩展，不改Controller签名/装饰器、所有getter、warm/hottest scheduler、gateway通用鉴权或摘要通知桥。

新增独立 `API_GO_NEWSNOW_SOURCES_MODE`，空/legacy/go、默认legacy、非法值Nest和Go启动失败，Compose同名变量注入api/api-go、默认legacy。它只控制这两条HTTP接管和Nest来源relay，不代表cron所有权。

- Go单独开本模式只需DATABASE_URL/REDIS_HOST及现有Redis参数；不强开旧NEWSNOW_CLUSTERING_OPS、INFRASTRUCTURE_SETTINGS、JWT、Mongo、GraphQL、模型开关。
- main新增精确规则、handler、无效DSN阻断、DB/Redis初始化、必要资源关闭；保持needsCredentialedGo鉴权边界，不因两路公开HTTP强建authenticator。wire错误启动失败，不能ModeGo却无handler。
- 精确GET/POST两路，OPTIONS按现有CORS规则处理；metadata/resolve/order/domestic-opinion/recommended/hottest-analysis/聚类管理和未知method/path保留原所属规则，不抢整段/api/news-aggregator。
- 共享main/config/env/compose/README只加本任务条件，与#92的AuditOutboxMode/ScheduleEnabled/needsRedis及关闭顺序保留并集。执行前重查其新head，不能依赖其尚未合入的导出符号；正常merge更新main，不rebase。
- 不迁推荐、热点模型分析/自动bridge、LLM backfill、新闻pipeline/分类/指标/KG ingestion。不给已迁metadata/order等重新计数，不把两接口完成写成整个BL-18已完成。

## 10. 回退、验证、记录与Ready PR

legacy不注册本两路，继续Nest；go出错按本接口错误契约返回，不转发Nest补做，不对真实外调做shadow双执行。回滚改legacy并drain本批在途HTTP/relay，保留兼容缓存，Nest预热仍照常。Web→NestJS、canary=0及其他模式保持现状；本任务不实际部署。

本机不装依赖、不运行build/test、Docker或服务，不调用真实站点验证凭据；不新增专用smoke/CI框架。用已有普通CI运行少量关键契约测试：参数/201和批量顺序，缓存与Freebuf/锁竞争，代表性JSON/HTML/RSS/签名/编码fixture，运行凭据覆盖与失败，Redis relay两种adapter拓扑及租户边界，独立开关/无效值/路由隔离。覆盖特殊provider分支，避免为每个常量/selector堆测试；source静态覆盖清单是交付证据，不代替实际业务fixture。

静态复核具名类型、缺省/null/false、全局secret与socket组织绑定、错误过滤器、共享cache/锁、资源关闭和#92并集，保存精确SHA+file:line。所有真实provider连通、Cookie/token有效性、Cloudflare/限额、多实例relay和部署未实跑就写未验证；上游合法空或正常失败不能伪造成功，也不自动视作迁移遗漏。

编码窗口按PLANNING轻量分工只更新自己的tasks/NEWSNOW-SOURCES-001.md、专属docs/refactor/go-newsnow-sources.md和PR说明：精确两接口、当前支持ID、特殊getter、并发改善、默认开关、Nest预热/推荐/热点剩余所有权、PR/head/普通CI和未验证项。共享地图由规划窗口集中回填，不重建/重算全仓，不关闭整个GAP-LEGACY-001或GAP-ASYNC-001。

只提交自己的改动；源码注释英文，文档/提交/PR中文，中文emoji+type(scope)，正常push，创建指向main的Ready PR。记录精确head与普通CI run/job结果，skipped不算通过；失败用追加提交修复。不merge、不auto-merge、不amend/rebase/force-push，不创建Codex新对话、跨对话消息或定时任务。

最终交付Ready PR、分支/worktree/head、CI、完整两路/来源覆盖、并发调度证据、实时接缝与Nest执行边界、启用/回滚说明、任务记录及未验证项。
