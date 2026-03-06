export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_EVENT_MIN_GROUP_SIZE = 2;
export const DEFAULT_TAB = 'events' as const;

export type TopicsTabKey = 'events' | 'topics';
export type TopicsFilterLayoutMode = 'desktopSticky' | 'inlineStatic';

interface TopicsFilterBreakpointMap {
  lg?: boolean;
}

export const parsePositiveInt = (
  value: string | string[] | null | undefined,
  fallback: number
): number => {
  if (!value || Array.isArray(value)) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
};

export const resolveTopicsFilterLayoutMode = (
  screens?: TopicsFilterBreakpointMap | null
): TopicsFilterLayoutMode => {
  return screens?.lg ? 'desktopSticky' : 'inlineStatic';
};
