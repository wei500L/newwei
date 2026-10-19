# economic · 经济数据与 AkShare

最近核对：2026-10-19 23:50 MSK（UTC+03:00），经济数据 Go 所有权分支 `refactor/go-economic-data`（基线 `origin/main 91e759b449c4511dc96d86539ea0eb258754d07e`）。该批尚未合入 main，下表“Go 实现”是待合并实现事实。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

经济数据六 Query 是 Go 直接数据库读，本批不重写。新分支增加默认 legacy 的 `API_GO_ECONOMIC_DATA_MODE` 与 `API_GO_ECONOMIC_DATA_WORKER_MODE`：请求开关接管三个 Mutation 与三条 AkShare 管理 HTTP；worker 开关接管目录/重复任务同步与 `akshare-data` 唯一消费。两个开关独立，worker=go 时 Nest 跳过 `ensureCatalog`/`ensureRepeatableJobs` 且不创建 Worker。共享全局经济数据不按 org 过滤，权限检查仍必须存在。

关键数据与副作用：MySQL EconomicDataItem/ItemCategory/Category/Point/FetchConfig，Redis/BullMQ akshare-data，Mongo EconomicProviderResponse/AkshareResponse，AkShare/Finnhub/FRED/Yahoo HTTP。Go worker 按 provider 失败契约写 fetch config 状态；prefetch 配置错误归档 skipped 后成功结束 job。详见 [go-economic-data](../../go-economic-data.md)。

真实剩余缺口：本批未实网验证 AkShare、Finnhub、FRED、Yahoo、生产 Redis 与升级后的网关进程；`origin/main` 仍没有这些 Go 入口，待 PR 合并。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#economic) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[akshare](../../../../apps/api/src/modules/akshare)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：[PR #99](https://github.com/wei500L/newwei/pull/99)，分支 `refactor/go-economic-data`，head `084387d4fff9ef69c53097989baf7eb0763417f6`，Ready 未合并；普通 CI [39318891222](https://github.com/wei500L/newwei/actions/runs/39318891222) 在该 head 成功，两个 regen job 为 skipped（不是测试通过）。旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## 精确 HTTP 清单

分母 3：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/admin/akshare/status` | settings.manage | [admin-akshare.controller.ts](../../../../apps/api/src/modules/akshare/admin-akshare.controller.ts) · `status` | Go `economicdata.AdminHandler`；`API_GO_ECONOMIC_DATA_MODE=go`（分支待合并） |
| `POST /api/admin/akshare/upgrade` | settings.manage | [admin-akshare.controller.ts](../../../../apps/api/src/modules/akshare/admin-akshare.controller.ts) · `upgrade` | Go `economicdata.AdminHandler`；`API_GO_ECONOMIC_DATA_MODE=go`（分支待合并） |
| `GET /api/admin/akshare/version` | settings.manage | [admin-akshare.controller.ts](../../../../apps/api/src/modules/akshare/admin-akshare.controller.ts) · `version` | Go `economicdata.AdminHandler`；`API_GO_ECONOMIC_DATA_MODE=go`（分支待合并） |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `triggerDataFetch` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `triggerDataFetch` | `graphqlread/economicdata.Register`；`API_GO_ECONOMIC_DATA_MODE=go`（分支待合并） |
| Mutation `triggerEconomicDataRefreshPreset` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `triggerEconomicDataRefreshPreset` | `graphqlread/economicdata.Register`；`API_GO_ECONOMIC_DATA_MODE=go`（分支待合并） |
| Mutation `updateEconomicDataFetchConfig` | economicdata.manage | [economic-data.resolver.ts](../../../../apps/api/src/graphql/resolvers/economic-data.resolver.ts) · `updateEconomicDataFetchConfig` | `graphqlread/economicdata.Register`；`API_GO_ECONOMIC_DATA_MODE=go`（分支待合并） |
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
