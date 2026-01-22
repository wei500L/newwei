import {
  Controller,
  Get,
  HttpException,
  InternalServerErrorException,
  MessageEvent,
  Query,
  Sse
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Observable } from "rxjs";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { DashboardChartsService } from "./dashboard-charts.service";
import { DashboardService } from "./dashboard.service";
import {
  DashboardSpacetimeGeoHeatmapArticlesQueryDto,
  DashboardSpacetimeGeoHeatmapQueryDto,
  DashboardSpacetimePropagationArticlesQueryDto,
  DashboardSpacetimePropagationQueryDto,
  DashboardTimeRangeQueryDto
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

@ApiTags("dashboard")
@ApiBearerAuth()
@Controller("dashboard")
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    private readonly chartsService: DashboardChartsService
  ) {}

  @Permissions("items.read")
  @Get("stats")
  async stats(@CurrentUser() user: AuthenticatedUser) {
    return this.service.stats(user.orgId);
  }

  @Permissions("dashboards.read")
  @Get("war-map/geojson")
  async warMapGeoJson(@Query() query: DashboardTimeRangeQueryDto) {
    this.chartsService.resolveRange(query);
    try {
      return this.chartsService.getWarMapGeoJson();
    } catch (error) {
      throw new InternalServerErrorException({
        code: "GEOJSON_LOAD_FAILED",
        message: "GeoJSON map could not be loaded",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  @Permissions("dashboards.read")
  @Get("war-map/layers")
  async warMapLayers() {
    return this.chartsService.getWarMapLayers();
  }

  @Permissions("dashboards.read")
  @Get("war-map/events")
  async warMapEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardTimeRangeQueryDto
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getWarMapEvents(range, user.orgId);
  }

  @Permissions("dashboards.read")
  @Get("war-map/news-markers")
  async warMapNewsMarkers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardTimeRangeQueryDto
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getWarMapNewsMarkers(range, user.orgId);
  }

  @Permissions("dashboards.read")
  @Get("spacetime/geo-heatmap")
  async spacetimeGeoHeatmap(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimeGeoHeatmapQueryDto
  ) {
    const range = this.chartsService.resolveRange(query);
    const includeBuckets = query.includeBuckets === "1" || query.includeBuckets === "true";
    return this.chartsService.getSpacetimeGeoHeatmap(range, user.orgId, {
      eventId: query.eventId,
      includeBuckets
    });
  }

  @Permissions("dashboards.read")
  @Get("spacetime/geo-heatmap/articles")
  async spacetimeGeoHeatmapArticles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimeGeoHeatmapArticlesQueryDto
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getSpacetimeGeoHeatmapArticles(range, user.orgId, {
      eventId: query.eventId,
      snapshotId: query.snapshotId,
      pointId: query.pointId,
      bucketStart: query.bucketStart,
      limit: query.limit
    });
  }

  @Permissions("dashboards.read")
  @Get("spacetime/propagation")
  async spacetimePropagation(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimePropagationQueryDto
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getSpacetimePropagation(range, user.orgId, {
      eventId: query.eventId,
      windowHours: query.windowHours,
      maxNodes: query.maxNodes,
      maxEdges: query.maxEdges
    });
  }

  @Permissions("dashboards.read")
  @Get("spacetime/propagation/articles")
  async spacetimePropagationArticles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardSpacetimePropagationArticlesQueryDto
  ) {
    const range = this.chartsService.resolveRange(query);
    return this.chartsService.getSpacetimePropagationArticles(range, user.orgId, {
      eventId: query.eventId,
      source: query.source,
      cursorStart: query.cursorStart,
      cursorEnd: query.cursorEnd,
      limit: query.limit
    });
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
    @Query() query: DashboardTimeRangeQueryDto
  ): Observable<MessageEvent> {
    const range = this.chartsService.resolveRange(query);
    const defaultIntervalMs = process.env.NODE_ENV === "development" ? 2_000 : 10_000;
    const intervalMs = clampInt(
      readEnvInt("DASHBOARD_STREAM_INTERVAL_MS", defaultIntervalMs),
      1_000,
      60_000
    );
    const pingMs = clampInt(readEnvInt("DASHBOARD_STREAM_PING_MS", 25_000), 5_000, 120_000);

    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let inflight = false;
      let lastWarFingerprint = "";
      let lastCandleFingerprint = "";
      let lastGeoHeatmapFingerprint = "";

      const publish = async (force = false) => {
        if (closed || inflight) return;
        inflight = true;
        try {
          const geoHeatmapPromise = this.chartsService
            .getSpacetimeGeoHeatmap(range, user.orgId)
            .catch(() => null);

          const [warEvents, candlestick] = await Promise.all([
            this.chartsService.getWarMapEvents(range, user.orgId),
            this.chartsService.getFinancialCandlestick(range)
          ]);
          const geoHeatmap = await geoHeatmapPromise;

          const warFingerprint = `${warEvents.updatedAt ?? "none"}:${warEvents.events.length}`;
          if (force || warFingerprint !== lastWarFingerprint) {
            subscriber.next({ type: "war-map-events", data: warEvents });
            lastWarFingerprint = warFingerprint;
          }

          const candleFingerprint = `${candlestick.updatedAt ?? "none"}:${candlestick.points.length}`;
          if (force || candleFingerprint !== lastCandleFingerprint) {
            subscriber.next({ type: "financial-candlestick", data: candlestick });
            lastCandleFingerprint = candleFingerprint;
          }

          if (geoHeatmap) {
            const geoHeatmapFingerprint = `${geoHeatmap.updatedAt ?? "none"}:${geoHeatmap.points.length}`;
            if (force || geoHeatmapFingerprint !== lastGeoHeatmapFingerprint) {
              subscriber.next({ type: "spacetime-geo-heatmap", data: geoHeatmap });
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
              } else if (typeof payload.message === "string" && payload.message.trim()) {
                detail = payload.message;
              }
            } else if (typeof response === "string" && response.trim()) {
              detail = response;
            }
          }
          subscriber.next({
            type: "stream-error",
            data: {
              code,
              message: "Dashboard stream update failed",
              detail
            }
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
        subscriber.next({ type: "ping", data: { ts: new Date().toISOString() } });
      }, pingMs);

      return () => {
        closed = true;
        clearInterval(intervalId);
        clearInterval(pingId);
      };
    });
  }

}
