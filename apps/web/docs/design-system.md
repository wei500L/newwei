# Web 设计系统使用规范

> 本文固化 `apps/web` 现有的设计基元与约定。**新代码请复用这些基元，不要各自硬编码**——这是消除「组件视觉碎片化」的根本手段（优于事后再抽壳）。

## 1. 颜色

### 1.1 用 CSS token（className / CSS 上下文）
`globals.css` 的 `:root` / `.dark` 定义了全站语义色，Tailwind 已映射：

| 用途 | Tailwind 类 | CSS 变量 |
|------|------------|---------|
| 背景/前景 | `bg-background` `text-foreground` | `--background` `--foreground` |
| 主/辅/强调 | `text-primary` `bg-secondary` `text-accent` | `--primary` `--secondary` `--accent` |
| 危险/金融涨跌 | `text-destructive` `text-bullish` `text-bearish` | `--destructive` `--bullish` `--bearish` |
| 边框/输入/焦点环 | `border-border` `ring-ring` | `--border` `--input` `--ring` |

**规则**：DOM 元素的颜色优先走这些 token 类，**不要**写 `text-[#xxx]` / `bg-[rgba(...)]` 硬编码。

### 1.2 用 JS 常量 token（canvas / SVG 属性 / inline style / antd theme）
这些上下文**不解析 `var()`**，颜色必须是 JS 字符串。已集中在 `lib/`：

| 模块 | 内容 | 用于 |
|------|------|------|
| `lib/status-tokens.ts` | `SENTIMENT_*`、`CHART_STATE_*`、`*_FALLBACK`、`PRESSURE_STATUS_COLORS`、`RANGE_INDICATOR_COLORS`、`ALERT_LINE_COLORS` | 状态/情感语义色（badge glow、echarts lineStyle、SVG fill、inline style） |
| `lib/chart-theme-tokens.ts` | `CHART_SERIES_LIGHT/DARK`、`CHART_LIGHT/DARK_TEXT_COLORS`、`CHART_*_TOOLTIP_*`、`ECONOMIC_*`、`MARKET_PULSE_COLOR` | echarts 主题与图表数据色 |
| `lib/aura-theme-tokens.ts` | `AURA_BACKGROUND_COLORS`、`AURA_CARD_GLOW`、`EMPTY_DIGEST_SVG_COLORS` | aura 装饰渐变、SVG 属性 |
| `lib/graph-tokens.ts` | `KNOWLEDGE_GRAPH_NODE_COLORS`、`ENTITY_IMPACT_GRAPH_COLORS` | 图谱节点 itemStyle.color |
| `lib/antd-theme-tokens.ts` | `ANTD_COLORS_LIGHT/DARK`、`SHADOW_PRESETS` | antd ConfigProvider theme |

**规则**：canvas/SVG/inline-style/antd-theme 里的新颜色，加进对应模块再引用；**不要**在组件里散落 `rgba(...)` / `#hex`。
> ⚠️ **JIT 铁律**：绝不把颜色移进 Tailwind 任意类的 JS 插值（`bg-[${x}]`），会破坏 Tailwind 静态扫描导致类名不生成。任意类里的色值保持字面量。

## 2. 尺寸与间距

- **图表/容器高度**：用 `h-viz-xs..h-viz-4xl`（180/260/300/360/400/420/500/520px），别写 `h-[NNpx]`。见 `tailwind.config.ts` 的 `vizHeights`。
- **圆角**：`rounded`（`--radius` 10px）/ `rounded-lg`（`--radius-lg` 14px），别写 `rounded-[14px]` / `border-radius: 14px`。
- **面板阴影**：`shadow-panel`（`0 8px 20px rgba(15,23,42,0.08)`），别重复写该任意值。
- **间距**：优先 Tailwind 标度类（`p-4` `gap-6`），避免 `[13px]` 之类任意值与 layout 里的 inline `style={{gap:16}}`。

## 3. 排版

- **长文正文**：`text-reading`（16px / 行高 1.75）+ `max-w-measure`（72ch，控制测量宽度）。见 `MarkdownViewer`（`DEFAULT_CLASSES` / `CHAT_CLASSES` 两套基线均已 16px、行高 1.75）。
- 别用 `text-[14px]` / `text-[12px]` 当正文——用 `text-sm` / `text-xs`（注意：若无 `leading-*` 覆盖，切换会改行高）。

## 4. 卡片表面（已有基元，勿再造壳）

| 基元 | 用法 | 说明 |
|------|------|------|
| `.glass-card`（≡`.content-card`） | `<div className="glass-card ...">` 或 `<Card className="glass-card">` | 玻璃态卡片表面（含 light/dark） |
| `.glass-panel` | 同上 | 面板变体（透明度/阴影略不同） |
| `AuraBentoCard`（`components/aura-bento-card.tsx`） | `<AuraBentoCard>{...}</AuraBentoCard>` | 带鼠标 glow 交互的卡片，内部用 `useCardGlow` |
| `useCardGlow`（`hooks/use-card-glow.ts`） | 给任意卡片加 glow：取 `{ ref, style, onMouseMove }` | glow 逻辑单一真源 |

**规则**：需要玻璃卡片直接用 `.glass-card`/`.glass-panel` 类，叠加各自的 border/padding/尺寸即可；需要 glow 用 `AuraBentoCard` 或 `useCardGlow`。**不需要**再包 `CardBase`——基元已经足够，套壳只增 indirection。

## 5. 徽章 / 标签

- 情感徽章用 `SentimentBadge`（`components/sentiment-badge.tsx`），glow 走 `SENTIMENT_GLOW`。
- 状态/分类标签直接用 antd `<Tag color="...">`（其预设色板已达 WCAG）；同一区域内保持**尺寸一致**（统一带或不带 `text-xs`）与**语义→色映射一致**。

## 6. 暗色模式与可访问性

- **每个**浅色 `text-slate-*` / `bg-slate-*` / `border-slate-*` 都要配 `dark:` 变体。常用映射：
  `text-slate-900→dark:text-slate-100`、`700→300`、`hover:bg-slate-50→dark:hover:bg-slate-800`、`border-slate-200→dark:border-slate-700`、`ring-offset-white→dark:ring-offset-slate-900`。
- **对比度**：正文文字 ≥ 4.5:1（大字 ≥ 3:1）。浅背景上**避免 `text-slate-400/500` 作正文**（≈2.5–4.4:1，不达 AA），用 `text-slate-600+`。
- 暗色 hover 表面用 `slate-800`（次要）；文字用 `slate-300/200`。

## 7. App Shell 导航 token（FE-批2）

App Shell（TopNav / ActionRail / 移动 Drawer）的尺寸、状态色与动效已收敛到
`globals.css` 的 `:root` / `.dark` 中的 `--nav-*` / `--rail-*` / `--shell-*` /
`--z-*` token；交互状态类在 `@layer utilities` 的 `.nav-item--*` 定义，
映射函数在 `app/(app)/components/nav-item-state.ts`。

| token | 值 | 用途 |
|------|-----|------|
| `--shell-rail-width` | 4.5rem | 桌面 rail 面板宽（`w-[var(--shell-rail-width)]`） |
| `--rail-item-size` | 2.75rem | 导航项高（≥44px 触控目标），rail 与 drawer 共用 |
| `--rail-item-gap` / `--rail-item-radius` | 6px / 12px | rail 组内间距 / 项圆角 |
| `--nav-drawer-width` | 20rem | 移动导航 Drawer 宽 |
| `--nav-item-fg` / `--nav-item-strong-fg` | slate-500/400 · slate-700/300 | rail 次级图标 / drawer 行文字 |
| `--nav-item-hover-*` | `--secondary` + `--primary` | hover 面（暗色自动随 `--secondary` 切换） |
| `--nav-item-active-*` | `--primary` / `--primary-foreground` | active/selected 面 |
| `--nav-divider-soft` | slate-400/35% | rail 组间细分隔线 |
| `--z-top-nav` / `--z-rail` / `--z-content` | 50 / 20 / 0 | Shell 层叠顺序 |
| `--nav-motion-fast` | 150ms | 导航项状态过渡 |

**规则**：
- 导航导航项状态一律走 `.nav-item--active` / `.nav-item--idle` / `.nav-item--idle-strong`
  （经 `navItemStateClass(active, emphasis)`），**不要**在组件里重新拼
  `bg-[var(--primary)] text-white shadow-sm ...` 状态串。
- rail/drawer 尺寸用上表 token 的任意值类（`h-[var(--rail-item-size)]`），
  不再写 `h-11` / `w-[4.5rem]` 字面量；`nav-mode.ts` 的度量常量与这些
  token 值同步（44/6/17/13/32）。
- 顶部栏高度沿用既有 `--top-nav-height`（4rem）与 `--ticker-height`（2rem），
  shell 的内容偏移 `pt-[calc(...)]` 是唯一消费方。
- 焦点环沿用全局 `:focus-visible`（primary outline + 2px offset）；
  reduced-motion 由文件末尾的全局降级规则覆盖，导航不单独声明。

## 8. 反模式速查（PR 自检）

- ❌ `text-[#hex]` / `bg-[rgba(...)]` / JS 里散落 `rgba()`／`#hex`（改用 token）
- ❌ `h-[NNpx]` / `rounded-[14px]` / 重复 `shadow-[...]`（改用 `h-viz-*` / `rounded-lg` / `shadow-panel`）
- ❌ 浅色 slate 类无 `dark:` 变体
- ❌ 把颜色/尺寸移进 Tailwind 任意类的 `${}` 插值（破坏 JIT）
- ❌ 为已有基元（glass-card / antd Tag）再造 wrapper 组件
