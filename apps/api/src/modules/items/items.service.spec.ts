jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
  };
});

jest.mock("@modular/mongo", () => ({
  RawItemModel: { create: jest.fn() },
  ProcessedItemModel: { findOne: jest.fn(), find: jest.fn() }
}));

jest.mock("../config/prisma.service", () => ({
  PrismaService: class PrismaService {}
}));

jest.mock("../queue/queue.service", () => ({
  QueueService: class QueueService {}
}));

import { ItemsService } from "./items.service";

describe("ItemsService", () => {
  it("does not couple audit log write to the item transaction", async () => {
    const mongoMock = jest.requireMock("@modular/mongo");
    mongoMock.RawItemModel.create.mockResolvedValue({ id: "raw-1" });

    const tx = {
      itemMeta: {
        create: jest.fn().mockResolvedValue({
          id: "item-1",
          orgId: "org-1",
          externalId: "ext-1",
          name: "Item 1",
          status: "pending",
          mongoRef: "",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date()
        }),
        update: jest.fn().mockResolvedValue(undefined)
      },
      auditLog: {
        create: jest.fn(() => {
          throw new Error("should not be called on tx");
        })
      }
    };

    const prismaMock = {
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      auditLog: {
        create: jest.fn().mockRejectedValue(new Error("audit down"))
      },
      auditLogOutbox: {
        create: jest.fn().mockResolvedValue({ id: "outbox-1" })
      }
    } as any;

    const queueServiceMock = {
      enqueueItem: jest.fn().mockResolvedValue(undefined)
    } as any;

    const service = new ItemsService(prismaMock, queueServiceMock, {} as any);

    const result = await service.create("org-1", "user-1", {
      externalId: "ext-1",
      name: "Item 1",
      payload: {
        url: "https://example.com",
        keywords: [],
        tags: [],
        summaryHints: [],
        metadata: {},
        forceRefresh: false
      }
    });

    expect(result.id).toBe("item-1");
    expect(result.rawItemId).toBe("raw-1");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          actorId: "user-1",
          resource: "item",
          action: "create"
        })
      })
    );
    expect(queueServiceMock.enqueueItem).toHaveBeenCalledWith("org-1", "item-1", "raw-1");

    await new Promise((resolve) => setImmediate(resolve));
  });

  it("resolves search ids from processed articles", async () => {
    const mongoMock = jest.requireMock("@modular/mongo");
    const mockFind = jest.fn().mockReturnThis();
    mongoMock.ProcessedItemModel.find.mockReturnValue({
      limit: mockFind,
      lean: jest.fn().mockResolvedValue([{ itemMetaId: "meta-1" }])
    });

    const prismaMock = {
      $queryRaw: jest.fn().mockResolvedValue([
        { cleanedMarkdownRef: "507f1f77bcf86cd799439011" }
      ])
    } as any;

    const service = new ItemsService(prismaMock, {} as any, {} as any);

    const ids = await (service as any).resolveProcessedArticleSearchIds("org-1", {
      type: "fulltext",
      query: "article*"
    });

    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(ids).toEqual(["meta-1"]);
  });
});
