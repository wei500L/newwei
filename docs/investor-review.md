# 投资人产品审查报告

> 产品：**智能新闻聚合 × 个性化推荐 × 知识图谱平台**（Modular Monolith）
> 文档时间：2026-04-18｜基于主干代码 `main@604caf15` 的真实代码盘点
> 文档用途：面向投资人的功能盘点与技术深度说明；所有功能均可在代码中溯源到具体文件

---

## 一、产品定位与市场切入点

**一句话定位**：为金融、舆情、政策、行业分析类 B 端客户提供「多源全球新闻抓取 → 流水线结构化 → 个性化推荐 → 知识图谱影响分析」的一站式信息智能平台。

**市场切入**：
- **C 端读者流量入口**：Next.js 前端的 `(portal)` 对外门户与 `(reader)` 阅读器（`apps/web/app/(portal)`、`apps/web/app/(reader)`）面向公众用户，提供 RSS 友好、SEO 友好的频道页。
- **B 端组织/租户工作台**：`(app)` 路由组提供 26 个业务入口（情报监控、知识图谱、态势监控、告警、分析工作台、财经、地图等），面向分析师、企业战情团队。
- **金融/宏观研究场景**：已集成 GDELT、Finnhub、FRED、AKShare、YFinance（`apps/api/src/modules/akshare/providers/`），天然切入金融研究与宏观经济分析赛道。
- **政企与舆情场景**：内置国内 51 个主流内容源（`apps/api/src/modules/news-aggregator/sources/`，含 36kr、百度、微博、知乎、雪球、华尔街见闻、参考消息、澎湃、财联社、科创板日报等），切入舆情监控与国内市场洞察。

**差异化护城河**：同时覆盖「抓取 + 流水线 + 推荐 + 知识图谱 + 影响分析 + 向量检索 + 金融行情 + AIS 船舶实时定位」的 40+ 模块化业务域（`apps/api/src/modules/` 共 44 个模块），多源 × 多智能层 × 多行业的组合深度在单团队项目中较为少见。

---

## 二、核心功能矩阵

采用**三层分层**呈现：**基础层**（内容采集 × 流水线 × 存储）／**智能层**（推荐 × 知识图谱 × 向量 × LLM）／**管理层**（多租户 × 权限 × 合规 × 可观测性）。

### 2.1 基础层：多源抓取与结构化流水线

| 能力 | 说明 | 关键入口 |
| --- | --- | --- |
| **51 个国内外内容源** | NewsNow 聚合 36kr、知乎、微博、雪球、哔哩哔哩、GitHub、HackerNews、早报、华尔街见闻、财联社、参考消息、科创板日报、抖音、快手、酷安、少数派等 | `apps/api/src/modules/news-aggregator/sources/`（51 个 `.ts` 文件） |
| **金融数据供应商矩阵** | AKShare、Finnhub、FRED、YFinance 四大 Provider 注册表模式接入 | `apps/api/src/modules/akshare/providers/akshare.provider.ts`、`finnhub.provider.ts`、`fred.provider.ts`、`yfinance.provider.ts` |
| **智能抓取引擎** | Crawl4AI 集成、LLM 引导 Frontier、自适应并发控制、站点画像、链接分析、OPML 导入 | `apps/api/src/modules/crawl/crawl-frontier-llm.service.ts`、`crawl-adaptive-concurrency.service.ts`、`crawl-site-profile.service.ts`、`news-source-opml.service.ts` |
| **分阶段处理流水线** | `legacy` 与 `staged` 两种模式；`staged` 含 preflight → clean → quality_gate 等阶段；每阶段可独立配置 LLM Prompt | `apps/api/src/modules/news-pipeline/news-pipeline.service.ts:831-1737`（process / stage 执行）、`news-extraction-stage.service.ts` |
| **去重（LLM 辅助）** | LLM 参与的高精度去重策略 | `apps/api/src/modules/news-pipeline/news-dedupe-llm.ts`、`news-dedupe-settings.service.ts` |
| **RSS 翻译** | 原生 RSS 条目翻译服务 + 日度指标 | `apps/api/src/modules/items/items-rss-translation.service.ts`、Prisma `RssTranslationMetricsDaily` |
| **AIS 船舶实时中继** | 独立微服务，WebSocket 长连消费 aisstream.io，内置候选分类与优雅关闭 | `apps/ais-relay/src/index.ts`、`candidate-classification.ts` |
| **存储层** | PostgreSQL（Prisma，80+ 数据模型）+ MongoDB（原始条目 / 处理条目 / Assistant 运行记录等）+ Redis（缓存、速率、画像、锁） | `packages/db/prisma/schema.prisma`（2345 行）、`packages/mongo/src/models/`（21 个模型） |

**技术深度**：`news-pipeline.service.ts` 超过 5200 行，支撑阶段式流水线 + 补发 SSE 流 + MongoDB 写入 + 向量入库 + 分类质量追踪 + 事件聚类触发的复合逻辑。

### 2.2 智能层：个性化 × 图谱 × 向量 × LLM

| 能力 | 说明 | 关键入口 |
| --- | --- | --- |
| **个性化推荐（行为+协同过滤混合）** | 内容分 × 0.4 + 协同分 × 0.3 + 来源分 × 0.15 + 热度分 × 0.15，四路融合 | `apps/api/src/modules/news-aggregator/newsnow-recommended.service.ts:271-278` |
| **用户行为多维建模** | 9 种正向事件（view=1 ～ completed_read=4）、2 种负向事件（not_interested=4、unsubscribe=5）；6 维画像（sources/topics/entities/items/events/domains） | `apps/api/src/modules/user-news-behavior/user-news-behavior.service.ts`、`user-news-behavior.constants.ts` |
| **时间衰减** | 指数权重 `1d=0.45 / 7d=0.30 / 30d=0.17 / 90d=0.08`；行为画像 Redis TTL 95 天 | 同上 |
| **协同过滤（用户近邻）** | 共享信号 ≥ 3；Top 50 近邻；余弦相似度 `dot / √(t·c)`；分数半衰期 90 天；Snapshot 缓存 6h；脏标传播（被依赖用户自动失效） | `user-news-behavior.service.ts` `computeNeighbors` / `getCollaborativeProfile` |
| **五类订阅系统** | topic / entity / source / keyword / geo 共表、每类上限 50；组织级 `ContentSubscriptionCatalog` 每 6 小时滚动同步 90 天候选 | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.service.ts`（2464 行） |
| **地理订阅归一** | 输入 → ISO alpha-2；`AMBIGUOUS_REGION_CODES` 屏蔽 EU/APAC/EMEA 等模糊区域；国家变体正则匹配 | `apps/api/src/common/geo-subscription.ts:64`、`apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.service.ts` |
| **新闻事件聚类** | BERTopic 风格聚类服务 + 余弦相似度代表项选择；按语言 × Embedding 模型分组 | `apps/api/src/modules/news-events/news-events-bertopic.service.ts:46-200` |
| **知识图谱（图数据库结构）** | `KnowledgeEntity` / `KnowledgeEntityAlias` / `KnowledgeEdge`（带 `confidence` × `weight`）/ `KnowledgeEdgeEvidence`；实体消歧、质量评分、审核工作流、摄取状态跟踪 | `packages/db/prisma/schema.prisma:2258-2337`、`apps/api/src/modules/knowledge-graph/`（9 个服务） |
| **影响传播分析** | 高管变动影响、大宗商品波动影响、政策事件影响三大场景；基于边的 `confidence × weight` 计算影响分（如 `100 + edge.weight*2 + edge.confidence*10`） | `apps/api/src/modules/knowledge-graph/knowledge-graph-impact.service.ts:67-420` |
| **向量服务（可降级）** | 独立 `apps/vector` 微服务；主服务 `VectorClientService` 支持 `searchBestEffort`/`upsertBestEffort`/`upsertOrThrow`；MongoDB fallback；运行时诊断 | `apps/api/src/modules/vector/vector-client.service.ts:37-252`、`apps/vector/src/modules/vector/`、`packages/vector-client/` |
| **LiteLLM 多模型网关** | 抽象 completion / embedding / rerank 三类模型；MySQL 网关配置；多 Provider 负载均衡、Fallback、速率、防护栏（Guardrail） | `apps/api/src/modules/news-pipeline/litellm.service.ts:227-337`、`litellm-proxy-governance.service.ts`、`litellm-proxy-lb-settings.service.ts` |
| **AI 助手（Assistant）** | 查询 / 报告 / 预测三种任务；运行时能力感知（Web Search）；Guardrail 可插拔；Prompt 建设器 | `apps/api/src/modules/assistant/assistant.service.ts:118-410` |
| **情感分析** | 实体级、主题级情感快照；接入流水线 | `apps/api/src/modules/sentiment/`、Prisma `EntitySentimentSnapshot` / `TopicSentimentSnapshot` |
| **新闻-指标关联** | Pearson 相关 + 最佳滞后扫描（best-lag correlation）+ 回测运行 | `apps/api/src/modules/news-indicator/news-indicator-math.ts:72-192`、Prisma `NewsIndicatorAssociation*` |
| **每日摘要（个性化）** | 基于订阅 + 情感 + 指标，时区感知，邮件 + 站内通知双通道；每分钟调度 + 组级分布式锁 + 并发可调 | `apps/api/src/modules/user-digest/user-digest.service.ts`、`user-digest-delivery-scheduler.service.ts` |

### 2.3 管理层：多租户 × 合规 × 运维

| 能力 | 说明 | 关键入口 |
| --- | --- | --- |
| **多租户组织** | Unicode 友好 slug（支持中日韩字符）；事务内写默认角色；审计 best-effort | `apps/api/src/modules/org/org.service.ts:47` |
| **RBAC 多角色合并** | `Membership` × `MembershipRole` 多角色；权限缩量校验防提权；角色变更缓存失效；审计写入限流 | `apps/api/src/modules/rbac/rbac.service.ts:33`、`apps/api/src/common/authz/membership-permissions.ts` |
| **MFA（TOTP）** | RFC6238 自研实现（HMAC-SHA1、30s 窗口、±1 容差）；加密存储 Secret；8 个恢复码（SHA-256 hash）；支持 off / all_users / admins_only 策略 | `apps/api/src/modules/auth/mfa.service.ts:30`、`auth-flow.utils.ts:62` |
| **SSO（OIDC）** | PKCE 流、discovery 文档、state TTL、登录后 handoff token 与 MFA 衔接 | `apps/api/src/modules/auth/oidc-auth.service.ts:31` |
| **会话吊销** | Access Token / Refresh Token 双黑名单；`/auth/logout`、`logoutAll` | `AccessTokenBlacklistService`、`RefreshTokenBlacklistService` |
| **审计日志** | 保留策略可配置；每天 01:00 分批（1000/批）定时清理；`AuditLogOutbox` 保证写入 | `apps/api/src/modules/rbac/audit-log-retention.service.ts:17`、`apps/api/src/modules/audit/audit-log-outbox.service.ts` |
| **搜索遥测** | 查询长度分桶、垂直频道事件（如 `archive_load_more_click`）、日聚合 | `apps/api/src/modules/search-telemetry/search-telemetry.service.ts:43-148` |
| **流水线恢复** | 按 `itemMetaId` 列运行历史、`replay`（重新入列）、`rollback`（回滚持久化） | `apps/api/src/modules/observability/pipeline-recovery.service.ts:35-182` |
| **可观测性** | 分类质量队列、流水线质量、新闻源质量、客户端异常收集、实时 WebSocket（`quality.gateway`、`ops.gateway`） | `apps/api/src/modules/observability/`（28 个文件） |
| **告警规则引擎** | `AlertRule` / `AlertEvent` / `AlertDelivery` / `AlertRuleChannel`；节流（通知防抖）、多通道投递 | `apps/api/src/modules/alerts/alerts.service.ts`、`alerts-notification-throttle.service.ts` |
| **仪表盘** | 宏观长中短、民生价格、关键监控、经济告警、实时告警、分析面板 | `apps/web/app/(app)/dashboard/*` |
| **地理编码** | Nominatim Provider + 缓存（含负缓存）+ 速率限制；管理后台可调用测试 | `apps/api/src/modules/geo/geocoding.service.ts:45-140` |
| **存储加密** | 第三方存储凭据加密落库 | `apps/api/src/modules/storage/storage-settings.crypto.ts` |
| **系统设置集成枢纽** | 23+ 子项可运行时调整（归档、审计、Assistant 安全、Auth 缓存、邮件、实体影响图、金融 Provider、LiteLLM 网关等） | `apps/api/src/modules/system-settings/` |

---

## 三、技术架构与工程深度

### 3.1 架构全景图

```
                         ┌────────────────────────────────────────┐
                         │       Next.js 14 Web（apps/web）        │
                         │   (app) 工作台 · (portal) 门户 ·         │
                         │   (reader) 阅读器 · (auth) 登录          │
                         └────────────┬───────────────────────────┘
                                      │ GraphQL + REST + WS
                         ┌────────────▼───────────────────────────┐
                         │   NestJS Modular Monolith（apps/api）   │
                         │   44 个业务模块，40+ REST Controller，  │
                         │   GraphQL Resolvers，WebSocket Gateway  │
                         └─┬────┬────┬───┬──────────┬────────────┬┘
                           │    │    │   │          │            │
               ┌───────────▼┐ ┌─▼─┐ ┌▼──┐ ┌────────▼─────┐ ┌────▼─────┐
               │ PostgreSQL │ │Mg │ │Re │ │ Vector Svc    │ │ AIS Relay │
               │ (Prisma)   │ │Mgo│ │dis│ │(apps/vector)  │ │           │
               └────────────┘ └───┘ └───┘ └───────────────┘ └───────────┘
                     80+       20+    缓存     向量检索        船舶流
                     关系模型  文档    速率    Qdrant-style   WS 中继
                     审计 RBAC  原始   会话    best-effort
                     图谱 行为  处理   分布式  降级 Mongo
                              条目    锁
                ┌───────────────────────┐
                │  LiteLLM Gateway       │──► OpenAI / Claude / Gemini / 本地模型
                │  (completion/embed/    │
                │   rerank, 多 Provider) │
                └───────────────────────┘
                ┌───────────────────────┐
                │  Crawl4AI + SSRF Proxy │──► 抓取目标站
                │  Frontier LLM 引导     │
                └───────────────────────┘
```

### 3.2 技术亮点（按护城河价值排序）

1. **可量化的推荐算法** — 推荐权重、时间衰减 bands、近邻过滤阈值全部**代码即文档**，非空口而谈；加权公式 `0.4 / 0.3 / 0.15 / 0.15` 与衰减系数 `0.45 / 0.30 / 0.17 / 0.08` 来自 `newsnow-recommended.service.ts:271` 与 `user-news-behavior.constants.ts`。
2. **LLM 模型独立治理层** — `LiteLlmService` 抽象 completion / embedding / rerank 三路调用，配合 `litellm-proxy-governance.service.ts` 与 `litellm-proxy-lb-settings.service.ts` 可运行时切换厂商，避免厂商锁定；`Guardrail` 违规类型独立抛错（`LiteLlmGuardrailViolationError`）。
3. **向量服务可降级** — `VectorClientService.searchBestEffort` 在向量服务不可用时自动 fallback 到 Mongo 过滤（`fallbackToMongoEnabled`），保证核心功能不因基础设施不稳而中断。
4. **知识图谱置信度建模** — `KnowledgeEdge` 同时记录 `confidence`（数据来源可信度）与 `weight`（边权）两个维度，影响分公式如 `100 + edge.weight*2 + edge.confidence*10`，具备可解释性。
5. **五类订阅 × 跨源聚合** — 同一张表承载 topic/entity/source/keyword/geo 五种语义，`USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND` 统一封顶；`ContentSubscriptionCatalog` 组织级候选集 6 小时滚动同步，支撑「发现 → 订阅 → 摘要」一条链。
6. **多阶段流水线 + 失败可重放** — `staged` 流水线 + `pipeline-recovery.service.ts` 的 `replay`/`rollback`，以及 `MongoOutbox`、`AuditLogOutbox`、`CrawlCleanupOutbox` 三套 Outbox 模式，给运维与事故复盘留出足够空间。
7. **工程资产的「数量级」厚度** — 44 个业务模块、80+ 关系模型、20+ MongoDB 模型、51 个国内外内容源、2345 行 Prisma Schema、5242 行流水线单体服务；这意味着后发竞品需要 1–2 年工程积累才能对齐。

### 3.3 测试与质量

| 维度 | 数据 |
| --- | --- |
| 单元/集成测试 | `*.spec.ts` 遍布各模块（如 `news-aggregator.service.spec.ts`、`knowledge-graph/__tests__/`、`crawl/crawl-frontier.service.spec.ts`），观察到 30+ 测试文件 |
| 静态检查 | ESLint + TypeScript + Prettier + Husky + lint-staged（`package.json:47-58`） |
| 健康检查 | Redis、MongoDB、Crawl4AI、LLM 网关、SSRF 代理五类健康探针（`apps/api/src/modules/health/`） |
| Smoke 测试 | `docker:smoke:ais-relay-startup`（`package.json:27`），Redis AOF 修复脚本（`docker:redis:repair`） |

---

## 四、数据与智能化能力深度

### 4.1 用户行为建模（护城河之一）

- **维度与权重（`user-news-behavior.constants.ts`）**：每事件每维上限 8，key 截断 96 字符；Redis Hash 实时写入 + Prisma 聚合持久化。
- **时间衰减 bands（非连续函数，工程简洁度高）**：`{ 1d:0.45, 7d:0.30, 30d:0.17, 90d:0.08 }`，总和 1.0；按 day offset 归档。
- **协同过滤参数（可被投资人审阅）**：
  - Top 信号 24（`SIMILARITY_TOP_SIGNALS`）
  - 共享信号阈值 ≥ 3（`SIMILARITY_MIN_SHARED_SIGNALS`）
  - 近邻保留 50（`SIMILARITY_NEIGHBOR_LIMIT`）
  - 半衰期 90 天（`SIMILARITY_SCORE_HALF_LIFE_DAYS`）
  - Snapshot 缓存 6h、锁 30s
- **脏标传播**：删除用户画像时，自动将依赖该用户的其他用户 snapshot 标 `dirty=true`，避免陈旧近邻污染。

### 4.2 知识图谱与影响分析

- **数据模型**：`KnowledgeEntity`（实体）+ `KnowledgeEntityAlias`（别名消歧）+ `KnowledgeEdge`（关系，含 confidence/weight）+ `KnowledgeEdgeEvidence`（证据链路）+ `KnowledgeGraphIngestionState`（摄取进度）。
- **核心服务分拆**（`apps/api/src/modules/knowledge-graph/`）：
  - `knowledge-graph.service.ts`（主服务，1055 行）
  - `knowledge-graph.ingestion.service.ts`（摄取）
  - `knowledge-graph-entity-disambiguation.service.ts`（消歧）
  - `knowledge-graph-quality.service.ts`（质量）
  - `knowledge-graph-review.service.ts`（人工审核）
  - `knowledge-graph-impact.service.ts`（影响分析）
- **影响分析三个开箱即用场景**（`knowledge-graph-impact.service.ts`）：
  - `analyzeExecutiveChange` — 高管变动 → 关联公司股票代码/行业/竞争者
  - `analyzeCommodityMove` — 大宗商品波动 → 受影响行业
  - `analyzePolicyEvent` — 政策事件 → 受影响行业
- **影响打分可解释**：每条 edge 同时报告 `confidence`/`weight`，评分公式暴露在代码中。

### 4.3 事件聚类与情感

- **BERTopic 聚类**：按 `language × embeddingModel` 分组；代表项与成员余弦相似度（`news-events-bertopic.service.ts:188-190`）；聚类失败恢复队列（`news-event-clustering-recovery.processor.ts`）。
- **情感快照**：`EntitySentimentSnapshot` / `TopicSentimentSnapshot`；摘要服务通过 bucket 关联到事件。
- **NewsNow 国内舆论指数**：独立服务 `newsnow-domestic-opinion-index.service.ts` + 滚动快照 `NewsnowDomesticOpinionIndexSnapshot`。

### 4.4 新闻与指标关联（金融研究护城河）

- **Pearson 相关 + 最佳滞后扫描**：`news-indicator-math.ts:72-192`，代码级即可复现。
- **回测持久化**：`NewsIndicatorAssociationBacktestRun` 存储回测运行，供前端「新闻影响指标」面板回溯。

---

## 五、可扩展性与合规能力

| 维度 | 实现 |
| --- | --- |
| **MFA 合规** | TOTP（可扩展至 SMS/邮件 OTP，目前未实现）；恢复码 SHA-256 入库、一次性消费；Enroll / Verify 两种 Challenge 类型隔离 |
| **登录防护** | 登录速率限制（Redis `login:*` 键）、邮箱验证码冷却、OIDC state TTL 10 分钟 |
| **组织隔离** | 全部业务读写按 `orgId` 过滤；RBAC 权限缩量防提权；角色可自定义 |
| **审计可查** | 审计字段统一 `writeAuditLogBestEffort` + Outbox；保留天数可配 + 定时清理 |
| **地理化** | ISO alpha-2 归一（`geo-subscription.ts:64`）+ Nominatim 解析 + 缓存；模糊区域码黑名单防误归 |
| **数据保留** | 行为画像 Redis 95 天；用户可 DELETE `/user-news-behavior/profile` 请求删除 |
| **速率限制** | 跨 RBAC 写、邀请、登录、WebSocket 连接、Crawl 抓取多维度；统一 `ActionRateLimitService` 与 `RateLimiterService` |
| **GDPR-ready（部分）** | 个人画像可删；但**用户数据导出接口**（Right to Portability）**未观察到**，需补足 |
| **SSRF 防护** | `crawl4ai-ssrf-proxy` 独立代理 + 健康探针 |
| **独立部署单元** | `ais-relay`（AIS 中继）、`vector`（向量服务）、`api`、`web` 四个独立进程，Docker Compose 编排，支持横向扩展 |
| **运行时配置热更新** | `system-settings` 模块 23+ 子项（LiteLLM、Assistant 安全、Crawl 模板、地理 Nominatim、Auth 缓存、邮件等）支持无重启调整 |

---

## 六、产品成熟度指标

### 6.1 已实现（代码可见，可 Demo）

- **采集** ✅ 51 个国内外源 + Crawl4AI + OPML 导入 + 站点画像 + LLM Frontier
- **流水线** ✅ staged + legacy 双流水线 + LLM 去重 + 分类质量追踪 + 恢复 replay/rollback
- **金融数据** ✅ AKShare/Finnhub/FRED/YFinance 四 Provider
- **推荐** ✅ 行为建模 + 协同过滤 + 四路加权融合 + 运行中的 `/news-aggregator/recommended`
- **知识图谱** ✅ 实体、别名、边（conf/weight）、证据链、摄取状态、审核、质量、影响分析三场景
- **AI 助手** ✅ 查询 / 报告 / 预测 + Guardrail
- **向量检索** ✅ 独立服务 + Mongo fallback + 诊断
- **告警** ✅ 规则、事件、投递、节流、多通道
- **仪表盘** ✅ 宏观长中短、民生价格、实时告警、分析面板
- **多租户 & RBAC** ✅ Org slug（Unicode）、权限缩量、角色自定义
- **MFA（TOTP）+ SSO（OIDC）** ✅
- **审计日志 + 保留** ✅
- **搜索遥测** ✅ 查询长度分桶、点击事件、日聚合
- **AIS 船舶中继** ✅ 独立微服务
- **前端** ✅ 26 个工作台入口 + 对外门户 + 阅读器
- **Web Socket 通知** ✅ Queue / Ops / Quality / Notification 四类 Gateway

### 6.2 规划/半成品（代码中有迹象但未完全成型）

- **MFA 其他通道**：仅 TOTP；SMS/邮件 OTP、WebAuthn/Passkey 未见。
- **用户数据导出**：GDPR 数据可携带权未见接口。
- **FAQ / RAG 终端**：`assistant` 模块提供服务，但代码中未见面向用户的知识库导入/检索端到端链路；当前主要是查询 / 报告 / 预测三类任务。
- **收入化通路**：订阅/计费/配额相关模型在 Prisma Schema 中未见（无 `Subscription` / `BillingPlan` / `Usage` 等），**商业化层需补足**。
- **移动端 / 小程序**：仅 Next.js Web，未见 React Native / Flutter / 小程序工程。
- **管理后台（前端）完整度**：`apps/web/app/(app)/admin/*` 已覆盖 14 个子目录（alerts、audit-logs、dashboards、errors、logs、ops、orgs、quality、search-telemetry、settings、storage、system），但不同模块深度不一，建议下一轮抽样验收。

### 6.3 规模指标

| 指标 | 数值 |
| --- | --- |
| API 业务模块数 | 44（`apps/api/src/modules/`） |
| Prisma 关系模型数 | 80+（`packages/db/prisma/schema.prisma`，2345 行） |
| MongoDB 文档模型数 | 21（`packages/mongo/src/models/`） |
| 新闻内容源 | 51（NewsNow sources） + GDELT + Finnhub + FRED + AKShare + YFinance |
| Web 工作台路由 | 26（`apps/web/app/(app)`） |
| 核心服务代码量 | `news-pipeline.service.ts` 5242 行 / `user-content-subscriptions.service.ts` 2464 行 / `auth.service.ts` 1507 行 / `user-news-behavior.service.ts` 1460 行 / `knowledge-graph.service.ts` 1055 行 |
| 独立部署单元 | 4（api / web / vector / ais-relay） |

---

## 七、下一步路线图建议（面向投资人）

### 7.1 商业化闭环（最高优先级）

1. **计费/配额体系** — Prisma 中新增 `Subscription`/`Plan`/`Usage` 模型；在 LiteLLM Gateway、向量服务、抓取配额三处植入 `UsageTracker`；前端「套餐升级」页。
2. **API 商品化** — 将 `news-aggregator`、`knowledge-graph`、`news-indicator` 的 REST 端点封装为对外 OpenAPI + API Key 管理；沿用已有 `ActionRateLimitService` 限额。
3. **数据导出/合规** — 补齐 GDPR 数据可携带接口（`/user-data/export`），降低合规风险，打开欧洲/新加坡市场。

### 7.2 智能层深化

1. **语义检索升级** — 现 `VectorClientService` 是 best-effort；可对接 Reranker Chain + Hybrid Retrieval（BM25 × 向量），把 `LiteLlmService.getRerankModel` 与 Qdrant Rerank 能力串起来。
2. **知识图谱自动化扩张** — 利用 `KnowledgeGraphIngestionState` 做增量摄取 + LLM 自动消歧/抽边（已有 `knowledge-graph-entity-disambiguation.service.ts` 框架）；目标：节点数量级从「千/万」进入「十万/百万」。
3. **推荐冷启动** — 现协同过滤需共享信号 ≥ 3；新用户可引入 Content-based + LLM 兴趣引导对话，填充冷启动 14 天。

### 7.3 终端扩张

1. **移动端** — 基于 `(reader)` 与 `(portal)` 的 RSS 友好设计，投产 React Native 或 PWA 读者端。
2. **企业私有化部署包** — 现 Docker Compose 已成形（`infra/docker/`），可打包「离线私有云部署」SKU，切入金融与政企市场。

### 7.4 行业垂直化

1. **金融研究 SaaS** — 以 `news-indicator`（新闻-指标关联）+ `knowledge-graph-impact`（影响分析）为锚，推出「事件驱动研究」订阅产品。
2. **舆情监测 SaaS** — 以 `situation-monitor` + `newsnow-domestic-opinion-index` + 告警为锚，切 PR/市场情报场景。
3. **航运情报** — 以 `ais-relay` + `map` 面板为锚，切贸易/航运/大宗研究场景（独立卖点，当前少有同类平台把 AIS 与新闻图谱打通）。

---

## 附录：关键文件导航

| 主题 | 文件 |
| --- | --- |
| 推荐权重公式 | `apps/api/src/modules/news-aggregator/newsnow-recommended.service.ts:271` |
| 行为权重 & 衰减 | `apps/api/src/modules/user-news-behavior/user-news-behavior.constants.ts` |
| 协同过滤近邻 | `apps/api/src/modules/user-news-behavior/user-news-behavior.service.ts:107` |
| 五类订阅 | `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.service.ts:169` |
| 流水线主路径 | `apps/api/src/modules/news-pipeline/news-pipeline.service.ts:831` |
| 知识图谱影响 | `apps/api/src/modules/knowledge-graph/knowledge-graph-impact.service.ts:67` |
| 向量降级 | `apps/api/src/modules/vector/vector-client.service.ts:37` |
| LiteLLM 网关 | `apps/api/src/modules/news-pipeline/litellm.service.ts:227` |
| MFA (TOTP) | `apps/api/src/modules/auth/mfa.service.ts:30` |
| OIDC SSO | `apps/api/src/modules/auth/oidc-auth.service.ts:31` |
| 审计保留 | `apps/api/src/modules/rbac/audit-log-retention.service.ts:17` |
| 流水线恢复 | `apps/api/src/modules/observability/pipeline-recovery.service.ts:35` |
| 搜索遥测 | `apps/api/src/modules/search-telemetry/search-telemetry.service.ts:43` |
| 地理编码 | `apps/api/src/modules/geo/geocoding.service.ts:45` |
| Pearson 相关 | `apps/api/src/modules/news-indicator/news-indicator-math.ts:72` |
| AIS 中继 | `apps/ais-relay/src/index.ts` |
| 数据库 Schema | `packages/db/prisma/schema.prisma`（2345 行） |
| 对外门户 | `apps/web/app/(portal)/` |
| 阅读器 | `apps/web/app/(reader)/` |
| 工作台 | `apps/web/app/(app)/`（26 个入口） |

---

**审查结论**：这是一个**智能层深度 >> 商业化成熟度**的平台产品。技术底座足以支撑 2–3 个细分 SaaS 同时衍生；当前缺口是商业化闭环与对外产品化打包。建议投资条款对应「技术护城河强 × 需要商业化加速」的节奏安排。
