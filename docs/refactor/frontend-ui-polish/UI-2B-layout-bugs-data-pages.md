# FE-UI 批2B：布局 bug 修复——dashboard · finance · crawl

> 先读 [README](README.md) §3、§4。
> 依赖：UI-0 已合入。可与 UI-1、UI-2A 并行（文件不相交）。
> 本批修具体布局 bug，**不迁移页头**（页头由 UI-3B/3C 负责），**不处理表格和抽屉**（由 UI-4 负责）。

## 必读文件

- `apps/web/app/(app)/dashboard/components/dashboard-nav.tsx`（全文）
- `apps/web/app/(app)/finance/finance-nav.tsx`（全文）
- `apps/web/app/(app)/dashboard/layout.tsx`、`app/(app)/finance/layout.tsx`
- `apps/web/components/dashboard-chart-card.tsx`、`components/echart.tsx`、`components/chart-skeleton.tsx`、`components/chart-empty-state.tsx`（只读 props 部分）
- `apps/web/app/(app)/dashboard/dashboard-content.tsx`：530–545、725–745、880–916 行
- `apps/web/app/(app)/dashboard/components/analysis-stream.tsx`：130–150 行
- `apps/web/app/(app)/dashboard/economic-short/page.tsx`：215–300 行；`military-alert/page.tsx`：170–250 行
- `apps/web/app/(app)/admin/ops/crawl-frontier/crawl-workflow-studio.tsx`：260–282、1585–1630 行
- `apps/web/app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx`：1655–1670 行

## 任务清单

### T1 · 子页 Tab 高亮错误（P0）

**现状**：`dashboard/components/dashboard-nav.tsx:25-28`
```ts
  const activeItem =
    dashboardRoutes.find(
      (route) => pathname === route.key || pathname.startsWith(`${route.key}/`),
    ) ?? dashboardRoutes[0];
```
`dashboardRoutes[0]` 是 `/dashboard`。所以访问 `/dashboard/key-monitor` 时，`"/dashboard/key-monitor".startsWith("/dashboard/")` 为真，`find` 会先命中「总览」并停在那里。`finance/finance-nav.tsx:23-26` 有同样的问题（`/finance` 排在第一项）。

**改法**：新建纯函数模块 `apps/web/lib/resolve-active-route.ts`：
```ts
/**
 * 子导航 Tab 的激活项解析：精确匹配优先，否则取「最长前缀」匹配。
 * 修复父路由（如 /dashboard）排在前面时吞掉所有子路由的问题。
 */
export function resolveActiveRouteKey(
  pathname: string | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!pathname || keys.length === 0) {
    return keys[0];
  }
  if (keys.includes(pathname)) {
    return pathname;
  }
  let best: string | undefined;
  for (const key of keys) {
    if (pathname.startsWith(`${key}/`) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best ?? keys[0];
}
```
然后改两个 nav 组件：
- `dashboard-nav.tsx`：把 `activeItem` / `activeKey` 两段替换为
  ```ts
  const activeKey =
    resolveActiveRouteKey(pathname, dashboardRoutes.map((route) => route.key)) ??
    dashboardRoutes[0]!.key;
  ```
- `finance-nav.tsx`：同理。

**测试**（必做）：新建 `apps/web/lib/resolve-active-route.test.ts`，覆盖以下用例：
- `("/dashboard", keys)` → `/dashboard`
- `("/dashboard/key-monitor", keys)` → `/dashboard/key-monitor`
- `("/dashboard/key-monitor/sub", keys)` → `/dashboard/key-monitor`
- `("/finance/macro", financeKeys)` → `/finance/macro`
- `(null, keys)` → `keys[0]`
- `("/other", keys)` → `keys[0]`

这个文件是纯函数，不需要渲染。把 `"lib/resolve-active-route.ts"` 加进 `vitest.config.ts` 的 `coverage.include`，前面加注释 `// FE-UI 批2B：子导航激活项解析`。

### T2 · dashboard 和 finance 布局的行内样式

**现状**：`dashboard/layout.tsx:7` 和 `finance/layout.tsx:7` 都是：
```tsx
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
```
而页面内部用的是 `gap-6`（24px），节奏不统一。

**改法**：两处都改为 `<div className="flex flex-col gap-6">`。

### T3 · 图表卡片高度不齐、空态塌陷

**现状 1**：`components/dashboard-chart-card.tsx:66`
```tsx
    <Card title={title} className={className} extra={extra}>
```
空态（`:98-103`）是一个裸的 antd `<Empty>`，没有最小高度。同一行里，有图表的卡片约 320px 高，空态卡片却只有约 120px。

**改法 1**：
```tsx
    <Card
      title={title}
      className={`h-full ${className ?? ""}`.trim()}
      extra={extra}
      styles={{ body: { height: "100%" } }}
    >
```
把空态分支替换为：
```tsx
        <div className="flex min-h-viz-sm items-center justify-center">
          <Empty description={emptyDescription ?? t("dashboard.dataEmpty")} />
        </div>
```
error 分支（`ChartEmptyState`）同样包一层 `<div className="flex min-h-viz-sm items-center justify-center">...</div>`。

如果 antd 版本不支持 `styles` prop（antd ≥5.10 支持），就去掉这一项，只保留 `h-full`。

**现状 2**：`economic-short/page.tsx:262-286`、`military-alert/page.tsx:179-238` 这些页面直接写 `<Card className="content-card">` 加 `DashboardChart` 加裸 `<Empty>`，与 T3 的问题相同。

**改法 2**：**只做最小改动，不要改成 DashboardChartCard**。原因有二：它们的「有数据」判断（例如 heatmap 检查数值是否为有限数）与 DashboardChartCard 内部的 `hasSeries` 语义不同；military-alert 的卡片里还嵌了 List。具体做法：
- 这两个文件里，凡是放在 `<Col xs={24} lg={12}>` 并排两列中的 `<Card ... className="content-card">`，className 都改为 `"content-card h-full"`。
- 这些卡片里的裸 `<Empty description={...} />` 都包一层 `<div className="flex min-h-viz-sm items-center justify-center">...</div>`。
- 其他兄弟页（`economic-medium`、`economic-long`、`economic-alert`、`key-monitor`、`livelihood-prices`）也 grep 一遍 `<Empty description=`。处于并排 Col 中的同样处理；如果用的是 `DashboardChartCard`，T3 改法 1 已经覆盖，不用再动。

**验收**：在 dashboard 子页，同一行左右两张卡片等高；空态居中，不塌陷。

### T4 · 图表加载骨架高度与图表实际高度不一致

**现状**：`components/echart.tsx:13`
```ts
    loading: () => <ChartSkeleton height={360} />,
```
所有图表加载时都显示 360px 的骨架，实际高度却是 320、260 等，加载完成后布局会跳动。

**改法**：Next 的 `dynamic` 的 `loading` 拿不到组件 props，所以改为在外层包一层：
```tsx
const DashboardChartInner = dynamic<EchartProps>(
  () => import("./echart.client").then((mod) => mod.DashboardChart),
  { ssr: false, loading: () => null },
);

export function DashboardChart(props: EchartProps) {
  return (
    <div className="relative" style={{ minHeight: props.height ?? 360 }}>
      <DashboardChartInner {...props} />
    </div>
  );
}
```
这样**不再显示骨架**，但会按目标高度预留空间，彻底消除跳动。如果你希望保留骨架，可以改成用 `useState` 加 `onReady` 回调的方案，但这超出本批范围，要在报告里说明。`ChartSkeleton` 这个 import 改完后如果没被使用，就删掉。

`height` 的类型是 `number | string`，可以直接作为 `minHeight` 的值。

**注意**：`style={{ minHeight: ... }}` 的值是动态的，没法写成 Tailwind 类，这里允许保留行内样式。

### T5 · Dashboard 概览：右栏在 <1280px 时消失、无效类、固定高度

**现状 1**：`dashboard-content.tsx:536` 的根是 `<div className="flex gap-6 h-full items-start">`，右栏在 `:886`：
```tsx
      <div className="w-[340px] 2xl:w-[400px] flex-shrink-0 flex flex-col gap-6 hidden xl:flex sticky top-0 h-fit">
```
屏宽 <1280 时，AI 分析、实时新闻流、告警这些内容**完全不可见**，也没有替代入口。

**改法 1**：
- `:536` 的根改为 `<div className="flex h-full flex-col items-stretch gap-6 xl:flex-row xl:items-start">`
- `:886` 的右栏改为 `<div className="flex w-full flex-col gap-6 xl:sticky xl:top-0 xl:h-fit xl:w-[340px] xl:flex-shrink-0 2xl:w-[400px]">`

效果：窄屏时右栏落到主列下方，全宽显示；≥1280 时恢复原来的侧栏。

**现状 2**：`:889` `<div className="h-[600px]">` 包着 `<AnalysisStream />`。

**改法 2**：改为 `<div className="h-viz-3xl xl:h-[600px]">`。窄屏 500px（`h-viz-3xl`），宽屏保持 600。`h-[600px]` 在 Tailwind 刻度里没有对应值，保留，并在旁边加注释 `{/* 600：侧栏信息流高度，宽屏专用 */}`。

**现状 3**：`:735` `<div className="animate-in fade-in slide-in-from-top-4 duration-300">`。项目没装 tailwindcss-animate，这几个类都不生效。

**改法 3**：改为 `<div>`，直接删掉这几个无效类。

### T6 · analysis-stream 的无效滚动条类

**现状**：`dashboard/components/analysis-stream.tsx:141`
```tsx
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[var(--primary)]/20 scrollbar-track-transparent p-4 space-y-4">
```

**改法**：`<div className="rail-scrollbar flex-1 space-y-4 overflow-y-auto p-4">`

同文件里的 `border-red-200 bg-red-50 text-red-900` 错误框（`:143`）补上暗色：`dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200`。

### T7 · 工作流画布：废弃 API 与固定高度

**现状**：`admin/ops/crawl-frontier/crawl-workflow-studio.tsx:1592-1596`
```tsx
              <Card
                size="small"
                title={t("crawlFrontier.workflowStudio.sections.canvas")}
                bodyStyle={{ padding: 0, height: 720, background: "#f8fafc" }}
              >
```
`bodyStyle` 在 antd 5 中已废弃，而且 720px 的固定高度在笔记本屏上占满整屏还多；`:1618` 的空态也写死了 `height: 720`。`:273-279` 节点样式用 hex：`border: "1px solid #d9d9d9", background: "#fffdf8"`，`borderRadius: 14`。

**改法**：
- Card 改为：
  ```tsx
              <Card
                size="small"
                title={t("crawlFrontier.workflowStudio.sections.canvas")}
                styles={{ body: { padding: 0 } }}
              >
                <div className="h-[min(720px,70dvh)] bg-[var(--surface-muted)]">
                  {definition ? (<ReactFlow ...>…</ReactFlow>) : (<div className="flex h-full items-center justify-center">…</div>)}
                </div>
              </Card>
  ```
  空态 div 上原来的 `style={{ height: 720, display: "flex", ... }}` 改为 `className="flex h-full items-center justify-center"`。
- `<Background color="#dbe4f0" gap={18} />`：`color` 是 SVG 属性，不能用 CSS 变量。在 `lib/graph-tokens.ts` 中新增 `export const WORKFLOW_CANVAS_GRID_COLOR = "#d9d4c9";`，然后引用它。
- 节点样式（`:273-279`）：`borderRadius: 14` 改为 `6`；`border` 改为 `"1px solid var(--border)"`；`background` 改为 `"var(--surface)"`；`boxShadow` 改为 `"var(--shadow-surface)"`。React Flow 节点的 style 是普通 DOM 行内样式，支持 `var()`。

### T8 · crawl-frontier 吸顶统计卡

**现状**：`crawl-frontier-console.tsx:1663`
```tsx
                <Card className="content-card" size="small" style={{ position: "sticky", top: 16, zIndex: 2 }}>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={4}><Statistic ... /></Col>   ×6
```
手机上 6 个统计项各占一行，再加上筛选栏，这张卡片高度超过一屏。由于它是吸顶的，会挡住全部内容。

**改法**：
- `style={{ position: "sticky", top: 16, zIndex: 2 }}` 改为 `className="content-card md:sticky md:top-0 md:z-[2]"`（`<main>` 本身就是滚动容器，`top-0` 即可）。
- 6 个 `<Col xs={24} md={4}>` 改为 `<Col xs={12} sm={8} md={4}>`。

## 禁止事项

- 不要改任何数据、hooks、查询或 Socket 逻辑。
- T3 中**不要**把页面迁移成 DashboardChartCard（原因见 T3 改法 2）。
- 不要动 `war-map` 目录，它刚完成 FE-批4 拆分，风险高。

## 自主优化授权

在本批列出的 dashboard 子页文件里，可以把 `style={{ marginBottom: N }}` / `style={{ marginLeft: 8 }}` 这类纯间距行内样式改为 Tailwind 的 `mb-*` / `ml-2` 等，前提是等价，并在报告里列出。页头附近的结构（`<div style={{ marginBottom: 16 }}><Typography.Title level={4}>`）**不要动**，那是 UI-3B 的工作。

## 测试

- T1：必须新增测试（见上）。
- 其他项是纯样式改动，现有测试通过即可。

## 验证与提交

按 README §5 执行。commit 示例：
`🐛 fix(web): FE-UI 批2B 修复 dashboard/finance 子页 Tab 高亮、图表卡等高与概览右栏窄屏消失`

## 人工冒烟清单

| 页面 | 宽度 | 看什么 |
|---|---|---|
| `/dashboard/key-monitor`、`/finance/macro` | 1280 | Tab 高亮在当前子页，而不是「总览」/「市场」 |
| `/dashboard/economic-short` | 1280 | 两列卡片等高；空数据时居中显示空态 |
| `/dashboard` | 1024 | 实时信息流和 AI 分析出现在主列下方 |
| `/dashboard` | 1920 | 右侧栏与以前一致 |
| `/admin/ops/crawl-frontier` 工作流 | 1366×768 | 画布高度不超过视口的 70%；暗色下画布底色不刺眼 |
| `/admin/ops/crawl-frontier` 运行 | 375 | 统计卡是 2 列，并且不吸顶 |
