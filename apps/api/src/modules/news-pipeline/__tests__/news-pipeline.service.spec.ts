import { TaskLogModel } from "@modular/mongo";
import type { Crawl4aiResponse } from "../../crawl/crawl4ai.client";
import { NewsPromptBuilder } from "../news-prompt.builder";
import { NewsPipelineService } from "../news-pipeline.service";
import type { PipelineJobContext, RawPipelineItem } from "../news-pipeline.types";
import { NewsPipelineConfig } from "../news-pipeline.config";
import { DEFAULT_NEWS_PROMPT_CONFIG } from "../news-prompt-config.service";
import { NormalizedNewsPayloadSchema } from "../news-pipeline.schema";

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn().mockResolvedValue(undefined)
  },
  ProcessedItemModel: {
    create: jest.fn().mockResolvedValue({
      _id: { toString: () => "processed-id" },
      toJSON: () => ({ id: "processed-id" })
    })
  }
}));

const baseConfig: NewsPipelineConfig = {
  litellm: {
    model: "openai/gpt-4o-mini",
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
    configPath: "config/news-pipeline.config.yaml"
  }
};

describe("NewsPipelineService", () => {
  const promptBuilder = new NewsPromptBuilder();

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
    }))
  };

  const cache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined)
  };

  const promptConfigService = {
    getConfig: jest.fn().mockResolvedValue(DEFAULT_NEWS_PROMPT_CONFIG)
  };

  const configService = {
    get config() {
      return baseConfig;
    }
  };

  const service = new NewsPipelineService(
    crawlClient as any,
    liteLlm as any,
    configService as any,
    promptBuilder,
    promptConfigService as any,
    cache as any
  );

  const job: PipelineJobContext = {
    queue: "itemPipeline",
    jobId: "job-1",
    itemMetaId: "meta-1",
    rawItemId: "raw-1",
    orgId: "org-1"
  };

  const raw: RawPipelineItem = {
    id: "raw-1",
    itemMetaId: "meta-1",
    payload: {
      url: "https://example.com/story",
      keywords: ["AI"],
      tags: ["breaking"]
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("processes a raw item by crawling and cleaning content", async () => {
    await service.process(job, raw);

    expect(crawlClient.crawl).toHaveBeenCalledTimes(1);
    expect(liteLlm.acompletion).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(promptConfigService.getConfig).toHaveBeenCalledTimes(1);
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
});
