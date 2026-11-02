# FE-UI 批3A：页头迁移——内容页（今日与信息流 / 事件 / 个人工作台）

> 先读 [README](README.md) §3、§4，以及 UI-1 产出的 `apps/web/components/page-header.tsx`（需要知道它的 props）。
> 依赖：UI-1 和 UI-2A 都已合入。UI-2A 改过 today、news-hub、welcome、events 中的部分代码，所以本批必须基于它的结果开工。
> 可与 UI-3B、UI-3C 并行，三批的目录互不相交。

## 目标

内容页的页头目前有 8 种写法，本批把它们统一成 `<PageHeader>`。一次只改**页头那一块**，以及**页面根容器的间距**，页面其余部分不动。

## 通用迁移规则（每个页面都按这 6 步做）

1. **定位旧页头**：用下表给出的 `文件:行` 和现状片段找到它。旧页头通常是以下几种之一：
   - `<Space direction="vertical" size={2}><Typography.Title level={4} style={{ margin: 0 }}>…</Typography.Title><Typography.Text type="secondary">…</Typography.Text></Space>`
   - 或者 Card 的 `title=` 属性
   - 或者手写的 `<h1>`
2. **替换为**：
   ```tsx
   <PageHeader
     kicker={t("nav.groups.xxx")}
     title={t("原标题 key")}
     description={t("原副标题 key")}
     meta={/* 原来跟在标题旁边的 Tag、时区、计数，没有就省略 */}
     actions={/* 原来跟在标题旁边的按钮（刷新、新建等），没有就省略 */}
   />
   ```
   import 写成 `import { PageHeader } from "@/components/page-header";`。
3. **kicker 取值**：按页面所属的导航组取（`nav.groups.*` 已存在）：
   - today、news-hub、rss、search、items → `nav.groups.today`（今日与信息流）
   - events、events-archive、topics → `nav.groups.situation`（事件与态势）
   - entities、assistant → `nav.groups.research`（分析与研究）
   - alerts、subscriptions、profile、settings/security → `nav.groups.workspace`（个人工作台）
4. **页面根容器**：统一为 `<div className="flex flex-col gap-6">`。如果根是 `<Space direction="vertical" size="large" style={{ width: "100%" }}>`，替换掉它（子节点不动）。如果根已经是 `flex flex-col gap-4/5`，改成 `gap-6`。
5. **清理**：Typography、Space 等 import 如果改完后没人用了，就删掉；不要留下空的 `<div>`。
6. **不动**：页头之外的所有内容，包括筛选、列表、Tabs、Modal、数据逻辑，都不改。

## 逐页任务

### T1 · alerts（`app/(app)/alerts/alert-center.tsx:401-410`）
现状：
```tsx
      <Space align="center" size="middle" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("alerts.center.title")}
        </Typography.Title>
        {isContentReady ? (
          <Button size="small" onClick={onRetry}>{t("common.refresh")}</Button>
        ) : null}
      </Space>
```
改为：
```tsx
      <PageHeader
        kicker={t("nav.groups.workspace")}
        title={t("alerts.center.title")}
        actions={isContentReady ? <Button onClick={onRetry}>{t("common.refresh")}</Button> : undefined}
      />
```
注意：这个文件在 coverage.include 中，有测试。如果测试用 `getByText("告警中心")` 一类的写法，迁移后仍然能找到；如果用的是 `getByRole("heading", { level: 4 })`，就改成 `level: 1`。

### T2 · topics（`app/(app)/topics/topics-content.tsx:343-352`）
现状是 `<div className="flex flex-col gap-2"><Space direction="vertical" size={2}><Typography.Title level={4} …>{t('pages.topics.title')}…{t('pages.topics.subtitle')}…`。
改为 `PageHeader`：kicker 用 situation，title 用 `pages.topics.title`，description 用 `pages.topics.subtitle`。外层 `content = (<div className="flex flex-col gap-4">` 改成 `gap-6`。

### T3 · search（`app/(app)/search/search-content.tsx:711-719`）
标题和副标题替换为 `PageHeader`：kicker 用 today，title 用 `pages.search.title`，description 用 `pages.search.subtitle`。根 `gap-4` 改为 `gap-6`。
附加任务：`:776-877` 一带可能连续出现 3 个 `<Alert>`（说明、功能标签、最近搜索）。**只读，不合并**。在报告的「建议后续」里记下它们各自的触发条件。合并它们涉及交互，不属于本批范围。

### T4 · subscriptions（`app/(app)/subscriptions/page.tsx:1226-1233`）
`Space` 里的 Title 和 Text 替换为 `PageHeader`：kicker 用 workspace，title 用 `subscriptions.title`，description 用 `subscriptions.subtitle`。根已经是 `gap-6`，不用改。

### T5 · events（`app/(app)/events/events-content.tsx:386-398`）
现状：Title 加 Tooltip 包着的时区 `<Tag>`，下面是副标题。
改为：
```tsx
      <PageHeader
        kicker={t("nav.groups.situation")}
        title={t("pages.events.title")}
        description={t("pages.events.subtitle")}
        meta={
          <Tooltip title={`${timeZone} (${timeZoneLabel || timeZone})`}>
            <Tag className="m-0">{timeZoneLabel || timeZone}</Tag>
          </Tooltip>
        }
      />
```
根 `flex flex-col gap-4`（`:385`）改为 `gap-6`。

### T6 · 事件详情（`app/(app)/events/[id]/event-detail.tsx:860-874`）
现状：返回按钮（`router.push("/events")`）加 Title 加时区 Tag，放在同一个 `Space` 里；下一行（`:876` 起）是状态 Tag。
改为：
```tsx
        <PageHeader
          kicker={t("nav.groups.situation")}
          back={{ href: "/events", label: t("common.back") }}
          title={<span className="line-clamp-2">{title}</span>}
          meta={
            <Tooltip title={`${timeZone} (${timeZoneLabel || timeZone})`}>
              <Tag className="m-0">{timeZoneLabel || timeZone}</Tag>
            </Tooltip>
          }
        />
```
`:876` 起的状态 Tag 那个 `Space` 保留在 PageHeader 下方，不动。删掉 `ArrowLeftOutlined` 的 import；`router` 如果在别处还有用，就保留。

**注意**：`event-details-drawer.tsx` 里有一份同构的内容，它是抽屉，**不要**给它加 PageHeader。

### T7 · events-archive（`app/(app)/events-archive/events-archive-content.tsx:1009-1037`）
现状：自制的 hero `<section className="relative overflow-hidden rounded-[28px] … shadow-[…]">`，里面有两层径向渐变，左侧是 Title 和副标题，右侧是 3 个胶囊（区域、日期、搜索词）。
改为：删掉整个 `<section>`（包括渐变 div），替换为：
```tsx
      <PageHeader
        kicker={t("nav.groups.situation")}
        title={t("pages.eventsArchive.title")}
        description={t("pages.eventsArchive.subtitle")}
        meta={
          <>
            <Tag className="m-0">{currentRegionLabel}</Tag>
            <Tag className="m-0 font-mono">{archiveDateDisplay}</Tag>
            {currentSearch ? (
              <Tag className="m-0 max-w-[16rem] truncate" icon={<SearchOutlined />}>{currentSearch}</Tag>
            ) : null}
          </>
        }
      />
```
根 `gap-5` 改为 `gap-6`。如果 `SearchOutlined` 在别处还有用就保留 import。

### T8 · rss（`app/(app)/rss/rss-content.tsx:476-490`）
现状：页头放在第一个 Card 里面，是 Title level 3 加副标题加 `<br/>` 加一行提示。
改为：
- 根 `<Space direction="vertical" size="large" style={{ width: "100%" }}>` 改为 `<div className="flex flex-col gap-6">`，**闭合标签要对应改成 `</div>`**。
- 在第一个 Card **之前**插入：
  ```tsx
      <PageHeader
        kicker={t("nav.groups.today")}
        title={t("pages.rss.title")}
        description={<>{t("pages.rss.subtitle")} {t("pages.rss.readerHint")}</>}
      />
  ```
- 删掉 Card 内部原来的 `<div>`（Title + Text + `<br/>` + Text）。如果 Card 内的 `Space` 因此第一个子节点变成了 `{error ? …}`，属于正常现象。
- `:605-621` 一带还有四行提示文字。**本批不动**，在报告里记录。

### T9 · items（`app/(app)/items/page.tsx`，目前没有标题）
现状：`return <ItemsView />;`
改为：
```tsx
  return (
    <div className="flex flex-col gap-6">
      <ItemsPageHeader />
      <ItemsView />
    </div>
  );
```
`page.tsx` 是服务端组件，所以要新建 `app/(app)/items/items-page-header.tsx`（`"use client"`），里面用 `useTranslation`，渲染 `<PageHeader kicker={t("nav.groups.today")} title={t("nav.items")} description={t("pages.items.subtitle")} />`。
- 先 grep zh.json 中的 `nav.items`、`pages.items` 等 key，确认标题能用哪个（审查时看到 `nav.items` 存在）。如果没有 subtitle，就新增 `pages.items.subtitle`：「全部已入库内容，可按来源、时间与情感筛选。」/ "Everything ingested, filterable by source, time and sentiment."

### T10 · news-hub（`app/(app)/news-hub/page.tsx:37-44`）
现状：暗色渐变 header（`bg-[linear-gradient(120deg,rgba(15,23,42,0.92)…)] text-zinc-100`），文案「News Hub」和中文说明都是硬编码。
改为：用 `PageHeader` 替换整个 `<header>`。文案走 i18n，新增两个 key：
- `pages.newsHub.title`：「新闻中枢」/ "News Hub"
- `pages.newsHub.subtitle`：「统一入口：先看热榜，再进深读，最后回到事件脉络校验。」/ "One entry point: scan what's trending, read in depth, then verify against the event timeline."

`page.tsx` 是服务端组件。参照 T9，新建 `news-hub-page-header.tsx`（client）来渲染。同时检查 `pillars` 数组（`:10-30`）里有没有硬编码文案：有就在报告里记录，**本批不改**。

### T11 · entities/[id]（`app/(app)/entities/[id]/entity-intelligence-card.tsx:236-256`）
现状：返回链接（指向 `/knowledge-graph`）、Title level 3（实体名）、类型 Tag、生成时间。
改为：
```tsx
        <PageHeader
          kicker={t("nav.groups.research")}
          back={{ href: "/knowledge-graph", label: t("nav.main.knowledgeGraph") }}
          title={card.entity.name}
          meta={
            <>
              <Tag color="blue" className="m-0">{/* 原 Tag 内容不变 */}</Tag>
              <span className="font-mono">{t("entities.intelligence.generatedAt")} {dayjs(card.generatedAt).format("YYYY-MM-DD HH:mm")}</span>
            </>
          }
          actions={/* 原来与左侧并排的右侧区块（:236 这一层 flex 的第二个子节点），整体搬进来；如果太大（>30 行），就保留在原位并在报告说明 */}
        />
```

### T12 · profile、settings/security（Card title 当页头）
- `app/(app)/profile/profile-content.tsx:354`：`<Card className="content-card" title={t("profile.title")}>` 后面紧跟 `<Typography.Paragraph type="secondary">{t("profile.description")}`。
  改为：最外层包 `<div className="flex flex-col gap-6">`，先放 `<PageHeader kicker={t("nav.groups.workspace")} title={t("profile.title")} description={t("profile.description")} />`，再放去掉 `title` 的 Card，并删掉 Card 里的那段 Paragraph。`{contextHolder}` 移到外层 div 的第一个子节点。
  `:341-345` 的加载态是 `<Spin>` 加行内 flex，改为 `<div className="flex min-h-[40vh] items-center justify-center"><Spin /></div>`。
- `app/(app)/settings/security/page.tsx:61-64`：`title="Security settings"` 和 `Manage your authenticator app and recovery codes.` 是硬编码英文。
  新增 i18n key：`settings.security.title`（「账号安全」/ "Account security"）、`settings.security.description`（「管理身份验证器与恢复码。」/ "Manage your authenticator app and recovery codes."）。先 grep 有没有现成 key 可以复用。结构改法同 profile。加载态 `:46-48` 的处理也同 profile。

### T13 · assistant（`app/(app)/assistant/assistant-content.tsx:1104-1111`）
assistant 有自己的全宽 frame 和 hero 设计，**不替换成 PageHeader**，只统一视觉：
- `<p className={styles.heroKicker}>` 改为 `<p className="kicker m-0">`。`styles.heroKicker` 在 `assistant-content.module.css` 中的定义如果没有其他引用，就删掉。
- `<h1 className="text-3xl font-black tracking-tight text-slate-900 sm:text-4xl dark:text-slate-100">` 改为 `<h1 className="m-0 font-serif text-2xl font-semibold leading-tight tracking-tight text-[var(--foreground)] md:text-[28px]">`
- 副标题 `text-sm font-medium text-slate-600 sm:text-[15px] dark:text-slate-300` 改为 `m-0 max-w-measure text-sm text-muted-foreground`
- header 的 `border-white/70 … dark:border-white/10` 改为 `border-[var(--border)]`

### T14 · today（`app/(app)/today/today-content.tsx:32-41`）
Today 的头版设计在 UI-6 完成。本批只把现有的 `Typography.Title level={3}` 加副标题替换为：
```tsx
      <PageHeader
        kicker={t("nav.groups.today")}
        title={<span suppressHydrationWarning>{todayLabel}</span>}
        description={t("pages.today.subtitle")}
      />
```

## 收尾自检（必做，结果贴进报告）

```bash
cd apps/web
grep -rnE 'Title level=\{[34]\}' "app/(app)/"{alerts,topics,search,subscriptions,events,events-archive,rss,items,news-hub,entities,profile,settings,today}
grep -rn 'PageHeader' "app/(app)" | wc -l
```
第一条命令**允许**的剩余命中：卡片或抽屉内部的区块标题，每条都要在报告里说明它是什么。不允许出现页面级标题。

## 禁止事项

- 不要改 `event-details-drawer.tsx` 的结构。
- 不要合并 search 页的 Alert，也不要改 rss 的提示文字区（只记录）。
- 不要改 `items-view.tsx`。

## 自主优化授权

页头里原来那些标题旁的按钮，统一去掉 `size="small"`，让 actions 区按钮高度一致（34px）。其他视觉调整留给后续批次。

## 测试

- 现有测试（alerts 等）必须通过。断言 heading level 的地方改成 1。
- 不需要新增测试，PageHeader 本身已在 UI-1 测过。

## 验证与提交

按 README §5 执行。commit 示例：
`💄 style(web): FE-UI 批3A 内容页统一 PageHeader（alerts/events/topics/search/rss/items 等 14 页）`

## 人工冒烟清单

逐页打开：`/today` `/items` `/news-hub` `/rss` `/search` `/events` `/events/<id>` `/events-archive` `/topics` `/entities/<id>` `/alerts` `/subscriptions` `/profile` `/settings/security` `/assistant`

每页检查：
- 眉题小字、衬线大标题、灰色说明文字的样式和位置都一致；
- 375 宽时操作按钮换到标题下方；
- 暗色下标题是暖白色。
