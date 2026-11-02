/**
 * Aura 装饰色（背景光晕 / bento 卡片辉光 / 空态 SVG）的单一真源。
 *
 * 这些颜色以 JS 常量存在，而非 CSS 变量：它们被拼进 inline style 的
 * radial-gradient() 字符串、以及 SVG 的 presentation 属性(floodColor/fill=...)。
 * SVG presentation 属性与部分渐变拼接上下文都不会解析 CSS 自定义属性 var()，
 * 故集中为 JS 常量以消除跨组件的硬编码碎片（审计 W6：装饰色散落各组件 JS 里）。
 *
 * 值与迁移前逐字符一致，收敛本身零视觉变化。
 */

/** FE-UI 批0：纸面背景——顶部极淡墨蓝晕染，替代动画光斑。用 CSS 变量以随主题切换。 */
export const PAPER_BACKGROUND_GRADIENT =
  'radial-gradient(120% 60% at 50% -10%, var(--aura-color-1) 0%, transparent 60%)';

/**
 * EmptyDigestSvg 各图元的 SVG 颜色。
 * shadow: feDropShadow floodColor；aura*: 光晕圆形 fill / 图标 fill / stroke；
 * placeholder: bento 占位条 rect fill。
 */
export const EMPTY_DIGEST_SVG_COLORS = {
  shadow: '#1F3B7B',
  auraBlue: '#3B82F6',
  auraIndigo: '#6366F1',
  auraSky: '#0EA5E9',
  placeholder: '#1F2933',
} as const;
