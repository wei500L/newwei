# crawl · 采集源、模板、画像、工作流与 Frontier

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

源管理、模板四编辑、画像、工作流、运行监控取消、任务/媒体读取已接管。模板没有 GET :id 契约，不能凭迁移报告中的排除说明虚构待迁入口。源 run/schedule 是现有本地状态操作，dispatch/队列消费是另一条链。

关键数据与副作用：MySQL NewsSource/CrawlTemplate/CrawlSiteProfile/Workflow/Run/Node，Mongo 抓取结果与媒体，Redis BullMQ，crawl4ai、对象存储、LLM judge/learn。取消更新与真正入队/重放不能混为一谈。

真实剩余缺口：crawlMetadata（主动外部抓取，非纯数据库读）、任务创建/删除/重试/导入、Frontier 创建/节点重试/trial-run/replay、crawl4ai 队列管理、来源 preview 尚在 Nest；入队/worker 归异步域协同。

`crawlMetadata` 与 `POST /api/crawl-tasks/metadata`：Resolver → [CrawlMetadataService.extract](../../../../apps/api/src/modules/crawl/crawl-metadata.service.ts) → resolveUrls / fetchMetadata / fetchWithStatus；读取 sitemap 并逐 URL 请求真实网页，fetchWithStatus 包含逐跳 SSRF、重定向和超时语义。深度发现可选 crawl4ai，但普通 metadata 不是必经 crawl4ai；迁移时按真实模式保留安全约束并单列外部调用验证。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#crawl) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[crawl](../../../../apps/api/src/modules/crawl)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领与交付：[STORAGE-MEDIA-001](../tasks/STORAGE-MEDIA-001.md) 补已有媒体 HTTP 与 REST/GraphQL 详情的 S3 分支，不重迁采集 7 读。业务实现已在 `refactor/go-storage-media` 分支提交（[Ready PR #73](https://github.com/wei500L/newwei/pull/73)），补 `GET /api/crawl-media-assets/:assetId/:mode` 的 S3 presigned 302 与 `GET /api/crawl-tasks/:id`／`Query crawlTask` 的 S3 mediaAssets，并按存储配置 TTL 签名；PR 未合 main，GAP-CRAWL-001 仍开放，实桶/部署未验证。其余历史审查日期不变；旧 worktree 不自动视为活动任务。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithCrawlFrontierRuns](../../../../apps/api-go/internal/legacyproxy/crawl_frontier_runs_routes.go) | `API_GO_CRAWL_FRONTIER_RUNS_MODE` | [crawlfrontierruns](../../../../apps/api-go/internal/crawlfrontierruns) | `${API_GO_CRAWL_FRONTIER_RUNS_MODE:-legacy}` |
| [WithCrawlProfiles](../../../../apps/api-go/internal/legacyproxy/crawl_profiles_routes.go) | `API_GO_CRAWL_PROFILES_MODE` | [crawlprofile](../../../../apps/api-go/internal/crawlprofile) | `legacy` |
| [WithCrawlReadTelemetry](../../../../apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go) | `API_GO_CRAWL_READ_TELEMETRY_MODE` | [crawlreadtelemetry](../../../../apps/api-go/internal/crawlreadtelemetry) | `legacy` |
| [WithCrawlTemplates](../../../../apps/api-go/internal/legacyproxy/crawl_templates_routes.go) | `API_GO_CRAWL_TEMPLATES_MODE` | [crawltemplate](../../../../apps/api-go/internal/crawltemplate) | `legacy` |
| [WithCrawlWorkflows](../../../../apps/api-go/internal/legacyproxy/crawl_workflows_routes.go) | `API_GO_CRAWL_WORKFLOWS_MODE` | [crawlworkflow](../../../../apps/api-go/internal/crawlworkflow) | `legacy` |
| [WithNewsSources](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_NEWS_SOURCES_MODE` | [newssources](../../../../apps/api-go/internal/newssources) | `legacy` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 68：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/admin/crawl-frontier/news-sources/:id/workflow-bridge` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `getNewsSourceWorkflowBridge` | WithCrawlWorkflows |
| `GET /api/admin/crawl-frontier/nodes/:id` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `getNode` | WithCrawlFrontierRuns |
| `POST /api/admin/crawl-frontier/nodes/:id/retry` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `retryNode` | Nest；尚未接管 |
| `POST /api/admin/crawl-frontier/nodes/retry` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `retryNodes` | Nest；尚未接管 |
| `GET /api/admin/crawl-frontier/profiles` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `listProfiles` | WithCrawlProfiles |
| `POST /api/admin/crawl-frontier/profiles` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `createProfile` | WithCrawlProfiles |
| `GET /api/admin/crawl-frontier/profiles/:id` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `getProfile` | WithCrawlProfiles |
| `PATCH /api/admin/crawl-frontier/profiles/:id` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `updateProfile` | WithCrawlProfiles |
| `POST /api/admin/crawl-frontier/profiles/:id/rollback/:version` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `rollbackProfile` | WithCrawlProfiles |
| `GET /api/admin/crawl-frontier/profiles/:id/versions` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `listVersions` | WithCrawlProfiles |
| `GET /api/admin/crawl-frontier/profiles/:id/workflow-bridge` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `getProfileWorkflowBridge` | WithCrawlWorkflows |
| `GET /api/admin/crawl-frontier/profiles/match` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `matchProfile` | WithCrawlProfiles |
| `POST /api/admin/crawl-frontier/profiles/preview` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `previewProfile` | WithCrawlProfiles |
| `GET /api/admin/crawl-frontier/runs` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `listRuns` | WithCrawlFrontierRuns |
| `POST /api/admin/crawl-frontier/runs` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `createRun` | Nest；尚未接管 |
| `GET /api/admin/crawl-frontier/runs/:id` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `getRun` | WithCrawlFrontierRuns |
| `POST /api/admin/crawl-frontier/runs/:id/cancel` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `cancelRun` | WithCrawlFrontierRuns |
| `GET /api/admin/crawl-frontier/runs/:id/workflow-candidates` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `listRunWorkflowCandidates` | WithCrawlFrontierRuns |
| `GET /api/admin/crawl-frontier/runs/:id/workflow-candidates/:candidateId` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `getRunWorkflowCandidateExplanation` | WithCrawlFrontierRuns |
| `GET /api/admin/crawl-frontier/runs/:id/workflow-run` | crawl.read | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `getRunWorkflowRun` | WithCrawlFrontierRuns |
| `POST /api/admin/crawl-frontier/runs/cancel` | crawl.write | [crawl-frontier.controller.ts](../../../../apps/api/src/modules/crawl/crawl-frontier.controller.ts) · `cancelRuns` | WithCrawlFrontierRuns |
| `GET /api/admin/crawl-frontier/workflow-runs/:runId` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `getRun` | WithCrawlFrontierRuns |
| `GET /api/admin/crawl-frontier/workflow-runs/:runId/candidates` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `listRunCandidates` | WithCrawlFrontierRuns |
| `GET /api/admin/crawl-frontier/workflow-runs/:runId/candidates/:candidateId/explanation` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `getCandidateExplanation` | WithCrawlFrontierRuns |
| `POST /api/admin/crawl-frontier/workflow-runs/:runId/replay` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `replayRun` | Nest；尚未接管 |
| `GET /api/admin/crawl-frontier/workflow-versions/:versionId` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `getVersion` | WithCrawlWorkflows |
| `GET /api/admin/crawl-frontier/workflows` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `listWorkflows` | WithCrawlWorkflows |
| `POST /api/admin/crawl-frontier/workflows` | crawl.write | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `createWorkflow` | WithCrawlWorkflows |
| `GET /api/admin/crawl-frontier/workflows/:id` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `getWorkflow` | WithCrawlWorkflows |
| `PATCH /api/admin/crawl-frontier/workflows/:id/draft` | crawl.write | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `updateDraft` | WithCrawlWorkflows |
| `POST /api/admin/crawl-frontier/workflows/:id/publish` | crawl.write | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `publishWorkflow` | WithCrawlWorkflows |
| `POST /api/admin/crawl-frontier/workflows/:id/trial-run` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `trialRun` | Nest；尚未接管 |
| `GET /api/admin/crawl-frontier/workflows/:id/versions` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `listVersions` | WithCrawlWorkflows |
| `POST /api/admin/crawl-frontier/workflows/compare` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `compareVersions` | WithCrawlWorkflows |
| `GET /api/admin/crawl-frontier/workflows/node-schemas` | crawl.read | [crawl-strategy.controller.ts](../../../../apps/api/src/modules/crawl/crawl-strategy.controller.ts) · `listNodeSchemas` | WithCrawlWorkflows |
| `GET /api/admin/crawl-templates` | crawl.read | [crawl-template.controller.ts](../../../../apps/api/src/modules/crawl/crawl-template.controller.ts) · `list` | WithCrawlTemplates |
| `POST /api/admin/crawl-templates` | crawl.write | [crawl-template.controller.ts](../../../../apps/api/src/modules/crawl/crawl-template.controller.ts) · `create` | WithCrawlTemplates |
| `DELETE /api/admin/crawl-templates/:id` | crawl.write | [crawl-template.controller.ts](../../../../apps/api/src/modules/crawl/crawl-template.controller.ts) · `remove` | WithCrawlTemplates |
| `PATCH /api/admin/crawl-templates/:id` | crawl.write | [crawl-template.controller.ts](../../../../apps/api/src/modules/crawl/crawl-template.controller.ts) · `update` | WithCrawlTemplates |
| `GET /api/admin/crawl4ai/quality` | crawl.read | [crawl4ai-quality.controller.ts](../../../../apps/api/src/modules/crawl/crawl4ai-quality.controller.ts) · `getQualitySnapshot` | WithCrawlReadTelemetry |
| `GET /api/admin/crawl4ai/quality/sources/:sourceId` | crawl.read | [crawl4ai-quality.controller.ts](../../../../apps/api/src/modules/crawl/crawl4ai-quality.controller.ts) · `getSourceQualitySnapshot` | WithCrawlReadTelemetry |
| `GET /api/admin/crawl4ai/queue` | crawl.read | [crawl4ai-queue.controller.ts](../../../../apps/api/src/modules/crawl/crawl4ai-queue.controller.ts) · `getQueueStats` | Nest；尚未接管 |
| `POST /api/admin/crawl4ai/queue/concurrency` | settings.manage | [crawl4ai-queue.controller.ts](../../../../apps/api/src/modules/crawl/crawl4ai-queue.controller.ts) · `updateQueueConcurrency` | Nest；尚未接管 |
| `POST /api/admin/crawl4ai/queue/pause` | settings.manage | [crawl4ai-queue.controller.ts](../../../../apps/api/src/modules/crawl/crawl4ai-queue.controller.ts) · `pauseQueue` | Nest；尚未接管 |
| `POST /api/admin/crawl4ai/queue/resume` | settings.manage | [crawl4ai-queue.controller.ts](../../../../apps/api/src/modules/crawl/crawl4ai-queue.controller.ts) · `resumeQueue` | Nest；尚未接管 |
| `GET /api/admin/news-sources` | crawl.read | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `list` | WithNewsSources |
| `POST /api/admin/news-sources` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `create` | WithNewsSources |
| `DELETE /api/admin/news-sources/:id` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `remove` | WithNewsSources |
| `PATCH /api/admin/news-sources/:id` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `update` | WithNewsSources |
| `GET /api/admin/news-sources/:id/preview` | crawl.read | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `preview` | Nest；尚未接管 |
| `POST /api/admin/news-sources/:id/run` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `run` | WithNewsSources |
| `POST /api/admin/news-sources/:id/schedule` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `schedule` | WithNewsSources |
| `DELETE /api/admin/news-sources/batch` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `batchDelete` | WithNewsSources |
| `PATCH /api/admin/news-sources/batch/active` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `batchUpdateActive` | WithNewsSources |
| `POST /api/admin/news-sources/batch/frequency` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `batchUpdateFrequency` | WithNewsSources |
| `PATCH /api/admin/news-sources/batch/group` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `batchUpdateGroup` | WithNewsSources |
| `GET /api/admin/news-sources/groups` | crawl.read | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `listGroups` | WithNewsSources |
| `GET /api/admin/news-sources/opml-presets` | crawl.read | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `listOpmlPresets` | WithNewsSources |
| `POST /api/admin/news-sources/opml/import` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `importOpml` | WithNewsSources |
| `POST /api/admin/news-sources/opml/preview` | crawl.write | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `previewOpml` | WithNewsSources |
| `GET /api/admin/news-sources/options` | crawl.read | [news-source.controller.ts](../../../../apps/api/src/modules/crawl/news-source.controller.ts) · `listOptions` | WithNewsSources |
| `GET /api/crawl-media-assets/:assetId/:mode` | 公开 | [crawl-media-asset.controller.ts](../../../../apps/api/src/modules/crawl/crawl-media-asset.controller.ts) · `serveAsset` | WithCrawlReadTelemetry；**部分实现：S3 下发缺失，GAP-CRAWL-001** |
| `GET /api/crawl-tasks` | crawl.read | [crawl.controller.ts](../../../../apps/api/src/modules/crawl/crawl.controller.ts) · `list` | WithCrawlReadTelemetry |
| `POST /api/crawl-tasks` | crawl.write | [crawl.controller.ts](../../../../apps/api/src/modules/crawl/crawl.controller.ts) · `create` | Nest；尚未接管 |
| `DELETE /api/crawl-tasks/:id` | crawl.write | [crawl.controller.ts](../../../../apps/api/src/modules/crawl/crawl.controller.ts) · `remove` | Nest；尚未接管 |
| `GET /api/crawl-tasks/:id` | crawl.read | [crawl.controller.ts](../../../../apps/api/src/modules/crawl/crawl.controller.ts) · `detail` | WithCrawlReadTelemetry |
| `POST /api/crawl-tasks/:id/retry` | crawl.write | [crawl.controller.ts](../../../../apps/api/src/modules/crawl/crawl.controller.ts) · `retry` | Nest；尚未接管 |
| `POST /api/crawl-tasks/metadata` | crawl.read | [crawl.controller.ts](../../../../apps/api/src/modules/crawl/crawl.controller.ts) · `extractMetadata` | Nest；尚未接管 |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `createCrawlTask` | crawl.write | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `createCrawlTask` | Nest；未注册 |
| Mutation `deleteCrawlTask` | crawl.write | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `deleteCrawlTask` | Nest；未注册 |
| Mutation `ingestCrawlTaskResultsToItems` | crawl.read + items.write | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `ingestCrawlTaskResultsToItems` | Nest；未注册 |
| Mutation `retryCrawlTask` | crawl.write | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `retryCrawlTask` | Nest；未注册 |
| Mutation `updateCrawlTaskIngestToItems` | crawl.write | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `updateCrawlTaskIngestToItems` | Nest；未注册 |
| Query `crawlMetadata` | crawl.read | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `crawlMetadata` | Nest；未注册；主动外部 HTTP/sitemap |
| Query `crawlTask` | crawl.read | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `crawlTask` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `crawlTasks` | crawl.read | [crawl.resolver.ts](../../../../apps/api/src/graphql/resolvers/crawl.resolver.ts) · `crawlTasks` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |

## 已注册范围的具体例外

媒体下发 MySQL blob 与 S3 分支已沿 Nest/Go 复核；S3 资产合法签名也会404，见 [GAP-CRAWL-001](../GAPS.md#gap-crawl-001)。不把存储未配置或合法无资产误作同类问题，原 #50 merged 历史保留。

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#35](https://github.com/wei500L/newwei/pull/35) | [d21f70216201](https://github.com/wei500L/newwei/commit/d21f702162019fa879f466f8c5953798e365be3f) | ✨ feat(api-go): 用开关接管新闻源管理台 |
| [#36](https://github.com/wei500L/newwei/pull/36) | [6c22f1ed4502](https://github.com/wei500L/newwei/commit/6c22f1ed4502ec09cfc1ce431416840b8a74070d) | ✨ feat(api-go): 用开关接管采集策略工作流编辑接口 |
| [#37](https://github.com/wei500L/newwei/pull/37) | [27099ce2cd3a](https://github.com/wei500L/newwei/commit/27099ce2cd3a2af3e1c18ee774a233c4785b9ec1) | ✨ feat(api-go): 用开关接管采集站点画像编辑接口 |
| [#38](https://github.com/wei500L/newwei/pull/38) | [55fe3744589d](https://github.com/wei500L/newwei/commit/55fe3744589dd153e22ec29d1c9bff33fb305103) | ✨ feat(api-go): 采集模板 4 条接口迁移到 Go（默认 legacy） |
| [#50](https://github.com/wei500L/newwei/pull/50) | [b0e4c178b2af](https://github.com/wei500L/newwei/commit/b0e4c178b2af54ea6a72f4555973e011877f0e88) | ✨ feat(api-go): 采集只读、媒体下发与检索遥测迁入 7 条接口（默认 legacy） |
| [#52](https://github.com/wei500L/newwei/pull/52) | [b89c35a85998](https://github.com/wei500L/newwei/commit/b89c35a85998512392e32566ccd96b2766f65441) | ✨ feat(api-go): 迁入设置中心/来源策略/复核队列/采集任务 20 个 GraphQL 只读 root（API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE） |
| [#53](https://github.com/wei500L/newwei/pull/53) | [2672b62e35ed](https://github.com/wei500L/newwei/commit/2672b62e35ed7235604c65939bcd335c81bf7d27) | ✨ feat(api-go): 采集 Frontier 运行监控与取消 11 条接口迁入 Go（API_GO_CRAWL_FRONTIER_RUNS_MODE，默认 legacy） |

- [docs/refactor/go-crawl-templates.md](../../go-crawl-templates.md)

- [docs/refactor/go-crawl-profiles.md](../../go-crawl-profiles.md)

- [docs/refactor/go-crawl-workflows.md](../../go-crawl-workflows.md)

- [docs/refactor/go-crawl-frontier-runs.md](../../go-crawl-frontier-runs.md)

- [docs/refactor/go-crawl-read-telemetry.md](../../go-crawl-read-telemetry.md)

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
