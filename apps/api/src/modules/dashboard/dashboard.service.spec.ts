jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: { countDocuments: jest.fn() }
}));

jest.mock("../config/prisma.service", () => ({
  PrismaService: class PrismaService {}
}));

jest.mock("../queue/queue.service", () => ({
  QueueService: class QueueService {}
}));

import { BadRequestException, ConflictException } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";

const prismaMock = {
  dashboard: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn()
  },
  dashboardWidget: {
    update: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn()
  },
  $transaction: jest.fn()
} as unknown as any;

const queueServiceMock = {
  stats: jest.fn()
} as unknown as any;

describe("DashboardService.upsertDashboard", () => {
  let service: DashboardService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction = jest.fn().mockImplementation(async (handler: any) => handler(prismaMock));
    service = new DashboardService(prismaMock, queueServiceMock, {} as any);
  });

  it("requires version for updates", async () => {
    prismaMock.dashboard.findUnique = jest.fn().mockResolvedValue({
      id: "dash-1",
      orgId: "org-1",
      version: 3,
      widgets: []
    });

    await expect(
      service.upsertDashboard(
        "org-1",
        { id: "dash-1", name: "n", slug: "s", widgets: [] },
        "user-1"
      )
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects stale version updates", async () => {
    prismaMock.dashboard.findUnique = jest.fn().mockResolvedValue({
      id: "dash-1",
      orgId: "org-1",
      version: 3,
      widgets: []
    });
    prismaMock.dashboard.updateMany = jest.fn().mockResolvedValue({ count: 0 });

    await expect(
      service.upsertDashboard(
        "org-1",
        { id: "dash-1", version: 2, name: "n", slug: "s", widgets: [] },
        "user-1"
      )
    ).rejects.toThrow(ConflictException);
  });

  it("increments version on successful update", async () => {
    prismaMock.dashboard.findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        id: "dash-1",
        orgId: "org-1",
        version: 3,
        widgets: []
      })
      .mockResolvedValueOnce({
        id: "dash-1",
        orgId: "org-1",
        version: 4
      })
      .mockResolvedValueOnce({
        id: "dash-1",
        orgId: "org-1",
        version: 4,
        widgets: []
      });

    prismaMock.dashboard.updateMany = jest.fn().mockResolvedValue({ count: 1 });

    const result = await service.upsertDashboard(
      "org-1",
      { id: "dash-1", version: 3, name: "n", slug: "s", widgets: [] },
      "user-1"
    );

    expect(prismaMock.dashboard.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dash-1", orgId: "org-1", version: 3 },
        data: expect.objectContaining({ version: { increment: 1 } })
      })
    );
    expect(result?.version).toBe(4);
  });
});
