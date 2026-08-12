import { DASHBOARD_STREAM_EVENT_TYPES } from "@modular/utils";
import {
  Controller,
  Get,
  Header,
  HttpException,
  InternalServerErrorException,
  MessageEvent,
  Query,
  Sse,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { createHash } from "node:crypto";
import { Observable } from "rxjs";

/* eslint-disable import/order */
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { DashboardChartsService } from "./dashboard-charts.service";
import { DashboardService } from "./dashboard.service";
/* eslint-enable import/order */

function parseWarMapFlightMode(value?: string): "military" | "all" {
  return value?.trim().toLowerCase() === "all" ? "all" : "military";
}

function parseWarMapAisMode(value?: string): "all" | "military" | "density" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  if (normalized === "density") {
    return "density";
  }
  return "military";
}
import {
  DashboardStreamQueryDto,
  DashboardWarMapNewsMarkersQueryDto,
  DashboardWarMapQueryDto,
  DashboardWarMapTransportDetailQueryDto,
  DashboardSpacetimeGeoHeatmapArticlesQueryDto,
  DashboardSpacetimeGeoHeatmapQueryDto,
  DashboardSpacetimePropagationArticlesQueryDto,
  DashboardSpacetimePropagationQueryDto,
  DashboardTimeRangeQueryDto,
} from "./dto/dashboard-charts.dto";

function readEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hashText(value: string): string {
  return createHash("sha1").update(value).digest("base64url");
}

export function createDashboardStreamFingerprint(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized === "string") {
      return hashText(serialized);
    }
    return hashText(String(payload));
  } catch {
    return hashText(String(payload));
  }
}

type DashboardTranslateTarget = "zh-CN";

function parseTranslateTarget(
  value: unknown,
): DashboardTranslateTarget | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "zh-cn" || normalized === "zh") {
    return "zh-CN";
  }
  return undefined;
}

function parseWarMapBbox(
  value: unknown,
): [number, number, number, number] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((part) => Number.parseFloat(part.trim()))
    .filter((part) => Number.isFinite(part));
  if (parts.length !== 4) {
    return undefined;
  }
  const [minLng, minLat, maxLng, maxLat] = parts as [
    number,
    number,
    number,
    number,
  ];
  if (
    minLng < -180 ||
    maxLng > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLng > maxLng ||
    minLat > maxLat
  ) {
    return undefined;
  }
  return [minLng, minLat, maxLng, maxLat];
}

function parseWarMapZoom(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return clampInt(Math.round(parsed * 100), 50, 1800) / 100;
}

function parseWarMapCluster(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseWarMapTransportKind(
  value: unknown,
): "aircraft" | "vessel" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "aircraft" || normalized === "vessel") {
    return normalized;
  }
  return undefined;
}

function parseOptionalPositiveInt(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return clampInt(parsed, min, max);
}

@ApiTags("dashboard")
@ApiBearerAuth()
@Controller("dashboard")
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    private readonly chartsService: DashboardChartsService,
  ) {}

  @Permissions("items.read")
  @Get("stats")
  async stats(@CurrentUser() user: AuthenticatedUser) {
    return this.service.stats(user.orgId);
  }

  @Permissions("dashboards.read")
  @Get("war-map/geojson")
  @Header("Cache-Control", "no-store")
  async warMapGeoJson(@Query() query: DashboardTimeRangeQueryDto) {
    this.chartsService.resolveRange(query);
    try {
      return this.chartsService.getWarMapGeoJson();
    } catch (error) {
      throw new InternalServerErrorException({
        code: "GEOJSON_LOAD_FAILED",
        message: "GeoJSON map could not be loaded",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  @Permissions("dashboards.read")
  @Get("war-map/layers")
  @Header("Cache-Control", "no-store")
  async warMapLayers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardWarMapQueryDto,
  ) {
    const range = this.chartsService.resolveRange(query, {
      alignToUtcDay: false,
    });
    return this.chartsService.getWarMapLayers({
      translateTarget: parseTranslateTarget(query.translate),
      orgId: user.orgId,
      range,
      bbox: parseWarMapBbox(query.bbox),
      zoom: parseWarMapZoom(query.zoom),
      flightMode: parseWarMapFlightMode(query.flightMode),
      aisMode: parseWarMapAisMode(query.aisMode),
    });
  }

  @Permissions("dashboards.read")
  @Get("war-map/events")
  async warMapEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardWarMapQueryDto,
  ) {
    const range = this.chartsService.resolveRange(query, {
      alignToUtcDay: false,
    });
    return this.chartsService.getWarMapEvents(range, user.orgId, {
      translateTarget: parseTranslateTarget(query.translate),
      bbox: parseWarMapBbox(query.bbox),
      zoom: parseWarMapZoom(query.zoom),
      cluster: parseWarMapCluster(query.cluster),
    });
  }

  @Permissions("dashboards.read")
  @Get("war-map/news-markers")
  async warMapNewsMarkers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardWarMapNewsMarkersQueryDto,
  ) {
    const range = this.chartsService.resolveRange(query, {
      alignToUtcDay: false,
    });
    return this.chartsService.getWarMapNewsMarkers(range, user.orgId, {
      translateTarget: parseTranslateTarget(query.translate),
      bbox: parseWarMapBbox(query.bbox),
      zoom: parseWarMapZoom(query.zoom),
      cluster: parseWarMapCluster(query.cluster),
    });
  }

  @Permissions("dashboards.read")
  @Get("war-map/transport-detail")
  async warMapTransportDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardWarMapTransportDetailQueryDto,
  ) {
    const kind = parseWarMapTransportKind(query.kind);
    if (!kind) {
      throw new HttpException(
        {
          code: "INVALID_TRANSPORT_KIND",
          message: "Transport kind must be aircraft or vessel.",
        },
        400,
      );
    }

    const range = this.chartsService.resolveRange(query, {
      alignToUtcDay: false,
    });
    return this.chartsService.getWarMapTransportDetail({
      orgId: user.orgId,
      kind,
      objectKey: query.objectKey,
      range,
      limit: parseOptionalPositiveInt(query.limit, 5, 50) ?? 20,
    });
  }

  @Permissions("dashboards.read")
  @Get("spacetime/geo-heatmap")
  async spacetimeGeoHeatmap(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimeGeoHeatmapQueryDto,
  ) {
    const range = this.chartsService.resolveRange(query);
    const includeBuckets =
      query.includeBuckets === "1" || query.includeBuckets === "true";
    return this.chartsService.getSpacetimeGeoHeatmap(range, user.orgId, {
      eventId: query.eventId,
      includeBuckets,
    });
  }

  @Permissions("dashboards.read")
  @Get("spacetime/geo-heatmap/articles")
  async spacetimeGeoHeatmapArticles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimeGeoHeatmapArticlesQueryDto,
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getSpacetimeGeoHeatmapArticles(
      range,
      user.orgId,
      {
        eventId: query.eventId,
        snapshotId: query.snapshotId,
        pointId: query.pointId,
        bucketStart: query.bucketStart,
        limit: query.limit,
      },
    );
  }

  @Permissions("dashboards.read")
  @Get("spacetime/propagation")
  async spacetimePropagation(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimePropagationQueryDto,
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getSpacetimePropagation(range, user.orgId, {
      eventId: query.eventId,
      windowHours: query.windowHours,
      maxNodes: query.maxNodes,
      maxEdges: query.maxEdges,
      maxPredecessorsPerSignal: query.maxPredecessorsPerSignal,
    });
  }

  @Permissions("dashboards.read")
  @Get("spacetime/propagation/articles")
  async spacetimePropagationArticles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimePropagationArticlesQueryDto,
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getSpacetimePropagationArticles(
      range,
      user.orgId,
      {
        eventId: query.eventId,
        source: query.source,
        cursorStart: query.cursorStart,
        cursorEnd: query.cursorEnd,
        limit: query.limit,
      },
    );
  }

  @Permissions("dashboards.read")
  @Get("sector-heatmap")
  async sectorHeatmap(@Query() query: DashboardTimeRangeQueryDto) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getSectorHeatmap(range);
  }

  @Permissions("dashboards.read")
  @Get("financial-candlestick")
  async financialCandlestick(@Query() query: DashboardTimeRangeQueryDto) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getFinancialCandlestick(range);
  }

  @Permissions("dashboards.read")
  @Sse("stream")
  dashboardStream(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardStreamQueryDto,
  ): Observable<MessageEvent> {
    const range = this.chartsService.resolveRange(query);
    const warMapRange = this.chartsService.resolveRange(
      {
        start: query.warMapStart ?? query.start,
        end: query.warMapEnd ?? query.end,
      },
      {
        alignToUtcDay: false,
      },
    );
    const warMapEventsOptions = {
      translateTarget: parseTranslateTarget(query.warMapTranslate),
      bbox: parseWarMapBbox(query.warMapBbox),
      zoom: parseWarMapZoom(query.warMapZoom),
      cluster: false,
    } as const;
    const warMapLayersOptions = {
      translateTarget: parseTranslateTarget(query.warMapTranslate),
      orgId: user.orgId,
      range: warMapRange,
      bbox: parseWarMapBbox(query.warMapBbox),
      zoom: parseWarMapZoom(query.warMapZoom),
      flightMode: parseWarMapFlightMode(query.warMapFlightMode),
      aisMode: parseWarMapAisMode(query.warMapAisMode),
    } as const;
    const defaultIntervalMs =
      process.env.NODE_ENV === "development" ? 2_000 : 10_000;
    const intervalMs = clampInt(
      readEnvInt("DASHBOARD_STREAM_INTERVAL_MS", defaultIntervalMs),
      1_000,
      60_000,
    );
    const pingMs = clampInt(
      readEnvInt("DASHBOARD_STREAM_PING_MS", 25_000),
      5_000,
      120_000,
    );

    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let inflight = false;
      let lastWarFingerprint = "";
      let lastWarNewsFingerprint = "";
      let lastWarLayersFingerprint = "";
      let lastCandleFingerprint = "";
      let lastGeoHeatmapFingerprint = "";

      const publish = async (force = false) => {
        if (closed || inflight) return;
        inflight = true;
        try {
          const geoHeatmapPromise = this.chartsService
            .getSpacetimeGeoHeatmap(range, user.orgId)
            .catch(() => null);

          // Shared promises: the stream and the layers enrichment both need
          // events + news markers; reusing the same promises avoids doubling
          // the aggregation work on every SSE interval.
          const warEventsPromise = this.chartsService.getWarMapEvents(
            warMapRange,
            user.orgId,
            warMapEventsOptions,
          );
          const warNewsMarkersPromise = this.chartsService.getWarMapNewsMarkers(
            warMapRange,
            user.orgId,
            warMapEventsOptions,
          );

          const [warEvents, warNewsMarkers, warLayers, candlestick] = await Promise.all([
            warEventsPromise,
            warNewsMarkersPromise,
            this.chartsService.getWarMapLayers({
              ...warMapLayersOptions,
              realtimeData: {
                events: warEventsPromise,
                newsMarkers: warNewsMarkersPromise,
              },
            }),
            this.chartsService.getFinancialCandlestick(range),
          ]);
          const geoHeatmap = await geoHeatmapPromise;

          const warFingerprint = createDashboardStreamFingerprint(warEvents);
          if (force || warFingerprint !== lastWarFingerprint) {
            subscriber.next({
              type: DASHBOARD_STREAM_EVENT_TYPES.warMapEvents,
              data: warEvents,
            });
            lastWarFingerprint = warFingerprint;
          }

          const warNewsFingerprint =
            createDashboardStreamFingerprint(warNewsMarkers);
          if (force || warNewsFingerprint !== lastWarNewsFingerprint) {
            subscriber.next({
              type: DASHBOARD_STREAM_EVENT_TYPES.warMapNewsMarkers,
              data: warNewsMarkers,
            });
            lastWarNewsFingerprint = warNewsFingerprint;
          }

          const warLayersFingerprint =
            createDashboardStreamFingerprint(warLayers);
          if (force || warLayersFingerprint !== lastWarLayersFingerprint) {
            subscriber.next({
              type: DASHBOARD_STREAM_EVENT_TYPES.warMapLayers,
              data: warLayers,
            });
            lastWarLayersFingerprint = warLayersFingerprint;
          }

          const candleFingerprint =
            createDashboardStreamFingerprint(candlestick);
          if (force || candleFingerprint !== lastCandleFingerprint) {
            subscriber.next({
              type: DASHBOARD_STREAM_EVENT_TYPES.financialCandlestick,
              data: candlestick,
            });
            lastCandleFingerprint = candleFingerprint;
          }

          if (geoHeatmap) {
            const geoHeatmapFingerprint =
              createDashboardStreamFingerprint(geoHeatmap);
            if (force || geoHeatmapFingerprint !== lastGeoHeatmapFingerprint) {
              subscriber.next({
                type: DASHBOARD_STREAM_EVENT_TYPES.spacetimeGeoHeatmap,
                data: geoHeatmap,
              });
              lastGeoHeatmapFingerprint = geoHeatmapFingerprint;
            }
          }
        } catch (error) {
          let code: string | undefined;
          let detail = error instanceof Error ? error.message : "Unknown error";
          if (error instanceof HttpException) {
            const response = error.getResponse();
            if (typeof response === "object" && response) {
              const payload = response as Record<string, unknown>;
              if (typeof payload.code === "string") {
                code = payload.code;
              }
              if (typeof payload.detail === "string" && payload.detail.trim()) {
                detail = payload.detail;
              } else if (
                typeof payload.message === "string" &&
                payload.message.trim()
              ) {
                detail = payload.message;
              }
            } else if (typeof response === "string" && response.trim()) {
              detail = response;
            }
          }
          subscriber.next({
            type: DASHBOARD_STREAM_EVENT_TYPES.streamError,
            data: {
              code,
              message: "Dashboard stream update failed",
              detail,
            },
          });
        } finally {
          inflight = false;
        }
      };

      void publish(true);

      const intervalId = setInterval(() => {
        void publish(false);
      }, intervalMs);

      const pingId = setInterval(() => {
        subscriber.next({
          type: DASHBOARD_STREAM_EVENT_TYPES.ping,
          data: { ts: new Date().toISOString() },
        });
      }, pingMs);

      return () => {
        closed = true;
        clearInterval(intervalId);
        clearInterval(pingId);
      };
    });
  }
}
