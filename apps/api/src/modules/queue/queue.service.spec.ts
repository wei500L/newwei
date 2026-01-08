jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  },
  TaskLogModel: {
    find: jest.fn(() => ({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    })),
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
  it("reads org counts without scanning jobs", async () => {
    const { QueueService } = require("./queue.service") as typeof import("./queue.service");
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
    expect(queue.getJobs).not.toHaveBeenCalled();
    expect(result.counts).toEqual({
      waiting: 1,
      active: 2,
      completed: 0,
      failed: 3,
      delayed: 4,
    });
  });

  it("records initial job status for org counters", async () => {
    const { QueueService } = require("./queue.service") as typeof import("./queue.service");
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
      { processedItemId: "65f1c2d3e4f5a6b7c8d9e0f2" }
    );

    expect(orgStats.upsertJobMetaAndCount).toHaveBeenCalledWith({
      jobId: "meta-1:65f1c2d3e4f5a6b7c8d9e0f1",
      orgId: "org-1",
      status: "delayed",
      keepCompleted: false,
      keepFailed: true,
    });
  });
});
