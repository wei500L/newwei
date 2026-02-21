/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  ensureTraceId: jest.fn((traceId?: string) => traceId ?? "test-trace-id"),
  runWithTraceId: jest.fn(async (_traceId: string, fn: () => Promise<any>) =>
    fn(),
  ),
}));

const mockWorkerInstance = {
  on: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  rateLimit: jest.fn().mockResolvedValue(undefined),
};
const mockRateLimitError = new Error("__rate_limit__");
const WorkerMock = jest.fn(() => mockWorkerInstance) as unknown as jest.Mock & {
  RateLimitError: jest.Mock;
};
WorkerMock.RateLimitError = jest.fn(() => mockRateLimitError);

jest.mock("bullmq", () => ({
  Worker: WorkerMock,
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  },
}));

import { Worker, UnrecoverableError } from "bullmq";

import { Crawl4aiRequestException } from "./crawl4ai.exception";
import { CrawlQueueProcessor } from "./crawl.processor";

describe("CrawlQueueProcessor", () => {
  const createContext = (
    options: {
      envMaxConcurrency?: number;
      settingsMaxConcurrency?: number;
      queueOverloadCooldownMs?: number;
      queueOverrides?: Record<string, unknown>;
    } = {},
  ) => {
    const env = {
      crawl4aiConfig: {
        maxConcurrency: options.envMaxConcurrency ?? 3,
      },
    } as any;

    const crawlSettings = {
      getSettings: jest.fn().mockResolvedValue({
        maxConcurrency:
          options.settingsMaxConcurrency ?? options.envMaxConcurrency ?? 3,
        queueOverloadCooldownMs: options.queueOverloadCooldownMs ?? 30_000,
      }),
    } as any;

    const crawlExecutionService = {
      runTask: jest.fn(),
    } as any;

    const prisma = {
      crawlTask: {
        updateMany: jest.fn(),
      },
    } as any;

    const queue = {
      opts: {
        connection: { host: "localhost", port: 6379 },
      },
      getJob: jest.fn(),
      ...(options.queueOverrides ?? {}),
    } as any;

    const events = {
      on: jest.fn(),
    } as any;

    const processor = new CrawlQueueProcessor(
      env,
      crawlSettings,
      crawlExecutionService,
      prisma,
      queue,
      events,
    );

    return { processor, crawlExecutionService, queue };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("applies queue-wide cooldown and requeues when crawl4ai reports memory pressure", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(
      new Crawl4aiRequestException(
        "Memory at 96.1%, refusing new browser\n(status 500)",
        500,
      ),
    );

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (
      job: any,
    ) => Promise<unknown>;
    const job = {
      id: "job-1",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1",
      },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      },
      attemptsMade: 0,
      attemptsStarted: 1,
    };

    await expect(workerCallback(job)).rejects.toBe(mockRateLimitError);
    expect(mockWorkerInstance.rateLimit).toHaveBeenCalledWith(90_000);
    expect(WorkerMock.RateLimitError).toHaveBeenCalledTimes(1);
  });

  it("marks memory-pressure errors as unrecoverable when retry budget is exhausted", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(
      new Crawl4aiRequestException(
        "Memory at 96.1%, refusing new browser\n(status 500)",
        500,
      ),
    );

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (
      job: any,
    ) => Promise<unknown>;
    const job = {
      id: "job-1-exhausted",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1",
      },
      opts: {
        attempts: 3,
      },
      attemptsMade: 0,
      attemptsStarted: 3,
    };

    await expect(workerCallback(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockWorkerInstance.rateLimit).not.toHaveBeenCalled();
    expect(WorkerMock.RateLimitError).not.toHaveBeenCalled();
  });

  it("uses memory-pressure requeue counter when attemptsStarted is unavailable", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(
      new Crawl4aiRequestException(
        "Memory at 96.1%, refusing new browser\n(status 500)",
        500,
      ),
    );

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (
      job: any,
    ) => Promise<unknown>;
    const updateData = jest.fn().mockResolvedValue(undefined);
    const job = {
      id: "job-1-counter",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1",
        memoryPressureRequeues: 0,
      },
      opts: {
        attempts: 3,
      },
      attemptsMade: 0,
      updateData,
    };

    await expect(workerCallback(job)).rejects.toBe(mockRateLimitError);
    expect(updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryPressureRequeues: 1,
      }),
    );
  });

  it("marks memory-pressure errors as unrecoverable when requeue counter budget is exhausted", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(
      new Crawl4aiRequestException(
        "Memory at 96.1%, refusing new browser\n(status 500)",
        500,
      ),
    );

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (
      job: any,
    ) => Promise<unknown>;
    const job = {
      id: "job-1-counter-exhausted",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1",
        memoryPressureRequeues: 2,
      },
      opts: {
        attempts: 3,
      },
      attemptsMade: 0,
    };

    await expect(workerCallback(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockWorkerInstance.rateLimit).not.toHaveBeenCalled();
    expect(WorkerMock.RateLimitError).not.toHaveBeenCalled();
  });

  it("fails memory-pressure requeue as unrecoverable when retry state cannot be persisted", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(
      new Crawl4aiRequestException(
        "Memory at 96.1%, refusing new browser\n(status 500)",
        500,
      ),
    );

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (
      job: any,
    ) => Promise<unknown>;
    const job = {
      id: "job-1-no-persist",
      data: {
        taskId: "task-1",
        orgId: "org-1",
        triggeredById: "user-1",
        memoryPressureRequeues: 0,
      },
      opts: {
        attempts: 3,
      },
      attemptsMade: 0,
    };

    await expect(workerCallback(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockWorkerInstance.rateLimit).toHaveBeenCalledTimes(1);
    expect(WorkerMock.RateLimitError).not.toHaveBeenCalled();
  });

  it("prefers configured worker concurrency when global concurrency update fails", async () => {
    const setGlobalConcurrency = jest
      .fn()
      .mockRejectedValue(new Error("redis unavailable"));
    const { processor } = createContext({
      envMaxConcurrency: 8,
      settingsMaxConcurrency: 2,
      queueOverrides: {
        setGlobalConcurrency,
      },
    });

    await processor.onModuleInit();

    expect(setGlobalConcurrency).toHaveBeenCalledWith(2);
    const workerOptions = (Worker as jest.Mock).mock.calls[0][2] as {
      concurrency: number;
    };
    expect(workerOptions.concurrency).toBe(2);
  });

  it("marks non-retryable errors as unrecoverable", async () => {
    const { processor, crawlExecutionService } = createContext();
    crawlExecutionService.runTask.mockRejectedValue(new Error("bad input"));

    await processor.onModuleInit();

    const workerCallback = (Worker as jest.Mock).mock.calls[0][1] as (
      job: any,
    ) => Promise<unknown>;
    const job = {
      id: "job-2",
      data: {
        taskId: "task-2",
        orgId: "org-1",
      },
      opts: {
        attempts: 3,
      },
      attemptsMade: 0,
    };

    await expect(workerCallback(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockWorkerInstance.rateLimit).not.toHaveBeenCalled();
  });
});
