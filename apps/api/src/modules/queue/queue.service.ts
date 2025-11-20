import { TaskLogModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Queue, JobsOptions, QueueEvents } from "bullmq";
import type Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.module";
import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS, ITEM_PIPELINE_QUEUE_NAME } from "./queue.module";

const logger = createLogger({ name: "queue-service" });

type QueueJobStatus = "waiting" | "active" | "completed" | "failed" | "delayed";

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly jobStateTtlSeconds = 60 * 60 * 24 * 2; // keep state for removals/cleanup

  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    @Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  onModuleInit() {
    this.bindQueueEventHandlers();
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
    const counts = await this.getOrgCounts(orgId);
    const logs = await TaskLogModel.find({ orgId, queue: ITEM_PIPELINE_QUEUE_NAME })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    return {
      counts,
      recentLogs: logs
    };
  }

  getQueueEvents() {
    return this.events;
  }

  private bindQueueEventHandlers() {
    this.events.on("waiting", ({ jobId, prev }) => {
      void this.recordJobStatus(jobId, "waiting", prev);
    });
    this.events.on("active", ({ jobId, prev }) => {
      void this.recordJobStatus(jobId, "active", prev);
    });
    this.events.on("completed", ({ jobId, prev }) => {
      void this.recordJobStatus(jobId, "completed", prev);
    });
    this.events.on("failed", ({ jobId, prev }) => {
      void this.recordJobStatus(jobId, "failed", prev);
    });
    this.events.on("delayed", ({ jobId }) => {
      void this.recordJobStatus(jobId, "delayed");
    });
    this.events.on("removed", ({ jobId, prev }) => {
      void this.recordJobStatus(jobId, null, prev);
    });
  }

  private async recordJobStatus(jobId: string, nextStatus: QueueJobStatus | null, eventPrev?: string) {
    try {
      const stored = await this.getStoredJobState(jobId);
      const orgId = stored?.orgId ?? (await this.getJobOrg(jobId));
      if (!orgId) {
        return;
      }
      const previousStatus = stored?.status ?? this.asTrackedStatus(eventPrev);
      await this.persistCounters(jobId, orgId, previousStatus, nextStatus);
    } catch (err) {
      logger.error({ err, jobId, nextStatus }, "Failed to update queue counters");
    }
  }

  private async getOrgCounts(orgId: string) {
    const key = this.orgCounterKey(orgId);
    const rawCounts = await this.redis.hgetall(key);
    if (Object.keys(rawCounts).length === 0) {
      const hydrated = await this.hydrateCounts(orgId);
      if (hydrated) {
        return hydrated;
      }
    }
    return {
      waiting: Number(rawCounts.waiting ?? 0),
      active: Number(rawCounts.active ?? 0),
      completed: Number(rawCounts.completed ?? 0),
      failed: Number(rawCounts.failed ?? 0),
      delayed: Number(rawCounts.delayed ?? 0)
    };
  }

  private async hydrateCounts(orgId: string) {
    const counts: Record<QueueJobStatus, number> = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0
    };
    const statuses: QueueJobStatus[] = ["waiting", "active", "completed", "failed", "delayed"];
    await Promise.all(
      statuses.map(async (status) => {
        // Limit to recent jobs; queue defaults already prune completed items.
        const jobs = await this.queue.getJobs([status], 0, 500, false);
        counts[status] = jobs.filter((job) => job.data?.orgId === orgId).length;
      })
    );
    await this.redis.hset(this.orgCounterKey(orgId), {
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed
    });
    return counts;
  }

  private async persistCounters(
    jobId: string,
    orgId: string,
    prevStatus?: QueueJobStatus | null,
    nextStatus?: QueueJobStatus | null
  ) {
    if (prevStatus === nextStatus && nextStatus) {
      await this.redis.set(
        this.jobStateKey(jobId),
        JSON.stringify({ orgId, status: nextStatus }),
        "EX",
        this.jobStateTtlSeconds
      );
      return;
    }
    const pipeline = this.redis.multi();
    if (prevStatus) {
      pipeline.hincrby(this.orgCounterKey(orgId), prevStatus, -1);
    }
    if (nextStatus) {
      pipeline.hincrby(this.orgCounterKey(orgId), nextStatus, 1);
      pipeline.set(
        this.jobStateKey(jobId),
        JSON.stringify({ orgId, status: nextStatus }),
        "EX",
        this.jobStateTtlSeconds
      );
    } else {
      pipeline.del(this.jobStateKey(jobId));
    }
    await pipeline.exec();
  }

  private asTrackedStatus(status?: string | null): QueueJobStatus | undefined {
    if (!status) {
      return undefined;
    }
    if (status === "waiting-children") {
      return "waiting";
    }
    const tracked: QueueJobStatus[] = ["waiting", "active", "completed", "failed", "delayed"];
    return tracked.includes(status as QueueJobStatus) ? (status as QueueJobStatus) : undefined;
  }

  private async getStoredJobState(jobId: string) {
    const raw = await this.redis.get(this.jobStateKey(jobId));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { orgId: string; status: QueueJobStatus };
      return parsed;
    } catch {
      return null;
    }
  }

  private async getJobOrg(jobId: string) {
    const job = await this.queue.getJob(jobId);
    const orgId = (job?.data as { orgId?: string } | undefined)?.orgId;
    return orgId ?? null;
  }

  private orgCounterKey(orgId: string) {
    return `queue:stats:${ITEM_PIPELINE_QUEUE_NAME}:${orgId}`;
  }

  private jobStateKey(jobId: string) {
    return `queue:job-state:${ITEM_PIPELINE_QUEUE_NAME}:${jobId}`;
  }
}
