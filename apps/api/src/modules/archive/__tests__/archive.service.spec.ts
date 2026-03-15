jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

import type { ProcessedArticleStatus } from "@prisma/client";

import { ArchiveService } from "../archive.service";
import {
  ArchiveMatchOrigin,
  ArchivePreparationState,
  ArchiveRegion,
  ArchiveVertical,
  ArchiveWeight,
  createArchiveVerticalScoreMap,
} from "../archive.types";

interface ArchiveRowFixture {
  id: string;
  title: string | null;
  summary: string | null;
  source: string | null;
  publishedAt: Date | null;
  topics: unknown;
  entities: unknown;
  qualityScore: number | null;
  location: string | null;
  processedAt: Date;
  cleanedMarkdownRef: string | null;
  article: {
    id: string;
    orgId: string;
    url: string;
    sourceLabel: string | null;
    crawlAt: Date;
  };
  newsEventItems: Array<{
    eventId: string;
  }>;
  status?: ProcessedArticleStatus;
}

const makeRow = (id: string, publishedAtIso: string): ArchiveRowFixture => ({
  id,
  title: `${id} title`,
  summary: `${id} summary`,
  source: "fixture-source",
  publishedAt: new Date(publishedAtIso),
  topics: ["security"],
  entities: [{ name: "Philippines" }],
  qualityScore: 0.92,
  location: "Philippines",
  processedAt: new Date(publishedAtIso),
  cleanedMarkdownRef: `ref-${id}`,
  article: {
    id: `article-${id}`,
    orgId: "org-1",
    url: `https://example.com/${id}`,
    sourceLabel: "fixture-source",
    crawlAt: new Date(publishedAtIso),
  },
  newsEventItems: [{ eventId: `event-${id}` }],
});

const makeCacheMock = () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  hincrby: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
});

const makeArchivePreparationQueueServiceMock = () => ({
  ensureDigestCoverage: jest.fn().mockResolvedValue(undefined),
  ensureCalendarCoverage: jest.fn().mockResolvedValue(undefined),
  getDigestStatus: jest.fn().mockResolvedValue(null),
});

describe("ArchiveService", () => {
  const classifierResult = {
    region: ArchiveRegion.APAC,
    vertical: ArchiveVertical.EAST_SEA,
    countryCode: "PHL",
    countryLabel: "Philippines",
    entityTags: ["Philippines"],
  };
  const classifierSignalsResult = {
    region: ArchiveRegion.APAC,
    ruleVertical: ArchiveVertical.EAST_SEA,
    countryCode: "PHL",
    countryLabel: "Philippines",
    entityTags: ["Philippines"],
    ruleScores: {
      ...createArchiveVerticalScoreMap(),
      [ArchiveVertical.EAST_SEA]: 1,
    },
    matchedCountries: ["【东海】 Philippines"],
    matchedKeywords: ["【东海】 maritime security"],
    suppressedKeywords: [],
    countryMatchedVerticals: [ArchiveVertical.EAST_SEA],
    verticalSignals: {
      [ArchiveVertical.EAST_SEA]: {
        countryMatched: true,
        matchedCountries: ["Philippines"],
        matchedStrongKeywords: ["maritime security"],
        matchedWeakKeywords: [],
        excludedKeywords: [],
        conflictKeywords: [],
      },
      [ArchiveVertical.SOUTH_SEA]: {
        countryMatched: false,
        matchedCountries: [],
        matchedStrongKeywords: [],
        matchedWeakKeywords: [],
        excludedKeywords: [],
        conflictKeywords: [],
      },
      [ArchiveVertical.WEST_FRONT]: {
        countryMatched: false,
        matchedCountries: [],
        matchedStrongKeywords: [],
        matchedWeakKeywords: [],
        excludedKeywords: [],
        conflictKeywords: [],
      },
      [ArchiveVertical.FOREIGN_AFFAIRS]: {
        countryMatched: false,
        matchedCountries: [],
        matchedStrongKeywords: [],
        matchedWeakKeywords: [],
        excludedKeywords: [],
        conflictKeywords: [],
      },
      [ArchiveVertical.DOMESTIC_AFFAIRS]: {
        countryMatched: false,
        matchedCountries: [],
        matchedStrongKeywords: [],
        matchedWeakKeywords: [],
        excludedKeywords: [],
        conflictKeywords: [],
      },
    },
  };

  const makeClassifierMock = () => ({
    classify: jest.fn().mockReturnValue(classifierResult),
    classifyRuleSignals: jest.fn().mockReturnValue(classifierSignalsResult),
  });

  const makeArchiveClassificationServiceMock = () => ({
    getCachedHybridBatch: jest.fn(async (_orgId: string, inputs: any[]) =>
      new Map(
        inputs.map((input) => [
          input.processedArticleId,
          {
            processedArticleId: input.processedArticleId,
            articleId: input.articleId,
            region: input.ruleContext.region,
            vertical: ArchiveVertical.EAST_SEA,
            countryCode: input.ruleContext.countryCode,
            countryLabel: input.ruleContext.countryLabel,
            entityTags: input.ruleContext.entityTags,
            ruleScores: input.ruleContext.ruleScores,
            embeddingScores: createArchiveVerticalScoreMap(),
            rerankScores: createArchiveVerticalScoreMap(),
            fusedScores: {
              ...createArchiveVerticalScoreMap(),
              [ArchiveVertical.EAST_SEA]: 1,
            },
            classificationTextHash: `hash-${input.processedArticleId}`,
            classificationTextVersion: "archive-text-v1",
            taxonomyVersion: "archive-vertical-v1",
            pipelineVersion: "archive-hybrid-v1",
            embeddingModel: "embedding-model",
            rerankModel: "rerank-model",
          },
        ]),
      ),
    ),
    classifyHybridBatch: jest.fn(async (_orgId: string, inputs: any[]) =>
      inputs.map((input) => ({
        processedArticleId: input.processedArticleId,
        articleId: input.articleId,
        region: input.ruleContext.region,
        vertical: ArchiveVertical.EAST_SEA,
        countryCode: input.ruleContext.countryCode,
        countryLabel: input.ruleContext.countryLabel,
        entityTags: input.ruleContext.entityTags,
        ruleScores: input.ruleContext.ruleScores,
        embeddingScores: createArchiveVerticalScoreMap(),
        rerankScores: createArchiveVerticalScoreMap(),
        fusedScores: {
          ...createArchiveVerticalScoreMap(),
          [ArchiveVertical.EAST_SEA]: 1,
        },
        classificationTextHash: `hash-${input.processedArticleId}`,
        classificationTextVersion: "archive-text-v1",
        taxonomyVersion: "archive-vertical-v1",
        pipelineVersion: "archive-hybrid-v1",
        embeddingModel: "embedding-model",
        rerankModel: "rerank-model",
      })),
    ),
  });

  it("throws when embedding model is unavailable", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([makeRow("row-1", "2025-05-28T02:00:00.000Z")]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue(null),
      embedding: jest.fn(),
      rerank: jest.fn().mockResolvedValue({ results: [] }),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "菲律宾",
        weights: [
          ArchiveWeight.ONE,
          ArchiveWeight.TWO,
          ArchiveWeight.THREE,
          ArchiveWeight.FOUR,
          ArchiveWeight.FIVE,
        ],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_EMBEDDING_UNAVAILABLE");
    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(vectorClient.searchBestEffort).not.toHaveBeenCalled();
    expect(prisma.processedArticle.findMany).not.toHaveBeenCalled();
  });

  it("throws when embedding response has no usable vector", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([makeRow("row-2", "2025-05-27T02:00:00.000Z")]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{}],
      }),
      rerank: jest.fn().mockResolvedValue({ results: [] }),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "south china sea",
        weights: [ArchiveWeight.FIVE],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_EMBEDDING_INVALID_RESPONSE");
    expect(vectorClient.searchBestEffort).not.toHaveBeenCalled();
    expect(prisma.processedArticle.findMany).not.toHaveBeenCalled();
  });

  it("throws when vector service is unavailable", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn(),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{ embedding: [0.1, 0.2] }],
      }),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn().mockResolvedValue(null) };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "south china sea",
        weights: [ArchiveWeight.FIVE],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_VECTOR_UNAVAILABLE");
    expect(prisma.processedArticle.findMany).not.toHaveBeenCalled();
  });

  it("throws when rerank fails instead of silently reordering", async () => {
    const row = makeRow("row-3", "2025-05-27T02:00:00.000Z");
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([row]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{ embedding: [0.1, 0.2] }],
      }),
      rerank: jest.fn().mockRejectedValue(new Error("rerank down")),
    };
    const vectorClient = {
      searchBestEffort: jest
        .fn()
        .mockResolvedValue([{ processedItemId: row.cleanedMarkdownRef, score: 0.92 }]),
    };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "south china sea",
        weights: [ArchiveWeight.FIVE],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_RERANK_FAILED");
  });

  it("ranks search-mode archive items by relevance before weight", async () => {
    const lowRelevanceHighWeight = makeRow(
      "row-high-weight",
      "2025-05-27T02:00:00.000Z",
    );
    lowRelevanceHighWeight.qualityScore = 0.95;
    lowRelevanceHighWeight.cleanedMarkdownRef = "ref-high-weight";

    const highRelevanceLowWeight = makeRow(
      "row-low-weight",
      "2025-05-27T01:30:00.000Z",
    );
    highRelevanceLowWeight.qualityScore = 0.05;
    highRelevanceLowWeight.cleanedMarkdownRef = "ref-low-weight";
    highRelevanceLowWeight.title = "South China Sea latest escalation";
    highRelevanceLowWeight.summary = "Key maritime developments";

    const prisma = {
      processedArticle: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([lowRelevanceHighWeight, highRelevanceLowWeight])
          .mockResolvedValueOnce([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{ embedding: [0.1, 0.2] }],
      }),
      rerank: jest.fn().mockResolvedValue({
        results: [
          { index: 0, score: 0.95 },
          { index: 1, score: 0.1 },
        ],
      }),
    };
    const vectorClient = {
      searchBestEffort: jest.fn().mockResolvedValue([
        { processedItemId: "ref-low-weight", score: 0.96 },
        { processedItemId: "ref-high-weight", score: 0.58 },
      ]),
    };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const result = await service.getDigest("org-1", {
      anchorDate: new Date("2025-05-28T00:00:00.000Z"),
      region: ArchiveRegion.APAC,
      search: "south china sea",
      weights: [
        ArchiveWeight.ONE,
        ArchiveWeight.TWO,
        ArchiveWeight.THREE,
        ArchiveWeight.FOUR,
        ArchiveWeight.FIVE,
      ],
      limitPerVertical: 20,
    });

    const items = result.groups[0]?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.processedArticleId).toBe(highRelevanceLowWeight.id);
    expect(items[1]?.processedArticleId).toBe(lowRelevanceHighWeight.id);
    expect(items[0]?.relevanceScore ?? 0).toBeGreaterThan(
      items[1]?.relevanceScore ?? 0,
    );
  });

  it("labels match origin as lexical, semantic, or hybrid", async () => {
    const hybridRow = makeRow("row-hybrid", "2025-05-27T02:00:00.000Z");
    hybridRow.cleanedMarkdownRef = "ref-hybrid";
    hybridRow.title = "Hybrid query hit";

    const semanticOnlyRow = makeRow("row-semantic", "2025-05-27T01:00:00.000Z");
    semanticOnlyRow.cleanedMarkdownRef = "ref-semantic";
    semanticOnlyRow.title = "Semantic-only hit";

    const lexicalOnlyRow = makeRow("row-lexical", "2025-05-27T00:30:00.000Z");
    lexicalOnlyRow.cleanedMarkdownRef = "ref-lexical";
    lexicalOnlyRow.title = "Hybrid lexical hit";

    const prisma = {
      processedArticle: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([hybridRow, semanticOnlyRow])
          .mockResolvedValueOnce([hybridRow, lexicalOnlyRow]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{ embedding: [0.1, 0.2] }],
      }),
      rerank: jest.fn().mockResolvedValue({
        results: [
          { index: 0, score: 0.9 },
          { index: 1, score: 0.6 },
          { index: 2, score: 0.3 },
        ],
      }),
    };
    const vectorClient = {
      searchBestEffort: jest.fn().mockResolvedValue([
        { processedItemId: "ref-hybrid", score: 0.93 },
        { processedItemId: "ref-semantic", score: 0.89 },
      ]),
    };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const result = await service.getDigest("org-1", {
      anchorDate: new Date("2025-05-28T00:00:00.000Z"),
      region: ArchiveRegion.APAC,
      search: "hybrid",
      weights: [
        ArchiveWeight.ONE,
        ArchiveWeight.TWO,
        ArchiveWeight.THREE,
        ArchiveWeight.FOUR,
        ArchiveWeight.FIVE,
      ],
      limitPerVertical: 20,
    });

    const itemById = new Map(
      (result.groups[0]?.items ?? []).map((item) => [item.processedArticleId, item]),
    );
    expect(itemById.get(hybridRow.id)?.matchOrigin).toBe(ArchiveMatchOrigin.HYBRID);
    expect(itemById.get(semanticOnlyRow.id)?.matchOrigin).toBe(
      ArchiveMatchOrigin.SEMANTIC,
    );
    expect(itemById.get(lexicalOnlyRow.id)?.matchOrigin).toBe(
      ArchiveMatchOrigin.LEXICAL,
    );
  });

  it("extends scan depth for deep cursor offsets before deriving hasMore", async () => {
    const baseTime = new Date("2025-05-28T10:00:00.000Z").getTime();
    const makeBatch = (startIndex: number, count: number) =>
      Array.from({ length: count }, (_, index) => {
        const absoluteIndex = startIndex + index;
        return makeRow(
          `deep-row-${String(absoluteIndex + 1).padStart(5, "0")}`,
          new Date(baseTime - absoluteIndex * 1_000).toISOString(),
        );
      });

    const prisma = {
      processedArticle: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(makeBatch(0, 400))
          .mockResolvedValueOnce(makeBatch(400, 400))
          .mockResolvedValueOnce(makeBatch(800, 400))
          .mockResolvedValueOnce(makeBatch(1200, 400))
          .mockResolvedValueOnce([]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const cursor = Buffer.from(
      JSON.stringify({ v: ArchiveVertical.EAST_SEA, o: 1500 }),
      "utf8",
    ).toString("base64url");

    const result = await service.getDigest("org-1", {
      anchorDate: new Date("2025-05-28T00:00:00.000Z"),
      region: ArchiveRegion.APAC,
      weights: [
        ArchiveWeight.ONE,
        ArchiveWeight.TWO,
        ArchiveWeight.THREE,
        ArchiveWeight.FOUR,
        ArchiveWeight.FIVE,
      ],
      pageSize: 20,
      cursors: [{ vertical: ArchiveVertical.EAST_SEA, cursor }],
    });

    const eastSeaGroup = result.groups.find(
      (group) => group.vertical === ArchiveVertical.EAST_SEA,
    );
    expect(eastSeaGroup?.items).toHaveLength(20);
    expect(eastSeaGroup?.pageInfo.hasMore).toBe(true);
    expect(eastSeaGroup?.pageInfo.nextCursor).not.toBeNull();
    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(4);
  });

  it("keeps numeric terms when tokenizing search input", () => {
    const prisma = {
      processedArticle: { findMany: jest.fn() },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const tokens = (service as any).tokenizeSearch("F-35 2025 +policy", 2);
    expect(tokens).toContain("F35");
    expect(tokens).toContain("2025");
    expect(tokens).toContain("policy");
  });

  it("paginates calendar queries and aggregates all matching rows", async () => {
    const firstBatch = Array.from({ length: 600 }, (_, index) =>
      makeRow(
        `row-${index + 1}`,
        `2025-05-${String((index % 28) + 1).padStart(2, "0")}T08:00:00.000Z`,
      ),
    );
    const secondBatch = [makeRow("row-601", "2025-05-28T08:00:00.000Z")];
    const prisma = {
      processedArticle: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(firstBatch)
          .mockResolvedValueOnce(secondBatch),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = makeArchiveClassificationServiceMock();
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const result = await service.getCalendar("org-1", {
      month: "2025-05",
      region: ArchiveRegion.APAC,
    });

    const total = result.reduce((sum, day) => sum + day.count, 0);
    expect(total).toBe(601);
    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(2);
  });

  it("uses cached hybrid vertical output when classification cache is ready", async () => {
    const eastRow = makeRow("row-east", "2025-05-28T08:00:00.000Z");
    const southRow = makeRow("row-south", "2025-05-27T08:00:00.000Z");
    const prisma = {
      processedArticle: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([eastRow, southRow])
          .mockResolvedValueOnce([]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = {
      getCachedHybridBatch: jest.fn(async (_orgId: string, inputs: any[]) =>
        new Map(
          [
            {
              processedArticleId: inputs[0].processedArticleId,
              articleId: inputs[0].articleId,
              region: ArchiveRegion.APAC,
              vertical: ArchiveVertical.EAST_SEA,
              countryCode: 'PHL',
              countryLabel: 'Philippines',
              entityTags: ['Philippines'],
              ruleScores: classifierSignalsResult.ruleScores,
              embeddingScores: createArchiveVerticalScoreMap(),
              rerankScores: createArchiveVerticalScoreMap(),
              fusedScores: {
                ...createArchiveVerticalScoreMap(),
                [ArchiveVertical.EAST_SEA]: 1,
              },
              classificationTextHash: 'hash-east',
              classificationTextVersion: 'archive-text-v1',
              taxonomyVersion: 'archive-vertical-v1',
              pipelineVersion: 'archive-hybrid-v1',
              embeddingModel: 'embedding-model',
              rerankModel: 'rerank-model',
            },
            {
              processedArticleId: inputs[1].processedArticleId,
              articleId: inputs[1].articleId,
              region: ArchiveRegion.APAC,
              vertical: ArchiveVertical.SOUTH_SEA,
              countryCode: 'PHL',
              countryLabel: 'Philippines',
              entityTags: ['Philippines'],
              ruleScores: classifierSignalsResult.ruleScores,
              embeddingScores: createArchiveVerticalScoreMap(),
              rerankScores: createArchiveVerticalScoreMap(),
              fusedScores: {
                ...createArchiveVerticalScoreMap(),
                [ArchiveVertical.SOUTH_SEA]: 1,
              },
              classificationTextHash: 'hash-south',
              classificationTextVersion: 'archive-text-v1',
              taxonomyVersion: 'archive-vertical-v1',
              pipelineVersion: 'archive-hybrid-v1',
              embeddingModel: 'embedding-model',
              rerankModel: 'rerank-model',
            },
          ].map((result) => [result.processedArticleId, result]),
        ),
      ),
      classifyHybridBatch: jest.fn(async (_orgId: string, inputs: any[]) => [
        {
          processedArticleId: inputs[0].processedArticleId,
          articleId: inputs[0].articleId,
          region: ArchiveRegion.APAC,
          vertical: ArchiveVertical.EAST_SEA,
          countryCode: 'PHL',
          countryLabel: 'Philippines',
          entityTags: ['Philippines'],
          ruleScores: classifierSignalsResult.ruleScores,
          embeddingScores: createArchiveVerticalScoreMap(),
          rerankScores: createArchiveVerticalScoreMap(),
          fusedScores: {
            ...createArchiveVerticalScoreMap(),
            [ArchiveVertical.EAST_SEA]: 1,
          },
          classificationTextHash: 'hash-east',
          classificationTextVersion: 'archive-text-v1',
          taxonomyVersion: 'archive-vertical-v1',
          pipelineVersion: 'archive-hybrid-v1',
          embeddingModel: 'embedding-model',
          rerankModel: 'rerank-model',
        },
        {
          processedArticleId: inputs[1].processedArticleId,
          articleId: inputs[1].articleId,
          region: ArchiveRegion.APAC,
          vertical: ArchiveVertical.SOUTH_SEA,
          countryCode: 'PHL',
          countryLabel: 'Philippines',
          entityTags: ['Philippines'],
          ruleScores: classifierSignalsResult.ruleScores,
          embeddingScores: createArchiveVerticalScoreMap(),
          rerankScores: createArchiveVerticalScoreMap(),
          fusedScores: {
            ...createArchiveVerticalScoreMap(),
            [ArchiveVertical.SOUTH_SEA]: 1,
          },
          classificationTextHash: 'hash-south',
          classificationTextVersion: 'archive-text-v1',
          taxonomyVersion: 'archive-vertical-v1',
          pipelineVersion: 'archive-hybrid-v1',
          embeddingModel: 'embedding-model',
          rerankModel: 'rerank-model',
        },
      ]),
    };
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const result = await service.getDigest('org-1', {
      anchorDate: new Date('2025-05-29T00:00:00.000Z'),
      region: ArchiveRegion.APAC,
      weights: [
        ArchiveWeight.ONE,
        ArchiveWeight.TWO,
        ArchiveWeight.THREE,
        ArchiveWeight.FOUR,
        ArchiveWeight.FIVE,
      ],
      limitPerVertical: 20,
    });

    expect(classifier.classifyRuleSignals).toHaveBeenCalledTimes(2);
    expect(archiveClassification.getCachedHybridBatch).toHaveBeenCalledTimes(1);
    expect(
      result.groups.find((group) => group.vertical === ArchiveVertical.EAST_SEA)?.items,
    ).toHaveLength(1);
    expect(
      result.groups.find((group) => group.vertical === ArchiveVertical.SOUTH_SEA)?.items,
    ).toHaveLength(1);
  });

  it("surfaces failed preparation when digest enqueue does not succeed", async () => {
    const row = makeRow("row-missing", "2025-05-28T08:00:00.000Z");
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = {
      getCachedHybridBatch: jest.fn().mockResolvedValue(new Map()),
      classifyHybridBatch: jest.fn(),
    };
    const archivePreparationQueue = {
      ensureDigestCoverage: jest
        .fn()
        .mockRejectedValue(new Error("BullMQ unavailable")),
      ensureCalendarCoverage: jest.fn().mockResolvedValue(undefined),
      getDigestStatus: jest.fn().mockResolvedValue(null),
    };
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      archivePreparationQueue as any,
    );

    const result = await service.getDigest("org-1", {
      anchorDate: new Date("2025-05-29T00:00:00.000Z"),
      region: ArchiveRegion.APAC,
      weights: [
        ArchiveWeight.ONE,
        ArchiveWeight.TWO,
        ArchiveWeight.THREE,
        ArchiveWeight.FOUR,
        ArchiveWeight.FIVE,
      ],
      limitPerVertical: 20,
    });

    expect(archivePreparationQueue.ensureDigestCoverage).toHaveBeenCalledWith(
      "org-1",
      "2025-05-29",
    );
    expect(result.preparation.state).toBe(ArchivePreparationState.FAILED);
    expect(result.preparation.errorMessage).toBe("BullMQ unavailable");
  });

  it("returns classification detail in archive detail when cached classification exists", async () => {
    const row = makeRow("row-detail", "2025-05-28T08:00:00.000Z");
    const prisma = {
      processedArticle: {
        findFirst: jest.fn().mockResolvedValue({
          ...row,
          article: {
            id: row.article.id,
            url: row.article.url,
            sourceLabel: row.article.sourceLabel,
            crawlAt: row.article.crawlAt,
          },
        }),
      },
      newsEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = {
      getCachedHybridBatch: jest.fn().mockResolvedValue(
        new Map([
          [
            row.id,
            {
              processedArticleId: row.id,
              articleId: row.article.id,
              region: ArchiveRegion.APAC,
              vertical: ArchiveVertical.EAST_SEA,
              countryCode: "PHL",
              countryLabel: "Philippines",
              entityTags: ["Philippines"],
              ruleScores: classifierSignalsResult.ruleScores,
              embeddingScores: createArchiveVerticalScoreMap(),
              rerankScores: createArchiveVerticalScoreMap(),
              fusedScores: {
                ...createArchiveVerticalScoreMap(),
                [ArchiveVertical.EAST_SEA]: 1,
              },
              classificationTextHash: "hash-detail",
              classificationTextVersion: "archive-text-v2",
              taxonomyVersion: "archive-vertical-v2",
              pipelineVersion: "archive-hybrid-v2",
              embeddingModel: "embedding-model",
              rerankModel: "rerank-model",
            },
          ],
        ]),
      ),
      classifyHybridBatch: jest.fn(),
    };
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const result = await service.getDetail("org-1", row.id);

    expect(result?.classification?.vertical).toBe(ArchiveVertical.EAST_SEA);
    expect(result?.classification?.taxonomyVersion).toBe("archive-vertical-v2");
    expect(result?.classification?.ruleSignals).toContain("Country match: Philippines");
    expect(result?.classification?.scoreEntries).toHaveLength(5);
  });

  it("returns null classification in archive detail when cached classification is missing", async () => {
    const row = makeRow("row-detail-missing", "2025-05-28T08:00:00.000Z");
    const prisma = {
      processedArticle: {
        findFirst: jest.fn().mockResolvedValue({
          ...row,
          article: {
            id: row.article.id,
            url: row.article.url,
            sourceLabel: row.article.sourceLabel,
            crawlAt: row.article.crawlAt,
          },
        }),
      },
      newsEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const cache = makeCacheMock();
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = makeClassifierMock();
    const archiveClassification = {
      getCachedHybridBatch: jest.fn().mockResolvedValue(new Map()),
      classifyHybridBatch: jest.fn(),
    };
    const service = new ArchiveService(
      prisma as any,
      cache as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
      archiveClassification as any,
      makeArchivePreparationQueueServiceMock() as any,
    );

    const result = await service.getDetail("org-1", row.id);

    expect(result?.classification).toBeNull();
  });
});
