jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
  };
});

import { AuditLogOutboxStatus } from "@prisma/client";
import { AuditLogOutboxService } from "./audit-log-outbox.service";

describe("AuditLogOutboxService", () => {
  beforeAll(() => {
    process.env.NODE_ENV = "production";
  });

  it("marks invalid payloads as dead", async () => {
    const prisma = {
      auditLogOutbox: {
        findMany: jest.fn().mockResolvedValue([
          { id: "outbox-1", orgId: "org-1", payload: { nope: true }, attempts: 0 }
        ]),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;

    const service = new AuditLogOutboxService(prisma);
    await service.retryPendingAuditLogOutbox();

    expect(prisma.auditLogOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({ status: AuditLogOutboxStatus.dead })
      })
    );
  });

  it("marks delivery failures as failed for retry", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);

    const nowIso = new Date().toISOString();
    const prisma = {
      runInTransaction: jest.fn().mockImplementation(async (fn: any) => {
        const tx = {
          auditLogOutbox: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ id: "outbox-1", attempts: 1 })
          }
        };
        return fn(tx);
      }),
      auditLog: { create: jest.fn().mockRejectedValue(new Error("write failed")) },
      auditLogOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "outbox-1",
            orgId: "org-1",
            payload: {
              orgId: "org-1",
              actorId: "user-1",
              resource: "auth",
              action: "login",
              createdAt: nowIso
            },
            attempts: 0
          }
        ]),
        delete: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;

    const service = new AuditLogOutboxService(prisma);
    await service.retryPendingAuditLogOutbox();

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLogOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({ status: AuditLogOutboxStatus.failed, lockedAt: null })
      })
    );

    randomSpy.mockRestore();
  });
});
