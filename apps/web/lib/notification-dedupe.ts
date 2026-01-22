import type { NotificationType } from "@/graphql/generated";

export interface NotificationDedupeItem {
  id: string;
  orgId?: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
  readAt?: string | null;
  createdAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeText = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

const normalizeCreatedAt = (createdAt: unknown): string => {
  if (typeof createdAt !== "string") {
    return "";
  }

  const trimmed = createdAt.trim();
  if (!trimmed) {
    return "";
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return trimmed;
  }

  return parsed.toISOString();
};

const stableJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJson(entry));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const next = value[key];
      if (next === undefined) {
        continue;
      }
      out[key] = stableJson(next);
    }
    return out;
  }

  return value;
};

const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(stableJson(value));
  } catch {
    // Should not happen for notification payloads; fallback prevents crashes.
    return "";
  }
};

export const getNotificationDedupeKey = (item: NotificationDedupeItem): string => {
  const createdAt = normalizeCreatedAt(item.createdAt);
  const title = normalizeText(item.title);
  const body = normalizeText(item.body);
  const data = stableStringify(item.data ?? null);
  return `${item.type}|${createdAt}|${title}|${body}|${data}`;
};

export const mergeNotification = (
  base: NotificationDedupeItem,
  incoming: NotificationDedupeItem
): NotificationDedupeItem => {
  return {
    ...base,
    ...incoming,
    id: base.id,
    body: base.body ?? incoming.body,
    data: base.data ?? incoming.data,
    createdAt: base.createdAt || incoming.createdAt,
    readAt: base.readAt ?? incoming.readAt,
  };
};

export const dedupeNotifications = (list: NotificationDedupeItem[]): NotificationDedupeItem[] => {
  const result: NotificationDedupeItem[] = [];
  const indexById = new Map<string, number>();
  const indexByKey = new Map<string, number>();

  for (const item of list) {
    const key = getNotificationDedupeKey(item);
    const existingIndex = indexById.get(item.id) ?? indexByKey.get(key);

    if (existingIndex === undefined) {
      result.push(item);
      const idx = result.length - 1;
      indexById.set(item.id, idx);
      indexByKey.set(key, idx);
      continue;
    }

    const existing = result[existingIndex];
    if (!existing) {
      continue;
    }
    result[existingIndex] = mergeNotification(existing, item);
    indexById.set(item.id, existingIndex);
    indexByKey.set(key, existingIndex);
  }

  return result;
};

export const upsertNotification = (
  prev: NotificationDedupeItem[],
  incoming: NotificationDedupeItem
): NotificationDedupeItem[] => {
  const incomingKey = getNotificationDedupeKey(incoming);
  const existingIndex = prev.findIndex(
    (item) => item.id === incoming.id || getNotificationDedupeKey(item) === incomingKey
  );

  if (existingIndex === -1) {
    return [incoming, ...prev];
  }

  const next = [...prev];
  const existing = prev[existingIndex];
  if (!existing) {
    return [incoming, ...prev];
  }
  next[existingIndex] = mergeNotification(existing, incoming);
  return next;
};
