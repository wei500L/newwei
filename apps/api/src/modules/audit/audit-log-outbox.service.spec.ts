jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  };
});

import { AuditLogOutboxStatus } from "@prisma/client";

import { AuditLogOutboxService } from "./audit-log-outbox.service";

const createCache = () =>
  ({
    withLock: jest.fn(
      async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
        await runner(),
    ),
  }) as any;

describe("AuditLogOutboxService", () => {
  beforeAll(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("marks invalid payloads as dead", async () => {
    const createdAt = new Date("2026-03-23T00:00:00.000Z");
    const prisma = {
      auditLogOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "outbox-1",
              orgId: "org-1",
              payload: { nope: true },
              attempts: 0,
              status: AuditLogOutboxStatus.pending,
              createdAt,
            },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        update: jest.fn().mockResolvedValue(undefined),
      },
    } as any;

    const service = new AuditLogOutboxService(prisma, createCache());
    await service.retryPendingAuditLogOutbox();

    expect(prisma.auditLogOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({ status: AuditLogOutboxStatus.dead }),
      }),
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
            findUnique: jest
              .fn()
              .mockResolvedValue({ id: "outbox-1", attempts: 1 }),
          },
        };
        return fn(tx);
      }),
      auditLog: {
        create: jest.fn().mockRejectedValue(new Error("write failed")),
      },
      auditLogOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "outbox-1",
              orgId: "org-1",
              payload: {
                orgId: "org-1",
                actorId: "user-1",
                resource: "auth",
                action: "login",
                createdAt: nowIso,
              },
              attempts: 0,
              status: AuditLogOutboxStatus.pending,
              createdAt: new Date(nowIso),
            },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        delete: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    } as any;

    const service = new AuditLogOutboxService(prisma, createCache());
    await service.retryPendingAuditLogOutbox();

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLogOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({
          status: AuditLogOutboxStatus.failed,
          lockedAt: null,
        }),
      }),
    );

    randomSpy.mockRestore();
  });

  it("processes multiple outbox entries without serial blocking", async () => {
    const nowIso = new Date().toISOString();
    let resolveSlowStarted: (() => void) | null = null;
    let resolveFastStarted: (() => void) | null = null;
    const slowStarted = new Promise<void>((resolve) => {
      resolveSlowStarted = resolve;
    });
    const fastStarted = new Promise<void>((resolve) => {
      resolveFastStarted = resolve;
    });
    let releaseSlowWrite: (() => void) | null = null;
    const slowWrite = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve;
    });

    const prisma = {
      runInTransaction: jest.fn().mockImplementation(async (fn: any) => {
        const tx = {
          auditLogOutbox: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ attempts: 1 }),
          },
        };
        return fn(tx);
      }),
      auditLog: {
        create: jest
          .fn()
          .mockImplementation(
            async ({ data }: { data: { resource: string } }) => {
              if (data.resource === "slow-resource") {
                resolveSlowStarted?.();
                await slowWrite;
                return;
              }
              resolveFastStarted?.();
            },
          ),
      },
      auditLogOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "outbox-slow",
              orgId: "org-1",
              payload: {
                orgId: "org-1",
                resource: "slow-resource",
                action: "create",
                createdAt: nowIso,
              },
              attempts: 0,
              status: AuditLogOutboxStatus.pending,
              createdAt: new Date("2026-03-23T00:00:00.000Z"),
            },
          ])
          .mockResolvedValueOnce([
            {
              id: "outbox-fast",
              orgId: "org-1",
              payload: {
                orgId: "org-1",
                resource: "fast-resource",
                action: "create",
                createdAt: nowIso,
              },
              attempts: 0,
              status: AuditLogOutboxStatus.failed,
              createdAt: new Date("2026-03-23T00:01:00.000Z"),
            },
          ])
          .mockResolvedValueOnce([]),
        delete: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
    } as any;

    const service = new AuditLogOutboxService(prisma, createCache());
    const retryPromise = service.retryPendingAuditLogOutbox();

    await Promise.all([slowStarted, fastStarted]);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ resource: "slow-resource" }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ resource: "fast-resource" }),
      }),
    );

    releaseSlowWrite?.();
    await retryPromise;

    expect(prisma.auditLogOutbox.delete).toHaveBeenCalledTimes(2);
  });
});
