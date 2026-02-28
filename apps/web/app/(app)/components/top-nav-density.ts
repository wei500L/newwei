export type TopNavDensityMode = "full" | "compact" | "minimal";

export const NAV_FULL_MIN_WIDTH = 1700;
export const NAV_COMPACT_MIN_WIDTH = 1280;
export const NAV_OVERFLOW_EPSILON = 2;
export const NAV_UPGRADE_SLACK = 24;

export const resolveBaseDensityMode = (viewportWidth: number): TopNavDensityMode => {
  if (viewportWidth >= NAV_FULL_MIN_WIDTH) {
    return "full";
  }
  if (viewportWidth >= NAV_COMPACT_MIN_WIDTH) {
    return "compact";
  }
  return "minimal";
};

export const downgradeDensityMode = (mode: TopNavDensityMode): TopNavDensityMode => {
  if (mode === "full") {
    return "compact";
  }
  return "minimal";
};

export const alignDensityModeToBase = (
  mode: TopNavDensityMode,
  baseMode: TopNavDensityMode
): TopNavDensityMode => {
  if (baseMode === "minimal") {
    return "minimal";
  }

  if (baseMode === "compact" && mode !== "compact") {
    return "compact";
  }

  return mode;
};

export const downgradeDensityModeForBase = (
  mode: TopNavDensityMode,
  baseMode: TopNavDensityMode
): TopNavDensityMode => {
  if (mode === "minimal") {
    return "minimal";
  }

  const nextMode = downgradeDensityMode(mode);
  if (baseMode === "compact" && nextMode === "minimal") {
    return "compact";
  }
  return nextMode;
};

export const upgradeDensityMode = (
  mode: TopNavDensityMode,
  target: TopNavDensityMode
): TopNavDensityMode => {
  if (mode === target) {
    return mode;
  }

  if (mode === "minimal") {
    return target === "full" ? "compact" : target;
  }

  if (mode === "compact" && target === "full") {
    return "full";
  }

  return mode;
};
