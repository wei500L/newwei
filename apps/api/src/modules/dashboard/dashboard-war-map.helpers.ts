import { ProcessedItemModel, RawItemModel } from '@modular/mongo';
import {
  extractCountryCodeFromText,
  type WarMapAisDensityProperties,
  type WarMapAisDisruptionProperties,
  type WarMapAisLayerSummary,
  type WarMapAisVesselProperties,
  type WarMapEvent,
  type WarMapEventSeverity,
  type WarMapFlightProperties,
  type WarMapLayerDataset,
  type WarMapLayerFeature,
  type WarMapLayerId,
  type WarMapNewsMarker,
  WAR_MAP_LAYER_IDS,
  normalizeCountryCode,
} from '@modular/utils';
import { AlertSeverity } from '@prisma/client';

import type { CacheService } from '../cache/cache.service';
import type { PrismaService } from '../config/prisma.service';
import type { GeocodingService } from '../geo/geocoding.service';
import { buildAisRuntimeSemantics } from '../realtime-signals/ais-runtime-semantics';
import type { RealtimeSignalsService } from '../realtime-signals/realtime-signals.service';
import type { RealtimeSignalsSnapshotStore } from '../realtime-signals/realtime-signals.snapshot-store';
import type {
  RealtimeAdsbAircraftSnapshot,
  RealtimeAisLatestSnapshot,
  RealtimeAisVesselSnapshot,
} from '../realtime-signals/realtime-signals.types';
import {
  classifyAircraftTransport,
  classifyAisShipType,
} from '../realtime-signals/transport-classification';
import type { SituationMonitorTranslationService } from '../situation-monitor/situation-monitor-translation.service';

import {
  AIS_ALL_MODE_BLOCKED_REASON_CODES,
  DEFAULT_WAR_MAP_BBOX,
  DEFAULT_WAR_MAP_CLUSTER_ZOOM,
  MAX_WAR_MAP_AIS_CELL_SIZE_DEG,
  MAX_WAR_MAP_AIS_GLOBAL_HIGH_ZOOM,
  MAX_WAR_MAP_AIS_GLOBAL_LOW_ZOOM,
  MAX_WAR_MAP_AIS_GLOBAL_MAX,
  MAX_WAR_MAP_AIS_GLOBAL_MID_ZOOM,
  MAX_WAR_MAP_AIS_VIEWPORT_HIGH_ZOOM,
  MAX_WAR_MAP_AIS_VIEWPORT_LOW_ZOOM,
  MAX_WAR_MAP_AIS_VIEWPORT_MAX,
  MAX_WAR_MAP_AIS_VIEWPORT_MID_ZOOM,
  MAX_WAR_MAP_CLUSTER_ZOOM,
  MAX_WAR_MAP_FLIGHTS_GLOBAL_HIGH_ZOOM,
  MAX_WAR_MAP_FLIGHTS_GLOBAL_LOW_ZOOM,
  MAX_WAR_MAP_FLIGHTS_GLOBAL_MAX,
  MAX_WAR_MAP_FLIGHTS_GLOBAL_MID_ZOOM,
  MAX_WAR_MAP_FLIGHTS_VIEWPORT_HIGH_ZOOM,
  MAX_WAR_MAP_FLIGHTS_VIEWPORT_LOW_ZOOM,
  MAX_WAR_MAP_FLIGHTS_VIEWPORT_MAX,
  MAX_WAR_MAP_FLIGHTS_VIEWPORT_MID_ZOOM,
  MIN_WAR_MAP_AIS_CELL_SIZE_DEG,
  MIN_WAR_MAP_FLIGHT_CELL_SIZE_DEG,
  WAR_MAP_LAYER_COLORS,
  WAR_MAP_LAYER_KEYWORDS,
  type DateRange,
  type WarMapCleanedEntity,
  type WarMapLayersOptions,
  type WarMapMongoLocationRecord,
  type WarMapRealtimeLayerSeedPoint,
  clampFinite,
  normalizeMongoId,
  alertSeverityRank,
  alertSeverityByRank,
  type WarMapEventsOptions,
  type WarMapNewsMarkersOptions,
} from './dashboard-charts.helpers';
import { type WarMapLayersResponse as WarMapStaticLayersResponse } from './war-map-layers';

export class DashboardWarMapSupport {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly geocoding: GeocodingService,
    protected readonly cache: CacheService,
    protected readonly translation?: SituationMonitorTranslationService,
    protected readonly realtimeSignals?: RealtimeSignalsService,
    protected readonly realtimeSignalsStore?: RealtimeSignalsSnapshotStore,
  ) {}

  protected parseWarMapDate(value: unknown): Date | undefined {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime())) {
        return parsed;
      }
    }
    return undefined;
  }

  protected buildWarMapMongoRangeFilter(range: DateRange): Record<string, unknown> {
    return {
      $or: [
        { sortAt: { $gte: range.start, $lte: range.end } },
        {
          sortAt: { $exists: false },
          ingestedAt: { $gte: range.start, $lte: range.end },
        },
        {
          sortAt: null,
          ingestedAt: { $gte: range.start, $lte: range.end },
        },
        {
          sortAt: { $exists: false },
          ingestedAt: { $exists: false },
          createdAt: { $gte: range.start, $lte: range.end },
        },
        {
          sortAt: null,
          ingestedAt: { $exists: false },
          createdAt: { $gte: range.start, $lte: range.end },
        },
      ],
    };
  }

  protected normalizeWarMapEntities(input: unknown): WarMapCleanedEntity[] {
    if (!Array.isArray(input)) {
      return [];
    }
    const entities: WarMapCleanedEntity[] = [];
    for (const entry of input) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const type = typeof record.type === 'string' ? record.type.trim() : '';
      const confidenceRaw = record.confidence;
      const confidence =
        typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : 0;
      if (!name || !type) {
        continue;
      }
      entities.push({ name, type, confidence });
    }
    return entities;
  }

  protected isWarMapLocationEntityType(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return (
      normalized === 'location' ||
      normalized.includes('loc') ||
      normalized.includes('place') ||
      normalized.includes('geo') ||
      normalized.includes('city') ||
      normalized.includes('country') ||
      normalized.includes('region') ||
      normalized.includes('state') ||
      normalized.includes('province') ||
      normalized.includes('地点') ||
      normalized.includes('地點') ||
      normalized.includes('地区') ||
      normalized.includes('地區') ||
      normalized.includes('城市') ||
      normalized.includes('国家') ||
      normalized.includes('國家')
    );
  }

  protected resolveWarMapCountryAlpha3(
    location: string,
    entities: WarMapCleanedEntity[],
  ): string | null {
    const fromLocation = extractCountryCodeFromText(location) ?? normalizeCountryCode(location);
    if (fromLocation) {
      return fromLocation;
    }
    for (const entity of entities) {
      const code = normalizeCountryCode(entity.name) ?? extractCountryCodeFromText(entity.name);
      if (code) {
        return code;
      }
    }
    return null;
  }

  protected buildWarMapGeocodeCandidates(
    location: string,
    entities: WarMapCleanedEntity[],
    countryName?: string | null,
  ): string[] {
    const candidates: string[] = [];
    const pushCandidate = (value: string) => {
      const normalized = value.trim();
      if (!normalized) return;
      candidates.push(normalized);
    };

    const locationEntities = entities
      .filter((entity) => entity.confidence >= 0.5 && this.isWarMapLocationEntityType(entity.type))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    for (const entity of locationEntities) {
      if (countryName && !entity.name.toLowerCase().includes(countryName.toLowerCase())) {
        pushCandidate(`${entity.name}, ${countryName}`);
      }
      pushCandidate(entity.name);
    }

    const primaryLocationChunk = location.split(/[,，;；/|]/)[0]?.trim() ?? '';
    if (primaryLocationChunk && primaryLocationChunk !== location) {
      if (countryName && !primaryLocationChunk.toLowerCase().includes(countryName.toLowerCase())) {
        pushCandidate(`${primaryLocationChunk}, ${countryName}`);
      }
      pushCandidate(primaryLocationChunk);
    }

    if (countryName && !location.toLowerCase().includes(countryName.toLowerCase())) {
      pushCandidate(`${location}, ${countryName}`);
    }
    pushCandidate(location);
    if (countryName) {
      pushCandidate(countryName);
    }

    return candidates;
  }

  protected async loadMongoWarMapLocationRecords(
    range: DateRange,
    orgId: string,
    limit: number,
  ): Promise<WarMapMongoLocationRecord[]> {
    const normalizedLimit = Math.max(1, Math.min(2_500, Math.round(limit)));
    const rawDocs = (await ProcessedItemModel.find(
      {
        orgId,
        status: 'completed',
        hasLocation: true,
        duplicateOf: null,
        ...this.buildWarMapMongoRangeFilter(range),
      },
      {
        _id: 1,
        rawItemId: 1,
        sortAt: 1,
        ingestedAt: 1,
        createdAt: 1,
        'result.location': 1,
        'result.title': 1,
        'result.entities': 1,
        'result.published_at': 1,
      },
    )
      .sort({ sortAt: -1, ingestedAt: -1, createdAt: -1 })
      .limit(normalizedLimit)
      .lean()
      .exec()) as unknown;

    if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
      return [];
    }

    const rawItemIds = Array.from(
      new Set(
        rawDocs
          .map((entry) =>
            entry && typeof entry === 'object'
              ? normalizeMongoId((entry as Record<string, unknown>).rawItemId)
              : '',
          )
          .filter((value) => value.length > 0),
      ),
    );

    const rawUrlByRawItemId = new Map<string, string>();
    if (rawItemIds.length > 0) {
      try {
        const rawItems = (await RawItemModel.find(
          { _id: { $in: rawItemIds } },
          { _id: 1, payload: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(rawItems)) {
          for (const rawItem of rawItems) {
            if (!rawItem || typeof rawItem !== 'object') {
              continue;
            }
            const payload = rawItem as Record<string, unknown>;
            const rawItemId = normalizeMongoId(payload._id);
            if (!rawItemId) {
              continue;
            }
            const rawPayload =
              payload.payload &&
              typeof payload.payload === 'object' &&
              !Array.isArray(payload.payload)
                ? (payload.payload as Record<string, unknown>)
                : null;
            const url = typeof rawPayload?.url === 'string' ? rawPayload.url.trim() : '';
            if (url) {
              rawUrlByRawItemId.set(rawItemId, url);
            }
          }
        }
      } catch {
        // URL enrichment is best-effort for Mongo fallback records.
      }
    }

    const records: WarMapMongoLocationRecord[] = [];
    for (const entry of rawDocs) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const doc = entry as Record<string, unknown>;
      const result =
        doc.result && typeof doc.result === 'object' && !Array.isArray(doc.result)
          ? (doc.result as Record<string, unknown>)
          : null;
      const location = typeof result?.location === 'string' ? result.location.trim() : '';
      if (!location) {
        continue;
      }

      const id = normalizeMongoId(doc._id);
      if (!id) {
        continue;
      }
      const rawItemId = normalizeMongoId(doc.rawItemId);
      const url = rawItemId ? (rawUrlByRawItemId.get(rawItemId) ?? null) : null;
      const title = typeof result?.title === 'string' ? result.title.trim() : undefined;

      records.push({
        id,
        location,
        entities: result?.entities,
        title: title && title.length > 0 ? title : undefined,
        url,
        sortAt: this.parseWarMapDate(doc.sortAt),
        ingestedAt: this.parseWarMapDate(doc.ingestedAt),
        createdAt: this.parseWarMapDate(doc.createdAt),
        publishedAt: this.parseWarMapDate(result?.published_at),
      });
    }

    return records;
  }

  protected resolveWarMapClusterBbox(
    bbox?: [number, number, number, number],
  ): [number, number, number, number] {
    if (!bbox) {
      return DEFAULT_WAR_MAP_BBOX;
    }
    const [minLng, minLat, maxLng, maxLat] = bbox;
    return [
      clampFinite(minLng, -180, 180),
      clampFinite(minLat, -90, 90),
      clampFinite(maxLng, -180, 180),
      clampFinite(maxLat, -90, 90),
    ];
  }

  protected resolveWarMapClusterZoom(zoom?: number): number {
    const normalized =
      typeof zoom === 'number' && Number.isFinite(zoom)
        ? Math.round(zoom)
        : DEFAULT_WAR_MAP_CLUSTER_ZOOM;
    return Math.max(0, Math.min(MAX_WAR_MAP_CLUSTER_ZOOM, normalized));
  }

  protected resolveWarMapClusterCellSizeDegrees(zoom?: number): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(zoom);
    const scale = Math.pow(2, normalizedZoom / 2);
    const rawCellSize = 24 / scale;
    return clampFinite(rawCellSize, 0.35, 32);
  }

  protected buildWarMapClusterCellKey(
    lat: number,
    lng: number,
    bbox: [number, number, number, number],
    cellSizeDeg: number,
  ): string {
    const [minLng, minLat] = bbox;
    const x = Math.floor((lng - minLng) / cellSizeDeg);
    const y = Math.floor((lat - minLat) / cellSizeDeg);
    return `${x}:${y}`;
  }

  protected isWithinWarMapBbox(
    lat: number,
    lng: number,
    bbox: [number, number, number, number],
  ): boolean {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
  }

  protected filterWarMapPointsByBbox<T extends { lat: number; lng: number }>(
    points: T[],
    bbox?: [number, number, number, number],
  ): T[] {
    if (!bbox) {
      return points;
    }
    return points.filter((point) => this.isWithinWarMapBbox(point.lat, point.lng, bbox));
  }

  protected isAdsbSnapshotFresh(
    snapshot: {
      updatedAt: string;
      latestObservedAt?: string;
      validPositionCount: number;
      diagnostics: { staleThresholdSec: number; latestObservedAt?: string };
    },
    nowMs: number,
  ): boolean {
    if (snapshot.validPositionCount <= 0) {
      return false;
    }
    const staleThresholdMs = Math.max(60_000, snapshot.diagnostics.staleThresholdSec * 1_000);
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs > staleThresholdMs) {
      return false;
    }
    const latestObservedAt = snapshot.latestObservedAt ?? snapshot.diagnostics.latestObservedAt;
    const latestObservedAtMs = latestObservedAt ? Date.parse(latestObservedAt) : Number.NaN;
    if (!Number.isFinite(latestObservedAtMs)) {
      return false;
    }
    return nowMs - latestObservedAtMs <= staleThresholdMs;
  }

  protected resolveWarMapFlightsMaxPoints(
    options: Pick<WarMapLayersOptions, 'bbox' | 'zoom'>,
  ): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(options.zoom);
    if (!options.bbox) {
      if (normalizedZoom <= 2) {
        return MAX_WAR_MAP_FLIGHTS_GLOBAL_LOW_ZOOM;
      }
      if (normalizedZoom <= 4) {
        return MAX_WAR_MAP_FLIGHTS_GLOBAL_MID_ZOOM;
      }
      if (normalizedZoom <= 6) {
        return MAX_WAR_MAP_FLIGHTS_GLOBAL_HIGH_ZOOM;
      }
      return MAX_WAR_MAP_FLIGHTS_GLOBAL_MAX;
    }

    if (normalizedZoom <= 2) {
      return MAX_WAR_MAP_FLIGHTS_VIEWPORT_LOW_ZOOM;
    }
    if (normalizedZoom <= 4) {
      return MAX_WAR_MAP_FLIGHTS_VIEWPORT_MID_ZOOM;
    }
    if (normalizedZoom <= 6) {
      return MAX_WAR_MAP_FLIGHTS_VIEWPORT_HIGH_ZOOM;
    }
    return MAX_WAR_MAP_FLIGHTS_VIEWPORT_MAX;
  }

  protected resolveWarMapFlightsPerCellLimit(zoom?: number): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(zoom);
    if (normalizedZoom <= 2) {
      return 1;
    }
    if (normalizedZoom <= 4) {
      return 2;
    }
    if (normalizedZoom <= 6) {
      return 3;
    }
    if (normalizedZoom <= 8) {
      return 5;
    }
    return 8;
  }

  protected resolveWarMapAisMaxPoints(options: Pick<WarMapLayersOptions, 'bbox' | 'zoom'>): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(options.zoom);
    if (!options.bbox) {
      if (normalizedZoom <= 2) {
        return MAX_WAR_MAP_AIS_GLOBAL_LOW_ZOOM;
      }
      if (normalizedZoom <= 4) {
        return MAX_WAR_MAP_AIS_GLOBAL_MID_ZOOM;
      }
      if (normalizedZoom <= 6) {
        return MAX_WAR_MAP_AIS_GLOBAL_HIGH_ZOOM;
      }
      return MAX_WAR_MAP_AIS_GLOBAL_MAX;
    }

    if (normalizedZoom <= 2) {
      return MAX_WAR_MAP_AIS_VIEWPORT_LOW_ZOOM;
    }
    if (normalizedZoom <= 4) {
      return MAX_WAR_MAP_AIS_VIEWPORT_MID_ZOOM;
    }
    if (normalizedZoom <= 6) {
      return MAX_WAR_MAP_AIS_VIEWPORT_HIGH_ZOOM;
    }
    return MAX_WAR_MAP_AIS_VIEWPORT_MAX;
  }

  protected resolveWarMapAisPerCellLimit(zoom?: number): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(zoom);
    if (normalizedZoom <= 2) {
      return 1;
    }
    if (normalizedZoom <= 4) {
      return 2;
    }
    if (normalizedZoom <= 6) {
      return 3;
    }
    if (normalizedZoom <= 8) {
      return 5;
    }
    return 8;
  }

  protected resolveWarMapAisCellSizeDegrees(zoom?: number): number {
    return clampFinite(
      this.resolveWarMapClusterCellSizeDegrees(zoom),
      MIN_WAR_MAP_AIS_CELL_SIZE_DEG,
      MAX_WAR_MAP_AIS_CELL_SIZE_DEG,
    );
  }

  protected shapeWarMapFlightsForViewport(
    aircraft: RealtimeAdsbAircraftSnapshot[],
    options: Pick<WarMapLayersOptions, 'bbox' | 'zoom'>,
  ): RealtimeAdsbAircraftSnapshot[] {
    const filtered = this.filterWarMapPointsByBbox(aircraft, options.bbox);
    const maxPoints = this.resolveWarMapFlightsMaxPoints(options);
    if (filtered.length <= maxPoints) {
      return filtered;
    }

    const bbox = this.resolveWarMapClusterBbox(options.bbox);
    const cellSizeDeg = clampFinite(
      this.resolveWarMapClusterCellSizeDegrees(options.zoom) * 0.75,
      MIN_WAR_MAP_FLIGHT_CELL_SIZE_DEG,
      24,
    );
    const perCellLimit = this.resolveWarMapFlightsPerCellLimit(options.zoom);
    const cellCounts = new Map<string, number>();
    const selected: RealtimeAdsbAircraftSnapshot[] = [];

    for (const entry of filtered) {
      const cellKey = this.buildWarMapClusterCellKey(entry.lat, entry.lng, bbox, cellSizeDeg);
      const currentCount = cellCounts.get(cellKey) ?? 0;
      if (currentCount >= perCellLimit) {
        continue;
      }
      cellCounts.set(cellKey, currentCount + 1);
      selected.push(entry);
      if (selected.length >= maxPoints) {
        break;
      }
    }

    return selected.length > 0 ? selected : filtered.slice(0, maxPoints);
  }

  protected clusterWarMapEvents(
    events: WarMapEvent[],
    options: Pick<WarMapEventsOptions, 'bbox' | 'zoom' | 'cluster'>,
  ): WarMapEvent[] {
    const filteredEvents = this.filterWarMapPointsByBbox(events, options.bbox);
    if (!options.cluster) {
      return filteredEvents;
    }
    const clusterBbox = this.resolveWarMapClusterBbox(options.bbox);
    const eventsForClustering = this.filterWarMapPointsByBbox(filteredEvents, clusterBbox);
    if (eventsForClustering.length === 0) {
      return [];
    }
    const cellSizeDeg = this.resolveWarMapClusterCellSizeDegrees(options.zoom);
    const groups = new Map<
      string,
      {
        clusterId: number;
        events: WarMapEvent[];
        weightTotal: number;
        latWeighted: number;
        lngWeighted: number;
        maxSeverityRank: number;
        derivedScore: number;
        alertScore: number;
        alertCount: number;
        newsCount: number;
        latestEpoch: number;
      }
    >();
    let clusterIdSeq = 1;

    for (const event of eventsForClustering) {
      const key = this.buildWarMapClusterCellKey(event.lat, event.lng, clusterBbox, cellSizeDeg);
      const group = groups.get(key) ?? {
        clusterId: clusterIdSeq,
        events: [],
        weightTotal: 0,
        latWeighted: 0,
        lngWeighted: 0,
        maxSeverityRank: 0,
        derivedScore: 0,
        alertScore: 0,
        alertCount: 0,
        newsCount: 0,
        latestEpoch: 0,
      };
      if (!groups.has(key)) {
        clusterIdSeq += 1;
      }

      const weight = Math.max(1, event.derivedScore ?? event.value ?? 1);
      group.events.push(event);
      group.weightTotal += weight;
      group.latWeighted += event.lat * weight;
      group.lngWeighted += event.lng * weight;
      group.maxSeverityRank = Math.max(
        group.maxSeverityRank,
        alertSeverityRank[event.severity] ?? 1,
      );
      group.derivedScore += event.derivedScore;
      group.alertScore += event.alertScore ?? 0;
      group.alertCount += event.alertCount ?? 0;
      group.newsCount += event.newsCount ?? 0;
      const latestEpochRaw = event.latestAt ? Date.parse(event.latestAt) : NaN;
      const latestEpoch = Number.isFinite(latestEpochRaw) ? latestEpochRaw : 0;
      group.latestEpoch = Math.max(group.latestEpoch, latestEpoch);
      groups.set(key, group);
    }

    const result: WarMapEvent[] = [];
    for (const group of groups.values()) {
      if (group.events.length <= 1) {
        const single = group.events[0];
        if (single) {
          result.push(single);
        }
        continue;
      }

      const severityRank = Math.max(1, Math.round(group.maxSeverityRank));
      const severity = alertSeverityByRank[severityRank] ?? AlertSeverity.low;
      const derivedScore = Number(group.derivedScore.toFixed(2));
      const centerLat =
        group.weightTotal > 0 ? group.latWeighted / group.weightTotal : (group.events[0]?.lat ?? 0);
      const centerLng =
        group.weightTotal > 0 ? group.lngWeighted / group.weightTotal : (group.events[0]?.lng ?? 0);

      result.push({
        id: `cluster-${group.clusterId}`,
        name: `Cluster (${group.events.length})`,
        lat: clampFinite(centerLat, -90, 90),
        lng: clampFinite(centerLng, -180, 180),
        severity,
        isCluster: true,
        clusterId: group.clusterId,
        clusterCount: group.events.length,
        latestAt: group.latestEpoch > 0 ? new Date(group.latestEpoch).toISOString() : undefined,
        derivedScore,
        value: derivedScore,
        alertScore: Number(group.alertScore.toFixed(2)),
        alertCount: group.alertCount,
        newsCount: group.newsCount,
      });
    }

    return result;
  }

  protected clusterWarMapNewsMarkers(
    markers: WarMapNewsMarker[],
    options: Pick<WarMapNewsMarkersOptions, 'bbox' | 'zoom' | 'cluster'>,
  ): WarMapNewsMarker[] {
    const filteredMarkers = this.filterWarMapPointsByBbox(markers, options.bbox);
    if (!options.cluster) {
      return filteredMarkers;
    }
    const clusterBbox = this.resolveWarMapClusterBbox(options.bbox);
    const markersForClustering = this.filterWarMapPointsByBbox(filteredMarkers, clusterBbox);
    if (markersForClustering.length === 0) {
      return [];
    }
    const cellSizeDeg = this.resolveWarMapClusterCellSizeDegrees(options.zoom);
    const groups = new Map<
      string,
      {
        clusterId: number;
        markers: WarMapNewsMarker[];
        latTotal: number;
        lngTotal: number;
        latestEpoch: number;
      }
    >();
    let clusterIdSeq = 1;

    for (const marker of markersForClustering) {
      const key = this.buildWarMapClusterCellKey(marker.lat, marker.lng, clusterBbox, cellSizeDeg);
      const group = groups.get(key) ?? {
        clusterId: clusterIdSeq,
        markers: [],
        latTotal: 0,
        lngTotal: 0,
        latestEpoch: 0,
      };
      if (!groups.has(key)) {
        clusterIdSeq += 1;
      }

      group.markers.push(marker);
      group.latTotal += marker.lat;
      group.lngTotal += marker.lng;
      const latestIso = marker.publishedAt ?? marker.ingestedAt;
      const latestEpochRaw = latestIso ? Date.parse(latestIso) : NaN;
      const latestEpoch = Number.isFinite(latestEpochRaw) ? latestEpochRaw : 0;
      group.latestEpoch = Math.max(group.latestEpoch, latestEpoch);
      groups.set(key, group);
    }

    const result: WarMapNewsMarker[] = [];
    for (const group of groups.values()) {
      if (group.markers.length <= 1) {
        const single = group.markers[0];
        if (single) {
          result.push(single);
        }
        continue;
      }

      result.push({
        id: `cluster-${group.clusterId}`,
        title: `Cluster (${group.markers.length})`,
        location: 'Multiple locations',
        lat: clampFinite(group.latTotal / group.markers.length, -90, 90),
        lng: clampFinite(group.lngTotal / group.markers.length, -180, 180),
        geoSource: 'geocoded',
        isCluster: true,
        clusterId: group.clusterId,
        clusterCount: group.markers.length,
        publishedAt: group.latestEpoch > 0 ? new Date(group.latestEpoch).toISOString() : undefined,
      });
    }

    return result;
  }

  protected hashString(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  protected buildWarMapRealtimeLayerSeedPoints(
    events: WarMapEvent[],
    markers: WarMapNewsMarker[],
  ): WarMapRealtimeLayerSeedPoint[] {
    const points: WarMapRealtimeLayerSeedPoint[] = [];

    for (const event of events) {
      if (
        typeof event.lat !== 'number' ||
        typeof event.lng !== 'number' ||
        !Number.isFinite(event.lat) ||
        !Number.isFinite(event.lng)
      ) {
        continue;
      }
      const description = `severity=${event.severity}; alerts=${event.alertCount ?? 0}; news=${event.newsCount ?? 0}; score=${event.derivedScore ?? event.value ?? 0}`;
      const textCorpus = `${event.name} ${event.nameZh ?? ''} ${description}`.toLowerCase();
      points.push({
        id: `evt-${event.id}`,
        lat: event.lat,
        lng: event.lng,
        name: event.name,
        nameZh: event.nameZh,
        description,
        timestamp: event.latestAt,
        textCorpus,
      });
    }

    for (const marker of markers) {
      if (
        typeof marker.lat !== 'number' ||
        typeof marker.lng !== 'number' ||
        !Number.isFinite(marker.lat) ||
        !Number.isFinite(marker.lng)
      ) {
        continue;
      }
      const name = marker.displayName?.trim() || marker.location;
      const nameZh = marker.displayNameZh?.trim() || marker.locationZh;
      const description = marker.title;
      const descriptionZh = marker.titleZh;
      const textCorpus =
        `${name} ${nameZh ?? ''} ${description} ${descriptionZh ?? ''} ${marker.location}`.toLowerCase();
      points.push({
        id: `news-${marker.id}`,
        lat: marker.lat,
        lng: marker.lng,
        name,
        nameZh,
        description,
        descriptionZh,
        timestamp: marker.publishedAt ?? marker.ingestedAt,
        textCorpus,
      });
    }

    return points;
  }

  protected pickWarMapSeedPointsForLayer(
    layerId: WarMapLayerId,
    points: WarMapRealtimeLayerSeedPoint[],
  ): WarMapRealtimeLayerSeedPoint[] {
    if (points.length === 0) {
      return [];
    }

    const keywords = WAR_MAP_LAYER_KEYWORDS[layerId] ?? [];
    let selected =
      keywords.length > 0
        ? points.filter((point) => keywords.some((keyword) => point.textCorpus.includes(keyword)))
        : points.slice();

    if (selected.length === 0) {
      const seed = this.hashString(layerId);
      const modulo = Math.max(2, (seed % 7) + 2);
      selected = points.filter((_, index) => (index + seed) % modulo === 0);
    }

    if (selected.length === 0) {
      selected = points.slice(0, 24);
    }

    selected.sort((a, b) => {
      const aEpochRaw = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bEpochRaw = b.timestamp ? Date.parse(b.timestamp) : 0;
      const aEpoch = Number.isFinite(aEpochRaw) ? aEpochRaw : 0;
      const bEpoch = Number.isFinite(bEpochRaw) ? bEpochRaw : 0;
      return bEpoch - aEpoch;
    });

    return selected;
  }

  protected buildWarMapLayerFeaturesFromSeedPoints(
    layerId: WarMapLayerId,
    geometryType: WarMapLayerDataset['geometryType'],
    points: WarMapRealtimeLayerSeedPoint[],
  ): WarMapLayerFeature[] {
    if (points.length === 0 || geometryType === 'raster') {
      return [];
    }

    if (geometryType === 'path') {
      const features: WarMapLayerFeature[] = [];
      if (points.length === 1) {
        const point = points[0];
        if (!point) {
          return features;
        }
        const lngOffset = 1.2;
        const latOffset = 0.6;
        features.push({
          id: `${layerId}-path-0-${point.id}`,
          path: [
            [
              clampFinite(point.lng - lngOffset, -180, 180),
              clampFinite(point.lat - latOffset, -90, 90),
            ],
            [
              clampFinite(point.lng + lngOffset, -180, 180),
              clampFinite(point.lat + latOffset, -90, 90),
            ],
          ],
          properties: {
            name: point.name,
            nameZh: point.nameZh,
            description: point.description,
            descriptionZh: point.descriptionZh,
          },
          timestamp: point.timestamp,
        });
        return features;
      }

      const maxPaths = Math.min(24, Math.floor(points.length / 2));
      for (let index = 0; index < maxPaths; index += 1) {
        const from = points[index * 2];
        const to = points[index * 2 + 1];
        if (!from || !to) {
          continue;
        }
        features.push({
          id: `${layerId}-path-${index}-${from.id}-${to.id}`,
          path: [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ],
          properties: {
            name: `${from.name} -> ${to.name}`,
            nameZh: from.nameZh && to.nameZh ? `${from.nameZh} -> ${to.nameZh}` : undefined,
            description: from.description ?? to.description,
          },
          timestamp: from.timestamp ?? to.timestamp,
        });
      }
      return features;
    }

    if (geometryType === 'polygon') {
      const maxPolygons = Math.min(18, points.length);
      const features: WarMapLayerFeature[] = [];
      for (let index = 0; index < maxPolygons; index += 1) {
        const point = points[index];
        if (!point) {
          continue;
        }
        const offset = 0.8 + (index % 3) * 0.35;
        const minLng = clampFinite(point.lng - offset, -180, 180);
        const maxLng = clampFinite(point.lng + offset, -180, 180);
        const minLat = clampFinite(point.lat - offset, -90, 90);
        const maxLat = clampFinite(point.lat + offset, -90, 90);

        features.push({
          id: `${layerId}-polygon-${index}-${point.id}`,
          polygon: [
            [
              [minLng, minLat],
              [maxLng, minLat],
              [maxLng, maxLat],
              [minLng, maxLat],
              [minLng, minLat],
            ],
          ],
          properties: {
            name: point.name,
            nameZh: point.nameZh,
            description: point.description,
            descriptionZh: point.descriptionZh,
          },
          timestamp: point.timestamp,
        });
      }
      return features;
    }

    const maxPoints = Math.min(140, points.length);
    return points.slice(0, maxPoints).map((point, index) => ({
      id: `${layerId}-point-${index}-${point.id}`,
      lat: point.lat,
      lng: point.lng,
      properties: {
        name: point.name,
        nameZh: point.nameZh,
        description: point.description,
        descriptionZh: point.descriptionZh,
      },
      timestamp: point.timestamp,
    }));
  }

  protected mergeWarMapLayerFeatures(
    existing: WarMapLayerFeature[],
    incoming: WarMapLayerFeature[],
    maxItems: number,
  ): WarMapLayerFeature[] {
    const merged: WarMapLayerFeature[] = [];
    const seen = new Set<string>();

    const append = (feature: WarMapLayerFeature) => {
      if (seen.has(feature.id)) {
        return;
      }
      seen.add(feature.id);
      merged.push(feature);
    };

    for (const feature of existing) {
      append(feature);
      if (merged.length >= maxItems) {
        return merged;
      }
    }
    for (const feature of incoming) {
      append(feature);
      if (merged.length >= maxItems) {
        break;
      }
    }
    return merged;
  }

  protected collectWarMapLayerFeatureTexts(
    layers: Record<WarMapLayerId, WarMapLayerDataset>,
  ): string[] {
    const texts: string[] = [];
    for (const layerId of WAR_MAP_LAYER_IDS) {
      const layer = layers[layerId];
      if (!layer || !Array.isArray(layer.features)) {
        continue;
      }
      for (const feature of layer.features) {
        const properties =
          feature.properties &&
          typeof feature.properties === 'object' &&
          !Array.isArray(feature.properties)
            ? (feature.properties as Record<string, unknown>)
            : null;
        if (!properties) {
          continue;
        }
        const name = properties.name;
        const description = properties.description;
        if (typeof name === 'string' && name.trim()) {
          texts.push(name.trim());
        }
        if (typeof description === 'string' && description.trim()) {
          texts.push(description.trim());
        }
      }
    }
    return texts;
  }

  protected applyWarMapLayerFeatureTranslations(
    layers: Record<WarMapLayerId, WarMapLayerDataset>,
    translatedByText: Map<string, string>,
  ): void {
    for (const layerId of WAR_MAP_LAYER_IDS) {
      const layer = layers[layerId];
      if (!layer || !Array.isArray(layer.features)) {
        continue;
      }
      for (const feature of layer.features) {
        const properties =
          feature.properties &&
          typeof feature.properties === 'object' &&
          !Array.isArray(feature.properties)
            ? (feature.properties as Record<string, unknown>)
            : null;
        if (!properties) {
          continue;
        }
        if (typeof properties.name === 'string') {
          const nameZh = translatedByText.get(properties.name);
          if (nameZh) {
            properties.nameZh = nameZh;
          }
        }
        if (typeof properties.description === 'string') {
          const descriptionZh = translatedByText.get(properties.description);
          if (descriptionZh) {
            properties.descriptionZh = descriptionZh;
          }
        }
      }
    }
  }

  protected mapAisDisruptionSeverity(severity: 'low' | 'elevated' | 'high'): WarMapEventSeverity {
    if (severity === 'high') {
      return 'high';
    }
    if (severity === 'elevated') {
      return 'medium';
    }
    return 'low';
  }

  protected buildWarMapAisVesselFeature(
    vessel: RealtimeAisVesselSnapshot,
    mode: 'all' | 'military',
    sourceUpdatedAt: string,
  ): WarMapLayerFeature {
    const classification = classifyAisShipType(vessel.shipType, mode === 'military');
    const properties: WarMapAisVesselProperties & {
      name: string;
      description: string;
    } = {
      sourceType: 'ais',
      featureKind: 'vessel',
      mmsi: vessel.mmsi,
      ...(vessel.name ? { name: vessel.name } : {}),
      ...(typeof vessel.shipType === 'number' ? { shipType: vessel.shipType } : {}),
      shipTypeLabel: classification.shipTypeLabel,
      shipTypeLabelZh: classification.shipTypeLabelZh,
      vesselRole: classification.vesselRole,
      vesselRoleZh: classification.vesselRoleZh,
      isMilitaryCandidate: classification.isMilitaryCandidate,
      ...(typeof vessel.heading === 'number' ? { heading: vessel.heading } : {}),
      ...(typeof vessel.speed === 'number' ? { speed: vessel.speed } : {}),
      ...(typeof vessel.course === 'number' ? { course: vessel.course } : {}),
      observedAt: vessel.observedAt,
      sourceUpdatedAt,
      name: vessel.name ?? vessel.mmsi,
      description: mode === 'military' ? 'AIS military/government candidate vessel' : 'AIS vessel',
    };

    return {
      id: `ais-vessel-${vessel.mmsi}`,
      lat: vessel.lat,
      lng: vessel.lng,
      timestamp: vessel.observedAt,
      properties: properties as unknown as Record<string, unknown>,
    };
  }

  protected buildWarMapAisDensityFeature(
    zone: RealtimeAisLatestSnapshot['density'][number],
  ): WarMapLayerFeature {
    const properties: WarMapAisDensityProperties & {
      name: string;
      description: string;
    } = {
      sourceType: 'ais',
      featureKind: 'density',
      intensity: zone.intensity,
      ...(typeof zone.deltaPct === 'number' ? { deltaPct: zone.deltaPct } : {}),
      ...(typeof zone.shipsPerDay === 'number' ? { shipsPerDay: zone.shipsPerDay } : {}),
      ...(zone.note ? { note: zone.note } : {}),
      name: zone.name ?? zone.id,
      description: zone.note ?? 'AIS traffic density zone',
    };

    return {
      id: zone.id,
      lat: zone.lat,
      lng: zone.lng,
      properties: properties as unknown as Record<string, unknown>,
    };
  }

  protected buildWarMapAisDisruptionFeature(
    disruption: RealtimeAisLatestSnapshot['disruptions'][number],
    observedAt: string,
  ): WarMapLayerFeature {
    const properties: WarMapAisDisruptionProperties = {
      sourceType: 'ais',
      featureKind: 'disruption',
      name: disruption.name,
      disruptionType: disruption.type,
      severity: this.mapAisDisruptionSeverity(disruption.severity),
      ...(typeof disruption.vesselCount === 'number'
        ? { vesselCount: disruption.vesselCount }
        : {}),
      ...(typeof disruption.changePct === 'number' ? { changePct: disruption.changePct } : {}),
      ...(typeof disruption.windowHours === 'number'
        ? { windowHours: disruption.windowHours }
        : {}),
      ...(disruption.region ? { region: disruption.region } : {}),
      ...(disruption.description ? { description: disruption.description } : {}),
      ...(typeof disruption.darkShips === 'number' ? { darkShips: disruption.darkShips } : {}),
    };

    return {
      id: disruption.id,
      lat: disruption.lat,
      lng: disruption.lng,
      timestamp: observedAt,
      properties: properties as unknown as Record<string, unknown>,
    };
  }

  protected shapeWarMapAisVesselsForViewport(
    vessels: RealtimeAisVesselSnapshot[],
    options: Pick<WarMapLayersOptions, 'bbox' | 'zoom'>,
  ): RealtimeAisVesselSnapshot[] {
    const filtered = this.filterWarMapPointsByBbox(vessels, options.bbox);
    const maxPoints = this.resolveWarMapAisMaxPoints(options);
    if (filtered.length <= maxPoints) {
      return filtered;
    }

    const bbox = this.resolveWarMapClusterBbox(options.bbox);
    const cellSizeDeg = this.resolveWarMapAisCellSizeDegrees(options.zoom);
    const perCellLimit = this.resolveWarMapAisPerCellLimit(options.zoom);
    const cellCounts = new Map<string, number>();
    const selected: RealtimeAisVesselSnapshot[] = [];
    const sorted = [...filtered].sort((left, right) =>
      right.observedAt.localeCompare(left.observedAt),
    );

    for (const vessel of sorted) {
      const cellKey = this.buildWarMapClusterCellKey(vessel.lat, vessel.lng, bbox, cellSizeDeg);
      const currentCellCount = cellCounts.get(cellKey) ?? 0;
      if (currentCellCount >= perCellLimit) {
        continue;
      }
      cellCounts.set(cellKey, currentCellCount + 1);
      selected.push(vessel);
      if (selected.length >= maxPoints) {
        break;
      }
    }

    return selected;
  }

  protected async enrichWarMapAisLayer(
    response: WarMapStaticLayersResponse,
    orgId: string,
    options: Pick<WarMapLayersOptions, 'bbox' | 'zoom' | 'aisMode'>,
  ): Promise<void> {
    const dataset = response.layers.ais;
    if (!dataset || !this.realtimeSignalsStore) {
      return;
    }

    dataset.renderHints = {
      ...dataset.renderHints,
      pickable: true,
      clusterable: false,
      color: WAR_MAP_LAYER_COLORS.ais,
      radiusScale: 1.1,
    };

    const aisMode = options.aisMode ?? 'military';
    const [snapshot, sourceState] = await Promise.all([
      this.realtimeSignalsStore.getLatestAisSnapshot(orgId),
      this.realtimeSignalsStore.getSourceState(orgId, 'ais'),
    ]);
    const aisRuntime = buildAisRuntimeSemantics({ snapshot, sourceState });
    const staleThresholdSec = 20 * 60;

    if (!snapshot) {
      dataset.features = [];
      dataset.updatedAt = sourceState?.lastSuccessAt;
      dataset.summary = {
        source: 'relay',
        mode: aisMode,
        configured: aisRuntime.diagnostics.configured,
        connected: false,
        freshness: 'missing',
        staleThresholdSec,
        relayVesselCount: 0,
        disruptionsCount: 0,
        densityCount: 0,
        candidateCount: 0,
        renderedVesselCount: 0,
        allVesselsAvailable: false,
        ...(aisMode === 'all'
          ? {
              maxReturned: this.resolveWarMapAisMaxPoints(options),
              truncated: false,
            }
          : {}),
        ...(aisMode === 'all'
          ? {
              blockedReasonCode: AIS_ALL_MODE_BLOCKED_REASON_CODES.snapshotUnavailable,
              blockedReason: 'AIS relay snapshot is not available yet.',
            }
          : {}),
        ...(aisRuntime.statusReasonCode ? { statusReasonCode: aisRuntime.statusReasonCode } : {}),
        ...(aisRuntime.statusReason ? { statusReason: aisRuntime.statusReason } : {}),
      } satisfies WarMapAisLayerSummary;
      return;
    }

    const nowMs = Date.now();
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    const snapshotAgeSec = Number.isFinite(updatedAtMs)
      ? Math.max(0, Math.round((nowMs - updatedAtMs) / 1_000))
      : undefined;
    const freshness =
      typeof snapshotAgeSec === 'number' && snapshotAgeSec > staleThresholdSec ? 'stale' : 'fresh';
    const disruptionFeatures = this.filterWarMapPointsByBbox(
      snapshot.disruptions,
      options.bbox,
    ).map((disruption) => this.buildWarMapAisDisruptionFeature(disruption, snapshot.updatedAt));
    const densityFeatures =
      aisMode === 'military'
        ? []
        : this.filterWarMapPointsByBbox(snapshot.density, options.bbox).map((zone) =>
            this.buildWarMapAisDensityFeature(zone),
          );

    const vesselPool =
      aisMode === 'all'
        ? snapshot.hasVesselSnapshot
          ? snapshot.vessels
          : []
        : aisMode === 'military'
          ? snapshot.candidateReports
          : [];
    const filteredVessels = this.filterWarMapPointsByBbox(vesselPool, options.bbox);
    const viewportVesselCount =
      aisMode === 'all' && snapshot.hasVesselSnapshot ? filteredVessels.length : undefined;
    const shapedVessels =
      aisMode === 'all'
        ? this.shapeWarMapAisVesselsForViewport(vesselPool, options)
        : filteredVessels;
    const vesselFeatures = shapedVessels.map((vessel) =>
      this.buildWarMapAisVesselFeature(
        vessel,
        aisMode === 'all' ? 'all' : 'military',
        snapshot.updatedAt,
      ),
    );

    dataset.features = [...densityFeatures, ...disruptionFeatures, ...vesselFeatures];
    dataset.updatedAt = snapshot.updatedAt;
    dataset.summary = {
      source: 'relay',
      sourceEndpoint: snapshot.sourceEndpoint,
      mode: aisMode,
      configured: aisRuntime.diagnostics.configured,
      connected: aisRuntime.diagnostics.connected,
      freshness,
      snapshotUpdatedAt: snapshot.updatedAt,
      ...(typeof snapshotAgeSec === 'number' ? { snapshotAgeSec } : {}),
      staleThresholdSec,
      relayVesselCount: aisRuntime.diagnostics.vesselCount,
      disruptionsCount: disruptionFeatures.length,
      densityCount: densityFeatures.length,
      candidateCount: aisRuntime.diagnostics.candidateCount,
      renderedVesselCount: vesselFeatures.length,
      allVesselsAvailable: aisRuntime.diagnostics.allVesselsAvailable,
      messageCount: aisRuntime.diagnostics.messageCount,
      clientCount: snapshot.status.clients,
      droppedMessages: aisRuntime.diagnostics.droppedMessages,
      positionReportsSeen: aisRuntime.diagnostics.positionReportsSeen,
      positionReportsProcessed: aisRuntime.diagnostics.positionReportsProcessed,
      ignoredPositionReports: aisRuntime.diagnostics.ignoredPositionReports,
      parseErrors: aisRuntime.diagnostics.parseErrors,
      ...(aisRuntime.statusReasonCode ? { statusReasonCode: aisRuntime.statusReasonCode } : {}),
      ...(aisRuntime.statusReason ? { statusReason: aisRuntime.statusReason } : {}),
      ...(aisMode === 'all'
        ? {
            ...(typeof viewportVesselCount === 'number' ? { viewportVesselCount } : {}),
            maxReturned: this.resolveWarMapAisMaxPoints(options),
            truncated: vesselFeatures.length < filteredVessels.length,
          }
        : {}),
      ...(aisMode === 'all' && !snapshot.hasVesselSnapshot
        ? {
            blockedReasonCode: AIS_ALL_MODE_BLOCKED_REASON_CODES.missingVesselsSnapshot,
            blockedReason: 'AIS relay snapshot does not include vessels[] yet.',
          }
        : {}),
    } satisfies WarMapAisLayerSummary;
  }

  protected async enrichWarMapFlightsLayer(
    response: WarMapStaticLayersResponse,
    orgId: string,
    options: Pick<WarMapLayersOptions, 'bbox' | 'zoom' | 'flightMode'>,
  ): Promise<void> {
    const dataset = response.layers.flights;
    if (!dataset) {
      return;
    }

    dataset.renderHints = {
      ...dataset.renderHints,
      pickable: true,
      clusterable: true,
      color: WAR_MAP_LAYER_COLORS.flights,
      radiusScale: 1.15,
    };
    const flightMode = options.flightMode ?? 'military';
    const summaryBase = {
      source: 'opensky',
      scope: flightMode,
    } as const;

    if (flightMode === 'all') {
      if (!this.realtimeSignals) {
        return;
      }
      const result = await this.realtimeSignals.fetchOpenskyViewportSnapshot({
        bbox: options.bbox,
      });
      if (!result.configured) {
        dataset.features = [];
        dataset.updatedAt = undefined;
        dataset.summary = {
          ...summaryBase,
          freshness: 'not_configured',
          rawAircraftCount: 0,
          snapshotValidPositionCount: 0,
          returnedCount: 0,
          truncated: false,
          retainedPreviousSnapshot: false,
        };
        return;
      }
      if (result.budgetLimited) {
        dataset.features = [];
        dataset.updatedAt = undefined;
        dataset.summary = {
          ...summaryBase,
          sourceEndpoint: result.sourceEndpoint,
          freshness: 'budget_limited',
          rawAircraftCount: 0,
          snapshotValidPositionCount: 0,
          returnedCount: 0,
          truncated: false,
          retainedPreviousSnapshot: false,
          ...(result.statusReasonCode ? { statusReasonCode: result.statusReasonCode } : {}),
          ...(result.statusReason ? { statusReason: result.statusReason } : {}),
          ...(result.budgetSummary
            ? {
                remainingCredits: result.budgetSummary.remainingCredits,
                dailyBudget: result.budgetSummary.dailyBudget,
                dateHkt: result.budgetSummary.dateHkt,
                degradationLevel: result.budgetSummary.degradationLevel,
              }
            : {}),
        };
        return;
      }
      if (result.requiresZoom) {
        dataset.features = [];
        dataset.updatedAt = undefined;
        dataset.summary = {
          ...summaryBase,
          sourceEndpoint: result.sourceEndpoint,
          freshness: 'zoom_required',
          rawAircraftCount: 0,
          snapshotValidPositionCount: 0,
          returnedCount: 0,
          truncated: false,
          retainedPreviousSnapshot: false,
          requiresZoom: true,
        };
        return;
      }
      const snapshot = result.snapshot;
      if (!snapshot) {
        dataset.features = [];
        dataset.updatedAt = undefined;
        dataset.summary = {
          ...summaryBase,
          sourceEndpoint: result.sourceEndpoint,
          freshness: 'missing',
          rawAircraftCount: 0,
          snapshotValidPositionCount: 0,
          returnedCount: 0,
          truncated: false,
          retainedPreviousSnapshot: false,
        };
        return;
      }

      const rawAircraft = snapshot.aircraft.map((entry) => ({
        ...entry,
        lat: clampFinite(entry.lat, -90, 90),
        lng: clampFinite(entry.lng, -180, 180),
      }));
      const aircraft = this.shapeWarMapFlightsForViewport(rawAircraft, options);
      dataset.features = aircraft.map((entry) =>
        this.buildWarMapFlightFeature(entry, snapshot.updatedAt, flightMode),
      );
      dataset.updatedAt = snapshot.updatedAt;
      dataset.summary = {
        ...summaryBase,
        sourceEndpoint: result.sourceEndpoint,
        freshness: 'fresh',
        rawAircraftCount: snapshot.totalAircraft,
        snapshotValidPositionCount: snapshot.validPositionCount,
        returnedCount: aircraft.length,
        maxReturned: this.resolveWarMapFlightsMaxPoints(options),
        truncated:
          aircraft.length < this.filterWarMapPointsByBbox(rawAircraft, options.bbox).length,
        retainedPreviousSnapshot: false,
      };
      return;
    }

    if (!this.realtimeSignalsStore) {
      return;
    }

    const snapshot = await this.realtimeSignalsStore.getLatestAdsbSnapshot(orgId);

    if (!snapshot) {
      dataset.features = [];
      dataset.updatedAt = undefined;
      dataset.summary = {
        ...summaryBase,
        freshness: 'missing',
        rawAircraftCount: 0,
        snapshotValidPositionCount: 0,
        returnedCount: 0,
        truncated: false,
        retainedPreviousSnapshot: false,
      };
      return;
    }

    if (!this.isAdsbSnapshotFresh(snapshot, Date.now())) {
      dataset.features = [];
      dataset.updatedAt = snapshot.updatedAt;
      dataset.summary = {
        ...summaryBase,
        sourceEndpoint: snapshot.sourceEndpoint,
        freshness: 'stale',
        rawAircraftCount: snapshot.totalAircraft,
        snapshotValidPositionCount: snapshot.validPositionCount,
        returnedCount: 0,
        truncated: false,
        retainedPreviousSnapshot: snapshot.diagnostics.retainedPreviousSnapshot,
      };
      return;
    }

    const rawAircraft = snapshot.aircraft.map((entry) => ({
      ...entry,
      lat: clampFinite(entry.lat, -90, 90),
      lng: clampFinite(entry.lng, -180, 180),
    }));
    const aircraft = this.shapeWarMapFlightsForViewport(rawAircraft, options);

    dataset.features = aircraft.map((entry) =>
      this.buildWarMapFlightFeature(entry, snapshot.updatedAt, flightMode),
    );
    dataset.updatedAt = snapshot.updatedAt;
    dataset.summary = {
      ...summaryBase,
      sourceEndpoint: snapshot.sourceEndpoint,
      freshness: 'fresh',
      rawAircraftCount: snapshot.totalAircraft,
      snapshotValidPositionCount: snapshot.validPositionCount,
      returnedCount: aircraft.length,
      maxReturned: this.resolveWarMapFlightsMaxPoints(options),
      truncated: aircraft.length < this.filterWarMapPointsByBbox(rawAircraft, options.bbox).length,
      retainedPreviousSnapshot: snapshot.diagnostics.retainedPreviousSnapshot,
    };
  }

  protected buildWarMapFlightFeature(
    aircraft: RealtimeAdsbAircraftSnapshot,
    sourceUpdatedAt: string,
    flightMode: 'military' | 'all',
  ): WarMapLayerFeature {
    const classification = classifyAircraftTransport({
      callsign: aircraft.callsign,
      icao24: aircraft.icao24,
      sourceScope: flightMode,
    });
    const properties: WarMapFlightProperties & {
      name: string;
      description: string;
    } = {
      sourceType: 'opensky',
      source: aircraft.source,
      sourceUpdatedAt,
      ...(aircraft.callsign ? { callsign: aircraft.callsign } : {}),
      icao24: aircraft.icao24,
      ...(aircraft.registration ? { registration: aircraft.registration } : {}),
      ...(aircraft.aircraftType ? { aircraftType: aircraft.aircraftType } : {}),
      ...(aircraft.countryCode ? { countryCode: aircraft.countryCode } : {}),
      ...(aircraft.countryName ? { countryName: aircraft.countryName } : {}),
      ...(typeof aircraft.heading === 'number' ? { heading: aircraft.heading } : {}),
      ...(typeof aircraft.altitudeFt === 'number' ? { altitudeFt: aircraft.altitudeFt } : {}),
      ...(typeof aircraft.groundSpeedKt === 'number'
        ? { groundSpeedKt: aircraft.groundSpeedKt }
        : {}),
      displayCategory: classification.displayCategory,
      displayCategoryZh: classification.displayCategoryZh,
      role: classification.role,
      roleZh: classification.roleZh,
      observedAt: aircraft.observedAt,
      name: aircraft.callsign ?? aircraft.registration ?? aircraft.icao24.toUpperCase(),
      description: aircraft.aircraftType
        ? `OpenSky ${aircraft.aircraftType}`
        : flightMode === 'military'
          ? 'OpenSky military/possibly military flight'
          : 'OpenSky flight',
    };

    return {
      id: aircraft.id,
      lat: aircraft.lat,
      lng: aircraft.lng,
      timestamp: aircraft.observedAt,
      properties: properties as unknown as Record<string, unknown>,
    };
  }
}
