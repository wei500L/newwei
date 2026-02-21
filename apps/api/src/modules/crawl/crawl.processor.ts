import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker, UnrecoverableError, type BackoffOptions } from "bullmq";

import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { CrawlExecutionService } from "./crawl-execution.service";
import { CRAWL_QUEUE, CRAWL_QUEUE_EVENTS, CRAWL_QUEUE_NAME } from "./crawl.constants";
import { CrawlSettingsService } from "./crawl-settings.service";
import type { CrawlJobData } from "./crawl.types";
import { Crawl4aiRequestException } from "./crawl4ai.exception";

const logger = createLogger({ name: "crawl-queue" });
const RETRYABLE_STATUS_CODES = new Set([408, 423, 425, 429, 500, 502, 503, 504]);
const MAX_ERROR_TEXT = 4000;
const MYSQL_VARCHAR_191 = 191;
const MEMORY_PRESSURE_COOLDOWN_MIN_MS = 5_000;
const MEMORY_PRESSURE_COOLDOWN_MAX_MS = 10 * 60 * 1000;
const MEMORY_PRESSURE_DEFAULT_COOLDOWN_MS = 30_000;
const MEMORY_PRESSURE_PERCENT_PATTERN = /memory\s+at\s+(\d+(?:\.\d+)?)%/i;

const RETRYABLE_MESSAGE_HINTS = ["timeout", "temporarily", "rate limit", "connection reset", "connection refused"];
const MEMORY_PRESSURE_HINTS = [
  "refusing new browser",
  "memory at",
  "insufficient memory",
  "out of memory",
  "not enough memory",
  "cannot allocate memory"
];

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function resolveBackoffDelayMs(backoff: number | BackoffOptions | undefined, attempt: number): number | null {
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
    return RETRYABLE_MESSAGE_HINTS.some((needle) => normalized.includes(needle));
  }
  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    return RETRYABLE_MESSAGE_HINTS.some((needle) => normalized.includes(needle));
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
  if (normalized.includes("memory") && normalized.includes("refusing") && normalized.includes("browser")) {
    return true;
  }
  return MEMORY_PRESSURE_HINTS.some((needle) => normalized.includes(needle));
}

function resolveQueueOverloadCooldownMs(configured: unknown, memoryPercent: number | null): number {
  const fallback =
    typeof configured === "number" && Number.isFinite(configured)
      ? Math.round(configured)
      : MEMORY_PRESSURE_DEFAULT_COOLDOWN_MS;
  const baseDelayMs = Math.max(
    MEMORY_PRESSURE_COOLDOWN_MIN_MS,
    Math.min(MEMORY_PRESSURE_COOLDOWN_MAX_MS, fallback)
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
    Math.min(MEMORY_PRESSURE_COOLDOWN_MAX_MS, Math.round(baseDelayMs * multiplier))
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

function resolveInitialWorkerConcurrency(configured: unknown, fallback: unknown): number {
  const normalizedConfigured = normalizePositiveInteger(configured);
  if (normalizedConfigured !== null) {
    return normalizedConfigured;
  }
  return normalizePositiveInteger(fallback) ?? 1;
}

function resolveMaxAttempts(value: unknown): number {
  return normalizePositiveInteger(value) ?? 1;
}

function resolveAttemptsStarted(job: { attemptsMade?: number; attemptsStarted?: unknown }): number {
  const attemptsStarted = normalizePositiveInteger(job.attemptsStarted);
  if (attemptsStarted !== null) {
    return attemptsStarted;
  }
  if (typeof job.attemptsMade === "number" && Number.isFinite(job.attemptsMade)) {
    return Math.max(1, Math.floor(job.attemptsMade) + 1);
  }
  return 1;
}

function resolveMemoryPressureRequeues(job: { data?: { memoryPressureRequeues?: unknown } }): number {
  return normalizeNonNegativeInteger(job.data?.memoryPressureRequeues) ?? 0;
}

async function persistMemoryPressureRequeueCount(
  job: {
    data?: CrawlJobData;
    attemptsStarted?: unknown;
    updateData?: (data: CrawlJobData) => Promise<unknown>;
  },
  nextRequeues: number
) {
  if (!job.data) {
    throw new Error("Crawl job payload is missing; cannot persist retry state");
  }

  const nextData: CrawlJobData = {
    ...job.data,
    memoryPressureRequeues: nextRequeues
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
    "Cannot persist memory pressure retry state for crawl job (missing updateData and attemptsStarted)"
  );
}

interface QueueWithGlobalConcurrencyApi {
  setGlobalConcurrency?: (concurrency: number) => Promise<void>;
}

@Injectable()
export class CrawlQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<CrawlJobData>;

  constructor(
    private readonly env: EnvService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly crawlExecutionService: CrawlExecutionService,
    private readonly prisma: PrismaService,
    @Inject(CRAWL_QUEUE) private readonly queue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onModuleInit() {
    let configuredConcurrency = Math.max(1, Math.round(this.env.crawl4aiConfig.maxConcurrency ?? 1));
    try {
      const settings = await this.crawlSettings.getSettings();
      configuredConcurrency = Math.max(1, Math.round(settings.maxConcurrency));
      const queueWithGlobalConcurrency = this.queue as Queue<CrawlJobData> & QueueWithGlobalConcurrencyApi;
      if (typeof queueWithGlobalConcurrency.setGlobalConcurrency === "function") {
        await queueWithGlobalConcurrency.setGlobalConcurrency(configuredConcurrency);
      }
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to apply configured crawl queue global concurrency; using worker-local concurrency fallback"
      );
    }

    const concurrency = resolveInitialWorkerConcurrency(
      configuredConcurrency,
      this.env.crawl4aiConfig.maxConcurrency ?? 1
    );

    const worker = new Worker<CrawlJobData>(
      CRAWL_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          logger.info({ jobId: job.id, taskId: job.data.taskId }, "Processing crawl job");
          const maxAttempts = resolveMaxAttempts(job.opts?.attempts);
          const attemptsStarted = resolveAttemptsStarted(job);
          const attempt = Math.min(maxAttempts, attemptsStarted);
          const backoffDelayMs = resolveBackoffDelayMs(job.opts?.backoff, attempt);
          try {
            return await this.crawlExecutionService.runTask(
              job.data.taskId,
              job.data.orgId,
              job.data.triggeredById,
              {
                attempt,
                maxAttempts,
                backoffDelayMs
              }
            );
          } catch (error) {
            if (isMemoryPressureError(error)) {
              const memoryPressureRequeues = resolveMemoryPressureRequeues(job);
              if (
                attemptsStarted >= maxAttempts ||
                memoryPressureRequeues >= maxAttempts - 1
              ) {
                logger.warn(
                  {
                    jobId: job.id,
                    taskId: job.data.taskId,
                    attemptsStarted,
                    maxAttempts,
                    memoryPressureRequeues
                  },
                  "crawl4ai memory pressure retry budget exhausted; failing job as unrecoverable"
                );
                const unrecoverable = new UnrecoverableError(
                  error instanceof Error ? error.message : String(error)
                );
                (unrecoverable as Error & { cause?: unknown }).cause = error;
                throw unrecoverable;
              }

              let configuredCooldownMs: number = MEMORY_PRESSURE_DEFAULT_COOLDOWN_MS;
              try {
                const settings = await this.crawlSettings.getSettings();
                configuredCooldownMs = settings.queueOverloadCooldownMs;
              } catch (settingsError) {
                logger.warn(
                  { err: settingsError },
                  "Failed to load crawl settings for memory pressure cooldown; using default"
                );
              }

              const memoryPercent = extractMemoryPressurePercent(error);
              const cooldownMs = resolveQueueOverloadCooldownMs(configuredCooldownMs, memoryPercent);

              try {
                await worker.rateLimit(cooldownMs);
              } catch (rateLimitError) {
                logger.error(
                  { jobId: job.id, taskId: job.data.taskId, cooldownMs, err: rateLimitError },
                  "Failed to apply crawl queue rate limit during memory pressure fallback"
                );
                throw error;
              }

              const nextMemoryPressureRequeues = memoryPressureRequeues + 1;
              try {
                await persistMemoryPressureRequeueCount(job, nextMemoryPressureRequeues);
              } catch (persistError) {
                logger.error(
                  {
                    jobId: job.id,
                    taskId: job.data.taskId,
                    nextMemoryPressureRequeues,
                    maxAttempts,
                    err: persistError
                  },
                  "Failed to persist memory pressure retry state; failing crawl job as unrecoverable"
                );
                const unrecoverable = new UnrecoverableError(
                  error instanceof Error ? error.message : String(error)
                );
                (unrecoverable as Error & { cause?: unknown }).cause = error;
                throw unrecoverable;
              }

              logger.warn(
                {
                  jobId: job.id,
                  taskId: job.data.taskId,
                  cooldownMs,
                  memoryPercent,
                  memoryPressureRequeues: nextMemoryPressureRequeues,
                  maxAttempts,
                  error:
                    error instanceof Error
                      ? truncateText(error.message, 500)
                      : truncateText(String(error), 500)
                },
                "crawl4ai memory pressure detected; re-queueing job with queue-wide cooldown"
              );

              throw Worker.RateLimitError();
            }

            if (!isRetryableError(error)) {
              const unrecoverable = new UnrecoverableError(
                error instanceof Error ? error.message : String(error)
              );
              (unrecoverable as Error & { cause?: unknown }).cause = error;
              throw unrecoverable;
            }
            throw error;
          }
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency,
        limiter: {
          max: resolveManualLimiterMax(concurrency),
          duration: 1000
        }
      }
    );
    this.worker = worker;

    this.worker.on("failed", (job, error) => {
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () => logger.error({ jobId: job?.id, error }, "Crawl queue worker error"));
      } else {
        logger.error({ jobId: job?.id, error }, "Crawl queue worker error");
      }
    });

    this.events.on("stalled", async ({ jobId }) => {
      try {
        const job = await this.queue.getJob(jobId);
        if (!job?.data?.taskId || !job.data.orgId) {
          logger.warn({ jobId }, "Crawl stalled event missing job data");
          return;
        }
        await this.prisma.crawlTask.updateMany({
          where: {
            id: job.data.taskId,
            orgId: job.data.orgId,
            status: "running"
          },
          data: {
            status: "queued",
            lastError: "crawl job stalled; re-queued by bullmq"
          }
        });
      } catch (error) {
        logger.error({ jobId, err: error }, "Failed to handle crawl stalled event");
      }
    });

    this.events.on("failed", async ({ jobId, failedReason }) => {
      try {
        const job = await this.queue.getJob(jobId);
        if (!job?.data?.taskId || !job.data.orgId) {
          logger.warn({ jobId, failedReason }, "Crawl failed event missing job data");
          return;
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
              status: { in: ["queued", "running"] }
            },
            data: {
              status: "failed",
              lastError: normalizedReason
            }
          });
        } catch (error) {
          const fallbackMessage =
            normalizedReason.length <= MYSQL_VARCHAR_191
              ? normalizedReason
              : truncateText(normalizedReason, MYSQL_VARCHAR_191);
          logger.warn({ err: error, jobId, taskId: job.data.taskId }, "Failed to persist crawl failure reason; truncating");
          await this.prisma.crawlTask
            .updateMany({
              where: {
                id: job.data.taskId,
                orgId: job.data.orgId,
                status: { in: ["queued", "running"] }
              },
              data: {
                status: "failed",
                lastError: fallbackMessage
              }
            })
            .catch((fallbackError) => {
              logger.error(
                { err: fallbackError, jobId, taskId: job.data.taskId },
                "Failed to persist crawl failure reason after truncation"
              );
            });
        }
      } catch (error) {
        logger.error({ jobId, err: error }, "Failed to handle crawl failed event");
      }
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  setWorkerConcurrency(maxConcurrency: number) {
    if (!this.worker) {
      return;
    }
    this.worker.concurrency = Math.max(1, Math.round(maxConcurrency));
  }
}
