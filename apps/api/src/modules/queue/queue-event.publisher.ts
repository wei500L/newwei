import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import { PubSub } from "graphql-subscriptions";

import { CacheService } from "../cache/cache.service";

import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "./queue.constants";

export interface QueueEventPayload {
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
  pipelineJobId?: string;
  sourceId?: string;
  rawItemId?: string;
  itemMetaId?: string;
  processedItemId?: string;
}

export type QueueEventListener = (
  orgId: string,
  payload: QueueEventPayload
) => Promise<void> | void;

interface PipelineQueueJobContext {
  orgId: string;
  pipelineJobId?: string;
  sourceId?: string;
  rawItemId?: string;
  itemMetaId?: string;
  processedItemId?: string;
}

interface QueueJobContextCacheEntry extends PipelineQueueJobContext {
  expiresAt: number;
}

@Injectable()
export class QueueEventPublisher implements OnModuleDestroy {
  private readonly pubsub = new PubSub();
  private readonly listeners = new Set<QueueEventListener>();
  private readonly logger = createLogger({ name: "queue-events" });
  private readonly orgCache = new Map<string, QueueJobContextCacheEntry>();
  private readonly orgCacheTtlMs = 10 * 60_000;
  private readonly orgCachePruneIntervalMs = 60_000;
  private lastPruneAt = 0;

  private readonly handleCompleted = async ({
    jobId,
    returnvalue,
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
    this.deleteCachedJobContext(jobId);
  };

  private readonly handleActive = async ({
    jobId,
    prev,
  }: {
    jobId: string;
    prev?: string | null;
  }) => {
    await this.emit(jobId, "ACTIVE", prev ? { prev } : undefined);
  };

  private readonly handleProgress = async ({
    jobId,
    data,
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
    failedReason,
  }: {
    jobId: string;
    failedReason?: string;
  }) => {
    await this.emit(jobId, "FAILED", failedReason ? { reason: failedReason } : undefined);
    this.deleteCachedJobContext(jobId);
  };

  constructor(
    @Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    private readonly cache: CacheService,
  ) {
    this.events.on("active", this.handleActive);
    this.events.on("progress", this.handleProgress);
    this.events.on("completed", this.handleCompleted);
    this.events.on("failed", this.handleFailed);
  }

  registerListener(listener: QueueEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(jobId: string, event: string, data?: Record<string, unknown>) {
    try {
      const context = await this.resolveJobContext(jobId);
      if (!context?.orgId) {
        this.logger.debug({ jobId, event }, "Skipping queue event without org context");
        return;
      }
      const orgId = context.orgId;
      const payload: QueueEventPayload = {
        event,
        jobId,
        data,
        timestamp: new Date().toISOString(),
        ...(context.pipelineJobId ? { pipelineJobId: context.pipelineJobId } : {}),
        ...(context.sourceId ? { sourceId: context.sourceId } : {}),
        ...(context.rawItemId ? { rawItemId: context.rawItemId } : {}),
        ...(context.itemMetaId ? { itemMetaId: context.itemMetaId } : {}),
        ...(context.processedItemId ? { processedItemId: context.processedItemId } : {}),
      };
      await this.publish(orgId, payload);
    } catch (error) {
      this.logger.error({ jobId, event, error }, "Failed to publish queue event");
    }
  }

  private async resolveJobContext(jobId: string): Promise<PipelineQueueJobContext | null> {
    const cached = this.getCachedJobContext(jobId);
    try {
      const job = await this.queue.getJob(jobId);
      const context = this.extractJobContext(job?.data);
      if (context) {
        await this.setCachedJobContext(jobId, context);
        return context;
      }
    } catch (error) {
      this.logger.debug({ jobId, error }, "Failed to resolve pipeline queue context from job");
    }

    if (cached) {
      return cached;
    }

    // Cross-instance fallback: for terminal events the job may already be removed
    // (removeOnComplete) and this instance may never have observed 'active' locally,
    // so its in-memory cache is cold. Resolve from the shared cache so the COMPLETED/
    // FAILED event is not dropped for subscribers connected to this instance (C-4).
    return this.readSharedJobContext(jobId);
  }

  private extractJobContext(value: unknown): PipelineQueueJobContext | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const orgId = this.readStringField(record.orgId);
    if (!orgId) {
      return null;
    }
    return {
      orgId,
      pipelineJobId: this.readStringField(record.pipelineJobId),
      sourceId: this.readStringField(record.sourceId),
      rawItemId: this.readStringField(record.rawItemId),
      itemMetaId: this.readStringField(record.itemMetaId),
      processedItemId: this.readStringField(record.processedItemId),
    };
  }

  private async setCachedJobContext(jobId: string, context: PipelineQueueJobContext) {
    const now = Date.now();
    this.pruneExpiredOrgCacheIfDue(now);
    this.orgCache.set(jobId, {
      ...context,
      expiresAt: now + this.orgCacheTtlMs,
    });
    // Mirror to the shared cache so any instance can resolve context for a removed job.
    try {
      await this.cache.set(
        this.jobContextCacheKey(jobId),
        context,
        Math.ceil(this.orgCacheTtlMs / 1000),
      );
    } catch (error) {
      this.logger.debug({ jobId, error }, "Failed to persist queue job context to shared cache");
    }
  }

  private async readSharedJobContext(jobId: string): Promise<PipelineQueueJobContext | null> {
    try {
      const stored = await this.cache.get<PipelineQueueJobContext>(
        this.jobContextCacheKey(jobId),
      );
      const context = this.extractJobContext(stored);
      if (context) {
        // Warm the local cache for any subsequent events for this job on this instance.
        this.orgCache.set(jobId, {
          ...context,
          expiresAt: Date.now() + this.orgCacheTtlMs,
        });
        return context;
      }
    } catch (error) {
      this.logger.debug({ jobId, error }, "Failed to read shared queue job context");
    }
    return null;
  }

  private jobContextCacheKey(jobId: string) {
    return `queue:pipeline:jobctx:${jobId}`;
  }

  private getCachedJobContext(jobId: string): PipelineQueueJobContext | null {
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
    const { expiresAt, ...context } = cached;
    void expiresAt;
    return context;
  }

  private deleteCachedJobContext(jobId: string) {
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

  private readStringField(value: unknown) {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  async publish(orgId: string, payload: QueueEventPayload) {
    this.logger.debug({ orgId, payload }, "Publishing queue event");
    await this.pubsub.publish(this.topic(orgId), { queueEvents: payload });
    await this.dispatchToListeners(orgId, payload);
  }

  asyncIterator(orgId: string) {
    return this.pubsub.asyncIterator<{ queueEvents: QueueEventPayload }>(this.topic(orgId));
  }

  private async dispatchToListeners(orgId: string, payload: QueueEventPayload) {
    for (const listener of this.listeners) {
      try {
        await listener(orgId, payload);
      } catch (error) {
        this.logger.error({ orgId, error }, "Queue event listener failed");
      }
    }
  }

  private topic(orgId: string) {
    return `queueEvents:${orgId}`;
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
