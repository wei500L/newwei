# knowledge · 知识图谱、实体情报与影响传播

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

图谱六读、冲击与实体影响四读，以及证据复核队列 Query 已注册；证据 review 写未注册。设置 root 归设置中心，避免双计。

关键数据与副作用：MySQL KnowledgeEntity/图边/证据/文章、Mongo 处理结果、Redis；图谱 ingestion Cron 和抽取/向量上游仍在 Nest。影响计算读取经济时间序列。

真实剩余缺口：reviewKnowledgeGraphEvidence Mutation 与图谱摄取 Cron 尚未迁；精确根权限及 OR 权限见下表，不能只保留根权限而漏掉返回字段授权。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：首次基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；14:22 MSK 最新 main [CI 39122519950](https://github.com/wei500L/newwei/actions/runs/39122519950) 已复核为 success，head 与本页3cedce9a基线一致。#68 的 PR head a1c96172 普通 CI 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[knowledge-graph](../../../../apps/api/src/modules/knowledge-graph)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `reviewKnowledgeGraphEvidence` | settings.manage OR knowledgegraph.review | [knowledge-graph-review.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph-review.resolver.ts) · `reviewKnowledgeGraphEvidence` | Nest；未注册 |
| Query `articleEntityLinks` | items.read | [knowledge-graph.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph.resolver.ts) · `articleEntityLinks` | [knowledgegraph.Register](../../../../apps/api-go/internal/graphqlread/knowledgegraph/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` |
| Query `entityIntelligenceCard` | dashboards.read | [entity-intelligence.resolver.ts](../../../../apps/api/src/graphql/resolvers/entity-intelligence.resolver.ts) · `entityIntelligenceCard` | [knowledgegraph.Register](../../../../apps/api-go/internal/graphqlread/knowledgegraph/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` |
| Query `entityIntelligenceEvidence` | dashboards.read | [entity-intelligence.resolver.ts](../../../../apps/api/src/graphql/resolvers/entity-intelligence.resolver.ts) · `entityIntelligenceEvidence` | [knowledgegraph.Register](../../../../apps/api-go/internal/graphqlread/knowledgegraph/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` |
| Query `getCommodityMoveImpact` | dashboards.read | [knowledge-graph-impact.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph-impact.resolver.ts) · `getCommodityMoveImpact` | [kgimpact.Register](../../../../apps/api-go/internal/graphqlread/kgimpact/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KG_IMPACT_MODE` |
| Query `getEntityImpactGraph` | dashboards.read | [entity-impact-graph.resolver.ts](../../../../apps/api/src/graphql/resolvers/entity-impact-graph.resolver.ts) · `getEntityImpactGraph` | [kgimpact.Register](../../../../apps/api-go/internal/graphqlread/kgimpact/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KG_IMPACT_MODE` |
| Query `getExecutiveChangeImpact` | dashboards.read | [knowledge-graph-impact.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph-impact.resolver.ts) · `getExecutiveChangeImpact` | [kgimpact.Register](../../../../apps/api-go/internal/graphqlread/kgimpact/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KG_IMPACT_MODE` |
| Query `getKnowledgeGraphSubgraph` | dashboards.read | [knowledge-graph.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph.resolver.ts) · `getKnowledgeGraphSubgraph` | [knowledgegraph.Register](../../../../apps/api-go/internal/graphqlread/knowledgegraph/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` |
| Query `getPolicyEventImpact` | dashboards.read | [knowledge-graph-impact.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph-impact.resolver.ts) · `getPolicyEventImpact` | [kgimpact.Register](../../../../apps/api-go/internal/graphqlread/kgimpact/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KG_IMPACT_MODE` |
| Query `knowledgeEntityByName` | dashboards.read | [entity-intelligence.resolver.ts](../../../../apps/api/src/graphql/resolvers/entity-intelligence.resolver.ts) · `knowledgeEntityByName` | [knowledgegraph.Register](../../../../apps/api-go/internal/graphqlread/knowledgegraph/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` |
| Query `knowledgeGraphEdgeEvidence` | items.read | [knowledge-graph.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph.resolver.ts) · `knowledgeGraphEdgeEvidence` | [knowledgegraph.Register](../../../../apps/api-go/internal/graphqlread/knowledgegraph/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` |
| Query `knowledgeGraphEvidenceReviewQueue` | settings.manage OR knowledgegraph.review | [knowledge-graph-review.resolver.ts](../../../../apps/api/src/graphql/resolvers/knowledge-graph-review.resolver.ts) · `knowledgeGraphEvidenceReviewQueue` | [settingscrawl.Register](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#44](https://github.com/wei500L/newwei/pull/44) | [8271f265a02a](https://github.com/wei500L/newwei/commit/8271f265a02ac59a962d7b0fd5d9d1c8e0923a8e) | 🧠 feat(knowledge-graph): 迁移知识图谱与实体 360 的六个 GraphQL 读查询 |
| [#46](https://github.com/wei500L/newwei/pull/46) | [a80d394539c3](https://github.com/wei500L/newwei/commit/a80d394539c3ff84174b7d8db239016847e7e99c) | ✨ feat(api-go): 迁入知识图谱冲击传导与实体相关图 GraphQL 读 |
| [#52](https://github.com/wei500L/newwei/pull/52) | [b89c35a85998](https://github.com/wei500L/newwei/commit/b89c35a85998512392e32566ccd96b2766f65441) | ✨ feat(api-go): 迁入设置中心/来源策略/复核队列/采集任务 20 个 GraphQL 只读 root（API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE） |

- [docs/refactor/go-knowledge-graph-read.md](../../go-knowledge-graph-read.md)

- [docs/refactor/go-kg-impact-read.md](../../go-kg-impact-read.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
