import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { type Queue, type QueueEvents } from "bullmq";

import { CRAWL_QUEUE, CRAWL_QUEUE_EVENTS } from "./crawl.constants";
import type { CrawlJobData } from "./crawl.types";

export interface CrawlQueueEventPayload {
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type CrawlQueueEventListener = (orgId: string, payload: CrawlQueueEventPayload) => Promise<void> | void;

interface OrgCacheEntry {
  orgId: string;
  expiresAt: number;
}

@Injectable()
export class CrawlQueueEventPublisher implements OnModuleDestroy {
  private readonly listeners = new Set<CrawlQueueEventListener>();
  private readonly logger = createLogger({ name: "crawl-queue-events" });
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
    @Inject(CRAWL_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(CRAWL_QUEUE) private readonly queue: Queue<CrawlJobData>
  ) {
    this.events.on("active", this.handleActive);
    this.events.on("progress", this.handleProgress);
    this.events.on("completed", this.handleCompleted);
    this.events.on("failed", this.handleFailed);
  }

  registerListener(listener: CrawlQueueEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(jobId: string, event: string, data?: Record<string, unknown>) {
    try {
      const orgId = await this.resolveOrgId(jobId);
      if (!orgId) {
        this.logger.debug({ jobId, event }, "Skipping crawl queue event without org context");
        return;
      }

      const payload: CrawlQueueEventPayload = {
        event,
        jobId,
        data,
        timestamp: new Date().toISOString()
      };

      await this.dispatchToListeners(orgId, payload);
    } catch (error) {
      this.logger.error({ jobId, event, error }, "Failed to publish crawl queue event");
    }
  }

  private async resolveOrgId(jobId: string): Promise<string | null> {
    const cached = this.getCachedOrgId(jobId);
    try {
      const job = await this.queue.getJob(jobId);
      const orgId = job?.data?.orgId;
      if (orgId && typeof orgId === "string") {
        this.setCachedOrgId(jobId, orgId);
        return orgId;
      }
    } catch (error) {
      this.logger.debug({ jobId, error }, "Failed to resolve crawl queue orgId from job");
    }

    return cached;
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

  private async dispatchToListeners(orgId: string, payload: CrawlQueueEventPayload) {
    for (const listener of this.listeners) {
      try {
        await listener(orgId, payload);
      } catch (error) {
        this.logger.error({ orgId, error }, "Crawl queue event listener failed");
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

