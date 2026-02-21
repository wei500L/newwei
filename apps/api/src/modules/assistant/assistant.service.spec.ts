import type { PubSubEngine } from "graphql-subscriptions";
import { ServiceUnavailableException } from "@nestjs/common";

import type { EnvService } from "../config/config.service";
import type { PrismaService } from "../config/prisma.service";
import type { ModelServiceClient } from "../model-service/model-service.client";
import type { LiteLlmMessage, LiteLlmService, LiteLlmStreamChunk } from "../news-pipeline/litellm.service";
import { LiteLlmGuardrailViolationError } from "../news-pipeline/litellm.service";
import type { AssistantSafetySettingsService } from "../system-settings/assistant-safety-settings.service";
import type { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";
import type { OpenAiKeysSettingsService } from "../system-settings/openai-keys-settings.service";

import { AssistantPromptService } from "./assistant-prompt.service";
import { AssistantStreamError } from "./assistant.errors";
import { AssistantService } from "./assistant.service";

jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }),
  ensureTraceId: () => "test-trace-id",
  getCurrentTraceId: () => undefined
}));

function createService(overrides?: { stream?: LiteLlmService["stream"] }) {
  async function* failingStream(): AsyncGenerator<LiteLlmStreamChunk> {
    yield { model: "test-model", raw: {}, delta: "foo" };
    yield { model: "test-model", raw: {}, delta: "bar" };
    throw new Error("boom");
  }

  const llm = {
    stream: overrides?.stream ?? (jest.fn(() => failingStream()) as unknown as LiteLlmService["stream"])
  } as unknown as LiteLlmService;

  const env = {
    assistantConfig: {
      streamFlushChars: 10_000,
      streamFlushMs: 10_000,
      llmTimeoutMs: 1_000,
      maxRetries: 1,
      queueConcurrency: 1
    }
  } as unknown as EnvService;

  const assistantSafety = {} as unknown as AssistantSafetySettingsService;
  const llmGatewaySettings = {
    getActiveConfig: jest.fn(async () => null)
  } as unknown as LlmGatewaySettingsService;
  const openaiKeys = { getKeyCount: jest.fn(async () => 0) } as unknown as OpenAiKeysSettingsService;
  const prisma = {} as unknown as PrismaService;
  const items = {} as never;
  const modelService = {} as unknown as ModelServiceClient;
  const prompts = {} as unknown as AssistantPromptService;
  const queue = {} as never;
  const pubsub = { publish: jest.fn(async () => undefined) } as unknown as PubSubEngine;

  return {
    service: new AssistantService(
      llm,
      env,
      assistantSafety,
      llmGatewaySettings,
      openaiKeys,
      prisma,
      items,
      modelService,
      prompts,
      queue,
      pubsub
    ),
    llm,
    pubsub
  };
}

describe("AssistantService.streamMessages", () => {
  it("throws AssistantStreamError with partial summary on stream failure", async () => {
    const { service } = createService();

    const streamMessages = (
      service as unknown as {
        streamMessages: (
          orgId: string,
          runId: string,
        type: "query" | "report" | "forecast",
        createdAt: Date,
        messages: LiteLlmMessage[],
        options?: { initialChunk?: string; guardrails?: string[]; assistantModel?: string }
      ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).streamMessages.bind(service);

    try {
      await streamMessages("org", "run", "query", new Date(), [{ role: "user", content: "hi" }], {
        initialChunk: "init-"
      });
      throw new Error("expected streamMessages to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantStreamError);
      const streamError = error as AssistantStreamError;
      expect(streamError.message).toBe("boom");
      expect(streamError.partialSummary).toBe("init-foobar");
      expect(streamError.cause).toBeInstanceOf(Error);
    }
  });

  it("does not wrap LiteLlmGuardrailViolationError", async () => {
    async function* blockedStream(): AsyncGenerator<LiteLlmStreamChunk> {
      yield { model: "test-model", raw: {}, delta: "x" };
      throw new LiteLlmGuardrailViolationError("blocked", { appliedGuardrails: ["openai-moderation-pre"] });
    }

    const { service } = createService({ stream: jest.fn(() => blockedStream()) as unknown as LiteLlmService["stream"] });

    const streamMessages = (
      service as unknown as {
        streamMessages: (
          orgId: string,
          runId: string,
        type: "query" | "report" | "forecast",
        createdAt: Date,
        messages: LiteLlmMessage[],
        options?: { initialChunk?: string; guardrails?: string[]; assistantModel?: string }
      ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).streamMessages.bind(service);

    await expect(
      streamMessages("org", "run", "query", new Date(), [{ role: "user", content: "hi" }])
    ).rejects.toBeInstanceOf(LiteLlmGuardrailViolationError);
  });

  it("passes assistant model override to LiteLLM stream", async () => {
    async function* successStream(): AsyncGenerator<LiteLlmStreamChunk> {
      yield { model: "test-model", raw: {}, delta: "ok" };
    }

    const stream = jest.fn(() => successStream()) as unknown as LiteLlmService["stream"];
    const { service, llm } = createService({ stream });

    const streamMessages = (
      service as unknown as {
        streamMessages: (
          orgId: string,
          runId: string,
          type: "query" | "report" | "forecast",
          createdAt: Date,
          messages: LiteLlmMessage[],
          options?: { initialChunk?: string; guardrails?: string[]; assistantModel?: string }
        ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).streamMessages.bind(service);

    const result = await streamMessages("org", "run", "query", new Date(), [{ role: "user", content: "hi" }], {
      assistantModel: "openai/gpt-4.1-mini",
    });

    expect(result.summary).toBe("ok");
    expect((llm.stream as unknown as jest.Mock).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: "openai/gpt-4.1-mini" })
    );
  });
});

describe("AssistantService.runQuery", () => {
  it("falls back to RECENCY ranking when rerank is unavailable", async () => {
    const { service, llm } = createService({
      stream: jest.fn() as unknown as LiteLlmService["stream"]
    });

    (service as any).prompts = {
      buildQueryPlannerRequest: jest.fn().mockReturnValue({
        messages: [{ role: "user", content: "negative news query" }],
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "assistant_query_plan", schema: {} }
        }
      }),
      buildNewsListRendererMessages: jest.fn().mockReturnValue([{ role: "user", content: "rendered prompt" }])
    };
    (llm as any).acompletion = jest.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              kind: "news_negative_list",
              topic: "gold",
              lookbackDays: 7,
              limit: 2
            })
          }
        }
      ]
    });

    const list = jest
      .fn()
      .mockRejectedValueOnce(
        new ServiceUnavailableException({
          code: "RERANK_UNAVAILABLE",
          message: "Reranker unavailable"
        })
      )
      .mockResolvedValueOnce({ items: [{ id: "meta-1" }] });
    (service as any).items = { list };
    jest.spyOn(service as any, "renderNewsItems").mockResolvedValue([
      {
        itemMetaId: "meta-1",
        title: "Gold downside pressure",
        summary: "Risk-off sentiment persists"
      }
    ]);
    const streamMessages = jest
      .spyOn(service as any, "streamMessages")
      .mockResolvedValue({ summary: "ok", raw: { tokens: 10 } });

    const runQuery = (
      service as unknown as {
        runQuery: (
          orgId: string,
          runId: string,
          createdAt: Date,
          input: { message: string },
          guardrails?: string[],
          assistantModel?: string
        ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).runQuery.bind(service);

    const result = await runQuery(
      "org-1",
      "run-1",
      new Date("2026-01-01T00:00:00.000Z"),
      { message: "最近黄金的负面新闻有哪些？" },
      ["openai-moderation-pre"],
      "openai/gpt-4.1-mini"
    );

    expect(list).toHaveBeenNthCalledWith(
      1,
      "org-1",
      1,
      2,
      "gold",
      expect.objectContaining({
        sentiments: ["negative"],
        dateRange: {
          start: expect.any(Date),
          end: expect.any(Date)
        }
      }),
      "PUBLISHED_DESC",
      "RELEVANCE"
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      "org-1",
      1,
      2,
      "gold",
      expect.objectContaining({
        sentiments: ["negative"],
        dateRange: {
          start: expect.any(Date),
          end: expect.any(Date)
        }
      }),
      "PUBLISHED_DESC",
      "RECENCY"
    );
    expect(streamMessages).toHaveBeenCalledWith(
      "org-1",
      "run-1",
      "query",
      new Date("2026-01-01T00:00:00.000Z"),
      [{ role: "user", content: "rendered prompt" }],
      {
        guardrails: ["openai-moderation-pre"],
        assistantModel: "openai/gpt-4.1-mini"
      }
    );
    expect(result.summary).toBe("ok");
  });
});
