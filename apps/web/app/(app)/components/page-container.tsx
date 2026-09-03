import type { ReactNode } from "react";

import { CONTENT_WIDTH_CLASSES, type ContentWidth } from "@/lib/content-widths";

/**
 * PageContainer：页内内容容量的统一原语（前端 IA 重构第一批）。
 *
 * 职责（收口后）：
 *   - 宽度档位来自单一真源 @/lib/content-widths（与 shell 共用同一份
 *     类型与 class 映射），页面不再各自硬编码 max-w。
 *   - 水平居中（mx-auto w-full）。
 *
 * 非职责（padding 的唯一所有者是 shell）：
 *   - 页面级边距由 ShellLayout 统一提供（默认页 p-4 md:p-6；edge-to-edge
 *     页 p-0 自管）。PageContainer 不加任何 padding——结构上杜绝双重
 *     边距，需要纵向节奏的页面用 className 叠加。
 *   - 不做数据加载/状态/标题渲染。
 *
 * 服务端组件（无 hooks/无客户端 API）——可同时被 RSC 页面与客户端
 * 组件导入，不制造客户端组件边界。
 */
interface PageContainerProps {
  children: ReactNode;
  /** 内容最大宽度档位（默认 default=1440px），见 lib/content-widths。 */
  contentWidth?: ContentWidth;
  className?: string;
}

export function PageContainer({
  children,
  contentWidth = "default",
  className = "",
}: PageContainerProps) {
  const widthClass = CONTENT_WIDTH_CLASSES[contentWidth];
  return (
    <div className={`mx-auto w-full ${widthClass} ${className}`.trim()}>
      {children}
    </div>
  );
}
