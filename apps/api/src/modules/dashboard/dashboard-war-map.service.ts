import { MapTransportObjectStateModel, MapTransportTrackPointModel } from '@modular/mongo';
import {
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  type WarMapEvent,
  type WarMapEventsResponse,
  type WarMapNewsGeoSource,
  type WarMapNewsMarker,
  type WarMapNewsMarkersResponse,
  type WarMapTransportDetailResponse,
  type WarMapTransportTrackPoint,
  WAR_MAP_LAYER_IDS,
  normalizeCountryCode,
} from '@modular/utils';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AlertSeverity } from '@prisma/client';

import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';
import { GeocodingService } from '../geo/geocoding.service';
import { RealtimeSignalsService } from '../realtime-signals/realtime-signals.service';
import { RealtimeSignalsSnapshotStore } from '../realtime-signals/realtime-signals.snapshot-store';
import { SituationMonitorTranslationService } from '../situation-monitor/situation-monitor-translation.service';

import worldGeoJson from './assets/world.geo.json';
import {
  MAX_WAR_MAP_NEWS_GEOCODE_NETWORK,
  MAX_WAR_MAP_NEWS_MARKERS,
  WAR_MAP_ALERT_EVENT_SCAN_LIMIT,
  WAR_MAP_LAYER_COLORS,
  alertSeverityByRank,
  alertSeverityRank,
  type CachedWarMapEventArticleRow,
  type CachedWarMapNewsMarkerArticleRow,
  type DateRange,
  type SharedWarMapEventArticleRow,
  type SharedWarMapNewsMarkerArticleRow,
  type WarMapEventsOptions,
  type WarMapGeoJsonResponse,
  type WarMapLayersOptions,
  normalizeGeoId,
  type WarMapMongoLocationRecord,
  type WarMapNewsMarkersOptions,
  type WarMapSourceNewsRecord,
  type WarMapTransportDetailOptions,
  buildProcessedArticleRangeWhere,
  deserializeDate,
  getGeoIndex,
  loadSharedDashboardQuery,
  logger,
  readCountryCodesFromAlertContext,
  serializeDate,
  uniqStrings,
} from './dashboard-charts.helpers';
import { DashboardWarMapSupport } from './dashboard-war-map.helpers';
import {
  buildWarMapLayersResponse,
  type WarMapLayersResponse as WarMapStaticLayersResponse,
} from './war-map-layers';

@Injectable()
export class DashboardWarMapService extends DashboardWarMapSupport {
  constructor(
    prisma: PrismaService,
    geocoding: GeocodingService,
    cache: CacheService,
    translation?: SituationMonitorTranslationService,
    realtimeSignals?: RealtimeSignalsService,
    realtimeSignalsStore?: RealtimeSignalsSnapshotStore,
  ) {
    super(prisma, geocoding, cache, translation, realtimeSignals, realtimeSignalsStore);
  }

  private async enrichWarMapLayersWithRealtimeData(
    response: WarMapStaticLayersResponse,
    orgId: string,
    range: DateRange,
    realtimeData?: WarMapLayersOptions['realtimeData'],
  ): Promise<void> {
    const [eventsResponse, newsMarkersResponse] = realtimeData
      ? await Promise.all([realtimeData.events, realtimeData.newsMarkers])
      : await Promise.all([
          this.getWarMapEvents(range, orgId, { cluster: false }),
          this.getWarMapNewsMarkers(range, orgId, { cluster: false }),
        ]);

    const points = this.buildWarMapRealtimeLayerSeedPoints(
      eventsResponse.events,
      newsMarkersResponse.markers,
    );
    if (points.length === 0) {
      return;
    }

    for (const layerId of WAR_MAP_LAYER_IDS) {
      if (
        layerId === 'monitors' ||
        layerId === 'dayNight' ||
        layerId === 'flights' ||
        layerId === 'ais'
      ) {
        continue;
      }
      const dataset = response.layers[layerId];
      if (!dataset) {
        continue;
      }

      const selectedPoints = this.pickWarMapSeedPointsForLayer(layerId, points);
      const generatedFeatures = this.buildWarMapLayerFeaturesFromSeedPoints(
        layerId,
        dataset.geometryType,
        selectedPoints,
      );
      if (generatedFeatures.length === 0) {
        continue;
      }

      dataset.features = this.mergeWarMapLayerFeatures(dataset.features, generatedFeatures, 240);
      dataset.renderHints = {
        ...dataset.renderHints,
        pickable: true,
        color: dataset.renderHints?.color ?? WAR_MAP_LAYER_COLORS[layerId],
        clusterable:
          dataset.renderHints?.clusterable ??
          (dataset.geometryType === 'point' || dataset.geometryType === 'path'),
        radiusScale:
          dataset.renderHints?.radiusScale ?? (dataset.geometryType === 'point' ? 1 : undefined),
      };
    }
  }

  private serializeWarMapEventRows(
    rows: SharedWarMapEventArticleRow[],
  ): CachedWarMapEventArticleRow[] {
    return rows.map((row) => ({
      location: row.location,
      processedAt: serializeDate(row.processedAt),
      eventAt: serializeDate(row.eventAt),
    }));
  }

  private deserializeWarMapEventRows(
    rows: CachedWarMapEventArticleRow[],
  ): SharedWarMapEventArticleRow[] {
    return rows.map((row) => ({
      location: row.location,
      processedAt: deserializeDate(row.processedAt),
      eventAt: deserializeDate(row.eventAt),
    }));
  }

  private serializeWarMapNewsMarkerRows(
    rows: SharedWarMapNewsMarkerArticleRow[],
  ): CachedWarMapNewsMarkerArticleRow[] {
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      location: row.location,
      publishedAt: serializeDate(row.publishedAt),
      eventAt: serializeDate(row.eventAt),
      processedAt: serializeDate(row.processedAt),
      entities: row.entities,
      article: {
        url: row.article.url,
        crawlAt: serializeDate(row.article.crawlAt),
        titleGuess: row.article.titleGuess,
      },
    }));
  }

  private deserializeWarMapNewsMarkerRows(
    rows: CachedWarMapNewsMarkerArticleRow[],
  ): SharedWarMapNewsMarkerArticleRow[] {
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      location: row.location,
      publishedAt: deserializeDate(row.publishedAt),
      eventAt: deserializeDate(row.eventAt),
      processedAt: deserializeDate(row.processedAt),
      entities: row.entities,
      article: {
        url: row.article.url,
        crawlAt: deserializeDate(row.article.crawlAt),
        titleGuess: row.article.titleGuess,
      },
    }));
  }

  getWarMapGeoJson(): WarMapGeoJsonResponse {
    const payload = worldGeoJson as { type?: string; features?: unknown };
    if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new Error('Invalid GeoJSON payload');
    }
    return {
      name: 'world',
      geoJson: worldGeoJson,
      center: [0, 20],
      zoom: 1.1,
    };
  }

  async getWarMapTransportDetail(
    options: WarMapTransportDetailOptions,
  ): Promise<WarMapTransportDetailResponse> {
    const objectKey = options.objectKey.trim();
    if (!objectKey) {
      throw new BadRequestException('Transport objectKey is required');
    }

    const state = await MapTransportObjectStateModel.findOne({
      orgId: options.orgId,
      entityKind: options.kind,
      objectKey,
    }).lean();
    if (!state) {
      return { detail: null };
    }

    const rangeTrackPoints = await MapTransportTrackPointModel.find({
      orgId: options.orgId,
      entityKind: options.kind,
      objectKey,
      observedAt: {
        $gte: options.range.start,
        $lte: options.range.end,
      },
    })
      .sort({ observedAt: -1 })
      .limit(options.limit)
      .lean();

    const trackPointDocs =
      rangeTrackPoints.length > 0
        ? rangeTrackPoints
        : await MapTransportTrackPointModel.find({
            orgId: options.orgId,
            entityKind: options.kind,
            objectKey,
          })
            .sort({ observedAt: -1 })
            .limit(options.limit)
            .lean();

    const trackPoints = trackPointDocs.map((point) => this.toWarMapTransportTrackPoint(point));
    const title =
      options.kind === 'aircraft'
        ? (this.normalizeString(state.callsign) ??
          this.normalizeString(state.registration) ??
          this.normalizeString(state.icao24)?.toUpperCase() ??
          objectKey)
        : (this.normalizeString(state.name) ??
          (this.normalizeString(state.mmsi) ? `MMSI ${state.mmsi}` : objectKey));
    const subtitleParts =
      options.kind === 'aircraft'
        ? [
            this.normalizeString(state.displayCategoryZh) ??
              this.normalizeString(state.displayCategory),
            this.normalizeString(state.roleZh) ?? this.normalizeString(state.role),
          ]
        : [
            this.normalizeString(state.shipTypeLabelZh) ??
              this.normalizeString(state.shipTypeLabel),
            this.normalizeString(state.roleZh) ?? this.normalizeString(state.role),
          ];

    return {
      detail: {
        kind: options.kind,
        objectKey,
        title,
        subtitle: subtitleParts.filter(Boolean).join(' · ') || undefined,
        latestState: {
          ...state,
          observedAt: this.toIsoString(state.observedAt),
          sourceUpdatedAt: this.toIsoString(state.sourceUpdatedAt),
        },
        trackPoints,
        summary: this.buildWarMapTransportSummary(trackPointDocs),
      },
    };
  }

  async getWarMapLayers(options: WarMapLayersOptions = {}): Promise<WarMapStaticLayersResponse> {
    const response = buildWarMapLayersResponse();

    if (options.orgId && options.range) {
      await this.enrichWarMapFlightsLayer(response, options.orgId, {
        bbox: options.bbox,
        zoom: options.zoom,
        flightMode: options.flightMode,
      });
      await this.enrichWarMapAisLayer(response, options.orgId, {
        bbox: options.bbox,
        zoom: options.zoom,
        aisMode: options.aisMode,
      });
      await this.enrichWarMapLayersWithRealtimeData(
        response,
        options.orgId,
        options.range,
        options.realtimeData,
      );
    }

    if (options.translateTarget === 'zh-CN' && this.translation) {
      const targets = uniqStrings([
        ...response.hotspots.flatMap((item) => [item.name, item.description]),
        ...response.conflictZones.map((item) => item.name),
        ...response.chokepoints.flatMap((item) => [item.name, item.description]),
        ...response.cableLandings.flatMap((item) => [item.name, item.description]),
        ...response.nuclearSites.flatMap((item) => [item.name, item.description]),
        ...response.militaryBases.flatMap((item) => [item.name, item.description]),
        ...this.collectWarMapLayerFeatureTexts(response.layers),
      ]);
      const translatedByText = await this.translation.translateTextsToZhBestEffort(targets);

      const applyHotspot = (item: {
        name: string;
        nameZh?: string;
        description: string;
        descriptionZh?: string;
      }) => {
        const nameZh = translatedByText.get(item.name);
        if (nameZh) {
          item.nameZh = nameZh;
        }
        const descriptionZh = translatedByText.get(item.description);
        if (descriptionZh) {
          item.descriptionZh = descriptionZh;
        }
      };

      const applyZone = (item: { name: string; nameZh?: string }) => {
        const nameZh = translatedByText.get(item.name);
        if (nameZh) {
          item.nameZh = nameZh;
        }
      };

      const applyStrategic = (item: {
        name: string;
        nameZh?: string;
        description: string;
        descriptionZh?: string;
      }) => {
        const nameZh = translatedByText.get(item.name);
        if (nameZh) {
          item.nameZh = nameZh;
        }
        const descriptionZh = translatedByText.get(item.description);
        if (descriptionZh) {
          item.descriptionZh = descriptionZh;
        }
      };

      for (const item of response.hotspots) {
        applyHotspot(item);
      }
      for (const item of response.conflictZones) {
        applyZone(item);
      }
      for (const item of response.chokepoints) {
        applyStrategic(item);
      }
      for (const item of response.cableLandings) {
        applyStrategic(item);
      }
      for (const item of response.nuclearSites) {
        applyStrategic(item);
      }
      for (const item of response.militaryBases) {
        applyStrategic(item);
      }

      this.applyWarMapLayerFeatureTranslations(response.layers, translatedByText);
    }

    return response;
  }

  private toWarMapTransportTrackPoint(point: Record<string, unknown>): WarMapTransportTrackPoint {
    return {
      id:
        this.normalizeString(point._id?.toString?.()) ??
        this.normalizeString(point.id) ??
        `${point.objectKey ?? 'transport'}:${point.observedAt ?? ''}`,
      lat: Number(point.lat),
      lng: Number(point.lng),
      observedAt: this.toIsoString(point.observedAt) ?? new Date().toISOString(),
      ...(this.toIsoString(point.sourceUpdatedAt)
        ? { sourceUpdatedAt: this.toIsoString(point.sourceUpdatedAt) }
        : {}),
      ...(typeof point.heading === 'number' ? { heading: point.heading } : {}),
      ...(typeof point.course === 'number' ? { course: point.course } : {}),
      ...(typeof point.speed === 'number' ? { speed: point.speed } : {}),
      ...(typeof point.altitudeFt === 'number' ? { altitudeFt: point.altitudeFt } : {}),
      ...(this.normalizeString(point.geoCell)
        ? { geoCell: this.normalizeString(point.geoCell) }
        : {}),
    };
  }

  private buildWarMapTransportSummary(trackPoints: Record<string, unknown>[]) {
    const chronological = [...trackPoints].sort(
      (left, right) =>
        (this.toDateMs(left.observedAt) ?? 0) - (this.toDateMs(right.observedAt) ?? 0),
    );
    let totalDistanceKm = 0;
    let maxSpeed = 0;
    let maxAltitudeFt = 0;
    const geoCellCounts = new Map<string, number>();

    for (let index = 0; index < chronological.length; index += 1) {
      const point = chronological[index]!;
      if (typeof point.speed === 'number' && Number.isFinite(point.speed)) {
        maxSpeed = Math.max(maxSpeed, point.speed);
      }
      if (typeof point.altitudeFt === 'number' && Number.isFinite(point.altitudeFt)) {
        maxAltitudeFt = Math.max(maxAltitudeFt, point.altitudeFt);
      }
      const geoCell = this.normalizeString(point.geoCell);
      if (geoCell) {
        geoCellCounts.set(geoCell, (geoCellCounts.get(geoCell) ?? 0) + 1);
      }

      if (index === 0) {
        continue;
      }
      const previous = chronological[index - 1]!;
      const distanceKm = this.computeTrackDistanceKm(previous, point);
      if (typeof distanceKm === 'number') {
        totalDistanceKm += distanceKm;
      }
    }

    return {
      pointCount: chronological.length,
      earliestObservedAt: this.toIsoString(chronological[0]?.observedAt),
      latestObservedAt: this.toIsoString(chronological[chronological.length - 1]?.observedAt),
      ...(totalDistanceKm > 0 ? { totalDistanceKm: Number(totalDistanceKm.toFixed(1)) } : {}),
      ...(maxSpeed > 0 ? { maxSpeed: Math.round(maxSpeed) } : {}),
      ...(maxAltitudeFt > 0 ? { maxAltitudeFt: Math.round(maxAltitudeFt) } : {}),
      geoCells: Array.from(geoCellCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 10)
        .map(([geoCell]) => geoCell),
    };
  }

  private computeTrackDistanceKm(left: Record<string, unknown>, right: Record<string, unknown>) {
    const leftLat = typeof left.lat === 'number' ? left.lat : null;
    const leftLng = typeof left.lng === 'number' ? left.lng : null;
    const rightLat = typeof right.lat === 'number' ? right.lat : null;
    const rightLng = typeof right.lng === 'number' ? right.lng : null;
    if (leftLat === null || leftLng === null || rightLat === null || rightLng === null) {
      return null;
    }

    const toRadians = (value: number) => (value * Math.PI) / 180;
    const earthRadiusKm = 6_371;
    const dLat = toRadians(rightLat - leftLat);
    const dLng = toRadians(rightLng - leftLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(leftLat)) *
        Math.cos(toRadians(rightLat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  }

  private normalizeString(value: unknown) {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private toIsoString(value: unknown) {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isFinite(timestamp) ? value.toISOString() : undefined;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
    }
    return undefined;
  }

  private toDateMs(value: unknown) {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  async getWarMapEvents(
    range: DateRange,
    orgId: string,
    options: WarMapEventsOptions = {},
  ): Promise<WarMapEventsResponse> {
    const geoIndex = getGeoIndex();
    const signals = new Map<
      string,
      {
        name: string;
        lat: number;
        lng: number;
        alertCount: number;
        alertScore: number;
        maxAlertSeverityRank: number;
        newsCount: number;
        latestAt?: Date;
      }
    >();

    const [alertEvents, newsRecords] = await Promise.all([
      this.prisma.alertEvent.findMany({
        where: {
          triggeredAt: {
            gte: range.start,
            lte: range.end,
          },
          rule: {
            orgId,
          },
        },
        select: {
          triggeredAt: true,
          severity: true,
          context: true,
        },
        orderBy: { triggeredAt: 'desc' },
        // The 30-day window can hold a large alert backlog; the map only
        // renders the recent tail, so cap the scan instead of loading all
        // rows into memory on every SSE tick.
        take: WAR_MAP_ALERT_EVENT_SCAN_LIMIT,
      }),
      loadSharedDashboardQuery<SharedWarMapEventArticleRow[], CachedWarMapEventArticleRow[]>(
        this.cache,
        'war-map-events',
        { orgId, range },
        async () =>
          this.prisma.processedArticle.findMany({
            where: buildProcessedArticleRangeWhere(orgId, range, {
              requireLocation: true,
            }),
            select: {
              location: true,
              processedAt: true,
              eventAt: true,
            },
            orderBy: [{ eventAt: 'desc' }, { articleId: 'desc' }],
            take: 2500,
          }),
        {
          serialize: (rows) => this.serializeWarMapEventRows(rows),
          deserialize: (rows) => this.deserializeWarMapEventRows(rows),
        },
      ),
    ]);

    let mongoFallbackRecords: WarMapMongoLocationRecord[] = [];
    if (newsRecords.length === 0) {
      try {
        mongoFallbackRecords = await this.loadMongoWarMapLocationRecords(range, orgId, 2_500);
      } catch (error) {
        logger.warn(
          { orgId, range, err: error },
          'War map event aggregation mongo fallback failed',
        );
      }
    }

    for (const event of alertEvents) {
      const context =
        event.context && typeof event.context === 'object' && !Array.isArray(event.context)
          ? (event.context as Record<string, unknown>)
          : null;
      const resolvedCodes = readCountryCodesFromAlertContext(context);
      if (resolvedCodes.length === 0) {
        continue;
      }
      for (const resolvedCode of resolvedCodes) {
        const geo = geoIndex.get(resolvedCode);
        if (!geo) {
          continue;
        }
        const entry = signals.get(resolvedCode) ?? {
          name: geo.name,
          lat: geo.lat,
          lng: geo.lng,
          alertCount: 0,
          alertScore: 0,
          maxAlertSeverityRank: 0,
          newsCount: 0,
        };
        const severityValue = alertSeverityRank[event.severity] ?? 1;
        entry.alertScore += severityValue;
        entry.alertCount += 1;
        entry.maxAlertSeverityRank = Math.max(entry.maxAlertSeverityRank, severityValue);
        entry.latestAt =
          !entry.latestAt || event.triggeredAt > entry.latestAt
            ? event.triggeredAt
            : entry.latestAt;
        signals.set(resolvedCode, entry);
      }
    }

    for (const record of newsRecords) {
      const location = record.location;
      if (!location || typeof location !== 'string') {
        continue;
      }
      const resolvedCode = normalizeGeoId(extractCountryCodeFromText(location) ?? location);
      if (!resolvedCode) {
        continue;
      }
      const geo = geoIndex.get(resolvedCode);
      if (!geo) {
        continue;
      }

      const entry = signals.get(resolvedCode) ?? {
        name: geo.name,
        lat: geo.lat,
        lng: geo.lng,
        alertCount: 0,
        alertScore: 0,
        maxAlertSeverityRank: 0,
        newsCount: 0,
        latestAt: undefined,
      };
      entry.newsCount += 1;
      const latestAt = record.eventAt ?? record.processedAt;
      if (!latestAt) {
        continue;
      }
      entry.latestAt = !entry.latestAt || latestAt > entry.latestAt ? latestAt : entry.latestAt;
      signals.set(resolvedCode, entry);
    }

    for (const record of mongoFallbackRecords) {
      const location = record.location.trim();
      if (!location) {
        continue;
      }
      const entities = this.normalizeWarMapEntities(record.entities);
      const resolvedCode = this.resolveWarMapCountryAlpha3(location, entities) ?? null;
      if (!resolvedCode) {
        continue;
      }
      const geo = geoIndex.get(resolvedCode);
      if (!geo) {
        continue;
      }
      const latestAt = record.publishedAt ?? record.sortAt ?? record.ingestedAt ?? record.createdAt;
      if (!latestAt) {
        continue;
      }
      const entry = signals.get(resolvedCode) ?? {
        name: geo.name,
        lat: geo.lat,
        lng: geo.lng,
        alertCount: 0,
        alertScore: 0,
        maxAlertSeverityRank: 0,
        newsCount: 0,
        latestAt: undefined,
      };
      entry.newsCount += 1;
      entry.latestAt = !entry.latestAt || latestAt > entry.latestAt ? latestAt : entry.latestAt;
      signals.set(resolvedCode, entry);
    }

    const events: WarMapEvent[] = [];
    let updatedAt: Date | undefined;

    for (const [code, entry] of signals.entries()) {
      if (!entry.latestAt) {
        continue;
      }
      const alertScore = Number(entry.alertScore.toFixed(2));
      const derivedScoreRaw = alertScore + entry.newsCount;
      const derivedScore = Math.max(1, derivedScoreRaw);
      const newsSeverityRank =
        entry.newsCount >= 8 ? 3 : entry.newsCount >= 4 ? 2 : entry.newsCount > 0 ? 1 : 0;
      const maxSeverityRank = Math.max(entry.maxAlertSeverityRank, newsSeverityRank);
      const severity =
        maxSeverityRank > 0
          ? (alertSeverityByRank[maxSeverityRank] ?? AlertSeverity.low)
          : AlertSeverity.low;
      events.push({
        id: code.toLowerCase(),
        name: entry.name,
        lat: entry.lat,
        lng: entry.lng,
        severity,
        latestAt: entry.latestAt.toISOString(),
        derivedScore,
        value: derivedScore,
        alertScore,
        alertCount: entry.alertCount,
        newsCount: entry.newsCount,
      });
      if (!updatedAt || entry.latestAt > updatedAt) {
        updatedAt = entry.latestAt;
      }
    }

    if (options.translateTarget === 'zh-CN' && this.translation && events.length > 0) {
      const translatedByText = await this.translation.translateTextsToZhBestEffort(
        events.map((event) => event.name),
      );
      for (const event of events) {
        const nameZh = translatedByText.get(event.name);
        if (nameZh) {
          event.nameZh = nameZh;
        }
      }
    }

    const shapedEvents = this.clusterWarMapEvents(events, options);

    return {
      events: shapedEvents,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      clustered: options.cluster === true,
    };
  }

  async getWarMapNewsMarkers(
    range: DateRange,
    orgId: string,
    options: WarMapNewsMarkersOptions = {},
  ): Promise<WarMapNewsMarkersResponse> {
    const geoIndex = getGeoIndex();
    const prismaRecords = await loadSharedDashboardQuery<
      SharedWarMapNewsMarkerArticleRow[],
      CachedWarMapNewsMarkerArticleRow[]
    >(
      this.cache,
      'war-map-news-markers',
      { orgId, range },
      async () =>
        this.prisma.processedArticle.findMany({
          where: buildProcessedArticleRangeWhere(orgId, range, {
            requireLocation: true,
          }),
          select: {
            id: true,
            title: true,
            location: true,
            publishedAt: true,
            eventAt: true,
            processedAt: true,
            entities: true,
            article: {
              select: {
                url: true,
                crawlAt: true,
                titleGuess: true,
              },
            },
          },
          orderBy: [{ eventAt: 'desc' }, { articleId: 'desc' }],
          take: MAX_WAR_MAP_NEWS_MARKERS,
        }),
      {
        serialize: (rows) => this.serializeWarMapNewsMarkerRows(rows),
        deserialize: (rows) => this.deserializeWarMapNewsMarkerRows(rows),
      },
    );

    let records: WarMapSourceNewsRecord[] = prismaRecords.map((record) => ({
      id: record.id,
      title: record.title,
      location: typeof record.location === 'string' ? record.location : '',
      entities: record.entities,
      url: record.article.url ?? null,
      publishedAt: record.publishedAt ?? undefined,
      sortAt:
        record.eventAt ??
        record.publishedAt ??
        record.article.crawlAt ??
        record.processedAt ??
        undefined,
      processedAt: record.processedAt ?? undefined,
      crawlAt: record.article.crawlAt ?? undefined,
      titleGuess: record.article.titleGuess ?? null,
    }));

    if (records.length === 0) {
      try {
        const mongoFallbackRecords = await this.loadMongoWarMapLocationRecords(
          range,
          orgId,
          MAX_WAR_MAP_NEWS_MARKERS,
        );
        records = mongoFallbackRecords.map((record) => ({
          id: record.id,
          title: record.title ?? null,
          location: record.location,
          entities: record.entities,
          url: record.url ?? null,
          publishedAt: record.publishedAt,
          sortAt: record.publishedAt ?? record.sortAt ?? record.ingestedAt ?? record.createdAt,
          processedAt: record.sortAt ?? record.ingestedAt ?? record.createdAt,
          crawlAt: record.ingestedAt,
          titleGuess: null,
        }));
      } catch (error) {
        logger.warn({ orgId, range, err: error }, 'War map marker mongo fallback failed');
      }
    }

    let updatedAt: Date | undefined;
    let networkBudget = MAX_WAR_MAP_NEWS_GEOCODE_NETWORK;
    const markers: WarMapNewsMarker[] = [];

    for (const record of records) {
      const location = record.location.trim();
      if (!location) {
        continue;
      }

      const entities = this.normalizeWarMapEntities(record.entities);
      const countryAlpha3 = this.resolveWarMapCountryAlpha3(location, entities);
      const directCountryAlpha3 = normalizeCountryCode(location);
      const countryAlpha2 = countryAlpha3
        ? (getCountryAlpha2(countryAlpha3) ?? undefined)
        : undefined;
      const countryName = countryAlpha3 ? getCountryName(countryAlpha3) : null;

      const candidates = this.buildWarMapGeocodeCandidates(location, entities, countryName);

      let geocode = await this.geocoding.resolveCandidates(candidates, {
        countryCodeAlpha2: countryAlpha2,
        allowNetwork: false,
      });
      if (!geocode && networkBudget > 0) {
        networkBudget -= 1;
        geocode = await this.geocoding.resolveCandidates(candidates, {
          countryCodeAlpha2: countryAlpha2,
          allowNetwork: true,
        });
      }

      let lat = geocode?.lat;
      let lng = geocode?.lng;
      let displayName = geocode?.displayName;
      let geoSource: WarMapNewsGeoSource = 'geocoded';

      if (!geocode && directCountryAlpha3) {
        const fallback = geoIndex.get(directCountryAlpha3);
        if (fallback) {
          lat = fallback.lat;
          lng = fallback.lng;
          displayName = fallback.name;
          geoSource = 'fallback-country';
        }
      }

      if (
        typeof lat !== 'number' ||
        typeof lng !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        continue;
      }

      const title = (record.title ?? record.titleGuess ?? record.url ?? '').trim() || location;
      const latestAt =
        record.sortAt ?? record.publishedAt ?? record.crawlAt ?? record.processedAt ?? undefined;

      markers.push({
        id: record.id,
        title,
        url: record.url ?? null,
        location,
        lat,
        lng,
        publishedAt: record.publishedAt ? record.publishedAt.toISOString() : undefined,
        ingestedAt: record.crawlAt ? record.crawlAt.toISOString() : undefined,
        displayName,
        geoSource,
      });

      if (latestAt && (!updatedAt || latestAt > updatedAt)) {
        updatedAt = latestAt;
      }
    }

    if (options.translateTarget === 'zh-CN' && this.translation && markers.length > 0) {
      const translatedByText = await this.translation.translateTextsToZhBestEffort(
        uniqStrings(
          markers.flatMap((marker) => [marker.title, marker.location, marker.displayName ?? '']),
        ),
      );
      for (const marker of markers) {
        const titleZh = translatedByText.get(marker.title);
        if (titleZh) {
          marker.titleZh = titleZh;
        }
        const locationZh = translatedByText.get(marker.location);
        if (locationZh) {
          marker.locationZh = locationZh;
        }
        if (marker.displayName) {
          const displayNameZh = translatedByText.get(marker.displayName);
          if (displayNameZh) {
            marker.displayNameZh = displayNameZh;
          }
        }
      }
    }

    const shapedMarkers = this.clusterWarMapNewsMarkers(markers, options);

    return {
      markers: shapedMarkers,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      clustered: options.cluster === true,
    };
  }
}
