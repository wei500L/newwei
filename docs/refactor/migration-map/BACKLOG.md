# 候选队列与已派发去向

[入口](README.md) · [规划](PLANNING.md) · [占用](tasks/README.md) · [缺口](GAPS.md) · [复用/所有权](DEPENDENCIES.md)。核对基线 `3cedce9aa3200436aba3596f63b559de5490cec8`，2026-10-18 本轮静态复核。候选不等于任务，不创建分支/worktree/对话，不自动发业务提示词；选择一项后才核对最新源码并写 task。

当前已派发BL-02、BL-03及BL-15.storage/test、BL-05，分别见各自task；保留去向供恢复，其余候选不因本轮批量认领，历史核对基线/深度不统一刷新。

## 顺序与隔离

先处理 **#70 与设置写的公共接线并集（BL-01）**，但不启动第二个竞争 main/config 的编码窗口。期间 **BL-02 简报冷路径、BL-03 S3 媒体** 可各自做源码设计/确认文件边界，若正式编码要串行登记 main/公共客户端所有权。其后优先 **BL-05 条目完整查询、BL-07 来源策略、BL-08 导出、BL-23 元数据发现**，这些可交付完整同步功能。**BL-04 登录**价值高、协议边界较大，应单独一条主线，之后接 BL-06 邀请/OIDC/审批。需要 queue/worker 的批次在生产者/消费者协议明确后进入，不能为了多计入口先制造不推进的 pending 状态。

WORKSPACE-WRITE-001 占用的 8 roots 不出现在候选范围中；BL-10 只覆盖剩余 alertRules/规则三写。SETTINGS-WRITE-001 merged，不重迁 13 写。以下所有“可独立窗口”仍须先做 PLANNING 的远端刷新；共享 main/config/模型装配需要按提交顺序取并集。

复用索引简称：`G` = Go `apps/api-go/internal/`，`N` = Nest `apps/api/src/`；`G/`下的包按此根目录展开；并列包用顿号或花括号区分，符号写在包名后。主要修改文件另列仓库路径，精确Controller/Resolver可从域页表定位。尚需核对是准入事实，不是已确认 bug。

## 优先修补与同步链路

### BL-01 · settings / GraphQL 公共接线

- 2026-10-18按main90765633重新核实后，将GAP-GQL-001具体剩余的graphqlRouteMode/无效DSN分支两处settingsWrite条件认领至[SOURCE-POLICY-WRITE-001](tasks/SOURCE-POLICY-WRITE-001.md)，与来源策略独立开关接线一并交付；不重迁13业务，不再另开竞争该两处接线的窗口。缺口未落地仍开放。
- **目标/范围**：GAP-GQL-001 的13写独立路由/资源条件，保留 READ/ORG_ACCESS_WRITE/工作台写并集、模型与嵌套字段权限；不重写13个业务 resolver。OBS-DATA-001 仅作同文件错误传播审查项，不把不可达观察冒充已确认故障。
- **基础/工作量依据**：settingswrite、settingscrawl.RegisterSettingsModelTypes、workspace.RegisterModels 已存在；需要核对 RouteMode、无效 DSN、needsCredentialedGo、handler 四处条件以及三写模式组合。无新队列/外部调用。
- **文件/前置/冲突**：`apps/api-go/cmd/api/main.go`，必要时config/模型注册；#70已由#77合入，但这两处条件仍缺。当前由SOURCE-POLICY-WRITE-001拥有最小修复，保留网关批次main/config并集；无新业务root计数。

### BL-02 · news / newsEventBrief 生成（已派发）

- 2026-10-18 按 main 9d0462e1 深读后派发至 [NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md)，提示词见同目录任务附件；不再属于未认领队列。GAP-NEWS-001 仍未关闭。本批不领取 BL-17 或其他候选。
- 补查事实：生成 sources 须携带 Summary/KeyPoints（Go SQL 已有，briefSource 原先未带）；Nest completion 还产生 Mongo LLM 请求日志，Go gateway 原先没有 writer，本批补 best-effort 具名 writer 与 metadata policy。news_event_brief 不在自动 moderation 集合，运行上下文不是租约。共享 main 只改新闻事件 Register 参数，不扩顶层资源/路由 OR；新增独立 BRIEF 子开关默认 legacy，父读开关依赖由 Load 明确校验。
- 交付：Ready [PR #72](https://github.com/wei500L/newwei/pull/72)（pr_open，未合 main），head 517a73f9 普通 CI verify/integration 通过。

- **范围/缺口**：Query newsEventBrief 的 cache miss、forceRefresh、模型结果清洗与 metadata 写回（GAP-NEWS-001）；保留合法 null 与缓存命中。
- **基础/依据**：G/graphqlread/newsevents 有选源/指纹/模型；G/publicportal 的完整冷路径和 gatewayClient 是私有，可提取具名共享能力。工作量来自两种调用语义/参数/配置/错误/写回，而非新增一个 root。
- **文件/边界/次序**：`apps/api-go/internal/graphqlread/newsevents/{brief.go,store.go}`（以实际文件布局为准）、publicportal/{story,brief,gateway}.go；MySQL+外部模型，无 BullMQ 前置。**已由 NEWS-BRIEF-001 占用**，与 BL-17 修改 gateway 辅助函数串行；准入再核模型配置与所有 metadata 叶子保留策略。

### BL-03 · crawl / S3 媒体下发

- 2026-10-18按main9d0462e1续读后已reserved至[STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md)，不再属于未认领队列；范围补充同因缺失的REST详情/Query crawlTask媒体URL，与BL-15仅storage/test构成完整链。其余候选不认领。

- **范围/缺口**：GET /api/crawl-media-assets/:assetId/:mode，补 S3 签名重定向（GAP-CRAWL-001），不扩大为全部采集写/存储上传。
- **基础/依据**：G/crawlreadtelemetry 已做 HMAC、orgId 资产查询与 MySQL blob；infrastructuresettings 只有配置管理。必须补 S3 对象 URL 行为与 config 解密/TTL/disposition/path-style，不是改一个 nil 返回。
- **文件/前置/冲突**：service_media.go、构造/wire 与必要存储辅助；外部 S3，独立于 crawl worker。**可独立窗口**；先确认是否抽共享存储客户端，避开 BL-15 同文件；实桶验证范围另外登记。
- 2026-10-18 交付：已由 [STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md) 实施于 `refactor/go-storage-media`（[Ready PR #73](https://github.com/wei500L/newwei/pull/73)），新增窄包 `objectstorage`、`StorageRuntimeConfig` 与 REST/GraphQL 两处注入；PR 未合 main，GAP-CRAWL-001 仍开放，实桶验证未执行。BL-03 不再作为未认领候选。

### BL-04 · identity / 登录与会话签发主链

- 2026-10-18按main9d0462e1深入核实后已reserved至[AUTH-LOGIN-001](tasks/AUTH-LOGIN-001.md)，[完整提示词](tasks/AUTH-LOGIN-001.prompt.md)已发出；本11路不再是未认领候选。登录/refresh/challenge/真实SMTP/重置事务整体迁移，业务不依赖#70或前三批；BL-06会话协议后续按此批先后处理。编码窗口只交付业务与PR说明，共享地图由规划窗口维护。

- **范围/缺口**：POST /api/auth/login、refresh、send-login-code、login-with-code、mfa/verify-login、mfa/enrollment/start、mfa/enrollment/complete、password/forgot、password/reset、send-verification、verify-email（GAP-LEGACY-001）；不重复已迁已认证 MFA/status 管理。
- **基础/工作量**：G/{authn,authz,authhttp}、accountsecurity/authfactors 的密码/会话/密钥基础；N/modules/auth 的 AuthService/PasswordResetService/MfaService，DTO 见 auth.controller.ts。需签发/刷新 token、session/Redis 撤销、MFA challenge、验证码/SMTP、限流与审计；这些步骤均须保持实际可用。
- **文件/前置/冲突**：新 Go 登录业务包、main/config；阅读 `apps/api/src/modules/auth/{auth.service,password-reset.service,mfa.service}.ts`；MySQL/Redis+SMTP。**适合单独主窗口，不与 BL-06 并行改会话协议**。先核 refresh rotation/验证码存储/SMTP helper 可复用性，不能从 verifier 存在推断 signer 已有。

### BL-05 · items / 完整 GraphQL 列表

- 2026-10-18 已由 [ITEMS-LIST-001](tasks/ITEMS-LIST-001.md) 认领并实现（分支 `refactor/go-graphql-items-list`，pr_open，未合 main），不再属于未认领队列。完整分页/三排序/相关性 rerank/用户正负画像与批量投影，不包装 REST 后冒充完成；原第三方调用/错误/日志边界见任务。前两批核心业务包不重叠，只读 selection 元数据由本任务最小扩展。
- **范围/缺口**：Query `items`（GAP-LEGACY-001）；完整 connection/page/after/first、排序/过滤、PERSONALIZED 与 RELEVANCE，保留互斥分页校验。
- **基础/依据**：G/itemsreading.Service.List及同包搜索/facets/read-model、workspace 模型；N/graphql/resolvers/items.resolver.ts 的 items 与 ItemsListService。REST List 只做 RECENCY，不可直接包装后称全量完成；还需 cursor、选择字段、个性化/召回排序和返回 connection 注册。
- **文件/前置/冲突**：G/itemsreading 与 graphqlread/itemsreading、main/config 最小接线；DB/Mongo/Redis，ES/vector/embedding 外部边界。**可独立窗口**；先明确是否共享 List 核心，BL-08/24 避开搜索核心文件；未核所有 cursor 编码与 totalCount 成本。

### BL-06 · identity / 邀请、审批与 OIDC 接入的后续分段

- 2026-10-18按main90765633深入后，OIDC start/callback/handoff exchange三路完整SSO链已认领[OIDC-LOGIN-001](tasks/OIDC-LOGIN-001.md) reserved，[提示词](tasks/OIDC-LOGIN-001.prompt.md)在#80发布；复用已合可信登录/MFA/secret，明确真实discovery/JWKS/token与handoff条件领取修复，不重迁配置CRUD。头像/导出仍未认领，真实IdP未验证。
- 2026-10-18以main c39f282f深读并发出其中邀请/申请审批14路[IDENTITY-ONBOARDING-001](tasks/IDENTITY-ONBOARDING-001.md)，现已由#79实际merge f35ec572进入main90765633；原[提示词](tasks/IDENTITY-ONBOARDING-001.prompt.md)保留，不重复派发。#75登录基础已通过#77合入；本批accept不签发会话。新组织审批调用普通invite的system-admin拒绝问题纳入受控bootstrap路径实现。OIDC三路现独立认领，头像与导出仍未认领，不扩成19路杂批。

- **精确候选集合**：identity 域余下 Nest HTTP：/admin/invites 四路、/admin/registration-applications 五路、/register/{applications,join-applications} 两路、/invitations/:token 三路、GET sso/oidc/start、GET oidc/callback、POST sso/handoff/exchange；另 POST avatar/presigned-url 与 GET data-export 是两个可分离支线。均为 GAP-LEGACY-001，不包含 BL-04。
- **基础/依据**：G/graphqlread/orgaccesswrite、G/{rbacapi,authfactors,accountsecurity}，N/OrgInviteService、RegistrationApplicationService、OidcAuthService；需要邀请/审批事务、默认角色/租户初始化、邮件、IdP/state/PKCE/handoff token；头像依赖 StorageService、导出依赖完整个人数据聚合。
- **文件/前置/冲突**：N/modules/auth 对应服务→新 Go 包；主链依赖 BL-04 token/session 协议。**当前只适合分段源码核对，不能把19条不相干入口一次认领**；先按邀请+审批、OIDC、头像/导出确定可独立交付的 task，后两支需分别声明存储/数据边界。

### BL-07 · settings / 来源策略四写

- 2026-10-18按main90765633深读后，整条来源策略版本链认领至[SOURCE-POLICY-WRITE-001](tasks/SOURCE-POLICY-WRITE-001.md) reserved，[完整执行提示词](tasks/SOURCE-POLICY-WRITE-001.prompt.md)在#80发布；不再是未认领候选。已核四写/DTO/helper/normalizer、category presence、20/30/60历史差异、preset时间比较、DB/cache审计失败边界及Go私有复用；无新外部服务/worker，保留源读后校验，不增加CAS/锁。
- **范围/缺口**：updateNewsEventSourcePolicy、updateNewsEventSourcePolicyPresets、resetNewsEventSourcePolicy、rollbackNewsEventSourcePolicy（GAP-LEGACY-001）；不动已合并13写。
- **基础/依据**：G/graphqlread/settingscrawl policyReader 和 publicportal 的来源规范化；N/news-event-source-policy.service.ts updatePolicy/updatePolicyPreset/resetPolicy/rollbackPolicy。expectedRevision校验、revision历史、preset delta/分类同步与Redis syncWarnings是主要工作，不只是四次upsert。
- **文件/前置/冲突**：新 GraphQL 写包及现有 policy helpers/main；MySQL/SystemSetting/Redis，无须迁 ingestion 才可交付。**BL-01/#70 接线稳定后可独立窗口**；避免 BL-18 同时更改策略模型；本轮已进一步核对读后校验/同步失败语义，准入还需明确是否保留或优化其并发边界，见下表。

15:01–15:08源码续读，仍main3cedce9a；可交付步骤已明确：

| 精确root | 必须迁的内部步骤/返回 | 数据与失败边界 |
|---|---|---|
| updateNewsEventSourcePolicy | normalize有效列表→转delta→读取prevState→可选expectedRevision校验→新revision→persistState；只有输入显式含categoryAuthority才额外保存该组规则 | SystemSetting news_event_source_policy:<org>；分类规则另键保存，非一个总事务；DB成功后Redis失败返回syncWarnings，不抹去已保存状态 |
| rollbackNewsEventSourcePolicy | expectedRevision校验→在保留历史中找target→创建**新**rollback revision与note→持久化并返回当前categoryAuthority | 不把activeRevision简单改回旧数字，不回滚categoryAuthority；找不到revision是合法400 |
| resetNewsEventSourcePolicy | 检查当前版本→新reset revision，delta置空→保留revision历史→返回策略详情 | 是重置delta而非删除整份历史/分类规则；状态Redis TTL60秒 |
| updateNewsEventSourcePolicyPresets | 可选expectedUpdatedAt精确比较→normalize→独立preset upsert→DB updatedAt→审计/cache→显式categoryAuthority另存→返回syncWarnings | news_event_source_policy_preset:<org>；preset/cache TTL30秒；当前Nest是读后校验再upsert，未使用数据库原子CAS，不描述成已具备CAS事务 |

Go读端settingscrawl/policy.go已有stateFromStoredValue/normalizeSourcePolicyState/effectiveFromDelta/getPolicyDetails/getPolicyPreset/getRevisionDiff/getSyncStatus及具名模型，但reader/helper大多私有；写端需要在同包补共享表面或明确抽取，不从publicportal另建不兼容state。状态保留60条revision，读取历史默认20、上限100；缓存同步status真实比较DB/cache时间戳与缺失/失败warning，不能由写“成功”自动推断已同步。主要新增文件可隔离为settingscrawl的policy写支持+新写root包；现有13写业务不进入范围。

### BL-08 · analysis / 三个 CSV 导出

- 2026-10-18按main90765633深入后，将items/events两路完整CSV认领至[ANALYSIS-EXPORT-001](tasks/ANALYSIS-EXPORT-001.md) reserved，[提示词](tasks/ANALYSIS-EXPORT-001.prompt.md)在#80发布。已核完整参数/5000选择、Go交互50条限制与私有复用、事件聚合/强制权威/先过滤排序后去重、CSV字节与公式语义；新增保持贪心结果的token索引优化。search整路仍未认领并保留Nest，不能因items模式共用业务计整路完成；归档准备与采集生命周期未认领。
- **范围/缺口**：POST /api/analysis/exports/search、items、events（GAP-LEGACY-001）。search 还含 mode=headlines 归档路径，不只导出当前页面。
- **基础/依据**：G/analysiscollab.NormalizeQueryString、itemsreading、newsevents；N/AnalysisWorkspaceService.export*CsvStream→buildItemsExportRows/buildArchiveSearchRows/buildEventsExportRows/buildCsvStream。需全量批读取/上限、日期排序、权限/组织过滤、CSV 转义、响应头与审计，避免套 REST 默认50条截断。
- **文件/前置/冲突**：独立 Go export 包/main；N/modules/analysis-workspace/analysis-workspace.service.ts 为事实源；DB/Mongo/ES/归档搜索边界。**可先独立交付items/events两路**，BL-05搜索核心先约文件；search的mode=headlines已确认经getDigest触发ensureDigestCoverage，完整第三路依赖BL-09准备链边界，不能静默代理Nest后把整路记Go完成。

15:01–15:08源码续读后的拆分依据：

| 可交付范围 | 真实内部步骤/复用与限制 | 隔离/前置 |
|---|---|---|
| POST exports/items + events | items复用完整筛选/排序但请求maxPageSize=5000，补read-model与事件关联；events保留time/status/entity/heat/authority/强制权威来源、排序及去重 | 新Go导出包可拥有CSV/DTO/响应；优先导出必要读取表面，别整改itemsreading与news事件读；无新增queue消费者 |
| POST exports/search的items模式 | 同buildItemsExportRows；queryString规范化移除savedView/page/pageSize，保留真实搜索/排序/用户画像语义 | 可与前两路共享实现，但HTTP整路不能因只支持此模式就标完整；若先分阶段交付，要明确headlines仍Nest且整请求归属 |
| POST exports/search的headlines模式 | 循环getDigest(pageSize100)，携带各vertical cursor；按processedArticleId去重至5000；getDigest可能enqueue归档准备 | 依赖BL-09查询/分类/准备所有权；不得返回空或丢准备副作用。可以在归档基础完成后再交付此整路，不抢认归档任务 |

三个附件名分别analysis-{items,events,search}-export.csv，content-type text/csv; charset=utf-8；公式前缀= + - @要按当前escapeCsvValue处理，合法数字负值保留。MAX_EXPORT_ROWS是当前契约上限，不是工时估计。未核项缩小为：所有URL参数枚举/默认、底层完整检索排序算法、归档分类冷路径与远端调用；不再把headlines的准备依赖写成未知猜测。

### BL-23 · crawl / 元数据主动发现

- 2026-10-18以main9d0462e1深入两入口实际调用链后，urls/sitemap网页元数据链已reserved至[CRAWL-METADATA-001](tasks/CRAWL-METADATA-001.md)，[提示词](tasks/CRAWL-METADATA-001.prompt.md)已发出；不再属于未认领候选。extract仅调用urls/sitemap/robots/HTML，不调用同服务RSS/list/deep/crawl4ai；后者不纳入本两入口。新业务包/adapter与S3及items包隔离，GraphQL在现有READ内独立注册，不改settingscrawl或引擎。

- **范围/缺口**：Query crawlMetadata 与 POST /api/crawl-tasks/metadata（GAP-LEGACY-001），同业务双入口；不捆绑完整 task worker。
- **基础/依据**：G/crawlreadtelemetry DTO/配置读、crawlworkflow/profile 的 normalize 基础；N/CrawlMetadataService.extract/discoverSitemap*/discoverRss*/discoverList*/discoverDeep*。实际是 robots/sitemap/XML/HTML、并发发现、HTTP 缓存/重定向/SSRF 与 crawl4ai 的完整网络链，不是 DB Query。
- **文件/前置/冲突**：独立 Go metadata 包、graphql/HTTP adapters/main；N/modules/crawl/crawl-metadata.service.ts 为事实源。**可独立窗口先做深读**；需核 feature 开关与各发现模式、私网/域名解析语义，避免与 BL-24/25 重写共享配置；真实站点验证另记。

## 需要明确异步/外部边界的链路

### BL-09 · archive / 查询与准备闭环

- **范围/缺口**：archiveDigest/archiveCalendar/archiveDetail，ensureDigestCoverage/ensureCalendarCoverage→archivePreparation queue→processor→分类/状态写回（GAP-LEGACY-001 / GAP-ASYNC-001）。现有 status HTTP 不重迁。
- **基础/依据**：G/dataruntimesettings 状态/设置、itemsreading/llmembed/publicportal 来源规则；N/ArchiveService、ArchivePreparationQueueService、ArchivePreparationProcessor。需要显示资格/分类缓存、embedding/rerank/翻译、job 去重和 partial/ready/failed；工作量远大于三读。
- **文件/前置/冲突**：archive 新包、Redis queue 协议、Mongo/MySQL 数据层/main；**当前不适合不定边界的独立编码窗口**。可分“完整查询+兼容现有生产者/消费者”与“Go 准备器”两阶段，但第一阶段必须明确仍依赖 Nest，不能关闭整条缺口；先核队列兼容与唯一消费。

### BL-10 · workspace / 告警规则与执行

- **范围/缺口**：alertRules、upsertAlertRule/deleteAlertRule/triggerAlertRule、对应 ensureDefaultRules/评估/投递步骤（GAP-LEGACY-001 / GAP-ASYNC-001），排除 #70 的8交互写。
- **基础/依据**：G/graphqlread/alerts 的历史/replay/tuning，#70 合入后的模型；N/AlertsService.listRules 会建默认规则，trigger 与 AlertsProcessor/BullMQ/SMTP/webhook 相连。需要规则关联事务、指标计算、事件/投递状态与历史保留。
- **文件/前置/冲突**：G/graphqlread/alerts、后续规则/执行包、main/config；#70 占用 alerts/{models,channels,events,convert,replay,register}.go。**等待 #70 稳定**；可先拆规则配置完整链与执行器，但须保留已认领渠道写，先核 trigger 是同步还是队列边界。

### BL-11 · economic / 配置调度与抓取

- **范围/缺口**：updateEconomicDataFetchConfig、triggerDataFetch、triggerEconomicDataRefreshPreset；GET /api/admin/akshare/status、version 与 POST upgrade（后者可独立运维子批）；Akshare repeat/processor（GAP-LEGACY-001 / GAP-ASYNC-001）。
- **基础/依据**：G/graphqlread/economic 历史/分页/insights；N/AkshareService.updateFetchConfig→ensureRepeatableJobs、queue.add、AkshareQueueProcessor。需修改 repeat 时清旧任务、构造 payload、更新全局经济数据/刷新预置状态；AkShare 是独立服务，upgrade 不是本地配置保存。
- **文件/前置/冲突**：economic 写/调度包、queue adapter/main；DB/Redis/AkShare。**先读队列协议后可单独主窗口**，不要与 BL-20 同时切 queue 通用能力；未核全部 repeat/jobName/退出语义。

### BL-12 · analysis / 三请求执行闭环

- **范围/缺口**：requestCorrelationAnalysis/requestAnomalyExplanation/requestGeoTransportAnalysis→submit*→analysis queue→process→Mongo/通知/analysisEvents（GAP-LEGACY-001 / GAP-ASYNC-001），不重迁协作 CRUD/history。
- **基础/依据**：G/graphqlread/history 模型/经济/地图读取、publicportal 模型客户端（私有）；N/AnalysisService/AnalysisProcessor。相关计算、异常/地理上下文、流式 chunk、最终失败通知均为必要内部步骤。
- **文件/前置/冲突**：独立分析执行包、队列/模型 adapter/main；MySQL/Mongo/Redis+模型/运输。**当前先定 producer/consumer 与 BL-21 发布契约**；可先迁一条完整分析类型，不能三个 root 只建记录。共享 gateway 提取需等 BL-02 的决定。

### BL-13 · assistant / 三类请求与删除

- **范围/缺口**：requestAssistantQuery/requestAssistantReport/requestAssistantForecast/deleteAssistantRun 与对应 processor/process/状态通知（GAP-LEGACY-001 / GAP-ASYNC-001）。delete 可成为独立完整子批，须保留活跃运行/对话关联语义。
- **基础/依据**：G/graphqlread/history capabilities/series/读取、items/经济检索，N/AssistantService/AssistantProcessor。query 的工具/会话/安全配额、report/forecast 模型、流式状态都需迁；仅保存 pending 不可交付为完整链。
- **文件/前置/冲突**：assistant 执行/工具/queue/client/main；DB/Mongo/Redis/模型、可能 Web search。**先核 provider/tool 能力与 BL-12/21 的共享发布边界**；不得引用未合入的客户端 API；尚未逐工具阅读，当前适合勘查而非一批全认领。

### BL-14 · situation / 主动刷新、授权与信号生成

- **范围/缺口**：POST geo/geocode；GET situation-monitor/insights、POST refresh；GET system-settings/realtime-signals/runtime；system-settings/situation-monitor GET/PUT/DELETE、external-snapshot/refresh、telegram-auth start/complete/DELETE；signals worker/轮询与 snapshot Cron（GAP-LEGACY-001 / GAP-ASYNC-001）。
- **基础/依据**：G/situationsignals 已读缓存/反馈、dataruntimesettings 配置、dashboardwarmap 地理/实时客户端；N/situation-monitor/signals、TelegramAuth、RealtimeSignalsService。全局 collector 与组织筛选、任务进度/租约、授权 session、外部限额决定拆分。
- **文件/前置/冲突**：signals/collector/geo/auth 新包与模型/main；Redis/Mongo/MySQL+Telegram/Oref/Nominatim/OpenSky/其他外部。**需先分地理同步链、Telegram授权、refresh消费者三条候选执行边界**；不因都是态势就同时认领；未核全部外部 API/凭据与轮询退出。

### BL-15 · infrastructure / 连接诊断与邮件设置

- storage/test子范围已由[STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md)认领，与BL-03共享runtime配置/客户端；不再并行派发该路及存储helper。Nominatim/vector/email/safety诊断仍未认领。新诊断独立开关不强开设置CRUD或媒体读取开关。

- **范围/缺口**：POST admin/settings/storage/test、POST system-settings/geo/nominatim/test、GET system-settings/vector-service/diagnostics；settings/email GET、PUT auth-code、POST test；GET assistant-safety/diagnostics（GAP-LEGACY-001）。
- **基础/依据**：G/infrastructuresettings、dataruntimesettings、platformgovernance 的配置读/解密；N 对应 Controller/Test/Email/Safety service。每种诊断需真实客户端/超时/权限/返回，不是固定 ok；存储、邮件、安全诊断可分别完整交付。
- **文件/前置/冲突**：各域独立诊断包/main；S3、vector、Nominatim、SMTP/安全外部依赖。**可单个服务窗口**，不同时改 BL-03 存储 helper；与 BL-04 邮件客户端需明确共享；当前未逐方法深读，选批前核请求/失败语义。
- 2026-10-18 交付：storage/test 子范围由 [STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md) 实施（独立开关 `API_GO_STORAGE_DIAGNOSTICS_MODE`，默认 legacy；[Ready PR #73](https://github.com/wei500L/newwei/pull/73)），与 BL-03 共用 `runtime 配置/客户端`，不并行为同一 helper 开启第二个窗口。Nominatim/vector/email/safety 诊断仍未认领，PR 未合 main。

### BL-16 · knowledge / 证据复核与 ingestion

- 2026-10-18限定续核main90765633：人工复核完整链与已有队列选取改善已由[KNOWLEDGE-REVIEW-001](tasks/KNOWLEDGE-REVIEW-001.md) reserved，[提示词](tasks/KNOWLEDGE-REVIEW-001.prompt.md)在规划#80发布。已核事务、实体别名、证据迁移/重复合并、新旧边聚合、耐久边、审计双失败和缓存失效；本子链只有MySQL/Redis，不需要Mongo。ingestion Cron/抽取/模型、历史reconcile脚本与审计outbox消费仍留Nest，未认领。新窄端口文件避开来源策略register/policy，共享接线只追加本开关并集；不把整个BL-16标已完成。

- **范围/缺口**：reviewKnowledgeGraphEvidence 及其关系边/证据/复核状态更新；KnowledgeGraphIngestionService 的后台构图作为后续独立执行阶段（GAP-LEGACY-001 / GAP-ASYNC-001）。
- **基础/依据**：G/graphqlread/{knowledgegraph,kgimpact}、settingscrawl.reviewReader 已有读模型；N/KnowledgeGraphService.upsertReviewedRelationEdge 与对应 review 服务。需要租户/权限、证据归属、接受/拒绝与边聚合、缓存失效；不能把更新 reviewed 状态当整个复核完成。
- **文件/前置/冲突**：graphqlread 新写包/knowledge 业务层/main，MySQL+Mongo/Redis，ingestion 可能模型；**复核写可在公共接线后独立窗口**；先核真正 resolver 调用的复核服务/事务，与 BL-18 新闻处理写入共享表的顺序。

### BL-17 · model-gateway / 治理与真实探测

- 2026-10-18以main c39f282f深入、最终按90765633核增量后，12路整体认领至[LLM-GATEWAY-OPS-001](tasks/LLM-GATEWAY-OPS-001.md) reserved，[执行提示词](tasks/LLM-GATEWAY-OPS-001.prompt.md)已保存并发布，不再是未认领候选。已核team/key管理协议、启停/轮换先后、真实探测/缓存/错误、三类Mongo日志与Go可复用能力；不依赖BL-02私有completion客户端。#79身份已合入，保留其公共接线。无真实外部验证，无队列/cron，其他候选不认领。
- **范围/缺口**：model-gateway 域12条 Nest HTTP：proxy-governance GET/PUT/DELETE/preflight/rotate-key，:id/models/test/proxy-health/proxy-model-info/proxy-lb-test，models-config/test-config（GAP-LEGACY-001）。
- **基础/依据**：G/{modelaccesssettings,llmgatewayprofiles} 的 profile、密钥、LB 配置，publicportal.gateway 已有请求实现但私有；N/LlmGatewaySettingsController 与服务。治理事务/密钥轮换、LiteLLM内部配置、真实探测/模型列表是不同子链，可先治理后探测。
- **文件/前置/冲突**：新llmgatewayops/wire/路由、profiles窄端口、llmlogs probe writer及main/config条件增量；MySQL/Redis/Mongo/加密+LiteLLM/模型。与#79身份核心业务隔离，公共接线保留并集。preflight/rotate协议已按本次task补核，配置applied与mock仍不等于真实生产生效。

### BL-18 · news / 上游内容、指标关联与流水线

- **范围/缺口**：GET news-aggregator/source、POST sources/batch、GET recommended/hottest-analysis；POST clustering/failures/:groupId/llm-backfill；refreshNewsIndicatorAssociations；相应 source warm/hottest/事件/指标/pipeline ingestion（GAP-LEGACY-001 / GAP-ASYNC-001）。
- **基础/依据**：G/newsnowclusteringops 的 metadata/resolve/order/opinion 与 failure store；newsevents/newsindicator 读取；N/news-aggregator、news-events、news-indicator、news-pipeline。真实源 fetch/cache、推荐召回/画像、LLM分析、关联写与恢复任务必须按各条完整链拆批。
- **文件/前置/冲突**：候选域对应包/新客户端/main；Mongo/MySQL/Redis+上游/模型/queue。**当前可单独核 source/batch 同步链，后台执行另定唯一所有权**；BL-07 来源策略模型稳定后再做依赖它的分支；未核全部生产者/失败回放。

### BL-19 · personal / digest 定时邮件投递

- 2026-10-18按main90765633深入核对后，本单链已reserved至[DIGEST-DELIVERY-001](tasks/DIGEST-DELIVERY-001.md)，[完整提示词](tasks/DIGEST-DELIVERY-001.prompt.md)已发出，不再为未认领候选。已有Go GenerateDigest/SMTP端口可复用；NotificationDispatcher仅进程内，明确新建摘要专用Redis→Nest本地socket桥，保留原WS服务。无BullMQ；独立同名跨进程开关默认legacy，明确停旧Cron/drain/启Go及反序回滚。具体改善为固定cutoff游标批扫及未领取slot的失败写CAS，不把设置CRUD或缓存读取当已投递。BL-15/20/21其余范围未认领。

- **范围/缺口**：UserDigestDeliverySchedulerService→到期用户/订阅→构建 digest→SMTP→delivery 状态/去重（GAP-ASYNC-001）；配置 HTTP 与 preview 不重迁。
- **基础/依据**：G/userdigest 读取/投递设置、contentsubscriptions/contentcatalog 已有；N/user-digest/user-digest-delivery-scheduler.service.ts。工作量在调度时区/租约/重复发送与失败状态，不在增加 HTTP 数。
- **文件/前置/冲突**：Go scheduler/delivery、SMTP client/main；DB/Mongo/Redis/ES+SMTP。**先核邮件客户端与 BL-04/15 边界后可独立窗口**；必须指定停用 Nest 哪个调度触发，先核租约/重复执行风险，不自行添加新框架。

### BL-20 · async / Outbox、清理与消费者基础

- **范围/缺口**：AuditLogOutboxService、RawItemOutboxService、CrawlCleanupOutboxService 三条补偿链及其当前 Cron（GAP-ASYNC-001）；它们分别交付，不领取“全部 worker”。
- **基础/依据**：G/graphqlread/settingswrite 等已写 AuditLog/失败 Outbox，读 Mongo/序列化与 Redis 可复用；N 各 service 为锁/可见性/重试事实源。需状态扫描、幂等目标写入、事务/租约与关闭，审计/原文/存储删除副作用不同。
- **文件/前置/冲突**：独立 Go outbox 消费包/main；MySQL→Mongo、可能 S3；**先审 AuditLogOutbox 单链可独立窗口**，RawItem 与 BL-24、cleanup 与 BL-25 串行。未核每张表的状态/重试上限与停机时 in-flight 语义。

### BL-21 · async / Subscription 与 Socket.IO

- **范围/缺口**：Subscription alertEvents/analysisEvents/assistantEvents/queueEvents 及 Socket.IO 执行/权限/投递（GAP-LEGACY-001 / GAP-ASYNC-001）；dashboard SSE 不重迁。
- **基础/依据**：G/graphqlread 解析鉴权/字段权限与 SSE 关闭流程；N/graphql-subscriptions Redis backplane、graphql resolvers、websocket gateway。需要 executor、连接鉴权、orgId过滤、payload/取消/背压与多实例 transport；只接 Redis 不够。
- **文件/前置/冲突**：GraphQL/WS 专门执行层/main/legacyproxy；**在 BL-10/12/13/25 事件生产者契约稳定后执行**，可独立窗口先核协议/事件样本；未核拓扑与全部订阅字段权限，不一次打开所有协议升级。

### BL-22 · vector / 上游部署切换核实

- **范围/缺口**：VECTOR_SERVICE_BASE_URL / SystemSetting 优先级与实际上游切流、回滚；VERIFY-DEPLOY-001，**不是已确认源码 bug**，不重写 vector-go 三接口。
- **基础/依据**：vector-go/Qdrant 与现有真实差分 CI、api-go vector recall；N/VectorServiceSettingsService，Compose 可选 pilot。工作在配置/部署证据与端到端请求归属。
- **文件/前置/冲突**：通常先只读 infra/docker、上游 clients/settings 与部署记录；**可独立只读窗口**；实际部署变更不在本轮授权内，执行时再按明确范围决定。未核真实配置值，不从 CI 推断已切流。

### BL-24 · crawl/items / 任务写入与内容导入

- 2026-10-18按main90765633深入后，仅RSS翻译子链已reserved至[RSS-TRANSLATION-001](tasks/RSS-TRANSLATION-001.md)，[提示词](tasks/RSS-TRANSLATION-001.prompt.md)随#85发出；不再重复派发translateRssItems。同步DeepLX主备/LLM、四字段分块、双缓存、指标/日志齐备才算本链；无BullMQ/Cron或原文写回。确认GAP-RSS-001共享完整profile缓存被状态投影覆盖，一并具体修复；Mongo选最新记录改数据库侧分组。其他任务生命周期、创建/更新/导入仍未认领。

- **范围/缺口**：crawl create/retry/delete 的 HTTP 与 createCrawlTask/retryCrawlTask/deleteCrawlTask、updateCrawlTaskIngestToItems/ingestCrawlTaskResultsToItems；POST /api/items、createItem/updateItem/createItemFromCrawlResult/translateRssItems（GAP-LEGACY-001 / GAP-ASYNC-001）。重复 HTTP/root 共用业务，不重复计工作。
- **基础/依据**：G/{crawlreadtelemetry,itemsreading}、已有 DB/模型；N/CrawlService/ItemsService/ItemsRssTranslationService、RawItemOutbox/QueueProcessor。任务状态/去重/关联媒体、原文 Mongo 与 MySQL outbox、翻译缓存/真实模型均为必要步骤。
- **文件/前置/冲突**：新 task/item 写包、数据层与 queue adapter/main；**先拆任务生命周期+消费者、条目写/导入、RSS翻译三段完整任务**，不能一个窗口领取全部。与 BL-03/05/20/25 有共享文件/表，先确定顺序；尚未核全事务/回滚与已处理条目失效链。

### BL-25 · crawl/async / Frontier 生产者与队列运维

- **范围/缺口**：POST crawl-frontier/runs、nodes/:id/retry、nodes/retry、workflow-runs/:runId/replay、workflows/:id/trial-run；news-sources/:id preview/dispatch/cancel-queued/clear-inflight/retry-latest；crawl4ai/queue GET 与 concurrency/pause/resume（GAP-LEGACY-001 / GAP-ASYNC-001）。
- **基础/依据**：G/crawlfrontierruns、G/newssources、G/crawlworkflow 的管理/状态基础；N/crawl 与 queue 的 strategy/frontier/dispatch/ops/controllers、QueueProcessor、CrawlQueueProcessor。队列运维必须维护真实 BullMQ job/计数/锁，trial/preview 也会真实外调，不可仅改状态字段。
- **文件/前置/冲突**：frontier/queue/strategy Go 包与 adapter/main；DB/Redis/Mongo/crawl4ai。**在 BL-24 payload/生命周期明确后按“Frontier生产者”和“队列控制”串行选批**；不重迁已合并取消11路。先核 trace/jobId、消费者重复与实时 queueEvents。

### BL-26 · observability / 质量报告、恢复与指标

- **范围/缺口**：POST admin/quality/classification/reports；GET admin/quality/pipeline/runs、POST replay/rollback；GET /api/metrics（GAP-LEGACY-001 / GAP-ASYNC-001）。
- **基础/依据**：G/{qualityoverview,classificationrssops,adminlogs} 与历史模型；N/ClassificationQualityProcessor、PipelineRecoveryController/服务、MetricsController。报告 queue→模型/分批写回、replay/rollback 真实流水线补偿与 metrics 平台鉴权是不同完整链。
- **文件/前置/冲突**：各运维业务包/worker/main；Mongo/MySQL/Redis+模型/queue。**metrics 可先独立深读，恢复链须先核 BL-18/24 数据所有权**；未核回滚补偿与所有指标 provider，不能给出固定工时或完成百分比。
