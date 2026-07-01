import { createLogger } from "@modular/utils";
import type { OnModuleDestroy } from "@nestjs/common";
import type { Job, JobType, KeepJobs, Queue } from "bullmq";

import {
  BULLMQ_FAILED_JOB_RETENTION,
  BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE,
  BULLMQ_RETAINED_JOB_CLEAN_INTERVAL_MS,
  BULLMQ_RETAINED_JOB_CLEAN_MAX_BATCHES,
} from "./bullmq-retention";

interface Closeable {
  close?: () => Promise<unknown> | void;
}

type CleanableQueue = Closeable &
  Pick<Queue, "clean" | "getFailedCount" | "getJobCounts" | "getJobs"> & {
    name?: string;
  };

export interface BullmqQueueCleanupProfile {
  failedRetention?: KeepJobs;
  waitingRetention?: KeepJobs;
}

type TrackedCleanupProfile = BullmqQueueCleanupProfile | false | undefined;

const logger = createLogger({ name: "bullmq-queue-cleanup" });

export class BullmqQueueCleanupService implements OnModuleDestroy {
  private readonly resources = new Map<Closeable, TrackedCleanupProfile>();
  private interval?: ReturnType<typeof setInterval>;
  private immediate?: ReturnType<typeof setTimeout>;
  private cleanupRunning = false;

  track<T extends Closeable>(
    resource: T,
    profile?: TrackedCleanupProfile,
  ): T {
    this.resources.set(resource, profile);
    if (this.resolveProfile(resource, profile)) {
      this.ensureCleanupTimer();
      this.scheduleImmediateCleanup();
    }
    return resource;
  }

  async cleanTrackedQueues(): Promise<void> {
    if (this.cleanupRunning) {
      return;
    }

    this.cleanupRunning = true;
    try {
      await Promise.all(
        Array.from(this.resources.entries()).map(([resource, profile]) =>
          this.cleanResource(resource, profile),
        ),
      );
    } finally {
      this.cleanupRunning = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.immediate) {
      clearTimeout(this.immediate);
      this.immediate = undefined;
    }

    const tasks = Array.from(this.resources.keys()).map(async (resource) => {
      if (typeof resource.close !== "function") {
        return;
      }
      try {
        await resource.close();
      } catch {
        // best-effort cleanup
      }
    });

    this.resources.clear();
    await Promise.allSettled(tasks);
  }

  private ensureCleanupTimer(): void {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.cleanTrackedQueues();
    }, BULLMQ_RETAINED_JOB_CLEAN_INTERVAL_MS);
    this.interval.unref?.();
  }

  private scheduleImmediateCleanup(): void {
    if (this.immediate) {
      return;
    }
    this.immediate = setTimeout(() => {
      this.immediate = undefined;
      void this.cleanTrackedQueues();
    }, 0);
    this.immediate.unref?.();
  }

  private resolveProfile(
    resource: Closeable,
    profile: TrackedCleanupProfile,
  ): BullmqQueueCleanupProfile | null {
    if (profile === false || !this.isCleanableQueue(resource)) {
      return null;
    }
    return {
      failedRetention: BULLMQ_FAILED_JOB_RETENTION,
      ...profile,
    };
  }

  private isCleanableQueue(resource: Closeable): resource is CleanableQueue {
    return (
      typeof (resource as Partial<CleanableQueue>).clean === "function" &&
      typeof (resource as Partial<CleanableQueue>).getJobs === "function"
    );
  }

  private async cleanResource(
    resource: Closeable,
    profile: TrackedCleanupProfile,
  ): Promise<void> {
    const resolved = this.resolveProfile(resource, profile);
    if (!resolved || !this.isCleanableQueue(resource)) {
      return;
    }

    await Promise.all([
      resolved.failedRetention
        ? this.cleanState(resource, "failed", resolved.failedRetention)
        : Promise.resolve(),
      resolved.waitingRetention
        ? this.cleanState(resource, "waiting", resolved.waitingRetention)
        : Promise.resolve(),
    ]);
  }

  private async cleanState(
    queue: CleanableQueue,
    state: "failed" | "waiting",
    retention: KeepJobs,
  ): Promise<void> {
    try {
      await this.cleanByAge(queue, state, retention);
      await this.trimByCount(queue, state, retention);
    } catch (error) {
      logger.warn(
        { error, queue: queue.name, state },
        "Failed to clean retained BullMQ jobs",
      );
    }
  }

  private async cleanByAge(
    queue: CleanableQueue,
    state: "failed" | "waiting",
    retention: KeepJobs,
  ): Promise<void> {
    if (!retention.age || retention.age <= 0) {
      return;
    }

    const graceMs = retention.age * 1000;
    for (let batch = 0; batch < BULLMQ_RETAINED_JOB_CLEAN_MAX_BATCHES; batch += 1) {
      const removed = await queue.clean(
        graceMs,
        BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE,
        state,
      );
      if (removed.length < BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE) {
        break;
      }
    }
  }

  private async trimByCount(
    queue: CleanableQueue,
    state: "failed" | "waiting",
    retention: KeepJobs,
  ): Promise<void> {
    if (retention.count === undefined || retention.count < 0) {
      return;
    }

    const currentCount = await this.getStateCount(queue, state);
    const excess = currentCount - retention.count;
    if (excess <= 0) {
      return;
    }

    let remaining = Math.min(
      excess,
      BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE *
        BULLMQ_RETAINED_JOB_CLEAN_MAX_BATCHES,
    );
    const jobType: JobType = state;
    while (remaining > 0) {
      const batchSize = Math.min(
        remaining,
        BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE,
      );
      const jobs = (await queue.getJobs(
        [jobType],
        0,
        batchSize - 1,
        true,
      )) as Job[];
      if (jobs.length === 0) {
        break;
      }
      await Promise.allSettled(jobs.map((job) => job.remove()));
      remaining -= jobs.length;
    }
  }

  private async getStateCount(
    queue: CleanableQueue,
    state: "failed" | "waiting",
  ): Promise<number> {
    if (state === "failed") {
      return queue.getFailedCount();
    }
    const counts = await queue.getJobCounts("waiting");
    return counts.waiting ?? 0;
  }
}
