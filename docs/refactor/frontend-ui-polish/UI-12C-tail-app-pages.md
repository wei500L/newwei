# FE-UI 批12C：其余页面收尾（态势监控 / dashboard / 事件 / 告警 / 图谱 / 订阅 等）

> **一句话目标**：按 README **§3.6 收尾换算表**，把本批目录里剩下的「装饰色 Tag」「颜色映射函数」「裸 `<Empty>`」「内联 `style={{ margin… }}`」机械地收尾。这是纯执行批：**规则全部在 §3.6，查表照做，不要自己发挥**。
>
> **本批规模**（快照）：Tag 字面量预设色 **136** 处、颜色映射里的预设色 **145** 处、裸 Empty **22** 处、内联 margin **123** 处。
>
> **依赖**：UI-11 已合入（UI-11 改过本批部分文件的时间格式，先 `git pull`）。可与另外两个 UI-12 批次并行，目录互不相交。本批**只改** `apps/web/app/**` 中**除** `app/(app)/admin/**`、`app/(app)/crawl/**` 以外的所有文件。
>
> **开工前必读**：README §3.5、**§3.6**、§4、§5、§7。

---

## 执行顺序

按目录推进：`situation-monitor/**` → `dashboard/**` → `events/**` → `alerts/**` → 其余。**每个文件按下面 4 步做完再换下一个文件**：

1. **Tag 字面量**：`grep -nE 'color="(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' <文件>`，逐个看 Tag 里的文字，按 §3.6-A 换成状态色或删掉 color。
2. **颜色映射**：`grep -nE '(:|\?|return)\s*"(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' <文件>`，找到所属函数 / 常量，**先 grep 它的使用处**，确认只喂给 Tag / Badge 后再按 §3.6-A 改返回值。
3. **裸 Empty**：按 §3.6-C 处理。`ChartEmptyState` 从 `@/components/chart-empty-state` 导入；`Empty` 不再使用就从 antd import 里删掉。
4. **内联 margin**：`grep -nE 'style=\{\{[^}]*margin' <文件>`，按 §3.6-B 换算或删除。

## 分次提交

- 每完成**一个子目录**（或累计约 15 个文件）提交一次，commit message 用：
  - `🎨 style(web): FE-UI 批12C <子目录> Tag 状态色收敛、空态与间距写法统一`
- **总上限**：本窗口最多处理 250 处 margin。超出就停下，在报告里写明停在哪个文件，剩下的留给下一个窗口（下一个窗口从报告列出的位置继续）。

## 文件清单（快照，按总数降序）

路径相对 `apps/web/`；所有 grep 命令都在 `apps/web/` 下执行。数量是快照，行号会漂移，以 grep 结果为准。

| 文件 | Tag 字面量 | 颜色映射 | 裸 Empty | 内联 margin |
|---|---|---|---|---|
| `app/(app)/events/[id]/event-detail.tsx` |  | 4 |  | 15 |
| `app/(app)/knowledge-graph/knowledge-graph-content.tsx` | 10 |  | 3 | 3 |
| `app/(app)/situation-monitor/utils/situation-monitor-format.ts` |  | 14 |  |  |
| `app/(app)/finance/news-indicator-associations.tsx` | 1 | 10 | 1 | 1 |
| `app/(app)/situation-monitor/components/situation-monitor-signals-panels.tsx` | 9 |  |  | 4 |
| `app/(app)/situation-monitor/components/situation-monitor-correlation-panel.tsx` | 11 | 2 |  |  |
| `app/(app)/dashboard/charts/war-map/war-map-ais-reference.tsx` | 8 | 2 |  | 2 |
| `app/(app)/situation-monitor/situation-monitor-monitors-panel.tsx` | 6 | 4 |  | 2 |
| `app/(app)/items/[id]/item-detail.tsx` | 7 | 3 |  | 2 |
| `app/(app)/subscriptions/content-subscriptions-tab.tsx` | 2 | 5 | 3 |  |
| `app/(app)/subscriptions/page.tsx` | 2 | 7 |  | 1 |
| `app/(app)/search/search-content.tsx` | 6 | 3 | 1 |  |
| `app/(app)/alerts/realtime-signal-evidence.tsx` | 4 | 2 |  | 4 |
| `app/(app)/situation-monitor/components/situation-monitor-narrative-panel.tsx` | 9 | 1 |  |  |
| `app/(app)/events/event-details-drawer.tsx` |  |  |  | 10 |
| `app/(app)/dashboard/charts/war-map/war-map-status-model.ts` |  | 9 |  |  |
| `app/(app)/components/notification-center.tsx` |  | 7 |  | 2 |
| `app/(app)/situation-monitor/components/situation-monitor-fed-panel.tsx` | 2 | 4 |  | 3 |
| `app/(app)/topics/topics-content.tsx` |  |  | 3 | 6 |
| `app/(app)/dashboard/spacetime-viz.tsx` | 4 |  | 1 | 3 |
| `app/(app)/newsnow/components/newsnow-search.tsx` |  | 7 |  |  |
| `app/(app)/dashboard/charts/knowledge-graph.tsx` | 5 |  |  | 2 |
| `app/(app)/dashboard/charts/war-map/war-map-transport-controls.tsx` | 1 | 6 |  |  |
| `app/(app)/situation-monitor/components/situation-monitor-live-news-panel.tsx` | 2 | 2 |  | 3 |
| `app/(app)/assistant/assistant-content.tsx` |  |  |  | 6 |
| `app/(app)/alerts/alert-event-row.tsx` |  | 4 |  | 2 |
| `app/(app)/dashboard/charts/knowledge-graph-3d.tsx` | 3 |  |  | 3 |
| `app/(app)/situation-monitor/situation-monitor-content.tsx` | 4 |  |  | 2 |
| `app/(app)/entities/[id]/entity-intelligence-card.tsx` | 1 | 2 | 3 |  |
| `app/(auth)/auth/sso/callback/page.tsx` |  |  |  | 6 |
| `app/(app)/analysis/analysis-workspace.tsx` | 2 | 3 |  |  |
| `app/(app)/knowledge-graph/knowledge-graph-impact-content.tsx` | 2 |  | 1 | 2 |
| `app/(app)/alerts/alert-event-overview-tab.tsx` |  | 4 |  | 1 |
| `app/(app)/alerts/entity-sentiment-evidence.tsx` | 1 | 3 |  | 1 |
| `app/(app)/alerts/economic-anomaly-evidence.tsx` | 1 | 3 |  | 1 |
| `app/(app)/dashboard/charts/war-map/war-map-ais-status.ts` |  | 5 |  |  |
| `app/(app)/situation-monitor/components/situation-monitor-map-panels.tsx` |  | 4 |  | 1 |
| `app/(app)/situation-monitor/components/situation-monitor-feeds-panel.tsx` | 5 |  |  |  |
| `app/global-error.tsx` |  |  |  | 4 |
| `app/(app)/alerts/entity-association-evidence.tsx` | 3 |  |  | 1 |
| `app/(app)/alerts/alert-event-deliveries-tab.tsx` |  | 4 |  |  |
| `app/(app)/dashboard/metric-drilldown.tsx` | 1 | 3 |  |  |
| `app/(app)/dashboard/alert-panel.tsx` |  | 4 |  |  |
| `app/(app)/items/[id]/pipeline-recovery-card.tsx` |  | 3 | 1 |  |
| `app/(app)/events-archive/events-archive-content.tsx` |  |  | 2 | 1 |
| `app/(app)/analysis/analysis-library.tsx` | 1 | 1 | 1 |  |
| `app/(app)/dashboard/analysis-panel.tsx` |  |  |  | 3 |
| `app/(app)/dashboard/charts/spacetime-propagation.tsx` | 2 |  |  | 1 |
| `app/(app)/dashboard/charts/spacetime-geo-heatmap.tsx` | 2 |  |  | 1 |
| `app/(app)/dashboard/charts/war-map/war-map-overlay-types.ts` |  | 3 |  |  |
| `app/(app)/situation-monitor/components/situation-monitor-headlines.tsx` |  |  |  | 3 |
| `app/(app)/situation-monitor/components/situation-monitor-leaders-panel.tsx` | 1 | 2 |  |  |
| `app/(app)/situation-monitor/components/situation-monitor-summary-panels.tsx` | 3 |  |  |  |
| `app/(app)/events/events-content.tsx` | 1 |  | 1 | 1 |
| `app/(app)/today/user-digest-panel.tsx` |  |  |  | 2 |
| `app/(app)/alerts/alert-event-evidence-tab.tsx` | 1 |  |  | 1 |
| `app/(app)/dashboard/charts/entity-impact-graph.tsx` | 2 |  |  |  |
| `app/(app)/dashboard/charts/war-map/war-map-inspector-shell.tsx` |  | 2 |  |  |
| `app/(app)/dashboard/charts/war-map/war-map-transport-inspector.tsx` | 2 |  |  |  |
| `app/(app)/dashboard/components/economic-chart-card.tsx` |  |  |  | 2 |
| `app/(app)/dashboard/components/global-sentiment-trend.tsx` | 1 | 1 |  |  |
| `app/(app)/dashboard/military-alert/page.tsx` |  |  |  | 2 |
| `app/(app)/components/user-ui-settings-sync-indicator.tsx` | 2 |  |  |  |
| `app/(app)/situation-monitor/components/situation-monitor-live-webcams-panel.tsx` |  |  |  | 2 |
| `app/(app)/situation-monitor/components/situation-monitor-markets-panel.tsx` | 1 |  |  | 1 |
| `app/(app)/items/items-view.tsx` | 2 |  |  |  |
| `app/(app)/items/components/financial-card.tsx` |  |  |  | 2 |
| `app/(app)/items/components/faceted-search.tsx` | 1 |  |  | 1 |
| `app/(auth)/invite/[token]/page.tsx` |  |  |  | 2 |
| `app/(app)/rss/rss-content.tsx` |  |  | 1 |  |
| `app/(app)/alerts/alert-event-feedback-tab.tsx` |  | 1 |  |  |
| `app/(app)/alerts/alert-center-filters.tsx` |  |  |  | 1 |
| `app/(app)/alerts/alert-event-list-toolbar.tsx` | 1 |  |  |  |
| `app/(app)/dashboard/dashboard-content.tsx` |  | 1 |  |  |
| `app/(app)/dashboard/economic-short/page.tsx` |  |  |  | 1 |
| `app/(app)/dashboard/charts/widget-renderer.tsx` | 1 |  |  |  |
| `app/(app)/items/components/news-card.tsx` |  |  |  | 1 |
| `app/(reader)/read/items/[id]/page.tsx` |  |  |  | 1 |
| `app/(auth)/register/page.tsx` |  |  |  | 1 |

---

## 禁止事项

- README §4；只改本批目录。
- `dashboard/charts/war-map/war-map-status-model.ts`、`situation-monitor/utils/situation-monitor-format.ts` 这类模型文件里的颜色**很可能同时喂给地图或图表**，按 §3.6-A 第 1 步先查使用处；不确定就不改。不改 react-grid-layout 配置、newsnow store。
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
| `/situation-monitor` | 亮 + 暗 | ✓ | 面板里的来源、地区、主题 Tag 是中性灰，只有状态上色 |
| `/dashboard` 各子页 | 亮 | ✓ | Tag 不再是彩虹色 |
| `/events`、`/alerts`、`/subscriptions`、`/topics` | 亮 | ✓ | 空态统一；严重度 medium 琥珀、high 红 |
| `/map` | 亮 | ✓ | 地图标记颜色**没有变化**（确认没误改喂给地图的映射） |
