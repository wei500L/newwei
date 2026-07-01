/**
 * 集中管理跨组件复用的「状态/情感」语义色。
 *
 * 这些值以 JS 常量（而非 CSS 变量）形式存在，因为它们渲染进
 * <canvas>(echarts) 与 SVG presentation 属性(fill=...)——这两种上下文
 * 都不会解析 CSS 自定义属性 var()。集中于此以消除组件间的硬编码碎片化
 * （审计 W6：状态/主题色散落在各组件 JS 里）。
 *
 * 迁移策略：新组件优先引用本模块；现有组件逐步收敛。值保持与迁移前一致，
 * 迁移本身零视觉变化。
 */

/** SentimentBadge 的辉光色（boxShadow），按情感极性。 */
export const SENTIMENT_GLOW = {
  positive: "rgba(34, 197, 94, 0.2)",
  negative: "rgba(239, 68, 68, 0.2)",
  neutral: "rgba(100, 100, 100, 0.2)",
} as const;

export type ChartStateVariant =
  | "empty"
  | "delayed"
  | "backfilling"
  | "offline"
  | "permission"
  | "error";

/**
 * ChartEmptyState 各状态的 SVG 强调色「兜底值」。
 * 组件在有 chart theme 时优先用主题色（primary/accent），
 * 仅在无主题时回退到这里的语义兜底值。
 */
export const CHART_STATE_ACCENT_FALLBACK: Record<ChartStateVariant, string> = {
  empty: "rgba(56, 189, 248, 0.6)",
  delayed: "rgba(245, 158, 11, 0.6)",
  backfilling: "rgba(56, 189, 248, 0.6)",
  offline: "rgba(100, 116, 139, 0.6)",
  permission: "rgba(217, 119, 6, 0.6)",
  error: "rgba(220, 38, 38, 0.55)",
} as const;

/** ChartEmptyState 标题文字色，按状态。 */
export const CHART_STATE_TITLE: Record<ChartStateVariant, string> = {
  empty: "#0f172a",
  backfilling: "#0f172a",
  delayed: "#d97706",
  offline: "#475569",
  permission: "#b45309",
  error: "#dc2626",
} as const;
