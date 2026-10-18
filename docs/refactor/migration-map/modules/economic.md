# economic · 经济数据与 AkShare

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

经济数据六 Query 是 Go 直接数据库读；AkShare 管理升级和数据抓取/配置写仍为 Nest。共享全局经济数据不按 org 过滤，权限检查仍必须存在。

关键数据与副作用：MySQL EconomicDataItem/Point/FetchConfig，Redis/BullMQ akshare-data，AkShare HTTP。AkshareService.onModuleInit 会 ensureCatalog/ensureRepeatableJobs；updateFetchConfig 写库后调用 ensureRepeatableJobs，不能当普通配置 CRUD。

真实剩余缺口：updateEconomicDataFetchConfig、triggerDataFetch、triggerEconomicDataRefreshPreset 以及 admin 升级/status/version 尚在 Nest；AkShare 与 repeat scheduler 本次无实网验证。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#economic) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[akshare](../../../../apps/api/src/modules/akshare)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## 精确 HTTP 清单

分母 3：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/admin/akshare/status` | settings.manage | [admin-akshare.controller.ts](../../../../apps/api/src/modules/akshare/admin-akshare.controller.ts) · `status` | Nest；尚未接管 |
| `POST /api/admin/akshare/upgrade` | settings.manage | [admin-akshare.controller.ts](../../../../apps/api/src/modules/akshare/admin-akshare.controller.ts) · `upgrade` | Nest；尚未接管 |
| `GET /api/admin/akshare/version` | settings.manage | [admin-akshare.controller.ts](../../../../apps/api/src/modules/akshare/admin-akshare.controller.ts) · `version` | Nest；尚未接管 |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `triggerDataFetch` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `triggerDataFetch` | Nest；未注册 |
| Mutation `triggerEconomicDataRefreshPreset` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `triggerEconomicDataRefreshPreset` | Nest；未注册 |
| Mutation `updateEconomicDataFetchConfig` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `updateEconomicDataFetchConfig` | Nest；未注册 |
| Query `economicDataFetchConfigs` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `economicDataFetchConfigs` | [economic.Register](../../../../apps/api-go/internal/graphqlread/economic/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `economicDataRefreshPresetStatus` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `economicDataRefreshPresetStatus` | [economic.Register](../../../../apps/api-go/internal/graphqlread/economic/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `getEconomicData` | economicdata.read | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `getEconomicData` | [economic.Register](../../../../apps/api-go/internal/graphqlread/economic/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `getEconomicDataInsights` | economicdata.read | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `getEconomicDataInsights` | [economic.Register](../../../../apps/api-go/internal/graphqlread/economic/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `getEconomicDataPaginated` | economicdata.read | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `getEconomicDataPaginated` | [economic.Register](../../../../apps/api-go/internal/graphqlread/economic/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `getEconomicDataWithInsights` | economicdata.read | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `getEconomicDataWithInsights` | [economic.Register](../../../../apps/api-go/internal/graphqlread/economic/register.go)；`API_GO_GRAPHQL_READ_MODE` |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#32](https://github.com/wei500L/newwei/pull/32) | [7d25a90a03c8](https://github.com/wei500L/newwei/commit/7d25a90a03c8924b637b816595d08c15bcd320dd) | ✨ feat(api-go): GraphQL 读查询试点接管告警、历史与经济数据 |

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
