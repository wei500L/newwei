## AI 能力增强：Task 列表（可逐项落地）

目标：在现有 `NewsPipeline`（抓取→清洗→结构化→存储）基础上，补齐并产品化 5 类能力：事件聚类/故事追踪、实体知识图谱、多维情感分析、新闻-指标关联（走到预测/预警）、智能摘要定制。默认 **MySQL 为主存**，Mongo 仅用于展示/缓存与向量索引输入。

### 总体原则（落地约束）

- **数据主权**：一切结果以 `orgId` 隔离；跨组织绝不共享衍生结果与缓存 key。
- **可演进**：把 AI 结果固化为“可版本化的衍生域模型”，模型可替换、算法可迭代，但消费端协议稳定。
- **可降级**：向量/LLM 不可用时退化为规则/统计实现，避免业务完全不可用。
- **可回填**：所有衍生结果都支持离线回放、增量追赶、幂等写入与审计。

---

## Phase 0 · 统一信号层（News Signals）

> 目的：让后续 5 类能力共享同一套输入，不在每个模块里重复“再清洗一遍”。

- [x] 定义 `NewsSignal`（逻辑结构，不一定落库）：`articleId`, `processedArticleId`, `processedItemId`, `timestamp`, `language`, `topics[]`, `entities[]`, `sentiment`, `summary`, `qualityScore`
- [x] 明确 `timestamp` 优先级：`publishedAt` > `crawlAt` > `processedAt`
- [x] 明确 `language` 策略：默认同语种优先聚类，但允许高相似度跨语种合并（可配置 penalty）
- [x] 输出：`NewsSignal` 构造函数（`apps/api/src/modules/news-signals/news-signal.ts`）+ 回归测试（`apps/api/src/modules/news-signals/news-signal.spec.ts`）

验收：
- 任意 `ProcessedArticle` 均可稳定映射为 `NewsSignal`（缺字段时有合理 fallback）。

---

## Phase 1 · 事件聚类与故事追踪（MySQL 主存）

> 目的：把“事件”升级为一等实体（而不是临时分桶），支持时间线演进、合并/拆分、回填与可解释性。

### 1.1 数据模型（Prisma/MySQL）

- [x] 新增表：`NewsEvent`, `NewsEventItem`, `NewsEventTimelineEntry`, `NewsEventIngestionState`（已落地：`packages/db/prisma/schema.prisma` + migrations）
- [ ] 关键约束：
  - `NewsEventItem` 对 `(orgId, processedArticleId)` 唯一，保证幂等
  - 事件范围按 `orgId` 查询与索引

### 1.2 增量聚类任务（后台 Job）

- [x] 新增 `NewsEventSettingsService`（`systemSetting` 持久化，默认关闭）
- [x] 新增 `NewsEventIngestionService`（定时增量扫描 `ProcessedArticle`）
- [ ] 聚类算法（MVP）：
  - 优先：向量召回（基于 `ProcessedItem.summaryEmbedding` + vector service），再映射到事件
  - 降级：`primaryTopic`/`primaryEntity` + 时间窗规则
- [ ] 事件代表：维护 `representativeProcessedArticleId`（必要时可更新）

验收：
- 重复跑同一批文章不会创建重复 `NewsEventItem`。
- 无向量服务时仍能稳定产出事件（只是质量较弱）。

### 1.3 API（GraphQL）

- [x] `newsEvents`：事件列表（时间窗、语言、topic/entity filter 可后置）
- [x] `newsEvent`：事件详情（items + timeline）
- [x] settings：`newsEventSettings` / `updateNewsEventSettings`

---

## Phase 2 · Timeline 生成（故事追踪）

> 目的：从事件内多条新闻生成“演变时间线”，支持摘要与关键节点追踪。

- [x] `NewsEventTimelineService`：按日/小时 bucket 聚合 `NewsEventItem`
- [x] 规则版（先落地）：`title/summary/keyPoints` 选取代表文章或拼接要点
- [ ] 小模型版（后续接入）：对 bucket 内新增信息做“增量摘要”，输出可追溯引用

验收：
- timeline 每个 bucket 可重建（给定相同输入输出一致或可解释差异）。

---

## Phase 3 · 实体知识图谱增强（Linking + Query UX）

> 目的：把新闻里抽取的 `entities[]` 对齐到 `KnowledgeEntity`，并提供更好查询能力。

- [x] `ArticleEntityLink`（或等价结构）：`articleId`, `kgEntityId`, `mention`, `confidence`, `evidence`
- [x] 补齐 GraphQL：`articleEntityLinks(articleId)`（其余查询能力可迭代）
- [ ] 与事件打通：event → entities → KG subgraph/impact

验收：
- 对齐率与误配率可抽样评估；支持回填。

---

## Phase 4 · 多维情感分析（entity/topic/event）

> 目的：从“全局 sentiment”走到“按实体/主题分解”，并可做趋势与预警。

- [x] MVP：弱分配聚合（现有 `ProcessedItem.result.sentiment_label` + 命中实体/主题）
- [ ] 增强：小模型抽取 `entity_sentiments[]` / `topic_sentiments[]`（含 evidence）
- [x] 存储：`EntitySentimentSnapshot` / `TopicSentimentSnapshot`（时间桶、样本量、score/ratio）
- [ ] 与 alerts 集成：复用现有 `AlertMetricProvider.entity_sentiment`

验收：
- 趋势查询可用；告警源数据可追溯到具体新闻。

---

## Phase 5 · 新闻-指标关联 → 预测/预警（含评估/回测框架）

> 目的：把“相关性展示”升级为可评估、可回测、可上线的预测与预警能力。

### 5.1 数据集构建（Feature Store）

- [ ] 事件/实体/主题信号 → 时间序列（volume、sentiment、novelty 等）
- [ ] 经济指标序列：`EconomicDataPoint`（统一频率、缺失处理、变换：level/return）
- [ ] 生成训练/评估样本：`(features @ t) -> (target @ t+lag)`

### 5.2 关联发现（候选生成）

- [ ] lag 扫描 + 统计显著性 + 稳定性指标（跨窗口一致性）
- [ ] 输出候选：`NewsIndicatorAssociation`（scope, indicatorSlug, lag, metrics, lastEvaluatedAt）

### 5.3 回测框架（最重要的护栏）

- [ ] 定义策略：触发条件（event spike / sentiment shift）与持有期
- [ ] 评估指标：precision/recall、hit-rate、avg return、max drawdown、coverage、cost
- [ ] 产物：`AssociationBacktestRun` + `AssociationBacktestResult`

### 5.4 预警产品化

- [ ] 与 `alerts` 集成：新增/复用 metric provider（必要时扩展）
- [ ] 输出解释：必须引用“触发信号 + 历史回测指标 + 关联候选”，禁止编造因果

已落地（MVP，后续可强化）：
- [x] 数据模型：`NewsIndicatorAssociation` + `NewsIndicatorAssociationBacktestRun`
- [x] 关联发现：基于 `EntitySentimentSnapshot` / `TopicSentimentSnapshot`（feature）与 `EconomicDataPoint`（target return）做 lag 扫描
- [x] 回测护栏：rolling baseline z-score + holdout window（减少 look-ahead）
- [x] API：GraphQL `newsIndicatorAssociations/newsIndicatorAssociation/refreshNewsIndicatorAssociations` + REST `/news-indicator/*`
- [x] settings：GraphQL `newsIndicatorSettings/updateNewsIndicatorSettings`（默认关闭，需配置 indicator slugs）

验收：
- 任意预警都有可回放的 backtest 依据与输入数据快照。

---

## Phase 6 · 智能摘要定制（Role/Preference）

- [x] `UserDigestPreference`（关注实体/主题、长度、是否包含指标关联；基于 `UserSetting` key 存储）
- [x] `PersonalizedDigest`（复用 event/sentiment/association 作为上下文，规则版落地）
- [ ] 输出严格引用：所有事实必须来自存储的结构化结果与引用列表

已落地（MVP）：
- [x] REST：`GET/PUT /user-digest/preference`，`GET /user-digest`（返回结构化 digest）

---

## Phase 7 · 可观测性与治理

- [ ] 统一记录：每个能力的 `latencyMs/costUsd/token`、失败率、缓存命中率
- [ ] 数据质量面板：事件规模分布、合并率、情感覆盖率、关联稳定性、回测漂移
- [ ] 回放工具：按 `orgId + timeRange` 重跑并对比差异
