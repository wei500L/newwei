# FE-UI 批4：表格 · 抽屉 · 工具栏的响应式修复

> 开工前先读 [README](README.md) §3、§4，以及 `apps/web/components/filter-bar.tsx`（UI-1 产出）。
> 依赖：UI-3A、UI-3B、UI-3C **全部合入**之后才能开始。本批会改到它们动过的大量文件，先后顺序反了会冲突。
> 本批是**机械但量大**的修改，每一项都按固定模式来，不要自由发挥。

## 背景

全站约 77 个 antd `<Table>`，其中 67 个没有设置 `scroll`。另有 16 个 `<Drawer>` 写死了 480–1320px 的宽度。窄屏下的结果是：表格把页面撑出横向滚动条，抽屉超出屏幕且关不掉。另外有几处工具栏不换行。

## 模式 P1 · 表格横向滚动

**规则**：
- Table 的列数（`columns` 数组长度）**≥ 4**，或者某一列设置了 `width` / `fixed`：加 `scroll={{ x: "max-content" }}`。
- 已经有 `scroll={{ y: N }}` 的：合并成 `scroll={{ x: "max-content", y: N }}`。
- 列数 ≤ 3，并且所有列都是短文本：**不加**。在报告里写「跳过：N 列」。
- `columns` 是变量时，跳到定义处数一下长度；数不清（比如动态生成的），就直接加。

**不要改**：`pagination`、`size`、`rowKey`、`columns` 的内容、`dataSource`、`loading`。分页大小可能和服务端查询变量绑定，所以**不统一 pageSize**。

**清单**（基线行号，可能有漂移，按 `<Table` 搜索定位）：

| 文件 | 行 |
|---|---|
| `app/(app)/admin/quality/quality-content.tsx` | 2142, 2156, 2246, 2262, 2312, 2502, 2525, 2540, 2693, 2783, 2807, 2833 |
| `app/(app)/admin/search-telemetry/search-telemetry-content.tsx` | 322, 337, 352, 378 |
| `app/(app)/admin/orgs/orgs-content.tsx` | 400 |
| `app/(app)/admin/logs/admin-logs-content.tsx` | 1246, 1447 |
| `app/(app)/admin/ops/news-sources/news-sources-modals.tsx` | 2234, 2742 |
| `app/(app)/admin/ops/crawl-monitor/crawl-monitor-content.tsx` | 2604, 2729, 2751, 2783 |
| `app/(app)/admin/ops/crawl-templates/crawl-templates-content.tsx` | 728 |
| `app/(app)/admin/ops/crawl-frontier/crawl-workflow-studio.tsx` | 2114 |
| `app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx` | 1643, 1694, 1944, 2203, 2278 |
| `app/(app)/crawl/components/MetadataExtractionCard.tsx` | 379 |
| `app/(app)/crawl/[taskId]/task-detail-task-logs.tsx` | 136 |
| `app/(app)/finance/news-indicator-associations.tsx` | 752 |
| `app/(app)/situation-monitor/components/situation-monitor-correlation-panel.tsx` | 692, 710, 728, 746 |
| `app/(app)/situation-monitor/components/situation-monitor-markets-panel.tsx` | 62, 100, 183 |
| `app/(app)/situation-monitor/components/situation-monitor-narrative-panel.tsx` | 596, 609, 622, 635, 690 |
| `app/(app)/situation-monitor/components/situation-monitor-fed-panel.tsx` | 67 |
| `app/(app)/situation-monitor/components/situation-monitor-leaders-panel.tsx` | 42 |
| `components/settings/llm-request-logs-panel.tsx` | 2440, 2459 |
| `components/settings/news-source-runtime-secrets-panel.tsx` | 1111 |
| `components/settings/assistant-safety-settings-panel.tsx` | 754, 1016 |
| `components/settings/rate-limit-policies-panel.tsx` | 330 |
| `components/settings/news-dedupe-settings-panel.tsx` | 677 |
| `components/settings/access-settings-content.tsx` | 1791, 2117, 2179, 2209 |
| `components/settings/akshare-gateway-settings-panel.tsx` | 864 |
| `components/settings/knowledge-graph-review-panel.tsx` | 410, 517 |
| `components/settings/realtime-signals/realtime-signals-opensky-budget.tsx` | 224 |
| `components/settings/llm-gateway/llm-gateway-profiles-panel.tsx` | 273 |
| `components/settings/llm-gateway/llm-gateway-proxy-lb-test-result.tsx` | 71, 106 |

**situation-monitor 的特殊情况**：这些面板放在 react-grid-layout 的格子里，格子高度是固定的。`narrative-panel.tsx:596-635` 在一个格子里连着放了 4 个 Table。本批**只加 `x` 滚动**，不改纵向布局。

**验收**：
```bash
cd apps/web && python3 -I - <<'PY'
import re,glob
for f in glob.glob('app/**/*.tsx',recursive=True)+glob.glob('components/**/*.tsx',recursive=True):
    if '.test.' in f or 'war-map' in f: continue
    L=open(f).read().split('\n')
    for i,l in enumerate(L):
        if re.search(r'<Table\b',l):
            seg='\n'.join(L[i:i+40]); e=seg.find('/>'); seg=seg if e<0 else seg[:e+2]
            if 'scroll=' not in seg: print(f"{f}:{i+1}")
PY
```
命令输出中剩下的每一条，都要在报告里写明跳过的原因。

## 模式 P2 · 抽屉宽度自适应

**规则**：把 `width={N}` 改为 `width="min(Npx, 100vw)"`，N 保持原值作为上限。antd 5.28 / rc-drawer 7.3 的 `width` 类型是 `number | string`，字符串会直接写进 CSS（已核实）。

如果 width 是三元表达式，比如 `width={screens.md ? 720 : "100%"}`，**保留不动**，它已经处理了窄屏。

**清单**：

| 文件:行 | 原宽度 |
|---|---|
| `app/(app)/analysis/analysis-workspace.tsx:916` | 720 |
| `app/(app)/admin/logs/admin-logs-content.tsx:1596` | 720 |
| `app/(app)/admin/ops/crawl-frontier/crawl-workflow-studio.tsx:2235` | 720 |
| `app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx:1702` | 1120 |
| `app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx:1966` | 1320 |
| `app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx:2375` | 760 |
| `app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx:2597` | 980 |
| `app/(app)/dashboard/spacetime-viz.tsx:1938` | 560 |
| `app/(app)/dashboard/charts/spacetime-propagation.tsx:690` | 520 |
| `app/(app)/dashboard/charts/spacetime-geo-heatmap.tsx:1009` | 520 |
| `app/(app)/crawl/components/CreateCrawlTaskDrawer.tsx:68` | 600 ⚠️ |
| `app/(app)/finance/news-indicator-associations.tsx:763` | 860 |
| `app/(app)/events/event-details-drawer.tsx:1427` | 900 |
| `app/(app)/events/[id]/event-detail.tsx:1759` | 900 |
| `components/settings/access-settings-content.tsx:1890` | 480 |
| `components/settings/access-settings-content.tsx:2011` | 520 |

⚠️ `CreateCrawlTaskDrawer.tsx` 有 68 例 characterization 测试。改之前先 grep 它的测试有没有断言 `width`：有就跳过这一项，并在报告里说明。

同时 grep `<Modal` 中 `width={N}` 且 N ≥ 720 的地方，按同样方式改成 `width="min(Npx, calc(100vw - 32px))"`。Modal 需要留出边距，所以这里减 32px。改了哪些都列进报告。

## 模式 P3 · 工具栏换行

### P3.1 `subscriptions/content-subscriptions-tab.tsx:~754-768` 与 `:~921-970`
**现状**：Card 的 `extra` 里放了 `<Space>`，没有 `wrap`；里面有一个 260px 的搜索框和若干按钮，另一处还多一个 140px 的 Select。
**改法**：
- 两个 `Space` 都加上 `wrap`。
- 搜索框的 `style={{ width: 260 }}` 改为 `className="w-full sm:w-[260px]"`。
- Select 的 `style={{ width: 140 }}` 改为 `className="w-full sm:w-[140px]"`。
- **如果** Card 的 extra 在窄屏下仍然把标题挤成一个字一行：把这个工具栏从 `extra` 移到 Card body 顶部，用 `<FilterBar>` 包起来（`actions` 放按钮），然后在报告里说明。

### P3.2 `admin/ops/crawl-monitor/crawl-monitor-content.tsx:~2086`（dashboardTitle Card 的 extra）
**现状**：`extra={<Space>…6+ 个按钮 + Segmented + Tag…</Space>}`，没有 `wrap`。
**改法**：把这一组控件从 `extra` 移到 Card body 的第一行：
```tsx
<FilterBar actions={/* 刷新、清空等按钮 */}>
  {/* Segmented 与 Tag */}
</FilterBar>
```
Card 的 `extra` 删掉。

### P3.3 `admin/ops/crawl-frontier/crawl-frontier-console.tsx:~1667-1683`（运行筛选）
**现状**：`<Space wrap>` 里有一个 `Input.Search style={{ width: 280 }}` 和 6 个 `Select style={{ width: 220/160/180 }}`，全部写在同一行。
**改法**：外层 `<Space wrap style={{ display: "flex", marginTop: 16, alignItems: "flex-end" }}>` 换成 `<FilterBar className="mt-4">`。每个控件包进 `<FilterBar.Item width="…">`，宽度对应关系：
- 280 → `lg`
- 220 → `lg`
- 180 → `md`
- 160 → `sm`

控件本身的 `style={{ width: N }}` 改成 `className="w-full"`。**排版时一个控件占一行**（每个 JSX 元素单独成行），onChange 等逻辑不变。

### P3.4 `events/events-content.tsx:~425-520`（7 个筛选 Select）
**现状**：「label + Select」两两成对放在 `Space` 里，每个 Select 带 `style={{ minWidth: 130–160 }}`。
**改法**：换成 `<FilterBar>`，每一对变成 `<FilterBar.Item label={原 label} width="sm|md">`；Select 的 `style` 改为 `className="w-full"`。刷新按钮放进 `actions`。

### P3.5 `crawl/crawl-tasks.tsx:~1493-1520`（用 JS 断点写的行内布局）
**现状**：`style={{ flexDirection: screens.md ? "row" : "column", width: screens.md ? 320 : "100%" … }}`
**改法**：换成等价的 Tailwind 响应式类：
- `flexDirection` 对应 `flex flex-col md:flex-row`
- `width` 对应 `w-full md:w-[320px]`

**先确认** antd `Grid.useBreakpoint()` 的 `md` 是 ≥768px，与 Tailwind 的 `md` 一致（都是 768）。如果 `screens` 改完后已经没有其他用途，删掉 `useBreakpoint`。

### P3.6 `admin/quality/quality-content.tsx:~1872`
如果 UI-3C 已经把这个工具栏放进了 PageHeader 的 actions，就跳过；否则给 `<Space>` 加 `wrap`。

## 模式 P4 · 长标题截断

| 文件:行 | 改法 |
|---|---|
| `events/events-content.tsx:~628`（列表项标题，行内 `fontSize:16`） | 外层加 `min-w-0`；标题改用 `className="line-clamp-2 text-base font-semibold"`，删掉行内 `fontSize` |
| `topics/topics-content.tsx:~460`、`~568`（列表标题） | 同上 |
| `topics/topics-content.tsx:~700-703`（抽屉里的条目标题，在不换行的 `Space` 中） | `Space` 加 `wrap`，标题加 `line-clamp-2` |
| `events-content.tsx:615`、`topics-content.tsx:440,548` 中 `List.Item actions={[…]}` | 在窄屏下，actions 列会挤压正文。给 List.Item 加 `className="flex-col items-start gap-2 sm:flex-row sm:items-center"`。如果 antd List.Item 的内部结构导致这个 className 不生效，就跳过并在报告里说明 |

## 禁止事项

- 不要改分页大小、列定义、排序或筛选逻辑。
- 不要碰 `war-map/**`。
- 只有 P3 中写明的位置可以把 `extra` 里的控件挪进 body，其他地方不要挪。

## 自主优化授权

处理 P1 时，如果在同一个文件里看到 Table 的外层 Card 只包了这一张表，可以给 Card 加 `styles={{ body: { padding: 0 } }}`，让表格贴边。每个文件最多改 3 处，并在报告里列出。

## 测试

- 现有测试（news-sources、crawl task detail、CreateCrawlTaskDrawer、alerts）必须通过。
- 不新增测试。

## 验证与提交

按 README §5。本批改动量大，**分 3 个 commit**：
1. `📱 fix(web): FE-UI 批4 表格横向滚动（67 处 Table 补 scroll.x）`
2. `📱 fix(web): FE-UI 批4 抽屉与弹窗宽度自适应窄屏`
3. `📱 fix(web): FE-UI 批4 工具栏换行与长标题截断`

## 人工冒烟清单（375px 宽）

- `/admin/quality`：每张表都能横向滑动，页面本身不出现横向滚动条。
- `/admin/ops/crawl-frontier`：筛选控件一个一行；打开详情抽屉，抽屉占满屏幕并且能关闭。
- `/events`：7 个筛选项自动换行；长标题最多显示两行。
- `/subscriptions`：搜索框占满一整行。
- `/situation-monitor`：面板里的表格能横向滑动。
