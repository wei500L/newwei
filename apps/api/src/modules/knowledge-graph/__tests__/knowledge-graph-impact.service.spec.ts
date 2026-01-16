import { KnowledgeEntityType, KnowledgeRelationType } from "@prisma/client";

import { KnowledgeGraphImpactService } from "../knowledge-graph-impact.service";

describe("KnowledgeGraphImpactService", () => {
  it("returns tickers and same-industry peers for executive change", async () => {
    const now = new Date();

    const seedCompany = {
      id: "c1",
      orgId: "org-1",
      type: KnowledgeEntityType.company,
      canonicalName: "Acme",
      normalizedKey: "acme",
      properties: null,
      createdAt: now,
      updatedAt: now
    };

    const instrument = {
      id: "i1",
      orgId: "org-1",
      type: KnowledgeEntityType.instrument,
      canonicalName: "600313.SH",
      normalizedKey: "600313.sh",
      properties: null,
      createdAt: now,
      updatedAt: now
    };

    const industry = {
      id: "ind1",
      orgId: "org-1",
      type: KnowledgeEntityType.industry,
      canonicalName: "Industry-3",
      normalizedKey: "industry-3",
      properties: null,
      createdAt: now,
      updatedAt: now
    };

    const peerCompany = {
      id: "c2",
      orgId: "org-1",
      type: KnowledgeEntityType.company,
      canonicalName: "Contoso",
      normalizedKey: "contoso",
      properties: null,
      createdAt: now,
      updatedAt: now
    };

    const edge = (id: string, type: KnowledgeRelationType, from: string, to: string) => ({
      id,
      orgId: "org-1",
      type,
      fromEntityId: from,
      toEntityId: to,
      weight: 1,
      confidence: 0.9,
      properties: null,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now
    });

    const tickerEdge = edge("e1", KnowledgeRelationType.has_ticker, seedCompany.id, instrument.id);
    const industryEdge = edge("e2", KnowledgeRelationType.belongs_to_industry, seedCompany.id, industry.id);
    const peerEdge = edge("e3", KnowledgeRelationType.belongs_to_industry, peerCompany.id, industry.id);

    const prisma = {
      knowledgeEdge: {
        findMany: jest.fn(async (args: any) => {
          const where = args.where ?? {};
          const relation = where.type;
          if (relation?.in?.includes(KnowledgeRelationType.has_ticker)) {
            return [tickerEdge];
          }
          if (relation?.in?.includes(KnowledgeRelationType.belongs_to_industry) && where.OR) {
            return [industryEdge];
          }
          if (relation === KnowledgeRelationType.belongs_to_industry && where.OR) {
            return [peerEdge];
          }
          return [];
        })
      },
      knowledgeEntity: {
        findMany: jest.fn(async (args: any) => {
          const ids: string[] = args.where?.id?.in ?? [];
          const all = [seedCompany, instrument, industry, peerCompany];
          return all.filter((node) => ids.includes(node.id));
        })
      }
    } as any;

    const graph = {
      resolveEntity: jest.fn().mockResolvedValue(seedCompany)
    } as any;

    const akshare = {
      get: jest.fn()
    } as any;

    const service = new KnowledgeGraphImpactService(prisma, graph, akshare);
    const result = await service.analyzeExecutiveChange({
      orgId: "org-1",
      companyName: "Acme",
      maxCandidates: 20
    });

    expect(result?.seed.id).toBe(seedCompany.id);
    expect(result?.candidates.some((c) => c.entity.id === instrument.id)).toBe(true);
    expect(result?.candidates.some((c) => c.entity.id === peerCompany.id)).toBe(true);

    const peerCandidate = result?.candidates.find((c) => c.entity.id === peerCompany.id);
    expect(peerCandidate?.chains[0]?.nodes.map((n) => n.id)).toEqual([seedCompany.id, industry.id, peerCompany.id]);
  });
});

