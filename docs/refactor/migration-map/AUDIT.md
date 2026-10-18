# 注册以外的实现核对

[入口](README.md) · [缺口](GAPS.md) · [开关/执行依赖/复用](DEPENDENCIES.md)。本页按共享实现保存核对深度；精确入口与权限不另抄，仍以域页为唯一清单。

## 本轮结论与口径

2026-10-18 14:37–14:42 MSK：以 `origin/main 3cedce9aa3200436aba3596f63b559de5490cec8` 静态核对；地图 worktree 的 apps/api、apps/api-go、apps/vector-go 与该 SHA 无差异。18 域/42 Nest 目录归属、370 HTTP、77/57/4 roots 与源码/契约快照重新做集合核对。71 个 Go Query、21 个 Mutation 与生产 Register 声明、main 调用交叉核对，HTTP 274 为生产规则的接管覆盖口径。

相对首版 14:18 基线：**分母变化 0、main 注册变化 0、业务实现变化 0**。修正三处 #67 历史证据 URL、工作台任务 PR 状态和候选筛选规则；新增 S3 缺失分支的确认，是发现原有实现深度事实，不能记为新业务迁移。已确认的两个部分实现入口是 newsEventBrief、采集媒体 S3 分支；设置 13 写另有一条公共接线根因。不能用注册总数减掉这些入口得到“已完整迁移数”，其他范围尚未逐字段验完。

| 维度 | 如何读本地图 |
|---|---|
| 注册 | 域表 Go/生产 Register 只证明指定开关路径有声明；Nest 行无 Go 接管。shadow live 不计接管 |
| 实现 | Go 部分实现 / Go 实现已静态核对（限下列分支）/ 尚未深入核对 / Nest 执行，四者独立 |
| 接线 | [HTTP 资源分组](DEPENDENCIES.md#开关与资源装配) 与 [GraphQL 组合](modules/graphql-runtime.md#本轮有意义的组合复核)；启动校验不等于初始化，更不等于部署 |
| 合并 | 域页保存实际 merge 提交；#68 merged；#70 pr_open 的 8 写不计入 main。原 PR 与 integration 提交都保留真实身份 |
| 验证 | 本页是静态范围；普通 CI 的精确 head/job 覆盖只在 [EVIDENCE](EVIDENCE.md) 保存；未运行本地测试、服务或外部调用 |
| 启用 | config 默认、Compose 可见值在域页/运行时页；真实部署与生产流量未核实。legacy 默认不否认源码已实现 |

下面每节是本轮审查组，时间/SHA 使用页首基线。对仅做注册/装配复核的组，实施状态仍为“尚未深入核对”，不以“未发现问题”替代完成。早期域页 13:51/14:18 时间仍是历史扫描时间，没有统一改成全量深审日期。

## identity

- **组织八写 / Go 静态核对的范围**：[orgaccesswrite/register.go](../../../apps/api-go/internal/graphqlread/orgaccesswrite/register.go) → rbac.go/members.go → rbacapi 的具名 View 入口与 workspace 返回模型，复核权限元数据、orgId 参数传递和独立写模型分支。createOrg/updateOrg/setOrgActive 的全事务/审计/缓存路径、RBAC 底层竞争与逐 DTO 语义尚未深入核对，不能据适配器存在判断完整。
- **账户、MFA/OIDC、RBAC HTTP 和身份七读 / 尚未深入核对**：生产 main/wire 与 workspace.Register 已对齐；仍须深入 accountsecurity 的 logout/refresh 黑名单交互、authfactors 密钥/挑战有效期、rbacapi 角色关联事务、workspace.users/memberships 的排序/分页/字段投影。登录/验证码/refresh/OIDC 登录及邀请审批仍为 Nest，已认证 MFA 管理不覆盖这些入口。

## personal

- **公共门户故事 / Go 实现已静态核对（冷路径限定）**：[publicportal/story.go](../../../apps/api-go/internal/publicportal/story.go) `Service.brief`：无来源合法 nil、指纹命中、miss 调 completer.Complete、JSON 清洗、metadata 合并和 SaveEventMetadata；写回失败保留生成响应。gateway.go 有真实 HTTP 客户端，未实网验证。此实现不能关闭 GAP-NEWS-001；helper 私有且组织/语言参数不同。
- **其余门户、六 UI 读/六写、订阅目录/行为/digest / 尚未深入核对**：已核 main 的 user-settings 与 wirePersonalNews 装配；未逐键检查 UI normalization、订阅候选召回/排序、行为衰减、digest 组合与跨租户投递。delivery 配置不负责 SMTP 定时发送，见 GAP-ASYNC-001。

## workspace

- **通知两读 / Go 实现已静态核对（SQL 范围）**：[history/notifications.go](../../../apps/api-go/internal/graphqlread/history/notifications.go) `listNotifications/countUnread` 执行 orgId+userId 约束、createdAt 排序、take=0/负 take 反转、未读计数和模型映射；不是固定空列表。Nest NotificationsService 为契约源；未跑 DB/逐 JSON 叶子验证。
- **告警四读、看板/情感/队列读及地图/图表/SSE HTTP / 尚未深入核对**：Registry、模型和 main 资源路径已看，alerts 根确实调用 list/replay/tuning；未逐一复算 replay/tuning 算法、队列 BullMQ Redis 脚本、地理缓存 miss/翻译/OpenSky 组合、SSE 关闭与去重。
- **8 个交互写 / Nest 在 main 执行**：#70 已提交但未合入；不将本地模型拆分计入当前实现。`alertRules` 也不在此任务：Nest AlertsService.listRules 会 ensureDefaultRules，不能只搬 SELECT。详见 BL-10。

## items

- **REST List / Go 实现已静态核对（调度与分页分支）**：[itemsreading/service.go](../../../apps/api-go/internal/itemsreading/service.go) `Service.List`：NormalizePagination→ParseSearchPayload→ResolveScopedIDs；受限集合为空时返回合法空；read-model Mongo / MySQL 两种 List+Count 分支均执行 order/offset/pageSize。底层 ES/vector/词法召回分数、全部筛选语法尚未逐项复算。
- **GraphQL item / Go 静态核对的范围**：[graphqlread/itemsreading/register.go](../../../apps/api-go/internal/graphqlread/itemsreading/register.go) 绑定 orgId，查不到合法 null；有 read-model 与 MySQL/Mongo 回退投影；workspace 未注册时补共享 ProcessedItem 嵌套类型。其余 facets/RSS/status/suggestions、processedItemById、原文/预览/事件链接/遥测尚未深入核对逐字段与缓存失效。
- **重建后台 / Go 实现已静态核对（生命周期）**：[searchreindex/service.go](../../../apps/api-go/internal/searchreindex/service.go) startReindex→Redis queued→goroutine runReindex→分页 Mongo→bulkIndex→refresh→完成/失败；ES 关闭时 indexed=0 是合法禁用分支。重启不自动重排队，不能当 BullMQ worker 已迁；未验证锁续租/故障竞争。

## analysis

- **协作 23 HTTP / 部分分支静态核对，整体尚未深入核对**：[cmd/api/analysis.go](../../../apps/api-go/cmd/api/analysis.go) 三独立模式与 handler；[analysisboards/service.go](../../../apps/api-go/internal/analysisboards/service.go) List/Get→ensureDefaultBoard→组织锁事务内二次检查/创建默认列，确认读可能写。其余列/任务移动重排、评论归属/计数、删除关联清理及版本并发尚未逐路径验完。
- **analysisResults / Go 实现已静态核对（读取）**：history/register.go→runs.go findRuns，按 orgId/createdAt/limit 查询 Mongo analysisresults，映射 input/output/status；更新这些记录的 submit/process/worker 仍由 Nest 执行。三个 CSV 导出与三个 request root 未迁。

## news

- **newsEventBrief / Go 部分实现**：命中、无事件/无来源、miss、forceRefresh 已沿两端服务核对，后两支固定错误；[GAP-NEWS-001](GAPS.md#gap-news-001) 为唯一缺口记录。
- **其余事件/分组、指标读写、NewsNow 本地计算与聚类运维 / 尚未深入核对**：已核各 Register/main 和 newsnowclusteringops.NewService 真实构造排序器，nil ordering 错误不是固定业务占位。尚未逐项比对事件筛选/游标、heat/authority、指标反测、聚类恢复状态与 Redis TTL；后续先读 newsevents/queries 与 newsindicator、newsnowclusteringops 的 service/store。上游读取/推荐、LLM backfill、ingestion/Cron 仍由 Nest。

## knowledge

11 读已注册；本轮核对 knowledgegraph/kgimpact/settingscrawl 返回类型装配与根权限。**业务算法尚未深入核对**：KnowledgeEdge 遍历/剪枝、置信度阈值、Redis 命中/失效、Mongo 共现/经济相关计算、证据队列分页与复核副作用。需读 graphqlread/{knowledgegraph,kgimpact,settingscrawl} 对应 service/store；不能因配置与读已迁推断 ingestion/review 写已迁。

## crawl

- **媒体下发 / Go 部分实现**：HMAC、orgId SQL、joined/legacy MySQL blob、响应头/重定向消费者与 S3 空返回沿 Nest Controller/Service 对照；新增确认 [GAP-CRAWL-001](GAPS.md#gap-crawl-001)。合法“无资产/无 blob”空返回与缺失 S3 实现分开。
- **来源/模板/画像/工作流/Frontier 与采集读 / 尚未深入核对**：注册、wire 和 config 依赖已复核；未逐项走更新合并/校验、Frontier cancel 事务/租约、task/results/media DTO、Mongo 内容与 telemetry 计数，不能泛称完整 CRUD。metadata 是主动 HTTP/robots/sitemap/crawl4ai 发现，Nest 服务入口已定位；create/retry/delete/ingest 与 worker 另分候选。

## situation

**信号缓存读的所有权已静态核对，其他业务尚未深入核对**：[situationsignals/oref.go](../../../apps/api-go/internal/situationsignals/oref.go) loadCachedOrefState 读取两份 Redis 文档；miss 合法空数组/计数，不发起 Oref 轮询。telegram/refreshrun 也围绕已有缓存；不能把缓存无新内容误报“生成器缺陷”。尚须逐字段核对 monitor 匹配、scope/时间/地理筛选、feedback Mongo 学习状态、Telegram channelSet 与 refresh-run 租户校验。polling/insights/refresh/geo 与授权为 Nest。

## settings

- **13 写 / Go 业务实现已静态核对（共享主路径）；接线有缺口**：SettingsResolver/DTO/被调用服务→settingswrite.Register→typed resolver→service.go/orgsettings.go/newssettings.go→SystemSetting upsert、共享 normalizer、Redis 与审计/outbox→settingscrawl 模型。核过限流三桶事务、组织键与可选字段合并、taxonomy/dedupe 规范化调用；尚未逐字段核对所有输入约束/默认值/异常文字、TTL 和多进程竞争。GAP-GQL-001 不代表这些已合并业务重新未迁。
- **HTTP 设置治理与20读中本域16读 / 尚未深入核对**：生产接线与资源已核；仍须检查 runtime/platformgovernance 的读写/reset 事务、Mongo TTL index 变更、quota/safety 聚合与缓存失效。规范化配置被 Nest pipeline 使用，不意味着 pipeline 运行器已迁。

## model-gateway

配置/密钥/profile/激活/LB 21 HTTP 的 main/wire/config 已核，实际 CRUD、加密失败/轮换、平台权限、内部 token、applied 快照和缓存边界**尚未深入核对**。读 llmgatewayprofiles / modelaccesssettings 对应 service；真实探测与 proxy-governance 12 HTTP 尚为 Nest。LiteLLM 配置下发不等于 LiteLLM 已应用，也不等于业务调用已切 Go。

## infrastructure-data

**接线已静态核对；9 数据设置和7基础设施组的业务归一化/加解密尚未深入核对**：main 的资源 OR、wireDataRuntimeSettings 创建 handler 与错误返回范围已核，OBS-DATA-001 记录吞错但当前合法路径未证实可触发。archive_status 读取 Redis 派生索引，不是 producer/consumer。未逐项验 storage/vector/nominatim/realtime 配置优先级、清空密钥语义、会话锁、归档状态分页/索引清理；读取 settings 不能当 S3 对象客户端可复用。

## observability

adminlogs/llmlogs/qualityoverview/classificationrssops/exceptioningest 与认证 health 的生产注册和 Mongo 初始化已核；**持久化与全部错误分支尚未深入核对**。具体待查：日志 cursor/date/脱敏、导出审计、异常 ingress 限流/TTL、质量图表、RSS 规则重写；HTTP metrics/pipeline recovery/report producer 仍为 Nest。不能由文本中 unavailable 一词推断占位。

## assistant

**三读的读取所有权已静态核对，完整模型执行尚未迁**：history/register.go→runs.go（Mongo `assistantruns`）、capabilities/series 入口与 MySQL 依赖；list 使用 orgId+limit+createdAt，合法空历史不是占位。capabilities 的 provider 配置合并、经济建议排序/中文归一化未深入验；request*/delete 与 worker/工具/流式发布均 Nest。

## economic

**Go 六读已静态核对（分页主路径）**：economic/register.go→query.go load/queryPoints/pagePoints，执行 category/time 过滤、timestamp+id ASC 游标、limit+1、粒度 bucket 分支；有粒度时不使用原始分页，是源码设计，未据此立 bug。SQL 读取全局经济数据，不能擅加 orgId。insights 数值/时区粒度与 Nest 全参数组合尚未逐算法复算。三调度写、AkShare 管理与 repeat/consumer 为 Nest。

## archive

**Go 状态入口资源/读取边界已核，业务准备仍 Nest**：Digest/Calendar 调 ensureDigestCoverage/ensureCalendarCoverage，processor 读取设置、分批 classifyRowsBatch、更新 processing/partial/ready/failed。只迁 Query SELECT 会漏必要准备。detail 的分类/翻译/显示资格、搜索/补偿链尚未深入核对，见 BL-09；当前没有三个 Query 的 Go 注册。

## async-runtime

本轮复核 AppModule 的 SCHEDULE_ENABLED/Bull Board 条件、已列 worker/调度入口、analysis/assistant/archive 的 submit/process/状态推进。**未深入核对所有 job payload、重试/租约、Outbox 幂等和实时拓扑**；具体文件继续用异步域既有清单。Go reindex goroutine/SSE 不等于 BullMQ/Subscription executor 已迁；配置写与结果查询不自动改变执行所有权。

## vector

三条独立 HTTP 的注册/现有 Qdrant CI 边界复核，**本轮没有逐行重审 upsert/search 的全部过滤/序列化**。源码已有直连 Qdrant 的实现，不能因上游部署未知标为“未实现”；实际 VECTOR_SERVICE_BASE_URL/数据库覆盖值/生产请求去向仍未核实，见 BL-22。既有 Qdrant 差分 CI 覆盖与部署分别记录。
