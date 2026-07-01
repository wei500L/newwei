# 性能深度分析报告（第二轮 · 系统性根因）

> 策略: review-audit · 范围: 全项目性能维度 · 方法: 纯静态只读 · 第二轮 5 路深挖代理 + Claude 复核 · 日期: 2026-06-03
> 配套文件: 第一轮宽度扫描见 [`report.md`](./report.md)（6C/18W/11I）
> 本轮定位: 不再做 file:line 点状发现，而是**端到端热路径量化 + 索引覆盖矩阵 + 连接/资源配置 + 多租户扩展性根因**。
> 本轮新增: **13 Critical · 31 Warning · 13 Info**，并对第一轮 2 条结论作出修正。

---

## 0. 对第一轮的修正（Claude 读码复核）

| 第一轮结论 | 修正 | 依据 |
|-----------|------|------|
| **C5** `situation-monitor-content.tsx:51` WarMap 静态导入（Critical） | **❌ 不成立 / 已解决**。当前 `:51` 是 `buildAdminSettingsHref`；WarMap 在 `:154` 用 `dynamic(() => import(...).then(m=>m.WarMap), { ssr:false, loading })` 正确懒加载。真正的 deck.gl 静态导入在 `map/page.tsx:6` 与 `finance/market-overview.tsx:10`（见 D-FE-1/2）。 | 复核 situation-monitor-content.tsx:51,146-159 |
| **W** `queue.processor.ts:90` pipeline 并发仅 3 | **修正**：有效默认是 **8**（`config.service.ts:973` `NEWS_PROCESS_QUEUE_CONCURRENCY ?? 8`）。`queue.processor.ts:92` 的 `> 0 ? cfg : 3` 中的 `3` 仅在 env 配 ≤0 时兜底。**降级为 Info**。真正的吞吐瓶颈是串行 LLM 链（D-ING-1），非 worker 并发。 | 复核 config.service.ts:971-973 |

> **栈事实更正**：Prisma datasource 是 **MySQL**（`schema.prisma:10`），非 PostgreSQL。下文索引建议按 MySQL/InnoDB 语义（复合索引最左前缀、`filesort`、`index_merge`）给出。

---

## 1. 五大系统性根因（本轮核心结论）

第二轮把 53 条点状发现归结为 **5 个可解释、可量化的系统性根因**——修这 5 个根因，能消除约 70% 的发现：

### 根因 ①：摄入流水线「串行 LLM 链」是平台吞吐天花板
`runIndependentEnrichmentStages`（news-pipeline.service.ts:1517）名为"independent"，实则 `entities → sentiment → KG` **逐个 await**，无数据依赖却串行；加上 clean、classify，每篇文章 **≈5 次串行 LLM 调用**。稳态吞吐 ≈ `worker并发(8) / Σ(LLM延迟)`。这是比任何 DB 问题都更硬的吞吐上限。

### 根因 ②：「每阶段/每条」写放大——遥测与审计日志淹没真实工作量
`recordStageOutcome`（22 处调用）每阶段写 1 Mongo `TaskLog.create` + 1 PG `findUnique` + 1 PG `updateMany`；每篇文章 ≈10 Mongo + 20 PG 往返**仅用于进度遥测**，与真实工作量同量级。第一轮 C4（gate 日志 await）只是此模式的一个实例。同类还有：KG 关系逐条 upsert（50-100+ PG/文章）、每文章游标 `state.update`、每接收者 `notification.create`。

### 根因 ③：无投影的全文档读取——热读路径拖拽大字段
主 items 列表与所有 ItemModel 字段解析器经 `ItemReadModelLoader` 拉取**整个反范式文档**（`raw.payload` HTML、`processed.result` 大 JSON、`summaryEmbedding` 向量、`searchText`），却只用其中几个标量。批处理（DataLoader）掩盖了 payload 体积成本，并未消除它。

### 根因 ④：索引与查询形状错配——热查询走 COLLSCAN / filesort
两条**每次搜索都跑**的查询是全集合扫描：`resolveProcessedSearchIds`（不锚定正则 `$or`）与 `resolveReadModelSearchIds`（`titleLower/externalIdLower` 未建索引使整个 `$or` 退化为扫描）。另有公共首页 feed、事件聚类候选、war-map 地理查询等 filesort/扫描放大。

### 根因 ⑤：per-org 串行 + 连接不复用——多租户线性劣化
`realtime-signals`（EVERY_MINUTE 全局锁内 per-org 串行）、`news-events-timeline`（per-org 串行无重入保护）成本 O(#orgs)，租户增长直接逼近 tick 周期。叠加 BullMQ 每队列各开连接（**~40+ Redis 连接**）、OTel 100% 采样、~8 个 EVERY_MINUTE cron 同点惊群——资源消耗随 **队列数/租户数/连接数** 增长而非随负载增长。

---

## 2. 文章摄入流水线 · 端到端成本剖析

### 2.1 每篇文章成本表（cache-miss、非重复，按阶段）

| 阶段 | DB 往返 (Mongo+PG) | 外部/LLM/向量 | 批量? | 并发 | 备注 |
|---|---|---|---|---|---|
| crawl/fetch | 1-3 Mongo 读 (+miss 时建 crawl 任务) | 0-1 HTTP；列表展开最多 **5** 次额外 crawl | n/a | worker=8 | 命中缓存免 LLM |
| clean | 1 Mongo (内容哈希缓存) | **1 LLM** (+0-1 修复) | per-item | 8 | |
| **recordStageOutcome ×N** | **每阶段** 1 Mongo create + 1 PG findUnique + 1 PG updateMany | 0 | ❌ 逐阶段 | 8 | 22 处，~8-10 次/文章 → **~10 Mongo + ~20 PG/文章** |
| entities | (+1 stage) | **1 LLM** | per-item | 8 | 串行 await |
| sentiment | (+1 stage) | **1 LLM** | per-item | 8 | 串行（在 entities 后） |
| kg extract | (+1 stage) | **1 LLM** | per-item | 8 | 串行（在 sentiment 后） |
| classify | (+1 stage) | 0-1 LLM | per-item | 8 | |
| dedupe | $in 批；fallback=1 broad find + O(N) 余弦 | **1 embedding + 1 向量搜索 HTTP** | 部分 | 8 | |
| persist | PG 事务 ≤6 语句 + mongoOutbox.create | 0 | terms 批量 | 8 | |
| outbox delivery | ~5 PG + 3 Mongo（含 **RawItem.findById 重读**） | **1 向量 upsert HTTP（单点）** | ❌ 1点/次 | 10 | |
| event clustering | newsEventItem.findUnique + **ProcessedItem.findById 重读 embedding** + 3×$in + 事务 + **TaskLog.insertMany/文章** + **state.update/文章** | **1 向量搜索 HTTP** | gate日志按文章批 | orgs并发, **文章串行** | |
| KG ingestion | 每关系 4 PG（entity×2+edge+evidence），entity 含别名内层串行 + **state.update/文章** | 0-E 消歧 LLM | links createMany | orgs并发, **文章串行** | **最重写扇出** |

**每篇文章合计（粗算）**：~5 LLM + ~3 向量/embedding HTTP（串行）+ ~13 Mongo + ~30 PG 往返（其中 ~20 来自遥测）。在 worker 并发下，**5 次串行 LLM 是 wall-clock 上限**。

### 2.2 瓶颈排序

1. **串行 LLM 链**（根因①）— 单一事实决定平台吞吐，远超任何 DB 问题。
2. **每阶段遥测写放大**（根因②）— 与真实工作量同量级的 telemetry 往返 + read-modify-write 竞态。
3. **跨阶段重读**（根因③）— embedding/raw/result 在 dedupe→persist→clustering→outbox 之间被反复读取，无共享上下文传递。
4. **KG 写扇出** — 单文章 ~10 关系 → 50-100+ 串行 PG 语句于一个事务内，且在 per-article 串行循环中。
5. **每文章游标写** — `state.update` 逐文章串行，彻底抵消批处理（bertopic 路径已证明可一次性 checkpoint）。

---

## 3. 索引覆盖矩阵（热查询 vs 索引）

> 完整索引清单见各 schema；下表只列**有问题**的热查询。✅=命中 / ⚠️=前缀错配或 filesort / ❌=COLLSCAN。

| 集合 | 查询 (file:line) | 应有索引 | 现状 | 判定 |
|---|---|---|---|---|
| ProcessedItem | `resolveProcessedSearchIds` 8 字段不锚定正则 `$or` 排序 createdAt (items.service.ts:5440-5457) | 正则无法用 btree | **缺** | ❌ **每次搜索 COLLSCAN** |
| ItemReadModel | `resolveReadModelSearchIds` `$or[titleLower^,externalIdLower^,...]` 排序 sortAt (items.service.ts:4625-4646) | {orgId,titleLower,sortAt} / {orgId,externalIdLower,sortAt} | **titleLower/externalIdLower 未建** | ❌ **整 $or 退化 COLLSCAN（每次搜索）** |
| NewsEventClusteringFailure | 自动重试 cron：status+clusteringMode+itemCount>0+lastAttemptAt 排序 lastAttemptAt (failure.service.ts:280-286) | {status,clusteringMode,lastAttemptAt,createdAt} | 仅单字段 {status} | ❌ **内存阻塞排序（增长集合）** |
| NewsEvent | `pickOverlapCandidates` OR[primaryTopic/primaryEntity] 排序 lastAt,startAt (news-events.ts:1335-1342) | OR 分支含 status 前缀 | 索引省略 status | ⚠️ index_merge + filesort（每次聚类） |
| NewsEvent | 公共首页 feed status+title/summary not null 排序 lastAt,startAt,id + **skip** (public-portal.ts:285-295) | {orgId,status,lastAt,startAt,id} | 仅前缀 {orgId,status,lastAt} | ⚠️ filesort 尾键 + 深 skip（高流量未认证） |
| ItemMeta | `buildPrefixWhere` OR[name^,externalId^] 排序 createdAt,id (items.service.ts:6133) | {orgId,createdAt,id} | **无 createdAt 索引** | ⚠️ 前缀合并后 filesort |
| NewsEvent | `listEvents` `primaryEntity contains`(unanchored LIKE) (news-events.ts:154) | startsWith 或 fulltext | contains 不可用索引 | ⚠️ 残余 LIKE 扫描 |
| ProcessedItem | war-map 地理 `result.location $exists/$nin` + $or(含$exists:false) (dashboard-charts.ts:1308-1328) | {orgId,status,hasLocation,duplicateOf,sortAt} | location 未索引 | ⚠️ 扫描放大（近期文档无 location 时 limit 难填满） |
| RawItem | `{itemMetaId:$in}` 排序 createdAt (items.service.ts:2534) | {itemMetaId,createdAt:-1} | 仅单 itemMetaId | ℹ️ 小批内存排序 |

**过度索引（写放大）**：`llm-request-log` 有 9 个冗余单字段 `index:true` 重复复合索引前缀；`processed-item`、`item-read-model` 同类冗余。建议删除被复合索引前缀覆盖的单字段索引。

---

## 4. GraphQL 读路径 + 连接/资源配置

### 4.1 Over-fetch 清单（无投影全文档）

| 位置 | 取回 | 实际使用 | 影响 |
|---|---|---|---|
| items.service.ts:1703-1708 / 1860-1863 | 整个 ItemReadModel（raw.payload/processed.result/searchText/searchTerms/4数组） | 仅 `meta.*`+orgId | **主列表**每行拖拽大 blob |
| loaders/item-read-model.loader.ts:17 | 整文档无投影 | 各字段子集 | 每个 ItemModel 字段解析器**首先**调用 → 任何 items 查询都拉全 blob |
| loaders/processed-item.loader.ts:53 | summaryEmbedding 向量 + result.cleaned_markdown | `.length` + 几标量 | 向量+全文每行过网 |

### 4.2 连接/池配置表

| 资源 | 设置 | 现状 (file:line) | 判定 |
|---|---|---|---|
| Mongoose | maxPoolSize/minPoolSize | **未设** (connection.ts:11) | 默认 100；无预热 |
| Mongoose | **autoIndex** | **未设→prod 默认 true**（read-model 14 复合 + 7字段 text） | ⚠️ **连接时尝试建索引** |
| Mongoose | bufferCommands | 未设→true | 断连时静默排队 |
| Prisma | connection_limit/pool | **未设**（prisma.service.ts:41-47），47 处交互式 `$transaction(,{timeout:15000})` 部分含 for 循环 | ⚠️ 长事务占连接耗尽默认池 |
| Redis(ioredis) | 共享客户端 | 单例 @Global (cache.module.ts:35) | ✅ |
| Redis | enableAutoPipelining | **未设** (redis-connection.ts:15) | ⚠️ 每请求多次 get/set 不合并 |
| Redis | maxRetriesPerRequest | 未设（BullMQ 要求 null） | 隐患 |
| HTTP | keep-alive agent | **未设** (akshare/health/alerts HttpModule 仅 timeout) | ⚠️ 每出站新建 TCP/TLS |
| Apollo | depth/complexity | 8 / 2000 已接线 | ✅（但每操作重算 complexity，无 APQ） |
| Apollo | response cache/APQ | **无** | 热读无缓存 |

---

## 5. 前端 bundle 拓扑

> 关键洞察：echarts 已集中在 `echart.client.tsx`（`echarts/core` 模块化 tree-shake），deck.gl/maplibre 集中在 `lib/map/map-runtime.ts`。问题是**入口处静态 vs `next/dynamic`**。

| 重依赖 | 量级 | 静态导入点（首包成本） | 已动态拆分 | 判定 |
|---|---|---|---|---|
| deck.gl + maplibre | ~500KB+ | **map/page.tsx:6**、**market-overview.tsx:10**(→metric-drilldown)、spacetime-geo-heatmap、war-map.tsx | dashboard-content:126(WarMap，缺 ssr:false)、situation-monitor:154(✅ssr:false)、spacetime-viz:163 | ⚠️ /map 与 /finance 泄漏入首包 |
| echarts | ~300KB | `echart.tsx` 静态再导出 → ~25 文件（7 个独立 dashboard 子路由 + alert-center 等） | wrapper 自身从不 dynamic | ⚠️ 每路由各打包 echarts |
| cytoscape + fcose | ~400KB | knowledge-graph-content.tsx:28-29 ← workspace.tsx:8（静态） | 无 | ⚠️ /knowledge-graph 首包带图引擎 |
| three | ~600KB | 无 | spacetime-viz:185（动态） | ✅ |
| mermaid | ~500KB | 无 | markdown-mermaid.tsx:10（动态+单例） | ✅ |

**Apollo 客户端**：`InMemoryCache()` 无 `typePolicies`/分页 `merge`（items Relay、alertEvents）→ 无增量缓存，翻页 refetch+replace。`alert-center.tsx:1379` 订阅每条消息 `refetchEvents()` 无去抖 → refetch 风暴。
**`'use client'` 过界**：`news-hub/page.tsx:1`（零交互静态链接页）、7 个独立 dashboard 子路由页静态导入 DashboardChart。**全 `app/` 无任何 `loading.tsx`** → 重路由无流式 shell。
**列表虚拟化**：`@tanstack/react-virtual` 仅用于 newsnow-dnd-grid；最大的两个列表（items feed 2638 行、alert events）未虚拟化。

---

## 6. 并发 / 调度 / 多租户扩展性

### 6.1 调度器风险（节选）

| 调度器 (file:line) | 周期 | per-org? | 重入/惊群风险 |
|---|---|---|---|
| realtime-signals.service.ts:467 | EVERY_MINUTE | **per-org 串行**（全局锁内） | **HIGH** — O(orgs) wall-clock，慢 org 饿死全部；>60s 后 tick 堆积 |
| news-events-timeline.service.ts:175 | EVERY_10_MIN | **per-org 串行** | **HIGH** — O(orgs×events×items)，**无重入保护**，超 10min 即重叠 |
| audit-log-outbox.service.ts:50 | EVERY_MINUTE | 并发 | MED — **无重入保护**，仅靠 5min stale-lock |
| clustering-recovery-scheduler:21 | EVERY_5_MIN | 全局 | MED — 重入保护是**进程内 boolean**，多实例无效 |
| newsnow-source-warm.scheduler:19 | EVERY_MINUTE | per-source 并发(6) | MED — 无重入保护 |
| ~8 个 EVERY_MINUTE crons | :00 对齐 | 各自 `org.findMany({isActive})` | **惊群** — 每分钟同点 DB+Redis 突发 + 冗余 org 列表查询 ~8× |

### 6.2 Worker 拓扑（瓶颈）

| worker | 队列 | 并发 | rateLimit | 备注 |
|---|---|---|---|---|
| crawl.processor.ts:793 | llm_judge/llm_learn | **1** | max 1/1000ms | **串行 LLM 回填**，backlog 时 ≤1/s |
| assistant.processor:38 | assistant | 2 | **无** | LLM(300s)，提并发即冲爆上游 |
| analysis.processor:38 | analysis | 2 | **无** | LLM 同上 |
| akshare.processor:48 | akshare | 2 | **无** | 外部 HTTP 同上 |
| situation-signals:59 / archive-prep:49 | — | 1 | 无 | 串行，无余量 |

### 6.3 连接扇出（根因⑤量化）

`toBullmqConnection` 返回 **RedisOptions 对象**（非共享客户端）→ 每个 `Queue`/`Worker`/`QueueEvents` 各开连接。crawl 模块单独：**5 Queues + 3+ QueueEvents + 5 Workers**。全局 **~40+ Redis 连接** + socket.io adapter 2 个 node-redis。随**队列数**增长，重启时连接风暴。

**OTel**（otel.ts:17）：`getNodeAutoInstrumentations()` 无采样器无过滤 → **100% span 导出**，instrument 了 fs/dns/net/http/redis/pg/mongodb 等热路径。

### 6.4 多租户扩展性

- **realtime-signals**：30 orgs × 1.5s 外部延迟 = 45s，逼近 60s tick；全局锁使一个慢 org 饿死全部。对比 ingestion/sentiment/KG 调度器同负载用 `settleWithConcurrency` + per-org 锁，形状好得多。
- **situation-monitor 广播**：每信号事件对**每个在线用户**做一次 DB 增强，无 org 级共享 → O(#users) DB/事件。
- **共享工作被重复 vs 提升**：`newsnow-hottest-analysis` 是正面样板（`globalSnapshot` 算一次复用）；反面是 gateway per-user 增强 + ~8 调度器各自查 org 列表。

---

## 7. 本轮新增发现清单（分级 · 已去重）

### 🔴 Critical（13）
1. **D-ING-1** `news-pipeline.service.ts:1517` 串行 LLM 链（根因①）→ `Promise.all(entities,sentiment,classify)`，KG 仅依赖 entities。
2. **D-ING-2** `news-pipeline.service.ts:1742-1815` recordStageOutcome 每阶段写放大（根因②，含第一轮 C4）→ 内存累积、persist 时一次性 flush。
3. **D-ING-3** `knowledge-graph.service.ts:191-219,936-1002` KG 关系/别名逐条 upsert 50-100+ PG/文章 → createMany+$in 批量。
4. **D-IDX-1** `items.service.ts:5440-5457` 不锚定正则 `$or` 每次搜索 COLLSCAN → ES 命中时跳过 Mongo 正则。
5. **D-IDX-2** `items.service.ts:4625-4646` titleLower/externalIdLower 未索引使 `$or` 退化扫描 → 补复合索引 + 每分支含 orgId / 走 ES。
6. **D-IDX-3** `news-event-clustering-failure.service.ts:280-286` cron 内存阻塞排序 → `index({status,clusteringMode,lastAttemptAt,createdAt})`。
7. **D-GQL-1** `items.service.ts:1703-1708,1860-1863` 主列表全文档 over-fetch（根因③）→ 显式投影。
8. **D-GQL-2** `loaders/item-read-model.loader.ts:17` loader 无投影，每 items 查询拉全 blob → 投影到映射字段。
9. **D-FE-1** `market-overview.tsx:10`→metric-drilldown deck.gl 静态导入，/finance 首包 ~500KB → `next/dynamic{ssr:false}`。
10. **D-FE-2** `map/page.tsx:6` WarMap 静态导入，/map 首包 deck.gl+maplibre → dynamic{ssr:false}。
11. **D-SCH-1** `realtime-signals.service.ts:467` 全局锁内 per-org 串行 EVERY_MINUTE（根因⑤）→ settleWithConcurrency + per-org 锁。
12. **D-SCH-2** `news-events-timeline.service.ts:175` per-org 串行无重入保护 O(orgs×events×items) → settleWithConcurrency + per-org 锁 + 批 loadEventItems。
13. **D-SCH-3** `redis-connection.ts:24` + 各队列模块 ~40+ Redis 连接 → 共享单非阻塞 ioredis（Worker 保留阻塞连接）+ maxRetriesPerRequest:null。

### 🟡 Warning（31）
**索引(5)**: D-IDX-4 NewsEvent OR 缺 status 前缀(:1335) · D-IDX-5 公共首页 feed filesort+skip(public-portal:285) · D-IDX-6 ItemMeta 无 createdAt 索引(:6133) · D-IDX-7 listEvents contains 不可索引(:154) · D-IDX-8 war-map result.location 未索引(dashboard-charts:1308)
**摄入(6)**: D-ING-4 news-events-ingestion 每文章游标(:255) · D-ING-5 KG 每文章游标(finally :213) · D-ING-6 clustering 重读 embedding(:1470) · D-ING-7 候选逻辑重复(:928 vs :1129) · D-ING-8 向量逐点 upsert(:4751) · D-ING-9 alerts 每接收者 create(:1428,:1505)
**读路径/连接(7)**: D-GQL-3 processed-item.loader 过取向量+全文(:53) · D-GQL-4 newsEvents candidateLimit 4× 放大(:98) · D-CONN-1 Mongoose autoIndex/pool(connection.ts:11) · D-CONN-2 Prisma 无 connection_limit+47 交互事务 · D-CONN-3 Redis 无 autoPipelining(:15) · D-CONN-4 HTTP 无 keep-alive(akshare.module:32) · D-CONN-5 economic-data granularity 时 take:undefined 无界(akshare.service:2335)
**前端(7)**: D-FE-3 echart.tsx wrapper 未 dynamic(:8) · D-FE-4 cytoscape 静态(:28) · D-FE-5 alert 订阅 refetch 风暴(:1379) · D-FE-6 Apollo 无分页 merge(:198) · D-FE-7 items 列表内联闭包+未 memo(:2261) · D-FE-8 alert List index key(:707…) · D-FE-9 两大列表未虚拟化
**并发(6)**: D-SCH-4 OTel 100% 采样(otel.ts:17) · D-SCH-5 situation 广播 per-user 增强(:254) · D-SCH-6 crawl LLM judge/learn 并发 1(:793) · D-SCH-7 assistant/analysis/akshare worker 无 rateLimit · D-SCH-8 audit-outbox 无重入保护(:50) · D-SCH-9 clustering-recovery 进程内 boolean 锁(:21)

### 🔵 Info（13）
D-IDX-9 RawItem 复合索引 · D-IDX-10 过度索引/写放大 · D-ING-10 dedupe Mongo fallback · D-ING-11 无 consumer lag 监控（背压） · D-GQL-5 getSubgraph BFS（已缓存可接受） · D-GQL-6 无 Apollo response cache/APQ · D-FE-10 news-hub 误用 'use client' · D-FE-11 dashboard WarMap 缺 ssr:false · D-FE-12 lodash 根导入 · D-FE-13 全站无 loading.tsx · D-FE-14 7 独立 dashboard 页静态 echarts · D-SCH-10 EVERY_MINUTE 惊群+冗余 org 查询 · D-SCH-11 SSE 每订阅者双 setInterval

---

## 8. 分阶段修复路线图（量化收益 / 工作量 / 风险）

### 阶段一：高性价比止血（低风险，1-2 天）
| 项 | 收益 | 工作量 | 风险 |
|---|---|---|---|
| 队列 `removeOnFail:{age,count}`（第一轮 C1） | 防 Redis OOM | 改 N 处配置 | 极低 |
| `newsnow.gateway:236` 删全量广播（第一轮 C2） | 防广播风暴+越权 | 删 1 行 | 极低 |
| D-FE-1/2 `/finance`+`/map` deck.gl 改 dynamic | 两路由首包 -~500KB | 各 1 处 | 低 |
| D-FE-3 echart.tsx wrapper 改 dynamic 边界 | ~25 路由自动拆 echarts | 1 处 | 低 |
| D-CONN-3 Redis `enableAutoPipelining:true` + maxRetriesPerRequest:null | 每请求 Redis 往返合并 | 1 处 | 低 |
| D-CONN-1 Mongoose `autoIndex:false`（索引走 ensure 脚本） | 去掉连接期建索引 | 1 处 + 确认脚本 | 低 |

### 阶段二：摄入吞吐（中风险，需测试，3-5 天）
| 项 | 收益 | 风险 |
|---|---|---|
| D-ING-1 enrichment 并行 LLM | LLM 关键路径 -40~50% | 中（验证无隐式依赖） |
| D-ING-2 遥测内存累积+批量 flush（含 C4） | -~10 Mongo/-~20 PG 每文章 | 中（保证失败可观测性） |
| D-ING-3 KG 批量 upsert | 每文章 PG 语句数量级下降 | 中（事务语义） |
| D-ING-4/5 游标移出循环 · D-ING-6 批取 embedding · D-ING-8 向量批量 upsert | 减少每文章串行往返 | 中 |

### 阶段三：索引与查询（中风险，需 DBA 确认 + migration）
| 项 | 收益 | 风险 |
|---|---|---|
| D-IDX-1/2 搜索路径 ES 优先 + 补 ItemReadModel 复合索引 | 消除每次搜索 COLLSCAN | 中（行为对齐 ES） |
| D-IDX-3 失败集合 cron 复合索引 | 去内存阻塞排序 | 低 |
| D-IDX-4~8 NewsEvent/ItemMeta/首页 feed 索引 + keyset | filesort→索引序 | 中（MySQL migration） |
| 第一轮 C3 user-digest 正则扫描加时间下界+limit | 防全表扫描/OOM | 中（since 下推） |

### 阶段四：多租户与资源（架构级，需灰度）
| 项 | 收益 | 风险 |
|---|---|---|
| D-SCH-1/2 per-org 串行→并发+per-org 锁 | 调度 wall-clock O(orgs)→O(1)~并发度 | 中高（并发正确性） |
| D-SCH-3 共享 Redis 连接 | ~40→个位数连接 | 中（BullMQ 连接语义） |
| D-SCH-4 OTel 采样 5-10% + 关 fs/dns | 降事件循环+导出开销 | 低 |
| D-SCH-7 LLM/HTTP worker 加 rateLimit | 可安全提并发 | 低 |
| D-GQL-1/2/3 读路径投影（根因③） | 主列表 egress 大降 | 中（确认字段映射） |

---

## 附录：累计统计（两轮）

| | Critical | Warning | Info |
|---|---|---|---|
| 第一轮 (report.md) | 6 → **5 有效**（C5 已解决） | 18（含 1 条 concurrency 降级 Info） | 11 |
| 第二轮 (本文) | 13 | 31 | 13 |
| **去重后总计** | **~18** | **~48** | **~24** |

> 注：两轮间存在相互印证（如第一轮 C4 是第二轮根因②的实例、第一轮 news-card 重渲染由 D-FE-7 补充 Apollo 配置角度），故"总计"为去重后近似值。修复请以**根因①~⑤**与**阶段一~四路线图**为纲，而非逐条孤立处理。
