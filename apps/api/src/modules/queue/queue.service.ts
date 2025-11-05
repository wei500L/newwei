import { Inject, Injectable } from "@nestjs/common";
import { Queue, JobsOptions, QueueEvents } from "bullmq";
import { TaskLogModel } from "@modular/mongo";
import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "./queue.module";

@Injectable()
export class QueueService {
  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    @Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async enqueueItem(itemMetaId: string, rawItemId: string, opts: JobsOptions = {}) {
    const jobId = `${itemMetaId}:${rawItemId}`;
    return this.queue.add(
      "process-item",
      { itemMetaId, rawItemId },
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

  async stats() {
    const counts = await this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    const logs = await TaskLogModel.find().sort({ createdAt: -1 }).limit(10).lean();
    return {
      counts,
      recentLogs: logs
    };
  }

  getQueueEvents() {
    return this.events;
  }
}
