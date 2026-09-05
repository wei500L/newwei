/**
 * War Map overlay 公共出口（FE-批4B：原 534 行实现拆分为四个纯模块）。
 *
 * 本文件只做 re-export，不含实现逻辑。保留原因：
 * - 27 个消费方（hooks/图层/面板/组合层/测试）以此为稳定入口，
 *   分批重构期间避免一次性改动全部 import 链；
 * - 纯 re-export 不构成 barrel cycle：theme/types/layout/view-model
 *   四个叶子模块之间依赖单向，均不依赖任何组件。
 *
 * 拆分去向：
 * - 主题常量与按钮 class：war-map-overlay-theme.ts
 * - 领域类型：war-map-overlay-types.ts
 * - 密度分档与布局计算：war-map-overlay-layout.ts
 * - view-model 构建：war-map-overlay-view-model.ts
 */
export {
  OVERLAY_BUTTON_ACTIVE_CLASS_NAME,
  OVERLAY_BUTTON_BASE_CLASS_NAME,
  OVERLAY_BUTTON_GHOST_CLASS_NAME,
  OVERLAY_BUTTON_LINK_CLASS_NAME,
  OVERLAY_BUTTON_NEUTRAL_CLASS_NAME,
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
  OVERLAY_SURFACE_CLASS_NAME,
  OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME,
  resolveOverlayButtonClassName,
} from "./war-map-overlay-theme";
export {
  buildWarMapOverlayLayout,
  resolveOverlayDensity,
} from "./war-map-overlay-layout";
export { buildWarMapOverlayViewModel } from "./war-map-overlay-view-model";
export {
  severityTagColor,
  type OverlayControlsSection,
  type OverlayDensity,
  type OverlayPanelKey,
  type RenderableWarMapEvent,
  type RenderableWarMapNewsMarker,
  type RenderableWarMapTransportSelection,
  type SelectedCluster,
  type SelectedInspector,
  type WarMapControlsSectionMeta,
  type WarMapDetailedChainStatus,
  type WarMapFeedSummaryCard,
  type WarMapLayoutVariant,
  type WarMapOverviewMetricCard,
  type WarMapOverlayLayout,
  type WarMapOverlayTab,
  type WarMapOverlayViewModel,
  type WarMapSelectableOption,
  type WarMapSummaryStatusCard,
  type WarMapTranslateFn,
} from "./war-map-overlay-types";
