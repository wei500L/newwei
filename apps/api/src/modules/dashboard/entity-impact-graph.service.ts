import { ProcessedItemModel } from "@modular/mongo";
import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../config/prisma.service";

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
  categories: Array<{ name: string }>;
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
  minCoOccurrence?: number;
  minCorrelation?: number;
  maxNodes?: number;
  categories?: string[];
}

@Injectable()
export class EntityImpactGraphService {
  private readonly logger = new Logger(EntityImpactGraphService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Main entry point: Generate entity impact graph data
   * Combines co-occurrence and correlation analysis
   */
  async getEntityImpactGraph(input: GetEntityImpactGraphInput): Promise<EntityImpactGraphData> {
    const {
      orgId,
      startDate,
      endDate,
      minCoOccurrence = 2,
      minCorrelation = 0.3,
      maxNodes = 100,
      categories = ["person", "organization", "stock", "commodity"]
    } = input;

    this.logger.log(`Generating entity impact graph for org ${orgId} from ${startDate} to ${endDate}`);

    // Step 1: Calculate co-occurrence relationships from news entities
    const coOccurrences = await this.calculateCoOccurrence(orgId, startDate, endDate, minCoOccurrence);

    // Step 2: Calculate correlation with financial instruments
    const correlations = await this.calculateCorrelation(orgId, startDate, endDate, minCorrelation);

    // Step 3: Build graph data structure
    const graphData = this.buildGraphData(coOccurrences, correlations, categories, maxNodes);

    this.logger.log(`Generated graph with ${graphData.nodes.length} nodes and ${graphData.links.length} links`);

    return graphData;
  }

  /**
   * Calculate co-occurrence frequency between entities
   * Entities that appear together in the same news article are considered co-occurring
   */
  async calculateCoOccurrence(
    orgId: string,
    startDate: Date,
    endDate: Date,
    minCount: number
  ): Promise<CoOccurrenceRecord[]> {
    // Query processed items with entities in the date range
    const items = await ProcessedItemModel.find({
      orgId,
      status: "completed",
      createdAt: { $gte: startDate, $lte: endDate },
      "result.entities": { $exists: true, $ne: [] }
    })
      .select("_id result.entities")
      .lean();

    // Build co-occurrence map
    const coOccurrenceMap = new Map<string, CoOccurrenceRecord>();

    for (const item of items) {
      const entities = item.result?.entities ?? [];
      if (entities.length < 2) continue;

      // Generate all pairs of entities within the same article
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const entityA = entities[i];
          const entityB = entities[j];

          // Skip if either entity has low confidence
          if ((entityA.confidence ?? 0) < 0.5 || (entityB.confidence ?? 0) < 0.5) continue;

          // Create consistent key (alphabetically sorted)
          const [first, second] =
            entityA.name < entityB.name ? [entityA, entityB] : [entityB, entityA];
          const key = `${first.name}::${second.name}`;

          const existing = coOccurrenceMap.get(key);
          const itemId = item._id?.toString() ?? "";

          if (existing) {
            existing.count++;
            if (!existing.articleIds.includes(itemId)) {
              existing.articleIds.push(itemId);
            }
          } else {
            coOccurrenceMap.set(key, {
              entityA: first.name,
              entityB: second.name,
              typeA: first.type,
              typeB: second.type,
              count: 1,
              articleIds: [itemId]
            });
          }
        }
      }
    }

    // Filter by minimum count and return
    return Array.from(coOccurrenceMap.values()).filter((record) => record.count >= minCount);
  }

  /**
   * Calculate correlation between news entities and financial instruments
   * Uses time-series correlation analysis
   */
  async calculateCorrelation(
    orgId: string,
    startDate: Date,
    endDate: Date,
    minCorrelation: number
  ): Promise<CorrelationResult[]> {
    const results: CorrelationResult[] = [];

    // Step 1: Get entity mention frequency by date
    const entityTimeSeries = await this.getEntityMentionTimeSeries(orgId, startDate, endDate);

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

    // Step 3: Calculate Pearson correlation for each entity-instrument pair
    for (const [entityKey, entityData] of entityTimeSeries) {
      const [entityName, entityType] = entityKey.split("::");

      for (const [instrumentKey, instrumentData] of financialTimeSeries) {
        const [instrumentName, instrumentType] = instrumentKey.split("::");

        // Align time series by date
        const { alignedX, alignedY } = this.alignTimeSeries(entityData, instrumentData);

        if (alignedX.length < 5) continue; // Need minimum data points

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

    const categoryIndex = new Map(categories.map((cat, idx) => [cat.name, idx]));

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
    endDate: Date
  ): Promise<Map<string, Map<string, number>>> {
    const timeSeries = new Map<string, Map<string, number>>();

    const items = await ProcessedItemModel.find({
      orgId,
      status: "completed",
      createdAt: { $gte: startDate, $lte: endDate },
      "result.entities": { $exists: true, $ne: [] }
    })
      .select("createdAt result.entities")
      .lean();

    for (const item of items) {
      const dateKey = item.createdAt
        ? new Date(item.createdAt).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];
      const entities = item.result?.entities ?? [];

      for (const entity of entities) {
        if ((entity.confidence ?? 0) < 0.5) continue;

        const entityKey = `${entity.name}::${entity.type}`;
        let entitySeries = timeSeries.get(entityKey);

        if (!entitySeries) {
          entitySeries = new Map<string, number>();
          timeSeries.set(entityKey, entitySeries);
        }

        entitySeries.set(dateKey, (entitySeries.get(dateKey) ?? 0) + 1);
      }
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
      const dateKey = point.recordedAt.toISOString().split("T")[0];
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
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
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
}
