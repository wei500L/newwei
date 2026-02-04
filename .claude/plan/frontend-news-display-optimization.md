# 📋 前端新闻展示优化实施计划

## 任务概述

基于AI新闻聚合平台的深入分析，本计划涵盖5个核心优化方向：新闻卡片重构、事件页面化、今日简报重构、阅读模式、搜索增强。

**技术栈**: Next.js 15 + React 19 + Ant Design 5 + Tailwind CSS + GraphQL + TypeScript

---

## 任务类型

- [x] 前端 (Gemini主导)
- [ ] 后端 (Codex主导)
- [x] 全栈 (并行)

---

## 技术方案

### 整体架构策略

采用"**方案A先落地 + 方案B作为增强迭代**"的两阶段策略：

**阶段一（立即执行）**：
- 新闻卡片层级重排
- 事件页面页面化（消灭嵌套抽屉）
- 今日简报模块化重构
- 阅读模式独立路由
- 搜索自动补全（基于现有facets）

**阶段二（后续迭代）**：
- GraphQL扩展：`searchSuggestions(prefix)`、`entityFacets`、`todayBrief`
- 后端增强的突发预警准确性
- 实体联想质量提升

---

## 实施步骤

### Phase 1: 新闻卡片信息层次重排

**目标**: 从"技术指标优先"改为"内容优先"

#### 1.1 新信息层次结构

```
┌─────────────────────────────────────┐
│ [缩略图 - 保持160px高度]            │
├─────────────────────────────────────┤
│ [情感指示器] [来源] [发布时间]       │
├─────────────────────────────────────┤
│ [标题 - 2行截断，字体加大]           │
├─────────────────────────────────────┤
│ [摘要 - 3行可展开]                  │
├─────────────────────────────────────┤
│ [主题标签] [实体标签] [地点标签]      │
├─────────────────────────────────────┤
│ [所属事件 Badge - 如有]             │
├─────────────────────────────────────┤
│ [阅读时间] [质量分▼] [操作按钮]       │
└─────────────────────────────────────┘
```

#### 1.2 关键改动点

**文件**: `apps/web/app/(app)/items/components/news-card.tsx`

1. **情感可视化组件** (新增)
   - 创建 `SentimentBadge` 组件
   - 映射: positive → `--bullish` (绿色), negative → `--bearish` (红色), neutral → 灰色
   - 显示趋势箭头（如有历史数据）
   - Tooltip解释"情感来源于AI模型推断"

2. **技术指标收纳**
   - qualityScore、duplicateSimilarity、LLM元数据移至Info Popover
   - 点击Info图标展开技术详情抽屉

3. **事件关联展示**
   - 如文章属于某事件，显示Event Badge
   - 点击跳转事件详情页

4. **阅读时间估算**
   - 基于cleaned_markdown字数计算
   - 显示"约X分钟阅读"

#### 1.3 代码结构

```typescript
// 新增组件: apps/web/components/sentiment-badge.tsx
interface SentimentBadgeProps {
  sentiment: 'positive' | 'negative' | 'neutral';
  showTrend?: boolean;
  trendDirection?: 'up' | 'down' | 'stable';
}

// NewsCard 改动
- 移除顶部 qualityScore/duplicateSimilarity 标签
+ 顶部: SentimentBadge + Source + 发布时间
+ 底部: 阅读时间 + 技术指标Popover + 操作按钮
```

---

### Phase 2: 事件页面页面化

**目标**: 消灭嵌套抽屉，URL可分享，返回键语义正确

#### 2.1 路由重构

```
当前结构:
/events (列表) → Drawer打开事件详情 → 嵌套Drawer打开文章

新结构:
/events (列表页，保留筛选)
/events/[id] (事件详情页，Tabs: Brief/Timeline/Articles)
/events/[id]/items/[processedItemId] (事件上下文下的文章页，可选)
/items/[id] (独立文章页，从事件页跳转)
```

#### 2.2 文件改动

**文件**: `apps/web/app/(app)/events/events-content.tsx`

- 移除 `selectedEventId` state 和 Drawer
- "Brief" 按钮改为路由跳转: `router.push(/events/${event.id})`
- 保留"Open"按钮跳转独立事件页

**文件**: `apps/web/app/(app)/events/event-details-drawer.tsx` → 改造为 `event-detail-content.tsx`

- 抽取可复用组件 `EventDetailContent`
- 支持两种模式: `standalone` (独立页) / `embedded` (嵌入)
- 移除嵌套文章Drawer，改为跳转到 `/items/[id]`

**文件**: `apps/web/app/(app)/events/[id]/event-detail.tsx`

- 使用 `EventDetailContent` 组件
- 添加Breadcrumb导航: 首页 / 事件 / 当前事件标题
- 添加返回按钮返回事件列表

**文件**: `apps/web/app/(app)/events/[id]/page.tsx` (可能已存在)

- 确保服务端获取初始数据
- 支持 `?tab=brief|timeline|articles` 查询参数

#### 2.3 响应式布局

**桌面端**: Master-Detail布局
- 左侧: 事件列表（窄栏，可收起）
- 右侧: 事件详情主区域

**移动端**:
- 列表页点击跳转详情页
- 详情页全屏展示
- 底部固定返回按钮

#### 2.4 技术债偿还

- 合并 `event-details-drawer.tsx` 和 `event-detail.tsx` 的重复逻辑
- 抽取共享组件: `EventBriefSection`、`EventTimeline`、`EventArticlesList`

---

### Phase 3: 今日简报页面重构

**目标**: "编辑式结构"，帮助用户快速决策

#### 3.1 新布局结构 (Bento Grid)

```
┌─────────────────────────────────────────────────────────┐
│  突发预警 (Breaking Alerts) - 红色/警告样式，最优先      │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│  头条 (Headlines)        │  热门话题 (Hot Topics)       │
│  2-4条Hero卡             │  Tag云/趋势列表              │
│  大图+TL;DR              │  点击跳转搜索                │
│                          │                              │
├──────────────────────────┴──────────────────────────────┤
│  个性化简报 (Personalized Digest) - 保留现有功能         │
├─────────────────────────────────────────────────────────┤
│  今日全部新闻 (ItemsView) - 底部主列表                   │
└─────────────────────────────────────────────────────────┘
```

#### 3.2 模块实现

**文件**: `apps/web/app/(app)/today/page.tsx` 和 `today-content.tsx`

1. **突发预警模块** (`BreakingAlerts`)
   - 数据源: `newsEvents(windowDays=1, status=active)`
   - 启发式: lastAt最近 + itemCount高/增长快
   - 显示触发原因: "近2小时新增12篇报道"
   - 添加"仅供参考"文案

2. **头条模块** (`Headlines`)
   - 数据源: `items(dateRange=today, orderBy=PUBLISHED_DESC, limit=4)`
   - 排序加权: qualityScore + 是否属于高热event
   - 展示: 缩略图 + 标题 + TL;DR + 来源

3. **热门话题模块** (`HotTopics`)
   - 数据源: `itemFacets` 的 topics
   - 展示: Tag云或带趋势sparkline的列表
   - 交互: 点击跳转 `/search?topic=xxx`

4. **个性化简报**
   - 保留现有 `UserDigestPanel`
   - 位置调整至中下部

#### 3.3 响应式适配

- 桌面: 3列Grid (头条2列 + 话题1列)
- 平板: 2列Grid
- 手机: 单列堆叠

---

### Phase 4: 阅读模式

**目标**: 沉浸式阅读体验， distraction-free UI

#### 4.1 路由设计

```
新路由组: apps/web/app/(reader)/
- layout.tsx: 最小布局（保留auth，无TopNav/ActionRail）
- items/[id]/page.tsx: 阅读模式文章页
- events/[id]/page.tsx: 阅读模式事件简报页（可选）
```

#### 4.2 阅读模式UI

**文件**: `apps/web/app/(reader)/layout.tsx`

- 纯白色/米黄色背景（非玻璃拟态）
- 无顶部导航栏
- 底部浮动工具栏（半透明）

**文件**: `apps/web/app/(reader)/items/[id]/page.tsx`

- 内容区最大宽度: 720px (最优阅读行长度)
- 字体: Serif (Merriweather/Georgia) 或 Sans (Inter) 可切换
- 字号: 小/中/大 (16px/18px/20px)
- 行高: 1.6-1.8
- 段落间距: 1.5em
- 阅读进度条 (顶部细条)

**文件**: `apps/web/components/reader-toolbar.tsx`

- 字体切换 (Serif/Sans)
- 字号调整
- 主题切换 (Light/Sepia/Dark)
- 关闭阅读模式 (返回普通视图)
- 分享按钮

#### 4.3 内容来源优先级

1. `cleaned_markdown` (LLM清洗后的正文)
2. `summary` + `key_points`
3. 原文链接 (fallback)

#### 4.4 入口点

- 新闻卡片: "阅读模式" 按钮
- 文章详情页: "进入阅读模式" 按钮
- 事件来源列表: "阅读模式" 按钮

---

### Phase 5: 搜索体验增强

**目标**: 自动补全 + 高级查询语法

#### 5.1 统一搜索组件

**文件**: `apps/web/components/enhanced-search-box.tsx`

- 基于 AntD `AutoComplete` 封装
- 样式: Tailwind自定义（去除AntD默认"企业感"）

#### 5.2 自动补全

**阶段A (立即实现)**:
- 历史记录: localStorage存储最近10条搜索
- Facets建议: 从 `itemFacets` 获取 topics/regions/sentiments
- Debounce: 300ms
- 最小触发长度: 2字符

**阶段B (后续迭代)**:
- 后端API: `searchSuggestions(prefix)`
- 实体联想: 从知识图谱获取

#### 5.3 高级查询语法

**支持的语法**:
```
topic:人工智能       → 筛选主题
region:北京          → 筛选地区
sentiment:positive   → 筛选情感 (positive/neutral/negative)
from:2024-01-01     → 开始日期
to:2024-12-31       → 结束日期
source:彭博社        → 来源筛选
"精确短语"           → 短语搜索
```

**解析策略**:
- 前端解析输入文本，提取结构化参数
- 映射到URL参数: `?topic=xxx&region=xxx&sentiment=xxx&from=xxx&to=xxx&q=剩余文本`
- 剩余文本传给 `items(search=...)`

**UI辅助**:
- 语法帮助Popover (点击右侧图标)
- 错误token高亮提示
- 可视化标签展示已应用的筛选器

#### 5.4 与现有搜索整合

- 替换 `ItemsView` 中的搜索框
- 与 `CommandBar` 共用 suggestion provider
- 保持URL作为状态单一来源

---

## 关键文件清单

| 文件路径 | 操作 | 说明 |
|---------|------|------|
| `apps/web/app/(app)/items/components/news-card.tsx` | 修改 | 信息层次重排，情感可视化 |
| `apps/web/components/sentiment-badge.tsx` | 新增 | 情感指示器组件 |
| `apps/web/app/(app)/events/events-content.tsx` | 修改 | 移除Drawer，改为路由跳转 |
| `apps/web/app/(app)/events/event-details-drawer.tsx` | 修改/合并 | 抽取EventDetailContent |
| `apps/web/app/(app)/events/[id]/event-detail.tsx` | 修改 | 使用共享组件，添加导航 |
| `apps/web/app/(app)/today/today-content.tsx` | 修改 | Bento Grid布局，新增模块 |
| `apps/web/app/(app)/today/components/headlines.tsx` | 新增 | 头条模块 |
| `apps/web/app/(app)/today/components/hot-topics.tsx` | 新增 | 热门话题模块 |
| `apps/web/app/(app)/today/components/breaking-alerts.tsx` | 新增 | 突发预警模块 |
| `apps/web/app/(reader)/layout.tsx` | 新增 | 阅读模式布局 |
| `apps/web/app/(reader)/items/[id]/page.tsx` | 新增 | 阅读模式文章页 |
| `apps/web/components/reader-toolbar.tsx` | 新增 | 阅读工具栏 |
| `apps/web/components/enhanced-search-box.tsx` | 新增 | 增强搜索框 |
| `apps/web/lib/search-syntax-parser.ts` | 新增 | 查询语法解析器 |
| `apps/web/app/(app)/items/items-view.tsx` | 修改 | 集成新搜索框 |

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 路由变更导致既有入口失效 | 高 | 保留过渡兼容（query param），添加breadcrumb导航 |
| 预警误报/漏报伤害信任 | 中 | 显示触发原因，添加"仅供参考"文案，尽快推进后端增强 |
| 自动补全带来额外查询压力 | 中 | Debounce 300ms，最小长度2，Apollo缓存，本地缓存facets |
| 阅读模式XSS风险 | 中 | 保持react-markdown不启用raw HTML，外链走safeHttpUrl |
| Tailwind与AntD样式冲突 | 低 | 阅读模式以Tailwind为主，复用globals.css token |
| 事件页抽屉代码重复 | 中 | 抽取共享组件，统一维护 |

---

## 验收标准

### Phase 1
- [ ] 新闻卡片情感指示器可见，技术指标收纳到Info Popover
- [ ] 点击情感标签可筛选同情感文章
- [ ] 卡片显示阅读时间估算

### Phase 2
- [ ] 事件详情页URL可分享
- [ ] 浏览器返回键正确返回列表
- [ ] 移动端无嵌套抽屉
- [ ] 代码重复度降低（Drawer和Page共用组件）

### Phase 3
- [ ] 今日简报页面显示头条、热门话题、突发预警
- [ ] 各模块数据正确加载
- [ ] 响应式布局适配良好

### Phase 4
- [ ] 阅读模式入口可用
- [ ] 字体/字号/主题可切换
- [ ] 阅读进度条正常显示
- [ ] 关闭阅读模式返回原页面

### Phase 5
- [ ] 搜索自动补全可用
- [ ] 高级语法解析正确
- [ ] 语法帮助Popover可打开
- [ ] 筛选器标签正确显示

---

## SESSION_ID（供 /ccg:execute 使用）

- **CODEX_SESSION**: 019c28da-6c51-7070-a56a-e92f98b6686e
- **GEMINI_SESSION**: eadabec1-14cb-4994-9ddf-9b3c600aa5b2

---

## 后续步骤

用户审查满意后，执行以下命令实施：

```bash
/ccg:execute .claude/plan/frontend-news-display-optimization.md
```
