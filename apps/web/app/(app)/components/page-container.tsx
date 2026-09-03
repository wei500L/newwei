"use client";

import type { ReactNode } from "react";

/**
 * PageContainer：页面内容容量的统一原语（前端 IA 重构第一批）。
 *
 * 职责（FE-批1 范围）：
 *   - 收敛「页面私自介入布局策略」：news-hub 自加 1200px、newsnow 自加
 *     1760px 等特例统一改为声明 contentWidth，宽度白名单只在 shell 与
 *     本组件两处出现。
 *   - 统一页面边距（p-4 md:p-6）与水平居中；edge-to-edge 页面自管 padding。
 *
 * 非职责：不做数据加载/状态/标题渲染——避免过度设计（IA 文档 PageHeader
 * 等原语留待后续批次）。
 *
 * 宽度档位（与 shell.tsx 的 useContainerClass 保持一致）：
 *   - default      max-w-[1440px]
 *   - wide         max-w-[1920px]（监控/仪表盘类）
 *   - wide-board   max-w-[1760px]（newsnow 等多栏看板）
 *   - article      max-w-[1200px]（阅读型页面）
 *   - full         max-w-none（fluid 页面）
 */
export type PageContentWidth = "default" | "wide" | "wide-board" | "article" | "full";

const WIDTH_CLASSES: Record<PageContentWidth, string> = {
  default: "max-w-[1440px]",
  wide: "max-w-[1920px]",
  "wide-board": "max-w-[1760px]",
  article: "max-w-[1200px]",
  full: "max-w-none",
};

interface PageContainerProps {
  children: ReactNode;
  /** 内容最大宽度档位（默认 default=1440px）。 */
  contentWidth?: PageContentWidth;
  /**
   * 页面自身边距。fluid/edge-to-edge 页面（shell 已给 p-0）传 "none" 自管；
   * 其余传 "default"（p-4 md:p-6，与 shell 内容边距一致）。
   */
  padding?: "default" | "none";
  className?: string;
}

export function PageContainer({
  children,
  contentWidth = "default",
  padding = "default",
  className = "",
}: PageContainerProps) {
  const widthClass = WIDTH_CLASSES[contentWidth];
  const paddingClass = padding === "none" ? "" : "p-4 md:p-6";
  return (
    <div className={`mx-auto w-full ${widthClass} ${paddingClass} ${className}`.trim()}>
      {children}
    </div>
  );
}
