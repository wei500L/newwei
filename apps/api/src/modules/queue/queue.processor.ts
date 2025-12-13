import { RawItemModel, TaskLogModel } from "@modular/mongo";
import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Worker } from "bullmq";
import type { Queue } from "bullmq";
import { UnrecoverableError } from "bullmq";

import { EnvService } from "../config/config.service";
import { NewsPipelineService } from "../news-pipeline/news-pipeline.service";
import type {
  PipelineJobContext,
  RawPipelineItem,
} from "../news-pipeline/news-pipeline.types";

import {
  ITEM_PIPELINE_QUEUE_NAME,
  PIPELINE_DLQ_QUEUE,
  PIPELINE_QUEUE,
} from "./queue.constants";
import {
  classifyQueueError,
  QueueErrorKind,
  QueuePermanentError,
} from "./queue.error-handling";

const logger = createLogger({ name: "queue" });

type PipelineQueueJobData = {
  rawItemId: string;
  itemMetaId: string;
  orgId?: string;
  traceId?: string;
};

type PipelineQueueDlqData = {
  rawItemId?: string;
  itemMetaId?: string;
  orgId?: string;
  traceId?: string;
  originalQueue: string;
  originalJobId?: string;
  failedAt: string;
  attemptsMade: number;
  attempts: number;
  errorKind: QueueErrorKind;
  error: unknown;
};

@Injectable()
export class QueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    @Inject(PIPELINE_DLQ_QUEUE) private readonly dlqQueue: Queue,
    private readonly env: EnvService,
    private readonly pipeline: NewsPipelineService,
  ) {}

  async onModuleInit() {
    const config = this.env.bullmqConfig;
    const concurrency =
      this.env.newsPipelineEnv.processQueueConcurrency > 0
        ? this.env.newsPipelineEnv.processQueueConcurrency
        : 3;
    this.worker = new Worker(
      ITEM_PIPELINE_QUEUE_NAME,
      async (job) => {
        const jobData = (job.data ?? {}) as Partial<PipelineQueueJobData>;
        const traceId = ensureTraceId(jobData.traceId);
        return runWithTraceId(traceId, async () => {
          try {
            const rawItemId =
              typeof jobData.rawItemId === "string" ? jobData.rawItemId : undefined;
            const itemMetaId =
              typeof jobData.itemMetaId === "string" ? jobData.itemMetaId : undefined;
            const jobOrgId =
              typeof jobData.orgId === "string" ? jobData.orgId : undefined;

            if (!rawItemId || !itemMetaId) {
              throw new QueuePermanentError(
                "Queue job missing rawItemId or itemMetaId",
              );
            }

            if (!jobOrgId) {
              logger.error({ jobId: job.id }, "Queue job missing orgId; failing job");
              throw new QueuePermanentError("Queue job missing orgId");
            }

            const orgId = jobOrgId;
            logger.info({ jobId: job.id }, "Processing item pipeline job");

            const rawItem = await RawItemModel.findById(rawItemId);
            if (!rawItem) {
              await TaskLogModel.create({
                queue: ITEM_PIPELINE_QUEUE_NAME,
                jobId: job.id,
                orgId,
                stage: "dedupe",
                status: "failed",
                message: "Raw item not found",
                data: job.data,
              });
              throw new QueuePermanentError("Raw item not found");
            }

            await TaskLogModel.create({
              queue: ITEM_PIPELINE_QUEUE_NAME,
              jobId: job.id,
              orgId,
              stage: "dedupe",
              status: "completed",
              message: "Item deduplicated",
              data: { itemMetaId },
            });

            const pipelineJob: PipelineJobContext = {
              queue: ITEM_PIPELINE_QUEUE_NAME,
              jobId: job.id ? String(job.id) : "",
              itemMetaId,
              rawItemId,
              orgId,
            };

            const rawPayload: RawPipelineItem = {
              id: rawItem._id.toString(),
              itemMetaId,
              payload: rawItem.payload,
              source: rawItem.source ?? undefined,
            };

            const processed = await this.pipeline.process(pipelineJob, rawPayload);

            await TaskLogModel.create({
              queue: ITEM_PIPELINE_QUEUE_NAME,
              jobId: job.id,
              orgId,
              stage: "complete",
              status: "completed",
              data: { processedId: processed.id ?? rawItemId },
            });

            return processed;
          } catch (error) {
            const classified = classifyQueueError(error);
            if (classified.kind === QueueErrorKind.Permanent) {
              const unrecoverable = new UnrecoverableError(classified.error.message);
              (unrecoverable as Error & { cause?: unknown }).cause = error;
              throw unrecoverable;
            }
            throw error instanceof Error ? error : new Error(String(error));
          }
        });
      },
      {
        connection: {
          host: config.connection.host,
          port: config.connection.port,
          username: config.connection.username,
          db: config.connection.db,
        },
        concurrency,
      },
    );

    this.worker.on("failed", async (job, err) => {
      const data = (job?.data ?? {}) as Partial<PipelineQueueJobData>;
      const traceId = typeof data.traceId === "string" ? data.traceId : undefined;
      const classified = classifyQueueError(err);

      const handler = async () => {
        try {
          logger.error(
            {
              jobId: job?.id,
              errorKind: classified.kind,
              reason: classified.reason,
              err: classified.error,
            },
            "Queue job failed",
          );

          if (!job) {
            return;
          }

          const attempts = job.opts.attempts ?? 1;
          const attemptsMade = job.attemptsMade ?? 0;
          const remainingAttempts = Math.max(0, attempts - attemptsMade);
          const jobOrgId =
            typeof data.orgId === "string" ? data.orgId : "unknown";

          await TaskLogModel.create({
            queue: ITEM_PIPELINE_QUEUE_NAME,
            jobId: job.id,
            orgId: jobOrgId,
            stage: "worker",
            status: "failed",
            data: {
              attempts,
              attemptsMade,
              remainingAttempts,
              errorKind: classified.kind,
              reason: classified.reason,
            },
            error: classified.error,
          });

          const shouldSendToDlq =
            classified.kind === QueueErrorKind.Permanent || remainingAttempts === 0;

          if (!shouldSendToDlq) {
            return;
          }

          const dlqPayload: PipelineQueueDlqData = {
            ...data,
            originalQueue: ITEM_PIPELINE_QUEUE_NAME,
            originalJobId: job.id ? String(job.id) : undefined,
            failedAt: new Date().toISOString(),
            attempts,
            attemptsMade,
            errorKind: classified.kind,
            error: classified.error,
          };

          const dlqJobId = `dlq:${ITEM_PIPELINE_QUEUE_NAME}:${job.id}:${attemptsMade}`;
          try {
            await this.dlqQueue.add("dlq", dlqPayload, {
              jobId: dlqJobId,
              removeOnComplete: false,
              removeOnFail: false,
              attempts: 1,
            });
            logger.warn(
              { jobId: job.id, dlqJobId, errorKind: classified.kind },
              "Queue job enqueued to DLQ",
            );
          } catch (dlqError) {
            logger.error(
              { jobId: job.id, dlqJobId, dlqError },
              "Failed to enqueue job to DLQ",
            );
          }
        } catch (handlerError) {
          logger.error(
            { jobId: job?.id, handlerError },
            "Queue failed handler crashed",
          );
        }
      };

      if (traceId) {
        await runWithTraceId(traceId, handler);
      } else {
        await handler();
      }
    });
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
    await this.dlqQueue.close();
  }
}
