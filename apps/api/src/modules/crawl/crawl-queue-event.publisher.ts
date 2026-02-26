import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { type Queue, type QueueEvents } from "bullmq";

import {
  CRAWL_QUEUE_EVENTS_HOT,
  CRAWL_QUEUE_EVENTS_NORMAL,
  CRAWL_QUEUE_HOT,
  CRAWL_QUEUE_HOT_NAME,
  CRAWL_QUEUE_NORMAL,
  CRAWL_QUEUE_NORMAL_NAME
} from "./crawl.constants";
import type { CrawlJobData } from "./crawl.types";

export interface CrawlQueueEventPayload {
  event: string;
  jobId: string;
  queueName?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type CrawlQueueEventListener = (orgId: string, payload: CrawlQueueEventPayload) => Promise<void> | void;

interface OrgCacheEntry {
  orgId: string;
  expiresAt: number;
}

interface EventBinding {
  events: QueueEvents;
  handlers: {
    active: ({ jobId, prev }: { jobId: string; prev?: string | null }) => Promise<void>;
    progress: ({ jobId, data }: { jobId: string; data?: unknown }) => Promise<void>;
    completed: ({ jobId, returnvalue }: { jobId: string; returnvalue?: unknown }) => Promise<void>;
    failed: ({ jobId, failedReason }: { jobId: string; failedReason?: string }) => Promise<void>;
  };
}

@Injectable()
export class CrawlQueueEventPublisher implements OnModuleDestroy {
  private readonly listeners = new Set<CrawlQueueEventListener>();
  private readonly logger = createLogger({ name: "crawl-queue-events" });
  private readonly orgCache = new Map<string, OrgCacheEntry>();
  private readonly orgCacheTtlMs = 10 * 60_000;
  private readonly bindings: EventBinding[] = [];

  constructor(
    @Inject(CRAWL_QUEUE_EVENTS_HOT) private readonly hotEvents: QueueEvents,
    @Inject(CRAWL_QUEUE_EVENTS_NORMAL) private readonly normalEvents: QueueEvents,
    @Inject(CRAWL_QUEUE_HOT) private readonly hotQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_NORMAL) private readonly normalQueue: Queue<CrawlJobData>
  ) {
    this.bindQueue(this.hotEvents, this.hotQueue, CRAWL_QUEUE_HOT_NAME);
    this.bindQueue(this.normalEvents, this.normalQueue, CRAWL_QUEUE_NORMAL_NAME);
  }

  registerListener(listener: CrawlQueueEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bindQueue(events: QueueEvents, queue: Queue<CrawlJobData>, queueName: string) {
    const active = async ({ jobId, prev }: { jobId: string; prev?: string | null }) => {
      await this.emit(queue, queueName, jobId, "ACTIVE", prev ? { prev } : undefined);
    };

    const progress = async ({ jobId, data }: { jobId: string; data?: unknown }) => {
      const progressData =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : data !== undefined
            ? { progress: data }
            : undefined;
      await this.emit(queue, queueName, jobId, "PROGRESS", progressData);
    };

    const completed = async ({
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
      await this.emit(queue, queueName, jobId, "COMPLETED", completedData);
    };

    const failed = async ({
      jobId,
      failedReason
    }: {
      jobId: string;
      failedReason?: string;
    }) => {
      await this.emit(queue, queueName, jobId, "FAILED", failedReason ? { reason: failedReason } : undefined);
    };

    events.on("active", active);
    events.on("progress", progress);
    events.on("completed", completed);
    events.on("failed", failed);

    this.bindings.push({
      events,
      handlers: {
        active,
        progress,
        completed,
        failed
      }
    });
  }

  private async emit(
    queue: Queue<CrawlJobData>,
    queueName: string,
    jobId: string,
    event: string,
    data?: Record<string, unknown>
  ) {
    try {
      const orgId = await this.resolveOrgId(queue, queueName, jobId);
      if (!orgId) {
        this.logger.debug({ queueName, jobId, event }, "Skipping crawl queue event without org context");
        return;
      }

      const payload: CrawlQueueEventPayload = {
        event,
        jobId,
        queueName,
        data,
        timestamp: new Date().toISOString()
      };

      await this.dispatchToListeners(orgId, payload);
    } catch (error) {
      this.logger.error({ queueName, jobId, event, error }, "Failed to publish crawl queue event");
    }
  }

  private cacheKey(queueName: string, jobId: string) {
    return `${queueName}:${jobId}`;
  }

  private async resolveOrgId(queue: Queue<CrawlJobData>, queueName: string, jobId: string): Promise<string | null> {
    const cacheKey = this.cacheKey(queueName, jobId);
    const cached = this.getCachedOrgId(cacheKey);
    try {
      const job = await queue.getJob(jobId);
      const orgId = job?.data?.orgId;
      if (orgId && typeof orgId === "string") {
        this.setCachedOrgId(cacheKey, orgId);
        return orgId;
      }
    } catch (error) {
      this.logger.debug({ queueName, jobId, error }, "Failed to resolve crawl queue orgId from job");
    }

    return cached;
  }

  private setCachedOrgId(cacheKey: string, orgId: string) {
    this.orgCache.set(cacheKey, { orgId, expiresAt: Date.now() + this.orgCacheTtlMs });
  }

  private getCachedOrgId(cacheKey: string): string | null {
    const cached = this.orgCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (Date.now() >= cached.expiresAt) {
      this.orgCache.delete(cacheKey);
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
    for (const binding of this.bindings) {
      binding.events.off("active", binding.handlers.active);
      binding.events.off("progress", binding.handlers.progress);
      binding.events.off("completed", binding.handlers.completed);
      binding.events.off("failed", binding.handlers.failed);
    }
    this.bindings.length = 0;
    this.listeners.clear();
    this.orgCache.clear();
  }
}
