jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
  };
});

import { writeAuditLogBestEffort } from "./audit-log.writer";

describe("writeAuditLogBestEffort", () => {
  beforeAll(() => {
    process.env.NODE_ENV = "production";
  });

  it("writes audit logs directly when possible", async () => {
    const prisma = {
      auditLog: { create: jest.fn().mockResolvedValue({ id: "log-1" }) },
      auditLogOutbox: { create: jest.fn() }
    } as any;

    await writeAuditLogBestEffort(prisma, {
      data: {
        orgId: "org-1",
        actorId: "user-1",
        resource: "auth",
        action: "login",
        metadata: { ok: true }
      }
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLogOutbox.create).not.toHaveBeenCalled();
  });

  it("enqueues audit logs to outbox when direct writes fail", async () => {
    const prisma = {
      auditLog: { create: jest.fn().mockRejectedValue(new Error("db down")) },
      auditLogOutbox: { create: jest.fn().mockResolvedValue({ id: "outbox-1" }) }
    } as any;

    await writeAuditLogBestEffort(prisma, {
      data: {
        orgId: "org-1",
        actorId: "user-1",
        resource: "auth",
        action: "login"
      }
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLogOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("throws when both direct write and outbox enqueue fail", async () => {
    const prisma = {
      auditLog: { create: jest.fn().mockRejectedValue(new Error("db down")) },
      auditLogOutbox: { create: jest.fn().mockRejectedValue(new Error("outbox down")) }
    } as any;

    await expect(
      writeAuditLogBestEffort(prisma, {
        data: {
          orgId: "org-1",
          actorId: "user-1",
          resource: "auth",
          action: "login"
        }
      })
    ).rejects.toThrow("db down");
  });
});
