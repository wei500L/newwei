# 前端视觉打磨（FE-UI）：审查结论与分批执行提示词

> 生成：2026-11-02 · 基线 commit `bdbb581a` · 方式：纯静态审查（未启动应用、未截图）
> 读者：执行各批次的编码模型（参数较小）。**每个批次文件都是一份可直接投喂的完整提示词**，但都依赖本 README 的 §3（视觉规范）与 §4（通用硬约束）——开工前必须先读完本文件。

---

## 1. 为什么要做

`apps/web` 的问题主要出在**缺少共享原语**和**风格互相冲突**，而不是某几个页面写得差：

| 问题 | 证据 |
|---|---|
| 没有统一页头 | 页头有 8 种写法：`Typography.Title level={3}` / `level={4}`，有的写 `style={{margin:0}}` 有的不写，Card `title` 当页头，手写 `<h1>` 有 3 种字号；全站几乎没有 h1。`PageContainer` 只有 2 处使用 |
| 两套视觉语言在打架 | token 是「暖纸底 `#f7f6f2` + 墨蓝 `#1f3b7b` + 衬线标题」（编辑部气质），但卡片是玻璃拟态（`backdrop-filter: blur(28px)` + 三层阴影，`globals.css:197-238`），背景有 3 个动画光斑（`components/aura-background.tsx`），卡片还跟随鼠标发光（`aura-bento-card.tsx`） |
| 标题字体失控 | `globals.css:168-175` 让 `h1–h6` 都是衬线，antd `Typography.Title` 渲染的也是 h1–h5，所以卡片里的小标题也成了衬线 |
| antd 与 Tailwind 尺度不一致 | body 没设字号（默认 16px），antd 用 14px；Button 圆角 8，全局 10；Tailwind `rounded-lg`（14px）比 `rounded-xl`（12px）还大；卡片阴影有三套 |
| 硬编码泛滥 | TSX 里 `style={{` 约 1100 处（admin 359、crawl 270、dashboard 150），hex/rgba 数百处，`text-[11px]` 这类任意字号约 200 处 |

已核实的布局 bug，分别由 UI-2A / UI-2B 处理：
1. `app/(app)/today/today-content.tsx:44` 用的 `aura-bento-grid` 类全仓没有定义，Today 页的栅格完全不生效。
2. `dashboard/components/dashboard-nav.tsx:25-28` 和 `finance/finance-nav.tsx:23-26` 进入任何子页后，Tab 高亮都停在「总览/市场」。
3. `alerts/alert-event-row.tsx:176-178` 写死 `#fff`，暗色模式下告警行是白块。
4. `shell.tsx:90` 的 `scrollbar-thin`（缺插件）和 `dashboard-content.tsx:735` 的 `animate-in fade-in`（缺插件）都是无效类。
5. `items/items-view.tsx:2475` 自带卡片外壳加 24px 内边距，嵌进 Today/RSS/Search 时变成卡中卡、内边距叠三层。
6. 没有任何 `error.tsx` / `not-found.tsx`；外壳用 `h-screen`，iOS 上底部被截；ticker 和通知中心没有暗色；dashboard 概览右栏在宽度不足 1280px 时直接消失。
7. 约 55 个 antd Table 里只有 10 个设了 `scroll.x`；9 个以上 Drawer 固定宽度 560–1320px；多处工具栏不换行。

## 2. 批次总览与依赖

| 批次 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| UI-0 | [UI-0-style-foundation.md](UI-0-style-foundation.md) | 风格基座：token、字体、表面类、antd 主题、背景去装饰 | 无 |
| UI-1 | [UI-1-page-primitives.md](UI-1-page-primitives.md) | PageHeader / SectionHeader / FilterBar / error / not-found | UI-0 |
| UI-2A | [UI-2A-layout-bugs-shell-content.md](UI-2A-layout-bugs-shell-content.md) | 布局 bug：外壳 + 内容页 + 登录 | UI-0 |
| UI-2B | [UI-2B-layout-bugs-data-pages.md](UI-2B-layout-bugs-data-pages.md) | 布局 bug：dashboard / finance / crawl | UI-0 |
| UI-3A | [UI-3A-header-adoption-content.md](UI-3A-header-adoption-content.md) | 页头迁移：内容页 | UI-1、UI-2A |
| UI-3B | [UI-3B-header-adoption-monitoring.md](UI-3B-header-adoption-monitoring.md) | 页头迁移：看板 / 金融 / 态势 / 地图 / 图谱 / 分析 | UI-1、UI-2B |
| UI-3C | [UI-3C-header-adoption-admin.md](UI-3C-header-adoption-admin.md) | 页头迁移：admin / crawl | UI-1、UI-2B |
| UI-4 | [UI-4-tables-drawers-toolbars.md](UI-4-tables-drawers-toolbars.md) | 表格 / 抽屉 / 工具栏响应式 | UI-3A/B/C 全部合入 |
| UI-5 | [UI-5-dark-mode-color-cleanup.md](UI-5-dark-mode-color-cleanup.md) | 暗色与硬编码颜色清理 | UI-4 |
| UI-6 | [UI-6-signature-pages.md](UI-6-signature-pages.md) | 招牌页面：Today 头版 / Dashboard 概览 / 登录 | UI-5 |
| UI-7 | [UI-7-optional-antd-ssr-registry.md](UI-7-optional-antd-ssr-registry.md) | 可选：antd SSR 样式注册（要新增依赖） | **用户确认后**才执行 |
| UI-8A | [UI-8A-global-leaks.md](UI-8A-global-leaks.md) | 补漏：antd 静态提示跟主题、图表纸墨配色、slate/gray 色阶变暖 | UI-0~7 全部合入 |
| UI-8B | [UI-8B-newsnow-newshub.md](UI-8B-newsnow-newshub.md) | 补漏：NewsNow 模块与 News Hub 去玻璃/霓虹，修亮色不可见 | UI-0~7 全部合入 |
| UI-8C | [UI-8C-legacy-css-families.md](UI-8C-legacy-css-families.md) | 补漏：globals/CSS Module 遗留样式族、events-archive、24 个表格滚动等 | UI-0~7 全部合入 |
| UI-9A | [UI-9A-global-primitives-shell.md](UI-9A-global-primitives-shell.md) | 版面纪律打底：antd 预设色收敛、DataStateBoundary 间距 bug、外壳去玻璃、错误页、阅读正文排版、死代码 | UI-8 全部合入；**先单独合入** |
| UI-9B | [UI-9B-dashboard.md](UI-9B-dashboard.md) | dashboard：窄列溢出、卡中卡、Tag 墙、战争地图浮层 | UI-9A |
| UI-9C | [UI-9C-content-main-path.md](UI-9C-content-main-path.md) | Today / Items / Alerts / Search / Events / 归档 / 话题 | UI-9A |
| UI-9D | [UI-9D-situation-newsnow.md](UI-9D-situation-newsnow.md) | 态势监控 + NewsNow | UI-9A |
| UI-9E | [UI-9E-admin-crawl.md](UI-9E-admin-crawl.md) | admin + crawl：整页大卡、多层嵌套、窄屏、主按钮、i18n | UI-9A |
| UI-9F | [UI-9F-settings-shared-components.md](UI-9F-settings-shared-components.md) | components/：settings 面板去卡中卡、共享组件去玻璃 | UI-9A |
| UI-9G | [UI-9G-remaining-pages.md](UI-9G-remaining-pages.md) | 登录 / 门户 / 助手 / 图谱 / 欢迎 / 安全 / 个人 / 实体 / 订阅 | UI-9A |
| UI-10A | [UI-10A-js-color-sources-events.md](UI-10A-js-color-sources-events.md) | `.ts` 里的 JS 色源（图谱 / 状态 / 情感 / 图表兜底）对齐纸墨；`/events` 列表行去玻璃 | UI-9 全部合入 |
| UI-10B | [UI-10B-crawl-frontier-quality.md](UI-10B-crawl-frontier-quality.md) | workflow-studio 四层嵌套、crawl-frontier 彩色 Tag 与英文表单、质量页 `window.prompt` | UI-9 全部合入 |
| UI-10C | [UI-10C-residual-i18n-polish.md](UI-10C-residual-i18n-polish.md) | 分析看板 / 邀请与 SSO / NewsNow 头部文案；大圆角、小字号、图标按钮 aria-label | UI-9 全部合入 |
| UI-11 | [UI-11-details-title-time-reading.md](UI-11-details-title-time-reading.md) | 细节：标签页标题、时间统一走应用时区、正文行宽、favicon、不生效的 `[var()]/NN` 类 | UI-10 全部合入 |
| UI-12A | [UI-12A-tail-components.md](UI-12A-tail-components.md) | `components/**`：Tag 颜色、颜色映射、裸 Empty、内联 margin 按 §3.6 收尾 | UI-11 合入 |
| UI-12B | [UI-12B-tail-admin-crawl.md](UI-12B-tail-admin-crawl.md) | `admin/**`、`crawl/**`：同上 | UI-11 合入 |
| UI-12C | [UI-12C-tail-app-pages.md](UI-12C-tail-app-pages.md) | 其余 `app/**` 页面：同上 | UI-11 合入 |

```
UI-0 ─┬→ UI-1 ─────────┬→ UI-3A ┐
      ├→ UI-2A ────────┘        │
      └→ UI-2B ─┬→ UI-3B ───────┼→ UI-4 → UI-5 → UI-6
                └→ UI-3C ───────┘
UI-7 独立
UI-6 + UI-7 → ┬ UI-8A
              ├ UI-8B   （三者并行，文件互不相交）
              └ UI-8C
UI-8 → UI-9A → ┬ UI-9B ┬ UI-9C ┬ UI-9D
                ├ UI-9E ┼ UI-9F ┴ UI-9G   （六者并行，目录互不相交）
UI-9 → ┬ UI-10A
       ├ UI-10B   （三者并行，文件互不相交）
       └ UI-10C
UI-10 → UI-11 → ┬ UI-12A
               ├ UI-12B   （三者并行，目录互不相交）
               └ UI-12C
```

可以并行的组合：UI-1、UI-2A、UI-2B 三者并行（都在 UI-0 合入后开工）；UI-3A、UI-3B、UI-3C 三者并行，它们改的目录互不相交。

---

## 3. 视觉规范：「情报编辑台 / Broadsheet Intelligence Desk」

**方向**：报纸版式 × 情报简报。不走企业控制台风格，也不再用玻璃拟态。层次靠**线条和字体**建立，不靠模糊、阴影和光效。

> **视觉参考（用户已确认）**：[`style-preview.html`](style-preview.html)，单文件，用浏览器直接打开即可，右下角可切换亮暗。它和本节的 token 一一对应，涵盖外壳、Today 头版、数据带、列表页、登录卡片几种场景。拿不准某个细节该长什么样时，以这个文件为准。同目录下其余的 `style-preview-*.html` 是被否决的备选方案，**不要参考**。

### 3.1 设计原则（每一批都要遵守）

1. **纸与墨**：页面是暖纸底，卡片是近白的纸面，正文是墨色。卡片用 1px 发丝线描边，阴影几乎为零。
2. **栏线**：重要区块的顶部加一条 2px 墨色粗线（`.section-rule`），像报纸的栏目分隔线。
3. **字体分工**：
   - 衬线（`font-serif`）**只**用于版面级标题：PageHeader 的 h1、文章/头条标题、Today 报头。
   - 其余界面一律无衬线（`font-sans`）：卡片标题、表单、按钮、表格。
   - 数字、时间、代码一律等宽并对齐（`font-mono tabular-nums`）。
4. **眉题（kicker）**：标题上方加一行 11px、全大写、字距 0.08em 的灰色小字（`.kicker`），标明栏目，例如「事件与态势」「管理」。
5. **信号色要克制**：
   - 墨蓝 `--primary`：主操作、选中态。
   - 琥珀 `--accent`：实时 / 信号 / 新。
   - 朱红 `--destructive`：突发、告警、危险。
   - 涨跌只用 `--bullish` / `--bearish`。
   - 一个区块里出现的强调色不超过 2 种。
6. **圆角**：控件和卡片 6px，大容器 10px，不再用 14/18/24/28px 的大圆角。
7. **间距节奏**：页面根节点用 `flex flex-col gap-6`；卡片内用 `gap-4`；表单项和工具栏用 `gap-3`。不准用 `style={{ marginTop: ... }}`。
8. **夜班模式（暗色）**：深墨底配暖白字，线条语言与亮色完全一致。

### 3.2 Token 表（UI-0 照抄，这里是唯一真源）

**CSS 变量（`app/globals.css`）**

| 变量 | 亮色 `:root` | 暗色 `.dark` | 用途 |
|---|---|---|---|
| `--background` | `#f5f3ee` | `#0d1117` | 页面纸底 |
| `--surface` **（新）** | `#fffdf9` | `#141a22` | 卡片纸面 |
| `--surface-muted` **（新）** | `#f0ede6` | `#1a212b` | 表头、内嵌区块、hover |
| `--foreground` | `#161b26` | `#e8e4da` | 正文墨色 |
| `--muted-foreground` **（新）** | `#5a6270` | `#9aa3af` | 次要文字（对比度 ≥4.5:1） |
| `--primary` | `#1f3b7b` | `#8fb0ff` | 墨蓝 |
| `--primary-foreground` | `#ffffff` | `#0d1117` | |
| `--secondary` | `#efece5` | `#1b222c` | 次级面 / hover 面 |
| `--secondary-foreground` | `#4a5261` | `#c9ced6` | |
| `--accent` | `#b45309` | `#f59e0b` | 琥珀信号（亮色加深是为了让白字对比度 ≥4.5） |
| `--accent-foreground` | `#ffffff` | `#111827` | |
| `--destructive` | `#b91c1c` | `#f87171` | 朱红 |
| `--destructive-foreground` | `#ffffff` | `#111827` | |
| `--bullish` / `--bearish` | 不变 | 不变 | |
| `--border` | `#e3dfd6` | `#252d38` | 发丝线 |
| `--border-strong` **（新）** | `#161b26` | `#e8e4da` | 栏线（2px） |
| `--input` | `#d9d4c9` | `#2c3542` | 输入框边框 |
| `--ring` | `#1f3b7b` | `#8fb0ff` | 焦点环 |
| `--radius` | `6px` | — | 控件 / 卡片 |
| `--radius-lg` | `10px` | — | 大容器 |
| `--shadow-surface` **（新）** | `0 1px 2px rgba(22, 27, 38, 0.04)` | `none` | 卡片阴影 |
| `--ticker-bg` **（新）** | `#161b26` | `#1a212b` | 电讯条底色 |
| `--ticker-fg` **（新）** | `#f5f3ee` | `#e8e4da` | 电讯条文字 |
| `--ticker-muted` **（新）** | `#a8adb8` | `#9aa3af` | 电讯条次要文字 |

`--aura-color-1/2`、`--command-bar-*`、`--nav-*`、`--auth-*` 的处理方式见 UI-0 / UI-6，本表不涉及。

**字体栈**

```css
--font-sans:
  ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC",
  Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
--font-serif:
  "Iowan Old Style", "Charter", Georgia, "Source Han Serif SC", "Noto Serif SC",
  "Songti SC", "STSong", "Times New Roman", serif;
```

**antd `theme.token`（`lib/antd-theme-tokens.ts` + `app/providers.tsx`）**

| token | 亮色 | 暗色 |
|---|---|---|
| `colorPrimary` | `#1f3b7b` | `#8fb0ff` |
| `colorBgBase` / `colorBgLayout` | `#f5f3ee` | `#0d1117` |
| `colorBgContainer` | `#fffdf9` | `#141a22` |
| `colorBgElevated` | `#fffdf9` | `#1a212b` |
| `colorBgSpotlight` | `rgba(22, 27, 38, 0.95)` | `rgba(2, 6, 23, 0.98)`（不变） |
| `colorTextBase` | `#161b26` | `#e8e4da` |
| `colorTextSecondary` | `#5a6270` | `#9aa3af` |
| `colorTextPlaceholder` | `#7a8190` | `#7d8692` |
| `colorFillSecondary` | `#efece5` | `#1b222c` |
| `colorBorder` | `#d9d4c9` | `#2c3542` |
| `colorBorderSecondary` **（新增键）** | `#e3dfd6` | `#252d38` |
| `fontSize` | `14` | 同 |
| `borderRadius` / `borderRadiusLG` / `borderRadiusSM` | `6` / `10` / `4` | 同 |

`components` 部分：

- `Card`：`boxShadow: "none"`，`borderRadiusLG: 10`，`headerFontSize: 15`
- `Button`：`borderRadius: 6`，`controlHeight: 34`，`primaryShadow: "none"`，`defaultShadow: "none"`
- `Table`：`headerBg` = surface-muted，`headerColor` = muted-foreground，`borderColor` = border，`rowHoverBg` = surface-muted
- `Modal`：`borderRadiusLG: 10`
- `Tabs`：`inkBarColor` = primary，`itemSelectedColor` = foreground

### 3.3 新工具类（UI-0 加入 `globals.css` 的 `@layer utilities`）

```css
.kicker {            /* 栏目眉题 */
  font-size: 11px; line-height: 16px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted-foreground);
}
.section-rule {      /* 栏线：区块顶部 2px 墨线 */
  border-top: 2px solid var(--border-strong);
  padding-top: 12px;
}
.hairline-b { border-bottom: 1px solid var(--border); }  /* 列表分隔线 */
.surface-inset {     /* 卡片里的子区块：用它代替「卡中卡」 */
  background: var(--surface-muted);
  border-radius: var(--radius);
  padding: 12px 16px;
}
```

Tailwind 新增的映射（UI-0）：`bg-surface`、`bg-surface-muted`、`text-muted-foreground`、`border-border-strong`。

### 3.4 什么时候用哪种表面

| 场景 | 用法 |
|---|---|
| 页面里的一级区块 | `.content-card`（或 `<Card className="content-card">`）；UI-0 之后它就是纸面卡片 |
| 卡片里还要再分组 | `.surface-inset` 或 `<div className="hairline-b pb-3">`。**禁止** Card 里再套 Card |
| 需要强调的区块标题 | 在 `<SectionHeader>` 上加 `rule`（`.section-rule`） |
| 监控面板 | `.glass-panel`，类名保留，UI-0 后视觉与 content-card 一致，只是少了阴影 |

### 3.5 版面纪律（UI-9 起强制，所有批次复查时都按这几条判）

**A. 嵌套：一页只有一层卡片**
- 页面根：`<div className="flex flex-col gap-6">`，子元素是 `PageHeader` + 若干**同级** `content-card`。页面根本身**不得**是 `content-card`。
- 卡片内部分组：`SectionHeader`（可加 `rule`）+ 内容；或 `.surface-inset`；或 `hairline-b` 分隔的列表。**不得**再放 `<Card>`（包括 `size="small"`、`type="inner"`）、不得再放带 `border + rounded` 的 div 框。
- 外壳已有边框的容器（如 admin 设置分区的 `.settings-section-shell`）里，面板根节点同样不能是 Card。
- 间距只靠父级 `gap-*`；子元素**不写** `mb-*` / `mt-*` / `style={{ marginTop|marginBottom }}` / `space-y-*` 与 gap 叠加。

**B. 状态：只用三个原语**
| 状态 | 用法 |
|---|---|
| 首次加载 / 空 / 阻塞错误 / 刷新 / 非阻塞错误 | `<DataStateBoundary state={…} onRetry={…}>` |
| 卡片或图表内部的空态、错误态 | `<ChartEmptyState>` |
| 页面或区块顶部的错误条 | `<RequestErrorBanner>` |
禁止：手写 `<div style={{display:"flex",justifyContent:"center"}}><Spin/></div>`、裸 `<Empty/>`、`<Text type="danger">{error.message}</Text>`、数据为空时 `return null` 让区块消失。

**C. Tag 与颜色：信息中性，只有状态上色**
- 描述「是什么」的 Tag（主题、实体、来源、地区、类型、模型名、策略名、计数）→ **不传 color**（默认中性）。类别靠前缀文字或图标区分，不靠颜色。
- 描述「怎么样」的 Tag（成功、失败、警告、进行中、突发、过期）→ 只用 `success` / `warning` / `error` / `processing`。
- 一行最多 **2 个**带色 Tag。数值不要塞进 Tag，改用 `<span className="font-mono text-xs text-muted-foreground">`。
- 禁止用 `blue`/`geekblue`/`purple`/`cyan`/`magenta`/`lime`/`volcano`/`gold` 作装饰。

**D. 按钮主次**
- 一个可视区块（一张卡片 / 一个工具栏 / 一个弹窗 footer）最多 **1 个** `type="primary"`。
- 「刷新」「重置」「导出」一律 default；列表每行的操作一律 `type="link"` 或 `type="text"`。

**E. 可访问与窄屏**
- 可点击元素用 `<Link>` / `<Button>`；不得在 `div`/`Tag`/`List.Item` 上直接挂 `onClick` 而不加 `role` + `tabIndex` + `onKeyDown`。
- 只有图标的按钮必须有 `aria-label`（文本走 `t()`），最好再包 `Tooltip`。
- 横向控件组（Space / flex）必须能换行（`Space wrap` 或 `flex-wrap`）。`<Col span>` 必须带 `xs={24}`。Modal 宽度写 `"min(Npx, calc(100vw - 32px))"`，不写 `screens.md ? N : "100%"`。

### 3.6 收尾换算表（UI-12 起使用，§3.5-C 与 §3.5-A 间距规则的机械执行版）

**A. Tag 颜色换算**：先判断这个 Tag 表达的是「怎么样」（状态）还是「是什么」（信息），再查表。**看 Tag 里显示的文字或 i18n key 来判断，不看原来的颜色**。

| 语义（看文字 / key） | 例子 | 新 color |
|---|---|---|
| 成功、正常、已启用、在线、健康、已完成、通过、active、ok、healthy、enabled、success、completed、passed | `common.ok`、`common.enabled`、`active` | `"success"` |
| 失败、错误、阻断、离线、拒绝、严重、critical、failed、error、blocked、rejected、offline | `common.failed`、`blocked` | `"error"` |
| 警告、降级、延迟、待处理、即将过期、重试中、warning、degraded、pending、delayed、expiring、retrying | `pending`、`degraded` | `"warning"` |
| 运行中、处理中、同步中、排队、running、processing、syncing、queued | `running` | `"processing"` |
| 已停用、未知、跳过、草稿、disabled、unknown、skipped、draft、inactive | — | **不传 color** |
| 其它一切：来源、类型、类别、模型名、供应商、操作名、指纹、版本、区域、主题、实体、计数、维度 | `operationLabelMap[x]`、`record.fingerprint`、`source.db` | **不传 color** |
| 严重度分级 low / medium / high / critical | — | low 不传，medium → `"warning"`，high / critical → `"error"` |

**颜色映射函数 / 常量**（例如 `function statusColor(x) { return x === "ok" ? "green" : "red"; }`、`const COLORS = { running: "blue", … }`）：

1. **先 grep 它的所有使用处**。只有当它的返回值**只**传给 `<Tag color>`（或 antd `Badge`、`Tag.CheckableTag` 的 color）时才改；如果同时喂给地图标记、图表、`style`、`className`，**一律不改**，在报告里列出。
2. 改法：按上表把返回值换成 `"success"` / `"error"` / `"warning"` / `"processing"` / `undefined`。返回类型如果写死了字符串联合，改成 `TagProps["color"]`（`import type { TagProps } from "antd"`）或 `string | undefined`。
3. 函数名、参数、调用方都不改。

**数字进 Tag**：`<Tag>{n}</Tag>`、`<Tag>judge:{n}</Tag>` 这种只为显示一个数值的 Tag → `<span className="font-mono text-xs text-muted-foreground">…</span>`。拿不准是否改变了布局（比如在表格 render 里），保留 Tag，只去掉 color。

**B. 内联 margin 换算**：

| 原值 | Tailwind（普通元素） | antd 组件上（Typography / Space / Alert / Form / Divider / Card / Button） |
|---|---|---|
| `0` | `m*-0` | `!m*-0` |
| `4` | `m*-1` | `!m*-1` |
| `6`、`8`、`"0.5rem"` | `m*-2` | `!m*-2` |
| `10`、`12`、`"0.75rem"` | `m*-3` | `!m*-3` |
| `16`、`"1rem"` | `m*-4` | `!m*-4` |
| `20`、`24`、`"1.5rem"` | `m*-6` | `!m*-6` |
| `32`、`"2rem"` | `m*-8` | `!m*-8` |
| `"8px 0"` / `"12px 0"` | `my-2` / `my-3` | `!my-2` / `!my-3` |
| `"8px 0 4px"` | `mt-2 mb-1` | `!mt-2 !mb-1` |

`m*` 指 `mt` / `mb` / `ml` / `mr` / `mx` / `my` / `m`，按原来的方向替换（`marginBottom` → `mb`，`marginTop` → `mt`，`margin` → `m`）。antd 组件要加 `!` 是因为 antd 的运行时样式可能排在 Tailwind 之后，不加会被覆盖。

- 如果这个元素的**父级已经是 `flex flex-col gap-*` 或 `Space`**，非零的 margin 直接**删掉**（间距交给父级），不要换算。
- `style` 里除 margin 外还有别的属性（如 `whiteSpace`、`fontFamily`），只把 margin 移进 className，其余保留在 style；`fontFamily: "monospace"` 顺手换成 `font-mono` 类。
- 原元素已有 `className`，就追加到同一个 className 字符串里，不要写两个 className。
- **不改**：值是变量或表达式的 margin（`marginTop: gap`）、`Modal` / `Drawer` / `Table` 的 `styles` / `bodyStyle` 对象、echarts option 里的 `margin`。

**C. 裸 `<Empty>`**：

| 位置 | 改法 |
|---|---|
| 卡片、区块、列表、Tab 内容里的空态 | `<ChartEmptyState presentation="banner" description={原 description} />` |
| 整页 / 整个抽屉的「找不到」「无权限」 | `<ChartEmptyState description={…} />`（默认 center） |
| `Table` / `List` 的 `locale={{ emptyText: … }}`、`Select` 的 `notFoundContent` | **保留** antd 的 Empty |

---

## 4. 通用硬约束（所有批次）

1. **只动展示层**。不改数据请求、GraphQL 文档（`graphql/`）、hooks 的业务逻辑、权限判断、路由路径、REST 调用。组件对外 props 可以**新增可选项**，不能改已有 props 的语义。
2. **不新增依赖**：不执行 `pnpm install` / `pnpm add`，不启动 dev server / docker。UI-7 例外，且须用户确认。
3. **Tailwind JIT 铁律**：禁止类名插值，如 `` `bg-[${color}]` `` 或 `` `w-[${n}px]` ``。条件类要写完整字面量，例如 `active ? "bg-primary text-primary-foreground" : "text-muted-foreground"`。
4. **颜色只用 token**：DOM 上用 Tailwind token 类或 `var(--xxx)`；canvas、SVG 属性、echarts、antd theme 里用 `lib/*-tokens.ts` 中的常量。新颜色先加进 token 再引用。
5. **i18n**：新增的可见文字一律 `t("...")`，并在 `apps/web/lib/locales/zh.json` 和 `en.json` 的**同一路径**下都加上 key。改完跑 `node apps/web/scripts/i18n-check.js`；本机不能跑就人工确认两边 key 一致。
6. **暗色**：每个浅色 `bg-white` / `text-slate-*` / `border-slate-*` 都要配 `dark:` 变体，或者直接改用 token 类（`bg-surface`、`text-muted-foreground`、`border-[var(--border)]`）。**优先用 token 类**，它们自带暗色。正文禁止用 `text-slate-400/500`。
7. **测试**：只写行为测试，用 `apps/web/test/render.tsx` 的 `renderWithProviders`，用 `screen.getByRole` / `getByText` 断言用户能看到的结果。禁止源码文本断言、禁止快照测试。新建的组件文件要加进 `apps/web/vitest.config.ts` 的 `coverage.include`，追加在数组末尾，并写注释 `// FE-UI 批N：...`。
8. **共享文件**（`zh.json`、`en.json`、`vitest.config.ts`、`globals.css`、`docs/design-system.md`）只追加或局部替换，禁止整文件重排或格式化。并行批次合并冲突时两边都保留。
9. **行号可能漂移**：提示词里的 `文件:行` 来自基线 `bdbb581a`。行号对不上时，按贴出的「现状代码片段」搜索定位；找不到就在报告里写「未找到」，不要猜。
10. **范围纪律**：只改本批列出的文件。看到同类问题，在本批文件内可以顺手修（报告里列出）；超出本批文件的写进报告的「建议后续」，不要动。
11. **不要大面积重写**：本系列是视觉打磨，不是重构。单个任务改动超过 150 行时停下来，在报告里说明原因。

## 5. 统一验证与提交流程

```bash
# 在仓库根目录。本机 node_modules 已就绪时才跑；禁止 pnpm install
pnpm --filter @modular/web lint
pnpm --filter @modular/web typecheck
pnpm --filter @modular/web test -- --coverage
node apps/web/scripts/i18n-check.js
```

- 本机跑不了的话：完成静态自查（逐个打开改过的文件，检查 import、类型、JSX 闭合），推送后以 GitHub Actions CI 结论为准。用 `gh run list --branch main --limit 3` 找到 run，再用 `gh run view <id> --json conclusion` 确认结果。**不要相信 `gh run watch` 的退出码**。
- 静态审查清单：
  - 类型和 props 契约没变；
  - 没有残留未使用的 import；
  - 条件渲染的 loading / empty / error 分支都还在；
  - 没有引入 `any`；
  - Tailwind 类都是字面量。
- 提交：直接在 `main` 上提交并推送（仓库惯例），中文 emoji 加 `type(scope)` 格式，例如 `💄 style(web): FE-UI 批0 风格基座——纸墨 token、实色纸面卡片与 antd 主题对齐`。只 `git add` 本批改动的文件；禁止 amend / rebase / force-push；工作区里的其他无关改动不要理会。

## 6. 人工冒烟清单模板（每批报告末尾附上，供用户在浏览器里检查）

每个指定页面都按 **亮色 / 暗色 × 375 / 768 / 1280 / 1920 宽** 检查：

- [ ] 没有横向滚动条，文字没有溢出容器，长标题有截断或换行
- [ ] 页头样式一致：眉题、衬线 h1、说明文字、右侧操作区，窄屏下操作区换行
- [ ] 卡片是纸面加发丝线，没有卡中卡，没有白块（暗色下特别注意）
- [ ] 表格在窄屏能横向滚动，Drawer 不超出屏幕
- [ ] 加载、空、错误三种状态能区分，不会同时出现

## 7. 报告格式（每批完成后输出）

```markdown
## FE-UI 批N 执行报告
- 提交：<sha> <message>
- 验证：lint ✅/❌/未跑（原因） · typecheck … · test … · CI run <id> conclusion=<…>
### 任务状态
| # | 任务 | 状态（完成/部分/跳过） | 改动文件 | 备注 |
### 自主补充（本批文件内顺手修的同类问题）
### 未完成与原因
### 建议后续（超出本批范围的发现）
### 人工冒烟清单
```
