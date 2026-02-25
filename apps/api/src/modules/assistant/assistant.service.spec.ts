import type { PubSubEngine } from "graphql-subscriptions";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { AssistantRunModel } from "@modular/mongo";

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
  const queue = {
    add: jest.fn(async () => undefined),
    getJob: jest.fn(async () => null)
  } as never;
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
    pubsub,
    queue
  };
}

describe("AssistantService.submitQuery", () => {
  it("generates and persists conversationId when absent", async () => {
    const { service, queue } = createService();
    const createSpy = jest.spyOn(
      AssistantRunModel as unknown as { create: (...args: unknown[]) => Promise<unknown> },
      "create"
    ).mockResolvedValue({
      id: "run-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    } as never);

    try {
      await service.submitQuery("org-1", { message: "hello" }, "user-1");

      expect(createSpy).toHaveBeenCalledTimes(1);
      const payload = createSpy.mock.calls[0]?.[0] as {
        input?: { conversationId?: string; knowledgeSource?: string };
        conversationId?: string;
      };
      expect(payload.conversationId).toEqual(expect.any(String));
      expect(payload.input?.conversationId).toBe(payload.conversationId);
      expect(payload.input?.knowledgeSource).toBe("site_db");
      expect((queue as { add: jest.Mock }).add).toHaveBeenCalledWith(
        "query",
        { type: "query", runId: "run-1", orgId: "org-1", traceId: "test-trace-id" },
        expect.objectContaining({ jobId: "assistant:query:run-1" })
      );
    } finally {
      createSpy.mockRestore();
    }
  });

  it("falls back to generated conversationId when input conversationId is invalid", async () => {
    const { service } = createService();
    const createSpy = jest.spyOn(
      AssistantRunModel as unknown as { create: (...args: unknown[]) => Promise<unknown> },
      "create"
    ).mockResolvedValue({
      id: "run-2",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    } as never);

    try {
      await service.submitQuery("org-1", { message: "hello", conversationId: "bad id with spaces" }, "user-1");

      const payload = createSpy.mock.calls[0]?.[0] as {
        input?: { conversationId?: string; knowledgeSource?: string };
        conversationId?: string;
      };
      expect(payload.conversationId).toEqual(expect.any(String));
      expect(payload.conversationId).not.toBe("bad id with spaces");
      expect(payload.input?.conversationId).toBe(payload.conversationId);
      expect(payload.input?.knowledgeSource).toBe("site_db");
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe("AssistantService.buildQueryConversationHistoryMessages", () => {
  it("loads recent runs in chronological order and maps user/assistant messages", async () => {
    const { service } = createService();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const lean = jest.fn().mockResolvedValue([
      {
        input: { message: "第二问" },
        output: { summary: "第二答" },
        summary: "第二答（fallback）"
      },
      {
        input: { message: "第一问" },
        summary: "第一答"
      }
    ]);
    const limit = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ limit });
    const findSpy = jest.spyOn(
      AssistantRunModel as unknown as { find: (...args: unknown[]) => unknown },
      "find"
    ).mockReturnValue({ sort } as never);

    const buildHistory = (
      service as unknown as {
        buildQueryConversationHistoryMessages: (
          orgId: string,
          runId: string,
          createdAt: Date,
          conversationId?: string
        ) => Promise<Array<{ role: string; content: string }>>;
      }
    ).buildQueryConversationHistoryMessages.bind(service);

    try {
      const messages = await buildHistory("org-1", "run-3", createdAt, "conversation-1");

      expect(findSpy).toHaveBeenCalledWith(
        {
          orgId: "org-1",
          type: "query",
          conversationId: "conversation-1",
          createdAt: { $lt: createdAt },
          _id: { $ne: "run-3" }
        },
        { input: 1, output: 1, summary: 1, createdAt: 1 }
      );
      expect(sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(limit).toHaveBeenCalledWith(10);
      expect(messages).toEqual([
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "第二问" },
        { role: "assistant", content: "第二答" }
      ]);
    } finally {
      findSpy.mockRestore();
    }
  });

  it("caps history payload size to avoid oversized context", async () => {
    const { service } = createService();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const veryLongUser = "u".repeat(5_000);
    const veryLongAssistant = "a".repeat(5_000);
    const lean = jest.fn().mockResolvedValue([
      {
        input: { message: veryLongUser },
        output: { summary: veryLongAssistant }
      }
    ]);
    const limit = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ limit });
    const findSpy = jest.spyOn(
      AssistantRunModel as unknown as { find: (...args: unknown[]) => unknown },
      "find"
    ).mockReturnValue({ sort } as never);

    const buildHistory = (
      service as unknown as {
        buildQueryConversationHistoryMessages: (
          orgId: string,
          runId: string,
          createdAt: Date,
          conversationId?: string
        ) => Promise<Array<{ role: string; content: string }>>;
      }
    ).buildQueryConversationHistoryMessages.bind(service);

    try {
      const messages = await buildHistory("org-1", "run-1", createdAt, "conversation-1");
      const totalChars = messages.reduce((sum, item) => sum + item.content.length, 0);
      expect(totalChars).toBeLessThanOrEqual(8_000);
      expect(messages.every((item) => item.content.length <= 1_000)).toBe(true);
    } finally {
      findSpy.mockRestore();
    }
  });
});

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
        options?: { initialChunk?: string; guardrails?: string[]; assistantModel?: string; tools?: Record<string, unknown>[] }
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
        options?: { initialChunk?: string; guardrails?: string[]; assistantModel?: string; tools?: Record<string, unknown>[] }
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
          options?: { initialChunk?: string; guardrails?: string[]; assistantModel?: string; tools?: Record<string, unknown>[] }
        ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).streamMessages.bind(service);

    const result = await streamMessages("org", "run", "query", new Date(), [{ role: "user", content: "hi" }], {
      assistantModel: "openai/gpt-4.1-mini",
    });

    expect(result.summary).toBe("ok");
    expect((llm.stream as unknown as jest.Mock).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        model: "openai/gpt-4.1-mini",
        orgId: "org",
      })
    );
  });
});

describe("AssistantService.runQuery", () => {
  it("injects history into planner and renderer calls", async () => {
    const { service, llm } = createService({
      stream: jest.fn() as unknown as LiteLlmService["stream"]
    });

    (service as any).prompts = {
      buildQueryPlannerRequest: jest.fn().mockReturnValue({
        messages: [
          { role: "system", content: "planner-system" },
          { role: "user", content: "planner-user" }
        ],
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "assistant_query_plan", schema: {} }
        }
      })
    };
    (llm as any).acompletion = jest.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              kind: "unsupported"
            })
          }
        }
      ]
    });

    jest.spyOn(service as any, "buildQueryConversationHistoryMessages").mockResolvedValue([
      { role: "user", content: "历史问题" },
      { role: "assistant", content: "历史回答" }
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
          input: { message: string; conversationId?: string },
          guardrails?: string[],
          assistantModel?: string
        ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).runQuery.bind(service);

    await runQuery("org-1", "run-1", new Date("2026-01-01T00:00:00.000Z"), {
      message: "继续上一个问题",
      conversationId: "conversation-1"
    });

    expect((llm as any).acompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "planner-system" },
          { role: "user", content: "历史问题" },
          { role: "assistant", content: "历史回答" },
          { role: "user", content: "planner-user" }
        ]
      })
    );

    const call = streamMessages.mock.calls[0];
    expect(call?.[0]).toBe("org-1");
    expect(call?.[1]).toBe("run-1");
    expect(call?.[2]).toBe("query");
    expect(call?.[3]).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(call?.[4]).toEqual([
      {
        role: "system",
        content: [
          "You are a finance analysis assistant.",
          "Write the response in Simplified Chinese.",
          "Explain that the request is not supported yet and ask for a supported query."
        ].join("\n")
      },
      { role: "user", content: "历史问题" },
      { role: "assistant", content: "历史回答" },
      { role: "user", content: "User request: 继续上一个问题" }
    ]);
    expect(call?.[5]).toEqual(
      expect.objectContaining({
        guardrails: undefined,
        assistantModel: undefined
      })
    );
  });

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

  it("rejects web search query when active profile does not support it", async () => {
    const { service } = createService({
      stream: jest.fn() as unknown as LiteLlmService["stream"]
    });

    const runQuery = (
      service as unknown as {
        runQuery: (
          orgId: string,
          runId: string,
          createdAt: Date,
          input: { message: string; conversationId?: string; knowledgeSource?: "site_db" | "web_search" },
          guardrails?: string[],
          assistantModel?: string
        ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).runQuery.bind(service);

    try {
      await runQuery("org-1", "run-1", new Date("2026-01-01T00:00:00.000Z"), {
        message: "给我查一下最新黄金新闻",
        knowledgeSource: "web_search"
      });
      throw new Error("Expected runQuery to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as { code?: string; message?: string };
      expect(response.code).toBe("WEB_SEARCH_UNSUPPORTED");
      expect(response.message).toContain("does not support web search");
    }
  });

  it("passes web search tool to stream when active profile supports it", async () => {
    const { service } = createService({
      stream: jest.fn() as unknown as LiteLlmService["stream"]
    });

    (service as any).llmGatewaySettings = {
      getActiveConfig: jest.fn().mockResolvedValue({
        model: "openai/gpt-4o-mini",
        apiSurface: "responses",
        assistantWebSearchEnabled: true
      })
    };

    jest.spyOn(service as any, "buildQueryConversationHistoryMessages").mockResolvedValue([
      { role: "user", content: "上一条问题" },
      { role: "assistant", content: "上一条回答" }
    ]);
    const streamMessages = jest
      .spyOn(service as any, "streamMessages")
      .mockResolvedValue({ summary: "web-ok", raw: { stream: true } });

    const runQuery = (
      service as unknown as {
        runQuery: (
          orgId: string,
          runId: string,
          createdAt: Date,
          input: { message: string; conversationId?: string; knowledgeSource?: "site_db" | "web_search" },
          guardrails?: string[],
          assistantModel?: string
        ) => Promise<{ summary: string; raw: Record<string, unknown>; knowledgeSource?: string }>;
      }
    ).runQuery.bind(service);

    const result = await runQuery("org-1", "run-1", new Date("2026-01-01T00:00:00.000Z"), {
      message: "给我查一下最新黄金新闻",
      knowledgeSource: "web_search",
      conversationId: "conversation-1"
    });

    const call = streamMessages.mock.calls[0];
    expect(call?.[4]).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "上一条问题" },
      { role: "assistant", content: "上一条回答" },
      { role: "user", content: "给我查一下最新黄金新闻" }
    ]);
    expect(call?.[5]).toEqual(
      expect.objectContaining({
        tools: [{ type: "web_search_preview" }]
      })
    );
    expect(result.summary).toBe("web-ok");
    expect(result.knowledgeSource).toBe("web_search");
  });
});
