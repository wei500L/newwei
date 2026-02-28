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

  it("queries title and language related fields in projection", async () => {
    const loader = new ProcessedItemPreviewLoader();
    const now = new Date();

    (ProcessedItemModel.find as jest.Mock).mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: { toString: () => "completed-id" },
          itemMetaId: "meta-1",
          status: "completed",
          tags: [],
          result: {
            title: "LLM title",
            language: "zh-CN",
          },
          createdAt: now,
          updatedAt: now,
        },
      ]),
    });

    const dataLoader = loader.generateDataLoader();
    const result = await dataLoader.load("meta-1");

    expect(result?.result).toMatchObject({
      title: "LLM title",
      language: "zh-CN",
    });

    expect(ProcessedItemModel.find).toHaveBeenCalledTimes(1);
    const [, projection] = (ProcessedItemModel.find as jest.Mock).mock.calls[0] as [
      Record<string, unknown>,
      Record<string, 1>,
    ];
    expect(projection).toMatchObject({
      "result.title": 1,
      "result.headline": 1,
      "result.title_zh": 1,
      "result.titleZh": 1,
      "result.language": 1,
      "result.lang": 1,
      "result.content_type": 1,
      "result.contentType": 1,
      "result.publishedAt": 1,
      "result.sourceName": 1,
      "result.source_name": 1,
    });
  });
});
