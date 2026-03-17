/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }),
  ensureTraceId: jest.fn((traceId?: string) => traceId ?? "test-trace-id"),
  runWithTraceId: jest.fn(async (_traceId: string, fn: () => Promise<any>) => fn())
}));

const workerInstances: any[] = [];
const WorkerMock = jest.fn().mockImplementation(() => {
  const instance = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    rateLimit: jest.fn().mockResolvedValue(undefined),
    concurrency: 1
  };
  workerInstances.push(instance);
  return instance;
}) as unknown as jest.Mock & {
  RateLimitError: jest.Mock;
};
const mockRateLimitError = new Error("__rate_limit__");
WorkerMock.RateLimitError = jest.fn(() => mockRateLimitError);

jest.mock("bullmq", () => ({
  Worker: WorkerMock,
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  }
}));

import { Worker, UnrecoverableError } from "bullmq";

import { CrawlQueueProcessor } from "./crawl.processor";
import { Crawl4aiRequestException } from "./crawl4ai.exception";

describe("CrawlQueueProcessor", () => {
  const createContext = (
    options: {
      envMaxConcurrency?: number;
      settingsMaxConcurrency?: number;
      requestTimeoutHotMs?: number;
      requestTimeoutNormalMs?: number;
      queueOverloadCooldownMs?: number;
      legacyQueueOverrides?: Record<string, unknown>;
      hotQueueOverrides?: Record<string, unknown>;
      normalQueueOverrides?: Record<string, unknown>;
    } = {}
  ) => {
    const env = {
      crawl4aiConfig: {
        maxConcurrency: options.envMaxConcurrency ?? 3,
        timeoutMs: options.requestTimeoutNormalMs ?? 120_000
      }
    } as any;

    const crawlSettings = {
      getSettings: jest.fn().mockResolvedValue({
        maxConcurrency: options.settingsMaxConcurrency ?? options.envMaxConcurrency ?? 3,
        queueOverloadCooldownMs: options.queueOverloadCooldownMs ?? 30_000,
        requestTimeoutHotMs: options.requestTimeoutHotMs ?? 60_000,
        requestTimeoutNormalMs: options.requestTimeoutNormalMs ?? 120_000
      })
    } as any;

    const crawlExecutionService = {
      runTask: jest.fn()
    } as any;

    const crawlFrontierService = {
      processQueuedNode: jest.fn()
    } as any;

    const prisma = {
      crawlTask: {
        updateMany: jest.fn()
      }
    } as any;

    const legacyQueue = {
      opts: {
        connection: { host: "localhost", port: 6379 }
      },
      getJob: jest.fn(),
      setGlobalConcurrency: jest.fn().mockResolvedValue(undefined),
      ...(options.legacyQueueOverrides ?? {})
    } as any;

    const hotQueue = {
      opts: {
        connection: { host: "localhost", port: 6379 }
      },
      getJob: jest.fn(),
      setGlobalConcurrency: jest.fn().mockResolvedValue(undefined),
      ...(options.hotQueueOverrides ?? {})
    } as any;

    const normalQueue = {
      opts: {
        connection: { host: "localhost", port: 6379 }
      },
      getJob: jest.fn(),
      setGlobalConcurrency: jest.fn().mockResolvedValue(undefined),
      ...(options.normalQueueOverrides ?? {})
    } as any;

    const legacyEvents = {
      on: jest.fn(),
      off: jest.fn()
    } as any;

    const hotEvents = {
      on: jest.fn(),
      off: jest.fn()
    } as any;

    const normalEvents = {
      on: jest.fn(),
      off: jest.fn()
    } as any;

    const processor = new CrawlQueueProcessor(
      env,
      crawlSettings,
      crawlExecutionService,
      crawlFrontierService,
      prisma,
      legacyQueue,
      hotQueue,
      normalQueue,
      legacyEvents,
      hotEvents,
      normalEvents
    );

    return {
      processor,
      crawlExecutionService,
      crawlFrontierService,
      legacyQueue,
      hotQueue,
      normalQueue,
      legacyEvents,
      hotEvents,
      normalEvents
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    workerInstances.length = 0;
  });

  it("creates workers for hot, legacy, and normal queues and forwards timeout tier", async () => {
    const { processor, crawlExecutionService } = createContext({
      requestTimeoutHotMs: 60_000,
      requestTimeoutNormalMs: 120_000
    });
    crawlExecutionService.runTask.mockResolvedValue({ inserted: 1, skipped: 0 });

    await processor.onModuleInit();

    expect((Worker as jest.Mock).mock.calls[0][0]).toBe("crawl4ai-hot");
    expect((Worker as jest.Mock).mock.calls[1][0]).toBe("crawl4ai");
    expect((Worker as jest.Mock).mock.calls[2][0]).toBe("crawl4ai-normal");

    const hotCallback = (Worker as jest.Mock).mock.calls[0][1] as (job: any) => Promise<unknown>;
    const legacyCallback = (Worker as jest.Mock).mock.calls[1][1] as (job: any) => Promise<unknown>;
    const normalCallback = (Worker as jest.Mock).mock.calls[2][1] as (job: any) => Promise<unknown>;

    const baseJob = {
      id: "job-1",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1"
      },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 }
      },
      attemptsMade: 0,
      attemptsStarted: 1
    };

    await hotCallback(baseJob);
    await legacyCallback({ ...baseJob, id: "job-2", data: { ...baseJob.data, taskId: "task-2" } });
    await normalCallback({ ...baseJob, id: "job-3", data: { ...baseJob.data, taskId: "task-3" } });

    expect(crawlExecutionService.runTask).toHaveBeenNthCalledWith(
      1,
      "task-1",
      "org-1",
      "user-1",
      expect.objectContaining({ priorityClass: "hot", requestTimeoutMs: 60_000 })
    );
    expect(crawlExecutionService.runTask).toHaveBeenNthCalledWith(
      2,
      "task-2",
      "org-1",
      "user-1",
      expect.objectContaining({ priorityClass: "normal", requestTimeoutMs: 120_000 })
    );
    expect(crawlExecutionService.runTask).toHaveBeenNthCalledWith(
      3,
      "task-3",
      "org-1",
      "user-1",
      expect.objectContaining({ priorityClass: "normal", requestTimeoutMs: 120_000 })
    );
  });

  it("enforces a shared global concurrency budget across hot and normal workers", async () => {
    const { processor, crawlExecutionService } = createContext({
      settingsMaxConcurrency: 1,
      envMaxConcurrency: 1
    });

    let firstResolve: ((value: unknown) => void) | null = null;
    crawlExecutionService.runTask
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            firstResolve = resolve;
          })
      )
      .mockResolvedValueOnce({ inserted: 1, skipped: 0 });

    await processor.onModuleInit();

    const hotCallback = (Worker as jest.Mock).mock.calls[0][1] as (job: any) => Promise<unknown>;
    const normalCallback = (Worker as jest.Mock).mock.calls[2][1] as (job: any) => Promise<unknown>;
    const baseJob = {
      id: "job-1",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1"
      },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 }
      },
      attemptsMade: 0,
      attemptsStarted: 1
    };

    const hotRun = hotCallback(baseJob);
    const normalRun = normalCallback({
      ...baseJob,
      id: "job-2",
      data: { ...baseJob.data, taskId: "task-2" }
    });

    for (let index = 0; index < 20 && crawlExecutionService.runTask.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(crawlExecutionService.runTask).toHaveBeenCalledTimes(1);

    firstResolve?.({ inserted: 1, skipped: 0 });
    await hotRun;
    for (let index = 0; index < 20 && crawlExecutionService.runTask.mock.calls.length < 2; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(crawlExecutionService.runTask).toHaveBeenCalledTimes(2);
    await normalRun;
  });

  it("applies queue-wide cooldown and requeues when crawl4ai reports memory pressure", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(
      new Crawl4aiRequestException("Memory at 96.1%, refusing new browser\n(status 500)", 500)
    );

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (job: any) => Promise<unknown>;
    const job = {
      id: "job-1",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1"
      },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 }
      },
      attemptsMade: 0,
      attemptsStarted: 1,
      updateData: jest.fn().mockResolvedValue(undefined)
    };

    await expect(workerCallback(job)).rejects.toBe(mockRateLimitError);
    for (const worker of workerInstances) {
      expect(worker.rateLimit).toHaveBeenCalledWith(90_000);
    }
    expect(WorkerMock.RateLimitError).toHaveBeenCalledTimes(1);
  });

  it("dispatches frontier-node jobs to crawlFrontierService", async () => {
    const { processor, crawlExecutionService, crawlFrontierService } = createContext({
      requestTimeoutHotMs: 60_000
    });
    crawlFrontierService.processQueuedNode.mockResolvedValue({ inserted: 1, skipped: 0 });

    await processor.onModuleInit();

    const hotCallback = (Worker as jest.Mock).mock.calls[0][1] as (job: any) => Promise<unknown>;
    await hotCallback({
      id: "job-frontier-1",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1",
        jobKind: "frontier_node",
        frontierNodeId: "node-1"
      },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 }
      },
      attemptsMade: 0,
      attemptsStarted: 1
    });

    expect(crawlFrontierService.processQueuedNode).toHaveBeenCalledWith(
      "node-1",
      "org-1",
      60_000
    );
    expect(crawlExecutionService.runTask).not.toHaveBeenCalled();
  });

  it("marks non-retryable errors as unrecoverable", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(new Error("bad input"));

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (job: any) => Promise<unknown>;
    const job = {
      id: "job-2",
      data: {
        taskId: "task-2",
        orgId: "org-1"
      },
      opts: {
        attempts: 3
      },
      attemptsMade: 0
    };

    await expect(workerCallback(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(workerInstances[0].rateLimit).not.toHaveBeenCalled();
  });

  it("applies global concurrency to all queues on startup", async () => {
    const legacySetGlobalConcurrency = jest.fn().mockResolvedValue(undefined);
    const hotSetGlobalConcurrency = jest.fn().mockResolvedValue(undefined);
    const normalSetGlobalConcurrency = jest.fn().mockResolvedValue(undefined);
    const { processor } = createContext({
      settingsMaxConcurrency: 5,
      legacyQueueOverrides: { setGlobalConcurrency: legacySetGlobalConcurrency },
      hotQueueOverrides: { setGlobalConcurrency: hotSetGlobalConcurrency },
      normalQueueOverrides: { setGlobalConcurrency: normalSetGlobalConcurrency }
    });

    await processor.onModuleInit();

    expect(legacySetGlobalConcurrency).toHaveBeenCalledWith(5);
    expect(hotSetGlobalConcurrency).toHaveBeenCalledWith(5);
    expect(normalSetGlobalConcurrency).toHaveBeenCalledWith(5);
  });
});
