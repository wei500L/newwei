/**
 * War Map 符号系统公共出口（FE-批4B：原 1530 行实现拆分为六个领域模块）。
 *
 * 本文件只做 re-export，不含任何实现逻辑。保留原因：
 * - 仓库内 15+ 个消费方（图层/状态/面板/组合层）以此为稳定入口，
 *   分批重构期间避免一次性改动所有 import 链；
 * - 纯 re-export 不构成 barrel cycle：叶子模块（color/svg/icons/model）
 *   之间依赖单向，且不反向依赖任何组件。
 *
 * 拆分去向：
 * - 类型：war-map-symbol-types.ts
 * - 颜色归一化（唯一事实源）：war-map-symbol-color.ts
 * - SVG builder（无 React）：war-map-symbol-svg.ts
 * - palette/deck icon 缓存（唯一所有者）：war-map-symbol-icons.ts
 * - legend 模型计算（无 React）：war-map-legend-model.ts
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
  buildWarMapInteractionLegendItems,
  buildWarMapLegendSections,
  buildWarMapQuickLegendItems,
  formatWarMapClusterCountLabel,
  getQuickLegendVisibility,
  matchesWarMapLegendItem,
  resolveWarMapLegendLabel,
  selectVisibleQuickLegendItems,
} from "./war-map-legend-model";
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
