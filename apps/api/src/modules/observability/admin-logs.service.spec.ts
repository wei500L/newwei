jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    aggregate: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
  },
}));

import { TaskLogModel } from "@modular/mongo";

import { AdminLogsService } from "./admin-logs.service";

describe("AdminLogsService", () => {
  const prismaMock = {
    auditLog: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
  } as any;

  const exceptionEvents = {
    list: jest.fn(),
    stats: jest.fn(),
  } as any;
  const cacheMock = {
    wrap: jest.fn().mockImplementation(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  } as any;

  let service: AdminLogsService;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheMock.wrap = jest.fn().mockImplementation(
      async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
    );
    service = new AdminLogsService(prismaMock, exceptionEvents, cacheMock);
  });

  it("paginates and redacts task log fields", async () => {
    (TaskLogModel.aggregate as jest.Mock).mockResolvedValue([
      {
        total: [{ count: 3 }],
        items: [
          {
            _id: { toString: () => "log-1" },
            queue: "crawl4ai",
            jobId: "job-1",
            orgId: "org-1",
            stage: "execute",
            status: "failed",
            message: "Bearer secret-token",
            data: {
              headers: {
                authorization: "Bearer another-secret",
                traceId: "trace-1",
              },
            },
            error: {
              message: "token=very-secret",
            },
            createdAt: new Date("2026-03-15T12:00:00.000Z"),
            updatedAt: new Date("2026-03-15T12:01:00.000Z"),
          },
        ],
        statusAgg: [{ _id: "failed", count: 3 }],
        stageAgg: [{ _id: "execute", count: 3 }],
        errorAgg: [
          {
            _id: { queue: "crawl4ai", stage: "execute", errorName: "unknown" },
            sampleMessage: "Bearer secret-token",
            count: 3,
          },
        ],
      },
    ]);

    const result = await service.listTaskLogs(
      {
        orgId: "org-1",
        status: "failed",
      },
      {
        page: 2,
        pageSize: 2,
      },
    );

    expect(TaskLogModel.aggregate).toHaveBeenCalledWith([
      expect.objectContaining({
        $match: {
          orgId: "org-1",
          status: "failed",
        },
      }),
      expect.objectContaining({
        $facet: expect.objectContaining({
          items: expect.arrayContaining([
            { $sort: { createdAt: -1 } },
            { $skip: 2 },
            { $limit: 2 },
          ]),
        }),
      }),
    ]);
    expect(result).toMatchObject({
      page: 2,
      pageSize: 2,
      total: 3,
      items: [
        {
          id: "log-1",
          message: "Bearer [REDACTED]",
          data: {
            headers: {
              authorization: "[REDACTED]",
              traceId: "trace-1",
            },
          },
          error: {
            message: "token=[REDACTED]",
          },
        },
      ],
    });
  });

  it("builds audit search filters on the server side", async () => {
    prismaMock.auditLog.count.mockResolvedValue(1);
    prismaMock.auditLog.findMany.mockResolvedValue([
      {
        id: "audit-1",
        orgId: "org-1",
        actorId: "user-1",
        resource: "settings",
        action: "update",
        metadata: { key: "value" },
        ipAddress: "127.0.0.1",
        createdAt: new Date("2026-03-15T10:00:00.000Z"),
      },
    ]);

    const result = await service.listAuditLogs(
      {
        orgId: "org-1",
        search: "rate-limit",
        resource: "settings",
        action: "update",
        start: new Date("2026-03-01T00:00:00.000Z"),
        end: new Date("2026-03-31T23:59:59.999Z"),
      },
      {
        page: 1,
        pageSize: 20,
      },
    );

    const where = prismaMock.auditLog.count.mock.calls[0][0].where;
    expect(where).toMatchObject({
      orgId: "org-1",
      AND: expect.arrayContaining([
        { resource: { contains: "settings" } },
        { action: { contains: "update" } },
        {
          createdAt: {
            gte: new Date("2026-03-01T00:00:00.000Z"),
            lte: new Date("2026-03-31T23:59:59.999Z"),
          },
        },
      ]),
    });
    expect(result).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [
        {
          id: "audit-1",
          resource: "settings",
          action: "update",
        },
      ],
    });
  });

  it("caches quality task-log overview responses for a short TTL", async () => {
    (TaskLogModel.aggregate as jest.Mock).mockResolvedValue([
      {
        items: [
          {
            _id: { toString: () => "log-1" },
            queue: "crawl4ai",
            jobId: "job-1",
            orgId: "org-1",
            stage: "execute",
            status: "failed",
            message: "boom",
            createdAt: new Date("2026-03-15T12:00:00.000Z"),
            updatedAt: new Date("2026-03-15T12:01:00.000Z"),
          },
        ],
        statusAgg: [{ _id: "failed", count: 1 }],
        stageAgg: [{ _id: "execute", count: 1 }],
        errorAgg: [
          {
            _id: { queue: "crawl4ai", stage: "execute", errorName: "unknown" },
            sampleMessage: "boom",
            count: 1,
          },
        ],
      },
    ]);

    const result = await service.getQualityTaskLogsOverview("org-1", {
      sinceMinutes: 60,
      limit: 5,
    });

    expect(cacheMock.wrap).toHaveBeenCalledWith(
      "quality:task-logs:overview:org-1:60:5",
      15,
      expect.any(Function),
      expect.objectContaining({
        lockTtlMs: 2000,
        retryDelayMs: 50,
        maxWaitMs: 3000,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.summary.totals.failed).toBe(1);
  });
});
