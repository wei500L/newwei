const mockProcessedItemFindOne = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    findOne: (...args: unknown[]) => mockProcessedItemFindOne(...args)
  }
}));

import { BadRequestException } from "@nestjs/common";

import { ProcessedItemResolver } from "./processed-item.resolver";

describe("ProcessedItemResolver.processedItemById", () => {
  const resolver = new ProcessedItemResolver();

  const makeQuery = (doc: unknown) => ({
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(doc)
  });

  it("throws BadRequest for invalid ObjectId", async () => {
    await expect(
      resolver.processedItemById({ user: { orgId: "org-1" } } as any, "not-an-objectid")
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns null when document does not exist", async () => {
    mockProcessedItemFindOne.mockReturnValueOnce(makeQuery(null));

    const result = await resolver.processedItemById(
      { user: { orgId: "org-1" } } as any,
      "507f1f77bcf86cd799439011"
    );

    expect(result).toBeNull();
  });

  it("filters by orgId", async () => {
    mockProcessedItemFindOne.mockReturnValueOnce(makeQuery(null));

    const result = await resolver.processedItemById(
      { user: { orgId: "org-1" } } as any,
      "507f1f77bcf86cd799439011"
    );

    expect(result).toBeNull();
    expect(mockProcessedItemFindOne).toHaveBeenCalledWith({
      _id: "507f1f77bcf86cd799439011",
      orgId: "org-1"
    });
  });

  it("returns processed item when orgId matches and normalizes resultJson", async () => {
    mockProcessedItemFindOne.mockReturnValueOnce(
      makeQuery({
        _id: { toString: () => "507f1f77bcf86cd799439011" },
        orgId: "org-1",
        itemMetaId: "meta-1",
        status: "completed",
        tags: ["tag-1", 123],
        result: JSON.stringify({
          summary: "s",
          key_points: ["k1"],
          cleaned_markdown: "# Hello"
        }),
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      })
    );

    const result = await resolver.processedItemById(
      { user: { orgId: "org-1" } } as any,
      "507f1f77bcf86cd799439011"
    );

    expect(result).toMatchObject({
      id: "507f1f77bcf86cd799439011",
      itemMetaId: "meta-1",
      status: "completed",
      tags: ["tag-1"],
      resultJson: expect.objectContaining({
        summary: "s",
        cleaned_markdown: "# Hello"
      })
    });
    expect(result?.result).toBeTruthy();
    expect(JSON.parse(result!.result!)).toMatchObject({ cleaned_markdown: "# Hello" });
  });
});
