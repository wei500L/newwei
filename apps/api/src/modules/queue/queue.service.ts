import { TaskLogModel } from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";
import { Queue, JobsOptions } from "bullmq";

import { PIPELINE_QUEUE, ITEM_PIPELINE_QUEUE_NAME } from "./queue.module";

@Injectable()
export class QueueService {
  constructor(@Inject(PIPELINE_QUEUE) private readonly queue: Queue) {}

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
      this.queue.getJobCounts(),
      TaskLogModel.find({ orgId, queue: ITEM_PIPELINE_QUEUE_NAME })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
    ]);

    return {
      counts: {
        waiting: jobCounts.waiting ?? 0,
        active: jobCounts.active ?? 0,
        completed: jobCounts.completed ?? 0,
        failed: jobCounts.failed ?? 0,
        delayed: jobCounts.delayed ?? 0
      },
      recentLogs: logs
    };
  }
}
