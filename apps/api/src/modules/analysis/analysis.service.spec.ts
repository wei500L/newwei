jest.mock("@modular/mongo", () => ({
  MapTransportObjectStateModel: {
    find: jest.fn(),
  },
  MapTransportTrackPointModel: {
    aggregate: jest.fn(),
  },
  AnalysisResultModel: {},
}));

import {
  AnalysisResultDocument,
  MapTransportObjectStateModel,
  MapTransportTrackPointModel,
} from "@modular/mongo";
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

const mockMapTransportObjectStateFind =
  MapTransportObjectStateModel.find as jest.Mock;
const mockMapTransportTrackPointAggregate =
  MapTransportTrackPointModel.aggregate as jest.Mock;

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

describe("AnalysisService.buildGeoTransportContext", () => {
  beforeEach(() => {
    mockMapTransportObjectStateFind.mockReset();
    mockMapTransportTrackPointAggregate.mockReset();
  });

  it("loads windowed and fallback track points with aggregated per-object batches", async () => {
    const states = [
      {
        objectKey: "air-1",
        entityKind: "aircraft",
        sourceScope: "all",
        callsign: "ALPHA1",
        registration: null,
        icao24: "abc123",
        observedAt: new Date("2026-01-02T00:00:00.000Z"),
        lat: 10,
        lng: 20,
        heading: 90,
        course: 91,
        speed: 500,
        altitudeFt: 30000,
      },
      {
        objectKey: "ship-1",
        entityKind: "vessel",
        sourceScope: "all",
        name: "Poseidon",
        mmsi: "123456789",
        observedAt: new Date("2026-01-02T01:00:00.000Z"),
        lat: 30,
        lng: 40,
        heading: null,
        course: 270,
        speed: 12,
        altitudeFt: null,
      },
    ];
    mockMapTransportObjectStateFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(states),
        }),
      }),
    });
    mockMapTransportTrackPointAggregate
      .mockResolvedValueOnce([
        {
          _id: "air-1",
          points: [
            {
              _id: { toString: () => "tp-window-1" },
              observedAt: new Date("2026-01-01T10:00:00.000Z"),
              lat: 11,
              lng: 21,
              heading: 100,
              course: 101,
              speed: 510,
              altitudeFt: 30500,
              geoCell: "cell-window",
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          _id: "ship-1",
          points: [
            {
              _id: { toString: () => "tp-fallback-1" },
              observedAt: new Date("2025-12-31T23:00:00.000Z"),
              lat: 31,
              lng: 41,
              heading: null,
              course: 271,
              speed: 13,
              altitudeFt: null,
              geoCell: "cell-fallback",
            },
          ],
        },
      ]);

    const { service } = createService();
    const buildGeoTransportContext = (
      service as unknown as {
        buildGeoTransportContext: (orgId: string, input: {
          transportKinds: ("aircraft" | "vessel")[];
          startDate: string;
          endDate: string;
          bbox?: [number, number, number, number];
          objectKeys?: string[];
        }) => Promise<{
          objectKeys: string[];
          objects: { objectKey: string; trackPoints: { trackPointId: string }[] }[];
        }>;
      }
    ).buildGeoTransportContext.bind(service);

    const context = await buildGeoTransportContext("org-1", {
      transportKinds: [],
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-02T23:59:59.999Z",
    });

    expect(mockMapTransportTrackPointAggregate).toHaveBeenCalledTimes(2);
    expect(mockMapTransportTrackPointAggregate).toHaveBeenNthCalledWith(1, [
      {
        $match: {
          orgId: "org-1",
          objectKey: { $in: ["air-1", "ship-1"] },
          observedAt: {
            $gte: new Date("2026-01-01T00:00:00.000Z"),
            $lte: new Date("2026-01-02T23:59:59.999Z"),
          },
        },
      },
      {
        $project: {
          _id: 1,
          objectKey: 1,
          observedAt: 1,
          lat: 1,
          lng: 1,
          heading: 1,
          course: 1,
          speed: 1,
          altitudeFt: 1,
          geoCell: 1,
        },
      },
      { $sort: { objectKey: 1, observedAt: -1 } },
      {
        $group: {
          _id: "$objectKey",
          points: { $push: "$$ROOT" },
        },
      },
      {
        $project: {
          points: { $slice: ["$points", 30] },
        },
      },
    ]);
    expect(mockMapTransportTrackPointAggregate).toHaveBeenNthCalledWith(2, [
      {
        $match: {
          orgId: "org-1",
          objectKey: { $in: ["ship-1"] },
        },
      },
      {
        $project: {
          _id: 1,
          objectKey: 1,
          observedAt: 1,
          lat: 1,
          lng: 1,
          heading: 1,
          course: 1,
          speed: 1,
          altitudeFt: 1,
          geoCell: 1,
        },
      },
      { $sort: { objectKey: 1, observedAt: -1 } },
      {
        $group: {
          _id: "$objectKey",
          points: { $push: "$$ROOT" },
        },
      },
      {
        $project: {
          points: { $slice: ["$points", 30] },
        },
      },
    ]);
    expect(context.objectKeys).toEqual(["air-1", "ship-1"]);
    expect(context.objects.map((object) => object.objectKey)).toEqual([
      "air-1",
      "ship-1",
    ]);
    expect(context.objects[0]?.trackPoints[0]?.trackPointId).toBe("tp-window-1");
    expect(context.objects[1]?.trackPoints[0]?.trackPointId).toBe("tp-fallback-1");
  });
});
