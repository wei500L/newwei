import type { Crawl4aiResponse } from "../../crawl/crawl4ai.client";
import { NewsPromptBuilder } from "../news-prompt.builder";
import { NewsPipelineService } from "../news-pipeline.service";
import type { PipelineJobContext, RawPipelineItem } from "../news-pipeline.types";
import { NewsPipelineConfig } from "../news-pipeline.config";

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
              status: "ok",
              title: "Clean Headline",
              content: "Clean body",
              publish_time: "2024-01-01T00:00:00Z",
              source: {
                url: "https://example.com/story",
                name: "Example",
                domain: "example.com"
              },
              highlights: ["Clean body"],
              keywords: ["example"],
              metadata: {}
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

  it("processes a raw item by crawling and cleaning content", async () => {
    await service.process(job, raw);

    expect(crawlClient.crawl).toHaveBeenCalledTimes(1);
    expect(liteLlm.acompletion).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });
});
