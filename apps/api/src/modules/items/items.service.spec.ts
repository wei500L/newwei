import { ItemStatus } from "../../common/pipeline-status";

import { ItemsService } from "./items.service";

jest.mock("@modular/mongo", () => ({
  RawItemModel: {
    create: jest.fn()
  },
  ProcessedItemModel: {}
}));

describe("ItemsService.list", () => {
  it("returns total consistent with filtered item rows", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "meta-1",
            orgId: "org-1",
            createdAt: new Date("2024-01-03T00:00:00.000Z"),
            updatedAt: new Date("2024-01-04T00:00:00.000Z")
          }
        ]),
        count: jest.fn().mockResolvedValue(1)
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    (service as any).resolveScopedIds = jest.fn().mockResolvedValue(["meta-1", "meta-2"]);

    const result = await service.list(
      "org-1",
      1,
      10,
      "hello world",
      undefined,
      "CREATED_DESC"
    );

    expect(prisma.itemMeta.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 10,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        where: {
          orgId: "org-1",
          status: { not: ItemStatus.Duplicate },
          id: { in: ["meta-1", "meta-2"] }
        }
      })
    );

    expect(prisma.itemMeta.count).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        status: { not: ItemStatus.Duplicate },
        id: { in: ["meta-1", "meta-2"] }
      }
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("ItemsService.listWithCursor", () => {
  it("uses sortAt keyset pagination for published desc", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "meta-1",
            orgId: "org-1",
            createdAt: new Date("2024-01-03T00:00:00.000Z"),
            sortAt: new Date("2024-01-03T00:00:00.000Z")
          },
          {
            id: "meta-0",
            orgId: "org-1",
            createdAt: new Date("2024-01-02T00:00:00.000Z"),
            sortAt: new Date("2024-01-02T00:00:00.000Z")
          }
        ]),
        count: jest.fn().mockResolvedValue(2),
        findFirst: jest.fn()
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    await service.listWithCursor(
      "org-1",
      1,
      { id: "meta-2", sortAt: "2024-01-02T00:00:00.000Z" },
      undefined,
      undefined,
      "PUBLISHED_DESC"
    );

    expect(prisma.itemMeta.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sortAt: "desc" }, { id: "desc" }],
        take: 2,
        where: {
          AND: [
            { orgId: "org-1", status: { not: ItemStatus.Duplicate } },
            {
              OR: [
                { sortAt: { lt: new Date("2024-01-02T00:00:00.000Z") } },
                { sortAt: new Date("2024-01-02T00:00:00.000Z"), id: { lt: "meta-2" } }
              ]
            }
          ]
        }
      })
    );

    expect(prisma.itemMeta.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to loading cursor timestamps when missing", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({
          id: "meta-1",
          orgId: "org-1",
          createdAt: new Date("2024-01-02T00:00:00.000Z"),
          sortAt: new Date("2024-01-05T00:00:00.000Z")
        })
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    await service.listWithCursor(
      "org-1",
      1,
      { id: "meta-1" },
      undefined,
      undefined,
      "PUBLISHED_DESC"
    );

    expect(prisma.itemMeta.findFirst).toHaveBeenCalledWith({
      where: { id: "meta-1", orgId: "org-1" },
      select: { createdAt: true, sortAt: true }
    });

    expect(prisma.itemMeta.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sortAt: "desc" }, { id: "desc" }],
        take: 2
      })
    );
  });
});

describe("ItemsService.createFromCrawlResult", () => {
  it("creates an item meta + raw item and enqueues the pipeline job", async () => {
    const { RawItemModel } = jest.requireMock("@modular/mongo") as {
      RawItemModel: { create: jest.Mock };
    };

    const prisma = {
      crawlResult: {
        findFirst: jest.fn().mockResolvedValue({
          id: "crawl-result-1",
          taskId: "crawl-task-1",
          sourceUrl: "https://example.com/story",
          fetchedAt: new Date("2024-01-01T00:00:00.000Z"),
          contentHash: "hash-1",
          metadata: { thumbnail: "https://example.com/thumb.jpg" },
          task: { id: "crawl-task-1", displayName: "Example", targetUrl: "https://example.com" }
        })
      },
      itemMeta: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "meta-1",
          orgId: "org-1",
          externalId: "crawlResult:crawl-result-1",
          name: "Example: https://example.com/story",
          status: ItemStatus.Pending,
          mongoRef: "",
          createdAt: new Date("2024-01-02T00:00:00.000Z"),
          updatedAt: new Date("2024-01-02T00:00:00.000Z")
        }),
        update: jest.fn().mockResolvedValue(null)
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma))
    };

    RawItemModel.create.mockResolvedValue({ id: "raw-1" });

    const queueService = { enqueueItem: jest.fn().mockResolvedValue(null) };

    const service = new ItemsService(
      prisma as any,
      queueService as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    const created = await service.createFromCrawlResult("org-1", "user-1", "crawl-result-1");

    expect(prisma.crawlResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "crawl-result-1",
          task: { orgId: "org-1" }
        }
      })
    );
    expect(prisma.itemMeta.create).toHaveBeenCalledTimes(1);
    expect(RawItemModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        itemMetaId: "meta-1",
        source: "crawl-task",
        payload: expect.objectContaining({
          url: "https://example.com/story",
          sourceName: "Example",
          metadata: expect.objectContaining({
            crawlResultId: "crawl-result-1",
            crawlTaskId: "crawl-task-1"
          })
        })
      })
    );
    expect(queueService.enqueueItem).toHaveBeenCalledWith("org-1", "meta-1", "raw-1");
    expect(created.id).toBe("meta-1");
  });
});
