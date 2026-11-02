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

/**
 * FilterBar.Item：单个筛选控件 + 可选标签。
 *
 * 放进 Item 的 antd Select / Input 必须带 `className="w-full"`，让它占满
 * Item 的宽度（Item 本身在窄屏是 w-full，桌面端按 width 档位固定宽度）。
 */
function FilterBarItem({ label, children, width = "md", className = "" }: FilterBarItemProps) {
  return (
    <label className={`flex w-full min-w-0 flex-col gap-1 ${ITEM_WIDTH_CLASSES[width]} ${className}`.trim()}>
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
      {children}
    </label>
  );
}

/**
 * FilterBar：列表页的筛选、工具栏，自动换行，窄屏下控件占满整行。
 */
export function FilterBar({ children, actions, className = "" }: FilterBarProps) {
  return (
    <div className={`flex flex-wrap items-end gap-3 ${className}`.trim()} role="group">
      {children}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

FilterBar.Item = FilterBarItem;
