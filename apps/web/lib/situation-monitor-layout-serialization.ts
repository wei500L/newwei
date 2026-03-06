import type { Layout } from 'react-grid-layout';

import {
  SITUATION_MONITOR_GRID_BREAKPOINT_ORDER,
  type SituationMonitorGridBreakpoint,
  type SituationMonitorResponsiveLayouts,
} from '@/lib/situation-monitor-grid';
import { SITUATION_MONITOR_PANELS } from '@/store/situation-monitor-layout';

export interface SituationMonitorLayoutPayload {
  layouts: SituationMonitorResponsiveLayouts;
  visibility: Record<string, boolean>;
}

function normalizeLayoutEntry(entry: unknown): Layout | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const id = typeof record.i === 'string' ? record.i : '';
  if (!id) {
    return null;
  }

  return {
    i: id,
    x: typeof record.x === 'number' ? record.x : 0,
    y: typeof record.y === 'number' ? record.y : 0,
    w: typeof record.w === 'number' ? record.w : 0,
    h: typeof record.h === 'number' ? record.h : 0,
    minW: typeof record.minW === 'number' ? record.minW : undefined,
    minH: typeof record.minH === 'number' ? record.minH : undefined,
    maxW: typeof record.maxW === 'number' ? record.maxW : undefined,
    maxH: typeof record.maxH === 'number' ? record.maxH : undefined,
    static: typeof record.static === 'boolean' ? record.static : undefined,
  };
}

function normalizeLayoutArray(raw: unknown): Layout[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => normalizeLayoutEntry(entry))
    .filter((entry): entry is Layout => entry !== null)
    .sort((a, b) => a.i.localeCompare(b.i));
}

function normalizeLayouts(rawLayouts: unknown, rawLayout: unknown): SituationMonitorResponsiveLayouts {
  const layouts: SituationMonitorResponsiveLayouts = {};

  if (rawLayouts && typeof rawLayouts === 'object' && !Array.isArray(rawLayouts)) {
    const record = rawLayouts as Record<string, unknown>;
    for (const breakpoint of SITUATION_MONITOR_GRID_BREAKPOINT_ORDER) {
      const nextLayout = normalizeLayoutArray(record[breakpoint]);
      if (nextLayout.length > 0) {
        layouts[breakpoint] = nextLayout;
      }
    }
  }

  if (!layouts.lg) {
    const legacyLayout = normalizeLayoutArray(rawLayout);
    if (legacyLayout.length > 0) {
      layouts.lg = legacyLayout;
    }
  }

  return layouts;
}

function sortLayouts(layouts: SituationMonitorResponsiveLayouts): SituationMonitorResponsiveLayouts {
  const sorted: SituationMonitorResponsiveLayouts = {};

  for (const breakpoint of SITUATION_MONITOR_GRID_BREAKPOINT_ORDER) {
    const nextLayout = layouts[breakpoint];
    if (nextLayout && nextLayout.length > 0) {
      sorted[breakpoint] = nextLayout.map((entry) => ({ ...entry }));
    }
  }

  return sorted;
}

export function buildDefaultSituationMonitorLayoutPayload(): SituationMonitorLayoutPayload {
  return {
    layouts: {
      lg: SITUATION_MONITOR_PANELS.map((panel) => ({ ...panel.defaultLayout })),
    },
    visibility: Object.fromEntries(
      SITUATION_MONITOR_PANELS.map((panel) => [panel.id, panel.defaultVisible]),
    ) as Record<string, boolean>,
  };
}

export function normalizeSituationMonitorLayoutPayload(payload: unknown): SituationMonitorLayoutPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { layouts: {}, visibility: {} };
  }

  const record = payload as Record<string, unknown>;
  const rawVisibility = record.visibility;
  const visibilityEntries =
    rawVisibility && typeof rawVisibility === 'object' && !Array.isArray(rawVisibility)
      ? Object.entries(rawVisibility as Record<string, unknown>)
          .filter(([key, val]) => typeof key === 'string' && typeof val === 'boolean')
          .sort(([a], [b]) => a.localeCompare(b))
      : [];

  return {
    layouts: sortLayouts(normalizeLayouts(record.layouts, record.layout)),
    visibility: Object.fromEntries(visibilityEntries) as Record<string, boolean>,
  };
}

export function fingerprintSituationMonitorLayout(payload: unknown): string {
  const normalized = normalizeSituationMonitorLayoutPayload(payload);
  const serializedLayouts = Object.fromEntries(
    SITUATION_MONITOR_GRID_BREAKPOINT_ORDER.flatMap((breakpoint) => {
      const layout = normalized.layouts[breakpoint];
      return layout && layout.length > 0 ? [[breakpoint, layout]] : [];
    }),
  ) as Partial<Record<SituationMonitorGridBreakpoint, Layout[]>>;

  return JSON.stringify({ layouts: serializedLayouts, visibility: normalized.visibility });
}
