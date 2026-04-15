# Modular-Monolith 产品审计报告

> 审计日期: 2026-04-16
> 审计范围: 全球态势感知与新闻情报分析平台（modular-monolith）
> 审计视角: 产品经理
> 方法论: 基于代码与数据模型的实际状态，覆盖 6 个维度

---

## 平台概览

| 维度 | 现状 |
|------|------|
| 可部署应用 | 4 个 — `web`(Next.js 15), `api`(NestJS 11), `vector`(Qdrant), `ais-relay`(AIS WebSocket) |
| 共享包 | 5 个 — config, db(Prisma/MySQL), mongo(Mongoose), utils, vector-client |
| 后端领域模块 | 32 个领域, 41 个 NestJS Module, 60+ Controller, 23 个 GraphQL Resolver |
| 前端路由页面 | 50+ 页面, 分布于 `(app)` / `(auth)` / `(reader)` 三个活跃路由组 |
| 数据模型 | 75 Prisma 模型(MySQL) + 19 Mongoose 模型(MongoDB) + Qdrant 向量索引 |
| 实时能力 | 6 WebSocket 网关 + 1 SSE 端点 + 14 BullMQ 队列 + 15+ Cron 任务 |

---

## 一、核心链路完整性

### 评估方法

逐环节检查 **采集 → 清洗 → 结构化 → 关联 → 检索 → 可视化 → 推送** 七个环节。

### 1.1 采集（Crawl）— 完备度: ★★★★★

| 子能力 | 状态 | 说明 |
|--------|------|------|
| 新闻源管理 | ✅ 完整 | `NewsSource` 模型支持 频率/优先级/分组/熔断器，前端 `/admin/ops/news-sources` 可管理 |
| 调度系统 | ✅ 完整 | `NewsSourceSchedulerService` 每 30s 调度，双优先级队列 (hot/normal)，自适应并发 |
| 爬取执行 | ✅ 完整 | Crawl4AI 集成，支持 Layered/Native/Hybrid 三种执行模式 |
| Frontier 探索 | ✅ 完整 | 树形 Frontier 节点 + LLM Judge + LLM Learn 队列，`CrawlWorkflowStudio` 前端可视化编排 |
| 模板系统 | ✅ 完整 | `CrawlTemplate` + `CrawlStrategyWorkflow` 版本化配置 |
| 质量监控 | ✅ 完整 | `CrawlQualityTaskSnapshot` 每 5 分钟刷新，前端 `/admin/ops/crawl-monitor` |
| 媒体资产 | ✅ 完整 | `CrawlMediaAsset/Blob` SHA256 去重存储 |

**结论**: 采集环节是平台最成熟的模块，功能覆盖从源发现到质量监控的完整闭环。

### 1.2 清洗 + 结构化（Clean + Structure）— 完备度: ★★★★☆

| 子能力 | 状态 | 说明 |
|--------|------|------|
| 内容清洗 | ✅ 完整 | LLM 单次调用完成 Markdown 清洗、去噪 |
| 元数据提取 | ✅ 完整 | 标题/副标题/作者/来源/发布时间/语言/地理位置 |
| 摘要生成 | ✅ 完整 | `summary` + `key_points` 结构化输出 |
| 分类 | ✅ 完整 | 多层分类器 (LLM + Embedding + Rerank)，分配 taxonomy path |
| 情感分析 | ✅ 完整 | `sentiment_label` (positive/neutral/negative) |
| NER 实体提取 | ✅ 完整 | person/company/industry/organization/location/product/index/policy/commodity + confidence |
| 知识图谱关系 | ✅ 完整 | `kg_relations` (subject/predicate/object/confidence/evidence) 最多 20 条 |
| 质量评分 | ✅ 完整 | `quality_score` 由 LLM 在清洗阶段计算 |
| 去重 | ✅ 完整 | Embedding 向量相似度 + LLM Judge 双模式 |

**Gap**: NER/情感/KG 关系提取全部 bundle 在一次 LLM 调用中，无法独立迭代或使用专用 NER 模型（spaCy/Flair）。没有独立的质量门控阶段——低质量文章仍会消耗 LLM tokens。

### 1.3 关联（Association）— 完备度: ★★★★☆

| 子能力 | 状态 | 说明 |
|--------|------|------|
| 知识图谱构建 | ✅ 完整 | 每 5 分钟增量 ingestion，实体解析 + 关系 upsert + 别名管理 |
| 实体消歧 | ✅ 完整 | LLM 辅助消歧 (`knowledge-graph-entity-disambiguation.service.ts`) |
| 关系质量验证 | ✅ 完整 | LLM-based yes/no/uncertain 验证 |
| 影响分析 | ✅ 完整 | executive_change / commodity_move / policy_event 场景，图遍历涟漪效应 |
| 人工审核 | ✅ 完整 | 低置信边的 review queue |
| 新闻事件聚类 | ✅ 完整 | 每 5 分钟增量 ingestion，向量相似度事件分配 |
| 事件时间线 | ✅ 完整 | 每 10 分钟重建，KL 散度检测 topic drift |
| 新闻-经济指标关联 | ✅ 完整 | Pearson 相关性 + 回测框架 (`NewsIndicatorAssociation`) |
| 情感快照 | ✅ 完整 | 每小时聚合 entity/topic 级别情感快照 |

**Gap**: 事件聚类仅基于向量相似度，缺少 BERTopic/LDA 等主题模型聚类方式。

### 1.4 检索（Search）— 完备度: ★★★☆☆

| 子能力 | 状态 | 说明 |
|--------|------|------|
| 全文搜索 | ⚠️ 可用但有限 | MySQL `FULLTEXT` 索引 + MongoDB text index，**无 Elasticsearch** |
| 向量语义搜索 | ✅ 完整 | Qdrant 集成，0.78 最小相似度，30 天窗口，最多 300 结果 |
| 混合检索 | ✅ 完整 | Lexical + Semantic + Hybrid 三种模式，融合排序 |
| 搜索建议 | ✅ 完整 | 语义建议 + 来源建议，带缓存 |
| Faceted 过滤 | ✅ 完整 | 分面搜索 (category, source, language, dateRange 等) |
| 搜索遥测 | ✅ 完整 | `search-telemetry` 模块追踪搜索行为 |
| 高亮 | ❌ 缺失 | 无搜索结果关键词高亮 |
| 高级检索语法 | ❌ 缺失 | 无布尔运算 (AND/OR/NOT)、短语匹配、字段限定搜索 |

**Gap**: **无 Elasticsearch/OpenSearch** 是检索环节最大的结构性短板。MySQL fulltext + Qdrant 的组合在数据量增长后面临性能和功能瓶颈（无高亮、无聚合、无同义词扩展、无 fuzzy match）。

### 1.5 可视化（Visualization）— 完备度: ★★★★★

| 子能力 | 状态 | 说明 |
|--------|------|------|
| 战争地图 | ✅ 完整 | MapLibre/deck.gl，军事飞行(OpenSky) + AIS 船舶 + 新闻标记 + 聚类 |
| 经济仪表盘 | ✅ 完整 | 7 个专题仪表盘 (短/中/长期经济、军事、民生、关键指标、经济预警) |
| K 线图 | ✅ 完整 | 金融 OHLC + 商品价格 |
| 时空热力图 | ✅ 完整 | 地理热力图 + 信息传播图 |
| 行业热力图 | ✅ 完整 | 板块热力图 |
| 实体影响图 | ✅ 完整 | 实体共现 + Pearson 相关性，ECharts 关系图 |
| 新闻事件列表 | ✅ 完整 | 事件浏览 + 详情 + 来源溯证 + 归档 |
| 今日简报 | ✅ 完整 | Breaking Alerts + Headlines + Hot Topics + User Digest + Latest Feed |
| AI 助手 | ✅ 完整 | query/report/forecast 三种模式 |

**Gap**: 知识图谱缺乏独立的可视化探索页面（力导向图/Cytoscape），仅通过仪表盘 widget 和管理面板间接暴露。

### 1.6 实时推送（Push）— 完备度: ★★★☆☆

| 子能力 | 状态 | 说明 |
|--------|------|------|
| WebSocket 实时推送 | ✅ 完整 | 6 个网关: notifications / newsnow / situation-monitor / ops / quality / queue |
| SSE 仪表盘流 | ✅ 完整 | 指纹去重，10s 默认间隔 |
| 应用内通知 | ✅ 完整 | DB 记录 + WebSocket 推送 |
| 邮件通知 | ✅ 完整 | Nodemailer + Handlebars 模板，告警渠道 |
| Webhook | ✅ 完整 | 告警渠道，SSRF 防护 |
| 浏览器推送 | ❌ 缺失 | 无 Web Push / Service Worker |
| 移动推送 | ❌ 缺失 | 无 FCM/APNs 集成 |
| 定时摘要推送 | ❌ 缺失 | Digest 仅支持按需获取，无定时邮件投递 |

**Gap**: 推送环节的核心短板是 **Digest 没有定时投递机制**——用户必须手动访问 `/today` 页面才能看到个人摘要，无法通过邮件/推送被动接收每日简报。

### 1.7 链路完整性汇总

```
采集 ──→ 清洗+结构化 ──→ 关联 ──→ 检索 ──→ 可视化 ──→ 推送
 ★★★★★     ★★★★☆       ★★★★☆   ★★★☆☆    ★★★★★     ★★★☆☆
```

**断链点**:
1. **检索 → 可视化**: 搜索结果无法直接生成分析报告或触发告警（需用户手动操作）
2. **关联 → 可视化**: KG 后端完备但前端无独立探索页面
3. **可视化 → 推送**: Digest 缺乏定时投递，形成 "最后一公里" 断链

---

## 二、用户旅程覆盖

### 2.1 角色定义（基于 RBAC 实际配置）

| 角色 | 权限数 | 核心职责 |
|------|--------|----------|
| Admin | 全部 23 项 | 平台配置、用户管理、数据源管理 |
| Manager | 19 项 | 运营管理、分析执行、告警管理 |
| Analyst | 10 项 | 只读浏览、搜索分析 |

### 2.2 管理员旅程

| 旅程 | 状态 | 说明 |
|------|------|------|
| 登录系统 | ✅ | 密码 + 邮件验证码双方式 |
| 组织管理 | ✅ | 创建/编辑/停用组织，组织切换 |
| 用户管理 | ✅ | 列表/搜索/多角色分配/启停用/登录记录 |
| 角色权限管理 | ✅ | 3 个系统角色 + 自定义角色，23 项细粒度权限 |
| 数据源管理 | ✅ | 新闻源 CRUD，爬取模板，策略工作流，Frontier 探索 |
| 系统设置 | ✅ | 33+ 配置面板覆盖 LLM/安全/调度/限流/邮件/地理等 |
| 审计日志 | ✅ | 带留存策略的完整审计追踪 |
| 队列管理 | ✅ | Bull Board UI + 手动调度/取消/重试 |
| **邀请用户** | ❌ 缺失 | 无邮件邀请流程，用户只能由管理员在后台创建 |
| **密码重置** | ❌ 缺失 | 无忘记密码/重置密码功能 |
| **用户注册** | ❌ 缺失 | 无自助注册页面 |
| **MFA 管理** | ❌ 缺失 | 无双因素认证 |
| **SSO 配置** | ❌ 缺失 | 无 OAuth/SAML/OIDC |

### 2.3 分析师旅程

| 旅程 | 状态 | 说明 |
|------|------|------|
| 每日简报 | ✅ | `/today` 页面: Breaking Alerts + Headlines + Hot Topics + Digest + Feed |
| 新闻浏览 | ✅ | `/items` 列表 + `/items/[id]` 详情 + `/read/items/[id]` 阅读模式 |
| 实时新闻流 | ✅ | `/newsnow` WebSocket 实时推送，支持多列/分源 |
| 搜索 | ✅ | `/search` 全文+语义混合搜索，faceted 过滤 |
| 事件追踪 | ✅ | `/events` 事件列表 + 详情 + 归档，来源溯证 |
| 主题浏览 | ✅ | `/topics` 主题浏览器 |
| 态势监控 | ✅ | `/situation-monitor` 实时信号监控 + Telegram/OREF 信号 |
| 地图视图 | ✅ | `/map` 军事飞行 + AIS 船舶 + 新闻地理标记 |
| 仪表盘 | ✅ | 7 个经济/军事专题仪表盘，自定义 widget |
| 告警管理 | ✅ | `/alerts` 规则配置 + 多渠道投递 (应用内/邮件/Webhook) |
| AI 助手 | ✅ | `/assistant` 查询/报告/预测三种模式 |
| 订阅管理 | ✅ | `/subscriptions` 主题/实体订阅 + 基于行为的推荐 |
| 金融数据 | ✅ | `/finance` 宏观/趋势/民生/关键指标 |
| RSS 阅读 | ✅ | `/rss` RSS 阅读器 |
| **数据导出** | ⚠️ 部分 | 存在 `data-export.ts` + `use-csv-export.ts`，但仅在告警和部分图表可用 |
| **保存/分享分析** | ❌ 缺失 | 无法保存搜索条件、分享分析视图、生成分析报告链接 |
| **协作标注** | ❌ 缺失 | 无团队协作标注、评论、共享笔记功能 |
| **个人设置** | ⚠️ 基础 | `/profile` 仅头像，无法修改姓名/密码 |

### 2.4 普通用户旅程

| 旅程 | 状态 | 说明 |
|------|------|------|
| **Onboarding** | ❌ 缺失 | 无引导教程、新手向导、功能介绍 |
| **公开门户** | ❌ 缺失 | `(portal)` 路由组目录不存在，无公开可访问的新闻门户 |
| **移动端适配** | ⚠️ 基础 | 存在 `useMediaQuery` / responsive 断点，但核心可视化（战争地图、K 线图）未做移动适配 |
| **多语言** | ⚠️ 部分 | `react-i18next` 已接入 + `useTranslation` 广泛使用，但无独立语言包文件 (`locales/` 目录缺失)，翻译键散布在 `defaultValue` 中 |
| **无障碍** | ❌ 未评估 | 未发现 ARIA 标签或键盘导航优化 |

---

## 三、模块间协同

### 3.1 后端已实现但前端未接入

| 后端能力 | API/Service | 前端状态 | 优先级 |
|----------|-------------|----------|--------|
| 知识图谱浏览 | `knowledge-graph.service.ts` + GraphQL resolver | 仅管理面板配置，无独立探索页 | **P0** |
| 实体影响分析 | `knowledge-graph-impact.service.ts` | 仅嵌入仪表盘 widget | P1 |
| 搜索遥测仪表盘 | `search-telemetry.controller.ts` | 无前端展示 | P1 |
| 分类质量审核 | `classification-quality.controller.ts` 完整 CRUD | 管理面板有基础配置，缺完整审核工作台 | P1 |
| Pipeline 回放/回滚 | `pipeline-recovery.controller.ts` | 无前端入口 | P2 |
| Geo 地理编码 | `geo.controller.ts` + Nominatim | 仅设置面板，无直接功能使用 | P2 |
| 向量服务管理 | `vector-client.service.ts` | 仅设置面板 | P2 |
| 新闻-指标回测 | `NewsIndicatorAssociationBacktestRun` | 无前端展示 | P1 |
| 用户登录记录 | `listUserLoginRecords` | 无前端展示 | P2 |

### 3.2 前端页面存在但后端 API 可能不足

| 前端页面 | 发现 | 优先级 |
|----------|------|--------|
| `/profile` | 仅支持头像修改，缺少姓名/密码/偏好设置 API | **P0** |
| `/subscriptions` | 页面实际渲染的是告警+通知管理，与"内容订阅"标题不完全匹配 | P1 |
| `(portal)` 路由组 | 目录不存在，公开门户为空壳 | P1 |
| `/news-hub` | 存在但实现细节需验证 | P2 |

### 3.3 GraphQL 与 REST 双轨问题

平台同时暴露 23 个 GraphQL Resolver 和 60+ REST Controller，前端混合使用 Apollo Client (GraphQL) 和直接 fetch (REST)。两套 API 的功能覆盖不完全对称：

- **仅 GraphQL**: topics, processed-item-event, knowledge-graph-review, knowledge-graph-impact, entity-impact-graph
- **仅 REST**: 全部 system-settings (22 个 controller), observability (10 个 controller), queue ops, crawl frontier, realtime-signals-runtime
- **双轨并存**: items, dashboard, alerts, crawl, analysis, assistant, notifications, rbac

**风险**: API 治理成本高，新功能需决定暴露在哪套接口。

---

## 四、数据闭环

### 4.1 闭环链路评估

```
用户行为追踪 ──→ 个性化推荐 ──→ 内容订阅 ──→ 摘要推送
     ★★★☆☆         ★★★☆☆        ★★★★☆      ★★☆☆☆
```

#### 用户行为追踪 (user-news-behavior)

| 维度 | 状态 |
|------|------|
| 追踪事件类型 | `view` / `click` / `open_event` / `open_item` / `bookmark` (5 种) |
| 存储 | Redis Hash, 7 维度 (actions/sources/topics/entities/items/events/domains), 90 天 TTL |
| 权重 | view=1, click=2, open_event/open_item=3, bookmark=4 |
| **缺失: 负面信号** | 无 dislike / not-interested / hide / 取消订阅 |
| **缺失: 阅读深度** | 无 dwell time / scroll depth / 阅读完成率 |
| **缺失: 分享** | 无 share 事件类型 |
| **缺失: 时间衰减** | 计数器在 90 天窗口内无衰减，89 天前的爆发与昨天等权 |

#### 个性化推荐

| 能力 | 状态 |
|------|------|
| 订阅推荐 | ✅ 基于行为 profile embedding 的 catalog 相似度排序 + LLM rerank |
| 信息流排序 | ✅ NewsNow 信息源排序 (affinity 0.42 + behavior 0.58 + focus bonus 0.35) |
| **缺失: 文章级推荐** | 仅排序信息**源**，不排序单篇文章 |
| **缺失: 协同过滤** | 无 "相似用户也关注" 机制 |
| **缺失: ML 模型训练** | 纯规则打分，无离线特征工程/模型训练 pipeline |
| **缺失: A/B 测试** | 无实验框架，权重为全局配置 |

#### 内容订阅 (user-content-subscriptions)

| 能力 | 状态 |
|------|------|
| 可订阅类型 | `topic` + `entity` (2 种) |
| Catalog 自动构建 | ✅ 90 天窗口，≥2 次出现，embedding + taxonomy 分类 |
| 与态势监控联动 | ✅ 双向同步 |
| **缺失: 来源订阅** | 无法订阅特定新闻源 |
| **缺失: 关键词订阅** | 无自定义关键词/短语订阅 |
| **缺失: 地理区域订阅** | 无按国家/地区过滤 |

#### 摘要推送 (user-digest)

| 能力 | 状态 |
|------|------|
| Digest 生成 | ✅ 基于订阅的 topic/entity 过滤 NewsEvent，enriched with sentiment + indicator associations |
| **缺失: 定时投递** | 无 Cron 触发，无邮件投递，无推送通知 |
| **缺失: 频率配置** | 无每日/每周/即时选项 |
| **缺失: 格式选项** | 无 PDF/Newsletter 格式 |

### 4.2 闭环诊断

**闭环现状**: 行为采集 → 信息源排序 + 订阅推荐 → 内容订阅 → Digest 生成。链路存在但**最后一环断裂**——Digest 无法主动到达用户。

**数据闭环断裂点**:
1. **被动 vs 主动**: 所有个性化内容均需用户主动访问，无推送到达机制
2. **无反馈回路**: 用户对推荐/Digest 的 accept/dismiss 行为未被回采
3. **无效果度量**: 无推荐 CTR、Digest 打开率等效果指标

---

## 五、运营与可观测

### 5.1 现状评估

| 能力 | 状态 | 详情 |
|------|------|------|
| 健康检查 | ✅ 完整 | 7 项: MySQL/Redis(含集群)/MongoDB/Crawl4AI/SSRF Proxy/LLM Gateway/Disk |
| Pipeline 质量 | ✅ 完整 | 成功率、延迟百分位(p50/p90/p99)、按阶段失败分布、LLM 成本追踪 |
| 新闻源健康 | ✅ 完整 | 总/活跃/失败/熔断数，Top 失败源 |
| 分类质量 | ✅ 完整 | 采样 + 标注 + 审核队列 + 报告生成 |
| 队列管理 | ✅ 完整 | Bull Board UI (10 队列)，手动调度/取消/重试 |
| 实时事件流 | ✅ 完整 | 3 个 WebSocket 网关 (ops/quality/queue) 广播 5 类队列事件 |
| 审计日志 | ✅ 完整 | Outbox 模式保证可靠写入，可配置留存策略 |
| 异常事件采集 | ✅ 完整 | 客户端(限流) + 服务端(Token 认证) 双通道 |
| 系统设置 | ✅ 完整 | 22+ 运行时配置 Controller |

### 5.2 发现的 Gap

| Gap | 影响 | 优先级 |
|-----|------|--------|
| **无 Prometheus/OpenTelemetry 指标导出** | 无法接入 Grafana/Datadog 标准监控栈 | **P0** |
| **Pipeline 降级无自动告警** | 成功率下降/延迟飙升需人工巡检发现 | **P0** |
| **无 SLA/SLO 定义** | 无数据新鲜度 SLO (如 "95% 文章 5 分钟内入库") | P1 |
| **无分布式追踪** | `traceId` 存在于异常事件但无 Jaeger/OTel 集成 | P1 |
| **无成本仪表盘** | LLM 成本逐条追踪但无汇总趋势/预算告警 | P1 |
| **无数据新鲜度监控** | 经济数据源超期未更新时无告警 | P1 |
| **无 Runbook 链接** | 质量面板发现问题后无处置流程指引 | P2 |
| **无可用性历史** | 健康检查存在但无 uptime 记录和状态页 | P2 |
| **无容量规划指标** | 队列深度可见但无吞吐趋势和容量预测 | P2 |

---

## 六、竞品差距

### 对标产品

| 对标 | 定位 | 核心差异化 |
|------|------|------------|
| **GDELT** | 全球事件数据库 | 大规模开放数据集, GKG (Global Knowledge Graph), 主题模型, 情感指数, 地理编码覆盖 |
| **Recorded Future** | 威胁情报平台 | CTI (Cyber Threat Intelligence), IOC 关联, 暗网监控, 攻击面管理 |
| **Feedly for TI** | 威胁情报信息流 | AI Feed, MITRE ATT&CK 映射, STIX/TAXII, 团队协作 |

### 6.1 vs GDELT

| GDELT 能力 | 本平台状态 | Gap 优先级 |
|------------|-----------|-----------|
| 全球事件编码 (CAMEO) | ❌ 无标准事件编码体系 | P1 |
| Global Knowledge Graph (GKG) | ✅ 有 KG 但缺可视化探索 | P1 |
| 全球情感指数 (GDAIndex) | ⚠️ 有实体/主题情感快照，但缺全局聚合指数 | P1 |
| 多语言覆盖 (65+ 语言) | ⚠️ 支持语言检测但未见 65+ 语言处理能力 | P2 |
| 时空可视化 (GDELT Globe) | ✅ 有战争地图/时空热力图，能力对等 | - |
| 开放数据 API | ❌ 无公开数据集/API，仅闭环使用 | P2 |
| 电视新闻分析 | ❌ 无视频/电视新闻处理能力 | P2 |

### 6.2 vs Recorded Future

| RF 能力 | 本平台状态 | Gap 优先级 |
|---------|-----------|-----------|
| 威胁情报 (CTI) | ❌ 无 IOC/TTP/CVE 关联 | P2* |
| 暗网/论坛监控 | ❌ 仅覆盖公开新闻源 | P2* |
| 攻击面管理 | ❌ 不在平台定位内 | N/A |
| 实体卡 (Intelligence Cards) | ⚠️ 有实体模型但缺实体详情页 | **P0** |
| 风险评分 | ⚠️ 有 quality_score 和 heatScore，缺综合实体风险评分 | P1 |
| STIX/TAXII 输出 | ❌ 无标准情报交换格式 | P2 |
| Playbook 自动化 | ❌ 无自动化响应编排 | P1 |

> *P2 标注 CTI 相关能力，因为平台当前定位更偏向新闻情报而非网络威胁情报

### 6.3 vs Feedly for Threat Intelligence

| Feedly TI 能力 | 本平台状态 | Gap 优先级 |
|----------------|-----------|-----------|
| AI Feed (Leo) | ✅ 有 AI 助手 + 个性化排序 | - |
| MITRE ATT&CK 映射 | ❌ 无安全框架映射 | P2* |
| 团队协作 (Boards/Notes) | ❌ 无协作标注/共享看板 | **P0** |
| Newsletter/报告生成 | ❌ 无自动化报告输出 | **P0** |
| MTTI (Mean Time to Intelligence) | ⚠️ 有 pipeline 延迟追踪但无 MTTI 指标 | P1 |
| API 集成 (SOAR/SIEM) | ❌ 无标准集成接口 | P1 |
| 移动端 | ❌ 无原生移动应用 | P1 |
| Deduplication Feed | ✅ 完整去重体系 | - |
| Power Search | ⚠️ 有混合搜索但缺高级语法 | P1 |

### 6.4 本平台的差异化优势

本平台相比上述竞品具备的**独特优势**:

1. **战争地图 + 军事态势**: 集成 OpenSky (军事飞行) + AIS (船舶追踪) + 新闻地理标记，竞品中罕见
2. **经济-新闻关联分析**: 新闻情感与经济指标的 Pearson 相关性 + 回测，Feedly/GDELT 不具备
3. **Frontier 自适应爬取**: LLM Judge + LLM Learn 驱动的智能 Frontier 探索，超越传统 RSS/API 采集
4. **态势监控**: Telegram/OREF 信号集成 + 自适应学习状态，面向特定区域冲突监控
5. **多维仪表盘体系**: 7 个专题经济仪表盘 (短/中/长期+军事+民生)，竞品通常仅有通用仪表盘

---

## 七、Action Items 汇总

### P0 — 必须修复 (影响核心用户价值)

| # | Action Item | 所属维度 | 预期收益 |
|---|-------------|----------|----------|
| 1 | **实现密码重置/忘记密码流程** | 用户旅程 | 用户无法自助恢复账户是上线阻断项 |
| 2 | **实现用户注册或邀请流程** | 用户旅程 | 当前无法扩展用户基数 |
| 3 | **构建知识图谱独立探索页** (力导向图可视化, 实体详情卡) | 链路完整性 / 竞品差距 | KG 是核心差异化资产，当前对用户不可见 |
| 4 | **实现 Digest 定时邮件投递** | 数据闭环 | 闭环 "最后一公里"，激活被动信息到达 |
| 5 | **接入 Prometheus/OpenTelemetry 指标导出** | 运营可观测 | 接入标准监控栈是生产运行的基础设施 |
| 6 | **Pipeline 降级自动告警** (成功率/延迟/熔断阈值) | 运营可观测 | 当前降级只能靠人工巡检发现 |
| 7 | **团队协作能力** (共享看板/标注/评论) | 竞品差距 | 情报平台的核心差异化场景，当前完全缺失 |
| 8 | **自动化报告/Newsletter 生成** | 竞品差距 | 分析师需要输出成果物给决策者 |

### P1 — 应该修复 (影响产品竞争力)

| # | Action Item | 所属维度 | 预期收益 |
|---|-------------|----------|----------|
| 9 | **引入 Elasticsearch/OpenSearch** 替代 MySQL fulltext | 链路完整性 | 高亮、聚合、同义词、fuzzy match、规模化检索 |
| 10 | **实现高级搜索语法** (布尔/短语/字段限定) | 链路完整性 | 分析师核心工作流 |
| 11 | **实体详情页** (Intelligence Card) | 竞品差距 | 360 度实体视图: 关联事件/情感趋势/知识图谱关系/经济指标 |
| 12 | **行为追踪增加负面信号** (not-interested / hide) + 时间衰减 | 数据闭环 | 推荐准确性的基础 |
| 13 | **文章级个性化排序** (不仅排序源，也排序文章) | 数据闭环 | 从 "源级" 升级到 "文章级" 个性化 |
| 14 | **数据导出增强** (全量 CSV/PDF/API 导出) | 用户旅程 | 分析师需要离线分析和报告素材 |
| 15 | **Profile 完善** (修改姓名/密码/偏好) | 用户旅程 | 基础用户体验 |
| 16 | **SLA/SLO 定义** (数据新鲜度、pipeline 延迟) | 运营可观测 | 运营目标量化 |
| 17 | **LLM 成本汇总仪表盘** + 预算告警 | 运营可观测 | 成本可控性 |
| 18 | **新闻-指标回测前端** | 模块协同 | 后端完整但用户无法使用 |
| 19 | **搜索遥测仪表盘前端** | 模块协同 | 理解搜索使用模式 |
| 20 | **全球情感聚合指数** (类 GDELT GDAIndex) | 竞品差距 | 宏观态势感知的关键指标 |
| 21 | **标准事件编码体系** (CAMEO 或自定义) | 竞品差距 | 事件可比性和跨时间分析 |
| 22 | **Playbook 自动化** (告警 → 自动执行动作链) | 竞品差距 | 从 "感知" 到 "响应" 的闭环 |
| 23 | **分布式追踪** (OpenTelemetry → Jaeger) | 运营可观测 | 跨服务问题定位 |

### P2 — 可以优化 (提升体验和差异化)

| # | Action Item | 所属维度 | 预期收益 |
|---|-------------|----------|----------|
| 24 | 公开门户 `(portal)` 实现 | 用户旅程 | 公开信息窗口，潜在获客渠道 |
| 25 | Onboarding 新手引导 | 用户旅程 | 降低上手门槛 |
| 26 | 移动端适配优化 | 用户旅程 | 移动场景覆盖 |
| 27 | 国际化语言包提取 | 用户旅程 | 多语言用户支持 |
| 28 | OAuth/SSO 接入 | 用户旅程 | 企业级认证 |
| 29 | MFA 双因素认证 | 用户旅程 | 安全合规 |
| 30 | 搜索结果关键词高亮 | 链路完整性 | 用户体验 |
| 31 | 分类质量完整审核工作台 | 模块协同 | 后端有，前端不完整 |
| 32 | 可用性历史 / 状态页 | 运营可观测 | 运营透明度 |
| 33 | 容量规划指标 | 运营可观测 | 预防性运维 |
| 34 | API 双轨(GraphQL+REST)治理策略 | 模块协同 | 降低维护成本 |
| 35 | Web Push / 浏览器通知 | 链路完整性 | 实时触达 |
| 36 | STIX/TAXII 标准情报格式输出 | 竞品差距 | 行业互操作性 |
| 37 | Runbook 链接集成 | 运营可观测 | 运维闭环 |
| 38 | 行为计数器时间衰减 | 数据闭环 | 推荐时效性 |

---

## 附录: 模块清单

<details>
<summary>后端 32 个领域模块</summary>

akshare, alerts, analysis, archive, assistant, audit, auth, cache, config, crawl, dashboard, email, geo, health, items, knowledge-graph, model-service, news-aggregator, news-events, news-indicator, news-pipeline, notifications, observability, org, queue, rbac, realtime-signals, search-telemetry, sentiment, situation-monitor, storage, system-settings, user-content-subscriptions, user-digest, user-news-behavior, user-settings, vector, websocket

</details>

<details>
<summary>前端 50+ 页面路由</summary>

**`(app)` 路由组**: /admin, /admin/alerts, /admin/audit-logs, /admin/dashboards, /admin/errors, /admin/logs, /admin/ops, /admin/ops/crawl-frontier, /admin/ops/crawl-monitor, /admin/ops/crawl-tasks, /admin/ops/crawl-tasks/[taskId], /admin/ops/crawl-templates, /admin/ops/news-sources, /admin/orgs, /admin/quality, /admin/settings, /admin/settings/[section], /admin/storage, /admin/system, /alerts, /assistant, /crawl, /crawl/[taskId], /dashboard, /dashboard/economic-alert, /dashboard/economic-long, /dashboard/economic-medium, /dashboard/economic-short, /dashboard/key-monitor, /dashboard/livelihood-prices, /dashboard/military-alert, /events, /events/[id], /events-archive, /finance, /finance/key-monitor, /finance/livelihood, /finance/macro, /finance/trends, /items, /items/[id], /map, /news-hub, /newsnow, /newsnow/[column], /profile, /rss, /search, /settings, /settings/system, /situation-monitor, /subscriptions, /today, /topics

**`(auth)` 路由组**: /login

**`(reader)` 路由组**: /read/items/[id]

</details>
