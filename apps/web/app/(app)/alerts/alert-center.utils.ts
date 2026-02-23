import dayjs from '@/lib/dayjs';
import type { AlertEventsQuery } from '@/graphql/generated';
import type { CsvCellValue } from '@/lib/data-export';

export type AlertEventItem = AlertEventsQuery['alertEvents'][number];

export type AlertDatePreset = 'today' | '7d' | '30d' | 'custom';

export interface AlertFilterState {
  severities: string[];
  statuses: string[];
  providers: string[];
  ruleKeyword: string;
  datePreset: AlertDatePreset;
  customRangeMs: [number | null, number | null] | null;
}

export interface AlertTimeWindow {
  startMs: number | null;
  endMs: number | null;
}

export interface AlertStats {
  total: number;
  pending: number;
  confirmed: number;
  ignored: number;
  falsePositiveRate: number | null;
}

export interface AlertTrendPoint {
  date: string;
  low: number;
  medium: number;
  high: number;
  total: number;
}

export interface SimilarAlertItem {
  event: AlertEventItem;
  reason: 'same_rule' | 'same_metric';
}

export interface AlertRuleTrendPoint {
  date: string;
  triggers: number;
  falsePositiveRate: number | null;
}

export interface AlertRuleTrendAnalysis {
  points: AlertRuleTrendPoint[];
  totalTriggers: number;
  averageDailyTriggers: number;
  falsePositiveRate: number | null;
}

export interface AlertExportOptions {
  includeContext?: boolean;
  includeDeliveries?: boolean;
}

export interface ResolveSelectedEventIdOptions {
  eventParam: string | null;
  selectedEventId: string | null;
  sortedEvents: AlertEventItem[];
  filteredEvents: AlertEventItem[];
}

const PENDING_STATUSES = new Set(['pending', 'delivered', 'failed']);

export const getEventTimestamp = (event: AlertEventItem): number => {
  const timestamp = new Date(event.triggeredAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export function resolveFilterTimeWindow(
  filterState: AlertFilterState,
  now: Date | number = Date.now()
): AlertTimeWindow {
  const nowTime = dayjs(now);
  const endMs = nowTime.endOf('day').valueOf();

  if (filterState.datePreset === 'today') {
    return {
      startMs: nowTime.startOf('day').valueOf(),
      endMs
    };
  }

  if (filterState.datePreset === '7d') {
    return {
      startMs: nowTime.subtract(6, 'day').startOf('day').valueOf(),
      endMs
    };
  }

  if (filterState.datePreset === '30d') {
    return {
      startMs: nowTime.subtract(29, 'day').startOf('day').valueOf(),
      endMs
    };
  }

  if (filterState.datePreset === 'custom' && filterState.customRangeMs) {
    const [start, end] = filterState.customRangeMs;
    if (typeof start === 'number' && typeof end === 'number') {
      return {
        startMs: dayjs(start).startOf('day').valueOf(),
        endMs: dayjs(end).endOf('day').valueOf()
      };
    }
  }

  return { startMs: null, endMs: null };
}

export function filterAlertEvents(
  events: AlertEventItem[],
  filterState: AlertFilterState,
  window: AlertTimeWindow
): AlertEventItem[] {
  const keyword = filterState.ruleKeyword.trim().toLowerCase();
  return events.filter((event) => {
    if (filterState.severities.length > 0 && !filterState.severities.includes(event.severity)) {
      return false;
    }

    if (filterState.statuses.length > 0 && !filterState.statuses.includes(event.status)) {
      return false;
    }

    if (
      filterState.providers.length > 0 &&
      (!event.metricProvider || !filterState.providers.includes(event.metricProvider))
    ) {
      return false;
    }

    if (keyword) {
      const ruleName = (event.ruleName ?? '').toLowerCase();
      if (!ruleName.includes(keyword)) {
        return false;
      }
    }

    const timestamp = getEventTimestamp(event);
    if (window.startMs !== null && timestamp < window.startMs) {
      return false;
    }
    if (window.endMs !== null && timestamp > window.endMs) {
      return false;
    }

    return true;
  });
}

export function buildAlertStats(events: AlertEventItem[]): AlertStats {
  const total = events.length;
  const confirmed = events.filter((event) => event.status === 'confirmed').length;
  const ignored = events.filter((event) => event.status === 'ignored').length;
  const pending = events.filter((event) => PENDING_STATUSES.has(event.status)).length;
  const reviewed = confirmed + ignored;

  return {
    total,
    pending,
    confirmed,
    ignored,
    falsePositiveRate: reviewed > 0 ? ignored / reviewed : null
  };
}

export function buildAlertTrend(
  events: AlertEventItem[],
  window: AlertTimeWindow
): AlertTrendPoint[] {
  if (events.length === 0) {
    return [];
  }

  const timestampList = events.map((event) => getEventTimestamp(event)).filter((value) => value > 0);
  if (timestampList.length === 0) {
    return [];
  }

  const minTs = window.startMs ?? Math.min(...timestampList);
  const maxTs = window.endMs ?? Math.max(...timestampList);
  const startDay = dayjs(minTs).startOf('day');
  const endDay = dayjs(maxTs).startOf('day');
  if (endDay.valueOf() < startDay.valueOf()) {
    return [];
  }

  const bucketByDate = new Map<string, AlertTrendPoint>();
  let cursor = startDay;
  while (cursor.valueOf() <= endDay.valueOf()) {
    const date = cursor.format('YYYY-MM-DD');
    bucketByDate.set(date, {
      date,
      low: 0,
      medium: 0,
      high: 0,
      total: 0
    });
    cursor = cursor.add(1, 'day');
  }

  for (const event of events) {
    const timestamp = getEventTimestamp(event);
    if (timestamp <= 0) {
      continue;
    }
    if (window.startMs !== null && timestamp < window.startMs) {
      continue;
    }
    if (window.endMs !== null && timestamp > window.endMs) {
      continue;
    }

    const date = dayjs(timestamp).format('YYYY-MM-DD');
    const bucket = bucketByDate.get(date);
    if (!bucket) {
      continue;
    }
    if (event.severity === 'low') {
      bucket.low += 1;
    } else if (event.severity === 'medium') {
      bucket.medium += 1;
    } else if (event.severity === 'high') {
      bucket.high += 1;
    }
    bucket.total += 1;
  }

  return [...bucketByDate.values()];
}

export function resolveSelectedEventId({
  eventParam,
  selectedEventId,
  sortedEvents,
  filteredEvents
}: ResolveSelectedEventIdOptions): string | null {
  if (sortedEvents.length === 0) {
    return null;
  }

  const sortedEventIds = new Set(sortedEvents.map((event) => event.id));

  if (eventParam && sortedEventIds.has(eventParam)) {
    return eventParam;
  }

  if (selectedEventId && sortedEventIds.has(selectedEventId)) {
    return selectedEventId;
  }

  return filteredEvents[0]?.id ?? sortedEvents[0]?.id ?? null;
}

export function buildSimilarAlerts(
  selectedEvent: AlertEventItem | null,
  events: AlertEventItem[],
  limit = 5
): SimilarAlertItem[] {
  if (!selectedEvent) {
    return [];
  }

  const selectedMetricSlug =
    typeof selectedEvent.metricSlug === 'string' ? selectedEvent.metricSlug.trim() : '';
  const candidates = events
    .filter((event) => event.id !== selectedEvent.id)
    .map((event) => {
      const eventMetricSlug = typeof event.metricSlug === 'string' ? event.metricSlug.trim() : '';
      const sameRule =
        Boolean(selectedEvent.ruleId) && Boolean(event.ruleId) && selectedEvent.ruleId === event.ruleId;
      const sameMetric =
        Boolean(selectedEvent.metricProvider) &&
        Boolean(event.metricProvider) &&
        selectedEvent.metricProvider === event.metricProvider &&
        selectedMetricSlug.length > 0 &&
        eventMetricSlug.length > 0 &&
        selectedMetricSlug === eventMetricSlug;
      const timeDistance = Math.abs(getEventTimestamp(event) - getEventTimestamp(selectedEvent));
      return { event, sameRule, sameMetric, timeDistance };
    })
    .filter((entry) => entry.sameRule || entry.sameMetric)
    .sort((a, b) => {
      if (a.sameRule !== b.sameRule) {
        return a.sameRule ? -1 : 1;
      }
      if (a.sameMetric !== b.sameMetric) {
        return a.sameMetric ? -1 : 1;
      }
      return a.timeDistance - b.timeDistance;
    })
    .slice(0, Math.max(1, limit));

  return candidates.map((entry) => ({
    event: entry.event,
    reason: entry.sameRule ? 'same_rule' : 'same_metric'
  }));
}

const resolveRuleTrendDays = (window: AlertTimeWindow, points: AlertRuleTrendPoint[]): number => {
  if (
    typeof window.startMs === 'number' &&
    Number.isFinite(window.startMs) &&
    typeof window.endMs === 'number' &&
    Number.isFinite(window.endMs) &&
    window.endMs >= window.startMs
  ) {
    const startDay = dayjs(window.startMs).startOf('day');
    const endDay = dayjs(window.endMs).startOf('day');
    if (endDay.valueOf() >= startDay.valueOf()) {
      return endDay.diff(startDay, 'day') + 1;
    }
  }

  if (window.startMs !== null && window.endMs !== null && window.endMs < window.startMs) {
    return 1;
  }

  return Math.max(points.length, 1);
};

export function buildRuleTrendAnalysis(
  ruleId: string | null | undefined,
  events: AlertEventItem[],
  window: AlertTimeWindow
): AlertRuleTrendAnalysis {
  if (!ruleId) {
    return {
      points: [],
      totalTriggers: 0,
      averageDailyTriggers: 0,
      falsePositiveRate: null
    };
  }

  const scopedEvents = events.filter((event) => {
    if (event.ruleId !== ruleId) {
      return false;
    }
    const timestamp = getEventTimestamp(event);
    if (window.startMs !== null && timestamp < window.startMs) {
      return false;
    }
    if (window.endMs !== null && timestamp > window.endMs) {
      return false;
    }
    return true;
  });

  if (scopedEvents.length === 0) {
    return {
      points: [],
      totalTriggers: 0,
      averageDailyTriggers: 0,
      falsePositiveRate: null
    };
  }

  const dateMap = new Map<
    string,
    { triggers: number; confirmed: number; ignored: number }
  >();

  for (const event of scopedEvents) {
    const date = dayjs(getEventTimestamp(event)).format('YYYY-MM-DD');
    const current = dateMap.get(date) ?? { triggers: 0, confirmed: 0, ignored: 0 };
    current.triggers += 1;
    if (event.status === 'confirmed') {
      current.confirmed += 1;
    }
    if (event.status === 'ignored') {
      current.ignored += 1;
    }
    dateMap.set(date, current);
  }

  const orderedDates = [...dateMap.keys()].sort((a, b) => a.localeCompare(b));
  const points: AlertRuleTrendPoint[] = orderedDates.map((date) => {
    const current = dateMap.get(date);
    if (!current) {
      return {
        date,
        triggers: 0,
        falsePositiveRate: null
      };
    }
    const reviewed = current.confirmed + current.ignored;
    return {
      date,
      triggers: current.triggers,
      falsePositiveRate: reviewed > 0 ? current.ignored / reviewed : null
    };
  });

  const totalTriggers = scopedEvents.length;
  const days = resolveRuleTrendDays(window, points);
  const totalConfirmed = scopedEvents.filter((event) => event.status === 'confirmed').length;
  const totalIgnored = scopedEvents.filter((event) => event.status === 'ignored').length;
  const reviewed = totalConfirmed + totalIgnored;

  return {
    points,
    totalTriggers,
    averageDailyTriggers: totalTriggers / days,
    falsePositiveRate: reviewed > 0 ? totalIgnored / reviewed : null
  };
}

const toSerializable = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const resolveThresholdText = (event: AlertEventItem): string => {
  if (typeof event.thresholdValue === 'number') {
    return `${event.operator ?? ''} ${event.thresholdValue}`.trim();
  }
  if (typeof event.thresholdLower === 'number' || typeof event.thresholdUpper === 'number') {
    return `${event.thresholdLower ?? '-'} ~ ${event.thresholdUpper ?? '-'}`;
  }
  return '';
};

const toBasicExportRecord = (
  event: AlertEventItem,
  options: AlertExportOptions
): Record<string, unknown> => {
  const record: Record<string, unknown> = {
    id: event.id,
    triggeredAt: event.triggeredAt,
    severity: event.severity,
    status: event.status,
    ruleName: event.ruleName ?? '',
    metricProvider: event.metricProvider ?? '',
    metricSlug: event.metricSlug ?? '',
    metricValue: event.metricValue,
    changePercent: typeof event.changePercent === 'number' ? event.changePercent : '',
    threshold: resolveThresholdText(event),
    message: event.message ?? ''
  };

  if (options.includeContext) {
    record.context = event.context;
  }
  if (options.includeDeliveries) {
    record.deliveries = event.deliveries;
  }

  return record;
};

export function buildAlertExportRows(
  events: AlertEventItem[],
  options: AlertExportOptions = {}
): CsvCellValue[][] {
  const includeContext = Boolean(options.includeContext);
  const includeDeliveries = Boolean(options.includeDeliveries);
  const header: CsvCellValue[] = [
    'id',
    'triggeredAt',
    'severity',
    'status',
    'ruleName',
    'metricProvider',
    'metricSlug',
    'metricValue',
    'changePercent',
    'threshold',
    'message'
  ];
  if (includeContext) {
    header.push('context');
  }
  if (includeDeliveries) {
    header.push('deliveries');
  }

  const rows = events.map((event) => {
    const row: CsvCellValue[] = [
      event.id,
      event.triggeredAt,
      event.severity,
      event.status,
      event.ruleName ?? '',
      event.metricProvider ?? '',
      event.metricSlug ?? '',
      event.metricValue,
      typeof event.changePercent === 'number' ? event.changePercent : '',
      resolveThresholdText(event),
      event.message ?? ''
    ];
    if (includeContext) {
      row.push(toSerializable(event.context));
    }
    if (includeDeliveries) {
      row.push(toSerializable(event.deliveries));
    }
    return row;
  });

  return [header, ...rows];
}

export function buildAlertExportJson(
  events: AlertEventItem[],
  options: AlertExportOptions = {}
): Record<string, unknown>[] {
  return events.map((event) => toBasicExportRecord(event, options));
}
