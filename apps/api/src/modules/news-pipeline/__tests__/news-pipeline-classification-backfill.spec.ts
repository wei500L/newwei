import { ProcessedItemModel } from "@modular/mongo";

import { NewsExtractionPipelineMode } from "../news-extraction-settings.service";
import { NewsPipelineService } from "../news-pipeline.service";
import { NewsPromptBuilder } from "../news-prompt.builder";

jest.mock(
  "@modular/vector-client",
  () => ({
    VectorBadResponseError: class VectorBadResponseError extends Error {},
    VectorClient: class VectorClient {
      search = jest.fn();
      upsert = jest.fn();
    },
    VectorServiceUnavailableError: class VectorServiceUnavailableError extends Error {},
    VectorUnauthorizedError: class VectorUnauthorizedError extends Error {},
  }),
  { virtual: true },
);

jest.mock("@modular/mongo", () => ({
  processedItemHasLocation: jest.fn(
    (result?: { location?: unknown } | null) =>
      typeof result?.location === "string" && result.location.trim().length > 0,
  ),
  CrawlResultContentModel: {
    findById: jest.fn(),
  },
  ItemReadModelModel: {
    updateOne: jest.fn(),
  },
  RawItemModel: {
    findById: jest.fn(),
  },
  TaskLogModel: {
    create: jest.fn(),
  },
  ProcessedItemModel: {
    find: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  parseDateTime: jest.requireActual("@modular/utils").parseDateTime,
}));

const makeMongoFindQuery = (docs: unknown[]) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(docs),
});

describe("NewsPipelineService classification backfill", () => {
  const promptBuilder = new NewsPromptBuilder();
  const liteLlm = {} as any;
  const configService = {
    config: {
      litellm: {},
      crawl4ai: {
        crawlerDefaults: {},
        userAgent: "Mozilla/5.0",
      },
      pipeline: {},
    },
  };
  const promptConfig = {} as any;
  const dedupeSettings = {} as any;
  const extractionSettings = {
    getSettings: jest.fn().mockResolvedValue({
      pipelineMode: NewsExtractionPipelineMode.legacy,
      preflightGate: {
        enabled: true,
        minWordCount: 120,
        rejectBotChallenge: true,
        rejectListLike: true,
      },
      postCleanGate: {
        enabled: true,
        minQualityScore: 0.35,
        minCleanedChars: 400,
        requireSummary: true,
      },
      capabilities: {
        entities: true,
        sentiment: true,
        kg: true,
      },
      providers: {
        clean: "llm",
        entities: "llm",
        sentiment: "llm",
        kg: "llm",
      },
    }),
  };
  const extractionStages = {} as any;
  const prisma = {} as any;
  const crawlExecution = {} as any;

  beforeEach(() => {
    (ProcessedItemModel.find as jest.Mock).mockReset();
    (ProcessedItemModel.updateOne as jest.Mock).mockReset();
  });

  it("reclassifies processed items when content type and taxonomy path are missing", async () => {
    const processedItemId = "507f1f77bcf86cd799439011";
    (ProcessedItemModel.find as jest.Mock).mockReturnValueOnce(
      makeMongoFindQuery([
        {
          _id: processedItemId,
          result: {
            title: "Maritime surveillance update",
            summary: "Latest reporting on regional force movements.",
            source: "Reuters",
            topics: ["security"],
            cleaned_markdown: "# Headline\nBody",
            content_type: null,
            category_path: null,
            category_method: null,
          },
        },
      ]),
    );
    (ProcessedItemModel.updateOne as jest.Mock).mockResolvedValue({
      acknowledged: true,
    });

    const classifier = {
      classify: jest.fn().mockResolvedValue({
        legacyCategory: "intel",
        categoryPath: "intel/osint/analysis",
        labels: ["intel", "osint", "analysis"],
        confidence: 0.82,
        reason: "ranked",
        method: "hybrid",
        candidates: [],
        metrics: {
          taxonomyVersion: "news-taxonomy-v1",
          llmLatencyMs: null,
          embeddingLatencyMs: null,
          rerankLatencyMs: null,
          candidateCount: 0,
          layerSuccess: {
            llm: true,
            embedding: true,
            rerank: true,
          },
        },
      }),
      applyToCleanedNews: jest.fn((cleaned, classification) => ({
        ...cleaned,
        category: classification.legacyCategory,
        category_path: classification.categoryPath,
        category_labels: classification.labels,
        category_confidence: classification.confidence,
        category_reason: classification.reason,
        category_method: classification.method,
        category_candidates: classification.candidates,
      })),
    };

    const service = new NewsPipelineService(
      liteLlm,
      configService as any,
      promptBuilder,
      promptConfig,
      dedupeSettings,
      extractionSettings,
      extractionStages,
      prisma,
      crawlExecution,
      undefined,
      undefined,
      classifier as any,
    );

    const result = await service.backfillProcessedItemClassificationSignals(
      "org-1",
      [
        {
          processedItemId,
          sourceUrl: "https://www.reuters.com/world/example",
          sourceLabel: "Reuters",
        },
      ],
    );

    expect(result).toEqual({ updatedCount: 1, skippedCount: 0 });
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(ProcessedItemModel.updateOne).toHaveBeenCalledWith(
      { _id: processedItemId, orgId: "org-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          hasLocation: false,
          result: expect.objectContaining({
            content_type: "news_fact",
            category_path: "intel/osint/analysis",
            category_method: "hybrid",
          }),
        }),
      }),
    );
  });

  it("skips processed items that already have content type and taxonomy signals", async () => {
    const processedItemId = "507f1f77bcf86cd799439012";
    (ProcessedItemModel.find as jest.Mock).mockReturnValueOnce(
      makeMongoFindQuery([
        {
          _id: processedItemId,
          result: {
            title: "Existing classification",
            summary: "Already classified content.",
            source: "Reuters",
            topics: ["security"],
            cleaned_markdown: "# Headline\nBody",
            content_type: "news_fact",
            category_path: "tech/ai/model-release",
            category_method: "hybrid",
          },
        },
      ]),
    );

    const classifier = {
      classify: jest.fn(),
      applyToCleanedNews: jest.fn(),
    };

    const service = new NewsPipelineService(
      liteLlm,
      configService as any,
      promptBuilder,
      promptConfig,
      dedupeSettings,
      extractionSettings,
      extractionStages,
      prisma,
      crawlExecution,
      undefined,
      undefined,
      classifier as any,
    );

    const result = await service.backfillProcessedItemClassificationSignals(
      "org-1",
      [
        {
          processedItemId,
          sourceUrl: "https://www.reuters.com/world/example",
          sourceLabel: "Reuters",
        },
      ],
    );

    expect(result).toEqual({ updatedCount: 0, skippedCount: 1 });
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(ProcessedItemModel.updateOne).not.toHaveBeenCalled();
  });
});
