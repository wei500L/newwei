import { ProcessedItemModel } from '@modular/mongo';
import { extractCountryCodeFromText, getCountryAlpha2 } from '@modular/utils';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ProcessedArticleStatus } from '@prisma/client';
import { createHash } from 'node:crypto';

import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';
import { GeocodingService } from '../geo/geocoding.service';

import {
  DEFAULT_SPACETIME_PROPAGATION_PREDECESSORS,
  DEFAULT_SPACETIME_PROPAGATION_WINDOW_HOURS,
  MAX_SPACETIME_GEO_GEOCODE_NETWORK,
  MAX_SPACETIME_GEO_LOCATIONS,
  MAX_SPACETIME_GEO_POINTS,
  MAX_SPACETIME_GEO_RECORDS,
  MAX_SPACETIME_PROPAGATION_PREDECESSORS,
  MAX_SPACETIME_PROPAGATION_WINDOW_HOURS,
  SPACETIME_GEO_CLUSTER_STEP_DEG,
  SPACETIME_GEO_HEAT_HALF_LIFE_DAYS,
  SPACETIME_GEO_SNAPSHOT_TTL_SECONDS,
  DAY_MS,
  alignUtcDayStart,
  normalizeGeoId,
  type CachedSpacetimeGeoHeatmapRecord,
  type DateRange,
  type SharedSpacetimeGeoHeatmapRecord,
  type SpacetimeGeoHeatmapArticle,
  type SpacetimeGeoHeatmapArticlesResponse,
  type SpacetimeGeoHeatmapResponse,
  type SpacetimeGeoHeatmapSnapshot,
  type SpacetimePropagationArticle,
  type SpacetimePropagationArticlesResponse,
  type SpacetimePropagationEdgeKind,
  type SpacetimePropagationResponse,
  type SpacetimeSentimentLabel,
  buildProcessedArticleRangeWhere,
  clampFinite,
  deserializeDate,
  extractMongoObjectIdLookupKey,
  isMongoObjectIdLookupKey,
  getGeoIndex,
  loadSharedDashboardQuery,
  normalizeLocationCandidate,
  normalizeLocationGroupKey,
  normalizeMongoId,
  normalizeSentimentLabel,
  resolveProcessedItemLookupKeys,
  roundToStep,
  serializeDate,
  toUtcDayStartIso,
} from './dashboard-charts.helpers';

@Injectable()
export class DashboardSpacetimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService,
    private readonly cache: CacheService,
  ) {}

  private geoHeatmapSnapshotCacheKey(orgId: string, snapshotId: string) {
    return `dashboard:spacetime:geo-heatmap:snapshot:${orgId}:${snapshotId}`;
  }

  private async loadGeoHeatmapSnapshot(orgId: string, snapshotId: string) {
    if (!snapshotId) {
      return null;
    }
    try {
      return await this.cache.get<SpacetimeGeoHeatmapSnapshot>(
        this.geoHeatmapSnapshotCacheKey(orgId, snapshotId),
      );
    } catch {
      return null;
    }
  }

  private async storeGeoHeatmapSnapshot(
    orgId: string,
    snapshotId: string,
    snapshot: SpacetimeGeoHeatmapSnapshot,
  ): Promise<boolean> {
    if (!snapshotId) {
      return false;
    }
    try {
      await this.cache.set(
        this.geoHeatmapSnapshotCacheKey(orgId, snapshotId),
        snapshot,
        SPACETIME_GEO_SNAPSHOT_TTL_SECONDS,
      );
      return true;
    } catch {
      return false;
    }
  }

  private serializeSpacetimeGeoHeatmapRows(
    rows: SharedSpacetimeGeoHeatmapRecord[],
  ): CachedSpacetimeGeoHeatmapRecord[] {
    return rows.map((row) => ({
      location: row.location,
      cleanedMarkdownRef: row.cleanedMarkdownRef,
      eventAt: serializeDate(row.eventAt),
      processedAt: serializeDate(row.processedAt),
    }));
  }

  private deserializeSpacetimeGeoHeatmapRows(
    rows: CachedSpacetimeGeoHeatmapRecord[],
  ): SharedSpacetimeGeoHeatmapRecord[] {
    return rows.map((row) => ({
      location: row.location,
      cleanedMarkdownRef: row.cleanedMarkdownRef,
      eventAt: deserializeDate(row.eventAt),
      processedAt: deserializeDate(row.processedAt),
    }));
  }

  async getSpacetimeGeoHeatmap(
    range: DateRange,
    orgId: string,
    options: { eventId?: string; includeBuckets?: boolean } = {},
  ): Promise<SpacetimeGeoHeatmapResponse> {
    const geoIndex = getGeoIndex();
    const eventId = typeof options.eventId === 'string' ? options.eventId.trim() : '';
    const includeBuckets = options.includeBuckets === true;
    const records = await loadSharedDashboardQuery<
      SharedSpacetimeGeoHeatmapRecord[],
      CachedSpacetimeGeoHeatmapRecord[]
    >(
      this.cache,
      'spacetime-geo-heatmap',
      { orgId, range, eventId, includeBuckets },
      async () =>
        this.prisma.processedArticle.findMany({
          where: buildProcessedArticleRangeWhere(orgId, range, {
            requireLocation: true,
            extra: eventId
              ? {
                  newsEventItems: {
                    some: {
                      orgId,
                      eventId,
                    },
                  },
                }
              : undefined,
          }),
          select: {
            location: true,
            cleanedMarkdownRef: true,
            eventAt: true,
            processedAt: true,
          },
          orderBy: [{ eventAt: 'desc' }, { articleId: 'desc' }],
          take: MAX_SPACETIME_GEO_RECORDS,
        }),
      {
        serialize: (rows) => this.serializeSpacetimeGeoHeatmapRows(rows),
        deserialize: (rows) => this.deserializeSpacetimeGeoHeatmapRows(rows),
      },
    );

    if (records.length === 0) {
      return { points: [] };
    }

    const processedItemIds = Array.from(
      new Set(
        records
          .map((record) =>
            typeof record.cleanedMarkdownRef === 'string' ? record.cleanedMarkdownRef.trim() : '',
          )
          .filter((id) => id.length > 0),
      ),
    );

    const sentimentByProcessedItemId = new Map<string, SpacetimeSentimentLabel>();
    if (processedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: processedItemIds }, orgId, status: 'completed' },
          { _id: 1, result: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== 'object') {
              continue;
            }
            const record = doc as Record<string, unknown>;
            const id = normalizeMongoId(record._id);
            if (!id) {
              continue;
            }
            const result =
              record.result && typeof record.result === 'object' && !Array.isArray(record.result)
                ? (record.result as Record<string, unknown>)
                : null;
            const sentiment = normalizeSentimentLabel(
              result?.sentiment_label ?? result?.sentimentLabel ?? result?.sentiment,
            );
            sentimentByProcessedItemId.set(id, sentiment);
          }
        }
      } catch {
        // Sentiment is best-effort; heatmap still works with unknown sentiment.
      }
    }

    const createSentimentCounts = (): Record<SpacetimeSentimentLabel, number> => ({
      positive: 0,
      neutral: 0,
      negative: 0,
      unknown: 0,
    });

    const halfLifeMs = Math.max(1, SPACETIME_GEO_HEAT_HALF_LIFE_DAYS) * DAY_MS;
    const nowMs = range.end.getTime();

    interface BucketAgg {
      total: number;
      sentiment: Record<SpacetimeSentimentLabel, number>;
    }

    interface LocationAgg {
      key: string;
      candidates: Map<string, number>;
      heat: number;
      total: number;
      sentiment: Record<SpacetimeSentimentLabel, number>;
      buckets?: Map<string, BucketAgg>;
      lastAt?: Date;
    }

    const byLocation = new Map<string, LocationAgg>();
    let updatedAt: Date | undefined;

    for (const record of records) {
      const rawLocation = typeof record.location === 'string' ? record.location.trim() : '';
      if (!rawLocation) {
        continue;
      }
      const key = normalizeLocationGroupKey(rawLocation);
      if (!key) {
        continue;
      }
      const candidate = normalizeLocationCandidate(rawLocation);
      const ts = record.eventAt ?? record.processedAt;
      if (!ts) {
        continue;
      }
      const ageMs = Math.max(0, nowMs - ts.getTime());
      const weight = Math.exp(-ageMs / halfLifeMs);

      const processedItemId =
        typeof record.cleanedMarkdownRef === 'string' ? record.cleanedMarkdownRef.trim() : '';
      const sentiment = processedItemId
        ? (sentimentByProcessedItemId.get(processedItemId) ?? 'unknown')
        : 'unknown';
      const bucketStartIso = includeBuckets ? toUtcDayStartIso(ts) : null;

      const entry = byLocation.get(key) ?? {
        key,
        candidates: new Map<string, number>(),
        heat: 0,
        total: 0,
        sentiment: createSentimentCounts(),
        buckets: includeBuckets ? new Map() : undefined,
        lastAt: undefined,
      };

      entry.candidates.set(candidate, (entry.candidates.get(candidate) ?? 0) + 1);
      entry.heat += weight;
      entry.total += 1;
      entry.sentiment[sentiment] = (entry.sentiment[sentiment] ?? 0) + 1;
      entry.lastAt = !entry.lastAt || ts > entry.lastAt ? ts : entry.lastAt;

      if (includeBuckets && bucketStartIso) {
        const buckets = entry.buckets ?? new Map<string, BucketAgg>();
        const bucket = buckets.get(bucketStartIso) ?? {
          total: 0,
          sentiment: createSentimentCounts(),
        };
        bucket.total += 1;
        bucket.sentiment[sentiment] = (bucket.sentiment[sentiment] ?? 0) + 1;
        buckets.set(bucketStartIso, bucket);
        entry.buckets = buckets;
      }

      byLocation.set(key, entry);

      updatedAt = !updatedAt || ts > updatedAt ? ts : updatedAt;
    }

    const sortedLocations = Array.from(byLocation.values())
      .sort((a, b) => b.heat - a.heat)
      .slice(0, MAX_SPACETIME_GEO_LOCATIONS);

    interface ClusterAgg {
      id: string;
      name: string;
      lat: number;
      lng: number;
      heat: number;
      total: number;
      sentiment: Record<SpacetimeSentimentLabel, number>;
      buckets?: Map<string, BucketAgg>;
    }

    const clusters = new Map<string, ClusterAgg>();
    const locationKeysByClusterKey = new Map<string, Set<string>>();
    let networkBudget = MAX_SPACETIME_GEO_GEOCODE_NETWORK;

    for (const loc of sortedLocations) {
      const candidates = Array.from(loc.candidates.entries())
        .sort((a, b) => {
          const lenDelta = b[0].length - a[0].length;
          if (lenDelta !== 0) return lenDelta;
          const countDelta = (b[1] ?? 0) - (a[1] ?? 0);
          if (countDelta !== 0) return countDelta;
          return a[0].localeCompare(b[0]);
        })
        .map(([value]) => value);
      if (!candidates.includes(loc.key)) {
        candidates.push(loc.key);
      }
      const trimmedCandidates = candidates.slice(0, 8);
      const resolvedCountry =
        trimmedCandidates.map((candidate) => extractCountryCodeFromText(candidate)).find(Boolean) ??
        null;

      const countryHintAlpha3 = normalizeGeoId(resolvedCountry);
      const directAlpha3 = normalizeGeoId(trimmedCandidates[0] ?? '');
      const countryAlpha3 = countryHintAlpha3 ?? directAlpha3;
      const countryAlpha2 = countryAlpha3
        ? (getCountryAlpha2(countryAlpha3) ?? undefined)
        : undefined;

      let lat: number | undefined;
      let lng: number | undefined;
      let displayName: string | undefined;

      if (directAlpha3) {
        const geo = geoIndex.get(directAlpha3);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
          displayName = geo.name;
        }
      }

      if (lat === undefined || lng === undefined) {
        let geocode = await this.geocoding.resolveCandidates(trimmedCandidates, {
          countryCodeAlpha2: countryAlpha2,
          allowNetwork: false,
        });
        if (!geocode && networkBudget > 0) {
          networkBudget -= 1;
          geocode = await this.geocoding.resolveCandidates(trimmedCandidates, {
            countryCodeAlpha2: countryAlpha2,
            allowNetwork: true,
          });
        }
        lat = geocode?.lat;
        lng = geocode?.lng;
        displayName = geocode?.displayName ?? displayName;

        if ((lat === undefined || lng === undefined) && countryAlpha3) {
          const fallback = geoIndex.get(countryAlpha3);
          if (fallback) {
            lat = fallback.lat;
            lng = fallback.lng;
            displayName = fallback.name;
          }
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

      const clusterLat = roundToStep(clampFinite(lat, -90, 90), SPACETIME_GEO_CLUSTER_STEP_DEG);
      const clusterLng = roundToStep(clampFinite(lng, -180, 180), SPACETIME_GEO_CLUSTER_STEP_DEG);
      const clusterKey = `${clusterLat.toFixed(3)}:${clusterLng.toFixed(3)}`;

      const locationKeys = locationKeysByClusterKey.get(clusterKey) ?? new Set<string>();
      locationKeys.add(loc.key);
      locationKeysByClusterKey.set(clusterKey, locationKeys);

      const existing = clusters.get(clusterKey) ?? {
        id: clusterKey,
        name: displayName ?? loc.key,
        lat: clusterLat,
        lng: clusterLng,
        heat: 0,
        total: 0,
        sentiment: createSentimentCounts(),
        buckets: includeBuckets ? new Map<string, BucketAgg>() : undefined,
      };

      existing.heat += loc.heat;
      existing.total += loc.total;
      for (const label of Object.keys(existing.sentiment) as SpacetimeSentimentLabel[]) {
        existing.sentiment[label] += loc.sentiment[label] ?? 0;
      }

      if (includeBuckets && loc.buckets) {
        const bucketMap = existing.buckets ?? new Map<string, BucketAgg>();
        for (const [bucketStart, bucketAgg] of loc.buckets.entries()) {
          const existingBucket = bucketMap.get(bucketStart) ?? {
            total: 0,
            sentiment: createSentimentCounts(),
          };
          existingBucket.total += bucketAgg.total;
          for (const label of Object.keys(existingBucket.sentiment) as SpacetimeSentimentLabel[]) {
            existingBucket.sentiment[label] += bucketAgg.sentiment[label] ?? 0;
          }
          bucketMap.set(bucketStart, existingBucket);
        }
        existing.buckets = bucketMap;
      }
      clusters.set(clusterKey, existing);
    }

    const points = Array.from(clusters.values())
      .sort((a, b) => b.heat - a.heat)
      .slice(0, MAX_SPACETIME_GEO_POINTS)
      .map((point) => {
        const buckets =
          includeBuckets && point.buckets
            ? Array.from(point.buckets.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([bucketStart, agg]) => ({
                  bucketStart,
                  total: agg.total,
                  sentiment: agg.sentiment,
                }))
            : undefined;

        return {
          id: point.id,
          name: point.name,
          lat: point.lat,
          lng: point.lng,
          heat: Number(point.heat.toFixed(4)),
          total: point.total,
          sentiment: point.sentiment,
          ...(buckets ? { buckets } : {}),
        };
      });

    const pointToLocationKeys: Record<string, string[]> = {};
    for (const point of points) {
      const keys = locationKeysByClusterKey.get(point.id);
      if (!keys || keys.size === 0) {
        continue;
      }
      pointToLocationKeys[point.id] = Array.from(keys).sort((a, b) => a.localeCompare(b));
    }

    const snapshotBase: SpacetimeGeoHeatmapSnapshot | null =
      points.length > 0 && Object.keys(pointToLocationKeys).length > 0
        ? {
            v: 1,
            orgId,
            eventId: eventId ? eventId : null,
            rangeStart: range.start.toISOString(),
            rangeEnd: range.end.toISOString(),
            pointToLocationKeys: Object.fromEntries(
              Object.entries(pointToLocationKeys).sort(([a], [b]) => a.localeCompare(b)),
            ),
          }
        : null;

    const snapshotId = snapshotBase
      ? createHash('sha256').update(JSON.stringify(snapshotBase)).digest('hex')
      : '';
    const snapshotStored = snapshotBase
      ? await this.storeGeoHeatmapSnapshot(orgId, snapshotId, snapshotBase)
      : false;

    return {
      points,
      ...(snapshotStored ? { snapshotId } : {}),
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getSpacetimeGeoHeatmapArticles(
    range: DateRange,
    orgId: string,
    options: {
      eventId?: string;
      snapshotId?: string;
      pointId: string;
      bucketStart?: string;
      limit?: string;
    },
  ): Promise<SpacetimeGeoHeatmapArticlesResponse> {
    const rawPointId = typeof options.pointId === 'string' ? options.pointId.trim() : '';
    const normalizePointId = (value: string): string => {
      const parts = value.split(':');
      if (parts.length !== 2) {
        throw new BadRequestException('Invalid pointId');
      }
      const lat = Number(parts[0]);
      const lng = Number(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new BadRequestException('Invalid pointId');
      }
      const clusterLat = roundToStep(clampFinite(lat, -90, 90), SPACETIME_GEO_CLUSTER_STEP_DEG);
      const clusterLng = roundToStep(clampFinite(lng, -180, 180), SPACETIME_GEO_CLUSTER_STEP_DEG);
      return `${clusterLat.toFixed(3)}:${clusterLng.toFixed(3)}`;
    };
    if (!rawPointId) {
      throw new BadRequestException('pointId is required');
    }
    const pointId = normalizePointId(rawPointId);

    const limitRaw = typeof options.limit === 'string' ? options.limit.trim() : '';
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? Math.min(80, limitParsed) : 30;

    const eventId = typeof options.eventId === 'string' ? options.eventId.trim() : '';
    const snapshotId = typeof options.snapshotId === 'string' ? options.snapshotId.trim() : '';

    let bucketStart: Date | null = null;
    let bucketEnd: Date | null = null;
    let bucketStartIso: string | undefined;
    if (typeof options.bucketStart === 'string' && options.bucketStart.trim()) {
      const parsed = new Date(options.bucketStart);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid bucketStart');
      }
      const alignedStart = alignUtcDayStart(parsed);
      bucketStart = alignedStart;
      bucketEnd = new Date(alignedStart.getTime() + DAY_MS);
      bucketStartIso = alignedStart.toISOString();
    }

    const effectiveStart = bucketStart ?? range.start;
    const effectiveEnd = bucketEnd ? new Date(bucketEnd.getTime() - 1) : range.end;

    const records = await this.prisma.processedArticle.findMany({
      where: buildProcessedArticleRangeWhere(
        orgId,
        {
          start: effectiveStart,
          end: effectiveEnd,
        },
        {
          requireLocation: true,
          extra: eventId
            ? {
                newsEventItems: {
                  some: {
                    orgId,
                    eventId,
                  },
                },
              }
            : undefined,
        },
      ),
      select: {
        id: true,
        title: true,
        location: true,
        cleanedMarkdownRef: true,
        publishedAt: true,
        eventAt: true,
        processedAt: true,
        article: {
          select: {
            url: true,
            sourceLabel: true,
            crawlAt: true,
          },
        },
      },
      orderBy: [{ eventAt: 'desc' }, { articleId: 'desc' }],
      take: MAX_SPACETIME_GEO_RECORDS,
    });

    if (records.length === 0) {
      return {
        pointId,
        bucketStart: bucketStartIso,
        hasMore: false,
        articles: [],
      };
    }

    const resolveTimestamp = (record: (typeof records)[number]) =>
      record.eventAt ?? record.article.crawlAt ?? record.processedAt;

    const sortedRecords = [...records].sort(
      (a, b) => resolveTimestamp(b).getTime() - resolveTimestamp(a).getTime(),
    );
    const first = sortedRecords[0];
    const updatedAt = first ? resolveTimestamp(first) : undefined;

    if (snapshotId) {
      const snapshot = await this.loadGeoHeatmapSnapshot(orgId, snapshotId);
      if (!snapshot) {
        throw new BadRequestException('Invalid snapshotId');
      }

      const snapshotEventId = snapshot.eventId ?? '';
      if (snapshotEventId !== eventId) {
        throw new BadRequestException('snapshotId does not match eventId');
      }

      const rangeStartIso = range.start.toISOString();
      const rangeEndIso = range.end.toISOString();
      if (snapshot.rangeStart !== rangeStartIso || snapshot.rangeEnd !== rangeEndIso) {
        throw new BadRequestException('snapshotId does not match range');
      }

      const allowedLocationKeysRaw = snapshot.pointToLocationKeys?.[pointId];
      const allowedLocationKeys = Array.isArray(allowedLocationKeysRaw)
        ? allowedLocationKeysRaw.filter((value) => typeof value === 'string' && value.trim())
        : [];
      if (allowedLocationKeys.length === 0) {
        return {
          pointId,
          bucketStart: bucketStartIso,
          hasMore: false,
          articles: [],
          updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
        };
      }

      const allowedLocationKeySet = new Set(allowedLocationKeys);

      const articles: SpacetimeGeoHeatmapArticle[] = [];
      const processedItemIdByIndex: (string | null)[] = [];
      const processedItemIds: string[] = [];
      let hasMore = false;

      for (const record of sortedRecords) {
        const rawLocation = typeof record.location === 'string' ? record.location.trim() : '';
        if (!rawLocation) {
          continue;
        }
        const groupKey = normalizeLocationGroupKey(rawLocation);
        if (!groupKey) {
          continue;
        }
        if (!allowedLocationKeySet.has(groupKey)) {
          continue;
        }

        if (articles.length >= limit) {
          hasMore = true;
          break;
        }

        const url = record.article.url ?? null;
        const title = (record.title ?? '').trim() || url || groupKey;
        const publishedAtIso = record.publishedAt ? record.publishedAt.toISOString() : undefined;
        const ingestedAtIso = record.article.crawlAt
          ? record.article.crawlAt.toISOString()
          : undefined;
        const processedAtIso = record.processedAt ? record.processedAt.toISOString() : undefined;

        const cleanedMarkdownRef =
          typeof record.cleanedMarkdownRef === 'string' ? record.cleanedMarkdownRef.trim() : '';
        const processedItemId = cleanedMarkdownRef || null;
        processedItemIdByIndex.push(processedItemId);
        if (processedItemId) {
          processedItemIds.push(processedItemId);
        }

        articles.push({
          id: record.id,
          title,
          url,
          sourceLabel: record.article.sourceLabel ?? null,
          location: rawLocation,
          publishedAt: publishedAtIso,
          ingestedAt: ingestedAtIso,
          processedAt: processedAtIso,
        });
      }

      const sentimentByProcessedItemId = new Map<string, SpacetimeSentimentLabel>();
      const uniqueProcessedItemIds = Array.from(new Set(processedItemIds));
      if (uniqueProcessedItemIds.length > 0) {
        try {
          const docs = (await ProcessedItemModel.find(
            {
              _id: { $in: uniqueProcessedItemIds },
              orgId,
              status: 'completed',
            },
            { _id: 1, result: 1 },
          )
            .lean()
            .exec()) as unknown;

          if (Array.isArray(docs)) {
            for (const doc of docs) {
              if (!doc || typeof doc !== 'object') {
                continue;
              }
              const payload = doc as Record<string, unknown>;
              const id = normalizeMongoId(payload._id);
              if (!id) {
                continue;
              }
              const result =
                payload.result &&
                typeof payload.result === 'object' &&
                !Array.isArray(payload.result)
                  ? (payload.result as Record<string, unknown>)
                  : null;
              const sentiment = normalizeSentimentLabel(
                result?.sentiment_label ?? result?.sentimentLabel ?? result?.sentiment,
              );
              sentimentByProcessedItemId.set(id, sentiment);
            }
          }
        } catch {
          // Drilldown sentiment is best-effort.
        }
      }

      for (let i = 0; i < articles.length; i += 1) {
        const processedItemId = processedItemIdByIndex[i];
        if (!processedItemId) {
          continue;
        }
        const sentiment = sentimentByProcessedItemId.get(processedItemId);
        if (sentiment) {
          articles[i]!.sentiment = sentiment;
        }
      }

      return {
        pointId,
        bucketStart: bucketStartIso,
        hasMore,
        articles,
        updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      };
    }

    const geoIndex = getGeoIndex();

    type CandidateAgg = Map<string, number>;
    const candidatesByGroupKey = new Map<string, CandidateAgg>();

    for (const record of records) {
      const rawLocation = typeof record.location === 'string' ? record.location.trim() : '';
      if (!rawLocation) {
        continue;
      }
      const groupKey = normalizeLocationGroupKey(rawLocation);
      if (!groupKey) {
        continue;
      }
      const candidate = normalizeLocationCandidate(rawLocation);
      const agg = candidatesByGroupKey.get(groupKey) ?? new Map<string, number>();
      agg.set(candidate, (agg.get(candidate) ?? 0) + 1);
      candidatesByGroupKey.set(groupKey, agg);
    }

    const clusterByGroupKey = new Map<string, { clusterKey: string | null }>();
    let networkBudget = MAX_SPACETIME_GEO_GEOCODE_NETWORK;

    const resolveClusterForGroupKey = async (
      groupKey: string,
      candidatesAgg: CandidateAgg,
    ): Promise<string | null> => {
      const cached = clusterByGroupKey.get(groupKey);
      if (cached) {
        return cached.clusterKey;
      }

      const candidates = Array.from(candidatesAgg.entries())
        .sort((a, b) => {
          const lenDelta = b[0].length - a[0].length;
          if (lenDelta !== 0) return lenDelta;
          const countDelta = (b[1] ?? 0) - (a[1] ?? 0);
          if (countDelta !== 0) return countDelta;
          return a[0].localeCompare(b[0]);
        })
        .map(([value]) => value);

      if (!candidates.includes(groupKey)) {
        candidates.push(groupKey);
      }

      const trimmedCandidates = candidates.slice(0, 8);
      const resolvedCountry =
        trimmedCandidates.map((candidate) => extractCountryCodeFromText(candidate)).find(Boolean) ??
        null;

      const countryHintAlpha3 = normalizeGeoId(resolvedCountry);
      const directAlpha3 = normalizeGeoId(trimmedCandidates[0] ?? '');
      const countryAlpha3 = countryHintAlpha3 ?? directAlpha3;
      const countryAlpha2 = countryAlpha3
        ? (getCountryAlpha2(countryAlpha3) ?? undefined)
        : undefined;

      let lat: number | undefined;
      let lng: number | undefined;

      if (directAlpha3) {
        const geo = geoIndex.get(directAlpha3);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        }
      }

      if (lat === undefined || lng === undefined) {
        let geocode = await this.geocoding.resolveCandidates(trimmedCandidates, {
          countryCodeAlpha2: countryAlpha2,
          allowNetwork: false,
        });
        if (!geocode && networkBudget > 0) {
          networkBudget -= 1;
          geocode = await this.geocoding.resolveCandidates(trimmedCandidates, {
            countryCodeAlpha2: countryAlpha2,
            allowNetwork: true,
          });
        }
        lat = geocode?.lat;
        lng = geocode?.lng;

        if ((lat === undefined || lng === undefined) && countryAlpha3) {
          const fallback = geoIndex.get(countryAlpha3);
          if (fallback) {
            lat = fallback.lat;
            lng = fallback.lng;
          }
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
        clusterByGroupKey.set(groupKey, { clusterKey: null });
        return null;
      }

      const clusterLat = roundToStep(clampFinite(lat, -90, 90), SPACETIME_GEO_CLUSTER_STEP_DEG);
      const clusterLng = roundToStep(clampFinite(lng, -180, 180), SPACETIME_GEO_CLUSTER_STEP_DEG);
      const clusterKey = `${clusterLat.toFixed(3)}:${clusterLng.toFixed(3)}`;
      clusterByGroupKey.set(groupKey, { clusterKey });
      return clusterKey;
    };

    const articles: SpacetimeGeoHeatmapArticle[] = [];
    const processedItemIdByIndex: (string | null)[] = [];
    const processedItemIds: string[] = [];
    let hasMore = false;

    for (const record of sortedRecords) {
      const rawLocation = typeof record.location === 'string' ? record.location.trim() : '';
      if (!rawLocation) {
        continue;
      }
      const groupKey = normalizeLocationGroupKey(rawLocation);
      if (!groupKey) {
        continue;
      }

      const candidatesAgg = candidatesByGroupKey.get(groupKey);
      if (!candidatesAgg) {
        continue;
      }

      const clusterKey = await resolveClusterForGroupKey(groupKey, candidatesAgg);
      if (!clusterKey || clusterKey !== pointId) {
        continue;
      }

      if (articles.length >= limit) {
        hasMore = true;
        break;
      }

      const url = record.article.url ?? null;
      const title = (record.title ?? '').trim() || url || groupKey;
      const publishedAtIso = record.publishedAt ? record.publishedAt.toISOString() : undefined;
      const ingestedAtIso = record.article.crawlAt
        ? record.article.crawlAt.toISOString()
        : undefined;
      const processedAtIso = record.processedAt ? record.processedAt.toISOString() : undefined;

      const cleanedMarkdownRef =
        typeof record.cleanedMarkdownRef === 'string' ? record.cleanedMarkdownRef.trim() : '';
      const processedItemId = cleanedMarkdownRef || null;
      processedItemIdByIndex.push(processedItemId);
      if (processedItemId) {
        processedItemIds.push(processedItemId);
      }

      articles.push({
        id: record.id,
        title,
        url,
        sourceLabel: record.article.sourceLabel ?? null,
        location: rawLocation,
        publishedAt: publishedAtIso,
        ingestedAt: ingestedAtIso,
        processedAt: processedAtIso,
      });
    }

    const sentimentByProcessedItemId = new Map<string, SpacetimeSentimentLabel>();
    const uniqueProcessedItemIds = Array.from(new Set(processedItemIds));
    if (uniqueProcessedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: uniqueProcessedItemIds }, orgId, status: 'completed' },
          { _id: 1, result: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== 'object') {
              continue;
            }
            const payload = doc as Record<string, unknown>;
            const id = normalizeMongoId(payload._id);
            if (!id) {
              continue;
            }
            const result =
              payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
                ? (payload.result as Record<string, unknown>)
                : null;
            const sentiment = normalizeSentimentLabel(
              result?.sentiment_label ?? result?.sentimentLabel ?? result?.sentiment,
            );
            sentimentByProcessedItemId.set(id, sentiment);
          }
        }
      } catch {
        // Drilldown sentiment is best-effort.
      }
    }

    for (let i = 0; i < articles.length; i += 1) {
      const processedItemId = processedItemIdByIndex[i];
      if (!processedItemId) {
        continue;
      }
      const sentiment = sentimentByProcessedItemId.get(processedItemId);
      if (sentiment) {
        articles[i]!.sentiment = sentiment;
      }
    }

    return {
      pointId,
      bucketStart: bucketStartIso,
      hasMore,
      articles,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getSpacetimePropagation(
    range: DateRange,
    orgId: string,
    options: {
      eventId: string;
      windowHours?: string;
      maxNodes?: string;
      maxEdges?: string;
      maxPredecessorsPerSignal?: string;
    },
  ): Promise<SpacetimePropagationResponse> {
    const eventId = typeof options.eventId === 'string' ? options.eventId.trim() : '';
    if (!eventId) {
      throw new BadRequestException('eventId is required');
    }

    const parseBoundedInt = (
      raw: string | undefined,
      fallback: number,
      min: number,
      max: number,
    ) => {
      if (!raw) {
        return fallback;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        return fallback;
      }
      return Math.max(min, Math.min(max, parsed));
    };

    const windowHours = parseBoundedInt(
      options.windowHours?.trim(),
      DEFAULT_SPACETIME_PROPAGATION_WINDOW_HOURS,
      1,
      MAX_SPACETIME_PROPAGATION_WINDOW_HOURS,
    );
    const maxNodes = parseBoundedInt(options.maxNodes?.trim(), 140, 30, 600);
    const maxEdges = parseBoundedInt(options.maxEdges?.trim(), 320, 60, 2000);
    const maxPredecessorsPerSignal = parseBoundedInt(
      options.maxPredecessorsPerSignal?.trim(),
      DEFAULT_SPACETIME_PROPAGATION_PREDECESSORS,
      1,
      MAX_SPACETIME_PROPAGATION_PREDECESSORS,
    );
    const windowMs = windowHours * 60 * 60 * 1000;

    const resolveSourceKey = (sourceLabel: unknown, url: unknown): string => {
      const label = typeof sourceLabel === 'string' ? sourceLabel.trim() : '';
      if (label) {
        return label.slice(0, 120);
      }
      const rawUrl = typeof url === 'string' ? url.trim() : '';
      if (rawUrl) {
        try {
          const host = new URL(rawUrl).hostname.trim();
          if (host) {
            return host.slice(0, 120);
          }
        } catch {
          // Ignore invalid URLs.
        }
      }
      return 'unknown';
    };

    const rows = await this.prisma.newsEventItem.findMany({
      where: {
        orgId,
        eventId,
        processedArticle: {
          status: ProcessedArticleStatus.completed,
          orgId,
          eventAt: {
            gte: range.start,
            lte: range.end,
          },
        },
      },
      select: {
        processedItemId: true,
        createdAt: true,
        processedArticle: {
          select: {
            id: true,
            cleanedMarkdownRef: true,
            title: true,
            publishedAt: true,
            processedAt: true,
            article: {
              select: {
                url: true,
                sourceLabel: true,
                crawlAt: true,
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 2000,
    });

    interface Signal {
      processedArticleId: string;
      processedItemId: string | null;
      processedItemLookupKeys: string[];
      source: string;
      timestampMs: number;
    }

    const signals: Signal[] = [];
    const nodeAgg = new Map<string, { count: number; firstMs: number; lastMs: number }>();
    const signalByProcessedItemId = new Map<string, Signal>();
    let updatedAt: Date | undefined;

    for (const row of rows) {
      const processed = row.processedArticle;
      if (!processed) {
        continue;
      }
      const article = processed.article;
      const ts = processed.publishedAt ?? article?.crawlAt ?? processed.processedAt;
      if (!ts) {
        continue;
      }
      const tsMs = ts.getTime();
      if (!Number.isFinite(tsMs)) {
        continue;
      }

      const source = resolveSourceKey(article?.sourceLabel, article?.url);
      const processedItemLookupKeys = resolveProcessedItemLookupKeys(
        row.processedItemId,
        processed.cleanedMarkdownRef,
      );
      const processedItemId = processedItemLookupKeys[0] ?? null;

      const signal: Signal = {
        processedArticleId: processed.id,
        processedItemId,
        processedItemLookupKeys,
        source,
        timestampMs: tsMs,
      };
      signals.push(signal);

      const existing = nodeAgg.get(source);
      if (!existing) {
        nodeAgg.set(source, { count: 1, firstMs: tsMs, lastMs: tsMs });
      } else {
        existing.count += 1;
        existing.firstMs = Math.min(existing.firstMs, tsMs);
        existing.lastMs = Math.max(existing.lastMs, tsMs);
      }

      if (processedItemLookupKeys.length > 0) {
        for (const lookupKey of processedItemLookupKeys) {
          const prior = signalByProcessedItemId.get(lookupKey);
          if (!prior || tsMs < prior.timestampMs) {
            signalByProcessedItemId.set(lookupKey, signal);
          }
        }
      }

      updatedAt = !updatedAt || ts > updatedAt ? ts : updatedAt;
    }

    if (signals.length === 0) {
      return {
        eventId,
        windowHours,
        nodes: [],
        edges: [],
        updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      };
    }

    interface EdgeAgg {
      kind: SpacetimePropagationEdgeKind;
      source: string;
      target: string;
      weight: number;
      lagSumMs: number;
      lagCount: number;
      firstMs: number;
      lastMs: number;
      similaritySum?: number;
      similarityCount?: number;
    }

    const edgeAgg = new Map<string, EdgeAgg>();

    const pushEdge = (
      kind: SpacetimePropagationEdgeKind,
      source: string,
      target: string,
      lagMs: number,
      tsMs: number,
      similarity?: number | null,
    ) => {
      if (!source || !target || source === target) {
        return;
      }
      const key = `${kind}:${source} -> ${target}`;
      const existing = edgeAgg.get(key);
      if (!existing) {
        edgeAgg.set(key, {
          kind,
          source,
          target,
          weight: 1,
          lagSumMs: lagMs,
          lagCount: 1,
          firstMs: tsMs,
          lastMs: tsMs,
          ...(kind === 'duplicate' && typeof similarity === 'number' && Number.isFinite(similarity)
            ? { similaritySum: similarity, similarityCount: 1 }
            : {}),
        });
        return;
      }
      existing.weight += 1;
      existing.lagSumMs += lagMs;
      existing.lagCount += 1;
      existing.firstMs = Math.min(existing.firstMs, tsMs);
      existing.lastMs = Math.max(existing.lastMs, tsMs);
      if (kind === 'duplicate' && typeof similarity === 'number' && Number.isFinite(similarity)) {
        existing.similaritySum = (existing.similaritySum ?? 0) + similarity;
        existing.similarityCount = (existing.similarityCount ?? 0) + 1;
      }
    };

    const handledDuplicateChildren = new Set<string>();

    const processedItemIds = Array.from(
      new Set(
        signals
          .flatMap((signal) => signal.processedItemLookupKeys)
          .filter(isMongoObjectIdLookupKey),
      ),
    );

    if (processedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: processedItemIds }, orgId, status: 'completed' },
          { _id: 1, duplicateOf: 1, duplicateSimilarity: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== 'object') {
              continue;
            }
            const payload = doc as Record<string, unknown>;
            const childId = extractMongoObjectIdLookupKey(payload._id);
            const parentId = extractMongoObjectIdLookupKey(payload.duplicateOf);
            if (!childId || !parentId) {
              continue;
            }
            const child = signalByProcessedItemId.get(childId);
            const parent = signalByProcessedItemId.get(parentId);
            if (!child || !parent) {
              continue;
            }
            if (child.source === parent.source) {
              continue;
            }
            const lagMs = Math.abs(child.timestampMs - parent.timestampMs);
            const tsMs = Math.max(child.timestampMs, parent.timestampMs);
            const similarity =
              typeof payload.duplicateSimilarity === 'number' &&
              Number.isFinite(payload.duplicateSimilarity)
                ? payload.duplicateSimilarity
                : null;

            const forward = parent.timestampMs <= child.timestampMs;
            const source = forward ? parent.source : child.source;
            const target = forward ? child.source : parent.source;
            pushEdge('duplicate', source, target, lagMs, tsMs, similarity);
            handledDuplicateChildren.add(childId);
          }
        }
      } catch {
        // Duplicate edges are best-effort; fall back to time-based edges.
      }
    }

    signals.sort((a, b) => a.timestampMs - b.timestampMs);

    for (let idx = 0; idx < signals.length; idx += 1) {
      const signal = signals[idx]!;
      if (
        signal.processedItemLookupKeys.length > 0 &&
        signal.processedItemLookupKeys.some((lookupKey) => handledDuplicateChildren.has(lookupKey))
      ) {
        continue;
      }
      const linkedSources = new Set<string>();
      for (let prevIdx = idx - 1; prevIdx >= 0; prevIdx -= 1) {
        if (linkedSources.size >= maxPredecessorsPerSignal) {
          break;
        }
        const prev = signals[prevIdx]!;
        const deltaMs = signal.timestampMs - prev.timestampMs;
        if (deltaMs > windowMs) {
          break;
        }
        if (prev.source === signal.source || linkedSources.has(prev.source)) {
          continue;
        }
        pushEdge('time', prev.source, signal.source, deltaMs, signal.timestampMs);
        linkedSources.add(prev.source);
      }
    }

    const sortedNodes = Array.from(nodeAgg.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, maxNodes)
      .map(([source, agg]) => ({
        id: source,
        name: source,
        count: agg.count,
        firstAt: new Date(agg.firstMs).toISOString(),
        lastAt: new Date(agg.lastMs).toISOString(),
      }));

    const allowed = new Set(sortedNodes.map((node) => node.id));

    const sortedEdges = Array.from(edgeAgg.values())
      .filter((edge) => allowed.has(edge.source) && allowed.has(edge.target))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, maxEdges)
      .map((edge) => {
        const avgLagMs = edge.lagCount > 0 ? edge.lagSumMs / edge.lagCount : 0;
        const avgDuplicateSimilarity =
          edge.kind === 'duplicate' && edge.similarityCount && edge.similarityCount > 0
            ? (edge.similaritySum ?? 0) / edge.similarityCount
            : undefined;
        return {
          source: edge.source,
          target: edge.target,
          kind: edge.kind,
          weight: edge.weight,
          avgLagMs,
          firstAt: new Date(edge.firstMs).toISOString(),
          lastAt: new Date(edge.lastMs).toISOString(),
          ...(avgDuplicateSimilarity !== undefined ? { avgDuplicateSimilarity } : {}),
        };
      });

    return {
      eventId,
      windowHours,
      nodes: sortedNodes,
      edges: sortedEdges,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getSpacetimePropagationArticles(
    range: DateRange,
    orgId: string,
    options: {
      eventId: string;
      source: string;
      cursorStart?: string;
      cursorEnd?: string;
      limit?: string;
    },
  ): Promise<SpacetimePropagationArticlesResponse> {
    const eventId = typeof options.eventId === 'string' ? options.eventId.trim() : '';
    if (!eventId) {
      throw new BadRequestException('eventId is required');
    }
    const source = typeof options.source === 'string' ? options.source.trim() : '';
    if (!source) {
      throw new BadRequestException('source is required');
    }

    const limitRaw = typeof options.limit === 'string' ? options.limit.trim() : '';
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? Math.min(100, limitParsed) : 30;

    const parseIsoDate = (raw?: string): Date | null => {
      if (!raw || typeof raw !== 'string') {
        return null;
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        return null;
      }
      const d = new Date(trimmed);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException('Invalid cursor date');
      }
      return d;
    };

    const cursorStart = parseIsoDate(options.cursorStart);
    const cursorEnd = parseIsoDate(options.cursorEnd);
    const cursorStartIso = cursorStart ? cursorStart.toISOString() : undefined;
    const cursorEndIso = cursorEnd ? cursorEnd.toISOString() : undefined;

    const resolveSourceKey = (sourceLabel: unknown, url: unknown): string => {
      const label = typeof sourceLabel === 'string' ? sourceLabel.trim() : '';
      if (label) {
        return label.slice(0, 120);
      }
      const rawUrl = typeof url === 'string' ? url.trim() : '';
      if (rawUrl) {
        try {
          const host = new URL(rawUrl).hostname.trim();
          if (host) {
            return host.slice(0, 120);
          }
        } catch {
          // Ignore invalid URLs.
        }
      }
      return 'unknown';
    };

    const rows = await this.prisma.newsEventItem.findMany({
      where: {
        orgId,
        eventId,
        processedArticle: {
          status: ProcessedArticleStatus.completed,
          orgId,
          eventAt: {
            gte: range.start,
            lte: range.end,
          },
        },
      },
      select: {
        processedItemId: true,
        createdAt: true,
        processedArticle: {
          select: {
            id: true,
            cleanedMarkdownRef: true,
            title: true,
            publishedAt: true,
            processedAt: true,
            article: {
              select: {
                url: true,
                sourceLabel: true,
                crawlAt: true,
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 2000,
    });

    const matches: {
      processedArticleId: string;
      processedItemId: string | null;
      title: string;
      url: string | null;
      sourceLabel: string | null;
      publishedAt?: string;
      ingestedAt?: string;
      processedAt?: string;
      tsMs: number;
    }[] = [];

    let updatedAt: Date | undefined;

    for (const row of rows) {
      const processed = row.processedArticle;
      if (!processed) {
        continue;
      }
      const article = processed.article;
      const sourceKey = resolveSourceKey(article?.sourceLabel, article?.url);
      if (sourceKey !== source) {
        continue;
      }

      const ts = processed.publishedAt ?? article?.crawlAt ?? processed.processedAt;
      if (!ts) {
        continue;
      }
      if (cursorStart && ts < cursorStart) {
        continue;
      }
      if (cursorEnd && ts >= cursorEnd) {
        continue;
      }
      const tsMs = ts.getTime();
      if (!Number.isFinite(tsMs)) {
        continue;
      }

      const url = article?.url ?? null;
      const title = (processed.title ?? '').trim() || url || sourceKey;
      const publishedAtIso = processed.publishedAt
        ? processed.publishedAt.toISOString()
        : undefined;
      const ingestedAtIso = article?.crawlAt ? article.crawlAt.toISOString() : undefined;
      const processedAtIso = processed.processedAt
        ? processed.processedAt.toISOString()
        : undefined;

      const processedItemIdCandidate =
        (typeof row.processedItemId === 'string' ? row.processedItemId.trim() : '') ||
        (typeof processed.cleanedMarkdownRef === 'string'
          ? processed.cleanedMarkdownRef.trim()
          : '');
      const processedItemId = processedItemIdCandidate ? processedItemIdCandidate : null;

      matches.push({
        processedArticleId: processed.id,
        processedItemId,
        title,
        url,
        sourceLabel: typeof article?.sourceLabel === 'string' ? article.sourceLabel : null,
        publishedAt: publishedAtIso,
        ingestedAt: ingestedAtIso,
        processedAt: processedAtIso,
        tsMs,
      });

      updatedAt = !updatedAt || ts > updatedAt ? ts : updatedAt;
    }

    matches.sort((a, b) => b.tsMs - a.tsMs);

    const selected = matches.slice(0, limit);
    const hasMore = matches.length > selected.length;

    const processedItemIds = Array.from(
      new Set(selected.map((row) => row.processedItemId ?? '').filter((id) => id.length > 0)),
    );

    const sentimentByProcessedItemId = new Map<string, SpacetimeSentimentLabel>();
    if (processedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: processedItemIds }, orgId, status: 'completed' },
          { _id: 1, result: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== 'object') {
              continue;
            }
            const payload = doc as Record<string, unknown>;
            const id = normalizeMongoId(payload._id);
            if (!id) {
              continue;
            }
            const result =
              payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
                ? (payload.result as Record<string, unknown>)
                : null;
            const sentiment = normalizeSentimentLabel(
              result?.sentiment_label ?? result?.sentimentLabel ?? result?.sentiment,
            );
            sentimentByProcessedItemId.set(id, sentiment);
          }
        }
      } catch {
        // Sentiment is best-effort.
      }
    }

    const articles: SpacetimePropagationArticle[] = selected.map((row) => ({
      id: row.processedArticleId,
      title: row.title,
      url: row.url,
      sourceLabel: row.sourceLabel,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
      processedAt: row.processedAt,
      ...(row.processedItemId && sentimentByProcessedItemId.has(row.processedItemId)
        ? { sentiment: sentimentByProcessedItemId.get(row.processedItemId)! }
        : {}),
    }));

    return {
      eventId,
      source,
      cursorStart: cursorStartIso,
      cursorEnd: cursorEndIso,
      hasMore,
      articles,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }
}
