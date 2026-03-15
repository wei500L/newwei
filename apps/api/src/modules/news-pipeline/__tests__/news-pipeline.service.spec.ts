import { RawItemModel, TaskLogModel, ProcessedItemModel } from "@modular/mongo";
import { createHash } from "crypto";

import type { NewsPipelineConfig } from "../news-pipeline.config";
import { NormalizedNewsPayloadSchema } from "../news-pipeline.schema";
import { NewsPipelineService } from "../news-pipeline.service";
import type {
  PipelineJobContext,
  RawPipelineItem,
} from "../news-pipeline.types";
import { DEFAULT_NEWS_PROMPT_CONFIG } from "../news-prompt-config.service";
import { NewsPromptBuilder } from "../news-prompt.builder";

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn().mockResolvedValue(undefined),
  },
  CrawlResultContentModel: {
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    }),
  },
  RawItemModel: {
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    }),
  },
  ProcessedItemModel: {
    findOneAndUpdate: jest.fn().mockResolvedValue({
      _id: { toString: () => "processed-id" },
      toJSON: () => ({ id: "processed-id" }),
    }),
    create: jest.fn(),
    find: jest.fn(),
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    }),
  },
}));

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  };
});

const baseConfig: NewsPipelineConfig = {
  litellm: {
    model: "openai/gpt-4o-mini",
    embeddingModel: "openai/text-embedding-3-small",
    rerankModel: "cohere/rerank-v3.5",
    rerankFallbackModels: [],
    apiBase: "http://localhost:4001",
    apiKey: "test",
    timeoutMs: 60000,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 1_200,
    maxRetries: 2,
    fallbackModels: [],
    stream: false,
    responseFormat: "json_schema",
  },
  crawl4ai: {
    userAgent: "Mozilla/5.0",
    maxConcurrent: 2,
    timeoutMs: 120000,
    keywordMatchThreshold: 0.5,
    markdown: undefined,
    cleanMarkdown: undefined,
    virtualScroll: undefined,
    crawlerDefaults: {},
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
    configPath: "config/news-pipeline.config.yaml",
  },
};

describe("NewsPipelineService", () => {
  const promptBuilder = new NewsPromptBuilder();

  const flushOutbox = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const defaultMarkdown = "# Headline\nBody paragraph";
  const defaultCrawlResultId = "crawl-result-1";
  const defaultMarkdownRef = "mongo-markdown-1";

  const crawlExecution = {
    runTask: jest.fn().mockResolvedValue({ inserted: 1, skipped: 0 }),
  };

  const liteLlm = {
    getEmbeddingModel: jest.fn(async () => "openai/text-embedding-3-small"),
    getCompletionTimeoutMs: jest.fn(async () => 60_000),
    acompletion: jest.fn(async () => ({
      id: "cmpl",
      model: "openai/gpt-4o-mini",
      created: Date.now(),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 80,
        total_tokens: 180,
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
              llm_prompt_version: "v1",
            }),
          },
        },
      ],
    })),
    embedding: jest.fn(async () => ({
      model: "openai/text-embedding-3-small",
      data: [{ index: 0, embedding: [1, 0, 0] }],
    })),
  };

  const promptConfigService = {
    getConfig: jest.fn().mockResolvedValue(DEFAULT_NEWS_PROMPT_CONFIG),
  };

  const dedupeSettingsService = {
    getSettings: jest.fn().mockResolvedValue({
      defaultThreshold: baseConfig.pipeline.summaryDedupThreshold,
      scopedThresholds: [],
      useEmbeddings: true,
      llmJudgeInstructions: null,
      llmJudgeModel: null,
      llmJudgeMaxComparisons: 12,
      llmJudgeCandidateChars: 1200,
      llmJudgePromptVersion: "news-dedupe-judge-v1",
      llmJudgeSystemPromptTemplate: "system prompt",
      llmJudgeUserPromptTemplate: "user prompt",
    }),
    resolveBaseThreshold: jest.fn((settings: any) => ({
      threshold: settings.defaultThreshold,
    })),
  };

  const configService = {
    get config() {
      return baseConfig;
    },
  };

  const mongoOutbox = {
    create: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  };

  const prisma: any = {
    processedArticle: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(null),
    },
    article: {
      upsert: jest.fn().mockResolvedValue({ id: "article-1" }),
    },
    membership: {
      findFirst: jest.fn().mockResolvedValue({ userId: "user-1" }),
    },
    crawlTask: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "crawl-task-1" }),
      update: jest.fn().mockResolvedValue({ id: "crawl-task-1" }),
    },
    crawlResult: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    itemMeta: {
      findUnique: jest.fn().mockResolvedValue({
        id: "meta-1",
        orgId: "org-1",
        name: "Example: https://example.com/story",
        createdAt: new Date("2024-01-01T00:00:00Z"),
        publishedAt: null,
      }),
      update: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    mongoOutbox,
    runInTransaction: jest.fn(),
  };

  prisma.runInTransaction.mockImplementation(async (cb: any) =>
    cb({
      article: prisma.article,
      processedArticle: prisma.processedArticle,
      mongoOutbox,
    }),
  );

  const service = new NewsPipelineService(
    liteLlm as any,
    configService as any,
    promptBuilder,
    promptConfigService as any,
    dedupeSettingsService as any,
    prisma as any,
    crawlExecution as any,
  );

  const rawItemId = "507f1f77bcf86cd799439011";

  const job: PipelineJobContext = {
    queue: "itemPipeline",
    jobId: "job-1",
    itemMetaId: "meta-1",
    rawItemId,
    orgId: "org-1",
  };

  const raw: RawPipelineItem = {
    id: rawItemId,
    itemMetaId: "meta-1",
    payload: {
      url: "https://example.com/story",
      keywords: ["AI"],
      tags: ["breaking"],
    },
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
        mongoOutbox,
      }),
    );
    mongoOutbox.create.mockResolvedValue({ id: "outbox-1", attempts: 0 });
    mongoOutbox.updateMany.mockResolvedValue({ count: 1 });
    mongoOutbox.findUnique.mockResolvedValue({ id: "outbox-1", attempts: 1 });
    mongoOutbox.delete.mockResolvedValue(undefined);
    mongoOutbox.findMany.mockResolvedValue([]);
    mongoOutbox.update.mockResolvedValue(undefined);
    (ProcessedItemModel.findById as jest.Mock).mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    (RawItemModel.findById as jest.Mock).mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const { CrawlResultContentModel } = jest.requireMock("@modular/mongo") as {
      CrawlResultContentModel: { findById: jest.Mock };
    };

    const defaultContentHash = createHash("sha256")
      .update(defaultMarkdown)
      .digest("hex");
    prisma.crawlResult.findFirst.mockImplementation(async (args: any) => {
      if (args?.where?.id) {
        return {
          id: defaultCrawlResultId,
          sourceUrl: "https://example.com/story",
          fetchedAt: new Date("2024-01-01T00:00:00Z"),
          markdownRef: defaultMarkdownRef,
          contentHash: defaultContentHash,
          metadata: { title: "Headline" },
        };
      }

      if (args?.where?.taskId) {
        return { id: defaultCrawlResultId };
      }

      return null;
    });

    CrawlResultContentModel.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        markdown: defaultMarkdown,
        markdownWithCitations: null,
        referencesMarkdown: null,
        crawlRunId: null,
        metadata: { title: "Headline" },
      }),
    });
    const findChain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
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

    expect(prisma.crawlTask.create).toHaveBeenCalledTimes(1);
    expect(crawlExecution.runTask).toHaveBeenCalledTimes(1);
    expect(liteLlm.acompletion).toHaveBeenCalledTimes(1);
    expect(promptConfigService.getConfig).toHaveBeenCalledTimes(1);
    expect(prisma.mongoOutbox.create).toHaveBeenCalledTimes(1);
    expect(prisma.mongoOutbox.delete).toHaveBeenCalledTimes(1);
    expect(prisma.runInTransaction).toHaveBeenCalledTimes(2);
  });

  it("rejects llm extraction settings inside crawl options", () => {
    expect(() =>
      (service as any).buildCrawlTaskOptions({
        url: "https://example.com/story",
        language: null,
        sourceName: "Example",
        keywords: [],
        tags: [],
        summaryHints: [],
        metadata: {},
        forceRefresh: false,
        crawlOptions: {
          markdownStrategy: {
            type: "LLMExtractionStrategy",
          },
        },
      }),
    ).toThrow("crawl stage must only fetch and store cleaned markdown");
  });

  it("prefers richer stored markdown when summary markdown is too short", () => {
    const selected = (service as any).selectBestMarkdownFromContentDoc({
      markdown: "# Digest\n- one\n- two",
      rawMarkdown:
        "# Full article\n\n" +
        "Detailed paragraph with facts and context.\n".repeat(120),
      markdownWithCitations:
        "Verification Required\nPlease enable JS and disable any ad blocker",
    });

    expect(typeof selected).toBe("string");
    expect((selected as string).startsWith("# Full article")).toBe(true);
    expect((selected as string).length).toBeGreaterThan(2000);
  });

  it("builds LLM markdown with citations and references when available", () => {
    const prepared = (service as any).buildMarkdownForLlm(
      {
        sourceUrl: "https://example.com/story",
        markdown: "# Story\n\nParagraph one.",
        markdownWithCitations: "# Story[^1]\n\nParagraph one with citation.",
        referencesMarkdown: "[^1]: https://example.com/source",
        metadata: {},
        publishedAt: null,
        runId: null,
        fetchedAt: "2024-01-01T00:00:00.000Z",
        contentHash: "hash-1",
      },
      10_000,
    );

    expect(prepared.source).toBe("citations");
    expect(prepared.referencesAppended).toBe(true);
    expect(prepared.markdown).toContain("[^1]: https://example.com/source");
  });

  it("keeps primary markdown when citations variant is anti-bot challenge", () => {
    const prepared = (service as any).buildMarkdownForLlm(
      {
        sourceUrl: "https://example.com/story",
        markdown: "# Headline\n\nNormal article body with context.",
        markdownWithCitations:
          "Verification Required\nPlease enable JS and disable any ad blocker",
        referencesMarkdown: null,
        metadata: {},
        publishedAt: null,
        runId: null,
        fetchedAt: "2024-01-01T00:00:00.000Z",
        contentHash: "hash-2",
      },
      10_000,
    );

    expect(prepared.source).toBe("primary");
    expect(prepared.markdown).toContain("# Headline");
  });

  it("prefers raw markdown when fit markdown is over-pruned", () => {
    const prepared = (service as any).buildMarkdownForLlm(
      {
        sourceUrl: "https://example.com/story",
        markdown: "# Digest\n\nShort summary.",
        rawMarkdown:
          "# Full Story\n\n" +
          "This paragraph carries substantial reporting context.\n".repeat(120),
        fitMarkdown: "# Fit\n\nTiny fragment.",
        markdownWithCitations: null,
        referencesMarkdown: null,
        metadata: {},
        publishedAt: null,
        runId: null,
        fetchedAt: "2024-01-01T00:00:00.000Z",
        contentHash: "hash-raw",
      },
      12_000,
    );

    expect(prepared.variant).toBe("raw");
    expect(prepared.markdown.startsWith("# Full Story")).toBe(true);
    expect(prepared.markdown.length).toBeGreaterThan(3000);
  });

  it("extracts relative markdown links as detail candidates", () => {
    const candidates = (service as any).extractDetailLinkCandidates({
      sourceUrl: "https://jp.reuters.com/world/",
      markdown:
        "# world\n" +
        "- [Detail](/world/us/HR4DZXQ265MXDBOFDVZM3QUIVA-2026-02-06/)\n" +
        "- [External](https://www.reuters.com/world/us/HR4DZXQ265MXDBOFDVZM3QUIVA-2026-02-06/)\n",
      markdownWithCitations: null,
      referencesMarkdown: null,
      metadata: {},
      publishedAt: null,
      runId: null,
      fetchedAt: "2024-01-01T00:00:00.000Z",
      contentHash: "hash-relative",
    });

    expect(candidates).toEqual([
      "https://jp.reuters.com/world/us/HR4DZXQ265MXDBOFDVZM3QUIVA-2026-02-06/",
    ]);
  });

  it("extracts detail article candidates from references markdown", () => {
    const candidates = (service as any).extractDetailLinkCandidates({
      sourceUrl: "https://jp.reuters.com/world/",
      markdown: "# world",
      markdownWithCitations: null,
      referencesMarkdown:
        "## References\n" +
        "⟨1⟩ https://jp.reuters.com/world/us/: US section\n" +
        "⟨2⟩ https://jp.reuters.com/world/us/HR4DZXQ265MXDBOFDVZM3QUIVA-2026-02-06/: detail\n" +
        "⟨3⟩ https://www.reuters.com/resizer/v2/AAABBB.jpg: image\n",
      metadata: {},
      publishedAt: null,
      runId: null,
      fetchedAt: "2024-01-01T00:00:00.000Z",
      contentHash: "hash-3",
    });

    expect(candidates).toEqual([
      "https://jp.reuters.com/world/us/HR4DZXQ265MXDBOFDVZM3QUIVA-2026-02-06/",
    ]);
  });

  it("throws explicit error when list-like markdown has no detail candidates", async () => {
    await expect(
      (service as any).expandListLikeArticle({
        job,
        payload: {
          url: "https://jp.reuters.com/world/",
          language: null,
          sourceName: null,
          keywords: [],
          tags: [],
          summaryHints: [],
          metadata: {},
          forceRefresh: false,
          crawlOptions: {},
        },
        article: {
          sourceUrl: "https://jp.reuters.com/world/",
          markdown:
            "# world\n\n" +
            "- [US](https://jp.reuters.com/world/us/)\n".repeat(40),
          markdownWithCitations: null,
          referencesMarkdown: null,
          metadata: {},
          publishedAt: null,
          runId: null,
          fetchedAt: "2024-01-01T00:00:00.000Z",
          contentHash: "hash-4",
        },
      }),
    ).rejects.toThrow("no detail candidate URLs were extracted");
  });

  it("selects non-challenge crawl result when preferred source is blocked", async () => {
    const { CrawlResultContentModel } = jest.requireMock("@modular/mongo") as {
      CrawlResultContentModel: { findById: jest.Mock };
    };

    prisma.crawlResult.findMany = jest.fn().mockResolvedValue([
      {
        id: "preferred",
        sourceUrl: "https://www.reuters.com/world/",
        markdownRef: "md-blocked",
      },
      {
        id: "alt",
        sourceUrl: "https://jp.reuters.com/world/",
        markdownRef: "md-usable",
      },
    ]);

    CrawlResultContentModel.findById.mockImplementation((id: string) => ({
      lean: jest.fn().mockResolvedValue(
        id === "md-blocked"
          ? {
              markdown:
                "Verification Required\nPlease enable JS and disable any ad blocker",
            }
          : {
              markdown:
                "# Usable story\n\n" +
                "Paragraph with meaningful context and facts.\n".repeat(80),
            },
      ),
    }));

    const selected = await (service as any).selectBestPipelineCrawlResultId({
      orgId: "org-1",
      crawlTaskId: "crawl-task-1",
      preferredResultId: "preferred",
      preferredSourceUrl: "https://www.reuters.com/world/",
    });

    expect(selected).toBe("alt");
  });

  it("falls back to crawled markdown when LLM omits cleaned_markdown", async () => {
    (liteLlm.acompletion as jest.Mock).mockResolvedValueOnce({
      id: "cmpl",
      model: "openai/gpt-4o-mini",
      created: Date.now(),
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
              removed_noise_types: [],
              quality_score: 0.9,
              llm_model: "openai/gpt-4o-mini",
              llm_prompt_version: "v1",
            }),
          },
        },
      ],
    });

    await service.process(job, raw);
    await flushOutbox();

    const createArgs = (prisma.mongoOutbox.create as jest.Mock).mock
      .calls[0]?.[0];
    const payload = createArgs?.data?.payload as any;
    expect(payload.document.result.cleaned_markdown).toBe(
      "# Headline\nBody paragraph",
    );
    expect(payload.document.result.cleaned_markdown_source).toBe(
      "crawl_fallback",
    );
    expect(payload.document.result.content_type).toBe("news_fact");
  });

  it("uses stored crawl results when crawlResultId is provided", async () => {
    const { CrawlResultContentModel } = jest.requireMock("@modular/mongo") as {
      CrawlResultContentModel: { findById: jest.Mock };
    };

    prisma.crawlResult.findFirst.mockResolvedValueOnce({
      id: "crawl-result-1",
      sourceUrl: "https://example.com/story",
      fetchedAt: new Date("2024-01-01T00:00:00Z"),
      markdownRef: "mongo-markdown-1",
      contentHash: createHash("sha256")
        .update("# Stored headline\nStored body")
        .digest("hex"),
      metadata: { title: "Stored headline" },
    });

    CrawlResultContentModel.findById.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        markdown: "# Stored headline\nStored body",
        markdownWithCitations: null,
        referencesMarkdown: null,
        crawlRunId: "crawl-run-1",
        metadata: { title: "Stored headline" },
      }),
    });

    await service.process(job, {
      ...raw,
      payload: {
        ...raw.payload,
        metadata: {
          crawlResultId: "crawl-result-1",
        },
      },
    });
    await flushOutbox();

    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
    expect(prisma.crawlTask.create).not.toHaveBeenCalled();
    expect(crawlExecution.runTask).not.toHaveBeenCalled();
    expect(liteLlm.acompletion).toHaveBeenCalledTimes(1);
    expect(prisma.crawlResult.findFirst).toHaveBeenCalledTimes(1);
    expect(CrawlResultContentModel.findById).toHaveBeenCalledTimes(1);
  });

  it("uses prefetched RSS markdown without creating crawl tasks", async () => {
    await service.process(job, {
      ...raw,
      payload: {
        ...raw.payload,
        prefetchedArticle: {
          title: "RSS headline",
          markdown: "# RSS headline\n\nRSS body content",
          publishedAt: "2026-01-01T00:00:00.000Z",
          metadata: {
            source: "rss",
            markdownSource: "content",
          },
        },
      },
    });
    await flushOutbox();

    expect(prisma.crawlResult.findFirst).not.toHaveBeenCalled();
    expect(prisma.crawlTask.create).not.toHaveBeenCalled();
    expect(crawlExecution.runTask).not.toHaveBeenCalled();
    expect(liteLlm.acompletion).toHaveBeenCalledTimes(1);
  });

  it("falls back to crawling when stored crawl result is missing", async () => {
    prisma.crawlResult.findFirst.mockResolvedValueOnce(null);

    await service.process(job, {
      ...raw,
      payload: {
        ...raw.payload,
        metadata: {
          crawlResultId: "missing-crawl-result",
        },
      },
    });
    await flushOutbox();

    expect(prisma.crawlTask.create).toHaveBeenCalledTimes(1);
    expect(crawlExecution.runTask).toHaveBeenCalledTimes(1);
  });

  it("reuses crawl execution summary reusedResultId when crawl run inserted no new rows", async () => {
    const reusedResultId = "reused-result-1";
    const reusedContentHash = createHash("sha256")
      .update("# Reused headline\nReused body")
      .digest("hex");
    crawlExecution.runTask.mockResolvedValueOnce({
      inserted: 0,
      skipped: 1,
      reusedResultId,
    });
    prisma.crawlResult.findFirst.mockReset();
    prisma.crawlResult.findFirst
      .mockResolvedValueOnce(null) // findRecentStoredCrawlResultId fingerprint match
      .mockResolvedValueOnce(null) // findRecentStoredCrawlResultId url fallback
      .mockResolvedValueOnce({ id: reusedResultId }) // crawlViaCrawlTask reusedResult lookup
      .mockResolvedValueOnce({
        // fetchStoredCrawlResult by reusedResultId
        id: reusedResultId,
        sourceUrl: "https://example.com/story",
        fetchedAt: new Date("2024-01-01T00:00:00Z"),
        markdownRef: defaultMarkdownRef,
        contentHash: reusedContentHash,
        metadata: { title: "Reused headline" },
      })
      .mockResolvedValue(null);

    const { CrawlResultContentModel } = jest.requireMock("@modular/mongo") as {
      CrawlResultContentModel: { findById: jest.Mock };
    };
    CrawlResultContentModel.findById.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        markdown: "# Reused headline\nReused body",
        markdownWithCitations: null,
        referencesMarkdown: null,
        crawlRunId: "crawl-run-reused",
        metadata: { title: "Reused headline" },
      }),
    });

    await service.process(job, raw);
    await flushOutbox();

    expect(crawlExecution.runTask).toHaveBeenCalledTimes(1);
    const hasTaskIdLookup = prisma.crawlResult.findFirst.mock.calls.some(
      ([args]: [any]) => Boolean(args?.where?.taskId),
    );
    expect(hasTaskIdLookup).toBe(false);
    expect(prisma.crawlResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: reusedResultId,
          orgId: "org-1",
        },
        select: { id: true },
      }),
    );
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
        updatedAt: new Date("2024-01-01T00:00:00Z"),
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
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    };
    (prisma.processedArticle.findFirst as jest.Mock).mockResolvedValueOnce(
      processedArticle,
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
          llm_prompt_version: "v1",
        },
      }),
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
      data: [{ index: 0, embedding: [1, 0] }],
    });

    const findChain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest
        .fn()
        .mockResolvedValue([
          { _id: duplicateId, summaryEmbedding: [0.99, 0.01] },
        ]),
    };
    (ProcessedItemModel.find as jest.Mock).mockReturnValueOnce(findChain);

    await service.process(job, raw);
    await flushOutbox();

    expect(prisma.itemMeta.update).toHaveBeenCalledWith({
      where: { id: job.itemMetaId },
      data: { status: "duplicate" },
    });
  });

  it("uses LLM dedupe when embeddings are disabled", async () => {
    baseConfig.pipeline.summaryDedupMinChars = 1;
    baseConfig.pipeline.summaryDedupThreshold = 0.8;

    dedupeSettingsService.getSettings.mockResolvedValueOnce({
      defaultThreshold: baseConfig.pipeline.summaryDedupThreshold,
      scopedThresholds: [],
      useEmbeddings: false,
      llmJudgeInstructions: null,
      llmJudgeModel: "openai/gpt-4o-mini",
      llmJudgeMaxComparisons: 5,
      llmJudgeCandidateChars: 1200,
      llmJudgePromptVersion: "news-dedupe-judge-v1",
      llmJudgeSystemPromptTemplate: "system prompt",
      llmJudgeUserPromptTemplate: "user prompt",
    });

    const duplicateId = "64b5f0c4f6e4b0495c3f4a11";
    const findChain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: duplicateId,
          result: {
            summary: "Clean body with minor edits",
            title: "Duplicate title",
          },
        },
      ]),
    };
    (ProcessedItemModel.find as jest.Mock).mockReturnValueOnce(findChain);

    const originalCompletion = await (
      liteLlm.acompletion as jest.Mock
    ).getMockImplementation()!();

    (liteLlm.acompletion as jest.Mock)
      .mockResolvedValueOnce(originalCompletion)
      .mockResolvedValueOnce({
        id: "judge",
        model: "openai/gpt-4o-mini",
        created: Date.now(),
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                similarity: 0.95,
                is_duplicate: true,
                rationale: "same event",
              }),
            },
          },
        ],
      });

    await service.process(job, raw);
    await flushOutbox();

    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(liteLlm.acompletion).toHaveBeenCalledTimes(2);
    expect(prisma.itemMeta.update).toHaveBeenCalledWith({
      where: { id: job.itemMetaId },
      data: { status: "duplicate" },
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
        updatedAt: new Date("2024-01-01T00:00:00Z"),
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
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });

    await expect(service.process(job, raw)).rejects.toThrow();
    expect(liteLlm.acompletion).not.toHaveBeenCalled();

    const failureCall = (TaskLogModel.create as jest.Mock).mock.calls.find(
      ([entry]) => entry.stage === "llm" && entry.status === "failed",
    );
    expect(failureCall?.[0]).toMatchObject({
      stage: "llm",
      status: "failed",
      data: { url: "https://example.com/story", runId: null },
    });
  });

  it("throws when crawl task produces no results", async () => {
    prisma.crawlResult.findFirst.mockResolvedValue(null);

    await expect(service.process(job, raw)).rejects.toThrow(
      "crawl task produced no results",
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
      prefetchedArticle: {
        title: " RSS title ",
        markdown: " RSS markdown ",
        publishedAt: "2026-01-01T00:00:00.000Z",
        metadata: { source: "rss" },
      },
      forceRefresh: "",
      crawlOptions: { userAgent: "UA" },
    });

    expect(parsed.url).toBe("https://example.com/news");
    expect(parsed.language).toBe("en");
    expect(parsed.sourceName).toBe("Example");
    expect(parsed.keywords).toEqual(["ai"]);
    expect(parsed.tags).toEqual(["breaking"]);
    expect(parsed.summaryHints).toEqual(["focus"]);
    expect(parsed.forceRefresh).toBe(false);
    expect(parsed.crawlOptions).toEqual({ userAgent: "UA" });
    expect(parsed.prefetchedArticle).toEqual({
      title: "RSS title",
      description: undefined,
      author: undefined,
      markdown: "RSS markdown",
      publishedAt: "2026-01-01T00:00:00.000Z",
      metadata: { source: "rss" },
    });
  });

  it("logs failed stage when LLM cleaning fails", async () => {
    const error = new Error("LLM unavailable");
    liteLlm.acompletion.mockRejectedValueOnce(error);

    await expect(service.process(job, raw)).rejects.toThrow("LLM unavailable");

    const llmProcessingCall = (
      TaskLogModel.create as jest.Mock
    ).mock.calls.find(
      ([entry]) => entry.stage === "llm" && entry.status === "processing",
    );

    expect(llmProcessingCall?.[0]).toMatchObject({
      stage: "llm",
      status: "processing",
      data: { url: "https://example.com/story", runId: null },
    });

    const llmFailureCall = (TaskLogModel.create as jest.Mock).mock.calls.find(
      ([entry]) => entry.stage === "llm" && entry.status === "failed",
    );

    expect(llmFailureCall?.[0]).toMatchObject({
      stage: "llm",
      status: "failed",
      data: { url: "https://example.com/story", runId: null },
      error: { message: "LLM unavailable" },
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
        lockedAt: null,
      },
    ]);

    await service.retryPendingOutbox();

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-invalid" },
        data: expect.objectContaining({
          status: "failed",
          attempts: 3,
          lockedAt: null,
          availableAt: expect.any(Date),
        }),
      }),
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
          llm_prompt_version: "v1",
        },
        llm: {
          model: "openai/gpt-4o-mini",
          promptVersion: "v1",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.01,
          latencyMs: 80,
        },
        error: undefined,
      },
    };

    mongoOutbox.findMany.mockResolvedValueOnce([
      {
        id: "outbox-stale",
        payload: validPayload,
        status: "processing",
        attempts: 1,
        availableAt: new Date(),
        lockedAt: staleLockedAt,
      },
    ]);
    mongoOutbox.updateMany.mockResolvedValueOnce({ count: 1 });
    mongoOutbox.findUnique.mockResolvedValueOnce({
      id: "outbox-stale",
      attempts: 1,
    });
    const upsertSpy = ProcessedItemModel.findOneAndUpdate as jest.Mock;
    upsertSpy.mockResolvedValueOnce({
      _id: { toString: () => validPayload.document._id },
      toJSON: () => ({ id: validPayload.document._id }),
    });

    await service.retryPendingOutbox();

    expect(mongoOutbox.delete).toHaveBeenCalledWith({
      where: { id: "outbox-stale" },
    });
    const updateArgs = upsertSpy.mock.calls[0]?.[1] as
      | { $set?: Record<string, unknown> }
      | undefined;
    expect(updateArgs?.$set).toEqual(
      expect.objectContaining({
        rawItemId: expect.anything(),
        result: expect.objectContaining({
          title: "Existing title",
          published_at: "2024-01-01T00:00:00.000Z",
        }),
      }),
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
          llm_prompt_version: "v1",
        },
        llm: {
          model: "openai/gpt-4o-mini",
          promptVersion: "v1",
          promptTokens: "10",
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.01,
          latencyMs: 80,
        },
      },
    };

    mongoOutbox.findMany.mockResolvedValueOnce([
      {
        id: "outbox-dirty",
        payload: dirtyPayload,
        status: "processing",
        attempts: 1,
        availableAt: new Date(),
        lockedAt: staleLockedAt,
      },
    ]);
    mongoOutbox.updateMany.mockResolvedValueOnce({ count: 1 });
    mongoOutbox.findUnique.mockResolvedValueOnce({
      id: "outbox-dirty",
      attempts: 1,
    });

    await service.retryPendingOutbox();

    expect(mongoOutbox.delete).toHaveBeenCalledWith({
      where: { id: "outbox-dirty" },
    });
    const updateArgs = (ProcessedItemModel.findOneAndUpdate as jest.Mock).mock
      .calls[0]?.[1];
    expect(updateArgs.$set.tags).toEqual([]);
    expect(updateArgs.$set.llm.promptTokens).toBeNull();
  });

  it("marks outbox delivery failed when vector upsert is required but unavailable", async () => {
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
          llm_prompt_version: "v1",
        },
        llm: {
          model: "openai/gpt-4o-mini",
          promptVersion: "v1",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.01,
          latencyMs: 80,
        },
        summaryEmbedding: [1, 0, 0],
        summaryEmbeddingModel: "openai/text-embedding-3-small",
        error: undefined,
      },
    };

    const vectorClient = {
      upsertOrThrow: jest.fn().mockRejectedValue(new Error("vector unavailable")),
    };
    const serviceWithVector = new NewsPipelineService(
      liteLlm as any,
      configService as any,
      promptBuilder,
      promptConfigService as any,
      dedupeSettingsService as any,
      prisma as any,
      crawlExecution as any,
      vectorClient as any,
    );

    mongoOutbox.findMany.mockResolvedValueOnce([
      {
        id: "outbox-vector",
        payload: validPayload,
        status: "processing",
        attempts: 1,
        availableAt: new Date(),
        lockedAt: staleLockedAt,
      },
    ]);
    mongoOutbox.updateMany.mockResolvedValueOnce({ count: 1 });
    mongoOutbox.findUnique.mockResolvedValueOnce({
      id: "outbox-vector",
      attempts: 2,
    });

    await serviceWithVector.retryPendingOutbox();

    expect(vectorClient.upsertOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        embeddingModel: "openai/text-embedding-3-small",
      }),
    );
    expect(mongoOutbox.delete).not.toHaveBeenCalledWith({
      where: { id: "outbox-vector" },
    });
    expect(mongoOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-vector" },
        data: expect.objectContaining({
          status: "failed",
          attempts: 2,
          lockedAt: null,
          availableAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.itemMeta.updateMany).not.toHaveBeenCalled();

    const retryTimers = (serviceWithVector as any).outboxRetryTimers as Map<
      string,
      ReturnType<typeof setTimeout>
    >;
    for (const timer of retryTimers.values()) {
      clearTimeout(timer);
    }
    retryTimers.clear();
  });
});
