import { BadRequestException } from "@nestjs/common";

import { KnowledgeGraphReviewService } from "../knowledge-graph-review.service";

const buildService = (tx: any, graphOverrides?: Partial<Record<string, jest.Mock>>) => {
  const cache = {
    delByPrefix: jest.fn().mockResolvedValue(0)
  };
  const prisma = {
    runInTransaction: jest.fn(async (fn: any) => fn(tx)),
    knowledgeEdgeEvidence: {
      findFirst: jest.fn().mockResolvedValue({ id: "evidence-1" })
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({})
    }
  };
  const graph = {
    normalizeReviewedRelation: jest.fn(),
    upsertReviewedRelationEdge: jest.fn(),
    ...graphOverrides
  };

  return {
    service: new KnowledgeGraphReviewService(cache as any, prisma as any, graph as any),
    cache,
    prisma,
    graph
  };
};

describe("KnowledgeGraphReviewService", () => {
  it("keeps approved evidence active and recomputes edge weight and confidence", async () => {
    const firstSeenAt = new Date("2026-05-01T00:00:00.000Z");
    const lastSeenAt = new Date("2026-05-02T00:00:00.000Z");
    const tx = {
      knowledgeEdgeEvidence: {
        findFirst: jest.fn().mockResolvedValue({
          id: "evidence-1",
          orgId: "org-1",
          edgeId: "edge-1",
          articleId: "article-1",
          confidence: 0.4,
          evidence: { quote: "original" }
        }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          {
            id: "evidence-1",
            confidence: 0.4,
            evidence: { review: { status: "approved" } },
            createdAt: firstSeenAt
          },
          {
            id: "evidence-2",
            confidence: 0.8,
            evidence: null,
            createdAt: lastSeenAt
          }
        ]),
        deleteMany: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn()
      },
      knowledgeEdge: {
        findFirst: jest.fn().mockResolvedValue({ id: "edge-1", properties: null }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn()
      }
    };
    const { service, cache } = buildService(tx);

    await service.reviewEvidence({
      orgId: "org-1",
      actorId: "user-1",
      evidenceId: "evidence-1",
      status: "approved"
    });

    expect(tx.knowledgeEdgeEvidence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evidence-1" },
        data: expect.objectContaining({
          evidence: expect.objectContaining({
            quote: "original",
            review: expect.objectContaining({ status: "approved", reviewerId: "user-1" })
          })
        })
      })
    );
    expect(tx.knowledgeEdge.update).toHaveBeenCalledWith({
      where: { id: "edge-1" },
      data: {
        weight: 2,
        confidence: 0.6000000000000001,
        firstSeenAt,
        lastSeenAt
      }
    });
    expect(cache.delByPrefix).toHaveBeenCalledWith("knowledgeGraph:subgraph:org-1:");
    expect(cache.delByPrefix).toHaveBeenCalledWith("knowledgeGraph:impact:org-1:");
  });

  it("deletes an evidence-backed edge when its last evidence is rejected", async () => {
    const tx = {
      knowledgeEdgeEvidence: {
        findFirst: jest.fn().mockResolvedValue({
          id: "evidence-1",
          orgId: "org-1",
          edgeId: "edge-1",
          articleId: "article-1",
          confidence: 0.3,
          evidence: null
        }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          {
            id: "evidence-1",
            confidence: 0.3,
            evidence: { review: { status: "rejected" } },
            createdAt: new Date("2026-05-01T00:00:00.000Z")
          }
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
        findUnique: jest.fn()
      },
      knowledgeEdge: {
        findFirst: jest.fn().mockResolvedValue({ id: "edge-1", properties: null }),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({})
      }
    };
    const { service, prisma } = buildService(tx);

    const result = await service.reviewEvidence({
      orgId: "org-1",
      actorId: "user-1",
      evidenceId: "evidence-1",
      status: "rejected"
    });

    expect(result).toBeNull();
    expect(tx.knowledgeEdgeEvidence.deleteMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", edgeId: "edge-1" }
    });
    expect(tx.knowledgeEdge.delete).toHaveBeenCalledWith({ where: { id: "edge-1" } });
    expect(prisma.knowledgeEdgeEvidence.findFirst).not.toHaveBeenCalled();
  });

  it("moves corrected evidence to the corrected edge and recomputes both edges", async () => {
    const correctedRelation = {
      subject: { name: "Acme", type: "company" },
      predicate: "supplies",
      object: { name: "Contoso", type: "company" }
    };
    const tx = {
      knowledgeEdgeEvidence: {
        findFirst: jest.fn().mockResolvedValue({
          id: "evidence-1",
          orgId: "org-1",
          edgeId: "edge-1",
          articleId: "article-1",
          confidence: 0.7,
          evidence: { quote: "Acme supplies Contoso." }
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: "evidence-1",
              confidence: 0.7,
              evidence: { review: { status: "corrected", correctedRelation } },
              createdAt: new Date("2026-05-01T00:00:00.000Z")
            }
          ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        delete: jest.fn()
      },
      knowledgeEdge: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: "edge-1", properties: null })
          .mockResolvedValueOnce({ id: "edge-2", properties: null }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({})
      }
    };
    const { service, graph } = buildService(tx, {
      normalizeReviewedRelation: jest.fn().mockReturnValue(correctedRelation),
      upsertReviewedRelationEdge: jest.fn().mockResolvedValue({ id: "edge-2" })
    });

    await service.reviewEvidence({
      orgId: "org-1",
      actorId: "user-1",
      evidenceId: "evidence-1",
      status: "corrected",
      correctedRelation
    });

    expect(graph.upsertReviewedRelationEdge).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orgId: "org-1",
        relation: correctedRelation,
        confidence: 0.7
      })
    );
    expect(tx.knowledgeEdgeEvidence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evidence-1" },
        data: expect.objectContaining({ edgeId: "edge-2" })
      })
    );
    expect(tx.knowledgeEdge.delete).toHaveBeenCalledWith({ where: { id: "edge-1" } });
    expect(tx.knowledgeEdge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "edge-2" },
        data: expect.objectContaining({ weight: 1, confidence: 0.7 })
      })
    );
  });

  it("merges corrected evidence when the target edge already has article evidence", async () => {
    const correctedRelation = {
      subject: { name: "Acme", type: "company" },
      predicate: "supplies",
      object: { name: "Contoso", type: "company" }
    };
    const tx = {
      knowledgeEdgeEvidence: {
        findFirst: jest.fn().mockResolvedValue({
          id: "evidence-1",
          orgId: "org-1",
          edgeId: "edge-1",
          articleId: "article-1",
          confidence: 0.6,
          evidence: { quote: "original quote" }
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: "evidence-2",
          confidence: null,
          evidence: { quote: "target quote" }
        }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: "evidence-2",
              confidence: 0.6,
              evidence: { review: { status: "corrected", correctedRelation } },
              createdAt: new Date("2026-05-01T00:00:00.000Z")
            }
          ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      knowledgeEdge: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: "edge-1", properties: null })
          .mockResolvedValueOnce({ id: "edge-2", properties: null }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({})
      }
    };
    const { service } = buildService(tx, {
      normalizeReviewedRelation: jest.fn().mockReturnValue(correctedRelation),
      upsertReviewedRelationEdge: jest.fn().mockResolvedValue({ id: "edge-2" })
    });

    await service.reviewEvidence({
      orgId: "org-1",
      actorId: "user-1",
      evidenceId: "evidence-1",
      status: "corrected",
      correctedRelation
    });

    expect(tx.knowledgeEdgeEvidence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evidence-2" },
        data: expect.objectContaining({
          confidence: 0.6,
          evidence: expect.objectContaining({
            quote: "target quote",
            review: expect.objectContaining({ status: "corrected" })
          })
        })
      })
    );
    expect(tx.knowledgeEdgeEvidence.delete).toHaveBeenCalledWith({ where: { id: "evidence-1" } });
  });

  it("rejects malformed corrected relations", async () => {
    const tx = {
      knowledgeEdgeEvidence: {
        findFirst: jest.fn().mockResolvedValue({
          id: "evidence-1",
          orgId: "org-1",
          edgeId: "edge-1",
          articleId: "article-1",
          confidence: 0.7,
          evidence: null
        })
      }
    };
    const { service } = buildService(tx, {
      normalizeReviewedRelation: jest.fn().mockReturnValue(null)
    });

    await expect(
      service.reviewEvidence({
        orgId: "org-1",
        actorId: "user-1",
        evidenceId: "evidence-1",
        status: "corrected",
        correctedRelation: { predicate: "" }
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
