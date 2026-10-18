# settings · 设置中心与平台治理

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

运行时/限流/审计保留等 HTTP、平台安全/配额/日志治理 HTTP，以及设置 GraphQL 读均已有 Go。13 个设置写已通过 #68 合入，独立开关接线仍有具体缺口；来源策略四写不在该批。模型/网关、基础设施/数据运行 HTTP 分别见专属域。

关键数据与副作用：MySQL SystemSetting、Redis crawl_client:settings / audit_log:retention_days / auth 与限流缓存，Mongo 日志保留配置；分类 taxonomy/去重规则规范化影响新闻流水线读取。

真实剩余缺口：13 个设置 Mutation 已在 main 注册，禁止重新派发整批；来源策略 update/reset/rollback/presets 四写仍为 Nest，可作为独立候选但必须检查 revision、事务与同步副作用。SMTP 测试、assistant 安全 diagnostics 等外部/诊断入口仍有缺口。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#settings) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[system-settings](../../../../apps/api/src/modules/system-settings)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

历史任务：[SETTINGS-WRITE-001](../tasks/SETTINGS-WRITE-001.md)（merged；#68 于 14:15 MSK 合入 main，尚有独立写接线缺口，不能把任务 merged 等同完全可独立启用）。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithClassificationRssOps](../../../../apps/api-go/internal/legacyproxy/classification_rss_ops_routes.go) | `API_GO_CLASSIFICATION_RSS_OPS_MODE` | [classificationrssops](../../../../apps/api-go/internal/classificationrssops) | `legacy` |
| [WithPlatformGovernanceSettings](../../../../apps/api-go/internal/legacyproxy/platform_governance_settings_routes.go) | `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE` | [platformgovernance](../../../../apps/api-go/internal/platformgovernance) | `${API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE:-legacy}` |
| [WithRuntimeSettings](../../../../apps/api-go/internal/legacyproxy/runtime_settings_routes.go) | `API_GO_RUNTIME_SETTINGS_MODE` | [runtimesettings](../../../../apps/api-go/internal/runtimesettings) | `legacy` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 43：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `DELETE /api/system-settings/assistant-quota` | settings.manage；handler 平台管理员 | [assistant-quota-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-quota-settings.controller.ts) · `reset` | WithPlatformGovernanceSettings |
| `GET /api/system-settings/assistant-quota` | settings.manage | [assistant-quota-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-quota-settings.controller.ts) · `getSettings` | WithPlatformGovernanceSettings |
| `PUT /api/system-settings/assistant-quota` | settings.manage；handler 平台管理员 | [assistant-quota-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-quota-settings.controller.ts) · `updateSettings` | WithPlatformGovernanceSettings |
| `DELETE /api/system-settings/assistant-safety` | settings.manage；handler 平台管理员 | [assistant-safety-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts) · `reset` | WithPlatformGovernanceSettings |
| `GET /api/system-settings/assistant-safety` | settings.manage | [assistant-safety-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts) · `getSettings` | WithPlatformGovernanceSettings |
| `PUT /api/system-settings/assistant-safety` | settings.manage；handler 平台管理员 | [assistant-safety-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts) · `updateSettings` | WithPlatformGovernanceSettings |
| `GET /api/system-settings/assistant-safety/diagnostics` | settings.manage | [assistant-safety-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts) · `runDiagnostics` | Nest；尚未接管 |
| `GET /api/system-settings/assistant-safety/metrics` | settings.manage | [assistant-safety-settings.controller.ts](../../../../apps/api/src/modules/system-settings/assistant-safety-settings.controller.ts) · `getMetrics` | WithPlatformGovernanceSettings |
| `GET /api/system-settings/audit-log` | settings.manage | [audit-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/audit-log-settings.controller.ts) · `getRetention` | WithRuntimeSettings |
| `PUT /api/system-settings/audit-log` | settings.manage；handler 平台管理员 | [audit-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/audit-log-settings.controller.ts) · `updateRetention` | WithRuntimeSettings |
| `GET /api/system-settings/auth-cache` | settings.manage | [auth-cache-settings.controller.ts](../../../../apps/api/src/modules/system-settings/auth-cache-settings.controller.ts) · `getSettings` | WithRuntimeSettings |
| `PUT /api/system-settings/auth-cache` | settings.manage | [auth-cache-settings.controller.ts](../../../../apps/api/src/modules/system-settings/auth-cache-settings.controller.ts) · `updateSettings` | WithRuntimeSettings |
| `GET /api/system-settings/email` | settings.manage | [email-settings.controller.ts](../../../../apps/api/src/modules/system-settings/email-settings.controller.ts) · `getStatus` | Nest；尚未接管 |
| `PUT /api/system-settings/email/auth-code` | settings.manage；handler 平台管理员 | [email-settings.controller.ts](../../../../apps/api/src/modules/system-settings/email-settings.controller.ts) · `updateAuthCodeSettings` | Nest；尚未接管 |
| `POST /api/system-settings/email/test` | settings.manage | [email-settings.controller.ts](../../../../apps/api/src/modules/system-settings/email-settings.controller.ts) · `test` | Nest；尚未接管 |
| `DELETE /api/system-settings/llm-request-logs` | settings.manage；handler 平台管理员 | [llm-request-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts) · `reset` | WithPlatformGovernanceSettings |
| `GET /api/system-settings/llm-request-logs` | settings.manage | [llm-request-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts) · `getSettings` | WithPlatformGovernanceSettings |
| `PUT /api/system-settings/llm-request-logs` | settings.manage；handler 平台管理员 | [llm-request-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts) · `updateSettings` | WithPlatformGovernanceSettings |
| `POST /api/system-settings/llm-request-logs/metadata-policy/reset` | settings.manage；handler 平台管理员 | [llm-request-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-request-log-settings.controller.ts) · `resetMetadataPolicy` | WithPlatformGovernanceSettings |
| `GET /api/system-settings/multi-tenant-schedulers` | settings.manage | [multi-tenant-scheduler-settings.controller.ts](../../../../apps/api/src/modules/system-settings/multi-tenant-scheduler-settings.controller.ts) · `getSettings` | WithRuntimeSettings |
| `PUT /api/system-settings/multi-tenant-schedulers` | settings.manage | [multi-tenant-scheduler-settings.controller.ts](../../../../apps/api/src/modules/system-settings/multi-tenant-scheduler-settings.controller.ts) · `updateSettings` | WithRuntimeSettings |
| `GET /api/system-settings/news-source-scheduler` | settings.manage | [news-source-scheduler-settings.controller.ts](../../../../apps/api/src/modules/system-settings/news-source-scheduler-settings.controller.ts) · `getSettings` | WithRuntimeSettings |
| `PUT /api/system-settings/news-source-scheduler` | settings.manage | [news-source-scheduler-settings.controller.ts](../../../../apps/api/src/modules/system-settings/news-source-scheduler-settings.controller.ts) · `updateSettings` | WithRuntimeSettings |
| `GET /api/system-settings/newsnow-personalization` | settings.manage | [newsnow-personalization-settings.controller.ts](../../../../apps/api/src/modules/system-settings/newsnow-personalization-settings.controller.ts) · `getSettings` | WithRuntimeSettings |
| `PUT /api/system-settings/newsnow-personalization` | settings.manage | [newsnow-personalization-settings.controller.ts](../../../../apps/api/src/modules/system-settings/newsnow-personalization-settings.controller.ts) · `updateSettings` | WithRuntimeSettings |
| `GET /api/system-settings/newsnow-personalization/metrics` | settings.manage | [newsnow-personalization-settings.controller.ts](../../../../apps/api/src/modules/system-settings/newsnow-personalization-settings.controller.ts) · `getRuntimeMetrics` | WithRuntimeSettings |
| `GET /api/system-settings/rate-limit-policies` | settings.manage | [rate-limit-policy.controller.ts](../../../../apps/api/src/modules/system-settings/rate-limit-policy.controller.ts) · `list` | WithRuntimeSettings |
| `POST /api/system-settings/rate-limit-policies` | settings.manage | [rate-limit-policy.controller.ts](../../../../apps/api/src/modules/system-settings/rate-limit-policy.controller.ts) · `create` | WithRuntimeSettings |
| `DELETE /api/system-settings/rate-limit-policies/:feature` | settings.manage | [rate-limit-policy.controller.ts](../../../../apps/api/src/modules/system-settings/rate-limit-policy.controller.ts) · `remove` | WithRuntimeSettings |
| `GET /api/system-settings/rate-limit-policies/:feature` | settings.manage | [rate-limit-policy.controller.ts](../../../../apps/api/src/modules/system-settings/rate-limit-policy.controller.ts) · `get` | WithRuntimeSettings |
| `PUT /api/system-settings/rate-limit-policies/:feature` | settings.manage | [rate-limit-policy.controller.ts](../../../../apps/api/src/modules/system-settings/rate-limit-policy.controller.ts) · `update` | WithRuntimeSettings |
| `GET /api/system-settings/rate-limits` | settings.manage | [rate-limit-settings.controller.ts](../../../../apps/api/src/modules/system-settings/rate-limit-settings.controller.ts) · `getSettings` | WithRuntimeSettings |
| `PUT /api/system-settings/rate-limits` | settings.manage | [rate-limit-settings.controller.ts](../../../../apps/api/src/modules/system-settings/rate-limit-settings.controller.ts) · `updateSettings` | WithRuntimeSettings |
| `POST /api/system-settings/rss-diagnostics/backfill-source-id` | settings.manage | [rss-diagnostics.controller.ts](../../../../apps/api/src/modules/system-settings/rss-diagnostics.controller.ts) · `backfillSourceId` | WithClassificationRssOps |
| `GET /api/system-settings/rss-diagnostics/chain` | settings.manage | [rss-diagnostics.controller.ts](../../../../apps/api/src/modules/system-settings/rss-diagnostics.controller.ts) · `getChainSummary` | WithClassificationRssOps |
| `GET /api/system-settings/rss-diagnostics/overview` | settings.manage | [rss-diagnostics.controller.ts](../../../../apps/api/src/modules/system-settings/rss-diagnostics.controller.ts) · `getOverview` | WithClassificationRssOps |
| `GET /api/system-settings/rss-diagnostics/sources` | settings.manage | [rss-diagnostics.controller.ts](../../../../apps/api/src/modules/system-settings/rss-diagnostics.controller.ts) · `getSourceDetails` | WithClassificationRssOps |
| `GET /api/system-settings/rss-translation/metrics` | settings.manage | [rss-translation-metrics.controller.ts](../../../../apps/api/src/modules/system-settings/rss-translation-metrics.controller.ts) · `getMetrics` | WithClassificationRssOps |
| `GET /api/system-settings/security` | settings.manage | [system-security-settings.controller.ts](../../../../apps/api/src/modules/system-settings/system-security-settings.controller.ts) · `getSettings` | WithPlatformGovernanceSettings |
| `PUT /api/system-settings/security` | settings.manage；handler 平台管理员 | [system-security-settings.controller.ts](../../../../apps/api/src/modules/system-settings/system-security-settings.controller.ts) · `updateSettings` | WithPlatformGovernanceSettings |
| `DELETE /api/system-settings/task-logs` | settings.manage；handler 平台管理员 | [task-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/task-log-settings.controller.ts) · `reset` | WithPlatformGovernanceSettings |
| `GET /api/system-settings/task-logs` | settings.manage | [task-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/task-log-settings.controller.ts) · `getSettings` | WithPlatformGovernanceSettings |
| `PUT /api/system-settings/task-logs` | settings.manage；handler 平台管理员 | [task-log-settings.controller.ts](../../../../apps/api/src/modules/system-settings/task-log-settings.controller.ts) · `updateSettings` | WithPlatformGovernanceSettings |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `resetNewsEventSourcePolicy` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `resetNewsEventSourcePolicy` | Nest；未注册 |
| Mutation `rollbackNewsEventSourcePolicy` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `rollbackNewsEventSourcePolicy` | Nest；未注册 |
| Mutation `updateAuditLogRetention` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateAuditLogRetention` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateAuthCacheSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateAuthCacheSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateClassificationQualitySettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateClassificationQualitySettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateCrawlClientSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateCrawlClientSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateEntityImpactGraphSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateEntityImpactGraphSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateKnowledgeGraphSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateKnowledgeGraphSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateNewsClassificationSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsClassificationSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateNewsDedupeSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsDedupeSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateNewsEventSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsEventSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateNewsEventSourcePolicy` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsEventSourcePolicy` | Nest；未注册 |
| Mutation `updateNewsEventSourcePolicyPresets` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsEventSourcePolicyPresets` | Nest；未注册 |
| Mutation `updateNewsExtractionSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsExtractionSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateNewsIndicatorSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsIndicatorSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateNewsPromptConfig` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsPromptConfig` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Mutation `updateRateLimitSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateRateLimitSettings` | [settingswrite.Register](../../../../apps/api-go/internal/graphqlread/settingswrite/service.go)；`SETTINGS_WRITE=go` 且当前顶层需 `READ=go OR ORG_ACCESS_WRITE=go`；独立模式缺口见下 |
| Query `auditLogRetention` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `auditLogRetention` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `authCacheSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `authCacheSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `classificationQualitySettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `classificationQualitySettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `crawlClientSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `crawlClientSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `entityImpactGraphSettings` | dashboards.read | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `entityImpactGraphSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `knowledgeGraphSettings` | dashboards.read | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `knowledgeGraphSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsClassificationSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsClassificationSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsDedupeSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsDedupeSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsEventSettings` | dashboards.read | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsEventSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsEventSourcePolicy` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsEventSourcePolicy` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsEventSourcePolicyPresets` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsEventSourcePolicyPresets` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsEventSourcePolicyRevisionDiff` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsEventSourcePolicyRevisionDiff` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsExtractionSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsExtractionSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsIndicatorSettings` | dashboards.read | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsIndicatorSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `newsPromptConfig` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `newsPromptConfig` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |
| Query `rateLimitSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `rateLimitSettings` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |

## 设置写已合并与独立启用缺口

13 写与 settingscrawl 共享模型/规范化、SystemSetting 与 Redis 已随 #68 合入；本轮沿主路径静态核对，逐字段/运行验证范围见 AUDIT。独立路由与资源条件仍漏接，详见 [GAP-GQL-001](../GAPS.md#gap-gql-001) 和 [GraphQL 组合](graphql-runtime.md#本轮有意义的组合复核)。#70 14:49 head 200ab944 虽已同步 #68、补设置写鉴权资源 OR，路由 OR 仍漏设置写；未合入前不改变 main 结论。只规划最小接线修复，不重新迁整批13写。

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#47](https://github.com/wei500L/newwei/pull/47) | [7b6703f53d37](https://github.com/wei500L/newwei/commit/7b6703f53d37417297dd5bb1bbc4656b5d1a5c7c) | ✨ feat(api-go): 运行时与治理设置 18 条接口迁入 Go（API_GO_RUNTIME_SETTINGS_MODE，默认 legacy） |
| [#52](https://github.com/wei500L/newwei/pull/52) | [b89c35a85998](https://github.com/wei500L/newwei/commit/b89c35a85998512392e32566ccd96b2766f65441) | ✨ feat(api-go): 迁入设置中心/来源策略/复核队列/采集任务 20 个 GraphQL 只读 root（API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE） |
| [#54](https://github.com/wei500L/newwei/pull/54) | [6c3ddfb1ce55](https://github.com/wei500L/newwei/commit/6c3ddfb1ce55e89bed1886167bb6c7d44ea42c30) | ✨ feat(api-go): 平台治理设置 16 条接口迁入 Go（默认 legacy）+ 修 SEC-05/TTL-01/CONC-01 |

- [docs/refactor/go-runtime-settings.md](../../go-runtime-settings.md)

- [docs/refactor/go-platform-governance-settings.md](../../go-platform-governance-settings.md)

- [docs/refactor/go-graphql-settings-crawl-read.md](../../go-graphql-settings-crawl-read.md)

- [#68 合并提交 3cedce9aa320](https://github.com/wei500L/newwei/commit/3cedce9aa3200436aba3596f63b559de5490cec8)；[设置写迁移报告](../../go-graphql-settings-write.md)。

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。

本文 SETTINGS_WRITE / READ / ORG_ACCESS_WRITE 是 `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` / `API_GO_GRAPHQL_READ_MODE` / `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` 的简写，所有组合以当前 main.run 实际接线为准。
