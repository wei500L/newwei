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

    const service = new PipelineQualityService(prisma);

    await service.summary("org-1", 60);

    const pipeline = (TaskLogModel.aggregate as jest.Mock).mock.calls[0]?.[0] as any[];
    expect(Array.isArray(pipeline)).toBe(true);
    expect(pipeline[0]?.$match?.orgId).toBe("org-1");
    expect(pipeline[0]?.$match?.queue).toBe(ITEM_PIPELINE_QUEUE_NAME);
    expect(pipeline[0]?.$match?.status).toBe("failed");
    expect(pipeline[0]?.$match?.createdAt?.$gte).toBeInstanceOf(Date);
  });
});

