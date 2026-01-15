jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    create: jest.fn()
  }
}));

jest.mock("../crawl-config-secrets", () => ({
  decodeCrawlTaskConfigKey: jest.fn(),
  protectCrawlTaskConfigForStorage: jest.fn(),
  revealCrawlTaskConfigForExecution: jest.fn(),
  CrawlTaskConfigEncryptionRequiredError: class CrawlTaskConfigEncryptionRequiredError extends Error {
    override name = "CrawlTaskConfigEncryptionRequiredError";
  }
}));

import { TaskLogModel } from "@modular/mongo";
import { NotificationType } from "@prisma/client";

import {
  decodeCrawlTaskConfigKey,
  protectCrawlTaskConfigForStorage,
  revealCrawlTaskConfigForExecution,
  CrawlTaskConfigEncryptionRequiredError
} from "../crawl-config-secrets";
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
  crawlTaskConfigEncryptionKey: undefined
});

const createMockCrawlClient = () => ({
  crawl: jest.fn()
});

const createMockResultService = () => ({
  persistResults: jest.fn(),
  extractMarkdownResult: jest.fn()
});

const createMockNotificationsService = () => ({
  notify: jest.fn()
});

describe("CrawlExecutionService", () => {
  let service: CrawlExecutionService;
  let mockPrisma: ReturnType<typeof createMockPrismaService>;
  let mockEnv: ReturnType<typeof createMockEnvService>;
  let mockCrawlClient: ReturnType<typeof createMockCrawlClient>;
  let mockResultService: ReturnType<typeof createMockResultService>;
  let mockNotifications: ReturnType<typeof createMockNotificationsService>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockPrisma = createMockPrismaService();
    mockEnv = createMockEnvService();
    mockCrawlClient = createMockCrawlClient();
    mockResultService = createMockResultService();
    mockNotifications = createMockNotificationsService();

    service = new CrawlExecutionService(
      mockPrisma as any,
      mockEnv as any,
      mockCrawlClient as any,
      mockResultService as any,
      mockNotifications as any
    );

    // Default mock implementations
    (decodeCrawlTaskConfigKey as jest.Mock).mockReturnValue(Buffer.alloc(32));
    (protectCrawlTaskConfigForStorage as jest.Mock).mockReturnValue({ config: null, didEncrypt: false });
    (revealCrawlTaskConfigForExecution as jest.Mock).mockReturnValue(null);
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
  });

  describe("runTask error handling", () => {
    it("marks CrawlTaskConfigEncryptionRequiredError as non-retryable", async () => {
      const task = createMockTask({ config: { browserCookies: [] } });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      (protectCrawlTaskConfigForStorage as jest.Mock).mockImplementation(() => {
        throw new CrawlTaskConfigEncryptionRequiredError("Encryption key required");
      });

      await expect(
        service.runTask("task-1", "org-1", undefined, { attempt: 1, maxAttempts: 3 })
      ).rejects.toThrow(CrawlTaskConfigEncryptionRequiredError);

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

      const promise = service.runTask("task-1", "org-1", "user-1", { attempt: 1, maxAttempts: 3 });
      await jest.runAllTimersAsync();
      await expect(promise).rejects.toThrow(Crawl4aiRequestException);

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
          bodyWidth: 300
        }
      });

      expect(result.markdownOptions?.contentSource).toBe("cleaned_html");
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
      expect(result.virtualScroll?.scrollBy).toBe("viewport");
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

    it("sets excludeExternalImages to false when storeMedia is true", () => {
      const result = service.normalizeOptions({ storeMedia: true });
      expect(result.excludeExternalImages).toBe(false);
    });

    it("sets waitForImages to true when storeMedia is true", () => {
      const result = service.normalizeOptions({ storeMedia: true });
      expect(result.waitForImages).toBe(true);
    });
  });

  describe("config encryption flow", () => {
    it("calls decodeCrawlTaskConfigKey with env encryption key", async () => {
      const task = createMockTask({ config: { includeImages: true } });
      mockEnv.crawlTaskConfigEncryptionKey = "test-key-base64";
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(decodeCrawlTaskConfigKey).toHaveBeenCalledWith("test-key-base64");
    });

    it("calls protectCrawlTaskConfigForStorage when config exists", async () => {
      const task = createMockTask({ config: { includeImages: true } });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(protectCrawlTaskConfigForStorage).toHaveBeenCalled();
    });

    it("updates task config when didEncrypt is true", async () => {
      const task = createMockTask({ config: { browserCookies: [{ name: "test", value: "val", domain: "example.com" }] } });
      const encryptedConfig = { browserCookies: { __enc: "crawl-task-config:v1" } };
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });
      (protectCrawlTaskConfigForStorage as jest.Mock).mockReturnValue({
        config: encryptedConfig,
        didEncrypt: true
      });

      await service.runTask("task-1", "org-1");

      expect(mockPrisma.crawlTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ config: expect.anything() })
        })
      );
    });

    it("skips encryption flow when config is null", async () => {
      const task = createMockTask({ config: null });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(protectCrawlTaskConfigForStorage).not.toHaveBeenCalled();
      expect(revealCrawlTaskConfigForExecution).not.toHaveBeenCalled();
    });

    it("skips encryption flow when config is array (invalid)", async () => {
      const task = createMockTask({ config: ["invalid", "array"] });
      mockPrisma.crawlTask.findFirst.mockResolvedValue(task);
      mockPrisma.crawlTask.update.mockResolvedValue(task);
      mockCrawlClient.crawl.mockResolvedValue(createMockCrawlResponse());
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });

      await service.runTask("task-1", "org-1");

      expect(protectCrawlTaskConfigForStorage).not.toHaveBeenCalled();
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
        expect.anything()
      );
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

      await service.runTask("task-1", "org-1");

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
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
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
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
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
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
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
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });
      (revealCrawlTaskConfigForExecution as jest.Mock).mockReturnValue({
        additionalUrls: ["https://extra1.com", "https://extra2.com"]
      });

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
      mockResultService.persistResults.mockResolvedValue({ inserted: 0, skipped: 0 });
      mockResultService.extractMarkdownResult.mockReturnValue({ primary: "# Test" });
      (revealCrawlTaskConfigForExecution as jest.Mock).mockReturnValue({
        additionalUrls: ["https://example.com", "https://extra.com"]
      });

      await service.runTask("task-1", "org-1");

      const crawlCall = mockCrawlClient.crawl.mock.calls[0][0];
      const uniqueUrls = new Set(crawlCall.urls);
      expect(crawlCall.urls.length).toBe(uniqueUrls.size);
    });
  });
});
