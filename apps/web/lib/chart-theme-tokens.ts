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

// ---------------------------------------------------------------------------
// 图表主题的「非系列色」（tooltip / title / legend / axis 文本与边框）。
//
// 同样以 JS 常量存在——这些值直接喂给 echarts.registerTheme 的主题对象，
// 渲染进 <canvas>，无法解析 CSS 变量 var()。集中于此以消除 echart.client.tsx
// 里散落的硬编码文本/边框色（审计 W6）。值与迁移前逐字符一致，零视觉变化。
// ---------------------------------------------------------------------------

/** smart-light tooltip 背景（半透明白）。 */
export const CHART_LIGHT_TOOLTIP_BG = "rgba(255, 255, 255, 0.95)";

/** smart-light 主题文本/边框色（tooltip 正文 / 标题 / 图例 / 坐标轴标签 / 轴线）。 */
export const CHART_LIGHT_TEXT_COLORS = {
  primary: "#1f2937", // tooltip 正文
  title: "#111827", // 标题
  secondary: "#4b5563", // 图例
  tertiary: "#6b7280", // 坐标轴标签
  border: "#e5e7eb", // 坐标轴线 / tooltip 边框
} as const;

/** smart-dark tooltip 背景（半透明深蓝）。 */
export const CHART_DARK_TOOLTIP_BG = "rgba(15, 23, 42, 0.95)";

/** smart-dark tooltip / 坐标轴线边框色（半透明白）。 */
export const CHART_DARK_TOOLTIP_BORDER = "rgba(255, 255, 255, 0.1)";

/** smart-dark 主题文本色（tooltip 正文 / 标题 / 类目轴标签 / 图例·数值轴标签）。 */
export const CHART_DARK_TEXT_COLORS = {
  primary: "#e2e8f0", // tooltip 正文
  title: "#f3f4f6", // 标题
  secondary: "#cbd5e1", // 类目轴标签
  tertiary: "#9ca3af", // 图例 / 数值轴标签
} as const;

// ---------------------------------------------------------------------------
// 各仪表盘图表的专属数据色（itemStyle / sparkline color 等 JS 上下文）。
// ---------------------------------------------------------------------------

/** economic-long：GDP 柱状图色。 */
export const ECONOMIC_CHART_COLORS = {
  gdp: "#0958d9",
} as const;

/** economic-medium：经济涨跌柱色（正=绿 / 负=红）。 */
export const ECONOMIC_CHANGE_COLORS = {
  positive: "#389e0d",
  negative: "#cf1322",
} as const;

/** market-pulse：「资源稀缺度」指标色（Cyan）。 */
export const MARKET_PULSE_COLOR = "#13c2c2";
