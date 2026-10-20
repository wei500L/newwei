import { createLogger } from "@modular/utils";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { EnvService } from "../config/config.service";
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
    private readonly env: EnvService,
  ) {}

  onModuleInit() {
    // API_GO_CLASSIFICATION_REVIEW_SEED_MODE=go means api-go consumes the same
    // itemPipeline completed events and enqueues the review-seed job. Running
    // both sides would be safe (the BullMQ job id is stable), but only the Go
    // consumer should do the work after the switchover.
    const owner =
      this.env.get<string>("API_GO_CLASSIFICATION_REVIEW_SEED_MODE", {
        infer: true,
      }) ?? "legacy";
    if (owner === "go") {
      this.logger.info(
        "Classification review seed trigger disabled: owned by api-go (API_GO_CLASSIFICATION_REVIEW_SEED_MODE=go)",
      );
      return;
    }
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
