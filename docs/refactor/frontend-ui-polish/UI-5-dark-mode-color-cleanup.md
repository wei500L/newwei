# FE-UI 批5：暗色模式与硬编码颜色清理

> 开工前先读 [README](README.md) §3、§4，以及 `apps/web/docs/design-system.md` §1、§6（UI-0 已更新）。
> 依赖：UI-4 已合入。
> 范围：**只处理下面列出的文件**。全仓的 hex/rgba 有数百处，本批只清理视觉影响最大的部分，其余记入报告的「建议后续」。

## 替换规则（所有任务通用）

| 现状 | 替换为 | 说明 |
|---|---|---|
| `bg-white` / `bg-white/60…/95`（DOM 表面） | `bg-[var(--surface)]`（不带透明度） | 自带暗色。token 是 hex，Tailwind 3 的 `/80` 透明度修饰对 `var()` hex 不生效，不要写 |
| `bg-slate-50` / `bg-slate-100`（内嵌区块） | `bg-[var(--surface-muted)]` | |
| `border-slate-200` / `border-slate-200/80` / `border-gray-200` | `border-[var(--border)]` | |
| `text-slate-900` / `text-slate-950` / `text-gray-900` | `text-[var(--foreground)]` | |
| `text-slate-500` / `text-slate-600` / `text-gray-500/600`（次要文字） | `text-muted-foreground` | |
| `text-slate-400`（正文） | `text-muted-foreground` | 400 对比度不达标 |
| `text-gray-*` 的其他档 | 对应的 `text-slate-*`，并加 `dark:` 变体 | 统一用 slate 色板 |
| `text-[11px]` / `text-[12px]` | `text-xs`（12px）。11px 只用于眉题（`.kicker`） | 改了行高的话，补 `leading-4` |
| `text-[13px]` / `text-[14px]` | `text-sm`。确实需要 13px 时保留，并在报告里说明 | |
| 圆角 `rounded-[18px…2rem]` | `rounded-lg`（10px） | |
| 阴影 `shadow-[0_24px_70px…]` 一类 | 删掉，或改成 `shadow-panel` | |
| 装饰性 `bg-[radial-gradient(...)]` / `bg-[linear-gradient(...)]` | 删掉，改成 `bg-[var(--surface)]` | 编辑台风格不用渐变装饰 |
| JS 里的 hex（echarts、cytoscape、SVG 属性、行内 style） | 移到 `lib/*-tokens.ts` 中按语义命名的常量；需要随主题切换的，用 `useTheme().isDark` 选择 light/dark 两套 | `useTheme` 来自 `@/hooks/use-theme` |
| 涨跌色写死（`#3f8600` / `#cf1322` 等） | DOM 上用 `text-bullish` / `text-bearish`；echarts 用 `lib/status-tokens.ts` 或 `chart-theme-tokens.ts` 中已有的涨跌常量（先 grep 找到常量名） | |

**禁止**：任何形式的 Tailwind 类名插值（README §4.3）。

## 任务清单

### T1 · 知识图谱画布（`app/(app)/knowledge-graph/knowledge-graph-canvas.tsx`）

1. `:40-51` 的 `getNodeColor` 在本地重复定义了一份节点色表，和 `lib/graph-tokens.ts:16` 的 `KNOWLEDGE_GRAPH_NODE_COLORS` 几乎一样（policy、commodity、instrument 三项有细微差异）。
   - 改为直接使用 `KNOWLEDGE_GRAPH_NODE_COLORS` 和 `DEFAULT_NODE_COLOR`。
   - 差异以 token 文件为准，并在报告里列出这三项的颜色变化。
2. `:106` 的 `color: "#0f172a"`（节点标签色）在暗色背景上看不见。
   - 在 `lib/graph-tokens.ts` 新增：
     ```ts
     export const KNOWLEDGE_GRAPH_LABEL_COLORS = { light: "#161b26", dark: "#e8e4da" } as const;
     ```
   - 组件内用 `const { isDark } = useTheme();` 取得主题，然后 `color: isDark ? KNOWLEDGE_GRAPH_LABEL_COLORS.dark : KNOWLEDGE_GRAPH_LABEL_COLORS.light`。
   - **注意**：cytoscape 的 style 是在初始化时生成的。如果 style 写在 `useEffect` 或 `useMemo` 里，要把 `isDark` 加进依赖数组，或者在 `isDark` 变化时调用 `cy.style().update()`。先读懂现有的初始化方式，选改动最小的一种，并在报告里说明。
3. `:208` 容器类名：
   ```
   min-h-[640px] rounded-[28px] border border-slate-200/80 bg-[radial-gradient(...)…,linear-gradient(...)]
   ```
   改为：
   ```
   min-h-[min(640px,70dvh)] rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]
   ```

### T2 · 分析工作台（`app/(app)/analysis/analysis-workspace.tsx`）

`:160`、`:261`、`:743`、`:790` 四处的 `bg-white` / `bg-white/60`，按替换规则改成 `bg-[var(--surface)]`。`:261` 是虚线占位框，改成 `bg-[var(--surface-muted)]`。

### T3 · 金融卡片涨跌色（`app/(app)/items/components/financial-card.tsx:26`）

`const color = isPositive ? "#3f8600" : "#cf1322";`
- 先看 `color` 被用在哪里：
  - 用于 DOM 文字 → 改成 className `isPositive ? "text-bullish" : "text-bearish"`。
  - 用于 echarts → 改成 token 常量（`lib/chart-theme-tokens.ts` 或 `lib/status-tokens.ts` 中已有的涨跌色）。
- 两种用法都有的话，分别处理。

### T4 · 情绪趋势卡（`app/(app)/dashboard/components/global-sentiment-trend.tsx:~294-321`）

1. 硬编码的英文：`Aggregation: `、`Range: `、`Window: `。新增以下 i18n key，zh/en 都加：
   - `dashboard.sentiment.aggregationLabel`：「聚合」/ "Aggregation"
   - `dashboard.sentiment.rangeLabel`：「范围」/ "Range"
   - `dashboard.sentiment.windowLabel`：「窗口」/ "Window"

   使用写法：`` `${t("dashboard.sentiment.rangeLabel")}: ${range}` ``，其余两个同理。
2. Card 上的 `className="h-full shadow-sm"` 和 `variant="borderless"` 改为 `className="content-card h-full"`，并删掉 `variant`，与同一行的其他卡片保持一致。
3. `:321` 的 `h-[250px]` 改为 `h-viz-sm`（260px）。同一行的邻居卡片如果是 350px，在报告里记录，**不要**为了对齐而改邻居。

### T5 · dashboard 概览的浅色专用类（`app/(app)/dashboard/dashboard-content.tsx`）

- `:278-319`、`:544`、`:582`、`:665` 一带，所有没有 `dark:` 变体的 `text-slate-*` / `bg-white*` / `border-slate-*`，按替换规则处理。
- 先在本文件内 grep `text-slate-\|bg-white\|border-slate-`，逐条判断：已经带 `dark:` 变体的跳过，没带的替换。

### T6 · Today 相关组件

- `app/(app)/today/user-digest-panel.tsx`：全文件没有一个 `dark:`，按替换规则全部处理。
  - `:~348` 的裸 `<Spin>` 包一层 `<div className="flex min-h-viz-xs items-center justify-center">`。
- `app/(app)/today/components/headlines.tsx:~178`、`breaking-alerts.tsx:~122`：浅色专用的灰字，按规则处理。
- `app/(app)/items/components/news-card.tsx:~335,341,363,371,378,546`：同上。这个组件在全站信息流里复用，改完要特别检查暗色效果。

### T7 · 欢迎页与门户（`app/(app)/welcome/page.tsx`、`app/(portal)/components/portal-shell.tsx`）

- welcome：`:72` 的 hero `<section>` 类名里有 `rounded-[2rem]`、渐变背景 `bg-[linear-gradient(135deg,rgba(14,165,233,0.10),…)]` 和 `shadow-[…]`。改为 `content-card p-6 sm:p-8`。
  - eyebrow 那一行（`text-sm font-semibold uppercase tracking-[0.26em] text-cyan-700`）改为 `kicker`。
  - h1（`text-3xl … text-slate-950 sm:text-5xl`）改为 `m-0 mt-2 max-w-3xl font-serif text-3xl font-semibold leading-tight text-[var(--foreground)] sm:text-4xl`。
  - 文件中其余卡片和区块按替换规则处理。
- portal-shell：门户是公开页面，**先确认**它是否在 `ThemeProvider` 之内（`app/layout.tsx` 已包住全站，所以是在之内），也就是说会跟随暗色切换。
  - 按替换规则处理 `text-slate-950`、`bg-white/80`、`rounded-[…]`、`shadow-[…]`、`:187` 的渐变。
  - UI-0 已经给 h1 加上了 `font-serif`，保留。

### T8 · 新闻看板（`app/(app)/newsnow/**`）

审查统计：这个目录有 `text-[..px]` 63 处、rgba 36 处、浅色专用类 24 处。本批**只处理**：
- `newsnow/components/newsnow-card.tsx`
- `newsnow/components/newsnow-header.tsx`
- `newsnow/components/news-list-hot.tsx`
- `newsnow/components/news-list-timeline.tsx`

按替换规则处理。其中 `text-[11px]` 如果用作序号或角标，可以保留，并在报告里列出。

**额外任务**：`newsnow-card.tsx` 中有 6 处静态 `message.xxx()` 调用（`import { message } from "antd"`）。静态 API 读不到 ConfigProvider 的主题，暗色下会显示成亮色提示。改法：
```tsx
const { message } = App.useApp();
```
放在组件函数体顶部；import 改为 `import { App, … } from "antd"`，并删掉原来的 `message` import。`providers.tsx` 已经包了 `<AntApp>`，所以 `App.useApp()` 可以直接用。

（审查时确认过：全仓只有这一个文件在用静态 message，其他文件都用 `message.useMessage()`，不用改。）

### T9 · globals.css：auth 暗色覆写与 archive-toolbar 的 `!important`

1. `globals.css` 约 `:2014-2170`，是 `.auth-card .ant-*` 和 `.dark .auth-card .ant-*` 的一大段覆写（约 130 行）。这些是在 antd darkAlgorithm 没生效、或者 token 不一致的年代写的补丁；UI-0 之后 antd token 已与 CSS token 对齐。
   - **逐条判断**：如果某条规则设置的值和 antd token 推导出来的值一致或接近（颜色、边框、背景），就删掉。
   - 拿不准的留着，并在报告里列出。
   - **不要**删 `.auth-layout` 和 `.auth-card` 本身的规则（UI-6 会改）。
2. `.archive-toolbar` 相关的 `!important` 覆写（约 `:813-860`、`:1153-1161`）：强制设置了 `.ant-select-selector` 的边框、背景、最小高度、padding、圆角。
   - 把里面的颜色值改成 token（`var(--border)`、`var(--surface)`）。
   - 把圆角改成 `var(--radius)`。
   - `!important` **本批保留**，因为去掉可能导致 antd 样式反过来覆盖它，需要浏览器验证；在报告里列为「需浏览器验证后去除」。

### T10 · 清理 UI-0 留下的过期代码

- `lib/aura-theme-tokens.ts` 的 `AURA_BACKGROUND_COLORS`、`AURA_CARD_GLOW`：grep 确认没有消费方后删除。
- `hooks/use-card-glow.ts`：grep 确认没有消费方后删除文件。
- `tailwind.config.ts` 的 `animation` / `keyframes` 中的 `aura-breathe`、`aura-drift`、`aura-shimmer`：grep `animate-aura-` 确认没有消费方后删除。

## 收尾自检（结果贴进报告）

```bash
cd apps/web
for f in "app/(app)/knowledge-graph/knowledge-graph-canvas.tsx" "app/(app)/analysis/analysis-workspace.tsx" "app/(app)/today/user-digest-panel.tsx" "app/(app)/welcome/page.tsx" "app/(portal)/components/portal-shell.tsx"; do
  echo "$f: bg-white=$(grep -c 'bg-white' "$f") slate-no-dark=$(grep -E 'text-slate-[4-9]00' "$f" | grep -vc 'dark:') hex=$(grep -cE '#[0-9a-fA-F]{6}' "$f")"
done
```
每个数字都应该明显下降。剩余的要逐条说明原因。

## 禁止事项

- 不要碰 `war-map/**`，它的颜色已经在 FE-批4B 收敛到 token。
- 不要改 echarts 系列的配色方案（`CHART_SERIES_*`），那是数据可视化色板，和界面主题无关。
- 不要大面积修改 `admin-content.module.css`（124 处 rgba）。这一项列进「建议后续」。

## 自主优化授权

在本批列出的文件里，看到 `style={{ color: "#…" }}` 这类纯颜色的行内样式，可以按规则替换掉。

## 测试

现有测试必须通过。不新增测试。

## 验证与提交

按 README §5。建议拆成 2 个 commit：
1. `🌙 style(web): FE-UI 批5 暗色适配与硬编码色收敛（图谱/分析/Today/欢迎页/门户/newsnow）`
2. `🔥 chore(web): FE-UI 批5 删除过期 aura 光斑与卡片光晕代码`

## 人工冒烟清单（暗色模式为主）

逐页打开以下页面，检查有没有白块、看不清的文字、不协调的渐变：
- `/knowledge-graph`：节点标签在暗色下清晰可读
- `/analysis`
- `/today`
- `/welcome`
- `/`（门户）
- `/newsnow`
- `/dashboard`
- `/items`：财经卡片的涨跌色正确
- `/login`：暗色下输入框和按钮仍然正常
