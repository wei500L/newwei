# FE-UI 批3C：页头迁移——管理（admin/*）与抓取（crawl/*）

> 先读 [README](README.md) §3、§4，再读 `apps/web/components/page-header.tsx` 和 [UI-3A](UI-3A-header-adoption-content.md) 的「通用迁移规则」。
> 依赖：UI-1、UI-2B 已合入（UI-2B 改过 crawl-frontier 的两个文件）。
> 可与 UI-3A、UI-3B 并行。

## 本批 kicker

全部用 `t("nav.groups.admin")`（「管理」）。

## admin 页头的 4 种现状写法，以及各自的改法

| 写法 | 例子 | 改法 |
|---|---|---|
| A. 裸 `Title level={4}` + 副标题，放在 `Space` 里 | ops、queue-ops、alerts-config、quality、crawl-monitor、crawl-frontier、dashboards | 照通用规则换成 PageHeader |
| B. 页头放在 Card 里（Card 内第一个元素是 Title + Paragraph） | logs、search-telemetry、settings-section | PageHeader 提到 Card 外面；Card 只保留剩下的内容。如果剩下的内容为空，整张 Card 删掉 |
| C. Card 的 `title=` 被当成页头，`extra=` 里放主操作 | orgs、news-sources、crawl-templates、crawl-tasks | PageHeader 的 `title` 用原 Card title，`actions` 用原 Card `extra`；Card 去掉 `title` 和 `extra` |
| D. CSS module 自定义页头 | admin 首页 | 见 T1 |

## 「无权限」和「加载中」状态统一

admin 页面目前有多种「无权限」和「加载中」的写法，本批顺手统一：

```tsx
// 无权限（替换 <Card className="content-card" title={X}><Alert …/></Card>）
<div className="flex flex-col gap-6">
  <PageHeader kicker={t("nav.groups.admin")} title={X} />
  <Alert type="warning" showIcon message={…原 message…} description={…原 description…} />
</div>

// 加载中（替换 <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}><Spin size="large" /></div>）
<div className="flex min-h-[40vh] items-center justify-center"><Spin size="large" /></div>
```

以下文件按此处理：
- `admin/ops/ops-content.tsx:94-110`
- `crawl/crawl-tasks.tsx:~1416-1435`
- `admin/ops/crawl-frontier/crawl-frontier-console.tsx:~1606`

处理其他文件时，遇到同样的结构也照此修改。

## 逐页任务

### T1 · admin 首页（`admin/admin-content.tsx:280-295`，写法 D）

现状：
```tsx
    <div className={styles.adminShell}>
      <div className={styles.headerBlock}>
        <Space direction="vertical" size={2}>
          <Typography.Title level={4} className={styles.pageTitle} style={{ margin: 0 }}>
            {t("adminConsole.title")}
          </Typography.Title>
          <Typography.Text className={styles.pageSubtitle}>{t("adminConsole.subtitle")}</Typography.Text>
        </Space>
        …（headerBlock 里可能还有其他内容，先读完再动）
```

改法：
- 把 `Space`（Title + Text）替换为 `<PageHeader kicker={t("nav.groups.admin")} title={t("adminConsole.title")} description={t("adminConsole.subtitle")} actions={…} />`。
- 如果 `headerBlock` 里在 Space 之后还有其他元素（按钮、统计等）：
  - 能放进 `actions` 的就放进去；
  - 放不进去的，保留在 PageHeader 下方。
- `admin-content.module.css` 里的 `.pageTitle`、`.pageSubtitle` 如果已经没有引用，就删掉。
- `.headerBlock` 如果只剩布局作用，改为 Tailwind 类后删除。
- 这个 module 里还有大量 rgba（约 124 处），**本批不动**，留给 UI-5。

### T2 · 写法 A 的页面（逐个处理）

| 文件:行 | title key | description key | 备注 |
|---|---|---|---|
| `admin/ops/ops-content.tsx:114-121` | `ops.title` | `ops.subtitle` | 同时统一无权限和加载态 |
| `admin/ops/queue-ops/queue-ops-content.tsx:~70` | 读原文件 | 读原文件 | `<Card loading>` 加载态保留 |
| `admin/alerts/alerts-config-content.tsx:~115` | 读原文件 | 读原文件 | |
| `admin/dashboards/dashboards-content.tsx:~103` | 读原文件 | 读原文件 | |
| `admin/quality/quality-content.tsx:~1866` | 读原文件 | 读原文件 | `:1872` 起是一个不换行的工具栏 `<Space>`。如果它和标题处于同一行布局里，就整体放进 `actions` 并给 Space 加 `wrap`；否则只加 `wrap` |
| `admin/ops/crawl-monitor/crawl-monitor-content.tsx:2071-2078` | `crawl.monitor.title` | `crawl.monitor.subtitle` | 下方 `dashboardTitle` Card 的 `extra` 工具栏**不动**（UI-4 处理） |
| `admin/ops/crawl-frontier/crawl-frontier-console.tsx:~1617` | 读原文件 | 读原文件 | 同时统一无权限态 |
| `admin/settings/settings-overview-content.tsx:~51` | 读原文件 | 读原文件 | settings 有自己的侧栏布局（`settings-workspace-layout.tsx`），PageHeader 放在内容区顶部 |

### T3 · 写法 B 的页面（页头在 Card 里）

1. `admin/logs/admin-logs-content.tsx:1067-1076`
   - 现状：`<div className="space-y-6"><Card className="content-card"><Space direction="vertical" size={8}><Title>{t("adminLogs.title")}</Title><Paragraph>{t("adminLogs.description")}</Paragraph></Space>…`
   - 改法：把根 `space-y-6` 改为 `flex flex-col gap-6`；在 Card 之前插入 PageHeader（title `adminLogs.title`，description `adminLogs.description`）。
   - 然后删掉 Card 内的这个 Space。**先读** Card 在 `:1076` 之后还有什么：
     - 只剩空内容 → 删掉整张 Card；
     - 还有筛选器 → 保留 Card。
2. `admin/search-telemetry/search-telemetry-content.tsx:~222`：同样的处理。原 Title 用的是 `marginBottom: 8`。
3. `admin/settings/settings-section-content.tsx:~95-97`：同样的处理。注意这是 `[section]` 动态页，title 是动态的，读清楚变量来源，原样传入。

### T4 · 写法 C 的页面（Card title 当页头）

1. `admin/orgs/orgs-content.tsx:323-330`
   ```tsx
      <Card
        className="content-card"
        title={t("orgAdmin.title")}
        extra={<Button type="primary" onClick={() => setCreateOpen(true)}>{t("orgAdmin.new")}</Button>}
      >
   ```
   改为：
   ```tsx
      <div className="flex flex-col gap-6">
        <PageHeader
          kicker={t("nav.groups.admin")}
          title={t("orgAdmin.title")}
          actions={<Button type="primary" onClick={() => setCreateOpen(true)}>{t("orgAdmin.new")}</Button>}
        />
        <Card className="content-card">
          …原内容…
        </Card>
      </div>
   ```
   原来的 `<>{contextHolder}…</>` 片段：`contextHolder` 保留在最外层。
2. `admin/ops/news-sources/news-sources-content.tsx:~1056-1110`
   - Card title 加上密集的 `extra` 工具栏（约 50 行）。
   - `extra` 里如果是「主操作按钮」（新建、导入），移进 `actions`。
   - 如果是「筛选或搜索控件」，**留在 Card 内**：在 Card body 顶部用 `<FilterBar>`（`@/components/filter-bar`）包起来。
   - 拿不准的，整体放进 `actions` 并在报告里说明。
   - 这个文件在 coverage.include 里，有测试，先读测试再动手。
3. `admin/ops/crawl-templates/crawl-templates-content.tsx:~707`：同 T4.1。
4. `crawl/crawl-tasks.tsx:1441-1444`
   - 现状：`<div className="flex flex-col gap-4"><Card className="content-card" title={t("crawl.title")}>`
   - 改法：根改为 `gap-6`；Card 之前加 `<PageHeader kicker={t("nav.groups.admin")} title={t("crawl.title")} />`；Card 去掉 `title`。
   - Card 如果有 `extra`，按 T4.1 的方式移进 `actions`。

### T5 · 抓取任务详情（`crawl/[taskId]/task-detail-header.tsx:53-…`）

现状：
```tsx
    <Space style={{ marginBottom: 16 }} wrap>
      <Link href="/admin/ops/crawl-tasks">{t("crawl.detail.backToTasks")}</Link>
      <Tag color={statusColors[task.status]}>…</Tag>
      <Tag color={…liveStatus…}>…</Tag>
      …（后面还有重试、回填等按钮，先读完整）
    </Space>
```
详情页没有任何标题。

改为：
```tsx
    <PageHeader
      kicker={t("nav.groups.admin")}
      back={{ href: "/admin/ops/crawl-tasks", label: t("crawl.detail.backToTasks") }}
      title={<span className="line-clamp-2 break-all">{task.displayName || task.targetUrl}</span>}
      meta={<>{/* 原来的两个状态 Tag，原样搬过来，加 className="m-0" */}</>}
      actions={<>{/* 原来的重试、回填等按钮与 Tooltip，原样搬过来 */}</>}
    />
```
- `task.displayName` 和 `task.targetUrl` 都来自 GraphQL `CrawlTask` 查询（`graphql/crawl.graphql:33-34`），可以直接使用。如果 typecheck 提示它们可能为 null，写成 `task.displayName || task.targetUrl || task.id`。
- 去掉 `style={{ marginBottom: 16 }}`，间距由上层容器负责。
- **先确认**上层（`task-detail.tsx`）渲染 `TaskDetailHeader` 时，外层容器有没有 gap。如果没有，就给上层容器加 `flex flex-col gap-6`。
- 这个文件在 FE-批5A 的 characterization 保护网里（coverage.include + 61 例测试），**先读** `crawl/[taskId]/*.test.tsx` 中断言 header 的用例：
  - 断言链接文本、Tag 文本的，迁移后仍然有效；
  - 断言 DOM 结构的（比如 `container.querySelector(".ant-space")`），改成断言用户可见的行为，并在报告里逐条列出。
- `task-detail-link-overview.tsx:59` 的 `Title level={4}` 是**统计数值**，不是标题，误用了标题元素。改为：
  ```tsx
  <span className="font-mono text-xl font-semibold tabular-nums text-[var(--foreground)]">{item.value}</span>
  ```

## 收尾自检（结果贴进报告）

```bash
cd apps/web
grep -rnE 'Title level=\{[34]\}' "app/(app)/admin" "app/(app)/crawl"
grep -rn 'title={t("' "app/(app)/admin" "app/(app)/crawl" | grep '<Card' | head
```
第一条命令的剩余命中只允许是卡片内的区块标题，每条都要说明。

## 禁止事项

- 不要改表格的列、分页、scroll 设置（UI-4 负责）。
- 不要改 Drawer 宽度（UI-4 负责）。
- 不要改 `CreateCrawlTaskDrawer` 及其子模块。
- 不要动 `admin-content.module.css` 里的颜色（UI-5 负责）。

## 自主优化授权

- 在写法 B / C 改造之后，如果某张 Card 只剩一个子元素，而且这个子元素本身就是 Table，可以给 Card 加 `styles={{ body: { padding: 0 } }}`，让表格贴边。
- 加载态 Spin 的行内样式改成 Tailwind 类。

## 测试

- news-sources 和 crawl task detail 的现有测试必须通过；需要调整的断言逐条写进报告。
- 不新增测试。

## 验证与提交

按 README §5 执行。commit 示例：
`💄 style(web): FE-UI 批3C 管理与抓取页统一 PageHeader，收敛无权限/加载态写法`

## 人工冒烟清单

- 依次打开：`/admin` `/admin/orgs` `/admin/logs` `/admin/quality` `/admin/search-telemetry` `/admin/settings` 及任一 section `/admin/ops` `/admin/ops/news-sources` `/admin/ops/crawl-tasks` `/admin/ops/crawl-templates` `/admin/ops/crawl-monitor` `/admin/ops/crawl-frontier` `/admin/ops/queue-ops` `/admin/alerts` `/admin/dashboards` `/crawl/<taskId>`
- 每页都要有眉题「管理」和衬线标题，主操作按钮在标题右侧。
- 用非管理员账号访问 `/admin/ops`：看到的是标题 + 警告条，而不是一张带标题的卡片。
