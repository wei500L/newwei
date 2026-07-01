/**
 * ECharts 图表主题的「系列配色板」（light / dark）单一真源。
 *
 * 这些颜色以 JS 常量存在——图表渲染进 <canvas>，无法解析 CSS 变量 var()。
 * 集中于此以消除各图表组件内的硬编码碎片（审计 W6：图表色散落各组件、
 * 脱离设计 token）。值与迁移前完全一致，收敛本身零视觉变化。
 *
 * 供 echart 主题注册（smart-light / smart-dark）与其它自定义图表复用。
 */

/** smart-light 主题系列色（8 色轮转）。 */
export const CHART_SERIES_LIGHT: string[] = [
  "#0050b3", // Primary (Deep Blue)
  "#faad14", // Secondary (Tech Gold)
  "#13c2c2", // Accent (Cyan)
  "#eb2f96", // Magenta
  "#722ed1", // Purple
  "#52c41a", // Green
  "#fadb14", // Yellow
  "#fa8c16", // Orange
];

/** smart-dark 主题系列色（8 色轮转）。 */
export const CHART_SERIES_DARK: string[] = [
  "#2563eb", // Vibrant Blue
  "#d48806", // Gold
  "#13a8a8", // Cyan
  "#cb2b83", // Magenta
  "#642ab5", // Purple
  "#49aa19", // Green
  "#d8bd14", // Yellow
  "#d87a16", // Orange
];
