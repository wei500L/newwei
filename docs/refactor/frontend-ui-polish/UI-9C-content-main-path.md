# FE-UI 批9C：内容主路径版面纪律（Today / Items / Alerts / Search / Events / Events-archive / Topics）

> **一句话目标**：按 README §3.5 清理用户最常走的内容页面：Today 右栏拥挤、左栏可能整块空白；ItemsView 卡中卡、列数过多；`/events` 一行 11 个彩色 Tag；搜索页常驻两个提示条；events-archive 分类彩虹色和卡中卡。
>
> **依赖**：UI-9A 已合入。可与 9B、9D ~ 9G 并行。本批只改下列目录：`app/(app)/today/`、`items/`、`alerts/`、`search/`、`events/`、`events-archive/`、`topics/`。
>
> **开工前必读**：README §3（**§3.5**）、§4、§5、§7；`style-preview.html` 的 Today 头版与列表页。行号是审查快照，执行前先用片段定位。
>
> **分 3 次提交**：Today、Items/Alerts、其余。

---

## C1 Today（门面，优先）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `today/user-digest-panel.tsx:327-341` | `mb-4` + `<Space>` 里 4 个 small Button，不换行 | 只保留 1 个主操作（「立即生成」或现有的主按钮）；其余收进 `<Dropdown menu={…}><Button size="small" icon={<MoreOutlined/>} aria-label={t("common.more")} /></Dropdown>`；去掉 `mb-4` |
| `today/user-digest-panel.tsx:351-389` | 偏好信息最多 10 个 Tag，含 green/blue | 改成定义列表：`<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt className="text-muted-foreground">…</dt><dd className="m-0 font-mono">…</dd></dl>`；只有「已启用 / 已暂停」这类状态保留 1 个 `<Tag color="success|default">` |
| `today/user-digest-panel.tsx:343-348,421,511` | 裸 `<Spin/>`、`Text type="danger"`、两种 Empty | 改用 `DataStateBoundary`（§3.5-B） |
| `today/user-digest-panel.tsx:462-463` | topic=blue、entity=purple | 不传 color（§3.5-C） |
| `today/components/headlines.tsx:58,86-88`、`hot-topics.tsx:45-47` | `if (!heroItem) return null`，没数据时左栏 7 列整块空白，也没处理 error | 改为渲染区块外壳 + `<ChartEmptyState>`（空态文案 `today.headlines.empty` / `today.hotTopics.empty`）；有 error 时在同位置用 `<ChartEmptyState>` 的错误形态或 `<RequestErrorBanner>`（以组件能拿到的 error 为准，拿不到就只处理空态，并在报告中说明） |
| `headlines.tsx:104-106,150-153`、`hot-topics.tsx:54-57` | `<div onClick={() => router.push(...)}>`（共 3 处） | 改为 `<Link href={...} className="…原 class… block">`；删掉不再使用的 `useRouter` |
| `today-content.tsx:69,79`、`hot-topics.tsx:39`、`headlines.tsx:80`、`today/page.tsx:18-19` | `kicker="MY DIGEST"`、`title="Daily briefing"` 等英文 | 走 `t()`。`page.tsx` 若是服务端组件导出的 `metadata`，保持英文或改成中英 `"每日简报 · Daily briefing"`，在报告中说明 |

## C2 Items（被 Today、RSS、Search 复用）与 Alerts

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `items/items-view.tsx:2476` + `components/faceted-search.tsx:402` + `components/news-card.tsx:514` | 卡片模式下外层 `content-card p-4 md:p-6`，里面的 FacetedSearch 是 `<Card>`，每张 NewsCard 也是 `<Card className="glass-card">`，形成卡中卡 | FacetedSearch 的 Card 改成 `<div className="surface-inset">`；NewsCard 根节点从 `<Card>` 改为 `<article className="hairline-b py-4 last:border-b-0">`（列表模式）。**网格模式**（若有）保留卡片，但外层 ItemsView 必须是 `surface="none"`。在报告中说明 NewsCard 有几种布局，各自怎么处理 |
| `items/items-view.tsx:2330` + `:187` | `grid={{ … md:3, lg:3, xl:4 }}`，旁边还有 300px 侧栏 | 改为 `{ xs:1, sm:1, md:2, lg:2, xl:3, xxl:3 }` |
| `items/items-view.tsx:121` | 行骨架 `style={{ width: 420 }}` | `className="w-full max-w-[420px]"` |
| `items/items-view.tsx:111` | `bg-white/70` | `bg-surface` |
| `items/items-view.tsx:2662-2695` | 查询、筛选、翻译三个 Tag 分别是 geekblue/purple/cyan | 不传 color |
| `items/items-view.tsx:2482-2741` | 6 层 `Space direction="vertical"` 与 Row/Col 混用 | 根节点改 `flex flex-col gap-6`，`Space direction="vertical"` 改 `flex flex-col gap-3`。**只改布局类，不拆文件** |
| reader 预设下 `items-reader-shell` | 给 ItemsView 加了纸色底，但没有边框和内边距，feed 区出现一大块无边界的色底 | 在 `globals.css` 里找 `.items-reader-shell`：**本批不改 globals**，改为在 items-view 中当 `surface="none"` 时不加 `items-reader-shell` 类；若做不到，写进报告 |
| `items/components/news-card.tsx:615` | 每张卡一个 `type="primary"` 按钮 | `type="link"`（§3.5-D） |
| `items/components/news-card.tsx:99,406,425` | `bg-amber-100`、`hover:text-blue-500`、amber 高亮框 | `bg-[var(--secondary)]`、`hover:text-[var(--primary)]`；高亮框改 `border-l-2 border-[var(--accent)] pl-3` |
| `items/components/news-card.tsx:503` | 只有图标的 Info 按钮 | 加 `aria-label` |
| `items/[id]/item-detail.tsx:1843`、`items/[id]/pipeline-recovery-card.tsx:254` | content-card 里套 `<Card size="small">` | 改 `surface-inset` |
| `items/[id]/item-detail.tsx:1246-1290` | blue/orange/purple/gold/orange 的 Tag 排成一行 | 按 §3.5-C 处理 |
| `items/[id]/item-detail.tsx:1045` | `<Typography.Text type="danger">{error.message}` | `<RequestErrorBanner error={error} />` |
| `items/[id]/item-detail.tsx:1259,1276,1314-1333` | `Model:`、`score ${…}` 等英文 | 走 `t()` |
| `items/[id]/item-detail.tsx:1379` | `rounded-xl` | `rounded-lg` |
| `items/[id]/item-detail.tsx:1886` | 数值没有等宽字体 | 加 `font-mono` |
| `alerts/alert-center.tsx:405` | DataStateBoundary 不传 className | UI-9A 已改成默认 `contents`，这里**不用改**。确认 `/alerts` 刷新时间距正常即可 |
| `alerts/alert-event-row.tsx:205` | 数值没有等宽字体 | 加 `font-mono` |
| `alerts/economic-anomaly-evidence.tsx:175`、`alerts/realtime-signal-evidence.tsx:277,312` | `observed`、`score` 等英文 | 走 `t()` |

## C3 Search / Events / Events-archive / Topics

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `search/search-content.tsx:774-851` | 常驻一个 info Alert 和一个 success Alert，里面有 10 种颜色的 Tag | 合并成一个默认折叠的 `<Collapse ghost size="small" items={[{ key:"help", label: t("search.help.title"), children: … }]} />`；里面的 Tag 不传 color |
| `events/events-content.tsx:631-678` | 一行最多 11 个 Tag，用 volcano/cyan/blue/geekblue/purple | 只保留「状态」和「突发」两个带色 Tag（`error`/`warning`/`processing`）；其余改成元信息行 `flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground` |
| `events/[id]/event-detail.tsx:996,1085-1169` | `content-card` 里的 Tabs 中又有 8 个 Card | Tabs 内每块改成 `<section className="flex flex-col gap-3">` + `<SectionHeader>`，块之间用 `hairline-b pb-4` |
| `events/[id]/event-detail.tsx:885-889` 与 `events/event-details-drawer.tsx:759-763` | 两处 Tag 写法逐行相同 | 按 §3.5-C 统一改。抽取共享组件不在本批范围，写进「建议后续」 |
| `events-archive/events-archive-content.tsx:1026` 与 `:1265` | 外层 Card 里套各分类 Card | 外层改为 `<section className="flex flex-col gap-6">`（去掉卡片），每个分类是一张 `content-card` |
| `events-archive/events-archive-display.ts:137-174`、`events-archive-content.tsx:236-241` | 每个分类各配一种 sky/cyan/violet/emerald/fuchsia | 所有分类统一中性：标题 `text-[var(--foreground)]`、kicker 中性色；只有「高危」类用 `--destructive`，「关注」类用 `--accent`。改常量值，不改结构 |
| `events-archive-content.tsx`（18 处 `text-[11px]`，如 :1253,1292,1549） | 手写胶囊 + `text-[11px]` | 标签用 `kicker`；计数加 `font-mono` |
| `events-archive-content.tsx:1067,1102` | 前一天 / 后一天是只有图标的按钮 | 加 `aria-label` |
| `topics/topics-content.tsx:335-339` | 加载时不渲染 PageHeader | PageHeader 移到加载分支之外，始终渲染 |
| `topics/topics-content.tsx:350-385` | 手写筛选栏，`fontSize: 12` | 改用 `<FilterBar>` |
| `topics/topics-content.tsx:477-508` | topic=blue、entity=purple、source=geekblue | 不传 color；类别用前缀文字，如 `#话题`、`@实体` |

---

## 禁止事项

- README §4；只改上面列出的 7 个目录。`globals.css` 不改（归 9A）。
- NewsCard 的点击、收藏、翻译等交互逻辑不改，只改外壳和样式。

## 测试

- 已有 `items-view`、`news-card`、`headlines`、`hot-topics`、`events-content` 等测试必须通过。按旧文案或角色断言的，改为按新结构断言，不要删。
- 新增：`headlines` 无数据时渲染空态文案（断言 `getByText(t 结果)`）。

## 验证与提交

按 README §5 执行：

- `💄 style(web): FE-UI 批9C Today 右栏收敛、空态占位与链接化`
- `💄 style(web): FE-UI 批9C ItemsView 去卡中卡、列数与 Tag 收敛`
- `💄 style(web): FE-UI 批9C 搜索、事件、归档、话题页版面纪律`

## 人工冒烟清单

| 页面 | 亮/暗 | 375 / 1280 | 看什么 |
|---|---|---|---|
| `/today` | 亮 + 暗 | 两档 | 右栏按钮一行放得下；无数据时左栏有空态而不是空白；头条可以 Tab 聚焦 |
| `/items`、`/rss`、`/search` | 亮 | 两档 | 没有卡中卡；1280 时最多 2 列 |
| `/items/<id>` | 亮 + 暗 | 1280 | 阶段卡不嵌套；Tag 不花 |
| `/alerts`，点刷新 | 亮 | 1280 | 间距不塌 |
| `/events`、`/events/<id>` | 亮 | 两档 | 一行最多 2 个彩色 Tag；详情 Tabs 里无卡中卡 |
| `/events-archive` | 亮 + 暗 | 1280 | 分类不再是彩虹色 |
| `/topics` | 亮 | 375 | 筛选栏换行，加载时页头不消失 |
