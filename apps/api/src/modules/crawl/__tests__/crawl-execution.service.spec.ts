jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn()
  }
}));

import { NotificationType } from "@prisma/client";
import { TaskLogModel } from "@modular/mongo";
import { CrawlExecutionService } from "../crawl-execution.service";

describe("CrawlExecutionService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("retries notifications.notify before giving up", async () => {
    const notify = jest
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);

    const service = new CrawlExecutionService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { notify } as any
    );

    const task = { id: "task-1", orgId: "org-1", targetUrl: "https://example.com" } as any;
    const summary = { inserted: 1, skipped: 2, lastFetchedAt: new Date() } as any;

    const promise = (service as any).safeNotifyCrawl(task, summary, "user-1", "completed");
    await jest.runAllTimersAsync();
    await promise;

    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "user-1",
        type: NotificationType.crawl_completed
      })
    );
    expect(TaskLogModel.create).not.toHaveBeenCalled();
  });

  it("writes a notify failure log after exhausting retries", async () => {
    const notify = jest.fn().mockRejectedValue(new Error("db down"));
    (TaskLogModel.create as jest.Mock).mockResolvedValue(undefined);

    const service = new CrawlExecutionService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { notify } as any
    );

    const task = { id: "task-1", orgId: "org-1", targetUrl: "https://example.com" } as any;
    const summary = { inserted: 0, skipped: 0, lastFetchedAt: null } as any;

    const promise = (service as any).safeNotifyCrawl(task, summary, "user-1", "failed", "boom");
    await jest.runAllTimersAsync();
    await promise;

    expect(notify).toHaveBeenCalledTimes(3);
    expect(TaskLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "crawl4ai",
        jobId: "task-1",
        orgId: "org-1",
        stage: "notify",
        status: "failed",
        data: expect.objectContaining({
          taskId: "task-1",
          status: "failed",
          notificationType: NotificationType.crawl_failed
        })
      })
    );
  });
});

