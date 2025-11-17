import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";
import { EnvService } from "../config/config.service";
import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_QUEUE_NAME } from "./analysis.constants";
import { AnalysisJobPayload } from "./analysis.types";
import { AnalysisService } from "./analysis.service";
import { createLogger } from "@modular/utils";

const logger = createLogger({ name: "analysis-worker" });

@Injectable()
export class AnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AnalysisJobPayload>;

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
        await this.analysisService.process(job.data);
      },
      {
        connection: this.queue.opts.connection,
        concurrency: this.env.analysisConfig.queueConcurrency
      }
    );

    this.worker.on("failed", (job, error) => {
      logger.error({ jobId: job?.id, error }, "Analysis worker failed");
    });

    this.events.on("failed", (event) => {
      logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, "Analysis queue event failed");
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.events.close();
  }
}
