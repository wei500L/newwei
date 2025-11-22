import { TaskLogModel } from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";
import { Queue, JobsOptions, JobType } from "bullmq";

import { PIPELINE_QUEUE, ITEM_PIPELINE_QUEUE_NAME } from "./queue.module";

type TrackedJobStatus = Extract<JobType, "waiting" | "active" | "completed" | "failed" | "delayed">;

@Injectable()
export class QueueService {
  constructor(@Inject(PIPELINE_QUEUE) private readonly queue: Queue) {}

  /**
   * BullMQ counters are global; we need to filter by orgId manually.
   */
  private async getOrgJobCounts(orgId: string): Promise<Record<TrackedJobStatus, number>> {
    const trackedStatuses: TrackedJobStatus[] = ["waiting", "active", "completed", "failed", "delayed"];
    const jobsByStatus = await Promise.all(
      trackedStatuses.map((status) => this.queue.getJobs(status, 0, -1, true))
    );

    return trackedStatuses.reduce<Record<TrackedJobStatus, number>>(
      (counts, status, index) => {
        counts[status] = jobsByStatus[index].filter(
          (job) => (job.data as { orgId?: string }).orgId === orgId
        ).length;
        return counts;
      },
      { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
    );
  }

  async enqueueItem(orgId: string, itemMetaId: string, rawItemId: string, opts: JobsOptions = {}) {
    const jobId = `${itemMetaId}:${rawItemId}`;
    return this.queue.add(
      "process-item",
      { itemMetaId, rawItemId, orgId },
      {
        jobId,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        ...opts
      }
    );
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
