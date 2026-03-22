import { KnowledgeGraphIngestionService } from "../knowledge-graph.ingestion.service";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

describe("KnowledgeGraphIngestionService", () => {
  it("fans out org ingestion with configured concurrency", async () => {
    const cache = {
      withLock: jest.fn(),
    } as any;
    const prisma = {
      org: {
        findMany: jest.fn().mockResolvedValue([
          { id: "org-1" },
          { id: "org-2" },
          { id: "org-3" },
        ]),
      },
    } as any;
    const schedulerSettings = {
      getRuntimeSettings: jest.fn().mockResolvedValue({
        knowledgeGraphIngestionOrgConcurrency: 2,
      }),
    } as any;
    const settings = {} as any;
    const quality = {} as any;
    const graph = {} as any;
    const service = new KnowledgeGraphIngestionService(
      cache,
      prisma,
      schedulerSettings,
      settings,
      quality,
      graph,
    );

    cache.withLock.mockImplementation(
      async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
        await runner(),
    );

    const releases = new Map(
      ["org-1", "org-2", "org-3"].map((orgId) => [
        orgId,
        createDeferred<void>(),
      ]),
    );
    const startedTwo = createDeferred<void>();
    let active = 0;
    let maxActive = 0;
    let started = 0;

    jest.spyOn(service as any, "ingestOrg").mockImplementation(async (orgId: string) => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 2) {
        startedTwo.resolve();
      }

      await releases.get(orgId)!.promise;
      active -= 1;
    });

    const runPromise = service.ingestRecentProcessedArticles();

    await startedTwo.promise;
    expect(maxActive).toBe(2);

    releases.get("org-1")!.resolve();
    releases.get("org-2")!.resolve();
    releases.get("org-3")!.resolve();

    await runPromise;
  });

  it("continues batch ingestion and advances cursor when one article fails", async () => {
    const firstProcessedAt = new Date("2026-01-01T00:00:00.000Z");
    const secondProcessedAt = new Date("2026-01-01T00:05:00.000Z");

    const cache = {} as any;
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

    const schedulerSettings = {} as any;
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
      cache,
      prisma,
      schedulerSettings,
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
