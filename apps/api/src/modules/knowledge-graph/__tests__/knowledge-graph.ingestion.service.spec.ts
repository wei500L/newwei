import { KnowledgeGraphIngestionService } from "../knowledge-graph.ingestion.service";

describe("KnowledgeGraphIngestionService", () => {
  it("continues batch ingestion and advances cursor when one article fails", async () => {
    const firstProcessedAt = new Date("2026-01-01T00:00:00.000Z");
    const secondProcessedAt = new Date("2026-01-01T00:05:00.000Z");

    const prisma = {
      knowledgeGraphIngestionState: {
        findUnique: jest.fn().mockResolvedValue({
          orgId: "org-1",
          lastProcessedAt: null,
          lastProcessedArticleId: null
        }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined)
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            articleId: "a-1",
            processedAt: firstProcessedAt,
            title: "title 1",
            summary: "summary 1",
            language: "zh",
            entities: [],
            kgRelations: [],
            llmPromptVersion: "v1"
          },
          {
            articleId: "a-2",
            processedAt: secondProcessedAt,
            title: "title 2",
            summary: "summary 2",
            language: "zh",
            entities: [],
            kgRelations: [],
            llmPromptVersion: "v1"
          }
        ])
      }
    } as any;

    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        enabled: true,
        ingestionEnabled: true,
        maxBatchSize: 100,
        maxRelationsPerArticle: 20,
        minEdgeConfidence: 0.55,
        dynamicEdgeConfidenceEnabled: true,
        dynamicEdgeConfidenceQuantile: 0.25,
        multiModelValidationEnabled: false,
        multiModelValidationModels: [],
        multiModelValidationModelCount: 3,
        multiModelValidationMaxRelationsPerArticle: 5,
        entityDisambiguationEnabled: false,
        entityDisambiguationMaxCandidates: 5,
        cacheTtlSeconds: 60
      })
    } as any;

    const quality = {
      prepareRelationsForIngestion: jest
        .fn()
        .mockRejectedValueOnce(new Error("broken article"))
        .mockResolvedValueOnce({
          relations: [],
          validatedRelations: 2,
          filteredRelations: 1
        })
    } as any;

    const graph = {
      ingestProcessedArticle: jest.fn().mockResolvedValue({ edgesUpserted: 3 }),
      linkArticleEntities: jest.fn().mockResolvedValue(undefined)
    } as any;

    const service = new KnowledgeGraphIngestionService(
      prisma,
      settings,
      quality,
      graph
    );

    await (service as any).ingestOrg("org-1");

    expect(quality.prepareRelationsForIngestion).toHaveBeenCalledTimes(2);
    expect(graph.ingestProcessedArticle).toHaveBeenCalledTimes(1);
    expect(graph.linkArticleEntities).toHaveBeenCalledTimes(1);
    expect(prisma.knowledgeGraphIngestionState.update).toHaveBeenCalledTimes(2);
    expect(prisma.knowledgeGraphIngestionState.update).toHaveBeenNthCalledWith(
      1,
      {
        where: { orgId: "org-1" },
        data: {
          lastProcessedAt: firstProcessedAt,
          lastProcessedArticleId: "a-1"
        }
      }
    );
    expect(prisma.knowledgeGraphIngestionState.update).toHaveBeenNthCalledWith(
      2,
      {
        where: { orgId: "org-1" },
        data: {
          lastProcessedAt: secondProcessedAt,
          lastProcessedArticleId: "a-2"
        }
      }
    );
  });
});
