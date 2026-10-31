# 后端迁移地图

## 2026-11-01 下一批：两个现存功能缺口

最终 main `e04fc4d8` 的[普通 CI 41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081) 已完成：verify、vector-integration、api-go-user-settings-integration 均 success，两个 regen skipped。用户要求继续提示词，本轮核对实际源码后预留两条完整功能链，可分两个编码窗口执行：

- [CRAWL-TABLE-NORMALIZATION-001](tasks/CRAWL-TABLE-NORMALIZATION-001.md)：采集表格归一化、保存、REST/GraphQL 读取与详情 UI；[执行提示词](tasks/CRAWL-TABLE-NORMALIZATION-001.prompt.md)。
- [MONITOR-GEOCODING-001](tasks/MONITOR-GEOCODING-001.md)：监控 preview/create/update 接入系统配置、共享缓存与限速，贯通现有 UI；[执行提示词](tasks/MONITOR-GEOCODING-001.prompt.md)。

两项均 reserved，尚无编码 PR/head/CI；文件所有权见 task 与[索引](tasks/README.md)。共享 main/CI 的本轮必要增量只归地理编码任务，表格任务使用既有采集 CI。不重派迁移退役，不新增部署或 Node 工具 Go 化任务；规划 PR #149 发布本轮文档。

## 2026-11-01 收口：三项退役任务均已合入

- 最新源码基线 `e04fc4d8bb54596afd302a309ebc852c7676d958`：#152 契约/工具迁出、#153 Go 独立运行、#154 三个 Node 后端删除均 merged，源 head 已逐个核实 main 祖先关系；各源普通 CI 三主要 job success。完整 SHA、run 与验证边界见 [收口记录](GO-MIGRATION-CLOSEOUT.md)。
- main 已无 `apps/api` / `apps/vector` / `apps/ais-relay` 和 shadow/canary 实现；`legacyproxy` 只是保留旧包名的纯 Go 路由器，不再向 Nest 转发。默认开发/编排/构建/CI 已使用 Go；Prisma/seed、Web 与必要 Node 工具按原范围保留。
- 最新 main [普通 CI 41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081) 已完成，精确 merge head `e04fc4d8` 三主要 job success，两个 regen skipped；源码退役与该 merge head 的 CI 分别有证据，未部署/实网验证。
- 原三份提示词已完成，不再重复派发或按下方 reserved/planned 快照占用。GAP-EXCEPTION-WIRING-001 残留和真实多实例/外部验证边界继续保留；没有部署、真实流量或实网验证。
- 本次只回填已核事实，不重算全域覆盖、不全文重审业务。规划 PR #149 发布本记录；下方旧日期/统计/默认/任务状态均为历史快照。

## 2026-10-31 #151 合并后：默认 Go 已落地，进入退役三步

- 最新核对 main：`fcf1e5334acb0350ea36535c48c4131df7c9698a`，[#151](https://github.com/wei500L/newwei/pull/151) 已实际 merged，包含后续本地配置修补；源 head `e48a25725603e2d7a02088b696599dbf28b0131b` 已验证为 main 祖先。[源 head 普通 CI 41199618477](https://github.com/wei500L/newwei/actions/runs/41199618477) 三主要 job success；[merge CI 41200907795](https://github.com/wei500L/newwei/actions/runs/41200907795) 在核对时尚未完成，skipped 不算通过。
- 仓库默认已是 Go：根示例 API 4020、新 Socket.IO 路径，137 个迁移 mode 为 go/reject；本地 `dev.mts` 读取根环境并按进程配置端口；compose 默认 Go 服务。Node 后端和显式 legacy 回退仍保留，尚未进入源码删除；没有部署或真实流量/外部服务验证。
- [GO-DEFAULT-CUTOVER-001](tasks/GO-DEFAULT-CUTOVER-001.md) 按实际 merge 标 `merged`，原跟进提示词已完成，不再重复派。GAP-DEV-CONFIG-001 的已派缺口按源码修补关闭，异常事件残留另记，不能因此统一关闭全部 GAP。
- 退役分三步**串行**：[契约/工具迁出](tasks/GO-CONTRACT-TOOLING-001.md) reserved（[提示词](tasks/GO-CONTRACT-TOOLING-001.prompt.md)）；[Go 去迁移分流](tasks/GO-ONLY-RUNTIME-001.md) planned（[提示词](tasks/GO-ONLY-RUNTIME-001.prompt.md)）；[删 Node 与 CI 收尾](tasks/GO-NODE-RETIRE-001.md) planned（[提示词](tasks/GO-NODE-RETIRE-001.prompt.md)）。后两项提示词预先提供，必须等各自前置实际合入与 CI，不能并开共享文件。
- 本次只核默认补修与退役依赖，不重算覆盖数、不全文重审领域；规划发布仍用 PR #149，只维护文档，不直接实施退役业务。下方各时间段按历史快照理解。

## 2026-10-31 完成核对与继续提示词

- main 已核实为 `385c887e8cda2df6a3fadd2109c6641ae62cb6ee`（[#150](https://github.com/wei500L/newwei/pull/150) 实际 merge）；前置修补主体已合入。源 head `4f21c025` 的普通 CI 40551203359 三主要 job success；main CI 40557202479 失败在队列运维 Web 测试、两个集成 success，不能称 main 全绿。
- 默认切 Go [#151](https://github.com/wei500L/newwei/pull/151) 仍 OPEN/Ready，head `b97e181aa7248175ed3c91daf9a258dba6289f96`，[普通 CI 40576119903](https://github.com/wei500L/newwei/actions/runs/40576119903) 三主要 job success、两个 regen skipped。当前 main 默认尚未切 Go；#151 的实现不能提前算入 main。
- 已确认本地开发示例与新默认不一致，见 [GAP-DEV-CONFIG-001](GAPS.md#2026-10-31-完成核对与本地默认链缺口)。[继续提示词](tasks/GO-DEFAULT-CUTOVER-001.followup.prompt.md) 已发出：在原 worktree 更新 #151，补根示例、Go 环境来源、端口与 dev:legacy；不新开重复任务，不直接实施业务。
- #150 异常记录仍有自写 500/unknown/stack 残留，不重新派四项整批，也不伪称异常覆盖完整。删除 Node 后端、双轨结构与迁移契约/CI 继续等 #151 补齐并合入后再派。
- 本次只核相关增量与配置链，不重算全域注册覆盖、不冒充全文复审；不部署、不连接真实服务，未修改真实 `.env`。

## 2026-10-27 增量与下一批

- 本次只核对 `origin/main = f15f598d4358b4c9823054ef5a355618e1480a4e` 的合并、下一批相关源码与默认链，未重建全域覆盖数，也未全文重审五域。下方 `dcbe563b` 统计保留为历史快照。
- [#148](https://github.com/wei500L/newwei/pull/148) 实际 merge `0a48babea69700c7f9cd1bf2262f25d414469527` 已包含 #142–#147（五域审查修复 + AIS relay Go）；六个源 head 均已验证为 main 祖先。当前无开放 PR（本规划发布前快照），不再派整合任务。main 后续三次提交为新增/扩充 self-hosted smoke，以及把既有 workflow 的 runs-on 切到自托管 runner，未改相关业务源码。
- 整合 head `79220a477cc8dad7df387fa67442c3bcd5d6a49e` 的[普通 CI](https://github.com/wei500L/newwei/actions/runs/40513400923) attempt 2 三个主要 job success，两个 regen skipped。最新 main 的[普通 CI](https://github.com/wei500L/newwei/actions/runs/40518886959) 在 2026-10-27 17:21 MSK 交付复核时 **cancelled**（verify failure、vector-integration success、api-go-user-settings-integration cancelled）；原因未证实，下一编码窗口先查精确 head/job。上一 head `cc3782c0` 的 run 40518448341 亦 cancelled，Self-hosted Smoke success 不代替普通 CI。不得把其他 head 的结果算作最新 main 通过。
- **下一步先补四项，再改默认**：[GO-CUTOVER-PREREQS-001](tasks/GO-CUTOVER-PREREQS-001.md) 已 reserved，含安全头、三类指标的生产接线、REST/GraphQL 异常事件、`POST /api/items` 请求体契约；[提示词](tasks/GO-CUTOVER-PREREQS-001.prompt.md)。四项根因见 [GAPS](GAPS.md#2026-10-27-切默认前增量)。不是重迁队列/DLQ/NewsNow/brief/outbox。
- 后继 [GO-DEFAULT-CUTOVER-001](tasks/GO-DEFAULT-CUTOVER-001.md) planned，[提示词](tasks/GO-DEFAULT-CUTOVER-001.prompt.md) 已备好，须等前置合入与 CI 后再执行：config + Web + 三项 Go 服务 + migration/index 工具职责 + 显式 legacy 回退作为一条链完成。两任务串行，不并开抢共享接线。
- 当前默认仍指 Nest / Node vector / Node AIS；本规划没有修改默认或业务代码。目标为仓库默认转 Go，保留 Node 回退代码，后续再删；**只做静态审查与普通 CI，不部署、不连接真实外部服务**。Prisma/seed 可继续作为 Node 工具，不能声称工具链已全 Go。

**历史状态摘要（基线 `dcbe563b`，2026-10-21；现行增量以上方为准）**

- 基线：`origin/main = dcbe563b917f`（#136 整合 #133–#135）；上一版地图基线的 `91e759b4` 已成历史，见 [HISTORY.md](HISTORY.md)。
- 开放 PR：无（`gh pr list --state open` 为空）。
- 基线普通 CI：[run 39625284282](https://github.com/wei500L/newwei/actions/runs/39625284282) 在精确 head `dcbe563b917f` 上 `conclusion=success`（`verify` / `vector-integration` / `api-go-user-settings-integration` 均 success，两个 regen job skipped——skipped 不算通过）。CI 只证明该 SHA 的既有检查通过，不证明部署或实网。
- 注册覆盖：HTTP **365/370**、Query **77/77**、Mutation **57/57**、Subscription **4/4**、BullMQ worker **14/15** 队列（11 个开关）、Cron/Interval **21/21**、Socket.IO **6/6** namespace。
- 分类：HTTP A=365、B=0、C=5；GraphQL C=0；异步面 15 个队列名中 `itemPipelineDlq` 无消费者（C）。
- **这是注册覆盖，不是部署启用**：130 个 `API_GO_*` 开关默认仍是 `legacy`（个别历史开关为空串/`shadow`，见口径 1），`apps/web` 默认仍指向 NestJS，`api-go` 仍在 compose 的 `api-go-pilot` profile；真实部署、生产流量与实网调用均未核实。
- 细节：口径与分域见下方[注册覆盖](#注册覆盖)；审计见[执行权审计](../cutover/ownership-audit.md)，130 开关逐项见[开关矩阵](../cutover/switch-matrix.md)，阶段与回退见[切流手册](../cutover/runbook.md)。

历史增量快照见 [HISTORY.md](HISTORY.md)

先读本页 → [PLANNING](PLANNING.md) → [当前任务](tasks/README.md) + [缺口摘要](GAPS.md#当前摘要) → [候选队列](BACKLOG.md) → 候选域与源码。[实现核对深度](AUDIT.md)、[开关/执行所有权/复用入口](DEPENDENCIES.md)、[证据](EVIDENCE.md)按需展开。Nest 暂时保留。


> **增量（GO-ONLY-RUNTIME-001，2026-10-31，分支 `codex/go-only-runtime`）**：`apps/api-go` 已移除 legacy/shadow/canary 反向代理、迁移 `API_GO_*_MODE` 开关与 GraphQL 整包 operation 回退，改为纯 Go 路由（`legacyproxy.AllRoutes()` + 命中 handler，未命中 Nest 等价 404）；删除 `internal/{canary,shadow,shadowidentity}` 与迁移指标；保留 `SCHEDULE_ENABLED`/`BULLMQ_WORKERS_ENABLED`/`WS_REDIS_ADAPTER_ENABLED`/`GRAPHQL_SUBSCRIPTION_BUS` 第二道门与资源/鉴权校验。Node 源码与对照 CI 留待第三步。下文覆盖统计为历史口径，不代表本批后的开关状态（已无 mode 开关）。

## 注册覆盖

HTTP/Query/Mutation 为“生产 Go 接管注册 / Nest 契约入口”，不是功能完成率或启用比例；`—` 为无此类主 API 入口。HTTP 以 METHOD+完整路径去重（全局前缀 `/api` 已拼入），SSE 算一条；四订阅与传输见域页。vector-go 三条独立 HTTP 不并入主 API 分母。

分子为按 `dcbe563b` 源码复算的 A 类（存在 `API_GO_*` 开关且规则/处理器就位）；分母沿用本表既有口径（与 T1 审计的 370/77/57/4 总数一致）。C 类 5 条 HTTP 单列在表下，不计入任何模块分子。

| 模块 ID | 产品域 | HTTP | Query | Mutation | 队列与外部依赖 | 详情 |
|---|---|---|---|---|---|---|
| `identity` | 身份、组织与访问控制 | 51/51 | 7/7 | 8/8 | 邮件/OIDC；会话缓存 | [详情](modules/identity.md) |
| `personal` | 个人设置、阅读工作台与公共门户 | 31/31 | — | — | 邮件 Cron；模型冷路径 | [详情](modules/personal.md) |
| `workspace` | 通知、看板与告警交互 | 13/13 | 11/11 | 11/11 | 告警 worker；Nominatim/OpenSky | [详情](modules/workspace.md) |
| `items` | 条目检索、RSS 阅读与处理结果 | 7/7 | 7/7 | 4/4 | 索引后台任务；ES/vector | [详情](modules/items.md) |
| `analysis` | 分析协作工作区与导出 | 26/26 | 1/1 | 3/3 | analysis 队列/导出 | [详情](modules/analysis.md) |
| `news` | 新闻事件、指标、聚类与内容流水线 | 17/17 | 9/9 | 1/1 | 流水线/聚类恢复/模型 | [详情](modules/news.md) |
| `knowledge` | 知识图谱、实体情报与影响传播 | — | 11/11 | 1/1 | ingestion Cron/证据 | [详情](modules/knowledge.md) |
| `crawl` | 采集源、模板、画像、工作流与 Frontier | 65/68 | 3/3 | 5/5 | crawl4ai/Frontier/BullMQ | [详情](modules/crawl.md) |
| `situation` | 态势监控、地理与实时信号 | 16/16 | — | — | Telegram/Oref/AIS/刷新 | [详情](modules/situation.md) |
| `settings` | 设置中心与平台治理 | 43/43 | 16/16 | 17/17 | 共享设置缓存/SMTP | [详情](modules/settings.md) |
| `model-gateway` | 模型接入、密钥与 LLM 网关 | 33/33 | — | — | LiteLLM/密钥下发 | [详情](modules/model-gateway.md) |
| `infrastructure-data` | 基础设施、采集凭据与数据运行 | 24/25 | — | — | S3/vector/归档/地理 | [详情](modules/infrastructure-data.md) |
| `observability` | 日志、异常、质量、遥测与运维 | 31/32 | — | — | 分类报告/恢复队列 | [详情](modules/observability.md) |
| `assistant` | Assistant 与模型任务 | — | 3/3 | 4/4 | assistant worker/模型 | [详情](modules/assistant.md) |
| `economic` | 经济数据与 AkShare | 3/3 | 6/6 | 3/3 | AkShare/repeat job | [详情](modules/economic.md) |
| `archive` | 归档阅读与准备任务 | 1/1 | 3/3 | — | 准备任务/模型 | [详情](modules/archive.md) |
| `async-runtime` | 队列、调度、Outbox 与实时传输 | 4/4 | — | —（Subscription 4/4） | worker/Cron/Outbox/WS | [详情](modules/async-runtime.md) |
| `vector` | 独立 Go 服务与 vector 上游切换 | — | — | — | 独立 Qdrant 服务 | [详情](modules/vector.md) |

合计 **370 HTTP / 77 Query / 57 Mutation / 4 Subscription**；Go 注册 **365 / 77 / 57 / 4**。

**口径与对账**

1. **注册 ≠ 启用**：A 类只表示“存在 `API_GO_*` 开关，且 Go 侧规则/handler/Register 已就位”；开关默认仍为 `legacy`（`API_GO_USER_SETTINGS_READ_MODE` 默认为空=兼容、`API_GO_ONBOARDING_MODE` 默认 `shadow`），部署值与真实流量未核实。
2. **A 类判定**以本批 T1 审计为准，逐条证据见[执行权审计](../cutover/ownership-audit.md)：HTTP 370 条（A 365 / B 0 / C 5）在 §2，GraphQL 138 根字段（A 138）在 §3，Socket.IO 6 个 namespace（A 6）在 §4，BullMQ/Cron/Redis 订阅在 §5，其它入口在 §6。
3. **C 类 5 条 HTTP（只能由 Nest 提供）**：`GET /api/healthz/live`（规则固定 `shadow`，无开关）、`POST /api/admin/crawl-frontier/runs`、`POST /api/admin/crawl-frontier/nodes/retry`、`POST /api/admin/crawl-frontier/nodes/:id/retry`、`GET /api/system-settings/vector-service/diagnostics`。处理选项见 [执行权审计](../cutover/ownership-audit.md)，不新增 GAP ID。
4. **与 T1 审计的分组差异**：T1 的 15 个审计域按 Nest 控制器目录分组，本表 18 个产品模块按产品归属，两者总数相同（370 / A365）。被本表跨域归属的路线：`GET /api/geo/geocode`（T1 归 items/geo 域，本表归 `situation`）、`GET /api/admin/search-telemetry/summary` 与 `POST /api/search-telemetry`（T1 归 observability，本表归 `items`）、4 条新闻源运维 POST（`/api/admin/news-sources/:id/{cancel-queued,clear-inflight,retry-latest,dispatch}`，T1 归 crawl，本表归 `async-runtime`）、`GET /api/system-settings/realtime-signals/runtime`（T1 归 settings，本表归 `situation`）、`GET /api/admin/archive-preparation/status`（T1 归 settings，本表归 `archive`）、`GET /api/healthz` 与 `GET /api/healthz/live`（T1 单列 health，本表归 `observability`）、3 条 `GET /api/llm-logs*`（T1 单列 llm-logs，本表归 `observability`）。GraphQL 侧同理：`processedItemById` 本表归 `items`、`ingestCrawlTaskResultsToItems`/`updateCrawlTaskIngestToItems` 归 `crawl`、`newsEventSourcePolicySyncStatus` 归 `news`、`knowledgeGraphEvidenceReviewQueue` 归 `knowledge`，其余按 T1 分节。
5. **旧快照对比（Go 注册 274/71/21/0 → 365/77/57/4）**：分母未变（370/77/57/4），增量来自 #92–#136 的注册与接线；公开 live 仍为 shadow，由 Nest 响应，不计 Go 接管。

## 实现与接线缺口

稳定 ID、逐条证据与观察项以 [GAPS.md](GAPS.md) 为唯一事实源；本批以 `dcbe563b` 源码复核后关闭三项，另一项范围缩小但未关闭：

- [GAP-NEWS-001](GAPS.md#gap-news-001)（newsEventBrief 冷生成/强刷）：**已关闭**。`apps/api-go/cmd/api/main.go:2236-2243` 在 BRIEF 子开关为 go 时注入 `publicportal.NewBriefCompleter` 与 `llmlogs.CompletionWriter`；`apps/api-go/internal/graphqlread/newsevents/brief.go:69` 走模型生成、`:81` 经 `:456-482` 的 `JSON_SET(metadata,'$.briefV1',…)` 写回（带 orgId 条件），写回失败仍返回已生成简报（`:82-85`）。
- [GAP-CRAWL-001](GAPS.md#gap-crawl-001)（采集媒体 S3 分支 404）：**已关闭**。`apps/api-go/internal/crawlreadtelemetry/service_media.go:478` `resolveDelivery` 按记录自身 storageKey 签发 presigned 302（`:525`）；REST 详情与 `Query crawlTask` 两处构造共用同一 storage client（`:605-646`）；GraphQL 侧存储配置经 `apps/api-go/cmd/api/main.go:2273-2279` 注入 settingscrawl。
- [GAP-GQL-001](GAPS.md#gap-gql-001)（设置写接线）：**已关闭**。`graphqlRouteMode` OR（`apps/api-go/cmd/api/main.go:891-905`）、`needsCredentialedGo`（`apps/api-go/cmd/api/main.go:1348`）、handler 装配条件（`apps/api-go/cmd/api/main.go:2192-2193`）三处均已含 `GraphQLSettingsWriteMode`；无效 DSN 阻断列表见 `apps/api-go/cmd/api/main.go:1080`；开关校验见 `apps/api-go/internal/config/config.go:4592-4598,6048`。
- [GAP-ASYNC-001](GAPS.md#gap-async-001)（已迁读取背后的 Nest 执行所有权）：**未关闭，范围已大幅缩小**。T1 复核 14/15 队列、21/21 Cron、Socket.IO 6/6 namespace 均有 Go 实现与开关；但 `itemPipelineDlq` 无消费者、告警规则全量 repeatable 对账仍只在 Nest、QueueEvents 派生读侧无独立开关，且未做运行时/部署验证。

GAPS.md 同时按源码关闭了 GAP-ANALYSIS-001 / GAP-ITEMS-001 / GAP-KG-001 / GAP-RSS-001，并把 GAP-LEGACY-001 收窄到 5 条 C 类 HTTP；缺口“已关闭”只表示源码实现/接线已落地，不代表部署、切流或实网验证。新的 C 类缺口指向[执行权审计](../cutover/ownership-audit.md)，不新增 GAP ID。

wireDataRuntimeSettings 吞错已确认；当前合法初始化路径尚未证实可触发，列为 OBS-DATA-001，不能宣称九路必然不可用。

## 当前占用

本批已无开放迁移 PR；历史占用快照见 [HISTORY.md](HISTORY.md)，任务认领与 merged 证据见 [tasks/README.md](tasks/README.md)。

[BACKLOG](BACKLOG.md) 保存未认领队列：先协调 BL-01 公共接线，再补 BL-02 简报/BL-03 S3；随后完整条目查询、来源策略、导出、metadata 与登录主链。归档/采集/告警/分析/Assistant/经济等异步链先明确生产者、消费者与外部边界。候选包含未迁入口、已注册部分实现、接线及必要 Nest 步骤，不只筛 Nest 行。

真实部署、生产流量和实网调用均未核实。源码默认/Compose pilot 与实际启用分别表达；目前不能给出“完整迁移总数”。新对话短启动提示词见 [PLANNING](PLANNING.md#新对话短启动提示词)。
