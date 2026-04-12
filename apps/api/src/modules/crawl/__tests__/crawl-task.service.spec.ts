import { MongoOutboxStatus, MongoOutboxType } from "@prisma/client";

jest.mock(
  "@modular/vector-client",
  () => ({
    VectorBadResponseError: class VectorBadResponseError extends Error {},
    VectorClient: class VectorClient {
      search = jest.fn();
      upsert = jest.fn();
    },
    VectorServiceUnavailableError: class VectorServiceUnavailableError extends Error {},
    VectorUnauthorizedError: class VectorUnauthorizedError extends Error {},
  }),
  { virtual: true },
);

import { CrawlTaskService } from "../crawl-task.service";

describe("CrawlTaskService", () => {
  it("reuses the loaded crawl result page when ingesting items", async () => {
    const itemsServiceMock = {
      createFromCrawlResultsBatch: jest.fn().mockResolvedValue([
        {
          crawlResultId: "result-2",
          itemMeta: { id: "item-2" },
          status: "fulfilled",
        },
      ]),
    } as any;

    const resultPage = [
      {
        id: "result-1",
        taskId: "task-1",
        sourceUrl: "https://example.com/1",
        fetchedAt: new Date("2024-01-02T00:00:00.000Z"),
        contentHash: "hash-1",
        metadata: {},
        task: {
          id: "task-1",
          displayName: "Example",
          targetUrl: "https://example.com",
          keywords: ["markets"],
          config: null,
        },
      },
      {
        id: "result-2",
        taskId: "task-1",
        sourceUrl: "https://example.com/2",
        fetchedAt: new Date("2024-01-01T00:00:00.000Z"),
        contentHash: "hash-2",
        metadata: {},
        task: {
          id: "task-1",
          displayName: "Example",
          targetUrl: "https://example.com",
          keywords: ["markets"],
          config: null,
        },
      },
    ];

    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue({ id: "task-1" }),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue(resultPage),
      },
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([{ externalId: "crawlResult:result-1" }]),
      },
    } as any;

    const moduleRef = {
      get: jest.fn().mockReturnValue(itemsServiceMock),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      {} as any,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
      moduleRef,
    );

    const summary = await service.ingestResultsToItems("org-1", "user-1", "task-1");

    expect(itemsServiceMock.createFromCrawlResultsBatch).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      {
        crawlResults: [resultPage[1]],
      },
    );
    expect(summary).toEqual({
      taskId: "task-1",
      scanned: 2,
      attempted: 1,
      ingested: 1,
      skippedExisting: 1,
      failed: 0,
      nextCursor: null,
      hasMore: false,
    });
  });

  it("does not treat empty mongoRef item metas as already ingested", async () => {
    const itemsServiceMock = {
      createFromCrawlResultsBatch: jest.fn().mockResolvedValue([
        {
          crawlResultId: "result-1",
          itemMeta: { id: "item-1" },
          status: "fulfilled",
        },
      ]),
    } as any;

    const resultPage = [
      {
        id: "result-1",
        taskId: "task-1",
        sourceUrl: "https://example.com/1",
        fetchedAt: new Date("2024-01-02T00:00:00.000Z"),
        contentHash: "hash-1",
        metadata: {},
        task: {
          id: "task-1",
          displayName: "Example",
          targetUrl: "https://example.com",
          keywords: ["markets"],
          config: null,
        },
      },
    ];

    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue({ id: "task-1" }),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue(resultPage),
      },
      itemMeta: {
        findMany: jest.fn().mockImplementation(async (args: any) => {
          const row = {
            externalId: "crawlResult:result-1",
            mongoRef: "",
          };
          const mongoRefFilter = args?.where?.mongoRef;
          const matchesMongoRef =
            !mongoRefFilter || row.mongoRef !== mongoRefFilter.not;
          return matchesMongoRef ? [{ externalId: row.externalId }] : [];
        }),
      },
    } as any;

    const moduleRef = {
      get: jest.fn().mockReturnValue(itemsServiceMock),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      {} as any,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
      moduleRef,
    );

    const summary = await service.ingestResultsToItems("org-1", "user-1", "task-1");

    expect(prismaMock.itemMeta.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        externalId: { in: ["crawlResult:result-1"] },
        mongoRef: { not: "" },
      },
      select: { externalId: true },
    });
    expect(itemsServiceMock.createFromCrawlResultsBatch).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      {
        crawlResults: resultPage,
      },
    );
    expect(summary).toEqual({
      taskId: "task-1",
      scanned: 1,
      attempted: 1,
      ingested: 1,
      skippedExisting: 0,
      failed: 0,
      nextCursor: null,
      hasMore: false,
    });
  });

  it("records a cleanup intent in MongoOutbox when deleting a task", async () => {
    const tx = {
      crawlResult: { deleteMany: jest.fn().mockResolvedValue(undefined) },
      crawlTask: { delete: jest.fn().mockResolvedValue(undefined) },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      mongoOutbox: { create: jest.fn().mockResolvedValue(undefined) },
    };

    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue({
          id: "task-1",
          orgId: "org-1",
          results: [{ id: "r1" }, { id: "r2" }],
        }),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    } as any;

    const queueServiceMock = {
      removeQueuedJobs: jest.fn().mockResolvedValue(undefined),
    } as any;

    const resultServiceMock = {
      deleteTaskResults: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      queueServiceMock,
      resultServiceMock,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
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
          orgId: "org-1",
        },
      }),
    });
    expect(resultServiceMock.deleteTaskResults).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: "task-1", deletedResultCount: 2 });
  });

  it("strips jsCode/jsOnly for non-admin users", async () => {
    const prismaMock = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({
          role: { name: "manager" },
          roles: [],
        }),
      },
      crawlTask: {
        create: jest
          .fn()
          .mockResolvedValue({ id: "task-1", _count: { results: 0 } }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;

    const executionServiceMock = {
      normalizeOptions: jest.fn().mockReturnValue({}),
    } as any;

    const queueServiceMock = {
      enqueueTask: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      executionServiceMock,
      queueServiceMock,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest.spyOn(service, "toView").mockReturnValue({ id: "task-1" } as any);

    await service.createTask("org-1", "user-1", {
      url: "https://example.com",
      options: {
        jsCode: ["console.log('pwn')"],
        jsOnly: true,
        multiUrlConfigs: [
          {
            urls: ["https://example.com/a"],
            options: {
              jsCode: ["console.log('nested')"],
              jsOnly: true,
            },
          },
        ],
      },
    } as any);

    expect(prismaMock.membership.findUnique).toHaveBeenCalledTimes(1);
    const normalizeArg =
      executionServiceMock.normalizeOptions.mock.calls[0]?.[0];
    expect(normalizeArg.jsCode).toBeUndefined();
    expect(normalizeArg.jsOnly).toBeUndefined();
    expect(normalizeArg.multiUrlConfigs?.[0]?.options?.jsCode).toBeUndefined();
    expect(normalizeArg.multiUrlConfigs?.[0]?.options?.jsOnly).toBeUndefined();
  });

  it("rejects crawl options that enable crawl-stage llm extraction", async () => {
    const prismaMock = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({
          role: { name: "admin" },
          roles: [],
        }),
      },
      crawlTask: {
        create: jest.fn(),
        update: jest.fn(),
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;

    const executionServiceMock = {
      normalizeOptions: jest.fn().mockReturnValue({}),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      executionServiceMock,
      { enqueueTask: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await expect(
      service.createTask("org-1", "user-1", {
        url: "https://example.com",
        options: {
          markdownStrategy: {
            type: "LLMExtractionStrategy",
          },
        },
      } as any),
    ).rejects.toThrow("crawl stage must only fetch and store cleaned markdown");

    expect(executionServiceMock.normalizeOptions).not.toHaveBeenCalled();
    expect(prismaMock.crawlTask.create).not.toHaveBeenCalled();
  });

  it("allows jsCode/jsOnly for admin users", async () => {
    const prismaMock = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({
          role: { name: "admin" },
          roles: [],
        }),
      },
      crawlTask: {
        create: jest
          .fn()
          .mockResolvedValue({ id: "task-1", _count: { results: 0 } }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;

    const executionServiceMock = {
      normalizeOptions: jest.fn().mockReturnValue({}),
    } as any;

    const queueServiceMock = {
      enqueueTask: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      executionServiceMock,
      queueServiceMock,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest.spyOn(service, "toView").mockReturnValue({ id: "task-1" } as any);

    await service.createTask("org-1", "user-1", {
      url: "https://example.com",
      options: {
        jsCode: ["console.log('allowed')"],
        jsOnly: true,
        multiUrlConfigs: [
          {
            urls: ["https://example.com/a"],
            options: {
              jsCode: ["console.log('nested')"],
              jsOnly: true,
            },
          },
        ],
      },
    } as any);

    expect(prismaMock.membership.findUnique).toHaveBeenCalledTimes(1);
    const normalizeArg =
      executionServiceMock.normalizeOptions.mock.calls[0]?.[0];
    expect(normalizeArg.jsCode).toEqual(["console.log('allowed')"]);
    expect(normalizeArg.jsOnly).toBe(true);
    expect(normalizeArg.multiUrlConfigs?.[0]?.options?.jsCode).toEqual([
      "console.log('nested')",
    ]);
    expect(normalizeArg.multiUrlConfigs?.[0]?.options?.jsOnly).toBe(true);
  });

  it("retries with stored crawlPriorityClass and sourcePriority", async () => {
    const task = {
      id: "task-1",
      orgId: "org-1",
      config: {
        crawlPriorityClass: "hot",
        sourcePriority: 88,
      },
      _count: { results: 0 },
    };

    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue(task),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;

    const queueServiceMock = {
      enqueueTask: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      queueServiceMock,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn() } as any,
    );
    jest.spyOn(service, "toView").mockReturnValue({ id: "task-1" } as any);

    await service.retryTask("org-1", "user-1", "task-1");

    expect(queueServiceMock.enqueueTask).toHaveBeenCalledWith(
      "task-1",
      "org-1",
      "user-1",
      {
        priorityClass: "hot",
        sourcePriority: 88,
      },
    );
  });

  it("infers priorityClass from sourcePriority when retry config lacks crawlPriorityClass", async () => {
    const task = {
      id: "task-2",
      orgId: "org-1",
      config: {
        sourcePriority: 10,
      },
      _count: { results: 0 },
    };

    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue(task),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;

    const queueServiceMock = {
      enqueueTask: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      queueServiceMock,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn() } as any,
    );
    jest.spyOn(service, "toView").mockReturnValue({ id: "task-2" } as any);

    await service.retryTask("org-1", "user-1", "task-2");

    expect(queueServiceMock.enqueueTask).toHaveBeenCalledWith(
      "task-2",
      "org-1",
      "user-1",
      {
        priorityClass: "normal",
        sourcePriority: 10,
      },
    );
  });

  it("rejects retrying legacy tasks with unsupported proxy config", async () => {
    const task = {
      id: "task-legacy-proxy",
      orgId: "org-1",
      config: {
        proxyUrl: "http://proxy.example.com:8080",
      },
      _count: { results: 0 },
    };

    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue(task),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;

    const queueServiceMock = {
      enqueueTask: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      queueServiceMock,
      {} as any,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn() } as any,
    );

    await expect(
      service.retryTask("org-1", "user-1", "task-legacy-proxy"),
    ).rejects.toThrow("Unsupported crawl config");
    expect(prismaMock.crawlTask.update).not.toHaveBeenCalled();
    expect(queueServiceMock.enqueueTask).not.toHaveBeenCalled();
  });

  it("loads latest run details with a single result-service call when building task detail", async () => {
    const prismaMock = {
      crawlTask: {
        findFirst: jest.fn().mockResolvedValue({
          id: "task-1",
          orgId: "org-1",
          _count: { results: 0 },
        }),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    const resultServiceMock = {
      attachResultContent: jest.fn().mockResolvedValue([]),
      getLatestRunDetails: jest.fn().mockResolvedValue({
        memoryStats: {
          serverMemoryMb: 128,
          peakMemoryMb: 256,
          efficiencyPercent: 50,
        },
        lastRunSummary: {
          inserted: 2,
          skipped: 1,
        },
      }),
      getLatestMemoryStats: jest.fn(),
      getLatestExecutionSummary: jest.fn(),
    } as any;

    const service = new CrawlTaskService(
      prismaMock,
      { crawl4aiConfig: { maxConcurrency: 1 } } as any,
      {} as any,
      {} as any,
      resultServiceMock,
      { enforceCrawlTaskCreate: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn() } as any,
    );
    jest.spyOn(service, "toView").mockReturnValue({ id: "task-1" } as any);

    const result = await service.getTask("org-1", "task-1", {} as any);

    expect(resultServiceMock.getLatestRunDetails).toHaveBeenCalledWith(
      "org-1",
      "task-1",
    );
    expect(resultServiceMock.getLatestMemoryStats).not.toHaveBeenCalled();
    expect(resultServiceMock.getLatestExecutionSummary).not.toHaveBeenCalled();
    expect(result.task.memoryStats).toEqual({
      serverMemoryMb: 128,
      peakMemoryMb: 256,
      efficiencyPercent: 50,
    });
    expect(result.task.lastRunSummary).toEqual({
      inserted: 2,
      skipped: 1,
    });
  });
});
