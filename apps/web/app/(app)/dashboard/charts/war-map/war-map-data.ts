'use client';

import {
  type WarMapAisMode,
  type WarMapEvent,
  type WarMapEventsResponse,
  type WarMapFlightMode,
  type WarMapLayerDataset,
  type WarMapLayerFeature,
  type WarMapLayerId,
  type WarMapLayersResponse,
  type WarMapNewsMarker,
  type WarMapNewsMarkersResponse,
  type WarMapRequestParams,
  type WarMapTranslateTarget,
  WAR_MAP_LAYER_IDS,
} from '@modular/utils';

import type { StoredSituationMonitor } from '@/app/(app)/situation-monitor/types/situation-monitor-monitors';

const VALID_GEOMETRY_TYPES = new Set(['point', 'path', 'polygon', 'raster']);
const VALID_LAYER_IDS = new Set<string>(WAR_MAP_LAYER_IDS);
const UNSUPPORTED_LAYER_IDS = ['dayNight'] as const satisfies readonly WarMapLayerId[];

export const WAR_MAP_UNSUPPORTED_LAYER_IDS = new Set<WarMapLayerId>(UNSUPPORTED_LAYER_IDS);
export const WAR_MAP_QUERY_KEYS = {
  eventsPrefix: ['dashboard', 'war-map', 'events'] as const,
  newsMarkersPrefix: ['dashboard', 'war-map', 'news-markers'] as const,
  layersPrefix: ['dashboard', 'war-map', 'layers'] as const,
  monitors: ['situation-monitor', 'monitors', 'war-map'] as const,
};

export interface WarMapQueryInput {
  start: string;
  end: string;
  translateTarget?: WarMapTranslateTarget;
  bbox?: string;
  zoom?: number;
  cluster?: boolean;
  flightMode?: WarMapFlightMode;
  aisMode?: WarMapAisMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeLayerFeature(value: unknown): WarMapLayerFeature | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  if (!id) {
    return null;
  }

  const feature: WarMapLayerFeature = { id };
  const lat = asNumber(value.lat);
  const lng = asNumber(value.lng);
  if (typeof lat === 'number') {
    feature.lat = lat;
  }
  if (typeof lng === 'number') {
    feature.lng = lng;
  }
  if (Array.isArray(value.path)) {
    feature.path = value.path as [number, number][];
  }
  if (Array.isArray(value.polygon)) {
    feature.polygon = value.polygon as [number, number][][];
  }
  if (isRecord(value.properties)) {
    feature.properties = value.properties;
  }
  const timestamp = asString(value.timestamp);
  if (timestamp) {
    feature.timestamp = timestamp;
  }
  return feature;
}

function normalizeLayerDataset(layerId: WarMapLayerId, value: unknown): WarMapLayerDataset | null {
  if (!isRecord(value)) {
    return null;
  }

  const geometryType = asString(value.geometryType);
  if (!geometryType || !VALID_GEOMETRY_TYPES.has(geometryType)) {
    return null;
  }

  const features = Array.isArray(value.features)
    ? value.features
        .map((feature) => normalizeLayerFeature(feature))
        .filter((feature): feature is WarMapLayerFeature => Boolean(feature))
    : [];

  const dataset: WarMapLayerDataset = {
    layerId,
    geometryType: geometryType as WarMapLayerDataset['geometryType'],
    features,
  };

  const updatedAt = asString(value.updatedAt);
  if (updatedAt) {
    dataset.updatedAt = updatedAt;
  }
  if (isRecord(value.renderHints)) {
    dataset.renderHints = value.renderHints;
  }
  if (isRecord(value.summary)) {
    dataset.summary = value.summary;
  }

  return dataset;
}

function normalizeWarMapEvent(value: unknown): WarMapEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  const name = asString(value.name);
  const lat = asNumber(value.lat);
  const lng = asNumber(value.lng);
  const severity = asString(value.severity);
  if (!id || !name || typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }

  const event: WarMapEvent = {
    id,
    name,
    lat,
    lng,
    derivedScore: asNumber(value.derivedScore) ?? asNumber(value.value) ?? 0,
    value: asNumber(value.value) ?? asNumber(value.derivedScore) ?? 0,
    severity:
      severity === 'high' || severity === 'medium' || severity === 'low'
        ? severity
        : 'low',
  };

  const optionalStrings = [
    ['nameZh', value.nameZh],
    ['latestAt', value.latestAt],
  ] as const;
  for (const [key, raw] of optionalStrings) {
    const normalized = asString(raw);
    if (normalized) {
      event[key] = normalized;
    }
  }

  const optionalNumbers = [
    ['alertScore', value.alertScore],
    ['alertCount', value.alertCount],
    ['newsCount', value.newsCount],
    ['clusterId', value.clusterId],
    ['clusterCount', value.clusterCount],
  ] as const;
  for (const [key, raw] of optionalNumbers) {
    const normalized = asNumber(raw);
    if (typeof normalized === 'number') {
      event[key] = normalized as never;
    }
  }

  if (typeof value.isCluster === 'boolean') {
    event.isCluster = value.isCluster;
  }

  return event;
}

function normalizeWarMapNewsMarker(value: unknown): WarMapNewsMarker | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  const title = asString(value.title);
  const location = asString(value.location);
  const lat = asNumber(value.lat);
  const lng = asNumber(value.lng);
  if (!id || !title || !location || typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }

  const marker: WarMapNewsMarker = {
    id,
    title,
    location,
    lat,
    lng,
    geoSource: value.geoSource === 'fallback-country' ? 'fallback-country' : 'geocoded',
  };

  const optionalStrings = [
    ['titleZh', value.titleZh],
    ['url', value.url],
    ['locationZh', value.locationZh],
    ['publishedAt', value.publishedAt],
    ['ingestedAt', value.ingestedAt],
    ['displayName', value.displayName],
    ['displayNameZh', value.displayNameZh],
  ] as const;
  for (const [key, raw] of optionalStrings) {
    const normalized = raw === null && key === 'url' ? null : asString(raw);
    if (normalized) {
      marker[key] = normalized as never;
    } else if (normalized === null) {
      marker.url = null;
    }
  }

  const optionalNumbers = [
    ['clusterId', value.clusterId],
    ['clusterCount', value.clusterCount],
  ] as const;
  for (const [key, raw] of optionalNumbers) {
    const normalized = asNumber(raw);
    if (typeof normalized === 'number') {
      marker[key] = normalized as never;
    }
  }
  if (typeof value.isCluster === 'boolean') {
    marker.isCluster = value.isCluster;
  }

  return marker;
}

export function buildWarMapEventsQueryKey(input: WarMapQueryInput) {
  return [
    ...WAR_MAP_QUERY_KEYS.eventsPrefix,
    input.start,
    input.end,
    input.bbox ?? null,
    typeof input.zoom === 'number' ? Number(input.zoom.toFixed(2)) : null,
    input.translateTarget ?? null,
  ] as const;
}

export function buildWarMapNewsMarkersQueryKey(input: WarMapQueryInput) {
  return [
    ...WAR_MAP_QUERY_KEYS.newsMarkersPrefix,
    input.start,
    input.end,
    input.bbox ?? null,
    typeof input.zoom === 'number' ? Number(input.zoom.toFixed(2)) : null,
    input.translateTarget ?? null,
  ] as const;
}

export function buildWarMapLayersQueryKey(
  input: Pick<
    WarMapQueryInput,
    'start' | 'end' | 'bbox' | 'zoom' | 'translateTarget' | 'flightMode' | 'aisMode'
  >,
) {
  return [
    ...WAR_MAP_QUERY_KEYS.layersPrefix,
    input.start,
    input.end,
    input.bbox ?? null,
    typeof input.zoom === 'number' ? Number(input.zoom.toFixed(2)) : null,
    input.translateTarget ?? null,
    input.flightMode ?? 'military',
    input.aisMode ?? 'military',
  ] as const;
}

export function buildWarMapRequestParams(input: WarMapQueryInput): WarMapRequestParams {
  const params: WarMapRequestParams = {
    start: input.start,
    end: input.end,
  };

  if (input.translateTarget) {
    params.translate = input.translateTarget;
  }
  if (input.bbox) {
    params.bbox = input.bbox;
  }
  if (typeof input.zoom === 'number') {
    params.zoom = input.zoom.toFixed(2);
  }
  if (typeof input.cluster === 'boolean') {
    params.cluster = input.cluster ? '1' : '0';
  }
  if (input.flightMode) {
    params.flightMode = input.flightMode;
  }
  if (input.aisMode) {
    params.aisMode = input.aisMode;
  }

  return params;
}

export function normalizeWarMapEventsResponse(payload: unknown): WarMapEventsResponse {
  const record = isRecord(payload) ? payload : {};
  return {
    events: Array.isArray(record.events)
      ? record.events
          .map((event) => normalizeWarMapEvent(event))
          .filter((event): event is WarMapEvent => Boolean(event))
      : [],
    updatedAt: asString(record.updatedAt),
    clustered: typeof record.clustered === 'boolean' ? record.clustered : undefined,
  };
}

export function normalizeWarMapNewsMarkersResponse(payload: unknown): WarMapNewsMarkersResponse {
  const record = isRecord(payload) ? payload : {};
  return {
    markers: Array.isArray(record.markers)
      ? record.markers
          .map((marker) => normalizeWarMapNewsMarker(marker))
          .filter((marker): marker is WarMapNewsMarker => Boolean(marker))
      : [],
    updatedAt: asString(record.updatedAt),
    clustered: typeof record.clustered === 'boolean' ? record.clustered : undefined,
  };
}

export function normalizeWarMapLayersResponse(payload: unknown): WarMapLayersResponse {
  const record = isRecord(payload) ? payload : {};
  const layers: Partial<Record<WarMapLayerId, WarMapLayerDataset>> = {};
  const source = isRecord(record.layers) ? record.layers : {};

  for (const [key, value] of Object.entries(source)) {
    if (!VALID_LAYER_IDS.has(key)) {
      continue;
    }
    const layerId = key as WarMapLayerId;
    const dataset = normalizeLayerDataset(layerId, value);
    if (dataset) {
      layers[layerId] = dataset;
    }
  }

  return {
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
    layers,
  };
}

export function normalizeStoredSituationMonitors(payload: unknown): StoredSituationMonitor[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.filter((item): item is StoredSituationMonitor => isRecord(item) && typeof item.id === 'string');
}
