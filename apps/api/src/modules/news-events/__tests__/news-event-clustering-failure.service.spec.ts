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

import { NotFoundException } from "@nestjs/common";

import { NewsEventClusteringFailureService } from "../news-event-clustering-failure.service";

const createLeanExecChain = <T,>(value: T) => ({
  lean: jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(value),
  }),
});

const createExecChain = <T,>(value: T) => ({
  exec: jest.fn().mockResolvedValue(value),
});

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
    modelMocks.updateOne.mockReturnValue(createExecChain({ acknowledged: true }));
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
      service.resolveFailureGroupByVectorBackfill("org-1", "admin-1", "missing"),
    ).rejects.toBeInstanceOf(NotFoundException);
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
