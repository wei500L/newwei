import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  Queue,
  QueueEvents,
  Worker,
  UnrecoverableError,
  type BackoffOptions,
} from "bullmq";

import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { CrawlActivityService } from "./crawl-activity.service";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CrawlFrontierService } from "./crawl-frontier.service";
import { CrawlSettingsService } from "./crawl-settings.service";
import {
  CRAWL_QUEUE_EVENTS_LEGACY,
  CRAWL_QUEUE_EVENTS_HOT,
  CRAWL_QUEUE_EVENTS_NORMAL,
  CRAWL_QUEUE_HOT,
  CRAWL_QUEUE_HOT_NAME,
  CRAWL_QUEUE_LLM_JUDGE,
  CRAWL_QUEUE_LLM_JUDGE_NAME,
  CRAWL_QUEUE_LLM_LEARN,
  CRAWL_QUEUE_LLM_LEARN_NAME,
  CRAWL_QUEUE_LEGACY,
  CRAWL_QUEUE_NAME,
  CRAWL_QUEUE_NORMAL,
  CRAWL_QUEUE_NORMAL_NAME,
} from "./crawl.constants";
import type { CrawlJobData, CrawlPriorityClass } from "./crawl.types";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import { NewsSourceOpsSnapshotService } from "./news-source-ops-snapshot.service";

const logger = createLogger({ name: "crawl-queue" });
const RETRYABLE_STATUS_CODES = new Set([
  408, 423, 425, 429, 500, 502, 503, 504,
]);
const MAX_ERROR_TEXT = 4000;
const MYSQL_VARCHAR_191 = 191;
const MEMORY_PRESSURE_COOLDOWN_MIN_MS = 5_000;
const MEMORY_PRESSURE_COOLDOWN_MAX_MS = 10 * 60 * 1000;
const MEMORY_PRESSURE_DEFAULT_COOLDOWN_MS = 30_000;
const MEMORY_PRESSURE_PERCENT_PATTERN = /memory\s+at\s+(\d+(?:\.\d+)?)%/i;

const RETRYABLE_MESSAGE_HINTS = [
  "timeout",
  "temporarily",
  "rate limit",
  "connection reset",
  "connection refused",
];
const MEMORY_PRESSURE_HINTS = [
  "refusing new browser",
  "memory at",
  "insufficient memory",
  "out of memory",
  "not enough memory",
  "cannot allocate memory",
];

interface QueueEventBinding {
  events: QueueEvents;
  onStalled: ({ jobId }: { jobId: string }) => Promise<void>;
  onCompleted: ({ jobId }: { jobId: string }) => Promise<void>;
  onFailed: ({
    jobId,
    failedReason,
  }: {
    jobId: string;
    failedReason?: string;
  }) => Promise<void>;
}

interface QueueRuntimeContext {
  queueClass: CrawlPriorityClass;
  queueName: string;
  queue: Queue<CrawlJobData>;
  events: QueueEvents;
}

interface WorkerRuntimeContext {
  queueClass: CrawlPriorityClass;
  queueName: string;
  worker: Worker<CrawlJobData>;
}

type ConcurrencySlotReleaser = () => void;

interface ConcurrencyWaiter {
  resolve: (release: ConcurrencySlotReleaser) => void;
  reject: (error: Error) => void;
}

class SharedGlobalConcurrencyLimiter {
  private capacity: number;
  private active = 0;
  private closed = false;
  private readonly waiters: Record<CrawlPriorityClass, ConcurrencyWaiter[]> = {
    hot: [],
    normal: [],
  };

  constructor(initialCapacity: number) {
    this.capacity = Math.max(1, Math.round(initialCapacity));
  }

  setCapacity(next: number) {
    this.capacity = Math.max(1, Math.round(next));
    this.drain();
  }

  async acquire(
    queueClass: CrawlPriorityClass,
  ): Promise<ConcurrencySlotReleaser> {
    if (this.closed) {
      throw new Error("Global crawl concurrency limiter is closed");
    }

    const immediate = this.tryAcquire(queueClass);
    if (immediate) {
      return immediate;
    }

    return new Promise<ConcurrencySlotReleaser>((resolve, reject) => {
      this.waiters[queueClass].push({ resolve, reject });
    });
  }

  close() {
    this.closed = true;
    const error = new Error(
      "Global crawl concurrency limiter is shutting down",
    );
    const waiters = [...this.waiters.hot, ...this.waiters.normal];
    this.waiters.hot = [];
    this.waiters.normal = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private tryAcquire(
    queueClass: CrawlPriorityClass,
  ): ConcurrencySlotReleaser | null {
    if (this.active >= this.capacity) {
      return null;
    }
    if (queueClass === "normal" && this.waiters.hot.length > 0) {
      return null;
    }
    this.active += 1;
    return this.createReleaser();
  }

  private createReleaser(): ConcurrencySlotReleaser {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain() {
    while (this.active < this.capacity) {
      const next = this.waiters.hot.shift() ?? this.waiters.normal.shift();
      if (!next) {
        break;
      }
      this.active += 1;
      next.resolve(this.createReleaser());
    }
  }
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function resolveBackoffDelayMs(
  backoff: number | BackoffOptions | undefined,
  attempt: number,
): number | null {
  if (!backoff) {
    return null;
  }
  if (typeof backoff === "number") {
    return Number.isFinite(backoff) ? Math.max(0, Math.round(backoff)) : null;
  }
  const delay = typeof backoff.delay === "number" ? backoff.delay : null;
  if (delay === null || !Number.isFinite(delay)) {
    return null;
  }
  const normalizedDelay = Math.max(0, Math.round(delay));
  if (backoff.type === "exponential") {
    const exponent = Math.max(0, attempt - 1);
    return Math.round(normalizedDelay * 2 ** exponent);
  }
  return normalizedDelay;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Crawl4aiRequestException) {
    if (error.status && RETRYABLE_STATUS_CODES.has(error.status)) {
      return true;
    }
    const normalized = error.message.toLowerCase();
    return RETRYABLE_MESSAGE_HINTS.some((needle) =>
      normalized.includes(needle),
    );
  }
  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    return RETRYABLE_MESSAGE_HINTS.some((needle) =>
      normalized.includes(needle),
    );
  }
  return false;
}

function extractErrorText(error: unknown): string {
  if (!error) {
    return "";
  }

  const parts = new Set<string>();
  const addPart = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      parts.add(trimmed);
    }
  };

  if (error instanceof Error) {
    addPart(error.message);
  }

  if (typeof error === "object") {
    const axiosLike = error as {
      message?: unknown;
      response?: { data?: unknown };
    };
    addPart(axiosLike.message);
    const responseData = axiosLike.response?.data;
    if (typeof responseData === "string") {
      addPart(responseData);
    } else if (
      responseData &&
      typeof responseData === "object" &&
      !Array.isArray(responseData)
    ) {
      const record = responseData as Record<string, unknown>;
      addPart(record.message);
      addPart(record.detail);
      addPart(record.error);
      const nestedError = record.error;
      if (
        nestedError &&
        typeof nestedError === "object" &&
        !Array.isArray(nestedError)
      ) {
        const nestedRecord = nestedError as Record<string, unknown>;
        addPart(nestedRecord.message);
        addPart(nestedRecord.detail);
        addPart(nestedRecord.error);
      }
    }
  }

  return Array.from(parts).join("\n").toLowerCase();
}

function extractMemoryPressurePercent(error: unknown): number | null {
  const message = extractErrorText(error);
  if (!message) {
    return null;
  }
  const match = message.match(MEMORY_PRESSURE_PERCENT_PATTERN);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, parsed));
}

function isMemoryPressureError(error: unknown): boolean {
  const normalized = extractErrorText(error);
  if (!normalized) {
    return false;
  }
  if (
    normalized.includes("memory") &&
    normalized.includes("refusing") &&
    normalized.includes("browser")
  ) {
    return true;
  }
  return MEMORY_PRESSURE_HINTS.some((needle) => normalized.includes(needle));
}

function resolveQueueOverloadCooldownMs(
  configured: unknown,
  memoryPercent: number | null,
): number {
  const fallback =
    typeof configured === "number" && Number.isFinite(configured)
      ? Math.round(configured)
      : MEMORY_PRESSURE_DEFAULT_COOLDOWN_MS;
  const baseDelayMs = Math.max(
    MEMORY_PRESSURE_COOLDOWN_MIN_MS,
    Math.min(MEMORY_PRESSURE_COOLDOWN_MAX_MS, fallback),
  );

  let multiplier = 1;
  if (typeof memoryPercent === "number") {
    if (memoryPercent >= 98) {
      multiplier = 4;
    } else if (memoryPercent >= 96) {
      multiplier = 3;
    } else if (memoryPercent >= 94) {
      multiplier = 2;
    }
  }

  return Math.max(
    MEMORY_PRESSURE_COOLDOWN_MIN_MS,
    Math.min(
      MEMORY_PRESSURE_COOLDOWN_MAX_MS,
      Math.round(baseDelayMs * multiplier),
    ),
  );
}

function resolveManualLimiterMax(concurrency: number): number {
  return Math.max(1, Math.min(10_000, Math.round(concurrency) * 100));
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.round(value));
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function resolveInitialWorkerConcurrency(
  configured: unknown,
  fallback: unknown,
): number {
  const normalizedConfigured = normalizePositiveInteger(configured);
  if (normalizedConfigured !== null) {
    return normalizedConfigured;
  }
  return normalizePositiveInteger(fallback) ?? 1;
}

function resolveMaxAttempts(value: unknown): number {
  return normalizePositiveInteger(value) ?? 1;
}

function resolveAttemptsStarted(job: {
  attemptsMade?: number;
  attemptsStarted?: unknown;
}): number {
  const attemptsStarted = normalizePositiveInteger(job.attemptsStarted);
  if (attemptsStarted !== null) {
    return attemptsStarted;
  }
  if (
    typeof job.attemptsMade === "number" &&
    Number.isFinite(job.attemptsMade)
  ) {
    return Math.max(1, Math.floor(job.attemptsMade) + 1);
  }
  return 1;
}

function resolveMemoryPressureRequeues(job: {
  data?: { memoryPressureRequeues?: unknown };
}): number {
  return normalizeNonNegativeInteger(job.data?.memoryPressureRequeues) ?? 0;
}

async function persistMemoryPressureRequeueCount(
  job: {
    data?: CrawlJobData;
    attemptsStarted?: unknown;
    updateData?: (data: CrawlJobData) => Promise<unknown>;
  },
  nextRequeues: number,
) {
  if (!job.data) {
    throw new Error("Crawl job payload is missing; cannot persist retry state");
  }

  const nextData: CrawlJobData = {
    ...job.data,
    memoryPressureRequeues: nextRequeues,
  };

  if (typeof job.updateData === "function") {
    await job.updateData(nextData);
    return;
  }

  // Without updateData(), the counter cannot persist across retries.
  // If attemptsStarted is unavailable, we cannot enforce a bounded requeue budget safely.
  if (normalizePositiveInteger(job.attemptsStarted) !== null) {
    return;
  }

  throw new Error(
    "Cannot persist memory pressure retry state for crawl job (missing updateData and attemptsStarted)",
  );
}

interface QueueWithGlobalConcurrencyApi {
  setGlobalConcurrency?: (concurrency: number) => Promise<void>;
}

@Injectable()
export class CrawlQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly workers: WorkerRuntimeContext[] = [];
  private readonly llmWorkers: Worker<CrawlJobData>[] = [];
  private readonly queueEventBindings: QueueEventBinding[] = [];
  private readonly globalConcurrencyLimiter =
    new SharedGlobalConcurrencyLimiter(1);

  constructor(
    private readonly env: EnvService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly activity: CrawlActivityService,
    private readonly crawlExecutionService: CrawlExecutionService,
    private readonly crawlFrontierService: CrawlFrontierService,
    private readonly prisma: PrismaService,
    @Inject(CRAWL_QUEUE_LEGACY)
    private readonly legacyQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_HOT) private readonly hotQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_NORMAL)
    private readonly normalQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_LLM_JUDGE)
    private readonly llmJudgeQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_LLM_LEARN)
    private readonly llmLearnQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_EVENTS_LEGACY)
    private readonly legacyEvents: QueueEvents,
    @Inject(CRAWL_QUEUE_EVENTS_HOT) private readonly hotEvents: QueueEvents,
    @Inject(CRAWL_QUEUE_EVENTS_NORMAL)
    private readonly normalEvents: QueueEvents,
    @Optional()
    private readonly newsSourceOpsSnapshots?: NewsSourceOpsSnapshotService,
  ) {}

  private queueContexts(includeLegacy = true): QueueRuntimeContext[] {
    const contexts: QueueRuntimeContext[] = [
      {
        queueClass: "hot",
        queueName: CRAWL_QUEUE_HOT_NAME,
        queue: this.hotQueue,
        events: this.hotEvents,
      },
      {
        queueClass: "normal",
        queueName: CRAWL_QUEUE_NORMAL_NAME,
        queue: this.normalQueue,
        events: this.normalEvents,
      },
    ];
    if (includeLegacy) {
      contexts.splice(1, 0, {
        queueClass: "normal",
        queueName: CRAWL_QUEUE_NAME,
        queue: this.legacyQueue,
        events: this.legacyEvents,
      });
    }
    return contexts;
  }

  async onModuleInit() {
    let configuredConcurrency = Math.max(
      1,
      Math.round(this.env.crawl4aiConfig.maxConcurrency ?? 1),
    );
    try {
      const settings = await this.crawlSettings.getSettings();
      configuredConcurrency = Math.max(1, Math.round(settings.maxConcurrency));
      await this.applyGlobalConcurrency(configuredConcurrency);
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to apply configured crawl queue global concurrency; using worker-local concurrency fallback",
      );
    }

    const concurrency = resolveInitialWorkerConcurrency(
      configuredConcurrency,
      this.env.crawl4aiConfig.maxConcurrency ?? 1,
    );
    this.globalConcurrencyLimiter.setCapacity(concurrency);

    const includeLegacy = await this.shouldStartLegacyWorker();
    for (const context of this.queueContexts(includeLegacy)) {
      const worker = this.createWorker(context, concurrency);
      this.workers.push({
        queueClass: context.queueClass,
        queueName: context.queueName,
        worker,
      });
      this.registerQueueEvents(context);
    }

    this.llmWorkers.push(
      this.createLlmWorker(CRAWL_QUEUE_LLM_JUDGE_NAME, this.llmJudgeQueue),
      this.createLlmWorker(CRAWL_QUEUE_LLM_LEARN_NAME, this.llmLearnQueue),
    );
  }

  private createWorker(
    context: QueueRuntimeContext,
    concurrency: number,
  ): Worker<CrawlJobData> {
    const worker = new Worker<CrawlJobData>(
      context.queueName,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          logger.info(
            {
              queue: context.queueName,
              jobId: job.id,
              taskId: job.data.taskId,
            },
            "Processing crawl job",
          );
          const releaseConcurrency =
            await this.globalConcurrencyLimiter.acquire(context.queueClass);
          try {
            const maxAttempts = resolveMaxAttempts(job.opts?.attempts);
            const attemptsStarted = resolveAttemptsStarted(job);
            const attempt = Math.min(maxAttempts, attemptsStarted);
            const backoffDelayMs = resolveBackoffDelayMs(
              job.opts?.backoff,
              attempt,
            );
            const requestTimeoutMs = await this.resolveQueueTimeoutMs(
              context.queueClass,
            );
            try {
              if (
                job.data.jobKind === "frontier_node" &&
                typeof job.data.frontierNodeId === "string" &&
                job.data.frontierNodeId.length > 0
              ) {
                return await this.crawlFrontierService.processQueuedNode(
                  job.data.frontierNodeId,
                  job.data.orgId,
                  requestTimeoutMs,
                );
              }
              return await this.crawlExecutionService.runTask(
                job.data.taskId,
                job.data.orgId,
                job.data.triggeredById,
                {
                  attempt,
                  maxAttempts,
                  backoffDelayMs,
                  priorityClass: context.queueClass,
                  requestTimeoutMs,
                },
              );
            } catch (error) {
              if (isMemoryPressureError(error)) {
                const memoryPressureRequeues =
                  resolveMemoryPressureRequeues(job);
                if (
                  attemptsStarted >= maxAttempts ||
                  memoryPressureRequeues >= maxAttempts - 1
                ) {
                  logger.warn(
                    {
                      queue: context.queueName,
                      jobId: job.id,
                      taskId: job.data.taskId,
                      attemptsStarted,
                      maxAttempts,
                      memoryPressureRequeues,
                    },
                    "crawl4ai memory pressure retry budget exhausted; failing job as unrecoverable",
                  );
                  const unrecoverable = new UnrecoverableError(
                    error instanceof Error ? error.message : String(error),
                  );
                  (unrecoverable as Error & { cause?: unknown }).cause = error;
                  throw unrecoverable;
                }

                let configuredCooldownMs: number =
                  MEMORY_PRESSURE_DEFAULT_COOLDOWN_MS;
                try {
                  const settings = await this.crawlSettings.getSettings();
                  configuredCooldownMs = settings.queueOverloadCooldownMs;
                } catch (settingsError) {
                  logger.warn(
                    { err: settingsError },
                    "Failed to load crawl settings for memory pressure cooldown; using default",
                  );
                }

                const memoryPercent = extractMemoryPressurePercent(error);
                const cooldownMs = resolveQueueOverloadCooldownMs(
                  configuredCooldownMs,
                  memoryPercent,
                );

                try {
                  await this.rateLimitAllWorkers(cooldownMs, {
                    queueClass: context.queueClass,
                    queueName: context.queueName,
                    worker,
                  });
                } catch (rateLimitError) {
                  logger.error(
                    {
                      queue: context.queueName,
                      jobId: job.id,
                      taskId: job.data.taskId,
                      cooldownMs,
                      err: rateLimitError,
                    },
                    "Failed to apply crawl queue rate limit during memory pressure fallback",
                  );
                  throw error;
                }

                const nextMemoryPressureRequeues = memoryPressureRequeues + 1;
                try {
                  await persistMemoryPressureRequeueCount(
                    job,
                    nextMemoryPressureRequeues,
                  );
                } catch (persistError) {
                  logger.error(
                    {
                      queue: context.queueName,
                      jobId: job.id,
                      taskId: job.data.taskId,
                      nextMemoryPressureRequeues,
                      maxAttempts,
                      err: persistError,
                    },
                    "Failed to persist memory pressure retry state; failing crawl job as unrecoverable",
                  );
                  const unrecoverable = new UnrecoverableError(
                    error instanceof Error ? error.message : String(error),
                  );
                  (unrecoverable as Error & { cause?: unknown }).cause = error;
                  throw unrecoverable;
                }

                logger.warn(
                  {
                    queue: context.queueName,
                    jobId: job.id,
                    taskId: job.data.taskId,
                    cooldownMs,
                    memoryPercent,
                    memoryPressureRequeues: nextMemoryPressureRequeues,
                    maxAttempts,
                    error:
                      error instanceof Error
                        ? truncateText(error.message, 500)
                        : truncateText(String(error), 500),
                  },
                  "crawl4ai memory pressure detected; re-queueing job with queue-wide cooldown",
                );

                throw Worker.RateLimitError();
              }

              if (!isRetryableError(error)) {
                const unrecoverable = new UnrecoverableError(
                  error instanceof Error ? error.message : String(error),
                );
                (unrecoverable as Error & { cause?: unknown }).cause = error;
                throw unrecoverable;
              }
              throw error;
            }
          } finally {
            releaseConcurrency();
          }
        });
      },
      {
        connection: context.queue.opts.connection,
        concurrency,
        limiter: {
          max: resolveManualLimiterMax(concurrency),
          duration: 1000,
        },
      },
    );

    worker.on("failed", (job, error) => {
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () =>
          logger.error(
            { queue: context.queueName, jobId: job?.id, error },
            "Crawl queue worker error",
          ),
        );
      } else {
        logger.error(
          { queue: context.queueName, jobId: job?.id, error },
          "Crawl queue worker error",
        );
      }
    });

    return worker;
  }

  private createLlmWorker(
    queueName: string,
    queue: Queue<CrawlJobData>,
  ): Worker<CrawlJobData> {
    const worker = new Worker<CrawlJobData>(
      queueName,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          logger.info(
            { queue: queueName, jobId: job.id, jobKind: job.data.jobKind },
            "Processing frontier LLM job",
          );

          if (
            job.data.jobKind === "frontier_llm_judge" &&
            job.data.frontierLlmJudge
          ) {
            return this.crawlFrontierService.processQueuedLlmJudge(
              job.data.orgId,
              job.data.frontierLlmJudge,
            );
          }

          if (
            job.data.jobKind === "frontier_llm_learn" &&
            job.data.frontierLlmLearn
          ) {
            return this.crawlFrontierService.processQueuedLlmLearn(
              job.data.orgId,
              job.data.frontierLlmLearn,
            );
          }

          return { inserted: 0, skipped: 0 };
        });
      },
      {
        connection: queue.opts.connection,
        concurrency: 1,
        limiter: {
          max: 1,
          duration: 1000,
        },
      },
    );

    worker.on("failed", (job, error) => {
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () =>
          logger.error(
            { queue: queueName, jobId: job?.id, error },
            "Frontier LLM worker error",
          ),
        );
      } else {
        logger.error(
          { queue: queueName, jobId: job?.id, error },
          "Frontier LLM worker error",
        );
      }
    });

    return worker;
  }

  private async rateLimitAllWorkers(
    cooldownMs: number,
    currentWorker?: WorkerRuntimeContext,
  ) {
    const runtimeWorkers = [...this.workers];
    if (
      currentWorker &&
      !runtimeWorkers.some((entry) => entry.worker === currentWorker.worker)
    ) {
      runtimeWorkers.push(currentWorker);
    }

    const failedQueues: string[] = [];
    await Promise.all(
      runtimeWorkers.map(async ({ queueName, worker }) => {
        try {
          await worker.rateLimit(cooldownMs);
        } catch (error) {
          failedQueues.push(queueName);
          logger.error(
            { queue: queueName, cooldownMs, err: error },
            "Failed to apply crawl queue rate limit",
          );
        }
      }),
    );

    if (failedQueues.length > 0) {
      throw new Error(
        `Failed to apply crawl queue rate limit to queues: ${failedQueues.join(",")}`,
      );
    }
  }

  private registerQueueEvents(context: QueueRuntimeContext) {
    const onStalled = async ({ jobId }: { jobId: string }) => {
      try {
        const job = await context.queue.getJob(jobId);
        if (!job?.data?.taskId || !job.data.orgId) {
          logger.warn(
            { queue: context.queueName, jobId },
            "Crawl stalled event missing job data",
          );
          return;
        }
        await this.prisma.crawlTask.updateMany({
          where: {
            id: job.data.taskId,
            orgId: job.data.orgId,
            status: "running",
          },
          data: {
            status: "queued",
            lastError: "crawl job stalled; re-queued by bullmq",
          },
        });
        if (job.data.sourceId && this.newsSourceOpsSnapshots) {
          await this.newsSourceOpsSnapshots.syncQueueCounts(
            job.data.orgId,
            job.data.sourceId,
          );
        }
      } catch (error) {
        logger.error(
          { queue: context.queueName, jobId, err: error },
          "Failed to handle crawl stalled event",
        );
      }
    };

    const onCompleted = async ({ jobId }: { jobId: string }) => {
      try {
        const job = await context.queue.getJob(jobId);
        if (!job?.data?.taskId || !job.data.orgId) {
          return;
        }
        // Only plain crawl tasks (which carry no jobKind) were counted by
        // markTaskQueued at enqueue time. Frontier node / LLM judge / LLM
        // learn jobs are never counted, so they must not decrement the
        // counter here — otherwise the counter drifts to zero and disables
        // the stale-task janitor's active-count gate.
        if (!job.data.jobKind) {
          await this.activity.markTasksTerminal(1);
        }
        if (job.data.sourceId && this.newsSourceOpsSnapshots) {
          await this.newsSourceOpsSnapshots.syncQueueCounts(
            job.data.orgId,
            job.data.sourceId,
          );
        }
      } catch (error) {
        logger.error(
          { queue: context.queueName, jobId, err: error },
          "Failed to handle crawl completed event",
        );
      }
    };

    const onFailed = async ({
      jobId,
      failedReason,
    }: {
      jobId: string;
      failedReason?: string;
    }) => {
      try {
        const job = await context.queue.getJob(jobId);
        if (!job?.data?.taskId || !job.data.orgId) {
          logger.warn(
            { queue: context.queueName, jobId, failedReason },
            "Crawl failed event missing job data",
          );
          return;
        }
        if (!job.data.jobKind) {
          await this.activity.markTasksTerminal(1);
        }
        const normalizedReason =
          typeof failedReason === "string" && failedReason.trim().length > 0
            ? truncateText(failedReason, MAX_ERROR_TEXT)
            : "crawl job failed";
        try {
          await this.prisma.crawlTask.updateMany({
            where: {
              id: job.data.taskId,
              orgId: job.data.orgId,
              status: { in: ["queued", "running"] },
            },
            data: {
              status: "failed",
              lastError: normalizedReason,
            },
          });
        } catch (error) {
          const fallbackMessage =
            normalizedReason.length <= MYSQL_VARCHAR_191
              ? normalizedReason
              : truncateText(normalizedReason, MYSQL_VARCHAR_191);
          logger.warn(
            {
              err: error,
              queue: context.queueName,
              jobId,
              taskId: job.data.taskId,
            },
            "Failed to persist crawl failure reason; truncating",
          );
          await this.prisma.crawlTask
            .updateMany({
              where: {
                id: job.data.taskId,
                orgId: job.data.orgId,
                status: { in: ["queued", "running"] },
              },
              data: {
                status: "failed",
                lastError: fallbackMessage,
              },
            })
            .catch((fallbackError) => {
              logger.error(
                {
                  err: fallbackError,
                  queue: context.queueName,
                  jobId,
                  taskId: job.data.taskId,
                },
                "Failed to persist crawl failure reason after truncation",
              );
            });
        }
        if (job.data.sourceId && this.newsSourceOpsSnapshots) {
          await this.newsSourceOpsSnapshots.syncQueueCounts(
            job.data.orgId,
            job.data.sourceId,
          );
        }
      } catch (error) {
        logger.error(
          { queue: context.queueName, jobId, err: error },
          "Failed to handle crawl failed event",
        );
      }
    };

    context.events.on("stalled", onStalled);
    context.events.on("completed", onCompleted);
    context.events.on("failed", onFailed);

    this.queueEventBindings.push({
      events: context.events,
      onStalled,
      onCompleted,
      onFailed,
    });
  }

  async onModuleDestroy() {
    for (const { worker } of this.workers) {
      await worker.close();
    }
    this.workers.length = 0;
    for (const worker of this.llmWorkers) {
      await worker.close();
    }
    this.llmWorkers.length = 0;
    this.globalConcurrencyLimiter.close();

    for (const binding of this.queueEventBindings) {
      binding.events.off("stalled", binding.onStalled);
      binding.events.off("completed", binding.onCompleted);
      binding.events.off("failed", binding.onFailed);
    }
    this.queueEventBindings.length = 0;
  }

  setWorkerConcurrency(
    maxConcurrency: number,
    queueClass?: CrawlPriorityClass,
  ) {
    const sanitized = Math.max(1, Math.round(maxConcurrency));
    this.globalConcurrencyLimiter.setCapacity(sanitized);

    if (queueClass) {
      for (const runtime of this.workers) {
        if (runtime.queueClass === queueClass) {
          runtime.worker.concurrency = sanitized;
        }
      }
      return;
    }

    for (const runtime of this.workers) {
      runtime.worker.concurrency = sanitized;
    }
  }

  private async applyGlobalConcurrency(maxConcurrency: number) {
    const concurrency = Math.max(1, Math.round(maxConcurrency));
    await Promise.all(
      this.queueContexts().map(async (context) => {
        const queueWithGlobalConcurrency =
          context.queue as Queue<CrawlJobData> & QueueWithGlobalConcurrencyApi;
        if (
          typeof queueWithGlobalConcurrency.setGlobalConcurrency === "function"
        ) {
          await queueWithGlobalConcurrency.setGlobalConcurrency(concurrency);
        }
      }),
    );
  }

  private async shouldStartLegacyWorker(): Promise<boolean> {
    try {
      const counts = (await this.legacyQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "paused",
      )) as Record<string, number>;
      return (
        (counts.waiting ?? 0) +
          (counts.active ?? 0) +
          (counts.delayed ?? 0) +
          (counts.paused ?? 0) >
        0
      );
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to inspect legacy crawl queue; starting legacy worker defensively",
      );
      return true;
    }
  }

  private async resolveQueueTimeoutMs(
    queueClass: CrawlPriorityClass,
  ): Promise<number> {
    try {
      const settings = await this.crawlSettings.getSettings();
      const timeoutMs =
        queueClass === "hot"
          ? settings.requestTimeoutHotMs
          : settings.requestTimeoutNormalMs;
      if (
        typeof timeoutMs === "number" &&
        Number.isFinite(timeoutMs) &&
        timeoutMs > 0
      ) {
        return Math.max(1_000, Math.round(timeoutMs));
      }
    } catch (error) {
      logger.warn(
        { err: error, queueClass },
        "Failed to resolve crawl timeout tier; using env fallback",
      );
    }

    const fallback = this.env.crawl4aiConfig.timeoutMs;
    if (
      typeof fallback === "number" &&
      Number.isFinite(fallback) &&
      fallback > 0
    ) {
      return Math.max(1_000, Math.round(fallback));
    }
    return 120_000;
  }
}
