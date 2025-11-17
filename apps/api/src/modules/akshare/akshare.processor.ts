import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";
import { EnvService } from "../config/config.service";
import { AKSHARE_QUEUE, AKSHARE_QUEUE_EVENTS, AKSHARE_QUEUE_NAME } from "./akshare.constants";
import { AkshareJobPayload } from "./akshare.types";
import { AkshareService } from "./akshare.service";
import { createLogger } from "@modular/utils";

const logger = createLogger({ name: "akshare-queue" });

@Injectable()
export class AkshareQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AkshareJobPayload>;

  constructor(
    private readonly env: EnvService,
    private readonly akshareService: AkshareService,
    @Inject(AKSHARE_QUEUE) private readonly queue: Queue<AkshareJobPayload>,
    @Inject(AKSHARE_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onModuleInit() {
    const config = this.env.akshareConfig;
    this.worker = new Worker<AkshareJobPayload>(
      AKSHARE_QUEUE_NAME,
      async (job) => {
        logger.info({ jobId: job.id, slug: job.data.dataItemId }, "Processing Akshare job");
        await this.akshareService.fetchAndPersist(job.data.dataItemId, job.data.triggeredById);
      },
      {
        connection: this.queue.opts.connection,
        concurrency: config.queueConcurrency
      }
    );

    this.worker.on("failed", (job, error) => {
      logger.error({ jobId: job?.id, slug: job?.data?.dataItemId, error }, "Akshare worker failed");
    });

    this.events.on("failed", (event) => {
      logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, "Akshare queue event failed");
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.events.close();
  }
}
