import { Inject, Injectable } from "@nestjs/common";
import { Queue, JobsOptions, QueueEvents, type JobType } from "bullmq";
import { TaskLogModel } from "@modular/mongo";
import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS, ITEM_PIPELINE_QUEUE_NAME } from "./queue.module";

@Injectable()
export class QueueService {
  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    @Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

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
    const counts = await this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    const logs = await TaskLogModel.find({ orgId, queue: ITEM_PIPELINE_QUEUE_NAME })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    return {
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0
      },
      recentLogs: logs
    };
  }

  getQueueEvents() {
    return this.events;
  }
}
