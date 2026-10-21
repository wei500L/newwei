# assistant · Assistant 与模型任务

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

**覆盖更新（2026-10-21，基线 `dcbe563b`，更新至 #136）**：HTTP **—**、Query **3/3**、Mutation **4/4**（Go 注册/分母，C 类 0 条）；3 个读 root 与 4 个写 root（提交/报告/预测/删除）已注册；本域无主 API HTTP；剩余 Nest root 0 条（worker 执行权见 async-runtime）。旧行为 `91e759b4`/`3cedce9a` 快照（Query 3/3、Mutation 0/4），差值即 #92–#136 的注册与接线增量；分子口径为“存在 `API_GO_*` 开关且 Go 规则/处理器/Register 就位”，**不是部署启用**。对账与 C 类清单见 [README 覆盖表](../README.md#注册覆盖) 与 [执行权审计](../../cutover/ownership-audit.md)。

## 范围与实施状态

assistantRuns、运行能力和经济序列建议三读在 Go；query/report/forecast 请求与历史删除仍为 Nest。不能把“运行能力配置可读”当成模型执行迁完。

关键数据与副作用：MySQL AssistantRun、Mongo 历史、Redis/BullMQ assistant、LiteLLM/模型、经济/地图/检索工具。配额/安全设置 HTTP 在治理域，队列消费者另列。

真实剩余缺口：deleteAssistantRun 与三个 requestAssistant* 入口（requestGeoTransportAnalysis 属于分析域）见下表，输出流 assistantEvents 与 worker 尚在 Nest。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#assistant) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[assistant](../../../../apps/api/src/modules/assistant)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `deleteAssistantRun` | assistant.run | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `deleteAssistantRun` | Nest；未注册 |
| Mutation `requestAssistantForecast` | assistant.run | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `requestAssistantForecast` | Nest；未注册 |
| Mutation `requestAssistantQuery` | assistant.run | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `requestAssistantQuery` | Nest；未注册 |
| Mutation `requestAssistantReport` | assistant.run | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `requestAssistantReport` | Nest；未注册 |
| Query `assistantEconomicSeriesSuggestions` | assistant.run | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `assistantEconomicSeriesSuggestions` | [history.Register](../../../../apps/api-go/internal/graphqlread/history/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `assistantRuns` | assistant.read | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `assistantRuns` | [history.Register](../../../../apps/api-go/internal/graphqlread/history/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Query `assistantRuntimeCapabilities` | assistant.read | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `assistantRuntimeCapabilities` | [history.Register](../../../../apps/api-go/internal/graphqlread/history/register.go)；`API_GO_GRAPHQL_READ_MODE` |
| Subscription `assistantEvents` | assistant.read | [assistant.resolver.ts](../../../../apps/api/src/graphql/resolvers/assistant.resolver.ts) · `assistantEventsSubscription` | Nest Redis backplane；Go 整份回退 |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#32](https://github.com/wei500L/newwei/pull/32) | [7d25a90a03c8](https://github.com/wei500L/newwei/commit/7d25a90a03c8924b637b816595d08c15bcd320dd) | ✨ feat(api-go): GraphQL 读查询试点接管告警、历史与经济数据 |

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
