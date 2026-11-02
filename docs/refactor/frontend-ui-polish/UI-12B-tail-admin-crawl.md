# FE-UI 批12B：`admin/**` 与 `crawl/**` 收尾

> **一句话目标**：按 README **§3.6 收尾换算表**，把本批目录里剩下的「装饰色 Tag」「颜色映射函数」「裸 `<Empty>`」「内联 `style={{ margin… }}`」机械地收尾。这是纯执行批：**规则全部在 §3.6，查表照做，不要自己发挥**。
>
> **本批规模**（快照）：Tag 字面量预设色 **63** 处、颜色映射里的预设色 **131** 处、裸 Empty **8** 处、内联 margin **161** 处。
>
> **依赖**：UI-11 已合入（UI-11 改过本批部分文件的时间格式，先 `git pull`）。可与另外两个 UI-12 批次并行，目录互不相交。本批**只改** `apps/web/app/(app)/admin/**`、`apps/web/app/(app)/crawl/**`。
>
> **开工前必读**：README §3.5、**§3.6**、§4、§5、§7。

---

## 执行顺序

按目录推进：`admin/ops/news-sources/**` → `admin/quality/**` → `crawl/**` → 其余 `admin/**`。**每个文件按下面 4 步做完再换下一个文件**：

1. **Tag 字面量**：`grep -nE 'color="(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' <文件>`，逐个看 Tag 里的文字，按 §3.6-A 换成状态色或删掉 color。
2. **颜色映射**：`grep -nE '(:|\?|return)\s*"(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' <文件>`，找到所属函数 / 常量，**先 grep 它的使用处**，确认只喂给 Tag / Badge 后再按 §3.6-A 改返回值。
3. **裸 Empty**：按 §3.6-C 处理。`ChartEmptyState` 从 `@/components/chart-empty-state` 导入；`Empty` 不再使用就从 antd import 里删掉。
4. **内联 margin**：`grep -nE 'style=\{\{[^}]*margin' <文件>`，按 §3.6-B 换算或删除。

## 分次提交

- 每完成**一个子目录**（或累计约 15 个文件）提交一次，commit message 用：
  - `🎨 style(web): FE-UI 批12B <子目录> Tag 状态色收敛、空态与间距写法统一`
- **总上限**：本窗口最多处理 250 处 margin。超出就停下，在报告里写明停在哪个文件，剩下的留给下一个窗口（下一个窗口从报告列出的位置继续）。

## 文件清单（快照，按总数降序）

路径相对 `apps/web/`；所有 grep 命令都在 `apps/web/` 下执行。数量是快照，行号会漂移，以 grep 结果为准。

| 文件 | Tag 字面量 | 颜色映射 | 裸 Empty | 内联 margin |
|---|---|---|---|---|
| `app/(app)/admin/ops/news-sources/news-sources-modals.tsx` | 14 | 6 |  | 27 |
| `app/(app)/admin/quality/quality-content.tsx` | 3 | 28 |  | 2 |
| `app/(app)/admin/ops/news-sources/news-sources-table.tsx` | 11 | 13 |  |  |
| `app/(app)/admin/ops/news-sources/news-sources.helpers.ts` |  | 22 |  |  |
| `app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx` |  |  | 2 | 20 |
| `app/(app)/crawl/crawl-tasks.tsx` |  | 11 |  | 7 |
| `app/(app)/admin/ops/crawl-monitor/crawl-monitor-content.tsx` | 9 | 5 |  | 3 |
| `app/(app)/admin/logs/admin-logs-content.tsx` | 5 | 4 | 3 | 4 |
| `app/(app)/admin/ops/crawl-frontier/crawl-workflow-studio.tsx` |  |  |  | 11 |
| `app/(app)/crawl/components/MetadataExtractionCard.tsx` | 4 | 4 |  | 3 |
| `app/(app)/crawl/components/Crawl4aiHealthCard.tsx` | 8 |  |  | 3 |
| `app/(app)/admin/ops/news-sources/news-sources-ops-panels.tsx` |  | 6 |  | 3 |
| `app/(app)/crawl/[taskId]/task-detail-header.tsx` |  | 9 |  |  |
| `app/(app)/crawl/[taskId]/task-detail-result-item.tsx` |  | 5 |  | 3 |
| `app/(app)/crawl/[taskId]/task-detail-alerts.tsx` |  |  |  | 8 |
| `app/(app)/admin/orgs/orgs-content.tsx` | 2 | 4 |  |  |
| `app/(app)/admin/ops/news-sources/news-sources-content.tsx` | 1 | 3 |  | 2 |
| `app/(app)/admin/ops/crawl-templates/crawl-templates-content.tsx` |  | 1 |  | 5 |
| `app/(app)/crawl/components/create-crawl-task-drawer/markdown-fields.tsx` |  |  |  | 6 |
| `app/(app)/crawl/[taskId]/task-detail-strategy-card.tsx` | 5 |  |  | 1 |
| `app/(app)/crawl/[taskId]/task-detail-task-logs.tsx` |  | 4 |  | 2 |
| `app/(app)/admin/settings/settings-overview-content.tsx` |  |  | 1 | 4 |
| `app/(app)/admin/alerts/alerts-config-content.tsx` |  | 4 |  |  |
| `app/(app)/crawl/components/create-crawl-task-drawer/dynamic-content-fields.tsx` |  |  |  | 4 |
| `app/(app)/crawl/[taskId]/task-detail-media-section.tsx` |  |  |  | 4 |
| `app/(app)/admin/ops/queue-ops/queue-ops-job-detail-modal.tsx` |  |  |  | 3 |
| `app/(app)/admin/ops/queue-ops/queue-ops-queues-panel.tsx` | 1 | 2 |  |  |
| `app/(app)/crawl/components/CreateCrawlTaskDrawer.tsx` |  |  |  | 3 |
| `app/(app)/crawl/components/create-crawl-task-drawer/session-proxy-fields.tsx` |  |  |  | 3 |
| `app/(app)/crawl/components/create-crawl-task-drawer/browser-identity-fields.tsx` |  |  |  | 3 |
| `app/(app)/crawl/components/create-crawl-task-drawer/optimization-fields.tsx` |  |  |  | 3 |
| `app/(app)/crawl/[taskId]/task-detail-tables-section.tsx` |  |  |  | 3 |
| `app/(app)/admin/settings/settings-workspace-layout.tsx` |  |  |  | 2 |
| `app/(app)/crawl/components/create-crawl-task-drawer/browser-headers-cookies-fields.tsx` |  |  |  | 2 |
| `app/(app)/crawl/components/create-crawl-task-drawer/browser-config-fields.tsx` |  |  |  | 2 |
| `app/(app)/crawl/components/create-crawl-task-drawer/link-preview-fields.tsx` |  |  |  | 2 |
| `app/(app)/crawl/components/create-crawl-task-drawer/virtual-scroll-fields.tsx` |  |  |  | 2 |
| `app/(app)/crawl/components/create-crawl-task-drawer/table-extraction-fields.tsx` |  |  |  | 2 |
| `app/(app)/crawl/[taskId]/task-detail-stored-media-section.tsx` |  |  |  | 2 |
| `app/(app)/crawl/[taskId]/task-detail-expansion-section.tsx` |  |  |  | 2 |
| `app/(app)/admin/admin-content.tsx` |  |  | 1 |  |
| `app/(app)/admin/settings/settings-section-content.tsx` |  |  |  | 1 |
| `app/(app)/admin/ops/ops-content.tsx` |  |  | 1 |  |
| `app/(app)/crawl/components/create-crawl-task-drawer/multi-url-overrides-fields.tsx` |  |  |  | 1 |
| `app/(app)/crawl/components/create-crawl-task-drawer/multi-url-virtual-scroll.tsx` |  |  |  | 1 |
| `app/(app)/crawl/components/create-crawl-task-drawer/scan-strategy-alert.tsx` |  |  |  | 1 |
| `app/(app)/crawl/[taskId]/task-detail-link-overview.tsx` |  |  |  | 1 |

---

## 禁止事项

- README §4；只改本批目录。
- 不改表格 columns 的业务逻辑（只改 render 里 Tag 的 color 和外层样式）；不改 `admin/ops/news-sources/news-sources.helpers.ts` 中颜色映射以外的函数。
- 不改 Tag 的文字、`key`、`onClick`、`closable` 等其它属性；只改 `color`（或整体换成 span）。
- 不因为「顺手」去拆组件、改布局结构；本批只做 §3.6 的四件事。

## 自查（每个子目录做完跑一次）

```bash
D="<子目录>"
grep -rnE 'color="(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' "$D"   # 期望 0
grep -rnE '<Empty\b' "$D" --include='*.tsx' | grep -v emptyText | grep -v notFoundContent             # 期望 0
grep -rnE 'style=\{\{[^}]*margin' "$D" --include='*.tsx'                                              # 只剩 §3.6-B 允许保留的
```

映射函数没改的（因为同时喂给图表 / 地图 / style），在报告中逐个列出：`文件:行 函数名 —— 另外用于哪里`。

## 测试

- 已有测试必须通过。断言了 Tag `color` 或 `ant-tag-<color>` 类名的测试，按新的状态色更新（例如 `ant-tag-green` → `ant-tag-success`）。
- 断言了「暂无数据」文案的测试：ChartEmptyState 显示的仍是同一个 description，`getByText` 不受影响。
- 不新增测试。

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 | 看什么 |
|---|---|---|---|
| `/admin/ops/news-sources` | 亮 + 暗 | ✓ | 来源表格里类型、调度方式是中性 Tag，健康状态是绿 / 琥珀 / 红 |
| `/crawl`、`/crawl/<taskId>` | 亮 | ✓ | 任务状态 Tag 用状态色，配置项 Tag 中性 |
| `/admin/quality`、`/admin/logs` | 亮 | ✓ | 空态统一；段落间距均匀 |
