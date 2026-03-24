jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
  };
});

import { MongoOutboxStatus, MongoOutboxType } from "@prisma/client";

import { CrawlCleanupOutboxService } from "../crawl-cleanup-outbox.service";

describe("CrawlCleanupOutboxService", () => {
  it("marks invalid payloads as dead", async () => {
    const prisma = {
      mongoOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "outbox-1",
              orgId: "org-1",
              payload: { nope: true },
              attempts: 0,
              status: MongoOutboxStatus.pending,
              createdAt: new Date("2026-03-23T00:00:00.000Z")
            }
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;

    const resultService = {
      deleteTaskResults: jest.fn()
    } as any;

    const service = new CrawlCleanupOutboxService(prisma, resultService);
    await service.retryPendingCleanupOutbox();

    expect(prisma.mongoOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({
          status: MongoOutboxStatus.dead,
          lockedAt: null
        })
      })
    );
  });

  it("marks delivery failures for retry before max attempts", async () => {
    const prisma = {
      runInTransaction: jest.fn().mockImplementation(async (fn: any) => {
        const tx = {
          mongoOutbox: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ id: "outbox-1", attempts: 1 })
          }
        };
        return fn(tx);
      }),
      mongoOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "outbox-1",
              orgId: "org-1",
              payload: {
                type: MongoOutboxType.cleanup_crawl_results,
                taskId: "task-1",
                orgId: "org-1"
              },
              attempts: 0,
              status: MongoOutboxStatus.pending,
              createdAt: new Date("2026-03-23T00:00:00.000Z")
            }
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        delete: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;

    const resultService = {
      deleteTaskResults: jest.fn().mockRejectedValue(new Error("delete failed"))
    } as any;

    const service = new CrawlCleanupOutboxService(prisma, resultService);
    await service.retryPendingCleanupOutbox();

    expect(resultService.deleteTaskResults).toHaveBeenCalledWith("task-1", "org-1");
    expect(prisma.mongoOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({
          status: MongoOutboxStatus.failed,
          lockedAt: null
        })
      })
    );
  });

  it("marks delivery failures as dead after max attempts", async () => {
    const prisma = {
      runInTransaction: jest.fn().mockImplementation(async (fn: any) => {
        const tx = {
          mongoOutbox: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ id: "outbox-1", attempts: 10 })
          }
        };
        return fn(tx);
      }),
      mongoOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "outbox-1",
              orgId: "org-1",
              payload: {
                type: MongoOutboxType.cleanup_crawl_results,
                taskId: "task-1",
                orgId: "org-1"
              },
              attempts: 9,
              status: MongoOutboxStatus.failed,
              createdAt: new Date("2026-03-23T00:00:00.000Z")
            }
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        delete: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;

    const resultService = {
      deleteTaskResults: jest.fn().mockRejectedValue(new Error("delete failed"))
    } as any;

    const service = new CrawlCleanupOutboxService(prisma, resultService);
    await service.retryPendingCleanupOutbox();

    expect(prisma.mongoOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({
          status: MongoOutboxStatus.dead,
          lockedAt: null,
          attempts: 10
        })
      })
    );
  });

  it("merges pending, failed, and stale processing batches by createdAt", async () => {
    const deliveryOrder: string[] = [];
    const prisma = {
      runInTransaction: jest.fn().mockImplementation(async (fn: any) => {
        const tx = {
          mongoOutbox: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUnique: jest.fn().mockResolvedValue({ attempts: 1 })
          }
        };
        return fn(tx);
      }),
      mongoOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "outbox-pending",
              orgId: "org-1",
              payload: {
                type: MongoOutboxType.cleanup_crawl_results,
                taskId: "task-pending"
              },
              attempts: 0,
              status: MongoOutboxStatus.pending,
              createdAt: new Date("2026-03-23T00:02:00.000Z")
            }
          ])
          .mockResolvedValueOnce([
            {
              id: "outbox-failed",
              orgId: "org-1",
              payload: {
                type: MongoOutboxType.cleanup_crawl_results,
                taskId: "task-failed"
              },
              attempts: 0,
              status: MongoOutboxStatus.failed,
              createdAt: new Date("2026-03-23T00:03:00.000Z")
            }
          ])
          .mockResolvedValueOnce([
            {
              id: "outbox-processing",
              orgId: "org-1",
              payload: {
                type: MongoOutboxType.cleanup_crawl_results,
                taskId: "task-processing"
              },
              attempts: 0,
              status: MongoOutboxStatus.processing,
              createdAt: new Date("2026-03-23T00:01:00.000Z")
            }
          ]),
        delete: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;

    const resultService = {
      deleteTaskResults: jest.fn().mockImplementation(async (taskId: string) => {
        deliveryOrder.push(taskId);
      })
    } as any;

    const service = new CrawlCleanupOutboxService(prisma, resultService);
    await service.retryPendingCleanupOutbox();

    expect(deliveryOrder).toEqual(["task-processing", "task-pending", "task-failed"]);
  });
});
