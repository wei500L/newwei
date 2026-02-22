import { createLogger } from "@modular/utils";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { QueueEventPayload, QueueEventPublisher } from "../queue/queue-event.publisher";

import { ClassificationQualityService } from "./classification-quality.service";

@Injectable()
export class ClassificationQualitySeedTriggerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: "classification-quality-seed-trigger",
  });

  private unsubscribe?: () => void;

  constructor(
    private readonly queueEvents: QueueEventPublisher,
    private readonly classificationQuality: ClassificationQualityService,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.queueEvents.registerListener((orgId, payload) =>
      this.handlePipelineQueueEvent(orgId, payload),
    );
  }

  onModuleDestroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private async handlePipelineQueueEvent(orgId: string, payload: QueueEventPayload) {
    if (payload.event !== "COMPLETED") {
      return;
    }
    const data =
      payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : null;
    if (!data) {
      return;
    }

    const processedItemId = this.readProcessedItemId(data);
    if (!processedItemId) {
      return;
    }

    try {
      await this.classificationQuality.enqueueReviewSeedItemJob({
        orgId,
        processedItemId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, orgId, processedItemId, jobId: payload.jobId },
        "Failed to enqueue classification review seed from pipeline completion event",
      );
    }
  }

  private readProcessedItemId(data: Record<string, unknown>) {
    const candidates = [data.id, data._id, data.processedItemId];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = candidate.trim();
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }
}
