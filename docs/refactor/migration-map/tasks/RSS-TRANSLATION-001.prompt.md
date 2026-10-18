# 目标

完成 wei500L/newwei 的 `RSS-TRANSLATION-001`：将 RSS 阅读器批量翻译完整迁入 `apps/api-go`，支持标题、摘要、要点和 Markdown 正文，包含 DeepLX 主备、LLM、缓存、部分失败、每日统计和模型请求日志。补齐一个新 Mutation，不重迁已完成的条目列表/导出，不按接口数凑批次。

本任务仅后端。专注迁移和具体功能，不堆防御性代码、分布式锁、重试平台或泛化框架。Go 新业务 DTO、返回、数据库 JSON、缓存和日志用具名强类型，禁止 any/interface{}/map[string]any/[]any 承载业务数据；通用 GraphQL/驱动边界沿用，扩展 JSON 叶子可用 json.RawMessage。保留鉴权、租户隔离、必要业务校验；新增/修改源码注释英文，文档、提交、PR 描述中文。

## 1. 基线、认领与工作目录

- 规划基线：fetch 后 `origin/main 90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`。普通 CI https://github.com/wei500L/newwei/actions/runs/39149114456 success；不表示翻译外部服务、部署或流量已验证。
- 仓库 `/Users/oo/project/newwei` 的 checkout 可能旧。先 fetch origin main，查最新 SHA、开放 PR、main 最近五次 CI、git worktree list；读适用 AGENTS.md、迁移地图 README/PLANNING/tasks/README、本任务和 items 域，只核对本候选增量。
- 规划记录和稳定提示词发布在 `docs/plan-digest-delivery` 的 Ready PR #85：https://github.com/wei500L/newwei/pull/85 。main 尚无记录时从该 PR 读，不以文档分支替代业务基线。
- 独立业务分支 `refactor/go-rss-translation`；worktree `/Users/oo/project/newwei-go-rss-translation`，从开工时最新 origin/main 创建。已有同任务目录先核归属/HEAD/差异再复用，不动其他目录。同步 main 正常 merge，不 rebase。
- 若同范围已认领/合入，先核实际剩余分支，不重复迁整批。本任务不实施摘要投递，也不创建其他对话或定时自动化。

## 2. 精确 root、权限和返回

新迁 Mutation：
`translateRssItems(input: TranslateRssItemsInput!): TranslateRssItemsPayloadModel!`

权限 `items.read`，不是 items.write。orgId 由既有 GraphQL JWT/权限/组织重推导链取得，不从 input 或缓存消息取得；保持现有 GraphQL 对机器令牌的处理，不另造鉴权。

已迁 Query `rssTranslationStatus(targetLanguage: String): [RssTranslationProviderStatusModel!]!` 保持原 READ + ITEMS_READING 条件和既有顺序 deeplx→llm，仅修本任务相关的共享缓存写回缺口。不把状态 Query 重计为新增迁移。

返回模型：provider、targetLanguage、translations 非空；translations 可为 []。每项 itemId 非空，title/summary/keyPoints/cleanedMarkdown 可空；未请求或源字段不存在的字段投影为 null，不补空字符串/空数组。找到记录但没有有效字段，或找不到本组织记录，返回仅 itemId 的项；不得借机返回其他组织内容。

权威契约位置：
- `apps/api/schema.gql` 的 TranslateRssItemsInput、TranslateRssItemsPayloadModel、RssItemTranslationModel 及两个 enum。
- `apps/api/src/graphql/dto/item.input.ts` 的 TranslateRssItemsInput/RssTranslationProvider/RssTranslationField。
- `apps/api/src/graphql/models/item.model.ts` 与 `resolvers/items.resolver.ts` 的 translateRssItems/rssTranslationStatus。
- `apps/api/src/modules/items/items-rss-translation.service.ts` 全部执行链。

## 3. DTO、默认、null 和错误语义

- itemIds:[String!]!，DTO 原始数组上限50，每项必须字符串；不要求非空数组。先执行 DTO 原数组长度限制，不能靠去重让超过50的输入通过。随后 trim、删空、保序去重，service 上限仍50。
- provider:RssTranslationProvider! 默认 deeplx，只有 deeplx/llm；targetLanguage:String! 默认 zh-CN，DTO最长16，trim后空串归 zh-CN。显式 null 不等于缺省，按非空 SDL 拒绝。
- fields:[RssTranslationField!] 可省略/null，最多4；枚举 title/summary/key_points/cleaned_markdown。省略/null/[] 都用 title+summary+key_points，保序去重。不要让显式[]变成“不翻译”。
- 规范化后 itemIds 为空时，立即返回 provider/targetLanguage/translations=[]，不检查provider、不访问Mongo、不计请求指标。
- provider 检查先于翻译缓存读取；不能用旧缓存绕过已禁用provider。状态仅反映配置可用性，不做实网探测。
- DeepLX 仅接受 zh、zh-cn、zh-*，否则400，使用源服务的完整错误消息。fallback配置完整可使deeplx provider可用；没有启用的completion profile时LLM不可用。
- 保留错误依据：`RSS translation accepts at most 50 itemIds per request.`、`RSS translation service is unavailable`、`No enabled LLM gateway profile is active.`，以及服务中DeepLX/fallback状态消息；通过contract.Failure及现有GraphQL错误链表达，不把错误伪装合法空。
- 批次采用原 Promise.allSettled 语义：保序保留成功项，某项抛错只移除该项，不丢其他成功项。上游某段翻译失败的普通best-effort分支返回该段原文、不缓存失败；缓存/Mongo/全局provider配置错误按源层级处理。不能把所有失败都统一改成整批报错或全部成功。
- assertProviderAvailable原先通过getProviderStatuses读取两种provider状态；全局设置读取/治理解析抛错仍按源层级处理，不能借“只选一个provider”吞掉这些错误。后文未选provider无启动依赖仅指启动校验，不是改写此请求控制流。

## 4. 已有 Go 能力与真实复用边界

1. `internal/itemsreading/translation.go` 已有 provider状态、SystemSetting读取、`situation_monitor:settings` 30秒{exists,value}缓存、API key解密、LLM profile状态规范化。大多数helper私有，runtime结构目前缺timeout/retries/concurrency；新增 `translation_support.go` 窄导出读取端口，补完整具名runtime，不跨包调用私有符号，不强开items HTTP。
2. `internal/publicportal/gateway.go` 已有active profile选择、解密、managed governance、API base规范化、模型fallback、HTTP、usage/cost与部分错误helper；`publicportal.NewMySQLStore(db).GatewaySettings` 已公开，可读profiles/governance完整原文。新增 `publicportal/rss_completion.go` 等RSS专用具名端口，选择性复用经核对等价helper。
3. **不能直接用 NewBriefCompleter 翻译**：现有brief请求固定temperature=0.2、max_tokens=1200且带简报JSON schema；RSS需要temperature=0、动态tokens、文本响应及不同metadata。不能强开publicportal HTTP，也不改简报输出行为。
4. `internal/dashboardwarmap/translate.go` 已有DeepLX/fallback协议，但入口/runtime/helper私有；其中settings缓存key为situation-monitor:settings，与本链Nest实际situation_monitor:settings不同，不得把完整旧translator直接当成RSS客户端。按本链Nest事实在新RSS业务文件实现具名客户端，必要等价helper可窄复用，不扩修整个地图翻译域。
5. `internal/llmlogs/completion.go` 已有具名日志文档、字段归一化、metadata policy。其metadata只有简报字段，不足以承载RSS source/targetLanguage。新增 `llmlogs/rss_translation.go` 专用typed writer，复用稳定policy/normalizer和既有DB/Mongo，不覆盖#81占用的completion.go。
6. `internal/classificationrssops/translation.go` 已有每日指标查询，说明表的读取已迁；本批新增指标写，不能重派其HTTP。GraphQL复用contract.Registry/RegisterMutation、Bind、Failure和现有executor，不重写引擎。

## 5. 记录选择、文本算法和缓存

Mongo processeditems 只查询 `{orgId, status:"completed", itemMetaId:{$in:itemIds}}`，取每个item最新createdAt记录，仅投影必要字段。不额外增加duplicateOf=null等原服务没有的限制。

result可为对象或JSON字符串；非法/空result成为空字段payload，不回退到更老版本。title→headline、summary→abstract采用trim后的非空回退，key_points取非空字符串列表，cleaned_markdown取非空字符串。输出按规范化itemIds顺序，与Mongo返回顺序解耦。

具体查询优化：在数据库侧按itemMetaId分组选最新记录，避免把每项全部历史result加载到Go。保留createdAt DESC，时间相同用_id DESC确定顺序并在文档说明；不新建无依据索引/迁移，不取第一条后遗漏其他item。

字段顺序和分块保持源算法：title→summary→key_points→cleaned_markdown；普通文本上限12000，Markdown总上限120000、目标块1600、最多80块，按JS UTF-16 length/slice语义核对，不用Go字节长度替代。

Markdown先按连续空行分段，trim/去空，尽量按双换行装块；长段再按单换行拆，超长单行按1600切。翻译后按双换行拼接并trim。超过总长度/块数直接返回原Markdown、skipTooLongCount+1；不要为“优化”改变原分块、顺序、结构或引入新的Markdown解析框架。

RSS外层缓存：
`rss:translation:v1:<providerKey>:<language>:<sha256(trimmedText)>`
- language=trim/lowercase targetLanguage
- DeepLX providerKey=deeplx
- LLM providerKey=llm:<trim/lowercase所选主模型名或default>
- 值为JSON字符串，TTL7天
- 同一次translateTextList内保序去重后MGET；回填原顺序/重复位置
- >12000的普通文本返回原文、不外调、不缓存，计skipTooLong
- 只缓存有效成功文本，失败无翻译则原文回退；不要缓存错误/null

DeepLX内层缓存仍沿Nest：`situation-monitor:translation:v3:zh-cn:multi:<sha256(text)>`，JSON字符串TTL30天。两层缓存不是一层，不能遗漏。原内层批次任一任务失败时best-effort接口返回空映射，但已成功的内层缓存仍可保留；别无意改成部分映射契约。

### 现有具体缺口 GAP-RSS-001

main的 `itemsreading.loadLLMGatewaySettings` 在共享 `llm_gateway:profiles` miss后，将仅有activeId和profile id/model/enabled的窄结构Marshal后写回该共享key。Nest LlmGatewaySettingsService在同key存完整normalized settings，包含apiBase/apiKey/协议及其他用途配置；这是状态查询破坏共享完整缓存的已确认静态缺口。

本批修复：状态reader不再用精简投影回填这个共享key。优先保留现有canonical缓存读取，miss时从DB规范化仅供状态返回，不回填窄结构；无需重做全套profile管理。不能为清理旧缓存盲目DEL整个共享key或宣称部署缓存已修复。新翻译runtime读完整profile，可用完整规范缓存或上述完整DB reader，绝不把状态DTO当连接配置。

## 6. DeepLX 主备与 LLM 完整执行

DeepLX事实源：`modules/situation-monitor/situation-monitor-translation.service.ts` 的translateTextsToZhBestEffort、translateHashesToZh、requestZhTranslation、requestViaDeepLx、requestViaFallbackApi、detectFallbackSourceLang及response/error helper；只迁RSS调用所需路径，不迁态势insights。

配置取SystemSetting situation_monitor_settings：stored→env→default；API key沿现有明文/加密存储解密，不自造新env密钥。timeout默认15000，1000–120000；maxRetries默认2，0–5；DeepLX并发默认2，1–5000；LLM并发复用translationMaxConcurrency但clamp1–20，读取失败回退2。两个限流器为服务实例共享并发上限，不是每item重新放大，不是分布式锁。

DeepLX：POST `<baseUrl>/<encodeURIComponent(apiKey)>/translate`，JSON text/source_lang=auto/target_lang=ZH。fallback在primary不可用或失败后执行，POST fallbackBaseUrl，JSON source_lang/target_lang=zh-CN/text_list:[text]。源语言按日→韩→中→法→德→英检测；中文直接原文，不支持语言按原失败分支。保留URL编码、response提取string/data/translation/alternatives、fallback translations[].text、数值code及HTTP错误语义。

重试只保留源已有网络/408/429/5xx规则，DeepLX每端maxRetries+1次、300ms*attempt退避、现有超时；可取消等待，不添加更多重试/熔断/凭据探测。不记录含API key的URL。

LLM事实源：ItemsRssTranslationService.translateSingleTextViaLlm和LiteLlmService.acompletion/prepareRequest/executeWithRetry/executeResponsesCompletionWithRetry/日志/guardrails helper，以及LlmGatewaySettingsService.getActiveConfig/applyManagedProxyGovernance。

- 复用启用completion profile选择、managed runtime key、fallback models、API surface、timeout/topP/sendMetadata配置；cache key用源服务取得的主模型，不把实际fallback模型偷偷替换进key。
- prompt按源服务逐字迁移：professional translation engine，保留Markdown/链接/数字/实体；user含Target language、已有目标语言则原文返回、Text及正文。
- temperature=0；max_tokens=max(512,min(4000,ceil(JS长度*1.6)))；metadata={source:"rss_translation",targetLanguage}。
- 明确 `maxRetries:1` 在LiteLlmService表示每模型最多1次attempt，不是“失败后再重试一次”；模型fallback仍执行。保留/v1路径404/405短路径回退。
- chat_completions与responses都支持；不发送brief schema。RSS未传response_format，profile none/json_schema时省略format，json_object时按Nest显式发送json_object，保留原契约而非自作主张改provider配置。
- 空choices/content、网络/模型错误按单文本原文回退，不缓存失败。guardrail/兼容性错误停止该次模型fallback；不能绕过阻断改用下一模型。
- rss_translation不在当前自动moderation feature集合中；不新增额外moderation调用。runtimeContext当前用于日志，不是配额租约，不引入不存在的许可平台。

模型每个真实attempt按Nest日志边界写llmrequestlogs，含orgId、requestType=completion、feature=rss_translation、model、success/error、延迟、usage/cost、apiSurface、profile/governance/authMode等。metadata保留source/targetLanguage并按既有allowlist/prefix/长度策略过滤；未上报值保持null。不要用brief metadata或写完整翻译正文；写日志失败best-effort，不反向使翻译失败。

## 7. 每日指标和业务副作用

完整finally记录RssTranslationMetricsDaily，唯一键orgId/date/provider/targetLanguage；date为UTC日，provider/language trim小写，计数累加、maxLatency取GREATEST、updatedAt更新，不用读取后覆盖造成丢计数。

保留requestCount/itemCount/textCount/cacheHitCount/cacheMissCount/translatedCount/failureCount/skipTooLongCount/totalLatencyMs/maxLatencyMs。计数层级按原createMetricsAccumulator/translateTextList/recordMetricsBestEffort，不能把请求条数、去重文本数、实际HTTP次数混成一类。provider全局检查等失败在finally仍记请求，若尚无failureCount则至少1；空itemIds早返不记。表/列缺失和写指标失败均不阻断翻译，遵源服务best-effort处理，不新增迁表。

翻译结果只写缓存/指标/日志，不覆盖processeditems原文/result，不写ItemMeta/read-model，不重建ES索引、不入队、不启动worker/Cron、不发邮件或通知。数据库写仅上述指标原子upsert；外部HTTP不放长事务。

## 8. 独立开关与生产接线

新增 `API_GO_GRAPHQL_RSS_TRANSLATION_MODE`，空串/legacy/go，默认legacy，非法值启动失败。写开关独立于READ、ITEMS_READING、ITEMS_LIST、PUBLIC_PORTAL、LLM_LOGS、网关管理及全部其他写模式。

仅本开关go时：初始化shared MySQL、JWT鉴权、Redis、Mongo及本批service/client/writer，登记这一个Mutation和返回模型；不注册旧items Query、不强开其他HTTP。需要JWT_SECRET/DATABASE_URL/REDIS_HOST/MONGO_URI；provider URL/密钥/profile/加密key保持请求时语义，不启动时实网探测，未选provider不强依赖其真实配置。

main中/graphql路由OR、无效DSN阻断、资源OR、handler OR、Mongo创建/复用/关闭和RegisterMutation必须一致，不能只加注册。新增独立cmd/api/rss_translation.go或窄wire避免扩大main。新graphqlread/rsstranslation adapter使用具名输入/返回，复用现有SDL和枚举，不改contract/exec引擎。

mutation-only、READ+ITEMS_READING+mutation、多写并开均成立；未支持root/字段必须在任何翻译/缓存写/指标副作用前整份operation回退Nest，不先执行半份。POST Mutation顺序/非空错误/GET 405/响应no-store沿现有executor，不能加Mutation响应缓存。

默认Compose/.env.sample为legacy；Web→Nest和canary保持现状。回滚新写开关legacy，该Mutation回Nest；旧状态Query仍由原开关控制，GAP-RSS-001修复无需反向恢复有害写回。兼容共享缓存键/值/TTL及指标/日志格式，不清缓存/改schema/部署。

## 9. 文件所有权、并行与排除

允许：
- 新 internal/rsstranslation 业务包与internal/graphqlread/rsstranslation adapter。
- itemsreading新增translation_support.go，translation.go只改本链runtime所需字段和GAP-RSS-001写回，不改csvexport/list/ranking。
- publicportal新增rss_completion.go等RSS专用文件，复用包内稳定配置/协议helper，保留原gateway/brief行为；需改共享helper时仅做本任务必要兼容扩展，不重构网关框架。
- llmlogs新增rss_translation.go，不修改#81占用的completion.go；基于main已存在的MetadataPolicy/归一化能力写窄adapter，不能引用未合入#81新方法。
- #81会重命名completionMetadataEntry并提取filterMetadataEntries；本批新writer不要依赖这两个正在变动的私有表面，使用稳定MetadataPolicy及自己的具名RSS metadata叶子。合并main后检查整个同包符号并集，不搬入#81未合代码。
- cmd/api/rss_translation.go、main/config、apps/api-go/README.md及env/compose最小增量；必要业务说明docs/refactor/go-rss-translation.md。

并行快照：Ready #81网关head0b89196f、#82来源策略head52340760、#83OIDC head2c52763c、#84导出head38e4e0e1；#80的KNOWLEDGE-REVIEW-001目录已见review业务开发，in_progress；#85的DIGEST-DELIVERY-001目录已创建，未见业务改动仍reserved。全部继续占用，开工重新查询。

不碰llmgatewayops/profiles/ports.go、llmlogs/completion.go、settingscrawl/settingswrite、authlogin/authfactors/oidclogin、analysisexport/itemsreading/csvexport.go/newsevents导出端口、knowledgereview/knowledgegraph、userdigest/runtimesettings/digest端口或notifications。

#82继续拥有旧13设置写两处漏接线。公共main/config/env/compose仅增加本任务语义段，保留所有并行开关和资源并集；后合者正常merge，不整段覆盖。没有本任务真实依赖的开放PR不要整批合入。

排除其他item/create/update/import、crawl任务/翻译外内容流水线、归档、态势刷新/地图整体翻译、配置CRUD、worker/cron/BullMQ、SMTP、摘要投递及全局网关治理。只认领BL-24中的RSS翻译子链，不认领整份候选队列。

## 10. 验证、记录、提交与Ready PR

本机不安装依赖，不运行build/test、Docker或服务。允许gofmt、git diff --check和只读静态审查；以file:line核对租户Mongo过滤、DTO/null、错误层级、缓存完整性、逐项失败、并发收口、日志/指标和开关组合。

少量必要行为验证覆盖：默认/显式空fields、跨租户/无记录、最新result为字符串或非法、缓存命中/miss与失败不缓存、双provider及fallback、UTF-16边界/Markdown超限、部分项失败、GAP-RSS-001不覆盖完整profile、mutation-only/整operation回退。远端现有普通CI执行，不恢复Nest Jest/e2e，不默认新增专用smoke或测试依赖。

正常push后观察最终head普通CI，记录SHA、run链接和关键job结果；skipped不是成功，修复用正常追加提交。DeepLX/fallback/LLM及DB/cache真实运行未执行必须明写，不用fake或CI推断实网/生产启用。

遵PLANNING轻量分工：编码窗口只更新自己的task/精简PR交付事实，main无task时可从规划#85取本文件，不把整个规划分支混入业务PR；共享README/tasks索引/模块/AUDIT/GAPS/BACKLOG由规划窗口集中回填。PR给出实际root/内部步骤、缓存缺口修复、优化、排除、开关/资源/回滚、验证和未核实项。开放时pr_open，实际main落地才凭merge SHA关闭对应范围；不提前增main覆盖或关闭整个GAP-LEGACY/ASYNC。

只stage自己的改动，中文emoji+type(scope)提交，正常push并创建**Ready PR**。不合并、不auto-merge、不amend/rebase/force-push，不创建对话、不跨对话发消息、不创建定时任务。交付PR链接、最终head、完整链路与必要剩余事实。
