/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("@modular/mongo", () => ({
  processedItemHasLocation: jest.fn(
    (result?: { location?: unknown } | null) =>
      typeof result?.location === "string" && result.location.trim().length > 0,
  ),
  ProcessedItemModel: {
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  },
  RawItemModel: {
    findById: jest.fn(),
  },
  TaskLogModel: {
    create: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    ensureTraceId: jest.fn((id?: string) => id ?? "test-trace-id"),
    runWithTraceId: jest.fn(async (_traceId: string, fn: () => Promise<any>) =>
      fn(),
    ),
  };
});

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

jest.mock("bullmq", () => {
  const mockWorkerInstance = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    Worker: jest.fn(() => mockWorkerInstance),
    UnrecoverableError: class UnrecoverableError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "UnrecoverableError";
      }
    },
  };
});

import { ProcessedItemModel, RawItemModel, TaskLogModel } from "@modular/mongo";
import { NotificationPresentationKind } from "@modular/utils";
import { NotificationType, PipelineJobStatus } from "@prisma/client";
import { Worker, UnrecoverableError } from "bullmq";
import { Types } from "mongoose";

import { BULLMQ_DLQ_JOB_RETENTION } from "../../common/bullmq-retention";
import { ItemStatus } from "../../common/pipeline-status";

import { ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";
import {
  QueueErrorKind,
  QueuePermanentError,
  QueueTransientError,
} from "./queue.error-handling";
import { QueueProcessor } from "./queue.processor";

// Test fixtures
const createValidJobData = (overrides: Record<string, unknown> = {}) => ({
  rawItemId: new Types.ObjectId().toHexString(),
  itemMetaId: "meta-123",
  orgId: "org-123",
  traceId: "trace-123",
  processedItemId: new Types.ObjectId().toHexString(),
  pipelineJobId: "pipeline-job-123",
  sourceId: "source-123",
  ...overrides,
});

const createMockJob = (
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  id: "job-123",
  data,
  opts: { attempts: 3 },
  attemptsMade: 0,
  ...overrides,
});

const createMockRawItem = (id: string) => ({
  _id: new Types.ObjectId(id),
  payload: { url: "https://example.com/article", keywords: ["test"] },
  source: "test-source",
});

// Mock factories
const createMockQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: "queued-job-id" }),
  close: jest.fn().mockResolvedValue(undefined),
  opts: {
    connection: {
      host: "localhost",
      port: 6379,
    },
  },
});

const createMockDlqQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: "dlq-job-id" }),
  close: jest.fn().mockResolvedValue(undefined),
});

const createMockEnvService = () => ({
  bullmqConfig: {
    connection: {
      host: "localhost",
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
    },
  },
  newsPipelineEnv: {
    processQueueConcurrency: 5,
  },
  newsSourceSchedulerConfig: {
    circuitBreakerThreshold: 3,
    failureRecoveryDelayMs: 1000,
    failureMaxDelayMs: 60000,
    circuitBreakerBaseDelayMs: 5000,
    circuitBreakerMaxDelayMs: 300000,
  },
});

const createMockPipeline = () => ({
  process: jest.fn().mockResolvedValue({ id: "processed-123" }),
});

const createMockPrisma = () => ({
  itemMeta: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  pipelineJob: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  newsSource: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({
      consecutiveFailures: 0,
      isActive: true,
      orgId: "org-1",
      name: "Source 1",
    }),
    update: jest.fn().mockResolvedValue({}),
  },
  $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => {
    const tx = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({
          consecutiveFailures: 0,
          isActive: true,
          orgId: "org-1",
          name: "Source 1",
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    return cb(tx);
  }),
});

describe("QueueProcessor", () => {
  let processor: QueueProcessor;
  let mockQueue: ReturnType<typeof createMockQueue>;
  let mockDlqQueue: ReturnType<typeof createMockDlqQueue>;
  let mockEnv: ReturnType<typeof createMockEnvService>;
  let mockPipeline: ReturnType<typeof createMockPipeline>;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockNotifications: { notify: jest.Mock };
  let workerCallback: (job: any) => Promise<any>;
  let failedHandler: (job: any, err: Error) => Promise<void>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQueue = createMockQueue();
    mockDlqQueue = createMockDlqQueue();
    mockEnv = createMockEnvService();
    mockPipeline = createMockPipeline();
    mockPrisma = createMockPrisma();
    mockNotifications = { notify: jest.fn().mockResolvedValue(undefined) };

    (RawItemModel.findById as jest.Mock).mockImplementation((id: string) =>
      Promise.resolve(createMockRawItem(id)),
    );

    processor = new QueueProcessor(
      mockQueue as any,
      mockDlqQueue as any,
      mockEnv as any,
      mockPipeline as any,
      mockPrisma as any,
      mockNotifications as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("worker lifecycle", () => {
    it("creates Worker with correct queue name and concurrency on init", async () => {
      await processor.onModuleInit();

      expect(Worker).toHaveBeenCalledWith(
        ITEM_PIPELINE_QUEUE_NAME,
        expect.any(Function),
        expect.objectContaining({
          concurrency: 5,
          connection: expect.objectContaining({
            host: "localhost",
            port: 6379,
          }),
        }),
      );
    });

    it("registers failed event handler on init", async () => {
      await processor.onModuleInit();

      const mockWorkerInstance = (Worker as jest.Mock).mock.results[0].value;
      expect(mockWorkerInstance.on).toHaveBeenCalledWith(
        "failed",
        expect.any(Function),
      );
    });

    it("uses default concurrency of 3 when config is 0", async () => {
      mockEnv.newsPipelineEnv.processQueueConcurrency = 0;

      await processor.onModuleInit();

      expect(Worker).toHaveBeenCalledWith(
        ITEM_PIPELINE_QUEUE_NAME,
        expect.any(Function),
        expect.objectContaining({
          concurrency: 3,
        }),
      );
    });

    it("uses default concurrency of 3 when config is negative", async () => {
      mockEnv.newsPipelineEnv.processQueueConcurrency = -1;

      await processor.onModuleInit();

      expect(Worker).toHaveBeenCalledWith(
        ITEM_PIPELINE_QUEUE_NAME,
        expect.any(Function),
        expect.objectContaining({
          concurrency: 3,
        }),
      );
    });

    it("closes worker, queue, and dlqQueue on destroy", async () => {
      await processor.onModuleInit();
      const mockWorkerInstance = (Worker as jest.Mock).mock.results[0].value;

      await processor.onModuleDestroy();

      expect(mockWorkerInstance.close).toHaveBeenCalled();
      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockDlqQueue.close).toHaveBeenCalled();
    });
  });

  describe("job processing happy path", () => {
    beforeEach(async () => {
      await processor.onModuleInit();
      workerCallback = (Worker as jest.Mock).mock.calls[0][1];
    });

    it("extracts job data correctly from valid job", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({
          rawItemId: jobData.rawItemId,
          itemMetaId: jobData.itemMetaId,
          orgId: jobData.orgId,
          processedItemId: jobData.processedItemId,
          pipelineJobId: jobData.pipelineJobId,
          sourceId: jobData.sourceId,
        }),
        expect.any(Object),
      );
    });

    it("calls markProcessingState with correct parameters", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPrisma.itemMeta.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: jobData.itemMetaId,
          }),
          data: { status: ItemStatus.Processing },
        }),
      );
    });

    it("fetches raw item by rawItemId", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(RawItemModel.findById).toHaveBeenCalledWith(jobData.rawItemId);
    });

    it("calls pipeline.process with correct context and raw item", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: ITEM_PIPELINE_QUEUE_NAME,
          jobId: job.id,
          itemMetaId: jobData.itemMetaId,
          rawItemId: jobData.rawItemId,
          orgId: jobData.orgId,
        }),
        expect.objectContaining({
          id: jobData.rawItemId,
          itemMetaId: jobData.itemMetaId,
          payload: expect.any(Object),
        }),
      );
    });

    it("calls markSuccessState after successful processing", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPrisma.pipelineJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: jobData.pipelineJobId },
          data: expect.objectContaining({
            status: PipelineJobStatus.completed,
          }),
        }),
      );
    });

    it("creates TaskLog with stage=complete on success", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: ITEM_PIPELINE_QUEUE_NAME,
          jobId: job.id,
          orgId: jobData.orgId,
          stage: "complete",
          status: "completed",
        }),
      );
    });

    it("derives processedItemId from rawItemId when not provided", async () => {
      const rawItemId = new Types.ObjectId().toHexString();
      const jobData = createValidJobData({
        rawItemId,
        processedItemId: undefined,
      });
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({
          processedItemId: rawItemId,
        }),
        expect.any(Object),
      );
    });

    it("generates new ObjectId for processedItemId when rawItemId is invalid", async () => {
      const jobData = createValidJobData({
        rawItemId: "invalid-id",
        processedItemId: undefined,
      });
      const job = createMockJob(jobData);

      (RawItemModel.findById as jest.Mock).mockResolvedValueOnce({
        _id: "invalid-id",
        payload: {},
        source: "test",
      });

      await expect(workerCallback(job)).resolves.toEqual({
        id: "processed-123",
      });

      const [pipelineJobArg] =
        (mockPipeline.process as jest.Mock).mock.calls.at(-1) ?? [];
      expect(pipelineJobArg.rawItemId).toBe("invalid-id");
      expect(Types.ObjectId.isValid(pipelineJobArg.processedItemId)).toBe(true);
      expect(pipelineJobArg.processedItemId).not.toBe("invalid-id");
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      await processor.onModuleInit();
      workerCallback = (Worker as jest.Mock).mock.calls[0][1];
    });

    it("throws UnrecoverableError for missing rawItemId", async () => {
      const jobData = createValidJobData({ rawItemId: undefined });
      const job = createMockJob(jobData);

      await expect(workerCallback(job)).rejects.toThrow(UnrecoverableError);
    });

    it("throws UnrecoverableError for missing itemMetaId", async () => {
      const jobData = createValidJobData({ itemMetaId: undefined });
      const job = createMockJob(jobData);

      await expect(workerCallback(job)).rejects.toThrow(UnrecoverableError);
    });

    it("throws UnrecoverableError for missing orgId", async () => {
      const jobData = createValidJobData({ orgId: undefined });
      const job = createMockJob(jobData);

      await expect(workerCallback(job)).rejects.toThrow(UnrecoverableError);
    });

    it("throws UnrecoverableError when raw item not found", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      (RawItemModel.findById as jest.Mock).mockResolvedValueOnce(null);

      await expect(workerCallback(job)).rejects.toThrow(UnrecoverableError);
      expect(TaskLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "dedupe",
          status: "failed",
          message: "Raw item not found",
        }),
      );
    });

    it("re-throws transient errors as-is", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);
      const transientError = new QueueTransientError("Network timeout");

      mockPipeline.process.mockRejectedValueOnce(transientError);

      await expect(workerCallback(job)).rejects.toThrow("Network timeout");
    });

    it("wraps permanent errors in UnrecoverableError", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);
      const permanentError = new QueuePermanentError("Invalid data format");

      mockPipeline.process.mockRejectedValueOnce(permanentError);

      await expect(workerCallback(job)).rejects.toThrow(UnrecoverableError);
    });

    it("preserves error cause on UnrecoverableError", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);
      const permanentError = new QueuePermanentError("Invalid data");

      mockPipeline.process.mockRejectedValueOnce(permanentError);

      try {
        await workerCallback(job);
        fail("Expected error to be thrown");
      } catch (err: any) {
        expect(err.name).toBe("UnrecoverableError");
        expect(err.cause).toBe(permanentError);
      }
    });

    it("converts non-Error objects to Error", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      mockPipeline.process.mockRejectedValueOnce("string error");

      await expect(workerCallback(job)).rejects.toThrow("string error");
    });
  });

  describe("DLQ routing", () => {
    beforeEach(async () => {
      await processor.onModuleInit();
      const mockWorkerInstance = (Worker as jest.Mock).mock.results[0].value;
      failedHandler = mockWorkerInstance.on.mock.calls.find(
        (call: any[]) => call[0] === "failed",
      )[1];
    });

    it("enqueues to DLQ immediately for permanent errors", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, { attemptsMade: 1 });
      const permanentError = new QueuePermanentError("Permanent failure");

      await failedHandler(job, permanentError);

      expect(mockDlqQueue.add).toHaveBeenCalledWith(
        "dlq",
        expect.objectContaining({
          originalQueue: ITEM_PIPELINE_QUEUE_NAME,
          originalJobId: job.id,
          errorKind: QueueErrorKind.Permanent,
        }),
        expect.objectContaining({
          jobId: expect.stringContaining("dlq-"),
          removeOnComplete: BULLMQ_DLQ_JOB_RETENTION,
          removeOnFail: BULLMQ_DLQ_JOB_RETENTION,
          attempts: 1,
        }),
      );
    });

    it("does NOT enqueue to DLQ for transient error with remaining retries", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 1,
        opts: { attempts: 3 },
      });
      const transientError = new QueueTransientError("Temporary failure");

      await failedHandler(job, transientError);

      expect(mockDlqQueue.add).not.toHaveBeenCalled();
    });

    it("enqueues to DLQ when retries exhausted", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });
      const transientError = new QueueTransientError("Temporary failure");

      await failedHandler(job, transientError);

      expect(mockDlqQueue.add).toHaveBeenCalled();
    });

    it("creates DLQ payload with correct structure", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });
      const error = new Error("Test error");

      await failedHandler(job, error);

      expect(mockDlqQueue.add).toHaveBeenCalledWith(
        "dlq",
        expect.objectContaining({
          rawItemId: jobData.rawItemId,
          itemMetaId: jobData.itemMetaId,
          orgId: jobData.orgId,
          originalQueue: ITEM_PIPELINE_QUEUE_NAME,
          originalJobId: job.id,
          failedAt: expect.any(String),
          attempts: 3,
          attemptsMade: 3,
          errorKind: expect.any(String),
          error: expect.any(Object),
        }),
        expect.any(Object),
      );
    });

    it("formats DLQ jobId correctly", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 2,
        opts: { attempts: 2 },
      });
      const error = new Error("Test error");

      await failedHandler(job, error);

      expect(mockDlqQueue.add).toHaveBeenCalledWith(
        "dlq",
        expect.any(Object),
        expect.objectContaining({
          jobId: `dlq-${ITEM_PIPELINE_QUEUE_NAME}-${job.id}-2`,
        }),
      );
    });

    it("logs error but does not throw when DLQ enqueue fails", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });
      const error = new Error("Test error");

      mockDlqQueue.add.mockRejectedValueOnce(new Error("DLQ unavailable"));

      // Should not throw
      await expect(failedHandler(job, error)).resolves.toBeUndefined();
    });

    it("handles null job gracefully", async () => {
      const error = new Error("Test error");

      await expect(failedHandler(null, error)).resolves.toBeUndefined();
      expect(mockDlqQueue.add).not.toHaveBeenCalled();
    });
  });

  describe("state management", () => {
    beforeEach(async () => {
      await processor.onModuleInit();
      workerCallback = (Worker as jest.Mock).mock.calls[0][1];
      const mockWorkerInstance = (Worker as jest.Mock).mock.results[0].value;
      failedHandler = mockWorkerInstance.on.mock.calls.find(
        (call: any[]) => call[0] === "failed",
      )[1];
    });

    it("updates ItemMeta to processing with skipIfDuplicate", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPrisma.itemMeta.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: jobData.itemMetaId,
            status: { not: ItemStatus.Duplicate },
          }),
          data: { status: ItemStatus.Processing },
        }),
      );
    });

    it("upserts ProcessedItem with status=processing", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(ProcessedItemModel.updateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: ItemStatus.Processing,
          }),
          $unset: expect.objectContaining({
            hasLocation: 1,
            summaryEmbeddingDimensions: 1,
          }),
        }),
        { upsert: true },
      );
    });

    it("updates PipelineJob to running when pipelineJobId provided", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPrisma.pipelineJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: jobData.pipelineJobId },
          data: expect.objectContaining({
            status: PipelineJobStatus.running,
            startedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("updates NewsSource.lastRunAt when sourceId provided", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPrisma.newsSource.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: jobData.sourceId },
          data: expect.objectContaining({
            lastRunAt: expect.any(Date),
          }),
        }),
      );
    });

    it("updates PipelineJob to completed on success", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      const completedCall = mockPrisma.pipelineJob.updateMany.mock.calls.find(
        (call: any[]) => call[0].data.status === PipelineJobStatus.completed,
      );
      expect(completedCall).toBeDefined();
    });

    it("resets NewsSource consecutiveFailures on success", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData);

      await workerCallback(job);

      expect(mockPrisma.newsSource.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: jobData.sourceId },
          data: expect.objectContaining({
            consecutiveFailures: 0,
            circuitOpenUntil: null,
          }),
        }),
      );
    });

    it("updates ItemMeta to failed only on finalFailure", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });
      const error = new Error("Test error");

      await failedHandler(job, error);

      expect(mockPrisma.itemMeta.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ItemStatus.Failed },
        }),
      );
    });

    it("does NOT update ItemMeta to failed when retries remain", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 1,
        opts: { attempts: 3 },
      });
      const error = new QueueTransientError("Temporary failure");

      await failedHandler(job, error);

      const failedCall = mockPrisma.itemMeta.updateMany.mock.calls.find(
        (call: any[]) => call[0].data.status === ItemStatus.Failed,
      );
      expect(failedCall).toBeUndefined();
    });

    it("upserts ProcessedItem with error details on failure", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });
      const error = new Error("Test error message");

      await failedHandler(job, error);

      expect(ProcessedItemModel.updateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: ItemStatus.Failed,
            error: expect.objectContaining({
              message: "Test error message",
            }),
          }),
          $unset: expect.objectContaining({
            summaryEmbeddingDimensions: 1,
          }),
        }),
        { upsert: true },
      );
    });

    it("increments consecutiveFailures on source failure", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });
      const error = new Error("Test error");

      await failedHandler(job, error);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("opens circuit breaker when threshold reached", async () => {
      const jobData = createValidJobData();
      const job = createMockJob(jobData, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });
      const error = new Error("Test error");

      mockPrisma.$transaction.mockImplementationOnce(
        async (cb: (tx: any) => Promise<any>) => {
          const tx = {
            newsSource: {
              findUnique: jest.fn().mockResolvedValue({
                consecutiveFailures: 2,
                isActive: true,
                orgId: "org-1",
                name: "Source 1",
              }),
              update: jest.fn().mockResolvedValue({}),
            },
          };
          return cb(tx);
        },
      );

      await failedHandler(job, error);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockNotifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.system,
          data: expect.objectContaining({
            sourceId: jobData.sourceId,
            sourceName: "Source 1",
            presentation: expect.objectContaining({
              kind: NotificationPresentationKind.NewsSourceCircuitOpened,
              params: expect.objectContaining({
                sourceId: jobData.sourceId,
                sourceName: "Source 1",
                consecutiveFailures: 3,
              }),
            }),
          }),
        }),
      );
    });
  });

  describe("mocks isolation", () => {
    it("clears all mocks between tests", () => {
      expect(RawItemModel.findById).not.toHaveBeenCalled();
      expect(TaskLogModel.create).not.toHaveBeenCalled();
      expect(ProcessedItemModel.updateOne).not.toHaveBeenCalled();
    });

    it("fixtures match actual job data structure", () => {
      const jobData = createValidJobData();

      expect(jobData).toHaveProperty("rawItemId");
      expect(jobData).toHaveProperty("itemMetaId");
      expect(jobData).toHaveProperty("orgId");
      expect(typeof jobData.rawItemId).toBe("string");
      expect(Types.ObjectId.isValid(jobData.rawItemId)).toBe(true);
    });
  });
});
