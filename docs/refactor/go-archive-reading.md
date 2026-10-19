# 归档阅读与搜索导出迁移（ARCHIVE-READING-001）

- 基线：`origin/main 91e759b449c4511dc96d86539ea0eb258754d07e`（普通 CI 39247556593 success）。
- 业务分支：`refactor/go-archive-reading`；工作目录 `/Users/oo/project/newwei-go-archive-reading`。
- 开关：`API_GO_ARCHIVE_READING_MODE`，空串/`legacy` → legacy，`go` → 接管本批四入口，非法值启动失败。
- 默认 legacy；不依赖 `API_GO_GRAPHQL_READ_MODE` 或 `API_GO_ANALYSIS_EXPORT_MODE`。

## 精确入口

| 入口 | 权限 | Go 实现 |
|---|---|---|
| Query `archiveDigest(input: ArchiveQueryInput!)` | `items.read` | `internal/archivereading.Service.Digest` + `internal/graphqlread/archivereading` |
| Query `archiveCalendar(input: ArchiveCalendarInput!)` | `items.read` | `Service.Calendar` |
| Query `archiveDetail(processedArticleId: String!)` | `items.read`，可 null | `Service.Detail` |
| `POST /api/analysis/exports/search` | `analysis.write`（JWT/`mtk_`/吊销/RBAC 沿 `accountsecurity`） | `analysisexport.SearchService` |

HTTP 成功固定 `201`、`text/csv; charset=utf-8`、`attachment; filename="analysis-search-export.csv"`。GraphQL 只新增三个 root；未支持的 root/Mutation/operation 仍由现有预检整份回退 NestJS。

## 查询与缓存事实

### SQL / 显示资格

- 只读 `ProcessedArticle` + `Article` + 当前组织 `NewsEventItem`；`status='completed'` 且 `Article.orgId` 约束。
- `sortAt = publishedAt ?? article.crawlAt ?? processedAt`；展示 `publishedAt` 使用同一回退。
- Digest 无搜索按 `processedAt DESC, id DESC` 400 条键集批读，`targetRows=min(12000,max(pageSize*5*6,maxCursorOffset+pageSize,1200))`；达到 12000 只告警并返回截断结果。
- Calendar 600 条键集批读至穷尽，保留 `publishedAt`/`crawlAt`/`processedAt` 的 OR/null 条件，再按最终 `sortAt` 过滤整月。
- Detail timeline `bucketStart ASC` 最多 160；related `NewsEventItem.createdAt DESC` 最多 12，所有关联再次按组织限定。当前 Detail 无正文翻译、全文生成或分类冷生成。
- Mongo `processeditems` 按 `_id=cleanedMarkdownRef`、`orgId`、`status='completed'` 批量读 `result.content_type|contentType`、`category_path|categoryPath`、`category_method|method`。
- 缺文档（`exists=false`）不触发 backfill；`exists && (!contentType || (!categoryPath && !categoryMethod))` 才需要显示信号回填。显示规则：blog/opinion 先排除，`intel[/...]`、`politics/geopolitics[/...]` 放行其他类型，否则只允许 `news_fact`/`mixed`。内容类型缺失时按 `news-content-type.ts` 的 aliases、URL、关键词和来源打分推断。
- 显示信号内存缓存 5 分钟/200 项，key 含 orgId。

### 分类缓存

- 本地规则信号通过 `newsnowclusteringops/archive_port.go` 复用已有 taxonomy/geo 数据；`archivereading` 只补 region 国家集合、country label 与缓存文本。
- 分类文本逐行生成 `Title/Summary/Topics/Entities/Location/Source/Country hint/Region hint`，保留 trim、去重、顺序与 SHA256；`textVersion=archive-text-v2`。
- hash/version 不匹配、非法 region/vertical → miss。`taxonomy=archive-vertical-v2`、`pipeline=archive-hybrid-v2`；当前非空 embedding/rerank 模型不一致分别 stale。
- Digest/Calendar 只用 fresh；Detail 可展示文本仍匹配的 stale，并复现 `selectVerticalOutcome`（强国家覆盖 `.62/.08`、低语义 `.55`、低融合 `.5`、`1e-9` 与固定栏目顺序 tie-break）。`STALE_CACHED_RESULT` 仅在 stale 且新判定栏目不同于存储栏目时使用。
- 读路径不生成、不写回分类；缺失计数是“缺 fresh 分类 OR 需 backfill”的 ID 并集，发生在 region/weight/显示过滤之前。

### 搜索

- 真实 `embedding → vector(limit=500,minScore=.55) + lexical → merge → rerank(前 180)`；vector 空结果且 available=true 是合法无召回，available=false 抛 `ARCHIVE_VECTOR_UNAVAILABLE`。
- Lexical 先 `MATCH(title,summary) IN BOOLEAN MODE`，失败告警后仍执行 contains；contains 使用完整 query+tokens 顺序去重前 8 项，上限 240；全文缺失候选补取，合并去重上限 500。
- 合并：semantic 先、lexical 后，按文章 ID 去重；lexical 全文包含 query=1，否则命中 token 比例；semantic clamp01；两者 >0 时 `base=clamp(.6*semantic+.4*lexical+.05)`，否则 `max`。`matchOrigin` 由召回成员关系决定。
- rerank 前 180，`topN=本批数`、`maxRetries=1`、`source=archive-search-rerank`；分数按 min/max 归一，`span<=1e-9` 时 max>0 → 1，否则 0；`relevance=.75*rerank+.25*base`，180 外候选保留 base。
- 双层缓存 key 均含组织：embedding 5 分钟（配置 model 作 key、实际 model 入 payload）、vector 60 秒（实际 embedding model）、rerank 90 秒（有序候选 ID 摘要）。共享缓存故障 best effort。
- 指标继续写 `archive:metrics:<orgId>:<UTC日期>`，TTL 30 天，保留 requests/rows/origins/rerank/query_length/cache 命中。
- 错误码：`ARCHIVE_EMBEDDING_UNAVAILABLE/FAILED/INVALID_RESPONSE`、`ARCHIVE_VECTOR_UNAVAILABLE`、`ARCHIVE_RERANK_FAILED/INVALID_RESPONSE`。LiteLlm 内部抛错→`*_FAILED`；响应拿到后无有效向量/分数→`*_INVALID_RESPONSE`；vector unavailable 不降级 lexical/Mongo。
- 每次真实模型逻辑尝试（404/405 fallback 仍算一次）写 `llmrequestlogs`：requestType、实际 model/profile/治理、`apiSurface=embeddings|rerank`、延迟、已上报 usage/cost、metadata source。feature 缺省为 null；缓存命中不伪造日志。

## BullMQ 准备生产者

- `internal/archivepreparation` 固定 BullMQ `5.63.2` 的 Lua（`addStandardJob-9`、`getStateV2-8`、`removeJob-2` 及递归 includes，生成时展开，运行时不下载），文件名 `scripts.go` 保留来源与 SHA256。
- queue/name=`archivePreparation`，prefix 默认 `bull`；payload `{scope,orgId,anchorDate|month,traceId}`；jobId `<scope>:<orgId>:<date|month>`（5.63.2 允许三段冒号）。
- waiting/active/delayed 直接返回且不重置状态 TTL；其他状态按官方受锁 `removeJob` 移除再 add。add opts：attempts=5、exponential 15000ms、removeOnComplete `{age:3600,count:1000}`、removeOnFail `{age:604800,count:10000}`。
- 新入队后 best effort 写 `archive:preparation:status:<scope>:<orgId>:<scopeValue>`（TTL 3600）并 `ZADD archive:preparation:status:index`，全局裁剪至 200；与已迁状态 HTTP 的组织快照读取兼容。
- **NestJS `ArchivePreparationProcessor` 仍是唯一消费者（concurrency 1）**：读取设置、分类生成、显示信号回填、`PROCESSING→PARTIAL→READY/FAILED` 与 SQL 写回。Go 不创建 consumer、不改 worker owner、不新增 cron/repeat。`BULLMQ_WORKERS_ENABLED` 当前不 gate 该 processor，因此不能依赖它停消费。
- 回滚只退本批入口；已排队 job 继续由 NestJS 消费，禁止 flush/delete 队列。

## headlines 导出快照

- 单次请求固定 anchor、候选/分类/显示/搜索结果；非搜索扫描至 12000 预算或数据穷尽，搜索仍保留 500 召回/180 重排且只调用一次搜索链。
- 从同一五组快照按固定栏目顺序、每轮每组 100 条、`processedArticleId` 去重输出，总计最多 5000；不先写完一个栏目再写下一个，耗尽组不重复从 0 读。
- 这是导出行为改善：非搜索可覆盖交互前缀之外、12000 预算内的旧结果；同一候选集合保持原分轮顺序与 CSV 字节。交互 `archiveDigest` 的候选预算、游标和排序不变。
- 13 列固定：`processedArticleId,title,summary,countryLabel,region,vertical,weight,publishedAt,sourceLabel,eventId,matchOrigin,relevanceScore,sourceUrl`。null→空 cell，日期 UTC ISO 毫秒，数字按 JS String；复用现有无 BOM、LF、无尾换行、转义与公式前缀保护。items 模式直接复用已迁 12 列导出。

## 装配与回滚

- `API_GO_ARCHIVE_READING_MODE=go` 单独开启时：配置校验、shared MySQL、Redis、Mongo、authenticator、GraphQL handler/模型、search HTTP handler、items 导出依赖与 producer 全部独立装配。
- 共享文件只做最小增量：`cmd/api/main.go`、`internal/config/config.go`、legacyproxy 精确规则、`.env.example`/compose/README、`go.mod`。
- 只创建共享连接，不新开 HTTP server、不启后台 goroutine/cron；新资源沿既有共享关闭顺序。
- 回滚：改回 `legacy` 并重启。没有 schema 迁移或数据回滚；NestJS 队列消费 owner 不变；不清缓存或队列。

## 验证边界

本机未安装依赖、未运行 build/test/Docker/服务。已做 `gofmt` 与静态审阅。代码 head `5683e0cf` 的普通 CI [39310112110](https://github.com/wei500L/newwei/actions/runs/39310112110)：`verify`、`api-go-user-settings-integration`（含 archivepreparation 真实 Redis 7.2 协议用例）、`vector-integration` 均 success；skipped job 不计通过。真实 MySQL/Mongo 数据、NestJS worker 消费、embedding/vector/rerank 上游、部署与切流均未验证；Redis 协议通过不等于完整 NestJS worker 已运行。
