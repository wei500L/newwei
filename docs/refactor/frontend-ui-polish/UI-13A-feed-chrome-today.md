# FE-UI 批13A：信息流外壳减负（ItemsView / NewsCard / 分析工具栏 / Today 侧栏）

> **一句话目标**：精读 `/today`、`/items`、`/search`、`/rss` 后发现，信息流本身已经干净，但**包在外面的东西太多**：
> 1. **`/search` 出现两张「分析工作台」卡片**：`search-content.tsx:716` 渲染了一张，内嵌的 `ItemsView` 在 `items-view.tsx:2502` 又**无条件**渲染一张。
> 2. **Today 首页底部嵌了一整套检索控制台**：「最新信息流」区块里依次是快捷导航三个按钮、分析工作台卡片、搜索 / 排序 / 去重 / 刷新控制行、6 个数字 Tag，左侧还有 300px 筛选栏。这一块是 Today 首页的主要内容，不应该是一个后台检索页。
> 3. **分析工作台卡片本身太重**：kicker 位置直接显示未翻译的英文 `items` / `search`（`analysis-toolbar.tsx:249`）；没有 `analysis.write` 权限的用户会在每个列表页顶部看到一条蓝色「只读访问」提示（`:278-286`）。
> 4. **feed 视图每条新闻之间有三条线**：antd `List` 默认的分隔线 + `NewsCard` list 布局的 `hairline-b`（`news-card.tsx:631`）+ 卡片底部操作行的 `border-t`（`:531`）。
> 5. **数字进 Tag**：结果统计行 `items-view.tsx:2660-2708` 最多 6 个 Tag（「匹配: 1,234」「显示 1-20 / 共 N」「已翻译 N」…），违反 §3.5-C。
> 6. **Today 右侧「我的摘要」**是约 450px 宽的窄栏，里面却有 8 行配置明细（`user-digest-panel.tsx:378-427`），每条事件最多 10 个 Tag（`:486-526`）。
>
> **依赖**：UI-12 全部合入。可与 UI-13B 并行（文件不相交）。本批只改下面「文件范围」列出的文件，以及 `zh.json` / `en.json`（只追加）。
>
> **开工前必读**：README §3.5、§3.6、§4、§5、§7。行号是审查快照，执行前先用片段定位。分 3 次提交（A1+A2、A3、A4）。

## 文件范围

- `apps/web/components/analysis/analysis-toolbar.tsx`
- `apps/web/app/(app)/items/items-view.tsx`
- `apps/web/app/(app)/items/components/news-card.tsx`
- `apps/web/app/(app)/today/today-content.tsx`
- `apps/web/app/(app)/today/user-digest-panel.tsx`
- `apps/web/app/(app)/today/components/headlines.tsx`
- `apps/web/app/(app)/search/search-content.tsx`（只改 `<ItemsView` 的 props）
- `apps/web/app/(app)/rss/rss-content.tsx`（只改 `<ItemsView` 的 props）

---

## A1 ItemsView 外壳按场景开关

### 1. `items-view.tsx` 新增可选 prop

在 props 接口（约 `:866-879`，`hideQuickNav?: boolean` 旁边）加：

```ts
/** 是否渲染分析工作台工具栏。嵌入到已有工具栏的页面（/search）或首页（/today）时传 false。默认 true。 */
showAnalysisToolbar?: boolean;
```

解构处（约 `:940`）加 `showAnalysisToolbar = true,`，然后把 `:2502` 的 `<AnalysisToolbar … />` 和紧跟的 `AnnotationPanel` 包进 `{showAnalysisToolbar ? (<>…</>) : null}`。

### 2. 调用方

| 文件 | 改法 |
|---|---|
| `search/search-content.tsx:~924` `<ItemsView` | 加 `showAnalysisToolbar={false}`（页面自己在 `:716` 已有一张） |
| `today/today-content.tsx:82` `<ItemsView` | 加 `hideQuickNav`、`showAnalysisToolbar={false}` |
| `rss/rss-content.tsx:737` | 不改（RSS 保留工具栏） |

### 3. Today 的信息流去掉左侧筛选栏

Today 是首页，「最新信息流」只需要一条干净的时间线。在 `items-view.tsx` 的主布局（约 `:2712-2741`）里，`experiencePreset === "reader"` 且 `surface === "none"` 时**不渲染** `<Col flex="300px">` 筛选栏（窄屏的「筛选」按钮也一并隐藏，约 `:2636`）。实现方式：

```ts
const hideFacetRail = surface === "none" && layoutState.isReaderPreset;
```

然后 `{screens.lg && !hideFacetRail && (<Col flex="300px">…)}`、`{!screens.lg && !hideFacetRail && (<Button …>{filterButtonLabel}</Button>)}`。

> 先确认 `surface === "none"` 的调用方只有 Today（`grep -rn 'surface="none"' app`）。如果还有别的页面，在报告里列出，并改用新 prop `hideFacetRail?: boolean` 由 Today 显式传入。

## A2 分析工作台卡片瘦身（`analysis-toolbar.tsx`）

| 位置 | 现状 | 改法 |
|---|---|---|
| `:249` | `<span className="kicker">{surface}</span>`，显示原始英文 `items` / `search` / `events` | 删掉这个 span（标题「分析工作台」已经足够） |
| `:262-271` | 未保存时也显示一段说明文字 `unsavedDescription` | 只在 `savedView` 存在时显示 description；未保存时不显示段落 |
| `:278-286` | 无写权限时渲染 `<Alert type="info" …permissionTitle…>` | 删除 Alert。改为：把 `permissionDescription` 作为「导出 CSV」「保存视图」两个按钮外层 `<Tooltip>` 的 title（仅 `!canWrite` 时），按钮保持 `disabled` |
| 外层 `<div className="content-card p-4">` + `lg:flex-row` | 两栏，左侧标题区较高 | 保持结构不变；左侧标题区改为一行：`<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">`，里面是标题（`text-sm font-semibold`）和已保存时的「组织共享 / 私有」Tag |

> 注意：被 `disabled` 的 antd Button 不会触发 Tooltip，需要在按钮外包一层 `<span className="inline-block">` 再包 Tooltip。

## A3 列表分隔线与统计行（`items-view.tsx`、`news-card.tsx`）

### 1. 三重分隔线 → 一条发丝线

- `items-view.tsx` feed 视图的 `<List itemLayout="vertical" …>`（约 `:2439`）加 `split={false}`；`renderItem` 里的 `<List.Item key={item.id}>` 改为 `<List.Item key={item.id} className="!p-0">`。
- `news-card.tsx:531` 底部操作行：

```tsx
<div className="mt-auto pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between gap-2 flex-wrap">
```

改为按布局区分：`isListLayout` 时**不要** `border-t`，用 `pt-2`；卡片布局保留 `border-t border-[var(--border)]`。

```tsx
<div className={`mt-auto flex flex-wrap items-center justify-between gap-2 ${isListLayout ? "pt-2" : "border-t border-[var(--border)] pt-3"}`}>
```

- `news-card.tsx:603-610` 的「打开」链接按钮：`isListLayout` 时**不渲染**（标题本身就是同一个链接，`handleOpenItem` 埋点已挂在标题 Link 上）。

### 2. 统计行去 Tag（约 `:2660-2708`）

整个 `<div className="flex flex-wrap items-center gap-2">` 改成一行元信息：

```tsx
<div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
  {search ? (
    <Tag closable onClose={() => handleSearch("")} className="m-0 max-w-[320px] truncate font-sans">
      {t("items.stats.query")}: {search}
    </Tag>
  ) : null}
  {filterSummary.text ? (
    <Tooltip title={filterSummary.text}>
      <span className="max-w-[360px] truncate">{t("items.stats.filters")}: {filterSummary.text}</span>
    </Tooltip>
  ) : null}
  <span>{t("items.stats.matches")}: {typeof resolvedTotalCount === "number" ? totalCount.toLocaleString(locale) : t("common.loading")}</span>
  {showingRange ? <span>{t("items.stats.showing", { … 原参数 … })}</span> : null}
  {rssTranslationStats ? <span>{t("pages.rss.translation.translatedCount", { count: rssTranslationStats.translated })}</span> : null}
  {rssTranslationStats ? <span>{t("pages.rss.translation.originalCount", { count: rssTranslationStats.original })}</span> : null}
</div>
```

（搜索词保留可关闭的 Tag，因为它可以点 × 清除；其余都是只读数字。）

### 3. NewsCard 残留的灰色写法（`news-card.tsx`）

`text-gray-500 dark:text-gray-400` / `text-gray-600 dark:text-gray-300` / `text-gray-700 dark:text-gray-300`（`:335`、`:369`、`:377`、`:422`、`:461`、`:491-492`）→ 统一 `text-muted-foreground`（标题级的 `:335` 用 `text-[var(--foreground)]`）。`:335` 的 `border-b pb-2 mb-1` 补 `border-[var(--border)]`。

## A4 Today 页细节

### 1. 「我的摘要」窄栏减负（`user-digest-panel.tsx`）

**配置明细 dl（`:378-427`）** → 只保留一行摘要，明细移到「自定义」弹窗里已有的字段中（弹窗已经能看到这些值，不需要新增）：

```tsx
<p className="m-0 font-mono text-xs text-muted-foreground">
  {digest.preference.windowDays}d · {t("pages.digest.maxEvents")} {digest.preference.maxEvents}
  {generatedAt ? ` · ${formatDateTime(generatedAt, locale, { dateStyle: "medium", timeStyle: "short" })}` : ""}
</p>
```

同时删掉上方只放了一个投递状态 Tag 的 `<div className="flex items-center gap-2">`（`:372-378`）——投递状态改为在这行末尾追加 ` · ${deliveryStatusLabel}`。`delivery.nextRunAt`、时区等明细**不再在首页展示**（仍可在投递弹窗里看到）。

**每条事件的 Tag 墙（`:486-526`）** → 一行标题 + 一行元信息 + 摘要：

```tsx
<List.Item.Meta
  title={<span className="text-sm font-semibold">{title}</span>}
  description={
    <div className="flex flex-col gap-1">
      <p className="m-0 font-mono text-xs text-muted-foreground">
        {[
          `${t("pages.digest.items")} ${event.itemCount}`,
          topic || null,
          entity || null,
          formatDateTime(event.lastAt, locale, { dateStyle: "medium" }),
        ].filter(Boolean).join(" · ")}
      </p>
      {event.summary ? (
        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} className="!mb-0 text-sm">
          {event.summary}
        </Typography.Paragraph>
      ) : null}
    </div>
  }
/>
```

情感（`topicSentiment` / `entitySentiment`）和指标关联（`associations`）两组 Tag **从首页删除**（它们属于事件详情，不属于首页摘要）。删除后不再使用的 `formatSigned`、`percent` 等辅助函数如果变成未使用，一并删除（以 lint 为准）。

`List.Item` 的 `extra`（「查看原文」链接）在窄栏里会把正文挤窄 → 移到元信息行末尾：`url` 存在时在 `<p>` 后面加 `<a href={url} target="_blank" rel="noreferrer" className="text-xs">{t("pages.digest.openSource")}</a>`，删除 `extra`。

### 2. 报头首帧闪英文（`today-content.tsx:20`）

`useState<string>("Today")` → `useState<string>("")`。h1 为空字符串时会塌陷，给 h1 加 `min-h-[1.25em]`。

### 3. 头条次条（`headlines.tsx:170-191`）

- 相对时间单独占一行（`:178-182`）→ 并入上一行：`{itemSource ? `${itemSource} · ` : ""}{itemPublished.primaryText}{itemPublished.relativeText ? ` · ${itemPublished.relativeText}` : ""}`，删掉第二个 `<p>`。
- 右侧 48px 缩略图在**没有图片时**也会渲染一个首字母方块，三条次条都是方块很杂乱 → 只在 `itemThumbnail` 存在时渲染 `<NewsImage …/>`。
- 头条标题是 `<h2>`，但上方 SectionHeader 已经是 h2 → 头条改 `<h3>`（样式类不变）；次条 `<h3>` 改 `<h4>`（样式类不变）。

---

## 禁止事项

- README §4。
- 不改请求、查询变量、分页逻辑、埋点调用（`trackUserNewsBehavior`、`handleOpenItem`）。
- 不改「自定义摘要」「投递设置」两个弹窗的表单字段。

## 测试

- 已有测试必须通过。`items-view` / `news-card` 测试如果按「打开」按钮找元素（`getByRole("button"|"link", { name: 打开 })`），list 布局下改为点击标题链接。
- 新增 1 个用例（放在 `items-view` 已有测试文件或新建 `search-content` 测试）：渲染 `<ItemsView showAnalysisToolbar={false} />` 时页面上**没有**「分析工作台」文字。

## 验证与提交

- `💄 style(web): FE-UI 批13A 信息流外壳按场景开关，搜索页不再出现两张分析工具栏`
- `💄 style(web): FE-UI 批13A 信息流单条发丝线分隔，统计行改为元信息`
- `💄 style(web): FE-UI 批13A Today 摘要侧栏减负与头条细节`

## 人工冒烟清单

| 页面 | 亮/暗 | 375 / 1280 | 看什么 |
|---|---|---|---|
| `/today` | 亮 + 暗 | 两档 | 「最新信息流」只有一条干净的时间线：没有快捷导航、没有分析工作台、没有左侧筛选栏；每条新闻之间只有一条细线 |
| `/today` 右栏「我的摘要」 | 亮 | 1280 | 顶部一行等宽小字摘要；每条事件是标题 + 一行元信息 + 两行摘要，没有 Tag 墙 |
| `/search` 搜索任意词 | 亮 | 1280 | 只有一张「分析工作台」卡片 |
| `/items`（用只读账号） | 亮 | 1280 | 分析工作台没有蓝色「只读访问」提示；悬停被禁用的「导出 / 保存」按钮能看到原因 |
| `/items` 切到卡片视图 | 亮 | 1280 | 卡片底部操作行仍有分隔线，「打开」按钮仍在 |
