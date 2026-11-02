# FE-UI 批9D：态势监控与 NewsNow 版面纪律

> **一句话目标**：按 README §3.5 清理 `/situation-monitor` 和 `/newsnow/*`。具体包括：面板放在可缩放网格里却按视口断点排版；面板正文隐藏滚动条导致内容被裁掉却看不出来；三层嵌套；顶部一个 Space 里塞了约 16 个控件；彩色 Tag 墙；NewsNow 卡头叠着 10 个彩色小胶囊；hover 才出现的操作行；`--text-muted` 未定义；剩余的硬编码文案。
>
> **依赖**：UI-9A 已合入。可与 9B、9C、9E ~ 9G 并行。本批只改 `app/(app)/situation-monitor/**`、`app/(app)/newsnow/**`。
>
> **开工前必读**：README §3（**§3.5**）、§4、§5、§7。行号是审查快照，执行前先用片段定位。分 2 次提交（SM、NewsNow）。

---

## D1 态势监控（`/situation-monitor`）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `situation-monitor-content.tsx:805-1007` | 一个 `Space wrap` 里塞了约 16 个控件和 5 种状态 Tag | 拆成两行：第一行 `<FilterBar>` 放筛选控件；第二行是状态条 `<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">`，「同步状态」和「实时连接」合并为一个指示：一个 `h-2 w-2 rounded-full` 圆点加文字，颜色只用 `bg-[var(--bullish)]`、`bg-[var(--accent)]`、`bg-[var(--destructive)]` 三种字面量 |
| `situation-monitor-content.tsx:1011,1022,1044,1076` | 父级有 gap-6，子级又写 `<div className="mt-3">` | 删除 `mt-3` |
| `components/situation-monitor-feeds-panel.tsx:230,293` | 面板 Card 里套 Card，里面还有 `bg-white/20` 方框，共三层 | cluster 之间用 `hairline-b py-3` 分隔；内层方框改 `surface-inset` |
| `components/situation-monitor-live-webcams-panel.tsx:109,121` | `md:grid-cols-2`、`height: 180` | 面板在可缩放网格里，按视口断点排版不准。改成 `grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3`（按容器宽度自适应）；视频容器 `aspect-video w-full` 替代固定高度 |
| `components/situation-monitor-live-news-panel.tsx:577` | `md:grid-cols-2` | 同上，改 auto-fill |
| `components/situation-monitor-live-news-panel.tsx:271,302,321` | `text-[var(--text-muted)]`：**这个变量没有定义**；还有 `bg-black/20`、`bg-black/30` | `text-muted-foreground`；底色 `bg-surface-muted` |
| `components/situation-monitor-narrative-panel.tsx:349` | `<Col lg={8}>` | 改 `xs={24}`；面板内不要用视口断点切 3 列，确实要多列就用 auto-fill |
| `components/situation-monitor-narrative-panel.tsx:593`、`components/situation-monitor-correlation-panel.tsx:708` | 面板内小节用 `Title level={5}` | 改 `<SectionHeader>`，或 `<p className="kicker m-0">` |
| `components/situation-monitor-summary-panels.tsx:60-80` | 同一行 geekblue/cyan/blue/purple/green 5 个 Tag | 计数改中性：`<span className="font-mono">`；Tag 不传 color |
| `situation-monitor-monitors-panel.tsx:917-990` | 类型、状态、主题、实体、来源、地区分别是 purple/blue/green/geekblue/gold/cyan | 维度用前缀文字区分（`主题·`、`实体·`），一律中性；「状态」按 §3.5-C 用 success/warning/error |
| `situation-monitor-monitors-panel.tsx:843-850` | 裸 Spin / Empty | `DataStateBoundary` 或 `ChartEmptyState` |
| `components/situation-monitor-map-panels.tsx:175,177` | `bg-white/30`；数值只加了 strong | `surface-inset`；数值加 `font-mono` |
| `components/situation-monitor-headlines.tsx:57,129,213` | `<Tag className="cursor-pointer" onClick=…>` | 换成 `<Tag.CheckableTag>`（筛选语义时），或给 Tag 加 `role="button" tabIndex={0} onKeyDown`（Enter/Space 触发同一回调） |
| 面板正文隐藏了滚动条（globals.css:326 一带的 `scrollbar-width: none`） | 内容被裁掉看不出来 | **本批不改 globals**。在面板正文容器上加 `rail-scrollbar` 类（细滚动条），覆盖隐藏规则；如果优先级不够、无法覆盖，写进报告，交给后续批次改 globals |

## D2 NewsNow（`/newsnow/*`）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `components/newsnow-card.tsx:84-105,1153,1206-1282` | 卡头最多 10 个 `text-[10px]` 彩色胶囊（indigo/sky/amber/emerald/violet/rose）+ colorMap 色条 | 胶囊最多保留 2 个：「新 / 实时」用 `text-[var(--accent)] border border-[var(--border)]`，「过期 / 失败」用 `text-[var(--destructive)] border border-[var(--border)]`，其余信息改成一行 `font-mono text-xs text-muted-foreground` 元信息。字号统一 `text-xs`。colorMap 色条保留，但颜色值改为 `bg-slate-400`、`bg-[var(--primary)]`、`bg-[var(--accent)]`、`bg-[var(--destructive)]` 等字面量 |
| `components/newsnow-card.tsx:1192` | 来源名用了 `font-serif` | 去掉（卡片标题用无衬线，§3.1） |
| `components/newsnow-card.tsx:408,1148` | `height: "clamp(380px,56vh,620px)"` 加上 `min-h-[380px]`，内容少时整卡空着 | 改为 `max-height: clamp(380px,56vh,620px)`，去掉 `min-h-[380px]`，让卡片随内容收缩 |
| `components/newsnow-card.tsx:1400` | 列表区 `scrollbar-width:none` | 加 `rail-scrollbar` |
| `components/news-list-hot.tsx:245`、`components/news-list-timeline.tsx:181` | `opacity-0 pointer-events-none group-hover:…`：键盘用户看不到；这行占着高度却不可见，造成空白 | 加 `group-focus-within:opacity-100 group-focus-within:pointer-events-auto`；占位问题改为 `absolute right-2 top-1/2 -translate-y-1/2`，不再占行高（父级加 `relative`） |
| `components/newsnow-hottest-candidates.tsx:153,168,197` | content-card 里叠了三层 `rounded border bg-surface-muted` | 指标格去边框，只留 `rounded bg-surface-muted px-3 py-2` |
| `components/newsnow-hottest-candidates.tsx:79-80` vs `components/newsnow-recommended-feed.tsx:300` | 两处都手写 kicker + h2，一处是无衬线、一处是衬线 | 都换成 `<SectionHeader kicker={…} title={…} />` |
| `components/newsnow-header.tsx:28,315` | content-card 里的 controlShell 又带 border | 去掉内层 border |
| `[column]/page.tsx:311` | `shadow-md hover:brightness-110 active:scale-95` 自定义按钮 | `<Button type="primary">` |
| `[column]/page.tsx:230`、`components/newsnow-recommended-feed.tsx:287,328` | 裸 Spin / Result / Alert / Empty | 按 §3.5-B 改用原语 |
| `components/newsnow-card.tsx:1207-1326`、`[column]/page.tsx:180-360`、`components/newsnow-recommended-feed.tsx:238-318` | 硬编码中文：「同题」「刷新」「实时连接不可用」「原文」等 | 走 `t()`，放 `newsnow.*` 下（UI-8B 可能已建部分 key，先查 zh.json 复用） |

---

## 禁止事项

- README §4；只改两个目录。
- 不改 react-grid-layout 的网格配置和拖拽逻辑；不改 newsnow 的 store 和请求。

## 测试

已有测试必须通过；按旧文案断言的同步更新。为 `news-list-hot` 新增 1 个用例：操作按钮在键盘聚焦后可以被访问（`userEvent.tab()` 之后 `getByRole("button", { name })` 存在且可点击）。

## 验证与提交

- `💄 style(web): FE-UI 批9D 态势监控面板去嵌套、按容器宽度排版与状态条收敛`
- `💄 style(web): FE-UI 批9D NewsNow 卡头胶囊收敛、hover 行可键盘访问与文案国际化`

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 / 1920 | 看什么 |
|---|---|---|---|
| `/situation-monitor` | 亮 + 暗 | 两档 | 顶部两行（筛选 + 状态）；把面板拖窄后，摄像头和新闻栅格自动变成 1 列；面板内能看到细滚动条 |
| `/newsnow/hottest` | 亮 + 暗 | 两档 | 卡头最多 2 个彩色胶囊；内容少的卡片不留大空白；按 Tab 能聚焦到条目操作 |
