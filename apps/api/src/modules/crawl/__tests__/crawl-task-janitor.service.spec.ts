import { TaskLogModel } from "@modular/mongo";
import { CrawlTaskJanitorService } from "../crawl-task-janitor.service";

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  };
});

const prismaMock = {
  crawlTask: {
    findMany: jest.fn(),
    updateMany: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  }
} as any;

const envMock = {
  crawlTaskJanitorConfig: {
    enabled: true,
    runningTimeoutMs: 60_000,
    queuedTimeoutMs: 60_000,
    batchSize: 50,
    queueScanLimit: 1_000,
    lockTtlMs: 120_000
  }
} as any;

const queueServiceMock = {
  getPendingJobCount: jest.fn(),
  listPendingTaskIds: jest.fn()
} as any;

const cacheMock = {
  withLock: jest.fn()
} as any;

describe("CrawlTaskJanitorService", () => {
  let service: CrawlTaskJanitorService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.crawlTask.findMany = jest.fn().mockResolvedValue([]);
    prismaMock.crawlTask.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    queueServiceMock.getPendingJobCount = jest.fn().mockResolvedValue(0);
    queueServiceMock.listPendingTaskIds = jest.fn().mockResolvedValue(new Set());
    cacheMock.withLock = jest.fn().mockImplementation(async (_key: string, _ttlMs: number, runner: () => Promise<any>) =>
      runner()
    );
    (TaskLogModel.create as jest.Mock).mockResolvedValue(undefined);
    service = new CrawlTaskJanitorService(prismaMock, envMock, queueServiceMock, cacheMock);
  });

  it("no-ops when there are no stale tasks", async () => {
    const result = await service.cleanupStaleTasks(new Date());
    expect(result).toEqual({ staleRunning: 0, staleQueued: 0 });
    expect(prismaMock.crawlTask.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(TaskLogModel.create).not.toHaveBeenCalled();
  });

  it("guards cron cleanup with a distributed lock", async () => {
    const spy = jest.spyOn(service, "cleanupStaleTasks").mockResolvedValue({
      staleRunning: 0,
      staleQueued: 0
    });
    await service.cleanupCron();
    expect(cacheMock.withLock).toHaveBeenCalledWith(
      "cron:crawl-task-janitor",
      envMock.crawlTaskJanitorConfig.lockTtlMs,
      expect.any(Function)
    );
    expect(spy).toHaveBeenCalled();
  });

  it("marks stale running tasks as failed", async () => {
    prismaMock.crawlTask.findMany = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: "task-1",
          orgId: "org-1",
          lastRunAt: new Date(Date.now() - 120_000),
          updatedAt: new Date(Date.now() - 120_000)
        }
      ])
      .mockResolvedValueOnce([]);
    prismaMock.crawlTask.updateMany = jest.fn().mockResolvedValue({ count: 1 });

    const result = await service.cleanupStaleTasks(new Date());
    expect(result.staleRunning).toBe(1);
    expect(prismaMock.crawlTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "running"
        })
      })
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          resource: "crawlTask",
          action: "auto_fail_stale"
        })
      })
    );
    expect(TaskLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        jobId: "task-1",
        stage: "cleanup"
      })
    );
  });

  it("skips queued tasks that still have pending jobs", async () => {
    prismaMock.crawlTask.findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "task-2",
          orgId: "org-1",
          lastRunAt: null,
          updatedAt: new Date(Date.now() - 120_000)
        }
      ]);
    queueServiceMock.getPendingJobCount = jest.fn().mockResolvedValue(1);
    queueServiceMock.listPendingTaskIds = jest.fn().mockResolvedValue(new Set(["task-2"]));

    const result = await service.cleanupStaleTasks(new Date());
    expect(result).toEqual({ staleRunning: 0, staleQueued: 0 });
    expect(prismaMock.crawlTask.updateMany).not.toHaveBeenCalled();
  });

  it("marks queued tasks as failed when no pending jobs exist", async () => {
    prismaMock.crawlTask.findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "task-3",
          orgId: "org-2",
          lastRunAt: null,
          updatedAt: new Date(Date.now() - 120_000)
        }
      ]);
    queueServiceMock.getPendingJobCount = jest.fn().mockResolvedValue(0);
    queueServiceMock.listPendingTaskIds = jest.fn().mockResolvedValue(new Set());
    prismaMock.crawlTask.updateMany = jest.fn().mockResolvedValue({ count: 1 });

    const result = await service.cleanupStaleTasks(new Date());
    expect(result).toEqual({ staleRunning: 0, staleQueued: 1 });
    expect(prismaMock.crawlTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "queued"
        })
      })
    );
  });
});
