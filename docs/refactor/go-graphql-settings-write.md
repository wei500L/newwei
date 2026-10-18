# 设置中心 13 个 GraphQL Mutation 写入迁移（Go）

基线是 `origin/main` 的 `7fc17faa3dc5043537bad4038299d11fdba4758d`。

## 开关与回滚

- 新增 `API_GO_GRAPHQL_SETTINGS_WRITE_MODE`，只接受空串 / `legacy` / `go`，默认 `legacy`，非法值启动失败（错误文本含变量名）。
- 与 `API_GO_GRAPHQL_READ_MODE`、`API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE`、`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` 以及所有 REST 开关**完全解耦**：

  | SETTINGS_CRAWL_READ | SETTINGS_WRITE | 行为 |
  | --- | --- | --- |
  | `legacy` | `legacy` | GraphQL 全部走 NestJS |
  | `go` | `legacy` | 20 个设置读 root 由 Go 执行，13 个 mutation 仍走 NestJS |
  | `legacy` | `go` | 只有这 13 个 mutation 由 Go 执行，20 个设置读 root 仍走 NestJS |
  | `go` | `go` | 读按读开关、写按写开关各自登记 |

- `go` 只要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`；**不要求 `MONGO_URI`**，不初始化任何只读域的 Mongo service，不启动 worker，不投递 BullMQ，不调用模型 / crawl4ai。
- 只开写入时**不**顺带打开任何 Query：`settingscrawl.RegisterSettingsModelTypes` 只登记 20 个设置模型类型，不登记 root。
- 生产 Web 入口仍是 `Web -> NestJS`，canary 保持关闭。回滚只把本开关改回 `legacy`；不改表、不改 SDL、不改 Web、不改其他开关默认值。
- 启动日志新增 `api-go: GraphQL settings writes registered (...) / not registered (...)`；设置读日志保持原样（不再把设置写描述为全部留在 NestJS）。

## 迁入的 13 个 Mutation

| # | Mutation | input | 返回类型 |
| --- | --- | --- | --- |
| 1 | `updateRateLimitSettings` | `UpdateRateLimitSettingsInput!` | `RateLimitSettingsModel!` |
| 2 | `updateAuthCacheSettings` | `UpdateAuthCacheSettingsInput!` | `AuthCacheSettingsModel!` |
| 3 | `updateCrawlClientSettings` | `UpdateCrawlClientSettingsInput!` | `CrawlClientSettingsModel!` |
| 4 | `updateAuditLogRetention` | `UpdateAuditLogRetentionInput!` | `AuditLogRetentionModel!` |
| 5 | `updateEntityImpactGraphSettings` | `UpdateEntityImpactGraphSettingsInput!` | `EntityImpactGraphSettingsModel!` |
| 6 | `updateKnowledgeGraphSettings` | `UpdateKnowledgeGraphSettingsInput!` | `KnowledgeGraphSettingsModel!` |
| 7 | `updateNewsEventSettings` | `UpdateNewsEventSettingsInput!` | `NewsEventSettingsModel!` |
| 8 | `updateNewsIndicatorSettings` | `UpdateNewsIndicatorSettingsInput!` | `NewsIndicatorSettingsModel!` |
| 9 | `updateNewsClassificationSettings` | `UpdateNewsClassificationSettingsInput!` | `NewsClassificationSettingsModel!` |
| 10 | `updateClassificationQualitySettings` | `UpdateClassificationQualitySettingsInput!` | `ClassificationQualitySettingsModel!` |
| 11 | `updateNewsDedupeSettings` | `UpdateNewsDedupeSettingsInput!` | `NewsDedupeSettingsModel!` |
| 12 | `updateNewsExtractionSettings` | `UpdateNewsExtractionSettingsInput!` | `NewsExtractionSettingsModel!` |
| 13 | `updateNewsPromptConfig` | `UpdateNewsPromptConfigInput!` | `NewsPromptConfigModel!` |

全部根权限 `settings.manage`，并在 resolver 内继续执行 `SettingsResolver.assertAdmin`：actor 在当前组织有 `Membership`、角色集合按 `MembershipRole`（无记录回退 `Membership.roleId`）、角色属于当前 `orgId`、`isSystem = true`、`name` 大小写不敏感等于 `admin`。失败沿用 `403 Unauthenticated` / `403 Admin access required`（复用 `settingscrawl` 的判定语义与错误文案），不是 `platform_admin`。

未迁（仍回 NestJS）：`updateNewsEventSourcePolicy`、`updateNewsEventSourcePolicyPresets`、`resetNewsEventSourcePolicy`、`rollbackNewsEventSourcePolicy`，其余 Mutation、Subscription 与全部 Query。

## 输入契约与校验

- 参数进入 resolver 后立即由 `input.go` 转成具名输入结构；`contract.Context.Args` / `contract.MapArg` 是唯一的非类型化边界。
- SDL 已保证标量与列表形状，`validate.go` 补齐 SDL 表达不了的约束（`@Min` / `@Max` / `@MaxLength` / `@ArrayMaxSize` / `@ArrayMinSize` / `@IsIn` / `@IsEnum`），消息采用 class-validator 默认文案的逆装饰器顺序、`"; "` 连接，与全局 `ValidationPipe` 的失败形状一致。
- 数值范围、字符串长度、数组上限与枚举取值全部按 `settings.input.ts` 逐字段落地，**不额外收紧**，例如 `CrawlClient` 的必填四项 + 十五项可选、`NewsIndicator.indicatorSlugs` 每项 128 / 至多 50、`CategoryThresholds` 上限 100。
- 嵌套数组的 DTO 校验保留：taxonomy 节点 `path ≤160` / `displayName ≤200` / `description ≤500` / `legacyCategory ∈ {politics,tech,finance,gov,ai,intel}` / `keywords|synonyms ≤50 项且每项 ≤80`，`scopedThresholds` 的三个 selector 长度上限与 `threshold ∈ [0,1]`。
- 业务校验（服务层）继续保留并保持顺序与文案：启用分类时至少启用一个分类层、`path` 必须是合法小写 slash-separated slug、重复 `path` 报错、必填文本与关键词列表的既有错误。

## 字段更新语义（逐段对齐 resolver）

- `EntityImpactGraph` / `NewsIndicator`：全部字段必填，直接归一化输入。
- `KnowledgeGraph` / `NewsEvent`：resolver 的 `input.x ?? current.x` 在 Go 中同样先读当前值再合并，`cacheTtlSeconds` 等必填项直接用输入。
  交叉规则沿用共享归一化：timeline low/high 互换、`bertopicMaxItemsPerRequest >= bertopicMinItemsPerGroup`。
- `NewsDedupe`：judge 字段按 `=== undefined` 三态处理——**省略**保留当前值，**显式 null** 回落到内置默认；`scopedThresholds` 按 resolver 的 `entry.x ?? null` 映射。
- `NewsClassification` / `ClassificationQuality`：resolver 直传，服务层用当前值合并（`normalizeSettings(input, current)`）。
- `NewsExtraction`：保留服务自己的默认归一化语义，**不**改成对所有字段 merge current；`pipelineMode` 省略与 `null` 的差异按 resolver 的枚举映射还原（`null -> legacy`），provider 的 `null` 等价于省略。
- `NewsPromptConfig`：按 `DEFAULT_NEWS_PROMPT_CONFIG` 归一化完整配置，`denoisePromptTemplate` 不在 GraphQL input 中，更新时按 Nest 语义重置为内置默认并持久化；提示词文本本身不改写。
- 单个 Mutation 内当前值只读一次、归一化一次，返回值由真实写入结果构造；同一 operation 内串行执行，后面的 Mutation 能看到前面的写入（不缓存可变设置快照）。

## 归一化复用

新业务包 `internal/graphqlread/settingswrite` 不重写默认值与 clamp：`settingscrawl` 新增 `writesupport.go`，导出模型默认值、共享归一化函数、taxonomy 路径/列表归一化与管理员门禁。写入路径把候选文档（具名 struct + json tag）序列化后交给同一个归一化函数，因此「写入的结果」与「随后 Nest 或 Go 读取到的结果」逐字段一致。

## MySQL 键与缓存协议

| 域 | SystemSetting.key | Redis key | TTL |
| --- | --- | --- | --- |
| 实体影响图 | `entity_impact_graph_settings:<orgId>` | `entityImpactGraph:settings:<orgId>` | 60s |
| 知识图谱 | `knowledge_graph_settings:<orgId>` | `knowledgeGraph:settings:<orgId>` | 60s |
| 新闻事件 | `news_event_settings:<orgId>` | `newsEvents:settings:<orgId>` | 60s |
| 新闻指标 | `news_indicator_association_settings:<orgId>` | `newsIndicator:settings:<orgId>` | 60s |
| 新闻分类 | `news_classification_settings:<orgId>` | `newsClassification:settings:<orgId>` | 60s |
| 分类质量 | `classification_quality_settings:<orgId>` | `classificationQuality:settings:<orgId>` | 60s |
| 新闻去重 | `news_dedupe_settings:<orgId>` | `newsDedupe:settings:<orgId>` | 60s |
| 新闻抽取 | `news_extraction_settings:<orgId>` | `newsExtraction:settings:<orgId>` | 60s |
| 限流三桶 | `rate_limit_login` / `rate_limit_crawl_create` / `rate_limit_rbac_write` | `rate_limit:settings` | `RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS`（默认 60s） |
| 鉴权缓存 | `auth_profile_cache_settings` | `auth_cache:settings` | 60s |
| 采集客户端 | `crawl_client_settings` | `crawl_client:settings` | 30s |
| 审计保留期 | `audit_log_retention_days`（裸数字） | `audit_log:retention_days`（裸数字） | 30s |
| 提示词配置 | `news_pipeline_prompt_config` | 无 | — |

- 输入的 `cacheTtlSeconds` 只是设置内容，**不是**设置缓存 TTL。
- 保留现有 description、审计 resource/action 与 metadata：`system_settings` 下 `rate_limit_update` / `auth_cache_settings_update` / `crawl_client_settings_update` / `audit_log_retention_update` / `entity_impact_graph_settings_update` / `knowledge_graph_settings_update` / `news_event_settings_update` / `news_indicator_settings_update` / `news_classification_settings_update` / `classification_quality_settings_update` / `news_dedupe_settings_update` / `news_extraction_settings_update`，以及 `news_pipeline_prompt` / `update`；actorId 与 orgId 取真实身份。审计失败沿用既有 best-effort（`AuditLogOutbox` 兜底，不回滚已成功的写入）。
- 三个限流桶仍在同一事务内更新；其余域不新增 operation 级事务。

## 跨 Nest/Go 共享缓存（本批优化一）

1. `CrawlSettingsService` 的 30 秒进程内缓存与 `loadingPromise` 删除，改为共享 Redis `crawl_client:settings`（30s，normalized 对象）：`getSettings` 先读缓存（读失败只告警并回落数据库），miss 读库后写回；`updateSettings` / `updateSettingsInternal` / `persistSettings` 在写入成功后刷新同一键。
2. `AuditLogSettingsService` 的进程内 `cache` / `cacheExpiresAt` 删除，改为共享 Redis `audit_log:retention_days`（30s，裸 JSON 数字）：读优先缓存、miss 读库并写回；写成功后刷新。
3. Go `internal/runtimesettings` 的审计保留期进程缓存（`retentionCache`）删除，GET/PUT 改用同一 Redis 键。
4. 本批 GraphQL Go 写入在数据库成功后更新上述同键，因此 Nest 与 Go 的读路径互见彼此的写入。没有新增 L1 缓存、版本同步系统、pub/sub 失效总线或后台轮询。

## 分类与去重的重复计算优化（本批优化二）

**taxonomy（Nest + Go）**

- Nest：`validateUpdateInput` 现在在单次遍历中完成校验并产出**已归一化**的节点（path 经 `normalizePath` 一次、keywords / synonyms 经一次 `validateStringList` 去重与截断），返回该数组；`normalizeSettings` 通过新增的可选参数直接复用，`normalizeTaxonomy` 只在读取存量配置时运行。最终排序一次。校验顺序、错误文案与重复 `path` 检查不变；没有提交 taxonomy 时沿用已有 taxonomy；默认 taxonomy 内容不变。
- Go：`classifyUpdateTaxonomy` 同样一次遍历完成服务层校验与归一化（复用 `settingscrawl` 的路径/列表归一化），排序一次；归一化后的 taxonomy 直接写入候选结果，不再次经过列表归一化。

**scopedThresholds（Nest + Go）**

- 每项 scope key 计算一次、sort key 计算一次，Map 去重后统一排序；比较器只读预计算 key，不再重复拼接或用 `toFixed(6)`。Nest 沿用原有 sort key（`sourceId`、`language`、`categoryPath`、`threshold.toFixed(6)`，`\u0000` 分隔）与 `localeCompare` 比较；Go 沿用既有 `dedupeScopeSortKey`（同一分隔符）与字节序比较。
- scope 字段规范化、`scopedThresholds` 与旧 `categoryThresholds` 的兼容优先级、重复 scope 覆盖规则、上限与截断、最终顺序全部不变；未修改相似度阈值、匹配公式或 scope 优先级。

以上只减少重复计算，未做任何耗时或吞吐测量。

## 强类型建模

新增的输入、持久化 JSON、Redis 缓存、taxonomy、scope 与审计 metadata 全部是具名 `struct`（含 json/graphql tag）。`settingswrite` 内不出现 `any`、`interface{}`、`map[string]any`、`[]any` 承载业务数据；`any` 只作为泛型类型参数（`mustJSON`、`writeAuditLogBestEffort`）这一序列化边界出现。`json.RawMessage` 仅用于「Absent 与显式 null 必须区分」的两处（classification 的 `llmModel`/`taxonomy`）。GraphQL 通用协议适配未重写。

## 与 Nest 的已知差异

1. `/graphql` 的 Mutation 一进 Go 就不再经过 Nest 的 GraphQL 限流守卫与 `ValidationPipe` 管道；Go 独立完成参数约束检查、权限重推导与管理员门禁。
2. 缓存写入为 best-effort：Nest 的限流 / 实体图 / 知识图谱 / 新闻事件 / 新闻指标写路径会在 `cache.set` 抛错时把**已提交**的写入报成 500；Go 侧只记日志并返回成功（与同批把 crawl client / audit retention 改成共享缓存后的容错风格一致）。
3. class-validator 文案：可达的约束（数值范围、字符串长度、数组上限、枚举）逐字对齐；taxonomy 节点的 DTO 长度上限在 Go 中同时由 DTO 层与服务层覆盖，两条路径都返回 400，具体文案可能来自服务层（Nest 由 DTO 层先拦下）。
4. `crawl_client_settings_update` 的审计 `inputFields` 在 Go 中按 DTO 声明顺序输出；Nest 的 `Object.keys(input)` 取决于 GraphQL 文档中的参数顺序。
5. 消息中的长度以 Unicode 码点近似 UTF-16 计数，与既有各批一致。

## 验证

- 普通 CI：`go vet ./...`、`go test ./...` 与 Nest 侧 typecheck / lint / test。见 PR 上的 CI 链接。
- 未新增专用 smoke workflow，未新增大型测试矩阵。
- 本机只做静态操作：代码阅读、`git diff`、`rg`、`gofmt`；未执行安装、`go build` / `go test` / `go vet`、Docker 或启动服务。

## 未完成项

- `updateNewsEventSourcePolicy` 一族 4 个 Mutation 与 `resetNewsIndicatorAssociations` 等其余 Mutation 未迁移。
- 未做真实栈端到端验收（按本批要求不新增 smoke workflow）；13 个 Mutation 的真实数据库读写正确性依赖普通 CI 的编译/静态检查与后续人工验收。
