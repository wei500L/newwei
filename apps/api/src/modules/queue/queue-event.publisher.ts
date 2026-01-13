import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import { PubSub } from "graphql-subscriptions";

import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "./queue.constants";

export interface QueueEventPayload {
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type QueueEventListener = (
  orgId: string,
  payload: QueueEventPayload
) => Promise<void> | void;

@Injectable()
export class QueueEventPublisher implements OnModuleDestroy {
  private readonly pubsub = new PubSub();
  private readonly listeners = new Set<QueueEventListener>();
  private readonly logger = createLogger({ name: "queue-events" });

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
  };

  constructor(
    @Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
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
      const job = await this.queue.getJob(jobId);
      const orgId = job?.data?.orgId as string | undefined;
      if (!orgId) {
        this.logger.debug({ jobId, event }, "Skipping queue event without org context");
        return;
      }
      const payload: QueueEventPayload = {
        event,
        jobId,
        data,
        timestamp: new Date().toISOString(),
      };
      await this.publish(orgId, payload);
    } catch (error) {
      this.logger.error({ jobId, event, error }, "Failed to publish queue event");
    }
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
  }
}
