# FE-UI 批3B：页头迁移——dashboard · finance · 态势监控 · 地图 · 知识图谱 · 分析

> 先读 [README](README.md) §3、§4，再读 UI-1 产出的 `apps/web/components/page-header.tsx`。
> 「通用迁移规则」与 [UI-3A](UI-3A-header-adoption-content.md) 的同名小节完全相同，开工前先去读那一节。
> 依赖：UI-1、UI-2B 已合入（UI-2B 改过 dashboard/finance 的 layout 和部分卡片）。
> 可与 UI-3A、UI-3C 并行。

## 本批 kicker

本批所有页面的 kicker 都是 `t("nav.groups.situation")`（事件与态势），只有 analysis 和 knowledge-graph 例外，用 `t("nav.groups.research")`（分析与研究）。

## 特别说明：dashboard 和 finance 的子页用 `size="compact"`

这两个区的页面顶部已经有 `DashboardNav` / `FinanceNav` 两条 Tab 导航。为了避免「Tab 条 + 大标题」叠在一起显得笨重，子页的 PageHeader 一律传 `size="compact"`。

## 逐页任务

### T1 · dashboard 7 个子页（统一模式）

涉及文件（基线行号）：
- `dashboard/key-monitor/page.tsx:56-64`
- `dashboard/economic-short/page.tsx:221-228`
- `dashboard/economic-medium/page.tsx:~257`
- `dashboard/economic-alert/page.tsx:~253`
- `dashboard/economic-long/page.tsx:~107`
- `dashboard/livelihood-prices/page.tsx:~196`
- `dashboard/military-alert/page.tsx:~154`

现状（7 个文件结构一致）：
```tsx
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.keyMonitor.title")}</Typography.Title>
        <TimeRangeControls
          loading={loading}
          appliedGranularity={appliedGranularity}
          appliedGranularityRange={appliedGranularityRange}
        />
      </div>
```
改为：
```tsx
    <div className="flex flex-col gap-6">
      <PageHeader
        size="compact"
        kicker={t("nav.groups.situation")}
        title={t("dashboard.keyMonitor.title")}
      />
      <TimeRangeControls
        loading={loading}
        appliedGranularity={appliedGranularity}
        appliedGranularityRange={appliedGranularityRange}
      />
```
说明：
- 每个文件的 title key 不同，照原文件里的写，不要统一成一个。
- `TimeRangeControls` 的 props 每个文件可能不一样，**原样保留**。
- 有的文件在 Title 和 TimeRangeControls 之间还夹着别的元素，那就保持原来的顺序，只把 Title 换成 PageHeader，并把外层 `<div style={{ marginBottom: 16 }}>` 去掉。
- 如果某个文件在根 div 上还有其他 style 属性，先读清楚：只去掉 flex、column、gap 这三项，其余保留。

### T2 · dashboard 概览（`dashboard/dashboard-content.tsx`，目前没有标题）

概览页没有任何标题，第一个元素直接是时间范围面板（`:542`）。
改法：在中间列 `<div className="flex-1 flex flex-col gap-6 min-w-0">`（`:540`；UI-2B 之后位置可能略有变化）的**第一个子节点之前**插入：
```tsx
        <PageHeader
          size="compact"
          kicker={t("nav.groups.situation")}
          title={t("dashboard.tabs.overview")}
          description={t("dashboard.overview.subtitle")}
        />
```
需要新增 i18n key `dashboard.overview.subtitle`：「跨市场、事件与新闻的实时态势总览。」/ "A live overview across markets, events and news."。先 grep 有没有现成可用的 key。

### T3 · finance

1. `finance/market-overview.tsx:65-75`：Title + 副标题 + TimeRangeControls 位于同一个 `flex flex-col gap-2` 中。
   改为：`<PageHeader size="compact" kicker={t("nav.groups.situation")} title={t("finance.market.overviewTitle")} description={t("finance.market.overviewSubtitle")} />`，后面紧跟 `<TimeRangeControls … />`。外层那个 `gap-2` 的 div 删掉，把这两个元素提升为根 `gap-6` 容器的直接子节点。
2. `finance/news-indicator-associations.tsx:~582`：先读一下这个 Title 处在什么位置。它是 `market-content.tsx` 里 Tabs 的一个页签内容，所以属于**页签内区块标题**，不是页面标题。处理方式：换成 `<SectionHeader title={…} />`（`@/components/section-header`），不要用 PageHeader。
3. `finance/market-content.tsx:79-89`：页面里有两层 Tabs，外层是 FinanceNav，内层是 overview/monitor/associations。内层是真实存在的子视图，**保留不改**。只给内层 Tabs 加 `size="small"`，让它在视觉上低一级。
4. `finance/macro`、`finance/livelihood`、`finance/trends`、`finance/key-monitor` 这四个目录：grep 它们的标题实现。如果是 `Title level={4}` 当页头，按 T1 的模式改成 compact PageHeader；如果它们直接复用 dashboard 的子页组件，那 T1 已经覆盖，在报告里注明即可。

### T4 · situation-monitor（`situation-monitor/situation-monitor-content.tsx:797-804`）

现状：Title + 副标题 + 一个 `Space wrap` 工具栏（窗口时长 Select 等），三者在同一个 `flex flex-col gap-3` 中。
改为：
```tsx
      <PageHeader
        kicker={t("nav.groups.situation")}
        title={t("pages.situationMonitor.title")}
        description={t("pages.situationMonitor.subtitle")}
      />
      <Space wrap align="center" style={{ width: "100%" }}>…原工具栏不变…</Space>
```
外层那个 `gap-3` 的 div 去掉，PageHeader 和工具栏都成为根 `gap-6` 容器的直接子节点。如果去掉 div 后间距明显变大，就保留 div，只把其中的 Title 和 Text 替换掉，并在报告里说明你选了哪种做法。

### T5 · map（`map/page.tsx:32-41`）

`map/page.tsx` 是服务端组件，所以需要新建 `map/map-page-header.tsx`（`"use client"` + `useTranslation`），里面渲染 `PageHeader`（kicker 用 situation，title 用 `pages.map.title`，description 用 `pages.map.subtitle`）。然后把 `page.tsx` 中 `:33-41` 的 Title 块替换成 `<MapPageHeader />`。

同时，把根容器 `flex flex-col gap-4 pb-6 sm:gap-6` 改为 `flex flex-col gap-6 pb-6`；`:44` 处 `text-sm text-slate-600 sm:text-base` 改为 `text-sm text-muted-foreground`。

先确认 `page.tsx` 里是否已经有 `"use client"`。如果有，它就是客户端组件，可以直接用 `PageHeader`，不需要新建文件。

### T6 · knowledge-graph

1. `knowledge-graph/knowledge-graph-content.tsx:799-806`：Title + 副标题，右侧还有内容（这一层是 `flex items-start justify-between`）。
   改为 PageHeader：kicker 用 research，title 用 `pages.knowledgeGraph.title`，description 用 `pages.knowledgeGraph.subtitle`。`justify-between` 右侧那一块整体放进 `actions`；如果右侧块超过 30 行，就保留在原位并在报告里说明。
2. `knowledge-graph/knowledge-graph-impact-content.tsx:355-365`：页头放在 Card 里，是 `Title level={4} style={{ marginBottom: 8 }}` + Paragraph。
   改为：根 `Space` 换成 `<div className="flex flex-col gap-6">`（闭合标签同步改）。在 Card 之前插入 `<PageHeader kicker={t("nav.groups.research")} title={t("knowledgeGraph.impact.title")} description={t("knowledgeGraph.impact.description")} />`，然后删掉 Card 里原来的 Title 和 Paragraph。

   **先确认**：impact 是独立路由，还是 knowledge-graph 页面里的一个 tab？
   - 如果是 tab：这两份内容会出现在同一个路由下，第 2 项就改成 `SectionHeader`，避免一个页面出现两个 h1。
   - 两种情况都在报告里写明你的判断依据。

### T7 · analysis

1. `analysis/analysis-workspace.tsx:708-731`：左侧是 Title + 副标题，右侧是 `Space wrap`，里面有看板 Select、Refresh、New board，还有硬编码英文。
   改为：
   ```tsx
      <PageHeader
        kicker={t("nav.groups.research")}
        title={t("analysis.workspace.title")}
        description={t("analysis.workspace.subtitle")}
        actions={
          <>
            <Select className="w-full sm:w-[220px]" … placeholder={t("analysis.workspace.selectBoard")} />
            <Button icon={<ReloadOutlined />} …>{t("common.refresh")}</Button>
            <Button icon={<PlusOutlined />} …>{t("analysis.workspace.newBoard")}</Button>
          </>
        }
      />
   ```
   - 新增 i18n key：`analysis.workspace.selectBoard`（「选择看板」/ "Select board"）、`analysis.workspace.newBoard`（「新建看板」/ "New board"）。先 grep 是否已有可复用的 key。
   - Select 上原来的 `style={{ minWidth: 220 }}` 用 className 替换。
   - 根 `gap-4` 改为 `gap-6`。
2. `analysis/analysis-library.tsx:121-130`：同样的 Title + Text 结构，用 PageHeader 替换（kicker 用 research）。
   **先确认** library 和 workspace 是否会在同一路由下同时渲染（比如作为 tabs）。如果是，library 改用 SectionHeader，避免一个页面出现两个 h1。

## 收尾自检（结果贴进报告）

```bash
cd apps/web
grep -rnE 'Title level=\{[34]\}' "app/(app)/"{dashboard,finance,situation-monitor,map,knowledge-graph,analysis} | grep -v war-map
```
剩下的每一条命中都要说明是什么：只允许出现卡片或页签内的区块标题。

## 禁止事项

- 不要动 `dashboard/charts/war-map/**`。
- 不要改 `TimeRangeControls`、`ChartStateBanner` 的 props 和位置顺序。
- 不要删除 finance 的内层 Tabs。

## 自主优化授权

在本批涉及的页面根容器附近，`style={{ marginBottom: N }}` 一类的纯间距行内样式可以改成 Tailwind 类。

## 测试

现有测试必须通过。不新增测试。

## 验证与提交

按 README §5 执行。commit 示例：
`💄 style(web): FE-UI 批3B 看板/金融/态势/地图/图谱/分析页统一 PageHeader`

## 人工冒烟清单

需要检查的页面：`/dashboard` 及其 7 个子页、`/finance`、`/finance/macro`、`/finance/livelihood`、`/situation-monitor`、`/map`、`/knowledge-graph`、`/analysis`。

逐项看：
- [ ] Tab 条下方是紧凑的衬线标题（compact 尺寸）
- [ ] 页面之间标题的位置和字号一致
- [ ] 在 analysis 页，宽度 375 时看板选择框占满一整行
