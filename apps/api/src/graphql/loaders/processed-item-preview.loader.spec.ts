jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: jest.fn(),
  },
}));

import { ProcessedItemModel } from "@modular/mongo";

import { ProcessedItemPreviewLoader } from "./processed-item-preview.loader";

describe("ProcessedItemPreviewLoader", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("prefers completed runs over newer pending docs", async () => {
    const loader = new ProcessedItemPreviewLoader();
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
  });
});

