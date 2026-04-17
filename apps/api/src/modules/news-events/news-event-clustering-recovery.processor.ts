import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";

import { EnvService } from "../config/config.service";

import {
  NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE,
  NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME,
  type NewsEventClusteringRecoveryJobPayload,
} from "./news-event-clustering-recovery.constants";
import { NewsEventClusteringRecoveryService } from "./news-event-clustering-recovery.service";

const logger = createLogger({ name: "news-event-clustering-recovery-worker" });

@Injectable()
export class NewsEventClusteringRecoveryProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private worker?: Worker<NewsEventClusteringRecoveryJobPayload>;

  constructor(
    private readonly env: EnvService,
    private readonly recovery: NewsEventClusteringRecoveryService,
    @Inject(NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE)
    private readonly queue: Queue<NewsEventClusteringRecoveryJobPayload>,
  ) {}

  async onModuleInit() {
    const configured =
      this.env.newsPipelineEnv.processQueueConcurrency > 0
        ? this.env.newsPipelineEnv.processQueueConcurrency
        : 1;
    const concurrency = Math.max(1, Math.min(2, configured));

    this.worker = new Worker<NewsEventClusteringRecoveryJobPayload>(
      NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          await this.recovery.processJob(job.data);
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency,
      },
    );

    this.worker.on("failed", (job, error) => {
      logger.error(
        {
          jobId: job?.id,
          groupId: job?.data?.groupId,
          orgId: job?.data?.orgId,
          err: error,
        },
        "News event clustering recovery worker failed",
      );
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
