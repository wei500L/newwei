import {
  processedItemHasLocation,
  ProcessedItemModel,
} from "@modular/mongo";
import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { NewsClassifierService } from "./news-classifier.service";
import { normalizeNewsContentType } from "./news-content-type";
import {
  normalizeProcessedItemRef,
  normalizeStoredCategoryMethod,
  normalizeStoredCategoryPath,
  parseStoredCleanedNewsResult,
  resolveStoredContentTypeForBackfill,
} from "./news-pipeline-internal";
import { NewsPipelineOutboxService } from "./news-pipeline-outbox.service";
import { NewsPipelineStagesService } from "./news-pipeline-stages.service";
import { type PipelineJobContext, type RawPipelineItem } from "./news-pipeline.types";

@Injectable()
export class NewsPipelineService implements OnModuleDestroy {
  constructor(
    private readonly stages: NewsPipelineStagesService,
    private readonly outbox: NewsPipelineOutboxService,
    @Optional() private readonly classifier?: NewsClassifierService,
  ) {}

  async backfillProcessedItemClassificationSignals(
    orgId: string,
    inputs: {
      processedItemId: string;
      sourceUrl?: string | null;
      sourceLabel?: string | null;
      sourceId?: string | null;
    }[],
  ): Promise<{ updatedCount: number; skippedCount: number }> {
    if (!this.classifier || inputs.length === 0) {
      return { updatedCount: 0, skippedCount: inputs.length };
    }

    const contextByProcessedItemId = new Map<
      string,
      {
        processedItemId: string;
        sourceUrl: string | null;
        sourceLabel: string | null;
        sourceId: string | null;
      }
    >();
    for (const input of inputs) {
      const processedItemId = normalizeProcessedItemRef(
        input.processedItemId,
      );
      if (!processedItemId || contextByProcessedItemId.has(processedItemId)) {
        continue;
      }
      contextByProcessedItemId.set(processedItemId, {
        processedItemId,
        sourceUrl:
          typeof input.sourceUrl === "string" &&
          input.sourceUrl.trim().length > 0
            ? input.sourceUrl.trim()
            : null,
        sourceLabel:
          typeof input.sourceLabel === "string" &&
          input.sourceLabel.trim().length > 0
            ? input.sourceLabel.trim()
            : null,
        sourceId:
          typeof input.sourceId === "string" && input.sourceId.trim().length > 0
            ? input.sourceId.trim()
            : null,
      });
    }

    if (contextByProcessedItemId.size === 0) {
      return { updatedCount: 0, skippedCount: inputs.length };
    }

    const docs = await ProcessedItemModel.find({
      _id: { $in: Array.from(contextByProcessedItemId.keys()) },
      orgId,
      status: "completed",
    })
      .select({ _id: 1, result: 1 })
      .lean()
      .exec();

    let updatedCount = 0;
    let skippedCount =
      inputs.length -
      contextByProcessedItemId.size +
      Math.max(0, contextByProcessedItemId.size - docs.length);

    for (const doc of docs) {
      const processedItemId = normalizeProcessedItemRef(
        (() => {
          const rawId = (doc as { _id?: unknown })._id;
          if (typeof rawId === "string") {
            return rawId;
          }
          if (rawId && typeof rawId === "object" && "toString" in rawId) {
            return String((rawId as { toString: () => string }).toString());
          }
          return null;
        })(),
      );
      if (!processedItemId) {
        skippedCount += 1;
        continue;
      }

      const cleaned = parseStoredCleanedNewsResult(
        (doc as { result?: unknown }).result,
      );
      if (!cleaned) {
        skippedCount += 1;
        continue;
      }

      const hasContentType = Boolean(
        normalizeNewsContentType(cleaned.content_type),
      );
      const hasCategoryPath = normalizeStoredCategoryPath(
        cleaned.category_path,
      );
      const hasCategoryMethod = normalizeStoredCategoryMethod(
        cleaned.category_method,
      );
      if (hasContentType && (hasCategoryPath || hasCategoryMethod)) {
        skippedCount += 1;
        continue;
      }

      const context = contextByProcessedItemId.get(processedItemId);
      const sourceLabel =
        context?.sourceLabel ??
        (typeof cleaned.source === "string" && cleaned.source.trim().length > 0
          ? cleaned.source.trim()
          : null);
      const resolvedCleaned = resolveStoredContentTypeForBackfill(
        cleaned,
        context?.sourceUrl ?? null,
        sourceLabel,
      );
      const classification = await this.classifier.classify(
        orgId,
        resolvedCleaned,
        {
          sourceId: context?.sourceId ?? null,
          sourceUrl: context?.sourceUrl ?? null,
          sourceLabel,
        },
      );
      const updated = this.classifier.applyToCleanedNews(
        resolvedCleaned,
        classification,
      );

      await ProcessedItemModel.updateOne(
        { _id: processedItemId, orgId },
        {
          $set: {
            result: updated,
            hasLocation: processedItemHasLocation(updated),
          },
        },
      );
      updatedCount += 1;
    }

    return { updatedCount, skippedCount };
  }

  /**
   * Cleanup timers and event listeners on module destroy to prevent memory leaks.
   * NP-BUG-002: Fix memory leak by clearing outbox retry timers and event listeners.
   */
  onModuleDestroy(): void {
    this.outbox.onModuleDestroy();
  }

  async process(
    job: PipelineJobContext,
    raw: RawPipelineItem,
  ): Promise<Record<string, unknown> & { id: string }> {
    return this.stages.process(job, raw);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryPendingOutbox(): Promise<void> {
    await this.outbox.retryPendingOutbox();
  }
}
