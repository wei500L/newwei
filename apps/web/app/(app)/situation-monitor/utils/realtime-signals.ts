import type {
  OrefHistoryEntry,
  SituationOrefAlertsResponse,
  SituationOrefHistoryResponse,
  SituationOrefRealtimePayload,
  SituationTelegramFeedResponse,
  SituationTelegramRealtimePayload,
  TelegramSignalItem,
} from '../types/situation-monitor-signals';
import type { SituationMonitorMatchResult } from '../types/situation-monitor-monitors';

import type { TelegramFeedFilterState } from './telegram-feed';

export const DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT = 80;

function mergeMonitorMatches(
  current: SituationMonitorMatchResult[] | undefined,
  incoming: SituationMonitorMatchResult[] | undefined,
  options?: { replaceKeys?: string[]; allowedKeys?: string[] },
): SituationMonitorMatchResult[] | undefined {
  const shouldReplace = incoming !== undefined;
  const replaceKeys = new Set(options?.replaceKeys ?? []);
  const allowedKeys = options?.allowedKeys ? new Set(options.allowedKeys) : null;
  const merged = new Map<string, SituationMonitorMatchResult>();

  for (const match of current ?? []) {
    if (shouldReplace && replaceKeys.has(match.itemKey)) {
      continue;
    }
    if (allowedKeys && !allowedKeys.has(match.itemKey)) {
      continue;
    }
    merged.set(`${match.itemKey}::${match.monitorId}`, match);
  }

  for (const match of incoming ?? []) {
    if (allowedKeys && !allowedKeys.has(match.itemKey)) {
      continue;
    }
    const key = `${match.itemKey}::${match.monitorId}`;
    const existing = merged.get(key);
    if (!existing || match.score >= existing.score) {
      merged.set(key, match);
    }
  }

  const results = Array.from(merged.values());
  if (results.length === 0) {
    return undefined;
  }
  results.sort(
    (left, right) =>
      left.itemKey.localeCompare(right.itemKey) ||
      right.score - left.score ||
      left.monitorName.localeCompare(right.monitorName),
  );
  return results;
}

function normalizeTelegramFilterValue(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'all') {
    return null;
  }
  return normalized;
}

function matchesTelegramFeedFilters(
  item: TelegramSignalItem,
  filters: TelegramFeedFilterState,
): boolean {
  const topicFilter = normalizeTelegramFilterValue(filters.topic);
  if (topicFilter && item.topic.trim().toLowerCase() !== topicFilter) {
    return false;
  }

  const channelFilter = normalizeTelegramFilterValue(filters.channel);
  if (channelFilter && item.channel.trim().toLowerCase() !== channelFilter) {
    return false;
  }

  return true;
}

function getTelegramMatchKey(item: TelegramSignalItem): string {
  return `telegram:${item.id}`;
}

function getOrefAlertMatchKey(id: string): string {
  return `oref:${id}`;
}

function getOrefHistoryMatchKeys(entry: OrefHistoryEntry): string[] {
  return (entry.alerts ?? []).map(
    (alert) => `oref-history:${entry.timestamp}:${alert.id}`,
  );
}

export function mergeTelegramFeedRealtime(
  current: SituationTelegramFeedResponse | null,
  payload: SituationTelegramRealtimePayload,
  filters: TelegramFeedFilterState,
  options?: { limit?: number },
): SituationTelegramFeedResponse | null {
  if (!current) {
    return current;
  }

  const limit = Number.isFinite(Number(options?.limit))
    ? Math.max(1, Math.floor(Number(options?.limit)))
    : DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT;

  const seen = new Set<string>();
  const items = [...payload.items, ...current.items]
    .filter((item) => matchesTelegramFeedFilters(item, filters))
    .filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, limit);

  const allowedKeys = items.map(getTelegramMatchKey);
  const replaceKeys = payload.items.map(getTelegramMatchKey);

  const { error: _error, ...rest } = current;
  return {
    ...rest,
    count: items.length,
    updatedAt: payload.updatedAt,
    items,
    monitorMatches: mergeMonitorMatches(
      current.monitorMatches,
      payload.monitorMatches,
      { replaceKeys, allowedKeys },
    ),
  };
}

export function mergeOrefAlertsRealtime(
  current: SituationOrefAlertsResponse | null,
  payload: SituationOrefRealtimePayload,
): SituationOrefAlertsResponse | null {
  if (!current) {
    return current;
  }

  const { error: _error, ...rest } = current;
  return {
    ...rest,
    alerts: payload.alerts,
    historyCount24h: payload.historyCount24h,
    totalHistoryCount: payload.totalHistoryCount,
    timestamp: payload.updatedAt,
    monitorMatches: mergeMonitorMatches(
      current.monitorMatches,
      payload.alertMonitorMatches,
      {
        replaceKeys: payload.alerts.map((alert) => getOrefAlertMatchKey(alert.id)),
        allowedKeys: payload.alerts.map((alert) => getOrefAlertMatchKey(alert.id)),
      },
    ),
  };
}

function appendOrefHistoryEntry(
  history: OrefHistoryEntry[],
  entry: OrefHistoryEntry,
): OrefHistoryEntry[] {
  const withoutDuplicate = history.filter(
    (item) => item.timestamp !== entry.timestamp,
  );
  return [...withoutDuplicate, entry];
}

export function mergeOrefHistoryRealtime(
  current: SituationOrefHistoryResponse | null,
  payload: SituationOrefRealtimePayload,
): SituationOrefHistoryResponse | null {
  if (!current) {
    return current;
  }

  const history =
    payload.historyEntry
      ? appendOrefHistoryEntry(current.history, payload.historyEntry)
      : current.history;
  const allowedKeys = history.flatMap(getOrefHistoryMatchKeys);
  const replaceKeys = payload.historyEntry
    ? getOrefHistoryMatchKeys(payload.historyEntry)
    : [];

  const { error: _error, ...rest } = current;
  return {
    ...rest,
    history,
    historyCount24h: payload.historyCount24h,
    totalHistoryCount: payload.totalHistoryCount,
    timestamp: payload.updatedAt,
    monitorMatches: mergeMonitorMatches(
      current.monitorMatches,
      payload.historyMonitorMatches,
      { replaceKeys, allowedKeys },
    ),
  };
}
