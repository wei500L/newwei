/**
 * ECharts 图表主题的「系列配色板」（light / dark）单一真源。
 *
 * 这些颜色以 JS 常量存在——图表渲染进 <canvas>，无法解析 CSS 变量 var()。
 * 集中于此以消除各图表组件内的硬编码碎片（审计 W6：图表色散落各组件、
 * 脱离设计 token）。
 *
 * FE-UI 批8A：对齐情报编辑台纸墨色板（README §3.2）。
 *
 * 供 echart 主题注册（smart-light / smart-dark）与其它自定义图表复用。
 */

/** smart-light 系列色：墨蓝、琥珀、青绿、朱红、靛紫、橄榄、赭黄、石墨。低饱和，适合纸底。 */
export const CHART_SERIES_LIGHT: string[] = [
  "#1f3b7b", // 墨蓝（= --primary）
  "#b45309", // 琥珀（= --accent）
  "#0f766e", // 青绿
  "#b91c1c", // 朱红（= --destructive）
  "#5b4b8a", // 靛紫
  "#4d7c0f", // 橄榄
  "#a16207", // 赭黄
  "#5a6270", // 石墨（= --muted-foreground）
];

/** smart-dark 系列色：同色相提亮，保证深墨底上可读。 */
export const CHART_SERIES_DARK: string[] = [
  "#8fb0ff", // 墨蓝（= 暗色 --primary）
  "#f59e0b", // 琥珀（= 暗色 --accent）
  "#2dd4bf", // 青绿
  "#f87171", // 朱红（= 暗色 --destructive）
  "#a78bfa", // 靛紫
  "#a3e635", // 橄榄
  "#facc15", // 赭黄
  "#9aa3af", // 石墨（= 暗色 --muted-foreground）
];

// ---------------------------------------------------------------------------
// 图表主题的「非系列色」（tooltip / title / legend / axis 文本与边框）。
//
// 同样以 JS 常量存在——这些值直接喂给 echarts.registerTheme 的主题对象，
// 渲染进 <canvas>，无法解析 CSS 变量 var()。集中于此以消除 echart.client.tsx
// 里散落的硬编码文本/边框色（审计 W6）。
// FE-UI 批8A：对齐纸墨 token（README §3.2）。
// ---------------------------------------------------------------------------

export const CHART_LIGHT_TOOLTIP_BG = "rgba(255, 253, 249, 0.98)"; // --surface
export const CHART_LIGHT_TEXT_COLORS = {
  primary: "#161b26",   // --foreground
  title: "#161b26",
  secondary: "#4a5261", // --secondary-foreground
  tertiary: "#5a6270",  // --muted-foreground
  border: "#e3dfd6",    // --border
} as const;

export const CHART_DARK_TOOLTIP_BG = "rgba(20, 26, 34, 0.98)"; // 暗色 --surface #141a22
export const CHART_DARK_TOOLTIP_BORDER = "rgba(232, 228, 218, 0.12)";
export const CHART_DARK_TEXT_COLORS = {
  primary: "#e8e4da",   // 暗色 --foreground
  title: "#e8e4da",
  secondary: "#c9ced6", // 暗色 --secondary-foreground
  tertiary: "#9aa3af",  // 暗色 --muted-foreground
} as const;

// ---------------------------------------------------------------------------
// 各仪表盘图表的专属数据色（itemStyle / sparkline color 等 JS 上下文）。
// ---------------------------------------------------------------------------

export const ECONOMIC_CHART_COLORS = { gdp: "#1f3b7b" } as const;
export const ECONOMIC_CHANGE_COLORS = { positive: "#1b9e77", negative: "#d95f02" } as const; // = --bullish / --bearish
export const MARKET_PULSE_COLOR = "#0f766e";
