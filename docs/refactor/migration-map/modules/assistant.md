# assistant · Assistant 与模型任务

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

assistantRuns、运行能力和经济序列建议三读在 Go；query/report/forecast 请求与历史删除仍为 Nest。不能把“运行能力配置可读”当成模型执行迁完。

关键数据与副作用：MySQL AssistantRun、Mongo 历史、Redis/BullMQ assistant、LiteLLM/模型、经济/地图/检索工具。配额/安全设置 HTTP 在治理域，队列消费者另列。

真实剩余缺口：deleteAssistantRun 与三个 requestAssistant* 入口（requestGeoTransportAnalysis 属于分析域）见下表，输出流 assistantEvents 与 worker 尚在 Nest。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：首次基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；14:22 MSK 最新 main [CI 39122519950](https://github.com/wei500L/newwei/actions/runs/39122519950) 已复核为 success，head 与本页3cedce9a基线一致。#68 的 PR head a1c96172 普通 CI 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

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

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
