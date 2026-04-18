import { createApiClient, getCachedApiSession } from './api-client';

export type UserNewsBehaviorType =
  | 'view'
  | 'click'
  | 'open_event'
  | 'open_item'
  | 'bookmark'
  | 'share'
  | 'engaged_read'
  | 'deep_read'
  | 'completed_read'
  | 'not_interested'
  | 'unsubscribe';

export interface UserNewsBehaviorPayload {
  type: UserNewsBehaviorType;
  itemId?: string;
  eventId?: string;
  source?: string;
  topics?: string[];
  entities?: string[];
  url?: string;
}

const api = createApiClient();
const DEDUP_WINDOW_MS = 2000;
const SESSION_VIEW_DEDUP_KEY = 'user-news-behavior:view:v1';
const SESSION_VIEW_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSION_VIEW_ENTRIES = 1200;
const HIDDEN_EVENT_NAME = 'user-news-behavior:hidden-updated';
const HIDDEN_SURFACE_STORAGE_KEYS = {
  items: 'user-news-behavior:hidden:items:v1',
  newsnowItems: 'user-news-behavior:hidden:newsnow-items:v1',
  newsnowSources: 'user-news-behavior:hidden:newsnow-sources:v1',
} as const;
const recentEvents = new Map<string, number>();
const sessionViewedEvents = new Map<string, number>();
let sessionViewCacheHydrated = false;

export type UserNewsBehaviorHiddenSurface =
  keyof typeof HIDDEN_SURFACE_STORAGE_KEYS;

export interface ShareTrackedNewsLinkInput {
  title: string;
  url: string;
  behavior: UserNewsBehaviorPayload;
}

function canReadItems(permissions: unknown): boolean {
  if (!Array.isArray(permissions)) {
    return false;
  }

  return permissions.includes('items.read') || permissions.includes('items.write');
}

function normalizeValue(value?: string | null, maxLength = 160): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

function normalizeTerms(values?: string[] | null): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const normalized = normalizeValue(entry, 96)?.toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 12) {
      break;
    }
  }
  return out.length > 0 ? out : undefined;
}

function shouldSkipEvent(key: string, now: number) {
  const lastTs = recentEvents.get(key) ?? 0;
  if (now - lastTs < DEDUP_WINDOW_MS) {
    return true;
  }
  recentEvents.set(key, now);
  if (recentEvents.size > 200) {
    for (const [eventKey, eventTs] of recentEvents.entries()) {
      if (now - eventTs > DEDUP_WINDOW_MS * 3) {
        recentEvents.delete(eventKey);
      }
    }
  }
  return false;
}

function hydrateSessionViewCache(now: number) {
  if (sessionViewCacheHydrated || typeof window === 'undefined') {
    return;
  }
  sessionViewCacheHydrated = true;
  try {
    const raw = window.sessionStorage.getItem(SESSION_VIEW_DEDUP_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        continue;
      }
      const key = typeof entry[0] === 'string' ? entry[0] : '';
      const ts = typeof entry[1] === 'number' && Number.isFinite(entry[1]) ? entry[1] : 0;
      if (!key || ts <= 0 || now - ts > SESSION_VIEW_TTL_MS) {
        continue;
      }
      sessionViewedEvents.set(key, ts);
      if (sessionViewedEvents.size >= MAX_SESSION_VIEW_ENTRIES) {
        break;
      }
    }
  } catch {
    // Ignore malformed session cache.
  }
}

function persistSessionViewCache(now: number) {
  if (typeof window === 'undefined') {
    return;
  }
  const compactEntries: [string, number][] = [];
  for (const [key, ts] of sessionViewedEvents.entries()) {
    if (now - ts > SESSION_VIEW_TTL_MS) {
      continue;
    }
    compactEntries.push([key, ts]);
    if (compactEntries.length >= MAX_SESSION_VIEW_ENTRIES) {
      break;
    }
  }
  try {
    window.sessionStorage.setItem(SESSION_VIEW_DEDUP_KEY, JSON.stringify(compactEntries));
  } catch {
    // Ignore storage failures (private mode / quota).
  }
}

function shouldSkipViewInSession(key: string, now: number) {
  hydrateSessionViewCache(now);
  const seenAt = sessionViewedEvents.get(key) ?? 0;
  if (seenAt > 0 && now - seenAt <= SESSION_VIEW_TTL_MS) {
    return true;
  }
  sessionViewedEvents.set(key, now);

  if (sessionViewedEvents.size > MAX_SESSION_VIEW_ENTRIES) {
    const sortedByTs = Array.from(sessionViewedEvents.entries()).sort((a, b) => b[1] - a[1]);
    sessionViewedEvents.clear();
    for (const [eventKey, eventTs] of sortedByTs.slice(0, MAX_SESSION_VIEW_ENTRIES)) {
      sessionViewedEvents.set(eventKey, eventTs);
    }
  }
  persistSessionViewCache(now);
  return false;
}

function getHiddenSurfaceStorageKey(surface: UserNewsBehaviorHiddenSurface) {
  return HIDDEN_SURFACE_STORAGE_KEYS[surface];
}

function readHiddenSet(surface: UserNewsBehaviorHiddenSurface): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }
  try {
    const raw = window.sessionStorage.getItem(getHiddenSurfaceStorageKey(surface));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function writeHiddenSet(
  surface: UserNewsBehaviorHiddenSurface,
  next: Set<string>,
) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.setItem(
      getHiddenSurfaceStorageKey(surface),
      JSON.stringify(Array.from(next)),
    );
  } catch {
    // Ignore storage failures.
  }
}

function emitHiddenSurfaceUpdated(surface: UserNewsBehaviorHiddenSurface) {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<{ surface: UserNewsBehaviorHiddenSurface }>(
      HIDDEN_EVENT_NAME,
      {
        detail: { surface },
      },
    ),
  );
}

export async function trackUserNewsBehavior(payload: UserNewsBehaviorPayload) {
  if (typeof window === 'undefined') {
    return;
  }

  const session = await getCachedApiSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  if (!session?.accessToken || !canReadItems(permissions)) {
    return;
  }

  const type = payload.type;
  const source = normalizeValue(payload.source);
  const itemId = normalizeValue(payload.itemId, 128);
  const eventId = normalizeValue(payload.eventId, 128);
  const url = normalizeValue(payload.url, 2048);
  const topics = normalizeTerms(payload.topics);
  const entities = normalizeTerms(payload.entities);

  const now = Date.now();
  const dedupeKey =
    type === 'view'
      ? [type, itemId ?? '', eventId ?? '', source ?? '', url ?? ''].join('::')
      : [type, itemId ?? '', eventId ?? '', source ?? '', (topics ?? []).join('|'), (entities ?? []).join('|')].join('::');
  if (shouldSkipEvent(dedupeKey, now)) {
    return;
  }
  if (type === 'view') {
    const sessionKey = [itemId ?? '', eventId ?? '', source ?? '', url ?? ''].join('::');
    if (sessionKey !== ':::' && shouldSkipViewInSession(sessionKey, now)) {
      return;
    }
  }

  try {
    await api.post('/user-news-behavior', {
      type,
      ...(itemId ? { itemId } : {}),
      ...(eventId ? { eventId } : {}),
      ...(source ? { source } : {}),
      ...(url ? { url } : {}),
      ...(topics ? { topics } : {}),
      ...(entities ? { entities } : {}),
    });
  } catch {
    // Keep interaction non-blocking.
  }
}

export async function shareTrackedNewsLink(
  input: ShareTrackedNewsLinkInput,
): Promise<boolean> {
  if (typeof window === 'undefined') {
    return false;
  }

  const normalizedUrl = normalizeValue(input.url, 2048);
  if (!normalizedUrl) {
    return false;
  }
  const trackingUrl = normalizeValue(input.behavior.url, 2048) ?? normalizedUrl;

  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({
        title: input.title,
        url: normalizedUrl,
      });
      await trackUserNewsBehavior({
        ...input.behavior,
        type: 'share',
        url: trackingUrl,
      });
      return true;
    }
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      return false;
    }
    // Continue to clipboard fallback.
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(normalizedUrl);
      await trackUserNewsBehavior({
        ...input.behavior,
        type: 'share',
        url: trackingUrl,
      });
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export function getSessionHiddenBehaviorKeys(
  surface: UserNewsBehaviorHiddenSurface,
): string[] {
  return Array.from(readHiddenSet(surface));
}

export function isSessionHiddenBehaviorKey(
  surface: UserNewsBehaviorHiddenSurface,
  key: string,
): boolean {
  const normalizedKey = normalizeValue(key, 256);
  if (!normalizedKey) {
    return false;
  }
  return readHiddenSet(surface).has(normalizedKey);
}

export function hideSessionBehaviorKey(
  surface: UserNewsBehaviorHiddenSurface,
  key: string,
) {
  const normalizedKey = normalizeValue(key, 256);
  if (!normalizedKey || typeof window === 'undefined') {
    return false;
  }
  const next = readHiddenSet(surface);
  if (next.has(normalizedKey)) {
    return false;
  }
  next.add(normalizedKey);
  writeHiddenSet(surface, next);
  emitHiddenSurfaceUpdated(surface);
  return true;
}

export function subscribeSessionHiddenBehaviorKeys(
  surface: UserNewsBehaviorHiddenSurface,
  handler: (keys: string[]) => void,
) {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const emit = () => {
    handler(getSessionHiddenBehaviorKeys(surface));
  };

  const onCustomEvent = (
    event: Event,
  ) => {
    const customEvent = event as CustomEvent<{ surface?: UserNewsBehaviorHiddenSurface }>;
    if (customEvent.detail?.surface && customEvent.detail.surface !== surface) {
      return;
    }
    emit();
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== getHiddenSurfaceStorageKey(surface)) {
      return;
    }
    emit();
  };

  window.addEventListener(HIDDEN_EVENT_NAME, onCustomEvent);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(HIDDEN_EVENT_NAME, onCustomEvent);
    window.removeEventListener('storage', onStorage);
  };
}
