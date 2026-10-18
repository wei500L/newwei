# 条目列表 GraphQL Query `items` 迁移（Go）

基线 `origin/main` 的 `9d0462e16d88d146b8afbf67cdd58d8b7419ff29`（main CI run
https://github.com/wei500L/newwei/actions/runs/39127631691 `success`）。本批只做后端，不改 Web UI、
不改生产入口（Web → NestJS 保持，canary 仍 0）。

## 精确 root、权限与开关

- 新增接管 Query `items(after: String, filters: ItemsFiltersInput, first: Int! = 10, orderBy:
  ItemsOrderBy! = CREATED_DESC, page: Int, rankingMode: ItemsRankingMode, search: String):
  ItemConnection!`，根权限 `items.read`。`orgId` 与个性化 `userId` 只取服务端重推导身份。
- 新增独立子开关 `API_GO_GRAPHQL_ITEMS_LIST_MODE`（空 / `legacy` / `go`，默认 `legacy`，非法值
  `config.Load` 失败）。`go` 明确要求 `API_GO_GRAPHQL_READ_MODE=go` **且**
  `API_GO_ITEMS_READING_MODE=go`，不静默打开父开关；父模式不满足时 Load 直接报依赖错误。
- 本开关为 `legacy` 时不登记 `items`，含 `items` 的 operation 在任何 resolver 或副作用前整份回
  NestJS（沿用 `exec/walk.go` 的未注册 root 预规划回退）。回滚只把该变量改回 `legacy`：其余 5 个
  条目读 root 与两条 REST 路由不受影响，无 schema 迁移、无数据库/缓存删除。
- Compose/示例只新增该变量默认 `legacy`。

## 分页与排序契约

- `first` 默认 10，业务交互页上限 50（`MaxCursorPageSize`）。`after` 与有效 `page` 同时出现时
  400，原消息 `Use either 'after' cursor or 'page' pagination, not both.`；空 `after` 或 null
  `page` 不算冲突。
- `page` 分支先用 `checkedOffset(page, take)` 走 IR2 的 `2147483647` 上限（在搜索/缓存/DB 调用
  之前），`hasNextPage` 为 `page * pageSize < total`。
- 时间游标是 `base64(JSON)` 的复合 `(time, id)` 边界：`CREATED_DESC` 用 `createdAt`，
  `PUBLISHED_DESC` 用 `sortAt`；`limit = take + 1` 决定 `hasNextPage`，不是普通 offset。
  `PUBLISHED_DESC` 输出仍以 `publishedAt` 字段为准，排序只用 `sortAt` 列。
- `RELEVANCE` / `PERSONALIZED` 游标是 `{id, offset}`：`RELEVANCE` 先按当前排序找 cursor id、找不到
  再回退 `offset + 1`（负 offset 归起点）；`PERSONALIZED` 先取有效非负 `offset + 1`、没有时才按 id
  定位。两条重定位规则不合并。
- 解码兼容旧 `base64(id)` 与新 JSON；无法解码、JSON 无有效 id 时按 Nest 视作无 cursor（不抛 400）。
  时间戳缺失时按 `orgId` 查 cursor 行；cursor 行缺失、受限 id 集合不含 cursor、排序列为空等分支与
  源码一致，不会一律返回第一页。
- `filters` 显式非 null 时优先于历史 `__items_filters__` payload（含 `{}` 视为“无筛选”），null/缺省
  回退历史 filters；root 保留 presence，不把 `{}` 还原为旧 filters，也不改其他 root 行为。
- `rankingMode` 缺省由**原始** `search.trim()` 是否非空决定：非空 `RELEVANCE`，否则 `RECENCY`；
  service 解析历史 payload 后只有 `RELEVANCE` 且实际 search 非空才相关性排序。

## RELEVANCE 算法

- 复用 `internal/itemsreading` 已有 `ParseSearchPayload`、`ResolveScopedIDs`、MySQL/Mongo/read-model
  召回、ES/vector 召回；召回顺序不是最终相关性分数，候选一律重新排名。
- 配置沿用 `ITEMS_SEARCH_RECALL_MAX_CANDIDATES`(120)、`ITEMS_SEARCH_RERANK_MAX_CANDIDATES`(40)、
  `ITEMS_SEARCH_RERANK_ENABLED`(true)、`ITEMS_SEARCH_RERANK_TIMEOUT_MS`(300)、
  `ITEMS_SEARCH_RECENCY_HALFLIFE_HOURS`(48)。
- 按 Nest 从 title/summary/topics/entities 拼具名文档（topic/entity 各前 5）；旧 processed result
  字段别名与 read-model 特征分别处理。预排 `lexical*0.7 + recency*0.3` 取 `rerankMax`；未进入 rerank
  的候选仍用 lexical，不删除。
- `finalScore = 0.55*clamp01(base) + 0.25*recency + 0.15*sourceTrust + 0.05*quality`，钳制 0..1；
  `quality` 缺省 0.5、`sourceTrust` 缺省 0.6，来源匹配表照 `items.shared.ts`。recency 是指数半衰期。
  final 按 `score DESC, sortAt DESC, id localeCompare ASC` 稳定排序，并保留 `relevanceScore` 与页面
  ES highlights（highlight 读取失败按原行为降级为空）。rerank 失败不降级：启用且模型/网络/无有效
  分数时返回 503 `RERANK_UNAVAILABLE`（安全 detail），原消息
  `Reranker unavailable: failed to rank relevance results.`。
- 新增 `llmembed.RerankWithOutcome` 具名调用 options/观测面：本次请求 timeout（下限 100ms）、每模型
  `maxRetries = 1`、metadata `source=items-search-rerank`；旧 `Rerank` 签名与默认行为保留。`llmembed`
  的 `runtimeProfile` 只新增只读观测字段（profile/governance/authMode）。
- 本链路 rerank 请求日志在 `internal/itemsreading/rerank.go` 隔离实现：best effort 写既有
  `llmrequestlogs` 集合，字段为 orgId、`requestType=rerank`、实际 model/attempt、status、latency、
  usage/cost 为 null、profile/governance/authMode、`apiSurface=rerank` 与按
  `llm_request_log_settings` 策略过滤后的 source metadata。写失败只记服务端日志，不改变查询结果，
  不记录原文或密钥。

## PERSONALIZED 算法

- 复用 `newsbehavior.NewService(db, redis).GetPersonalizationProfile(orgId, userId)` 的 Redis 窗口/
  衰减画像，不重建行为 API、不在读取时记录点击；只把正/负六维转为本域具名类型，不带旧动态 `Meta`。
- 候选 `MIN=180`、`MAX=1600`、`MULTIPLIER=8`；`total = min(rawTotal, 1600)`；按 `sortAt DESC,
  id DESC` 增量游标召回，过滤/去重后不足再扩大窗口（`targetWindowSize*2`），不是固定 180 条。
- 特征读取 source/domain/topics/entities/eventIds，`NewsEventItem` 带 `orgId`；无 orgId 的 `rawitems`
  只按来自组织范围 ItemMeta 的 `itemMetaId` 绑定，不能从请求伪造。画像词条按正有限值排序、最多 400。
- `recency = 1/(1+ageHours/36)`（与 relevance 半衰期不同）；source/topic/entity/item/event/domain
  权重 1.15/1/0.9/1.45/1.2/0.75；`behavior = log1p(max(0,positive)) -
  log1p(max(0,negative*1.15))`；`final = behavior*0.78 + recency*0.22`，无画像时直接 recency。
  topics/entities 各前 6、events 前 4 求和；source preference 取 source/domain 匹配较大值。分差阈值
  0.0001，其后 `sortAt DESC`、`id ASC`，`rankOffset` 按最终顺序。未认证 userId 时回退 `CREATED_DESC`。

## 批量嵌套投影与查询优化

- `internal/graphqlread/contract` 新增最小只读选择元数据 `FieldSet`（按 canonical 字段名，alias 已
  折叠），`exec` 用现有 `collectFields` 构建并放进 `contract.Context.Selection`，因此 fragment、
  `@skip`/`@include` 与 alias 都按既有语义解析；不重写 executor、不引入新 DataLoader 框架。
- 新增 `RegisterList`、`ItemConnection`/`ItemEdge` 类型（`PageInfo` 复用 settingscrawl 已注册类型，
  未注册时才补），不覆盖已注册公共类型或字段权限。
- 本页批量装配取代“每个 edge 调一次 `item()`”：read-model 模式一次查 Meta/Raw/RawPreview/
  Processed/ProcessedPreview 投影，非 read-model 模式一次 `FindRawItemsBound` + 一次
  `ProcessedByKeys`；`eventId`/`duplicateOf` 也批量解析（直连 `NewsEventItem` 一次查询，仅少数未命中
  再走 `ProcessedArticle` 回退）。单条 `item` root 复用同一装配函数。
- 按选中字段决定是否加载 `processed.result` 与本页原文：只取 `id`/`totalCount` 不加载 raw/processed。
  `totalCount` 被选中（含 alias/fragment）时计算真实总数，未选中时时间排序分支跳过 COUNT；
  RELEVANCE/PERSONALIZED 仍计算其候选总数（`hasNextPage` 依赖）。分页投影不把“未加载”当业务不存在。

## 仍然由 NestJS 执行

- `createItem`、`updateItem`、`createItemFromCrawlResult`、`translateRssItems` Mutation 与 RSS 订阅；
  `item`/`itemFacets`/`rssSources`/`rssTranslationStatus`/`searchSuggestions` 之外的 items 域入口。
- 本批不迁 BullMQ/cron/后台索引/RSS 翻译/创建更新/导入/流水线，不新增 worker 或写模式，不要求
  `USER_NEWS_BEHAVIOR_MODE`、`WORKSPACE_READ`、公共门户或任何写模式。

## 验证与未验证

- 普通 CI：业务 head `c45f1afe3754fab3cdd31e6fb8ba5b9eb37bd9eb`，[run 39136842080](https://github.com/wei500L/newwei/actions/runs/39136842080) success（verify 的 lint/typecheck/Web 覆盖率/Vector+API 测试/契约与 SDL 漂移/Go tests/build/SBOM/Compose pin，加 user-settings 与 vector integration）；两个 smoke 与两个 regen 为 skipped，不记为本批通过。修复链：`3a8b73d1`（go vet undefined）→ `0c8f645d`（选择元数据测试与 root 父类型）→ `de7256b5`（测试查询缺子选择集）→ `c45f1afe` success。本地只做 `gofmt`、`git diff --check` 与只读静态复核，未在本机运行 build/test/Docker/服务。
- 新增少量 CI 行为测试：游标新旧格式与无效值、显式 `{}` filters 优先、IR2 offset 上限、两条排序
  公式、画像词条归一化与来源/域回退、选择元数据对 alias/fragment/`@skip`/`@include` 的解析、
  新子开关与父依赖。
- 未做实网验证：Elasticsearch、vector 服务、embedding/rerank 模型、真实 MySQL/Mongo/Redis 并发、
  部署、流量与回滚演练均未在本地运行；`llmrequestlogs` 写入与 TTL 策略只做只读源码核对。
