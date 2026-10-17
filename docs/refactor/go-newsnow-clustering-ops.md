# NewsNow 本地计算与新闻事件聚类失败管理（Go）

> 本批：`API_GO_NEWSNOW_CLUSTERING_OPS_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。

## 开关与回滚

- 变量：`API_GO_NEWSNOW_CLUSTERING_OPS_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名（`API_GO_NEWSNOW_CLUSTERING_OPS_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。`MONGO_URI` 缺失时启动失败（`MONGO_URI is required when API_GO_NEWSNOW_CLUSTERING_OPS_MODE=go`）；`DATABASE_URL` DSN 无效时启动失败。
- 不启用 shadow：本批没有差分执行单元，`legacy` 时不注册 handler、不追加路由规则、不额外打开 Mongo 连接。
- 回滚：**只把 `API_GO_NEWSNOW_CLUSTERING_OPS_MODE` 改回 `legacy`**——纯配置变更。

## 接管的 9 条精确路由

| # | 方法 | 路径 | 鉴权 | 成功码 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/news-aggregator/metadata` | `@Public()` | 200 |
| 2 | GET | `/api/news-aggregator/resolve` | `@Public()` | 200 |
| 3 | POST | `/api/news-aggregator/sources/order` | `items.read` | 201 |
| 4 | GET | `/api/news-aggregator/domestic-opinion-index` | `items.read` | 200 |
| 5 | GET | `/api/system-settings/news-events/clustering/readiness` | `settings.manage` | 200 |
| 6 | GET | `/api/system-settings/news-events/clustering/overview` | `settings.manage` | 200 |
| 7 | GET | `/api/system-settings/news-events/clustering/failures` | `settings.manage` | 200 |
| 8 | POST | `/api/system-settings/news-events/clustering/failures/:groupId/vector-backfill` | `settings.manage` | 201 |
| 9 | POST | `/api/system-settings/news-events/clustering/failures/:groupId/ignore` | `settings.manage` | 201 |

除 1、2 外，7 条同时接受人类 JWT（验签 + Redis 撤销名单 + MySQL membership 权限重推导）与 `mtk_` 机器令牌（`MachineAccessToken` SHA-256 + `Org.isActive`，权限与 `orgId` 只取令牌行）。`orgId` 只来自鉴权结果，query/body 里的 `orgId` 不参与。

路由规则在 `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go`，处理器注册键 `NewsnowClusteringOpsKey`。规则是「精确路径或恰好一段 + 固定尾段」加方法白名单，`OPTIONS` 预检一并交给 Go。

## 明确留在 NestJS 的路由

- `GET /api/news-aggregator/source`、`POST /api/news-aggregator/sources/batch`、`GET /api/news-aggregator/hottest-analysis`、`GET /api/news-aggregator/recommended`：需要抓取外网源。
- `POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill`：需要投递 BullMQ 任务并调用 LLM 网关。
- 上述 9 条之外的方法（例如 `POST /api/news-aggregator/metadata`）、同级路径（`/api/news-aggregator/sources`）与更长路径继续回落 NestJS —— Go 不返回自己的 404。

## 各接口实现要点

### metadata

`data_gen.go` 内嵌由 NestJS 事实源机械生成的 `genSources()` / `genMetadata()` 确定性结果（64 个源、7 个固定列）。为做到与 NestJS **逐字节等价**，`newsnowMetadataSource.MarshalJSON` 按生成期记录的键顺序输出：普通源是 `title` 在前，`sub` 父条目是 `redirect` 在前，`sources` / `columns` 也按插入顺序而不是 Go map 的字典序。

### resolve

`buildComparableURLVariants` 的等价实现：解析为 WHATWG 语义（scheme/host 小写、去掉默认端口、空路径视作 `/`），生成 `full`、`fullHash`（sha256 hex）、`base`。先读 Redis，未命中按 5 级优先级查 Mongo `rawitems`（一律 `createdAt desc`）：

1. `urlComparableFullHash + urlComparableFull` → 置信度 `1`
2. `urlComparableFull` → `1`
3. `payload.url` 精确匹配（`rawUrl` 与 `full` 两种写法）→ `1`
4. `urlComparableBase` → `0.93`
5. `payload.url` 前缀正则 `^<base>(?:/)?(?:[?#].*)?$`（大小写不敏感）→ `0.86`

命中写 Redis：命中缓存 TTL 300s、未命中 30s。Redis 键是 `newsnow:resolve:v1:<fullHash>`（NestJS 用 `news-aggregator:resolve:v1:<sha1(full|base)>`，两套键互不干扰，切换期可共存）。

### sources/order

请求校验与 Nest 控制器一致：`column` 缺失/空白 → 400 `column is required`；不匹配 `^[a-z0-9_-]{1,64}$` → 400 `invalid column format`；`sources` 非数组 → 400 `sources must be an array of source ids`；`settings` 不是对象（含 `null`）→ 400 `settings must be an object`。

用户设置 `ui:newsnow:settings:v1` 复用 `internal/usersettings`（`FindNewsnow` + `NormalizeNewsnow`，与 `normalizeNewsnowUiSettings` 1:1）。运行时策略读 MySQL `SystemSetting.key = newsnow_personalization_settings`（缺行取默认值；存在但非法 → 409 `NEWSNOW_PERSONALIZATION_SETTINGS_INVALID`）。行为画像复用 `internal/newsbehavior`。

个性化评分（`sortMode` 为 `personalized`，`NormalizeNewsnow` 已把 `smart` 归一成它）：14 天衰减因子 `1 - elapsedDays / (14 * 1.25)` 并 clamp 到 `0.2..1`；正负向行为分先 `log1p` 再按各自最大值归一；`combinedScore = affinityContribution + behaviorContribution + focusBonus`。缓存是 Redis fresh/stale 双键 + 有序集合索引（按 `Date.now()` 打分，超过 `maxCacheEntries` 时按最旧淘汰，单批上限 200，索引 TTL 1800s），限流是每用户滑动窗口（超限且无 stale 缓存 → 429 `NewsNow personalized ordering is rate limited. Please retry shortly.`），并写 `newsnow:personalization:metrics:v1:<UTC 日期>` 哈希计数（TTL 45 天）。

### domestic-opinion-index

`hours` 非空时必须是 `1..168` 的整数字符串，否则 400 `hours must be an integer between 1 and 168`；缺省 24。

读 MySQL `NewsnowDomesticOpinionIndexSnapshot`（`orgId, bucketStart >= since`，升序）与 `ProcessedArticle`（`orgId, status = 'completed', eventAt >= since`，连同 `Article.crawlAt/sourceId` 与 `NewsSource.language`），并用 Mongo `processeditems` 的 `sourceId` 与 `result.sentiment_label` 补信号。

国内报道判定：源在 `DOMESTIC_SOURCE_IDS`（`china` 列的源集合），或（不在该集合时）中文语言信号且 `ArchiveClassifier` 规则分类结果为 `DOMESTIC_AFFAIRS`。分类器与国家级别名表同样由 `archive-taxonomy.ts`、`country-data.ts`、`geo.ts` 机械生成；`Intl.DisplayNames` 派生的本地化名称无法在 Go 中复现，代码里已注明。

融合公式：同一小时内两侧都有时按 `0.75`（NewsNow 快照）与 `0.25`（流水线）加权（`mergeWeightedMetric`，两侧权重和为 0 时退化为算术平均）；`sentimentPressure` 用 `candidateCount` 与 `articleCount` 作权重。单侧存在时直接取该侧。`indexValue = clamp01(attention*0.5 + breadth*0.2 + freshness*0.2 + sentiment*0.1)`。返回 `{generatedAt, dataState, emptyReason, diagnostics, latest, trend, topKeywords, topCandidates, breakdown}`，空数据时 `dataState = "empty"`、`emptyReason = "no_recent_snapshots_or_pipeline_data"`，数组字段一律为 `[]` 而不是 `null`。

### clustering readiness

读 MySQL `SystemSetting.key = model_service`（字段级回落到 `MODEL_SERVICE_ENABLED` / `MODEL_SERVICE_BASE_URL` / `MODEL_SERVICE_INTERNAL_TOKEN`，存储令牌支持 `system-settings:v1` AES-256-GCM 信封）与 `llm_gateway_profiles`（`activeId` 指向且启用的 profile，否则第一个启用的 profile），返回 `{modelService:{ready,enabled,baseUrl,hasToken}, llmBackfill:{ready,profileId,profileName,model,apiSurface}, recoveryAutomation:{enabled:true,intervalSeconds:300,retryAfterSeconds:900,batchSize:25,actorId:"system:news-event-clustering-recovery"}}`。任一侧缺行都降级为 `ready:false`，不报错。

注意 NestJS 的键名是 `model_service`（不是 `model_service_settings`）。Go 直接读 MySQL 而不读 NestJS 的 Redis 缓存（`model_service:settings`、`llm_gateway:profiles`），两者由同一行归一化而来，结果一致。

### clustering overview / failures / ignore

- `overview`：统计当前 `orgId` 下 Mongo `newseventclusteringfailures` 的 `pending`/`processing`/`resolved`/`ignored` 计数与最新一条 `createdAt`（`latestFailureAt`）。
- `failures`：`status` 只在这四个枚举值时过滤，否则忽略过滤；`limit` 缺省 20 并 clamp `1..200`；按 `createdAt desc` 返回。
- `ignore`：按 `{orgId, groupId}` 置 `status = "ignored"`、`activeJobId: null`、`resolvedById`、`resolvedAt`、`resolutionMode: "ignored"`；找不到 → 404 `News event clustering failure not found`。

### clustering vector-backfill（缺陷 3 的修复点）

入口先读文档：不存在 → 404；`processing` → 400 `Failure group is already processing`；`resolved`/`ignored` → 400 `Failure group can no longer be recovered`。

随后用 `{ orgId, groupId, status: "pending" }` 的 `findOneAndUpdate` 原子抢占为 `processing` 并推进 `lastAttemptAt` / `attemptCount`。**未抢到时回查当前文档**再按上面三种情况抛错。这一步是缺陷 3 的核心：原先 `findOne` 检查后不翻转状态就直接进入循环，两个并发请求都会通过检查并重复创建事件。

抢到后按失败组内每条 `items` 在本组织 `NewsEvent` 上做本地匹配：候选是 `status = 'active'` 且 `lastAt >= now - lookbackDays` 且（`primaryTopic` 相等或 `primaryEntity` 相等）的事件，按 `lastAt desc, startAt desc` 取前 30 条。命中分数是 `(topic 命中 + entity 命中) / 2`，再乘语言惩罚 `1 - crossLanguagePenalty`，再过分类闸门（`classificationGateEnabled`、`minCategoryConfidenceForGate`、`categoryConflictReject`、`categorySoftPenalty`）。都不命中则新建 `NewsEvent` 并写入 `NewsEventItem`（`assignedBy = "overlap"`）。**全程不发外网模型请求、不查 Qdrant、不投递队列**。

成功后置 `status = "resolved"`、`resolutionMode: "vector_backfill"`、`resolvedEventIds`（排序）并写 `tasklogs`（`stage = bertopic_vector_backfill`，`status = completed`）；失败则把状态放回 `pending` 并写 `lastError`（`attemptCount`/`lastAttemptAt` 已由抢占阶段推进）。

## 本批同修的 3 个真实缺陷

1. **`id as any`**（`apps/api/src/modules/news-aggregator/data/metadata.ts` 第 38 行）：改用 `ReadonlySet<string>` 承载 `fixedColumnIds` 并定义显式类型守卫 `isHiddenColumnID`，同时去掉末尾的 `as HiddenColumnID[]`。
2. **URL 反查跨租户**（`news-aggregator.service.ts` `resolveByUrlUncached`）：拿到 `itemMetaId` 后先 `prisma.itemMeta.findUnique({ id, select: { id, orgId } })`；查不到直接返回 `{ matched: false }`；后续 `ProcessedItemModel.find` 与 `prisma.newsEventItem.findFirst` 都显式带 `orgId`。Go 侧在 `urlresolve.go` + `store_resolve.go` 同步实现。
3. **聚类恢复缺少原子抢占**（`news-event-clustering-failure.service.ts` `resolveFailureGroupByVectorBackfill`）：见上一节。Go 侧在 `clusteringfailure.go` + `store_clustering.go` 同步实现。

## 强类型与注释规范

- Go 业务代码零 `any` / `interface{}` / `map[string]any` / `[]any`：所有 DTO、注册表、评分明细、舆情指数与 Mongo/MySQL 扫描行都是具名 `struct`，字段带精确 `json` / `bson` tag；枚举（`SortMode`、`NewsnowDataState`、`ClusteringFailureStatus`、`ArchiveVertical`、`StaleTTLStrategy`）是具名类型 + 常量。
- 所有新增/修改的后端 `.go` 与 `.ts` 代码注释为英文；Go 每个包、导出类型/函数/常量都有以符号名开头的 GoDoc 注释；衰减公式、0.75/0.25 融合、5 级 URL 变体匹配、`vector-backfill` 原子抢占处都有英文行内注释。
- 仅 Git commit、PR 描述与本 `docs/refactor/*.md` 使用中文。

## 验证

- 普通 CI（`.github/workflows/ci.yml`）：Go 模块漂移门、`pnpm --filter @modular/api-go test`（本包单测在此执行）、auth-matrix 与 OpenAPI/SDL 漂移门，以及 `pnpm lint`（Go 侧即 `go vet ./...`）。
- 专项 smoke：`.github/workflows/api-go-newsnow-clustering-ops-smoke.yml`，`workflow_dispatch` 或 PR label `api-go-newsnow-clustering-ops-smoke` 触发，不在普通 CI 中执行。
