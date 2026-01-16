import { AlertEventStatus, AlertMetricProvider } from "@prisma/client";

import { EntityAssociationMetricProvider } from "./entity-association-metric.provider";

describe("EntityAssociationMetricProvider.fetch", () => {
  const buildProvider = (overrides?: {
    sourceEvent?: any;
    seed?: any;
    edges?: any[];
    neighbors?: any[];
  }) => {
    const prisma = {
      alertEvent: {
        findFirst: jest.fn().mockResolvedValue(overrides?.sourceEvent ?? null)
      },
      knowledgeEdge: {
        findMany: jest.fn().mockResolvedValue(overrides?.edges ?? [])
      },
      knowledgeEntity: {
        findMany: jest.fn().mockResolvedValue(overrides?.neighbors ?? [])
      }
    } as any;

    const kg = {
      resolveEntity: jest.fn().mockResolvedValue(overrides?.seed ?? null)
    } as any;

    const provider = new EntityAssociationMetricProvider(prisma, kg);
    return { provider, prisma, kg };
  };

  it("returns null when no source event exists in window", async () => {
    const { provider } = buildProvider();
    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.entity_association,
      metricSlug: "Seed",
      operator: "gte" as any,
      changeWindowMin: null,
      metadata: { sourceWindowMinutes: 60 }
    });
    expect(result.latest).toBeNull();
  });

  it("computes impact score from source event and top association edge", async () => {
    const { provider, prisma, kg } = buildProvider({
      sourceEvent: {
        id: "event-1",
        ruleId: "rule-sent-1",
        triggeredAt: new Date("2026-01-16T12:00:00.000Z"),
        metricValue: 3,
        status: AlertEventStatus.delivered,
        rule: {
          orgId: "org-1",
          metricProvider: AlertMetricProvider.entity_sentiment,
          metricSlug: "Seed"
        }
      },
      seed: { id: "seed-1", canonicalName: "Seed", type: "policy" },
      edges: [
        { fromEntityId: "seed-1", toEntityId: "n1", confidence: 0.9, weight: 0.5, type: "affects_company", updatedAt: new Date() },
        { fromEntityId: "seed-1", toEntityId: "n2", confidence: 0.6, weight: 1.0, type: "affects_industry", updatedAt: new Date() }
      ],
      neighbors: [
        { id: "n1", canonicalName: "Target A", type: "company" },
        { id: "n2", canonicalName: "Target B", type: "industry" }
      ]
    });

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.entity_association,
      metricSlug: "Seed",
      operator: "gte" as any,
      changeWindowMin: null,
      metadata: { sourceWindowMinutes: 180, minAssociationWeight: 0.1, maxTargets: 10 }
    });

    expect(prisma.alertEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [AlertEventStatus.pending, AlertEventStatus.delivered, AlertEventStatus.confirmed] }
        })
      })
    );
    expect(kg.resolveEntity).toHaveBeenCalledWith("org-1", "Seed");
    expect(result.latest).toBeCloseTo(1.8);

    const context = result.context as any;
    expect(context.sourceEvent.id).toBe("event-1");
    expect(context.targets[0].name).toBe("Target B");
  });
});

