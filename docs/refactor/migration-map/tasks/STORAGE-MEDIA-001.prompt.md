# 目标

执行 STORAGE-MEDIA-001：完成“存储连接诊断 → 采集任务媒体 URL → S3 预览/下载”的后端链路。管理员能测试实际存储；用户查看采集任务时能获得有效 S3 媒体链接；合法媒体访问能取得签名重定向。补齐已迁读接口的剩余 S3 分支，不重迁整个采集读批次或存储配置 CRUD。

本次只做后端。保留既有 Web、HTTP、GraphQL 返回结构，不启动采集迁移或实际部署。

## 一、最新基线与认领

- 仓库 /Users/oo/project/newwei；规划代码基线 origin/main 9d0462e16d88d146b8afbf67cdd58d8b7419ff29，2026-10-18 Europe/Moscow。#69地图已merged；地图业务基线3cedce9a至此只有文档/导航变化。最新main普通CI run39127631691 success，最近5次main普通CI均success。
- 先fetch main并取得当时最新SHA，查开放PR、main最近5次CI、git worktree list，读取适用AGENTS.md、迁移地图README/PLANNING/tasks/README、本任务、crawl/infrastructure-data域页及AUDIT/DEPENDENCIES相关部分。只增量核本域，不重做全仓审计。
- 本任务已reserved，来源BL-03/GAP-CRAWL-001及BL-15的storage/test子范围；不得领取BL-15其他诊断。
- 认领与提示词保存在Ready文档PR #71、分支docs/plan-news-event-brief。若未合main，fetch该分支，用git show origin/docs/plan-news-event-brief:docs/refactor/migration-map/tasks/STORAGE-MEDIA-001.md及同目录STORAGE-MEDIA-001.prompt.md读取；业务基线仍取origin/main。
- 编码分支 refactor/go-storage-media；独立worktree /Users/oo/project/newwei-go-storage-media，从当时origin/main创建。存在则先查归属/HEAD/状态，安全复用本任务目录。不要在规划worktree或他人工作目录编码，不覆盖未提交改动。

## 二、精确交付范围、权限和契约

1. 新迁移 POST /api/admin/settings/storage/test
   - settings.manage；复用基础设施域的human JWT/Redis撤销/权限重推导及现有mtk_机器令牌授权。该test没有PATCH的platform_admin二次门槛，不擅加。
   - 无业务请求DTO，body不提供endpoint/凭据覆盖；测试全局已保存配置及环境回退。
   - Nest @Post默认HTTP201。返回StorageConnectionTestResult：ok、可选mode/error/bucket/region/endpoint/publicBaseUrl/forcePathStyle/presignedUrlTtlSeconds/checks；check为ok及可选error/httpStatusCode/requestId。成功省略error等未定义键，不统一补null。
   - mode=mysql执行真实SELECT 1，返回checks.mysql，不要求S3配置。mode=s3执行后述完整诊断，单项失败汇总成201 + ok:false，而非固定200/500或伪造ok。
   - getCrawlImageStorageProvider读取失败位于Nest try外，仍按既有服务错误处理；配置不完整在refreshClient捕获范围内，返回ok:false/mode/error。

2. 补齐 GET /api/crawl-media-assets/:assetId/:mode
   - 已注册入口，只补剩余S3分支；preview/download是两个模式，不算两个新路由。
   - @Public仅免JWT，必须保留HMAC的exp/org/user/sig校验、到期与最大窗口、常量时间比较；之后按assetId+orgId查询资产。不因已知storageKey跳过授权。
   - 无效mode404；缺签名/范围、非法exp、过期/超窗/错误签名400并保留现有reason；无资产/跨租户/无storageKey404。配置不完整应按Nest BadRequest400，不能仍伪装资产不存在。
   - 合法S3分支返回302 Location为签名GET URL，不在服务端下载整份媒体，不改成publicBaseUrl拼接。
   - 现有MySQL joined CrawlMediaBlob→legacy blob回退、200二进制及缺payload404保持；content-type规范化、文件名、private max-age=300、nosniff、inline CSP沿用。

3. 补齐已有 GET /api/crawl-tasks/:id 的mediaAssets投影
   - crawl.read，orgId/userId来自认证身份；资产查询必须orgId+taskId，且只为本次结果集resultIds投影。
   - 现有resultLimit/resultSearch DTO与返回结构不改：REST整数范围1..100，越界保持校验错误。只补S3来源的previewUrl/downloadUrl，不重写任务列表、搜索或结果内容读取。

4. 同步补齐已有 GraphQL Query：
   crawlTask(id: ID!, resultLimit: Int = 20, resultSearch: String): CrawlTaskModel
   - crawl.read；父模式为API_GO_GRAPHQL_READ_MODE与API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE。
   - 它在settingscrawl.Register里单独NewService，必须一起注入同一个对象存储能力，不能只修REST构造器。
   - GraphQL resultLimit钳制1..100，与REST拒绝越界不同；显式null/缺省沿用现有adapter。不存在/跨租户任务保持字段null + NOT_FOUND/404错误，不改为无错误null。
   - mediaAssets仍按既有GraphQL字符串JSON标量序列化，不改SDL、模型字段或其余19个settingscrawl roots。

契约事实源，均按规划完整SHA：
- apps/api/src/modules/storage/storage-settings.controller.ts 的testConnection。
- 同目录storage.service.ts：StorageConnectionTestResult、testConnection、refreshClient、createObjectReadUrl、safeAwsCall/formatAwsError。
- 同目录storage-settings.service.ts：getStorageConfig/getCrawlImageStorageProvider/loadSettings/resolveSecret；storage-settings.crypto.ts。
- apps/api/src/modules/crawl/crawl-media-asset.controller.ts与service.ts：getAssetDeliveryPayload、toCrawlStoredAsset、getSignedUrlTtlSeconds、buildContentDisposition。
- crawl.controller.ts、dto/list-crawl-task.dto.ts、crawl-task.service.ts getTask；graphql/resolvers/crawl.resolver.ts、apps/api/schema.gql。
- Go对应handler/adapter及common HTTP/GraphQL错误投影。普通5xx沿既有错误掩蔽，不泄露密钥或完整签名URL。

## 三、已有Go能力与实施边界

- crawlreadtelemetry/service_media.go已有HMAC、内容类型/inline白名单、文件名、MySQL blob下发及资产批量投影。getAssetDeliveryPayload末尾固定nil；buildStoredMediaAsset遇非mysql提前返回，没有S3 URL。这两个位置都要完成。
- crawlreadtelemetry/handler.go的NewService已支持具名service和可空Mongo；service_crawl.go attachResultContent共享REST/GraphQL详情业务。
- graphqlread/settingscrawl/register.go的Options与crawlReader构造需要最小对象存储注入；crawl.go现成错误/模型转换复用。
- infrastructuresettings已有Config、loadStorageRecords、resolveStorageSecret、storageProvider、settingsKey与解密；cache.go已实现共享storage:settings TTL60秒、cache miss/失败回DB。增加具名运行时配置读取表面，复用这些能力，不把脱敏AdminSettings当真实配置，也不复制整套密钥/设置逻辑。
- 新建internal/objectstorage作为窄边界，承载具名RuntimeConfig/ReadURLOptions、S3客户端与presign、诊断必要HeadBucket/PutObject/DeleteObject。依赖由配置reader/interface注入，避免objectstorage与infrastructuresettings循环依赖。
- 诊断HTTP handler可在infrastructuresettings新增独立文件，复用现有私有authorize；不重迁7条配置路由，不改变platform-admin写权限。

## 四、配置、签名与URL生成

- MySQL SystemSetting九键及Redis文档完全复用：crawl_image_storage、storage_s3_access_key_id、storage_s3_secret_access_key、storage_s3_region、storage_s3_bucket、storage_s3_endpoint、storage_s3_public_base_url、storage_s3_force_path_style、storage_s3_presigned_url_ttl_seconds。
- DB可用值优先于S3_*环境回退，provider无有效配置默认mysql；region默认us-east-1，TTL默认300，forcePathStyle默认false。endpoint/TTL/null/false按现有reader语义处理，不统一把false当缺省。
- secret保留既有明文/加密读取与解密失败时环境回退；不擅改成拒绝所有回退，不能把掩码当凭据。解密告警不暴露secret。
- refreshClient兼容条件要求accessKeyId/secretAccessKey/bucket/publicBaseUrl齐全；publicBaseUrl虽不作为私有媒体GET目标，仍是当前Nest完整配置条件。保留移除末尾斜杠的返回配置语义。
- S3客户端遵循region、endpoint、path-style/virtual-host、显式静态凭据；不启用环境外的默认凭据搜索/metadata服务来掩盖缺配置。尊重请求context，不添加新的重试/锁框架。
- 使用官方AWS SDK for Go v2的S3 client与PresignGetObject；当前go.mod没有AWS SDK，不能声称现成。只引入本链路所需模块，不拉上传manager或其他AWS服务，不手写通用S3 SDK。
- 本机禁止安装/下载依赖或运行go mod tidy/get/build/test。通过仓库ci.yml已存在go-modules-regen job在远端生成并固定go.mod/go.sum；创建Ready PR时带现有go-modules-regen label，按实际触发方式运行该既有CI。生成后正常fetch/merge机器人提交、移除label，再确认最终head普通CI；不伪造sum，不新增workflow，不把regen的临时检查当最终通过。
- 对象GET必须使用记录自己的storageKey；已有S3记录不应因当前全局provider=mysql被错按MySQL读取。provider只决定诊断分支/新资产存储策略。
- 直接媒体路由的URL使用存储配置TTL；StorageService显式expiresInSeconds仅在有限正数时floor并至少30，否则用配置TTL。任务详情先按getSignedUrlTtlSeconds把有效TTL floor并钳制30..86400，读取失败默认300；修正现有Go只读DB单键而遗漏S3环境TTL回退的问题。
- response-content-type使用规范化类型；response-content-disposition为preview且inlineSafe时inline，否则attachment；文件名按现有kind/id/扩展名并转义反斜杠/引号；response-cache-control为private, max-age=300。这些值必须参与S3签名，不在签完后随便拼query。
- SVG不在inline白名单，不能生成inline preview；未知二进制保留attachment。storageKey中的中文、空格、加号、百分号和斜杠交给SDK正确编码，不二次转义。
- 详情投影按Nest分别处理preview/download签名失败：warning且该URL缺省，保留资产与其他结果；缺storageKey不伪造URL。公共HMAC媒体路由发生签名/配置错误则沿原服务错误语义返回，不能全部吞成404。

## 五、数据库、缓存、副作用与具体优化

- 媒体签名只读CrawlMediaAsset/CrawlMediaBlob/SystemSetting；详情Mongo读取保持原租户过滤。不得写媒体业务记录、迁库或新建资产。
- 保留共享storage:settings键、原始记录形状和60秒TTL，Redis失败回DB并warning；不新增带明文secret的日志或平行配置缓存。已有PATCH的事务/审计/缓存失效不改。
- 一次详情请求读取一个有效存储配置快照，供该批S3资产生成URL；不要每个资产/每种模式重新查9个设置。用具名强类型快照，不建立新的分布式锁或无限客户端缓存。
- 实际诊断：mode=mysql只SELECT1；mode=s3依次HeadBucket、PutObject、DeleteObject，每步独立捕获，因此head/put失败也要尝试后续步骤。写text/plain、Cache-Control:no-store、内容ok:<时间戳>，汇总三check的ok，error优先head→put→delete，返回真实HTTP状态/requestId（存在时）。
- 具体优化：把Nest固定__healthcheck__/storage-connection.txt改成同前缀下每次唯一的测试对象key，delete只删本次key，避免并行测试覆盖/删除彼此对象或碰到已有固定键。保持返回JSON契约及三步执行语义；不新增清理worker。
- 诊断确实会产生一次远端测试对象写入/删除，必须在PR说明。媒体GET/presign不会HEAD每个对象，也不会主动下载内容；不要引入额外探测I/O。
- Nest原方法没有该诊断的业务审计/outbox，不为了迁移虚构新审计、入队或事务。测试对象残留/删除失败在checks明确报告，不假称清理成功。
- 唯一外部执行边界是S3/兼容存储。没有BullMQ、cron、采集消费者、crawl4ai、SMTP或模型调用的执行权。本次规划没有实桶验证。

## 六、开关、资源初始化与回滚

- 新诊断模块独立API_GO_STORAGE_DIAGNOSTICS_MODE：空/legacy/go，默认legacy，非法值启动失败；只控制POST /api/admin/settings/storage/test及必要OPTIONS。不要把整个/admin/settings/storage前缀交给新handler。
- 诊断go独立要求DATABASE_URL/JWT_SECRET/Redis，不要求INFRASTRUCTURE_SETTINGS_MODE、CRAWL_READ_TELEMETRY_MODE、GraphQL或Mongo同时go。不在启动时调用S3/SELECT1或要求配置桶已经可连；实际诊断在请求中执行。
- 媒体路由与REST任务详情继续由现有API_GO_CRAWL_READ_TELEMETRY_MODE控制，空/legacy/go默认legacy；本批补齐其实现，不另加会让已启用读接口继续残缺的S3子开关。
- GraphQL详情继续由READ + SETTINGS_CRAWL_READ双父模式控制，单独启用时也要有S3配置reader/client注入，不依赖REST模式或诊断模式go。
- 只开诊断：初始化MySQL/JWT/Redis，无Mongo。只开REST读或只开GraphQL详情：沿其既有资源要求，S3签名能力可用，诊断仍Nest。全legacy保持原入口回退。
- main.go中诊断mode要同时纳入无效DSN阻断、needsCredentialedGo/DB/auth/Redis条件、精确路由与wire调用；ModeGo却未挂handler会501，不能当自动回退。连接复用现有关闭路径，SDK按需创建，不启动worker。
- 回滚诊断只改新变量legacy；回滚REST媒体/详情按原CRAWL_READ_TELEMETRY_MODE改legacy；GraphQL按SETTINGS_CRAWL_READ改legacy。无需删对象/缓存、回滚schema。Web→NestJS与canary=0保持，Compose/示例新增变量默认legacy。

## 七、文件所有权和并行任务

本批允许：
- 新objectstorage包；infrastructuresettings的运行时配置导出、诊断独立handler与最小auth复用；crawlreadtelemetry媒体服务/构造/详情接入；settingscrawl.Options及crawlReader的最小依赖注入。
- 新cmd/api/storage_diagnostics.go或storage_objects.go；现有crawl_read_telemetry.go；main/config/legacyproxy的新诊断模式、HTTP规则和settingscrawl.Options参数；必要同域少量测试、go.mod/go.sum的远端生成、README/env/compose单项文档。
- 本任务与prompt、crawl/infrastructure-data域页、相关GAPS/BACKLOG/AUDIT/DEPENDENCIES/EVIDENCE事实。

并行排除：
- NEWS-BRIEF-001已发出，reserved，拥有newsevents简报、publicportal简报gateway/helper、llmlogs writer；不触碰这些包或API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE/newsevents.Register段。
- WORKSPACE-WRITE-001/#70仍OPEN/Ready，head adb765d0180e8b34910181e8c6fde8be400a2dff；拥有工作台8写、alerts/history/workspacewrite及GraphQL顶层接线。本批不领取BL-01/GAP-GQL-001，不修设置13写。
- main/config/compose不可避免共享，但本批只追加诊断mode/HTTPwire/资源条件及settingscrawl.Options依赖参数；#70保留GraphQL顶层路由/多写模型，简报保留newsevents段。优先新增独立helper/规则文件与单行增量，不覆盖长OR表达式整段，不删除他人条件。
- 开始与最终接线前都查开放PR实际diff与本机认领。若同一语义段产生新重叠，先做独立业务文件，共享段等先行提交稳定或合main后正常merge取并集；不rebase、不跨窗口发消息。
- 排除头像presign、真实采集资产上传/删除、CrawlCleanupOutbox、worker、Frontier、队列、全存储设置重构、vector/Nominatim/邮件诊断。BL-15其余范围仍未认领。

## 八、精简验证与交付

- Go业务DTO、配置、错误结果、缓存与副作用用具名强类型，禁止any/interface{}/map[string]any/[]any承载新业务。驱动/GraphQL通用协议边界可沿用，扩展JSON叶子可json.RawMessage；源码注释英文，文档/提交/PR中文。
- 本机不安装依赖，不运行任何build/test、Docker或服务，覆盖AGENTS中的本地测试要求。允许gofmt、git diff --check、只读静态审查。
- 少量有价值的现有CI行为测试覆盖：HMAC/跨租户；MySQL回归；S3 key/endpoint/path-style与响应参数签名；REST/GraphQL两处注入与TTL回退；签名失败详情保留；配置解密/Redis回退；诊断mysql及S3三步失败汇总/唯一key；新模式独立资源/路由组合。不增加专用smoke、测试框架或本地服务。
- 使用已有普通CI，记录最终head SHA、run URL、verify和适用job。依赖生成后必须在最终head重新确认，skipped、旧head成功、main成功都不能当本批通过。真实S3/MinIO、签名下载和部署未执行时逐项注明，不能用静态签名测试冒充实桶成功。
- 开工更新STORAGE-MEDIA-001为in_progress，实际基线/worktree/共享文件边界写清；未合main的规划记录从已发布文档分支恢复，仅更新自己的任务，不覆盖NEWS-BRIEF-001或#70状态。
- 交付回写本任务、精确入口/必要内部步骤、独立开关、TTL与测试对象优化、PR/head/CI、部署/实网未知项。GAP-CRAWL-001在业务PR开着时仍开放；BL-03及BL-15.storage/test指向本任务，其他候选保留。只有确认实际main落地才能关闭缺口、标merged或更新main注册数。
- 中文emoji + type(scope)提交，只stage本批改动，正常push并创建Ready PR。不合并GitHub PR、不auto-merge、不amend/rebase/force-push。远端regen机器人提交用普通merge同步，不覆盖其他窗口。
- 最终给出PR、精确head和CI链接、三条HTTP/一个已有Query中本批完成的分支、配置/存储复用位置、权限与签名语义、开关回滚、对象测试真实副作用、明确剩余范围与未验证外部调用。只有storage/test是新增接管入口，不把已有3个入口重新计作新增迁移。
