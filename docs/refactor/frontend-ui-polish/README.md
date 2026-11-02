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

```
UI-0 ─┬→ UI-1 ─────────┬→ UI-3A ┐
      ├→ UI-2A ────────┘        │
      └→ UI-2B ─┬→ UI-3B ───────┼→ UI-4 → UI-5 → UI-6
                └→ UI-3C ───────┘
UI-7 独立
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
