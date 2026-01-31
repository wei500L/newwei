import { AnalysisResultModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Queue, QueueEvents } from "bullmq";

import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS } from "./analysis.constants";
import type { AnalysisJobPayload } from "./analysis.types";

export interface AnalysisQueueEventPayload {
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type AnalysisQueueEventListener = (orgId: string, payload: AnalysisQueueEventPayload) => Promise<void> | void;

interface OrgCacheEntry {
  orgId: string;
  expiresAt: number;
}

@Injectable()
export class AnalysisQueueEventPublisher implements OnModuleDestroy {
  private readonly listeners = new Set<AnalysisQueueEventListener>();
  private readonly logger = createLogger({ name: "analysis-queue-events" });
  private readonly orgCache = new Map<string, OrgCacheEntry>();
  private readonly orgCacheTtlMs = 10 * 60_000;

  private readonly handleCompleted = async ({
    jobId,
    returnvalue
  }: {
    jobId: string;
    returnvalue?: unknown;
  }) => {
    const completedData =
      returnvalue && typeof returnvalue === "object" && !Array.isArray(returnvalue)
        ? (returnvalue as Record<string, unknown>)
        : returnvalue !== undefined
          ? { returnvalue }
          : undefined;
    await this.emit(jobId, "COMPLETED", completedData);
  };

  private readonly handleActive = async ({
    jobId,
    prev
  }: {
    jobId: string;
    prev?: string | null;
  }) => {
    await this.emit(jobId, "ACTIVE", prev ? { prev } : undefined);
  };

  private readonly handleProgress = async ({
    jobId,
    data
  }: {
    jobId: string;
    data?: unknown;
  }) => {
    const progressData =
      data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : data !== undefined
          ? { progress: data }
          : undefined;
    await this.emit(jobId, "PROGRESS", progressData);
  };

  private readonly handleFailed = async ({
    jobId,
    failedReason
  }: {
    jobId: string;
    failedReason?: string;
  }) => {
    await this.emit(jobId, "FAILED", failedReason ? { reason: failedReason } : undefined);
  };

  constructor(
    @Inject(ANALYSIS_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJobPayload>
  ) {
    this.events.on("active", this.handleActive);
    this.events.on("progress", this.handleProgress);
    this.events.on("completed", this.handleCompleted);
    this.events.on("failed", this.handleFailed);
  }

  registerListener(listener: AnalysisQueueEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(jobId: string, event: string, data?: Record<string, unknown>) {
    try {
      const orgId = await this.resolveOrgId(jobId);
      if (!orgId) {
        this.logger.debug({ jobId, event }, "Skipping analysis queue event without org context");
        return;
      }

      const payload: AnalysisQueueEventPayload = {
        event,
        jobId,
        data,
        timestamp: new Date().toISOString()
      };

      await this.dispatchToListeners(orgId, payload);
    } catch (error) {
      this.logger.error({ jobId, event, error }, "Failed to publish analysis queue event");
    }
  }

  private async resolveOrgId(jobId: string): Promise<string | null> {
    const cached = this.getCachedOrgId(jobId);

    try {
      const job = await this.queue.getJob(jobId);
      const orgId = (job?.data as { orgId?: unknown } | undefined)?.orgId;
      if (typeof orgId === "string" && orgId.length > 0) {
        this.setCachedOrgId(jobId, orgId);
        return orgId;
      }

      const analysisId = (job?.data as { analysisId?: unknown } | undefined)?.analysisId;
      if (typeof analysisId === "string" && analysisId.length > 0) {
        const orgIdFromRecord = await this.lookupOrgIdFromAnalysisId(analysisId);
        if (orgIdFromRecord) {
          this.setCachedOrgId(jobId, orgIdFromRecord);
          return orgIdFromRecord;
        }
      }
    } catch (error) {
      this.logger.debug({ jobId, error }, "Failed to resolve analysis queue orgId from job");
    }

    const inferredAnalysisId = this.inferAnalysisIdFromJobId(jobId);
    if (inferredAnalysisId) {
      const orgIdFromRecord = await this.lookupOrgIdFromAnalysisId(inferredAnalysisId);
      if (orgIdFromRecord) {
        this.setCachedOrgId(jobId, orgIdFromRecord);
        return orgIdFromRecord;
      }
    }

    return cached;
  }

  private inferAnalysisIdFromJobId(jobId: string): string | null {
    if (jobId.startsWith("corr-")) {
      const id = jobId.slice(5);
      return id.length > 0 ? id : null;
    }
    if (jobId.startsWith("anomaly-")) {
      const id = jobId.slice(8);
      return id.length > 0 ? id : null;
    }
    return null;
  }

  private async lookupOrgIdFromAnalysisId(analysisId: string): Promise<string | null> {
    try {
      const record = await AnalysisResultModel.findById(analysisId, { orgId: 1 }).lean();
      const orgId = (record as { orgId?: unknown } | null)?.orgId;
      return typeof orgId === "string" && orgId.length > 0 ? orgId : null;
    } catch (error) {
      this.logger.debug({ analysisId, error }, "Failed to resolve analysis orgId");
      return null;
    }
  }

  private setCachedOrgId(jobId: string, orgId: string) {
    this.orgCache.set(jobId, { orgId, expiresAt: Date.now() + this.orgCacheTtlMs });
  }

  private getCachedOrgId(jobId: string): string | null {
    const cached = this.orgCache.get(jobId);
    if (!cached) {
      return null;
    }
    if (Date.now() >= cached.expiresAt) {
      this.orgCache.delete(jobId);
      return null;
    }
    return cached.orgId;
  }

  private async dispatchToListeners(orgId: string, payload: AnalysisQueueEventPayload) {
    for (const listener of this.listeners) {
      try {
        await listener(orgId, payload);
      } catch (error) {
        this.logger.error({ orgId, error }, "Analysis queue event listener failed");
      }
    }
  }

  async onModuleDestroy() {
    this.events.off("active", this.handleActive);
    this.events.off("progress", this.handleProgress);
    this.events.off("completed", this.handleCompleted);
    this.events.off("failed", this.handleFailed);
    this.listeners.clear();
    this.orgCache.clear();
  }
}

