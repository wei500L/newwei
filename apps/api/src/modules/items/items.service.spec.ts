import { ItemStatus } from "../../common/pipeline-status";

import { ItemsService } from "./items.service";

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
