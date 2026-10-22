# 爬取（crawl）域 Go 对照 Nest 静态审查

## 1. 范围与基线

- 实施基线：`origin/main = dc48abc18c2a5921ace8189db6471c5a3ef0a3c2`（#141，整合 #138–#140）。开工前复核：`gh pr list --state open` 为空；main 普通 CI [run 39664944449](https://github.com/wei500L/newwei/actions/runs/39664944449) `conclusion=success`。
- 分支 / worktree：`review/go-crawl` / `/Users/oo/project/newwei-review-crawl`（从复核后的 `origin/main` 新建）。
- 本窗口范围：Nest `apps/api/src/modules/crawl` 全部（约 5.1 万行）与 `graphql/resolvers/crawl.resolver.ts`；Go 侧 `apps/api-go/internal/{crawl4ai,crawlexecution,crawlworker,crawlqueue,crawlfrontiernode,crawlfrontierllm,crawlfrontierruns,crawlprofile,crawlstrategyruns,crawlworkflow,crawltemplate,crawltaskwrite,crawlmetadata,crawloptions,crawlmaintenance,crawlreadtelemetry,newssources,graphqlread/crawl*}`。
- 不属于本窗口：新闻流水线与条目入库（`itempipeline`、`itemsingest`、`newspipeline`，由「新闻与条目」窗口审查；本窗口只审 crawl 一侧的调用边界）、身份与设置、态势、GraphQL 执行器本身。

**审查是静态的**：本机按约束未安装依赖，未运行 `go build`、`go test`、`pnpm`、Docker 或任何服务，未连接真实 MySQL/Redis/Mongo/crawl4ai/LLM/S3。验证手段只有源码对读、`gofmt -l`、`git diff` 检查；真正的执行验证由现有普通 CI 承担（第 8 节）。

### 结论摘要

| 级别 | 数量 | 已修复 | 只记录 |
|---|---|---|---|
| P0 | 0 | — | — |
| P1 | 4 | 4 | 0 |
| P2 | 21 | 17 | 4 |
| P3 | 44 | 6 | 38 |
| 合计 | 69 | 27 | 42 |

共 21 个修复提交（每个修复或每组同文件修复一个提交）。发现的分布说明：本域的读路径与入口注册在之前批次已较扎实，问题集中在**并发读改写、跨任务的复用查询、共享 SSRF 校验器的 JS 等价性**以及**#139 新增写接口**上；没有任何跨租户读泄漏或鉴权绕过。

## 2. 方法与本批不变式

按 `.workflow/reviews/static-audit.md` 的对抗式复核执行，8 个独立切片并行（互不重叠的 Go 包写作用域），每条结论都要求双侧 `file:line` 并被主动反驳一次后才收录。切片划分：worker/queue/crawl4ai、frontier 节点执行、frontier LLM 与运行生命周期、执行与媒体、元数据/SSRF/选项、工作流/模板/任务写/维护、读接口与 GraphQL 契约、采集源注册表。

本批未修改任何开关默认值、未新增开关；`cmd/api/main.go`、`internal/config/config.go`、Nest、Web、compose 与 `.env.sample` 均未改动；`ci.yml` 未改动（新增测试全部落在既有 job 的选择范围内，见第 8 节）。唯一的跨窗口包改动是 `internal/graphqlread/settingscrawl`（第 4.2 节 LD-02），为最小必要增量。

## 3. 入口清单

下表按 `docs/refactor/cutover/ownership-audit.md` 的 crawl 段逐行给出（该段共 74 行，含 23 条采集源入口；地图把其中 4 条采集源运维入口计入 async-runtime，故 crawl 域自身分母为 68）。深度列的「全文 / 重点 / 未审查」是真实深度，不是抽样冒充全量。

- **全文**：逐个方法读完并双侧对照，包括错误分支。
- **重点**：只读了列出的关键方法与分支。
- **未审查**：没有对读，只从调用关系确认存在。

| Nest 入口 | Nest 源码（Controller） | Go 接管组 / 包 | 开关 | 深度 | 结论 |
|---|---|---|---|---|---|
| `GET /api/admin/crawl-frontier/news-sources/:id/workflow-bridge` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:174`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 重点 | 一致 |
| `GET /api/admin/crawl-frontier/nodes/:id` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:193`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致 |
| `POST /api/admin/crawl-frontier/nodes/:id/retry` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:211`（CrawlFrontierController） | `WithCrawlFrontierWrites` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_WRITES_MODE` | FL · 全文 | 已修复 FL-01（终态运行重试 409） |
| `POST /api/admin/crawl-frontier/nodes/retry` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:202`（CrawlFrontierController） | `WithCrawlFrontierWrites` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_WRITES_MODE` | FL · 全文 | 已修复 FL-01（终态运行重试 409） |
| `GET /api/admin/crawl-frontier/profiles` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:37`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `POST /api/admin/crawl-frontier/profiles` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:73`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `GET /api/admin/crawl-frontier/profiles/:id` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:64`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `PATCH /api/admin/crawl-frontier/profiles/:id` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:82`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `POST /api/admin/crawl-frontier/profiles/:id/rollback/:version` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:101`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `GET /api/admin/crawl-frontier/profiles/:id/versions` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:92`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `GET /api/admin/crawl-frontier/profiles/:id/workflow-bridge` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:164`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `GET /api/admin/crawl-frontier/profiles/match` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:46`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `POST /api/admin/crawl-frontier/profiles/preview` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:55`（CrawlFrontierController） | `WithCrawlProfiles` / `crawlprofile` | `API_GO_CRAWL_PROFILES_MODE` | MD · 全文 | 一致（MD-03 长度语义 P3） |
| `GET /api/admin/crawl-frontier/runs` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:116`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致（run-detail 契约逐字段核对） |
| `POST /api/admin/crawl-frontier/runs` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:125`（CrawlFrontierController） | `WithCrawlFrontierWrites` / `crawlfrontierruns`+`crawlfrontierllm` | `API_GO_CRAWL_FRONTIER_WRITES_MODE` | FL · 全文 | 一致（#139 事务/入队顺序已核） |
| `GET /api/admin/crawl-frontier/runs/:id` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:134`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致（run-detail 契约逐字段核对） |
| `POST /api/admin/crawl-frontier/runs/:id/cancel` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:184`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致（#139 事务/入队顺序已核） |
| `GET /api/admin/crawl-frontier/runs/:id/workflow-candidates` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:152`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致（run-detail 契约逐字段核对） |
| `GET /api/admin/crawl-frontier/runs/:id/workflow-candidates/:candidateId` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:161`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致（run-detail 契约逐字段核对） |
| `GET /api/admin/crawl-frontier/runs/:id/workflow-run` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:143`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致（run-detail 契约逐字段核对） |
| `POST /api/admin/crawl-frontier/runs/cancel` | `apps/api/src/modules/crawl/crawl-frontier.controller.ts:175`（CrawlFrontierController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致（#139 事务/入队顺序已核） |
| `GET /api/admin/crawl-frontier/workflow-runs/:runId` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:126`（CrawlStrategyController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致 |
| `GET /api/admin/crawl-frontier/workflow-runs/:runId/candidates` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:135`（CrawlStrategyController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致 |
| `GET /api/admin/crawl-frontier/workflow-runs/:runId/candidates/:candidateId/explanation` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:144`（CrawlStrategyController） | `WithCrawlFrontierRuns` / `crawlfrontierruns` | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | FL · 全文 | 一致 |
| `POST /api/admin/crawl-frontier/workflow-runs/:runId/replay` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:154`（CrawlStrategyController） | `WithCrawlWorkflowTrial` / `crawlstrategyruns` | `API_GO_CRAWL_WORKFLOW_TRIAL_MODE` | WF · 全文 | 一致 |
| `GET /api/admin/crawl-frontier/workflow-versions/:versionId` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:98`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 一致 |
| `GET /api/admin/crawl-frontier/workflows` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:42`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 已修复 WF-02（N+1，仅记录） |
| `POST /api/admin/crawl-frontier/workflows` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:51`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 已修复 WF-02（N+1，仅记录） |
| `GET /api/admin/crawl-frontier/workflows/:id` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:60`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 已修复 WF-02（N+1，仅记录） |
| `PATCH /api/admin/crawl-frontier/workflows/:id/draft` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:69`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 一致 |
| `POST /api/admin/crawl-frontier/workflows/:id/publish` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:79`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 已修复 WF-02（N+1，仅记录） |
| `POST /api/admin/crawl-frontier/workflows/:id/trial-run` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:116`（CrawlStrategyController） | `WithCrawlWorkflowTrial` / `crawlstrategyruns` | `API_GO_CRAWL_WORKFLOW_TRIAL_MODE` | WF · 全文 | 一致（trial/replay 语义见 WF 报告） |
| `GET /api/admin/crawl-frontier/workflows/:id/versions` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:89`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 已修复 WF-02（N+1，仅记录） |
| `POST /api/admin/crawl-frontier/workflows/compare` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:107`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 已修复 WF-02（N+1，仅记录） |
| `GET /api/admin/crawl-frontier/workflows/node-schemas` | `apps/api/src/modules/crawl/crawl-strategy.controller.ts:36`（CrawlStrategyController） | `WithCrawlWorkflows` / `crawlworkflow` | `API_GO_CRAWL_WORKFLOWS_MODE` | WF · 全文 | 已修复 WF-02（N+1，仅记录） |
| `GET /api/admin/crawl-templates` | `apps/api/src/modules/crawl/crawl-template.controller.ts:16`（CrawlTemplateController） | `WithCrawlTemplates` / `crawltemplate` | `API_GO_CRAWL_TEMPLATES_MODE` | WF · 全文 | 一致（orgId 过滤、Boolean 强转、P2002 映射） |
| `POST /api/admin/crawl-templates` | `apps/api/src/modules/crawl/crawl-template.controller.ts:22`（CrawlTemplateController） | `WithCrawlTemplates` / `crawltemplate` | `API_GO_CRAWL_TEMPLATES_MODE` | WF · 全文 | 一致（orgId 过滤、Boolean 强转、P2002 映射） |
| `DELETE /api/admin/crawl-templates/:id` | `apps/api/src/modules/crawl/crawl-template.controller.ts:38`（CrawlTemplateController） | `WithCrawlTemplates` / `crawltemplate` | `API_GO_CRAWL_TEMPLATES_MODE` | WF · 全文 | 一致（orgId 过滤、Boolean 强转、P2002 映射） |
| `PATCH /api/admin/crawl-templates/:id` | `apps/api/src/modules/crawl/crawl-template.controller.ts:28`（CrawlTemplateController） | `WithCrawlTemplates` / `crawltemplate` | `API_GO_CRAWL_TEMPLATES_MODE` | WF · 全文 | 一致（orgId 过滤、Boolean 强转、P2002 映射） |
| `GET /api/admin/crawl4ai/quality` | `apps/api/src/modules/crawl/crawl4ai-quality.controller.ts:15`（Crawl4aiQualityController） | `WithCrawlReadTelemetry` / `crawlreadtelemetry` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | RD · 全文 | 一致（RD-09 lookbackHours 解析 P3） |
| `GET /api/admin/crawl4ai/quality/sources/:sourceId` | `apps/api/src/modules/crawl/crawl4ai-quality.controller.ts:26`（Crawl4aiQualityController） | `WithCrawlReadTelemetry` / `crawlreadtelemetry` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | RD · 全文 | 一致（RD-09 lookbackHours 解析 P3） |
| `GET /api/admin/crawl4ai/queue` | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:40`（Crawl4aiQueueController） | `WithCrawlQueueOps` / `crawltaskwrite` | `API_GO_CRAWL_QUEUE_OPS_MODE` | WF · 全文 | 一致（C2 payload 与消费端核对） |
| `POST /api/admin/crawl4ai/queue/concurrency` | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:101`（Crawl4aiQueueController） | `WithCrawlQueueOps` / `crawltaskwrite` | `API_GO_CRAWL_QUEUE_OPS_MODE` | WF · 全文 | 一致（C2 payload 与消费端核对） |
| `POST /api/admin/crawl4ai/queue/pause` | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:87`（Crawl4aiQueueController） | `WithCrawlQueueOps` / `crawltaskwrite` | `API_GO_CRAWL_QUEUE_OPS_MODE` | WF · 全文 | 一致（C2 payload 与消费端核对） |
| `POST /api/admin/crawl4ai/queue/resume` | `apps/api/src/modules/crawl/crawl4ai-queue.controller.ts:94`（Crawl4aiQueueController） | `WithCrawlQueueOps` / `crawltaskwrite` | `API_GO_CRAWL_QUEUE_OPS_MODE` | WF · 全文 | 一致（C2 payload 与消费端核对） |
| `GET /api/admin/news-sources` | `apps/api/src/modules/crawl/news-source.controller.ts:42`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources` | `apps/api/src/modules/crawl/news-source.controller.ts:57`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `DELETE /api/admin/news-sources/:id` | `apps/api/src/modules/crawl/news-source.controller.ts:155`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `PATCH /api/admin/news-sources/:id` | `apps/api/src/modules/crawl/news-source.controller.ts:145`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/:id/cancel-queued` | `apps/api/src/modules/queue/news-source-ops.controller.ts:17`（NewsSourceOpsController） | `WithNewsSourceOps` / `newssourcescheduler` | `API_GO_NEWS_SOURCE_OPS_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/:id/clear-inflight` | `apps/api/src/modules/queue/news-source-ops.controller.ts:23`（NewsSourceOpsController） | `WithNewsSourceOps` / `newssourcescheduler` | `API_GO_NEWS_SOURCE_OPS_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/:id/dispatch` | `apps/api/src/modules/queue/news-source-dispatch.controller.ts:15`（NewsSourceDispatchController） | `WithNewsSourceOps` / `newssourcescheduler` | `API_GO_NEWS_SOURCE_OPS_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `GET /api/admin/news-sources/:id/preview` | `apps/api/src/modules/crawl/news-source.controller.ts:180`（NewsSourceController） | `WithNewsSourcePreview` / `crawlstrategyruns` | `API_GO_NEWS_SOURCE_PREVIEW_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/:id/retry-latest` | `apps/api/src/modules/queue/news-source-ops.controller.ts:29`（NewsSourceOpsController） | `WithNewsSourceOps` / `newssourcescheduler` | `API_GO_NEWS_SOURCE_OPS_MODE` | WF · 全文 | 一致（C1 回滚改进） |
| `POST /api/admin/news-sources/:id/run` | `apps/api/src/modules/crawl/news-source.controller.ts:164`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/:id/schedule` | `apps/api/src/modules/crawl/news-source.controller.ts:170`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `DELETE /api/admin/news-sources/batch` | `apps/api/src/modules/crawl/news-source.controller.ts:136`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `PATCH /api/admin/news-sources/batch/active` | `apps/api/src/modules/crawl/news-source.controller.ts:127`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/batch/frequency` | `apps/api/src/modules/crawl/news-source.controller.ts:66`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `PATCH /api/admin/news-sources/batch/group` | `apps/api/src/modules/crawl/news-source.controller.ts:118`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `GET /api/admin/news-sources/groups` | `apps/api/src/modules/crawl/news-source.controller.ts:112`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `GET /api/admin/news-sources/opml-presets` | `apps/api/src/modules/crawl/news-source.controller.ts:78`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/opml/import` | `apps/api/src/modules/crawl/news-source.controller.ts:98`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `POST /api/admin/news-sources/opml/preview` | `apps/api/src/modules/crawl/news-source.controller.ts:84`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `GET /api/admin/news-sources/options` | `apps/api/src/modules/crawl/news-source.controller.ts:51`（NewsSourceController） | `WithNewsSources` / `newssources` | `API_GO_NEWS_SOURCES_MODE` | NS · 全文 | 已修复 NS-01/NS-03/NS-04 |
| `GET /api/crawl-media-assets/:assetId/:mode` | `apps/api/src/modules/crawl/crawl-media-asset.controller.ts:29`（CrawlMediaAssetController） | `WithCrawlReadTelemetry` / `crawlreadtelemetry` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | RD · 全文 | 已修复 RD-03/RD-04（S3 分支已复核关闭） |
| `GET /api/crawl-tasks` | `apps/api/src/modules/crawl/crawl.controller.ts:26`（CrawlController） | `WithCrawlReadTelemetry` / `crawlreadtelemetry` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | RD · 全文 | 已修复 RD-01/RD-02（详情键与空串） |
| `POST /api/crawl-tasks` | `apps/api/src/modules/crawl/crawl.controller.ts:42`（CrawlController） | `WithCrawlTaskWrite` / `crawltaskwrite` | `API_GO_CRAWL_TASK_WRITE_MODE` | WF · 全文 | 一致（pending→enqueue→queued，C-5 窗口已记录） |
| `DELETE /api/crawl-tasks/:id` | `apps/api/src/modules/crawl/crawl.controller.ts:58`（CrawlController） | `WithCrawlTaskWrite` / `crawltaskwrite` | `API_GO_CRAWL_TASK_WRITE_MODE` | WF · 全文 | 一致（事务+outbox+审计） |
| `GET /api/crawl-tasks/:id` | `apps/api/src/modules/crawl/crawl.controller.ts:32`（CrawlController） | `WithCrawlReadTelemetry` / `crawlreadtelemetry` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | RD · 全文 | 已修复 RD-01/RD-02（详情键与空串） |
| `POST /api/crawl-tasks/:id/retry` | `apps/api/src/modules/crawl/crawl.controller.ts:65`（CrawlController） | `WithCrawlTaskWrite` / `crawltaskwrite` | `API_GO_CRAWL_TASK_WRITE_MODE` | WF · 全文 | 一致（pending→enqueue→queued，C-5 窗口已记录） |
| `POST /api/crawl-tasks/metadata` | `apps/api/src/modules/crawl/crawl.controller.ts:77`（CrawlController） | `WithCrawlMetadata` / `crawlmetadata` | `API_GO_CRAWL_METADATA_MODE` | MD · 全文 | 一致（逐跳 SSRF 已核） |
| `GET /api/admin/search-telemetry/summary` | `apps/api/src/modules/search-telemetry/search-telemetry-admin.controller.ts:13`（SearchTelemetryAdminController） | `WithCrawlReadTelemetry` / `crawlreadtelemetry` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | RD · 重点 | 一致（RD-08/RD-11 消息顺序 P3） |
| `POST /api/search-telemetry` | `apps/api/src/modules/search-telemetry/search-telemetry.controller.ts:13`（SearchTelemetryController） | `WithCrawlReadTelemetry` / `crawlreadtelemetry` | `API_GO_CRAWL_READ_TELEMETRY_MODE` | RD · 重点 | 一致（RD-08/RD-11 消息顺序 P3） |

### 3.1 非 HTTP 入口

| Nest 入口 | Nest 源码 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|---|
| crawl4ai 三队列消费者（`crawl4ai`、`-hot`、`-normal`） | `crawl.processor.ts` | `internal/crawlworker` | `API_GO_CRAWL_WORKER_MODE` | 全文 | 一致；WQ-01/WQ-02 已修 |
| QueueEvents 完成/失败副作用（B1） | `crawl.processor.ts:977-1150` | 副作用内联进 worker（无 QueueEvents） | 同上 | 全文 | 修复完整，无同类残留（WQ-04 补最后一处） |
| Frontier LLM 两队列（judge / learn） | `crawl-frontier-llm.service.ts` | `internal/crawlfrontierllm` | `API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE` | 全文（判定/学习/生命周期）；BullMQ 协议与 `materialize.go` 仅重点 | FL-02/03/04/10 已修 |
| `crawl:worker-concurrency:v1` 发布/订阅 | 仅订阅端 | `crawlqueue`（发布）、`crawlworker`（消费）、`crawlmaintenance/adaptive.go` | 同上 | 全文 | 一致（校验集合与 clamp 双侧相同） |
| 并发限制器（hot 优先 / 容量调整） | `crawl-adaptive-concurrency.service.ts` | `crawlworker/limiter.go` | — | 全文 | 一致 |
| 内存压力 rateLimit / `RateLimitError` / 预算 | `crawl.processor.ts`、`crawl4ai.client.ts:358-362` | `crawlworker/attempt.go`、`crawlqueue` | — | 全文 | 一致（Q1/Q2 结论复核） |
| 定时维护：卡住任务回收 | `crawl-task-janitor.service.ts` | `crawlmaintenance/janitor.go` | `API_GO_CRAWL_MAINTENANCE_MODE` | 全文 | 一致；LD-01 已修计数原子性 |
| cleanup outbox（drain / dead） | `crawl-cleanup-outbox.service.ts` | `crawlmaintenance/cleanup_outbox.go` | 同上 | 全文 | 一致（C-3 不成立） |
| 自适应并发 cron / 质量任务快照 cron / 审计保留 cron | 同名 service | `crawlmaintenance/{adaptive,quality_snapshot,audit_retention}.go` | 同上 / `API_GO_AUDIT_LOG_RETENTION_MODE` | 全文 | 一致（租约、tick gate、优雅停机已核） |
| 用户级爬取完成通知 | `crawl-execution-results.service.ts` safeNotifyCrawl | `crawlexecution/notify.go` | `API_GO_CRAWL_WORKER_MODE` | 全文 | 一致（3 次重试、UTF-16 191 截断、恰好一次） |
| `notification:events:v1` 中继（B3） | Nest 订阅端 | `crawlexecution/notify.go` 发布 | 同上 | 重点 | 一致 |
| 对象存储写入（crawl 媒体） | `crawl-media-asset.service.ts` | `crawlexecution/{media,media_store,media_config}.go` | 同上 | 全文 | 键名逐段一致；EX-07 记录 |
| crawl4ai 外部调用 | `crawl4ai.client.ts` | `internal/crawl4ai` | — | 全文 | WQ-01/02/03 已修；WQ-06 记录 |
| LLM 网关调用 | `crawl-frontier-llm.service.ts` | `crawlfrontierllm/{llm,llm_judge,llm_profile}.go` | — | 重点 | 无发现（协议边界为 `any`，允许） |
| GraphQL `crawlTasks` / `crawlTask` | `crawl.resolver.ts:69,153` | `graphqlread/settingscrawl/crawl.go` | `API_GO_SETTINGS_CRAWL_READ_MODE` | 重点 | RD-06（=LD-02）已修 |
| GraphQL `crawlMetadata` | `crawl.resolver.ts:279` | `graphqlread/crawlmetadata` | `API_GO_CRAWL_METADATA_MODE` | 全文 | RD-05 已修 |
| GraphQL 三任务写（create/delete/retry） | `crawl.resolver.ts:170,205,268` | `graphqlread/crawltaskwrite` | `API_GO_CRAWL_TASK_WRITE_MODE` | 重点 | 无发现（权限在 service 内校验，与 Nest 同） |
| GraphQL 三入库根（`createItemFromCrawlResult` 等） | `crawl.resolver.ts:245,268,170` | `graphqlread/itemsingest` | 条目域开关 | 边界 | 只核 crawl 侧调用；权限校验在 resolver 内（`requireAll(crawl.read, items.write)`）与 Nest 一致 |

## 4. 发现

编号规则：`MD`=元数据/选项/画像，`EX`=执行与媒体，`FN`=frontier 节点，`FL`=frontier LLM 与运行，`WQ`=worker/队列/crawl4ai，`WF`=工作流/模板/任务写/维护，`RD`=读接口与 GraphQL 契约，`NS`=采集源注册表，`LD`=Lead 跨切片。

### 4.1 P1（4 条，全部已修复）

#### EX-01 条件请求复用查询未限定任务，可复用其它任务乃至其它组织的 CrawlResult
- Nest：`apps/api/src/modules/crawl/crawl-conditional-preflight.service.ts:42-66` —— `where: { taskId, OR: [sourceUrlFingerprint, sourceUrl(canonical), sourceUrl(raw)] }`，`taskId` 与匹配组是 **AND**。
- Go（修复前）：`apps/api-go/internal/crawlexecution/preflight.go:70-88` 把 `taskId` 放进同一个顶层 `OR`：`WHERE taskId = ? OR sourceUrlFingerprint = ? OR sourceUrl = ? OR sourceUrl = ?`，全表无租户/任务约束。
- 影响：任意同 URL 的 `CrawlResult`（含其它组织）会成为本任务的 `latestValidation`：把别人的 ETag/Last-Modified 当 `If-None-Match` 发出；命中 304 后 `completeFrom304Reuse` 把本任务标 completed、`runCount+1`、`skipped=1`、`lastResultAt` 取别人的 `fetchedAt`，**真正的抓取被跳过**，summary 与 complete TaskLog 写入别人的 resultId；同组织跨任务时还会把别人的结果送去入条目（跨组织被 `itemsingest` 的 `JOIN CrawlTask ... AND t.orgId = ?` 拦住）。判为 P1 而非 P0：没有把其它租户的正文回给用户（读接口按 `taskId` 取结果），但确实是跨租户引用 + 抓取丢失。
- 处理：已修复（`fee345bc`）。抽出 `buildLatestResultValidationQuery`，SQL 改为 ``WHERE `taskId` = ? AND (<matchers OR …>)``，参数 `taskId` 在前；无 matcher 时仍返回 nil（同 Nest 的 null 分支）。
- 测试：`TestLatestResultValidationQueryScopesToTask`、`TestFindLatestResultValidationStateUsesTaskScopedQuery`。

#### FL-01 已完成运行的失败节点无法重试（409），而控制台正是提供该操作
- Nest：`crawl-frontier.service.ts:764-777`（`retryNode` → `requeueNodeRecord` 无条件）、`:4418-4470`（节点置 queued，run 改回 `queued`/`finishedAt=null`）。Web：`apps/web/app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx:1510-1512` 只要节点 `failed/skipped` 就显示重试，与 run 状态无关。
- Go（修复前）：`apps/api-go/internal/crawlfrontierruns/service_write.go:416-417` 要求 run 处于可取消状态，否则 409（文案在 `:199`）。
- 影响：`refreshRunStatus` 在 `pageCount>0` 就结束 run（`crawlfrontierllm/refresh.go:70-84`），因此「已完成运行里的失败节点」这一主要重试场景恒定 409；#139 引入该守卫（#135 记录 Q3 时 Nest 仍是可直接重试）。
- 处理：已修复（`96de1d60`）。新增 `runStatusAllowsNodeRetry`，只拒绝**已取消**运行；已完成运行恢复可重试。属 Nest 既有问题（取消运行在 Nest 也能重试），Go 已修复并有行为变化：取消运行的 409 文案为 `Crawl frontier run is canceled and cannot be retried`。
- 测试：`TestRunStatusAllowsNodeRetry`、`TestFrontierWritesIntegrationRetryCompletedRun`（集成）、更新 `TestFrontierWritesIntegrationRetryTerminalRun`。

#### FL-10 #133 B1：运行/节点 metadata 的读改写全部未加锁，加锁助手是死代码
- Nest：无加锁语义（Prisma 读改写），`crawl-frontier.service.ts:4052-4075` 等处在终态生命周期里重读 `run.metadata`。
- Go（修复前）：`crawlfrontierllm/export_lock.go` 定义了 `UpdateRunMetadataLocked` / `UpdateNodeMetadataLocked` / `UpdateNodeMetadataFuncLocked`，但**在生产代码中无任何调用点**（只有 `crawlfrontiernode/integration_test.go:1349-1353` 间接用到）；真实合并都走 `store.go` 的 SELECT→merge→UPDATE。`refreshRunStatus` 在开头读 metadata、结尾整份写回。
- 影响：并发写入互相覆盖。丢失 `shadowEvaluationTriggeredAt` / `shadowRunId` 会让下一次终态生命周期**再建一个 shadow 运行**（额外合成 CrawlTask + `CrawlFrontierRun` + workflow run + 根节点 + LLM learn）；丢 `llmLifecycle` 键会重复入队 learn；丢节点 `pendingLlmJudgeJobs` 会让运行永远 `active`（`judge.go:17-23` 记录的 B1 症状）。重复 learn 入队本身被 BullMQ dedup key 抑制（`crawlqueue/frontier_enqueue.go:212`），因此该半条主张降级；丢键才是 P1。
- 处理：已修复（`836d7499`）。`updateRunMetadata` → `mergeRunMetadataLocked` → `withLockedMetadata`（run 行 `FOR UPDATE`，同事务合并+更新）；`updateNodeMetadataFunc` 同理，回调在锁内文档上求值；`refresh.go` 的整行 UPDATE 改为 `writeRunRefreshLocked`（BEGIN → `SELECT metadata … FOR UPDATE` → 合并 → 单条 UPDATE 状态/计数/metadata/`finishedAt` → COMMIT，返回合并结果）；`handleTerminalRunLifecycle` 的 `handledKey`/`learnQueuedKey` 守卫改用该已提交文档（对齐 Nest 的重读）；`export_lock.go` 三个导出助手改为委派同一实现。
- 行为变化（Go 独有、有意）：metadata 合并由行锁串行化，合并结果等价于 Nest 串行时；代价是每次 refresh/metadata 写多一个短事务。锁顺序 run→node 保持，调用方均无外层事务，未发现 hold-and-wait 反转。
- 测试：`TestFrontierLlmRunMetadataLockedMergeIntegration`（16 并发 run 合并 + 16 并发节点函数式合并，32 个键全部保留）。
- 复核结论（#133 B1 完整性）：`crawlfrontierllm` 的 11 处 run metadata 写入与全部 node metadata 写入现共用两个加锁实现；`crawlfrontierruns` 的 `requeueNode` 在自身事务内 `SELECT … FOR UPDATE` 后合并、不写 run metadata；`crawlfrontiernode` 的节点写都是整文档自写。仍**未加锁且与 Nest 同**的只有两处（刷新派生列 last-writer-wins、两次 refresh 同时进终态分支，后者被 learn dedup key 与 `learnRetryCount` 限制）。

#### NS-01 共享 SSRF 校验器未按 WHATWG 规范化主机，数字/Unicode 别名可绕过内网与云 metadata 拦截
- Nest：`apps/api/src/common/validators/ssrf-url.validator.ts:194-265` 在 `new URL(url).hostname` 上判定（WHATWG 解析会小写、做 UTS#46 映射、把以数字结尾的主机按 IPv4 解析）；调用点 `news-source.service.ts:1105-1112`、`news-source-opml.service.ts:527-575`。
- Go（修复前）：`apps/api-go/internal/newssources/ssrf.go:46` 用 `strings.ToLower(parsed.Hostname())` + `net.ParseIP`：`127.1`、`017700000001`、`ｍｅｔａｄａｔａ.google.internal`、`[fe80::1%25eth0]` 都不是 IP 字面量 → 当普通主机名 → DNS 失败即按 allowUnresolved **放行**（`ssrf.go:73-80`）。而 Node/Python 侧解析会把它们还原成 `127.0.0.1` / `metadata.google.internal`。
- 影响面：该 helper 被 `crawlmetadata/fetch.go:48`（逐跳抓取）、`crawlexecution/preflight.go:267`、`crawl4ai/client.go:279`（实际解析发生在 crawl4ai 进程内，Python 会把 `127.1` 解析为回环）、`oidclogin/service.go:58` 复用。经 crawl4ai 路径可形成对内网与云 metadata 端点的 SSRF；若可读到 metadata 响应即为凭据泄露面，但本批**未做实网验证**，故按 P1 记录而非 P0。
- 处理：已修复（`4e910d61`）。新增 `canonicalSSRFHost`（UTS#46→ASCII、去尾点）、WHATWG IPv4 解析器（1–4 段 dec/oct/hex；非法数字形式等价 Node 的 Invalid URL，故拒绝），`isIPAddress` 认 RFC6874 zone。`golang.org/x/net/idna` 已是直接依赖（`go.mod:39`，另有三处使用），无 go.sum 变更。
- 行为变化（安全收紧，Nest 本来如此）：`http://127.1/`、`http://1.2.3.4.5/`、全角 metadata 别名、`[fe80::1%25eth0]` 由放行变为拒绝；公开数字形式（`134744072`=8.8.8.8）与正常 IDN 仍放行。
- 测试：`TestSSRFNumericHostFormsMatchWHATWG`、`TestSSRFUnicodeHostFormsMatchNodeURL`、`TestSSRFIPv6ZoneLiteralIsRejected`、`TestSSRFHostTrailingDotMatchesWHATWG`、`TestSSRFPercentEncodedHostIsRejected`。

### 4.2 P2（21 条，17 修复 / 4 只记录）

| 编号 | 标题 | 证据（Nest / Go） | 处理 | 测试 |
|---|---|---|---|---|
| MD-01 | sitemap 候选丢弃重复项且从不写 `crawledAt`，导致 preview 时间戳、`timestampSource` 与种子排序与 Nest 不同 | `crawl-metadata.service.ts:2253-2337,1419-1460` / `crawlmetadata/sitemap.go`（`orderedURLSet`）、`discover.go:67` | 已修复 `7648461f` | `TestDiscoverSitemapCandidatesMergeTimestamps` |
| MD-02 | jsCode 2000 上限按 UTF-8 字节，非 ASCII 脚本约 667 字符即被拒 | `validators/js-code.validator.ts` / `crawloptions/jscode.go:83` | 已修复 `45f9827a` | `TestValidationJSCodeLengthUsesUTF16` |
| EX-02 | markdown 规范化缺 `politico pro` 噪声规则 → contentHash 分叉、去重窗口失效 | `crawl-result.service.ts:1500-1501,1546-1547` / `crawlexecution/markdown.go` | 已修复 `28206a67` | `TestNormalizeMarkdownCandidateDropsPoliticoProChrome` |
| EX-03 | `linkAnalysis` 缺 metadata 回退，crawl4ai 把分析放 metadata 时恒为 null | `crawl-result.service.ts:1609-1631` / `crawlexecution/results.go:641` | 已修复 `28206a67` | `TestBuildResultLinkAnalysisFallsBackToMetadata` |
| EX-04 | 入条目 actor 丢 `triggeredById`（304 与 persist 两条路径） | `crawl-execution.service.ts:235-238,499-504` / `crawlexecution/service.go:479,results.go:383` | 已修复 `28206a67` | `TestIngestActorUsesTriggeringUser` |
| FN-01 | 子节点候选缺发现 provenance（`sourceTier`/`freshnessBucket`/`syntheticList`/`discoveryPath`），包装层是死代码 | `crawl-frontier.service.ts:3508-3546,2613-2659` / `crawlfrontiernode/discover.go:875-881` | 已修复 `fa647890` | `TestExtractFrontierNodeCandidatesAppliesDiscoveryProvenance` 等 |
| FN-02 | `seedDiscovery.mode="disabled"` 被忽略，仍发 sitemap 请求并造种子节点 | `crawl-metadata.service.ts:2364`、`crawl-frontier.service.ts:3081-3086` / `crawlfrontiernode/discover.go:913` | 已修复 `fa647890` | `TestDiscoverSitemapSeedsHonorsDisabledMode` |
| RD-01 | 无 complete TaskLog 时详情缺 `memoryStats`/`lastRunSummary` 键（Nest 为 null） | `crawl-task.service.ts:362-372`、`crawl-result.service.ts:803-815,853-865` / `crawlreadtelemetry/model_crawl.go:90-91` | 已修复 `a888b529` | `TestCrawlTaskDetailJSONCarriesRunKeys` 等 |
| RD-02 | 现存空串列被序列化为 null（12 个键） | `crawl-task.service.ts:642-665`、`crawl-media-asset.service.ts:748-766` / `service_media.go:671-677` | 已修复 `1939d5e3` | `TestStringPtrFromNullKeepsEmptyString` 等 |
| RD-03 | 媒体行查询用 trim 后的 org，Nest 用原始 query 值（`?org=%20X%20` 应 404） | `crawl-media-asset.controller.ts:34`、`:401-405` / `service_media.go:142` | 已修复 `1939d5e3` | `TestResolveMediaAccessKeepsRawOrgQueryValue` |
| RD-04 | 下发文件名用库内原始 contentType，别名值丢扩展名 | `crawl-media-asset.service.ts:454-461,684-691,815-824` / `service_media.go:485,643` | 已修复 `1939d5e3` | `TestResolveDeliveryFileNameUsesResolvedContentType` |
| RD-05 | `crawlMetadata` 的 `maxUrls`/`concurrency` <1 被静默 clamp，Nest 是 BAD_REQUEST | `graphql/dto/crawl.input.ts:648-652,679-683` / `graphqlread/crawlmetadata/register.go` | 已修复 `a263af10` | `TestCrawlMetadataInputBounds` |
| RD-06 → LD-02 | `crawlTask(resultLimit<1)` 被 clamp，Nest `@Min(1)` 报错 | `crawl.input.ts:749-759` / `graphqlread/settingscrawl/crawl.go:331-339` | 已修复 `ac687ecd` | `TestCrawlTaskResultLimitArg` |
| WQ-01 | crawl4ai 健康探针持锁跨 HTTP，并发抓取串行且等待不可取消（破坏停机排空） | `crawl4ai.client.ts:695-720` / `crawl4ai/client.go:183-221` | 已修复 `c6770593` | `TestHealthProbeMergesConcurrentWaiters` 等 |
| WQ-02 | crawl4ai jsCode 上限按字节、且未 trim/过滤空串就计 5 条名额 | `js-code.validator.ts:310,355`、`crawl4ai.client.ts:1313-1318` / `crawl4ai/jscode.go:96-104`、`payload.go:528-553` | 已修复 `d1a28bd6` | `TestValidateJSCodeLengthCountsUTF16Units` 等 |
| NS-03 | 无快照行的来源在列表里被清零 runtime/背压计数 | `news-source.service.ts:270-299` / `newssources/store.go:131-136` | 已修复 `0c19777c` | `TestEmptyIfNoSnapshotKeepsRuntime` 等 |
| NS-04 | 采集源全部 MaxLength 用 UTF-8 字节，中文名/分组/搜索词被误拒 | `dto/news-source.dto.ts:39-182` 等 / `newssources/validate.go:94-513`、`opml.go:411` | 已修复 `d0b40417` | `TestUTF16LengthMatchesJavaScript` 等 |
| WF-02 | `GET /workflows` 是 1+2N 查询（Nest 3 条） | `crawl-strategy-workflow.service.ts:60-86` / `crawlworkflow/store.go:110-146` | **只记录**：需重写为两条批量查询 + MySQL 集成测试，本机无编译/运行能力，盲写数据访问风险高于收益 | — |
| EX-05 | `CrawlResultContent.tables` 未规范化（Nest 写 `{id,caption,headers,rows,rowCount,columnCount,source,metadata,dataFrame}`） | `crawl-result.service.ts:584,2166-2260` / `crawlexecution/results.go:648` | **只记录**：约 180 行新规范化器移植，需独立窗口 1:1 实现并补测试 | — |
| FN-03 | sitemap 发现未透传 `requestTimeoutMs`、`robots`/`sitemap_only`/`common_paths` 语义与 8 项诊断，`seedMethod` 恒 null | `crawl-metadata.service.ts:289-293,2358-2400,299-330` / `crawlfrontiernode/discover.go:893-946` | **只记录**：需要 `crawlmetadata` 增加按次超时/模式/诊断参数，跨包 | — |
| NS-02 | 列表不再为缺快照的源补写 `NewsSourceOpsSnapshot` | `news-source.service.ts:331-356` / `newssources/store.go:145-181` | **只记录**：需 newssources→scheduler 窄接口并由 `cmd/api` 注入，反向 import 成环；`newssourcescheduler/snapshot.go:243-258` 的 `RefreshSnapshotsForSources` 目前无调用方 | — |

### 4.3 P3（44 条，6 修复 / 38 只记录）

已修复：

| 编号 | 标题 | 处理 | 测试 |
|---|---|---|---|
| WQ-03 | `crawl4ai.StatusOf` 用裸断言，`%w` 包装会丢可重试状态码 | 已修复 `88ac4b38`（改 `errors.As`） | `TestStatusOfUnwrapsWrappedError` |
| WQ-04 | 队列删除补偿仍用非原子 `MarkTasksTerminal`（B1 同类残留） | 已修复 `0d23c17b`（改原子版）；Nest 既有问题，Go 已修复 | 由 crawlworker 集成用例覆盖 |
| WF-01 | `crawlworkflow/bridge.go` 非 gofmt，整包被 `gofmt -l` 标出；且该包此前零测试 | 已修复 `9ffe95eb`（+9 个纯函数契约测试） | `TestValidateCreateWorkflowMessages` 等 |
| FL-04 | `sanitizeProfilePatch` 遍历 Go map，同一输入每次键序不同 | 已修复 `15c7c7a3`（有序切片） | `TestSanitizeProfilePatchKeyOrderIsDeterministic` |
| LD-01 | `crawlmaintenance/janitor.go:375` 用非原子 `MarkTasksTerminal` | 已修复 `655300d5`（接口与调用点改原子版） | 由 `TestCrawlMaintenance` 集成用例覆盖 |
| WQ-05 | 混合模式下 `crawl:activity` 双扣的文档描述过强 | 已修复 `c42b2dd5`（仅文档） | — |

只记录（按包归类，均为契约/文案/可读性/边界输入级，或需要跨包契约变更）：

- **MD**：MD-03 MaxLength 三套语义并存（class-validator 码点 vs UTF-16 vs 可变选择符近似），`crawlprofile/validate.go:541` 的 `jsMaxLengthLen` 与自身文档矛盾；MD-04 请求体解析与鉴权顺序（crawlprofile 先读 body → 未认证畸形体返回 400/413 而非 401），非对象 JSON body 返回字段级消息而非 `forbidUnknownValues` 文案；MD-05 `normalizeURL` 对非 http(s) sitemap `loc` 的处理不同（`ftp://` 被加 `https://` 前缀）；MD-06 生成的 JSON 对象键序（map 重排 vs 插入序，不影响解析）；MD-07 `jsTrim` 多裁 U+0085、`jsRound` 对 `0.49999999999999994` 与 `Math.round` 差 1。
- **EX**：EX-06 候选分覆盖加成未 `Math.round`（`markdown.go:257` vs `crawl-result.service.ts:1122`）；EX-07 媒体 blob `refCount` 释放无 `FOR UPDATE`（Nest 同缺陷）；EX-08 新闻源 runtime state 的 Redis 读改写跨实例可丢更新（Nest 同缺陷，Go 已加 1s 合并器缓解）；EX-09 `items` 服务缺失时 `itemsQueueFailed` 计数口径不同；EX-10 `expansion` improved 排序三级键全等时依赖 map 迭代序；EX-11 失败详情 error 取值优先级与 Nest 相反（可能影响 retryable 文案）。
- **FN**：FN-04 `doc.go` 声称 run/node metadata 合并加锁，但该包内加锁助手仍无调用者（run 级已由 FL-10 收口，本包节点写是整文档自写）；FN-05 `jsTruthy` 把 JSON `0.0` 当 truthy、空串回退语义、`U+2028/2029` 转义、`Service.http` 死字段。
- **WQ**：WQ-06 payload 未发送 `user_agent_generator_config`/geolocation（`crawl4ai.client.ts:107/113`），需 `crawloptions` 模型扩展；WQ-07 jsCode `setTimeout` 警告日志缺失、`jsonorder.go` 注释与实现不符、2xx 不可解析 body 归类不同、对未启动的 legacy 队列也设限速键。
- **WF**：WF-03 `crawlworkflow`/`crawltemplate` 约 315 行中文源码注释违反英文注释规则；WF-04 数据库 JSON 业务载荷仍用 `map[string]any`（`bridge.go`、`compare.go`、`nodes.go`）；WF-05 LLM guard 消息键序（Go 排序 vs 插入序）与 `jsMaxLengthLen` 的可变选择符近似；WF-06 `crawltaskwrite`/`crawlstrategyruns` 先鉴权后读 body（Nest 相反，未认证畸形体返回 401 而非 400/413）；WF-07 janitor 对从未计入的 `pending` 失败也扣 `crawl:activity`（Nest 同，Go 另有 idle 探针补偿）。
- **RD**：RD-07 错误体 `path` 丢查询串（`authhttp/errors.go:68` vs Nest `request.url`）；RD-08 未知 query/body 属性被忽略（Nest `forbidNonWhitelisted` 400）；RD-09 `lookbackHours`、RD-10 telemetry 计数用 `ParseInt` 严格要求（Nest `Number.parseInt` 接受前缀）；RD-11 summary 校验顺序/文案；RD-12 详情媒体投影先取整任务资产再内存过滤；RD-13 `metadata` 列为 JSON `null` 时不回退文档 metadata。
- **FL**：FL-05 WHATWG 分片内 `#` 被百分号编码、`%2e` 未按点段处理（分片不发给爬虫）；FL-06 shadow 学习写归属用 profile 创建者而非 run 创建者；FL-07 取消/重试用 `JSON_CONTAINS` 而非 `id IN (…)`，`FOR UPDATE` 锁范围偏大；FL-08 shadow profile config 未规范化即落库；FL-09 剩余 `map[string]any` 协议边界载荷（允许）。
- **NS**：NS-05 PATCH `language: null` Go 清空 / Nest 忽略；NS-06 OPML 逐条校验比 Nest DTO 宽（>191 字 name 变 500、未知 siteType 静默降级）；NS-07 OPML URL 规范化仍是 net/url 语义（缺尾斜杠、不 punycode）；NS-08 响应仍用 `map[string]any`/`[]map[string]string`，且 `resolveQueryParamAllowlist` 无调用方、`query_allowlist.go:65` 每次编译正则；NS-09 OPML preview/import 逐条串行 DNS（Nest 并发）；NS-10 校验器文案/强转差异（`page=0` 文案、重复 query 取首值 vs 400、bearer 前缀大小写）。

## 5. 被推翻的疑点

记录下来避免后续重复审查。每条都写了两侧证据并主动反驳过一次。

| 疑点 | 为什么不成立 |
|---|---|
| crawl4ai sitemap/robots 抓取没有 SSRF 校验（FN 切片提出的跨切片 P1） | `crawlmetadata` 只有一个出网点（`fetch.go:52-60` 的 `fetchWithStatus`），它对每个重定向跳都调用 `newssources.ValidateOutboundTargetURL`；`fetchMaybe`、sitemap、robots、RSS、深/列表发现全部经过它。 |
| 定时维护会把 Frontier 合成的 CrawlTask 当普通任务重新执行 | 两侧都没有 `config.frontier` 过滤，但 janitor **只**把超期行写成 `failed`（`janitor.go:386-448` 状态守卫事务），从不重跑；`pending` 也要求「无 pending BullMQ job」才回收。 |
| cleanup outbox 会永久遗留 Mongo 文档（static-audit C-3） | Go 的投递失败不会升级成 `dead`（`cleanup_outbox.go:326-339`，只有非法载荷才 dead），退避上限约 12 分钟；当前 Nest 同意图。 |
| C-5「pending 窗口无人回收」仍成立 | Go 的 janitor 会扫 `pending`（`janitor.go:174-198`）并按「无队列 job」失败之；Nest 现在也有同三件套，故该审查文档对两侧都已过期（文档需更新，见第 7 节）。 |
| `safeNotifyCrawl` 在多实例下重复通知 | 通知只在终止尝试时发；BullMQ 任务由 `moveToActive` Lua + job lock 单所有者持有，QueueEvents 只是 XREAD 广播、不再驱动副作用；3 次重试/退避/UTF-16 191 截断均与 Nest 一致。 |
| #135 B2（`markSourceFailureState` 无锁）在 Go 里仍不完整 | `crawlexecution/source_failure.go:175-235` 在同一 `BeginTx` 内 `SELECT … FROM NewsSource WHERE id = ? FOR UPDATE`，纯函数算计划，`Commit()` 之后才按结果发通知；并发失败不会丢计数、阈值通知只发一次。`itempipeline` 的独立副本按 #135 约定未动。 |
| 对象存储键名与 Nest 不一致会让已有对象失联 | `buildMediaStorageKey`（`media_store.go:361-370`）与 Nest `buildStorageKey` 逐段一致（`crawl-media/<orgId>/<taskId>/<resultId>/<ms>-<uuid><ext>`），扩展名表、content-type 规范化/别名、S3 去重键、`existingKey ?? buildStorageKey`、上传 cacheControl、插入失败删对象全部对齐。 |
| 失败清理顺序不同会留半写状态 | `rollbackPersistedResult` 依次回滚媒体资产→Mongo content→`CrawlResult` 行，与 Nest 同序，单步失败只记日志。 |
| 用户提供的正则会因 RE2 不支持环视而出问题 | 三个包里没有任何用户正则被编译进 RE2：crawlmetadata 的 `pattern` 是通配符匹配器（算法与 512/32 上限双侧相同），profile 的 `matchHostPattern` 把除 `*` 外全部转义。 |
| Go map 迭代序会泄漏进数组顺序 | sitemap/去重/通配符路径都用有序切片；唯一的 map→slice 转换（`findDisallowedKeys`、crawloptions 有序 JSON 树）是有意排序的。 |
| 共享 Redis 条件 GET 缓存与 Nest 不兼容 | 同键 `crawl:discover:http-state:<sha1>`、同 7 天 TTL、同载荷结构。 |
| 共享并发限制器 hot 优先/容量调整与 Nest 不同 | `shiftWaiterLocked`（hot 先、normal 不抢 hot）、`setCapacity`、两种停机文案与 Nest 逐字一致。 |
| 内存压力会误触发来源熔断 | 内存压力错误带 500，先命中可重试状态码集；`markSourceFailureState` 只在 `sourceID && pipelineJobID && !shouldRetry` 时调用，与 Nest 相同。 |
| BullMQ 协议有偏差（`ats`/`atm`/`failed` 事件/`moveJobFromActiveToWait`） | 逐条对照 vendored Lua：`ats` 只在 `moveToActive-11` 增；`retryJob-11` 只发 `waiting`；只有 `moveToFinished-14` 在 target=failed 时发 `failed`（`atm+1>=attempts` 补 `retries-exhausted`）；`moveJobFromActiveToWait-9` 只 LREM active、按 priority 回队、XADD `waiting`、不动 `atm`/`ats`。Go 未自行推进 attempts。 |
| `crawl:worker-concurrency:v1` 生产/消费形状不一致 | 生产 `{"version":1,"maxConcurrency":N}`；两侧校验都只接受 version 1、整数 1..20；REST 路由 clamp 1..20。 |
| `#139` 的 POST 201 / `crawl.write` / 跨租户 404 / 事务与入队顺序有偏差 | 三条写都 201；`authorize(permWrite)` 先于解析 body；按 id 读后比较 orgId 回 404；`createRunFromProfile` 两侧都是非事务 + 最后入队，Go 额外做了失败清理。 |
| 质量指标聚合/快照缓存与 Nest 不同 | Mongo 管道、SQL 聚合、`toFixed(4)`/`Math.round` 舍入、分组排序、空窗口分支、阈值选取、快照 key/TTL/lock/wait-rebuild 全部逐项一致。 |
| GraphQL `crawlTasks`/`crawlTask` 的 nullability 与游标语义不同 | keyset 等价于 Prisma cursor+skip；`take=min(first,50)`；跨组织/失效游标返回空页并过滤 totalCount；`NOT_FOUND` 无 appCode，与 Nest 一致。 |
| `crawlTask` 的 `resultLimit<1` 只能 clamp（RD-06 原判断的另一半） | 该 root 有 `@Min(1)`；同包 `first<1` 已按同一前例报错，故 LD-02 修复。 |
| Nest `JsCodeAuditService`（NP-SEC-002）写了审计而 Go 没写 | `logJsCodeUsage` 在全仓库**无任何调用方**，`JsCodeAuditService` 只在 `crawl.module.ts` 注册；Nest 自己也不写该 Mongo 审计集合，Go 未实现不构成行为差异。 |
| 《AUDIT.md》记的三处「既有偏差」仍在 | RD-01/RD-02/RD-03 正是那三处（详情缺 `memoryStats`/`lastRunSummary`、`stringPtrFromNull` 丢空串、媒体查库用 trim 后 orgId），本批已全部修复；AUDIT.md 该行需要更新。 |
| `applyCandidateDiscoveryMetadata` 之类助手只是「实现风格差异」 | 它是 `discoverChildNodes` 的必经包装层，Go 侧无调用者导致元数据缺失（FN-01 已修）。 |
| OPML 预设内容与 Nest 模板不一致 | 只有 1 个 preset，Go embed 文件与 Nest 模板字面量逐字节相同（14433 字节 / 92 条 feed）。 |
| OPML 解析有 billion-laughs 风险 | `encoding/xml` 不展开 DTD 实体（未定义实体直接报错→空结果），`fast-xml-parser` 也不展开；新增 `TestParseOPMLDoesNotExpandEntities` 固化。 |
| 采集源批量操作缺事务/部分失败语义 | 两侧都是单条 `UPDATE/DELETE … IN`（语句级原子），响应 `{updatedCount,requestedCount}` 逐字段一致，不存在逐条部分失败契约。 |
| 采集源有 orgId 漏过滤或鉴权映射错位 | 全部 SQL（含 count/IN/UPDATE/DELETE/快照/URL 去重）带 orgId；15 条路由的 `crawl.read`/`crawl.write` 与 Controller 装饰器逐条一致；`mtk_` 机器令牌校验语义一致。 |

## 6. 覆盖率（如实）

本窗口约 5.1 万行 Nest + 约 10 万行 Go（含测试），**没有逐行通读**。精力分配：写路径 > 鉴权/租户 > 后台任务与并发 > 读契约 > 纯格式化。

全文（双侧逐方法对照）：`crawlworker`、`crawlqueue`、crawl4ai 客户端与 payload、`crawlfrontiernode` 的节点链路、`crawlfrontierllm` 的判定/学习/生命周期、`crawlexecution` 的执行/结果/媒体/通知、`crawlmetadata` 的提取与发现链、`crawlprofile` 八条入口、`crawlworkflow`/`crawltemplate`/`crawltaskwrite`/`crawlstrategyruns`/`crawlmaintenance` 的路由与定时任务、`crawlreadtelemetry` 七条读入口、`newssources` 15 条路由、`crawlfrontierruns` 的读/写 handler 与 summary 契约。

重点（只读了列出的方法）：`crawlfrontierllm/materialize.go`（1292 行，未与 `crawl-strategy-layered-executor.service.ts` 2409 行对读）、BullMQ Lua 协议在 LLM 队列侧的等价性、`crawlworkflow/bridge.go` 各节点配置构造、`crawltemplate/dto.go` 逐字段装饰器、`crawlstrategyruns/nodes.go` 与 `frontier.go` 的数值逐条 parity、`crawl4ai/options.go`（909 行只读前 190 行与整体目录）、`graphqlread/itemsingest`（条目窗口范围）。

未审查：`crawlquality.strategy.ts` 的写侧低信号打分（属执行切片，读侧聚合已核）、`objectstorage` 包的 provider 分支与签名（基础设施窗口）、`newssourcescheduler` 的调度/dispatchNow/去重窗口（新闻窗口）、`settingscrawl` 中与 crawl 无关的其余根字段、`crawl4ai` 队列运维的 Nest 侧双实现细节。

已知证据空洞（不是「通过」）：所有修复的测试都**未在本机执行**；没有任何真实 crawl4ai / LLM / S3 / MySQL / Redis / Mongo 调用；FL-10 的行锁行为、EX-01 的 SQL、NS-01 的主机规范化只在静态层面确认，正确性由 CI 判定。

## 7. 删除 Nest 前必须确认

1. **混合模式会重新引入 #135 B1 的重复扣减**：legacy Nest 实例仍注册 QueueEvents 读取端，按事件再扣一次 `crawl:activity`。删除 Nest 后该风险消失，但**切换时必须一次性把所有实例切到 Go**（WQ-05 已在 `crawlworker/doc.go` 写明）。同理，任何残留 Nest 实例都会重新引入重复的爬取完成通知路径。
2. **只有 Nest 才写的数据**：本批确认 `js_code_audit_logs`（NP-SEC-002 审计）在 Nest 侧从未被调用，删除不丢数据；但该安全意图在两端都未实现，若合规需要，应作为新需求而非迁移缺口。`CrawlResultContent.tables` 的规范化形状目前只有 Nest 写（EX-05），删除后新写入行的 `tables` 形状会与历史行不同——读侧按原始数组解码不会报错，但 UI 的表格列（`id/rowCount/columnCount/dataFrame`）在旧行有、新行为空，需要在删 Nest 前决定是否补规范化器或调整读侧。
3. **媒体 `width/height` 列类型**：Go 写 `int32`（为迁就读侧 int 投影），Nest 历史行是 double；读侧需继续兼容两种历史值（EX 切片已标注，未改）。
4. **进程内状态**：Frontier 的 `pendingLlmJudgeJobs` 与 `llmLifecycle` 现由数据库行锁保护（FL-10），不再依赖进程内状态；但 `crawl:activity` 计数、`crawl:worker-concurrency:v1` 广播与 `news-source:list-runtime:*` 仍是跨进程共享的 Redis 契约，删除 Nest 前需确认**没有别的进程**（例如旧的调度器容器）继续写这些键。
5. **`#139` 的写接口**：已确认三条写路径的 201/权限/404 与 Nest 一致；但 FL-01 之后「已完成运行可重试、已取消运行不可重试」是 **Go 的改进**（Nest 两者都可重试），删除 Nest 后行为变化即为最终行为，Web 的批量重试提示（`crawl-frontier-console.tsx:1230-1250` 仍写「因缺少 crawlTaskId 跳过」）需要同步文案。
6. **Frontier 合成任务的运营重试链**：合成任务若丢失队列 job，会被 janitor 标失败，运营者仍可 `POST /api/crawl-tasks/:id/retry` 把它当普通任务重跑（`crawltaskwrite/service.go:320-340`；Nest `crawl-task.service.ts:597-610` 同洞）。两端一致，删除 Nest 不改变该风险，但若要收紧（`config.frontier` → 409）应在拆 Nest 前定案，否则之后没有对照基线。
7. **文档要同步**（不属于本窗口的改动范围，交给整合窗口）：`.workflow/reviews/static-audit.md` 的 C-3/C-5 对当前双侧都已过期；`docs/refactor/migration-map/AUDIT.md:98` 的三处偏差已由 RD-01/02/03 修复；`docs/refactor/go-crawl-frontier-runs.md` §5/§6 仍写 `id IN (…)` 与未加锁 appendEvent，已与实现不符；`ownership-audit.md` 的 C 类说明可保持。
8. **`newssources` 包目前没有 CI 集成步骤**，其 P2 修复只有单元测试兜底；`crawl:activity`/`news-source:list-runtime` 的真实 Redis 契约只在 `crawlworker` 与 `crawlmaintenance` 的集成用例里被间接覆盖。

## 8. 验证

- 本机：`gofmt -l` 对每个改动包为空；`git diff` 逐条复核；**未**运行 `go build`、`go test`、`pnpm`、Docker，**未**连接外部服务，**未**做实网验证。报告中的「已修复」= 代码与测试已提交且通过静态复核，不代表已运行通过。
- CI：由现有普通 workflow 执行，新增测试全部落在既有步骤内，未修改 `ci.yml`：
  - verify job 的 `go test ./...`（经 `pnpm --filter @modular/api-go test`）覆盖全部新增单元测试。
  - `internal/crawlworker/ -run 'TestCrawlWorkerIntegration'`（`ci.yml:631`）覆盖 WQ-04 的原子计数路径。
  - `internal/crawlexecution/ -run 'TestCrawlExecutionQueuedIntegration'`（`ci.yml:637`）。
  - `internal/crawlfrontiernode/ -run 'TestFrontierNode'`（`ci.yml:614`）。
  - `internal/crawlfrontierllm/ -run 'TestFrontierLlm'`（`ci.yml:515`）覆盖 FL-10 的并发合并用例。
  - `internal/crawlfrontierruns/ -run 'TestFrontierWritesIntegration'`（`ci.yml:433`）覆盖 FL-01。
  - `internal/crawlmaintenance/ -run 'TestCrawlMaintenance'`（`ci.yml:482`）覆盖 LD-01。
- 精确 head SHA 与各 job 结论见 PR 描述（CI 完成后回填）。

## 9. 后续建议

1. 专项批：EX-05（`tables` 规范化 1:1 移植）、WF-02（工作流列表批量查询 + MySQL 集成测试）、FN-03/NS-02（sitemap 诊断与快照回填，需跨包接口）、WQ-06（`userAgentGenerator`/geolocation payload）。
2. 统一 MaxLength 语义为码点（MD-03/WF-05）：需要一次全局约定 + 回归测试，不宜零散改。
3. 把 `crawltemplate`/`crawlworkflow` 的中文源码注释翻译为英文（WF-03），并逐步替换 `map[string]any` 业务载荷（WF-04/NS-08）。
4. 为 `newssources`、`crawlprofile`、`crawltemplate` 增加最小集成步骤（真实 MySQL），否则这些包的写路径只有单元测试兜底。
