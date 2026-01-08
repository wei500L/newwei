# 数据可视化与指标口径统一：任务清单（可执行版）

## 目标
- 统一“时间语义 / 指标口径 / 图表状态”的数据契约，避免前后端二次口径重算与口径漂移。
- 让图表在“空数据 / 延迟 / 回补中 / 错误”下有一致的用户提示与交互。
- 修复当前 P0/P1/P2 的展示不稳定、筛选无效、排序分页不一致等问题。

## 统一口径（作为所有任务的前置约束）
- **发布时间（Published）**：以 `published_at` 为主（语义：内容发布时间）。
- **入库时间（Ingested）**：以 `createdAt` 为主（语义：入库/处理记录创建时间）。
- **质量分（Quality）**：`quality_score`，范围 `0~1`（展示可换算为 `0~100%`）。
- **重复度（Duplicate Similarity）**：`duplicateSimilarity`，范围 `0~1`（展示可换算为 `0~100%`）。
- **告警强度（Alert Severity + Derived Score）**：统一以 `AlertEvent.severity`（枚举）+ 后端产出的聚合/派生分值展示；前端不再自行推导阈值口径。
- **经济数据单位（Unit）**：统一以 `EconomicDataPoint.unit / sourceField` 与 `EconomicDataItem.defaultUnit`（兜底）作为展示依据。

---

## 任务索引（按优先级）
- **P0**
  - DV.T1 统一发布时间/入库时间语义与前端展示
  - DV.T3 告警强度口径统一：地图/告警中心只消费 `severity + derived score`
  - DV.T4 经济数据单位口径统一：趋势/热力/蜡烛图全部按 `unit/sourceField/defaultUnit`
  - DV.T9 图表状态统一：延迟/空数据/回补中/错误提示与交互
  - DV.T11 `processed.result` 类型不一致导致前端解析不稳定（回归修复）
  - DV.T12 情感筛选“看似可用但无数据”（字段产出与筛选契约补齐或下线）
- **P1**
  - DV.T2 质量分与重复度同尺度展示 + 来源说明（LLM 清洗/去重阶段）
  - DV.T5 趋势图场景统一：时间序列 + 同步显示是否延迟
  - DV.T10 组件复用与配置化：统一复用 `DashboardChart`/`ChartEmptyState`
  - DV.T13 事件/话题排序与聚合：从 `createdAt` 迁移到 `published_at`（避免口径漂移）
  - DV.T14 分页与排序口径统一：稳定排序（服务端）替代页内客户端二次排序
  - DV.T15 “Breaking News” 实为 “Analysis Stream”（命名与语义对齐）
- **P2**
  - DV.T6 WarMap：无地区信息时给出明确空态（区分“无告警” vs “告警无定位”）
  - DV.T7 金融面板：行业热力图/蜡烛图保留并避免逻辑分叉
  - DV.T8 事件页时间线：继续用于话题/事件聚合（配合新时间口径）
  - DV.T16 WarMap 国家字段缺失：后端回补/兜底策略 + 可观测性
  - DV.T17 热力图/蜡烛图 `sourceField` 白名单导致空数据：改为可配置映射

---

## 任务详情

### DV.T1（P0）统一发布时间/入库时间语义与前端展示
- 问题：当前多个页面/聚合/排序存在 `published_at` 与 `createdAt` 混用，且前端存在“只展示其一/回退替代”的隐式行为，导致指标口径漂移。
- 涉及文件：
  - `apps/api/src/modules/news-pipeline/news-pipeline.schema.ts`（`published_at` 定义）
  - `packages/mongo/src/models/processed-item.ts`（`createdAt` 语义：处理记录时间）
  - `apps/web/app/(app)/items/items-view.tsx`（时间展示/排序口径）
- 实施步骤：
  - 后端：明确 `published_at` 的规范（ISO8601、时区、可空规则），并在 API/GraphQL 层显式区分 `publishedAt` 与 `ingestedAt`（不要让前端靠推断）。
  - 前端：在列表/卡片中**同时**明确展示 Published 与 Ingested（或在 UI 上可见地切换/提示），避免“有 published 时隐藏 ingested”造成误判。
  - 文档：补一份“时间字段字典”，列出每个页面/接口使用哪一个字段排序与筛选。
- 验收标准：
  - 任意页面不再“静默替代时间字段”；用户能清晰知道显示的是 Published 还是 Ingested。
  - 涉及排序/聚合/筛选的地方有一致的时间口径（详见 DV.T13/DV.T14）。
- 验证方式：
  - 手工：选取 `published_at` 缺失与存在的样本，验证 UI 标签与时间值一致。
  - 自动：为 GraphQL items 查询增加最小回归（断言返回字段语义与格式）。

### DV.T2（P1）质量分与重复度同尺度展示 + 来源说明
- 问题：虽然 `quality_score` 与 `duplicateSimilarity` 均为 `0~1`，但需要在产品层明确“同尺度”并对来源阶段做统一说明，减少误解与口径漂移。
- 涉及文件：
  - `apps/api/src/modules/news-pipeline/news-pipeline.schema.ts`（`quality_score` 范围）
  - `apps/api/src/modules/news-pipeline/news-pipeline.service.ts`（`quality_score` 映射来源）
  - `packages/mongo/src/models/processed-item.ts`（`duplicateSimilarity` 定义）
  - `apps/web/app/(app)/items/items-view.tsx`（展示/标签）
- 实施步骤：
  - 前端：质量/重复度统一用百分比展示（同一 rounding 规则）；为两列加 tooltip：来源于 “LLM 清洗（quality）/ 去重阶段（duplicate similarity）”。
  - 后端：在 `processed.llm` 元信息存在时，允许 UI 展示 `model/promptVersion`（便于解释质量分来源）。
- 验收标准：质量与重复度在 UI 上同尺度、同格式、含清晰来源说明。
- 验证方式：手工检查 + 组件快照/单测（若项目已有对应测试基建）。

### DV.T3（P0）告警强度口径统一：地图/告警中心只消费 `severity + derived score`
- 问题：地图与告警中心必须统一使用 `AlertEvent.severity` 与后端产出的派生分值，避免前端基于阈值/规则再推导“强度口径”。
- 涉及文件：
  - `packages/db/prisma/schema.prisma`（`AlertEvent.severity`）
  - `apps/api/src/modules/dashboard/dashboard-charts.service.ts`（WarMap 聚合/派生）
  - `apps/web/app/(app)/dashboard/charts/war-map.tsx`（强度展示）
  - `apps/web/app/(app)/alerts/alert-center.tsx`（告警中心 severity 展示）
- 实施步骤：
  - 后端：为 WarMap 返回结构补齐/命名清晰的 `derivedScore`（当前 `value` 实为聚合分值），并在服务端文档化计算方式。
  - 前端：WarMap tooltip/图例使用后端字段（`severity` + `derivedScore`），不做二次计算；告警中心同样只展示/筛选后端 severity。
- 验收标准：
  - 同一告警事件在地图与告警中心的 severity 表达一致。
  - 前端无任何“按数值阈值再映射 severity”的代码路径。
- 验证方式：抽样比对同时间范围内的 WarMap 点位与告警中心事件列表。

### DV.T4（P0）经济数据单位口径统一：趋势/热力/蜡烛图全部按 `unit/sourceField/defaultUnit`
- 问题：经济数据的单位与字段来源需要统一；避免某些图表按硬编码字段/单位渲染导致误读或空数据。
- 涉及文件：
  - `packages/db/prisma/schema.prisma`（`EconomicDataPoint.unit/sourceField`、`EconomicDataItem.defaultUnit`）
  - `apps/api/src/graphql/resolvers/economic-data.resolver.ts`（GraphQL 返回 unit/sourceField/defaultUnit）
  - `apps/api/src/modules/dashboard/dashboard-charts.service.ts`（热力图/蜡烛图点位选择）
  - `apps/web/hooks/useEconomicData.ts`（单位归并逻辑）
- 实施步骤：
  - 统一单位优先级：`point.unit` > `item.defaultUnit` > `null`（UI 明确显示未知单位）。
  - 为 REST 图表接口补充：返回当前使用的 `sourceField` 与 unit 信息（便于 UI tooltip/轴标签一致）。
  - 前端：趋势/热力/蜡烛图 tooltip 与轴标签统一展示单位（若多字段多单位则分系列展示）。
- 验收标准：同一指标在不同图表/页面显示的单位一致且可追溯到 `sourceField`。
- 验证方式：选择包含多 `sourceField` 的指标，验证 UI 展示与后端选择一致。

### DV.T5（P1）趋势图场景统一：时间序列 + 同步显示是否延迟
- 问题：经济指标趋势/英雄指标属于时间序列场景，需要统一在图表层呈现“是否延迟”状态，避免只在页面顶部散落提示。
- 涉及文件：
  - `apps/web/hooks/useEconomicData.ts`（`isDelayed` 计算）
  - `apps/web/app/(app)/dashboard/dashboard-content.tsx`（英雄指标/面板）
  - `apps/web/app/(app)/dashboard/*/page.tsx`（各经济页）
- 实施步骤：
  - 抽象统一的“Chart 状态条/空态”组件（复用 DV.T9/DV.T10），让每个图表可显示：`updatedAt`/`latestTimestamp`/`isDelayed`。
  - 英雄指标与经济趋势图统一为时间序列表达（不混用表格/静态数值替代趋势）。
- 验收标准：任意经济类趋势图都能稳定显示延迟状态（含 latest 时间）。
- 验证方式：手工调整 time range 与模拟缺口数据（或用历史数据窗口验证）。

### DV.T6（P2）WarMap：无地区信息时给出明确空态（区分“无告警” vs “告警无定位”）
- 问题：WarMap 当前无法区分“没有告警触发”与“有告警但缺失国家/地区字段导致无法落点”，会误导用户。
- 涉及文件：
  - `apps/api/src/modules/dashboard/dashboard-charts.service.ts`（国家字段解析/过滤）
  - `apps/web/app/(app)/dashboard/charts/war-map.tsx`（空态文案与显示条件）
- 实施步骤：
  - 后端：WarMap events 返回中增加计数：`totalAlerts / locatedAlerts / unlocatedAlerts`（或等价字段）。
  - 前端：当 `totalAlerts>0 && locatedAlerts==0` 时显示“告警存在但缺少地区信息”的空态，并提供引导（例如跳转告警中心查看详情）。
- 验收标准：空态文案准确表达原因；地图不再出现“看似没数据”的误导。

### DV.T7（P2）金融面板：行业热力图/蜡烛图保留并避免逻辑分叉
- 问题：行业热力图与蜡烛图属于金融对比/分布场景，需要明确归属金融面板，避免其它页面复制相似逻辑形成分叉。
- 涉及文件：
  - `apps/api/src/modules/dashboard/dashboard-charts.service.ts`（sector heatmap/candlestick 输出）
  - `apps/web/app/(app)/dashboard/charts/sector-heatmap.tsx`
  - `apps/web/app/(app)/dashboard/charts/financial-candlestick.tsx`
- 实施步骤：
  - 明确这两张图的入口与用途（金融面板），其它页面如需类似能力优先复用组件/接口。
  - 清理重复实现（若存在多处类似热力/蜡烛实现，统一到同一套组件与数据契约）。
- 验收标准：金融对比图表只在约定面板出现，且复用同一组件/接口。

### DV.T8（P2）事件页时间线：继续用于话题/事件聚合（配合新时间口径）
- 问题：事件页时间线是话题/事件聚合的主要承载，需要在时间口径统一后保持“排序/聚合/展示”的一致性。
- 涉及文件：
  - `apps/web/app/(app)/topics/topics-content.tsx`
  - `apps/api/src/modules/items/items.service.ts`（聚合来源，详见 DV.T13）
- 实施步骤：
  - 在 UI 上标明时间线排序依据（Published 优先、Ingested 兜底）。
  - 聚合结果中的 `latestAt` 与列表内 item 排序统一使用同一字段链路。
- 验收标准：时间线排序与卡片时间标签一致。

### DV.T9（P0）图表状态统一：延迟/空数据/回补中/错误提示与交互
- 问题：目前不同页面混用 `Alert/Empty/Skeleton/ChartEmptyState`，缺少“回补中”语义；用户在无数据时无法判断是空、延迟还是正在回补。
- 涉及文件：
  - `apps/web/hooks/useEconomicData.ts`（状态信号源）
  - `apps/web/components/chart-empty-state.tsx`（统一空态组件）
  - `apps/web/components/echart.client.tsx`（统一图表容器）
- 实施步骤：
  - 定义统一的 `ChartDataState`：`ok | empty | delayed | backfilling | error`（可由 hook/接口返回）。
  - `ChartEmptyState` 扩展支持 `delayed/backfilling`（或新增轻量组件 `ChartStatusBanner`，但保持统一入口）。
  - 所有图表页统一使用该组件呈现状态与“Retry/Refresh”动作。
- 验收标准：任一图表在上述状态下呈现一致、可复用、可配置的 UI。

### DV.T10（P1）组件复用与配置化：统一复用 `DashboardChart`/`ChartEmptyState`
- 问题：各图表组件有独立的 loading/error/empty/export 逻辑，维护成本高且口径容易分叉。
- 涉及文件：
  - `apps/web/components/echart.client.tsx`（`DashboardChart`）
  - `apps/web/components/chart-empty-state.tsx`
  - `apps/web/app/(app)/dashboard/charts/*`
  - `apps/web/app/(app)/dashboard/*/page.tsx`
- 实施步骤：
  - 抽象 `DashboardChartCard`（建议）统一处理：标题/更新时间/导出/状态层（DV.T9）。
  - 将现有 WarMap/SectorHeatmap/FinancialCandlestick 以及经济页中的图表逐步迁移到统一容器。
- 验收标准：图表容器逻辑分叉显著减少；新增图表只需传 `option + state`。

### DV.T11（P0）`processed.result` 类型不一致导致前端解析不稳定（回归修复）
- 问题：`processed.result` 在数据层可能出现“对象/字符串”混存；GraphQL resolver 直接 `JSON.stringify` 会导致双重编码，前端 `JSON.parse` 后出现空字段或类型不一致。
- 涉及文件：
  - `packages/mongo/src/models/processed-item.ts`（模型定义）
  - `apps/api/src/graphql/resolvers/items.resolver.ts`（`processed.result` 序列化）
  - `apps/web/app/(app)/items/items-view.tsx`（前端 `JSON.parse`）
- 实施步骤：
  - 后端：
    - 在 resolver/loader 层对 `processed.result` 做归一化：若为字符串，先尝试 `JSON.parse`；最终只输出一次序列化。
    - 评估引入 GraphQL JSON 标量或结构化字段（中期目标：前端不再 `JSON.parse`）。
    - 视数据情况补一次 Mongo 数据修复脚本：将 `result` 为字符串的记录回写为对象。
  - 前端：
    - 短期：增加“二次 parse”防御（当 parse 结果为字符串时再次 parse），并在异常时记录可观测日志。
    - 中期：迁移到结构化 GraphQL 字段后移除 `JSON.parse`。
- 验收标准：Items 列表中 `published_at/source/topics/entities/quality_score` 等字段稳定可读，不再因解析导致空值。
- 验证方式：为 resolver 增加 Jest 单测覆盖 “result 为 string/object/invalid” 三种情况。

### DV.T12（P0）情感筛选“看似可用但无数据”（字段产出与筛选契约补齐或下线）
- 问题：前端存在情感筛选项，但后端/流水线未稳定产出对应字段，导致筛选项可选但几乎无结果。
- 涉及文件：
  - `apps/api/src/modules/news-pipeline/news-pipeline.schema.ts`（当前未定义 sentiment 字段）
  - `apps/api/src/modules/items/items.service.ts`（facets/filters 里读取 `result.sentiment*`）
  - `apps/web/app/(app)/items/components/faceted-search.tsx`（前端始终展示 sentiment 选项）
- 实施步骤（二选一，需产品决策）：
  - 方案 A（上线情感）：在清洗产物里补齐 `sentiment`（建议枚举：positive/neutral/negative），并保证落库、聚合、筛选、展示闭环。
  - 方案 B（暂时下线）：前端隐藏/禁用情感筛选；后端 facets 仍可返回空但 UI 不呈现“可用控件”。
- 验收标准：情感筛选要么“有数据且可解释”，要么“不可见/不可操作并有说明”，不能处于“看似可用”的灰区。

### DV.T13（P1）事件/话题排序与聚合：从 `createdAt` 迁移到 `published_at`
- 问题：事件/话题聚合窗口与排序若依赖 `createdAt`，会偏离真实发布时间（例如延迟入库/回补导致排序漂移）。
- 涉及文件：
  - `apps/api/src/modules/items/items.service.ts`（topic/event groups 聚合管道）
  - `apps/web/app/(app)/topics/topics-content.tsx`（`latestAt` 与 item 排序）
- 实施步骤：
  - 后端：聚合管道中将窗口过滤从 `createdAt >= since` 迁移为 `sortAt >= since`（`sortAt` = 解析 `published_at`，失败则 fallback `createdAt`）。
  - 前端：对 `latestAt` 的含义加说明（Published 优先），并与 item 列表保持一致。
- 验收标准：同一事件在回补/延迟入库后不会因为 createdAt 变化而“异常靠前”。

### DV.T14（P1）分页与排序口径统一：稳定排序（服务端）替代页内客户端二次排序
- 问题：当前 Items 列表是服务端按 `createdAt` 分页，但前端对页内数据再按 `publishedAt` 排序，导致页内顺序与总数/翻页不稳定。
- 涉及文件：
  - `apps/api/src/modules/items/items.service.ts`（`listWithCursor` 排序字段）
  - `apps/web/app/(app)/items/items-view.tsx`（`sortedData` 页内排序）
- 实施步骤：
  - 后端：为 Items 查询提供可选 `orderBy`（至少支持 `publishedDesc`）；实现稳定 cursor（建议使用复合 cursor：`(publishedAt|createdAt, id)`）。
  - 数据侧：若 `publishedAt` 不在 SQL 表中，评估新增 `ItemMeta.publishedAt`（由流水线回填）作为排序基准，避免跨库排序。
  - 前端：移除“页内二次排序”，完全依赖服务端返回的稳定顺序。
- 验收标准：同一筛选条件下翻页顺序稳定、总数稳定、页内不跳动。

### DV.T15（P1）“Breaking News” 实为 “Analysis Stream”（命名与语义对齐）
- 问题：组件/入口命名为 Breaking News，但实际内容来自 `analysisResults`（Analysis stream），语义不一致。
- 涉及文件：
  - `apps/web/app/(app)/dashboard/components/breaking-news-stream.tsx`
  - `apps/api/src/graphql/resolvers/analysis.resolver.ts`
- 实施步骤：
  - 前端：重命名组件/导航/文案为 Analysis Stream（或根据产品重新定义 Breaking News 的真实数据源）。
  - 后端：若要保留 Breaking News 概念，需新增对应数据源与字段契约，否则保持 Analysis 命名一致。
- 验收标准：用户看到的名称与数据来源一致；标签/语义不再误导。

### DV.T16（P2）WarMap 国家字段缺失：后端回补/兜底策略 + 可观测性
- 问题：WarMap 依赖 `AlertEvent.context` 的国家字段；缺失或字段名不一致时无法落点。
- 涉及文件：
  - `apps/api/src/modules/dashboard/dashboard-charts.service.ts`（国家解析）
  - `packages/db/prisma/schema.prisma`（`AlertEvent.context`）
- 实施步骤：
  - 后端：扩展解析策略（更多 key、从 message/metadata 推断），并记录 unlocated 的原因统计（用于排查数据源）。
  - 运维：在告警写入/规则触发链路中尽可能补齐标准化 `countryCode/countryName` 字段。
- 验收标准：无法落点时可解释、可排查；并且能逐步减少 unlocated 比例。

### DV.T17（P2）热力图/蜡烛图 `sourceField` 白名单导致空数据：改为可配置映射
- 问题：后端使用硬编码 `PREFERRED_SOURCE_FIELDS`/OHLC 别名，遇到数据源字段名不匹配就直接空图。
- 涉及文件：
  - `apps/api/src/modules/dashboard/dashboard-charts.service.ts`（白名单/别名）
  - `packages/db/prisma/schema.prisma`（`EconomicDataPoint.sourceField`，可作为映射依据）
- 实施步骤：
  - 数据侧：为每个 `EconomicDataItem` 增加“字段映射配置”（可放 `metadata` 或新增表），包括：
    - 热力图偏好字段：`preferredSourceField`
    - 蜡烛图字段映射：`open/high/low/close` 对应的 `sourceField` 集合
  - 后端：优先使用配置；无配置时 fallback 到“最近窗口内点数最多的 sourceField”并记录日志。
  - 前端：在 tooltip 中显示实际使用的 `sourceField`（可选），帮助解释数据来源。
- 验收标准：字段名变化/多语言字段下仍能稳定出图，不再因白名单不匹配而空白。

