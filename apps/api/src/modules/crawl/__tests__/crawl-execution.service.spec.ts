jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  }),
  sanitizeError: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error)
  })
}));

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn()
  }
}));

import { TaskLogModel } from "@modular/mongo";
import { NotificationType } from "@prisma/client";
import { CrawlExecutionService } from "../crawl-execution.service";
import { Crawl4aiRequestException } from "../crawl4ai.exception";

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
  ...overrides
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
      metadata: {}
    }
  ],
  serverMemoryMb: 512,
  peakMemoryMb: 768,
  memoryEfficiency: 85,
  ...overrides
});

const createMockPrismaService = () => ({
  crawlTask: {
    findFirst: jest.fn(),
    update: jest.fn()
  }
});

const createMockEnvService = () => ({
  crawl4aiConfig: {
    baseUrl: "http://localhost:8082"
  }
});

const createMockCrawlClient = () => ({
  crawl: jest.fn()
});

const createMockResultService = () => ({
  persistResults: jest.fn(),
  extractMarkdownResult: jest.fn(),
  isLikelyBotChallengeMarkdown: jest.fn().mockReturnValue(false),
  isLowSignalMarkdown: jest.fn().mockReturnValue(false)
});

const createMockNotificationsService = () => ({
  notify: jest.fn()
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
    meanLowSignalLinkDensity: 0
  }),
  shouldAutoExpand: jest.fn().mockReturnValue(false),
  resolveDetailExpansion: jest.fn().mockReturnValue({
    maxDetailUrls: 12,
    minRelevanceScore: 0.35,
    requireSameDomain: true,
    allowExternalLinks: true
  }),
  assessArticleMarkdownSignal: jest.fn().mockReturnValue({
    wordCount: 120,
    paragraphCount: 4,
    headingCount: 1,
    linkCount: 2,
    linkDensity: 0.016,
    score: 120,
    isListLike: false
  }),
  isSignificantDetailImprovement: jest.fn().mockReturnValue(true)
});

describe("CrawlExecutionService", () => {
  let service: CrawlExecutionService;
  let mockPrisma: ReturnType<typeof createMockPrismaService>;
  let mockEnv: ReturnType<typeof createMockEnvService>;
  let mockCrawlClient: ReturnType<typeof createMockCrawlClient>;
  let mockResultService: ReturnType<typeof createMockResultService>;
  let mockQualityStrategy: ReturnType<typeof createMockQualityStrategyService>;
  let mockNotifications: ReturnType<typeof createMockNotificationsService>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockPrisma = createMockPrismaService();
    mockEnv = createMockEnvService();
    mockCrawlClient = createMockCrawlClient();
    mockResultService = createMockResultService();
    mockQualityStrategy = createMockQualityStrategyService();
    mockNotifications = createMockNotificationsService();

    service = new CrawlExecutionService(
      mockPrisma as any,
      mockEnv as any,
      mockCrawlClient as any,
      mockResultService as any,
      mockQualityStrategy as any,
      mockNotifications as any
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

      const promise = (service as any).safeNotifyCrawl(task, summary, "user-1", "completed");
      await jest.runAllTimersAsync();
      await promise;

      expect(mockNotifications.notify).toHaveBeenCalledTimes(3);
      expect(mockNotifications.notify).toHaveBeenLastCalledWith(
        expect.objectContaining({
          orgId: "org-1",
          userId: "user-1",
          type: NotificationType.crawl_completed
        })
      );
      expect(TaskLogModel.create).not.toHaveBeenCalled();
    });

    it("writes a notify failure log after exhausting retries", async () => {
      mockNotifications.notify.mockRejectedValue(new Error("db down"));

      const task = createMockTask();
      const summary = { inserted: 0, skipped: 0, lastFetchedAt: null };

      const promise = (service as any).safeNotifyCrawl(task, summary, "user-1", "failed", "boom");
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
            notificationType: NotificationType.crawl_failed
          })
        })
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
      const persistSummary = { inserted: 1, skipped: 0, lastFetchedAt: new Date() };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      const result = await service.runTask("task-1", "org-1");

      expect(mockPrisma.crawlTask.findFirst).toHaveBeenCalledWith({
        where: { id: "task-1", orgId: "org-1" }
      });
      expect(mockPrisma.crawlTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task-1" },
          data: expect.objectContaining({ status: "running" })
        })
      );
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "start", status: "processing" })
      );
      expect(mockCrawlClient.crawl).toHaveBeenCalled();
      expect(mockResultService.persistResults).toHaveBeenCalled();
      expect(result.inserted).toBe(1);
    });

    it("sends notification when triggeredById is provided", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse();
      const persistSummary = { inserted: 1, skipped: 0 };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });
      mockNotifications.notify.mockResolvedValue(undefined);

      const promise = service.runTask("task-1", "org-1", "user-1");
      await jest.runAllTimersAsync();
      await promise;

      expect(mockNotifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.crawl_completed,
          userId: "user-1"
        })
      );
    });

    it("updates task status to completed with memory stats", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse();
      const persistSummary = {
        inserted: 1,
        skipped: 0,
        lastFetchedAt: new Date(),
        memory: { serverMemoryMb: 512, peakMemoryMb: 768, efficiencyPercent: 85 }
      };

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue(persistSummary);
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "completed",
            runCount: { increment: 1 },
            lastServerMemoryMb: 512,
            lastPeakMemoryMb: 768,
            lastMemoryEfficiency: 85
          })
        })
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
            metadata: {}
          }
        ]
      });
      const fallbackResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com",
            markdown: "# Fallback Content",
            success: true,
            metadata: {}
          }
        ]
      });
      const persistSummary = { inserted: 1, skipped: 0, lastFetchedAt: new Date() };

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
      const secondCallPayload = (mockCrawlClient.crawl as jest.Mock).mock.calls[1]?.[0] as any;
      expect(secondCallPayload?.options).toEqual(
        expect.objectContaining({
          onlyMainContent: false,
          wordCountThreshold: 10,
          markdownOptions: expect.objectContaining({ contentSource: "raw_html" }),
        }),
      );
      const thirdCallPayload = (mockCrawlClient.crawl as jest.Mock).mock.calls[2]?.[0] as any;
      expect(thirdCallPayload?.options).toEqual(
        expect.objectContaining({
          markdownOptions: expect.objectContaining({ contentSource: "cleaned_html" }),
        }),
      );
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "fallback", status: "processing" }),
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
            metadata: {}
          }
        ]
      });
      const fallbackResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com/article/1",
            markdown: "# Article\n\nThis is a complete article body with context and details.",
            success: true,
            metadata: {}
          }
        ]
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(referenceOnlyResponse)
        .mockResolvedValueOnce(fallbackResponse)
        .mockResolvedValueOnce(fallbackResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0, lastFetchedAt: new Date() });
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : ""
      }));
      mockResultService.isLowSignalMarkdown.mockImplementation((markdown: string) =>
        markdown.trim().toLowerCase() === "## references"
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "fallback",
          status: "processing"
        })
      );
    });

    it("keeps bm25 fallback profile when empty-markdown failures occur with bm25 filter", async () => {
      const task = createMockTask({
        config: {
          markdownFilter: {
            type: "bm25",
            userQuery: "startup",
            bm25Threshold: 1.1,
            language: "english"
          }
        }
      });
      const emptyResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com",
            markdown: "",
            success: true,
            metadata: {}
          }
        ]
      });
      const fallbackResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com",
            markdown: "# BM25 Content",
            success: true,
            metadata: {}
          }
        ]
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(emptyResponse)
        .mockResolvedValueOnce(fallbackResponse)
        .mockResolvedValueOnce(fallbackResponse)
        .mockResolvedValueOnce(fallbackResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0, lastFetchedAt: new Date() });
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : ""
      }));

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThanOrEqual(4);
      const fallbackPayloads = (mockCrawlClient.crawl as jest.Mock).mock.calls.slice(1).map((entry) => entry[0] as any);
      expect(
        fallbackPayloads.some(
          (payload) =>
            payload?.options?.markdownFilter?.type === "bm25" &&
            payload?.options?.markdownFilter?.userQuery === "startup"
        )
      ).toBe(true);
      expect(result.inserted).toBe(1);
    });

    it("expands list-like markdown results by crawling detail candidates", async () => {
      const task = createMockTask({
        targetUrl: "https://jp.reuters.com/world/"
      });

      const listMarkdown =
        "# ワールド\n" +
        Array.from({ length: 18 }, (_, index) =>
          "- [記事" + index + "](https://jp.reuters.com/world/us/ARTICLE" + index + "-2026-02-06/)"
        ).join("\n");
      const detailedMarkdown =
        "# Detailed Article\n\n" +
        "This is a richer article paragraph with policy, timeline, and impact context.\n\n".repeat(80);

      const initialResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://jp.reuters.com/world/",
            markdown: listMarkdown,
            success: true,
            metadata: {}
          }
        ]
      });

      const expansionResponse = createMockCrawlResponse({
        runId: "run-expansion",
        results: [
          {
            url: "https://jp.reuters.com/world/us/ARTICLE0-2026-02-06/",
            markdown: detailedMarkdown,
            success: true,
            metadata: {}
          }
        ]
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(initialResponse)
        .mockResolvedValue(expansionResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0, lastFetchedAt: new Date() });
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : ""
      }));
      mockQualityStrategy.resolveQualityProfile.mockReturnValue("quality_first");
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
              isListLike: true
            },
            linkInventory: 18
          }
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
              isListLike: true
            },
            linkInventory: 18
          }
        ],
        allLowSignal: true,
        maxLowSignalWords: 220,
        minLowSignalWords: 220,
        meanLowSignalWords: 220,
        bestLowSignalScore: 50,
        maxLowSignalLinkDensity: 0.2,
        meanLowSignalLinkDensity: 0.2
      });
      mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
      mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
        maxDetailUrls: 12,
        minRelevanceScore: 0.05,
        requireSameDomain: true,
        allowExternalLinks: true
      });
      mockQualityStrategy.isSignificantDetailImprovement.mockReturnValue(true);
      mockQualityStrategy.assessArticleMarkdownSignal.mockImplementation((article: any) => {
        if (typeof article?.url === "string" && article.url.includes("ARTICLE0")) {
          return {
            wordCount: 1600,
            paragraphCount: 22,
            headingCount: 2,
            linkCount: 12,
            linkDensity: 0.01,
            bulletLines: 1,
            score: 1200,
            isListLike: false
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
          isListLike: true
        };
      });

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
      const expansionPayload = (mockCrawlClient.crawl as jest.Mock).mock.calls[1]?.[0] as any;
      expect(expansionPayload?.urls?.length).toBeGreaterThan(0);
      expect(expansionPayload?.options).toEqual(
        expect.objectContaining({
          scanFullPage: false,
          markdownFilter: undefined,
          extractLinks: false
        })
      );
      expect(mockResultService.persistResults).toHaveBeenCalledWith(
        task,
        expect.arrayContaining([
          expect.objectContaining({
            url: "https://jp.reuters.com/world/us/ARTICLE0-2026-02-06/"
          })
        ]),
        expect.any(Object),
        "run-expansion",
        expect.anything(),
        undefined
      );
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "expansion", status: "processing" })
      );
      expect(result.inserted).toBe(1);
    });
  });



    it("fails when all crawl markdown is low-signal and no detail candidates are extracted", async () => {
      const task = createMockTask({
        targetUrl: "https://jp.reuters.com/world/"
      });

      const listOnlyMarkdown =
        "# World\n" +
        Array.from({ length: 20 }, (_, index) =>
          "- [Section" + index + "](https://jp.reuters.com/world/us/)"
        ).join("\n");

      const initialResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://jp.reuters.com/world/",
            markdown: listOnlyMarkdown,
            success: true,
            metadata: {}
          }
        ]
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(initialResponse);
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : ""
      }));
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
              isListLike: true
            },
            linkInventory: 20
          }
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
              isListLike: true
            },
            linkInventory: 20
          }
        ],
        allLowSignal: true,
        maxLowSignalWords: 120,
        minLowSignalWords: 120,
        meanLowSignalWords: 120,
        bestLowSignalScore: 20,
        maxLowSignalLinkDensity: 0.3,
        meanLowSignalLinkDensity: 0.3
      });
      mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
      mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
        maxDetailUrls: 12,
        minRelevanceScore: 0.05,
        requireSameDomain: true,
        allowExternalLinks: true
      });

      await expect(service.runTask("task-1", "org-1")).rejects.toThrow(
        "no detail candidate URLs were extracted"
      );

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(1);
      expect(mockResultService.persistResults).not.toHaveBeenCalled();
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "expansion", status: "failed" })
      );
    });

    it("fails when detail expansion cannot produce richer content for all-low-signal pages", async () => {
      const task = createMockTask({
        targetUrl: "https://jp.reuters.com/world/"
      });

      const listMarkdown =
        "# ワールド\n" +
        Array.from({ length: 14 }, (_, index) =>
          "- [記事" + index + "](https://jp.reuters.com/world/us/ARTICLE" + index + "-2026-02-06/)"
        ).join("\n");

      const initialResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://jp.reuters.com/world/",
            markdown: listMarkdown,
            success: true,
            metadata: {}
          }
        ]
      });

      const expansionResponse = createMockCrawlResponse({
        runId: "run-expansion",
        results: [
          {
            url: "https://jp.reuters.com/world/us/ARTICLE0-2026-02-06/",
            markdown: listMarkdown,
            success: true,
            metadata: {}
          }
        ]
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValueOnce(initialResponse)
        .mockResolvedValue(expansionResponse);
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : ""
      }));
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
              isListLike: true
            },
            linkInventory: 14
          }
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
              isListLike: true
            },
            linkInventory: 14
          }
        ],
        allLowSignal: true,
        maxLowSignalWords: 180,
        minLowSignalWords: 180,
        meanLowSignalWords: 180,
        bestLowSignalScore: 30,
        maxLowSignalLinkDensity: 0.18,
        meanLowSignalLinkDensity: 0.18
      });
      mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
      mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
        maxDetailUrls: 12,
        minRelevanceScore: 0.05,
        requireSameDomain: true,
        allowExternalLinks: true
      });
      mockQualityStrategy.isSignificantDetailImprovement.mockReturnValue(false);

      await expect(service.runTask("task-1", "org-1")).rejects.toThrow(
        "detail expansion did not produce richer article content"
      );

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
      expect(mockResultService.persistResults).not.toHaveBeenCalled();
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "expansion",
          status: "completed",
          message: "Detail expansion did not produce richer markdown"
        })
      );
    });

    it("extracts detail candidates from metadata canonical urls", async () => {
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: ""
      }));

      const instance = service as unknown as {
        extractDetailLinkCandidatesFromArticle: (
          article: Record<string, unknown>,
          requireSameDomain: boolean,
          allowExternalLinks?: boolean
        ) => string[];
      };

      const candidates = instance.extractDetailLinkCandidatesFromArticle(
        {
          url: "https://www.politico.eu/latest/",
          markdown: "## References",
          metadata: {
            canonical: "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal/",
            openGraph: {
              url: "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal/"
            }
          }
        },
        true,
        true
      );

      expect(candidates).toContain(
        "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal"
      );
    });

    it("filters non-detail politico section links from candidate extraction", async () => {
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: ""
      }));

      const instance = service as unknown as {
        extractDetailLinkCandidatesFromArticle: (
          article: Record<string, unknown>,
          requireSameDomain: boolean,
          allowExternalLinks?: boolean
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
              { href: "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal/" },
              { href: "https://www.politico.eu/newsletter/politico-eu-influence/" },
              { href: "https://www.politico.eu/country/greenland/" },
              { href: "https://www.politico.eu/europe-poll-of-polls/european-parliament-election/" },
              { href: "https://www.politico.eu/special-report/danish-presidency-of-the-eu-special-report/" }
            ]
          }
        },
        true,
        false
      );

      expect(candidates).toContain(
        "https://www.politico.eu/article/top-starmer-aide-morgan-mcsweeney-resigns-over-peter-mandelson-scandal"
      );
      expect(candidates).not.toContain("https://www.politico.eu/newsletter/politico-eu-influence");
      expect(candidates).not.toContain("https://www.politico.eu/country/greenland");
      expect(candidates).not.toContain("https://www.politico.eu/europe-poll-of-polls/european-parliament-election");
      expect(candidates).not.toContain(
        "https://www.politico.eu/special-report/danish-presidency-of-the-eu-special-report"
      );
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
            allowExternalLinks: true
          }
        }
      });

      const initialResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://example.com/latest",
            markdown: "## References\n\n[1]: https://example.com/world/a-very-long-article-slug-with-context",
            success: true,
            links: {
              internal: [
                {
                  href: "https://example.com/world/a-very-long-article-slug-with-context"
                }
              ]
            },
            metadata: {
              url: "https://example.com/latest"
            }
          }
        ]
      });

      const expansionResponse = createMockCrawlResponse({
        runId: "expansion-run",
        results: [
          {
            url: "https://example.com/world/a-very-long-article-slug-with-context",
            markdown:
              "# Headline\n\nParagraph one with detailed context and analysis.\n\nParagraph two with additional reporting facts.\n\nParagraph three for stable article body.",
            success: true,
            metadata: {}
          }
        ]
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl
        .mockResolvedValue(expansionResponse)
        .mockResolvedValueOnce(initialResponse);
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: ""
      }));
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0, lastFetchedAt: new Date() });
      mockResultService.isLowSignalMarkdown.mockImplementation((markdown: string) =>
        markdown.trim().toLowerCase().startsWith("## references")
      );

      mockQualityStrategy.resolveQualityProfile.mockReturnValue("quality_first");
      mockQualityStrategy.assessPageSignals.mockImplementation((articles: any[]) => {
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
                  isListLike: true
                },
                linkInventory: 10
              }
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
                  isListLike: true
                },
                linkInventory: 10
              }
            ],
            allLowSignal: true,
            maxLowSignalWords: 120,
            minLowSignalWords: 120,
            meanLowSignalWords: 120,
            bestLowSignalScore: 10,
            maxLowSignalLinkDensity: 0.2,
            meanLowSignalLinkDensity: 0.2
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
                isListLike: false
              },
              linkInventory: 2
            }
          ],
          lowSignalAssessments: [],
          allLowSignal: false,
          maxLowSignalWords: 0,
          minLowSignalWords: 0,
          meanLowSignalWords: 0,
          bestLowSignalScore: Number.NEGATIVE_INFINITY,
          maxLowSignalLinkDensity: 0,
          meanLowSignalLinkDensity: 0
        };
      });
      mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
      mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
        maxDetailUrls: 6,
        minRelevanceScore: 0,
        requireSameDomain: true,
        allowExternalLinks: true
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
        isListLike: false
      });

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl.mock.calls.length).toBeGreaterThan(1);
      expect(mockResultService.persistResults).toHaveBeenCalledWith(
        task,
        expect.arrayContaining([
          expect.objectContaining({
            url: "https://example.com/world/a-very-long-article-slug-with-context"
          })
        ]),
        expect.any(Object),
        expect.anything(),
        expect.anything(),
        undefined
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
                  text: "A very long article slug with context and analysis"
                },
                {
                  href: "https://example.com/business/another-very-long-article-slug-with-context",
                  text: "Another long-form article"
                }
              ]
            }
          }
        ]
      });

      const expansionResponse = createMockCrawlResponse({
        runId: "run-expansion",
        results: [
          {
            url: "https://example.com/world/a-very-long-article-slug-with-context-and-analysis-2026",
            markdown:
              "# Headline\n\nParagraph one with detailed context and analysis.\n\nParagraph two with additional reporting facts.",
            success: true,
            metadata: {}
          }
        ]
      });

      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValueOnce(initialResponse).mockResolvedValue(expansionResponse);
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : "",
        references: "",
        citations: "",
        raw: "",
        fit: ""
      }));
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0, lastFetchedAt: new Date() });
      mockResultService.isLowSignalMarkdown.mockReturnValue(false);

      mockQualityStrategy.resolveQualityProfile.mockReturnValue("quality_first");
      mockQualityStrategy.assessPageSignals.mockImplementation((articles: any[]) => {
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
                  isListLike: true
                },
                linkInventory: 18
              }
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
                  isListLike: true
                },
                linkInventory: 18
              }
            ],
            allLowSignal: true,
            maxLowSignalWords: 140,
            minLowSignalWords: 140,
            meanLowSignalWords: 140,
            bestLowSignalScore: 20,
            maxLowSignalLinkDensity: 0.2,
            meanLowSignalLinkDensity: 0.2
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
          meanLowSignalLinkDensity: 0
        };
      });
      mockQualityStrategy.shouldAutoExpand.mockReturnValue(true);
      mockQualityStrategy.resolveDetailExpansion.mockReturnValue({
        maxDetailUrls: 6,
        minRelevanceScore: 0.85,
        requireSameDomain: true,
        allowExternalLinks: true
      });
      mockQualityStrategy.isSignificantDetailImprovement.mockReturnValue(true);
      mockQualityStrategy.assessArticleMarkdownSignal.mockReturnValue({
        wordCount: 360,
        paragraphCount: 8,
        headingCount: 1,
        linkCount: 2,
        linkDensity: 0.01,
        score: 420,
        isListLike: false
      });

      const result = await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(2);
      const expansionPayload = (mockCrawlClient.crawl as jest.Mock).mock.calls[1]?.[0] as any;
      expect(expansionPayload?.urls).toEqual(
        expect.arrayContaining([
          "https://example.com/world/a-very-long-article-slug-with-context-and-analysis-2026"
        ])
      );
      expect(result.inserted).toBe(1);
    });

  describe("runTask error handling", () => {
    it("fails fast when task config enables crawl-stage llm extraction", async () => {
      const config = {
        markdownStrategy: {
          type: "LLMExtractionStrategy"
        }
      };
      const task = createMockTask({ config });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);

      await expect(service.runTask("task-1", "org-1")).rejects.toThrow(
        "crawl stage must only fetch and store cleaned markdown"
      );

      expect(mockCrawlClient.crawl).not.toHaveBeenCalled();
      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" })
        })
      );
    });

    it("marks Crawl4aiRequestException with 429 as retryable", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(new Crawl4aiRequestException("Rate limited", 429));

      await expect(
        service.runTask("task-1", "org-1", undefined, { attempt: 1, maxAttempts: 3, backoffDelayMs: 1000 })
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "queued" })
        })
      );
    });

    it("marks Crawl4aiRequestException with 500 as retryable", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(new Crawl4aiRequestException("Server error", 500));

      await expect(
        service.runTask("task-1", "org-1", undefined, { attempt: 1, maxAttempts: 3, backoffDelayMs: 1000 })
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "queued" })
        })
      );
    });

    it("marks Crawl4aiRequestException with 400 as non-retryable", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(new Crawl4aiRequestException("Bad request", 400));

      await expect(
        service.runTask("task-1", "org-1", undefined, { attempt: 1, maxAttempts: 3 })
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" })
        })
      );
    });

    it("does not retry when attempt >= maxAttempts", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(new Crawl4aiRequestException("Rate limited", 429));

      await expect(
        service.runTask("task-1", "org-1", undefined, { attempt: 3, maxAttempts: 3 })
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockPrisma.crawlTask.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" })
        })
      );
    });

    it("does not send notification when shouldRetry is true", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(new Crawl4aiRequestException("Rate limited", 429));

      await expect(
        service.runTask("task-1", "org-1", "user-1", { attempt: 1, maxAttempts: 3, backoffDelayMs: 1000 })
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockNotifications.notify).not.toHaveBeenCalled();
    });

    it("sends failure notification when shouldRetry is false", async () => {
      const task = createMockTask();
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockRejectedValue(new Crawl4aiRequestException("Bad request", 400));
      mockNotifications.notify.mockResolvedValue(undefined);

      await expect(
        service.runTask("task-1", "org-1", "user-1", { attempt: 1, maxAttempts: 3 })
      ).rejects.toThrow(Crawl4aiRequestException);

      expect(mockNotifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.crawl_failed
        })
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
      expect(result.useManagedBrowser).toBe(false);
      expect(result.simulateUser).toBe(false);
      expect(result.overrideNavigator).toBe(false);
      expect(result.excludeExternalLinks).toBe(true);
      expect(result.removeOverlayElements).toBe(true);
      expect(result.processIframes).toBe(true);
      expect(result.textMode).toBe(false);
      expect(result.captureScreenshot).toBe(false);
      expect(result.wordCountThreshold).toBe(80);
    });

    it("applies quality-first markdown defaults for RAG readiness", () => {
      const result = service.normalizeOptions();

      expect(result.qualityProfile).toBe("quality_first");
      expect(result.markdownOptions).toEqual(
        expect.objectContaining({
          contentSource: "cleaned_html",
          citations: true
        })
      );
      expect(result.cleanMarkdown).toEqual(
        expect.objectContaining({
          removeOverlayElements: true,
          wordCountThreshold: 18
        })
      );
      expect(result.cleanMarkdown?.excludedTags).toEqual(
        expect.arrayContaining(["nav", "footer", "aside", "script", "style", "noscript", "form"])
      );
    });

    it("uses raw_html markdown source for speed_first profile", () => {
      const result = service.normalizeOptions({ qualityProfile: "speed_first" });

      expect(result.markdownOptions).toEqual(
        expect.objectContaining({
          contentSource: "raw_html",
          citations: true
        })
      );
      expect(result.cleanMarkdown).toEqual(
        expect.objectContaining({
          removeOverlayElements: true,
          wordCountThreshold: 12
        })
      );
    });

    it("keeps headless when provided", () => {
      expect(service.normalizeOptions({ headless: true }).headless).toBe(true);
      expect(service.normalizeOptions({ headless: false }).headless).toBe(false);
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
      expect(service.normalizeOptions({ scanFullPage: true, scrollDelayMs: -100 }).scrollDelayMs).toBe(0);
      expect(service.normalizeOptions({ scanFullPage: true, scrollDelayMs: 10000 }).scrollDelayMs).toBe(5000);
      expect(service.normalizeOptions({ scanFullPage: true, scrollDelayMs: 500 }).scrollDelayMs).toBe(500);
    });

    it("sets scrollDelayMs to 200 when NaN", () => {
      const result = service.normalizeOptions({ scanFullPage: true, scrollDelayMs: NaN });
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
      const result = service.normalizeOptions({ scanFullPage: true, adjustViewportToContent: false });

      expect(result.scanFullPage).toBe(true);
      expect(result.adjustViewportToContent).toBe(false);
    });

    it("sets simulateUser and overrideNavigator to true when enableStealthMode is true", () => {
      const result = service.normalizeOptions({ enableStealthMode: true });

      expect(result.simulateUser).toBe(true);
      expect(result.overrideNavigator).toBe(true);
    });

    it("sets useManagedBrowser to true when userDataDir is provided", () => {
      const result = service.normalizeOptions({ userDataDir: "/path/to/data" });

      expect(result.useManagedBrowser).toBe(true);
      expect(result.userDataDir).toBe("/path/to/data");
    });

    it("prefers proxyConfig over proxyUrl", () => {
      const result = service.normalizeOptions({
        proxyUrl: "http://proxy.example.com",
        proxyConfig: { server: "http://other-proxy.example.com" }
      });

      expect(result.proxyConfig).toEqual({ server: "http://other-proxy.example.com" });
      expect(result.proxyUrl).toBeUndefined();
    });

    it("deduplicates additionalUrls", () => {
      const result = service.normalizeOptions({
        additionalUrls: ["https://a.com", "https://b.com", "https://a.com"]
      });

      expect(result.additionalUrls).toEqual(["https://a.com", "https://b.com"]);
    });

    it("normalizes markdownOptions with bodyWidth clamping", () => {
      const result = service.normalizeOptions({
        markdownOptions: {
          contentSource: "cleaned_html",
          citations: true,
          bodyWidth: 300
        }
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
          thresholdType: "dynamic"
        }
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
          language: " english "
        } as any
      });

      expect(result.markdownFilter).toEqual(
        expect.objectContaining({
          type: "bm25",
          userQuery: "machine learning",
          bm25Threshold: 1.2,
          language: "english"
        })
      );
    });

    it("deduplicates browserHeaders by name (case-insensitive)", () => {
      const result = service.normalizeOptions({
        browserHeaders: [
          { name: "Authorization", value: "Bearer token1" },
          { name: "authorization", value: "Bearer token2" },
          { name: "X-Custom", value: "value" }
        ]
      });

      expect(result.browserHeaders).toHaveLength(2);
      expect(result.browserHeaders?.[0].name).toBe("Authorization");
    });

    it("deduplicates browserCookies by name+domain+path", () => {
      const result = service.normalizeOptions({
        browserCookies: [
          { name: "session", value: "abc", domain: "example.com", path: "/" },
          { name: "session", value: "xyz", domain: "example.com", path: "/" },
          { name: "session", value: "123", domain: "other.com", path: "/" }
        ]
      });

      expect(result.browserCookies).toHaveLength(2);
    });

    it("normalizes virtualScroll config", () => {
      const result = service.normalizeOptions({
        virtualScroll: {
          containerSelector: ".scroll-container",
          scrollCount: 10,
          scrollBy: "viewport",
          waitAfterScrollMs: 500
        }
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
          longitude: -200
        }
      });

      expect(result.geolocation?.latitude).toBe(90);
      expect(result.geolocation?.longitude).toBe(-180);
    });

    it("clamps wordCountThreshold to 0-5000 range", () => {
      expect(service.normalizeOptions({ wordCountThreshold: -10 }).wordCountThreshold).toBe(0);
      expect(service.normalizeOptions({ wordCountThreshold: 10000 }).wordCountThreshold).toBe(5000);
      expect(service.normalizeOptions({ wordCountThreshold: 100 }).wordCountThreshold).toBe(100);
    });

    it("clamps waitForTimeoutMs to 500-60000 range", () => {
      expect(service.normalizeOptions({ waitForTimeoutMs: 100 }).waitForTimeoutMs).toBe(500);
      expect(service.normalizeOptions({ waitForTimeoutMs: 100000 }).waitForTimeoutMs).toBe(60000);
      expect(service.normalizeOptions({ waitForTimeoutMs: 5000 }).waitForTimeoutMs).toBe(5000);
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
        removeForms: true
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
            matcher: { patterns: ["https://example.com/world/*"], matchMode: "glob" },
            options: {
              waitUntil: "networkidle",
              waitForTimeoutMs: 800,
              pageTimeoutMs: 999999,
              delayBeforeReturnHtmlMs: 35000,
              meanDelayMs: -100,
              maxDelayRangeMs: 13000,
              semaphoreCount: 999,
              removeForms: true
            }
          }
        ]
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
          { url: "https://b.com", markdown: "", success: false, error: "Failed to fetch" }
        ]
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Success" });

      await service.runTask("task-1", "org-1");

      expect(mockResultService.persistResults).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ success: true })]),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined
      );
    });

    it("treats HTTP 4xx with non-empty markdown as failure", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          { url: "https://blocked.com", markdown: "Verification Required", success: true, statusCode: 401 },
          { url: "https://ok.com", markdown: "# Usable content", success: true, statusCode: 200 }
        ]
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : ""
      }));

      await service.runTask("task-1", "org-1");

      const persisted = (mockResultService.persistResults as jest.Mock).mock.calls[0]?.[1] as any[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.url).toBe("https://ok.com");
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          message: "crawl4ai partial failures",
          data: expect.objectContaining({ totalFailures: 1, retryableFailures: 0 })
        })
      );
    });

    it("treats anti-bot challenge markdown as failure even with HTTP 200", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          {
            url: "https://blocked.com",
            markdown: "Verification Required\nPlease enable JS and disable any ad blocker",
            success: true,
            statusCode: 200
          },
          { url: "https://ok.com", markdown: "# Usable content", success: true, statusCode: 200 }
        ]
      });
      const retryResponse = createMockCrawlResponse({
        runId: "run-retry",
        results: [{ url: "https://ok.com", markdown: "# Usable content", success: true, statusCode: 200 }]
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValueOnce(crawlResponse).mockResolvedValueOnce(retryResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockImplementation((markdown: unknown) => ({
        primary: typeof markdown === "string" ? markdown : ""
      }));
      mockResultService.isLikelyBotChallengeMarkdown.mockImplementation((markdown: string) =>
        markdown.toLowerCase().includes("verification required")
      );

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledTimes(2);
      const retryPayload = (mockCrawlClient.crawl as jest.Mock).mock.calls[1]?.[0] as {
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
          waitUntil: "networkidle"
        })
      );

      const persisted = (mockResultService.persistResults as jest.Mock).mock.calls[0]?.[1] as any[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.url).toBe("https://ok.com");
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "anti_bot_retry",
          status: "processing",
          message: "Detected anti-bot challenge; retrying with hardened stealth profile"
        })
      );
      const hasPartialFailureLog = (TaskLogModel.create as jest.Mock).mock.calls.some(
        ([entry]) =>
          Boolean(entry) &&
          (entry as { stage?: string }).stage === "crawler" &&
          (entry as { message?: string }).message === "crawl4ai partial failures"
      );
      expect(hasPartialFailureLog).toBe(false);
    });

    it("logs warnings when present in response", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        warnings: ["Warning 1", "Warning 2"]
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          message: "crawl4ai warnings",
          data: expect.objectContaining({ warnings: ["Warning 1", "Warning 2"] })
        })
      );
    });

    it("logs partial failures when present", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          { url: "https://a.com", markdown: "# Success", success: true },
          { url: "https://b.com", success: false, statusCode: 429, error: "Rate limited" }
        ]
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Success" });

      await service.runTask("task-1", "org-1");

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          message: "crawl4ai partial failures"
        })
      );
    });

    it("identifies retryable status codes correctly", async () => {
      const task = createMockTask();
      const crawlResponse = createMockCrawlResponse({
        results: [
          { url: "https://a.com", success: false, statusCode: 429, error: "Rate limited" },
          { url: "https://b.com", success: false, statusCode: 500, error: "Server error" },
          { url: "https://c.com", success: false, statusCode: 400, error: "Bad request" }
        ]
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(crawlResponse);
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: undefined });

      await expect(service.runTask("task-1", "org-1")).rejects.toThrow("crawl task produced no results");

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "crawler",
          message: "crawl4ai partial failures",
          data: expect.objectContaining({
            totalFailures: 3,
            retryableFailures: 2
          })
        })
      );
    });
  });

  describe("request payload building", () => {
    it("builds URL list starting with baseUrl", async () => {
      const task = createMockTask({ targetUrl: "https://example.com" });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
          urls: expect.arrayContaining(["https://example.com"])
        })
      );
    });

    it("extracts keywords from task.keywords JSON", async () => {
      const task = createMockTask({ keywords: ["keyword1", "keyword2"] });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          keywords: ["keyword1", "keyword2"]
        })
      );
    });

    it("handles null keywords gracefully", async () => {
      const task = createMockTask({ keywords: null });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          keywords: []
        })
      );
    });

    it("includes additionalUrls in URL list", async () => {
    const task = createMockTask({ config: { additionalUrls: ["https://extra1.com", "https://extra2.com"] } });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(mockCrawlClient.crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          urls: expect.arrayContaining(["https://example.com", "https://extra1.com", "https://extra2.com"])
        })
      );
    });

    it("deduplicates URLs in the final list", async () => {
      const task = createMockTask({
        targetUrl: "https://example.com",
        config: { additionalUrls: ["https://example.com", "https://extra.com"] }
      });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 1, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      const crawlCall = mockCrawlClient.crawl.mock.calls[0][0];
      const uniqueUrls = new Set(crawlCall.urls);
      expect(crawlCall.urls.length).toBe(uniqueUrls.size);
    });
  });
});
