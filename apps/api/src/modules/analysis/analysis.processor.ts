import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";

import { EnvService } from "../config/config.service";

import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_QUEUE_NAME } from "./analysis.constants";
import { AnalysisService } from "./analysis.service";
import { AnalysisJobPayload } from "./analysis.types";

const logger = createLogger({ name: "analysis-worker" });

@Injectable()
export class AnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AnalysisJobPayload>;
  private readonly handleQueueFailed = (event: { jobId: string; failedReason?: string }) => {
    logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, "Analysis queue event failed");
  };

  constructor(
    private readonly env: EnvService,
    private readonly analysisService: AnalysisService,
    @Inject(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJobPayload>,
    @Inject(ANALYSIS_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onModuleInit() {
    this.worker = new Worker<AnalysisJobPayload>(
      ANALYSIS_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          await this.analysisService.process(job.data);
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency: this.env.analysisConfig.queueConcurrency
      }
    );

    this.worker.on("failed", (job, error) => {
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () => logger.error({ jobId: job?.id, error }, "Analysis worker failed"));
      } else {
        logger.error({ jobId: job?.id, error }, "Analysis worker failed");
      }
    });

    this.events.on("failed", this.handleQueueFailed);
  }

  async onModuleDestroy() {
    this.events.off("failed", this.handleQueueFailed);
    await this.worker?.close();
  }
}
