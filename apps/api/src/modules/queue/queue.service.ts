import { ProcessedItemModel, TaskLogModel } from "@modular/mongo";
import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import { Queue, JobsOptions, type Job } from "bullmq";
import { Types } from "mongoose";

import {
  BULLMQ_FAILED_JOB_RETENTION,
  keepsFinishedJob,
} from "../../common/bullmq-retention";

import {
  QueueOrgStatsService,
  type TrackedJobStatus,
} from "./queue-org-stats.service";
import { ITEM_PIPELINE_QUEUE_NAME, PIPELINE_QUEUE } from "./queue.constants";

interface PipelineJobMeta {
  pipelineJobId?: string;
  sourceId?: string;
  processedItemId?: string;
}

interface EnqueueItemBehavior {
  retryIfFailed?: boolean;
}

export interface QueueRecentLog {
  createdAt?: Date;
  jobId?: string;
  message?: string | null;
  stage?: string;
  status?: string;
}

export interface QueueStatsSnapshot {
  counts: Record<TrackedJobStatus, number>;
  recentLogs: QueueRecentLog[];
}

const RECENT_QUEUE_LOG_PROJECTION = {
  _id: 0,
  createdAt: 1,
  jobId: 1,
  message: 1,
  stage: 1,
  status: 1,
} as const;

@Injectable()
export class QueueService {
  private readonly logger = createLogger({ name: "queue-service" });

  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    private readonly orgStats: QueueOrgStatsService,
  ) {}

  /**
   * BullMQ counters are global; we keep org-scoped counters in Redis via QueueEvents.
   */
  private async getOrgJobCounts(
    orgId: string,
  ): Promise<Record<TrackedJobStatus, number>> {
    try {
      return await this.orgStats.getCounts(orgId);
    } catch (error) {
      this.logger.error({ orgId, error }, "Failed to load org queue counters");
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }
  }

  async enqueueItem(
    orgId: string,
    itemMetaId: string,
    rawItemId: string,
    opts: JobsOptions = {},
    meta: PipelineJobMeta = {},
    behavior: EnqueueItemBehavior = {},
  ) {
    const jobId = `${itemMetaId}-${rawItemId}`;
    const traceId = ensureTraceId(getCurrentTraceId());
    const processedItemId =
      typeof meta.processedItemId === "string" &&
      meta.processedItemId.length > 0
        ? meta.processedItemId
        : new Types.ObjectId().toHexString();

    let job: Job;
    try {
      job = await this.queue.add(
        "process-item",
        {
          itemMetaId,
          rawItemId,
          orgId,
          traceId,
          processedItemId,
          pipelineJobId: meta.pipelineJobId,
          sourceId: meta.sourceId,
        },
        {
          jobId,
          removeOnComplete: true,
          removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
          attempts: 5,
          backoff: { type: "exponential", delay: 2000 },
          ...opts,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        const existing = await this.queue.getJob(jobId);
        if (existing) {
          if (behavior.retryIfFailed) {
            try {
              const state = await existing.getState();
              if (state === "failed") {
                await existing.retry();
              }
            } catch (retryError) {
              this.logger.warn(
                { retryError, orgId, itemMetaId, rawItemId, jobId },
                "Failed to retry existing failed queue job",
              );
            }
          }
          return existing;
        }
      }
      throw error;
    }

    const now = new Date();
    try {
      if (
        Types.ObjectId.isValid(processedItemId) &&
        Types.ObjectId.isValid(rawItemId)
      ) {
        await ProcessedItemModel.updateOne(
          { _id: new Types.ObjectId(processedItemId) },
          {
            $set: {
              traceId,
              pipelineJobId: meta.pipelineJobId ?? null,
              sourceId: meta.sourceId ?? null,
              updatedAt: now,
            },
            $setOnInsert: {
              _id: new Types.ObjectId(processedItemId),
              rawItemId: new Types.ObjectId(rawItemId),
              itemMetaId,
              orgId,
              status: "pending",
              tags: [],
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }
    } catch (error) {
      this.logger.warn(
        { error, orgId, itemMetaId, rawItemId, processedItemId },
        "Failed to upsert pending processed item",
      );
    }

    const delay = typeof opts.delay === "number" ? opts.delay : 0;
    const status: TrackedJobStatus = delay > 0 ? "delayed" : "waiting";
    const removeOnComplete = opts.removeOnComplete ?? true;
    const removeOnFail = opts.removeOnFail ?? BULLMQ_FAILED_JOB_RETENTION;
    const keepCompleted = keepsFinishedJob(removeOnComplete);
    const keepFailed = keepsFinishedJob(removeOnFail);
    try {
      await this.orgStats.upsertJobMetaAndCount({
        jobId,
        orgId,
        status,
        keepCompleted,
        keepFailed,
      });
    } catch (error) {
      this.logger.warn(
        { jobId, orgId, error },
        "Failed to record initial org queue counters",
      );
    }

    return job;
  }

  async stats(orgId: string): Promise<QueueStatsSnapshot> {
    const [jobCounts, logs] = await Promise.all([
      this.getOrgJobCounts(orgId),
      TaskLogModel.find({ orgId, queue: ITEM_PIPELINE_QUEUE_NAME })
        .select(RECENT_QUEUE_LOG_PROJECTION)
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    return {
      counts: {
        waiting: jobCounts.waiting,
        active: jobCounts.active,
        completed: jobCounts.completed,
        failed: jobCounts.failed,
        delayed: jobCounts.delayed,
      },
      recentLogs: logs,
    };
  }
}
