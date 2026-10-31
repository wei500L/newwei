# 已确认缺口与待核对事项

## 2026-11-01 当前源码功能缺口选批

核对 main `e04fc4d8bb54596afd302a309ebc852c7676d958`；其普通 CI 41242463081 已完成，三个主要 job success、两个 regen skipped。以下两项当前实现仍有缺口，分别 reserved；没有编码交付证据，不提前关闭。其它历史 GAP 不随本次迁移收口统一关闭。

| 稳定 ID / 原复核 | 当前源码证据与用户影响 | 交付范围 |
|---|---|---|
| `GAP-CRAWL-TABLES-001` / [EX-05](../review/crawl.md) | `internal/crawlexecution/results.go:648` 原样保存顶层 tables，缺少归一化和 media.tables 提取；读侧与 UI 期待完整维度/列/行/dataFrame 模型 | [CRAWL-TABLE-NORMALIZATION-001](tasks/CRAWL-TABLE-NORMALIZATION-001.md)：输入到 Mongo、REST/GraphQL、采集详情 UI |
| `GAP-MONITOR-GEOCODING-001` / [M-04](../review/situation-realtime.md) | `internal/situationmonitors/location.go` 的 geocode 固定公网 URL/UA，`cmd/api/situation_monitors.go:20` 未注入已有 geocoding client；监控地点解析绕过配置、缓存与全局限速 | [MONITOR-GEOCODING-001](tasks/MONITOR-GEOCODING-001.md)：共享客户端生产接线、preview/create/update、Web 链路 |

上表 Go 路径均相对 `apps/api-go/`，定位以本次核对 SHA 为准。旧 Nest 表格规则从删除前固定提交读取；不恢复 Node app，不批量改历史数据库或访问真实外部服务。

## 2026-11-01 源码退役完成后的边界

main `e04fc4d8bb54596afd302a309ebc852c7676d958` 已含 #152 / #153 / #154；三个退役 task 已 merged，各最终源 head 及最新 merge head 的三个普通 CI 主 job 均 success，两个 regen skipped，证据见 [收口记录](GO-MIGRATION-CLOSEOUT.md)。Node 后端、迁移 mode、shadow/canary 与 Nest 反代已删除；`legacyproxy` 旧包名下是实际纯 Go 路由器，不能再按目录名派“删除反代”任务。

不统一关闭未处理的业务问题：GAP-EXCEPTION-WIRING-001 的部分自写 500/unknown/stack 仍残留；GAP-ASYNC-001 的真实多实例与外部运行证据仍缺。冻结的鉴权/OpenAPI 历史预期已与实际 Go 路由覆盖和权限结构对照，但不等于对所有权限行为做运行期验证。Prisma/seed/Node 工具是明确保留范围，不登记为源码迁移缺口。

本轮未部署、未实网或本机运行测试，不重算全域覆盖，不把历史文档/注释当活跃依赖。后续先读最新 main CI 与本页稳定 GAP，不重新派发三项已合入任务。

## 2026-10-31 #151 合并后的增量

- 基线：`fcf1e5334acb0350ea36535c48c4131df7c9698a`，#151 最终 head `e48a2572` 为 main 祖先；源 CI 41199618477 三主 job success，merge CI 41200907795 核对时尚未完成。
- **GAP-DEV-CONFIG-001 已关闭（源码/配置层）**：根 `.env.example:63-73` 已用 4020 与两个新 Socket.IO 路径，模式清单 go/reject；宿主 vector/AIS 为4010/3004；`infra/scripts/src/dev.mts` + `dev-config.ts` + `dev-process.ts` 负责根环境、独立端口、Go/legacy/AIS 计划和生命周期；`cutover_env_example_test.go` / `dev-runtime.test.ts` / `env-connection-defaults.test.ts` 进入源 head 成功 CI。本轮未再运行这些测试，未部署/实测启动或真实外部调用。
- GAP-EXCEPTION-WIRING-001 仍是主体已合入、部分自写 500/unknown/stack 未完整覆盖；#151 未声称修复该残留。不能用默认切换 merged 替代异常覆盖证据。
- 新退役范围用三个具体 task 管理：契约/工具独立、Go 去迁移分流、Node/CI 删除。它们是已授权架构收尾，不机械新增业务缺陷 ID；保留的 Prisma/seed/Node 协议工具不是待删 HTTP 后端。

## 2026-10-31 完成核对与本地默认链缺口

main 基线 `385c887e8cda2df6a3fadd2109c6641ae62cb6ee`；默认切换候选单独取 #151/head `b97e181aa7248175ed3c91daf9a258dba6289f96`，不能混计。下方 2026-10-27 的 open 清单为原缺口事实，现行增量如下：

- GAP-HTTP-HEADERS-001 / GAP-METRICS-WIRING-001 / GAP-ITEMS-BODY-001：**源码修复已合入 #150**。证据：main 根链 `cmd/api/main.go:3396`；`internal/metrics/producers.go` 与实际 ES/模型/provider 调用；`internal/itemsingest/handler.go:334` 的 `createBodyLimit=10<<20`。源 head 普通 CI 40551203359 三主要 job success；merge CI 40557202479 Web 测试失败，两个集成 success。未部署，真实服务未知。
- GAP-EXCEPTION-WIRING-001：**主体已合入，范围收窄但未完整关闭**。`cmd/api/main.go:1868,2568` 安装 REST/GraphQL recorder；`internal/crawlprofile/handler.go:349-352` 等序列化失败分支仍直接 `http.Error`，unknown/stack 亦不完整。按 #150 实际交付保留残留，不因 task=merged 删去。
- **GAP-DEV-CONFIG-001（open，GO-DEFAULT-CUTOVER-001 内继续，不新建任务）**：#151 根 `.env.example:57-65` 仍给 API 4000/旧 Socket.IO，`:70,103-119` 等仍显式 shadow/legacy；Web `next.config.mjs:4` 读根 `.env`，`lib/env.ts:48-54` 尊重显式值，因此示例覆盖新默认。根命令改为 go run 后，还需闭合 Go 的 OS 环境来源、vector/AIS 进程监听 4010/3004 与示例 4011/3005 的区别、dev:legacy 的完整显式回退。前者已静态确认，启动环境与端口组合须按生产入口进一步核实，未运行服务复现。

修补范围、排除与验证见 [继续提示词](tasks/GO-DEFAULT-CUTOVER-001.followup.prompt.md)。#151 当前 CI success 不覆盖这处示例遗漏，不能用旧 head 的通过关闭新缺口；本轮仅维护规划，不实施修复。

## 2026-10-27 切默认前增量

本节核对基线 `f15f598d4358b4c9823054ef5a355618e1480a4e`。#148 已合入，五份 review 的原审查深度保留；本节只核以下根因与旧残留的整合更正，不冒充全仓复审。`cc3782c0..f15f598d` 仅改 workflow 的 runner，以下源码定位未变。

| 稳定 ID | 触发 / 当前源码证据 | 影响与状态 |
|---|---|---|
| GAP-HTTP-HEADERS-001 | Nest `apps/api/src/main.ts:107` 使用 helmet；Go `apps/api-go/cmd/api/main.go:3367` 根链只有 trace，媒体局部头不能替代全局策略 | Go 直接响应缺既有安全头；**open**，归 GO-CUTOVER-PREREQS-001；需兼容 Swagger/CORS/媒体策略 |
| GAP-METRICS-WIRING-001 | Go `internal/metrics/families.go:104,116,128` 有三类记录函数但无非测试调用；Nest main、ES/search、LiteLLM、pipeline metric provider 有生产调用 | HTTP histogram、integration counter、pipeline gauge 无真实数据；**open**，同任务；不能只修 HTTP 就关闭 |
| GAP-EXCEPTION-WIRING-001 | Nest `common/filters/global-exception.filter.ts` 处理 http/graphql；Go `cmd/api/legacy_fallback.go:newNestNotFoundRecorder` 仅给 reject/docs 404 | 自有 REST/GraphQL 错误缺既有异常集合接线；**open**，同任务；GraphQL 200+errors 不能靠 HTTP 状态侦测 |
| GAP-ITEMS-BODY-001 | Go `internal/itemsingest/handler.go:150-151` 1MiB parser，`:246-268` 把解析错误写 400；Nest `main.ts:110-117` JSON 10mb | 合法大创建体提前失败；**open**，同任务。真实入口是 `POST /api/items`（Go `Path`、Nest `items.controller.ts:28-30`），纠正 #148 §7 的 `/api/items/ingest` 与当前“413”表述 |

缺口来源是 [#148 §7](https://github.com/wei500L/newwei/pull/148)，以上实现/错误码已按当前源码再核；完成标准与允许路径见 [任务](tasks/GO-CUTOVER-PREREQS-001.md) / [提示词](tasks/GO-CUTOVER-PREREQS-001.prompt.md)。修复 PR 开放不等于 main 缺口关闭；必须记录实际落地 SHA 和普通 CI。后继 GO-DEFAULT-CUTOVER-001 在四项关闭后执行，不预先改开关。

旧 GAP-LEGACY-001 / GAP-ASYNC-001 的下方历史范围已过期：五条 C 类 HTTP、队列计数/事件派生读、告警 repeat 对账、NewsNow 后台、brief、审计 outbox 已有 Go 实现接线；DLQ 人工 inspect/replay/delete 是既定设计，不要求自动消费者。定位见 `cutover/ownership-audit.md` 与 `review/{identity-core,news-items,workspace-runtime}.md` 整合更正。默认未启用、真实多实例/外部服务未验证应分开记录，不重新派“未迁”整批，也不据此宣称运行验收完成。

[入口](README.md) · [候选队列](BACKLOG.md) · [实现核对范围](AUDIT.md)。本轮源码基线均为 `3cedce9aa3200436aba3596f63b559de5490cec8`（2026-10-18 14:37–14:42 MSK 静态阅读）；PR #70 的候选代码另记 head，不能关闭 main 缺口。稳定 ID 不因任务 merged 而删除。关闭须有实际落地提交、对应入口/分支与证据。

2026-10-21 复核基线 `dcbe563b917f`（#136，整合 #133–#135；普通 CI run 39625284282 `conclusion=success`，无开放 PR）：本页逐条用当前 main 源码重核关闭状态：GAP-NEWS-001 / GAP-CRAWL-001 / GAP-GQL-001 已关闭，GAP-ASYNC-001 范围缩小但未关闭；另按真实代码关闭 GAP-ANALYSIS-001 / GAP-ITEMS-001 / GAP-KG-001 / GAP-RSS-001。`path:line` 均取 `dcbe563b`。关闭只表示“源码缺口的实现/接线已落地”，**不代表已部署、已切流或实网验证**。

## 当前摘要

| ID | 性质 / 所属域 | 影响范围 | 状态 / 归属 |
|---|---|---|---|
| GAP-ANALYSIS-001 | 中断恢复；analysis | BullMQ stalled重排时Mongo仍running，被process认领条件跳过，可能形成队列结束/结果永久running | **已关闭**（`dcbe563b`）：`apps/api/src/modules/analysis/analysis.service.ts:156` 的 claim 条件已含 `running`，`:145-160` 以 runToken 围栏终态写；ANALYSIS-RUNS-001 merged（#98 → `240b86b71b94`）；未部署/未运行验证 |
| GAP-ITEMS-001 | 部分实现/水合；items | Go读模型水合只取completed窄快照，丢最新pending/failed及必要字段 | **已关闭**（`dcbe563b`）：`apps/api-go/internal/itemsreading/readmodel.go:185-198` 改取任意状态最新快照（`ListLatestProcessedSnapshotsAnyStatus`）；ITEMS-INGEST-001 merged（#96 → `bb7cb6f2666c`）；未部署/未运行验证 |
| GAP-RSS-001 | 部分实现/共享缓存；items | rssTranslationStatus在LLM profile缓存miss后覆盖完整缓存字段 | **已关闭**（`dcbe563b`）：`apps/api-go/internal/itemsreading/translation.go:431-459` 只读 canonical 缓存，miss 时从 DB 返回且不再把窄投影写回；RSS-TRANSLATION-001 merged（#88 → `f85f80200ff7`，经 #90 → `c70b0373990a`）；未生产验证 |
| GAP-GQL-001 | 接线；settings / GraphQL 公共运行时 | 设置 13 写单独启用 | **已关闭**（`dcbe563b`）：路由 OR `apps/api-go/cmd/api/main.go:893`、`needsCredentialedGo` `apps/api-go/cmd/api/main.go:1348`、handler 装配 `apps/api-go/cmd/api/main.go:2192-2193` 三处均含 `GraphQLSettingsWriteMode`，无效 DSN 阻断列表见 `apps/api-go/cmd/api/main.go:1080`；SOURCE-POLICY-WRITE-001 merged（#82 → `f293f78053ff`）；独立开关运行证据另记 |
| GAP-NEWS-001 | 部分实现；news | Query `newsEventBrief` 冷生成/forceRefresh | **已关闭**（`dcbe563b`）：BRIEF 子开关注入 completer 与 LLM 日志 writer（`apps/api-go/cmd/api/main.go:2236-2243`），生成 `apps/api-go/internal/graphqlread/newsevents/brief.go:69`、写回 `:81`→`:456-482`；NEWS-BRIEF-001 merged（#72 → `e40e9041df6e`）；实网模型未验证 |
| GAP-CRAWL-001 | 部分实现；crawl | 媒体下发及已有REST/GraphQL详情的 S3 URL分支 | **已关闭**（`dcbe563b`）：`apps/api-go/internal/crawlreadtelemetry/service_media.go:478-540` S3 presign 302、`:605-646` 详情两处构造；GraphQL 存储配置注入 `apps/api-go/cmd/api/main.go:2273-2279`；STORAGE-MEDIA-001 merged（#73 → `f4ac4aa807b6`）；实桶未验证 |
| GAP-LEGACY-001 | 未迁移入口；跨域 | 原五条 C 类 HTTP/root | **原列举入口的源码/注册缺口已关闭**（2026-10-27，`f15f598d`）：#138/#139 经 #141 已接线，#148 整合更正复核；默认仍 legacy/shadow。新横切缺口另见上方四 ID，不能与部署/流量合并统计 |
| GAP-ASYNC-001 | Nest 执行依赖；跨域 | 已迁读取/配置背后的生成、消费、调度、订阅 | **原列举源码残留已解除，运行证据仍未完成**（2026-10-27，`f15f598d`）：queueops 人工 DLQ 路径、alertworker/reconcile、QueueObserver/queueorgstats 等已实现接线；不把人工 DLQ 设计当缺消费者。实际执行权取值、真实多实例/外部验证仍未知，见整合更正 |
| GAP-KG-001 | 部分实现；knowledge | 已迁证据复核队列的固定候选遮挡 | **已关闭**（`dcbe563b`）：`apps/api-go/internal/graphqlread/settingscrawl/review.go:68-130` keyset 分页直到选满/耗尽，无固定候选上限；KNOWLEDGE-REVIEW-001 merged（#86 → `afd9ba7d1974`）；未部署验证 |

“未迁移”是范围事实，不表示 Nest 有 bug；“缺少外部运行证据”不单独计为源码缺陷。2026-10-21 的关闭判定全部基于 `dcbe563b` 源码与已合并提交，不因文档维护本身关闭缺口；关闭不等于部署/切流/实网验证。

2026-10-20 本批整合增量：`docs/refactor/migration-map` 的 21 条开放 PR 由 `integration/merge-open-prs-b92-113` 一次性收口（#92–#113，#111 由 #112 取代并关闭）。GAP-ANALYSIS-001、GAP-ITEMS-001 由 reserved 改为 pr_open（#98 head e9c99ec9、#96 head 761ed72c）；GAP-RSS-001、GAP-KG-001、SOURCE-POLICY-WRITE-001 等经 #89/#90 合入的事实回填为 merged，但均未部署/未运行验证，不关闭缺口。本批新增的 worker/Cron/订阅仍按“实现已提交、整合分支待合并”记录，不以 PR CI 代替部署或实网证据。

<a id="gap-analysis-001"></a>

## GAP-ANALYSIS-001 · 分析中断重排与结果running脱节

- SHA：91e759b449c4511dc96d86539ea0eb258754d07e，2026-10-19限定analysis链静态核对；没有生产故障/运行复现证据。
- 触发：worker在Mongo标running后崩溃/锁丢失，BullMQ5.63.2按stalled策略重新交付。Nest apps/api/src/modules/analysis/analysis.service.ts:134-148只认pending/failed，running不匹配就return；analysis.processor.ts调用后无恢复。官方Worker/Job/Scripts的stalled回wait和重新执行路径已核。
- 影响：可重试任务不再实际计算，队列可结束但analysisresults仍running；stalled最终失败也须和Mongo/通知对齐。不能以BullMQ有重试认定业务已恢复。
- Go事实：当前无完整analysis执行器，history读无法修复。ANALYSIS-RUNS-001（#98，head e9c99ec9）已提交实现并持当前queue租约的running接续、最小attempt条件写/旧token不能覆盖、终态/最终通知，Nest回滚侧同步本链窄修；队列仍at-least-once，不引入跨库exactly-once框架。
- 文件：Nest analysis.processor.ts/analysis.service.ts、必要analysis-result可选字段，Go新analysisqueue/analysisruns；不扩展其他worker。远端普通CI真实Redis/Mongo/worker+SSE fixture须覆盖重排、旧token、已完成不重复；真实模型和部署分别记。
- 状态reserved、未实施、关闭证据无；须实际main落地、精确head CI/恢复行为证据，生产启用另记。

2026-10-21 复核（`dcbe563b`）：**已关闭**。`apps/api/src/modules/analysis/analysis.service.ts:145-160` 的 claim 条件已为 `status: { $in: ["pending","failed","running"] }`（`:156`），并用本次 attempt 的 runToken 作为终态写围栏（注释明确引用 GAP-ANALYSIS-001）；Go 侧执行链见 `apps/api-go/internal/analysisruns`、`analysisqueue` 与 `apps/api-go/cmd/api/analysis_runs.go:70-155`。ANALYSIS-RUNS-001 经 #114 收口（#98 → `240b86b71b94`）。未做运行/部署验证。

<a id="gap-items-001"></a>

## GAP-ITEMS-001 · 水合快照误用已完成数据读取

- 2026-10-19限定核对main `91e759b449c4511dc96d86539ea0eb258754d07e`，触发已有itemreadmodels水合/新写后刷新；不推断生产已发生故障。
- Go `apps/api-go/internal/itemsreading/readmodel.go:loadProcessedSnapshots` 调用 `mongo.go:ListLatestProcessedSnapshots`，后者where固定status=completed，投影不含rawItemId/error/llm/updatedAt等水合字段。Nest `ItemsReadModelService.loadProcessedReadModelSnapshots/buildLatestItemSnapshotPipeline` 在org+item IDs内按createdAt DESC,_id DESC取最新任意状态及完整snapshot，没有completed过滤。
- 影响：最新pending/failed可能缺失或旧completed替代最新运行状态；仅导出Go私有hydration helper不能完成写后读模型契约。搜索/RSS取completed本身不是此缺口，不改它们的语义。
- [ITEMS-INGEST-001](tasks/ITEMS-INGEST-001.md) 已 pr_open（#96，head 761ed72c），仅认领hydration专用Mongo聚合/全snapshot、组织和raw双向绑定/缺snapshot unset及新写链调用。允许readmodel.go与独立hydration store/port，不重建全库read-model、不新增后台回填；状态未修，无关闭证据。关闭需实际main实现/对应head验证与最新状态case，生产启用另记。

2026-10-21 复核（`dcbe563b`）：**已关闭**。`apps/api-go/internal/itemsreading/readmodel.go:185-198` 的 `loadProcessedSnapshots` 改用 `ListLatestProcessedSnapshotsAnyStatus`，按 item 取任意状态的最新快照（注释明确新入队 pending 不再被旧 completed 遮蔽），completed-only 的搜索辅助保持不变。ITEMS-INGEST-001 经 #114 收口（#96 → `bb7cb6f2666c`）。未做运行/部署验证。

<a id="gap-kg-001"></a>

## GAP-KG-001 · 复核队列固定候选遮挡待办

- 基线 `90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`，2026-10-18只深入本域。入口Query knowledgeGraphEvidenceReviewQueue，settings.manage OR knowledgegraph.review，已有总读+settings/crawl子开关。
- Nest KnowledgeGraphReviewService.listEvidenceReviewQueue 和 Go settingscrawl/review.go/evidenceReviewQueue 都先take=min(500,max(50,limit*4))，再跳过合法已复核状态。候选前缀足够多时，后面符合confidence/组织的待办永远不出现在列表；这不是Go完全缺入口，也不是新发现未迁root。
- [KNOWLEDGE-REVIEW-001](tasks/KNOWLEDGE-REVIEW-001.md)认领：按createdAt DESC/id DESC稳定游标轻字段分批，直到选满/耗尽，选中ID再批量关联；保留同组织关联、limit/nullable/confidence与状态判定。明确改变固定总候选上限和同时间排序，改善用户可见待办列表；不照搬原算法遮挡。
- 允许文件settingscrawl/review.go及新review_support.go、knowledgegraph/review_support.go；不碰来源策略#82的register.go/policy.go。新增人工复核写是GAP-LEGACY-001子范围，ingestion仍属GAP-ASYNC-001，不随队列修复关闭。
- 状态pr_open（Ready #86，head4d6d24b8），随集成分支 integration/merge-open-prs-b80-87 收口；合并与运行验证证据待回填，不由规划文档关闭。关闭需实际main提交中队列分页/组织/投影分支、该head普通CI和明确算法证据。

2026-10-21 复核（`dcbe563b`）：**已关闭**。`apps/api-go/internal/graphqlread/settingscrawl/review.go:68-73` 把页大小定义为“扫描页”而非总数上限，`:102-130` 的 `selectReviewCandidateIDs` 用 (createdAt,id) keyset 游标持续翻页直到选满 limit 或源耗尽。KNOWLEDGE-REVIEW-001 经 #89 合入（#86 → `afd9ba7d1974`）。

## GAP-RSS-001 · RSS状态读取用窄投影覆盖完整网关缓存

- 核对main90765633（2026-10-18），入口Query rssTranslationStatus，items.read，原READ+ITEMS_READING；触发llm_gateway:profiles miss而MySQL有完整llm_gateway_profiles设置。
- `apps/api-go/internal/itemsreading/translation.go`：llmGatewayProfile只含ID/Model/Enabled，llmGatewaySettings只含ActiveID/Profiles；loadLLMGatewaySettings从DB解码此投影、normalize后Marshal并Set同key60秒，导致apiBase/apiKey/模型协议/embedding/rerank等字段不在缓存内。
- Nest `LlmGatewaySettingsService.loadSettings`（modules/system-settings/llm-gateway-settings.service.ts）在同key读写完整normalized settings，真实completion会消费它。状态读取不应改变实际网关配置；未运行证明生产已触发，不把静态根因推成已发生外网故障。
- [RSS-TRANSLATION-001](tasks/RSS-TRANSLATION-001.md)仅修此status写回：保留canonical缓存读取，miss从DB投影返回但不回填窄结构，不重做profile CRUD或盲目删缓存。业务translation新root另属GAP-LEGACY-001，不与此具体缺口混计。
- 核心文件translation.go；与#84 csvexport无文件交集，与#81 profiles/llmlogs核心隔离。状态reserved、main未修、关闭证据无；需实际merge中无损缓存行为及对应CI，真实部署独立核实。

2026-10-21 复核（`dcbe563b`）：**已关闭**。`apps/api-go/internal/itemsreading/translation.go:431-440` 只读 canonical `llm_gateway:profiles` 缓存；miss 时 `:447` 读取 DB 原始值并在 `:459` 返回 normalize 结果，**不再**用窄投影 Set 同一 key（当前唯一缓存写为 `:418` 的 `situation_monitor:settings`）。RSS-TRANSLATION-001 经 #90 合入（#88 → `f85f80200ff7`）。

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

2026-10-21 复核（`dcbe563b`）：**已关闭**。设置写三处剩余条件已全部含 `API_GO_GRAPHQL_SETTINGS_WRITE_MODE`：`graphqlRouteMode` OR（`apps/api-go/cmd/api/main.go:891-905`，设置在 `:893`）、无效 DSN 阻断列表（`apps/api-go/cmd/api/main.go:1080`）、`needsCredentialedGo`（`apps/api-go/cmd/api/main.go:1348`）；GraphQL handler 装配条件 `apps/api-go/cmd/api/main.go:2192-2193` 亦含 `settingsWriteGo`；开关校验见 `apps/api-go/internal/config/config.go:4592-4598,6048`。SOURCE-POLICY-WRITE-001 经 #89 合入（#82 → `f293f78053ff`）。独立开关的运行/部署证据仍另记，不由本页推断。

<a id="gap-news-001"></a>

## GAP-NEWS-001 · 事件简报缺少生成与写回

- 入口：Query `newsEventBrief(eventId, language, maxSources, forceRefresh)`，items.read；总读和新闻事件子模式均 go。
- 触发/影响：存在可访问事件且有有效来源；briefV1 缺失、语言/指纹失配或 `forceRefresh=true` 时固定字段错误 `Internal server error`，无法生成新简报。事件不存在/无来源返回 null 是合法结果，不算缺口。命中有效缓存可返回简报。
- Nest（原核对基线 `3cedce9a` 历史源码）：[news-events.resolver.ts](https://github.com/wei500L/newwei/blob/3cedce9aa3200436aba3596f63b559de5490cec8/apps/api/src/graphql/resolvers/news-events.resolver.ts) → [NewsEventBriefService.getBrief](https://github.com/wei500L/newwei/blob/3cedce9aa3200436aba3596f63b559de5490cec8/apps/api/src/modules/news-events/news-event-brief.service.ts) → `generateBriefWithLlm`，清洗引用并合并 `metadata.briefV1`；写缓存失败记录 warning，仍返回已生成内容。
- Go：[newsevents/brief.go](../../../apps/api-go/internal/graphqlread/newsevents/brief.go) `newsEventBrief` 18–59，loadEvent/loadItems、选源/指纹与缓存命中已实现，末尾固定报错；没有模型调用/metadata 更新。注册在 [register.go](../../../apps/api-go/internal/graphqlread/newsevents/register.go)。核对 SHA 如页首。
- 可复用但不可直接调用：[publicportal/story.go](../../../apps/api-go/internal/publicportal/story.go) `Service.brief` 已实现选源→Complete→JSON 清洗→SaveEventMetadata；`brief`、`completionRequest`、gateway helper 均为包内私有，公共门户语言/组织选择与 GraphQL 参数也不同，不能声称已共享。
- 主要文件：newsevents `brief.go` / store/model；如抽共享能力，需明确 publicportal/story.go、brief.go、gateway.go 的所有权。MySQL NewsEvent/NewsEventItem/ProcessedArticle、模型配置/密钥、HTTP 模型上游；无须为了这个同步入口迁 BullMQ。前置是确定具名共享模型/客户端边界，BL-02 可独立窗口评估，避开 BL-17 公共门户客户端并行修改。
- 状态：已分配 [NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md)（pr_open）；编码窗口在 main 9d0462e1 上给出候选实现（BRIEF 子开关 + Go 选源→模型→校验清洗→`JSON_SET` 写 briefV1 叶子 + best-effort LLM 请求日志），Ready [PR #72](https://github.com/wei500L/newwei/pull/72) head 517a73f9 普通 CI verify/integration 通过，但**尚未合 main**，故缺口仍开放。规划期另核出生成 source 缺 Summary/KeyPoints、结构 schema 差异与 Nest LLM request log 副作用，详见任务/提示词。关闭证据：**无**；需该候选实际 merge SHA 中命中、miss、forceRefresh、无事件/来源、写回与日志分支的落地证据，实网模型验证另记。

2026-10-21 复核（`dcbe563b`）：**已关闭**。`apps/api-go/cmd/api/main.go:2236-2243` 在 `API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go` 时注入 `publicportal.NewBriefCompleter`（加密 key/LiteLLM 基址/超时/重试）与 `llmlogs.NewCompletionWriter`；`apps/api-go/internal/graphqlread/newsevents/brief.go:69` 调用生成，`:81` 经 `saveBriefV1`（`:456-482`）以 `JSON_SET(metadata,'$.briefV1',…)` 写回且带 `id + orgId` 条件，写回失败仅记日志并仍返回已生成简报（`:82-85`）；来源结构已携带 Summary/KeyPoints。NEWS-BRIEF-001 经 #77 合入（#72 → `e40e9041df6e`）。真实模型调用仍未验证。

<a id="gap-crawl-001"></a>

## GAP-CRAWL-001 · 已注册媒体入口丢失 S3 下发

- 入口：`GET /api/crawl-media-assets/:assetId/:mode`，mode 为 preview/download；公开路由使用 HMAC 的 exp/org/user/sig 授权，不由公开二字推断可越租户。
- 同因缺口（本次一并交付）：`GET /api/crawl-tasks/:id` 与 `Query crawlTask` 的 `mediaAssets` 对 S3 记录同样不生成 preview/download URL，且 REST 与 GraphQL 各有独立构造器，必须同时注入存储能力。
- 触发/用户影响：`API_GO_CRAWL_READ_TELEMETRY_MODE=go`；签名有效、orgId 匹配且资产 provider 为 s3，有合法 storageKey/存储配置，Go 仍返回 404。任务详情返回的媒体 URL 可能因此失效。
- Nest（原核对基线 `3cedce9a` 历史源码）：[CrawlMediaAssetService.getAssetDeliveryPayload](https://github.com/wei500L/newwei/blob/3cedce9aa3200436aba3596f63b559de5490cec8/apps/api/src/modules/crawl/crawl-media-asset.service.ts) 433–520，MySQL blob 与 S3 分支分开，S3 调 storage.createObjectReadUrl，附 content-type/disposition/cache-control；[controller](https://github.com/wei500L/newwei/blob/3cedce9aa3200436aba3596f63b559de5490cec8/apps/api/src/modules/crawl/crawl-media-asset.controller.ts) 对 redirectUrl 重定向。
- Go：[service_media.go](../../../apps/api-go/internal/crawlreadtelemetry/service_media.go) `getAssetDeliveryPayload` 456–515，MySQL joined blob/legacy blob 已实现；非 MySQL 末尾固定 `(nil,nil)`。`serveMediaAsset` 151 将 nil 映射为 404，虽有 RedirectURL 分支却没有 S3 生产者。核对 SHA 如页首。
- 主要文件：crawlreadtelemetry/service_media.go、模型/构造与 `cmd/api/crawl_read_telemetry.go`；读取存储配置/解密可能涉及 infrastructuresettings/storage.go，当前该包只提供配置管理，不能当现成 S3 对象客户端。S3/Nest StorageService 是外部对象边界；不需要迁 crawl worker 才可补读。
- 前置/冲突：明确 S3 配置优先级、endpoint/path-style/publicBaseURL/TTL 与租户签名；BL-03 与 BL-15 的存储配置辅助函数串行。原 #50 已 merged，未迁的是剩余 S3 分支，不重新分配整个 7 路批次。
- 同因缺口（规划期复核确认）：`service_media.go`/`buildStoredMediaAsset` 对非 mysql 直接返回、未生成 preview/download URL；它由 REST 详情及 `settingscrawl` 独立构造的 `Query crawlTask` 共同消费，只修下发路由不能闭环。
- 状态：2026-10-18 已实现，[STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md)（pr_open）交付于 `refactor/go-storage-media`（[Ready PR #73](https://github.com/wei500L/newwei/pull/73)）；PR **未合 main**，本缺口**仍开放**。已交付：媒体路由 S3 presigned 302（按记录自身 storageKey，签名 content-type/disposition/cache-control，配置不完整返回 400）、REST 详情与 `Query crawlTask` 两处注入并各自签名 preview/download、按存储配置 TTL 且修正 env TTL 回退；GAP 同时覆盖详情两处构造。关闭证据：需实际合入 main 的提交 + 该 head 的普通 CI success，以及实桶/MinIO 真实签名下载验证；当前只有 PR/静态契约测试，实桶未执行。

2026-10-21 复核（`dcbe563b`）：**已关闭**。`apps/api-go/internal/crawlreadtelemetry/service_media.go:478-540` 的 `resolveDelivery` 按记录自身 storageKey 调 `CreateObjectReadURL` 生成 presigned URL，handler 于 `:151-153` 返回 302；REST 详情与 `Query crawlTask` 两处构造共用 `attachStoredS3URLs`（`:605-646`）；GraphQL 侧存储配置在 `apps/api-go/cmd/api/main.go:2273-2279` 注入 settingscrawl（注释说明 crawlTask 自建 read service 必须注入，否则 S3 URL 为空）。STORAGE-MEDIA-001 经 #77 合入（#73 → `f4ac4aa807b6`）。实桶/MinIO 下载未验证。

<a id="gap-legacy-001"></a>

## GAP-LEGACY-001 · 尚无 Go 接管的契约入口

2026-10-19来源子链限定增量（main91e759b4）：GET /api/news-aggregator/source、POST /api/news-aggregator/sources/batch完整范围由[NEWSNOW-SOURCES-001](tasks/NEWSNOW-SOURCES-001.md) reserved，当前仍Nest，Go未实施。包含64来源ID的实际上游/凭据/缓存/必要实时接缝，不把它们当64HTTP。推荐/热点分析与后台预热不认领，不关闭本跨域GAP。审计#92仍开放、未合main；与此子链无核心业务交集。

- 精确范围的唯一事实源：18 个域页的 HTTP/root 表。**2026-10-21 更新（`dcbe563b`）**：未被 Go 注册的契约入口只剩 5 条 C 类 HTTP（`GET /api/healthz/live` 仅 shadow 无开关、`POST /api/admin/crawl-frontier/runs`、`POST /api/admin/crawl-frontier/nodes/retry`、`POST /api/admin/crawl-frontier/nodes/:id/retry`、`GET /api/system-settings/vector-service/diagnostics`），Query/Mutation/Subscription 未注册数均为 0；与 365/370、77/77、57/57、4/4 的接管口径相容。逐条证据与处理选项见 [ownership-audit](../cutover/ownership-audit.md)。阶段 6 停 Nest 前必须处理 `healthz/live` 探针，见切流手册。
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

2026-10-21 复核（`dcbe563b`）：**未关闭，范围已缩小**。按本批 T1 审计：BullMQ 15 个队列名中 14 个有 Go 消费者（11 个 worker 开关，go 时 Nest 在创建 Worker 前返回）、21 个 `@Cron/@Interval` 全部有 Go 实现与共享租约、Socket.IO 6/6 namespace 有 Go 路径与开关、12 个 Nest 实际订阅频道均为兼容桥/共享总线。仍属 Nest 独占或未闭环的部分：`itemPipelineDlq` 无消费者（只能靠 Bull Board 人工处理，属运维入口缺口）、告警规则级 repeatable 全量对账只在 Nest（`alerts.service.ts:1284-1301`）、QueueEvents 派生的 Nest 读侧职责（`QueueOrgStatsTracker`、`QueueEventPublisher`、`CrawlQueueEventPublisher`、告警 metric providers）没有独立 Go 开关、`situation-monitor:telegram-clear:v1` 订阅无模式门。加上未做运行时/部署/外部服务验证，本 ID 不关闭；逐条桥的停用条件与残留清单见 [ownership-audit](../cutover/ownership-audit.md)。

## 观察项与缺少验证（不计入已确认业务缺口）

- **OBS-DATA-001**：[main.go](../../../apps/api-go/cmd/api/main.go) 1245 空错误分支确实吞掉 `wireDataRuntimeSettings` 错误。当前 helper 仅在 go 且 db/redis/auth 为 nil 时返回错误；`config.Load` 要求 JWT/MySQL/Redis，main 的无效 DSN 阻断列表和 `needsCredentialedGo` 都含 dataRuntimeSettingsGo，先行完成这些资源装配。因此本轮未确认合法当前启动路径能触发它；不能写成“九路必然不可用”。若以后可触发，run 会继续，已选 ModeGo 却无 handler 的请求在 Gateway.ServeHTTPWithShadow 返回 **501**，不会自动回 Nest。跟踪候选 BL-01，需先证明可达路径/或说明仅错误传播修正，不改业务。
- **VERIFY-EXT-001**：真实 SMTP、模型、S3、crawl4ai、Nominatim/OpenSky、Telegram/Oref、AkShare 未在本轮调用。源码中有客户端不等于实网已通；正常外部错误/配置未设不自动登记 bug。
- **VERIFY-CONTRACT-001**：未逐字段复验所有 DTO/返回投影、跨进程缓存 TTL、事务竞争、全部游标/筛选边界，范围按 [AUDIT](AUDIT.md) 各组列明。静态阅读不是运行验收。
- **VERIFY-DEPLOY-001**：部署值、Web/vector 真实流量、生产启用与回滚均未核实。只读 Compose 源码，不读取真实 .env 或秘密。
