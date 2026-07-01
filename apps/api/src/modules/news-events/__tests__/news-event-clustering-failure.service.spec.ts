jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

const modelMocks = {
  countDocuments: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
};

jest.mock("@modular/mongo", () => ({
  NewsEventClusteringFailureModel: modelMocks,
}));

jest.mock("../../observability/task-log.writer", () => ({
  writeTaskLogBestEffort: jest.fn(async () => undefined),
}));

import { BadRequestException, NotFoundException } from "@nestjs/common";

import { NewsEventClusteringFailureService } from "../news-event-clustering-failure.service";

const createLeanExecChain = <T>(value: T) => ({
  lean: jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(value),
  }),
});

const createExecChain = <T>(value: T) => ({
  exec: jest.fn().mockResolvedValue(value),
});

const createQueryChain = <T>(value: T) => {
  const chain = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
};

describe("NewsEventClusteringFailureService", () => {
  const eventsMock = {
    assignNewsSignalToEvent: jest.fn(),
  } as any;

  const settingsMock = {
    getSettings: jest.fn(),
  } as any;

  let service: NewsEventClusteringFailureService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new NewsEventClusteringFailureService(eventsMock, settingsMock);
  });

  it("atomically marks a pending failure group as processing for llm backfill", async () => {
    modelMocks.findOneAndUpdate.mockReturnValue(
      createLeanExecChain({
        orgId: "org-1",
        groupId: "group-1",
        status: "processing",
        attemptCount: 2,
        progressTotalCount: 2,
        items: [
          {
            processedArticleId: "pa-1",
          },
          {
            processedArticleId: "pa-2",
          },
        ],
      }),
    );

    const result = await service.markLlmBackfillQueued({
      orgId: "org-1",
      actorId: "admin-1",
      groupId: "group-1",
      jobId: "job-1",
      model: "openai/gpt-4.1-mini",
    });

    expect(modelMocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        groupId: "group-1",
        status: "pending",
      },
      [
        {
          $set: expect.objectContaining({
            status: "processing",
            activeJobId: "job-1",
            progressProcessedCount: 0,
            progressTotalCount: {
              $size: {
                $ifNull: ["$items", []],
              },
            },
            lastRecoveryModel: "openai/gpt-4.1-mini",
            attemptCount: {
              $add: [{ $ifNull: ["$attemptCount", 0] }, 1],
            },
          }),
        },
      ],
      { new: true },
    );
    expect(modelMocks.updateOne).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        attemptCount: 2,
        progressTotalCount: 2,
      }),
    );
  });

  it("rejects llm backfill queueing when the group is already processing", async () => {
    modelMocks.findOneAndUpdate.mockReturnValue(createLeanExecChain(null));
    modelMocks.findOne.mockReturnValue(
      createLeanExecChain({
        orgId: "org-1",
        groupId: "group-1",
        status: "processing",
        attemptCount: 1,
        items: [],
      }),
    );

    await expect(
      service.markLlmBackfillQueued({
        orgId: "org-1",
        actorId: "admin-1",
        groupId: "group-1",
        jobId: "job-1",
        model: "openai/gpt-4.1-mini",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(modelMocks.updateOne).not.toHaveBeenCalled();
  });

  it("lists pending failure groups that are eligible for automatic retry", async () => {
    const now = new Date("2026-04-18T00:30:00.000Z");
    modelMocks.find.mockReturnValue(
      createQueryChain([
        {
          orgId: " org-1 ",
          groupId: "group-1",
          attemptCount: 0,
          itemCount: 3,
          lastAttemptAt: null,
        },
        {
          orgId: "org-2",
          groupId: "group-2",
          attemptCount: 2,
          itemCount: 1,
          lastAttemptAt: new Date("2026-04-18T00:00:00.000Z"),
        },
      ]),
    );

    const result = await service.listPendingAutoRetryCandidates({
      limit: 10,
      retryAfterMs: 15 * 60 * 1000,
      now,
    });

    expect(modelMocks.find).toHaveBeenCalledWith({
      status: "pending",
      clusteringMode: "bertopic_primary",
      itemCount: { $gt: 0 },
      $or: [
        { lastAttemptAt: null },
        { lastAttemptAt: { $lte: new Date("2026-04-18T00:15:00.000Z") } },
      ],
    });
    const chain = modelMocks.find.mock.results[0]?.value;
    expect(chain.sort).toHaveBeenCalledWith({
      lastAttemptAt: 1,
      createdAt: 1,
    });
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(chain.select).toHaveBeenCalledWith({
      orgId: 1,
      groupId: 1,
      attemptCount: 1,
      itemCount: 1,
      lastAttemptAt: 1,
    });
    expect(result).toEqual([
      {
        orgId: "org-1",
        groupId: "group-1",
        attemptCount: 0,
        itemCount: 3,
        lastAttemptAt: null,
      },
      {
        orgId: "org-2",
        groupId: "group-2",
        attemptCount: 2,
        itemCount: 1,
        lastAttemptAt: new Date("2026-04-18T00:00:00.000Z"),
      },
    ]);
  });

  it("resolves a failure group through vector backfill", async () => {
    settingsMock.getSettings.mockResolvedValue({
      enabled: true,
    });
    modelMocks.findOne.mockReturnValue(
      createLeanExecChain({
        orgId: "org-1",
        groupId: "group-1",
        attemptCount: 1,
        items: [
          {
            processedArticleId: "pa-1",
            processedItemId: "pi-1",
            articleId: "article-1",
            title: "First title",
            summary: "First summary",
            language: "en",
            category: "macro",
            categoryPath: "economy.macro",
            categoryConfidence: 0.9,
            topics: ["rates"],
            entities: [],
            qualityScore: 0.8,
            publishedAt: new Date("2026-04-17T00:00:00.000Z"),
            processedAt: new Date("2026-04-17T00:05:00.000Z"),
            crawlAt: new Date("2026-04-17T00:01:00.000Z"),
          },
          {
            processedArticleId: "pa-2",
            processedItemId: "pi-2",
            articleId: "article-2",
            title: "Second title",
            summary: "Second summary",
            language: "en",
            category: "macro",
            categoryPath: "economy.macro",
            categoryConfidence: 0.7,
            topics: ["inflation"],
            entities: [],
            qualityScore: 0.6,
            publishedAt: new Date("2026-04-17T01:00:00.000Z"),
            processedAt: new Date("2026-04-17T01:05:00.000Z"),
            crawlAt: new Date("2026-04-17T01:01:00.000Z"),
          },
        ],
      }),
    );
    modelMocks.updateOne.mockReturnValue(
      createExecChain({ acknowledged: true }),
    );
    eventsMock.assignNewsSignalToEvent
      .mockResolvedValueOnce({ eventId: "evt-2", created: true })
      .mockResolvedValueOnce({ eventId: "evt-1", created: false });

    const result = await service.resolveFailureGroupByVectorBackfill(
      "org-1",
      "admin-1",
      "group-1",
    );

    expect(settingsMock.getSettings).toHaveBeenCalledWith("org-1");
    expect(eventsMock.assignNewsSignalToEvent).toHaveBeenCalledTimes(2);
    expect(modelMocks.updateOne).toHaveBeenCalledWith(
      { orgId: "org-1", groupId: "group-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "resolved",
          attemptCount: 2,
          resolvedById: "admin-1",
          resolutionMode: "vector_backfill",
          resolvedEventIds: ["evt-1", "evt-2"],
          lastError: null,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        groupId: "group-1",
        assignedCount: 1,
        skippedCount: 1,
        resolvedEventIds: ["evt-1", "evt-2"],
      }),
    );
  });

  it("throws when resolving an unknown failure group", async () => {
    modelMocks.findOne.mockReturnValue(createLeanExecChain(null));

    await expect(
      service.resolveFailureGroupByVectorBackfill(
        "org-1",
        "admin-1",
        "missing",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects vector backfill when the failure group is already processing", async () => {
    modelMocks.findOne.mockReturnValue(
      createLeanExecChain({
        orgId: "org-1",
        groupId: "group-1",
        status: "processing",
        attemptCount: 1,
        items: [],
      }),
    );

    await expect(
      service.resolveFailureGroupByVectorBackfill(
        "org-1",
        "admin-1",
        "group-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(settingsMock.getSettings).not.toHaveBeenCalled();
    expect(eventsMock.assignNewsSignalToEvent).not.toHaveBeenCalled();
    expect(modelMocks.updateOne).not.toHaveBeenCalled();
  });

  it("marks a failure group as ignored and returns a normalized summary", async () => {
    modelMocks.findOneAndUpdate.mockReturnValue(
      createLeanExecChain({
        groupId: "group-ignored",
        status: "ignored",
        clusteringMode: "bertopic_primary",
        failureReason: "bertopic_request_failed",
        failureMessage: "request failed",
        language: "zh",
        embeddingModel: "text-embedding-3-large",
        itemCount: 3,
        sampleTitles: ["a", "b", 3],
        attemptCount: 2,
        lastAttemptAt: new Date("2026-04-17T02:00:00.000Z"),
        lastError: null,
        resolvedAt: new Date("2026-04-17T03:00:00.000Z"),
        resolutionMode: "ignored",
        resolvedEventIds: ["evt-1", 2],
        createdAt: new Date("2026-04-17T01:00:00.000Z"),
        updatedAt: new Date("2026-04-17T03:00:00.000Z"),
      }),
    );

    const result = await service.ignoreFailureGroup(
      "org-1",
      "admin-1",
      "group-ignored",
    );

    expect(modelMocks.findOneAndUpdate).toHaveBeenCalledWith(
      { orgId: "org-1", groupId: "group-ignored" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "ignored",
          resolvedById: "admin-1",
          resolutionMode: "ignored",
        }),
      }),
      { new: true },
    );
    expect(result).toEqual({
      groupId: "group-ignored",
      status: "ignored",
      clusteringMode: "bertopic_primary",
      failureReason: "bertopic_request_failed",
      failureMessage: "request failed",
      language: "zh",
      embeddingModel: "text-embedding-3-large",
      itemCount: 3,
      sampleTitles: ["a", "b"],
      attemptCount: 2,
      lastAttemptAt: "2026-04-17T02:00:00.000Z",
      lastError: null,
      activeJobId: null,
      progressProcessedCount: 0,
      progressTotalCount: 0,
      lastRecoveryModel: null,
      resolvedAt: "2026-04-17T03:00:00.000Z",
      resolutionMode: "ignored",
      resolvedEventIds: ["evt-1"],
      createdAt: "2026-04-17T01:00:00.000Z",
      updatedAt: "2026-04-17T03:00:00.000Z",
    });
  });
});
