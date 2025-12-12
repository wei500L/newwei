import { MongoOutboxStatus, MongoOutboxType } from "@prisma/client";
import { CrawlTaskService } from "../crawl-task.service";

describe("CrawlTaskService", () => {
  it("records a cleanup intent in MongoOutbox when deleting a task", async () => {
    const tx = {
      crawlResult: { deleteMany: jest.fn().mockResolvedValue(undefined) },
      crawlTask: { delete: jest.fn().mockResolvedValue(undefined) },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      mongoOutbox: { create: jest.fn().mockResolvedValue(undefined) }
    };

    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue({
          id: "task-1",
          orgId: "org-1",
          results: [{ id: "r1" }, { id: "r2" }]
        })
      },
      $transaction: jest.fn(async (cb: any) => cb(tx))
    } as any;

    const queueServiceMock = {
      removeQueuedJobs: jest.fn().mockResolvedValue(undefined)
    } as any;

    const resultServiceMock = {
      deleteTaskResults: jest.fn().mockResolvedValue(undefined)
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      queueServiceMock,
      resultServiceMock,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any
    );

    const result = await service.deleteTask("org-1", "user-1", "task-1");

    expect(queueServiceMock.removeQueuedJobs).toHaveBeenCalledWith("task-1");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.mongoOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org-1",
        type: MongoOutboxType.cleanup_crawl_results,
        status: MongoOutboxStatus.pending,
        payload: {
          type: MongoOutboxType.cleanup_crawl_results,
          taskId: "task-1",
          orgId: "org-1"
        }
      })
    });
    expect(resultServiceMock.deleteTaskResults).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: "task-1", deletedResultCount: 2 });
  });
});

