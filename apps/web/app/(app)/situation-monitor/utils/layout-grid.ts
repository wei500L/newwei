import type { Layout } from "react-grid-layout";

import {
  SITUATION_MONITOR_GRID_BREAKPOINTS,
  SITUATION_MONITOR_GRID_COLS,
  type SituationMonitorGridBreakpoint,
} from "@/lib/situation-monitor-grid";
import {
  SITUATION_MONITOR_PANELS,
  type SituationMonitorPanelSizeProfile,
} from "@/store/situation-monitor-layout";

export const GRID_BREAKPOINTS = SITUATION_MONITOR_GRID_BREAKPOINTS;

export const GRID_COLS = SITUATION_MONITOR_GRID_COLS;

export type GridBreakpoint = SituationMonitorGridBreakpoint;

interface GridLayoutMetrics {
  rowHeight: number;
  margin: [number, number];
  defaultHeightScale: number;
  defaultHeightCap: number;
  minHeightScale: number;
  minWidthCap: number;
}

export const GRID_LAYOUT_METRICS: Record<GridBreakpoint, GridLayoutMetrics> = {
  lg: {
    rowHeight: 30,
    margin: [16, 16],
    defaultHeightScale: 1,
    defaultHeightCap: Number.POSITIVE_INFINITY,
    minHeightScale: 1,
    minWidthCap: GRID_COLS.lg,
  },
  md: {
    rowHeight: 30,
    margin: [16, 16],
    defaultHeightScale: 1,
    defaultHeightCap: Number.POSITIVE_INFINITY,
    minHeightScale: 1,
    minWidthCap: GRID_COLS.md,
  },
  sm: {
    rowHeight: 28,
    margin: [12, 12],
    defaultHeightScale: 0.9,
    defaultHeightCap: 16,
    minHeightScale: 0.85,
    minWidthCap: 3,
  },
  xs: {
    rowHeight: 24,
    margin: [10, 10],
    defaultHeightScale: 0.8,
    defaultHeightCap: 14,
    minHeightScale: 0.75,
    minWidthCap: 2,
  },
  xxs: {
    rowHeight: 22,
    margin: [8, 8],
    defaultHeightScale: 0.72,
    defaultHeightCap: 12,
    minHeightScale: 0.65,
    minWidthCap: 1,
  },
};

const LG_COLS = GRID_COLS.lg;

const DEFAULT_PANEL_LAYOUTS = new Map<string, Layout>(
  SITUATION_MONITOR_PANELS.map((panel) => [panel.id, panel.defaultLayout]),
);

const DEFAULT_PANEL_PROFILES = new Map<
  string,
  SituationMonitorPanelSizeProfile
>(SITUATION_MONITOR_PANELS.map((panel) => [panel.id, panel.sizeProfile]));

function clampColsConstraint(value: unknown, cols: number): number | undefined {
  return typeof value === "number" ? Math.min(value, cols) : undefined;
}

function clampMinWidth(
  value: unknown,
  breakpoint: GridBreakpoint,
  cols: number,
): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  const cap = GRID_LAYOUT_METRICS[breakpoint].minWidthCap;
  return Math.max(1, Math.min(value, cap, cols));
}

function clampMinHeight(
  value: unknown,
  breakpoint: GridBreakpoint,
): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  if (breakpoint === "lg" || breakpoint === "md") {
    return Math.max(1, value);
  }

  return Math.max(
    3,
    Math.round(value * GRID_LAYOUT_METRICS[breakpoint].minHeightScale),
  );
}

function desiredPanelWidth(panelId: string, cols: number): number {
  if (cols <= 6) {
    return cols;
  }

  const profile = DEFAULT_PANEL_PROFILES.get(panelId);
  if (cols === GRID_COLS.md) {
    if (profile === "hero") {
      return cols;
    }
    return 5;
  }

  return cols;
}

function scaleWidthFromLg(width: number, cols: number): number {
  return Math.max(1, Math.min(cols, Math.round((width / LG_COLS) * cols)));
}

function isPanelSizeCustomized(item: Layout): boolean {
  const defaultLayout = DEFAULT_PANEL_LAYOUTS.get(item.i);
  if (!defaultLayout) {
    return true;
  }

  return item.w !== defaultLayout.w || item.h !== defaultLayout.h;
}

function resolveResponsiveWidth(
  item: Layout,
  breakpoint: GridBreakpoint,
): number {
  const cols = GRID_COLS[breakpoint];
  const minW = clampMinWidth(item.minW, breakpoint, cols) ?? 1;
  const maxW = clampColsConstraint(item.maxW, cols) ?? cols;

  const nextWidth = isPanelSizeCustomized(item)
    ? scaleWidthFromLg(
        typeof item.w === "number" && item.w > 0 ? item.w : cols,
        cols,
      )
    : Math.min(cols, desiredPanelWidth(item.i, cols));

  return Math.min(maxW, Math.max(minW, nextWidth));
}

function resolveResponsiveHeight(
  item: Layout,
  breakpoint: GridBreakpoint,
): number {
  const baseHeight = typeof item.h === "number" && item.h > 0 ? item.h : 6;
  const minH = clampMinHeight(item.minH, breakpoint) ?? 3;
  if (
    breakpoint === "lg" ||
    breakpoint === "md" ||
    isPanelSizeCustomized(item)
  ) {
    return Math.max(minH, baseHeight);
  }

  const metrics = GRID_LAYOUT_METRICS[breakpoint];
  const scaledHeight = Math.round(baseHeight * metrics.defaultHeightScale);
  return Math.min(metrics.defaultHeightCap, Math.max(minH, scaledHeight));
}

function getRect(item: Layout) {
  return {
    x: typeof item.x === "number" ? item.x : 0,
    y: typeof item.y === "number" ? item.y : 0,
    w: typeof item.w === "number" && item.w > 0 ? item.w : 1,
    h: typeof item.h === "number" && item.h > 0 ? item.h : 1,
  };
}

function overlapDistance(
  startA: number,
  sizeA: number,
  startB: number,
  sizeB: number,
): number {
  const endA = startA + sizeA;
  const endB = startB + sizeB;
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function overlapArea(a: Layout, b: Layout): number {
  const rectA = getRect(a);
  const rectB = getRect(b);
  return (
    overlapDistance(rectA.x, rectA.w, rectB.x, rectB.w) *
    overlapDistance(rectA.y, rectA.h, rectB.y, rectB.h)
  );
}

function layoutsOverlap(a: Layout, b: Layout): boolean {
  return overlapArea(a, b) > 0;
}

function hasSameFootprint(a: Layout, b: Layout): boolean {
  const rectA = getRect(a);
  const rectB = getRect(b);
  return rectA.w === rectB.w && rectA.h === rectB.h;
}

function cloneLayout(layout: Layout[]): Layout[] {
  return layout.map((item) => ({ ...item }));
}

export function stabilizeDesktopDragLayout(
  previousLayout: Layout[],
  nextLayout: Layout[],
): Layout[] {
  const previousById = new Map(previousLayout.map((item) => [item.i, item]));
  const working = nextLayout.map((item) => ({ ...item }));

  const changedItems = working
    .map((item) => {
      const previous = previousById.get(item.i);
      if (!previous) {
        return null;
      }

      const previousRect = getRect(previous);
      const currentRect = getRect(item);
      const distance =
        Math.abs(currentRect.x - previousRect.x) +
        Math.abs(currentRect.y - previousRect.y);

      return distance > 0 ? { item, previous, distance } : null;
    })
    .filter(
      (entry): entry is { item: Layout; previous: Layout; distance: number } =>
        entry !== null,
    )
    .sort((a, b) => b.distance - a.distance);

  if (changedItems.length < 2) {
    return working;
  }

  const movedItem = changedItems[0];
  if (!movedItem) {
    return working;
  }

  const swapTargetPrevious = previousLayout
    .filter((item) => item.i !== movedItem.item.i)
    .map((item) => ({ item, area: overlapArea(item, movedItem.item) }))
    .filter((entry) => entry.area > 0)
    .sort((a, b) => b.area - a.area)[0]?.item;

  if (!swapTargetPrevious) {
    return working;
  }

  const swapTarget = working.find((item) => item.i === swapTargetPrevious.i);
  if (!swapTarget) {
    return working;
  }

  if (
    !hasSameFootprint(movedItem.previous, swapTargetPrevious) ||
    !hasSameFootprint(movedItem.item, swapTargetPrevious) ||
    !hasSameFootprint(swapTarget, movedItem.previous)
  ) {
    return working;
  }

  swapTarget.x = movedItem.previous.x;
  swapTarget.y = movedItem.previous.y;

  let restored = true;
  while (restored) {
    restored = false;

    for (const previous of previousLayout) {
      if (
        previous.i === movedItem.item.i ||
        previous.i === swapTargetPrevious.i
      ) {
        continue;
      }

      const current = working.find((item) => item.i === previous.i);
      if (!current) {
        continue;
      }

      if (current.x === previous.x && current.y === previous.y) {
        continue;
      }

      const reverted: Layout = {
        ...current,
        x: previous.x,
        y: previous.y,
      };

      const hasCollision = working.some(
        (item) => item.i !== current.i && layoutsOverlap(reverted, item),
      );
      if (!hasCollision) {
        current.x = previous.x;
        current.y = previous.y;
        restored = true;
      }
    }
  }

  return working;
}

const DEFAULT_LG_LAYOUT = cloneLayout(
  SITUATION_MONITOR_PANELS.map((panel) => panel.defaultLayout),
);

const DEFAULT_RESPONSIVE_LAYOUTS: Record<GridBreakpoint, Layout[]> = {
  lg: cloneLayout(DEFAULT_LG_LAYOUT),
  md: buildPackedResponsiveLayout(DEFAULT_LG_LAYOUT, "md"),
  sm: buildPackedResponsiveLayout(DEFAULT_LG_LAYOUT, "sm"),
  xs: buildPackedResponsiveLayout(DEFAULT_LG_LAYOUT, "xs"),
  xxs: buildPackedResponsiveLayout(DEFAULT_LG_LAYOUT, "xxs"),
};

const DEFAULT_RESPONSIVE_LAYOUT_MAPS = new Map<
  GridBreakpoint,
  Map<string, Layout>
>(
  Object.entries(DEFAULT_RESPONSIVE_LAYOUTS).map(([breakpoint, layout]) => [
    breakpoint as GridBreakpoint,
    new Map(layout.map((item) => [item.i, item])),
  ]),
);

export function getDefaultPanelLayoutForBreakpoint(
  panelId: string,
  breakpoint: GridBreakpoint,
): Layout | null {
  const item = DEFAULT_RESPONSIVE_LAYOUT_MAPS.get(breakpoint)?.get(panelId);
  return item ? { ...item } : null;
}

export function isPanelSizeCustomizedForBreakpoint(
  item: Layout,
  breakpoint: GridBreakpoint,
): boolean {
  const defaultLayout = getDefaultPanelLayoutForBreakpoint(item.i, breakpoint);
  if (!defaultLayout) {
    return true;
  }

  return item.w !== defaultLayout.w || item.h !== defaultLayout.h;
}

export function buildPackedResponsiveLayout(
  base: Layout[],
  breakpoint: GridBreakpoint,
): Layout[] {
  const cols = GRID_COLS[breakpoint];
  const ordered = base
    .slice()
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;

  return ordered.map((item) => {
    const w = resolveResponsiveWidth(item, breakpoint);
    const h = resolveResponsiveHeight(item, breakpoint);

    if (cursorX + w > cols) {
      cursorX = 0;
      cursorY += rowH;
      rowH = 0;
    }

    const next: Layout = {
      ...item,
      x: cursorX,
      y: cursorY,
      w,
      h,
      minW: clampMinWidth(item.minW, breakpoint, cols),
      maxW: clampColsConstraint(item.maxW, cols),
      minH: clampMinHeight(item.minH, breakpoint),
      i: item.i,
    };

    cursorX += w;
    rowH = Math.max(rowH, h);

    return next;
  });
}

export function projectLayoutToLg(
  nextLayout: Layout[],
  fromBreakpoint: GridBreakpoint,
): Layout[] {
  const fromCols = GRID_COLS[fromBreakpoint];
  if (fromCols >= LG_COLS) {
    return nextLayout.map((item) => ({
      i: item.i,
      x: typeof item.x === "number" ? item.x : 0,
      y: typeof item.y === "number" ? item.y : 0,
      w: typeof item.w === "number" ? item.w : 1,
      h: typeof item.h === "number" ? item.h : 1,
    }));
  }

  const scale = LG_COLS / fromCols;
  return nextLayout.map((item) => {
    const rawW = Math.max(
      1,
      Math.round((typeof item.w === "number" ? item.w : 1) * scale),
    );
    const w = Math.min(LG_COLS, rawW);
    const rawX = Math.max(
      0,
      Math.round((typeof item.x === "number" ? item.x : 0) * scale),
    );
    const x = Math.min(Math.max(0, LG_COLS - w), rawX);
    return {
      i: item.i,
      x,
      y: typeof item.y === "number" ? item.y : 0,
      w,
      h: typeof item.h === "number" ? item.h : 1,
    };
  });
}
