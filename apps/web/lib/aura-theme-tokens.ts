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

/**
 * AuraBackground 三层径向渐变的主题配色。
 * 每套包含 color1 / color2 / color3，分别注入三个光晕层。
 * default 兜底沿用 CSS 变量（前两层）+ 白色微光（第三层）。
 */
export const AURA_BACKGROUND_COLORS = {
  finance: {
    color1: 'rgba(245, 158, 11, 0.2)',
    color2: 'rgba(217, 119, 6, 0.16)',
    color3: 'rgba(252, 211, 77, 0.12)',
  },
  tech: {
    color1: 'rgba(59, 130, 246, 0.16)',
    color2: 'rgba(139, 92, 246, 0.12)',
    color3: 'rgba(56, 189, 248, 0.1)',
  },
  default: {
    color1: 'var(--aura-color-1)',
    color2: 'var(--aura-color-2)',
    color3: 'rgba(255, 255, 255, 0.06)',
  },
} as const;

/** AuraBentoCard 鼠标跟随光晕（radial-gradient 中心色）。 */
export const AURA_CARD_GLOW = 'rgba(255,255,255,0.1)';

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
