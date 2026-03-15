import { NotificationPresentationKind } from "@modular/utils";
import { NotificationType } from "@prisma/client";
import type { PubSubEngine } from "graphql-subscriptions";

import type { EnvService } from "../config/config.service";
import type {
  LiteLlmMessage,
  LiteLlmService,
  LiteLlmStreamChunk,
} from "../news-pipeline/litellm.service";
import type { NotificationsService } from "../notifications/notifications.service";

import type { AnalysisPromptService } from "./analysis-prompt.service";
import { AnalysisStreamError } from "./analysis.errors";
import { AnalysisService } from "./analysis.service";

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    }),
    ensureTraceId: () => "test-trace-id",
    getCurrentTraceId: () => undefined,
  };
});

function createService(overrides?: {
  stream?: LiteLlmService["stream"];
  notifications?: Partial<NotificationsService>;
}) {
  async function* failingStream(): AsyncGenerator<LiteLlmStreamChunk> {
    yield { model: "test-model", raw: {}, delta: "foo" };
    yield { model: "test-model", raw: {}, delta: "bar" };
    throw new Error("boom");
  }

  const llm = {
    stream:
      overrides?.stream ??
      (jest.fn(() => failingStream()) as unknown as LiteLlmService["stream"]),
  } as unknown as LiteLlmService;

  const env = {
    analysisConfig: {
      streamFlushChars: 10_000,
      streamFlushMs: 10_000,
      llmTimeoutMs: 1_000,
      maxRetries: 1,
    },
  } as unknown as EnvService;

  const prompts = {} as unknown as AnalysisPromptService;
  const queue = {} as never;
  const pubsub = {
    publish: jest.fn(async () => undefined),
  } as unknown as PubSubEngine;
  const notifications = {
    notify: jest.fn(async () => undefined),
    ...overrides?.notifications,
  } as unknown as NotificationsService;

  return {
    service: new AnalysisService(
      llm,
      env,
      prompts,
      queue,
      pubsub,
      notifications,
    ),
    llm,
    notifications,
    pubsub,
  };
}

describe("AnalysisService.streamMessages", () => {
  it("throws AnalysisStreamError with partial summary on stream failure", async () => {
    const { service, llm } = createService();

    const streamMessages = (
      service as unknown as {
        streamMessages: (
          orgId: string,
          analysisId: string,
          type: string,
          createdAt: Date,
          messages: LiteLlmMessage[],
          initialChunk?: string,
        ) => Promise<{ summary: string; raw: Record<string, unknown> }>;
      }
    ).streamMessages.bind(service);

    try {
      await streamMessages(
        "org",
        "analysis",
        "anomaly",
        new Date(),
        [{ role: "user", content: "hi" }],
        "init-",
      );
      throw new Error("expected streamMessages to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisStreamError);
      const streamError = error as AnalysisStreamError;
      expect(streamError.message).toBe("boom");
      expect(streamError.partialSummary).toBe("init-foobar");
      expect(streamError.cause).toBeInstanceOf(Error);
    }

    expect((llm.stream as unknown as jest.Mock).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ orgId: "org" }),
    );
  });
});

describe("AnalysisService.notifyResult", () => {
  it("sends semantic notification payloads for failed analysis jobs", async () => {
    const notify = jest.fn(async () => undefined);
    const { service } = createService({
      notifications: { notify } as Partial<NotificationsService>,
    });

    await (
      service as unknown as {
        notifyResult: (record: AnalysisResultDocument) => Promise<void>;
      }
    ).notifyResult({
      _id: { toString: () => "analysis-1" },
      orgId: "org-1",
      triggeredById: "user-1",
      status: "failed",
      type: "correlation",
      error: "provider timeout",
    } as unknown as AnalysisResultDocument);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "user-1",
        type: NotificationType.analysis_failed,
        data: expect.objectContaining({
          analysisId: "analysis-1",
          presentation: expect.objectContaining({
            kind: NotificationPresentationKind.AnalysisFailed,
            technicalDetail: "provider timeout",
            params: expect.objectContaining({
              analysisId: "analysis-1",
              analysisType: "correlation",
            }),
          }),
        }),
      }),
    );
  });
});
