# 已确认缺口与待核对事项

[入口](README.md) · [候选队列](BACKLOG.md) · [实现核对范围](AUDIT.md)。本轮源码基线均为 `3cedce9aa3200436aba3596f63b559de5490cec8`（2026-10-18 14:37–14:42 MSK 静态阅读）；PR #70 的候选代码另记 head，不能关闭 main 缺口。稳定 ID 不因任务 merged 而删除。关闭须有实际落地提交、对应入口/分支与证据。

## 当前摘要

| ID | 性质 / 所属域 | 影响范围 | 状态 / 归属 |
|---|---|---|---|
| GAP-ANALYSIS-001 | 中断恢复；analysis | BullMQ stalled重排时Mongo仍running，被process认领条件跳过，可能形成队列结束/结果永久running | ANALYSIS-RUNS-001 pr_open（#98，head e9c99ec9）；实现已提交、本批整合分支待合并；未部署/未运行验证 |
| GAP-ITEMS-001 | 部分实现/水合；items | Go读模型水合只取completed窄快照，丢最新pending/failed及必要字段 | ITEMS-INGEST-001 pr_open（#96，head 761ed72c）；实现已提交、本批整合分支待合并；未部署/未运行验证 |
| GAP-RSS-001 | 部分实现/共享缓存；items | rssTranslationStatus在LLM profile缓存miss后覆盖完整缓存字段 | RSS-TRANSLATION-001 经#90合入main c70b0373，修共享缓存投影写回；未生产验证 |
| GAP-GQL-001 | 接线；settings / GraphQL 公共运行时 | 设置 13 写单独启用 | SOURCE-POLICY-WRITE-001 经#89合入main f1167769；旧13写剩余接线仍按设置写任务跟踪，缺口仍开放 |
| GAP-NEWS-001 | 部分实现；news | Query `newsEventBrief` 冷生成/forceRefresh | NEWS-BRIEF-001 pr_open（候选实现，未合 main）；缺口仍开放 |
| GAP-CRAWL-001 | 部分实现；crawl | 媒体下发及已有REST/GraphQL详情的 S3 URL分支 | STORAGE-MEDIA-001 pr_open（候选实现，未合 main）；缺口仍开放 |
| GAP-LEGACY-001 | 未迁移入口；跨域 | 域页精确清单中的 Nest HTTP/root | 主要子链已由 #92–#113 的 21 条 PR 覆盖（四订阅、来源、条目写、归档、经济、告警、采集、设置、态势、导出等），整合分支待合并；未部署验证，整域缺口不关闭 |
| GAP-ASYNC-001 | Nest 执行依赖；跨域 | 已迁读取/配置背后的生成、消费、调度、订阅 | digest/审计/四订阅/analysis worker/告警 worker/质检 worker/形状回填等已由本批 PR 覆盖，整合分支待合并；itemPipeline worker、Socket.IO 与真实外部服务继续由 NestJS 承担，整域缺口不关闭 |
| GAP-KG-001 | 部分实现；knowledge | 已迁证据复核队列的固定候选遮挡 | KNOWLEDGE-REVIEW-001 经#89合入main f1167769；未部署验证，缺口仍开放 |

“未迁移”是范围事实，不表示 Nest 有 bug；“缺少外部运行证据”不单独计为源码缺陷。当前没有因本轮文档维护而关闭的业务缺口。

2026-10-20 本批整合增量：`docs/refactor/migration-map` 的 21 条开放 PR 由 `integration/merge-open-prs-b92-113` 一次性收口（#92–#113，#111 由 #112 取代并关闭）。GAP-ANALYSIS-001、GAP-ITEMS-001 由 reserved 改为 pr_open（#98 head e9c99ec9、#96 head 761ed72c）；GAP-RSS-001、GAP-KG-001、SOURCE-POLICY-WRITE-001 等经 #89/#90 合入的事实回填为 merged，但均未部署/未运行验证，不关闭缺口。本批新增的 worker/Cron/订阅仍按“实现已提交、整合分支待合并”记录，不以 PR CI 代替部署或实网证据。

<a id="gap-analysis-001"></a>

## GAP-ANALYSIS-001 · 分析中断重排与结果running脱节

- SHA：91e759b449c4511dc96d86539ea0eb258754d07e，2026-10-19限定analysis链静态核对；没有生产故障/运行复现证据。
- 触发：worker在Mongo标running后崩溃/锁丢失，BullMQ5.63.2按stalled策略重新交付。Nest apps/api/src/modules/analysis/analysis.service.ts:134-148只认pending/failed，running不匹配就return；analysis.processor.ts调用后无恢复。官方Worker/Job/Scripts的stalled回wait和重新执行路径已核。
- 影响：可重试任务不再实际计算，队列可结束但analysisresults仍running；stalled最终失败也须和Mongo/通知对齐。不能以BullMQ有重试认定业务已恢复。
- Go事实：当前无完整analysis执行器，history读无法修复。ANALYSIS-RUNS-001（#98，head e9c99ec9）已提交实现并持当前queue租约的running接续、最小attempt条件写/旧token不能覆盖、终态/最终通知，Nest回滚侧同步本链窄修；队列仍at-least-once，不引入跨库exactly-once框架。
- 文件：Nest analysis.processor.ts/analysis.service.ts、必要analysis-result可选字段，Go新analysisqueue/analysisruns；不扩展其他worker。远端普通CI真实Redis/Mongo/worker+SSE fixture须覆盖重排、旧token、已完成不重复；真实模型和部署分别记。
- 状态reserved、未实施、关闭证据无；须实际main落地、精确head CI/恢复行为证据，生产启用另记。

<a id="gap-items-001"></a>

## GAP-ITEMS-001 · 水合快照误用已完成数据读取

- 2026-10-19限定核对main `91e759b449c4511dc96d86539ea0eb258754d07e`，触发已有itemreadmodels水合/新写后刷新；不推断生产已发生故障。
- Go `apps/api-go/internal/itemsreading/readmodel.go:loadProcessedSnapshots` 调用 `mongo.go:ListLatestProcessedSnapshots`，后者where固定status=completed，投影不含rawItemId/error/llm/updatedAt等水合字段。Nest `ItemsReadModelService.loadProcessedReadModelSnapshots/buildLatestItemSnapshotPipeline` 在org+item IDs内按createdAt DESC,_id DESC取最新任意状态及完整snapshot，没有completed过滤。
- 影响：最新pending/failed可能缺失或旧completed替代最新运行状态；仅导出Go私有hydration helper不能完成写后读模型契约。搜索/RSS取completed本身不是此缺口，不改它们的语义。
- [ITEMS-INGEST-001](tasks/ITEMS-INGEST-001.md) 已 pr_open（#96，head 761ed72c），仅认领hydration专用Mongo聚合/全snapshot、组织和raw双向绑定/缺snapshot unset及新写链调用。允许readmodel.go与独立hydration store/port，不重建全库read-model、不新增后台回填；状态未修，无关闭证据。关闭需实际main实现/对应head验证与最新状态case，生产启用另记。

<a id="gap-kg-001"></a>

## GAP-KG-001 · 复核队列固定候选遮挡待办

- 基线 `90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`，2026-10-18只深入本域。入口Query knowledgeGraphEvidenceReviewQueue，settings.manage OR knowledgegraph.review，已有总读+settings/crawl子开关。
- Nest KnowledgeGraphReviewService.listEvidenceReviewQueue 和 Go settingscrawl/review.go/evidenceReviewQueue 都先take=min(500,max(50,limit*4))，再跳过合法已复核状态。候选前缀足够多时，后面符合confidence/组织的待办永远不出现在列表；这不是Go完全缺入口，也不是新发现未迁root。
- [KNOWLEDGE-REVIEW-001](tasks/KNOWLEDGE-REVIEW-001.md)认领：按createdAt DESC/id DESC稳定游标轻字段分批，直到选满/耗尽，选中ID再批量关联；保留同组织关联、limit/nullable/confidence与状态判定。明确改变固定总候选上限和同时间排序，改善用户可见待办列表；不照搬原算法遮挡。
- 允许文件settingscrawl/review.go及新review_support.go、knowledgegraph/review_support.go；不碰来源策略#82的register.go/policy.go。新增人工复核写是GAP-LEGACY-001子范围，ingestion仍属GAP-ASYNC-001，不随队列修复关闭。
- 状态pr_open（Ready #86，head4d6d24b8），随集成分支 integration/merge-open-prs-b80-87 收口；合并与运行验证证据待回填，不由规划文档关闭。关闭需实际main提交中队列分页/组织/投影分支、该head普通CI和明确算法证据。

## GAP-RSS-001 · RSS状态读取用窄投影覆盖完整网关缓存

- 核对main90765633（2026-10-18），入口Query rssTranslationStatus，items.read，原READ+ITEMS_READING；触发llm_gateway:profiles miss而MySQL有完整llm_gateway_profiles设置。
- `apps/api-go/internal/itemsreading/translation.go`：llmGatewayProfile只含ID/Model/Enabled，llmGatewaySettings只含ActiveID/Profiles；loadLLMGatewaySettings从DB解码此投影、normalize后Marshal并Set同key60秒，导致apiBase/apiKey/模型协议/embedding/rerank等字段不在缓存内。
- Nest `LlmGatewaySettingsService.loadSettings`（modules/system-settings/llm-gateway-settings.service.ts）在同key读写完整normalized settings，真实completion会消费它。状态读取不应改变实际网关配置；未运行证明生产已触发，不把静态根因推成已发生外网故障。
- [RSS-TRANSLATION-001](tasks/RSS-TRANSLATION-001.md)仅修此status写回：保留canonical缓存读取，miss从DB投影返回但不回填窄结构，不重做profile CRUD或盲目删缓存。业务translation新root另属GAP-LEGACY-001，不与此具体缺口混计。
- 核心文件translation.go；与#84 csvexport无文件交集，与#81 profiles/llmlogs核心隔离。状态reserved、main未修、关闭证据无；需实际merge中无损缓存行为及对应CI，真实部署独立核实。

<a id="gap-gql-001"></a>

## GAP-GQL-001 · 设置写独立开关漏入公共接线

- 最新限定增量（2026-10-18，main90765633）：#70已合，但graphqlRouteMode和无效DSN错误分支仍漏旧settingsWrite；needsCredentialedGo/handler已有。两处剩余条件已交[SOURCE-POLICY-WRITE-001](tasks/SOURCE-POLICY-WRITE-001.md)与新来源策略开关接线一并最小修复，不重迁13业务、不在此提前关闭缺口。网关任务只保留其main/config语义增量。

- 精确入口：SETTINGS-WRITE-001 列出的 13 个 `update*` Mutation；根因共用，不按 13 条重复建 bug。
- 触发：`API_GO_GRAPHQL_SETTINGS_WRITE_MODE=go`，`API_GO_GRAPHQL_READ_MODE=legacy`，`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=legacy`。其他模式都关时，即使配置校验通过，仍缺 Redis/authenticator，`run` 在 GraphQL 装配检查处返回错误，进程不监听。若其他 HTTP go 模式补齐资源，handler 可以构造，但 `/graphql` 路由仍走 legacy，写实际由 Nest 执行。
- Nest 应有行为：SettingsResolver 先校验 settings.manage / assertAdmin，再调用设置服务进行规范化、持久化和缓存更新。Go 的 13 个业务 resolver 已存在；这是入口/资源选择缺口，不重迁整批业务。
- 源码：[main.go](../../../apps/api-go/cmd/api/main.go) `run`：681–685 `graphqlRouteMode`；746–796 无效 DSN 的接管判断也漏设置写；877 `needsCredentialedGo`；1418–1422 handler 判断却含 `settingsWriteGo`。资源校验见 [config.go](../../../apps/api-go/internal/config/config.go) `Load` 2483；模型装配 1501–1509 已有读关闭/开启分支。
- 当前可达组合：设置写 + 总读（另需 Mongo），或设置写 + 组织写（无须 Mongo）。模型使用 settingscrawl.Register / RegisterSettingsModelTypes，详见 [GraphQL 组合表](modules/graphql-runtime.md#本轮有意义的组合复核)。
- 任务关系：#68 合并事实不撤销。#70 head `db6339122263658148072f65dc641d9b769117e7` 基于 #67，路由和资源 OR 仅增加 workspaceWrite，尚没有 settingsWrite；因此不能据 #70 描述宣称 main 已修复。14:49 再核 #70 已正常 merge #68，head `200ab9440bc2c4d217f429999468c90b81a968e0`：needsCredentialedGo 补了设置写，graphqlRouteMode 和无效 DSN 条件仍漏设置写。14:56 PR head推进到adb765d0但只追加交付报告，业务未变。工作目录已干净；PR 仍 OPEN，此候选资源修复不关闭 main 缺口。
- 主要文件：`cmd/api/main.go`；必要时 `internal/config/config.go`；模型复用见 `graphqlread/{workspace,settingscrawl}/register.go`。前置：先确认 #70 与 #68 的并集落地方式；这些共享文件一次只交给一个执行任务。BL-01 当前须等待或明确接线所有权，不重复认领 13 写。
- 关闭证据：**无**。需要落地 SHA 中 OR/资源/handler 一致，静态组合核对与该 head 普通 CI；独立开关运行证据另外记，不能由 CI 自动推断。

<a id="gap-news-001"></a>

## GAP-NEWS-001 · 事件简报缺少生成与写回

- 入口：Query `newsEventBrief(eventId, language, maxSources, forceRefresh)`，items.read；总读和新闻事件子模式均 go。
- 触发/影响：存在可访问事件且有有效来源；briefV1 缺失、语言/指纹失配或 `forceRefresh=true` 时固定字段错误 `Internal server error`，无法生成新简报。事件不存在/无来源返回 null 是合法结果，不算缺口。命中有效缓存可返回简报。
- Nest：[news-events.resolver.ts](../../../apps/api/src/graphql/resolvers/news-events.resolver.ts) → [NewsEventBriefService.getBrief](../../../apps/api/src/modules/news-events/news-event-brief.service.ts) → `generateBriefWithLlm`，清洗引用并合并 `metadata.briefV1`；写缓存失败记录 warning，仍返回已生成内容。
- Go：[newsevents/brief.go](../../../apps/api-go/internal/graphqlread/newsevents/brief.go) `newsEventBrief` 18–59，loadEvent/loadItems、选源/指纹与缓存命中已实现，末尾固定报错；没有模型调用/metadata 更新。注册在 [register.go](../../../apps/api-go/internal/graphqlread/newsevents/register.go)。核对 SHA 如页首。
- 可复用但不可直接调用：[publicportal/story.go](../../../apps/api-go/internal/publicportal/story.go) `Service.brief` 已实现选源→Complete→JSON 清洗→SaveEventMetadata；`brief`、`completionRequest`、gateway helper 均为包内私有，公共门户语言/组织选择与 GraphQL 参数也不同，不能声称已共享。
- 主要文件：newsevents `brief.go` / store/model；如抽共享能力，需明确 publicportal/story.go、brief.go、gateway.go 的所有权。MySQL NewsEvent/NewsEventItem/ProcessedArticle、模型配置/密钥、HTTP 模型上游；无须为了这个同步入口迁 BullMQ。前置是确定具名共享模型/客户端边界，BL-02 可独立窗口评估，避开 BL-17 公共门户客户端并行修改。
- 状态：已分配 [NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md)（pr_open）；编码窗口在 main 9d0462e1 上给出候选实现（BRIEF 子开关 + Go 选源→模型→校验清洗→`JSON_SET` 写 briefV1 叶子 + best-effort LLM 请求日志），Ready [PR #72](https://github.com/wei500L/newwei/pull/72) head 517a73f9 普通 CI verify/integration 通过，但**尚未合 main**，故缺口仍开放。规划期另核出生成 source 缺 Summary/KeyPoints、结构 schema 差异与 Nest LLM request log 副作用，详见任务/提示词。关闭证据：**无**；需该候选实际 merge SHA 中命中、miss、forceRefresh、无事件/来源、写回与日志分支的落地证据，实网模型验证另记。

<a id="gap-crawl-001"></a>

## GAP-CRAWL-001 · 已注册媒体入口丢失 S3 下发

- 入口：`GET /api/crawl-media-assets/:assetId/:mode`，mode 为 preview/download；公开路由使用 HMAC 的 exp/org/user/sig 授权，不由公开二字推断可越租户。
- 同因缺口（本次一并交付）：`GET /api/crawl-tasks/:id` 与 `Query crawlTask` 的 `mediaAssets` 对 S3 记录同样不生成 preview/download URL，且 REST 与 GraphQL 各有独立构造器，必须同时注入存储能力。
- 触发/用户影响：`API_GO_CRAWL_READ_TELEMETRY_MODE=go`；签名有效、orgId 匹配且资产 provider 为 s3，有合法 storageKey/存储配置，Go 仍返回 404。任务详情返回的媒体 URL 可能因此失效。
- Nest：[CrawlMediaAssetService.getAssetDeliveryPayload](../../../apps/api/src/modules/crawl/crawl-media-asset.service.ts) 433–520，MySQL blob 与 S3 分支分开，S3 调 storage.createObjectReadUrl，附 content-type/disposition/cache-control；[controller](../../../apps/api/src/modules/crawl/crawl-media-asset.controller.ts) 对 redirectUrl 重定向。
- Go：[service_media.go](../../../apps/api-go/internal/crawlreadtelemetry/service_media.go) `getAssetDeliveryPayload` 456–515，MySQL joined blob/legacy blob 已实现；非 MySQL 末尾固定 `(nil,nil)`。`serveMediaAsset` 151 将 nil 映射为 404，虽有 RedirectURL 分支却没有 S3 生产者。核对 SHA 如页首。
- 主要文件：crawlreadtelemetry/service_media.go、模型/构造与 `cmd/api/crawl_read_telemetry.go`；读取存储配置/解密可能涉及 infrastructuresettings/storage.go，当前该包只提供配置管理，不能当现成 S3 对象客户端。S3/Nest StorageService 是外部对象边界；不需要迁 crawl worker 才可补读。
- 前置/冲突：明确 S3 配置优先级、endpoint/path-style/publicBaseURL/TTL 与租户签名；BL-03 与 BL-15 的存储配置辅助函数串行。原 #50 已 merged，未迁的是剩余 S3 分支，不重新分配整个 7 路批次。
- 同因缺口（规划期复核确认）：`service_media.go`/`buildStoredMediaAsset` 对非 mysql 直接返回、未生成 preview/download URL；它由 REST 详情及 `settingscrawl` 独立构造的 `Query crawlTask` 共同消费，只修下发路由不能闭环。
- 状态：2026-10-18 已实现，[STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md)（pr_open）交付于 `refactor/go-storage-media`（[Ready PR #73](https://github.com/wei500L/newwei/pull/73)）；PR **未合 main**，本缺口**仍开放**。已交付：媒体路由 S3 presigned 302（按记录自身 storageKey，签名 content-type/disposition/cache-control，配置不完整返回 400）、REST 详情与 `Query crawlTask` 两处注入并各自签名 preview/download、按存储配置 TTL 且修正 env TTL 回退；GAP 同时覆盖详情两处构造。关闭证据：需实际合入 main 的提交 + 该 head 的普通 CI success，以及实桶/MinIO 真实签名下载验证；当前只有 PR/静态契约测试，实桶未执行。

<a id="gap-legacy-001"></a>

## GAP-LEGACY-001 · 尚无 Go 接管的契约入口

2026-10-19来源子链限定增量（main91e759b4）：GET /api/news-aggregator/source、POST /api/news-aggregator/sources/batch完整范围由[NEWSNOW-SOURCES-001](tasks/NEWSNOW-SOURCES-001.md) reserved，当前仍Nest，Go未实施。包含64来源ID的实际上游/凭据/缓存/必要实时接缝，不把它们当64HTTP。推荐/热点分析与后台预热不认领，不关闭本跨域GAP。审计#92仍开放、未合main；与此子链无核心业务交集。

- 精确范围的唯一事实源：18 个域页的 HTTP/root 表。当前 95 条 HTTP 标为 Nest、6 Query、36 Mutation、4 Subscription 未被 Go 注册；另有 `GET /api/healthz/live` 仍为 shadow，单列为切流状态，不能算新增缺陷。与 274/370 接管口径相容。
- 触发/影响：请求到达 legacy 规则或包含未接管 GraphQL root，业务由 Nest 执行；停掉 Nest 会失去相应功能。Go 并没有把这些入口返回空值来冒充完成。
- Nest / Go：Nest Controller/Resolver/Service 定位已在域表；Go [legacyproxy](../../../apps/api-go/internal/legacyproxy) 与 [exec/walk.go](../../../apps/api-go/internal/graphqlread/exec/walk.go) 决定回退。未注册 root 在副作用前整份回退。
- 任务覆盖：工作台 8 写由 WORKSPACE-WRITE-001 / #70 占用，保持 pr_open；Query `items` 由 [ITEMS-LIST-001](tasks/ITEMS-LIST-001.md) 覆盖（pr_open，未合 main，不提前改本页分母）；其余候选见 BACKLOG 各自精确范围、文件和前置，不能领取整个集合。主要共享冲突是 main/config/Registry，其余按域隔离。
- 2026-10-18 新增具体子范围认领：ITEMS-LIST-001（pr_open，#74）负责 Query items，STORAGE-MEDIA-001（pr_open，#73）负责 storage/test；不关闭本跨域 GAP，不把未认领集合整体交给任一窗口。news/媒体部分实现另按各自 GAP 记录。
- 状态：部分已被任务覆盖，其余未分配；关闭证据按入口分批关联实际 main 提交，不因一批合并关闭整个 ID。新增/删契约另改分母，不以文档行数算迁移进度。

<a id="gap-async-001"></a>

## GAP-ASYNC-001 · 已迁读取背后的 Nest 执行所有权

2026-10-19条目入库限定增量（main91e759b4）：[ITEMS-INGEST-001](tasks/ITEMS-INGEST-001.md) pr_open，含raw_item消费者/后台owner与itemPipeline native producer、读模型刷新；完整[提示词](tasks/ITEMS-INGEST-001.prompt.md)已保存。当前main仍由Nest投递/补偿；新任务不迁itemPipeline worker、processed_item/其他Outbox或Socket.IO，不因这条认领关闭本跨域GAP。

2026-10-19四订阅限定增量（main91e759b4）：[GRAPHQL-SUBSCRIPTIONS-001](tasks/GRAPHQL-SUBSCRIPTIONS-001.md) reserved，[完整提示词](tasks/GRAPHQL-SUBSCRIPTIONS-001.prompt.md)已保存于Ready规划#93；四Subscription executor/upgrade在main仍Nest。只规划传输/事件投影、三域Redis订阅与itemPipeline广播观察及终态组织上下文，不迁入队/业务worker/Socket.IO，不关闭本跨域GAP。审计#92 OPEN/CI成功但未入main，NewsNow已in_progress；缺口/部署仍分别核实，不从本次规划增加完成数。

2026-10-19仅审计子链增量（main c70b0373）：[AUDIT-OUTBOX-001](tasks/AUDIT-OUTBOX-001.md) reserved，[完整提示词](tasks/AUDIT-OUTBOX-001.prompt.md)已保存；Go生产者已存在，AuditLogOutboxService仍Nest每分钟重放，Go消费者尚未实现，不能关闭缺口。摘要业务head2b0da7ec已通过#89进入main；这仅纠正下方旧快照的任务合并状态，不表示所有调度/实际部署已验证。新任务仅处理审计消费/所有权/查询优化，其余Outbox/worker范围不变。

2026-10-18限定增量（main90765633）：[DIGEST-DELIVERY-001](tasks/DIGEST-DELIVERY-001.md)已reserved并发出提示词，补Cron/到期CAS/SMTP/状态及摘要专用实时通知桥，现有五HTTP不重迁。NotificationDispatcher目前仅Nest进程内，桥尚不存在；只写通知表不能关闭此子链。本批无BullMQ，不覆盖其他调度/补偿/WS执行器；main仍Nest投递，未实施或真实验证，关闭证据无。

这是迁移边界，不是“所有 Go 读都未实现”。精确步骤和源码见 [DEPENDENCIES 执行所有权](DEPENDENCIES.md#产品链路与执行所有权) 与 [异步域](modules/async-runtime.md)。

| 受影响的 Go 范围 | 仍须 Nest 执行的必要步骤 | 用户影响 / 触发 | 候选与前置 |
|---|---|---|---|
| `analysisResults` / `assistantRuns` | 当前submit/worker/Mongo更新/发布仍Nest | ANALYSIS-RUNS-001 pr_open（#98）完整analysis Go执行，实现已提交、待整合合并；Assistant未认领，不一并关闭 | BL-12已占用，双开关/原生兼容/恢复GAP；BL-13独立核 |
| 归档准备状态 HTTP；三Query/search尚Nest | ensure*Coverage→archivePreparation→ArchivePreparationProcessor→分类/显示信号回填/状态写回 | status可读不代表有生成能力；停Nest worker无法推进冷数据。ARCHIVE-READING-001 reserved仅查询+兼容producer，尚未实现 | BL-09/08第一阶段已占用；Go准备worker第二阶段未认领，整链未关闭 |
| Telegram/Oref 信号和 refresh-run 读 | signals processor、轮询器、external snapshot Cron、refresh 入队 | Go 读取已有 Redis 缓存；停 Nest 会失去后续刷新 | BL-14；外部凭据与租约先确认 |
| 经济六读、新闻事件/指标、知识图谱读 | AkShare repeat/processor、news pipeline/ingestion、KG ingestion | 已有数据查询在 Go；新数据/关联仍依赖 Nest 更新 | BL-11/16/18；先划每条数据写入所有权 |
| digest 投递配置；审计补偿 | UserDigestDeliveryScheduler；AuditLogOutboxService 等 Cron | 配置已保存不等于邮件发送；设置写审计失败时 Go 写 outbox，重放仍在 Nest | BL-19/20；去重键、租约、关闭与外部 SMTP |
| 四 Subscription 与 Socket.IO | Nest executor / Redis backplane / WS gateway | Go SSE 不替代 GraphQL/WS；协议升级仍回退 | BL-21；先确定事件生产者/租户与字段权限 |

主要文件与独立交付边界分别保存在 BACKLOG，避免复制全部 worker 清单。状态：未分配；WORKSPACE-WRITE-001 只写交互数据，不覆盖告警扫描/SMTP/Webhook worker。关闭证据：**无**，按链路迁移后逐行缩小范围。

## 观察项与缺少验证（不计入已确认业务缺口）

- **OBS-DATA-001**：[main.go](../../../apps/api-go/cmd/api/main.go) 1245 空错误分支确实吞掉 `wireDataRuntimeSettings` 错误。当前 helper 仅在 go 且 db/redis/auth 为 nil 时返回错误；`config.Load` 要求 JWT/MySQL/Redis，main 的无效 DSN 阻断列表和 `needsCredentialedGo` 都含 dataRuntimeSettingsGo，先行完成这些资源装配。因此本轮未确认合法当前启动路径能触发它；不能写成“九路必然不可用”。若以后可触发，run 会继续，已选 ModeGo 却无 handler 的请求在 Gateway.ServeHTTPWithShadow 返回 **501**，不会自动回 Nest。跟踪候选 BL-01，需先证明可达路径/或说明仅错误传播修正，不改业务。
- **VERIFY-EXT-001**：真实 SMTP、模型、S3、crawl4ai、Nominatim/OpenSky、Telegram/Oref、AkShare 未在本轮调用。源码中有客户端不等于实网已通；正常外部错误/配置未设不自动登记 bug。
- **VERIFY-CONTRACT-001**：未逐字段复验所有 DTO/返回投影、跨进程缓存 TTL、事务竞争、全部游标/筛选边界，范围按 [AUDIT](AUDIT.md) 各组列明。静态阅读不是运行验收。
- **VERIFY-DEPLOY-001**：部署值、Web/vector 真实流量、生产启用与回滚均未核实。只读 Compose 源码，不读取真实 .env 或秘密。
