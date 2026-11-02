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
  empty: "#161b26",
  backfilling: "#161b26",
  delayed: "#b45309",
  offline: "#5a6270",
  permission: "#b45309",
  error: "#b91c1c",
} as const;

/**
 * ChartEmptyState 无 chart theme 时的 SVG 兜底色。
 * stroke/fill 直接写入 SVG presentation 属性，text 写入 inline style，
 * 均不解析 var()，故以 JS 常量集中。
 */
export const CHART_BORDER_FALLBACK = "rgba(155, 151, 142, 0.4)";
export const CHART_FILL_FALLBACK = "rgba(155, 151, 142, 0.08)";
export const CHART_TEXT_FALLBACK = "#9b978e";

/**
 * LLM 网关压力状态色（antd Progress strokeColor，JS prop）。
 * critical=已超额、warning=接近上限、normal=健康。
 */
export const PRESSURE_STATUS_COLORS = {
  critical: "#b91c1c",
  warning: "#b45309",
  normal: "#1f3b7b",
} as const;

/**
 * 实体情感极性色（inline style / antd Progress strokeColor，JS 上下文）。
 * neutral=无数据兜底、positive=正向、negative=负向、gray=接近中性。
 */
export const SENTIMENT_COLORS = {
  neutral: "#9b978e",
  positive: "#1b9e77",
  negative: "#d95f02",
  gray: "#5a6270",
} as const;

/**
 * 告警中心范围指示条各段色（inline style background/borderColor，JS 上下文）。
 * track=底轨、range=命中区间、expected=期望标记、observed=观测标记。
 */
export const RANGE_INDICATOR_COLORS = {
  track: "#e3dfd6",
  range: "#9fb3d9",
  expected: "#161b26",
  observed: "#b91c1c",
} as const;

/**
 * 告警趋势线色，按严重级别（echarts lineStyle.color，canvas 上下文）。
 */
export const ALERT_LINE_COLORS = {
  low: "#2f7d5b",
  medium: "#c2410c",
  high: "#b91c1c",
} as const;
