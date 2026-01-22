import { ProcessedItemModel } from "@modular/mongo";
import { Injectable, Logger } from "@nestjs/common";
import type { PipelineStage } from "mongoose";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { EntityImpactGraphSettingsService } from "../system-settings/entity-impact-graph-settings.service";

const DEFAULT_ENTITY_IMPACT_GRAPH_CATEGORIES = ["person", "organization", "stock", "commodity"] as const;
const MAX_CORRELATION_ENTITIES = 50;
const MAX_CORRELATION_INSTRUMENTS = 50;
const MIN_CORRELATION_DATA_POINTS = 5;

/**
 * Entity node in the impact graph
 */
interface EntityNode {
  id: string;
  name: string;
  category: "person" | "organization" | "stock" | "commodity";
  value: number;
  symbolSize: number;
}

/**
 * Link between entities in the impact graph
 */
interface EntityLink {
  source: string;
  target: string;
  value: number;
  linkType: "co-occurrence" | "correlation";
}

/**
 * Complete graph data structure for ECharts
 */
interface EntityImpactGraphData {
  nodes: EntityNode[];
  links: EntityLink[];
  categories: { name: string }[];
}

/**
 * Co-occurrence record for entity pairs
 */
interface CoOccurrenceRecord {
  entityA: string;
  entityB: string;
  typeA: string;
  typeB: string;
  count: number;
  articleIds: string[];
}

/**
 * Correlation result between entity and financial instrument
 */
interface CorrelationResult {
  entity: string;
  entityType: string;
  instrument: string;
  instrumentType: "stock" | "commodity";
  correlation: number;
  pValue: number;
}

/**
 * Input parameters for graph generation
 */
interface GetEntityImpactGraphInput {
  orgId: string;
  startDate: Date;
  endDate: Date;
  minEntityConfidence?: number;
  minCoOccurrence?: number;
  minCorrelation?: number;
  maxNodes?: number;
  categories?: string[];
}

@Injectable()
export class EntityImpactGraphService {
  private readonly logger = new Logger(EntityImpactGraphService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly entityImpactGraphSettings: EntityImpactGraphSettingsService
  ) {}

  /**
   * Main entry point: Generate entity impact graph data
   * Combines co-occurrence and correlation analysis
   */
  async getEntityImpactGraph(input: GetEntityImpactGraphInput): Promise<EntityImpactGraphData> {
    const { orgId, startDate, endDate } = input;

    let settings: Awaited<ReturnType<EntityImpactGraphSettingsService["getSettings"]>> | null = null;
    try {
      settings = await this.entityImpactGraphSettings.getSettings(orgId);
    } catch (error) {
      this.logger.warn(
        `Failed to load entity impact graph settings for org ${orgId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const minEntityConfidence = input.minEntityConfidence ?? settings?.minEntityConfidence ?? 0.5;
    const minCoOccurrence = input.minCoOccurrence ?? settings?.minCoOccurrence ?? 2;
    const minCorrelation = input.minCorrelation ?? settings?.minCorrelation ?? 0.3;
    const maxNodes = input.maxNodes ?? settings?.maxNodes ?? 100;
    const categories = this.normalizeCategories(
      input.categories ?? settings?.categories ?? [...DEFAULT_ENTITY_IMPACT_GRAPH_CATEGORIES]
    );
    const cacheTtlSeconds = settings?.cacheTtlSeconds ?? 0;

    const loader = async () => {
      const totalStart = Date.now();

      const coStart = Date.now();
      const coOccurrences = await this.calculateCoOccurrence(
        orgId,
        startDate,
        endDate,
        minCoOccurrence,
        minEntityConfidence
      );
      const coMs = Date.now() - coStart;

      const correlationStart = Date.now();
      const correlations = await this.calculateCorrelation(
        orgId,
        startDate,
        endDate,
        minCorrelation,
        minEntityConfidence
      );
      const correlationMs = Date.now() - correlationStart;

      const buildStart = Date.now();
      const graphData = this.buildGraphData(coOccurrences, correlations, categories, maxNodes);
      const buildMs = Date.now() - buildStart;

      const totalMs = Date.now() - totalStart;

      this.logger.log(
        `EntityImpactGraph timings org=${orgId} coOccurrenceMs=${coMs} correlationMs=${correlationMs} buildGraphMs=${buildMs} totalMs=${totalMs} nodes=${graphData.nodes.length} links=${graphData.links.length}`
      );

      return graphData;
    };

    if (cacheTtlSeconds <= 0) {
      return loader();
    }

    const cacheKey = this.buildCacheKey({
      orgId,
      startDate,
      endDate,
      minEntityConfidence,
      minCorrelation,
      minCoOccurrence,
      maxNodes,
      categories
    });

    const lockTtlMs = Math.min(300_000, Math.max(30_000, cacheTtlSeconds * 1000));

    try {
      return await this.cache.wrap(cacheKey, cacheTtlSeconds, loader, {
        lockTtlMs,
        maxWaitMs: lockTtlMs,
        retryDelayMs: 200
      });
    } catch (error) {
      this.logger.warn(
        `Failed to load or store entity impact graph cache for org ${orgId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return loader();
    }
  }

  /**
   * Calculate co-occurrence frequency between entities
   * Entities that appear together in the same news article are considered co-occurring
   */
  async calculateCoOccurrence(
    orgId: string,
    startDate: Date,
    endDate: Date,
    minCount: number,
    minEntityConfidence: number
  ): Promise<CoOccurrenceRecord[]> {
    const pipeline = [
      {
        $match: {
          orgId,
          status: "completed",
          createdAt: { $gte: startDate, $lte: endDate },
          "result.entities": { $exists: true, $ne: [] }
        }
      },
      {
        $project: {
          itemId: { $toString: "$_id" },
          entities: {
            $filter: {
              input: "$result.entities",
              as: "e",
              cond: {
                $and: [
                  { $ne: ["$$e.name", null] },
                  { $ne: ["$$e.name", ""] },
                  {
                    $gte: [
                      {
                        $ifNull: ["$$e.confidence", 0]
                      },
                      minEntityConfidence
                    ]
                  }
                ]
              }
            }
          }
        }
      },
      {
        $match: {
          $expr: { $gte: [{ $size: "$entities" }, 2] }
        }
      },
      {
        $project: {
          itemId: 1,
          entities: 1,
          entities2: "$entities"
        }
      },
      { $unwind: { path: "$entities", includeArrayIndex: "i" } },
      { $unwind: { path: "$entities2", includeArrayIndex: "j" } },
      { $match: { $expr: { $lt: ["$i", "$j"] } } },
      { $project: { itemId: 1, a: "$entities", b: "$entities2" } },
      {
        $project: {
          itemId: 1,
          first: { $cond: [{ $lt: ["$a.name", "$b.name"] }, "$a", "$b"] },
          second: { $cond: [{ $lt: ["$a.name", "$b.name"] }, "$b", "$a"] }
        }
      },
      {
        $group: {
          _id: { entityA: "$first.name", entityB: "$second.name" },
          typeA: { $first: "$first.type" },
          typeB: { $first: "$second.type" },
          count: { $sum: 1 },
          articleIds: { $addToSet: "$itemId" }
        }
      },
      { $match: { count: { $gte: minCount } } },
      {
        $project: {
          _id: 0,
          entityA: "$_id.entityA",
          entityB: "$_id.entityB",
          typeA: 1,
          typeB: 1,
          count: 1,
          articleIds: 1
        }
      },
      { $sort: { count: -1 } }
    ] as PipelineStage[];

    const results = await ProcessedItemModel.aggregate(pipeline).allowDiskUse(true);
    return results as CoOccurrenceRecord[];
  }

  /**
   * Calculate correlation between news entities and financial instruments
   * Uses time-series correlation analysis
   */
  async calculateCorrelation(
    orgId: string,
    startDate: Date,
    endDate: Date,
    minCorrelation: number,
    minEntityConfidence: number
  ): Promise<CorrelationResult[]> {
    const results: CorrelationResult[] = [];

    // Step 1: Get entity mention frequency by date
    const entityTimeSeries = await this.getEntityMentionTimeSeries(
      orgId,
      startDate,
      endDate,
      minEntityConfidence
    );

    if (entityTimeSeries.size === 0) {
      this.logger.debug("No entity time series data found");
      return results;
    }

    // Step 2: Get financial data time series
    const financialTimeSeries = await this.getFinancialTimeSeries(startDate, endDate);

    if (financialTimeSeries.size === 0) {
      this.logger.debug("No financial time series data found");
      return results;
    }

    const entityEntries = Array.from(entityTimeSeries.entries())
      .map(([entityKey, entityData]) => ({
        entityKey,
        entityData,
        totalMentions: Array.from(entityData.values()).reduce((acc, value) => acc + value, 0)
      }))
      .sort((a, b) => b.totalMentions - a.totalMentions)
      .slice(0, MAX_CORRELATION_ENTITIES);

    const instrumentEntries = Array.from(financialTimeSeries.entries())
      .map(([instrumentKey, instrumentData]) => ({
        instrumentKey,
        instrumentData,
        points: instrumentData.size
      }))
      .sort((a, b) => b.points - a.points)
      .slice(0, MAX_CORRELATION_INSTRUMENTS);

    this.logger.debug(
      `Correlation workload: entities=${entityEntries.length}/${entityTimeSeries.size}, instruments=${instrumentEntries.length}/${financialTimeSeries.size}`
    );

    // Step 3: Calculate Pearson correlation for each entity-instrument pair
    for (const { entityKey, entityData } of entityEntries) {
      const [entityName, entityType] = entityKey.split("::");
      if (!entityName || !entityType) {
        continue;
      }

      for (const { instrumentKey, instrumentData } of instrumentEntries) {
        const [instrumentName, instrumentType] = instrumentKey.split("::");
        if (!instrumentName || !instrumentType) {
          continue;
        }

        // Align time series by date
        const { alignedX, alignedY } = this.alignTimeSeries(entityData, instrumentData);

        if (alignedX.length < MIN_CORRELATION_DATA_POINTS) continue; // Need minimum data points

        // Calculate Pearson correlation
        const { correlation, pValue } = this.pearsonCorrelation(alignedX, alignedY);

        if (Math.abs(correlation) >= minCorrelation && pValue < 0.05) {
          results.push({
            entity: entityName,
            entityType,
            instrument: instrumentName,
            instrumentType: instrumentType as "stock" | "commodity",
            correlation,
            pValue
          });
        }
      }
    }

    return results;
  }

  /**
   * Build ECharts-compatible graph data from co-occurrence and correlation results
   */
  buildGraphData(
    coOccurrences: CoOccurrenceRecord[],
    correlations: CorrelationResult[],
    allowedCategories: string[],
    maxNodes: number
  ): EntityImpactGraphData {
    const nodeMap = new Map<string, EntityNode>();
    const links: EntityLink[] = [];

    // Category definitions for ECharts
    const categories = [
      { name: "person" },
      { name: "organization" },
      { name: "stock" },
      { name: "commodity" }
    ].filter((cat) => allowedCategories.includes(cat.name));

    // Helper to normalize entity type to category
    const normalizeCategory = (type: string): "person" | "organization" | "stock" | "commodity" => {
      const lower = type.toLowerCase();
      if (lower.includes("person") || lower.includes("people")) return "person";
      if (lower.includes("org") || lower.includes("company") || lower.includes("institution"))
        return "organization";
      if (lower.includes("stock") || lower.includes("equity")) return "stock";
      if (lower.includes("commodity") || lower.includes("gold") || lower.includes("oil"))
        return "commodity";
      return "organization"; // Default fallback
    };

    // Helper to add or update node
    const addNode = (name: string, type: string, weight: number) => {
      const category = normalizeCategory(type);
      if (!allowedCategories.includes(category)) return;

      const existing = nodeMap.get(name);
      if (existing) {
        existing.value += weight;
        existing.symbolSize = Math.min(50, 10 + Math.sqrt(existing.value) * 3);
      } else {
        nodeMap.set(name, {
          id: name,
          name,
          category,
          value: weight,
          symbolSize: Math.min(50, 10 + Math.sqrt(weight) * 3)
        });
      }
    };

    // Process co-occurrence relationships
    for (const record of coOccurrences) {
      addNode(record.entityA, record.typeA, record.count);
      addNode(record.entityB, record.typeB, record.count);

      links.push({
        source: record.entityA,
        target: record.entityB,
        value: record.count,
        linkType: "co-occurrence"
      });
    }

    // Process correlation relationships
    for (const record of correlations) {
      addNode(record.entity, record.entityType, Math.abs(record.correlation) * 10);
      addNode(record.instrument, record.instrumentType, Math.abs(record.correlation) * 10);

      links.push({
        source: record.entity,
        target: record.instrument,
        value: Math.abs(record.correlation),
        linkType: "correlation"
      });
    }

    // Limit nodes if exceeding maxNodes
    let nodes = Array.from(nodeMap.values());
    if (nodes.length > maxNodes) {
      nodes = nodes.sort((a, b) => b.value - a.value).slice(0, maxNodes);
      const nodeIds = new Set(nodes.map((n) => n.id));

      // Filter links to only include nodes that are kept
      const filteredLinks = links.filter(
        (link) => nodeIds.has(link.source) && nodeIds.has(link.target)
      );

      return { nodes, links: filteredLinks, categories };
    }

    return { nodes, links, categories };
  }

  /**
   * Get entity mention frequency time series from processed items
   */
  private async getEntityMentionTimeSeries(
    orgId: string,
    startDate: Date,
    endDate: Date,
    minEntityConfidence: number
  ): Promise<Map<string, Map<string, number>>> {
    const timeSeries = new Map<string, Map<string, number>>();

    const pipeline = [
      {
        $match: {
          orgId,
          status: "completed",
          createdAt: { $gte: startDate, $lte: endDate },
          "result.entities": { $exists: true, $ne: [] }
        }
      },
      { $unwind: "$result.entities" },
      {
        $match: {
          $expr: {
            $and: [
              { $ne: ["$result.entities.name", null] },
              { $ne: ["$result.entities.name", ""] },
              {
                $gte: [
                  {
                    $ifNull: ["$result.entities.confidence", 0]
                  },
                  minEntityConfidence
                ]
              }
            ]
          }
        }
      },
      {
        $project: {
          dateKey: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
          },
          name: "$result.entities.name",
          type: "$result.entities.type"
        }
      },
      {
        $group: {
          _id: { name: "$name", type: "$type", dateKey: "$dateKey" },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: { name: "$_id.name", type: "$_id.type" },
          totalMentions: { $sum: "$count" },
          series: { $push: { dateKey: "$_id.dateKey", count: "$count" } }
        }
      },
      { $sort: { totalMentions: -1 } },
      { $limit: MAX_CORRELATION_ENTITIES },
      {
        $project: {
          _id: 0,
          name: "$_id.name",
          type: "$_id.type",
          series: 1
        }
      }
    ] as PipelineStage[];

    const aggregated = await ProcessedItemModel.aggregate(pipeline).allowDiskUse(true);
    for (const row of aggregated as { name: string; type: string; series: { dateKey: string; count: number }[] }[]) {
      const entityKey = `${row.name}::${row.type}`;
      const entitySeries = new Map<string, number>();
      for (const point of row.series ?? []) {
        entitySeries.set(point.dateKey, point.count);
      }
      timeSeries.set(entityKey, entitySeries);
    }

    return timeSeries;
  }

  /**
   * Get financial instrument time series from economic data
   */
  private async getFinancialTimeSeries(
    startDate: Date,
    endDate: Date
  ): Promise<Map<string, Map<string, number>>> {
    const timeSeries = new Map<string, Map<string, number>>();

    // Query economic data points for stocks and commodities
    const dataPoints = await this.prisma.economicDataPoint.findMany({
      where: {
        recordedAt: { gte: startDate, lte: endDate },
        item: {
          categories: {
            some: {
              category: {
                key: { in: ["stock-index", "commodity", "forex", "precious-metals"] }
              }
            }
          }
        }
      },
      include: {
        item: {
          include: {
            categories: {
              include: { category: true }
            }
          }
        }
      },
      orderBy: { recordedAt: "asc" }
    });

    for (const point of dataPoints) {
      const dateKey = point.recordedAt.toISOString().split("T")[0] ?? point.recordedAt.toISOString();
      const categoryKey = point.item.categories[0]?.category?.key ?? "unknown";
      const instrumentType = categoryKey.includes("stock") ? "stock" : "commodity";
      const instrumentKey = `${point.item.displayName}::${instrumentType}`;

      let instrumentSeries = timeSeries.get(instrumentKey);
      if (!instrumentSeries) {
        instrumentSeries = new Map<string, number>();
        timeSeries.set(instrumentKey, instrumentSeries);
      }

      instrumentSeries.set(dateKey, Number(point.value));
    }

    return timeSeries;
  }

  /**
   * Align two time series by date
   */
  private alignTimeSeries(
    seriesA: Map<string, number>,
    seriesB: Map<string, number>
  ): { alignedX: number[]; alignedY: number[] } {
    const alignedX: number[] = [];
    const alignedY: number[] = [];

    for (const [date, valueA] of seriesA) {
      const valueB = seriesB.get(date);
      if (valueB !== undefined) {
        alignedX.push(valueA);
        alignedY.push(valueB);
      }
    }

    return { alignedX, alignedY };
  }

  /**
   * Calculate Pearson correlation coefficient and p-value
   */
  private pearsonCorrelation(x: number[], y: number[]): { correlation: number; pValue: number } {
    const n = x.length;
    if (n < 2) return { correlation: 0, pValue: 1 };

    // Calculate means
    const meanX = x.reduce((sum, val) => sum + val, 0) / n;
    const meanY = y.reduce((sum, val) => sum + val, 0) / n;

    // Calculate correlation components
    let sumXY = 0;
    let sumX2 = 0;
    let sumY2 = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i]! - meanX;
      const dy = y[i]! - meanY;
      sumXY += dx * dy;
      sumX2 += dx * dx;
      sumY2 += dy * dy;
    }

    // Avoid division by zero
    if (sumX2 === 0 || sumY2 === 0) return { correlation: 0, pValue: 1 };

    const correlation = sumXY / Math.sqrt(sumX2 * sumY2);

    // Calculate t-statistic for p-value approximation
    const t = correlation * Math.sqrt((n - 2) / (1 - correlation * correlation));
    // Approximate p-value using t-distribution (simplified)
    const pValue = this.approximatePValue(Math.abs(t), n - 2);

    return { correlation, pValue };
  }

  /**
   * Approximate p-value from t-statistic (simplified calculation)
   */
  private approximatePValue(t: number, df: number): number {
    // Simplified approximation using normal distribution for large df
    if (df > 30) {
      // Use standard normal approximation
      const z = t;
      return 2 * (1 - this.normalCDF(z));
    }

    // For smaller df, use a rough approximation
    // This is a simplified version - production code should use proper t-distribution
    const x = df / (df + t * t);
    return x;
  }

  /**
   * Standard normal cumulative distribution function (approximation)
   */
  private normalCDF(x: number): number {
    // Approximation using error function
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  private normalizeCategories(input: string[]): string[] {
    const allowed = new Set<string>(DEFAULT_ENTITY_IMPACT_GRAPH_CATEGORIES);
    const normalized = (input ?? [])
      .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
      .filter((entry) => allowed.has(entry));

    const categories = normalized.length > 0 ? Array.from(new Set(normalized)) : [...DEFAULT_ENTITY_IMPACT_GRAPH_CATEGORIES];
    categories.sort();
    return categories;
  }

  private buildCacheKey(input: {
    orgId: string;
    startDate: Date;
    endDate: Date;
    minEntityConfidence: number;
    minCorrelation: number;
    minCoOccurrence: number;
    maxNodes: number;
    categories: string[];
  }) {
    const startIso = input.startDate.toISOString();
    const endIso = input.endDate.toISOString();
    const confidence = input.minEntityConfidence.toFixed(3);
    const correlation = input.minCorrelation.toFixed(3);
    const coOccurrence = Math.round(input.minCoOccurrence);
    const maxNodes = Math.round(input.maxNodes);
    const categories = this.normalizeCategories(input.categories).join(",");

    return `entityImpactGraph:data:${input.orgId}:${startIso}:${endIso}:conf=${confidence}:corr=${correlation}:co=${coOccurrence}:max=${maxNodes}:cats=${categories}`;
  }
}
