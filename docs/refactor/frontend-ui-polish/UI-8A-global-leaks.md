# FE-UI 批8A：全局漏网——提示条主题、图表配色、冷灰色板

> **一句话目标**：用少数几个「单点改动」把整站残留的旧视觉一次性拉回纸墨风格。三个点分别是：antd 静态提示不跟主题、ECharts 仍用 antd 默认高饱和配色、738 处 `slate-*`/`gray-*` 冷灰类与暖纸底打架。
>
> **依赖**：UI-0 ~ UI-7 已全部合入 main。可与 UI-8B、UI-8C 并行，三者改的文件互不相交。只有 `zh.json`/`en.json` 可能同时被改，按 README §4 只追加。
>
> **开工前必读**：`docs/refactor/frontend-ui-polish/README.md` 的 §3（尤其 §3.2 token 表）、§4、§5、§7；视觉对照 `style-preview.html`。

---

## 背景（审查证据，2026-11-02 于 main@8d230eb6 静态核实）

| 问题 | 证据 | 后果 |
|---|---|---|
| antd 静态 `message` 不读 ConfigProvider | 约 70 个文件 `import { message } from "antd"`，全仓没有 `ConfigProvider.config({ holderRender })` | 静态提示用 antd 默认蓝色和 8px 圆角，暗色模式下是白底提示 |
| sonner `Toaster richColors` | `app/providers.tsx` 中 `<Toaster position="top-right" theme={themeMode} richColors />` | 成功和失败提示是饱和的绿底、红底整块，和纸面风格冲突 |
| 图表系列色仍是 antd 默认色板 | `lib/chart-theme-tokens.ts` 中 `CHART_SERIES_LIGHT = ["#0050b3","#faad14","#13c2c2","#eb2f96","#722ed1",…]`，坐标轴文字是冷灰 `#6b7280`/`#e5e7eb` | 每张图都是品红、亮紫、青色，是整个 dashboard 最「廉价」的来源 |
| 冷灰类与暖纸底打架 | `slate-*` 共 738 处（dashboard 227、events-archive 169、assistant 137、markdown-viewer 69…），`gray-*` 89 处 | 卡片边框和次要文字发蓝灰，暖纸底上显得脏 |

---

## 任务 1：antd 静态提示跟随主题（`app/providers.tsx`）

**现状**：`antdTheme`（useMemo）和 `antdLocale` 只传给了树内的 `<ConfigProvider>`；`message.success()` 这类静态调用渲染在树外，拿不到主题。

**改法**：在 `Providers` 组件里、`antdTheme` 的 useMemo 之后加一段 effect（`ConfigProvider` 已经从 antd 引入，`useEffect` 如果没引入要补上）：

```tsx
// antd 静态方法（message / notification / Modal.confirm）渲染在 React 树外，
// 读不到上面的 <ConfigProvider>。用 holderRender 把同一份主题注入进去，
// 否则约 70 个文件里的静态 message 会显示 antd 默认蓝和白底（暗色下尤其明显）。
useEffect(() => {
  ConfigProvider.config({
    holderRender: (children) => (
      <ConfigProvider locale={antdLocale} theme={antdTheme}>
        {children}
      </ConfigProvider>
    ),
  });
}, [antdLocale, antdTheme]);
```

- 变量名以文件里实际的为准（`antdTheme`、`antdLocale` 在审查时存在于 `providers.tsx:238-281` 一带）。
- **不要**批量把 70 个文件改成 `App.useApp()`，量太大，本批不做。

**验收**：亮色、暗色下分别触发一次静态 message（例如组织切换器切换组织，或在 `/settings/security` 提交表单）。提示应为纸面底、墨色字、6px 圆角；暗色下应为深墨底，而不是白底。

## 任务 2：sonner 提示条去饱和（`app/providers.tsx`）

**现状**：`<Toaster position="top-right" theme={themeMode} richColors />`

**改法**：

```tsx
<Toaster
  position="top-right"
  theme={themeMode}
  toastOptions={{
    style: {
      background: "var(--surface)",
      color: "var(--foreground)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "var(--shadow-surface)",
    },
  }}
/>
```

删掉 `richColors`。成功和失败的区分交给 sonner 自带的图标颜色，不再整块填充。

**验收**：触发一次 sonner 成功提示和失败提示（`grep -rln "from \"sonner\"" apps/web/app` 能找到调用点，例如复制链接、订阅操作）。提示是纸面卡片样式，只有图标带颜色。

## 任务 3：图表配色换成纸墨色板（`lib/chart-theme-tokens.ts`）

只改**常量的值**，不改导出名和类型。使用方（`components/echart.client.tsx`、`market-pulse.tsx`、`economic-long/page.tsx`、`economic-medium/page.tsx`、`financial-card.tsx`）一律不动。

把文件顶部「值与迁移前完全一致……零视觉变化」这类注释改成：「FE-UI 批8A：对齐情报编辑台纸墨色板（README §3.2）」。

```ts
/** smart-light 系列色：墨蓝、琥珀、青绿、朱红、靛紫、橄榄、赭黄、石墨。低饱和，适合纸底。 */
export const CHART_SERIES_LIGHT: string[] = [
  "#1f3b7b", // 墨蓝（= --primary）
  "#b45309", // 琥珀（= --accent）
  "#0f766e", // 青绿
  "#b91c1c", // 朱红（= --destructive）
  "#5b4b8a", // 靛紫
  "#4d7c0f", // 橄榄
  "#a16207", // 赭黄
  "#5a6270", // 石墨（= --muted-foreground）
];

/** smart-dark 系列色：同色相提亮，保证深墨底上可读。 */
export const CHART_SERIES_DARK: string[] = [
  "#8fb0ff", // 墨蓝（= 暗色 --primary）
  "#f59e0b", // 琥珀（= 暗色 --accent）
  "#2dd4bf", // 青绿
  "#f87171", // 朱红（= 暗色 --destructive）
  "#a78bfa", // 靛紫
  "#a3e635", // 橄榄
  "#facc15", // 赭黄
  "#9aa3af", // 石墨（= 暗色 --muted-foreground）
];

export const CHART_LIGHT_TOOLTIP_BG = "rgba(255, 253, 249, 0.98)"; // --surface
export const CHART_LIGHT_TEXT_COLORS = {
  primary: "#161b26",   // --foreground
  title: "#161b26",
  secondary: "#4a5261", // --secondary-foreground
  tertiary: "#5a6270",  // --muted-foreground
  border: "#e3dfd6",    // --border
} as const;

export const CHART_DARK_TOOLTIP_BG = "rgba(20, 26, 34, 0.98)"; // 暗色 --surface #141a22
export const CHART_DARK_TOOLTIP_BORDER = "rgba(232, 228, 218, 0.12)";
export const CHART_DARK_TEXT_COLORS = {
  primary: "#e8e4da",   // 暗色 --foreground
  title: "#e8e4da",
  secondary: "#c9ced6", // 暗色 --secondary-foreground
  tertiary: "#9aa3af",  // 暗色 --muted-foreground
} as const;

export const ECONOMIC_CHART_COLORS = { gdp: "#1f3b7b" } as const;
export const ECONOMIC_CHANGE_COLORS = { positive: "#1b9e77", negative: "#d95f02" } as const; // = --bullish / --bearish
export const MARKET_PULSE_COLOR = "#0f766e";
```

- 文件里如果还有本节没列出的常量（如 `CHART_DARK_*` 其它项），按同一思路映射：文字用 foreground/muted，边框用 border，背景用 surface。映射关系在报告里逐条列出。
- 若有测试断言了旧色值（`grep -rn "#0050b3\|#faad14\|#13c2c2" apps/web --include=*.test.*`），同步更新断言，不要删测试。

**验收**：打开 `/dashboard`、`/dashboard/economic-medium`、`/finance`。图表系列是墨蓝、琥珀为主的低饱和色，不再有品红和亮紫；tooltip 是纸面底；暗色下系列可读。

## 任务 4：把 Tailwind 的 `slate`/`gray` 色阶重映射为「暖纸—墨」色阶（`tailwind.config.ts`）

**思路**：不逐个改 800 多处类名，只在 Tailwind 配置里覆盖 `slate` 和 `gray` 两个色阶。浅端对齐纸色 token，深端对齐墨色 token，所有 `text-slate-500`、`dark:bg-slate-900/60` 会自动变暖，透明度修饰符照常生效（色值必须是 hex，不能写 `var()`，原因见 README 关于 Tailwind 3 的说明）。

在 `theme.extend.colors` 中追加，保留原有的 key：

```ts
// FE-UI 批8A：slate/gray 重映射为暖纸—墨色阶（README §3.2）。
// 浅端 = 纸色 token，深端 = 墨色 token；存量 800+ 处冷灰类一次性变暖。
// 必须写 hex（Tailwind 3 的 /opacity 修饰符无法作用于 var()）。
slate: {
  50: "#faf8f3",
  100: "#f0ede6", // --surface-muted
  200: "#e3dfd6", // --border
  300: "#cfc9bc",
  400: "#9b978e",
  500: "#6b707a",
  600: "#5a6270", // --muted-foreground
  700: "#3a414d",
  800: "#232a35",
  900: "#161b26", // --foreground / 暗色卡片
  950: "#0d1117", // 暗色 --background
},
gray: { /* 与 slate 完全相同的 11 个值，复制一份 */ },
```

- 如果 `extend.colors` 里已经有 `slate`/`gray` 的定义，先停下，在报告里贴出原定义，**不要覆盖**。
- 不要动 `zinc`、`neutral`、`stone`（`zinc` 由 UI-8B 处理）。
- 同步在 `docs/design-system.md` 颜色一节加一行说明：「slate/gray 已重映射为暖纸—墨色阶；新代码仍应优先用语义 token（`text-muted-foreground`、`border-border` 等），不要新增 slate 类。」

**验收**：
- `/events-archive`、`/assistant`、`/dashboard` 的边框和次要文字从蓝灰变成暖灰，与纸底协调。
- 暗色下 `dark:bg-slate-900` 一类的面板与 `--surface` 深度接近，不发蓝。
- 搜一下 `text-slate-400` 用作**正文**的地方（不是图标或占位），如果对比度明显不够，在报告「建议后续」中列出，本批不改。

---

## 禁止事项

- README §4 全部通用约束。
- 不修改 `echart.client.tsx` 的主题注册逻辑，只改 token 常量的值。
- 不迁移 `message` 调用点；不新增依赖。
- 不改 `globals.css`（UI-8C 负责）。

## 自主优化授权

本批文件范围是 `providers.tsx`、`chart-theme-tokens.ts`、`tailwind.config.ts`、`design-system.md`。范围内发现的同类问题可以顺手修，比如 `colorTextLightSolid: "#f8fafc"` 改为 `--primary-foreground` 对应值，但要在报告「自主补充」中列出。

## 测试

无新增组件，不需要新测试；已有测试断言旧色值的要同步更新。

## 验证与提交

按 README §5 执行。建议拆成 2 个 commit：

- `🎨 style(web): FE-UI 批8A 图表配色与 slate/gray 色阶对齐纸墨色板`
- `💄 style(web): FE-UI 批8A antd 静态提示与 sonner 提示条跟随主题`

## 人工冒烟清单

| 页面 | 亮色 | 暗色 | 看什么 |
|---|---|---|---|
| `/dashboard` | ✓ | ✓ | 图表系列色、tooltip、坐标轴文字 |
| `/finance` | ✓ | ✓ | 涨跌柱色是 bullish/bearish |
| `/events-archive` | ✓ | ✓ | 边框和次要文字不再发蓝 |
| 任意触发 message 的操作 | ✓ | ✓ | 提示框底色跟随主题 |
| 任意触发 sonner 的操作 | ✓ | ✓ | 不再是整块绿或红 |
