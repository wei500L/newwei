# 条目阅读与 RSS 检索辅助（Go 接管说明）

> 本批：`API_GO_ITEMS_READING_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 基线：`origin/main` = `2672b62e35ed7235604c65939bcd335c81bf7d27`（main CI run 39061326703 success）。
> 事实源：`apps/api/src/modules/items/items.controller.ts`、`dto/list-items.dto.ts`、`items.service.ts`、
> `items-list.service.ts`、`items-search.service.ts`、`items-search-query.service.ts`、`items-search.helpers.ts`、
> `items.shared.ts`、`items-elasticsearch.service.ts`、`items-read-model.service.ts`、`item-read-model.utils.ts`、
> `items-rss-translation.service.ts`、`apps/api/src/graphql/resolvers/items.resolver.ts`、
> `apps/api/src/graphql/models/item.model.ts`、`dto/item.input.ts`、`apps/api/src/graphql/loaders/*.ts`、
> `packages/mongo/src/models/{raw-item,processed-item,item-read-model}.ts`、`packages/db/prisma/schema.prisma`、
> `apps/api-go/internal/graphqlread/{contract,exec}`、`apps/api-go/internal/graphqlread/workspace/`。

## 1. 开关与回滚

- 变量：`API_GO_ITEMS_READING_MODE`。只接受空字符串、`legacy`、`go`；**空串与未设置都解析为 `legacy`**。
  其他值让进程启动失败，错误文本含变量名与非法值（回显被拒绝的取值）：
  `API_GO_ITEMS_READING_MODE must be one of legacy|go, got "bogus"`（`apps/api-go/internal/config/config.go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（本批要读 MySQL + Mongo + Redis）。
- **五个 GraphQL root 只在 `API_GO_GRAPHQL_READ_MODE=go` 且 `API_GO_ITEMS_READING_MODE=go` 时登记**。
  GraphQL 总开关仍是 `legacy` 时，即使本批开关是 `go`，五个 Query 也整包回 NestJS。
- **两条 REST 路由只由本批开关控制**（不看 `API_GO_GRAPHQL_READ_MODE`）。
- 回滚：**只把 `API_GO_ITEMS_READING_MODE` 改回 `legacy`** —— 纯配置变更；legacy 时不注册 handler、
  不追加路由规则、不登记 GraphQL root。
- `infra/docker/.env.sample` 与 `infra/docker/docker-compose.yml` 的 pilot 默认值都是 `legacy`。
  不改任何既有 `API_GO_*` 的默认值。**未启用 shadow，canary 保持关闭。**

## 2. 7 个入口契约矩阵

| # | 入口 | 方法/签名 | 权限 | Nest 事实源 | Go 落地 | 成功 | 缺失语义 |
|---|---|---|---|---|---|---|---|
| 1 | `GET /api/items` | `ListItemsDto`（page/pageSize/search/orderBy） | `items.read` | `items.controller.ts:18-25` → `items.service.ts:99-121` → `items-list.service.ts:55-167` | `internal/itemsreading` REST handler | 200 `{items,total,page,pageSize}` | 空列表 `items=[]`、`total=0` |
| 2 | `GET /api/items/:id` | `:id` = ItemMeta 字符串 ID | `items.read` | `items.controller.ts:33-37` → `items.service.ts:172-234` | 同上 | 200 `{itemMeta,rawItem,processed}` | 不存在/跨组织 → **404 `Item not found`** |
| 3 | GraphQL `item(id: String!)` | nullable `ItemModel` | `items.read` | `items.resolver.ts:562-575` | `internal/graphqlread/itemsreading` | `data.item` | 不存在/删除/跨组织 → `data.item = null`（**不抛错**） |
| 4 | GraphQL `itemFacets(search, filters)` | `ItemFacets!` | `items.read` | `items.resolver.ts:460-472` | 同上 | 四组非空列表 | 候选为空 → 四组 `[]` |
| 5 | GraphQL `rssSources(windowDays, onlyWithItems)` | `[RssSourceOptionModel!]!` | `items.read` | `items.resolver.ts:474-490` | 同上 | 列表 | 无来源 → `[]` |
| 6 | GraphQL `rssTranslationStatus(targetLanguage)` | `[RssTranslationProviderStatusModel!]!` | `items.read` | `items.resolver.ts:492-512` | 同上 | 固定顺序 `deeplx`、`llm` | 未配置 → `available=false` + 固定 message |
| 7 | GraphQL `searchSuggestions(prefix, limit: Float)` | `[SearchSuggestionModel!]!` | `items.read` | `items.resolver.ts:542-560` | 同上 | `{type,value,origin}` | 空前缀 → `[]` |

**开关矩阵（五个 GraphQL root）**

| `API_GO_GRAPHQL_READ_MODE` | `API_GO_ITEMS_READING_MODE` | 五个 root |
|---|---|---|
| 空/`legacy` | 空/`legacy` | Nest |
| 空/`legacy` | `go` | **Nest**（总开关未开） |
| `go` | 空/`legacy` | Nest |
| `go` | `go` | Go |

**未迁（明确留在 NestJS）**：GraphQL `items` root、`createItem`/`createItemFromCrawlResult`/`updateItem`/
`translateRssItems` mutation、`POST /api/items`、CSV 导出、archive、索引重建、摄取、队列 worker。
`POST /api/items` 与其他未列方法不得被 Go 抢占（不返回 Go 自己的 405）。

## 3. REST 契约细节

### 3.1 `GET /api/items`

- DTO 公开字段只有 `page`、`pageSize`、`search`、`orderBy`。保持 `class-validator` 的 `IsNumberString`
  默认语义（**不改成正整数正则，不放宽成任意 JS Number 可解析字符串**）；重复参数、数组、
  未知参数、非法 `orderBy` 按现有 `ValidationPipe` 拒绝（全局 pipe 的 `forbidNonWhitelisted` 行为）。
  **不给 REST 增加 filters/rankingMode/userId 参数。**
- 归一化（`items-list.service.ts:66-79`）：
  - `pageSize` 非有限数 → 10；`Math.floor`；`take = min(max(pageSize,1), cap)`，`cap = min(trunc(maxPageSize ?? 50), 50000)`。
  - `page` 非有限数 → 1；`Math.floor`；`safePage = max(page,1)`。
  - **REST 交互路径 `pageSize` 上限 50**（`MAX_CURSOR_PAGE_SIZE`），CSV 批量调用上限 50000 不变（IR2 回归点）。
- `search`：`trim` 后走 `parseSearchPayload`。`__items_filters__:` 前缀的历史编码载荷
  （`decodeURIComponent` 后 `JSON.parse`，含 `q` 与 `filters`）必须兼容；前缀后为空 → `{}`；
  解码/JSON 失败 → 把**原始 normalized 字符串**当搜索文本。
- 基础范围 `{orgId, status != duplicate}`；排序：
  - `CREATED_DESC` → `createdAt DESC, id DESC`（读模型模式 `createdAt DESC, itemMetaId DESC`）
  - `PUBLISHED_DESC` → `sortAt DESC, id DESC`（读模型模式 `sortAt DESC, itemMetaId DESC`）
  - 不用 `publishedAt` 非空排前替换现有 `sortAt`。
- REST 路径 `rankingMode=RECENCY`，不迁 PERSONALIZED/RELEVANCE 最终排序、不迁 rerank。
  但**搜索召回所需的候选融合必须实现**（见 §6）。

### 3.2 `GET /api/items/:id`

- `:id` 是 `ItemMeta.id` 字符串，**不对整个 `:id` 套 ObjectId 校验**。
- `ITEMS_READ_MODEL_ENABLED=false`：
  1. MySQL `ItemMeta` 先按 `{id, orgId}` 查；缺失 → 404 `Item not found`。
  2. `rawItem` 通过 `mongoRef` 读取，并实施 IR1 绑定校验（`_id = mongoRef` **且** `itemMetaId = meta.id`）；
     非法/空 `mongoRef` → `rawItem: null`。
  3. `processed` 按 `orgId + itemMetaId` 过滤，再 `createdAt DESC` 取**最新一条**。
- `ITEMS_READ_MODEL_ENABLED=true`：按 `{orgId,itemMetaId}` 读 `ItemReadModel`；缺失时遵守现有
  `hydrateMissing` 行为（会触发回填写入，见 §5）；保留读模型快照构造出的响应字段与 `null`。
- 不把读模型响应与 legacy Mongoose `lean` 响应强行统一（`legacy lean` 里的 `_id` 是 ObjectId，
  读模型快照里的 `id` 是字符串；两者字段集也不同）。

## 4. GraphQL 契约细节

### 4.1 `item(id)`

- 返回 nullable `ItemModel`；不存在/删除/跨组织 → `data.item = null`。
- 字段：`id`、`title`、`status`、`ingestedAt`、`publishedAt`、`relevanceScore`、`searchHighlights`、
  `createdAt`、`updatedAt`、`orgId`、`meta`、`raw`、`processed`、`rawPreview`、`processedPreview`。
  `metaId` 是 `@HideField()` 的内部键，**不得暴露**。
- `title` 来自 `ItemMeta.name`；`ingestedAt` 来自 `createdAt`；`createdAt`/`updatedAt` 是 `DateTime!`
  （JS ISO 毫秒，`YYYY-MM-DDTHH:mm:ss.sssZ`）。
- `meta` 缺失 → 错误 `Item metadata not found`（Nest 抛 `BadRequestException`；
  SDL 里 `meta: ItemMetaModel!`，因此该字段错误会让 `item` 整体为 `null`）。
- `publishedAt` 回退顺序：Item 已有值 → 读模型 → processed result → raw payload。
- `raw.payload` 是 JSON 字符串；`processed.result` 是规范化结果的 JSON 字符串；
  `processed.resultJson` 是 JSON 对象（**不双重 stringify**）。非法/空白/多层 JSON 字符串按
  `normalizeProcessedResult` 处理。
- `duplicateOf`：对外是**目标 ItemMeta ID**（不是 ProcessedItem ObjectId）；目标查询带 `orgId`；
  跨组织或目标缺失 → `null`。
- `eventId`：优先 `NewsEventItem.processedItemId` 直接关联（`createdAt DESC` 优先）；
  缺失时走 `ProcessedArticle.cleanedMarkdownRef → NewsEventItem.processedArticleId`
  fallback；两条链都带 `orgId`；无映射 → `null`。
- **legacy processed loader 的选择规则**：`completed > failed > processing > pending`；
  同优先级保留 `createdAt DESC` 的第一条。**不能**用 REST 的“最新记录”替换。
- full/scalar/preview projection 行为必须保留；aliases、fragments、变量与 `@skip`/`@include`
  不能导致漏读 `result`/`resultJson`。

### 4.2 `itemFacets`

- filters 字段：`sourceIds`、`regions`、`topics`、`sentiments`、`contentTypes`（可选字符串数组）、
  `excludeDuplicates`（可选 Boolean，默认 false）、`dateRange.start/end`（可选 DateTime）。
  **不新增数组长度上限、枚举限制或 `start<=end` 校验。**
- 规范化：`trim`、去空、去重；`sentiments`/`contentTypes` 转小写。
- **显式 `filters` 优先于 `search` 历史载荷里的 `filters`**；搜索候选与筛选候选**取交集**；
  `null` 候选表示不限制，空数组表示确实无结果（**不能混为一谈**）。
- 聚合：每组最多 50（`MAX_FACET_OPTIONS`）；`count DESC`，同 count 按 `localeCompare`；
  topics 的单文档重复值只计一次；`sentiment` 允许 `positive|neutral|negative`；
  `contentType` 允许 `news_fact|opinion|analysis|mixed`；**`location` 优先于 `region`**。
- legacy 分支：`orgId + completed`，批量读取最新 `completed` 快照（`createdAt DESC, _id DESC`），
  batch size=500，同 `itemMetaId` 只取最新 completed；**不得截断为前 500/1000/5000 条后宣称全量**。
  topic 合并 `result.topics`、`tags`、`result.entities` 的现有允许形态。
- read model 分支：`orgId` 且排除 duplicate，使用现有 denormalized 字段；
  **不把两个模式改为第三种统一统计口径**。

### 4.3 `rssSources`

- `windowDays` 默认 7，`Math.floor` 后 clamp 到 `1..30`；`onlyWithItems` 缺失/null 默认 `true`，
  **显式 false 必须保留**。
- 来源：`NewsSource.orgId=current`、`isActive=true`、`config.seed.mode` trim+lower 为 `rss`；
  `feedUrl` 优先非空 `config.seed.feedUrl`，否则 `source.url`；`siteUrl` 与 `feedUrl` 必须非空。
- 窗口统计：`since = now - windowDays*86400000ms`。
  - ProcessedItem：`orgId`、`completed`、`sourceId`、`createdAt >= since`。
  - Article：`orgId`、`sourceId`、`crawlAt >= since`。
  - `itemCountWindow = max(processedCount, articleCount)`（**不是相加**）；
    `latestItemAt` 取两侧最新时间的最大值，均无数据 → `null`。
- `onlyWithItems=true` 过滤 `count=0`；排序 `count DESC`、`latestItemAt DESC`、`name.localeCompare`。
- **不请求 feedUrl、不启动采集、不探测网站。**

### 4.4 `rssTranslationStatus`

- `targetLanguage` trim；缺失/null/空白默认 `zh-CN`；返回顺序固定 `deeplx`、`llm`。
- 只报告配置可用性，**不进行实际翻译或连通性探测**；`available=true` 不表述为真实翻译已成功。
- `deeplx`：
  - 仅 `zh`、`zh-cn`、`zh-*`（忽略大小写）属于支持的目标语言；其他语言
    `available=false`、`targetLanguageSupported=false`，message 为
    `DeepLX API translation currently supports Chinese (zh-CN) target language only.`
  - 中文目标：主服务 ready = `runtime.enabled=true` 且 `baseUrl`、`apiKey` trim 后非空；
    fallback ready = `runtime.fallbackEnabled=true` 且 `fallbackBaseUrl` 非空。
    主 ready → `available=true` 且不附加伪造消息；只有 fallback ready → `available=true` 且 message 为
    `DeepLX primary endpoint is unavailable; fallback translation API is configured and will be used.`；
    两者均不可用 → `available=false`、`targetLanguageSupported=true`，reasons 按
    **主服务原因、fallback 原因**顺序用空格连接。
  - 错误原句：`DeepLX translation API is disabled in Situation Monitor settings.` /
    `DeepLX translation API base URL is not configured.` /
    `DeepLX translation API key is not configured.` /
    `Fallback translation API is disabled in Situation Monitor settings.` /
    `Fallback translation API base URL is not configured.` /
    `DeepLX or fallback translation API is not available in Situation Monitor settings.`
- `llm`：按 `LlmGatewaySettingsService.getActiveConfig()` 的**实际 completion profile** 选择、
  enabled、默认回退与治理解析语义判断；**不仅检查 activeId 存在**，不把 embedding/rerank profile
  是否存在当 completion 可用性。没有 active config → `available=false`、`targetLanguageSupported=true`，
  message `No enabled LLM gateway profile is active.`；有 active config → `available=true`、
  `targetLanguageSupported=true`。
- 配置只读：`SystemSetting.key=situation_monitor_settings`、Redis `situation_monitor:settings`（TTL 30s，
  缓存包装 `{exists,value}`）；`SystemSetting.key=llm_gateway_profiles`、Redis `llm_gateway:profiles`
  （TTL 60s）。保留 DB/env/default 优先级、密钥解密与 URL 归一化。**不写 SystemSetting、不改 active
  profile、不发模型请求、不把部分字段 struct 写回共享缓存覆盖其他字段。**

### 4.5 `searchSuggestions`

- `limit` 的 SDL 类型是 **`Float` 而不是 `Int`**：缺失默认 10；`clamp(limit,1,25)`；
  保留非整数 `limit` 的 clamp、缓存键与 `slice` 截断行为；**不改 SDL**。
- `prefix` trim；空白 → `[]`；匹配用 lower-case `normalizedPrefix`；输出只含 `type`、`value`、`origin`。
- 缓存键：
  - `__items_search_suggestions__:${orgId}:${normalizedPrefix}:${clampedLimit}:v3`，TTL 60s。
  - `__items_source_suggestions__:${orgId}:v1`，TTL 180s。
  - `__items_vector_search__:${orgId}:${sha256(lowercaseQuery)}`，TTL 300s。
  - 锁 `lock:${cacheKey}`；`lockTtlMs=5000`、`retryDelayMs=50`、`maxWaitMs=2000`；
    保留锁 token 校验、续租（间隔 `max(1000, floor(lockTtlMs/2))`）、释放（Lua 比对 token）与最终 fallback。
  - **不改键版本、组织维度或 JSON 缓存形状；不能用进程内缓存代替 Redis。**
- 词法权重：TOPIC startsWith `360+count*2.5` / includes `180+count*1.2`；REGION `320+count*2` / `160+count`；
  SOURCE `330+count*2.2` / `165+count*2.2`；SENTIMENT `300+count*2` / `150+count*2`。
- 语义：触发条件为至少 2 个 `minLength=2` token，或 `prefix.length>=6`；前 120 个语义候选；
  `rankScore=140-index/max(1,n)*80`；TOPIC factor=1、REGION 0.92、SOURCE 0.88、SENTIMENT 0.8；
  startsWith +48、includes +24、每个 tokenHit +10；topics 每条候选最多 10 个。
- 合并：`key=${type}:${value.toLowerCase()}`，保留首次 casing；同 key 累加 `score/hits/lexicalScore/semanticScore`；
  两者都 >0 → `HYBRID`，仅 semantic >0 → `SEMANTIC`，否则 `LEXICAL`；
  排序 `score DESC`、`hits DESC`、`type.localeCompare`、`value.localeCompare`。

## 5. `ITEMS_READ_MODEL_ENABLED` 与回填

- `ITEMS_READ_MODEL_ENABLED` 默认 false；`ITEMS_VECTOR_HARD_FAIL_ENABLED` 默认 false；
  **不把本批迁移开关与读模型开关绑定**，必须分别验收 false/true。
- `ItemReadModel` 缺失时（`items-read-model.service.ts:556-661`）：
  1. 按 `orgId + IDs` 批量读 `ItemMeta`；
  2. 安全加载 raw/processed 快照；
  3. 来源补全优先级 `processed.sourceId` → `raw.metadata.sourceId` → `PipelineJob.sourceId` →
     `CrawlResult/CrawlTask.config`；
  4. `PipelineJob`、`CrawlResult/Task` 查询必须组织隔离；
  5. 按 `item-read-model.utils` 构造完整派生字段；
  6. Mongo upsert filter 必须含 `orgId + itemMetaId`；
  7. **不修改原始 ItemMeta/RawItem/ProcessedItem**。
- 快照缺失：保留当前代码“**unset** raw/processed，而不是写显式 null”——GraphQL 会把显式 null 当权威快照并
  停止 fallback。已有文档的显式 null 与字段不存在不能合并。验证“先缺失快照、稍后数据到达”时下一次读取能看到新数据。
- **不启动 BullMQ、不调用 ingest、不写 outbox、不触发抓取、不批量 reindex。**
- 这是本批需要保留的派生数据写入：`GET /api/items/:id` 与 GraphQL `item` 在读模型开启时可能触发回填，
  **不能当作完全无副作用的读取**，也不能扩展为摄取/排队/重建索引。

## 6. 检索与读模型实现约束

- 检索候选**不能简化为单表 LIKE**。保留：
  - MySQL `ItemMeta` FULLTEXT(name, externalId)（`resolveMetaSearchIds`，raw SQL **参数化**）；
  - Mongo ProcessedItem 全文检索（`$text`，`buildMongoTextSearchQuery`）；
  - `ProcessedArticle(title,summary)` FULLTEXT + `cleanedMarkdownRef` 关联；
  - `ITEMS_READ_MODEL_ENABLED` 时的 ItemReadModel 文本/前缀检索（`titleLower` 等）；
  - 配置启用时的 Elasticsearch 候选；
  - 配置可用时的 embedding + vector 候选；未配置/失败时现有降级。
- 普通检索：tokenize 按 whitespace，移除全文操作符 `+-><()~"*@`；`FULLTEXT_MIN_TOKEN_LENGTH=3`、
  Mongo token 下限=2；MySQL BOOLEAN MODE query 为 `token*` 空格连接；无 fulltext token 时走已有前缀策略
  （`startsWith`），**不把前缀策略改为任意 contains 扫描**；regexp 文本必须 escape。
- 候选融合权重：`meta=1.3`、`processed=1.15`、`processedArticle=1.05`、`vector=1.45`、`elasticsearch=1.6`；
  每来源去重后 `rankContribution = weight/(1+index/20)`；合并加分 `max(0, sourceCount-1)*0.2`；
  排序 score 差 >1e-9 时 score DESC，否则 bestRank ASC，再 `id.localeCompare`。
  `MAX_SEARCH_MATCHES=5000`；Elasticsearch 自身 `normalizeSearchLimit` 最大 1000。
- read-model 前缀字段：`titleLower`、`externalIdLower`、`sourceNameLower`、`topicKeys`、`entityKeys`、
  `regionKey`、`locationKey`；稳定次序 `sortAt DESC, itemMetaId DESC`。
- Elasticsearch：使用现有 `ELASTICSEARCH_*` 配置、items alias、认证与超时；`query_string` 的别名、
  字段 boost、`orgId` filter 与默认 AND 保持一致；**不迁移索引管理/写入/reindex**；失败按 Nest 降级，
  **不能固定返回空数组冒充实现**。
- 向量检索：先解析当前 embedding model（未配置按 Nest 跳过）；搜索文本 token 少于 2 且长度 <16 时不请求
  embedding；请求 metadata 保留 `orgId` 与 `source=items-search`；`limit=300`、`minSimilarity=0.78`、
  `lookback=30 天`；本地 Mongo fallback 候选最多 1200；`orgId`、`completed`、`embeddingModel`、非空向量、
  `duplicateOf=null`、时间窗口都必须保留；cosine 必须校验维度、有限数值与零范数；
  明确区分 `vector matches=[]` 与服务不可用 `null`。`ITEMS_VECTOR_HARD_FAIL_ENABLED`、`fallbackToMongo`
  与外层 `catch` 沿现有调用链核对（`items-search-query.service.ts:132-292`）。
  复用 `internal/llmembed` 仅限协议一致的部分；必要差异放在本批 typed adapter，不改公共客户端。

## 7. 必须一起修的 bug

行号基于规划 SHA `2672b62e35ed7235604c65939bcd335c81bf7d27`（开工核对一致）。

### IR1：Mongo 关联读取与回填没有完整绑定租户

**证据（修复前）**

| # | 文件:行号 | 代码 | 缺口 |
|---|---|---|---|
| 1 | `apps/api/src/modules/items/items.service.ts:221-224` | `RawItemModel.findById(itemMeta.mongoRef)` | 只验证 MySQL `ItemMeta` 的组织，未确认被引用 `RawItem.itemMetaId` 是否等于该 meta 的 id |
| 2 | `apps/api/src/modules/items/items.service.ts:225-227` | `ProcessedItemModel.findOne({itemMetaId: itemMeta.id})` | 查询**没有 `orgId`** |
| 3 | `apps/api/src/graphql/loaders/item-read-model.loader.ts:118-136` | `loadReadModels`：`ItemReadModelModel.find({itemMetaId:{$in:keys}})` | 批量读模型**没有 `orgId`** |
| 4 | `apps/api/src/graphql/loaders/processed-item.loader.ts:127-152` | `loadProcessedItems`：`ProcessedItemModel.find({itemMetaId:{$in:keys}})` | 批量 processed **没有 `orgId`** |
| 5 | `apps/api/src/modules/items/items-read-model.service.ts:313-339` | `buildLatestItemSnapshotPipeline(itemMetaIds)` 只 `$match itemMetaId` | 被 processed 回填复用时没有 `orgId`；raw 快照按 `_id` 读也没有 `itemMetaId` 配对校验 |
| 6 | `apps/api/src/modules/items/items-search-query.service.ts:892-898` | `ProcessedItemModel.find({_id:{$in:objectIds}})` | `ProcessedArticle.cleanedMarkdownRef` 反查 processed **没有 `orgId`** |

**触发数据**：组织 A 的 `ItemMeta.mongoRef` 指向组织 B 对应 raw；组织 B 的 processed 文档伪装
`itemMetaId=A`；组织 B 的 read-model 文档携带与 A 相同的 `itemMetaId`；A/B 混合批量 loader 请求；
缺失读模型后触发回填。

**修复前行为**：跨组织泄漏——A 请求能读到 B 的 raw/processed/read-model 内容；回填可能把 foreign
processed 写进 A 的快照；`ProcessedArticle` 反查可把 B 的 processed 映射进 A 的搜索结果。

**两侧修复点**

| 侧 | 文件 | 修复 |
|---|---|---|
| Nest | `apps/api/src/modules/items/items.service.ts` | REST processed 查询补 `orgId`；REST raw 先得到可信 org-scoped ItemMeta，再要求 `_id=mongoRef` **且** `itemMetaId=meta.id`；错配返回 `null` |
| Nest | `apps/api/src/graphql/loaders/scoped-items-reading.loader.ts`（新增） | request-scoped `ScopedItemsReadingLoader`：cache key 含 `orgId`，分批按组织读取；保留 raw/full/preview、processed full/scalar/preview、read-model 的选择与 fallback |
| Nest | `apps/api/src/graphql/resolvers/items.resolver.ts` | Item 嵌套字段改用 scoped loader；清理 `DataLoader<string, any>` 为明确类型 |
| Nest | `apps/api/src/graphql/graphql.module.ts` | 只新增注册 scoped loader 所需的 providers（不改 GraphQL Query/Mutation 公开签名与 SDL） |
| Nest | `apps/api/src/modules/items/items-read-model.service.ts` | `buildLatestItemSnapshotPipeline` 增加 `orgId`；raw 回填按已验证 meta 集合与正确 `mongoRef/itemMetaId` 配对；upsert filter 已是 `orgId+itemMetaId` |
| Nest | `apps/api/src/modules/items/items-search-query.service.ts` | `ProcessedArticle.cleanedMarkdownRef → ProcessedItem` 查询补 `orgId`（+ `status=completed`） |
| Go | `apps/api-go/internal/itemsreading/*` | 所有按 `itemMetaId` 的 Mongo 读取都带 `orgId`；raw 绑定校验；回填与嵌套读取以请求身份 `orgId` 为准，不从客户端参数或 `parent.orgId` 决定授权；检查 `snapshot.itemMetaId`、`doc.itemMetaId` 与目标 meta 一致性 |

**RawItem 没有 `orgId` 字段**（`packages/mongo/src/models/raw-item.ts:93-105`）：不得伪造该字段，
只能通过“可信 org-scoped ItemMeta + `itemMetaId` 配对”实现隔离。

**验证**：真实栈 smoke 中构造 A/B 污染数据，断言 A 的 REST 详情、GraphQL `item`、批量 loader 与回填
都读不到 B 的内容，且两组织各自的正常数据仍可见（证明修复不会把合法数据一起过滤掉）。

### IR2：分页偏移缺少安全边界

**证据（修复前）**：`apps/api/src/modules/items/items-list.service.ts:76-79`

```ts
const take = Math.min(Math.max(normalizedPageSize, 1), cap);
const normalizedPage = Number.isFinite(page) ? Math.floor(page) : 1;
const safePage = Math.max(normalizedPage, 1);
const skip = (safePage - 1) * take;      // 无整数/数据库边界检查
```

**触发数据**：`page=2147483647&pageSize=50`（skip = 107374182300）或更大的数字字符串。

**修复前行为**：`skip` 超出 MySQL/Prisma `skip` 可接受范围 → Prisma 报错（500），或静默回第一页/溢出。

**修复后明确契约**

- 保留正常 `page`/`pageSize` 归一化规则（含小数 floor、下界 1、`pageSize` cap）。
- `offset` 计算必须使用检查过的算术；`offset` 必须是非负安全整数且 `<= 2147483647`。
- 超出时 HTTP 400，`message = "Pagination offset is too large"`。
- **在任何搜索、缓存 loader 或数据库分页调用前失败**（不能先查库再报错）。
- 不允许 overflow、wrap、负 skip、500 或静默回到第一页。
- 边界政策写入文档，不伪称为原 DTO 已有约束。

**两侧修复点**：Nest 在 `ItemsListService.list` 修（`items-list.service.ts`，`skip` 计算处）；
Go 在共享分页归一化逻辑修（`apps/api-go/internal/itemsreading` 的 `NormalizePagination`），
**转成整数之前先完成范围验证**。回归 `service.list(..., { maxPageSize })` 的批量调用：
CSV 导出上限不被错误改为 50。

**验证**：smoke 断言越界请求 400 + 精确 message，且请求在触库前失败（检查无 500、无数据返回）。

### IR3：来源 fallback 绕过其他筛选

**证据（修复前）**：`apps/api/src/modules/items/items-search-query.service.ts:462-470`

```ts
const fallbackIds = await this.resolveSourceFilterFallbackItemMetaIds(
  orgId, filters.sourceIds, filters.dateRange);   // 只接收 sourceIds/dateRange
if (fallbackIds.length === 0) return primaryIds;
return dedupeItemMetaIds([...primaryIds, ...fallbackIds]);   // 直接 union
```

`resolveSourceFilterFallbackItemMetaIds`（同文件:478-536）只按 `Article.sourceId` + `crawlAt` 过滤。

**触发数据**：`filters = { sourceIds: [X], regions: ["EU"] }`（或 topics/contentTypes/sentiments/
excludeDuplicates 组合）。

**修复前行为**：primary 用全部 `matchFilters`，fallback 只按来源与日期，最后直接并集 ——
fallback 可把不符合 region/topic/sentiment/contentType/excludeDuplicates 的条目加回来。

**修复后**

- 来源 fallback 仍用于 `ProcessedItem.sourceId` 缺失的历史数据；保留 `Article.sourceId`/`crawlAt`
  的来源与日期判断。
- fallback 候选**还必须满足其余活动筛选**；内容筛选使用**同组织最新 completed 快照**，
  不能用任意旧快照恰好命中就放行。
- 保留各字段现有大小写、regex、null 与日期语义；**不禁用 fallback**；不改 read-model 分支筛选口径。
- 复用明确的筛选构造逻辑，避免两套条件未来漂移。

**两侧修复点**：Nest 在 `items-search-query.service.ts`（把 `matchFilters` 的构造抽成共用函数，
fallback 前对候选再按同一套条件过滤）；Go 在 `internal/itemsreading` 的同一位置。

**验证**：smoke 覆盖 source-only fallback 正常返回；source+region 排除错误地区；
source+topic/contentType/sentiment 排除不匹配记录；source+excludeDuplicates 排除重复条目；
source+dateRange 保留现有边界；REST 历史 encoded filters 与 `itemFacets` 两条入口都覆盖。

## 8. Redis key / TTL 与互通

| key | TTL | 说明 |
|---|---|---|
| `__items_search_suggestions__:${orgId}:${normalizedPrefix}:${clampedLimit}:v3` | 60s | 建议合并结果 |
| `__items_source_suggestions__:${orgId}:v1` | 180s | 来源计数快照（JSON 数组 `{source,normalizedSource,count}`） |
| `__items_vector_search__:${orgId}:${sha256(lowercaseQuery)}` | 300s | 向量召回 id 列表 |
| `lock:${cacheKey}` | `lockTtlMs=5000`（PX） | `SET NX PX` + token；续租与 Lua 比对释放 |
| `situation_monitor:settings` | 30s | `{exists,value}` 包装 |
| `llm_gateway:profiles` | 60s | LLM gateway 配置 |

互通验收：Nest 写缓存后 Go 能读、Go 写缓存后 Nest 能读；三类建议 key 的组织隔离；
锁 token 校验、续租、释放；配置共享缓存不能被部分 struct 覆盖。
**对比测试前明确隔离响应缓存与业务缓存**，不能让一次旧缓存命中掩盖真实读取错误。

## 9. REST 与 GraphQL 有意保留的差异

| 项 | REST `GET /api/items/:id` | GraphQL `item(id)` |
|---|---|---|
| 缺失语义 | 404 `Item not found` | `data.item = null` |
| processed 选择 | **最新记录**（`createdAt DESC`） | **状态优先**（completed > failed > processing > pending，再 `createdAt DESC`） |
| 形状 | legacy `lean` 文档（`_id` ObjectId）或读模型快照构造出的响应 | 读模型快照形状；`raw.payload`/`processed.result` 字符串化、`resultJson` 对象 |
| 错误 | REST 错误 envelope | GraphQL `errors`/`extensions`/`path` |

## 10. 身份与鉴权

- 7 个入口都要求真实认证身份与 `items.read`。用户、组织与权限从服务端认证及 MySQL 权限读取；
  **不相信请求参数/Header 自报 `orgId`，也不仅相信 JWT 携带的权限**。
- 保留既有 inactive user、成员关系、机器令牌等认证边界；保留限流、CORS、GraphQL 深度/复杂度、APQ、
  响应缓存与字段权限机制。
- REST 未认证/权限不足/校验失败沿用现有错误 envelope；GraphQL 沿用现有 HTTP 状态与
  `errors`/`extensions`/`path` 语义（**不直接复用 REST 错误 JSON**）。
- 不新增管理员门禁；本批是 `items.read` 业务读取。

## 11. 强类型与实现要求

- 业务代码禁止 `any` / `interface{}` / `map[string]any` / `map[string]interface{}` / `[]any`
  （含 DTO、响应、数据库 JSON、Mongo 文档、Redis 值与配置读取）。
- 具名 struct + 精确 `json`/`bson`/`graphql` tag；具名枚举与常量；明确区分
  missing/null/empty/zero。
- MySQL SQL 参数化；Mongo 查询可用 `bson.D` 构造操作符，但**禁止把查询结果 Decode 到无类型 map**。
- 固定业务字段不能用 `json.RawMessage` 透传；真正开放的 `payload.metadata`、`result` 扩展 JSON
  可用具名 lossless JSON 类型或 `json.RawMessage` 作为叶子字段。
- GraphQL 使用现有 `contract.Registry` 与 `contract.Bind[T]`；框架既有 `Context.Args` 泛型边界只在
  适配层处理并立即解码为本批 typed args；不修改框架泛型签名。
- 完整注册所需嵌套类型与现有字段权限；JSON scalar 使用执行器支持的 `json.RawMessage` token
  （不能把 JSON 对象作为普通字符串返回）；五个 root 统一 `items.read`；**不注册 `items` root**。
- 所有新增/修改后端源码英文注释；Go 每个包、每个导出符号有标准英文 GoDoc；
  租户绑定、fallback、分页算术、缓存互通、状态优先级与回填 null 语义有英文分支说明。
  修改到的 TypeScript 文件不得留下 `any`/`as any`。

## 12. 验收与未验证项（诚实登记）

### 12.1 已完成的远端验证

- 普通 CI（`ci.yml`，含 Go 编译/单测、Nest lint/typecheck、`check-auth-matrix.js`、契约与环境变量检查、
  `go-modules-regen` 与 `contract-baseline-regen`）在本分支各 head 上通过；最终 head 的 run 见 PR 正文。
- 真实栈 smoke（`.github/workflows/api-go-items-reading-smoke.yml`，PR label `api-go-items-reading-smoke`，
  或 `workflow_dispatch`；PR 上另有 `synchronize`/`reopened` 便于同一 PR 迭代）在 head `28f414cc`
  上 **ALL PHASES PASSED**：
  - A 开关矩阵：`API_GO_ITEMS_READING_MODE=bogus` 容器 `exited|unhealthy|1` 且日志同时含变量名与
    `bogus`；空串与 `legacy` 等价；`legacy+legacy` 两 REST + 五 GraphQL 经 Go 代理与 Nest 逐字段一致且
    Go 解析器计数不动；`go+legacy` 时两 REST 由 Go 独立处理、五个 root 仍在 Nest（计数不动）；
    `go+go` 时七个入口由 Go 处理。
  - B REST：分页归一化（默认 10/1、`pageSize=50`、`page=1.5→1`、`pageSize=0→1`）、`CREATED_DESC`/
    `PUBLISHED_DESC` 与 `id DESC` 稳定次序、DTO 400（`property pagee should not exist`、
    `orderBy must be one of the following values: CREATED_DESC, PUBLISHED_DESC`、`page must be a number string`）、
    IR2 越界 400 + `Pagination offset is too large`、详情 404（跨组织/缺失/非 ObjectId 形状）、
    IR1 跨组织 raw/processed 绑定、IR3 历史 encoded filters 的 (a)–(d)。
  - C GraphQL：`item(id)` 全字段形状（含 `raw.payload` JSON 字符串、`result`/`resultJson` 归一化、
    `duplicateOf` 目标 ItemMeta ID、`eventId` 直接与 `cleanedMarkdownRef` 回退、`metaId` 不泄漏）、
    缺失语义为 `data.item=null` 且无 errors、aliases/fragments/variables/`@include`/`@skip`、
    REST 最新 processed 与 GraphQL 状态优先的差异、`itemFacets`（含 filters 组合与 excludeDuplicates）、
    `rssSources`（默认只含有数据来源、显式 `onlyWithItems:false`、`windowDays` 1/0→1/30/99→30 与
    3 天旧来源被 1 天窗口排除）、`rssTranslationStatus` 八个配置分支与固定顺序、`searchSuggestions`
    空前缀/limit 边界/仅 LEXICAL。
  - D 缓存：建议缓存键与 TTL(≤60) 与响应一致、`lock:` 已释放、手工写入的建议缓存与来源快照被 Go 读取、
    两个组织的同前缀键不共享；Nest 写入的 `situation_monitor:settings` 与 `llm_gateway:profiles` 被 Go 读到。
  - RM 读模型：首次读取触发回填（`itemreadmodels` 计数 0→1）、第二次读取稳定、缺 raw 时下一次 GraphQL 读取
    经 Mongo 回退可见、删除后再次回填可见、读模型列表/详情与 Nest 一致、`meta.name` 用快照标题、
    读模型文本检索 facets 与 Nest 一致、跨组织读模型不泄漏。
  - E 停 Nest：七个入口仍返回非空真实数据；`POST /api/items`、`items` root、`createItem` mutation、
    migrated+unsupported 混合 operation 全部 502；`/__go/healthz` 200。
  - F 诚实负向：`ELASTICSEARCH_ENABLED`/`VECTOR_SERVICE_ENABLED`/`MODEL_SERVICE_ENABLED` 全程 false，
    只断言文档化的词法降级（建议仅 LEXICAL、列表与 facets 仍成功）。

### 12.2 验证期间发现并处理的环境事实（不改本批允许范围外的文件）

- `packages/db/prisma/schema.prisma` 在 `ProcessedArticle` 上声明 `@@fulltext([title, summary])`，但
  **迁移里没有对应索引**（`000_init` 只建了 `ItemMeta` 的 FULLTEXT）。纯迁移建的库里，
  `ProcessedArticle` 全文召回会返回 MySQL 1191（Nest 与 Go 同样失败）。smoke 在 fixture 阶段补建该索引
  （与 production 实际存在的索引一致）。**登记为遗留项**（见 `bug-ledger.md`），本批不修改 migrations。
- Mongoose `itemreadmodels` 的文本索引使用默认 `language` 作为语言覆盖字段，而 API 会写入
  `language: null`，MongoDB 会拒绝（"found language override field in document with non-string type"）。
  smoke 建索引时显式指定 `language_override:'irLanguageOverride'`。**登记为遗留项**，本批不修改
  `packages/mongo`。
- Go 读模型 upsert 的两个实现细节（本批修复）：`$set` 必须省略缺失的 `raw`/`processed`（否则与
  `$unset` 冲突），且不能写零值 `_id`（BSON 驱动的 `omitempty` 不会省略定长数组，会改/撞 `_id`）。
- read-model 模式的 Nest/Go 对比需要 Nest 以 `ITEMS_READ_MODEL_ENABLED=true` 重启（该开关只在进程启动时
  读取），smoke 的 RM 阶段重启 Nest 后再做同模式比对。

### 12.3 未验证项

- 未配置真实 LiteLLM 网关、DeepLX/fallback 翻译与 Elasticsearch：本批没有这些服务的真实成功链路证据。
  ES 与向量候选的请求结构、字段 boost/alias、`limit/minScore/lookbackMs`、`null` 与 `[]` 语义均由
  Go 单测（协议级）覆盖，**不称为真实上游成功**；向量 recall 在 smoke 中只验证“服务未配置时的降级”。
- 未运行真实 `vector-go` 服务；若要单列其证据，需另起带该服务的 workflow。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`go vet`、`docker`，未启动任何服务；
  所有执行验证均在本仓库的 GitHub Actions 中完成（见 12.1）。
