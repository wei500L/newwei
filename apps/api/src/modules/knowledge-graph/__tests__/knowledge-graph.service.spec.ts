import { KnowledgeEntityType, KnowledgeRelationType } from "@prisma/client";
import { KnowledgeRecordSource } from "@prisma/client";

import { KnowledgeGraphService } from "../knowledge-graph.service";

describe("KnowledgeGraphService", () => {
  it("ingests valid kg relations into entities, edges, and evidences", async () => {
    const tx = {
      knowledgeEntity: {
        upsert: jest
          .fn()
          .mockResolvedValueOnce({ id: "e1", canonicalName: "Acme", type: KnowledgeEntityType.company })
          .mockResolvedValueOnce({ id: "e2", canonicalName: "Aviation", type: KnowledgeEntityType.industry })
      },
      knowledgeEntityAlias: { upsert: jest.fn().mockResolvedValue(null) },
      knowledgeEdge: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "edge-1" }),
        update: jest.fn()
      },
      knowledgeEdgeEvidence: { upsert: jest.fn().mockResolvedValue(null) }
    };

    const prisma = {
      runInTransaction: jest.fn(async (fn: any) => fn(tx))
    } as any;

    const service = new KnowledgeGraphService(prisma);

    const result = await service.ingestProcessedArticle({
      orgId: "org-1",
      articleId: "article-1",
      extractorVersion: "news-clean-v4",
      maxRelationsPerArticle: 20,
      kgRelations: [
        {
          subject: { name: "Acme", type: "company" },
          predicate: "belongs_to_industry",
          object: { name: "Aviation", type: "industry" },
          confidence: 0.9,
          properties: { source: "unit-test" },
          evidence: "Acme operates in the aviation sector."
        }
      ]
    });

    expect(result.edgesUpserted).toBe(1);
    expect(prisma.runInTransaction).toHaveBeenCalledTimes(1);
    expect(tx.knowledgeEntity.upsert).toHaveBeenCalledTimes(2);
    expect(tx.knowledgeEdge.create).toHaveBeenCalledTimes(1);
    expect(tx.knowledgeEdgeEvidence.upsert).toHaveBeenCalledTimes(1);
  });

  it("builds a bounded subgraph with maxDepth", async () => {
    const buildSeedAlias = () => [
      {
        entity: {
          id: "a",
          orgId: "org-1",
          type: KnowledgeEntityType.company,
          canonicalName: "Acme",
          normalizedKey: "acme",
          properties: null
        }
      }
    ];

    const buildEdge = (id: string, from: string, to: string, type: KnowledgeRelationType) => ({
      id,
      orgId: "org-1",
      type,
      fromEntityId: from,
      toEntityId: to,
      weight: 1,
      confidence: 0.5,
      properties: null,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const buildEntity = (id: string, type: KnowledgeEntityType, name: string) => ({
      id,
      orgId: "org-1",
      type,
      canonicalName: name,
      normalizedKey: name.toLowerCase(),
      properties: null
    });

    const prismaDepth1 = {
      knowledgeEntityAlias: { findMany: jest.fn().mockResolvedValue(buildSeedAlias()) },
      knowledgeEdge: { findMany: jest.fn().mockResolvedValue([buildEdge("ab", "a", "b", KnowledgeRelationType.belongs_to_industry)]) },
      knowledgeEntity: { findMany: jest.fn().mockResolvedValue([buildEntity("b", KnowledgeEntityType.industry, "Aviation")]) }
    } as any;

    const serviceDepth1 = new KnowledgeGraphService(prismaDepth1);
    const depth1 = await serviceDepth1.getSubgraph({
      orgId: "org-1",
      seedName: "Acme",
      maxDepth: 1,
      maxNodes: 10
    });
    expect(depth1?.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(depth1?.edges.map((e) => e.id).sort()).toEqual(["ab"]);

    const prismaDepth2 = {
      knowledgeEntityAlias: { findMany: jest.fn().mockResolvedValue(buildSeedAlias()) },
      knowledgeEdge: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([buildEdge("ab", "a", "b", KnowledgeRelationType.belongs_to_industry)])
          .mockResolvedValueOnce([buildEdge("bc", "b", "c", KnowledgeRelationType.affects_company)])
      },
      knowledgeEntity: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([buildEntity("b", KnowledgeEntityType.industry, "Aviation")])
          .mockResolvedValueOnce([buildEntity("c", KnowledgeEntityType.company, "Contoso")])
      }
    } as any;

    const serviceDepth2 = new KnowledgeGraphService(prismaDepth2);
    const depth2 = await serviceDepth2.getSubgraph({
      orgId: "org-1",
      seedName: "Acme",
      maxDepth: 2,
      maxNodes: 10
    });
    expect(depth2?.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(depth2?.edges.map((e) => e.id).sort()).toEqual(["ab", "bc"]);
  });

  it("prefers instrument when querying by ticker", async () => {
    const prisma = {
      knowledgeEntityAlias: {
        findMany: jest.fn().mockResolvedValue([
          {
            source: KnowledgeRecordSource.seed,
            entity: {
              id: "company-1",
              orgId: "org-1",
              type: KnowledgeEntityType.company,
              canonicalName: "Acme",
              normalizedKey: "acme",
              properties: null
            }
          },
          {
            source: KnowledgeRecordSource.llm,
            entity: {
              id: "instrument-1",
              orgId: "org-1",
              type: KnowledgeEntityType.instrument,
              canonicalName: "600313.SH",
              normalizedKey: "600313.sh",
              properties: null
            }
          }
        ])
      }
    } as any;

    const service = new KnowledgeGraphService(prisma);
    const resolved = await service.resolveEntity("org-1", "600313.SH");
    expect(resolved?.type).toBe(KnowledgeEntityType.instrument);
    expect(resolved?.id).toBe("instrument-1");
  });

  it("includes stripped company suffixes in search keys", async () => {
    const companySuffix = "\u80a1\u4efd\u6709\u9650\u516c\u53f8";
    const query = `Acme${companySuffix}`;

    const prisma = {
      knowledgeEntityAlias: {
        findMany: jest.fn().mockResolvedValue([
          {
            source: KnowledgeRecordSource.seed,
            entity: {
              id: "company-1",
              orgId: "org-1",
              type: KnowledgeEntityType.company,
              canonicalName: "Acme",
              normalizedKey: "acme",
              properties: null
            }
          }
        ])
      }
    } as any;

    const service = new KnowledgeGraphService(prisma);
    await service.resolveEntity("org-1", query);

    expect(prisma.knowledgeEntityAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          normalizedAlias: expect.objectContaining({
            in: expect.arrayContaining(["acme"])
          })
        })
      })
    );
  });
});
