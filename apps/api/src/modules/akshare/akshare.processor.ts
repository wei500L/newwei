import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";

import { EnvService } from "../config/config.service";

import { AKSHARE_QUEUE, AKSHARE_QUEUE_EVENTS, AKSHARE_QUEUE_NAME } from "./akshare.constants";
import { AkshareService } from "./akshare.service";
import { AkshareJobPayload } from "./akshare.types";

const logger = createLogger({ name: "akshare-queue" });

@Injectable()
export class AkshareQueueProcessor
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker?: Worker<AkshareJobPayload>;
  private readonly handleQueueFailed = (event: { jobId: string; failedReason?: string }) => {
    logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, "Akshare queue event failed");
  };

  constructor(
    private readonly env: EnvService,
    private readonly akshareService: AkshareService,
    @Inject(AKSHARE_QUEUE) private readonly queue: Queue<AkshareJobPayload>,
    @Inject(AKSHARE_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onApplicationBootstrap() {
    const config = this.env.akshareConfig;

    this.worker = new Worker<AkshareJobPayload>(
      AKSHARE_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          logger.info({ jobId: job.id, slug: job.data.dataItemId }, "Processing economic data job");
          await this.akshareService.fetchAndPersist(job.data.dataItemId);
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency: config.queueConcurrency
      }
    );

    this.worker.on("failed", async (job, error) => {
      const slug = job?.data?.dataItemId;
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () => logger.error({ jobId: job?.id, slug, error }, "Akshare worker failed"));
      } else {
        logger.error({ jobId: job?.id, slug, error }, "Akshare worker failed");
      }
      if (!slug) {
        return;
      }
      try {
        await this.akshareService.recordFetchFailure(slug, error);
      } catch (persistError) {
        logger.error({ jobId: job?.id, slug, error: persistError }, "Failed to persist Akshare failure status");
      }
    });

    this.events.on("failed", this.handleQueueFailed);
  }

  async onModuleDestroy() {
    this.events.off("failed", this.handleQueueFailed);
    await this.worker?.close();
  }
}
