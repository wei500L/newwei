jest.mock("@modular/utils", () => {
  const mockLogger = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn()
  };
  return {
    __mockLogger: mockLogger,
    createLogger: jest.fn(() => mockLogger),
    ensureTraceId: (traceId: string | undefined) => traceId ?? "test-trace-id",
    getCurrentTraceId: () => "test-trace-id"
  };
});

import { CrawlQueueService } from "./crawl-queue.service";

describe("CrawlQueueService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const utils = jest.requireMock("@modular/utils") as any;
    utils.__mockLogger.warn.mockClear();
    utils.__mockLogger.info.mockClear();
    utils.__mockLogger.error.mockClear();
  });

  const createQueueMock = () => ({
    add: jest.fn().mockResolvedValue(undefined),
    getJobs: jest.fn().mockResolvedValue([]),
    getJobCounts: jest
      .fn()
      .mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0, paused: 0 }),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    isPaused: jest.fn().mockResolvedValue(false),
    getGlobalConcurrency: jest.fn().mockResolvedValue(null),
    setGlobalConcurrency: jest.fn().mockResolvedValue(undefined)
  });

  const createActivityMock = () => ({
    markTaskQueued: jest.fn().mockResolvedValue(undefined)
  });

  it("routes enqueueTask to hot queue with source priority", async () => {
    const hotQueue = createQueueMock();
    const normalQueue = createQueueMock();
    const llmJudgeQueue = createQueueMock();
    const llmLearnQueue = createQueueMock();
    const activity = createActivityMock();
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        maxRetries: 2,
        retryBackoffMs: 1_000,
        maxConcurrency: 3
      })
    } as any;
    const service = new CrawlQueueService(
      hotQueue as any,
      normalQueue as any,
      llmJudgeQueue as any,
      llmLearnQueue as any,
      settings,
      activity as any,
    );

    await service.enqueueTask("task-1", "org-1", "user-1", {
      priorityClass: "hot",
      sourcePriority: 100
    });

    expect(hotQueue.add).toHaveBeenCalledTimes(1);
    expect(normalQueue.add).not.toHaveBeenCalled();

    const [, data, opts] = hotQueue.add.mock.calls[0];
    expect(data).toMatchObject({
      taskId: "task-1",
      orgId: "org-1",
      triggeredById: "user-1",
      traceId: "test-trace-id",
      memoryPressureRequeues: 0,
      priorityClass: "hot",
      sourcePriority: 100
    });
    expect(opts.priority).toBe(1);
    expect(opts.deduplication).toEqual({ id: "crawl-task:task-1:hot" });
    expect(activity.markTaskQueued).toHaveBeenCalledTimes(1);
  });

  it("routes enqueueTask to normal queue by default", async () => {
    const hotQueue = createQueueMock();
    const normalQueue = createQueueMock();
    const llmJudgeQueue = createQueueMock();
    const llmLearnQueue = createQueueMock();
    const activity = createActivityMock();
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        maxRetries: 2,
        retryBackoffMs: 1_000,
        maxConcurrency: 3
      })
    } as any;
    const service = new CrawlQueueService(
      hotQueue as any,
      normalQueue as any,
      llmJudgeQueue as any,
      llmLearnQueue as any,
      settings,
      activity as any,
    );

    await service.enqueueTask("task-2", "org-1", "user-1");

    expect(normalQueue.add).toHaveBeenCalledTimes(1);
    expect(hotQueue.add).not.toHaveBeenCalled();

    const [, data, opts] = normalQueue.add.mock.calls[0];
    expect(data.priorityClass).toBe("normal");
    expect(opts.priority).toBeUndefined();
    expect(opts.deduplication).toEqual({ id: "crawl-task:task-2:normal" });
    expect(activity.markTaskQueued).toHaveBeenCalledTimes(1);
  });

  it("removes matching jobs from both queues and ignores lock errors", async () => {
    const hotQueue = createQueueMock();
    const normalQueue = createQueueMock();
    const llmJudgeQueue = createQueueMock();
    const llmLearnQueue = createQueueMock();
    const activity = createActivityMock();
    const settings = { getSettings: jest.fn() } as any;
    const service = new CrawlQueueService(
      hotQueue as any,
      normalQueue as any,
      llmJudgeQueue as any,
      llmLearnQueue as any,
      settings,
      activity as any,
    );

    const lockedJob = {
      id: "locked",
      data: { taskId: "task-1" },
      remove: jest
        .fn()
        .mockRejectedValue(
          new Error("Job locked could not be removed because it is locked by another worker")
        ),
      getState: jest.fn()
    };
    const okJob = {
      id: "ok",
      data: { taskId: "task-1" },
      remove: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn()
    };

    hotQueue.getJobs.mockResolvedValueOnce([lockedJob, okJob]);
    normalQueue.getJobs.mockResolvedValueOnce([]);

    await service.removeQueuedJobs("task-1");

    expect(lockedJob.remove).toHaveBeenCalledTimes(1);
    expect(okJob.remove).toHaveBeenCalledTimes(1);
    expect(hotQueue.getJobs).toHaveBeenCalled();
    expect(normalQueue.getJobs).toHaveBeenCalled();

    const utils = jest.requireMock("@modular/utils") as any;
    expect(utils.__mockLogger.warn).not.toHaveBeenCalled();
  });

  it("aggregates job counts and pending from both queues", async () => {
    const hotQueue = createQueueMock();
    const normalQueue = createQueueMock();
    const llmJudgeQueue = createQueueMock();
    const llmLearnQueue = createQueueMock();
    const activity = createActivityMock();
    const settings = {
      getSettings: jest.fn().mockResolvedValue({ maxConcurrency: 3 })
    } as any;
    const service = new CrawlQueueService(
      hotQueue as any,
      normalQueue as any,
      llmJudgeQueue as any,
      llmLearnQueue as any,
      settings,
      activity as any,
    );

    hotQueue.getJobCounts.mockResolvedValue({ waiting: 2, active: 1, delayed: 0, failed: 1, paused: 0 });
    normalQueue.getJobCounts.mockResolvedValue({ waiting: 3, active: 0, delayed: 1, failed: 0, paused: 0 });

    const counts = await service.getJobCounts();
    const pending = await service.getPendingJobCount();

    expect(counts).toEqual({ waiting: 5, active: 1, delayed: 1, failed: 1, paused: 0 });
    expect(pending).toBe(7);
  });

  it("applies pause/resume and global concurrency to both queues", async () => {
    const hotQueue = createQueueMock();
    const normalQueue = createQueueMock();
    const llmJudgeQueue = createQueueMock();
    const llmLearnQueue = createQueueMock();
    const activity = createActivityMock();
    hotQueue.getGlobalConcurrency.mockResolvedValue(4);
    normalQueue.getGlobalConcurrency.mockResolvedValue(2);

    const settings = {
      getSettings: jest.fn().mockResolvedValue({ maxConcurrency: 3 })
    } as any;
    const service = new CrawlQueueService(
      hotQueue as any,
      normalQueue as any,
      llmJudgeQueue as any,
      llmLearnQueue as any,
      settings,
      activity as any,
    );

    await service.pauseQueue();
    await service.resumeQueue();
    await service.setGlobalConcurrency(5);

    const effective = await service.getEffectiveConcurrencyByQueue();
    const paused = await service.getPausedByQueue();

    expect(hotQueue.pause).toHaveBeenCalledTimes(1);
    expect(normalQueue.pause).toHaveBeenCalledTimes(1);
    expect(hotQueue.resume).toHaveBeenCalledTimes(1);
    expect(normalQueue.resume).toHaveBeenCalledTimes(1);
    expect(hotQueue.setGlobalConcurrency).toHaveBeenCalledWith(5);
    expect(normalQueue.setGlobalConcurrency).toHaveBeenCalledWith(5);

    expect(effective).toEqual({ hot: 4, normal: 2 });
    expect(paused).toEqual({ hot: false, normal: false });
    expect(settings.getSettings).toHaveBeenCalled();
  });

  it("enqueues dedicated frontier LLM judge and learn jobs", async () => {
    const hotQueue = createQueueMock();
    const normalQueue = createQueueMock();
    const llmJudgeQueue = createQueueMock();
    const llmLearnQueue = createQueueMock();
    const activity = createActivityMock();
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        maxRetries: 2,
        retryBackoffMs: 1_000,
        maxConcurrency: 3,
      }),
    } as any;
    const service = new CrawlQueueService(
      hotQueue as any,
      normalQueue as any,
      llmJudgeQueue as any,
      llmLearnQueue as any,
      settings,
      activity as any,
    );

    await service.enqueueFrontierLlmJudge({
      taskId: "task-1",
      orgId: "org-1",
      runId: "run-1",
      nodeId: "node-1",
      payload: {
        mode: "discovery",
        runId: "run-1",
        nodeId: "node-1",
        taskId: "task-1",
        maxDepth: 3,
        maxPages: 10,
        candidates: [],
      },
    });
    await service.enqueueFrontierLlmLearn({
      taskId: "task-1",
      orgId: "org-1",
      runId: "run-1",
      payload: {
        runId: "run-1",
      },
    });

    expect(llmJudgeQueue.add).toHaveBeenCalledTimes(1);
    expect(llmLearnQueue.add).toHaveBeenCalledTimes(1);
    expect(llmJudgeQueue.add.mock.calls[0][1]).toMatchObject({
      orgId: "org-1",
      taskId: "task-1",
      jobKind: "frontier_llm_judge",
    });
    expect(llmLearnQueue.add.mock.calls[0][1]).toMatchObject({
      orgId: "org-1",
      taskId: "task-1",
      jobKind: "frontier_llm_learn",
    });
  });
});
