import { Inject, Injectable } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { CRAWL_QUEUE, CRAWL_QUEUE_NAME } from "./crawl.constants";
import type { CrawlJobData } from "./crawl.types";
import { CrawlSettingsService } from "./crawl-settings.service";

const logger = createLogger({ name: "crawl-queue-service" });

@Injectable()
export class CrawlQueueService {
  constructor(
    @Inject(CRAWL_QUEUE) private readonly crawlQueue: Queue<CrawlJobData>,
    private readonly crawlSettings: CrawlSettingsService
  ) {}

  async enqueueTask(taskId: string, orgId: string, triggeredById?: string) {
    const settings = await this.crawlSettings.getSettings();
    const attempts = Math.max(1, settings.maxRetries);
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.crawlQueue.add(
      "crawl-task",
      { taskId, orgId, triggeredById, traceId },
      {
        jobId: `${taskId}:${Date.now()}`,
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
    const jobs = await this.crawlQueue.getJobs([
      "waiting",
      "delayed",
      "active",
      "failed"
    ], 0, 200);
    const matching = jobs.filter((job) => job.data?.taskId === taskId);
    await Promise.all(
      matching.map(async (job: Job) => {
        try {
          await job.remove();
        } catch (error) {
          logger.warn({ taskId, jobId: job.id, err: error }, "Failed to remove queued crawl job");
        }
      })
    );
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
}
