# FE-UI 批1：页面原语（PageHeader · SectionHeader · FilterBar · error / not-found）

> 开工前先读 [README](README.md) §3、§4。
> 依赖：UI-0 已合入（本批要用 `.kicker`、`.section-rule`、`text-muted-foreground` 等 token）。
> 可以和 UI-2A、UI-2B 并行。
> 本批**只新建原语和路由级兜底页面，不迁移任何业务页面**。页面迁移放在 UI-3A/B/C。

## 目标

全站目前有 8 种页头写法、9 种以上的筛选栏写法，而且没有错误页。本批提供 3 个共享组件和 3 个路由文件，给后续批次统一使用。

## 必读文件

- `apps/web/app/(app)/components/page-container.tsx` 和 `page-container.test.tsx`：参考现有原语的写法和测试风格
- `apps/web/test/render.tsx`：`renderWithProviders`
- `apps/web/components/data-state-boundary.tsx`：参考 antd `Result` / `Button` 的用法
- `apps/web/app/(app)/components/route-loading-skeleton.tsx`
- `apps/web/lib/locales/zh.json`、`en.json`：`common.*`、`nav.groups.*`（已有：`common.back`=返回、`common.retry`=重试、`common.refresh`、`nav.groups.today/situation/research/workspace/admin`）

## 任务清单

### T1 · 新建 `apps/web/components/page-header.tsx`

**用途**：每个业务页面顶部的唯一标题区。

```tsx
import Link from "next/link";
import type { ReactNode } from "react";

export interface PageHeaderBack {
  href: string;
  label: string;
}

export interface PageHeaderProps {
  /** 页面标题，渲染为 h1（衬线） */
  title: ReactNode;
  /** 栏目眉题，例如导航组名「事件与态势」 */
  kicker?: ReactNode;
  /** 一两句说明，muted 色，最大 72ch */
  description?: ReactNode;
  /** 标题下方的元信息行：时区 Tag、更新时间、计数等 */
  meta?: ReactNode;
  /** 右侧操作区：刷新、新建等按钮 */
  actions?: ReactNode;
  /** 返回链接（详情页用） */
  back?: PageHeaderBack;
  /** compact：标题更小，用于 dashboard 子页这类有 Tab 条的页面 */
  size?: "default" | "compact";
  /** 底部是否加 2px 栏线，默认 false */
  rule?: boolean;
  className?: string;
}
```

**渲染结构**（照抄，类名都是字面量）：
```tsx
export function PageHeader({
  title, kicker, description, meta, actions, back,
  size = "default", rule = false, className = "",
}: PageHeaderProps) {
  const titleClass =
    size === "compact"
      ? "font-serif text-xl font-semibold leading-tight tracking-tight text-[var(--foreground)] md:text-2xl"
      : "font-serif text-2xl font-semibold leading-tight tracking-tight text-[var(--foreground)] md:text-[28px]";
  return (
    <header
      className={`flex flex-col gap-3 ${rule ? "hairline-b pb-4" : ""} ${className}`.trim()}
    >
      {back ? (
        <Link
          href={back.href}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-[var(--foreground)]"
        >
          <span aria-hidden>←</span>
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          {kicker ? <p className="kicker m-0">{kicker}</p> : null}
          <h1 className={`m-0 min-w-0 break-words ${titleClass}`}>{title}</h1>
          {description ? (
            <p className="m-0 max-w-measure text-sm text-muted-foreground">{description}</p>
          ) : null}
          {meta ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{meta}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
```

要点：
- 这是服务端安全组件：不用 hooks，也不加 `"use client"`，所以 RSC 页面和客户端组件都能直接 import。
- 用 `next/link`，不要用 `useRouter`。
- `max-w-measure` 已经在 Tailwind 配置里（72ch）。

### T2 · 新建 `apps/web/components/section-header.tsx`

**用途**：卡片或区块内部的二级标题。之后用它替代散落在各处的 `<Typography.Title level={5}>` 和 `Card title`。

```tsx
import type { ReactNode } from "react";

export interface SectionHeaderProps {
  title: ReactNode;
  kicker?: ReactNode;
  /** 右侧附加内容：链接、筛选、计数 */
  extra?: ReactNode;
  /** 顶部 2px 墨色栏线 */
  rule?: boolean;
  /** 标题语义层级，默认 h2 */
  as?: "h2" | "h3";
  className?: string;
}

export function SectionHeader({ title, kicker, extra, rule = false, as = "h2", className = "" }: SectionHeaderProps) {
  const Heading = as;
  return (
    <div className={`flex items-end justify-between gap-3 ${rule ? "section-rule" : ""} ${className}`.trim()}>
      <div className="flex min-w-0 flex-col gap-0.5">
        {kicker ? <p className="kicker m-0">{kicker}</p> : null}
        <Heading className="m-0 truncate font-sans text-[15px] font-semibold text-[var(--foreground)]">{title}</Heading>
      </div>
      {extra ? <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm">{extra}</div> : null}
    </div>
  );
}
```

### T3 · 新建 `apps/web/components/filter-bar.tsx`

**用途**：列表页的筛选、工具栏，自动换行，窄屏下控件占满整行。

```tsx
import type { ReactNode } from "react";

export interface FilterBarProps {
  children: ReactNode;
  /** 放在最右侧的操作（重置、刷新），窄屏时换到下一行 */
  actions?: ReactNode;
  className?: string;
}

export interface FilterBarItemProps {
  label?: ReactNode;
  children: ReactNode;
  /** 桌面端最小宽度档：sm=140 md=180 lg=240 */
  width?: "sm" | "md" | "lg" | "auto";
  className?: string;
}

const ITEM_WIDTH_CLASSES: Record<NonNullable<FilterBarItemProps["width"]>, string> = {
  sm: "sm:w-[140px]",
  md: "sm:w-[180px]",
  lg: "sm:w-[240px]",
  auto: "sm:w-auto",
};

function FilterBarItem({ label, children, width = "md", className = "" }: FilterBarItemProps) {
  return (
    <label className={`flex w-full min-w-0 flex-col gap-1 ${ITEM_WIDTH_CLASSES[width]} ${className}`.trim()}>
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
      {children}
    </label>
  );
}

export function FilterBar({ children, actions, className = "" }: FilterBarProps) {
  return (
    <div className={`flex flex-wrap items-end gap-3 ${className}`.trim()} role="group">
      {children}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

FilterBar.Item = FilterBarItem;
```

注意：
- `ITEM_WIDTH_CLASSES` 必须是字面量映射表，不准插值（README §4.3）。
- 放进 Item 的 antd `Select` / `Input` 要带 `className="w-full"`，让它占满 Item 的宽度。在组件 JSDoc 里写明这一点。
- `FilterBar.Item` 是函数静态属性，TypeScript strict 下没问题。如果 lint 报「组件静态属性」相关规则，就改成分别导出 `FilterBar` 和 `FilterBarItem`，同样在报告里说明。

### T4 · 路由级错误页 `apps/web/app/(app)/error.tsx`

```tsx
"use client";

import { Button, Result } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Result
        status="error"
        title={t("common.pageError.title")}
        subTitle={t("common.pageError.description")}
        extra={<Button type="primary" onClick={reset}>{t("common.retry")}</Button>}
      />
    </div>
  );
}
```
- 先 grep 项目里有没有统一的 logger（如 `lib/logger`）。有就用它替代 `console.error`；没有就保留 `console.error`。如果 ESLint 禁用 console，加上与仓库其他地方一致的 eslint-disable 注释。
- 新增 i18n key（zh / en 两边都加，路径一致）：
  - `common.pageError.title`：「页面出错了」/ "Something went wrong"
  - `common.pageError.description`：「这一页加载时发生错误，可以重试；问题持续请联系管理员。」/ "This page failed to load. Try again, or contact an administrator if it keeps happening."

### T5 · 404 页：`apps/web/app/(app)/not-found.tsx` 与 `apps/web/app/not-found.tsx`

- `(app)/not-found.tsx`（在 shell 内渲染）：
  ```tsx
  import Link from "next/link";
  // 服务端组件；用 antd Result 需要客户端边界，所以这里用纯 Tailwind 实现
  export default function AppNotFound() {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <p className="kicker m-0">404</p>
        <h1 className="m-0 font-serif text-2xl font-semibold">…</h1>
        <p className="m-0 text-sm text-muted-foreground">…</p>
        <Link href="/today" className="text-sm text-[var(--primary)] underline-offset-4 hover:underline">…</Link>
      </div>
    );
  }
  ```
- 服务端组件拿 i18n 文案：先看 `lib/i18n.ts` 有没有服务端翻译函数（例如 `getServerTranslation` / `resolveLocale` 配合字典）。
  - **有**就用它。
  - **没有**就把这个文件改成 `"use client"`，用 `useTranslation`。
- 新增 key：
  - `common.notFound.title`：「找不到这个页面」/ "Page not found"
  - `common.notFound.description`：「链接可能已失效，或你没有访问权限。」/ "The link may be broken, or you may not have access."
  - `common.notFound.goHome`：「回到今日简报」/ "Back to daily briefing"
- 根级 `app/not-found.tsx`（shell 之外，例如 portal 的未知路径）：同样的结构，外层套一个 `min-h-[100dvh] bg-[var(--background)] p-6` 的容器，链接指向 `/`。

### T6 · `app/(app)/components/route-loading-skeleton.tsx` 视觉对齐

- 面板 `className` 中的 `rounded-lg border border-[var(--border)] bg-white/60 p-4 shadow-sm dark:bg-slate-900/40` 替换为 `content-card p-4`。
- 骨架条 `bg-slate-200/80 dark:bg-slate-700/70` 替换为 `bg-[var(--surface-muted)]`（三处都改）。
- 第一条标题骨架（`h-7 w-56`）上方加一条 `h-3 w-24` 的眉题骨架，模拟 PageHeader 的结构。

### T7 · 测试（新建，行为断言）

`apps/web/components/page-header.test.tsx`：
1. 渲染 `title="事件"`、`kicker="事件与态势"`，断言 `screen.getByRole("heading", { level: 1, name: "事件" })` 存在，并且 `getByText("事件与态势")` 存在。
2. 传入 `actions={<button>刷新</button>}`，用 `userEvent` 或 `fireEvent` 点击，断言 mock 回调被调用。
3. 传入 `back={{ href: "/events", label: "返回" }}`，断言 `getByRole("link", { name: /返回/ })` 的 `href` 属性是 `/events`。
4. 不传 description / meta / actions 时，断言 `queryByText(...)` 为空，也就是不会渲染多余的空容器（可以断言 header 内只有 1 个 heading）。

`apps/web/components/filter-bar.test.tsx`：
1. 渲染两个 `FilterBar.Item`，label 分别是「状态」和「来源」，断言两个 label 文本都可见，且 `getByRole("group")` 存在。
2. 传入 `actions={<button>重置</button>}`，断言按钮可见。

两个测试文件都用 `renderWithProviders`（`@/test/render` 或相对路径，按现有测试的 import 写法）。

把下列文件追加进 `apps/web/vitest.config.ts` 的 `coverage.include` 末尾：
```ts
        // FE-UI 批1：页面原语（PageHeader / SectionHeader / FilterBar）
        "components/page-header.tsx",
        "components/section-header.tsx",
        "components/filter-bar.tsx",
```

### T8 · 文档：`apps/web/docs/design-system.md` 新增 §9「页面原语」

写清楚以下内容：
- 每个 `(app)` 页面的第一个子元素必须是 `<PageHeader>`；kicker 用所属导航组的文案 `t("nav.groups.xxx")`。
- 页面根容器统一用 `<div className="flex flex-col gap-6">`。
- 区块标题用 `<SectionHeader>`，不要再用 `Typography.Title level={4|5}` 当区块标题。
- 筛选栏用 `<FilterBar>`；放进去的 antd 控件要加 `className="w-full"`。
- 附一个最小示例：PageHeader 加 FilterBar 加 content-card 列表。

## 禁止事项

- 不要修改任何业务页面来使用这些原语，迁移是 UI-3 的事。唯一例外是 T6 的骨架屏。
- PageHeader 不要依赖 antd：它是服务端安全组件，antd 组件需要客户端边界。
- 不要在原语里写死中文或英文；原语本身不含文案，文案由调用方传入。

## 自主优化授权

如果你认为 `PageHeader` 需要一个 `titleSuffix`（标题右侧紧跟的小 Tag，例如时区），可以加成可选 prop，并补一个测试。其他新 prop 不要加。

## 验证与提交

按 README §5 执行。commit 示例：
`✨ feat(web): FE-UI 批1 页面原语——PageHeader/SectionHeader/FilterBar 与路由级错误页、404`

## 人工冒烟清单

- 在浏览器访问 `/this-page-does-not-exist-xyz`：应该看到带 shell 的 404，或者根级 404，衬线标题加返回链接，亮色和暗色都检查。
- 进入任一 dashboard 子页，在网络面板里阻断后刷新：路由骨架屏是纸面卡片样式，不是白色半透明块。
- （error.tsx 很难人工触发，有测试或 CI 通过即可。）
