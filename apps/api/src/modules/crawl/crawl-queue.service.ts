import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import { Job, Queue } from "bullmq";

import { CrawlSettingsService } from "./crawl-settings.service";
import { CRAWL_QUEUE } from "./crawl.constants";
import type { CrawlJobData } from "./crawl.types";

const logger = createLogger({ name: "crawl-queue-service" });
const GLOBAL_CONCURRENCY_FALLBACK = 1;

interface QueueWithGlobalConcurrencyApi {
  setGlobalConcurrency?: (concurrency: number) => Promise<void>;
  getGlobalConcurrency?: () => Promise<number | null>;
}

function isJobLockedRemovalError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("locked by another worker");
}

@Injectable()
export class CrawlQueueService {
  constructor(
    @Inject(CRAWL_QUEUE) private readonly crawlQueue: Queue<CrawlJobData>,
    private readonly crawlSettings: CrawlSettingsService
  ) {}

  private asQueueWithGlobalConcurrencyApi() {
    return this.crawlQueue as Queue<CrawlJobData> & QueueWithGlobalConcurrencyApi;
  }

  async enqueueTask(taskId: string, orgId: string, triggeredById?: string) {
    const settings = await this.crawlSettings.getSettings();
    const attempts = Math.max(1, settings.maxRetries);
    const traceId = ensureTraceId(getCurrentTraceId());
    const deduplicationId = `crawl-task:${taskId}`;
    await this.crawlQueue.add(
      "crawl-task",
      { taskId, orgId, triggeredById, traceId, memoryPressureRequeues: 0 },
      {
        jobId: `${taskId}-${Date.now()}`,
        deduplication: {
          id: deduplicationId
        },
        removeOnComplete: true,
        removeOnFail: false,
        attempts,
        backoff: settings.retryBackoffMs
          ? {
              type: "exponential",
              delay: settings.retryBackoffMs
            }
          : undefined
      }
    );
  }

  async removeQueuedJobs(taskId: string) {
    const states = ["waiting", "delayed", "failed", "paused"] as const;
    const scanLimit = 5_000;
    const pageSize = 200;

    for (let start = 0; start < scanLimit; start += pageSize) {
      const end = Math.min(scanLimit - 1, start + pageSize - 1);
      const jobs = await this.crawlQueue.getJobs([...states], start, end);
      const matching = jobs.filter((job) => job.data?.taskId === taskId);
      await Promise.all(
        matching.map(async (job: Job) => {
          try {
            await job.remove();
          } catch (error) {
            if (isJobLockedRemovalError(error)) {
              return;
            }

            let state: string | undefined;
            try {
              state = await job.getState();
            } catch {
              state = undefined;
            }

            logger.warn(
              { taskId, jobId: job.id, state, err: error },
              "Failed to remove queued crawl job"
            );
          }
        })
      );

      if (jobs.length < pageSize) {
        break;
      }
    }
  }

  async getPendingJobCount(): Promise<number> {
    const counts = await this.crawlQueue.getJobCounts("waiting", "delayed", "active");
    return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
  }

  async listPendingTaskIds(scanLimit = 5_000): Promise<Set<string>> {
    const states = ["waiting", "delayed", "active"] as const;
    const pageSize = 500;
    const taskIds = new Set<string>();
    for (let start = 0; start < scanLimit; start += pageSize) {
      const end = Math.min(scanLimit - 1, start + pageSize - 1);
      const jobs = await this.crawlQueue.getJobs([...states], start, end);
      for (const job of jobs) {
        const taskId = job.data?.taskId;
        if (typeof taskId === "string" && taskId.length > 0) {
          taskIds.add(taskId);
        }
      }
      if (jobs.length < pageSize) {
        break;
      }
    }
    return taskIds;
  }

  async listQueuedTaskIds(scanLimit = 5_000): Promise<Set<string>> {
    const states = ["waiting", "delayed", "failed", "paused"] as const;
    const pageSize = 500;
    const taskIds = new Set<string>();
    for (let start = 0; start < scanLimit; start += pageSize) {
      const end = Math.min(scanLimit - 1, start + pageSize - 1);
      const jobs = await this.crawlQueue.getJobs([...states], start, end);
      for (const job of jobs) {
        const taskId = job.data?.taskId;
        if (typeof taskId === "string" && taskId.length > 0) {
          taskIds.add(taskId);
        }
      }
      if (jobs.length < pageSize) {
        break;
      }
    }
    return taskIds;
  }

  async removeQueuedJobsForTasks(taskIds: Set<string>, scanLimit = 5_000) {
    if (taskIds.size === 0) {
      return { scanned: 0, removed: 0, removedTaskIds: [] as string[] };
    }

    const states = ["waiting", "delayed", "failed", "paused"] as const;
    const pageSize = 200;
    let scanned = 0;
    let removed = 0;
    const removedTaskIds = new Set<string>();

    for (let start = 0; start < scanLimit; start += pageSize) {
      const end = Math.min(scanLimit - 1, start + pageSize - 1);
      const jobs = await this.crawlQueue.getJobs([...states], start, end);
      scanned += jobs.length;

      const matching = jobs.filter((job) => taskIds.has(job.data?.taskId));
      await Promise.all(
        matching.map(async (job: Job) => {
          try {
            const taskId = job.data?.taskId;
            await job.remove();
            removed += 1;
            if (typeof taskId === "string" && taskId.length > 0) {
              removedTaskIds.add(taskId);
            }
          } catch (error) {
            if (isJobLockedRemovalError(error)) {
              return;
            }

            let state: string | undefined;
            try {
              state = await job.getState();
            } catch {
              state = undefined;
            }

            logger.warn(
              { jobId: job.id, state, err: error },
              "Failed to remove queued crawl job"
            );
          }
        })
      );

      if (jobs.length < pageSize) {
        break;
      }
    }

    return { scanned, removed, removedTaskIds: Array.from(removedTaskIds) };
  }

  async getJobCounts() {
    return this.crawlQueue.getJobCounts("waiting", "active", "delayed", "failed", "paused");
  }

  async pauseQueue() {
    await this.crawlQueue.pause();
  }

  async resumeQueue() {
    await this.crawlQueue.resume();
  }

  async isPaused() {
    return this.crawlQueue.isPaused();
  }

  async setGlobalConcurrency(maxConcurrency: number) {
    const queueWithApi = this.asQueueWithGlobalConcurrencyApi();
    if (typeof queueWithApi.setGlobalConcurrency === "function") {
      await queueWithApi.setGlobalConcurrency(maxConcurrency);
    }
  }

  async getGlobalConcurrency() {
    const queueWithApi = this.asQueueWithGlobalConcurrencyApi();
    if (typeof queueWithApi.getGlobalConcurrency !== "function") {
      return null;
    }
    return queueWithApi.getGlobalConcurrency();
  }

  async getEffectiveConcurrency() {
    const globalConcurrency = await this.getGlobalConcurrency();
    if (typeof globalConcurrency === "number" && Number.isFinite(globalConcurrency) && globalConcurrency > 0) {
      return Math.max(GLOBAL_CONCURRENCY_FALLBACK, Math.round(globalConcurrency));
    }
    const settings = await this.crawlSettings.getSettings();
    return settings.maxConcurrency;
  }
}
