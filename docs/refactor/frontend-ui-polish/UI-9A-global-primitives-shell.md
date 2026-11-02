# FE-UI 批9A：全局单点修复与外壳收尾

> **一句话目标**：先用几个影响全站的单点改动打底，包括 Tag 预设色去饱和、DataStateBoundary 打断间距的 bug、外壳残留的玻璃和大圆角、错误页风格、阅读页排版、死代码。之后的 UI-9B ~ 9F 都建立在这一批上。
>
> **依赖**：UI-0 ~ UI-8 已合入。**本批必须先单独合入**，之后 9B ~ 9F 可以并行。
>
> **开工前必读**：README §3（**尤其新增的 §3.5 版面纪律**）、§4、§5、§7；`style-preview.html`。
>
> **行号说明**：行号来自 2026-11-02 的审查快照，执行前先用片段定位。如果片段找不到，跳过该项并写进报告，不要猜。

---

## 任务 1：antd 预设色与状态色收敛到纸墨色板（`app/providers.tsx`）

**背景**：全仓有 397 处 `<Tag color="blue|geekblue|purple|cyan|…">`（blue 117、geekblue 95、purple 69、green 60、red 56、gold 53、orange 47、cyan 33…），主题里没有覆盖这些预设色的种子值，所以页面上依然是 antd 的默认高饱和彩虹色。逐个改调用点太多，先在主题层把种子色换成低饱和版本。各页面「不该上色的 Tag」由 9B ~ 9F 按 §3.5-C 再逐页清理。

**改法**：在 `antdTheme` 的 `token` 对象里追加以下字段。亮色和暗色共用同一组种子值，暗色由 `darkAlgorithm` 自动派生：

```ts
// FE-UI 批9A：antd 预设色种子（Tag color="blue" 等）改为纸墨低饱和版本；
// 状态色对齐 --bullish / --accent / --destructive / --primary。
colorSuccess: "#1b9e77",
colorWarning: "#b45309",
colorError: "#b91c1c",
colorInfo: "#1f3b7b",
blue: "#2f5597",
geekblue: "#3b4f8f",
purple: "#5b4b8a",
cyan: "#0f766e",
green: "#2f7d5b",
red: "#b91c1c",
volcano: "#c2410c",
orange: "#b45309",
gold: "#a16207",
yellow: "#a16207",
lime: "#4d7c0f",
magenta: "#9f1239",
pink: "#9f1239",
```

- 如果 TypeScript 报 `blue` 等不是 token 字段（antd 5.28 的 `SeedToken` 包含这些预设色，正常不会报），先停下，把报错贴进报告。
- `colorPrimary` 保持不动。

**验收**：`/events`、`/admin/ops/crawl-frontier`、`/situation-monitor` 上的彩色 Tag 都变成低饱和的墨蓝、琥珀、青绿等颜色，暗色下也可读。

## 任务 2：修 DataStateBoundary 打断父级 gap 的 bug（`components/data-state-boundary.tsx`）

**现状**（约 :126-145）：`ready` 状态返回 `<>{children}</>`；但 `refreshing` 和 `nonBlockingError` 会返回 `<div className={className}>…</div>`。调用方大多不传 className，于是 children 被一个无样式的 div 包住，父级 `flex flex-col gap-6` 的间距对里面的多个区块失效，区块贴在一起，状态切换时布局还会跳。已确认受影响的有 `/alerts`（`alerts/alert-center.tsx:405`），其它调用 DataStateBoundary 的页面同理。

**改法**：这两个分支在调用方没传 className 时默认用 `contents`，让包裹层不参与布局：

```tsx
case "refreshing":
  return (
    <div aria-busy="true" className={className ?? "contents"}>
      {children}
    </div>
  );
case "nonBlockingError":
  return (
    <div className={className ?? "contents"}>
      <RequestErrorBanner … />
      {children}
    </div>
  );
```

不要动 `loading`、`empty`、`error` 分支已有的 `className ?? "h-auto py-10"` 默认值。

**测试**：在已有的 data-state-boundary 测试文件里追加一个用例（文件不存在就新建 `components/data-state-boundary.test.tsx` 并加入 coverage.include）。渲染 `state={{ kind: "nonBlockingError", error: new Error("x") }}`（状态结构以组件实际类型为准），断言错误横幅和 children 文本都可见。

## 任务 3：外壳残留旧风格（`app/(app)/components/*`、`app/globals.css`）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `action-rail.tsx:58` | `glass-panel rounded-2xl border border-[var(--border)] shadow-panel` | `rounded-lg border border-[var(--border)] bg-surface`（去掉 glass-panel 和 shadow-panel） |
| `mobile-nav-drawer.tsx:60` | `rounded-2xl` | `rounded-lg` |
| `app/globals.css:30` 附近 | `--rail-item-radius: 0.75rem` | `--rail-item-radius: var(--radius)`（6px） |
| `command-bar.tsx:152-157` | `rounded-[inherit] px-3.5 backdrop-blur-xl` + `shadow-[0_14px_36px…]` | 删除 `backdrop-blur-xl` 和所有自定义 `shadow-[…]`；底色 `bg-surface`，边框 `border border-[var(--border)]`，聚焦态 `focus-within:border-[var(--ring)]` |
| `system-defcon.tsx:49-50` | `bg-white/70 … shadow-[0_6px_18px…]`、`tracking-[0.2em]` | `bg-surface border border-[var(--border)]`，去阴影；小标签改 `kicker` 类 |
| `command-bar.tsx:240-244` | 搜索结果行是 `<div onClick>` | 加 `role="option"`、`tabIndex={-1}`、`aria-selected`（若已有高亮索引）；回车已由输入框处理的话不需要 onKeyDown。在报告中说明键盘路径 |
| `notification-center.tsx:289-292` | `List.Item` 上挂 onClick | 内部内容包一个 `<button type="button" className="w-full text-left">`，或给 List.Item 加 `role="button" tabIndex={0} onKeyDown`（Enter/Space 触发同一回调） |
| `ticker-tape.tsx:100,130` | `` `Range ${range}` `` 硬编码英文 | 改 `t("ticker.range", { range })`，zh：「区间 {{range}}」 |
| `ticker-tape.tsx:145` | 涨跌百分比 | 加 `font-mono tabular-nums` |
| `top-nav-actions.tsx:68-73,103-111` | 只有图标的按钮 | 包 `<Tooltip title={t(...)}>`，并加 `aria-label`（复用已有文案 key） |

## 任务 4：共享的时间范围控件不换行（`components/time-range-controls.tsx:121-138`）

横向 `<Space>` 里放了 7 段 Segmented 和 RangePicker，375px 宽度下会溢出。改为 `<div className="flex flex-wrap items-center gap-3">`；Segmented 的父级加 `max-w-full overflow-x-auto`，避免单个 Segmented 本身比屏幕还宽。

## 任务 5：错误页与 404 统一为报纸风

- `app/(app)/error.tsx`：去掉 antd `Result`，按 `app/(app)/not-found.tsx` 的结构重写：`kicker`（文字用 `t("common.pageError.kicker")`，zh「出错了」，en "Error"）+ 衬线 `h1`（`common.pageError.title`）+ 描述 + `<Button type="primary" onClick={reset}>`。`captureClientError` 保持不动。
- 新建 `app/global-error.tsx`（根布局崩溃时的兜底）。按 Next.js 要求，它必须自己渲染 `<html><body>`，并且拿不到 Providers 和 i18n，所以文案写成中英双语的静态文本：

```tsx
"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: "#f5f3ee", color: "#161b26", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5a6270" }}>Error · 出错了</p>
          <h1 style={{ margin: 0, fontFamily: "Georgia, 'Songti SC', serif", fontSize: 24 }}>页面加载失败 / Something went wrong</h1>
          <button type="button" onClick={reset} style={{ marginTop: 8, padding: "6px 14px", borderRadius: 6, border: "1px solid #161b26", background: "#161b26", color: "#fff", cursor: "pointer" }}>
            重试 / Retry
          </button>
        </main>
      </body>
    </html>
  );
}
```

  这是全仓唯一允许写死色值的文件，原因是拿不到 CSS 变量，要在文件顶部注释里说明。

## 任务 6：阅读页（`app/(reader)/`）回归 token，并补上正文排版

- `(reader)/layout.tsx:17`：`bg-[#fafafa] dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100` → `bg-[var(--background)] text-[var(--foreground)]`。
- `read/items/[id]/page.tsx:92-94`（阅读主题配置）、`:393`（`backdrop-blur-md` 工具栏）、`:500`（`bg-blue-500`）：
  - blur 删掉，改成 `bg-[var(--background)] border-b border-[var(--border)]`。
  - `bg-blue-500` → `bg-[var(--primary)]`。
  - 阅读主题里的「纸色 / 夜间」等选项值，如果是写死的色值，可以保留：这是用户可选的阅读主题，属于功能。在报告中说明保留了哪些。
- `:659-755` AI 区块用 violet、要点用 blue 的底色和边框 → `surface-inset`；小标题改 `kicker`。
- `:792` `prose dark:prose-invert` **完全不生效**，因为 Tailwind 没装 typography 插件。不要装插件，改为在 `globals.css` 的 `@layer components` 末尾新增 `.article-body`，然后把 `prose dark:prose-invert` 替换成 `article-body`：

```css
/* FE-UI 批9A：阅读正文排版（替代未安装的 @tailwindcss/typography 的 prose）。 */
.article-body { font-size: 17px; line-height: 1.8; color: var(--foreground); }
.article-body > * + * { margin-top: 1em; }
.article-body h2, .article-body h3 { font-family: var(--font-serif); font-weight: 600; line-height: 1.35; margin-top: 1.8em; }
.article-body h2 { font-size: 1.35em; }
.article-body h3 { font-size: 1.15em; }
.article-body a { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
.article-body blockquote { border-left: 2px solid var(--border-strong); padding-left: 1em; color: var(--muted-foreground); }
.article-body ul, .article-body ol { padding-left: 1.4em; }
.article-body ul { list-style: disc; }
.article-body ol { list-style: decimal; }
.article-body img { max-width: 100%; height: auto; border-radius: var(--radius); }
.article-body pre, .article-body code { font-family: var(--font-mono); font-size: 0.88em; background: var(--surface-muted); border-radius: 4px; }
.article-body pre { padding: 12px 14px; overflow-x: auto; }
.article-body code { padding: 0.1em 0.35em; }
.article-body hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
```

## 任务 7：删除死代码

`app/(app)/dashboard/hero-section.tsx` 和 `app/(app)/dashboard/drilldown-chart.tsx` 在全仓没有任何引用（审查时 `grep -rn "hero-section\|HeroSection\|drilldown-chart\|DrilldownChart" apps/web/app apps/web/components` 只命中它们自己）。删除前再 grep 一次确认，**包括测试文件和 `vitest.config.ts` 的 coverage.include**；若有引用，从 include 中一并移除。

---

## 禁止事项

- README §4 全部通用约束。
- 不改 DataStateBoundary 的 props 类型和其它分支。
- 不安装 `@tailwindcss/typography`。
- 不改各页面的 Tag 调用点（交给 9B ~ 9F）。

## 自主优化授权

`app/(app)/components/`、`app/(reader)/`、`components/data-state-boundary.tsx`、`components/time-range-controls.tsx`、`providers.tsx` 范围内，符合 §3.5 的同类修正可以顺手做，在报告中列出。

## 验证与提交

按 README §5 执行。建议提交：

- `🎨 style(web): FE-UI 批9A antd 预设色与状态色收敛到纸墨色板`
- `🐛 fix(web): FE-UI 批9A DataStateBoundary 刷新与非阻塞错误态不再打断父级间距`
- `💄 style(web): FE-UI 批9A 外壳去玻璃、错误页报纸风、阅读页正文排版`
- `🔥 chore(web): FE-UI 批9A 删除未引用的 hero-section 与 drilldown-chart`

## 人工冒烟清单

| 页面 | 亮色 | 暗色 | 375 / 1280 | 看什么 |
|---|---|---|---|---|
| 任意页面 | ✓ | ✓ | ✓ | 左侧导航和命令栏无毛玻璃、无大阴影，圆角 6/10 |
| `/events`、`/situation-monitor` | ✓ | ✓ |  | 彩色 Tag 变成低饱和 |
| `/alerts`，点刷新 | ✓ |  |  | 刷新过程中各区块之间的间距不塌、不跳 |
| `/dashboard`（带时间范围的页） |  |  | ✓ | 375 宽时时间范围控件换行，不溢出 |
| 浏览器访问一个会报错的路由（或在 devtools 中让请求抛错） | ✓ | ✓ |  | 错误页是 kicker + 衬线标题 |
| `/read/items/<id>` | ✓ | ✓ | ✓ | 正文有段距、标题衬线、链接下划线；工具栏无毛玻璃 |
