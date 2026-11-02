/**
 * antd ConfigProvider 主题 token 的「品牌配色 + 阴影预设」单一真源（light / dark）。
 *
 * 这些值以 JS 常量（而非 CSS 变量）存在：它们被塞进 antd `theme.token`
 * 配置对象，由 antd 的主题算法在运行时消费并派生出成百上千个衍生 token。
 * 该算法接收的是 JS 字面量色值，不解析 CSS 自定义属性 var()——因此必须
 * 用 JS 常量。集中于此以消除 providers.tsx 内的硬编码碎片（审计 W6：
 * 主题色/阴影散落在组件里、脱离设计 token）。值与迁移前完全一致，
 * 收敛本身零视觉变化。
 * FE-UI 批0：与 globals.css 的纸墨 token 一一对应，修改时两处同步
 */

/** antd `theme.token` 中随 light/dark 切换的品牌语义色键。 */
export interface AntdThemeColors {
  colorPrimary: string;
  colorBgBase: string;
  colorTextBase: string;
  colorTextSecondary: string;
  colorFillSecondary: string;
  colorBorder: string;
  colorBgContainer: string;
  colorBgElevated: string;
  colorBgSpotlight: string;
  colorTextPlaceholder: string;
  colorBorderSecondary: string;
}

/** 亮色（defaultAlgorithm）下的 antd 主题色。 */
export const ANTD_COLORS_LIGHT: AntdThemeColors = {
  colorPrimary: "#1f3b7b",
  colorBgBase: "#f5f3ee",
  colorTextBase: "#161b26",
  colorTextSecondary: "#5a6270",
  colorFillSecondary: "#efece5",
  colorBorder: "#d9d4c9",
  colorBgContainer: "#fffdf9",
  colorBgElevated: "#fffdf9",
  colorBgSpotlight: "rgba(22, 27, 38, 0.95)",
  colorTextPlaceholder: "#7a8190",
  colorBorderSecondary: "#e3dfd6",
} as const;

/** 暗色（darkAlgorithm）下的 antd 主题色。 */
export const ANTD_COLORS_DARK: AntdThemeColors = {
  colorPrimary: "#8fb0ff",
  colorBgBase: "#0d1117",
  colorTextBase: "#e8e4da",
  colorTextSecondary: "#9aa3af",
  colorFillSecondary: "#1b222c",
  colorBorder: "#2c3542",
  colorBgContainer: "#141a22",
  colorBgElevated: "#1a212b",
  colorBgSpotlight: "rgba(2, 6, 23, 0.98)",
  colorTextPlaceholder: "#7d8692",
  colorBorderSecondary: "#252d38",
} as const;

/** Card / Modal 组件的多层 box-shadow 预设。 */
export interface ShadowPreset {
  card: string;
  modal: string;
}

/** antd Card/Modal 阴影预设，按主题。 */
export const SHADOW_PRESETS: { light: ShadowPreset; dark: ShadowPreset } = {
  light: {
    card: "none",
    modal: "0 12px 32px rgba(22, 27, 38, 0.14)",
  },
  dark: {
    card: "none",
    modal: "0 16px 40px rgba(0, 0, 0, 0.5)",
  },
} as const;
