import type { WarMapAisMode } from "@modular/utils";

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
