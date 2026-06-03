jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: jest.fn(),
  },
}));

import { ProcessedItemModel } from "@modular/mongo";

import { ProcessedItemLoader, ProcessedItemScalarLoader } from "./processed-item.loader";

describe("ProcessedItemLoader", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("prefers completed runs over newer pending docs", async () => {
    const loader = new ProcessedItemLoader();
    const now = new Date();
    const older = new Date(now.getTime() - 60_000);

    const docs = [
      {
        _id: { toString: () => "pending-id" },
        itemMetaId: "meta-1",
        status: "pending",
        tags: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: { toString: () => "completed-id" },
        itemMetaId: "meta-1",
        status: "completed",
        tags: ["ok"],
        result: { summary: "done" },
        createdAt: older,
        updatedAt: older,
      },
    ];

    (ProcessedItemModel.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(docs),
    });

    const dataLoader = loader.generateDataLoader();
    const result = await dataLoader.load("meta-1");

    expect(result).toMatchObject({
      id: "completed-id",
      status: "completed",
      tags: ["ok"],
    });
    expect(ProcessedItemModel.find).toHaveBeenCalledWith(
      { itemMetaId: { $in: ["meta-1"] } },
      expect.objectContaining({
        result: 1,
        summaryEmbeddingDimensions: 1
      })
    );
  });

  it("surfaces error metadata when the latest run failed", async () => {
    const loader = new ProcessedItemLoader();
    const now = new Date();
    const older = new Date(now.getTime() - 60_000);

    const docs = [
      {
        _id: { toString: () => "pending-id" },
        itemMetaId: "meta-1",
        status: "pending",
        tags: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: { toString: () => "failed-id" },
        itemMetaId: "meta-1",
        status: "failed",
        tags: [],
        error: { message: "boom", name: "LiteLLMError" },
        createdAt: older,
        updatedAt: older,
      },
    ];

    (ProcessedItemModel.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(docs),
    });

    const dataLoader = loader.generateDataLoader();
    const result = await dataLoader.load("meta-1");

    expect(result).toMatchObject({
      id: "failed-id",
      status: "failed",
      error: { message: "boom", name: "LiteLLMError" },
    });
  });

  it("loads scalar fields without result or summaryEmbedding", async () => {
    const loader = new ProcessedItemScalarLoader();
    const now = new Date();

    (ProcessedItemModel.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: { toString: () => "processed-id" },
          itemMetaId: "meta-1",
          status: "completed",
          tags: [],
          summaryEmbeddingModel: "embed-1",
          summaryEmbeddingDimensions: 1536,
          createdAt: now,
          updatedAt: now
        }
      ]),
    });

    const dataLoader = loader.generateDataLoader();
    const result = await dataLoader.load("meta-1");

    expect(result).toMatchObject({
      id: "processed-id",
      summaryEmbeddingModel: "embed-1",
      summaryEmbeddingDimensions: 1536
    });
    expect(result?.result).toBeUndefined();
    const projection = (ProcessedItemModel.find as jest.Mock).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(projection.result).toBeUndefined();
    expect(projection.summaryEmbedding).toBeUndefined();
    expect(projection.summaryEmbeddingDimensions).toBe(1);
  });
});
