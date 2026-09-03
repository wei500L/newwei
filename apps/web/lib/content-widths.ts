/**
 * 内容宽度档位（App Shell 布局的单一真源）。
 *
 * shell.tsx（页面级容器宽度）与 PageContainer（页内内容宽度）都从本
 * 文件取档位——宽度白名单只在此处出现一次。本模块是纯常量（无 hooks/
 * 无客户端 API），服务端与客户端组件均可导入。
 *
 * 档位语义：
 *   - default    max-w-[1440px]  常规业务页（shell 默认档）
 *   - wide       max-w-[1920px]  监控/仪表盘类（situation-monitor、dashboard、map）
 *   - wide-board max-w-[1760px]  多栏看板（newsnow 系列页内容器）
 *   - article    max-w-[1200px]  阅读型页面（news-hub 等，在 shell 默认档内嵌套）
 *   - full       max-w-none      流式页面（assistant、newsnow 的 shell 档）
 */
export const CONTENT_WIDTH_CLASSES = {
  default: "max-w-[1440px]",
  wide: "max-w-[1920px]",
  "wide-board": "max-w-[1760px]",
  article: "max-w-[1200px]",
  full: "max-w-none",
} as const;

export type ContentWidth = keyof typeof CONTENT_WIDTH_CLASSES;

/** 返回档位对应的 max-width class（档位外取值由类型系统拒绝）。 */
export function contentWidthClass(width: ContentWidth): string {
  return CONTENT_WIDTH_CLASSES[width];
}
