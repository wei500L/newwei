import { Injectable, InternalServerErrorException } from '@nestjs/common';

import { PrismaService } from '../config/prisma.service';

import {
  DEFAULT_CANDLESTICK_SLUG,
  DEFAULT_SECTOR_CATEGORY,
  HEATMAP_COLUMNS,
  MAX_SECTOR_CELLS,
  OHLC_FIELD_ALIASES,
  PREFERRED_SOURCE_FIELDS,
  type DateRange,
  type FinancialCandlestickPoint,
  type FinancialCandlestickResponse,
  type OhlcField,
  type SectorHeatmapCell,
  type SectorHeatmapResponse,
  type SectorHeatmapWarning,
  buildLabelToSourceFieldMap,
  getDataVizConfig,
  logger,
  resolveFallbackSourceField,
  resolvePreferredSourceField,
  uniqStrings,
  normalizeSourceFieldKey,
} from './dashboard-charts.helpers';

@Injectable()
export class DashboardSectorChartsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSectorHeatmap(range: DateRange): Promise<SectorHeatmapResponse> {
    const items = await this.prisma.economicDataItem.findMany({
      where: {
        isActive: true,
        categories: {
          some: {
            category: {
              key: DEFAULT_SECTOR_CATEGORY,
            },
          },
        },
      },
      select: {
        id: true,
        slug: true,
        displayName: true,
        defaultUnit: true,
        metadata: true,
      },
      orderBy: { displayName: 'asc' },
      take: MAX_SECTOR_CELLS,
    });

    const xLabels = Array.from(
      { length: HEATMAP_COLUMNS },
      (_, idx) => `Group ${String.fromCharCode(65 + idx)}`,
    );
    const yLabels = Array.from(
      { length: Math.max(1, Math.ceil(MAX_SECTOR_CELLS / HEATMAP_COLUMNS)) },
      (_, idx) => `Row ${idx + 1}`,
    );

    if (items.length === 0) {
      return { xLabels, yLabels, cells: [] };
    }

    const seriesGroups = await this.prisma.economicDataPoint.groupBy({
      by: ['itemId', 'sourceField'],
      where: {
        itemId: {
          in: items.map((item) => item.id),
        },
        recordedAt: {
          gte: range.start,
          lte: range.end,
        },
      },
      _count: { _all: true },
    });

    const availableFieldsByItemId = new Map<string, Set<string>>();
    for (const group of seriesGroups) {
      const itemId = group.itemId;
      const sourceField = group.sourceField;
      if (!itemId || !sourceField) {
        continue;
      }
      const existing = availableFieldsByItemId.get(itemId) ?? new Set<string>();
      existing.add(sourceField);
      availableFieldsByItemId.set(itemId, existing);
    }

    const cells: SectorHeatmapCell[] = [];
    let updatedAt: Date | undefined;
    const warnings: SectorHeatmapWarning[] = [];

    for (const item of items) {
      const fields = availableFieldsByItemId.get(item.id);
      if (!fields || fields.size === 0) {
        continue;
      }

      const config = getDataVizConfig(item.metadata);
      const preferredKeys =
        config.heatmap.preferredSourceFields && config.heatmap.preferredSourceFields.length > 0
          ? uniqStrings(config.heatmap.preferredSourceFields)
          : [...PREFERRED_SOURCE_FIELDS];
      const labelToField = buildLabelToSourceFieldMap(item.metadata);
      const availableSourceFields = Array.from(fields).sort((a, b) => a.localeCompare(b));
      const seriesByField = new Map<string, unknown[]>();
      availableSourceFields.forEach((field) => seriesByField.set(field, []));
      let fieldKey = resolvePreferredSourceField(seriesByField, preferredKeys, labelToField);
      let usedFallback = false;
      if (!fieldKey) {
        fieldKey = resolveFallbackSourceField(availableSourceFields, labelToField);
        usedFallback = Boolean(fieldKey);
      }
      if (!fieldKey) {
        continue;
      }
      if (usedFallback) {
        warnings.push({
          code: 'SOURCE_FIELD_FALLBACK',
          itemId: item.id,
          slug: item.slug,
          displayName: item.displayName,
          preferredSourceFields: preferredKeys,
          availableSourceFields,
          selectedSourceField: fieldKey,
        });
      }

      const pointWhere = {
        itemId: item.id,
        sourceField: fieldKey,
        recordedAt: {
          gte: range.start,
          lte: range.end,
        },
      };

      const [firstPoint, lastPoint] = await Promise.all([
        this.prisma.economicDataPoint.findFirst({
          where: pointWhere,
          select: {
            recordedAt: true,
            value: true,
            unit: true,
          },
          orderBy: { recordedAt: 'asc' },
        }),
        this.prisma.economicDataPoint.findFirst({
          where: pointWhere,
          select: {
            recordedAt: true,
            value: true,
            unit: true,
          },
          orderBy: { recordedAt: 'desc' },
        }),
      ]);

      if (!firstPoint || !lastPoint) {
        continue;
      }

      const firstValue = Number(firstPoint.value ?? 0);
      const lastValue = Number(lastPoint.value ?? 0);
      const unit = (lastPoint.unit as string | null | undefined) ?? item.defaultUnit ?? null;
      const change = firstValue === 0 ? 0 : ((lastValue - firstValue) / Math.abs(firstValue)) * 100;

      const index = cells.length;
      const x = index % HEATMAP_COLUMNS;
      const y = Math.floor(index / HEATMAP_COLUMNS);
      cells.push({
        x,
        y,
        name: item.displayName,
        value: Number(lastValue.toFixed(2)),
        change: Number(change.toFixed(2)),
        unit,
        sourceField: fieldKey,
      });

      if (lastPoint && (!updatedAt || lastPoint.recordedAt > updatedAt)) {
        updatedAt = lastPoint.recordedAt;
      }

      if (cells.length >= MAX_SECTOR_CELLS) {
        break;
      }
    }

    if (warnings.length > 0) {
      logger.warn(
        {
          warningCount: warnings.length,
          items: warnings.map((warning) => ({
            itemId: warning.itemId,
            slug: warning.slug,
            displayName: warning.displayName,
            selectedSourceField: warning.selectedSourceField,
          })),
        },
        'Sector heatmap fell back to non-preferred source fields',
      );
    }

    const rowCount = Math.max(1, Math.ceil(cells.length / HEATMAP_COLUMNS));
    return {
      xLabels,
      yLabels: yLabels.slice(0, rowCount),
      cells,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async getFinancialCandlestick(range: DateRange): Promise<FinancialCandlestickResponse> {
    const item = await this.prisma.economicDataItem.findUnique({
      where: { slug: DEFAULT_CANDLESTICK_SLUG },
      select: {
        id: true,
        displayName: true,
        defaultFrequency: true,
        defaultUnit: true,
        metadata: true,
      },
    });

    if (!item) {
      return {
        symbol: DEFAULT_CANDLESTICK_SLUG,
        interval: 'daily',
        points: [],
      };
    }

    const config = getDataVizConfig(item.metadata);
    const labelToField = buildLabelToSourceFieldMap(item.metadata);
    const ohlcAliases = (Object.keys(OHLC_FIELD_ALIASES) as OhlcField[]).reduce(
      (acc, field) => {
        const configured = config.candlestick.ohlc?.[field];
        const merged = configured && configured.length > 0 ? configured : OHLC_FIELD_ALIASES[field];
        const expanded: string[] = [];
        for (const alias of merged) {
          expanded.push(alias);
          const mapped = labelToField.get(alias);
          if (mapped) {
            expanded.push(mapped);
          }
        }
        acc[field] = uniqStrings(expanded);
        return acc;
      },
      {} as Record<OhlcField, string[]>,
    );

    const aliasToField = new Map<string, OhlcField>();
    const aliasRankByField = (Object.keys(OHLC_FIELD_ALIASES) as OhlcField[]).reduce(
      (acc, field) => {
        acc[field] = new Map<string, number>();
        return acc;
      },
      {} as Record<OhlcField, Map<string, number>>,
    );

    for (const field of Object.keys(ohlcAliases) as OhlcField[]) {
      ohlcAliases[field].forEach((alias, index) => {
        const normalized = normalizeSourceFieldKey(alias);
        if (!normalized) return;
        if (!aliasToField.has(normalized)) {
          aliasToField.set(normalized, field);
        }
        if (!aliasRankByField[field].has(normalized)) {
          aliasRankByField[field].set(normalized, index);
        }
      });
    }

    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        itemId: item.id,
        recordedAt: {
          gte: range.start,
          lte: range.end,
        },
        sourceField: {
          in: uniqStrings(Object.values(ohlcAliases).flat()),
        },
      },
      orderBy: { recordedAt: 'asc' },
    });

    if (points.length === 0) {
      const totalPoints = await this.prisma.economicDataPoint.count({
        where: {
          itemId: item.id,
          recordedAt: {
            gte: range.start,
            lte: range.end,
          },
        },
      });
      if (totalPoints > 0) {
        const available = await this.prisma.economicDataPoint.findMany({
          where: {
            itemId: item.id,
            recordedAt: {
              gte: range.start,
              lte: range.end,
            },
          },
          distinct: ['sourceField'],
          select: { sourceField: true },
          take: 50,
        });

        throw new InternalServerErrorException({
          code: 'DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH',
          message: 'Candlestick field mapping mismatch',
          detail:
            'No OHLC sourceField matched for this item in the requested range. Configure EconomicDataItem.metadata.dataViz.candlestick.ohlc.',
          item: {
            id: item.id,
            slug: DEFAULT_CANDLESTICK_SLUG,
            displayName: item.displayName,
          },
          expectedAliases: ohlcAliases,
          availableSourceFields: available
            .map((entry) => entry.sourceField)
            .sort((a, b) => a.localeCompare(b)),
        });
      }
    }

    const unit =
      (points.find((point) => point.unit)?.unit as string | null | undefined) ??
      item.defaultUnit ??
      null;
    const sourceFields: Partial<Record<keyof typeof OHLC_FIELD_ALIASES, string>> = {};
    const sourceFieldRanks: Partial<Record<keyof typeof OHLC_FIELD_ALIASES, number>> = {};
    const grouped = new Map<
      string,
      {
        timestamp: Date;
        open?: number;
        high?: number;
        low?: number;
        close?: number;
        ranks: Partial<Record<keyof typeof OHLC_FIELD_ALIASES, number>>;
      }
    >();

    for (const point of points) {
      const normalizedSourceField = normalizeSourceFieldKey(point.sourceField);
      const field = aliasToField.get(normalizedSourceField);
      if (!field) continue;
      const rank = aliasRankByField[field].get(normalizedSourceField) ?? Number.MAX_SAFE_INTEGER;

      const key = point.recordedAt.toISOString();
      const entry = grouped.get(key) ?? {
        timestamp: point.recordedAt,
        ranks: {},
      };
      const existingRank = entry.ranks[field];
      if (existingRank === undefined || rank < existingRank) {
        entry[field] = Number(point.value);
        entry.ranks[field] = rank;
      }
      grouped.set(key, entry);

      const globalRank = sourceFieldRanks[field];
      if (globalRank === undefined || rank < globalRank) {
        sourceFields[field] = point.sourceField;
        sourceFieldRanks[field] = rank;
      }
    }

    const sorted = Array.from(grouped.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const resultPoints: FinancialCandlestickPoint[] = [];
    let updatedAt: Date | undefined;
    const incompleteEntries: { timestamp: string; missing: string[] }[] = [];
    const latestObservedAt = sorted.at(-1)?.timestamp;
    for (const entry of sorted) {
      const missing: string[] = [];
      if (entry.open === undefined) missing.push('open');
      if (entry.high === undefined) missing.push('high');
      if (entry.low === undefined) missing.push('low');
      if (entry.close === undefined) missing.push('close');
      if (missing.length > 0) {
        incompleteEntries.push({
          timestamp: entry.timestamp.toISOString(),
          missing,
        });
        continue;
      }

      const open = entry.open!;
      const close = entry.close!;
      const high = entry.high!;
      const low = entry.low!;

      resultPoints.push({
        timestamp: entry.timestamp.toISOString(),
        open,
        close,
        high,
        low,
      });

      updatedAt = entry.timestamp;
    }

    if (incompleteEntries.length > 0) {
      logger.warn(
        {
          itemId: item.id,
          slug: DEFAULT_CANDLESTICK_SLUG,
          skippedCount: incompleteEntries.length,
          skippedEntries: incompleteEntries.slice(0, 10),
        },
        'Skipped incomplete candlestick OHLC entries',
      );
    }

    return {
      symbol: item.displayName,
      interval: item.defaultFrequency,
      points: resultPoints,
      unit,
      sourceFields:
        Object.keys(sourceFields).length > 0 ? (sourceFields as Record<string, string>) : undefined,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      latestObservedAt: latestObservedAt ? latestObservedAt.toISOString() : undefined,
      skippedIncompleteCount: incompleteEntries.length > 0 ? incompleteEntries.length : undefined,
    };
  }
}
