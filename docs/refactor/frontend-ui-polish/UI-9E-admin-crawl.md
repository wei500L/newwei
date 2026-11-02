# FE-UI 批9E：后台与抓取页版面纪律（`app/(app)/admin/**`、`app/(app)/crawl/**`）

> **一句话目标**：按 README §3.5 清理后台区（约 4.3 万行）：页面根就是 content-card 再套 Card 的「整页大卡」、三到四层卡片嵌套、Modal 和 Drawer 窄屏溢出、一页 5 个主按钮、彩虹 Tag、三种加载写法、crawl-frontier 约 150 处英文硬编码。
>
> **依赖**：UI-9A 已合入。可与 9B ~ 9D、9F、9G 并行。本批只改 `app/(app)/admin/**` 和 `app/(app)/crawl/**`。
>
> **开工前必读**：README §3（**§3.5**）、§4、§5、§7。后台页信息密度高是允许的，**目标是层次清楚，不是变稀疏**。行号是审查快照，执行前先用片段定位。
>
> **分 4 次提交**：E1 → E4。改动量很大，做不完就在报告里写明停在哪里，剩下的留给下一个窗口。

---

## E1 整页大卡与多层嵌套（§3.5-A，最高优先）

通用做法：**页面根 = `flex flex-col gap-6`；一级区块 = 同级 `content-card`；卡片内分组 = `SectionHeader` + `surface-inset` / `hairline-b`**。删除子卡上所有 `marginTop: 24` / `marginBottom: 16`。

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `crawl/[taskId]/task-detail.tsx:207` | 根节点是 `content-card flex flex-col gap-6`，里面放 5 张 Card | 根节点改为 `flex flex-col gap-6`（去掉 content-card），5 张子卡加 `className="content-card"` 成为同级 |
| `crawl/[taskId]/task-detail-multi-url.tsx:24`、`task-detail-link-overview.tsx:25`、`task-detail-task-logs.tsx:116`、`task-detail-results.tsx:68`、`task-detail-strategy-card.tsx:73` | `style={{ marginTop: 24 }}` | 删除 |
| `admin/admin-content.tsx:301` + `admin-content.module.css:92,199` | `content-card` > `.groupSection`（带边框的卡） > `.linkCard`（带边框的卡），三层 | 外层大卡去掉；`.groupSection` 改为无边框，标题下加 `section-rule`；`.linkCard` 保留为唯一一层卡片 |
| `admin/ops/news-sources/news-sources-content.tsx:1074,1146` + `news-sources-ops-panels.tsx:112,217,297` | 一张大 content-card 里放健康卡、3 张 Card 和表格 | 拆成同级 content-card |
| `admin/ops/crawl-monitor/crawl-monitor-content.tsx:2078`（嵌套例：2202、2348、2602、2780） | 整页一张 content-card，包住 Tabs 和 15 张 Card | Tabs 提到卡外，作为页面级（`<Tabs>` 直接放在页面根 gap 里）；每个 Tab 内是同级 content-card；Tab 内再嵌的子卡改 `surface-inset` |
| `admin/ops/crawl-frontier/crawl-frontier-console.tsx:2501→2507→2579`、`1921→1925`、`2191→2194`、`2686→2692` | Card 套 Card 套 Card | 最外层保留，第二层改 `surface-inset`，第三层改 `hairline-b` 分组 |
| `admin/ops/crawl-frontier/crawl-workflow-studio.tsx:889`、`1193→1207`、`1225→1239` | content-card 里四层 Card | 同上 |
| `admin/settings/settings-section-content.tsx:158` | `settings-section-shell scroll-mt-28 rounded-[28px] p-5`，里面又是面板自带的 Card | 圆角改 `rounded-lg`。面板内部的 Card 由 9F 处理，本批只改外壳 |
| `admin/settings/settings-workspace-layout.tsx:33,85,121` | 导航项 `rounded-2xl`；移动端选择卡排在 PageHeader 前面；侧栏标题与 PageHeader 重复 | 导航项改 `rounded`；PageHeader 移到最前；删除重复的侧栏标题 |
| `admin/admin-content.module.css:338-371,390-424` | sky/emerald/amber 色系的 rgba 和 `#075985`，用作分组装饰色 | 换成 token：分组强调统一用 `var(--border-strong)` 或 `var(--primary)` |
| `crawl/components/Crawl4aiHealthCard.tsx:545` | 组件默认带 `marginBottom: 16` | 删除；`crawl-tasks.tsx:1615` 处的手动清零一并删掉 |

## E2 窄屏溢出（§3.5-E）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `admin/ops/news-sources/news-sources-modals.tsx:2048,2541` | `width={screens.md ? 1120 : "100%"}`、`980` | `width="min(1120px, calc(100vw - 32px))"`、`"min(980px, calc(100vw - 32px))"`；若 `screens` 不再使用就一并删除 |
| `crawl-frontier-console.tsx:1770` | Drawer 内 `style={{ flex: 1, minWidth: 360 }}` | `className="min-w-0 flex-1 md:min-w-[360px]"` |
| `crawl/[taskId]/task-detail-results.tsx:71,89` | Card `extra` 里放 `width:260` + `width:140` | 筛选控件移到 body 顶部 `<FilterBar>` |
| `crawl/[taskId]/task-detail-link-overview.tsx:86,111` | `minWidth: 280`；长 URL 不断行 | 删掉 minWidth，用 `grid grid-cols-1 md:grid-cols-2`；URL 加 `break-all` |
| `crawl/components/create-crawl-task-drawer/browser-headers-cookies-fields.tsx:101-128` | Space 不换行，内含 4 个 Input | 改 `<Row gutter={[8,8]}>` + `<Col xs={24} md={6}>` |
| `news-sources-modals.tsx:634,1346,1898`、`crawl-monitor-content.tsx:2207,2244` | `<Col span={8}>` 等，没有 xs | 补 `xs={24} sm={…}` |

## E3 主次与一致性（§3.5-B / C / D）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `crawl/crawl-tasks.tsx:1604,1687,1818,2410`、`crawl/components/MetadataExtractionCard.tsx:315` | 一页 5 个 `type="primary"` | 只保留「新建任务」为 primary，其余 default |
| `admin/ops/queue-ops/queue-ops-queues-panel.tsx:218`、`admin/settings/settings-overview-content.tsx:136` | 每行或每张卡一个 primary | `type="link"` |
| `crawl-frontier-console.tsx:2006-2021`、`admin/ops/crawl-templates/crawl-templates-content.tsx:543-631`、`crawl/crawl-tasks.tsx:922-970` | 同一行 red/green/lime/gold/magenta/geekblue/cyan | 配置类 Tag 全部不传 color，只有状态 Tag 上色 |
| `crawl/crawl-tasks.tsx:1836,2422` | 约 580 行的设置表单排在任务列表之前 | 任务列表上移；设置表单放进 `<Collapse>`，默认折叠，标题 `t("crawl.tasks.settingsSection")` |
| `admin/orgs/orgs-content.tsx:184`、`crawl-monitor-content.tsx:2018`、`crawl/[taskId]/task-detail.tsx:159`、`admin/search-telemetry/search-telemetry-content.tsx:206` | 3 种加载写法（Spin 占 40vh、文本 + `marginTop:3rem`、`Card loading`） | 统一 `DataStateBoundary` |
| `crawl-frontier-console.tsx:1636`、`search-telemetry-content.tsx:261`、`crawl-workflow-studio.tsx:2010` | KPI 有 3 种写法 | 统一为**一张** content-card，内部 `grid grid-cols-2 md:grid-cols-4 gap-4`，每格用 antd `<Statistic>`，格子之间用 `md:border-l md:border-[var(--border)] md:pl-4`（首格不加） |
| `settings-overview-content.tsx:57,105`、`settings-section-content.tsx:163`、`queue-ops/queue-ops-job-detail-modal.tsx:133` | 区块标题手写 `Title level={5}` | `<SectionHeader>` |
| `admin/logs/admin-logs-content.tsx:1094,1327,1502`、`crawl/crawl-tasks.tsx:1486-1570` | 工具栏是 Space wrap + 固定宽度，或靠 `screens.md` 用 JS 判断布局 | `<FilterBar>` |
| `search-telemetry-content.tsx:302`、`crawl-monitor-content.tsx:2818` | 图表空态用 Alert | `<ChartEmptyState>` |
| `admin/quality/quality-content.tsx:1951`、`news-sources-content.tsx:1169` | 「更新于」位置不统一 | 都放进 PageHeader 的 `meta` |
| `crawl-workflow-studio.tsx:2063` | `style={{ background: "#fffdf8" }}`，暗色下是一块白 | `className="bg-surface-muted"` |

## E4 i18n 与可访问性（§3.5-E）

- `crawl-frontier-console.tsx` 全文件约 150 处英文硬编码（`label="Strategy"`、`"No workflow system events…"`、`"Permanent"`、`"OK/FAILED"`…），另有 `crawl-monitor-content.tsx:2209-2254,2380`、`crawl-workflow-studio.tsx:2011`。全部走 `t()`，key 放在 `adminOps.crawlFrontier.*` / `adminOps.crawlMonitor.*` 下。**上限 200 处**，超出就停下，在报告中按文件列出剩余数量。
- 只有图标的删除按钮补 `aria-label={t("common.delete")}`：`crawl/components/create-crawl-task-drawer/browser-headers-cookies-fields.tsx:75,129`、`dynamic-content-fields.tsx:140`、`multi-url-overrides-fields.tsx:44`。

---

## 禁止事项

- README §4；只改 admin、crawl 两个目录。
- 拆分大文件不在本批范围（写进「建议后续」）。
- 不改表格 columns 定义里的业务逻辑；只允许改 render 里 Tag 的 color。

## 测试

已有测试必须通过。Tab 结构调整后，按 role（`tab`、`tabpanel`）断言的测试要同步更新。

## 验证与提交

- `💄 style(web): FE-UI 批9E 后台与抓取页去整页大卡和多层嵌套`
- `📱 fix(web): FE-UI 批9E 后台弹窗、抽屉与栅格窄屏不溢出`
- `💄 style(web): FE-UI 批9E 后台主按钮、Tag、加载态与 KPI 写法统一`
- `🌐 i18n(web): FE-UI 批9E crawl-frontier 与 crawl-monitor 文案国际化`

## 人工冒烟清单

| 页面 | 亮/暗 | 768 / 1280 | 看什么 |
|---|---|---|---|
| `/crawl/<taskId>` | 亮 | 两档 | 同级卡片，间距一致，无双倍空白；长 URL 断行 |
| `/admin` | 亮 + 暗 | 1280 | 只有一层卡片 |
| `/admin/ops/crawl-monitor`、`/admin/ops/crawl-frontier` | 亮 | 两档 | Tabs 在卡片外；不超过两层层次 |
| `/admin/ops/news-sources` 打开大弹窗 | 亮 | 768 | 弹窗不溢出 |
| `/crawl` | 亮 | 1280 | 只有一个主按钮；任务列表在前 |
