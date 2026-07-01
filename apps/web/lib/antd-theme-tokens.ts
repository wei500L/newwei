/**
 * antd ConfigProvider 主题 token 的「品牌配色 + 阴影预设」单一真源（light / dark）。
 *
 * 这些值以 JS 常量（而非 CSS 变量）存在：它们被塞进 antd `theme.token`
 * 配置对象，由 antd 的主题算法在运行时消费并派生出成百上千个衍生 token。
 * 该算法接收的是 JS 字面量色值，不解析 CSS 自定义属性 var()——因此必须
 * 用 JS 常量。集中于此以消除 providers.tsx 内的硬编码碎片（审计 W6：
 * 主题色/阴影散落在组件里、脱离设计 token）。值与迁移前完全一致，
 * 收敛本身零视觉变化。
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
}

/** 亮色（defaultAlgorithm）下的 antd 主题色。 */
export const ANTD_COLORS_LIGHT: AntdThemeColors = {
  colorPrimary: "#1f3b7b",
  colorBgBase: "#f7f6f2",
  colorTextBase: "#1f2933",
  colorTextSecondary: "#475569",
  colorFillSecondary: "#f1f5f9",
  colorBorder: "#e2e8f0",
  colorBgContainer: "#ffffff",
  colorBgElevated: "rgba(255, 255, 255, 0.98)",
  colorBgSpotlight: "rgba(15, 23, 42, 0.95)",
  colorTextPlaceholder: "#64748b",
} as const;

/** 暗色（darkAlgorithm）下的 antd 主题色。 */
export const ANTD_COLORS_DARK: AntdThemeColors = {
  colorPrimary: "#6f9bff",
  colorBgBase: "#0b1220",
  colorTextBase: "#e2e8f0",
  colorTextSecondary: "#cbd5e1",
  colorFillSecondary: "#1e293b",
  colorBorder: "#334155",
  colorBgContainer: "rgba(15, 23, 42, 0.82)",
  colorBgElevated: "rgba(15, 23, 42, 0.95)",
  colorBgSpotlight: "rgba(2, 6, 23, 0.98)",
  colorTextPlaceholder: "#94a3b8",
} as const;

/** Card / Modal 组件的多层 box-shadow 预设。 */
export interface ShadowPreset {
  card: string;
  modal: string;
}

/** antd Card/Modal 阴影预设，按主题。 */
export const SHADOW_PRESETS: { light: ShadowPreset; dark: ShadowPreset } = {
  light: {
    card: "0 4px 6px rgba(31,59,123,0.04), 0 12px 28px rgba(31,59,123,0.06), 0 24px 48px rgba(31,59,123,0.03)",
    modal: "0 16px 40px rgba(15, 23, 42, 0.18), 0 24px 64px rgba(31,59,123,0.05)",
  },
  dark: {
    card: "0 4px 6px rgba(0,0,0,0.2), 0 12px 28px rgba(2,6,23,0.4), 0 0 48px rgba(99,102,241,0.04)",
    modal: "0 18px 42px rgba(2, 6, 23, 0.55), 0 0 64px rgba(99,102,241,0.06)",
  },
} as const;
