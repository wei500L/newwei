/**
 * War Map 符号系统公共出口（FE-批4B：原 1530 行实现拆分为十个领域模块）。
 *
 * 本文件只做 re-export，不含任何实现逻辑。保留原因：
 * - 仓库内 15+ 个消费方（图层/状态/面板/组合层）以此为稳定入口，
 *   分批重构期间避免一次性改动所有 import 链；
 * - 纯 re-export 不构成 barrel cycle：叶子模块（color/svg/legend model/
 *   icons）之间依赖单向，且不反向依赖任何组件。
 *
 * 拆分去向：
 * - 类型：war-map-symbol-types.ts
 * - 颜色归一化（唯一事实源）：war-map-symbol-color.ts
 * - SVG 基础原语（无 React）：war-map-symbol-svg-primitives.ts
 * - SVG glyph 构建器（无 React）：war-map-symbol-glyphs.ts
 * - SVG 公共装配（无 React）：war-map-symbol-svg.ts
 * - palette/deck icon 缓存（唯一所有者）：war-map-symbol-icons.ts
 * - legend 公共匹配/label（无 React）：war-map-legend-item-model.ts
 * - quick legend 模型（无 React）：war-map-quick-legend-model.ts
 * - 完整 legend 模型（无 React）：war-map-full-legend-model.ts
 * - swatch 组件：war-map-legend-swatch.tsx
 */
export { coerceHexColor } from "./war-map-symbol-color";
export {
  getWarMapDeckIcon,
  getWarMapLegendSvgMarkup,
  getWarMapSymbolAccentColor,
  type DeckIconDefinition,
} from "./war-map-symbol-icons";
export {
  matchesWarMapLegendItem,
  resolveWarMapLegendLabel,
} from "./war-map-legend-item-model";
export {
  buildWarMapInteractionLegendItems,
  buildWarMapLegendSections,
  formatWarMapClusterCountLabel,
} from "./war-map-full-legend-model";
export {
  buildWarMapQuickLegendItems,
  getQuickLegendVisibility,
  selectVisibleQuickLegendItems,
} from "./war-map-quick-legend-model";
export { WarMapLegendSwatch } from "./war-map-legend-swatch";
export type {
  OverlayDensity,
  WarMapActivePointLayerLegendItem,
  WarMapLegendItem,
  WarMapLegendMatchablePoint,
  WarMapLegendSection,
  WarMapLegendStatusTone,
  WarMapSymbolKey,
  WarMapSymbolState,
  WarMapTranslateFn,
  WarMapTransportLegendItemState,
  WarMapTransportLegendState,
} from "./war-map-symbol-types";
