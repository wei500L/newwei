import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";

import { EnvService } from "../config/config.service";

import {
  CLASSIFICATION_QUALITY_QUEUE,
  CLASSIFICATION_QUALITY_QUEUE_NAME,
  type ClassificationQualityJobPayload,
} from "./classification-quality.constants";
import { ClassificationQualityService } from "./classification-quality.service";

const logger = createLogger({ name: "classification-quality-worker" });

@Injectable()
export class ClassificationQualityProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private worker?: Worker<ClassificationQualityJobPayload>;

  constructor(
    private readonly env: EnvService,
    private readonly classificationQuality: ClassificationQualityService,
    @Inject(CLASSIFICATION_QUALITY_QUEUE)
    private readonly queue: Queue<ClassificationQualityJobPayload>,
  ) {}

  async onModuleInit() {
    const configured =
      this.env.newsPipelineEnv.processQueueConcurrency > 0
        ? this.env.newsPipelineEnv.processQueueConcurrency
        : 2;
    const concurrency = Math.max(1, Math.min(4, configured));

    this.worker = new Worker<ClassificationQualityJobPayload>(
      CLASSIFICATION_QUALITY_QUEUE_NAME,
      async (job) => {
        const rawPayload =
          job.data && typeof job.data === "object"
            ? (job.data as unknown as Record<string, unknown>)
            : {};
        const traceIdCandidate =
          typeof rawPayload.traceId === "string" ? rawPayload.traceId : undefined;
        const traceId = ensureTraceId(traceIdCandidate);
        return runWithTraceId(traceId, async () => {
          const jobType = this.readString(rawPayload.jobType);
          const orgId = this.readString(rawPayload.orgId);
          const processedItemId = this.readString(rawPayload.processedItemId);
          if (jobType === "review_seed_item" && orgId && processedItemId) {
            await this.classificationQuality.processReviewSeedItemJob({
              orgId,
              processedItemId,
            });
            return;
          }

          // Backward compatibility: old report jobs did not include jobType.
          const reportJobId = this.readString(rawPayload.reportJobId);
          if (!orgId || !reportJobId) {
            logger.warn(
              { jobId: job.id, payload: rawPayload },
              "Skipping classification quality job with invalid payload",
            );
            return;
          }

          await this.classificationQuality.processReportJob(
            orgId,
            reportJobId,
          );
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency,
      },
    );

    this.worker.on("failed", (job, error) => {
      const payload = job?.data;
      logger.error(
        {
          jobId: job?.id,
          reportJobId:
            payload &&
            typeof payload === "object" &&
            "reportJobId" in payload &&
            typeof payload.reportJobId === "string"
              ? payload.reportJobId
              : undefined,
          orgId: payload?.orgId,
          err: error,
        },
        "Classification quality worker failed",
      );
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private readString(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
