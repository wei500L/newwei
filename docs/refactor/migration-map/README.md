# 后端迁移地图

**当前状态摘要（基线 `dcbe563b`，2026-10-21）**

- 基线：`origin/main = dcbe563b917f`（#136 整合 #133–#135）；上一版地图基线的 `91e759b4` 已成历史，见 [HISTORY.md](HISTORY.md)。
- 开放 PR：无（`gh pr list --state open` 为空）。
- 基线普通 CI：[run 39625284282](https://github.com/wei500L/newwei/actions/runs/39625284282) 在精确 head `dcbe563b917f` 上 `conclusion=success`（`verify` / `vector-integration` / `api-go-user-settings-integration` 均 success，两个 regen job skipped——skipped 不算通过）。CI 只证明该 SHA 的既有检查通过，不证明部署或实网。
- 注册覆盖：HTTP **365/370**、Query **77/77**、Mutation **57/57**、Subscription **4/4**、BullMQ worker **14/15** 队列（11 个开关）、Cron/Interval **21/21**、Socket.IO **6/6** namespace。
- 分类：HTTP A=365、B=0、C=5；GraphQL C=0；异步面 15 个队列名中 `itemPipelineDlq` 无消费者（C）。
- **这是注册覆盖，不是部署启用**：130 个 `API_GO_*` 开关默认仍是 `legacy`（个别历史开关为空串/`shadow`，见口径 1），`apps/web` 默认仍指向 NestJS，`api-go` 仍在 compose 的 `api-go-pilot` profile；真实部署、生产流量与实网调用均未核实。
- 细节：口径与分域见下方[注册覆盖](#注册覆盖)；审计见[执行权审计](../cutover/ownership-audit.md)，130 开关逐项见[开关矩阵](../cutover/switch-matrix.md)，阶段与回退见[切流手册](../cutover/runbook.md)。

历史增量快照见 [HISTORY.md](HISTORY.md)

先读本页 → [PLANNING](PLANNING.md) → [当前任务](tasks/README.md) + [缺口摘要](GAPS.md#当前摘要) → [候选队列](BACKLOG.md) → 候选域与源码。[实现核对深度](AUDIT.md)、[开关/执行所有权/复用入口](DEPENDENCIES.md)、[证据](EVIDENCE.md)按需展开。Nest 暂时保留。

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
