# FE-UI 批6：招牌页面——Today 头版 · Dashboard 概览 · 登录页

> 开工前先读 [README](README.md) 的 §3（视觉规范要逐条对照）和 §4。
> 依赖：UI-5 已合入。
> 本批是整个系列里**设计成分最多**的一批。下面每个页面都给了 ASCII 线框，**照着线框布局**。线框没覆盖到的细节，按 README §3.1 的原则自己判断，并在报告里说明你的取舍。

## 不变的原则

- 只改展示层。数据 hooks、GraphQL 查询、跳转逻辑都不动。
- 不新增数据源，不新增依赖。
- 线框里出现的文案都走 i18n。新增 key 要同时写进 zh 和 en。

---

## A. Today 头版（`app/(app)/today/**`）

### 目标线框（≥1024px）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 每日简报 · DAILY BRIEFING                         （kicker，左对齐）   │
│ 11月2日 星期日                                    （font-serif 36px）  │
│ 今天发生了什么，先看这里，再进入深读。           （muted 描述）        │
│══════════════════════════════════════════════════════════════════════│ ← 双线：2px 墨线 + 3px 间隔 + 1px 墨线
│ ● 突发  伊朗……（一行一条，朱红 kicker，最多 3 条，超出折叠「还有 N 条」）│
│──────────────────────────────────────────────────────────────────────│ ← 1px 发丝线
│ 头条 HEADLINES                     │ 热点 HOT TOPICS                  │
│ ┌──────────────────────────────┐   │ 1  话题名 ··········· 128 篇      │
│ │        头条大图（16:9）        │   │ 2  话题名 ···········  96 篇      │
│ └──────────────────────────────┘   │ …                                 │
│ 来源 · 2 小时前                    │───────────────────────────────────│
│ 头条标题用衬线 24–28px，最多 3 行   │ 我的摘要 MY DIGEST                │
│ 摘要两行……                        │ （UserDigestPanel 原内容）         │
│────────────────────────────────────│                                   │
│ 次条 1（无图，标题 15px 半粗）       │                                   │
│ 来源 · 时间                         │                                   │
│────────────────────────────────────│                                   │
│ 次条 2 …                            │                                   │
│            （左 7 栏）               │          （右 5 栏，中间竖发丝线） │
├──────────────────────────────────────────────────────────────────────┤
│ 最新信息流 LATEST                                         section-rule │
│ （ItemsView feed，全宽，紧凑密度）                                       │
└──────────────────────────────────────────────────────────────────────┘
```
窄屏（<1024）时单栏，顺序为：报头 → 突发 → 头条 → 热点 → 我的摘要 → 最新信息流。

### 任务

**A1 · 报头（`today-content.tsx`）**

UI-3A 放进来的 `PageHeader` 换成**专用报头**。只有 Today 使用它，不抽成通用组件：
```tsx
<header className="flex flex-col gap-2">
  <p className="kicker m-0">{t("pages.today.kicker")}</p>
  <h1 className="m-0 font-serif text-3xl font-semibold leading-tight tracking-tight md:text-4xl" suppressHydrationWarning>
    {todayLabel}
  </h1>
  <p className="m-0 max-w-measure text-sm text-muted-foreground">{t("pages.today.subtitle")}</p>
  <div aria-hidden className="mt-2 h-[6px] border-y-2 border-[var(--border-strong)] [border-bottom-width:1px]" />
</header>
```
新增 i18n key：`pages.today.kicker`，值为「每日简报 · DAILY BRIEFING」/「Daily Briefing」。

`todayLabel` 目前的格式是 `dddd, MMMM D`（英文）。中文环境下改成 `M月D日 dddd`：用 `i18n.language` 判断，`dayjs` 的 locale 应该已经由 `@/lib/dayjs` 设置好，先确认这一点。**不要**改 `todayDateRange` 的逻辑。

**A2 · 突发条（`components/breaking-alerts.tsx`）**

- 现状：有告警时是一组红色圆角卡片（`bg-red-50 … rounded-lg p-3`），无告警时是一张绿色卡片。
- 改为（有告警时）：
  ```tsx
  <section aria-label={t(...)} className="flex flex-col">
    {visible.map((alert) => (
      <div key={alert.id} className="hairline-b flex items-baseline gap-3 py-2">
        <span className="kicker shrink-0 text-[var(--destructive)]">● {t("pages.today.breaking")}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{alert 标题}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{时间}</span>
      </div>
    ))}
    {hidden > 0 ? <button type="button" className="py-2 text-left text-xs text-muted-foreground hover:text-[var(--foreground)]">{t("pages.today.moreBreaking", { count: hidden })}</button> : null}
  </section>
  ```
- 默认最多显示 3 条，点击后展开全部。用 `useState<boolean>` 控制展开。
- 无告警时：**不渲染**绿色卡片，返回 `null`。头版没有突发新闻就不该占位置。如果你认为必须保留一个「一切正常」的提示，改成一行 `text-xs text-muted-foreground` 的小字，并在报告里说明。
- 告警标题和时间字段**沿用组件里现有的取值方式**，不要改查询。
- 新增 key：`pages.today.breaking`（「突发」/ "Breaking"），`pages.today.moreBreaking`（「还有 {{count}} 条」/ "{{count}} more"）。

**A3 · 头条（`components/headlines.tsx`）**

- 现状：头条大图上叠加黑色渐变，白字标题压在图上，蓝色徽标是 `bg-blue-500`；次条列表是 `divide-gray-100`，配 `text-gray-*`。
- 改为：**图文分离**，标题不再压在图上。
  - 外层：`AuraBentoCard` 改为 `<section className="flex flex-col gap-3">`，去掉卡片外壳。头版内容直接排在纸面上，靠发丝线分隔。
  - 区块标题：`<SectionHeader kicker="HEADLINES" title={t("pages.today.headlines")} />`。先 grep 有没有现成 key，没有就新增「头条」/ "Headlines"。
  - 头条：图片容器 `aspect-video w-full overflow-hidden rounded`，图片 `object-cover`。图下方依次是：
    - 来源 + 时间：`kicker` 风格
    - 标题：`<h2 className="m-0 font-serif text-2xl font-semibold leading-snug line-clamp-3 group-hover:underline underline-offset-4">`
    - 摘要：`text-sm text-muted-foreground line-clamp-2`
    
    删掉渐变遮罩 div 和蓝色徽标。如果原徽标表达的是「分类」，改成 `kicker` 文字放在来源前面。
  - 次条：`divide-y divide-[var(--border)]`；每条 `py-3`；标题 `text-[15px] font-semibold leading-snug line-clamp-2`；来源和时间 `text-xs text-muted-foreground font-mono`。缩略图（`w-12`）保留，放在右侧。
  - 没有头条图片时：直接显示标题块，不留空图位。
  - 骨架屏（`:80`）同样去掉卡片外壳。
- 点击跳转逻辑保持不变。

**A4 · 热点（`components/hot-topics.tsx`）**

- 改成编号列表：每行依次是 `font-mono text-muted-foreground` 的序号（1–N）、话题名（`flex-1 truncate`）、右侧计数（`font-mono tabular-nums text-xs`）。行间用发丝线分隔。
- 外层同样去掉卡片外壳，区块标题改用 `SectionHeader`。

**A5 · 栅格（`today-content.tsx`）**

UI-2A 已经把栅格改成 `lg:grid-cols-12` 加 7/5 分栏。本批在此基础上：
- 右栏加 `lg:border-l lg:border-[var(--border)] lg:pl-6`，形成栏间竖线。
- 「我的摘要」（UserDigestPanel）放在右栏热点之后，用 `SectionHeader` 加 `hairline` 与热点隔开。UserDigestPanel 内部只做外壳调整：如果它最外层是 `content-card` 一类的卡片，改成无卡片。**内部 654 行的逻辑不要动**。
- 最新信息流移到栅格**下方**，全宽：
  ```tsx
  <section className="flex flex-col gap-3">
    <SectionHeader rule kicker="LATEST" title={t("pages.today.latestFeed")} />
    <ItemsView surface="none" …原 props… />
  </section>
  ```
  删掉原来包裹它的 `AuraBentoCard` 和 `min-h-viz-3xl` 容器。信息流全宽之后，ItemsView 的网格视图和 300px 侧栏都能正常显示。

**A 的验收**：
- 1280 宽亮色：整页看起来像一份报纸头版，没有任何圆角大卡片，层次全靠线条和字号。
- 375 宽：单栏，阅读顺序正确。
- 暗色：深墨底配暖白字，双线报头清晰可见。

---

## B. Dashboard 概览（`app/(app)/dashboard/**`）

### 目标线框

```
┌ PageHeader(compact) 态势总览 ──────────────────── [时间范围控件] ┐
│ ┌────────┬────────┬────────┬────────┐  ← MarketPulse：一条横向数据带   │
│ │冲突指数│市场    │资源    │供应链  │    格子之间是竖发丝线，无卡片阴影   │
│ │ 72.4 ▲ │ 1.32 ▼ │ …      │ …      │    数字 font-mono 32px，         │
│ │ 迷你线 │        │        │        │    涨跌用 bullish/bearish         │
│ └────────┴────────┴────────┴────────┘                                 │
│ ━━ 战区地图 WAR MAP ━━━━━━━━━━━━━━━━━  ← SectionHeader rule           │
│ [地图 2/3]                 │ [板块热力 1/3]                            │
│ ━━ 市场情绪 SENTIMENT ━━━━━━━━━━━━━━━                                 │
│ …                                                                     │
└───────────────────────────────────────────────────────────────────────┘
```

### 任务

**B1 · MarketPulse 数据带（`dashboard/components/market-pulse.tsx`，500 行）**

- 删除鼠标光晕：`AuraMetricCard` 中的 `cardRef`、`onMouseMove`、`--market-pulse-x/y` 以及 radial-gradient 光晕层；删除 `active:scale-[0.98] active:brightness-105`。
- 卡片容器从 `rounded-2xl border-l border-white/10 first:border-l-0` 改为 `flex h-full cursor-pointer flex-col gap-1 px-5 py-4 hover:bg-[var(--surface-muted)] border-l border-[var(--border)] first:border-l-0`。
- 外层容器改为 `content-card grid grid-cols-2 overflow-hidden p-0 md:grid-cols-4`（按实际指标数量调整列数）。2 列布局下，第 3 和第 4 个格子需要上边框：给它们加 `border-t border-[var(--border)] md:border-t-0`，或者用 `[&>*:nth-child(n+3)]:border-t md:[&>*:nth-child(n+3)]:border-t-0` 实现，二选一并在报告里说明。
- 数值（`:95`）：`text-4xl font-bold` 改为 `font-mono text-3xl font-semibold tabular-nums`。
- **已有 bug**：`:89-91` 的闪烁背景写的是 `bg-[var(--bullish)]/15`。`--bullish` 是 hex 值，Tailwind 3 的透明度修饰对 `var()` 不生效，所以背景从来没有显示过。改为：
  - 上涨：`text-[var(--bullish)] bg-emerald-500/10`
  - 下跌：`text-[var(--bearish)] bg-orange-500/10`
  
  这里选用的是与 bullish / bearish 色相接近的 Tailwind 色板。
- 指标标题：改用 `kicker` 风格。
- 迷你趋势线如果是 echarts，颜色常量保持不变。
- `aria`：`onClick` 写在 div 上，需要补 `role="button" tabIndex={0}`，并支持 Enter 键触发：`onKeyDown={(e) => e.key === "Enter" && onClick?.()}`。

**B2 · 区块标题（`dashboard-content.tsx`）**

- `:~663-667` 地图标题 `<h3 className="text-lg text-slate-700">` 改为 `<SectionHeader rule kicker="WAR MAP" title={t("dashboard.charts.warMap.title")} />`，放在地图容器**之外、之上**。地图容器本身改为 `content-card h-viz-3xl overflow-hidden flex flex-col`，去掉 `glass-panel border …`。
- 「板块热力」「情绪」「K 线」这些用 `<Card title>` 的卡片：**保留 Card**，因为卡片内的 title 起区块标题作用。只把 className 统一为 `content-card`，并去掉 `variant="borderless"`。
- 时间范围面板（`:542`）`glass-panel border border-[var(--border)] px-4 py-3` 改为 `content-card px-4 py-3`；其中 `text-xs text-slate-600 font-medium` 改为 `kicker`。

**B 的验收**：概览页顶部是一条整齐的数据带，下方各区块由 2px 墨色栏线引出，整页没有光晕和渐变。

---

## C. 登录、注册等认证页（`app/(auth)/**` + `globals.css` 中的 `.auth-*`）

### 目标线框

```
┌────────────────────────── 纸底（--background），无渐变 ──────────────────────────┐
│                                                                    [中文 ▾]      │ ← 右上角语言切换
│                         MODULAR · INTELLIGENCE DESK          （kicker 居中）      │
│                         ═════════════════════════                                │
│                    ┌──────────────────────────────┐                               │
│                    │ 登录                          │  ← font-serif 24px           │
│                    │ 使用组织账号继续              │                               │
│                    │ [表单……]                     │                               │
│                    └──────────────────────────────┘  ← content-card，420px        │
│                         © Modular                    （muted 小字）               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 任务

**C1 · `app/(auth)/layout.tsx`**
```tsx
import type { ReactNode } from "react";

import { LanguageSwitcher } from "@/app/(app)/components/language-switcher";

import { AuthMasthead } from "./auth-masthead";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-layout">
      <div className="absolute right-4 top-4"><LanguageSwitcher compact /></div>
      <div className="flex w-full flex-col items-center gap-6">
        <AuthMasthead />
        {children}
      </div>
    </div>
  );
}
```
- `LanguageSwitcher` 是自包含的客户端组件，只依赖 i18n，可以直接在服务端 layout 中使用。
- 新建 `app/(auth)/auth-masthead.tsx`（`"use client"`，内部用 `useTranslation`）：渲染 kicker 文字 `t("auth.masthead")`，以及其下方一条 `w-48 h-[6px] border-y-2 border-[var(--border-strong)] [border-bottom-width:1px]` 的双线。
- 新增 key：`auth.masthead`，值为「MODULAR · 情报编辑台」/「MODULAR · INTELLIGENCE DESK」。
- `.auth-layout` 需要加 `position: relative`，让右上角的语言切换能定位。

**C2 · `globals.css` 的 auth 样式**
- `:root` 和 `.dark` 中的 `--auth-layout-background` 都改为 `var(--background)`，去掉径向渐变。
- `--auth-card-background` 改为 `var(--surface)`；`--auth-card-border` 改为 `var(--border)`；`--auth-card-shadow` 改为 `var(--shadow-surface)`。
- `.auth-card` 中的 `backdrop-filter` 两行删掉。
- `.auth-layout` 改为 `flex-direction: column;`（保留居中），并加 `position: relative;`。

**C3 · 各认证页的标题**

UI-2A 已经给标题加了 `font-serif !mb-2`。本批再检查一遍 register、forgot、reset、invite、sso 五个页面，确保标题写法一致。

**C 的验收**：375 和 1280 宽、亮暗两种模式下都检查——纸底上一张干净的卡片，顶部有报头双线，右上角能切换语言，切换后整页文案随之变化。

---

## 禁止事项

- 不要改 ItemsView、UserDigestPanel、MarketPulse 的数据逻辑和 props 语义（新增可选 props 可以）。
- 不要改登录表单的字段、校验、提交和 SSO 流程。
- 不要碰 `war-map/**`。

## 自主优化授权

本批允许你在 A / B / C 三个范围内做**符合 README §3 原则**的额外视觉微调，比如间距、字号、对齐。每一处都要在报告里写清楚「改了什么、为什么符合编辑台原则」。不允许引入新颜色，也不允许引入新的装饰效果（渐变、光晕、模糊）。

## 测试

- 新增 `apps/web/app/(app)/today/components/breaking-alerts.test.tsx`：
  1. mock Apollo 返回 5 条告警，断言默认只显示 3 条，并且出现「还有 2 条」。
  2. 点击「还有 2 条」后，5 条全部可见。
  3. 返回 0 条时，不渲染任何告警文本。

  用 `@apollo/client/testing` 的 `MockedProvider`，配合 `renderWithProviders`。先看仓库里其他 Apollo 测试的 mock 写法（grep `MockedProvider`），跟着它写。把文件加进 coverage.include。
- `login/page.tsx` 在 coverage.include 中，有测试，必须通过。

## 验证与提交

按 README §5 的流程执行。分 3 个 commit：
1. `✨ feat(web): FE-UI 批6 Today 头版——报头双线、突发条、图文分离头条与编号热点`
2. `💄 style(web): FE-UI 批6 Dashboard 概览数据带与栏线区块`
3. `💄 style(web): FE-UI 批6 登录页纸面报头与语言切换`

## 人工冒烟清单

- `/today`：在 1280、375 两种宽度，亮暗两种模式下各看一遍。重点看是否「像报纸」：线条是否清楚，衬线标题是否醒目，有没有残留的大圆角卡片。
- `/dashboard`：数据带四格等宽、竖线对齐；点击某个指标能打开详情；键盘 Tab 到指标上按 Enter 也能打开。
- `/login`：切换语言、切换暗色；在 375 宽下卡片不贴边。
