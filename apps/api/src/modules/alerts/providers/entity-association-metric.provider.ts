
import { Injectable } from "@nestjs/common";
import { AlertEventStatus, AlertMetricProvider, type AlertRule } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";
import { KnowledgeGraphService } from "../../knowledge-graph/knowledge-graph.service";

import type { MetricEvaluation, MetricProvider } from "./metric-provider";

function clampInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return min;
  }
  const normalized = Math.trunc(value);
  return Math.min(Math.max(normalized, min), max);
}

function clampFloat(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function toMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

@Injectable()
export class EntityAssociationMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.entity_association;

  constructor(private readonly prisma: PrismaService, private readonly kg: KnowledgeGraphService) {}

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const metricSlug =
      typeof rule.metricSlug === "string" ? rule.metricSlug.trim() : "";
    if (!metricSlug) {
      return { latest: null, previous: null, changePercent: null, context: { error: "seed_missing" } };
    }
    const metadata = toMetadata(rule.metadata);
    const windowMinutes = clampInt(
      typeof metadata?.sourceWindowMinutes === "number" ? metadata.sourceWindowMinutes : 180,
      5,
      7 * 24 * 60
    );
    const minAssociationWeight = clampFloat(
      typeof metadata?.minAssociationWeight === "number" ? metadata.minAssociationWeight : 0.3,
      0,
      1
    );
    const maxTargets = clampInt(typeof metadata?.maxTargets === "number" ? metadata.maxTargets : 10, 1, 50);

    const sourceSince = new Date(Date.now() - windowMinutes * 60 * 1000);
    const sourceEvent = await this.prisma.alertEvent.findFirst({
      where: {
        triggeredAt: { gte: sourceSince },
        status: { in: [AlertEventStatus.pending, AlertEventStatus.delivered, AlertEventStatus.confirmed] },
        rule: {
          orgId: rule.orgId,
          metricProvider: AlertMetricProvider.entity_sentiment,
          metricSlug
        }
      },
      include: { rule: true },
      orderBy: { triggeredAt: "desc" }
    });

    if (!sourceEvent) {
      return { latest: null, previous: null, changePercent: null, context: { source: "none" } };
    }

    const seedName = metricSlug;

    const seed = await this.kg.resolveEntity(rule.orgId, seedName);
    if (!seed) {
      return { latest: null, previous: null, changePercent: null, context: { error: "seed_not_found", seedName } };
    }

    const edges = await this.prisma.knowledgeEdge.findMany({
      where: {
        orgId: rule.orgId,
        OR: [{ fromEntityId: seed.id }, { toEntityId: seed.id }]
      },
      orderBy: [{ confidence: "desc" }, { weight: "desc" }, { updatedAt: "desc" }],
      take: Math.max(50, maxTargets * 10)
    });

    const neighborIds = new Set<string>();
    for (const edge of edges) {
      const otherId = edge.fromEntityId === seed.id ? edge.toEntityId : edge.fromEntityId;
      neighborIds.add(otherId);
    }

    const neighbors = await this.prisma.knowledgeEntity.findMany({
      where: { id: { in: Array.from(neighborIds) } }
    });
    const neighborsById = new Map(neighbors.map((node) => [node.id, node]));

    const targets: {
      entityId: string;
      name: string;
      type: string;
      confidence: number;
      weight: number;
      score: number;
      relationType: string;
    }[] = [];

    for (const edge of edges) {
      const otherId = edge.fromEntityId === seed.id ? edge.toEntityId : edge.fromEntityId;
      const other = neighborsById.get(otherId);
      if (!other) {
        continue;
      }
      const confidence = edge.confidence;
      const weight = edge.weight;
      const score = confidence * weight;
      if (!Number.isFinite(score) || score < minAssociationWeight) {
        continue;
      }
      targets.push({
        entityId: other.id,
        name: other.canonicalName,
        type: other.type,
        confidence,
        weight,
        score,
        relationType: edge.type
      });
    }

    targets.sort((a, b) => b.score - a.score);
    const topTargets = targets.slice(0, maxTargets);

    const sourceScore = Number(sourceEvent.metricValue);
    const maxEdgeScore = topTargets[0]?.score ?? 0;
    const impactScore = Math.max(0, Math.abs(sourceScore) * maxEdgeScore);

    return {
      latest: impactScore,
      previous: null,
      changePercent: null,
      context: {
        seed: { id: seed.id, name: seed.canonicalName, type: seed.type },
        sourceEvent: {
          id: sourceEvent.id,
          ruleId: sourceEvent.ruleId,
          triggeredAt: sourceEvent.triggeredAt.toISOString(),
          metricValue: sourceScore,
          status: sourceEvent.status
        },
        windowMinutes,
        minAssociationWeight,
        maxTargets,
        targets: topTargets
      }
    };
  }
}
