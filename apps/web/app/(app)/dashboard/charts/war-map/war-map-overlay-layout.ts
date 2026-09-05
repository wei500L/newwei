/**
 * War Map overlay 布局计算（FE-批4B：自 war-map-overlay-model.ts 拆出）。
 * 纯函数模块：密度分档与面板尺寸测量，无 React、无 "use client"。
 */
import type {
  OverlayDensity,
  WarMapLayoutVariant,
  WarMapOverlayLayout,
} from "./war-map-overlay-types";

const DESKTOP_CONTROLS_PANEL_WIDTH = 420;
const DESKTOP_INSPECTOR_PANEL_WIDTH = 360;
const DESKTOP_LEGEND_PANEL_WIDTH = 340;

interface BuildWarMapOverlayLayoutParams {
  wrapperWidth: number;
  wrapperHeight: number;
  overlayDensity: OverlayDensity;
  hasNonFatalErrors: boolean;
  layoutVariant?: WarMapLayoutVariant;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveOverlayDensity(
  width: number,
  height: number,
): OverlayDensity {
  if (width >= 1100 && height >= 560) {
    return "expanded";
  }
  if (width >= 760 && height >= 480) {
    return "compact";
  }
  return "minimal";
}

export function buildWarMapOverlayLayout({
  wrapperWidth,
  wrapperHeight,
  overlayDensity,
  hasNonFatalErrors,
  layoutVariant = "embedded",
}: BuildWarMapOverlayLayoutParams): WarMapOverlayLayout {
  const controlsPanelWidth =
    overlayDensity === "expanded"
      ? clamp(Math.round(wrapperWidth * 0.24), 320, 360)
      : overlayDensity === "compact"
        ? clamp(Math.round(wrapperWidth * 0.25), 288, 320)
        : clamp(wrapperWidth - 24, 280, DESKTOP_CONTROLS_PANEL_WIDTH);
  const legendPanelWidth =
    overlayDensity === "expanded"
      ? clamp(Math.round(wrapperWidth * 0.22), 300, DESKTOP_LEGEND_PANEL_WIDTH)
      : overlayDensity === "compact"
        ? clamp(Math.round(wrapperWidth * 0.24), 280, 312)
        : clamp(wrapperWidth - 24, 280, DESKTOP_LEGEND_PANEL_WIDTH);
  const overlayRailWidthBase =
    overlayDensity === "expanded"
      ? clamp(Math.round(wrapperWidth * 0.18), 220, 272)
      : overlayDensity === "compact"
        ? clamp(Math.round(wrapperWidth * 0.19), 208, 248)
        : clamp(wrapperWidth - 32, 220, 280);
  const standaloneDrawerHeight =
    layoutVariant === "standalone"
      ? clamp(Math.round((wrapperHeight || 640) * 0.54), 460, 620)
      : 0;

  return {
    overlayTopClassName: hasNonFatalErrors ? "top-20" : "top-4",
    overlayRailWidth: overlayRailWidthBase,
    overlayPanelMaxHeight:
      overlayDensity === "expanded"
        ? clamp(Math.round((wrapperHeight || 430) * 0.62), 340, 520)
        : overlayDensity === "compact"
          ? clamp(Math.round((wrapperHeight || 430) * 0.68), 320, 460)
          : clamp(Math.round((wrapperHeight || 430) * 0.78), 360, 620),
    controlsPanelWidth,
    legendPanelWidth,
    controlsDrawerHeight: clamp(
      Math.round((wrapperHeight || 480) * 0.78),
      400,
      640,
    ),
    standaloneDrawerHeight,
    inspectorPanelHeight:
      overlayDensity === "compact"
        ? clamp(Math.round((wrapperHeight || 430) * 0.42), 220, 300)
        : clamp(Math.round((wrapperHeight || 430) * 0.52), 240, 380),
    inspectorPanelWidth:
      overlayDensity === "compact"
        ? clamp(wrapperWidth - 32, 240, 320)
        : clamp(wrapperWidth - 32, 260, DESKTOP_INSPECTOR_PANEL_WIDTH),
    showActionLabels: overlayDensity === "expanded",
  };
}
