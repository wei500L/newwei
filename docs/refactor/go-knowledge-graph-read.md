# Go-批9 知识图谱与实体 360 情报 GraphQL 读查询

基线是 GraphQL 新闻事件读查询合并后的 `e8ae45b5e27213481e9db56c6c16bcb701b86fc8`（PR #42）。`API_GO_GRAPHQL_READ_MODE` 默认 `legacy`，启动日志里的 16 个 query 只计既有试点。知识图谱的六个 root 另看 `API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE`，默认 `legacy`，非法值启动失败。两个都是 `go` 才登记；读查询为 `legacy` 时不另挂 `/graphql`。知识图谱为 `legacy` 时，含这六个 root 的文档整包回 NestJS。生产 Web 仍指向 NestJS，canary 关闭。回滚只把 `API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` 改回 `legacy`。

真实栈工作流：`.github/workflows/api-go-knowledge-graph-read-smoke.yml`（label `api-go-knowledge-graph-read-smoke`，也用 `workflow_dispatch` 跑过）。在 commit `f51907b1` 上：普通 CI run `39025210725` success；smoke run `39025670484`（label 触发）success。

## 迁入的 root

orgId 和权限都来自服务端 membership 重推导，不读 JWT 的 orgId 或 permissions。`mtk_` 机器令牌沿用 GraphQL 读执行器既有规则拒绝。

| Root | 权限 | 参数 |
| --- | --- | --- |
| `getKnowledgeGraphSubgraph` | `dashboards.read` | `input: KnowledgeGraphSubgraphInput!` |
| `articleEntityLinks` | `items.read` | `articleId: String!, limit: Int` |
| `knowledgeGraphEdgeEvidence` | `items.read` | `edgeId: String!, limit: Int` |
| `entityIntelligenceCard` | `dashboards.read` | `input: EntityIntelligenceCardInput!` |
| `entityIntelligenceEvidence` | `dashboards.read`（内含 `items.read` 二次判定） | `input: EntityIntelligenceEvidenceInput!` |
| `knowledgeEntityByName` | `dashboards.read` | `name: String!, type: String` |

## 逐项对齐

- **组织级开关**：先读 Redis `knowledgeGraph:settings:<orgId>`，未命中查 MySQL `SystemSetting` 键 `knowledge_graph_settings:<orgId>`。数据库**没有**记录时用 `getBootstrapSettings()`（`enabled: true`、`ingestionEnabled: true`、`cacheTtlSeconds: 60`）写一条记录并写 Redis（TTL 60 秒）；只有数据库查询**抛异常**才回退 `getFallbackSettings()`（`enabled: false`）。`enabled === false` 时四个对象 root 返回 `null`，两个列表 root 返回 `[]`。
- **名称解析**：trim + 连续空白压成单空格 + 小写；剥离全角/半角括号内容与中英文公司后缀；6 位数字代码展开成纯数字、`<code>.<EX>`、`<EX><code>`（无交易所时展开 SH/SZ/BJ），去重后最多 20 个 key。查 `KnowledgeEntityAlias`（`orgId`、`normalizedAlias IN keys`、`take 20`），按 ticker/`alias.source`/实体类型优先级取第一个。
- **子图**：`maxDepth` clamp `1..5`（默认 2），`maxNodes` clamp `10..500`（默认 200）；Redis 键 `knowledgeGraph:subgraph:<orgId>:seed=<trim+lower>:type=<seedType ?? any>:depth=<d>:max=<n>:rels=<sorted or any>`，`cacheTtlSeconds > 0` 时读写。BFS 每层按 `weight desc, updatedAt desc` 取 `max(50, maxNodes*5)` 条边。节点用 `{id,name:canonicalName,type,properties}`。
- **列表查询**：`articleEntityLinks` limit 默认 50、clamp `1..200`；`knowledgeGraphEdgeEvidence` limit 默认 20、clamp `1..50`，证据按关联文章 `crawlAt desc` 再按 `createdAt desc`，标题/摘要/语言回退链与 Nest 一致。
- **实体 360 卡片**：`windowDays` clamp `1..180`（默认 30，`Math.round`），`relatedLimit` clamp `1..50`（默认 12）。`sentimentSeries` 先取精确 `entityName + entityType`；为空才看 `entityType = ""` 的遗留行，且只有该组织下没有同名其他类型的快照时才允许回退，否则返回 `[]`（防同名异类串读）。
- **实体情报证据**：顶层 `dashboards.read`。实体不存在返回 `null`；实体存在但当前用户权限集合不含 `items.read` 时**不报 403**，返回 `{ restricted: true, events: [], articles: [], generatedAt }`；拥有 `items.read` 才返回 `{ restricted: false, events, articles, generatedAt }`。

## 同步修复的缺陷

`KnowledgeGraphService.getSubgraph` 加载邻居实体时漏了 `orgId`，历史脏边可能把其他组织的 `KnowledgeEntity` 拉进子图并写进 Redis 缓存。Nest 与 Go 两侧同修，`where` 同时包含 `orgId: input.orgId` 与 `id: { in: missing }`：

- Nest：`apps/api/src/modules/knowledge-graph/knowledge-graph.service.ts:499-501`（`where` 在第 500 行）
- Go：`apps/api-go/internal/graphqlread/knowledgegraph/subgraph.go`（`loadSubgraph` 的 `missing` 邻居查询）

第 510~515 行与第 523~525 行原本就会剔除不在 `nodesById` 内的边端点，因此跨组织脏端点被安全剔除。

## 同步修复的第二个缺陷

`apps/api` 的全局 `ValidationPipe` 带 `forbidUnknownValues: true`（`main.ts:68-75`）。没有 class-validator 元数据的 GraphQL InputType 会被整包判为 “an unknown value was passed to the validate function”，返回 400。`KnowledgeGraphSubgraphInput`、`EntityIntelligenceCardInput`、`EntityIntelligenceEvidenceInput` 正是这种未装饰输入，所以这三个 input root 在迁移前就恒返回 400。

修复方式：只给这三个 InputType 的字段加 `@Allow()`（`class-validator`），注册元数据但**不加任何约束**，不改 SDL、不改字段白名单。修复后 Nest 返回正常数据，Go 与 Nest 才能逐字段对照。

## 留在 NestJS

`knowledgeGraphEvidenceReviewQueue`、`reviewKnowledgeGraphEvidence`、`getExecutiveChangeImpact`、`getCommodityMoveImpact`、`getPolicyEventImpact`、`getEntityImpactGraph` 以及 `knowledgeGraphSettings` / `updateKnowledgeGraphSettings` 不迁。选中任一未迁 root 时整个文档回 NestJS。

## 未验证

- 真实模型网关与 LLM 实体消歧（读查询路径本来就不调用消歧）。
- 浏览器点击和生产流量。
- Web 的 URL、SDL 和客户端 query 没有改。
- FE-TPL-02 仍开放。SEC-01 的真实登录态未在本批验证。
