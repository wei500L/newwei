const mockTaskLogFindChain = {
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue([]),
};

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  },
  TaskLogModel: {
    find: jest.fn(() => mockTaskLogFindChain),
  },
}));

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  };
});

describe("QueueService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTaskLogFindChain.lean.mockResolvedValue([]);
  });

  it("reads org counts without scanning jobs", async () => {
    const { QueueService } =
      require("./queue.service") as typeof import("./queue.service");
    const { TaskLogModel } =
      require("@modular/mongo") as typeof import("@modular/mongo");
    const queue = {
      add: jest.fn(),
      getJobs: jest.fn(() => {
        throw new Error("getJobs should not be called");
      }),
    } as any;

    const orgStats = {
      getCounts: jest.fn().mockResolvedValue({
        waiting: 1,
        active: 2,
        completed: 0,
        failed: 3,
        delayed: 4,
      }),
      upsertJobMetaAndCount: jest.fn(),
    } as any;

    const service = new QueueService(queue, orgStats);
    const result = await service.stats("org-1");

    expect(orgStats.getCounts).toHaveBeenCalledWith("org-1");
    expect(TaskLogModel.find).toHaveBeenCalledWith({
      orgId: "org-1",
      queue: "itemPipeline",
    });
    expect(mockTaskLogFindChain.select).toHaveBeenCalledWith({
      _id: 0,
      createdAt: 1,
      jobId: 1,
      message: 1,
      stage: 1,
      status: 1,
    });
    expect(queue.getJobs).not.toHaveBeenCalled();
    expect(result.counts).toEqual({
      waiting: 1,
      active: 2,
      completed: 0,
      failed: 3,
      delayed: 4,
    });
  });

  it("projects only lightweight recent log fields for dashboard stats", async () => {
    const { QueueService } =
      require("./queue.service") as typeof import("./queue.service");
    const logs = [
      {
        createdAt: new Date("2026-03-22T00:00:00.000Z"),
        jobId: "job-1",
        message: "completed",
        stage: "complete",
        status: "completed",
      },
    ];
    mockTaskLogFindChain.lean.mockResolvedValue(logs);

    const service = new QueueService(
      { add: jest.fn() } as any,
      {
        getCounts: jest.fn().mockResolvedValue({
          waiting: 0,
          active: 0,
          completed: 1,
          failed: 0,
          delayed: 0,
        }),
        upsertJobMetaAndCount: jest.fn(),
      } as any,
    );

    const result = await service.stats("org-1");

    expect(result.recentLogs).toEqual(logs);
  });

  it("records initial job status for org counters", async () => {
    const { QueueService } =
      require("./queue.service") as typeof import("./queue.service");
    const queue = {
      add: jest.fn().mockResolvedValue({ id: "job-1" }),
    } as any;

    const orgStats = {
      getCounts: jest.fn(),
      upsertJobMetaAndCount: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new QueueService(queue, orgStats);
    await service.enqueueItem(
      "org-1",
      "meta-1",
      "65f1c2d3e4f5a6b7c8d9e0f1",
      { delay: 10 },
      { processedItemId: "65f1c2d3e4f5a6b7c8d9e0f2" },
    );

    expect(orgStats.upsertJobMetaAndCount).toHaveBeenCalledWith({
      jobId: "meta-1-65f1c2d3e4f5a6b7c8d9e0f1",
      orgId: "org-1",
      status: "delayed",
      keepCompleted: false,
      keepFailed: true,
    });
  });

  it("does not upsert pending item when the queue job already exists", async () => {
    const { QueueService } =
      require("./queue.service") as typeof import("./queue.service");
    const { ProcessedItemModel } =
      require("@modular/mongo") as typeof import("@modular/mongo");

    const existingJob = { id: "job-1" };
    const queue = {
      add: jest
        .fn()
        .mockRejectedValue(new Error("Job meta-1-raw-1 already exists")),
      getJob: jest.fn().mockResolvedValue(existingJob),
    } as any;

    const orgStats = {
      getCounts: jest.fn(),
      upsertJobMetaAndCount: jest.fn(),
    } as any;

    const service = new QueueService(queue, orgStats);
    const job = await service.enqueueItem(
      "org-1",
      "meta-1",
      "65f1c2d3e4f5a6b7c8d9e0f1",
      {},
      { processedItemId: "65f1c2d3e4f5a6b7c8d9e0f2" },
    );

    expect(job).toBe(existingJob);
    expect(ProcessedItemModel.updateOne).not.toHaveBeenCalled();
  });
});
