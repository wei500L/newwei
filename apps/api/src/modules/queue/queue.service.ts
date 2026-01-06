import { TaskLogModel } from "@modular/mongo";
import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import { Queue, JobsOptions } from "bullmq";
import { Types } from "mongoose";

import { QueueOrgStatsService, type TrackedJobStatus } from "./queue-org-stats.service";
import { ITEM_PIPELINE_QUEUE_NAME, PIPELINE_QUEUE } from "./queue.constants";

interface PipelineJobMeta {
  pipelineJobId?: string;
  sourceId?: string;
  processedItemId?: string;
}

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
  private async getOrgJobCounts(orgId: string): Promise<Record<TrackedJobStatus, number>> {
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
    meta: PipelineJobMeta = {}
  ) {
    const jobId = `${itemMetaId}:${rawItemId}`;
    const traceId = ensureTraceId(getCurrentTraceId());
    const processedItemId =
      typeof meta.processedItemId === "string" && meta.processedItemId.length > 0
        ? meta.processedItemId
        : new Types.ObjectId().toHexString();
    const job = await this.queue.add(
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
        removeOnFail: false,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        ...opts
      }
    );

    const delay = typeof opts.delay === "number" ? opts.delay : 0;
    const status: TrackedJobStatus = delay > 0 ? "delayed" : "waiting";
    const removeOnComplete = (opts.removeOnComplete ?? true) as unknown;
    const removeOnFail = (opts.removeOnFail ?? false) as unknown;
    const keepCompleted = removeOnComplete !== true;
    const keepFailed = removeOnFail !== true;
    try {
      await this.orgStats.upsertJobMetaAndCount({ jobId, orgId, status, keepCompleted, keepFailed });
    } catch (error) {
      this.logger.warn({ jobId, orgId, error }, "Failed to record initial org queue counters");
    }

    return job;
  }

  async stats(orgId: string) {
    const [jobCounts, logs] = await Promise.all([
      this.getOrgJobCounts(orgId),
      TaskLogModel.find({ orgId, queue: ITEM_PIPELINE_QUEUE_NAME })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
    ]);

    return {
      counts: {
        waiting: jobCounts.waiting,
        active: jobCounts.active,
        completed: jobCounts.completed,
        failed: jobCounts.failed,
        delayed: jobCounts.delayed
      },
      recentLogs: logs
    };
  }
}
