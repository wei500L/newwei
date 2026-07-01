import { KnowledgeEntityType } from "@prisma/client";

import { KnowledgeGraphIntelligenceService } from "../knowledge-graph-intelligence.service";

const acme = {
  id: "entity-1",
  orgId: "org-1",
  canonicalName: "Acme Corp",
  normalizedKey: "acme corp",
  type: KnowledgeEntityType.company,
  properties: { ticker: "ACME" },
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const contoso = {
  ...acme,
  id: "entity-2",
  canonicalName: "Contoso",
  normalizedKey: "contoso",
  properties: null,
};

describe("KnowledgeGraphIntelligenceService", () => {
  const prisma = {
    knowledgeEntity: { findFirst: jest.fn() },
    knowledgeEntityAlias: { findMany: jest.fn() },
    knowledgeEdge: { count: jest.fn(), findMany: jest.fn() },
    articleEntityLink: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    newsEvent: { count: jest.fn(), findMany: jest.fn() },
    entitySentimentSnapshot: { findMany: jest.fn() },
  } as any;
  const graph = {
    resolveEntity: jest.fn(),
  } as any;

  const service = new KnowledgeGraphIntelligenceService(prisma, graph);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-31T00:00:00.000Z"));
    jest.clearAllMocks();
    prisma.knowledgeEntity.findFirst.mockResolvedValue(acme);
    prisma.knowledgeEntityAlias.findMany.mockResolvedValue([
      { alias: "Acme Corp" },
      { alias: "Acme" },
    ]);
    prisma.knowledgeEdge.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    prisma.knowledgeEdge.findMany.mockResolvedValue([
      {
        id: "edge-1",
        orgId: "org-1",
        type: "supplies",
        fromEntityId: "entity-1",
        toEntityId: "entity-2",
        weight: 3,
        confidence: 0.9,
        properties: null,
        firstSeenAt: new Date("2026-05-01T00:00:00.000Z"),
        lastSeenAt: new Date("2026-05-30T00:00:00.000Z"),
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-30T00:00:00.000Z"),
        fromEntity: acme,
        toEntity: contoso,
        evidences: [{ createdAt: new Date("2026-05-30T10:00:00.000Z") }],
        _count: { evidences: 2 },
      },
    ]);
    prisma.articleEntityLink.count.mockResolvedValue(7);
    prisma.articleEntityLink.findFirst.mockResolvedValue({
      createdAt: new Date("2026-05-30T12:00:00.000Z"),
    });
    prisma.newsEvent.count.mockResolvedValue(3);
    prisma.entitySentimentSnapshot.findMany.mockResolvedValue([
      {
        entityName: "Acme Corp",
        entityType: "company",
        bucketStart: new Date("2026-05-30T00:00:00.000Z"),
        totalDocs: 4,
        negativeDocs: 1,
        positiveDocs: 2,
        neutralDocs: 1,
        scoreSum: 1,
        avgScore: 0.25,
        negativeRatio: 0.25,
        evidenceProcessedItemIds: null,
      },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("builds a card with metrics, relationships, aliases, and neighborhood", async () => {
    const result = await service.getCard({
      orgId: "org-1",
      entityId: "entity-1",
      windowDays: 30,
      relatedLimit: 12,
    });

    expect(result?.aliases).toEqual(["Acme"]);
    expect(result?.metrics).toMatchObject({
      relationshipCount: 3,
      incomingEdgeCount: 1,
      outgoingEdgeCount: 2,
      mentionedArticleCount: 7,
      recentEventCount: 3,
      avgSentiment: 0.25,
      negativeRatio: 0.25,
    });
    expect(result?.relationships[0]).toMatchObject({
      direction: "outgoing",
      neighbor: contoso,
      evidenceCount: 2,
      latestEvidenceAt: new Date("2026-05-30T10:00:00.000Z"),
    });
    expect(result?.neighborhood.nodes.map((node) => node.id)).toEqual([
      "entity-1",
      "entity-2",
    ]);
  });

  it("falls back to empty entity sentiment type when exact type has no rows", async () => {
    prisma.entitySentimentSnapshot.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          entityName: "Acme Corp",
          entityType: "",
          bucketStart: new Date("2026-05-30T00:00:00.000Z"),
          totalDocs: 2,
          negativeDocs: 0,
          positiveDocs: 1,
          neutralDocs: 1,
          scoreSum: 1,
          avgScore: 0.5,
          negativeRatio: 0,
          evidenceProcessedItemIds: null,
        },
      ]);

    const result = await service.getCard({
      orgId: "org-1",
      entityId: "entity-1",
    });

    expect(result?.sentimentSeries[0]?.entityType).toBe("");
    expect(prisma.entitySentimentSnapshot.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not load content evidence without items.read", async () => {
    const result = await service.getEvidence({
      orgId: "org-1",
      entityId: "entity-1",
      canReadItems: false,
    });

    expect(result).toMatchObject({
      restricted: true,
      events: [],
      articles: [],
    });
    expect(prisma.newsEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.articleEntityLink.findMany).not.toHaveBeenCalled();
  });

  it("maps content evidence when items are readable", async () => {
    prisma.newsEvent.findMany.mockResolvedValue([
      {
        id: "event-1",
        status: "active",
        title: "Acme expands supply chain",
        summary: "Acme signed a new supply agreement.",
        primaryTopic: "Supply chain",
        primaryEntity: "Acme Corp",
        startAt: new Date("2026-05-29T00:00:00.000Z"),
        lastAt: new Date("2026-05-30T00:00:00.000Z"),
        _count: { items: 4 },
      },
    ]);
    prisma.articleEntityLink.findMany.mockResolvedValue([
      {
        articleId: "article-1",
        mention: "Acme",
        confidence: 0.91,
        createdAt: new Date("2026-05-30T12:00:00.000Z"),
        article: {
          url: "https://example.com/acme",
          sourceLabel: "Example",
          titleGuess: "Fallback title",
          language: "en",
          crawlAt: new Date("2026-05-30T10:00:00.000Z"),
          processed: {
            title: "Processed title",
            summary: "Processed summary",
            language: "en",
          },
        },
      },
    ]);

    const result = await service.getEvidence({
      orgId: "org-1",
      entityId: "entity-1",
      canReadItems: true,
    });

    expect(result?.restricted).toBe(false);
    expect(result?.events[0]?.itemCount).toBe(4);
    expect(result?.articles[0]?.article).toMatchObject({
      id: "article-1",
      title: "Processed title",
      summary: "Processed summary",
    });
  });

  it("resolves entity names through the knowledge graph service", async () => {
    graph.resolveEntity.mockResolvedValue(acme);

    const result = await service.resolveEntityByName("org-1", "Acme", "company");

    expect(graph.resolveEntity).toHaveBeenCalledWith(
      "org-1",
      "Acme",
      KnowledgeEntityType.company
    );
    expect(result).toBe(acme);
  });
});
