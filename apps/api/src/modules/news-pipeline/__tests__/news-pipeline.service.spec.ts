
import { RawItemModel, TaskLogModel, ProcessedItemModel } from "@modular/mongo";
import { createHash } from "crypto";

import type { Crawl4aiResponse } from "../../crawl/crawl4ai.client";
import type { NewsPipelineConfig } from "../news-pipeline.config";
import { NormalizedNewsPayloadSchema } from "../news-pipeline.schema";
import { NewsPipelineService } from "../news-pipeline.service";
import type { PipelineJobContext, RawPipelineItem } from "../news-pipeline.types";
import { DEFAULT_NEWS_PROMPT_CONFIG } from "../news-prompt-config.service";
import { NewsPromptBuilder } from "../news-prompt.builder";

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn().mockResolvedValue(undefined)
  },
  RawItemModel: {
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null)
    })
  },
  ProcessedItemModel: {
    findOneAndUpdate: jest.fn().mockResolvedValue({
      _id: { toString: () => "processed-id" },
      toJSON: () => ({ id: "processed-id" })
    }),
    create: jest.fn(),
    find: jest.fn(),
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null)
    })
  }
}));

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  };
});

const baseConfig: NewsPipelineConfig = {
  litellm: {
    model: "openai/gpt-4o-mini",
    embeddingModel: "openai/text-embedding-3-small",
    apiBase: "http://localhost:4001",
    apiKey: "test",
    timeoutMs: 60000,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 1_200,
    maxRetries: 2,
    fallbackModels: [],
    requestsPerMinute: 100,
    stream: false,
    responseFormat: "json_schema"
  },
  crawl4ai: {
    userAgent: "Mozilla/5.0",
    maxConcurrent: 2,
    timeoutMs: 120000,
    keywordMatchThreshold: 0.5,
    markdown: undefined,
    cleanMarkdown: undefined,
    virtualScroll: undefined,
    crawlerDefaults: {}
  },
  pipeline: {
    cacheTtlSeconds: 3600,
    maxInputChars: 10_000,
    summaryMaxTokens: 256,
    rateLimitWindowSeconds: 60,
    allowMediaEmbedding: true,
    detectLanguage: true,
    summaryDedupEnabled: true,
    summaryDedupThreshold: 0.9,
    summaryDedupLookbackHours: 48,
    summaryDedupMaxCandidates: 100,
    summaryDedupMinChars: 40,
    configPath: "config/news-pipeline.config.yaml"
  }
};

describe("NewsPipelineService", () => {
  const promptBuilder = new NewsPromptBuilder();

  const flushOutbox = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const crawlClient = {
    crawl: jest.fn(async () => {
      const response: Crawl4aiResponse = {
        results: [
          {
            url: "https://example.com/story",
            markdown: "# Headline\nBody paragraph",
            metadata: { title: "Headline" },
            publishedAt: "2024-01-01T00:00:00Z",
            success: true
          }
        ]
      };
      return response;
    })
  };

  const liteLlm = {
    acompletion: jest.fn(async () => ({
      id: "cmpl",
      model: "openai/gpt-4o-mini",
      created: Date.now(),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 80,
        total_tokens: 180
      },
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              title: "Clean Headline",
              subtitle: null,
              author: null,
              source: "Example",
              published_at: "2024-01-01T00:00:00Z",
              language: "en",
              location: null,
              category: null,
              topics: ["news"],
              summary: "Clean body",
              key_points: ["Clean body"],
              entities: [],
              cleaned_markdown: "Clean body",
              removed_noise_types: [],
              quality_score: 0.9,
              llm_model: "openai/gpt-4o-mini",
              llm_prompt_version: "v1"
            })
          }
        }
      ]
    })),
    embedding: jest.fn(async () => ({
      model: "openai/text-embedding-3-small",
      data: [{ index: 0, embedding: [1, 0, 0] }]
    }))
  };

  const cache: any = {};
  cache.get = jest.fn().mockResolvedValue(null);
  cache.set = jest.fn().mockResolvedValue(undefined);
  cache.del = jest.fn().mockResolvedValue(undefined);
  cache.wrap = jest.fn(async (key: string, ttlSeconds: number, fn: () => Promise<any>) => {
    const value = await fn();
    await cache.set(key, value, ttlSeconds);
    return value;
  });

  const promptConfigService = {
    getConfig: jest.fn().mockResolvedValue(DEFAULT_NEWS_PROMPT_CONFIG)
  };

  const configService = {
    get config() {
      return baseConfig;
    }
  };

  const mongoOutbox = {
    create: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn()
  };

  const prisma: any = {
    processedArticle: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(null)
    },
    article: {
      upsert: jest.fn().mockResolvedValue({ id: "article-1" })
    },
    itemMeta: {
      findUnique: jest.fn().mockResolvedValue({
        id: "meta-1",
        orgId: "org-1",
        createdAt: new Date("2024-01-01T00:00:00Z"),
        publishedAt: null
      }),
      update: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    mongoOutbox,
    runInTransaction: jest.fn()
  };

  prisma.runInTransaction.mockImplementation(async (cb: any) =>
    cb({
      article: prisma.article,
      processedArticle: prisma.processedArticle,
      mongoOutbox
    })
  );

  const service = new NewsPipelineService(
    crawlClient as any,
    liteLlm as any,
    configService as any,
    promptBuilder,
    promptConfigService as any,
    cache as any,
    prisma as any
  );

  const rawItemId = "507f1f77bcf86cd799439011";

  const job: PipelineJobContext = {
    queue: "itemPipeline",
    jobId: "job-1",
    itemMetaId: "meta-1",
    rawItemId,
    orgId: "org-1"
  };

  const raw: RawPipelineItem = {
    id: rawItemId,
    itemMetaId: "meta-1",
    payload: {
      url: "https://example.com/story",
      keywords: ["AI"],
      tags: ["breaking"]
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    baseConfig.pipeline.summaryDedupMinChars = 40;
    baseConfig.pipeline.summaryDedupThreshold = 0.9;
    (prisma.processedArticle.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.article.upsert as jest.Mock).mockResolvedValue({ id: "article-1" });
    (prisma.processedArticle.upsert as jest.Mock).mockResolvedValue(null);
    prisma.runInTransaction.mockImplementation(async (cb: any) =>
      cb({
        article: prisma.article,
        processedArticle: prisma.processedArticle,
        mongoOutbox
      })
    );
    mongoOutbox.create.mockResolvedValue({ id: "outbox-1", attempts: 0 });
    mongoOutbox.updateMany.mockResolvedValue({ count: 1 });
    mongoOutbox.findUnique.mockResolvedValue({ id: "outbox-1", attempts: 1 });
    mongoOutbox.delete.mockResolvedValue(undefined);
    mongoOutbox.findMany.mockResolvedValue([]);
    mongoOutbox.update.mockResolvedValue(undefined);
    (ProcessedItemModel.findById as jest.Mock).mockReturnValue({
      lean: jest.fn().mockResolvedValue(null)
    });
    (RawItemModel.findById as jest.Mock).mockReturnValue({
      lean: jest.fn().mockResolvedValue(null)
    });
    const findChain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([])
    };
    (ProcessedItemModel.find as jest.Mock).mockReturnValue(findChain);
  });

  afterEach(async () => {
    const retryTimers = (service as any).outboxRetryTimers as Map<
      string,
      ReturnType<typeof setTimeout>
    >;
    if (!retryTimers) {
      return;
    }
    for (const timer of retryTimers.values()) {
      clearTimeout(timer);
    }
    retryTimers.clear();

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("processes a raw item by crawling and cleaning content", async () => {
    await service.process(job, raw);
    await flushOutbox();

    expect(crawlClient.crawl).toHaveBeenCalledTimes(1);
    expect(liteLlm.acompletion).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(promptConfigService.getConfig).toHaveBeenCalledTimes(1);
    expect(prisma.mongoOutbox.create).toHaveBeenCalledTimes(1);
    expect(prisma.mongoOutbox.delete).toHaveBeenCalledTimes(1);
    expect(prisma.runInTransaction).toHaveBeenCalledTimes(2);
  });

  it("reuses existing processed article when content hash matches", async () => {
    const contentHash = createHash("sha256")
      .update("# Headline\nBody paragraph")
      .digest("hex");
    const processedArticle = {
      id: "processed-article-1",
      articleId: "article-1",
      article: {
        id: "article-1",
        orgId: "org-1",
        sourceId: null,
        url: "https://example.com/story?ref=news",
        sourceLabel: "Example",
        language: "en",
        titleGuess: null,
        crawlAt: new Date("2024-01-01T00:00:00Z"),
        contentHash,
        markdownRef: null,
        version: 1,
        metadata: {},
        createdAt: new Date("2024-01-01T00:00:00Z"),
        updatedAt: new Date("2024-01-01T00:00:00Z")
      },
      title: "Existing title",
      subtitle: null,
      author: "Reporter",
      source: "Example",
      publishedAt: new Date("2024-01-01T00:00:00Z"),
      category: null,
      topics: ["news"],
      summary: "Existing summary",
      keyPoints: ["Existing summary"],
      entities: [{ name: "Reporter", type: "Person", confidence: 0.9 }],
      cleanedMarkdownRef: "processed-id",
      removedNoiseTypes: [],
      qualityScore: 0.9,
      llmModel: "openai/gpt-4o-mini",
      llmPromptVersion: "v1",
      language: "en",
      location: "US",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
      latencyMs: 80,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      processedAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z")
    };
    (prisma.processedArticle.findFirst as jest.Mock).mockResolvedValueOnce(
      processedArticle
    );
    (ProcessedItemModel.findById as jest.Mock).mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        result: {
          title: "Existing title",
          subtitle: null,
          author: "Reporter",
          source: "Example",
          published_at: "2024-01-01T00:00:00Z",
          language: "en",
          location: "US",
          category: null,
          topics: ["news"],
          summary: "Existing summary",
          key_points: ["Existing summary"],
          entities: [{ name: "Reporter", type: "Person", confidence: 0.9 }],
          cleaned_markdown: "Clean body from cache",
          removed_noise_types: [],
          quality_score: 0.9,
          llm_model: "openai/gpt-4o-mini",
          llm_prompt_version: "v1"
        }
      })
    });

    await service.process(job, raw);
    await flushOutbox();

    expect(liteLlm.acompletion).not.toHaveBeenCalled();
    expect(prisma.article.upsert).not.toHaveBeenCalled();
    expect(prisma.processedArticle.upsert).not.toHaveBeenCalled();
    expect(ProcessedItemModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(prisma.mongoOutbox.create).toHaveBeenCalledTimes(1);
    expect(prisma.mongoOutbox.delete).toHaveBeenCalledTimes(1);
    expect(prisma.runInTransaction).toHaveBeenCalledTimes(2);
  });

  it("marks item meta as duplicate when summary similarity is high", async () => {
    baseConfig.pipeline.summaryDedupMinChars = 1;
    baseConfig.pipeline.summaryDedupThreshold = 0.8;

    const duplicateId = "64b5f0c4f6e4b0495c3f4a10";
    (liteLlm.embedding as jest.Mock).mockResolvedValueOnce({
      model: "openai/text-embedding-3-small",
      data: [{ index: 0, embedding: [1, 0] }]
    });

    const findChain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: duplicateId, summaryEmbedding: [0.99, 0.01] }
      ])
    };
    (ProcessedItemModel.find as jest.Mock).mockReturnValueOnce(findChain);

    await service.process(job, raw);
    await flushOutbox();

    expect(prisma.itemMeta.update).toHaveBeenCalledWith({
      where: { id: job.itemMetaId },
      data: { status: "duplicate" }
    });
  });

  it("fails fast when existing processed article cannot be mapped", async () => {
    const contentHash = createHash("sha256")
      .update("# Headline\nBody paragraph")
      .digest("hex");
    (prisma.processedArticle.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "processed-article-2",
      articleId: "article-1",
      article: {
        id: "article-1",
        orgId: "org-1",
        sourceId: null,
        url: "https://example.com/story?ref=news",
        sourceLabel: "Example",
        language: "en",
        titleGuess: null,
        crawlAt: new Date("2024-01-01T00:00:00Z"),
        contentHash,
        markdownRef: null,
        version: 1,
        metadata: {},
        createdAt: new Date("2024-01-01T00:00:00Z"),
        updatedAt: new Date("2024-01-01T00:00:00Z")
      },
      title: "Existing title",
      subtitle: null,
      author: "Reporter",
      source: "Example",
      publishedAt: new Date("2024-01-01T00:00:00Z"),
      category: null,
      topics: ["news"],
      summary: "Existing summary",
      keyPoints: ["Existing summary"],
      entities: [{ name: "Reporter", type: "Person", confidence: 0.9 }],
      cleanedMarkdownRef: null,
      removedNoiseTypes: [],
      qualityScore: 2, // invalid to trigger mapping failure
      llmModel: "openai/gpt-4o-mini",
      llmPromptVersion: "v1",
      language: "en",
      location: "US",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
      latencyMs: 80,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      processedAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z")
    });

    await expect(service.process(job, raw)).rejects.toThrow();
    expect(liteLlm.acompletion).not.toHaveBeenCalled();

    const failureCall = (TaskLogModel.create as jest.Mock).mock.calls.find(
      ([entry]) => entry.stage === "llm" && entry.status === "failed"
    );
    expect(failureCall?.[0]).toMatchObject({
      stage: "llm",
      status: "failed",
      data: { url: "https://example.com/story", runId: null }
    });
  });

  it("throws when crawl returns no successful results", async () => {
    crawlClient.crawl.mockResolvedValueOnce({
      results: [
        { url: "https://example.com", markdown: "", success: false }
      ]
    });

    await expect(service.process(job, raw)).rejects.toThrow(
      "crawl4ai returned no successful article"
    );
  });

  it("normalizes payloads via schema parsing", () => {
    const parsed = NormalizedNewsPayloadSchema.parse({
      url: " https://example.com/news ",
      language: " en ",
      sourceName: "Example ",
      keywords: [" ai ", " "],
      tags: [" breaking "],
      summaryHints: [" focus "],
      metadata: { foo: "bar" },
      forceRefresh: "",
      crawlOptions: { userAgent: "UA" }
    });

    expect(parsed.url).toBe("https://example.com/news");
    expect(parsed.language).toBe("en");
    expect(parsed.sourceName).toBe("Example");
    expect(parsed.keywords).toEqual(["ai"]);
    expect(parsed.tags).toEqual(["breaking"]);
    expect(parsed.summaryHints).toEqual(["focus"]);
    expect(parsed.forceRefresh).toBe(false);
    expect(parsed.crawlOptions).toEqual({ userAgent: "UA" });
  });

  it("logs failed stage when LLM cleaning fails", async () => {
    const error = new Error("LLM unavailable");
    liteLlm.acompletion.mockRejectedValueOnce(error);

    await expect(service.process(job, raw)).rejects.toThrow("LLM unavailable");

    const llmProcessingCall = (TaskLogModel.create as jest.Mock).mock.calls.find(
      ([entry]) => entry.stage === "llm" && entry.status === "processing"
    );

    expect(llmProcessingCall?.[0]).toMatchObject({
      stage: "llm",
      status: "processing",
      data: { url: "https://example.com/story", runId: null }
    });

    const llmFailureCall = (TaskLogModel.create as jest.Mock).mock.calls.find(
      ([entry]) => entry.stage === "llm" && entry.status === "failed"
    );

    expect(llmFailureCall?.[0]).toMatchObject({
      stage: "llm",
      status: "failed",
      data: { url: "https://example.com/story", runId: null },
      error: { message: "LLM unavailable" }
    });
  });

  it("marks invalid outbox payloads as failed without writing Mongo", async () => {
    const updateSpy = mongoOutbox.update as jest.Mock;
    mongoOutbox.findMany.mockResolvedValueOnce([
      {
        id: "outbox-invalid",
        payload: {},
        status: "pending",
        attempts: 2,
        availableAt: new Date(),
        lockedAt: null
      }
    ]);

    await service.retryPendingOutbox();

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-invalid" },
        data: expect.objectContaining({
          status: "failed",
          attempts: 3,
          lockedAt: null,
          availableAt: expect.any(Date)
        })
      })
    );
    expect(ProcessedItemModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("replays stale locked outbox entry to Mongo and deletes it", async () => {
    const staleLockedAt = new Date(Date.now() - 10 * 60 * 1000);
    const validPayload = {
      type: "processed_item",
      document: {
        _id: "64b5f0c4f6e4b0495c3f4a10",
        rawItemId,
        itemMetaId: "meta-1",
        orgId: "org-1",
        status: "completed",
        tags: ["breaking"],
        result: {
          title: "Existing title",
          subtitle: null,
          author: "Reporter",
          source: "Example",
          published_at: "2024-01-01T00:00:00Z",
          language: "en",
          location: "US",
          category: null,
          topics: ["news"],
          summary: "Existing summary",
          key_points: ["Existing summary"],
          entities: [{ name: "Reporter", type: "Person", confidence: 0.9 }],
          cleaned_markdown: "Clean body from cache",
          removed_noise_types: [],
          quality_score: 0.9,
          llm_model: "openai/gpt-4o-mini",
          llm_prompt_version: "v1"
        },
        llm: {
          model: "openai/gpt-4o-mini",
          promptVersion: "v1",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.01,
          latencyMs: 80
        },
        error: undefined
      }
    };

    mongoOutbox.findMany.mockResolvedValueOnce([
      {
        id: "outbox-stale",
        payload: validPayload,
        status: "processing",
        attempts: 1,
        availableAt: new Date(),
        lockedAt: staleLockedAt
      }
    ]);
    mongoOutbox.updateMany.mockResolvedValueOnce({ count: 1 });
    mongoOutbox.findUnique.mockResolvedValueOnce({
      id: "outbox-stale",
      attempts: 1
    });
    const upsertSpy = ProcessedItemModel.findOneAndUpdate as jest.Mock;
    upsertSpy.mockResolvedValueOnce({
      _id: { toString: () => validPayload.document._id },
      toJSON: () => ({ id: validPayload.document._id })
    });

    await service.retryPendingOutbox();

    expect(mongoOutbox.delete).toHaveBeenCalledWith({ where: { id: "outbox-stale" } });
    const updateArgs = upsertSpy.mock.calls[0]?.[1] as { $set?: Record<string, unknown> } | undefined;
    expect(updateArgs?.$set).toEqual(
      expect.objectContaining({
        rawItemId: expect.anything(),
        result: expect.objectContaining({
          title: "Existing title",
          published_at: "2024-01-01T00:00:00.000Z"
        })
      })
    );
  });

  it("sanitizes dirty outbox payload fields via schema parsing", async () => {
    const staleLockedAt = new Date(Date.now() - 10 * 60 * 1000);
    const dirtyPayload = {
      type: "processed_item",
      document: {
        _id: "64b5f0c4f6e4b0495c3f4a10",
        rawItemId,
        itemMetaId: "meta-1",
        orgId: "org-1",
        status: "completed",
        result: {
          title: "Existing title",
          subtitle: null,
          author: "Reporter",
          source: "Example",
          published_at: "2024-01-01T00:00:00Z",
          language: "en",
          location: "US",
          category: null,
          topics: ["news"],
          summary: "Existing summary",
          key_points: ["Existing summary"],
          entities: [{ name: "Reporter", type: "Person", confidence: 0.9 }],
          cleaned_markdown: "Clean body from cache",
          removed_noise_types: [],
          quality_score: 0.9,
          llm_model: "openai/gpt-4o-mini",
          llm_prompt_version: "v1"
        },
        llm: {
          model: "openai/gpt-4o-mini",
          promptVersion: "v1",
          promptTokens: "10",
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.01,
          latencyMs: 80
        }
      }
    };

    mongoOutbox.findMany.mockResolvedValueOnce([
      {
        id: "outbox-dirty",
        payload: dirtyPayload,
        status: "processing",
        attempts: 1,
        availableAt: new Date(),
        lockedAt: staleLockedAt
      }
    ]);
    mongoOutbox.updateMany.mockResolvedValueOnce({ count: 1 });
    mongoOutbox.findUnique.mockResolvedValueOnce({
      id: "outbox-dirty",
      attempts: 1
    });

    await service.retryPendingOutbox();

    expect(mongoOutbox.delete).toHaveBeenCalledWith({ where: { id: "outbox-dirty" } });
    const updateArgs = (ProcessedItemModel.findOneAndUpdate as jest.Mock).mock.calls[0]?.[1];
    expect(updateArgs.$set.tags).toEqual([]);
    expect(updateArgs.$set.llm.promptTokens).toBeNull();
  });
});
