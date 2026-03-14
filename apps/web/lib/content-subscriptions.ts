export type ContentSubscriptionKind = 'topic' | 'entity';

export interface ContentSubscriptionItem {
  id: string;
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  taxonomyPath: string | null;
  taxonomyDisplayName: string | null;
  taxonomyLabels: string[];
  source: 'manual' | 'recommendation' | 'related' | 'legacy';
  metadata?: unknown;
  ownerMonitorIds?: string[];
  ownerMonitorNames?: string[];
  manualMonitorOwned?: boolean;
  systemSyncOwned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContentSubscriptionCatalogItem {
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  count: number;
  lastSeenAt: string;
  taxonomyPath: string | null;
  taxonomyDisplayName: string | null;
  taxonomyLabels: string[];
  metadata?: unknown;
  score?: number;
}

export interface ContentSubscriptionListResponse {
  limitPerKind: number;
  counts: Record<ContentSubscriptionKind, number>;
  items: ContentSubscriptionItem[];
  taxonomyVersion: string;
}

export interface ContentSubscriptionCatalogResponse {
  limit: number;
  taxonomyVersion: string;
  items: ContentSubscriptionCatalogItem[];
}

export interface ContentSubscriptionBatchResultItem {
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  taxonomyPath: string | null;
  taxonomyDisplayName: string | null;
  taxonomyLabels: string[];
  status: 'subscribed' | 'already_subscribed' | 'deleted' | 'not_found' | 'limit_reached';
}

export interface ContentSubscriptionBatchResponse {
  limitPerKind: number;
  counts: Record<ContentSubscriptionKind, number>;
  items: ContentSubscriptionBatchResultItem[];
}

export function buildContentSubscriptionKey(kind: ContentSubscriptionKind, value: string) {
  return `${kind}:${value.trim().toLowerCase()}`;
}
