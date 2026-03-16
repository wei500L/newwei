import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";

import {
  REALTIME_SIGNALS_SERIES_MAX_POINTS,
  REALTIME_SIGNALS_SERIES_TTL_SECONDS,
} from "./realtime-signals.constants";
import type {
  RealtimeAdsbLatestSnapshot,
  RealtimeAisLatestSnapshot,
  RealtimeSignalMetricPoint,
  RealtimeSignalMetricSeries,
  RealtimeSignalSnapshotEvaluation,
  RealtimeSignalSourceState,
  RealtimeSignalsInsightSnapshot,
  RealtimeSignalSource,
} from "./realtime-signals.types";

@Injectable()
export class RealtimeSignalsSnapshotStore {
  constructor(private readonly cache: CacheService) {}

  async appendPoint(
    orgId: string,
    metricSlug: string,
    point: RealtimeSignalMetricPoint,
  ) {
    const key = this.seriesKey(orgId, metricSlug);
    const current = (await this.cache.get<RealtimeSignalMetricSeries>(key)) ?? {
      metricSlug,
      points: [],
    };
    const nextPoints = [...current.points, point]
      .slice(-REALTIME_SIGNALS_SERIES_MAX_POINTS)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    await this.cache.set(
      key,
      {
        metricSlug,
        points: nextPoints,
      } satisfies RealtimeSignalMetricSeries,
      REALTIME_SIGNALS_SERIES_TTL_SECONDS,
    );
  }

  async getSeries(orgId: string, metricSlug: string) {
    const key = this.seriesKey(orgId, metricSlug);
    const current = await this.cache.get<RealtimeSignalMetricSeries>(key);
    if (!current || !Array.isArray(current.points)) {
      return [] as RealtimeSignalMetricPoint[];
    }
    return current.points
      .filter(
        (entry): entry is RealtimeSignalMetricPoint =>
          Boolean(
            entry &&
              typeof entry.ts === "string" &&
              typeof entry.value === "number" &&
              Number.isFinite(entry.value),
          ),
      )
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async evaluateMetric(
    orgId: string,
    metricSlug: string,
    changeWindowMin?: number | null,
  ): Promise<RealtimeSignalSnapshotEvaluation> {
    const points = await this.getSeries(orgId, metricSlug);
    if (points.length === 0) {
      return { latest: null, previous: null, changePercent: null };
    }

    const latestPoint = points[points.length - 1]!;
    const latestTs = Date.parse(latestPoint.ts);
    const windowMin = Math.max(1, Math.trunc(changeWindowMin ?? 60));
    const maxStaleMin = Math.max(5, windowMin * 2);
    const maxStaleMs = maxStaleMin * 60_000;
    if (Number.isFinite(latestTs) && Date.now() - latestTs > maxStaleMs) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context:
          latestPoint.context &&
          typeof latestPoint.context === "object" &&
          !Array.isArray(latestPoint.context)
            ? {
                ...latestPoint.context,
                stale: true,
                latestTimestamp: latestPoint.ts,
                maxStaleMinutes: maxStaleMin,
              }
            : {
                stale: true,
                latestTimestamp: latestPoint.ts,
                maxStaleMinutes: maxStaleMin,
              },
      };
    }
    const targetTs = Number.isFinite(latestTs)
      ? latestTs - windowMin * 60_000
      : Number.NaN;

    let previousPoint: RealtimeSignalMetricPoint | null = null;
    if (Number.isFinite(targetTs)) {
      for (let i = points.length - 2; i >= 0; i -= 1) {
        const candidate = points[i]!;
        const candidateTs = Date.parse(candidate.ts);
        if (!Number.isFinite(candidateTs)) {
          continue;
        }
        if (candidateTs <= targetTs) {
          previousPoint = candidate;
          break;
        }
      }
    }
    if (!previousPoint && points.length > 1) {
      previousPoint = points[points.length - 2]!;
    }

    const latest = latestPoint.value;
    const previous = previousPoint?.value ?? null;
    const changePercent =
      previous !== null && previous !== 0
        ? ((latest - previous) / previous) * 100
        : null;

    return {
      latest,
      previous,
      changePercent:
        typeof changePercent === "number" && Number.isFinite(changePercent)
          ? changePercent
          : null,
      context:
        latestPoint.context &&
        typeof latestPoint.context === "object" &&
        !Array.isArray(latestPoint.context)
          ? latestPoint.context
          : undefined,
    };
  }

  async getLatestContext(orgId: string, metricSlug: string) {
    const points = await this.getSeries(orgId, metricSlug);
    const latestPoint = points[points.length - 1];
    if (!latestPoint?.context) {
      return undefined;
    }
    return latestPoint.context;
  }

  async getLatestAdsbSnapshot(orgId: string) {
    return this.cache.get<RealtimeAdsbLatestSnapshot>(this.adsbLatestKey(orgId));
  }

  async setLatestAdsbSnapshot(
    orgId: string,
    snapshot: RealtimeAdsbLatestSnapshot,
    ttlSeconds: number,
  ) {
    const normalizedTtlSeconds = Math.max(60, Math.floor(ttlSeconds));
    await this.cache.set(
      this.adsbLatestKey(orgId),
      snapshot,
      normalizedTtlSeconds,
    );
  }

  async clearLatestAdsbSnapshot(orgId: string) {
    await this.cache.del(this.adsbLatestKey(orgId));
  }

  async getLatestAisSnapshot(orgId: string) {
    return this.cache.get<RealtimeAisLatestSnapshot>(this.aisLatestKey(orgId));
  }

  async setLatestAisSnapshot(
    orgId: string,
    snapshot: RealtimeAisLatestSnapshot,
    ttlSeconds: number,
  ) {
    const normalizedTtlSeconds = Math.max(60, Math.floor(ttlSeconds));
    await this.cache.set(
      this.aisLatestKey(orgId),
      snapshot,
      normalizedTtlSeconds,
    );
  }

  async clearLatestAisSnapshot(orgId: string) {
    await this.cache.del(this.aisLatestKey(orgId));
  }

  async setLastRun(orgId: string, source: RealtimeSignalSource, tsMs: number) {
    await this.cache.set(this.lastRunKey(orgId, source), tsMs, 60 * 60 * 24 * 7);
  }

  async getLastRun(orgId: string, source: RealtimeSignalSource) {
    const value = await this.cache.get<number>(this.lastRunKey(orgId, source));
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  async getInsightSnapshot(orgId: string) {
    return this.cache.get<RealtimeSignalsInsightSnapshot>(this.insightKey(orgId));
  }

  async setInsightSnapshot(orgId: string, snapshot: RealtimeSignalsInsightSnapshot) {
    await this.cache.set(this.insightKey(orgId), snapshot, 60 * 60 * 12);
  }

  async getSourceState(orgId: string, source: RealtimeSignalSource) {
    return this.cache.get<RealtimeSignalSourceState>(
      this.sourceStateKey(orgId, source),
    );
  }

  async setSourceState(orgId: string, state: RealtimeSignalSourceState) {
    await this.cache.set(
      this.sourceStateKey(orgId, state.source),
      state,
      60 * 60 * 24 * 7,
    );
  }

  private seriesKey(orgId: string, metricSlug: string) {
    return `realtime-signals:series:${orgId}:${metricSlug}`;
  }

  private lastRunKey(orgId: string, source: RealtimeSignalSource) {
    return `realtime-signals:last-run:${orgId}:${source}`;
  }

  private insightKey(orgId: string) {
    return `realtime-signals:insights:${orgId}`;
  }

  private sourceStateKey(orgId: string, source: RealtimeSignalSource) {
    return `realtime-signals:source-state:${orgId}:${source}`;
  }

  private adsbLatestKey(orgId: string) {
    return `realtime-signals:opensky-latest:${orgId}`;
  }

  private aisLatestKey(orgId: string) {
    return `realtime-signals:ais-latest:${orgId}`;
  }
}
