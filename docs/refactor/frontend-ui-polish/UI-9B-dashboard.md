# FE-UI 批9B：Dashboard 版面纪律（`app/(app)/dashboard/`）

> **一句话目标**：按 README §3.5 清理 dashboard 区域（约 3.5 万行）。重点是：概览页 1/3 窄列里控件溢出、卡中卡、战争地图浮层的整套玻璃风、图表上方的 Tag 墙、子页卡片写法不统一。
>
> **依赖**：UI-9A 已合入。可与 9C ~ 9G 并行，本批只改 `app/(app)/dashboard/**`。
>
> **开工前必读**：README §3（**§3.5**）、§4、§5、§7。行号来自 2026-11-02 审查快照，执行前先用片段定位，找不到就跳过并写进报告。
>
> **规模控制**：本批可能超过 150 行改动，这是允许的，但要**按下面 P1 → P4 的顺序分 4 次提交**。每做完一个 P 就提交一次。做不完时，在报告里写明停在哪个 P 的哪一项。

---

## P1 概览页 1/3 窄列溢出（`/dashboard`）

**背景**：概览中栏已经减掉了左导航和 340px 右栏，`dashboard-content.tsx:669` 和 `spacetime-viz.tsx:1329,1906` 又在里面用了 `xl:grid-cols-3`。每列只剩约 200–280px，但里面有固定高度和固定宽度的控件。

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `dashboard-content.tsx:669`、`spacetime-viz.tsx:1329,1906` | `xl:grid-cols-3` | 改为 `2xl:grid-cols-3`（xl 及以下单列或两列：`lg:grid-cols-2 2xl:grid-cols-3`） |
| `spacetime-viz.tsx:1423,1437,1450,1501` | `glass-card sm-panel-card h-viz-4xl`，内部 `minWidth: 280` | 去掉 `h-viz-4xl` 固定高度（用 `min-h-viz-md`）；`minWidth: 280` 删除，Select 加 `className="w-full"` |
| `charts/knowledge-graph.tsx:409-450` | 工具栏 `display:"flex", gap:"1rem"` 不换行，宽 360 + 160×2 | 改成 `className="flex flex-wrap items-center gap-3"`；输入框改 `w-full sm:w-72`；Slider 外层 `w-full max-w-40` |
| `charts/knowledge-graph-3d.tsx:709` | `<Space size="middle">` 里两个 Slider（140/160） | `<Space wrap size="middle">` |
| `dashboard-content.tsx:690` + `charts/sector-heatmap.tsx:474,487` | Card 是 `h-viz-3xl`，内部图表 `h-viz-md`，上方最多 9 个 Tag | 内部图表改 `h-full min-h-viz-md`；Tag 处理见 P3 |
| `dashboard-content.tsx:280` | `flex items-center gap-2 text-xs`，6 段内容 | 加 `flex-wrap min-w-0` |
| `dashboard-content.tsx:893` | 右栏 `xl:sticky xl:top-0 xl:h-fit`，侧栏比视口高 | 加 `xl:max-h-[calc(100dvh-var(--top-nav-height)-48px)] xl:overflow-y-auto rail-scrollbar` |
| `dashboard-content.tsx:615,624,745,755` | 父级有 `gap-6`，子元素又加 `mb-6` | 删除 `mb-6` |
| `dashboard-editor.tsx:182-204` | `style={{ width: 320 }}` 一类 | `className="w-full sm:w-80"` |

## P2 卡中卡与状态原语（§3.5-A / B）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `dashboard-content.tsx:903` → `analysis-panel.tsx:122,146,170` | 「AI 分析」Card 里又放 3 个 `<Card title>` | analysis-panel 的 3 个 Card 改为 `<section className="flex flex-col gap-3">` + `<SectionHeader title={…} />`，区块之间用 `hairline-b pb-4` 分隔 |
| `dashboard-content.tsx:905,917` | `content-card … border-none shadow-sm` | 删除 `border-none shadow-sm`，恢复发丝线 |
| `economic-short/page.tsx:249-268` | Card 里放 `<CandlestickCard>`（它本身也是 Card） | 给 `candlestick-card.tsx` 新增可选 prop `bare?: boolean`，为 true 时只渲染内容不渲染 Card 外壳；economic-short 传 `bare` |
| `candlestick-card.tsx:53-57` | 标题 `fontSize: 17, fontWeight: 800` | 删除，用 Card 默认标题 |
| `economic-chart-card.tsx:118` | `style={{ marginBottom: 16 }}` | 删除（父级 Row 已有 gutter） |
| `economic-chart-card.tsx:120-158` | Card title 里塞了描述和 Statistic，antd 标题区单行省略会截断 | title 只留标题字符串；描述和 Statistic 移到 body 顶部 `<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">` |
| `economic-chart-card.tsx:101-103,150` | `"vs prev"` 等硬编码英文 | 走 `t()` |
| `military-alert/page.tsx:188,248`、`economic-short/page.tsx:285,300`、`candlestick-card.tsx:86` | 裸 `<Empty description=…/>` | `<ChartEmptyState …/>`（props 参照 dashboard-chart-card.tsx 的用法） |
| `charts/knowledge-graph.tsx:515`、`charts/knowledge-graph-3d.tsx:771` | `<Alert type="error" action={重试}>` | `<RequestErrorBanner error={…} onRetry={…} />` |
| `spacetime-viz.tsx:1667-1680` | 手写 `Text type="danger"` + Button | `<RequestErrorBanner>` |
| `metric-drilldown-utils.ts:195-209` | `shadow-[0_22px_44px…]` + `bg-white/[0.94]` | 改为 `surface-inset`（字符串常量直接替换） |
| `dashboard-content.tsx:672` vs `:690` | 同一行一个用 SectionHeader、一个用 Card title | 都改成 `content-card` + 内部 `SectionHeader`（跟 :672 一致） |

## P3 Tag 墙与按钮主次（§3.5-C / D）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `charts/spacetime-propagation.tsx:619-648` | 9 个 Tag，blue/geekblue/green/gold/cyan/purple/orange | 改成一行元信息：`<div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">`，每项是 `<span>{label}: {value}</span>`；只有告警类保留 `<Tag color="warning">` |
| `spacetime-viz.tsx:1603-1635,1827-1850` | 一行 green/blue/cyan/geekblue/purple | 同上 |
| `charts/sector-heatmap.tsx:474,487` | 最多 9 个 Tag | 同上；放不下时，把次要项收进一个 `<Tooltip>` 包着的「更多」 |
| `charts/financial-candlestick.tsx:500-545` | `absolute left-2 top-2`，最多 9 个 Tag 叠在 K 线图上 | 去掉绝对定位，移到图表上方，作为一行元信息（同上写法） |
| `charts/entity-impact-graph.tsx:1005,1032` | 选中的筛选 chip 全是 `type="primary"` | 改成 antd `Tag.CheckableTag`，或 `Segmented`（单选时） |
| `spacetime-propagation:620-646`、`geo-heatmap:902-908`、`charts/knowledge-graph.tsx:472`、`knowledge-graph-3d.tsx:812`、`dashboard-content.tsx:324,675` | `Range:`、`Aggregation: window graph`、`vs prev`、`kicker="WAR MAP"` 等英文 | 全部走 `t()`（`dashboard.*` 下新增 key） |

## P4 战争地图浮层与其它旧风格（`charts/war-map/**` 等）

war-map 目录里有大圆角 22 处、自定义 shadow 37 处、backdrop-blur 6 处、渐变 4 处、`bg-white/` 31 处，统一按下表替换：

| 旧写法 | 新写法 |
|---|---|
| 面板外壳 `rounded-2xl`/`rounded-[18px]`/`rounded-[22px]` + `shadow-2xl`/`shadow-[…]` + `backdrop-blur-*` + `bg-white/[0.92]` + `dark:bg-slate-950/[0.78]` | `rounded-lg border border-[var(--border)] bg-surface shadow-[var(--shadow-surface)]`（地图浮层需要一点阴影来跟底图区分，这是唯一允许的阴影） |
| 面板内的控件块 | `surface-inset` |
| `bg-gradient-to-b from-white…` 一类 | `bg-surface` |
| 头部按类型用 amber/sky/cyan/emerald 渐变（`war-map-inspector-panel.tsx:41-46`） | 去掉渐变；类型用 `kicker` 文字 + 左侧 3px 色条（`border-l-[3px]`），色条颜色只用 `border-l-[var(--accent)]` / `border-l-[var(--destructive)]` / `border-l-[var(--primary)]` / `border-l-[var(--border-strong)]` 四种字面量 |
| cyan/indigo/sky 选中底色（`war-map-controls-primitives.tsx:25,27,36-42`） | 选中 `bg-[var(--foreground)] text-[var(--background)]`，未选中 `text-muted-foreground hover:bg-[var(--secondary)]` |
| `text-[10px]`/`text-[11px]` 正文 | `text-xs`；纯标签用 `kicker` |

重点文件：`war-map-inspector-shell.tsx:196`、`war-map-controls-primitives.tsx`、`war-map-legend-dock.tsx:37,103`、`war-map-legend-panel.tsx:30`、`war-map-controls-panel.tsx:171,217`、`war-map-view-controls.tsx:146`、`war-map-map-surface.tsx:96`。
**地图 canvas 和 deck.gl 图层的颜色不要动**，只改 DOM 浮层。

其它：

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `charts/entity-impact-graph.tsx:1122,1134,1253` | `rounded-xl … bg-white/95 shadow-xl backdrop-blur`，暗色下发白 | `rounded-lg border border-[var(--border)] bg-surface shadow-[var(--shadow-surface)]`；遮罩 `bg-white/40` 改为 `bg-slate-50/60 dark:bg-slate-950/60`（slate 已重映射为纸墨 hex，透明度修饰符有效；`bg-[var(--background)]/60` 在 Tailwind 3 中无效，不要用） |
| `charts/knowledge-graph-3d.tsx:807-811` | `bg-white/90 … color:"#64748b"` | `bg-surface border border-[var(--border)] text-muted-foreground` |
| `metric-drilldown.tsx:597,711` | `text-blue-600`；DOM 图例 `from-cyan-100 via-sky-300 to-blue-700` | `text-[var(--primary)]`；图例渐变取 `lib/chart-theme-tokens.ts` 的 visualMap 色（若无，就在该文件新增 `CHART_SEQUENTIAL_LIGHT` 常量并引用，用 inline style 的 `linear-gradient`） |
| `metric-drilldown.tsx:702` | 小胶囊里放 `<Spin tip=…/>`（非嵌套用法，tip 不显示） | `<Spin size="small" />` + 一个 `<span>` 文本 |
| `dashboard-content.tsx:768,788` | `color: queueStats ? "#1f2933" : "#94a3b8"` | `className={queueStats ? "text-[var(--foreground)]" : "text-muted-foreground"}` + `font-mono` |
| `components/analysis-stream.tsx:113,128,212,219` | `bg-white/70`、emerald/red 胶囊、装饰渐变 | `bg-surface`；胶囊用 `<Tag color="success|error">`；删除装饰渐变 |
| `components/system-health-summary-card.tsx:185,222,236` | `shadow-[0_8px_20px…]`、`rounded-2xl` | `surface-inset` |
| `spacetime-viz.tsx:1815` | `border-slate-200/60 rounded-md p-3 bg-white/40` | `surface-inset` |

---

## 禁止事项

- README §4；只改 `app/(app)/dashboard/**` 和 `lib/chart-theme-tokens.ts`（仅限新增常量）。
- 不改图表 option 的数据逻辑、轮询、GraphQL。
- P1 的断点调整不得让 1920 宽度下的布局退化：2xl 时仍然是 3 列。

## 测试

- `candlestick-card` 新增 `bare` 后，加一个用例：`bare` 时不渲染卡片标题（`queryByText(title)` 为 null），子内容可见。
- 已有测试按旧英文文案或旧类名断言的，同步更新。

## 验证与提交

按 README §5 执行，每个 P 提交一次：

- `📱 fix(web): FE-UI 批9B 概览窄列不再溢出`
- `💄 style(web): FE-UI 批9B dashboard 去卡中卡并统一状态原语`
- `🎨 style(web): FE-UI 批9B dashboard Tag 墙收敛为元信息行`
- `💄 style(web): FE-UI 批9B 战争地图浮层与图谱浮层去玻璃`

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 / 1440 / 1920 | 看什么 |
|---|---|---|---|
| `/dashboard` | 亮 + 暗 | 三档 | 1280/1440 时没有被挤扁的 1/3 列；AI 分析卡里没有卡中卡；侧栏可滚动 |
| `/dashboard` 战争地图 | 亮 + 暗 | 1440 | 浮层是纸面，无毛玻璃；类型色条 |
| `/dashboard/economic-short`、`/military-alert` | 亮 | 1280 | 空态样式一致；K 线不再嵌套卡片 |
| 图谱 / 3D 图谱 | 暗 | 1280 | 工具栏换行；浮层不发白 |
