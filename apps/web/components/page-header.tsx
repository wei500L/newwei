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

/**
 * PageHeader：每个业务页面顶部的唯一标题区。
 *
 * 服务端安全组件：不使用 hooks，也不加 "use client"，因此 RSC 页面与
 * 客户端组件都能直接 import；返回链接用 next/link，避免 useRouter。
 */
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
