jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
  ensureTraceId: jest.fn((value?: string) => value ?? "trace-1"),
  getCurrentTraceId: jest.fn(() => "trace-1"),
}));

jest.mock("../../observability/task-log.writer", () => ({
  writeTaskLogBestEffort: jest.fn(async () => undefined),
}));

import { BadRequestException } from "@nestjs/common";

import { NewsEventClusteringRecoveryService } from "../news-event-clustering-recovery.service";

describe("NewsEventClusteringRecoveryService", () => {
  const failures = {
    getFailureGroupOrThrow: jest.fn(),
    listPendingAutoRetryCandidates: jest.fn(),
    markLlmBackfillQueued: jest.fn(),
    updateLlmBackfillProgress: jest.fn(),
    markLlmBackfillResolved: jest.fn(),
    markLlmBackfillFailed: jest.fn(),
  } as any;

  const settings = {
    getSettings: jest.fn(),
  } as any;

  const events = {
    listAssignmentCandidatesForSignal: jest.fn(),
    assignNewsSignalToSpecificEvent: jest.fn(),
    assignNewsSignalToNewEvent: jest.fn(),
  } as any;

  const modelServiceSettings = {
    getPublicSettings: jest.fn(),
  } as any;

  const llmGatewaySettings = {
    getActiveConfig: jest.fn(),
  } as any;

  const litellm = {
    acompletion: jest.fn(),
  } as any;

  const queue = {
    add: jest.fn(),
  } as any;

  let service: NewsEventClusteringRecoveryService;

  beforeEach(() => {
    jest.resetAllMocks();
    modelServiceSettings.getPublicSettings.mockResolvedValue({
      enabled: true,
      baseUrl: "http://model-service",
      hasToken: true,
    });
    llmGatewaySettings.getActiveConfig.mockResolvedValue({
      profileId: "profile-1",
      profileName: "Primary",
      assistantModel: "openai/gpt-4.1-mini",
      model: "openai/gpt-4.1-mini",
      apiSurface: "chat_completions",
    });

    service = new NewsEventClusteringRecoveryService(
      failures,
      settings,
      events,
      modelServiceSettings,
      llmGatewaySettings,
      litellm,
      queue,
    );
  });

  it("queues a pending failure group for llm backfill", async () => {
    failures.getFailureGroupOrThrow.mockResolvedValue({
      status: "pending",
      items: [{ processedArticleId: "pa-1" }],
    });
    failures.markLlmBackfillQueued.mockResolvedValue({
      progressTotalCount: 1,
      attemptCount: 2,
    });

    const result = await service.enqueueLlmBackfill(
      "org-1",
      "admin-1",
      "group-1",
    );

    expect(queue.add).toHaveBeenCalledWith(
      "llm_backfill",
      expect.objectContaining({
        orgId: "org-1",
        actorId: "admin-1",
        groupId: "group-1",
      }),
      expect.objectContaining({
        attempts: 1,
        removeOnComplete: true,
      }),
    );
    expect(
      failures.markLlmBackfillQueued.mock.invocationCallOrder[0],
    ).toBeLessThan(queue.add.mock.invocationCallOrder[0]);
    expect(failures.markLlmBackfillQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        actorId: "admin-1",
        groupId: "group-1",
        model: "openai/gpt-4.1-mini",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        groupId: "group-1",
        status: "processing",
        progressTotalCount: 1,
        lastRecoveryModel: "openai/gpt-4.1-mini",
      }),
    );
  });

  it("reverts the failure group when queue publish fails", async () => {
    failures.getFailureGroupOrThrow.mockResolvedValue({
      status: "pending",
      items: [{ processedArticleId: "pa-1" }],
    });
    failures.markLlmBackfillQueued.mockResolvedValue({
      progressTotalCount: 1,
      attemptCount: 2,
    });
    queue.add.mockRejectedValue(new Error("BullMQ unavailable"));

    await expect(
      service.enqueueLlmBackfill("org-1", "admin-1", "group-1"),
    ).rejects.toThrow("BullMQ unavailable");

    expect(failures.markLlmBackfillFailed).toHaveBeenCalledWith({
      orgId: "org-1",
      groupId: "group-1",
      processedCount: 0,
      totalCount: 1,
      errorMessage: "BullMQ unavailable",
      model: "openai/gpt-4.1-mini",
    });
  });

  it("rejects queueing when llm readiness is unavailable", async () => {
    llmGatewaySettings.getActiveConfig.mockResolvedValueOnce(null);

    await expect(
      service.enqueueLlmBackfill("org-1", "admin-1", "group-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("automatically queues pending failure groups for llm backfill", async () => {
    failures.listPendingAutoRetryCandidates.mockResolvedValue([
      {
        orgId: "org-1",
        groupId: "group-1",
        attemptCount: 0,
        itemCount: 1,
        lastAttemptAt: null,
      },
      {
        orgId: "org-2",
        groupId: "group-2",
        attemptCount: 1,
        itemCount: 2,
        lastAttemptAt: new Date("2026-04-18T00:00:00.000Z"),
      },
    ]);
    failures.getFailureGroupOrThrow.mockResolvedValue({
      status: "pending",
      items: [{ processedArticleId: "pa-1" }],
    });
    failures.markLlmBackfillQueued
      .mockResolvedValueOnce({
        progressTotalCount: 1,
        attemptCount: 1,
      })
      .mockResolvedValueOnce({
        progressTotalCount: 2,
        attemptCount: 2,
      });

    const result = await service.enqueuePendingLlmBackfills({
      limit: 10,
      retryAfterMs: 60_000,
    });

    expect(failures.listPendingAutoRetryCandidates).toHaveBeenCalledWith({
      limit: 10,
      retryAfterMs: 60_000,
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      "llm_backfill",
      expect.objectContaining({
        orgId: "org-1",
        actorId: "system:news-event-clustering-recovery",
        groupId: "group-1",
        trigger: "auto",
      }),
      expect.objectContaining({
        attempts: 1,
        removeOnComplete: true,
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "llm_backfill",
      expect.objectContaining({
        orgId: "org-2",
        actorId: "system:news-event-clustering-recovery",
        groupId: "group-2",
        trigger: "auto",
      }),
      expect.any(Object),
    );
    expect(result).toEqual({
      scanned: 2,
      queued: 2,
      skipped: 0,
      failed: 0,
      skippedNotReady: false,
    });
  });

  it("does not scan pending failures when automatic llm backfill is not ready", async () => {
    llmGatewaySettings.getActiveConfig.mockResolvedValueOnce(null);

    const result = await service.enqueuePendingLlmBackfills();

    expect(failures.listPendingAutoRetryCandidates).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
      skippedNotReady: true,
    });
  });

  it("processes an llm backfill job and resolves the failure group", async () => {
    failures.getFailureGroupOrThrow.mockResolvedValue({
      status: "processing",
      activeJobId: "job-1",
      items: [
        {
          articleId: "article-1",
          processedArticleId: "pa-1",
          processedItemId: "pi-1",
          title: "Rate cut expected",
          summary: "Markets expect a cut",
          language: "en",
          topics: ["rates"],
          entities: [{ name: "Fed", type: "org", confidence: 0.8 }],
          qualityScore: 0.9,
          category: "finance",
          categoryPath: "finance/rates",
          categoryConfidence: 0.7,
          publishedAt: new Date("2026-04-18T00:00:00.000Z"),
          processedAt: new Date("2026-04-18T00:01:00.000Z"),
          crawlAt: new Date("2026-04-18T00:00:30.000Z"),
        },
      ],
    });
    settings.getSettings.mockResolvedValue({ vectorMinScore: 0.82 });
    events.listAssignmentCandidatesForSignal.mockResolvedValue([
      {
        eventId: "evt-1",
        score: 0.91,
        matchOrigin: "vector",
        title: "Central bank policy shift",
        summary: "Policy event summary",
        language: "en",
        primaryTopic: "rates",
        primaryEntity: "Fed",
        startAt: new Date("2026-04-17T00:00:00.000Z"),
        lastAt: new Date("2026-04-18T00:00:00.000Z"),
        itemCount: 5,
      },
    ]);
    litellm.acompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: "assign_existing",
              eventId: "evt-1",
              confidence: 0.93,
            }),
          },
        },
      ],
    });
    events.assignNewsSignalToSpecificEvent.mockResolvedValue({
      eventId: "evt-1",
      created: true,
    });
    failures.markLlmBackfillResolved.mockResolvedValue(
      new Date("2026-04-18T00:02:00.000Z"),
    );

    await service.processJob({
      jobType: "llm_backfill",
      orgId: "org-1",
      actorId: "admin-1",
      groupId: "group-1",
      traceId: "trace-1",
    });

    expect(events.listAssignmentCandidatesForSignal).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        processedArticleId: "pa-1",
      }),
      expect.any(Object),
      { limit: 6 },
    );
    expect(events.assignNewsSignalToSpecificEvent).toHaveBeenCalledWith(
      "org-1",
      "evt-1",
      expect.objectContaining({
        processedArticleId: "pa-1",
      }),
      expect.objectContaining({
        assignedBy: "manual",
        similarity: 0.91,
      }),
    );
    expect(failures.updateLlmBackfillProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        groupId: "group-1",
        processedCount: 1,
        totalCount: 1,
      }),
    );
    expect(failures.markLlmBackfillResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        actorId: "admin-1",
        groupId: "group-1",
        processedCount: 1,
        totalCount: 1,
        resolvedEventIds: ["evt-1"],
      }),
    );
  });
});
