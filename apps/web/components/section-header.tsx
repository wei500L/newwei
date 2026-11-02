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

/**
 * SectionHeader：卡片或区块内部的二级标题。
 * 用于替代散落在各处的 <Typography.Title level={5}> 与 Card title。
 */
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
