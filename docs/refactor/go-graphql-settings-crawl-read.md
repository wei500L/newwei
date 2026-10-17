# Go-批：设置中心与来源策略 / 证据复核队列 / 采集任务 GraphQL 只读读（`API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE`）

## 1. 范围与开关

新增独立开关 `API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE`：

- 只接受空串、`legacy`、`go`；默认 `legacy`，非法值启动失败。
- 仅当 `API_GO_GRAPHQL_READ_MODE=go` **且** 本开关 `go` 时，才在 `cmd/api/main.go`
  调用 `settingscrawl.Register(...)` 把下面 20 个只读 Query root 登记进 Go 的
  GraphQL 读执行器。
- 本开关为 `legacy` 时，含这 20 个 root 的文档整包回 NestJS（执行器按“注册表
  未命中即整体 legacy”的既有规则回落），因此生产 Web 入口保持 `Web -> NestJS`，
  canary 关闭。
- 回滚只把本变量改回 `legacy`；不改表、不改 SDL、不改 Web 入口、不改其他
  `API_GO_*` 开关默认值。

Go 实现在新包 `apps/api-go/internal/graphqlread/settingscrawl`。

## 2. 迁入的 20 个 Query root

| # | Root | 顶层权限 | 附加门禁 |
| --- | --- | --- | --- |
| 1 | `rateLimitSettings` | `settings.manage` | 系统管理员 |
| 2 | `entityImpactGraphSettings` | `dashboards.read` | 无 |
| 3 | `knowledgeGraphSettings` | `dashboards.read` | 无（缺记录时 upsert 引导默认值） |
| 4 | `newsEventSettings` | `dashboards.read` | 无 |
| 5 | `newsEventSourcePolicy` | `settings.manage` | 系统管理员 |
| 6 | `newsEventSourcePolicyPresets` | `settings.manage` | 系统管理员 |
| 7 | `newsEventSourcePolicyRevisionDiff` | `settings.manage` | 系统管理员 |
| 8 | `newsClassificationSettings` | `settings.manage` | 系统管理员 |
| 9 | `classificationQualitySettings` | `settings.manage` | 系统管理员 |
| 10 | `newsDedupeSettings` | `settings.manage` | 系统管理员 |
| 11 | `newsIndicatorSettings` | `dashboards.read` | 无 |
| 12 | `authCacheSettings` | `settings.manage` | 系统管理员 |
| 13 | `crawlClientSettings` | `settings.manage` | 系统管理员 |
| 14 | `auditLogRetention` | `settings.manage` | 系统管理员 |
| 15 | `newsExtractionSettings` | `settings.manage` | 系统管理员 |
| 16 | `newsPromptConfig` | `settings.manage` | 系统管理员 |
| 17 | `newsEventSourcePolicySyncStatus` | `items.read` | 无 |
| 18 | `knowledgeGraphEvidenceReviewQueue` | `settings.manage` **或** `knowledgegraph.review` | 无（`any` 模式） |
| 19 | `crawlTasks` | `crawl.read` | 无 |
| 20 | `crawlTask` | `crawl.read` | 无 |

不迁 `crawlMetadata`（会向 crawl4ai 抓取外网）、`alertRules`（缺默认规则时会投递
BullMQ 任务）以及任何 GraphQL Mutation。

## 3. 多权限 `any` 模式

`knowledgeGraphEvidenceReviewQueue` 在 Nest 侧是
`@Permissions("settings.manage", "knowledgegraph.review")`（mode 恒为 `any`）。

`contract.Root` 新增 `AnyPermissions []string`，`exec.authorizeRoot` 在其非空时
按“命中任意一个即放行”判定；全部未命中时返回与 `GqlPermissionsGuard` 逐字节
对齐的失败结构：

```
message   = "Insufficient permissions"
status    = 403
appCode   = "INSUFFICIENT_PERMISSIONS"
detail    = "Requires any permission: settings.manage, knowledgegraph.review"
requiredPermissions = ["settings.manage", "knowledgegraph.review"]
permissionsMode     = "any"
```

`AllowAuthenticated` / `Permission` 的既有语义不变；`AnyPermissions` 优先。

## 4. 强类型建模（零 `any`）

- 20 个 root 的全部返回模型（44 个 ObjectType + 5 个枚举）都定义为带精确
  `graphql` tag 的具名 `struct`；枚举定义为具名字符串类型 + 常量
  （`CrawlTaskStatus`、`NewsEventClusteringMode`、`NewsEventSourcePolicyRevisionOperation`、
  `NewsExtractionPipelineMode`、`NewsExtractionProviderId`）。
- 为支持具名枚举类型，`exec.projectLeaf` 的 String/ID/Enum 投影改走新增的
  `contract.AsString`（按 `reflect.Kind` 接受任意字符串型值），对既有纯 `string`
  模型输出不变。
- 数据库 JSON 配置（`SystemSetting.value`）一律解码为具名 `struct`，字段用
  `json.RawMessage` 承载，再由 `settingvalue.go` 的强类型取值器按 Nest 的
  JavaScript 强制转换语义读取；没有任何 `map[string]any` / `[]any`。
- GraphQL `JSON` 标量（`evidence`、`properties`、`tables`）用
  `*json.RawMessage` 承载（与 `workspace/jsonScalar` 同一约定），空列与字面
  `null` 映射为 GraphQL null。
- 唯一保留非强类型的位置是执行器自身的参数边界 `contract.Context.Args`
  （`contract.Lookup` 的返回值），它不参与任何模型或存储结构定义。

## 5. 数据源与缓存

| Root | MySQL `SystemSetting.key` | Redis |
| --- | --- | --- |
| 1 | `rate_limit_login` / `rate_limit_crawl_create` / `rate_limit_rbac_write` | `rate_limit:settings`（60s） |
| 2 | `entity_impact_graph_settings:<orgId>` | `entityImpactGraph:settings:<orgId>`（60s） |
| 3 | `knowledge_graph_settings:<orgId>`（缺记录时 upsert 引导值） | `knowledgeGraph:settings:<orgId>`（60s） |
| 4 | `news_event_settings:<orgId>` | `newsEvents:settings:<orgId>`（60s） |
| 5/7 | `news_event_source_policy:<orgId>` + `..._category_authority:<orgId>` | `newsEvents:sourcePolicy:<orgId>`（60s） |
| 6 | `news_event_source_policy_preset:<orgId>` + `..._preset_category_authority:<orgId>` | `newsEvents:sourcePolicyPreset:<orgId>`（30s） |
| 8 | `news_classification_settings:<orgId>` | `newsClassification:settings:<orgId>`（60s） |
| 9 | `classification_quality_settings:<orgId>` | `classificationQuality:settings:<orgId>`（60s） |
| 10 | `news_dedupe_settings:<orgId>` | `newsDedupe:settings:<orgId>`（60s） |
| 11 | `news_indicator_association_settings:<orgId>` | `newsIndicator:settings:<orgId>`（60s） |
| 12 | `auth_profile_cache_settings`（全局） | `auth_cache:settings`（60s） |
| 13 | `crawl_client_settings`（全局） | 无（Nest 用进程内 30s 备忘） |
| 14 | `audit_log_retention_days`（全局） | 无（进程内 30s 备忘） |
| 15 | `news_extraction_settings:<orgId>` | `newsExtraction:settings:<orgId>`（60s） |
| 16 | `news_pipeline_prompt_config`（全局） | 无 |

**缓存策略（有意的、已记录的简化）**：除来源策略同步状态外，读路径直接读
MySQL 并按同一套归一化规则返回，不再读/写 Redis 设置缓存。原因是设置缓存里
存放的就是同一份归一化结果，服务写路径同时更新 DB 与缓存，因此对一致数据集
两者输出相同；跳过缓存读取避免了缓存载荷形状差异带来的偏差，也少了写回竞态。
`newsEventSourcePolicySyncStatus` 的语义本身就是“比较 DB 与 Redis 的时间戳”，
因此它仍然读取 Redis（key 与 Nest 相同）。

## 6. 同批修复的三个缺陷（Nest 与 Go 两侧）

1. **管理员门禁漏 `orgId` 与 `isSystem`**
   `settings.resolver.ts` `assertAdmin` 原先只按 `id ∈ roleIds AND name = 'admin'`
   查角色，组织内自建的同名非系统角色、或跨组织借用的角色 id 都能通过。Nest 侧
   补齐 `orgId: user.orgId` 与 `isSystem: true`；Go 侧 `store.assertSystemAdmin`
   直接用修正后的谓词（`Role.orgId = ? AND Role.isSystem = 1 AND LOWER(Role.name) = 'admin'`，
   角色 id 由 `MembershipRole`（为空时回退 `Membership.roleId`）重新推导）。
   两处大小写不敏感分别由 `utf8mb4_unicode_ci` 排序规则与 `LOWER()` 提供，语义一致。
2. **`crawlTasks` 失效/跨组织游标触发 Prisma `P2025`（500）**
   `crawl.resolver.ts` 把 `decodeCursor(after)` 直接交给 Prisma 的 `cursor`/`skip`。
   现先用 `id + orgId` 校验游标存在性；不存在时返回空页
   （`edges: []`、`hasNextPage: false`、`endCursor: null`），`totalCount` 仍按同一
   `where` 统计。Go 侧同样先解析锚点行，取不到即返回空连接，不报错。
3. **复核队列关联表未做 `orgId` 约束**
   `knowledge-graph-review.service.ts` 的 `where` 原先只有 `{ orgId }`，而
   `include` 拉出的 `edge` / `fromEntity` / `toEntity` / `article` 外键只绑定主键，
   历史脏外键会把其他组织的实体名、边属性与文章标题/URL 返回给当前组织。现对
   每个关联关系补 `orgId`；Go 侧用
   `INNER JOIN ... AND x.orgId = e.orgId`（`ProcessedArticle` 为 `LEFT JOIN`，
   `orgId` 谓词放在 `ON` 里，避免丢掉没有 processed 行的文章）。

## 7. GoDoc 与注释约定

- 所有新增与修改的 `.go` / `.ts` 代码写规范英文注释；Go 每个包、每个导出
  类型/结构体/函数/常量都有以符号名开头的英文 GoDoc。
- 多权限 `any` 判定、来源策略 delta 合成与版本差分、双层管理员校验、
  游标分页防 500 等逻辑处都有英文行内注释。
- 仅 Git commit、PR 描述与本 `docs/refactor/*.md` 使用中文。

## 8. 关键语义对齐点

- **来源策略冲突检测**：Nest 的实现是**不做比较期小写归一化**的精确集合成员
  判断，且输出顺序与拼写都取自 **blog 列表**。本实现照此对齐（任务说明里的
  “小写归一化交集”仅对服务写入的数据成立，手工改库的数据不成立）。
- **两套默认名单**：有效名单默认值来自分类器的 153/135/42/26 条（已归一化，
  小写），预设默认值是另一套 15/15/12/10 条且**从未归一化**（保留 `"Reuters"`
  等大小写）。预设的默认值通过 `publicportal.DefaultSourcePolicyLists()` 与
  归一化函数复用，避免手抄两遍。
- **版本差分**：每个 revision 的 delta 都是完整快照，`getRevisionDiff` 不做
  链式合并；找不到 revision 抛 400 `Revision <N> not found`（`baseRevision`
  先判），错误带 `code = "BAD_REQUEST"` / `http.status = 400` 且**无 `appCode`**。
  保留窗口为最新 60 条，查询返回最新 30 条（降序）。
- **同步状态**：`degraded = 有任一 warning code`；`warningCodes` 按字典序升序；
  `POLICY_DB_READ_FAILED` / `PRESET_DB_READ_FAILED` 只在读失败时出现；
  `*_CACHE_READ_FAILED` 会抑制同侧 `*_CACHE_MISS`；`CACHE_WRITE_FAILED` 不会由
  本 root 产生。`forceAuthoritativeMode` / `forceMinAuthoritativeSources` 来自
  `news_event_settings:<orgId>`，读取失败回落 `false` / `1`，并做 1..10 夹取。
- **复核队列**：先读知识图谱设置，`enabled = false` 直接返回 `[]`（不查证据表）；
  `take = min(500, max(50, min(max(limit,1),200) * 4))`；先按 `take` 取数再在内存里
  过滤 `onlyUnreviewed` 并在 `limit` 处 `break`（因此可能少于 `limit` 条，与 Nest
  一致，不做补齐）；`maxConfidence` 缺省取设置的 `minEdgeConfidence`（默认 0.55）；
  “已复核”仅当 `evidence.review.status` 去空白后恰为
  `approved` / `rejected` / `corrected`。
- **采集任务**：`take = min(first, 50)`（GraphQL `first` 缺省 20，由 resolver 补），
  排序 `createdAt desc, id desc`，游标是任务 id 的标准 base64；`crawlTask` 找不到
  抛 404 `crawl task not found`（`code = "NOT_FOUND"`，无 `appCode`，`data.crawlTask = null`），
  `resultLimit` 按 `max(1, min(100, limit))` 夹取。

## 9. 本轮的已知与有意取舍

- 设置类读路径不走 Redis 设置缓存（见第 5 节）。
- 服务端 `updatedAt` 若存的是不可解析的字符串，Nest 会在 `new Date(...)` 后
  由 GraphQL DateTime 序列化报错；Go 侧回落为 GraphQL null 而不是让整包失败。
  正常写入的数据不受影响。
- `crawlTask` 媒体资产的 S3 签名 URL 仍由 Nest 的存储层产生；Go 复用的是
  PR #50 已合入的 `crawlreadtelemetry` 读取与签名逻辑，行为以该包为准。
- `SEC-01` 的真实登录态未在本批验证。
- `FE-TPL-02` 不在本批范围。

## 10. 验证方式

- 普通 CI：`.github/workflows/ci.yml`（lint / typecheck / 既有 Go 单测）。
- 专用 smoke：`.github/workflows/api-go-graphql-settings-crawl-read-smoke.yml`，
  真实 MySQL + Redis + Mongo 栈，`workflow_dispatch` 或 PR label
  `api-go-graphql-settings-crawl-read-smoke` 触发，不进普通 CI。覆盖 7 组验收：
  `legacy` 逐字段一致、`go` 逐字段一致、管理员门禁修复、来源策略 revision 与
  冲突/差分/同步状态、失效游标防 500、复核队列多权限与脏外键、停 Nest 后 20 个
  root 仍 200 且未迁 root/mutation 返回 502。
