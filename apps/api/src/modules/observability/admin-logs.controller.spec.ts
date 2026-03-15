import type { AuthenticatedUser } from "../../modules/auth/auth.service";

import { AdminLogsController } from "./admin-logs.controller";

describe("AdminLogsController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    email: "demo@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: ["settings.manage"],
    firstName: "Demo",
    lastName: "User",
  };

  const adminLogs = {
    listTaskLogs: jest.fn().mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] }),
    summarizeTaskLogs: jest.fn().mockResolvedValue({ totals: {}, byStage: [], topErrors: [] }),
    listErrors: jest.fn().mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] }),
    summarizeErrors: jest.fn().mockResolvedValue({ total: 0, byKind: [], byDay: [] }),
    listAuditLogs: jest.fn().mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] }),
  };

  let controller: AdminLogsController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new AdminLogsController(adminLogs as any);
  });

  it("parses task log list filters and pagination", async () => {
    await controller.listTaskLogs(
      user,
      " pipeline ",
      " job-1 ",
      " ingest ",
      "failed",
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2",
      "50",
    );

    expect(adminLogs.listTaskLogs).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        queue: "pipeline",
        jobId: "job-1",
        stage: "ingest",
        status: "failed",
        start: new Date("2026-03-01T00:00:00.000Z"),
        end: new Date("2026-03-02T00:00:00.000Z"),
      },
      { page: 2, pageSize: 50 },
    );
  });

  it("passes error filters through the unified errors list", async () => {
    await controller.listErrors(
      user,
      "graphql",
      " newsEventBrief ",
      " invalid JSON ",
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.999Z",
      "3",
      "100",
    );

    expect(adminLogs.listErrors).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        kind: "graphql",
        operationName: "newsEventBrief",
        messageContains: "invalid JSON",
        start: new Date("2026-02-01T00:00:00.000Z"),
        end: new Date("2026-02-28T23:59:59.999Z"),
      },
      { page: 3, pageSize: 100 },
    );
  });

  it("passes audit filters and pagination", async () => {
    await controller.listAuditLogs(
      user,
      " rate-limit ",
      " settings ",
      " update ",
      "2026-01-01T00:00:00.000Z",
      "2026-01-31T23:59:59.999Z",
      "4",
      "20",
    );

    expect(adminLogs.listAuditLogs).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        search: "rate-limit",
        resource: "settings",
        action: "update",
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-31T23:59:59.999Z"),
      },
      { page: 4, pageSize: 20 },
    );
  });
});
