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

describe("CrawlQueueService.removeQueuedJobs", () => {
  beforeEach(() => {
    const utils = jest.requireMock("@modular/utils") as any;
    utils.__mockLogger.warn.mockClear();
    utils.__mockLogger.info.mockClear();
    utils.__mockLogger.error.mockClear();
  });

  it("skips removal when a job becomes locked/active during deletion", async () => {
    const queue = {
      getJobs: jest.fn()
    };
    const settings = {} as any;
    const service = new CrawlQueueService(queue as any, settings);

    const lockedJob = {
      id: "locked",
      data: { taskId: "t1" },
      remove: jest.fn().mockRejectedValue(new Error("Job locked could not be removed because it is locked by another worker")),
      getState: jest.fn()
    };
    const okJob = {
      id: "ok",
      data: { taskId: "t1" },
      remove: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn()
    };
    const otherJob = {
      id: "other",
      data: { taskId: "t2" },
      remove: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn()
    };

    queue.getJobs.mockResolvedValueOnce([lockedJob, okJob, otherJob]);

    await service.removeQueuedJobs("t1");

    expect(queue.getJobs).toHaveBeenCalledTimes(1);
    const [states, start, end] = queue.getJobs.mock.calls[0];
    expect(states).toEqual(["waiting", "delayed", "failed", "paused"]);
    expect(states).not.toContain("active");
    expect(start).toBe(0);
    expect(end).toBe(199);

    expect(lockedJob.remove).toHaveBeenCalledTimes(1);
    expect(lockedJob.getState).not.toHaveBeenCalled();
    expect(okJob.remove).toHaveBeenCalledTimes(1);
    expect(otherJob.remove).not.toHaveBeenCalled();

    const utils = jest.requireMock("@modular/utils") as any;
    expect(utils.__mockLogger.warn).not.toHaveBeenCalled();
  });

  it("logs a warning for unexpected removal errors", async () => {
    const queue = {
      getJobs: jest.fn()
    };
    const settings = {} as any;
    const service = new CrawlQueueService(queue as any, settings);

    const badJob = {
      id: "bad",
      data: { taskId: "t1" },
      remove: jest.fn().mockRejectedValue(new Error("boom")),
      getState: jest.fn().mockResolvedValue("waiting")
    };

    queue.getJobs.mockResolvedValueOnce([badJob]);

    await service.removeQueuedJobs("t1");

    const utils = jest.requireMock("@modular/utils") as any;
    expect(utils.__mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(utils.__mockLogger.warn.mock.calls[0][0]).toMatchObject({
      taskId: "t1",
      jobId: "bad",
      state: "waiting"
    });
  });
});
