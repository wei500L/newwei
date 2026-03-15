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

  let service: AdminLogsService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new AdminLogsService(prismaMock, exceptionEvents);
  });

  it("paginates and redacts task log fields", async () => {
    (TaskLogModel.countDocuments as jest.Mock).mockResolvedValue(3);

    const queryChain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
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
      ]),
    };

    (TaskLogModel.find as jest.Mock).mockReturnValue(queryChain);

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

    expect(TaskLogModel.countDocuments).toHaveBeenCalledWith({
      orgId: "org-1",
      status: "failed",
    });
    expect(queryChain.skip).toHaveBeenCalledWith(2);
    expect(queryChain.limit).toHaveBeenCalledWith(2);
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
});
