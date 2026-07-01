import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Queue, QueueEvents } from "bullmq";

import { keepsFinishedJob } from "../../common/bullmq-retention";

import { QueueOrgStatsService, type TrackedJobStatus } from "./queue-org-stats.service";
import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "./queue.constants";

interface JobDataWithOrg { orgId?: string }

function keepFlagFromRemoveOption(value: unknown): boolean {
  return keepsFinishedJob(value as Parameters<typeof keepsFinishedJob>[0]);
}

@Injectable()
export class QueueOrgStatsTracker implements OnModuleDestroy {
  private readonly logger = createLogger({ name: "queue-org-stats" });

  private readonly handleWaiting = async ({ jobId }: { jobId: string }) => {
    await this.trackTransition(jobId, "waiting");
  };

  private readonly handleDelayed = async ({ jobId }: { jobId: string }) => {
    await this.trackTransition(jobId, "delayed");
  };

  private readonly handleActive = async ({ jobId }: { jobId: string }) => {
    await this.trackTransition(jobId, "active");
  };

  private readonly handleCompleted = async ({ jobId }: { jobId: string }) => {
    await this.trackTransition(jobId, "completed");
  };

  private readonly handleFailed = async ({ jobId }: { jobId: string }) => {
    await this.trackTransition(jobId, "failed");
  };

  private readonly handleRemoved = async ({ jobId }: { jobId: string }) => {
    await this.trackRemoval(jobId);
  };

  constructor(
    @Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    private readonly stats: QueueOrgStatsService,
  ) {
    this.events.on("waiting", this.handleWaiting);
    this.events.on("delayed", this.handleDelayed);
    this.events.on("active", this.handleActive);
    this.events.on("completed", this.handleCompleted);
    this.events.on("failed", this.handleFailed);
    this.events.on("removed", this.handleRemoved);
  }

  private async trackTransition(jobId: string, status: TrackedJobStatus) {
    try {
      const existingMeta = await this.stats.getJobMeta(jobId);
      if (existingMeta) {
        await this.stats.transitionJob(existingMeta, jobId, status);
        return;
      }

      const job = await this.queue.getJob(jobId);
      const orgId = (job?.data as JobDataWithOrg | undefined)?.orgId;
      if (!job || typeof orgId !== "string" || !orgId) {
        this.logger.debug({ jobId, status }, "Skipping org stats update without org context");
        return;
      }

      const keepCompleted = keepFlagFromRemoveOption(job.opts.removeOnComplete);
      const keepFailed = keepFlagFromRemoveOption(job.opts.removeOnFail);
      await this.stats.upsertJobMetaAndCount({
        jobId,
        orgId,
        status,
        keepCompleted,
        keepFailed,
      });
    } catch (error) {
      this.logger.error({ jobId, status, error }, "Failed to update org queue stats");
    }
  }

  private async trackRemoval(jobId: string) {
    try {
      const existingMeta = await this.stats.getJobMeta(jobId);
      if (!existingMeta) {
        return;
      }
      await this.stats.removeJob(existingMeta.orgId, jobId);
    } catch (error) {
      this.logger.error({ jobId, error }, "Failed to remove org stats for job");
    }
  }

  async onModuleDestroy() {
    this.events.off("waiting", this.handleWaiting);
    this.events.off("delayed", this.handleDelayed);
    this.events.off("active", this.handleActive);
    this.events.off("completed", this.handleCompleted);
    this.events.off("failed", this.handleFailed);
    this.events.off("removed", this.handleRemoved);
  }
}
