# Web 设计系统使用规范

> FE-UI 批0（2026-11）起视觉方向为「情报编辑台」，详见 docs/refactor/frontend-ui-polish/README.md

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
| 表面 | `bg-surface` | `--surface` |
| 次级表面 | `bg-surface-muted` | `--surface-muted` |
| 弱化文字 | `text-muted-foreground` | `--muted-foreground` |
| 强边框 | `border-border-strong` | `--border-strong` |

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
- **圆角**：`rounded`（`--radius` 6px）/ `rounded-lg`（`--radius-lg` 10px），别写 `rounded-[14px]` / `border-radius: 14px`。
- **面板阴影**：`shadow-panel` 映射 `var(--shadow-surface)`，随主题切换（浅色 `0 1px 2px rgba(22,27,38,0.04)` / 暗色 `none`），别重复写该任意值。
- **间距**：优先 Tailwind 标度类（`p-4` `gap-6`），避免 `[13px]` 之类任意值与 layout 里的 inline `style={{gap:16}}`。

## 3. 排版

- **长文正文**：`text-reading`（16px / 行高 1.75）+ `max-w-measure`（72ch，控制测量宽度）。见 `MarkdownViewer`（`DEFAULT_CLASSES` / `CHAT_CLASSES` 两套基线均已 16px、行高 1.75）。
- 别用 `text-[14px]` / `text-[12px]` 当正文——用 `text-sm` / `text-xs`（注意：若无 `leading-*` 覆盖，切换会改行高）。

### 字体分工

- **衬线（`font-serif`）**：仅用于布局级标题（PageHeader h1、文章/头条标题、Today 刊头）。
- **无衬线（`font-sans`）**：其余全部 UI 文字。
- **等宽（`font-mono`）+ `tabular-nums`**：数字、时间、代码。
- **`.kicker`**：11px 大写、`letter-spacing: 0.08em`、muted 色，用于眉题。

## 4. 卡片表面（纸面卡片：实色 + 发丝线）

| 基元 | 用法 | 说明 |
|------|------|------|
| `.glass-card`（≡`.content-card`） | `<div className="glass-card ...">` 或 `<Card className="glass-card">` | 纸面卡片（实色 + 发丝线）：实色纸面表面、1px 发丝线边框、近零阴影（含 light/dark）；类名沿用 |
| `.glass-panel` | 同上 | 纸面面板变体（实色 + 1px 发丝线边框，近零阴影） |
| `.surface-inset` | `<div className="surface-inset ...">` | 卡内分区：内凹纸面（用色差/内描边分隔，不套 Card） |
| `.section-rule` | `<div className="section-rule" />` | 区块顶栏线（2px 墨线 + 上内边距） |
| `.hairline-b` | `<div className="hairline-b ...">` | 底部发丝线分隔 |
| `AuraBentoCard`（`components/aura-bento-card.tsx`） | `<AuraBentoCard>{...}</AuraBentoCard>` | 带鼠标 glow 交互的卡片，内部用 `useCardGlow`（批0 起已弃用，仅存量保留） |
| `useCardGlow`（`hooks/use-card-glow.ts`） | 给任意卡片加 glow：取 `{ ref, style, onMouseMove }` | glow 逻辑单一真源（批0 起已弃用，仅存量保留） |

**规则**：卡片表面一律用纸面卡片（`.glass-card`/`.glass-panel`，实色 + 1px 发丝线 + 近零阴影），叠加各自的 border/padding/尺寸即可；卡内分组用 `.surface-inset` 或 `.hairline-b`，**禁止卡中卡**（不要嵌套 Card）。`AuraBentoCard` / `useCardGlow` 保留但已弃用（批0 起），新代码不要再用；**不需要**再包 `CardBase`——基元已经足够，套壳只增 indirection。

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

## 9. 页面原语（FE-UI 批1）

统一页头、区块标题与筛选栏，避免全站出现多种写法。三个原语都在 `apps/web/components/`：

| 原语 | 文件 | 用途 |
|------|------|------|
| `PageHeader` | `components/page-header.tsx` | 每个业务页面顶部的唯一标题区（kicker + 衬线 h1 + 说明 + meta + 右侧操作 + 详情页返回链接） |
| `SectionHeader` | `components/section-header.tsx` | 卡片/区块内部的二级标题，替代散落的 `<Typography.Title level={4\|5}>` 与 `Card title` |
| `FilterBar` / `FilterBar.Item` | `components/filter-bar.tsx` | 列表页筛选与工具栏，自动换行，窄屏控件占满整行 |

**硬性约定**：

- 每个 `(app)` 页面的**第一个子元素必须是 `<PageHeader>`**；`kicker` 用所属导航组的文案 `t("nav.groups.xxx")`（`today` / `situation` / `research` / `workspace` / `admin`）。
- 页面根容器统一用 `<div className="flex flex-col gap-6">`（间距节奏见 §3/§2）。
- 区块标题用 `<SectionHeader>`，**不要**再用 `Typography.Title level={4|5}` 或 `Card title` 当区块标题；需要强调时加 `rule`（`.section-rule`）。
- 筛选栏用 `<FilterBar>`；放进去的 antd 控件（`Select` / `Input` / `DatePicker` 等）**必须**加 `className="w-full"`，让它占满 `FilterBar.Item` 的宽度。
- 原语本身**不含任何文案**——标题、kicker、说明、按钮文案都由调用方传入并走 `t("...")`。
- `PageHeader` 不依赖 antd（服务端安全组件，无 hooks、无 `"use client"`），RSC 页面与客户端组件都能直接 import。

**最小示例**：

```tsx
import { Button, Input, Select } from "antd";

import { FilterBar } from "@/components/filter-bar";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";

export default function EventsPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t("nav.groups.situation")}
        title={t("events.title")}
        description={t("events.description")}
        actions={<Button onClick={refresh}>{t("common.refresh")}</Button>}
      />

      <FilterBar actions={<Button onClick={reset}>{t("common.reset")}</Button>}>
        <FilterBar.Item label={t("events.filter.status")} width="sm">
          <Select className="w-full" options={statusOptions} />
        </FilterBar.Item>
        <FilterBar.Item label={t("events.filter.source")} width="md">
          <Input className="w-full" />
        </FilterBar.Item>
      </FilterBar>

      <section className="content-card p-4">
        <SectionHeader
          title={t("events.list.title")}
          extra={<span>{t("common.totalCount", { count })}</span>}
        />
        {/* 列表内容 */}
      </section>
    </div>
  );
}
```
