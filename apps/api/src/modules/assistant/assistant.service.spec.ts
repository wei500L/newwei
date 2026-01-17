import type { PubSubEngine } from "graphql-subscriptions";

import type { EnvService } from "../config/config.service";
import type { PrismaService } from "../config/prisma.service";
import type { ModelServiceClient } from "../model-service/model-service.client";
import type { LiteLlmMessage, LiteLlmService, LiteLlmStreamChunk } from "../news-pipeline/litellm.service";

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

  const prisma = {} as unknown as PrismaService;
  const items = {} as never;
  const modelService = {} as unknown as ModelServiceClient;
  const prompts = {} as unknown as AssistantPromptService;
  const queue = {} as never;
  const pubsub = { publish: jest.fn(async () => undefined) } as unknown as PubSubEngine;

  return { service: new AssistantService(llm, env, prisma, items, modelService, prompts, queue, pubsub), llm, pubsub };
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
          initialChunk?: string
        ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).streamMessages.bind(service);

    try {
      await streamMessages("org", "run", "query", new Date(), [{ role: "user", content: "hi" }], "init-");
      throw new Error("expected streamMessages to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantStreamError);
      const streamError = error as AssistantStreamError;
      expect(streamError.message).toBe("boom");
      expect(streamError.partialSummary).toBe("init-foobar");
      expect(streamError.cause).toBeInstanceOf(Error);
    }
  });
});
