# 性能审计报告 — 纯静态代码分析

> 策略: review-audit (Claude 6-路并行子代理) · 范围: 全项目性能维度 · 方法: 纯静态只读 · 日期: 2026-06-01
> 总计: **6 Critical · 18 Warning · 11 Info**（已去重 + Claude 独立复核 6 个 Critical）

## 总体评价

代码库性能卫生**整体良好**：普遍使用 `$in` 批量化 / `.lean()` / 字段投影 / 分页上界；Mongoose+Prisma 索引覆盖充分；`CacheService` 用 `SCAN` 而非 `KEYS` 且实现单飞锁防击穿；BullMQ worker 有 `onModuleDestroy` 清理；`ais-relay` 有完整背压+有界 Map+淘汰；GraphQL 深度/复杂度限制已正确接线、`@ResolveField` 全部走请求级 DataLoader（无 N+1）。
问题集中在 5 类：**摄入热路径串行写**、**无界查询/列表**、**队列失败任务无界增长**、**实时广播扇出**、**前端重组件静态导入**。

---

## Critical（必须修复）

### C1. 全部 BullMQ 队列 `removeOnFail: false` 且无任何清理 → Redis 无界增长
- **位置**: `apps/api/src/modules/queue/queue.module.ts:55,79`；另见 crawl.module.ts、crawl-queue.service.ts、akshare.service.ts:1125、alerts.service.ts、archive-preparation-queue.service.ts、queue.service.ts:100
- **证据**: 全仓 15+ 处 `removeOnFail: false`；`grep .clean(/.obliterate(/.getFailed(/removeOnFail:{` **零命中**（Claude 复核确认）。`removeOnComplete` 配了 `{age,count}` 上界，`removeOnFail` 完全无界。
- **影响**: 每个失败 job（含完整 payload）永久驻留 Redis `failed` ZSET+hash。pipeline/crawl/akshare 高吞吐，长跑下失败集合无上限累积 → 最终撑爆 Redis。
- **建议**: `removeOnFail: { age: 86400, count: 5000 }`；或新增定时 `queue.clean(ms, limit, 'failed')` 巡检。
- **来源**: Agent-cache（Claude 复核 ✓）

### C2. `newsnow.gateway.ts:236` 缺省路径 `server.emit` 全量广播（性能 + 跨租户越权）
- **位置**: `apps/api/src/modules/news-aggregator/newsnow.gateway.ts:236`
- **证据**: `event.orgId` 存在时 `emitToOrg`，否则 `this.server.emit("newsnow:update", event)` 广播给命名空间下所有租户所有 socket（Claude 复核确认）。
- **影响**: 高频 newsnow 更新事件在 orgId 缺失时 O(全部连接) 序列化+发送 → 广播风暴；并跨租户泄露数据。
- **建议**: 删除全量兜底；无 orgId 时不广播或仅记日志；确保 dispatcher 始终带 orgId。
- **来源**: Agent-cache（Claude 复核 ✓）

### C3. `user-digest.service.ts:518` 无界正则 `$or` 全集合扫描（ProcessedItem）
- **位置**: `apps/api/src/modules/user-digest/user-digest.service.ts:518`（`buildKeywordProcessedItemFilter` 550-573）
- **证据**: `ProcessedItemModel.find({ orgId, status, duplicateOf, $or: filters }).select({_id:1}).lean()`——filters 为 11 个 `result.*` 子字段上的不锚定 `RegExp(.., "i")`，**无 `.limit()`、无时间下界**（Claude 复核确认）。
- **影响**: `orgId+status` 前缀外的正则 `$or` 无法命中索引 = 对增长型集合全表扫描+逐文档跑正则；匹配到的全部 `_id` 一次性进内存。既被 `GET` 请求直连，又被 `@Cron(EVERY_MINUTE)` 逐用户调用 → 随历史增长线性变慢、OOM/超时风险。
- **建议**: 加 `createdAt: { $gte: since }` 时间下界 + `.sort({createdAt:-1}).limit(N)`；关键词匹配尽量改走 Elasticsearch 或预计算的已索引字段。
- **来源**: Agent-data（Claude 复核 ✓）

### C4. `news-events.service.ts` 聚类热路径每候选 `await TaskLogModel.create`（N+1 写）
- **位置**: `apps/api/src/modules/news-events/news-events.service.ts:972, 1176`（亦 787/1303）→ `applyCategoryGate`(1453) → `logCategoryGateDecision`(1546) → `await TaskLogModel.create`(1560)
- **证据**: `applyCategoryGate` 在每候选事件循环内被 `await`，其每个分支都 `await TaskLogModel.create(...)` 写一条 Mongo 审计日志（Claude 复核确认）。
- **影响**: gate 判定本身纯内存，但每次都同步 await 一次 Mongo 插入。每篇文章入聚类对 K 个候选各写一次 → 每文章 K 次串行 Mongo 写，摄入吞吐高时显著拖慢聚类。（K 受候选上限约束）
- **建议**: 决策日志收集到数组、循环后一次 `TaskLogModel.insertMany(..., {ordered:false})`；或 fire-and-forget/采样写入，不阻塞聚类。
- **来源**: Agent-data(Critical) + Agent-async(Warning) **双重确认**（Claude 复核 ✓）

### C5. `situation-monitor-content.tsx:51` WarMap(deck.gl + maplibre-gl) 静态导入到 7198 行大页
- **位置**: `apps/web/app/(app)/situation-monitor/situation-monitor-content.tsx:51`
- **证据**: `import { WarMap } from "@/app/(app)/dashboard/charts/war-map"`（静态）；对比 `dashboard-content.tsx:127` 同组件用 `dynamic(() => import("./charts/war-map"))`（Claude 复核确认）。
- **影响**: deck.gl+maplibre-gl 数百 KB WebGL 库无条件打进态势监控路由首包，即使用户从不滚到地图也要下载/解析 → 拖慢主屏 TTI。
- **建议**: 改 `dynamic(() => import(...).then(m=>m.WarMap), { ssr:false, loading })`，与 dashboard 对齐。
- **来源**: Agent-web（Claude 复核 ✓）

### C6. `markdown-viewer.tsx:119` MarkdownViewer 未 memo + `components` 每渲染重建，流式聊天逐 token 重解析
- **位置**: `apps/web/components/markdown-viewer.tsx:119`（components 字面量 136+）
- **证据**: `export function MarkdownViewer(...)` 无 `React.memo`；`<ReactMarkdown components={{ ...约25个内联箭头渲染器 }}>` 对象字面量每次 render 重建（`normalizedMarkdown` 已 memo，但 `components` 未 memo）（Claude 复核确认）。
- **影响**: assistant 流式输出时 markdown 随 token 增量更新，ReactMarkdown 每次拿到全新 `components` 引用 + 全量重解析 AST → 主线程抖动。
- **建议**: `components` 工厂用 `useMemo` 缓存；`React.memo` 包裹 MarkdownViewer。
- **来源**: Agent-web（Claude 复核 ✓）

---

## Warning（建议修复）

**后端 — 查询/列表无上限**
- `analysis.service.ts:124` — `listResults(orgId, limit)` 客户端 limit 无 `Math.min` 钳制，可拉 10 万条含大 JSON 字段。建议钳到 ≤100。
- `assistant.service.ts:206` — `listRuns` 同上，无上限。建议钳制。
- `akshare.service.ts:2334` — `getEconomicData*` 无分页时 `take: undefined` 全量读 + O(n) JS 聚合，复杂度估算器捕获不到。建议服务端硬上限/桶数校验。
- `graphql/resolvers/processed-item.resolver.ts:46` — `findOne` 无投影，过取 `summaryEmbedding`(768–1536 float) 仅用于读 `.length`。建议 `.select({summaryEmbedding:0})`。

**后端 — 写/循环可批量化或可并行**
- `news-events-timeline.service.ts:213-272` — 每事件串行 `loadEventItems` + 每时间桶逐条 `upsert`（@Cron 10min）。建议 `eventId:{in:[...]}` 批取 + `createMany(skipDuplicates)`。
- `user-content-subscriptions.service.ts:365,993` — 循环内逐条 `create`。建议 `createMany({skipDuplicates})`。
- `knowledge-graph-impact.service.ts:76,101,113` — 3 个无依赖 `findRelatedEntities` 串行（≈6 次串行往返）。建议 `Promise.all`。
- `analysis-workspace.service.ts:1941,2144` — O(n²) Jaccard 去重最多 5000 事件、同步阻塞事件循环(≈12.5M 比较)。建议按时间桶预分组再 Jaccard / MinHash-LSH。

**缓存/Redis/队列/实时**
- `queue.processor.ts:90-93` — pipeline worker 默认并发仅 3，I/O 密集任务串行瓶颈。建议提高到 8–16 并 env 可配。
- `cache.service.ts:132-138` — `incr` 后 `expire` 非原子（崩溃则 key 永无 TTL，两次往返）。建议 Lua 一次性 `INCR`+`PEXPIRE`。
- `realtime-signals.snapshot-store.ts:30-44` — `appendPoint` 读改写无锁 + 每次全段 series `JSON.parse/stringify`（丢点竞争）。建议改 Redis ZSET。
- `situation-monitor-signals.gateway.ts:234-251` — 每实时事件按每在线用户一次 `augmentPayloadForUser`(含 DB)。建议按 orgId 分组增强 + 短 TTL memoize。

**认证热路径**
- `auth/machine-token.service.ts:100` — 每个 `mtk_` 机器令牌请求一次 `findUnique`+一次 `update(lastUsedAt)`，无缓存（Prometheus 等高频抓取放大写）。建议节流 `lastUsedAt`（60s 闸门）+ `cache.wrap` 校验结果。

**前端**
- `finance/market-overview.tsx:10` — MetricDrillDown(deck.gl) 静态导入。建议 `next/dynamic`。
- `map/page.tsx:6` — WarMap 静态导入（虽是主内容，仍阻塞 shell）。建议 `dynamic + ssr:false + skeleton`。
- `items/components/news-card.tsx:112` — 列表主卡未 `React.memo`，且 items-view 传入每次新建的 `{{...item}}` 内联对象（破坏浅比较）。建议 memo + 传 `item` 本体。
- `items/components/news-card.tsx:130` — NewsCard 渲染体内 `formatRatioAsPercent`/`flatMap`/`estimateReadingTime` 等逐项计算未 `useMemo`。
- `alerts/alert-center.tsx:3678` — 告警事件列表 `renderItem` 内联 `buildContextSummary`/`buildThresholdSummary` 等重计算（每页30行）。建议抽 `React.memo` 行组件。

---

## Info（供参考）

- `public-portal.service.ts:454` — 全局 `newsEvent.findFirst` (status+lastAt 排序) 缺组合索引（兜底路径，触发概率低）。
- `items.service.ts:1397-1408` — mongoRef 回填逐行 updateMany（已用有界并发，可接受）。
- `news-indicator-association.ingestion.service.ts:27-37` — per-org 串行循环（6h cron，CPU-bound，serial 可辩护）。
- `knowledge-graph.ingestion.service.ts:160-228` — per-article 串行（游标可恢复语义，order-dependent）。
- `alerts-notification-throttle.service.ts:82-105` — 每通知 2–4 次顺序 `eval`。建议合并 Lua/pipeline。
- `realtime-signals.service.ts:440` — 模块级 `aisRelayIssueCodeByOrg` Map 无淘汰（受租户数上界约束）。
- `graphql/dto/item.input.ts:179` — `first` 缺 `@Max`（服务端已硬钳 50 兜底）。
- `components/news-image.tsx:109` — 原生 `<img>` 非 next/image（已手动 lazy/async，有意取舍）。
- `components/echart.tsx:7` — 客户端薄包装层（影响很小）。
- `packages/utils/src/date.ts:113` / `number.ts:1` — `formatDateTime/formatNumber` 每次 new Intl 实例（当前无热路径循环调用，引入批量格式化前先修）。
- `packages/utils/src/geo.ts:251-277` — `extractCountryCodeFromText` 对 ≈250 国家表做 includes 扫描（仅离线流水线，已短路）。

---

## 修复优先级建议（quick wins 优先）

1. **C1 队列 removeOnFail** — 改 2 行配置 × N 处，零风险，防 Redis OOM（最高性价比）。
2. **C2 全量广播** — 删 1 行兜底，兼修越权。
3. **C4 gate 日志** — 改 await 为 insertMany/fire-and-forget，直接提升摄入吞吐。
4. **C5/C6 前端** — WarMap 改 dynamic（1 处）、MarkdownViewer memo 化（局部），低风险高收益。
5. **C3 摘要扫描** — 需加时间下界+limit，涉及上游 `since` 下推，改动稍大但影响大。
6. Warning 中的 **list limit 钳制**（analysis/assistant/akshare）批量修，防内存放大。
