import {
  PERMISSIONS_KEY,
  PermissionsMode,
  type PermissionsRequirement
} from "../../../common/decorators/permissions.decorator";
import { CRAWL_QUEUE_HOT_NAME, CRAWL_QUEUE_MODE, CRAWL_QUEUE_NAME, CRAWL_QUEUE_NORMAL_NAME } from "../crawl.constants";
import { Crawl4aiQueueController } from "../crawl4ai-queue.controller";

describe("Crawl4aiQueueController permissions", () => {
  const getPermissionsFor = (
    methodName: "getQueueStats" | "pauseQueue" | "resumeQueue" | "updateQueueConcurrency"
  ): PermissionsRequirement =>
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      Crawl4aiQueueController.prototype[methodName]
    ) as PermissionsRequirement;

  it("requires crawl.read to fetch queue stats", () => {
    expect(getPermissionsFor("getQueueStats")).toEqual({
      permissions: ["crawl.read"],
      mode: PermissionsMode.Any
    });
  });

  it("requires settings.manage for queue mutation endpoints", () => {
    expect(getPermissionsFor("pauseQueue")).toEqual({
      permissions: ["settings.manage"],
      mode: PermissionsMode.Any
    });
    expect(getPermissionsFor("resumeQueue")).toEqual({
      permissions: ["settings.manage"],
      mode: PermissionsMode.Any
    });
    expect(getPermissionsFor("updateQueueConcurrency")).toEqual({
      permissions: ["settings.manage"],
      mode: PermissionsMode.Any
    });
  });
});

describe("Crawl4aiQueueController queue stats", () => {
  it("returns aggregate queue stats including per-queue runtime and adaptive details", async () => {
    const crawlQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 2,
        active: 1,
        delayed: 3,
        failed: 0
      }),
      isPaused: jest.fn().mockResolvedValue(false),
      getEffectiveConcurrency: jest.fn().mockResolvedValue(4),
      getRuntimeStatsByQueue: jest.fn().mockResolvedValue({
        hot: {
          queueName: CRAWL_QUEUE_HOT_NAME,
          pending: 2,
          paused: false,
          counts: { waiting: 1, active: 1, delayed: 0, failed: 0 },
          effectiveConcurrency: 3
        },
        normal: {
          queueName: CRAWL_QUEUE_NORMAL_NAME,
          pending: 4,
          paused: false,
          counts: { waiting: 1, active: 0, delayed: 3, failed: 0 },
          effectiveConcurrency: 1
        }
      })
    } as any;

    const crawlSettings = {
      getSettings: jest.fn().mockResolvedValue({
        maxConcurrency: 4
      })
    } as any;

    const adaptiveConcurrency = {
      getStatus: jest.fn().mockResolvedValue({
        enabled: true,
        lastDecision: "stable",
        lastAdjustedAt: null,
        reason: null,
        currentMaxConcurrency: 4,
        windowMinutes: 15,
        cooldownMinutes: 5,
        thresholds: {
          latencyRatio: 0.85,
          errorRate: 0.2,
          memoryHeadroom: 0.12
        },
        metrics: {
          taskCount: 5,
          failedCount: 1,
          errorRate: 0.2,
          p95LatencyMs: 90_000,
          memoryHeadroom: 0.3,
          memorySampleCount: 5
        }
      })
    } as any;

    const controller = new Crawl4aiQueueController(
      crawlQueue,
      crawlSettings,
      {} as any,
      adaptiveConcurrency
    );

    const result = await controller.getQueueStats();

    expect(result).toEqual(
      expect.objectContaining({
        queueName: `${CRAWL_QUEUE_HOT_NAME},${CRAWL_QUEUE_NORMAL_NAME}`,
        legacyQueueName: CRAWL_QUEUE_NAME,
        queueMode: CRAWL_QUEUE_MODE,
        queueNames: {
          hot: CRAWL_QUEUE_HOT_NAME,
          normal: CRAWL_QUEUE_NORMAL_NAME
        },
        pending: 6,
        paused: false,
        maxConcurrency: 4,
        effectiveConcurrency: 4,
        queues: {
          hot: expect.objectContaining({
            queueName: CRAWL_QUEUE_HOT_NAME,
            pending: 2
          }),
          normal: expect.objectContaining({
            queueName: CRAWL_QUEUE_NORMAL_NAME,
            pending: 4
          })
        },
        adaptive: expect.objectContaining({
          enabled: true,
          lastDecision: "stable",
          thresholds: expect.objectContaining({
            latencyRatio: 0.85
          }),
          metrics: expect.objectContaining({
            taskCount: 5
          })
        })
      })
    );
    expect(typeof result.updatedAt).toBe("string");
  });
});
