import { Inject, Injectable } from "@nestjs/common";
import { PubSub } from "graphql-subscriptions";
import { QueueEvents } from "bullmq";
import { PIPELINE_QUEUE_EVENTS } from "../modules/queue/queue.module";
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

  constructor(@Inject(PIPELINE_QUEUE_EVENTS) private readonly events: QueueEvents) {
    this.events.on("completed", ({ jobId, returnvalue }) => {
      const payload: QueueEventPayload = {
        event: "COMPLETED",
        jobId,
        data: returnvalue ?? undefined,
        timestamp: new Date().toISOString()
      };
      void this.publish(payload);
    });

    this.events.on("failed", ({ jobId, failedReason }) => {
      const payload: QueueEventPayload = {
        event: "FAILED",
        jobId,
        data: failedReason ? { reason: failedReason } : undefined,
        timestamp: new Date().toISOString()
      };
      void this.publish(payload);
    });
  }

  async publish(payload: QueueEventPayload) {
    logger.debug({ payload }, "Publishing queue GraphQL event");
    await this.pubsub.publish("queueEvents", { queueEvents: payload });
  }

  asyncIterator() {
    return this.pubsub.asyncIterator<QueueEventPayload>("queueEvents");
  }
}
