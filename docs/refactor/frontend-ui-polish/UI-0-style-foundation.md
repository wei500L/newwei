# FE-UI 批0：风格基座（纸墨 token · 实色纸面卡片 · antd 主题对齐 · 去装饰）

> 先读 [README](README.md) 的 §3 视觉规范和 §4 通用硬约束。本批的所有色值和尺寸**都照抄 README §3.2 的表**，本文不再重复数值。
> 依赖：无，本批是整个系列的第一步。
> 本批完成后再开 UI-1、UI-2A、UI-2B。

## 目标

只改**全局 token、全局 CSS 和 antd 主题**，不碰页面组件。完成后整站从「玻璃拟态 + 光斑」变为「暖纸 + 墨色 + 发丝线」。由于全站约 60 处 `.content-card`、25 处 `.glass-panel` 用的都是集中定义的表面类，只改这几条 CSS 规则，大部分页面的观感就会一起变。

## 必读文件

- `apps/web/app/globals.css`：1–190 行（token 与 base 层），191–260 行（`.glass`、`.glass-card`、`.glass-panel`），1000–1055 行（暗色表面），1370–1385 行，1650–1665 行，2183–2197 行
- `apps/web/tailwind.config.ts`（全文）
- `apps/web/lib/antd-theme-tokens.ts`（全文）
- `apps/web/app/providers.tsx`：210–290 行
- `apps/web/components/aura-background.tsx`、`components/aura-bento-card.tsx`、`hooks/use-card-glow.ts`、`lib/aura-theme-tokens.ts`
- `apps/web/docs/design-system.md`

## 任务清单

### T1 · 替换 CSS token（`app/globals.css` 的 `:root` 和 `.dark`）

**现状**（`globals.css:42-67` 亮色、`:94-117` 暗色），节选：
```css
  --background: #f7f6f2;
  --foreground: #1f2933;
  --primary: #1f3b7b;
  ...
  --border: #e2e8f0;
  --radius: 10px;
  --radius-lg: 14px;
```

**改法**：
1. 按 README §3.2 表，逐个替换 `:root` 和 `.dark` 里已有的变量值：`--background`、`--foreground`、`--primary*`、`--secondary*`、`--accent*`、`--destructive*`、`--border`、`--input`、`--ring`、`--radius`、`--radius-lg`。`--bullish*` 和 `--bearish*` 不改。
2. 在 `:root` 和 `.dark` 中、紧跟 `--foreground` 之后，新增 `--surface`、`--surface-muted`、`--muted-foreground`、`--border-strong`、`--shadow-surface`、`--ticker-bg`、`--ticker-fg`、`--ticker-muted`（`--radius` 系列只放在 `:root`）。
3. 把 `--font-sans` 和 `--font-serif` 替换为 README §3.2 的字体栈。
4. `--nav-item-fg` 和 `--nav-item-strong-fg` 改为引用 token：`--nav-item-fg: var(--muted-foreground);`、`--nav-item-strong-fg: var(--foreground);`，`:root` 和 `.dark` 两处都改。`.dark` 中这两行对应的硬编码值可以删掉，因为引用的 token 会随主题自动切换。
5. 其他变量（`--command-bar-*`、`--auth-*`、`--aura-*`、`--top-nav-height` 等）**这一批不动**。

**验收**：`:root` 和 `.dark` 里的每个新变量都有值，且与 README 表一致。

### T2 · base 层：字号、标题字体、重复声明（`globals.css:160-176`）

**现状**：
```css
  body {
    @apply bg-[var(--background)] text-[var(--foreground)] font-sans antialiased selection:bg-[var(--primary)] selection:text-[var(--primary-foreground)] tabular-nums;
    line-height: 1.6;
    background-color: var(--background);
  }

  h1, h2, h3, h4, h5, h6 {
    @apply font-semibold tracking-tight text-[var(--foreground)] font-serif;
  }
```

**改法**：
```css
  body {
    @apply bg-[var(--background)] text-[var(--foreground)] font-sans antialiased selection:bg-[var(--primary)] selection:text-[var(--primary-foreground)] tabular-nums;
    font-size: 14px;
    line-height: 1.6;
  }

  h1, h2, h3, h4, h5, h6 {
    @apply font-semibold tracking-tight text-[var(--foreground)];
  }
```
也就是：删掉重复的 `background-color`，加上 `font-size: 14px`，去掉 `font-serif`。从此衬线只能显式写 `font-serif` 才生效。

**补偿**：下面这些「版面级标题」原本依赖全局衬线，要在 className 里补上 `font-serif`，保住编辑感：
- `app/(reader)/read/items/[id]/page.tsx:608` 的 `<h1 className="text-3xl md:text-4xl font-bold ...">` → 加 `font-serif`
- `app/(portal)/components/portal-shell.tsx:228`、`:286`、`:335` 的三个 `<h1>` → 加 `font-serif`
- `app/(app)/items/[id]/item-detail.tsx:1237` 文章主标题 `<Typography.Title level={4} ellipsis={{ rows: 2 }} style={{ margin: 0 }}>{displayTitle}` → 加 `className="font-serif"`

**验收**：`globals.css` 中不再有任何把 `font-serif` 作用到 h1–h6 的规则；上面 5 处都显式带了 `font-serif`。

### T3 · 表面类改为实色纸面（`globals.css:191-238` 与 `:1015-1052`）

**现状**：`.glass-card, .content-card` 和 `.glass-panel` 用的是双层渐变背景、`backdrop-filter: blur(28px)` 和三层 box-shadow；暗色版本（`.dark .glass-card, .dark .content-card`、`.dark .glass-panel`）是 `blur(32px)` 加 indigo 光晕。

**改法**：把这 4 个规则块整体替换为：
```css
  .glass-card,
  .content-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-surface);
  }

  .glass-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: none;
  }
```
暗色不再需要单独的规则块，因为 token 会自动切换。**删除** `.dark .glass-card, .dark .content-card { ... }` 和 `.dark .glass-panel { ... }` 两个块。

`.glass`（`globals.css:193-195`，顶栏在用）改为：
```css
  .glass {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
```
同时删除 `.dark .glass { ... }`（约 `:1010-1013`）。

**注意**：
- 类名一个都不能改，60 多处在用。
- 如果某些地方 `.glass-card` 和 antd `Card` 叠用（`<Card className="content-card">`），antd Card 自带的 border 和背景可能和这条规则重叠。处理办法是在同一区域追加下面这条，保证 Card 不出现双边框：
  ```css
  .ant-card.content-card,
  .ant-card.glass-card,
  .ant-card.glass-panel { border-color: var(--border); }
  ```

**验收**：`globals.css` 中 grep `backdrop-filter`，`.glass-card` / `.content-card` / `.glass-panel` / `.glass` 相关的命中全部消失；其他组件自己的 backdrop-filter 本批不管。

### T4 · 新增工具类（`globals.css` 的 `@layer utilities` 开头，紧接 T3 的规则之后）

把 README §3.3 中 `.kicker`、`.section-rule`、`.hairline-b`、`.surface-inset` 四个类原样粘贴进去。

### T5 · 删除冗余规则（`globals.css`）

1. `:1379-1381`，下面这条与亮色规则重复，删除：
   ```css
   .dark .command-bar-shell.command-bar-shell--active {
     animation-name: command-bar-shell-glow;
   }
   ```
2. `:1653` 起的 `@media (prefers-reduced-motion: reduce) { .command-bar-shell, ... }` **保留不动**。它含有 `transform: none !important`，文件末尾 `:2187` 的全局 `*` 规则只压缩了时长，不会重置 transform，所以两者并不重复（已核实）。

### T6 · Tailwind 配置（`apps/web/tailwind.config.ts`）

1. `borderRadius` 改为（修正 lg > xl 的倒挂）：
   ```ts
   borderRadius: {
     sm: '4px',
     DEFAULT: 'var(--radius)',      // 6px
     md: 'var(--radius)',           // 6px
     lg: 'var(--radius-lg)',        // 10px
     xl: '12px',
     '2xl': '16px',
   },
   ```
2. 在 `colors` 里追加：
   ```ts
   surface: {
     DEFAULT: 'var(--surface)',
     muted: 'var(--surface-muted)',
   },
   'muted-foreground': 'var(--muted-foreground)',
   'border-strong': 'var(--border-strong)',
   ```
3. `boxShadow.panel` 改为 `'var(--shadow-surface)'`，注释改成「面板/卡片标准阴影，随主题切换」。

**验收**：`bg-surface`、`bg-surface-muted`、`text-muted-foreground`、`border-border-strong` 都可以使用。

### T7 · antd 主题对齐（`lib/antd-theme-tokens.ts` + `app/providers.tsx`）

1. `lib/antd-theme-tokens.ts`：
   - `AntdThemeColors` 接口新增 `colorBorderSecondary: string;`。
   - `ANTD_COLORS_LIGHT` 和 `ANTD_COLORS_DARK` 的每个值都按 README §3.2 的 antd 表替换（含新键）。
   - `SHADOW_PRESETS.light.card` 和 `.dark.card` 都改为 `"none"`。
   - `SHADOW_PRESETS.light.modal` 改为 `"0 12px 32px rgba(22, 27, 38, 0.14)"`，`.dark.modal` 改为 `"0 16px 40px rgba(0, 0, 0, 0.5)"`。
   - 文件头注释补一句：「FE-UI 批0：与 globals.css 的纸墨 token 一一对应，修改时两处同步」。
2. `app/providers.tsx` 的 `token` 块（约 `:240-256`）：
   - 加 `colorBorderSecondary: colors.colorBorderSecondary`
   - `borderRadius: 10` 改为 `borderRadius: 6`，并加 `borderRadiusLG: 10`、`borderRadiusSM: 4`、`fontSize: 14`
   - `colorTextLightSolid` 保持不变
3. `components` 块（约 `:257-280`）改为：
   ```ts
   components: {
     Card: { borderRadiusLG: 10, colorBgContainer, boxShadow: cardShadow, headerFontSize: 15 },
     Button: { borderRadius: 6, controlHeight: 34, primaryShadow: "none", defaultShadow: "none", dangerShadow: "none" },
     Table: {
       colorBgContainer,
       borderColor: colors.colorBorderSecondary,
       headerBg: colorFillSecondary,
       headerColor: colorTextSecondary,
       rowHoverBg: colorFillSecondary,
     },
     Menu: { colorBgContainer: "transparent" },
     Modal: { borderRadiusLG: 10, colorBgElevated, boxShadow: modalShadow },
     Tabs: { inkBarColor: colorPrimary, itemSelectedColor: colorTextBase },
   },
   ```
   如果 `colorFillSecondary`、`colorTextSecondary` 在该作用域里的变量名不一样，按文件里实际解构出的名字写。

**验收**：antd 组件的圆角是 6，卡片没有阴影，表头是 surface-muted 色。typecheck 通过，因为 `AntdThemeColors` 新键在两个常量里都补齐了。

### T8 · 背景去装饰（`components/aura-background.tsx` + `lib/aura-theme-tokens.ts`）

**现状**：3 个带 `blur-[110px]` 和 `animate-aura-*` 的动画光斑，按路由切换颜色。

**改法**：组件保留（`app/(app)/layout.tsx` 在用），返回值改为一个静态的、极淡的顶部纸面渐变：
```tsx
'use client';

import { usePathname } from 'next/navigation';

import { PAPER_BACKGROUND_GRADIENT } from '@/lib/aura-theme-tokens';

export function AuraBackground() {
  const pathname = usePathname();
  const isReadMode = pathname.includes('/read/') || pathname.match(/\/items\/\w+/);
  if (isReadMode) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      style={{ background: PAPER_BACKGROUND_GRADIENT }}
    />
  );
}
```
在 `lib/aura-theme-tokens.ts` 中新增：
```ts
/** FE-UI 批0：纸面背景——顶部极淡墨蓝晕染，替代动画光斑。用 CSS 变量以随主题切换。 */
export const PAPER_BACKGROUND_GRADIENT =
  'radial-gradient(120% 60% at 50% -10%, var(--aura-color-1) 0%, transparent 60%)';
```
同时把 `globals.css` 中 `--aura-color-1` 改为：亮色 `rgba(31, 59, 123, 0.05)`，暗色 `rgba(143, 176, 255, 0.06)`。

`AURA_BACKGROUND_COLORS` 改完后如果没有其他消费方（先 grep 确认），在常量上加 `/** @deprecated FE-UI 批0 后无消费方，留待 UI-5 删除 */`，**本批不删**。`tailwind.config.ts` 里的 `aura-*` 动画和 keyframes 也先保留，在报告中列为待清理。

### T9 · 关闭卡片光晕（`components/aura-bento-card.tsx`）

- 删掉光晕 `<div>`（`radial-gradient(... AURA_CARD_GLOW ...)` 那个），以及 `useCardGlow` 的 `ref` / `style` / `onMouseMove` 用法。组件变成纯展示：
  ```tsx
  export function AuraBentoCard({ children, className = '', squish = false, ...props }: AuraBentoCardProps) {
    const squishClass = squish ? 'transition-transform duration-150 active:scale-[0.99]' : '';
    return (
      <div className={`glass-card relative overflow-hidden ${squishClass} ${className}`} {...props}>
        <div className="relative h-full w-full">{children}</div>
      </div>
    );
  }
  ```
- `squish` 默认值从 `true` 改为 `false`（编辑风格不需要按压缩放）；props 接口不变。
- `hooks/use-card-glow.ts`：grep 一下还有没有别的消费方。没有就保留文件，加 `@deprecated` 注释，本批不删。

### T10 · 同步设计文档（`apps/web/docs/design-system.md`）

- §1 颜色表：新增 `bg-surface`、`bg-surface-muted`、`text-muted-foreground`、`border-border-strong` 四行。
- §2：圆角改为 `rounded`=6px、`rounded-lg`=10px；`shadow-panel` 改为随主题切换的 `--shadow-surface`。
- §3 排版：新增「字体分工」小节（衬线只给版面级标题，界面用无衬线，数字用等宽），并说明 `.kicker`。
- §4 卡片表面：把「玻璃态」改为「纸面卡片（实色 + 发丝线）」；新增 `.surface-inset`、`.section-rule`、`.hairline-b`；写明「禁止卡中卡」。
- 文档开头加一行：`> FE-UI 批0（2026-11）起视觉方向为「情报编辑台」，详见 docs/refactor/frontend-ui-polish/README.md`。

## 禁止事项

- 不要修改任何 `app/**` 页面组件的 JSX。唯一的例外是 T2 补 `font-serif` 的那 5 处。
- 不要重命名 `.glass-card`、`.content-card`、`.glass-panel`、`.glass`。
- 不要删除 `AURA_BACKGROUND_COLORS`、`useCardGlow`、`aura-*` keyframes，只标 deprecated。
- 不要改 `--nav-*` 的尺寸 token，也不要改 `--top-nav-height` / `--ticker-height`。

## 自主优化授权

在 `globals.css` 内，如果发现某个规则硬编码了旧主题色 `#e2e8f0`（旧 border）或 `#f7f6f2`（旧 background），并且语义上就是「边框」或「页面底色」，可以替换为 `var(--border)` / `var(--background)`。每处都要在报告里列出行号。其他颜色留给 UI-5。

## 测试

纯样式改动，不新增测试。必须确保现有测试仍然通过。如果 `shell.test.tsx` 或 `top-nav.test.tsx` 断言了 `glass` 之类的类名，类名没改，应该不受影响。

## 验证与提交

按 README §5 执行。commit 示例：
`💄 style(web): FE-UI 批0 风格基座——纸墨 token、实色纸面卡片、antd 主题对齐与背景去装饰`

## 人工冒烟清单（附在报告里给用户）

| 页面 | 看什么 |
|---|---|
| `/today` | 卡片是近白纸面加细边框，没有模糊和发光；背景只有顶部一抹极淡的晕染 |
| `/alerts`、`/events` | antd Button / Input / Select 圆角是 6px；卡片标题是无衬线 |
| `/admin/quality` | 表头底色是暖灰（surface-muted），行 hover 同色 |
| `/read/items/<任意 id>` | 文章大标题仍然是衬线 |
| 切换暗色 | 页面深墨底，卡片 `#141a22`，文字暖白，没有残留 indigo 光晕 |
