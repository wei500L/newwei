import type {
  WarMapEventsResponse,
  WarMapNewsMarkersResponse,
  WarMapTransportDetailResponse,
} from '@modular/utils';
import { BadRequestException, Injectable } from '@nestjs/common';

import {
  DAY_MS,
  DEFAULT_RANGE_DAYS,
  alignUtcDayEnd,
  alignUtcDayStart,
  type DateRange,
  type FinancialCandlestickResponse,
  type ResolveRangeOptions,
  type SectorHeatmapResponse,
  type SpacetimeGeoHeatmapArticlesResponse,
  type SpacetimeGeoHeatmapResponse,
  type SpacetimePropagationArticlesResponse,
  type SpacetimePropagationResponse,
  type WarMapEventsOptions,
  type WarMapGeoJsonResponse,
  type WarMapLayersOptions,
  type WarMapNewsMarkersOptions,
  type WarMapTransportDetailOptions,
} from './dashboard-charts.helpers';
import { DashboardSectorChartsService } from './dashboard-sector-charts.service';
import { DashboardSpacetimeService } from './dashboard-spacetime.service';
import { DashboardWarMapService } from './dashboard-war-map.service';
import type { DashboardTimeRangeQueryDto } from './dto/dashboard-charts.dto';
import type { WarMapLayersResponse as WarMapStaticLayersResponse } from './war-map-layers';

export {
  type FinancialCandlestickResponse,
  type SectorHeatmapResponse,
  type SectorHeatmapWarning,
  type SpacetimeGeoHeatmapArticle,
  type SpacetimeGeoHeatmapArticlesResponse,
  type SpacetimeGeoHeatmapResponse,
  type SpacetimeGeoHeatPoint,
  type SpacetimeGeoHeatPointBucket,
  type SpacetimePropagationArticle,
  type SpacetimePropagationArticlesResponse,
  type SpacetimePropagationEdge,
  type SpacetimePropagationEdgeKind,
  type SpacetimePropagationNode,
  type SpacetimePropagationResponse,
  type SpacetimeSentimentLabel,
  type WarMapGeoJsonResponse,
  type WarMapLayersResponse,
} from './dashboard-charts.helpers';

@Injectable()
export class DashboardChartsService {
  constructor(
    private readonly warMap: DashboardWarMapService,
    private readonly spacetime: DashboardSpacetimeService,
    private readonly sectorCharts: DashboardSectorChartsService,
  ) {}

  resolveRange(query: DashboardTimeRangeQueryDto, options: ResolveRangeOptions = {}): DateRange {
    const end = query.end ? new Date(query.end) : new Date();
    const start = query.start
      ? new Date(query.start)
      : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    const alignToUtcDay = options.alignToUtcDay ?? true;

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date range');
    }
    const resolvedStart = alignToUtcDay ? alignUtcDayStart(start) : new Date(start);
    const resolvedEnd = alignToUtcDay ? alignUtcDayEnd(end) : new Date(end);

    if (resolvedStart > resolvedEnd) {
      throw new BadRequestException('Start must be before end');
    }

    return { start: resolvedStart, end: resolvedEnd };
  }

  getWarMapGeoJson(): WarMapGeoJsonResponse {
    return this.warMap.getWarMapGeoJson();
  }

  async getWarMapTransportDetail(
    options: WarMapTransportDetailOptions,
  ): Promise<WarMapTransportDetailResponse> {
    return this.warMap.getWarMapTransportDetail(options);
  }

  async getWarMapLayers(options: WarMapLayersOptions = {}): Promise<WarMapStaticLayersResponse> {
    return this.warMap.getWarMapLayers(options);
  }

  async getWarMapEvents(
    range: DateRange,
    orgId: string,
    options: WarMapEventsOptions = {},
  ): Promise<WarMapEventsResponse> {
    return this.warMap.getWarMapEvents(range, orgId, options);
  }

  async getWarMapNewsMarkers(
    range: DateRange,
    orgId: string,
    options: WarMapNewsMarkersOptions = {},
  ): Promise<WarMapNewsMarkersResponse> {
    return this.warMap.getWarMapNewsMarkers(range, orgId, options);
  }

  async getSpacetimeGeoHeatmap(
    range: DateRange,
    orgId: string,
    options: { eventId?: string; includeBuckets?: boolean } = {},
  ): Promise<SpacetimeGeoHeatmapResponse> {
    return this.spacetime.getSpacetimeGeoHeatmap(range, orgId, options);
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
    return this.spacetime.getSpacetimeGeoHeatmapArticles(range, orgId, options);
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
    return this.spacetime.getSpacetimePropagation(range, orgId, options);
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
    return this.spacetime.getSpacetimePropagationArticles(range, orgId, options);
  }

  async getSectorHeatmap(range: DateRange): Promise<SectorHeatmapResponse> {
    return this.sectorCharts.getSectorHeatmap(range);
  }

  async getFinancialCandlestick(range: DateRange): Promise<FinancialCandlestickResponse> {
    return this.sectorCharts.getFinancialCandlestick(range);
  }
}
