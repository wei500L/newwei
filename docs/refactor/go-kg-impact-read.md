# Go 知识图谱冲击传导与实体共现/相关图 GraphQL 读查询

基线是 `e8ae45b5e27213481e9db56c6c16bcb701b86fc8`（PR #42 合并提交，main CI run 39020062833 success）。

`API_GO_GRAPHQL_READ_MODE` 默认 `legacy`。本批新增 `API_GO_GRAPHQL_KG_IMPACT_MODE`，只接受空串 / `legacy` / `go`，默认 `legacy`，非法值启动失败。只有两个都是 `go` 时，才在既有精确 `/graphql` 执行器上登记 4 个只读 root。读查询为 `legacy` 时不另挂入口；本开关为 `legacy` 时，含这 4 个 root 的文档整包回 NestJS。生产 Web 仍指向 NestJS，canary 关闭。回滚只把 `API_GO_GRAPHQL_KG_IMPACT_MODE` 改回 `legacy`。Mongo 驱动保持 `go.mongodb.org/mongo-driver/v2 v2.9.2`。

代码在独立包 `apps/api-go/internal/graphqlread/kgimpact`。

真实栈工作流：`.github/workflows/api-go-kg-impact-read-smoke.yml`（label `api-go-kg-impact-read-smoke` 或 `workflow_dispatch`）。验收链接在该 run 出现后回填。

## 迁入的 root

权限都是服务端重推导的 `dashboards.read`。orgId 只来自 membership，`mtk_` 机器令牌沿用读执行器既有规则拒绝。

| Root | 参数 | 返回 | 行为 |
| --- | --- | --- | --- |
| `getExecutiveChangeImpact` | `input: ExecutiveChangeImpactInput!` | `KnowledgeGraphImpactAnalysisModel`（可空） | 公司 -> 股票 / 竞争对手 / 同行业。 |
| `getCommodityMoveImpact` | `input: CommodityMoveImpactInput!` | `KnowledgeGraphImpactAnalysisModel`（可空） | 大宗商品 -> 行业 / 公司 / 行业下公司。 |
| `getPolicyEventImpact` | `input: PolicyEventImpactInput!` | `KnowledgeGraphImpactAnalysisModel`（可空） | 政策 -> 行业 / 公司 / 行业下公司。 |
| `getEntityImpactGraph` | `input: EntityImpactGraphInput`（可空） | `EntityImpactGraphModel!` | Mongo 共现 + MySQL 金融序列相关。 |

### 冲击传导三个场景

- 先读组织级知识图谱设置（Redis `knowledgeGraph:settings:<orgId>` -> MySQL `SystemSetting` `knowledge_graph_settings:<orgId>`；数据库无记录时按 `getBootstrapSettings()` 初始化 `enabled: true, cacheTtlSeconds: 60`）。`settings.enabled === false` 直接返回 `null`。
- `maxCandidates` resolver 默认 50，service 内 clamp 到 `1..200`。
- Redis 缓存键：`knowledgeGraph:impact:<orgId>:<sortedKeyEqualsNormalizedValueJoinedByColon>`；仅在 `cacheTtlSeconds > 0` 时启用。字符串值 `trim().toLowerCase()`，布尔值 `"true"/"false"`，键排序后冒号连接。
- 评分公式、候选合并（`score = max`、`kind` 逗号拼接、`chains` 追加）、排序（`score desc`，再按 `canonicalName` 字典序升序）逐字对齐 Nest。
- `analyzePolicyEvent` 的 `metadata.totalCandidates` 保持 Nest 原样的**截断前** `candidates.size`（与另外两个场景用截断后的长度不同）。
- `includeLprSnapshot` 为 `false` 不加 `lpr`；为 `true` 时不发实网 AkShare 请求，只记日志并忽略（不抛错、不设 `metadata.lpr`）。

### getEntityImpactGraph

- Resolver 参数收口：`endDate ?? now`；`startDate ?? endDate - 30 天`；窗口超过 365 天截断到 `endDate - 365 天`；`minEntityConfidence`/`minCorrelation` clamp 到 `[0,1]`；`minCoOccurrence` clamp 到 `[1,100]`；`maxNodes` clamp 到 `[1,500]`；`categories` 缺省 `["person","organization","stock","commodity"]`。
- 读 `EntityImpactGraphSettingsService.getSettings(orgId)`（Redis `entityImpactGraph:settings:<orgId>` -> MySQL `entity_impact_graph_settings:<orgId>`，默认 `cacheTtlSeconds: 60`）。设置对象整份规范化后写缓存，保证 Nest 能读 Go 写的 key，反之亦然。
- Redis 缓存键：`entityImpactGraph:data:<orgId>:<startIso>:<endIso>:conf=<minEntityConfidence.toFixed(3)>:corr=<minCorrelation.toFixed(3)>:co=<Math.round(minCoOccurrence)>:max=<Math.round(maxNodes)>:cats=<sortedAllowedCategoriesJoinComma>`。
- Mongo `processeditems` 共现聚合、按 `(name, type, UTC YYYY-MM-DD)` 的提及序列、`EconomicDataPoint` 金融序列、皮尔逊相关与近似 p 值、节点裁剪与 ECharts 符号大小逐字对齐 Nest。

## 必须一起修的缺陷

1. `apps/api/src/modules/knowledge-graph/knowledge-graph-impact.service.ts` 有 5 处 `knowledgeEntity.findMany` 只按主键 `id` 查询，漏掉 `orgId`：第 158、275、386、545、575 行。`KnowledgeEdge` 外键只约束 `KnowledgeEntity(id)`，一旦存在指向其他组织实体 id 的脏边，就会把其他组织实体拉进候选链并写缓存。现全部改为 `{ orgId, id: { in: ... } }`。Go 侧 `loadEntityList` 同样按 `orgId` 过滤。
2. `apps/api/src/modules/dashboard/entity-impact-graph.service.ts` 第 564 行 `$dateToString` 显式补 `timezone: "UTC"`，与第 644 行金融序列的 UTC 日对齐。Go 侧同一聚合显式带 `timezone: "UTC"`。
3. `apps/api/src/graphql/models/knowledge-graph-impact.model.ts`：`ExecutiveChangeImpactInput` / `CommodityMoveImpactInput` / `PolicyEventImpactInput` 没有任何 class-validator 装饰器，全局 `ValidationPipe` 的 `forbidUnknownValues` 会把它们当未知对象直接 400（`an unknown value was passed to the validate function`），三个查询根本到不了 resolver。补 `@IsString` / `@IsOptional()+@IsInt` / `@IsOptional()+@IsBoolean`，只注册校验元数据，不新增字段、不改 GraphQL SDL。此缺陷由 smoke 的 legacy 对照发现。

## 留下

设置读写、其他知识图谱读 root、mutation、subscription、聚类和采集仍在 NestJS。混入未登记 root 时整包回 NestJS。`getEntityImpactGraph` 未命中缓存时会真查 Mongo/MySQL（只读，不写）。

## 未验证

- 生产 Web / canary / 真实流量未切换。
- 前端、Prisma schema、GraphQL SDL 均未改。
- 本机未安装依赖、未跑测试、未构建、未启动 Docker；验证只在 GitHub Actions。
- FE-TPL-02 不处理。SEC-01 的真实登录态未在本批验证。
