import type { Layout } from 'react-grid-layout';

export const SITUATION_MONITOR_GRID_BREAKPOINTS = {
  lg: 992,
  md: 768,
  sm: 576,
  xs: 480,
  xxs: 0,
} as const;

export const SITUATION_MONITOR_GRID_COLS = {
  lg: 12,
  md: 10,
  sm: 6,
  xs: 4,
  xxs: 2,
} as const;

export const SITUATION_MONITOR_GRID_BREAKPOINT_ORDER = ['lg', 'md', 'sm', 'xs', 'xxs'] as const;

export type SituationMonitorGridBreakpoint = keyof typeof SITUATION_MONITOR_GRID_COLS;

export type SituationMonitorResponsiveLayouts = Partial<Record<SituationMonitorGridBreakpoint, Layout[]>>;
