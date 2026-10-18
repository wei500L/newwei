# 目标

执行 NEWS-BRIEF-001：在 apps/api-go 补齐事件详情页 newsEventBrief 的完整同步生成链路。首次打开无有效缓存的简报、切换语言、来源指纹变化和点击强制刷新时，由 Go 选源、调用真实模型、校验与清洗结构化输出、返回简报并写回缓存；有效缓存继续复用，无事件或无有效来源继续返回合法 null。不能以固定错误、空简报、仅缓存读取或回调 Nest 冒充完成。

本次只做后端迁移。现有 Web 简报页已经调用该 Query 和 forceRefresh，不改 UI、GraphQL SDL 或客户端签名。

## 一、基线、认领与独立工作目录

- 仓库：/Users/oo/project/newwei。规划代码基线：origin/main 9d0462e16d88d146b8afbf67cdd58d8b7419ff29，2026-10-18，Europe/Moscow。
- 地图 #69 已 merged，实际 merge SHA 即上述基线。相对地图业务基线 3cedce9aa3200436aba3596f63b559de5490cec8，仅增加文档/导航，没有业务源码变化。main 普通 CI 39127631691 success：https://github.com/wei500L/newwei/actions/runs/39127631691 。此证据不代表模型实网已验证。
- 开始先 git fetch origin main，取最新 SHA；查询 gh pr list --state open、gh run list --branch main --limit 5、git worktree list，并读取适用 AGENTS.md、地图 README/PLANNING/tasks/README、本任务及 news/AUDIT/DEPENDENCIES 对应部分。只增量核本域；不得全仓重审。
- 规划记录发布分支是 docs/plan-news-event-brief；若尚未合 main，fetch 该分支，用 git show origin/docs/plan-news-event-brief:docs/refactor/migration-map/tasks/NEWS-BRIEF-001.md 及同目录 NEWS-BRIEF-001.prompt.md 读取认领与本提示词，同时核对该规划 PR 最新状态。不要假设未合并记录已在 origin/main。
- 唯一编码分支：refactor/go-news-event-brief；唯一编码 worktree：/Users/oo/project/newwei-go-news-event-brief。从当时 origin/main 创建；若已存在先检查 HEAD、状态和归属，安全复用本任务的目录，不覆盖其他任务。规划 worktree /Users/oo/project/newwei-plan-news-event-brief 仅保存文档，不能作为编码目录。
- 本任务已 reserved，提示词交给本次用户的编码窗口；没有开工证据，不能声称执行器已运行。如已有同范围 PR/认领或 main 已补齐，先据源码缩小剩余范围，不重复迁移。

## 二、精确入口、鉴权与返回契约

唯一迁移入口是 POST /graphql 的 Query：
newsEventBrief(eventId: String!, forceRefresh: Boolean, language: String, maxSources: Int): NewsEventBriefModel

- 根权限 items.read；复用现有 GraphQL JWT、Redis 撤销、membership/权限重推导。orgId 只能来自服务端 identity，不能从参数、公共门户组织或模型 metadata 决定。
- 先按 orgId + eventId 查询 NewsEvent，确认可访问后再读取其 NewsEventItem/ProcessedArticle/Article。不存在或属于其他租户返回 null；无有效 URL 来源返回 null。不要附加公共门户 active/title/summary 等展示资格。
- 返回 version=1、generatedAt ISODateTime、language、detailedSummary、tldr、keyPoints、whyItMatters、latestUpdate、whatToWatch、comparison、limitations、sources。points 与 citations 数组按模型返回，空列表用 []；latestUpdate/comparison/limitations 可 null；sourceLabel/title/publishedAt/processedItemId/processedArticleId 可 null。
- 模型输出字段使用 snake_case，GraphQL 投影使用 camelCase；复用已有具名 NewsEventBrief*Model 与 DateTime 序列化，不重建一套不兼容模型。
- 无身份、无权限和输入/字段校验沿用现有 GraphQL engine 的契约；不能在生成失败时返回合法 null。普通网络失败、空模型输出、非法 JSON/结构错误应形成该字段的 Internal server error；governance 的 503 StatusError 要转换成对应 contract.Failure，保留503的 GraphQL extensions/HTTP 语义，原原因只进安全日志。当前Nest global-exception.filter.ts与Go fieldFailure均掩蔽5xx对外消息，不改成直接暴露publicportal错误或重写公共执行器。

事实源均按上述基线：
1. apps/api/schema.gql 的 Query.newsEventBrief。
2. apps/api/src/graphql/resolvers/news-events.resolver.ts:261 起 newsEventBrief。
3. apps/api/src/graphql/models/news-event-brief.model.ts。
4. apps/api/src/modules/news-events/news-event-brief.service.ts 的 getBrief、selectSources、normalizeLanguage、normalizeMaxSources、generateBriefWithLlm。
5. apps/api/src/modules/news-events/news-event-brief.schema.ts。
6. apps/api-go/internal/graphqlread/exec/engine.go 的 authorizeRoot、fieldFailure 与预规划；复用而非改写公共执行器。

## 三、DTO、默认值与生成步骤

- language 缺省/null/空白为 zh，trim 后小写，zh*/en* 归 zh/en；其他值 UTF-16 长度不超过8则保留，否则 zh。不能套公共门户从 event.language 选择输出语言的规则。
- maxSources 缺省/null 为10，GraphQL Int 输入钳制3..20；forceRefresh 仅显式 true 才跳过缓存。eventId 必填 String，不擅加 UUID 校验或变更空字符串语义。
- 最新200个 NewsEventItem 先按 createdAt DESC 读取；有效 URL 去空，候选按 publishedAt→crawlAt→processedAt 的时间回退排序；按 URL 去重，再优先不同 sourceLabel（忽略大小写）或 hostname，最后补足来源，索引1起。保持既有选源与指纹兼容，不能为凑来源越过租户边界。
- Go itemRow 已加载 Summary/KeyPoints，但 briefSource 当前没有把它们带入生成链：补具名字段与规范化。keyPoints trim/去空/去重，上限20；提示词用前8条。
- 指纹仍是 version/language/lastAt/有序来源 processedArticleId、processedItemId、url 的既有 SHA-256 JSON 序列；ISO时间与字段顺序须保持 Nest/Go/公共门户 briefV1 可互读。
- 有效缓存须匹配 version=1、language、fingerprint，forceRefresh=false 才命中；不新增平行 Redis 简报缓存，不把 newsEventBrief 加入 GraphQL 响应缓存白名单。
- 提示词保留 Nest 的只根据来源、事实引用、时间线、分歧、限制与观察点要求。事件标题按 title ?? primaryEntity ?? primaryTopic ?? id 的 nullish 语义取值，别用空串回退擅改契约。事件摘要限600字符；来源摘要限700；前8条 keyPoints 拼接限900，按原 truncate 的 UTF-16 截断/省略号语义处理。
- 使用 temperature=0.2、top_p=0.9、max_tokens=1200（responses 为 max_output_tokens）。metadata 为 feature=news_event_brief、eventTitle、sources 数量，组织单独传入。
- JSON 解析支持原 safeJsonParseFromText/parseBriefJSON 的代码块、文本包裹行为；结构校验以 Nest schema 为准，不能仅检查几个字符串：必要 detailed_summary/tldr、key_points 1..10，why_it_matters<=10、what_to_watch<=12、comparison 两组各<=12、citations 为正整数且<=12，处理各字段缺省与允许 null。
- 校验后清洗：trim 文本、列表过滤空 point，citations 先过滤有效索引1..来源数，截前12，再去重升序；latest_update单点按Nest trim，不因空白清洗结果擅自改成null。latest_update/comparison/limitations 的缺省/null 不应被错误拒绝；缓存generatedAt无效时按原服务使用当前时间。新生成的generatedAt按Nest在调用模型前取值，以UTC毫秒输出。不要把公共门户现有 JSON schema/sanitizer 假定为完全等价；尤其核对 latest_update 的 nullable、key_points 下限和 response-format 在两种 API surface 的形状。

## 四、已有 Go 基础与复用方案

- apps/api-go/internal/graphqlread/newsevents/brief.go：已有 loadEvent/loadItems、selectBriefSources、briefFingerprint、readCachedBrief、sanitizePayload 和 model 投影；newsEventBrief 末尾固定错误是本批要替换的缺口。
- 同包 store.go：eventRow/itemRow、按租户查询与来源读取；models.go/register.go：现成返回模型及 items.read root 注册。
- apps/api-go/internal/publicportal/story.go 的 Service.brief 已有选源→Complete→解析/清洗→metadata 写回，能作对照，不能调用 Service.Story 来替代 GraphQL 业务。
- publicportal/gateway.go 的 gatewayClient.Complete、resolveCompletionProfile、applyGovernance、postCompletion 已有模型配置、密钥解密、主/备用模型、超时重试、chat_completions/responses 与路径回退；store.go 的 GatewaySettings 读取 SystemSetting 的 llm_gateway_profiles、litellm_proxy_governance。它们大多私有，不能在新包直接调用。
- 在 publicportal 新增小而明确的导出简报 completion 表面（例如 brief_completion.go 中 BriefCompleter、BriefCompletionRequest/Result、构造器），复用已有 gateway 逻辑。输入、输出、metadata、usage、attempt observation 必须具名强类型；内部依赖缩小到 GatewaySettings reader，不为 GraphQL 构造公开门户首页/频道业务。
- newsevents 通过该能力与具名配置/option 接入。保持公共门户既有组织/语言/路由/缓存语义；必要 schema/协议修正只限本批真实共用的简报路径。不要新建一套模型网关管理、复制整份 gateway.go，或为了复用把所有门户业务重构。
- llmlogs 已有 NewService、MetadataPolicy 和 llmrequestlogs 读模型，尚无可直接复用的 completion 日志写服务。允许在该包增加独立具名 completion writer，复用已有 policy 读取/规范化，原查询/导出不改。

## 五、模型配置、外部调用和必要副作用

- 从 MySQL gateway profiles 选择有效 active profile，否则按 Nest 选择可用默认 profile；尊重 enabled、model、fallbackModels、apiSurface、responseFormatMode、sendMetadata、timeoutMs/maxRetries 和加密 apiKey。环境复用 cfg.SettingsEncryptionKey/LiteLLMAPIBase/LiteLLMAPIKey/LiteLLMTimeoutMs/LiteLLMMaxRetries，不读真实 .env，不把环境 API key 无条件覆盖 profile。
- 受治理目标的 managedRuntimeKey 缺失或不可解密继续报503，不能绕过治理使用旧 key；非受治理 profile 保持原选择规则。事实源：Nest llm-gateway-settings.service.ts getActiveConfig/applyManagedProxyGovernance、litellm-proxy-governance.service.ts getManagedRuntimeApiKeyForProfile，以及 Go applyGovernance。
- 保留 API base 规范化、/v1/chat/completions→/chat/completions 或 /v1/responses→/responses 的404/405回退、内容提取、可重试状态/超时与备用模型顺序；对明确 guardrail/兼容性终止错误按 Nest 语义停止，不把所有错误无限重试。不要新增泛化重试框架。
- 本 root 的 feature=news_event_brief 不在 Nest UNTRUSTED_CONTENT_FEATURE_TOKENS 中，不强加 assistant moderation 配置依赖；但上游已返回的 guardrail 拒绝不能被当成功。startRuntimeRequest/releaseRuntimeRequest 当前只建日志上下文/空释放，不是应迁的租约或配额系统。
- 迁移该调用实际产生的 LLM request log 副作用：按每次真实尝试记录 orgId、completion 类型、model、success/error、latency、usage/cost（未知为 null，不能造0）、feature、profile、governance/authMode/target、apiSurface，以及按现有 llm_request_log_settings allowlist/prefix/长度策略过滤的 metadata，写 Mongo llmrequestlogs，含 createdAt/updatedAt。默认 policy 不保留 eventTitle/sources，不能顺手全量写提示词或密钥。记录备用模型切换的现有可观测信息；不扩展成 /metrics 迁移。
- 日志写入为 best effort，失败记录 warning，不使成功简报失败；保留 Nest 的每尝试日志语义，未发起模型调用的缓存命中/合法 null 不伪造请求日志。事实源：Nest litellm.service.ts acompletion/executeWithRetry/executeResponsesCompletionWithRetry/writeRequestLog 和 llm-request-log.service.ts logRequest/normalizeEntry。
- 成功生成后写 NewsEvent.metadata.briefV1：version/language/fingerprint/generatedAt/sources/payload；来源缓存日期为ISO字符串或 null，返回还原模型 DateTime。updatedAt 维持毫秒精度，UPDATE 限 id + orgId。
- 具体优化：用 MySQL JSON_SET 仅更新 briefV1 叶子（metadata 非对象/null 按 Nest 视作空对象），保留同一行其他最新 metadata 叶子，避免读旧快照后整份覆盖 timeline/其他生成数据。该语句原子更新即可，不在模型网络调用期间持事务/行锁，不引入分布式锁或数据库迁移。
- 生成成功而缓存写回失败时 warning 后仍返回生成结果；不清除旧缓存，不用写回失败掩盖已生成内容。模型失败不写成功缓存。Nest/publicportal 仍可能写 metadata，本优化只保证本次 Go 更新不覆盖当时其他叶子，不能宣称解决了所有跨执行器竞争。
- 本批没有 BullMQ producer/worker、cron、邮件、入队、事件 ingestion 或外部来源采集的执行权；LiteLLM/实际模型是直接 HTTP 外部依赖，真实凭据/模型连通尚未验证。

## 六、允许文件与并行隔离

主要业务范围：
1. apps/api-go/internal/graphqlread/newsevents/ 的 brief.go、新增生成/缓存文件、service/store/register 必要增量。
2. apps/api-go/internal/publicportal/ 的简报 completion 导出表面、gateway 及共用 schema/必要适配；story.go 仅接入强类型共享 request 所必需的变更，其他门户功能排除。
3. apps/api-go/internal/llmlogs/ 新增 completion writer 与最小 policy 导出支持；既有日志 API、设置 CRUD、导出排除。
4. apps/api-go/internal/config/config.go 的新子开关；cmd/api/main.go 仅新闻事件 Register 参数/构造与对应精确日志；必要的同域少量测试与 api-go README、infra/docker/.env.sample、docker-compose.yml 的单项开关声明。
5. 本任务、prompt、news 域页、GAPS/BACKLOG/AUDIT/DEPENDENCIES 和必要 EVIDENCE 的本批事实。

并行事实：规划核对时 #70 OPEN/Ready，head adb765d0180e8b34910181e8c6fde8be400a2dff；业务与 main 差异已读，其工作目录干净，但不代表执行器已退出。它占用 WORKSPACE-WRITE-001 的8写、workspacewrite、alerts/history 模型、main/config 与 compose 的工作台开关。其普通 CI verify 成功；skipped smoke 不算通过。不能重派这8写。

- 本批不改 alerts/history/workspacewrite/settingswrite/orgaccesswrite，不认领 BL-01/GAP-GQL-001，不修 #70 的顶层 GraphQL 路由 OR/资源条件，不重复迁设置13写。
- 共享文件所有权按语义段隔离：#70/BL-01 保留顶层路由、needsCredentialedGo、无效DSN阻断、多写模型注册；本批仅拥有已有 read/newsEvents 区块中的 newsevents.Register 调用、自己的 config 子开关和单项 env 记录，不添加新的顶层接管条件。
- 执行前再次读 #70 实际 diff。若其推进到同一语义段，本批先完成隔离业务文件，共享段等待先行任务交付/普通 merge 后再接入；不得抢修、整段覆盖或反复询问已授权范围。必要时正常 merge 更新后的 origin/main，禁止 rebase。
- BL-17 公共门户/模型客户端候选尚未认领；本任务保留上述简报 helper 范围，后续不得并行另领同文件。排除 S3媒体、items列表/导出、来源策略、新闻推荐/指标刷新和所有后台执行迁移。

## 七、独立开关、初始化、注册与回滚

新增 API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE，接受空串/legacy/go，默认 legacy，非法值 config.Load 失败。它是精确 root 的独立子开关：

- READ=go + NEWS_EVENTS=go + BRIEF=go：登记本 root 和模型，使用 Go 全链路。
- 前两者 go、BRIEF=legacy/空：只登记其余5个新闻事件 root，含 newsEventBrief 的 operation 在执行副作用前整份回 Nest；不得在 resolver 中临时反向请求 Nest。
- BRIEF=go 而 READ 或 NEWS_EVENTS 非 go：Load 明确报配置依赖错误，不能悄悄启用其他父开关或挂一套缺资源 handler。
- 父开关 legacy 且 BRIEF 默认 legacy：保持已有回退。

这是有意收回原本已注册但不完整的单 root 默认接管，文档必须说明；其他5读、其他 GraphQL 域默认保持。不要把新模式仅定义为“允许模型调用”却让 legacy 下继续执行残缺的 Go root。

复用父读模式已有 sharedDB、JWT/authenticator、Redis 与共享 Mongo（日志使用）；不依赖 PUBLIC_PORTAL_MODE=go、LLM_LOGS_MODE=go、gateway配置管理HTTP模式或任何写模式。模型客户端懒加载配置，不在启动探测真实模型。资源生命周期沿用现有连接/关闭路径，无新 worker/goroutine 调度器。

新变量在 Compose/示例中显式默认 legacy，不改 Web→NestJS、canary=0 或部署流量。回滚本 root 将 BRIEF 改 legacy；不需要删缓存、回滚 schema 或停 Nest，旧 briefV1 保持兼容。不要改变 #70/设置写/组织写的注册与组合条件。

## 八、实施与精简验证

- 专注上述功能，Go 业务 DTO、数据库 JSON、缓存文档、审计/日志、模型请求结果使用具名强类型；禁止 any/interface{}/map[string]any/[]any 承载新业务数据。GraphQL/驱动通用协议边界可沿用，扩展 JSON 叶子可用 json.RawMessage；不要借机重写既有无关动态模型。
- 保留鉴权、租户隔离、业务校验和必要事务；源码注释英文，文档、提交与 PR 中文。不要修改 Nest 装饰器/签名。
- 本机不安装依赖，不运行 build/test（含 go build/go test）、Docker 或服务。允许 gofmt、git diff --check、只读静态复核；不要用“未本地运行”冒充通过。
- 少量有效行为测试交给现有普通 CI：鉴权/跨租户合法null；命中不外调；miss/force/语言或指纹变化生成；选源摘要/要点进入提示词；结构缺省/null与引用清洗；模型空/坏JSON/失败；治理key错误与surface/fallback；缓存写失败仍返回结果；其他metadata保留；日志best effort和元数据过滤；四组开关注册/整份回退。优先扩展现有测试，不新增专用 smoke workflow，不建设泛化测试框架。
- 静态核对 root/model/返回nullable、错误转换、where租户条件、写回副作用、选源/指纹与父子注册；尤其避免复制公共门户的语言/组织选择与宽松校验。
- 推送后观察现有普通 CI，记录该 PR 精确 head SHA、run URL、verify 与适用 job 结论；不能拿旧 head、skipped smoke 或 main CI 当本批验证。失败先判断是否本批引起，必要时修复并正常追加提交。
- 不假称真实 LiteLLM/模型 HTTP、MySQL/Mongo 或生产切流验证成功；未运行项目分别列明。不要为获取这些证据在本机安装或启动依赖。

## 九、地图、提交与交付

- 开始时把 NEWS-BRIEF-001 更新 in_progress，保存实际基线/分支/worktree、共享文件边界；若规划记录未进 main，将本任务与prompt从已发布规划分支带入自己的记录，不能遗漏认领证据。不要覆盖其他任务条目。
- 完成时按 PLANNING 回写实际实现、精确root/开关、日志与缓存副作用、具体优化、剩余分支、PR/head/CI与外部验证边界。GAP-NEWS-001 只有确认实际 main 落地后才能关闭；PR中只能记“候选实现/等待合并”。BACKLOG BL-02 改指本任务，不再列未认领；保留其他候选。
- 更新 news/AUDIT 仅本root实际核对深度、DEPENDENCIES 的具体复用/执行权；默认、Compose、实际部署分别记录。不得在 PR 开着时提高 main 覆盖数或把整份 news/async 标完成。
- 只 stage 本批文件，中文 emoji + type(scope) 正常提交和 push，创建 Ready PR。必要同步只用普通 merge，不合并 GitHub PR、不启用 auto-merge、不 amend/rebase/force-push。已有 AGENTS 的本地测试要求由本提示词明确的禁本地运行约束覆盖。
- 最终交付：PR链接、head与普通CI结果、唯一root的完整行为、代码复用位置、强类型边界、JSON叶子写回优化、精确开关组合/回滚、仍由Nest执行的范围、未进行的实网/部署验证。PR描述围绕“事件简报冷生成与强制刷新由Go完成”，不要声称新增7–20入口或整域迁移完成。
