import type { WarMapAisMode } from "@modular/utils";

export const AIS_AUTO_ALL_ENTER_ZOOM = 6;
export const AIS_AUTO_ALL_EXIT_ZOOM = 5.5;

export interface ResolveEffectiveAisModeOptions {
  preferredMode: WarMapAisMode;
  autoModeEnabled: boolean;
  aisLayerVisible: boolean;
  allVesselsAvailable?: boolean;
  zoom: number;
  previousEffectiveMode?: WarMapAisMode;
}

export function resolveEffectiveAisMode(
  options: ResolveEffectiveAisModeOptions,
): WarMapAisMode {
  const {
    preferredMode,
    autoModeEnabled,
    aisLayerVisible,
    allVesselsAvailable,
    zoom,
    previousEffectiveMode,
  } = options;

  if (!autoModeEnabled || !aisLayerVisible) {
    return preferredMode;
  }

  if (allVesselsAvailable === false) {
    return preferredMode;
  }

  if (allVesselsAvailable !== true) {
    return previousEffectiveMode ?? preferredMode;
  }

  const normalizedZoom = Number.isFinite(zoom) ? zoom : 0;
  if (normalizedZoom >= AIS_AUTO_ALL_ENTER_ZOOM) {
    return "all";
  }
  if (normalizedZoom < AIS_AUTO_ALL_EXIT_ZOOM) {
    return preferredMode;
  }

  return previousEffectiveMode === "all" ? "all" : preferredMode;
}

export function isAisAutoModeActive(
  preferredMode: WarMapAisMode,
  effectiveMode: WarMapAisMode,
  autoModeEnabled: boolean,
): boolean {
  return autoModeEnabled && preferredMode !== effectiveMode;
}

export interface ResolveAisViewportEmptyStateOptions {
  effectiveMode: WarMapAisMode;
  allVesselsAvailable?: boolean;
  viewportVesselCount?: number;
  renderedVesselCount?: number;
}

export function isAisViewportEmptyStateActive(
  options: ResolveAisViewportEmptyStateOptions,
): boolean {
  const {
    effectiveMode,
    allVesselsAvailable,
    viewportVesselCount,
    renderedVesselCount,
  } = options;

  if (effectiveMode !== "all" || allVesselsAvailable !== true) {
    return false;
  }

  const visibleCount =
    typeof viewportVesselCount === "number"
      ? viewportVesselCount
      : renderedVesselCount;

  return visibleCount === 0;
}
