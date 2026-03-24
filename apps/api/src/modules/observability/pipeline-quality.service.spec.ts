jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    aggregate: jest.fn(),
    find: jest.fn(),
  },
  TaskLogModel: {
    aggregate: jest.fn(),
  },
}));

import { ProcessedItemModel, TaskLogModel } from "@modular/mongo";

import { ITEM_PIPELINE_QUEUE_NAME } from "../queue/queue.constants";

import { PipelineQualityService } from "./pipeline-quality.service";

describe("PipelineQualityService", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("filters failure types by item pipeline queue", async () => {
    (ProcessedItemModel.aggregate as jest.Mock).mockResolvedValue([]);
    (TaskLogModel.aggregate as jest.Mock).mockResolvedValue([]);

    (ProcessedItemModel.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    const prisma = {
      mongoOutbox: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as any;
    const snapshots = {
      getOrCreate: jest.fn(
        async ({ loader }: { loader: () => Promise<unknown> }) => ({
          payload: await loader(),
        }),
      ),
    } as any;

    const service = new PipelineQualityService(prisma, snapshots);

    await service.summary("org-1", 60);

    const pipeline = (TaskLogModel.aggregate as jest.Mock).mock
      .calls[0]?.[0] as any[];
    expect(Array.isArray(pipeline)).toBe(true);
    expect(pipeline[0]?.$match?.orgId).toBe("org-1");
    expect(pipeline[0]?.$match?.queue).toBe(ITEM_PIPELINE_QUEUE_NAME);
    expect(pipeline[0]?.$match?.status).toBe("failed");
    expect(pipeline[0]?.$match?.createdAt?.$gte).toBeInstanceOf(Date);
  });

  it("counts dead outbox entries and excludes them from oldest backlog age", async () => {
    (ProcessedItemModel.aggregate as jest.Mock).mockResolvedValue([
      {
        statusAgg: [],
        latencyAgg: [],
        llmAgg: [],
      },
    ]);
    (TaskLogModel.aggregate as jest.Mock).mockResolvedValue([]);

    (ProcessedItemModel.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    const prisma = {
      mongoOutbox: {
        groupBy: jest.fn().mockResolvedValue([
          { status: "failed", _count: { _all: 1 } },
          { status: "dead", _count: { _all: 2 } },
        ]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date("2026-03-24T00:00:00.000Z"),
        }),
      },
    } as any;
    const snapshots = {
      getOrCreate: jest.fn(
        async ({ loader }: { loader: () => Promise<unknown> }) => ({
          payload: await loader(),
        }),
      ),
    } as any;

    const service = new PipelineQualityService(prisma, snapshots);
    const summary = await service.summary("org-1", 60);

    expect(summary.outbox?.totals).toEqual(
      expect.objectContaining({
        total: 3,
        failed: 1,
        dead: 2,
      }),
    );
    expect(prisma.mongoOutbox.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [
              "pending",
              "failed",
              "processing",
            ],
          },
        }),
      }),
    );
  });
});
