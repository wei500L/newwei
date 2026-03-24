import { AssistantRunModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Queue, QueueEvents } from "bullmq";

import { ASSISTANT_QUEUE, ASSISTANT_QUEUE_EVENTS } from "./assistant.constants";
import type { AssistantJobPayload } from "./assistant.types";

export interface AssistantQueueEventPayload {
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type AssistantQueueEventListener = (orgId: string, payload: AssistantQueueEventPayload) => Promise<void> | void;

interface OrgCacheEntry {
  orgId: string;
  expiresAt: number;
}

@Injectable()
export class AssistantQueueEventPublisher implements OnModuleDestroy {
  private readonly listeners = new Set<AssistantQueueEventListener>();
  private readonly logger = createLogger({ name: "assistant-queue-events" });
  private readonly orgCache = new Map<string, OrgCacheEntry>();
  private readonly orgCacheTtlMs = 10 * 60_000;
  private readonly orgCachePruneIntervalMs = 60_000;
  private lastPruneAt = 0;

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
    this.deleteCachedOrgId(jobId);
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
    this.deleteCachedOrgId(jobId);
  };

  constructor(
    @Inject(ASSISTANT_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(ASSISTANT_QUEUE) private readonly queue: Queue<AssistantJobPayload>
  ) {
    this.events.on("active", this.handleActive);
    this.events.on("progress", this.handleProgress);
    this.events.on("completed", this.handleCompleted);
    this.events.on("failed", this.handleFailed);
  }

  registerListener(listener: AssistantQueueEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(jobId: string, event: string, data?: Record<string, unknown>) {
    try {
      const orgId = await this.resolveOrgId(jobId);
      if (!orgId) {
        this.logger.debug({ jobId, event }, "Skipping assistant queue event without org context");
        return;
      }

      const payload: AssistantQueueEventPayload = {
        event,
        jobId,
        data,
        timestamp: new Date().toISOString()
      };

      await this.dispatchToListeners(orgId, payload);
    } catch (error) {
      this.logger.error({ jobId, event, error }, "Failed to publish assistant queue event");
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

      const runId = (job?.data as { runId?: unknown } | undefined)?.runId;
      if (typeof runId === "string" && runId.length > 0) {
        const orgIdFromRecord = await this.lookupOrgIdFromRunId(runId);
        if (orgIdFromRecord) {
          this.setCachedOrgId(jobId, orgIdFromRecord);
          return orgIdFromRecord;
        }
      }
    } catch (error) {
      this.logger.debug({ jobId, error }, "Failed to resolve assistant queue orgId from job");
    }

    const inferredRunId = this.inferRunIdFromJobId(jobId);
    if (inferredRunId) {
      const orgIdFromRecord = await this.lookupOrgIdFromRunId(inferredRunId);
      if (orgIdFromRecord) {
        this.setCachedOrgId(jobId, orgIdFromRecord);
        return orgIdFromRecord;
      }
    }

    return cached;
  }

  private inferRunIdFromJobId(jobId: string): string | null {
    const match = jobId.match(/^assistant:(query|report|forecast):(.+)$/);
    if (!match) {
      return null;
    }
    const runId = match[2]?.trim() ?? "";
    return runId.length > 0 ? runId : null;
  }

  private async lookupOrgIdFromRunId(runId: string): Promise<string | null> {
    try {
      const record = await AssistantRunModel.findById(runId, { orgId: 1 }).lean();
      const orgId = (record as { orgId?: unknown } | null)?.orgId;
      return typeof orgId === "string" && orgId.length > 0 ? orgId : null;
    } catch (error) {
      this.logger.debug({ runId, error }, "Failed to resolve assistant orgId");
      return null;
    }
  }

  private setCachedOrgId(jobId: string, orgId: string) {
    const now = Date.now();
    this.pruneExpiredOrgCacheIfDue(now);
    this.orgCache.set(jobId, { orgId, expiresAt: now + this.orgCacheTtlMs });
  }

  private getCachedOrgId(jobId: string): string | null {
    const now = Date.now();
    this.pruneExpiredOrgCacheIfDue(now);
    const cached = this.orgCache.get(jobId);
    if (!cached) {
      return null;
    }
    if (now >= cached.expiresAt) {
      this.orgCache.delete(jobId);
      return null;
    }
    return cached.orgId;
  }

  private deleteCachedOrgId(jobId: string) {
    this.orgCache.delete(jobId);
  }

  private pruneExpiredOrgCacheIfDue(now: number) {
    if (now - this.lastPruneAt < this.orgCachePruneIntervalMs) {
      return;
    }

    for (const [jobId, entry] of this.orgCache) {
      if (entry.expiresAt <= now) {
        this.orgCache.delete(jobId);
      }
    }
    this.lastPruneAt = now;
  }

  private async dispatchToListeners(orgId: string, payload: AssistantQueueEventPayload) {
    for (const listener of this.listeners) {
      try {
        await listener(orgId, payload);
      } catch (error) {
        this.logger.error({ orgId, error }, "Assistant queue event listener failed");
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
