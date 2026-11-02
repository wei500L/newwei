# FE-UI 批11：细节打磨（标签页标题 / 时间显示统一 / 正文行宽 / 图标 / 无效 hover 类）

> **一句话目标**：版面、配色、状态写法都已收敛，剩下的是用户每天都会碰到、但前面没有覆盖的细节：
> 1. **所有页面的浏览器标签页标题都一样**，是「Modular 管理台」。开了多个标签页时分不清哪个是哪个，「管理台」这个说法也和「情报编辑台」的定位不符。
> 2. **时间显示有两套时区**。`formatDateTime()` 按应用时区（`NEXT_PUBLIC_TIME_ZONE`，默认 `Asia/Shanghai`）显示；但约 40 处 `toLocaleString()` 和约 30 处 `dayjs(x).format()` 用的是**浏览器本地时区**，格式也各不相同。用户不在东八区时，同一条新闻在两个页面上的时间会差好几个小时。
> 3. `/items/[id]` 新闻详情的正文没有行宽限制，宽屏下一行超过 120 个字，读起来很累（阅读页 `/read` 已经有 `.article-body`，但应用内的详情页没有）。
> 4. favicon 还是冷灰底（`#111827`），和纸墨色板不一致。
> 5. 21 处 `bg-[var(--secondary)]/60`、`text-[var(--secondary-foreground)]/80` 这类写法在 Tailwind 3 里**不生效**（var() 颜色不能加透明度修饰），其中 NewsNow 列表的悬停底色因此完全没有反馈，热点候选区的次要文字也没有变浅。
>
> **依赖**：UI-10 全部合入。单独一批，按 T1 → T5 分 4 次提交（T4、T5 合并为一次）。
>
> **开工前必读**：README §3、§4、§5、§7。行号是审查快照，执行前先用片段定位。

---

## T1 标签页标题：每页显示「页面名 · 站点名」

### 1. 新建 `apps/web/lib/document-title.ts`

```ts
/**
 * 浏览器标签页标题的单一入口。
 * 站点名由 providers 按语言设置；页面名由 PageHeader（或个别没有 PageHeader 的页面）设置。
 * 两者谁先谁后都不影响结果，所以不依赖 React effect 的执行顺序。
 */
let siteTitle = "";
let pageTitle: string | null = null;

function apply(): void {
  if (typeof document === "undefined") return;
  if (!siteTitle) return;
  document.title = pageTitle ? `${pageTitle} · ${siteTitle}` : siteTitle;
}

export function setSiteTitle(value: string): void {
  siteTitle = value;
  apply();
}

export function setPageTitle(value: string | null): void {
  pageTitle = value;
  apply();
}
```

### 2. 新建 `apps/web/hooks/use-page-title.ts`

```ts
"use client";

import { useEffect } from "react";

import { setPageTitle } from "@/lib/document-title";

/** 设置当前页的标签页标题；组件卸载时恢复为只有站点名。title 不是字符串时不做任何事。 */
export function usePageTitle(title: unknown): void {
  const text = typeof title === "string" ? title.trim() : "";
  useEffect(() => {
    if (!text) return;
    setPageTitle(text);
    return () => setPageTitle(null);
  }, [text]);
}
```

### 3. `components/page-header.tsx`

PageHeader 目前**不是**客户端组件，而且被服务端组件直接使用（例如 `app/(app)/news-hub/page.tsx`），所以**不要**给它加 `"use client"`。做法是新建一个很小的客户端组件，渲染在 PageHeader 里面：

```tsx
// apps/web/components/page-title-sync.tsx
"use client";

import { usePageTitle } from "@/hooks/use-page-title";

export function PageTitleSync({ title }: { title: string }): null {
  usePageTitle(title);
  return null;
}
```

在 `page-header.tsx` 的返回 JSX 里（`<h1>` 旁边任意位置）加：

```tsx
{typeof title === "string" ? <PageTitleSync title={title} /> : null}
```

### 4. `app/providers.tsx:~189`

```ts
document.title = i18nInstance.t("metadata.title");
```

改为：

```ts
setSiteTitle(i18nInstance.t("metadata.title"));
```

（从 `@/lib/document-title` 导入。）

### 5. 没有 PageHeader 的主页面

`/today` 用的是自己的报头。在 Today 报头组件（客户端组件）里加 `usePageTitle(t("nav.main.today"))`（现有导航文案「今日要闻」）。`/welcome` 如果是客户端组件，用它页面上的主标题文案同样处理；不是就跳过并在报告里说明。其它没有 PageHeader 的 page.tsx 都是重定向或复用别的组件，不用管。

### 6. 站点名文案（`lib/locales/zh.json` / `en.json` 的 `metadata`）

| key | zh 原值 → 新值 | en 原值 → 新值 |
|---|---|---|
| `metadata.title` | `Modular 管理台` → `Modular 情报台` | 原值 → `Modular Intelligence Desk` |
| `metadata.description` | `运维控制台` → `新闻与信号情报编辑台` | 原值 → `News and signal intelligence desk` |

`app/layout.tsx:14` 的静态 `metadata` 同步改成 `{ title: "Modular 情报台", description: "新闻与信号情报编辑台" }`（首屏 JS 加载前显示的就是这个）。

**测试**：为 `page-header` 已有测试补 1 个用例：渲染 `<PageHeader title="告警" />` 后，在 `setSiteTitle("站点")` 之后 `document.title` 为 `"告警 · 站点"`；卸载后为 `"站点"`。

## T2 时间显示统一走应用时区

**规则**：凡是**展示给用户看的时间戳**，一律用 `lib/i18n.ts` 的 `formatDateTime(value, locale, options)` 或 `formatRelativeTime`；`locale` 用组件里已有的写法 `const locale = resolveLocale(i18n.language)`（参考 `analysis-workspace.tsx:309`）。

**统一的两种格式**（在 `lib/i18n.ts` 末尾新增两个便捷函数，其它地方只调用它们）：

```ts
/** 完整时间：2026-11-02 14:05（列表、表格、详情的时间列） */
export function formatTimestamp(value: string | number | Date, locale: SupportedLocale): string {
  return formatDateTime(value, locale, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** 只要时分：14:05（图表轴、实时流、今日内的条目） */
export function formatClock(value: string | number | Date, locale: SupportedLocale): string {
  return formatDateTime(value, locale, { hour: "2-digit", minute: "2-digit", hour12: false });
}
```

（`formatDateTime` 对无效输入返回空字符串；调用方原来如果对无效时间显示原值或 `-`，保留这个兜底：`formatTimestamp(v, locale) || "-"`。）

**要改的位置**（按文件内出现次数排序；先用 `grep -n "toLocaleString\|toLocaleDateString\|toLocaleTimeString" <文件>` 定位）：

| 文件 | 约几处 | 写法 |
|---|---|---|
| `components/settings/llm-gateway/llm-gateway-proxy-governance-panel.tsx` | 9 | `toLocaleString()` |
| `components/settings/assistant-safety-settings-panel.tsx` | 6 | 同上 |
| `app/(app)/admin/quality/quality-content.tsx` | 6 | `parsed.toLocaleString()` |
| `components/settings/llm-gateway-settings-panel.tsx` | 4 | 同上 |
| `app/(app)/admin/ops/crawl-frontier/crawl-workflow-studio.tsx` | 4 | 同上 |
| `components/settings/llm-request-logs-panel.tsx`、`llm-gateway/llm-gateway-governance.view.ts`、`archive-preparation-settings-panel.tsx`、`app/(app)/newsnow/components/newsnow-recommended-feed.tsx`、`app/(app)/dashboard/charts/sector-heatmap.tsx` | 各 2 | 同上 |
| `situation-monitor-settings-panel.tsx`、`rss-diagnostics-panel.tsx`、`realtime-signals/realtime-signals-runtime-model.ts`、`news-source-runtime-secrets-panel.tsx`、`news-events-settings-panel.tsx`（均在 `components/settings/`） | 各 1 | 同上 |

`dayjs(x).format("YYYY-MM-DD HH:mm…")` 用于**展示**的，同样替换（主要在 `admin/ops/crawl-monitor/crawl-monitor-content.tsx` 11 处、`dashboard/metric-drilldown.tsx` 7 处、`entities/[id]/entity-intelligence-card.tsx` 4 处、`dashboard/dashboard-content.tsx` 4 处、`today/components/breaking-alerts.tsx`、`dashboard/components/analysis-stream.tsx`、`crawl/components/Crawl4aiHealthCard.tsx`）。

**不要改的**：

- 数字的 `toLocaleString()`（千分位，如 `count.toLocaleString()`）。判断方法：调用对象是数字而不是 Date。
- 用于 URL 参数、请求参数、文件名、表单值、日期选择器的 `dayjs().format("YYYY-MM-DD")`（例如 `alerts/alert-center-url-state.ts`、`use-alert-center-url-state.ts`、`events-archive` 的筛选参数）。
- echarts 轴上**只有日期没有时间**的 `format("MM-DD")`（日期粒度不受时区影响的场景）。

拿不准的位置不要改，在报告里列出来。**上限 60 处**。

## T3 新闻详情正文行宽

`app/(app)/items/[id]/item-detail.tsx:~1466`：

```tsx
<MarkdownViewer markdown={resolvedArticleContent!} />
```

改为：

```tsx
<div className="max-w-[72ch]">
  <MarkdownViewer markdown={resolvedArticleContent!} />
</div>
```

同一区块里的翻译提示、`markdownFallbackUsed` 的 Alert 不用包。标题（`:~1238` 的 `Typography.Title level={4}`）也不限宽。

## T4 favicon（`app/icon.svg`）

整份替换为（墨色底、纸色字、10px 圆角，与卡片圆角刻度一致）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="10" fill="#161b26" />
  <path d="M16 48V16h8l8 16 8-16h8v32h-8V28l-8 16-8-16v20h-8z" fill="#faf8f3" />
  <rect x="16" y="52" width="32" height="2" fill="#b45309" />
</svg>
```

（底部那条 2px 琥珀色线是「栏线」，与报头的 ink rule 呼应。）`app/favicon.ico` 不动。

## T5 不生效的 `[var(--x)]/NN` 写法

Tailwind 3 对 `var()` 颜色**不支持**透明度修饰符：`bg-[var(--secondary)]/60` 这类类名根本不会生成 CSS，等于没写。全仓共 21 处：

| 文件 | 处数 |
|---|---|
| `app/(app)/newsnow/components/newsnow-hottest-candidates.tsx` | 12 |
| `app/(app)/newsnow/components/newsnow-card.tsx` | 3 |
| `app/(app)/components/command-bar.tsx` | 3 |
| `app/(app)/newsnow/components/news-list-hot.tsx`（`:152` 悬停底色） | 1 |
| `app/(app)/newsnow/components/news-list-timeline.tsx`（`:155` 悬停底色） | 1 |
| `app/(reader)/read/items/[id]/page.tsx` | 1 |

按下表替换（slate 已映射为暖色，见 README §3.2；hex 字面量可以带透明度）：

| 原写法 | 改成 |
|---|---|
| `hover:bg-[var(--secondary)]/60`、`bg-[var(--secondary)]/60`、`/70` | `bg-slate-100/70 dark:bg-slate-800/60`（hover 前缀照加：`hover:bg-slate-100/70 dark:hover:bg-slate-800/60`） |
| `bg-[var(--primary)]/10`、`/20` | `bg-[#1f3b7b]/10 dark:bg-[#8fb0ff]/10`（/20 同理） |
| `border-[var(--border)]/60` | `border-[var(--border)]`（去掉修饰） |
| `border-[var(--accent)]/30` | `border-[#b45309]/30 dark:border-[#f59e0b]/30` |
| `border-[var(--destructive)]/30` | `border-[#b91c1c]/30 dark:border-[#f87171]/30` |
| `text-[var(--secondary-foreground)]/60` ~ `/85` | `text-muted-foreground` |
| `text-[var(--foreground)]/85` | `text-[var(--foreground)]`（去掉修饰） |

改完自查：`grep -rnE "(bg|text|border)-\[var\([^)]*\)\]/[0-9]+" apps/web/app apps/web/components`，期望无输出。

---

## 禁止事项

- README §4。
- T2 只改**显示**，不改传给接口的时间值、筛选条件、排序逻辑。
- 不改 `formatDateTime` 本身的实现，只在文件末尾追加 `formatTimestamp` / `formatClock`。
- 不新增依赖。

## 测试

- 已有测试必须通过。断言了具体时间字符串的测试，如果因为改用应用时区而变化，按新的输出更新断言（测试里固定的时间值换算到 `Asia/Shanghai`）。
- 新增：T1 的 PageHeader 用例；为 `formatTimestamp` 新增 1 个用例：`formatTimestamp("2026-01-01T00:00:00Z", "zh-CN")` 包含 `08:00`（东八区）。

## 验证与提交

- `💄 feat(web): FE-UI 批11 标签页标题显示页面名，站点名改为情报台`
- `🕐 fix(web): FE-UI 批11 时间显示统一走应用时区与两种标准格式`
- `💄 style(web): FE-UI 批11 新闻详情正文限制行宽`
- `💄 style(web): FE-UI 批11 favicon 纸墨化与无效透明度类修复`

## 人工冒烟清单

| 检查 | 怎么看 |
|---|---|
| 标签页标题 | 依次打开 `/today`、`/items`、`/alerts`、`/admin/settings/ai`，标签页标题分别显示对应页面名加「· Modular 情报台」；切换到英文后跟着变 |
| 时区一致 | 把电脑时区改成非东八区（例如莫斯科），对比 `/items` 列表和 `/admin/quality`、`/admin/settings` 里的时间：都按应用时区显示，格式都是 `2026-11-02 14:05` |
| 正文行宽 | 1920 宽打开任意 `/items/<id>`，正文每行不超过约 70 个汉字 |
| favicon | 标签页图标是墨底纸字，底部有一条琥珀色细线 |
| NewsNow 悬停 | `/newsnow/hottest` 鼠标移到条目上有浅色底 |
