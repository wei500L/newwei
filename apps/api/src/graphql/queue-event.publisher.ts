import { Inject, Injectable } from "@nestjs/common";
import { PubSub } from "graphql-subscriptions";
import { Queue, QueueEvents } from "bullmq";
import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "../modules/queue/queue.module";
import { createLogger } from "@modular/utils";

export interface QueueEventPayload {
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

const logger = createLogger({ name: "queue-events" });

@Injectable()
export class QueueEventPublisher {
  private readonly pubsub = new PubSub();

  constructor(
    @Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
  ) {
    this.events.on("completed", async ({ jobId, returnvalue }) => {
      await this.emit(jobId, "COMPLETED", returnvalue ?? undefined);
    });

    this.events.on("failed", async ({ jobId, failedReason }) => {
      await this.emit(jobId, "FAILED", failedReason ? { reason: failedReason } : undefined);
    });
  }

  private async emit(jobId: string, event: string, data?: Record<string, unknown>) {
    try {
      const job = await this.queue.getJob(jobId);
      const orgId = job?.data?.orgId;
      if (!orgId) {
        logger.debug({ jobId, event }, "Skipping queue event without org context");
        return;
      }
      const payload: QueueEventPayload = {
        event,
        jobId,
        data,
        timestamp: new Date().toISOString()
      };
      await this.publish(orgId, payload);
    } catch (error) {
      logger.error({ jobId, event, error }, "Failed to publish queue event");
    }
  }

  async publish(orgId: string, payload: QueueEventPayload) {
    logger.debug({ orgId, payload }, "Publishing queue GraphQL event");
    await this.pubsub.publish(this.topic(orgId), { queueEvents: payload });
  }

  asyncIterator(orgId: string) {
    return this.pubsub.asyncIterator<QueueEventPayload>(this.topic(orgId));
  }

  private topic(orgId: string) {
    return `queueEvents:${orgId}`;
  }
}
