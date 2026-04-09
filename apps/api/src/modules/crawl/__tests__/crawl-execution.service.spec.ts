jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    }),
    normalizeBrowserHeaders: (input: unknown) => {
      if (!Array.isArray(input)) {
        return [];
      }
      const controlChar = new RegExp(
        `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
      );
      const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
      return input
        .map((entry) => {
          const record = entry as { name?: unknown; value?: unknown };
          const name =
            typeof record?.name === "string" ? record.name.trim() : "";
          const value =
            typeof record?.value === "string" ? record.value.trim() : "";
          if (!name || !value) {
            return null;
          }
          if (!headerNamePattern.test(name)) {
            return null;
          }
          if (controlChar.test(name) || controlChar.test(value)) {
            return null;
          }
          return { name, value };
        })
        .filter((entry): entry is { name: string; value: string } =>
          Boolean(entry),
        );
    },
    sanitizeError: (error: unknown) => ({
      message: error instanceof Error ? error.message : String(error),
    }),
  };
});

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn(),
  },
}));

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

import { TaskLogModel } from "@modular/mongo";
import { NotificationPresentationKind } from "@modular/utils";
import { NotificationType } from "@prisma/client";

import { CrawlExecutionService } from "../crawl-execution.service";
import { Crawl4aiRequestException } from "../crawl4ai.exception";
import { buildCanonicalUrlFingerprint } from "../url-fingerprint";

// Test fixtures
const createMockTask = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  orgId: "org-1",
  targetUrl: "https://example.com",
  displayName: "Test Task",
  keywords: null,
  config: null,
  status: "queued",
  runCount: 0,
  lastRunAt: null,
  lastSuccessAt: null,
  lastResultAt: null,
  lastCursor: null,
  lastError: null,
  lastServerMemoryMb: null,
  lastPeakMemoryMb: null,
  lastMemoryEfficiency: null,
  createdById: "user-1",
  ...overrides,
});

const createMockCrawlResponse = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-123",
  nextCursor: null,
  warnings: [],
  results: [
    {
      url: "https://example.com",
      markdown: "# Test Content",
      success: true,
      metadata: {},
    },
  ],
  serverMemoryMb: 512,
  peakMemoryMb: 768,
  memoryEfficiency: 85,
  ...overrides,
});

const createMockPrismaService = () => ({
  crawlTask: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  crawlResult: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
});

const createMockEnvService = () => ({
  crawl4aiConfig: {
    baseUrl: "http://localhost:8082",
  },
});

const createMockCrawlClient = () => ({
  crawl: jest.fn(),
});

const createMockResultService = () => ({
  persistResults: jest.fn(),
  extractMarkdownResult: jest.fn(),
  isLikelyBotChallengeMarkdown: jest.fn().mockReturnValue(false),
  isLowSignalMarkdown: jest.fn().mockReturnValue(false),
});

const createMockNotificationsService = () => ({
  notify: jest.fn(),
});

const createMockCrawlSettingsService = () => ({
  getSettings: jest.fn().mockResolvedValue({
    conditionalRequestEnabled: true,
    conditionalRequestTimeoutMs: 5_000,
    conditionalRequestMaxRetries: 0,
    detailPublishSignalHeadFetchTimeoutMs: 1500,
    detailPublishSignalHeadFetchConcurrency: 2,
    detailPublishSignalHeadFetchMaxReadBytes: 8_000_000,
  }),
});

const createMockQualityStrategyService = () => ({
  resolveQualityProfile: jest.fn().mockReturnValue("quality_first"),
  assessPageSignals: jest.fn().mockReturnValue({
    kind: "detail",
    assessments: [],
    lowSignalAssessments: [],
    allLowSignal: false,
    maxLowSignalWords: 0,
    minLowSignalWords: 0,
    meanLowSignalWords: 0,
    bestLowSignalScore: Number.NEGATIVE_INFINITY,
    maxLowSignalLinkDensity: 0,
    meanLowSignalLinkDensity: 0,
  }),
  shouldAutoExpand: jest.fn().mockReturnValue(false),
  resolveDetailExpansion: jest.fn().mockReturnValue({
    maxDetailUrls: 12,
    minRelevanceScore: 0.35,
    requireSameDomain: true,
    allowExternalLinks: true,
  }),
  assessArticleMarkdownSignal: jest.fn().mockReturnValue({
    wordCount: 120,
    paragraphCount: 4,
    headingCount: 1,
    linkCount: 2,
    linkDensity: 0.016,
    score: 120,
    isListLike: false,
  }),
  isSignificantDetailImprovement: jest.fn().mockReturnValue(true),
  scoreMarkdownQuality: jest
    .fn()
    .mockImplementation((items: unknown[]) =>
      Array.isArray(items) ? items.length * 100 : 0,
    ),
});

describe("CrawlExecutionService", () => {
  let service: CrawlExecutionService;
  let mockPrisma: ReturnType<typeof createMockPrismaService>;
  let mockEnv: ReturnType<typeof createMockEnvService>;
  let mockCrawlClient: ReturnType<typeof createMockCrawlClient>;
  let mockResultService: ReturnType<typeof createMockResultService>;
  let mockQualityStrategy: ReturnType<typeof createMockQualityStrategyService>;
  let mockCrawlSettings: ReturnType<typeof createMockCrawlSettingsService>;
  let mockNotifications: ReturnType<typeof createMockNotificationsService>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockPrisma = createMockPrismaService();
    mockEnv = createMockEnvService();
    mockCrawlClient = createMockCrawlClient();
    mockResultService = createMockResultService();
    mockQualityStrategy = createMockQualityStrategyService();
    mockCrawlSettings = createMockCrawlSettingsService();
    mockNotifications = createMockNotificationsService();

    service = new CrawlExecutionService(
      mockPrisma as any,
      mockEnv as any,
      mockCrawlClient as any,
      mockResultService as any,
      mockQualityStrategy as any,
      mockCrawlSettings as any,
      mockNotifications as any,
    );
    (TaskLogModel.create as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("safeNotifyCrawl", () => {
    it("retries notifications.notify before giving up", async () => {
      mockNotifications.notify
        .mockRejectedValueOnce(new Error("db down"))
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce(undefined);

      const task = createMockTask();
      const summary = { inserted: 1, skipped: 2, lastFetchedAt: new Date() };

      const promise = (service as any).safeNotifyCrawl(
        task,
        summary,
        "user-1",
        "completed",
      );
      await jest.runAllTimersAsync();
      await promise;

      expect(mockNotifications.notify).toHaveBeenCalledTimes(3);
      expect(mockNotifications.notify).toHaveBeenLastCalledWith(
        expect.objectContaining({
          orgId: "org-1",
          userId: "user-1",
          type: NotificationType.crawl_completed,
          data: expect.objectContaining({
            taskId: "task-1",
            status: "completed",
            presentation: expect.objectContaining({
              kind: NotificationPresentationKind.CrawlCompleted,
              params: expect.objectContaining({
                taskId: "task-1",
                taskLabel: "Test Task",
                inserted: 1,
                skipped: 2,
              }),
            }),
          }),
        }),
      );
      expect(TaskLogModel.create).not.toHaveBeenCalled();
    });

    it("writes a notify failure log after exhausting retries", async () => {
      mockNotifications.notify.mockRejectedValue(new Error("db down"));

      const task = createMockTask();
      const summary = { inserted: 0, skipped: 0, lastFetchedAt: null };

      const promise = (service as any).safeNotifyCrawl(
        task,
        summary,
        "user-1",
        "failed",
        "boom",
      );
      await jest.runAllTimersAsync();
      await promise;

      expect(mockNotifications.notify).toHaveBeenCalledTimes(3);
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: "crawl4ai",
          jobId: "task-1",
          orgId: "org-1",
          stage: "notify",
          status: "failed",
          data: expect.objectContaining({
            taskId: "task-1",
            status: "failed",
            notificationType: NotificationType.crawl_failed,
          }),
        }),
      );
    });
  });

  describe("runTask happy path", () => {
    it("returns empty summary when task not found", async () => {
      mockPrisma.crawlTask.findFirst.mockResolvedValue(null);

      const result = await service.runTask("task-1", "org-1");

      expect(result).toEqual({ inserted: 0, skipped: 0 });
      expect(mockPrisma.crawlTask.update).not.toHaveBeenCalled();
    });

    it("executes full task flow successfully", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse();
      const persistSummary = {
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
      };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      const result = await service.runTask("task-1", "org-1");

      expect(mockPrisma.crawlTask.findFirst).toHaveBeenCalledWith({
        where: { id: "task-1", orgId: "org-1" },
      });
      expect(mockPrisma.crawlTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task-1" },
          data: expect.objectContaining({ status: "running" }),
        }),
      );
      const hasStartLog = (TaskLogModel.create as jest.Mock).mock.calls.some(
        ([entry]) =>
          Boolean(entry) &&
          (entry as { stage?: string }).stage === "start" &&
          (entry as { status?: string }).status === "processing",
      );
      expect(hasStartLog).toBe(false);
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "complete", status: "completed" }),
      );
      expect(mockCrawlClient.crawl).toHaveBeenCalled();
      expect(mockResultService.persistResults).toHaveBeenCalled();
      expect(result.inserted).toBe(1);
    });

    it("skips crawl body extraction when conditional preflight returns 304", async () => {
      const task = createMockTask();
      const fetchedAt = new Date("2026-02-26T10:00:00.000Z");

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockPrisma.crawlResult.findFirst.mockResolvedValue({
        id: "result-previous",
        fetchedAt,
        metadata: {
          httpEtag: '"seed-v1"',
          httpLastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
        },
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        status: 304,
        headers: {
          get: (key: string) => {
            if (key === "etag") {
              return '"seed-v1"';
            }
            if (key === "last-modified") {
              return "Mon, 01 Jan 2024 00:00:00 GMT";
            }
            return null;
          },
        },
        body: null,
      }) as any;
      (service as any).shouldRunConditionalPreflight = jest
        .fn()
        .mockReturnValue(true);

      try {
        const result = await service.runTask("task-1", "org-1");

        expect(result).toEqual(
          expect.objectContaining({
            inserted: 0,
            skipped: 1,
            reusedResultId: "result-previous",
            lastFetchedAt: fetchedAt,
          }),
        );
        expect(global.fetch).toHaveBeenCalledWith(
          "https://example.com",
          expect.objectContaining({
            method: "HEAD",
            headers: expect.objectContaining({
              "if-none-match": '"seed-v1"',
              "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT",
            }),
          }),
        );
        expect(mockCrawlClient.crawl).not.toHaveBeenCalled();
        expect(mockResultService.persistResults).not.toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("does not skip crawl body extraction on 304 when task includes additionalUrls", async () => {
      const task = createMockTask({
        config: {
          additionalUrls: ["https://example.com/secondary"],
        },
      });
      const fetchedAt = new Date("2026-02-26T10:00:00.000Z");
      const persistSummary = {
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date("2026-02-26T10:05:00.000Z"),
      };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockPrisma.crawlResult.findFirst.mockResolvedValue({
        id: "result-previous",
        fetchedAt,
        metadata: {
          httpEtag: '"seed-v1"',
          httpLastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
        },
      });
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        status: 304,
        headers: {
          get: (key: string) => {
            if (key === "etag") {
              return '"seed-v1"';
            }
            if (key === "last-modified") {
              return "Mon, 01 Jan 2024 00:00:00 GMT";
            }
            return null;
          },
        },
        body: null,
      }) as any;
      (service as any).shouldRunConditionalPreflight = jest
        .fn()
        .mockReturnValue(true);

      try {
        const result = await service.runTask("task-1", "org-1");

        expect(result).toEqual(expect.objectContaining(persistSummary));
        expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(1);
        expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
          expect.objectContaining({
            urls: expect.arrayContaining([
              "https://example.com",
              "https://example.com/secondary",
            ]),
          }),
        );
        expect(mockResultService.persistResults).toHaveBeenCalledTimes(1);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("looks up HTTP validators by canonical URL fingerprint within task scope", async () => {
      const task = createMockTask({
        targetUrl: "https://example.com/story?id=42&utm_source=newsletter",
        config: {
          urlQueryParamAllowlist: ["id"],
        },
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockPrisma.crawlResult.findFirst.mockResolvedValue(null);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      const canonical = buildCanonicalUrlFingerprint(task.targetUrl, ["id"]);
      expect(canonical).not.toBeNull();
      expect(mockPrisma.crawlResult.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            taskId: "task-1",
            OR: expect.arrayContaining([
              { sourceUrlFingerprint: canonical?.fingerprint },
              { sourceUrl: canonical?.canonicalUrl },
              { sourceUrl: task.targetUrl },
            ]),
          }),
          orderBy: { fetchedAt: "desc" },
        }),
      );
    });

    it("retries with headless=true when headed crawl fails due to display dependency", async () => {
      const task = createMockTask({
        config: {
          headless: false,
        },
      });
      const crawlResponse = createMockCrawlResponse();
      const persistSummary = {
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
      };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockRejectedValueOnce(
          new Crawl4aiRequestException("cannot open display :99", 500),
        )
        .mockResolvedValueOnce(crawlResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(2);
      const firstPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[0]?.[0] as {
        options?: { headless?: boolean };
      };
      const secondPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[1]?.[0] as {
        options?: { headless?: boolean };
      };
      expect(firstPayload.options?.headless).toBe(false);
      expect(secondPayload.options?.headless).toBe(true);
      expect(result.inserted).toBe(1);
    });

    it("injects task-scoped sessionId when task config does not provide one", async () => {
      const task = createMockTask({ id: "task-1", config: null });
      const crawlResponse = createMockCrawlResponse();

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      const payload = mockCrawlClient.crawl.mock.calls[0]?.[0];
      expect(payload?.options?.sessionId).toBe("task-task-1");
    });

    it("sends notification when triggeredById is provided", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse();
      const persistSummary = { inserted: 1, skipped: 0 };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });
      mockNotifications.notify.mockResolvedValue(undefined);

      const promise = service.runTask("task-1", "org-1", "user-1");
      await jest.runAllTimersAsync();
      await promise;

      expect(mockNotifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.crawl_completed,
          userId: "user-1",
          data: expect.objectContaining({
            presentation: expect.objectContaining({
              kind: NotificationPresentationKind.CrawlCompleted,
            }),
          }),
        }),
      );
    });

    it("updates task status to completed with memory stats", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse();
      const persistSummary = {
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
        memory: {
          serverMemoryMb: 512,
          peakMemoryMb: 768,
          efficiencyPercent: 85,
        },
      };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "completed",
            runCount: { increment: 1 },
            lastServerMemoryMb: 512,
            lastPeakMemoryMb: 768,
            lastMemoryEfficiency: 85,
          }),
        }),
      );
    });

    it("retries with relaxed markdown options when pipeline job returns empty markdown", async () => {
      const task = createMockTask({ config: { pipelineJobId: "job-1" } });
      const emptyResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com",
            markdown: "",
            success: true,
            metadata: {},
          },
        ],
      });
      const fallbackResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com",
            markdown: "# Fallback Content",
            success: true,
            metadata: {},
          },
        ],
      });
      const persistSummary = {
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
      };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(emptyResponse)
        .mockResolvedValueOnce(fallbackResponse)
        .mockResolvedValueOnce(fallbackResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult
        .mockReturnValueOnce({ primary: "" })
        .mockReturnValueOnce({ primary: "" })
        .mockReturnValue({ primary: "# Fallback Content" });

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThanOrEqual(3);
      const secondCallPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[1]?.[0] as any;
      expect(secondCallPayload?.options).toEqual(
        expect.objectContaining({
          onlyMainContent: false,
          wordCountThreshold: 10,
          markdownOptions: expect.objectContaining({
            contentSource: "raw_html",
          }),
        }),
      );
      const thirdCallPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[2]?.[0] as any;
      expect(thirdCallPayload?.options).toEqual(
        expect.objectContaining({
          markdownOptions: expect.objectContaining({
            contentSource: "cleaned_html",
          }),
        }),
      );
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "fallback",
          status: "completed",
          data: expect.objectContaining({
            selectedProfile: expect.any(String),
            attempts: expect.any(Number),
          }),
        }),
      );
      expect(mockResultService.persistResults).toHaveBeenCalledWith(
        task,
        expect.any(Array),
        expect.any(Object),
        expect.anything(),
        expect.anything(),
        undefined,
      );
      expect(result.inserted).toBe(1);
    });

    it("treats reference-only markdown as failure and triggers markdown fallback", async () => {
      const task = createMockTask({ config: { pipelineJobId: "job-1" } });
      const referenceOnlyResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com/latest",
            markdown: "## References",
            success: true,
            metadata: {},
          },
        ],
      });
      const fallbackResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com/article/1",
            markdown:
              "# Article\n\nThis is a complete article body with context and details.",
            success: true,
            metadata: {},
          },
        ],
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(referenceOnlyResponse)
        .mockResolvedValueOnce(fallbackResponse)
        .mockResolvedValueOnce(fallbackResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );
      mockResultService.isLowSignalMarkdown.mockImplementation(
        (markdown: string) => markdown.trim().toLowerCase() === "## references",
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "fallback",
          status: "completed",
          data: expect.objectContaining({
            completedAttempts: expect.any(Number),
            profiles: expect.any(Array),
          }),
        }),
      );
    });

    it("keeps bm25 fallback profile when empty-markdown failures occur with bm25 filter", async () => {
      const task = createMockTask({
        config: {
          markdownFilter: {
            type: "bm25",
            userQuery: "startup",
            bm25Threshold: 1.1,
            language: "english",
          },
        },
      });
      const emptyResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com",
            markdown: "",
            success: true,
            metadata: {},
          },
        ],
      });
      const fallbackResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com",
            markdown: "# BM25 Content",
            success: true,
            metadata: {},
          },
        ],
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(emptyResponse)
        .mockResolvedValueOnce(fallbackResponse)
        .mockResolvedValueOnce(fallbackResponse)
        .mockResolvedValueOnce(fallbackResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThanOrEqual(4);
      const fallbackPayloads = (mockCrawlClient.crawl as jest.Mock).mock.calls
        .slice(1)
        .map((entry) => entry[0] as any);
      expect(
        fallbackPayloads.some(
          (payload) =>
            payload?.options?.markdownFilter?.type === "bm25" &&
            payload?.options?.markdownFilter?.userQuery === "startup",
        ),
      ).toBe(true);
      expect(result.inserted).toBe(1);
    });

    it("expands list-like markdown results by crawling detail candidates", async () => {
      const task = createMockTask({
        targetUrl: "https://jp.reuters.com/world/",
      });

      const listMarkdown =
        "# ワールド\n" +
        Array.from(
          { length: 18 },
          (_, index) =>
            "- [記事" +
            index +
            "](https://jp.reuters.com/world/us/ARTICLE" +
            index +
            "-2026-02-06/)",
        ).join("\n");
      const detailedMarkdown =
        "# Detailed Article\n\n" +
        "This is a richer article paragraph with policy, timeline, and impact context.\n\n".repeat(
          80,
        );

      const initialResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://jp.reuters.com/world/",
            markdown: listMarkdown,
            success: true,
            metadata: {},
          },
        ],
      });

      const expansionResponse = createMockCrawlResponse({
        runId: "run-expansion",
        results: [
          {
            url: "https://jp.reuters.com/world/us/ARTICLE0-2026-02-06/",
            markdown: detailedMarkdown,
            success: true,
            metadata: {},
          },
        ],
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(initialResponse)
        .mockResolvedValue(expansionResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );
      mockQualityStrategy.resolveQualityProfile.mockReturnValue(
        "quality_first",
      );
      mockQualityStrategy.assessPageSignals.mockReturnValue({
        kind: "list",
        assessments: [
          {
            index: 0,
            article: initialResponse.results[0],
            quality: {
              wordCount: 220,
              paragraphCount: 1,
              headingCount: 1,
              linkCount: 18,
              linkDensity: 0.2,
              bulletLines: 18,
              score: 50,
              isListLike: true,
            },
            linkInventory: 18,
          },
        ],
        lowSignalAssessments: [
          {
            index: 0,
            article: initialResponse.results[0],
            quality: {
              wordCount: 220,
              paragraphCount: 1,
              headingCount: 1,
              linkCount: 18,
              linkDensity: 0.2,
              bulletLines: 18,
              score: 50,
              isListLike: true,
            },
            linkInventory: 18,
          },
        ],
        allLowSignal: true,
        maxLowSignalWords: 220,
        minLowSignalWords: 220,
        meanLowSignalWords: 220,
        bestLowSignalScore: 50,
        maxLowSignalLinkDensity: 0.2,
        meanLowSignalLinkDensity: 0.2,
      });
      mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
      mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
        maxDetailUrls: 12,
        minRelevanceScore: 0.05,
        requireSameDomain: true,
        allowExternalLinks: true,
      });
      mockQualityStrategy.isSignificantDetailImprovement.mockReturnValue(true);
      mockQualityStrategy.assessArticleMarkdownSignal.mockImplementation(
        (article: any) => {
          if (
            typeof article?.url === "string" &&
            article.url.includes("ARTICLE0")
          ) {
            return {
              wordCount: 1600,
              paragraphCount: 22,
              headingCount: 2,
              linkCount: 12,
              linkDensity: 0.01,
              bulletLines: 1,
              score: 1200,
              isListLike: false,
            };
          }
          return {
            wordCount: 220,
            paragraphCount: 1,
            headingCount: 1,
            linkCount: 18,
            linkDensity: 0.2,
            bulletLines: 18,
            score: 50,
            isListLike: true,
          };
        },
      );

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
      const expansionPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[1]?.[0] as any;
      expect(expansionPayload?.urls?.length).toBeGreaterThan(0);
      expect(expansionPayload?.options).toEqual(
        expect.objectContaining({
          scanFullPage: false,
          markdownFilter: undefined,
          extractLinks: false,
        }),
      );
      expect(expansionPayload?.options?.sessionId).toBe("task-task-1");
      expect(mockResultService.persistResults).toHaveBeenCalledWith(
        task,
        expect.arrayContaining([
          expect.objectContaining({
            url: "https://jp.reuters.com/world/us/ARTICLE0-2026-02-06/",
          }),
        ]),
        expect.any(Object),
        "run-expansion",
        expect.anything(),
        undefined,
      );
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "expansion",
          status: "completed",
          data: expect.objectContaining({
            runId: "run-expansion",
            candidateRejects: expect.objectContaining({
              publishConfidenceRejected: expect.any(Number),
            }),
            publishConfidenceBuckets: expect.objectContaining({
              lt04: expect.any(Number),
              from04To06: expect.any(Number),
              from06To08: expect.any(Number),
              gte08: expect.any(Number),
            }),
            headSignalEnrichment: expect.objectContaining({
              attempted: expect.any(Number),
              totalSignalCandidates: expect.any(Number),
            }),
          }),
        }),
      );
      expect(
        mockCrawlSettings.getSettings.mock.calls.length,
      ).toBeGreaterThanOrEqual(1);
      expect(result.inserted).toBe(1);
    });
  });

  it("fails when all crawl markdown is low-signal and no detail candidates are extracted", async () => {
    const task = createMockTask({
      targetUrl: "https://jp.reuters.com/world/",
    });

    const listOnlyMarkdown =
      "# World\n" +
      Array.from(
        { length: 20 },
        (_, index) =>
          "- [Section" + index + "](https://jp.reuters.com/world/us/)",
      ).join("\n");

    const initialResponse = createMockCrawlResponse({
      results: [
        {
          url: "https://jp.reuters.com/world/",
          markdown: listOnlyMarkdown,
          success: true,
          metadata: {},
        },
      ],
    });

    mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
    mockPrisma.crawlTask.update.mockResolvedValue(task);
    mockCrawlClient.crawl.mockResolvedValue(initialResponse);
    mockResultService.extractMarkdownResult.mockImplementation(
      (markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
      }),
    );
    mockQualityStrategy.resolveQualityProfile.mockReturnValue("quality_first");
    mockQualityStrategy.assessPageSignals.mockReturnValue({
      kind: "list",
      assessments: [
        {
          index: 0,
          article: initialResponse.results[0],
          quality: {
            wordCount: 120,
            paragraphCount: 1,
            headingCount: 1,
            linkCount: 20,
            linkDensity: 0.3,
            bulletLines: 20,
            score: 20,
            isListLike: true,
          },
          linkInventory: 20,
        },
      ],
      lowSignalAssessments: [
        {
          index: 0,
          article: initialResponse.results[0],
          quality: {
            wordCount: 120,
            paragraphCount: 1,
            headingCount: 1,
            linkCount: 20,
            linkDensity: 0.3,
            bulletLines: 20,
            score: 20,
            isListLike: true,
          },
          linkInventory: 20,
        },
      ],
      allLowSignal: true,
      maxLowSignalWords: 120,
      minLowSignalWords: 120,
      meanLowSignalWords: 120,
      bestLowSignalScore: 20,
      maxLowSignalLinkDensity: 0.3,
      meanLowSignalLinkDensity: 0.3,
    });
    mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
    mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
      maxDetailUrls: 12,
      minRelevanceScore: 0.05,
      requireSameDomain: true,
      allowExternalLinks: true,
    });

    await expect(service.runTask("task-1", "org-1")).rejects.toThrow(
      "no detail candidate URLs were extracted",
    );

    expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(1);
    expect(mockResultService.persistResults).not.toHaveBeenCalled();
    expect(TaskLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "expansion", status: "failed" }),
    );
  });

  it("fails when detail expansion cannot produce richer content for all-low-signal pages", async () => {
    const task = createMockTask({
      targetUrl: "https://jp.reuters.com/world/",
    });

    const listMarkdown =
      "# ワールド\n" +
      Array.from(
        { length: 14 },
        (_, index) =>
          "- [記事" +
          index +
          "](https://jp.reuters.com/world/us/ARTICLE" +
          index +
          "-2026-02-06/)",
      ).join("\n");

    const initialResponse = createMockCrawlResponse({
      results: [
        {
          url: "https://jp.reuters.com/world/",
          markdown: listMarkdown,
          success: true,
          metadata: {},
        },
      ],
    });

    const expansionResponse = createMockCrawlResponse({
      runId: "run-expansion",
      results: [
        {
          url: "https://jp.reuters.com/world/us/ARTICLE0-2026-02-06/",
          markdown: listMarkdown,
          success: true,
          metadata: {},
        },
      ],
    });

    mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
    mockPrisma.crawlTask.update.mockResolvedValue(task);
    mockCrawlClient.crawl
      .mockResolvedValueOnce(initialResponse)
      .mockResolvedValue(expansionResponse);
    mockResultService.extractMarkdownResult.mockImplementation(
      (markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
      }),
    );
    mockQualityStrategy.resolveQualityProfile.mockReturnValue("quality_first");
    mockQualityStrategy.assessPageSignals.mockReturnValue({
      kind: "list",
      assessments: [
        {
          index: 0,
          article: initialResponse.results[0],
          quality: {
            wordCount: 180,
            paragraphCount: 1,
            headingCount: 1,
            linkCount: 14,
            linkDensity: 0.18,
            bulletLines: 14,
            score: 30,
            isListLike: true,
          },
          linkInventory: 14,
        },
      ],
      lowSignalAssessments: [
        {
          index: 0,
          article: initialResponse.results[0],
          quality: {
            wordCount: 180,
            paragraphCount: 1,
            headingCount: 1,
            linkCount: 14,
            linkDensity: 0.18,
            bulletLines: 14,
            score: 30,
            isListLike: true,
          },
          linkInventory: 14,
        },
      ],
      allLowSignal: true,
      maxLowSignalWords: 180,
      minLowSignalWords: 180,
      meanLowSignalWords: 180,
      bestLowSignalScore: 30,
      maxLowSignalLinkDensity: 0.18,
      meanLowSignalLinkDensity: 0.18,
    });
    mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
    mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
      maxDetailUrls: 12,
      minRelevanceScore: 0.05,
      requireSameDomain: true,
      allowExternalLinks: true,
    });
    mockQualityStrategy.isSignificantDetailImprovement.mockReturnValue(false);

    await expect(service.runTask("task-1", "org-1")).rejects.toThrow(
      "detail expansion did not produce richer article content",
    );

    expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
    expect(mockResultService.persistResults).not.toHaveBeenCalled();
    expect(TaskLogModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "expansion",
        status: "completed",
        message: "Detail expansion did not produce richer markdown",
      }),
    );
  });

  it("extracts detail candidates from metadata canonical urls", async () => {
    mockResultService.extractMarkdownResult.mockImplementation(
      (markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: "",
      }),
    );

    const instance = service as unknown as {
      extractDetailLinkCandidatesFromArticle: (
        article: Record<string, unknown>,
        requireSameDomain: boolean,
        allowExternalLinks?: boolean,
      ) => string[];
    };

    const candidates = instance.extractDetailLinkCandidatesFromArticle(
      {
        url: "https://www.politico.eu/latest/",
        markdown: "## References",
        metadata: {
          canonical:
            "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal/",
          openGraph: {
            url: "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal/",
          },
        },
      },
      true,
      true,
    );

    expect(candidates).toContain(
      "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal",
    );
  });

  it("filters non-detail politico section links from candidate extraction", async () => {
    mockResultService.extractMarkdownResult.mockImplementation(
      (markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: "",
      }),
    );

    const instance = service as unknown as {
      extractDetailLinkCandidatesFromArticle: (
        article: Record<string, unknown>,
        requireSameDomain: boolean,
        allowExternalLinks?: boolean,
      ) => string[];
    };

    const candidates = instance.extractDetailLinkCandidatesFromArticle(
      {
        url: "https://www.politico.eu/latest/",
        markdown:
          "[A](https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal/)\n" +
          "[B](https://www.politico.eu/newsletter/politico-eu-influence/)\n" +
          "[C](https://www.politico.eu/country/greenland/)\n" +
          "[D](https://www.politico.eu/europe-poll-of-polls/european-parliament-election/)\n" +
          "[E](https://www.politico.eu/special-report/danish-presidency-of-the-eu-special-report/)",
        links: {
          internal: [
            {
              href: "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal/",
            },
            {
              href: "https://www.politico.eu/newsletter/politico-eu-influence/",
            },
            { href: "https://www.politico.eu/country/greenland/" },
            {
              href: "https://www.politico.eu/europe-poll-of-polls/european-parliament-election/",
            },
            {
              href: "https://www.politico.eu/special-report/danish-presidency-of-the-eu-special-report/",
            },
          ],
        },
      },
      true,
      false,
    );

    expect(candidates).toContain(
      "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal",
    );
    expect(candidates).not.toContain(
      "https://www.politico.eu/newsletter/politico-eu-influence",
    );
    expect(candidates).not.toContain(
      "https://www.politico.eu/country/greenland",
    );
    expect(candidates).not.toContain(
      "https://www.politico.eu/europe-poll-of-polls/european-parliament-election",
    );
    expect(candidates).not.toContain(
      "https://www.politico.eu/special-report/danish-presidency-of-the-eu-special-report",
    );
  });

  it("applies pattern and publish-confidence guards for detail candidates", async () => {
    mockResultService.extractMarkdownResult.mockImplementation(
      (markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: "",
      }),
    );

    const instance = service as unknown as {
      extractDetailLinkCandidatesFromArticle: (
        article: Record<string, unknown>,
        requireSameDomain: boolean,
        allowExternalLinks?: boolean,
        excludeUrlPatterns?: string[],
        includeUrlPatterns?: string[],
        minPublishTimeConfidence?: number,
      ) => string[];
    };

    const candidates = instance.extractDetailLinkCandidatesFromArticle(
      {
        url: "https://example.com/latest/",
        markdown:
          "[A](https://example.com/world/market-wrap-2026-02-06)\n" +
          "[B](https://example.com/archive/markets)\n" +
          "[C](https://example.com/world/short-note)",
      },
      true,
      true,
      ["/archive/"],
      undefined,
      0.8,
    );

    expect(candidates).toContain(
      "https://example.com/world/market-wrap-2026-02-06",
    );
    expect(candidates).not.toContain("https://example.com/archive/markets");
    expect(candidates).not.toContain("https://example.com/world/short-note");
  });

  it("extracts publish-time confidence from html meta/jsonld/time signals", () => {
    const instance = service as unknown as {
      extractPublishSignalFromHtml: (
        html: string,
      ) =>
        | { confidence: number; source: string; timestamp?: number }
        | undefined;
    };

    const html = `
      <html>
        <head>
          <meta property="article:published_time" content="2026-02-06T08:30:00Z" />
          <script type="application/ld+json">
            {"@type":"NewsArticle","datePublished":"2026-02-06T08:30:00Z"}
          </script>
        </head>
        <body>
          <time datetime="2026-02-06T08:30:00Z"></time>
        </body>
      </html>
    `;
    const signal = instance.extractPublishSignalFromHtml(html);

    expect(signal?.source).toBe("meta");
    expect(signal?.confidence).toBe(0.95);
    expect(typeof signal?.timestamp).toBe("number");
  });

  it("prefers enriched publish-time signal over url-path heuristic when stronger", () => {
    const instance = service as unknown as {
      resolveCandidatePublishSignal: (
        url: string,
        enriched?: {
          confidence: number;
          source: "meta" | "jsonld" | "time_tag" | "url_path" | "none";
          timestamp?: number;
        },
      ) => { confidence: number; source: string };
    };

    const enriched = instance.resolveCandidatePublishSignal(
      "https://example.com/world/story",
      {
        confidence: 0.92,
        source: "jsonld",
        timestamp: Date.parse("2026-02-06T08:30:00Z"),
      },
    );
    expect(enriched.source).toBe("jsonld");
    expect(enriched.confidence).toBe(0.92);

    const fallback = instance.resolveCandidatePublishSignal(
      "https://example.com/2026/02/06/world/story",
    );
    expect(fallback.source).toBe("url_path");
    expect(fallback.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("loads publish-signal enrichment timeout/concurrency/maxReadBytes from crawl settings", async () => {
    mockCrawlSettings.getSettings.mockResolvedValueOnce({
      detailPublishSignalHeadFetchTimeoutMs: 2_500,
      detailPublishSignalHeadFetchConcurrency: 5,
      detailPublishSignalHeadFetchMaxReadBytes: 12_000_000,
    });

    const instance = service as unknown as {
      getPublishSignalEnrichmentSettings: () => Promise<{
        timeoutMs: number;
        concurrency: number;
        maxReadBytes: number;
      }>;
    };

    const settings = await instance.getPublishSignalEnrichmentSettings();

    expect(mockCrawlSettings.getSettings).toHaveBeenCalledTimes(1);
    expect(settings).toEqual({
      timeoutMs: 2_500,
      concurrency: 5,
      maxReadBytes: 12_000_000,
    });
  });

  it("falls back to defaults when crawl settings fetch fails", async () => {
    mockCrawlSettings.getSettings.mockRejectedValueOnce(
      new Error("settings unavailable"),
    );

    const instance = service as unknown as {
      getPublishSignalEnrichmentSettings: () => Promise<{
        timeoutMs: number;
        concurrency: number;
        maxReadBytes: number;
      }>;
    };

    const settings = await instance.getPublishSignalEnrichmentSettings();

    expect(mockCrawlSettings.getSettings).toHaveBeenCalledTimes(1);
    expect(settings).toEqual({
      timeoutMs: 1_500,
      concurrency: 2,
      maxReadBytes: 8_000_000,
    });
  });

  it("reports effective enrichment parameters even when enrichment is skipped", async () => {
    const instance = service as unknown as {
      enrichCandidatePublishSignals: (options: {
        urls: string[];
        requestTimeoutMs?: number;
        settings: {
          timeoutMs: number;
          concurrency: number;
          maxReadBytes: number;
        };
      }) => Promise<{
        attempted: number;
        skipped: boolean;
        effectiveTimeoutMs: number;
        effectiveConcurrency: number;
        maxReadBytes: number;
        truncatedResponses: number;
        earlyStoppedResponses: number;
        softFailureCount: number;
        softFailures: {
          httpStatus: number;
          nonHtml: number;
          emptyHtml: number;
          networkOrTimeout: number;
          noPublishSignal: number;
        };
      }>;
    };

    const result = await instance.enrichCandidatePublishSignals({
      urls: ["https://example.com/world/story"],
      requestTimeoutMs: 900,
      settings: {
        timeoutMs: 2_500,
        concurrency: 5,
        maxReadBytes: 12_000_000,
      },
    });

    expect(result.attempted).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.effectiveTimeoutMs).toBe(900);
    expect(result.effectiveConcurrency).toBe(1);
    expect(result.maxReadBytes).toBe(12_000_000);
    expect(result.truncatedResponses).toBe(0);
    expect(result.earlyStoppedResponses).toBe(0);
    expect(result.softFailureCount).toBe(0);
    expect(result.softFailures).toEqual({
      httpStatus: 0,
      nonHtml: 0,
      emptyHtml: 0,
      networkOrTimeout: 0,
      noPublishSignal: 0,
    });
  });

  it("records enrichment soft-failures and early-stop metrics without hard failing", async () => {
    const instance = service as unknown as {
      shouldEnrichCandidatePublishSignals: () => boolean;
      fetchCandidatePublishSignal: (
        url: string,
        timeoutMs: number,
        maxReadBytes: number,
      ) => Promise<{
        signal?: {
          confidence: number;
          source: "meta" | "jsonld" | "time_tag" | "url_path" | "none";
          timestamp?: number;
        };
        truncated: boolean;
        earlyStopped: boolean;
        failureReason?: "no_publish_signal";
      }>;
      enrichCandidatePublishSignals: (options: {
        urls: string[];
        requestTimeoutMs?: number;
        settings: {
          timeoutMs: number;
          concurrency: number;
          maxReadBytes: number;
        };
      }) => Promise<{
        attempted: number;
        succeeded: number;
        failed: number;
        skipped: boolean;
        truncatedResponses: number;
        earlyStoppedResponses: number;
        softFailureCount: number;
        softFailures: {
          httpStatus: number;
          nonHtml: number;
          emptyHtml: number;
          networkOrTimeout: number;
          noPublishSignal: number;
        };
      }>;
    };

    jest
      .spyOn(instance, "shouldEnrichCandidatePublishSignals")
      .mockReturnValue(true);
    jest
      .spyOn(instance, "fetchCandidatePublishSignal")
      .mockResolvedValueOnce({
        truncated: false,
        earlyStopped: false,
        failureReason: "no_publish_signal",
      })
      .mockResolvedValueOnce({
        signal: {
          confidence: 0.95,
          source: "meta",
          timestamp: Date.parse("2026-02-06T08:30:00Z"),
        },
        truncated: true,
        earlyStopped: true,
      });

    const result = await instance.enrichCandidatePublishSignals({
      urls: ["https://example.com/a", "https://example.com/b"],
      settings: {
        timeoutMs: 2_500,
        concurrency: 2,
        maxReadBytes: 8_000_000,
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.softFailureCount).toBe(1);
    expect(result.softFailures.noPublishSignal).toBe(1);
    expect(result.truncatedResponses).toBe(1);
    expect(result.earlyStoppedResponses).toBe(1);
  });

  it("soft-truncates oversized publish-signal html without failing", async () => {
    const instance = service as unknown as {
      readPublishSignalHtmlWithSoftLimit: (
        response: Response,
        maxBytes: number,
      ) => Promise<{ html: string; truncated: boolean; earlyStopped: boolean }>;
    };
    const response = {
      body: null,
      text: jest.fn().mockResolvedValue("x".repeat(45_000)),
    } as unknown as Response;

    const result = await instance.readPublishSignalHtmlWithSoftLimit(
      response,
      40_000,
    );

    expect(result.truncated).toBe(true);
    expect(result.earlyStopped).toBe(false);
    expect(result.html.length).toBe(40_000);
  });

  it("stops reading early when head meta publish signal is found", async () => {
    const instance = service as unknown as {
      readPublishSignalHtmlWithSoftLimit: (
        response: Response,
        maxBytes: number,
      ) => Promise<{ html: string; truncated: boolean; earlyStopped: boolean }>;
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '<html><head><meta property="article:published_time" content="2026-02-06T08:30:00Z" /></head>',
          ),
        );
        controller.enqueue(encoder.encode("<body>tail-marker</body></html>"));
        controller.close();
      },
    });
    const response = {
      body: stream,
      text: jest.fn(),
    } as unknown as Response;

    const result = await instance.readPublishSignalHtmlWithSoftLimit(
      response,
      8_000_000,
    );

    expect(result.earlyStopped).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.html).toContain("article:published_time");
    expect(result.html).not.toContain("tail-marker");
  });

  it("uses low-signal results as expansion seeds when no successful markdown exists", async () => {
    const task = createMockTask({
      config: {
        pageTypeHint: "list",
        autoExpandDetails: true,
        detailExpansion: {
          maxDetailUrls: 6,
          minRelevanceScore: 0,
          requireSameDomain: true,
          allowExternalLinks: true,
        },
      },
    });

    const initialResponse = createMockCrawlResponse({
      results: [
        {
          url: "https://example.com/latest",
          markdown:
            "## References\n\n[1]: https://example.com/world/a-very-long-article-slug-with-context",
          success: true,
          links: {
            internal: [
              {
                href: "https://example.com/world/a-very-long-article-slug-with-context",
              },
            ],
          },
          metadata: {
            url: "https://example.com/latest",
          },
        },
      ],
    });

    const expansionResponse = createMockCrawlResponse({
      runId: "expansion-run",
      results: [
        {
          url: "https://example.com/world/a-very-long-article-slug-with-context",
          markdown:
            "# Headline\n\nParagraph one with detailed context and analysis.\n\nParagraph two with additional reporting facts.\n\nParagraph three for stable article body.",
          success: true,
          metadata: {},
        },
      ],
    });

    mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
    mockPrisma.crawlTask.update.mockResolvedValue(task);
    mockCrawlClient.crawl
      .mockResolvedValue(expansionResponse)
      .mockResolvedValueOnce(initialResponse);
    mockResultService.extractMarkdownResult.mockImplementation(
      (markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: "",
      }),
    );
    mockResultService.persistResults.mockResolvedValue({
      inserted: 1,
      skipped: 0,
      lastFetchedAt: new Date(),
    });
    mockResultService.isLowSignalMarkdown.mockImplementation(
      (markdown: string) =>
        markdown.trim().toLowerCase().startsWith("## references"),
    );

    mockQualityStrategy.resolveQualityProfile.mockReturnValue("quality_first");
    mockQualityStrategy.assessPageSignals.mockImplementation(
      (articles: any[]) => {
        if (articles[0]?.url === "https://example.com/latest") {
          return {
            kind: "list",
            assessments: [
              {
                index: 0,
                article: articles[0],
                quality: {
                  wordCount: 120,
                  paragraphCount: 1,
                  headingCount: 1,
                  linkCount: 10,
                  linkDensity: 0.2,
                  bulletLines: 6,
                  score: 10,
                  isListLike: true,
                },
                linkInventory: 10,
              },
            ],
            lowSignalAssessments: [
              {
                index: 0,
                article: articles[0],
                quality: {
                  wordCount: 120,
                  paragraphCount: 1,
                  headingCount: 1,
                  linkCount: 10,
                  linkDensity: 0.2,
                  bulletLines: 6,
                  score: 10,
                  isListLike: true,
                },
                linkInventory: 10,
              },
            ],
            allLowSignal: true,
            maxLowSignalWords: 120,
            minLowSignalWords: 120,
            meanLowSignalWords: 120,
            bestLowSignalScore: 10,
            maxLowSignalLinkDensity: 0.2,
            meanLowSignalLinkDensity: 0.2,
          };
        }

        return {
          kind: "detail",
          assessments: [
            {
              index: 0,
              article: articles[0],
              quality: {
                wordCount: 360,
                paragraphCount: 8,
                headingCount: 1,
                linkCount: 2,
                linkDensity: 0.01,
                bulletLines: 0,
                score: 420,
                isListLike: false,
              },
              linkInventory: 2,
            },
          ],
          lowSignalAssessments: [],
          allLowSignal: false,
          maxLowSignalWords: 0,
          minLowSignalWords: 0,
          meanLowSignalWords: 0,
          bestLowSignalScore: Number.NEGATIVE_INFINITY,
          maxLowSignalLinkDensity: 0,
          meanLowSignalLinkDensity: 0,
        };
      },
    );
    mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
    mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
      maxDetailUrls: 6,
      minRelevanceScore: 0,
      requireSameDomain: true,
      allowExternalLinks: true,
    });
    mockQualityStrategy.isSignificantDetailImprovement.mockReturnValue(true);
    mockQualityStrategy.assessArticleMarkdownSignal.mockReturnValue({
      wordCount: 360,
      paragraphCount: 8,
      headingCount: 1,
      linkCount: 2,
      linkDensity: 0.01,
      bulletLines: 0,
      score: 420,
      isListLike: false,
    });

    const result = await service.runTask("task-1", "org-1");

    expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
    expect(mockResultService.persistResults).toHaveBeenCalledWith(
      task,
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/world/a-very-long-article-slug-with-context",
        }),
      ]),
      expect.any(Object),
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(result.inserted).toBe(1);
  });

  it("falls back to link inventory when strict detail candidates are sparse", async () => {
    const task = createMockTask({ targetUrl: "https://example.com/latest" });

    const listMarkdown =
      "# Latest\n" +
      "- [Section](https://example.com/news/world/)\n" +
      "- [Section](https://example.com/news/business/)";

    const initialResponse = createMockCrawlResponse({
      results: [
        {
          url: "https://example.com/latest",
          markdown: listMarkdown,
          success: true,
          metadata: {},
          links: {
            internal: [
              {
                href: "https://example.com/world/a-very-long-article-slug-with-context-and-analysis-2026",
                text: "A very long article slug with context and analysis",
              },
              {
                href: "https://example.com/business/another-very-long-article-slug-with-context",
                text: "Another long-form article",
              },
            ],
          },
        },
      ],
    });

    const expansionResponse = createMockCrawlResponse({
      runId: "run-expansion",
      results: [
        {
          url: "https://example.com/world/a-very-long-article-slug-with-context-and-analysis-2026",
          markdown:
            "# Headline\n\nParagraph one with detailed context and analysis.\n\nParagraph two with additional reporting facts.",
          success: true,
          metadata: {},
        },
      ],
    });

    mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
    mockPrisma.crawlTask.update.mockResolvedValue(task);
    mockCrawlClient.crawl
      .mockResolvedValueOnce(initialResponse)
      .mockResolvedValue(expansionResponse);
    mockResultService.extractMarkdownResult.mockImplementation(
      (markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: "",
      }),
    );
    mockResultService.persistResults.mockResolvedValue({
      inserted: 1,
      skipped: 0,
      lastFetchedAt: new Date(),
    });
    mockResultService.isLowSignalMarkdown.mockReturnValue(false);

    mockQualityStrategy.resolveQualityProfile.mockReturnValue("quality_first");
    mockQualityStrategy.assessPageSignals.mockImplementation(
      (articles: any[]) => {
        if (articles[0]?.url === "https://example.com/latest") {
          return {
            kind: "list",
            assessments: [
              {
                index: 0,
                article: articles[0],
                quality: {
                  wordCount: 140,
                  paragraphCount: 1,
                  headingCount: 1,
                  linkCount: 18,
                  linkDensity: 0.2,
                  bulletLines: 4,
                  score: 20,
                  isListLike: true,
                },
                linkInventory: 18,
              },
            ],
            lowSignalAssessments: [
              {
                index: 0,
                article: articles[0],
                quality: {
                  wordCount: 140,
                  paragraphCount: 1,
                  headingCount: 1,
                  linkCount: 18,
                  linkDensity: 0.2,
                  bulletLines: 4,
                  score: 20,
                  isListLike: true,
                },
                linkInventory: 18,
              },
            ],
            allLowSignal: true,
            maxLowSignalWords: 140,
            minLowSignalWords: 140,
            meanLowSignalWords: 140,
            bestLowSignalScore: 20,
            maxLowSignalLinkDensity: 0.2,
            meanLowSignalLinkDensity: 0.2,
          };
        }

        return {
          kind: "detail",
          assessments: [],
          lowSignalAssessments: [],
          allLowSignal: false,
          maxLowSignalWords: 0,
          minLowSignalWords: 0,
          meanLowSignalWords: 0,
          bestLowSignalScore: Number.NEGATIVE_INFINITY,
          maxLowSignalLinkDensity: 0,
          meanLowSignalLinkDensity: 0,
        };
      },
    );
    mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
    mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
      maxDetailUrls: 6,
      minRelevanceScore: 0.85,
      requireSameDomain: true,
      allowExternalLinks: true,
    });
    mockQualityStrategy.isSignificantDetailImprovement.mockReturnValue(true);
    mockQualityStrategy.assessArticleMarkdownSignal.mockReturnValue({
      wordCount: 360,
      paragraphCount: 8,
      headingCount: 1,
      linkCount: 2,
      linkDensity: 0.01,
      score: 420,
      isListLike: false,
    });

    const result = await service.runTask("task-1", "org-1");

    expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(2);
    const expansionPayload = (mockCrawlClient.crawl as jest.Mock).mock
      .calls[1]?.[0] as any;
    expect(expansionPayload?.urls).toEqual(
      expect.arrayContaining([
        "https://example.com/world/a-very-long-article-slug-with-context-and-analysis-2026",
      ]),
    );
    expect(result.inserted).toBe(1);
  });

  describe("runTask error handling", () => {
    it("fails fast when task config enables crawl-stage llm extraction", async () => {
      const config = {
        markdownStrategy: {
          type: "LLMExtractionStrategy",
        },
      };
      const task = createMockTask({ config });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);

      await expect(service.runTask("task-1", "org-1")).rejects.toThrow(
        "crawl stage must only fetch and store cleaned markdown",
      );

      expect(mockCrawlClient.crawl).not.toHaveBeenCalled();
      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
    });

    it("marks Crawl4aiRequestException with 429 as retryable", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(
        new Crawl4aiRequestException("Rate limited", 429),
      );

      await expect(
        service.runTask("task-1", "org-1", undefined, {
          attempt: 1,
          maxAttempts: 3,
          backoffDelayMs: 1000,
        }),
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "queued" }),
        }),
      );
    });

    it("marks Crawl4aiRequestException with 500 as retryable", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(
        new Crawl4aiRequestException("Server error", 500),
      );

      await expect(
        service.runTask("task-1", "org-1", undefined, {
          attempt: 1,
          maxAttempts: 3,
          backoffDelayMs: 1000,
        }),
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "queued" }),
        }),
      );
    });

    it("marks Crawl4aiRequestException with 400 as non-retryable", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(
        new Crawl4aiRequestException("Bad request", 400),
      );

      await expect(
        service.runTask("task-1", "org-1", undefined, {
          attempt: 1,
          maxAttempts: 3,
        }),
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
    });

    it("does not retry when attempt >= maxAttempts", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(
        new Crawl4aiRequestException("Rate limited", 429),
      );

      await expect(
        service.runTask("task-1", "org-1", undefined, {
          attempt: 3,
          maxAttempts: 3,
        }),
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
    });

    it("does not send notification when shouldRetry is true", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(
        new Crawl4aiRequestException("Rate limited", 429),
      );

      await expect(
        service.runTask("task-1", "org-1", "user-1", {
          attempt: 1,
          maxAttempts: 3,
          backoffDelayMs: 1000,
        }),
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockNotifications.notify).not.toHaveBeenCalled();
    });

    it("sends failure notification when shouldRetry is false", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(
        new Crawl4aiRequestException("Bad request", 400),
      );
      mockNotifications.notify.mockResolvedValue(undefined);

      await expect(
        service.runTask("task-1", "org-1", "user-1", {
          attempt: 1,
          maxAttempts: 3,
        }),
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockNotifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.crawl_failed,
          data: expect.objectContaining({
            presentation: expect.objectContaining({
              kind: NotificationPresentationKind.CrawlFailed,
              technicalDetail: "Bad request",
              params: expect.objectContaining({
                taskId: "task-1",
                taskLabel: "Test Task",
                inserted: 0,
                skipped: 0,
              }),
            }),
          }),
        }),
      );
    });
  });

  describe("normalizeOptions", () => {
    it("returns default values when no options provided", () => {
      const result = service.normalizeOptions();

      expect(result.includeImages).toBe(false);
      expect(result.storeMedia).toBe(false);
      expect(result.onlyMainContent).toBe(true);
      expect(result.extractLinks).toBe(false);
      expect(result.cacheMode).toBe("bypass");
      expect(result.scanFullPage).toBe(false);
      expect(result.headless).toBeUndefined();
      expect(result.enableUndetectedBrowser).toBe(false);
      expect(result.enableStealthMode).toBe(false);
      expect(result.antiBotMode).toBe("auto");
      expect(result.useManagedBrowser).toBe(false);
      expect(result.simulateUser).toBe(false);
      expect(result.overrideNavigator).toBe(false);
      expect(result.userAgentMode).toBe("random");
      expect(result.excludeExternalLinks).toBe(true);
      expect(result.removeOverlayElements).toBe(true);
      expect(result.processIframes).toBe(true);
      expect(result.textMode).toBe(false);
      expect(result.captureScreenshot).toBe(false);
      expect(result.wordCountThreshold).toBe(80);
    });

    it("disables random UA mode when custom userAgent is provided", () => {
      const result = service.normalizeOptions({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        userAgentMode: "random",
        userAgentGenerator: {
          platform: "windows",
          browser: "chrome",
          deviceType: "desktop",
          locale: "en-US",
        },
      });

      expect(result.userAgent).toContain("Mozilla/5.0");
      expect(result.userAgentMode).toBeUndefined();
      expect(result.userAgentGenerator).toBeUndefined();
    });

    it("applies quality-first markdown defaults for RAG readiness", () => {
      const result = service.normalizeOptions();

      expect(result.qualityProfile).toBe("quality_first");
      expect(result.markdownOptions).toEqual(
        expect.objectContaining({
          contentSource: "cleaned_html",
          citations: true,
        }),
      );
      expect(result.cleanMarkdown).toEqual(
        expect.objectContaining({
          removeOverlayElements: true,
          wordCountThreshold: 18,
        }),
      );
      expect(result.cleanMarkdown?.excludedTags).toEqual(
        expect.arrayContaining([
          "nav",
          "footer",
          "aside",
          "script",
          "style",
          "noscript",
          "form",
        ]),
      );
    });

    it("uses raw_html markdown source for speed_first profile", () => {
      const result = service.normalizeOptions({
        qualityProfile: "speed_first",
      });

      expect(result.markdownOptions).toEqual(
        expect.objectContaining({
          contentSource: "raw_html",
          citations: true,
        }),
      );
      expect(result.cleanMarkdown).toEqual(
        expect.objectContaining({
          removeOverlayElements: true,
          wordCountThreshold: 12,
        }),
      );
    });

    it("keeps headless when provided", () => {
      expect(service.normalizeOptions({ headless: true }).headless).toBe(true);
      expect(service.normalizeOptions({ headless: false }).headless).toBe(
        false,
      );
    });

    it("normalizes antiBotMode and defaults to auto for invalid values", () => {
      expect(
        service.normalizeOptions({ antiBotMode: "enabled" as any }).antiBotMode,
      ).toBe("enabled");
      expect(
        service.normalizeOptions({ antiBotMode: "disabled" as any })
          .antiBotMode,
      ).toBe("disabled");
      expect(
        service.normalizeOptions({ antiBotMode: "unexpected" as any })
          .antiBotMode,
      ).toBe("auto");
    });

    it("sets includeImages to true when storeMedia is true", () => {
      const result = service.normalizeOptions({ storeMedia: true });

      expect(result.includeImages).toBe(true);
      expect(result.storeMedia).toBe(true);
    });

    it("enables scrollDelayMs with default 200 when scanFullPage is true", () => {
      const result = service.normalizeOptions({ scanFullPage: true });

      expect(result.scanFullPage).toBe(true);
      expect(result.scrollDelayMs).toBe(200);
    });

    it("clamps scrollDelayMs to 0-5000 range", () => {
      expect(
        service.normalizeOptions({ scanFullPage: true, scrollDelayMs: -100 })
          .scrollDelayMs,
      ).toBe(0);
      expect(
        service.normalizeOptions({ scanFullPage: true, scrollDelayMs: 10000 })
          .scrollDelayMs,
      ).toBe(5000);
      expect(
        service.normalizeOptions({ scanFullPage: true, scrollDelayMs: 500 })
          .scrollDelayMs,
      ).toBe(500);
    });

    it("sets scrollDelayMs to 200 when NaN", () => {
      const result = service.normalizeOptions({
        scanFullPage: true,
        scrollDelayMs: NaN,
      });
      expect(result.scrollDelayMs).toBe(200);
    });

    it("defaults adjustViewportToContent to true when scanFullPage is enabled", () => {
      const result = service.normalizeOptions({ scanFullPage: true });

      expect(result.adjustViewportToContent).toBe(true);
    });

    it("keeps adjustViewportToContent false when scanFullPage is disabled", () => {
      const result = service.normalizeOptions();

      expect(result.scanFullPage).toBe(false);
      expect(result.adjustViewportToContent).toBe(false);
    });

    it("respects explicit adjustViewportToContent override", () => {
      const result = service.normalizeOptions({
        scanFullPage: true,
        adjustViewportToContent: false,
      });

      expect(result.scanFullPage).toBe(true);
      expect(result.adjustViewportToContent).toBe(false);
    });

    it("sets simulateUser and overrideNavigator to true when enableStealthMode is true", () => {
      const result = service.normalizeOptions({ enableStealthMode: true });

      expect(result.simulateUser).toBe(true);
      expect(result.overrideNavigator).toBe(true);
    });

    it("rejects browser headers containing control characters", () => {
      const result = service.normalizeOptions({
        browserHeaders: [
          { name: "X-Good", value: "ok" },
          { name: "X-Bad\r\nInjected", value: "bad" },
          { name: "X-Bad", value: "bad\r\nInjected" },
        ],
      });

      expect(result.browserHeaders).toEqual([{ name: "X-Good", value: "ok" }]);
    });

    it("sets useManagedBrowser to true when userDataDir is provided", () => {
      const result = service.normalizeOptions({ userDataDir: "/path/to/data" });

      expect(result.useManagedBrowser).toBe(true);
      expect(result.userDataDir).toBe("/path/to/data");
    });

    it("prefers proxyConfig over proxyUrl", () => {
      const result = service.normalizeOptions({
        proxyUrl: "http://proxy.example.com",
        proxyConfig: { server: "http://other-proxy.example.com" },
      });

      expect(result.proxyConfig).toEqual({
        server: "http://other-proxy.example.com",
      });
      expect(result.proxyUrl).toBeUndefined();
    });

    it("deduplicates additionalUrls", () => {
      const result = service.normalizeOptions({
        additionalUrls: ["https://a.com", "https://b.com", "https://a.com"],
      });

      expect(result.additionalUrls).toEqual(["https://a.com", "https://b.com"]);
    });

    it("normalizes markdownOptions with bodyWidth clamping", () => {
      const result = service.normalizeOptions({
        markdownOptions: {
          contentSource: "cleaned_html",
          citations: true,
          bodyWidth: 300,
        },
      });

      expect(result.markdownOptions?.contentSource).toBe("cleaned_html");
      expect(result.markdownOptions?.citations).toBe(true);
      expect(result.markdownOptions?.bodyWidth).toBe(200); // clamped to max 200
    });

    it("normalizes markdownFilter with pruning type", () => {
      const result = service.normalizeOptions({
        markdownFilter: {
          type: "pruning",
          threshold: 0.5,
          thresholdType: "dynamic",
        },
      });

      expect(result.markdownFilter?.type).toBe("pruning");
      expect(result.markdownFilter?.threshold).toBe(0.5);
      expect(result.markdownFilter?.thresholdType).toBe("dynamic");
    });

    it("normalizes markdownFilter with bm25 type", () => {
      const result = service.normalizeOptions({
        markdownFilter: {
          type: "bm25",
          userQuery: " machine learning ",
          bm25Threshold: 1.2,
          language: " english ",
        } as any,
      });

      expect(result.markdownFilter).toEqual(
        expect.objectContaining({
          type: "bm25",
          userQuery: "machine learning",
          bm25Threshold: 1.2,
          language: "english",
        }),
      );
    });

    it("deduplicates browserHeaders by name (case-insensitive)", () => {
      const result = service.normalizeOptions({
        browserHeaders: [
          { name: "Authorization", value: "Bearer token1" },
          { name: "authorization", value: "Bearer token2" },
          { name: "X-Custom", value: "value" },
        ],
      });

      expect(result.browserHeaders).toHaveLength(2);
      expect(result.browserHeaders?.[0].name).toBe("Authorization");
    });

    it("deduplicates browserCookies by name+domain+path", () => {
      const result = service.normalizeOptions({
        browserCookies: [
          { name: "session", value: "abc", domain: "example.com", path: "/" },
          { name: "session", value: "xyz", domain: "example.com", path: "/" },
          { name: "session", value: "123", domain: "other.com", path: "/" },
        ],
      });

      expect(result.browserCookies).toHaveLength(2);
    });

    it("normalizes virtualScroll config", () => {
      const result = service.normalizeOptions({
        virtualScroll: {
          containerSelector: ".scroll-container",
          scrollCount: 10,
          scrollBy: "viewport",
          waitAfterScrollMs: 500,
        },
      });

      expect(result.virtualScroll?.containerSelector).toBe(".scroll-container");
      expect(result.virtualScroll?.scrollCount).toBe(10);
      expect(result.virtualScroll?.scrollBy).toBe("page_height");
      expect(result.virtualScroll?.waitAfterScrollMs).toBe(500);
    });

    it("clamps geolocation latitude to -90/90 and longitude to -180/180", () => {
      const result = service.normalizeOptions({
        geolocation: {
          latitude: 100,
          longitude: -200,
        },
      });

      expect(result.geolocation?.latitude).toBe(90);
      expect(result.geolocation?.longitude).toBe(-180);
    });

    it("clamps wordCountThreshold to 0-5000 range", () => {
      expect(
        service.normalizeOptions({ wordCountThreshold: -10 })
          .wordCountThreshold,
      ).toBe(0);
      expect(
        service.normalizeOptions({ wordCountThreshold: 10000 })
          .wordCountThreshold,
      ).toBe(5000);
      expect(
        service.normalizeOptions({ wordCountThreshold: 100 })
          .wordCountThreshold,
      ).toBe(100);
    });

    it("clamps waitForTimeoutMs to 500-60000 range", () => {
      expect(
        service.normalizeOptions({ waitForTimeoutMs: 100 }).waitForTimeoutMs,
      ).toBe(500);
      expect(
        service.normalizeOptions({ waitForTimeoutMs: 100000 }).waitForTimeoutMs,
      ).toBe(60000);
      expect(
        service.normalizeOptions({ waitForTimeoutMs: 5000 }).waitForTimeoutMs,
      ).toBe(5000);
    });

    it("normalizes waitUntil/pageTimeout and politeness controls", () => {
      const result = service.normalizeOptions({
        waitUntil: "networkidle",
        waitForTimeoutMs: 600,
        pageTimeoutMs: 999999,
        delayBeforeReturnHtmlMs: 35000,
        meanDelayMs: -100,
        maxDelayRangeMs: 13000,
        semaphoreCount: 999,
        removeForms: true,
      });

      expect(result.waitUntil).toBe("networkidle");
      expect(result.waitForTimeoutMs).toBe(5000);
      expect(result.pageTimeoutMs).toBe(180000);
      expect(result.delayBeforeReturnHtmlMs).toBe(30000);
      expect(result.meanDelayMs).toBe(0);
      expect(result.maxDelayRangeMs).toBe(10000);
      expect(result.semaphoreCount).toBe(50);
      expect(result.removeForms).toBe(true);
    });

    it("normalizes politeness controls in multiUrl strategy overrides", () => {
      const result = service.normalizeOptions({
        multiUrlConfigs: [
          {
            matcher: {
              patterns: ["https://example.com/world/*"],
              matchMode: "glob",
            },
            options: {
              waitUntil: "networkidle",
              waitForTimeoutMs: 800,
              pageTimeoutMs: 999999,
              delayBeforeReturnHtmlMs: 35000,
              meanDelayMs: -100,
              maxDelayRangeMs: 13000,
              semaphoreCount: 999,
              removeForms: true,
            },
          },
        ],
      });

      const overrides = result.multiUrlConfigs?.[0]?.options;
      expect(overrides?.waitUntil).toBe("networkidle");
      expect(overrides?.waitForTimeoutMs).toBe(5000);
      expect(overrides?.pageTimeoutMs).toBe(180000);
      expect(overrides?.delayBeforeReturnHtmlMs).toBe(30000);
      expect(overrides?.meanDelayMs).toBe(0);
      expect(overrides?.maxDelayRangeMs).toBe(10000);
      expect(overrides?.semaphoreCount).toBe(50);
      expect(overrides?.removeForms).toBe(true);
    });

    it("normalizes detailExpansion fields on top-level options", () => {
      const result = service.normalizeOptions({
        detailExpansion: {
          maxDetailUrls: 88,
          minRelevanceScore: 1.2,
          requireSameDomain: false,
          allowExternalLinks: true,
          includeUrlPatterns: [" /news/* ", "/news/*", "/article/ "],
          excludeUrlPatterns: [" /tag/ ", "/archive/", "/tag/"],
          minPublishTimeConfidence: -0.25,
          preferFitMarkdownForQuality: false,
        },
      });

      expect(result.detailExpansion).toEqual(
        expect.objectContaining({
          maxDetailUrls: 30,
          minRelevanceScore: 1,
          requireSameDomain: false,
          allowExternalLinks: true,
          includeUrlPatterns: ["/news/*", "/article/"],
          excludeUrlPatterns: ["/tag/", "/archive/"],
          minPublishTimeConfidence: 0,
          preferFitMarkdownForQuality: false,
        }),
      );
    });

    it("normalizes detailExpansion fields in multiUrl strategy overrides", () => {
      const result = service.normalizeOptions({
        multiUrlConfigs: [
          {
            matcher: {
              patterns: ["https://example.com/world/*"],
              matchMode: "glob",
            },
            options: {
              detailExpansion: {
                maxDetailUrls: 0,
                minRelevanceScore: 0.4567,
                includeUrlPatterns: [" /world/* ", "/world/*"],
                excludeUrlPatterns: ["   "],
                minPublishTimeConfidence: 0.87654,
                preferFitMarkdownForQuality: true,
              },
            },
          },
        ],
      });

      const overrides = result.multiUrlConfigs?.[0]?.options?.detailExpansion;
      expect(overrides).toEqual(
        expect.objectContaining({
          maxDetailUrls: 1,
          minRelevanceScore: 0.457,
          includeUrlPatterns: ["/world/*"],
          minPublishTimeConfidence: 0.877,
          preferFitMarkdownForQuality: true,
        }),
      );
      expect(overrides?.excludeUrlPatterns).toBeUndefined();
    });

    it("parses detailExpansion fields from persisted crawl config", () => {
      const extracted = (
        service as unknown as {
          extractOptions: (
            config: Record<string, unknown>,
          ) => Record<string, unknown>;
        }
      ).extractOptions({
        autoExpandDetails: true,
        detailExpansion: {
          maxDetailUrls: 15.8,
          minRelevanceScore: 0.33333,
          includeUrlPatterns: [" /article/* ", "", "/article/*", "/world/*"],
          excludeUrlPatterns: [" /tag/ ", "/archive/"],
          minPublishTimeConfidence: 1.8,
          preferFitMarkdownForQuality: true,
        },
      });

      expect(extracted.autoExpandDetails).toBe(true);
      expect(extracted.detailExpansion).toEqual(
        expect.objectContaining({
          maxDetailUrls: 16,
          minRelevanceScore: 0.333,
          includeUrlPatterns: ["/article/*", "/world/*"],
          excludeUrlPatterns: ["/tag/", "/archive/"],
          minPublishTimeConfidence: 1,
          preferFitMarkdownForQuality: true,
        }),
      );
    });

    it("sets excludeExternalImages to false when storeMedia is true", () => {
      const result = service.normalizeOptions({ storeMedia: true });
      expect(result.excludeExternalImages).toBe(false);
    });

    it("sets waitForImages to true when storeMedia is true", () => {
      const result = service.normalizeOptions({ storeMedia: true });
      expect(result.waitForImages).toBe(true);
    });
  });

  describe("result partitioning", () => {
    it("partitions results into successes and failures", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          { url: "https://a.com", markdown: "# Success", success: true },
          {
            url: "https://b.com",
            markdown: "",
            success: false,
            error: "Failed to fetch",
          },
        ],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Success",
      });

      await service.runTask("task-1", "org-1");

      expect(mockResultService.persistResults).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ success: true })]),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
      );
    });

    it("treats HTTP 4xx with non-empty markdown as failure", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://blocked.com",
            markdown: "Verification Required",
            success: true,
            statusCode: 401,
          },
          {
            url: "https://ok.com",
            markdown: "# Usable content",
            success: true,
            statusCode: 200,
          },
        ],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );

      await service.runTask("task-1", "org-1");

      const persisted = (mockResultService.persistResults as jest.Mock).mock
        .calls[0]?.[1] as any[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.url).toBe("https://ok.com");
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          status: "completed",
          message: "crawl4ai completed with partial failures",
          data: expect.objectContaining({
            failures: 1,
            retryableFailures: 0,
          }),
        }),
      );
    });

    it("does not trigger anti-bot retry in auto mode when no challenge is detected", async () => {
      const task = createMockTask({ targetUrl: "https://example.com/world/" });
      const crawlResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com/world/",
            markdown: "# Partial content",
            success: true,
            statusCode: 200,
          },
          {
            url: "https://example.com/world/failure",
            success: false,
            statusCode: 500,
            error: "Upstream timeout",
          },
        ],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(1);
      const hasAntiBotRetryLog = (
        TaskLogModel.create as jest.Mock
      ).mock.calls.some(
        ([entry]) =>
          Boolean(entry) &&
          (entry as { stage?: string }).stage === "anti_bot_retry",
      );
      expect(hasAntiBotRetryLog).toBe(false);
    });

    it("skips anti-bot retry chain when antiBotMode is disabled", async () => {
      const task = createMockTask({
        targetUrl: "https://example.com/world/",
        config: {
          antiBotMode: "disabled",
        },
      });
      const crawlResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://blocked.com",
            markdown: "Verification Required",
            success: true,
            statusCode: 401,
          },
          {
            url: "https://ok.com/article",
            markdown: "# Valid content",
            success: true,
            statusCode: 200,
          },
        ],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );
      mockResultService.isLikelyBotChallengeMarkdown.mockImplementation(
        (markdown: string) => markdown.toLowerCase().includes("verification"),
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(1);
      const hasAntiBotRetryLog = (
        TaskLogModel.create as jest.Mock
      ).mock.calls.some(
        ([entry]) =>
          Boolean(entry) &&
          (entry as { stage?: string }).stage === "anti_bot_retry",
      );
      expect(hasAntiBotRetryLog).toBe(false);
    });

    it("forces anti-bot retry flow when antiBotMode is enabled and failures exist", async () => {
      const task = createMockTask({
        targetUrl: "https://example.com/world/",
        config: {
          antiBotMode: "enabled",
        },
      });
      const initialResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com/world/",
            markdown: "# Partial content",
            success: true,
            statusCode: 200,
          },
          {
            url: "https://example.com/world/failure",
            success: false,
            statusCode: 500,
            error: "Upstream timeout",
          },
        ],
      });
      const warmupResponse = createMockCrawlResponse({
        runId: "run-warmup-enabled",
        results: [
          {
            url: "https://example.com/",
            markdown: "# Home",
            success: true,
            statusCode: 200,
          },
        ],
      });
      const retryResponse = createMockCrawlResponse({
        runId: "run-retry-enabled",
        results: [
          {
            url: "https://example.com/world/article",
            markdown: "# Full article\n\nRecovered content after retry.",
            success: true,
            statusCode: 200,
          },
        ],
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(initialResponse)
        .mockResolvedValueOnce(warmupResponse)
        .mockResolvedValueOnce(retryResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(3);
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "anti_bot_retry",
          status: "completed",
          message: "Selected anti-bot retry candidate",
          data: expect.objectContaining({ reason: "anti_bot_mode_enabled" }),
        }),
      );
    });

    it("runs warmup + anti-bot retries and picks improved candidate", async () => {
      const task = createMockTask({ targetUrl: "https://example.com/world/" });
      const crawlResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://blocked.com",
            markdown:
              "Verification Required\nPlease enable JS and disable any ad blocker",
            success: true,
            statusCode: 200,
          },
          {
            url: "https://ok.com",
            markdown: "# Usable content",
            success: true,
            statusCode: 200,
          },
        ],
      });
      const warmupResponse = createMockCrawlResponse({
        runId: "run-warmup",
        results: [
          {
            url: "https://example.com/world/",
            markdown: "# World",
            success: true,
            statusCode: 200,
          },
        ],
      });
      const retryResponse = createMockCrawlResponse({
        runId: "run-retry",
        results: [
          {
            url: "https://ok.com",
            markdown: "# Usable content",
            success: true,
            statusCode: 200,
          },
        ],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(crawlResponse)
        .mockResolvedValueOnce(warmupResponse)
        .mockResolvedValueOnce(retryResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );
      mockResultService.isLikelyBotChallengeMarkdown.mockImplementation(
        (markdown: string) =>
          markdown.toLowerCase().includes("verification required"),
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(3);

      const warmupPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[1]?.[0] as {
        urls?: string[];
        options?: Record<string, unknown>;
      };
      expect(warmupPayload.urls).toEqual(
        expect.arrayContaining(["https://example.com/"]),
      );
      expect(warmupPayload.options).toEqual(
        expect.objectContaining({
          pageTypeHint: "list",
          waitForSelector: "main",
        }),
      );

      const retryPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[2]?.[0] as {
        options?: Record<string, unknown>;
      };
      const initialPayload = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[0]?.[0] as {
        options?: Record<string, unknown>;
      };
      expect(retryPayload.options).toEqual(
        expect.objectContaining({
          headless: false,
          enableUndetectedBrowser: true,
          enableStealthMode: true,
          simulateUser: true,
          overrideNavigator: true,
          userAgentMode: "random",
          waitUntil: "domcontentloaded",
          waitForSelector: "main",
        }),
      );
      expect(typeof retryPayload.options?.sessionId).toBe("string");
      expect(warmupPayload.options?.sessionId).toBe(
        initialPayload.options?.sessionId,
      );
      expect(retryPayload.options?.sessionId).toBe(
        initialPayload.options?.sessionId,
      );

      const persisted = (mockResultService.persistResults as jest.Mock).mock
        .calls[0]?.[1] as any[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.url).toBe("https://ok.com");
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "anti_bot_retry",
          status: "completed",
          message: "Selected anti-bot retry candidate",
          data: expect.objectContaining({
            reason: "challenge_detected",
            warmup: expect.objectContaining({
              result: "completed",
              runId: "run-warmup",
            }),
            attemptSummaries: expect.arrayContaining([
              expect.objectContaining({
                attempt: 1,
                result: "completed",
              }),
            ]),
          }),
        }),
      );
      const hasPartialFailureLog = (
        TaskLogModel.create as jest.Mock
      ).mock.calls.some(
        ([entry]) =>
          Boolean(entry) &&
          (entry as { stage?: string }).stage === "crawler" &&
          (entry as { message?: string }).message ===
            "crawl4ai partial failures",
      );
      expect(hasPartialFailureLog).toBe(false);
    });

    it("retries multiple anti-bot attempts and falls back to the best successful candidate", async () => {
      const task = createMockTask({
        targetUrl: "https://example.com/world/some-article-2026-02-10/",
      });
      const crawlResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://blocked.com",
            markdown:
              "Verification Required\nPlease enable JS and disable any ad blocker",
            success: true,
            statusCode: 401,
          },
        ],
      });
      const warmupResponse = createMockCrawlResponse({
        runId: "run-warmup",
        results: [
          {
            url: "https://example.com/world/",
            markdown: "# World",
            success: true,
            statusCode: 200,
          },
        ],
      });
      const retryResponseAttempt1 = createMockCrawlResponse({
        runId: "run-retry-1",
        results: [
          {
            url: "https://blocked.com",
            markdown: "Verifying the device",
            success: true,
            statusCode: 401,
          },
        ],
      });
      const retryResponseAttempt2 = createMockCrawlResponse({
        runId: "run-retry-2",
        results: [
          {
            url: "https://ok.com/article",
            markdown:
              "# Better\n\nThis is valid article body with enough text.",
            success: true,
            statusCode: 200,
          },
        ],
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(crawlResponse)
        .mockResolvedValueOnce(warmupResponse)
        .mockResolvedValueOnce(retryResponseAttempt1)
        .mockResolvedValueOnce(retryResponseAttempt2);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockImplementation(
        (markdown: unknown) => ({
          primary: typeof markdown === "string" ? markdown : "",
        }),
      );
      mockResultService.isLikelyBotChallengeMarkdown.mockImplementation(
        (markdown: string) => {
          const normalized = markdown.toLowerCase();
          return (
            normalized.includes("verification") ||
            normalized.includes("verifying the device")
          );
        },
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(4);

      const retryPayloadAttempt1 = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[2]?.[0] as {
        options?: Record<string, unknown>;
      };
      const retryPayloadAttempt2 = (mockCrawlClient.crawl as jest.Mock).mock
        .calls[3]?.[0] as {
        options?: Record<string, unknown>;
      };
      expect(retryPayloadAttempt1.options).toEqual(
        expect.objectContaining({
          waitUntil: "domcontentloaded",
          waitForSelector: "article",
        }),
      );
      expect(retryPayloadAttempt2.options).toEqual(
        expect.objectContaining({
          waitUntil: "load",
          waitForSelector: "article",
        }),
      );

      const hasBackoffLog = (TaskLogModel.create as jest.Mock).mock.calls.some(
        ([entry]) =>
          Boolean(entry) &&
          (entry as { stage?: string }).stage === "anti_bot_retry" &&
          (entry as { message?: string }).message?.includes(
            "backing off before retry 2/3",
          ),
      );
      expect(hasBackoffLog).toBe(false);

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "anti_bot_retry",
          status: "completed",
          message: "Selected anti-bot retry candidate",
          data: expect.objectContaining({
            attemptSummaries: expect.arrayContaining([
              expect.objectContaining({
                attempt: 1,
                result: "completed",
              }),
              expect.objectContaining({
                attempt: 2,
                result: "completed",
              }),
            ]),
          }),
        }),
      );

      const persisted = (mockResultService.persistResults as jest.Mock).mock
        .calls[0]?.[1] as any[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.url).toBe("https://ok.com/article");
    });

    it("logs warnings when present in response", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        warnings: ["Warning 1", "Warning 2"],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          status: "completed",
          message: "crawl4ai completed with warnings",
          data: expect.objectContaining({
            warnings: ["Warning 1", "Warning 2"],
            warningCount: 2,
          }),
        }),
      );
    });

    it("logs partial failures when present", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          { url: "https://a.com", markdown: "# Success", success: true },
          {
            url: "https://b.com",
            success: false,
            statusCode: 429,
            error: "Rate limited",
          },
        ],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Success",
      });

      await service.runTask("task-1", "org-1");

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          status: "completed",
          message: "crawl4ai completed with partial failures",
          data: expect.objectContaining({
            failureSamples: expect.any(Array),
          }),
        }),
      );
    });

    it("identifies retryable status codes correctly", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://a.com",
            success: false,
            statusCode: 429,
            error: "Rate limited",
          },
          {
            url: "https://b.com",
            success: false,
            statusCode: 500,
            error: "Server error",
          },
          {
            url: "https://c.com",
            success: false,
            statusCode: 400,
            error: "Bad request",
          },
        ],
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({
        inserted: 0,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: undefined,
      });

      await expect(service.runTask("task-1", "org-1")).rejects.toThrow(
        "crawl task produced no results",
      );

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          status: "completed",
          message: "crawl4ai completed with partial failures",
          data: expect.objectContaining({
            failures: 3,
            retryableFailures: 2,
          }),
        }),
      );
    });
  });

  describe("request payload building", () => {
    it("builds URL list starting with baseUrl", async () => {
      const task = createMockTask({ targetUrl: "https://example.com" });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
          urls: expect.arrayContaining(["https://example.com"]),
        }),
      );
    });

    it("extracts keywords from task.keywords JSON", async () => {
      const task = createMockTask({ keywords: ["keyword1", "keyword2"] });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          keywords: ["keyword1", "keyword2"],
        }),
      );
    });

    it("handles null keywords gracefully", async () => {
      const task = createMockTask({ keywords: null });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          keywords: [],
        }),
      );
    });

    it("includes additionalUrls in URL list", async () => {
      const task = createMockTask({
        config: {
          additionalUrls: ["https://extra1.com", "https://extra2.com"],
        },
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          urls: expect.arrayContaining([
            "https://example.com",
            "https://extra1.com",
            "https://extra2.com",
          ]),
        }),
      );
    });

    it("deduplicates URLs in the final list", async () => {
      const task = createMockTask({
        targetUrl: "https://example.com",
        config: {
          additionalUrls: ["https://example.com", "https://extra.com"],
        },
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({
        inserted: 1,
        skipped: 0,
      });
      mockResultService.extractMarkdownResult.mockReturnValue({
        primary: "# Test",
      });

      await service.runTask("task-1", "org-1");

      const crawlCall = mockCrawlClient.crawl.mock.calls[0][0];
      const uniqueUrls = new Set(crawlCall.urls);
      expect(crawlCall.urls.length).toBe(uniqueUrls.size);
    });
  });
});
