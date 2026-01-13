import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker, UnrecoverableError, type BackoffOptions } from "bullmq";

import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { CrawlTaskConfigEncryptionRequiredError } from "./crawl-config-secrets";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CRAWL_QUEUE, CRAWL_QUEUE_EVENTS, CRAWL_QUEUE_NAME } from "./crawl.constants";
import type { CrawlJobData } from "./crawl.types";
import { Crawl4aiRequestException } from "./crawl4ai.exception";

const logger = createLogger({ name: "crawl-queue" });
const RETRYABLE_STATUS_CODES = new Set([408, 423, 425, 429, 500, 502, 503, 504]);

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
  if (error instanceof CrawlTaskConfigEncryptionRequiredError) {
    return false;
  }
  if (error instanceof Crawl4aiRequestException) {
    if (error.status && RETRYABLE_STATUS_CODES.has(error.status)) {
      return true;
    }
    const normalized = error.message.toLowerCase();
    return ["timeout", "temporarily", "rate limit", "connection reset", "connection refused"].some((needle) =>
      normalized.includes(needle)
    );
  }
  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    return ["timeout", "temporarily", "rate limit", "connection reset", "connection refused"].some((needle) =>
      normalized.includes(needle)
    );
  }
  return false;
}

@Injectable()
export class CrawlQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<CrawlJobData>;

  constructor(
    private readonly env: EnvService,
    private readonly crawlExecutionService: CrawlExecutionService,
    private readonly prisma: PrismaService,
    @Inject(CRAWL_QUEUE) private readonly queue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onModuleInit() {
    this.worker = new Worker<CrawlJobData>(
      CRAWL_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          logger.info({ jobId: job.id, taskId: job.data.taskId }, "Processing crawl job");
          const maxAttempts = job.opts.attempts ?? 1;
          const attempt = (job.attemptsMade ?? 0) + 1;
          const backoffDelayMs = resolveBackoffDelayMs(job.opts.backoff, attempt);
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
        concurrency: this.env.crawl4aiConfig.maxConcurrency
      }
    );

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
        await this.prisma.crawlTask.updateMany({
          where: {
            id: job.data.taskId,
            orgId: job.data.orgId,
            status: { in: ["queued", "running"] }
          },
          data: {
            status: "failed",
            lastError: failedReason || "crawl job failed"
          }
        });
      } catch (error) {
        logger.error({ jobId, err: error }, "Failed to handle crawl failed event");
      }
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.events.close();
  }
}
