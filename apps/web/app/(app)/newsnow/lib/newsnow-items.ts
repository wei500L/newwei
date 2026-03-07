export interface NewsnowItemExtra {
  hover?: string;
  date?: number | string;
  info?: false | string;
  diff?: number;
  icon?: false | string | { url: string; scale: number };
}

export interface NormalizedNewsnowItem {
  id: string | number;
  title: string;
  url: string;
  mobileUrl?: string;
  pubDate?: number | string;
  extra?: NewsnowItemExtra;
}

type NewsnowItemLike = Partial<NormalizedNewsnowItem>;

function normalizeNewsItemUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNewsItemId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNewsItemTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNewsItemDate(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNewsItemExtra(value: unknown): NewsnowItemExtra | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as NewsnowItemExtra;
}

function buildNewsItemFallbackKey(item: NewsnowItemLike, index: number): string {
  const url = normalizeNewsItemUrl(item.url) ?? normalizeNewsItemUrl(item.mobileUrl);
  if (url) {
    return `url:${url}`;
  }

  const normalizedId = normalizeNewsItemId(item.id);
  if (normalizedId) {
    return `id:${normalizedId}`;
  }

  const title = normalizeNewsItemTitle(item.title).toLowerCase();
  const date = normalizeNewsItemDate(item.pubDate) ?? normalizeNewsItemDate(item.extra?.date);
  if (title) {
    return `title:${title}:${date ?? 'unknown'}`;
  }

  return `fallback:${index}`;
}

export function getNewsItemStableKey(item: NewsnowItemLike, index = 0): string {
  const normalizedId = normalizeNewsItemId(item.id);
  if (normalizedId) {
    return normalizedId;
  }

  const url = normalizeNewsItemUrl(item.url) ?? normalizeNewsItemUrl(item.mobileUrl);
  if (url) {
    return url;
  }

  const title = normalizeNewsItemTitle(item.title);
  const date = normalizeNewsItemDate(item.pubDate) ?? normalizeNewsItemDate(item.extra?.date);
  if (title) {
    return `${title}::${date ?? index}`;
  }

  return `news-item-${index}`;
}

function mergeNewsItems(
  primary: NormalizedNewsnowItem,
  duplicate: NormalizedNewsnowItem,
): NormalizedNewsnowItem {
  return {
    ...primary,
    title: primary.title || duplicate.title,
    url: primary.url || duplicate.url,
    mobileUrl: primary.mobileUrl ?? duplicate.mobileUrl,
    pubDate: primary.pubDate ?? duplicate.pubDate,
    extra:
      primary.extra || duplicate.extra
        ? {
            ...(duplicate.extra ?? {}),
            ...(primary.extra ?? {}),
          }
        : undefined,
  };
}

export function sanitizeNewsItems(items: unknown): NormalizedNewsnowItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const deduped = new Map<string, NormalizedNewsnowItem>();
  const orderedKeys: string[] = [];

  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return;
    }

    const rawItem = entry as NewsnowItemLike;
    const extra = normalizeNewsItemExtra(rawItem.extra);
    const mobileUrl = normalizeNewsItemUrl(rawItem.mobileUrl);
    const pubDate = normalizeNewsItemDate(rawItem.pubDate);
    const normalizedItem: NormalizedNewsnowItem = {
      id: normalizeNewsItemId(rawItem.id) ?? getNewsItemStableKey({ ...rawItem, extra }, index),
      title: normalizeNewsItemTitle(rawItem.title),
      url: normalizeNewsItemUrl(rawItem.url) ?? '',
      ...(mobileUrl ? { mobileUrl } : {}),
      ...(pubDate !== undefined ? { pubDate } : {}),
      ...(extra ? { extra } : {}),
    };

    const dedupeKey = buildNewsItemFallbackKey(normalizedItem, index);
    const existing = deduped.get(dedupeKey);
    if (existing) {
      deduped.set(dedupeKey, mergeNewsItems(existing, normalizedItem));
      return;
    }

    orderedKeys.push(dedupeKey);
    deduped.set(dedupeKey, normalizedItem);
  });

  return orderedKeys
    .map((key) => deduped.get(key))
    .filter((item): item is NormalizedNewsnowItem => Boolean(item));
}
