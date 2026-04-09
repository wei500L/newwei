import { ProcessedItemModel, RawItemModel } from "@modular/mongo";
import {
  createLogger,
  ensureTraceId,
  NotificationPresentationKind,
  runWithTraceId,
  sanitizeError,
} from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { NotificationType, PipelineJobStatus } from "@prisma/client";
import { Worker, UnrecoverableError, type Queue } from "bullmq";
import { Types } from "mongoose";

import { ItemStatus } from "../../common/pipeline-status";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { toBullmqConnection } from "../config/redis-connection";
import { NewsSourceOpsSnapshotService } from "../crawl/news-source-ops-snapshot.service";
import { NewsPipelineService } from "../news-pipeline/news-pipeline.service";
import type {
  PipelineJobContext,
  RawPipelineItem,
} from "../news-pipeline/news-pipeline.types";
import { NotificationsService } from "../notifications/notifications.service";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

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

interface PipelineQueueJobData {
  rawItemId: string;
  itemMetaId: string;
  orgId?: string;
  traceId?: string;
  processedItemId?: string;
  pipelineJobId?: string;
  sourceId?: string;
}

interface PipelineQueueDlqData {
  rawItemId?: string;
  itemMetaId?: string;
  orgId?: string;
  traceId?: string;
  processedItemId?: string;
  pipelineJobId?: string;
  sourceId?: string;
  originalQueue: string;
  originalJobId?: string;
  failedAt: string;
  attemptsMade: number;
  attempts: number;
  errorKind: QueueErrorKind;
  error: unknown;
}

@Injectable()
export class QueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    @Inject(PIPELINE_DLQ_QUEUE) private readonly dlqQueue: Queue,
    private readonly env: EnvService,
    private readonly pipeline: NewsPipelineService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional()
    private readonly newsSourceOpsSnapshots?: NewsSourceOpsSnapshotService,
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
              typeof jobData.rawItemId === "string"
                ? jobData.rawItemId
                : undefined;
            const itemMetaId =
              typeof jobData.itemMetaId === "string"
                ? jobData.itemMetaId
                : undefined;
            const jobOrgId =
              typeof jobData.orgId === "string" ? jobData.orgId : undefined;
            const pipelineJobId =
              typeof jobData.pipelineJobId === "string"
                ? jobData.pipelineJobId
                : undefined;
            const sourceId =
              typeof jobData.sourceId === "string"
                ? jobData.sourceId
                : undefined;

            if (!rawItemId || !itemMetaId) {
              throw new QueuePermanentError(
                "Queue job missing rawItemId or itemMetaId",
              );
            }

            if (!jobOrgId) {
              logger.error(
                { jobId: job.id },
                "Queue job missing orgId; failing job",
              );
              throw new QueuePermanentError("Queue job missing orgId");
            }

            const orgId = jobOrgId;
            logger.info({ jobId: job.id }, "Processing item pipeline job");
            const processedItemId =
              typeof jobData.processedItemId === "string" &&
              jobData.processedItemId.length > 0
                ? jobData.processedItemId
                : Types.ObjectId.isValid(rawItemId)
                  ? rawItemId
                  : new Types.ObjectId().toHexString();

            await this.markProcessingState({
              itemMetaId,
              rawItemId,
              orgId,
              processedItemId,
              pipelineJobId,
              sourceId,
            });

            const rawItem = await RawItemModel.findById(rawItemId);
            if (!rawItem) {
              await writeTaskLogBestEffort({
                queue: ITEM_PIPELINE_QUEUE_NAME,
                jobId: job.id ?? "",
                orgId,
                stage: "dedupe",
                status: "failed",
                message: "Raw item not found",
                data: job.data,
              });
              throw new QueuePermanentError("Raw item not found");
            }

            const pipelineJob: PipelineJobContext = {
              queue: ITEM_PIPELINE_QUEUE_NAME,
              jobId: job.id ? String(job.id) : "",
              itemMetaId,
              rawItemId,
              orgId,
              processedItemId,
              pipelineJobId,
              sourceId,
            };

            const rawPayload: RawPipelineItem = {
              id: rawItem._id.toString(),
              itemMetaId,
              payload: rawItem.payload,
              source: rawItem.source ?? undefined,
            };

            const processed = await this.pipeline.process(
              pipelineJob,
              rawPayload,
            );

            await this.markSuccessState({
              itemMetaId,
              orgId,
              pipelineJobId,
              sourceId,
            });

            await writeTaskLogBestEffort({
              queue: ITEM_PIPELINE_QUEUE_NAME,
              jobId: job.id ?? "",
              orgId,
              stage: "complete",
              status: "completed",
              data: { processedId: processed.id ?? rawItemId },
            });

            return processed;
          } catch (error) {
            const classified = classifyQueueError(error);
            if (classified.kind === QueueErrorKind.Permanent) {
              const unrecoverable = new UnrecoverableError(
                classified.error.message,
              );
              (unrecoverable as Error & { cause?: unknown }).cause = error;
              throw unrecoverable;
            }
            throw error instanceof Error ? error : new Error(String(error));
          }
        });
      },
      {
        connection: toBullmqConnection(config.connection),
        concurrency,
      },
    );

    this.worker.on("failed", async (job, err) => {
      const data = (job?.data ?? {}) as Partial<PipelineQueueJobData>;
      const traceId =
        typeof data.traceId === "string" ? data.traceId : undefined;
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

          const rawItemId =
            typeof data.rawItemId === "string" ? data.rawItemId : undefined;
          const itemMetaId =
            typeof data.itemMetaId === "string" ? data.itemMetaId : undefined;
          const processedItemId =
            typeof data.processedItemId === "string" &&
            data.processedItemId.length > 0
              ? data.processedItemId
              : rawItemId && Types.ObjectId.isValid(rawItemId)
                ? rawItemId
                : undefined;

          await writeTaskLogBestEffort({
            queue: ITEM_PIPELINE_QUEUE_NAME,
            jobId: job?.id ?? "",
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
            classified.kind === QueueErrorKind.Permanent ||
            remainingAttempts === 0;

          await this.markFailureState({
            itemMetaId,
            rawItemId,
            orgId: jobOrgId,
            processedItemId,
            pipelineJobId:
              typeof data.pipelineJobId === "string"
                ? data.pipelineJobId
                : undefined,
            sourceId:
              typeof data.sourceId === "string" ? data.sourceId : undefined,
            // Preserve the original error so sanitizeError can keep the message (vs. "[object Object]").
            error: err,
            attemptsMade,
            finalFailure: shouldSendToDlq,
          });

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

          const dlqJobId = `dlq-${ITEM_PIPELINE_QUEUE_NAME}-${job.id}-${attemptsMade}`;
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

  private normalizeError(error: unknown) {
    return sanitizeError(error);
  }

  private async updateItemMetaStatus(
    itemMetaId: string,
    status: ItemStatus,
    options?: { skipIfDuplicate?: boolean },
  ) {
    try {
      await this.prisma.itemMeta.updateMany({
        where: {
          id: itemMetaId,
          ...(options?.skipIfDuplicate
            ? { status: { not: ItemStatus.Duplicate } }
            : {}),
        },
        data: { status },
      });
    } catch (error) {
      logger.warn(
        { itemMetaId, status, error },
        "Failed to update item meta status",
      );
    }
  }

  private async upsertProcessedItemStatus(options: {
    processedItemId: string;
    rawItemId: string;
    itemMetaId: string;
    orgId: string;
    status: ItemStatus;
    error?: { message: string; name?: string; stack?: string };
  }) {
    if (
      !Types.ObjectId.isValid(options.processedItemId) ||
      !Types.ObjectId.isValid(options.rawItemId)
    ) {
      logger.warn(
        {
          processedItemId: options.processedItemId,
          rawItemId: options.rawItemId,
        },
        "Skipped processed item upsert due to invalid object id",
      );
      return;
    }

    const now = new Date();
    const processedId = new Types.ObjectId(options.processedItemId);
    const rawId = new Types.ObjectId(options.rawItemId);
    const update: Record<string, unknown> = {
      rawItemId: rawId,
      itemMetaId: options.itemMetaId,
      orgId: options.orgId,
      status: options.status,
      updatedAt: now,
      ...(options.error ? { error: options.error } : {}),
    };
    const unset: Record<string, 1> = {
      hasLocation: 1,
      result: 1,
      duplicateOf: 1,
      duplicateSimilarity: 1,
      summaryEmbedding: 1,
      summaryEmbeddingModel: 1,
    };
    if (!options.error) {
      unset.error = 1;
    }

    await ProcessedItemModel.updateOne(
      { _id: processedId },
      {
        $set: update,
        $unset: unset,
        $setOnInsert: {
          _id: processedId,
          createdAt: now,
          tags: [],
        },
      },
      { upsert: true },
    );
  }

  private async markProcessingState(options: {
    itemMetaId: string;
    rawItemId: string;
    orgId: string;
    processedItemId: string;
    pipelineJobId?: string;
    sourceId?: string;
  }) {
    const now = new Date();
    const actions: Promise<unknown>[] = [
      this.updateItemMetaStatus(options.itemMetaId, ItemStatus.Processing, {
        skipIfDuplicate: true,
      }),
      this.upsertProcessedItemStatus({
        processedItemId: options.processedItemId,
        rawItemId: options.rawItemId,
        itemMetaId: options.itemMetaId,
        orgId: options.orgId,
        status: ItemStatus.Processing,
      }),
    ];

    if (options.pipelineJobId) {
      actions.push(
        this.prisma.pipelineJob.updateMany({
          where: { id: options.pipelineJobId },
          data: {
            status: PipelineJobStatus.running,
            startedAt: now,
            error: null,
          },
        }),
      );
    }

    if (options.sourceId) {
      actions.push(
        this.prisma.newsSource.updateMany({
          where: { id: options.sourceId },
          data: { lastRunAt: now },
        }),
      );
    }

    try {
      await Promise.all(actions);
      if (options.sourceId && this.newsSourceOpsSnapshots) {
        await this.newsSourceOpsSnapshots.refreshSnapshotForSource(
          options.orgId,
          options.sourceId,
        );
      }
    } catch (error) {
      logger.warn(
        { error, itemMetaId: options.itemMetaId },
        "Failed to mark processing state",
      );
    }
  }

  private async markSuccessState(options: {
    itemMetaId: string;
    orgId: string;
    pipelineJobId?: string;
    sourceId?: string;
  }) {
    const now = new Date();
    const actions: Promise<unknown>[] = [];

    if (options.pipelineJobId) {
      actions.push(
        this.prisma.pipelineJob.updateMany({
          where: { id: options.pipelineJobId },
          data: {
            status: PipelineJobStatus.completed,
            completedAt: now,
            error: null,
          },
        }),
      );
    }

    if (options.sourceId) {
      actions.push(
        this.prisma.newsSource.updateMany({
          where: { id: options.sourceId },
          data: {
            lastSuccessAt: now,
            consecutiveFailures: 0,
            circuitOpenUntil: null,
          },
        }),
      );
    }

    try {
      await Promise.all(actions);
      if (options.sourceId && this.newsSourceOpsSnapshots) {
        await this.newsSourceOpsSnapshots.refreshSnapshotForSource(
          options.orgId,
          options.sourceId,
        );
      }
    } catch (error) {
      logger.warn(
        { error, itemMetaId: options.itemMetaId },
        "Failed to mark success state",
      );
    }
  }

  private computeExponentialBackoffDelay(
    baseDelayMs: number,
    attempt: number,
    maxDelayMs: number,
  ) {
    const normalizedAttempt = Math.max(1, Math.floor(attempt));
    const exponential = baseDelayMs * 2 ** Math.max(0, normalizedAttempt - 1);
    const capped = Math.min(exponential, maxDelayMs);
    const jitterFactor = 0.75 + Math.random() * 0.5;
    return Math.round(capped * jitterFactor);
  }

  private async markSourceFailureState(options: {
    sourceId: string;
    failureAt: Date;
  }) {
    const cfg = this.env.newsSourceSchedulerConfig;
    const threshold = Math.max(0, Math.floor(cfg.circuitBreakerThreshold));
    const autoDisableThresholdRaw = cfg.autoDisableThreshold;
    const autoDisableThreshold = Number.isFinite(autoDisableThresholdRaw)
      ? Math.max(0, Math.floor(autoDisableThresholdRaw))
      : 0;

    const { notifyCircuitOpen, notifyAutoDisable } =
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.newsSource.findUnique({
          where: { id: options.sourceId },
          select: {
            consecutiveFailures: true,
            isActive: true,
            orgId: true,
            name: true,
          },
        });
        if (!existing?.isActive) {
          return { notifyCircuitOpen: null, notifyAutoDisable: null };
        }

        const previousFailures = Number(existing.consecutiveFailures ?? 0);
        const consecutiveFailures = previousFailures + 1;

        const retryDelayMs = this.computeExponentialBackoffDelay(
          cfg.failureRecoveryDelayMs,
          consecutiveFailures,
          cfg.failureMaxDelayMs,
        );
        const retryAt = new Date(options.failureAt.getTime() + retryDelayMs);

        let circuitOpenUntil: Date | null = null;
        if (threshold > 0 && consecutiveFailures >= threshold) {
          const circuitAttempt = consecutiveFailures - threshold + 1;
          const circuitDelayMs = this.computeExponentialBackoffDelay(
            cfg.circuitBreakerBaseDelayMs,
            circuitAttempt,
            cfg.circuitBreakerMaxDelayMs,
          );
          circuitOpenUntil = new Date(
            options.failureAt.getTime() + circuitDelayMs,
          );
        }

        let notifyCircuitOpen: {
          orgId: string;
          name: string;
          circuitOpenUntil: Date;
        } | null = null;
        if (
          threshold > 0 &&
          consecutiveFailures === threshold &&
          circuitOpenUntil
        ) {
          notifyCircuitOpen = {
            orgId: existing.orgId,
            name: existing.name,
            circuitOpenUntil,
          };
        }

        const nextRunAt =
          circuitOpenUntil && circuitOpenUntil.getTime() > retryAt.getTime()
            ? circuitOpenUntil
            : retryAt;

        const shouldDisable =
          autoDisableThreshold > 0 &&
          consecutiveFailures >= autoDisableThreshold;
        let notifyAutoDisable: {
          orgId: string;
          name: string;
          failures: number;
        } | null = null;
        if (shouldDisable && consecutiveFailures === autoDisableThreshold) {
          notifyAutoDisable = {
            orgId: existing.orgId,
            name: existing.name,
            failures: consecutiveFailures,
          };
        }

        await tx.newsSource.update({
          where: { id: options.sourceId },
          data: {
            lastFailureAt: options.failureAt,
            consecutiveFailures,
            circuitOpenUntil,
            nextRunAt: shouldDisable ? null : nextRunAt,
            isActive: shouldDisable ? false : undefined,
          },
        });

        return { notifyCircuitOpen, notifyAutoDisable };
      });

    if (notifyCircuitOpen) {
      try {
        await this.notifications.notify({
          orgId: notifyCircuitOpen.orgId,
          userId: null,
          type: NotificationType.system,
          title: "News source circuit opened",
          body: `News source "${notifyCircuitOpen.name}" reached ${threshold} consecutive failures and is paused until ${notifyCircuitOpen.circuitOpenUntil.toISOString()}.`,
          data: {
            sourceId: options.sourceId,
            sourceName: notifyCircuitOpen.name,
            consecutiveFailures: threshold,
            circuitOpenUntil: notifyCircuitOpen.circuitOpenUntil.toISOString(),
            presentation: {
              kind: NotificationPresentationKind.NewsSourceCircuitOpened,
              params: {
                sourceId: options.sourceId,
                sourceName: notifyCircuitOpen.name,
                consecutiveFailures: threshold,
                circuitOpenUntil:
                  notifyCircuitOpen.circuitOpenUntil.toISOString(),
              },
            },
          },
        });
      } catch (error) {
        logger.warn(
          { error, sourceId: options.sourceId, orgId: notifyCircuitOpen.orgId },
          "Failed to notify circuit open for news source",
        );
      }
    }

    if (notifyAutoDisable) {
      try {
        await this.notifications.notify({
          orgId: notifyAutoDisable.orgId,
          userId: null,
          type: NotificationType.system,
          title: "News source disabled after failures",
          body: `News source "${notifyAutoDisable.name}" was disabled after ${notifyAutoDisable.failures} consecutive failures.`,
          data: {
            sourceId: options.sourceId,
            sourceName: notifyAutoDisable.name,
            consecutiveFailures: notifyAutoDisable.failures,
            presentation: {
              kind: NotificationPresentationKind.NewsSourceAutoDisabled,
              params: {
                sourceId: options.sourceId,
                sourceName: notifyAutoDisable.name,
                consecutiveFailures: notifyAutoDisable.failures,
              },
            },
          },
        });
      } catch (error) {
        logger.warn(
          { error, sourceId: options.sourceId, orgId: notifyAutoDisable.orgId },
          "Failed to notify auto-disable for news source",
        );
      }
    }
  }

  private async markFailureState(options: {
    itemMetaId?: string;
    rawItemId?: string;
    orgId: string;
    processedItemId?: string;
    pipelineJobId?: string;
    sourceId?: string;
    error: unknown;
    attemptsMade: number;
    finalFailure: boolean;
  }) {
    const now = new Date();
    const actions: Promise<unknown>[] = [];
    if (options.itemMetaId && options.finalFailure) {
      actions.push(
        this.updateItemMetaStatus(options.itemMetaId, ItemStatus.Failed, {
          skipIfDuplicate: true,
        }),
      );
    }
    if (options.processedItemId && options.rawItemId && options.itemMetaId) {
      actions.push(
        this.upsertProcessedItemStatus({
          processedItemId: options.processedItemId,
          rawItemId: options.rawItemId,
          itemMetaId: options.itemMetaId,
          orgId: options.orgId,
          status: ItemStatus.Failed,
          error: this.normalizeError(options.error),
        }),
      );
    }

    if (options.pipelineJobId) {
      actions.push(
        this.prisma.pipelineJob.updateMany({
          where: { id: options.pipelineJobId },
          data: {
            status: options.finalFailure
              ? PipelineJobStatus.failed
              : PipelineJobStatus.delayed,
            completedAt: options.finalFailure ? now : null,
            error: this.normalizeError(options.error).message,
            attempts: Math.max(options.attemptsMade, 0),
          },
        }),
      );
    }

    if (options.sourceId && options.finalFailure) {
      actions.push(
        this.markSourceFailureState({
          sourceId: options.sourceId,
          failureAt: now,
        }),
      );
    }

    try {
      await Promise.all(actions);
      if (options.sourceId && this.newsSourceOpsSnapshots) {
        await this.newsSourceOpsSnapshots.refreshSnapshotForSource(
          options.orgId,
          options.sourceId,
        );
      }
    } catch (error) {
      logger.warn(
        { error, itemMetaId: options.itemMetaId },
        "Failed to mark failure state",
      );
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.worker?.close(),
      this.queue.close(),
      this.dlqQueue.close(),
    ]);
  }
}
