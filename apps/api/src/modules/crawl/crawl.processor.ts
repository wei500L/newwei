import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";
import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { EnvService } from "../config/config.service";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CRAWL_QUEUE, CRAWL_QUEUE_EVENTS, CRAWL_QUEUE_NAME } from "./crawl.constants";
import type { CrawlJobData } from "./crawl.types";

const logger = createLogger({ name: "crawl-queue" });

@Injectable()
export class CrawlQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<CrawlJobData>;

  constructor(
    private readonly env: EnvService,
    private readonly crawlExecutionService: CrawlExecutionService,
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
          return this.crawlExecutionService.runTask(job.data.taskId, job.data.orgId, job.data.triggeredById);
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

    this.events.on("failed", ({ jobId, failedReason }) => {
      logger.warn({ jobId, failedReason }, "Crawl queue event failed");
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.events.close();
  }
}
