import {
  processedItemHasLocation,
  ItemReadModelModel,
  ProcessedItemModel,
  RawItemModel,
  type ProcessedItemDocument,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import {
  MongoOutboxStatus,
  MongoOutboxType,
  ProcessedArticleStatus,
  type Prisma,
} from "@prisma/client";
import { Types } from "mongoose";
import { EventEmitter } from "node:events";

import { ItemStatus } from "../../common/pipeline-status";
import { toPrismaJsonValue } from "../../common/prisma-json";
import {
  alignUtcHourStart,
  extractProcessedArticleTerms,
  normalizeProcessedArticleLocation,
  normalizeProcessedArticleSource,
  resolveProcessedArticleEventAt,
} from "../../common/processed-article-indexing";
import { PrismaService } from "../config/prisma.service";
import { NewsSourceOpsSnapshotService } from "../crawl/news-source-ops-snapshot.service";
import { buildCanonicalUrlFingerprint } from "../crawl/url-fingerprint";
import { buildItemReadModelPatch } from "../items/item-read-model.utils";
import { VectorClientService } from "../vector/vector-client.service";

import { NewsPipelineDedupeService } from "./news-pipeline-dedupe.service";
import {
  buildTags,
  computeBackoffDelay,
  extractSourceId,
  extractUrlQueryParamAllowlist,
  isDuplicateKeyError,
  MAX_TIMEOUT_MS,
  normalizeProcessedItemRef,
  OUTBOX_DELIVERY_REQUESTED_EVENT,
  parseDate,
  ProcessedItemOutboxPayloadSchema,
  toArticleUrl,
  toItemMetaName,
  type CrawledArticle,
  type LlmCallMetadata,
  type OutboxDeliveryRequestedEvent,
  type PersistedProcessedItem,
  type ProcessedItemOutboxPayload,
} from "./news-pipeline-internal";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { type CleanedNews, type NormalizedNewsPayload } from "./news-pipeline.schema";
import { type RawPipelineItem } from "./news-pipeline.types";

@Injectable()
export class NewsPipelineOutboxService implements OnModuleDestroy {
  private readonly logger = createLogger({ name: "news-pipeline" });
  private readonly outboxRetryBaseDelayMs = 30_000;
  private readonly outboxMaxAttempts = 10;
  private readonly outboxStaleLockMs = 5 * 60_000;
  private readonly outboxBatchSize = 10;
  private readonly outboxEventEmitter = new EventEmitter();
  private outboxDeliveryQueue = new Map<
    string,
    ProcessedItemOutboxPayload | null
  >();
  private outboxDeliveryScheduled = false;
  private outboxDeliveryInFlight = false;
  private readonly outboxRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly configService: NewsPipelineConfigService,
    private readonly prisma: PrismaService,
    private readonly dedupe: NewsPipelineDedupeService,
    @Optional()
    private readonly newsSourceOpsSnapshots?: NewsSourceOpsSnapshotService,
    @Optional() private readonly vectorClient?: VectorClientService,
  ) {
    this.outboxEventEmitter.on(
      OUTBOX_DELIVERY_REQUESTED_EVENT,
      (event: OutboxDeliveryRequestedEvent) => {
        this.enqueueOutboxDelivery(event);
      },
    );
  }

  /**
   * Cleanup timers and event listeners on module destroy to prevent memory leaks.
   * NP-BUG-002: Fix memory leak by clearing outbox retry timers and event listeners.
   */
  onModuleDestroy(): void {
    // Clear all pending retry timers
    let timerCount = 0;
    for (const timer of this.outboxRetryTimers.values()) {
      clearTimeout(timer);
      timerCount++;
    }
    this.outboxRetryTimers.clear();

    // Remove event listeners
    this.outboxEventEmitter.removeAllListeners(OUTBOX_DELIVERY_REQUESTED_EVENT);

    this.logger.debug(
      { timerCount },
      "NewsPipelineService destroyed, cleared retry timers and event listeners",
    );
  }

  async createOutboxEntry(options: {
    orgId: string;
    payload: ProcessedItemOutboxPayload;
    processedItemId: string;
    contentHash: string;
    article: CrawledArticle;
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    articleMetadataPatch?: Record<string, unknown>;
    processedArticleId?: string | null;
    normalizedPayload: NormalizedNewsPayload;
    pipelineJobId?: string;
    sourceId?: string;
  }): Promise<{ id: string }> {
    try {
      const outboxEntry = await this.prisma.runInTransaction(async (tx) => {
        const payloadSourceId = extractSourceId(options.normalizedPayload);
        const resolvedSourceId =
          options.sourceId ??
          (payloadSourceId
            ? await this.resolveSourceIdForOrg(
                tx,
                options.orgId,
                payloadSourceId,
              )
            : undefined);
        const resolvedPipelineJobId =
          typeof options.pipelineJobId === "string" &&
          options.pipelineJobId.length > 0
            ? options.pipelineJobId
            : undefined;

        if (!options.processedArticleId) {
          await this.upsertArticleAndProcessed(tx, {
            orgId: options.orgId,
            contentHash: options.contentHash,
            article: options.article,
            cleaned: options.cleaned,
            llm: options.llm,
            articleMetadataPatch: options.articleMetadataPatch,
            processedItemId: options.processedItemId,
            payload: options.normalizedPayload,
            pipelineJobId: resolvedPipelineJobId,
            sourceId: resolvedSourceId,
          });
        } else if (resolvedPipelineJobId || resolvedSourceId) {
          const existing = await tx.processedArticle.findUnique({
            where: { id: options.processedArticleId },
            select: { articleId: true },
          });

          if (existing?.articleId) {
            await Promise.all([
              resolvedPipelineJobId
                ? tx.pipelineJob.updateMany({
                    where: { id: resolvedPipelineJobId },
                    data: {
                      articleId: existing.articleId,
                      crawlRunId: options.article.runId ?? null,
                    },
                  })
                : Promise.resolve(null),
              resolvedSourceId
                ? tx.article.updateMany({
                    where: { id: existing.articleId, sourceId: null },
                    data: { sourceId: resolvedSourceId },
                  })
                : Promise.resolve(null),
            ]);
          }
        }

        return tx.mongoOutbox.create({
          data: {
            orgId: options.orgId,
            type: MongoOutboxType.processed_item,
            payload: toPrismaJsonValue(options.payload),
            status: MongoOutboxStatus.pending,
            availableAt: new Date(),
          },
        });
      });

      this.outboxEventEmitter.emit(OUTBOX_DELIVERY_REQUESTED_EVENT, {
        outboxId: outboxEntry.id,
        payload: options.payload,
      } satisfies OutboxDeliveryRequestedEvent);
      if (options.sourceId) {
        void this.newsSourceOpsSnapshots
          ?.refreshSnapshotForSource(options.orgId, options.sourceId)
          .catch(() => undefined);
      }

      return outboxEntry;
    } catch (error) {
      this.logger.error(
        { error, orgId: options.orgId },
        "Failed to persist MySQL transaction with outbox entry",
      );
      throw error;
    }
  }

  private enqueueOutboxDelivery(event: OutboxDeliveryRequestedEvent) {
    const existingPayload = this.outboxDeliveryQueue.get(event.outboxId);
    if (!existingPayload && event.payload) {
      this.outboxDeliveryQueue.set(event.outboxId, event.payload);
    } else if (!this.outboxDeliveryQueue.has(event.outboxId)) {
      this.outboxDeliveryQueue.set(event.outboxId, event.payload ?? null);
    }

    if (this.outboxDeliveryInFlight || this.outboxDeliveryScheduled) {
      return;
    }

    this.outboxDeliveryScheduled = true;
    setImmediate(() => {
      this.outboxDeliveryScheduled = false;
      void this.flushOutboxDeliveryQueue();
    });
  }

  private async flushOutboxDeliveryQueue() {
    if (this.outboxDeliveryInFlight) {
      return;
    }

    this.outboxDeliveryInFlight = true;
    const startTime = Date.now();
    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      while (this.outboxDeliveryQueue.size > 0) {
        // NP-BUG-003: Use atomic swap pattern to prevent race condition
        // between Array.from() and clear() operations.
        // New items added during processing go to the new Map while
        // old items are safely processed from the captured reference.
        const currentQueue = this.outboxDeliveryQueue;
        this.outboxDeliveryQueue = new Map();
        const batch = Array.from(currentQueue.entries());
        totalProcessed += batch.length;

        // NP-PERF-002: Parallelize outbox delivery with concurrency limit
        const concurrency =
          this.configService.config.pipeline.outboxDeliveryConcurrency ?? 10;
        const results = await this.executeWithConcurrencyLimit(
          batch,
          async ([outboxId, payload]) => {
            try {
              await this.deliverOutboxFromQueue(outboxId, payload);
              return true;
            } catch (err) {
              this.logger.warn({ err, outboxId }, "Outbox delivery failed");
              return false;
            }
          },
          concurrency,
        );

        succeeded += results.filter(Boolean).length;
        failed += results.filter((r) => !r).length;
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to flush outbox delivery queue");
    } finally {
      this.outboxDeliveryInFlight = false;
      if (totalProcessed > 0) {
        this.logger.info(
          {
            duration: Date.now() - startTime,
            total: totalProcessed,
            succeeded,
            failed,
          },
          "Outbox delivery flush completed",
        );
      }
    }
  }

  /**
   * Execute async tasks with concurrency limit.
   * NP-PERF-002: Simple concurrency limiter without external dependencies.
   */
  private async executeWithConcurrencyLimit<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrency: number,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    const worker = async () => {
      while (index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await fn(items[currentIndex]!);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    );
    await Promise.all(workers);

    return results;
  }

  private async deliverOutboxFromQueue(
    outboxId: string,
    payload: ProcessedItemOutboxPayload | null,
  ) {
    if (payload) {
      await this.deliverOutboxPayload(outboxId, payload);
      return;
    }

    const entry = await this.prisma.mongoOutbox.findUnique({
      where: { id: outboxId },
    });
    if (!entry) {
      return;
    }

    const parsed = this.parseOutboxPayload(entry.payload);
    if (!parsed) {
      await this.markOutboxDead(
        outboxId,
        (entry.attempts ?? 0) + 1,
        new Error("Invalid outbox payload"),
      );
      return;
    }

    await this.deliverOutboxPayload(outboxId, parsed);
  }

  private async upsertArticleAndProcessed(
    tx: Prisma.TransactionClient,
    options: {
      orgId: string;
      contentHash: string;
      article: CrawledArticle;
      cleaned: CleanedNews;
      llm: LlmCallMetadata;
      articleMetadataPatch?: Record<string, unknown>;
      processedItemId: string;
      payload: NormalizedNewsPayload;
      pipelineJobId?: string;
      sourceId?: string;
    },
  ) {
    try {
      const crawlAt =
        parseDate(options.article.publishedAt) ??
        parseDate(options.article.fetchedAt) ??
        new Date();

      const sourceUrl = options.article.sourceUrl?.trim() ?? "";
      const queryParamAllowlist = extractUrlQueryParamAllowlist(
        options.payload,
      );
      const canonical = buildCanonicalUrlFingerprint(
        sourceUrl,
        queryParamAllowlist,
      );
      const persistedUrl = toArticleUrl(
        canonical?.canonicalUrl ?? sourceUrl,
      );
      const persistedMetadata: Record<string, unknown> = {
        ...(options.article.metadata ?? {}),
        ...(options.articleMetadataPatch ?? {}),
        ...(sourceUrl && sourceUrl !== persistedUrl
          ? { originalUrl: sourceUrl }
          : {}),
        ...(canonical
          ? {
              canonicalUrl: canonical.canonicalUrl,
              urlFingerprint: canonical.fingerprint,
              urlQueryParamAllowlist: queryParamAllowlist,
            }
          : {}),
      };

      const articleRecord = await this.dedupe.upsertOrgScopedArticle(tx, {
        orgId: options.orgId,
        sourceId: options.sourceId,
        contentHash: options.contentHash,
        persistedUrl,
        persistedMetadata,
        canonical,
        payload: options.payload,
        cleaned: options.cleaned,
        crawlAt,
      });

      if (options.sourceId) {
        await tx.article.updateMany({
          where: { id: articleRecord.id, sourceId: null },
          data: { sourceId: options.sourceId },
        });
      }

      if (options.pipelineJobId) {
        await tx.pipelineJob.updateMany({
          where: { id: options.pipelineJobId },
          data: {
            articleId: articleRecord.id,
            crawlRunId: options.article.runId ?? null,
          },
        });
      }

      const publishedAt =
        parseDate(options.cleaned.published_at) ??
        parseDate(options.article.publishedAt);
      const normalizedLocation = normalizeProcessedArticleLocation(
        options.cleaned.location,
      );
      const processedSource =
        options.cleaned.source ?? options.payload.sourceName ?? null;
      const eventAt = resolveProcessedArticleEventAt({
        publishedAt,
        crawlAt,
      });

      const processedArticleRecord = await tx.processedArticle.upsert({
        where: { articleId: articleRecord.id },
        update: {
          orgId: options.orgId,
          status: ProcessedArticleStatus.completed,
          title: options.cleaned.title ?? null,
          subtitle: options.cleaned.subtitle ?? null,
          author: options.cleaned.author ?? null,
          source: processedSource,
          publishedAt,
          category: options.cleaned.category ?? null,
          topics: options.cleaned.topics ?? [],
          summary: options.cleaned.summary ?? null,
          keyPoints: options.cleaned.key_points ?? [],
          entities: options.cleaned.entities ?? [],
          kgRelations: toPrismaJsonValue(options.cleaned.kg_relations ?? []),
          cleanedMarkdownRef: options.processedItemId,
          removedNoiseTypes: options.cleaned.removed_noise_types ?? [],
          qualityScore: options.cleaned.quality_score ?? null,
          llmModel: options.llm.model ?? options.cleaned.llm_model ?? null,
          llmPromptVersion:
            options.cleaned.llm_prompt_version ??
            options.llm.promptVersion ??
            null,
          language:
            options.cleaned.language ?? options.payload.language ?? null,
          location: normalizedLocation,
          promptTokens: options.llm.promptTokens ?? null,
          completionTokens: options.llm.completionTokens ?? null,
          totalTokens: options.llm.totalTokens ?? null,
          costUsd: options.llm.costUsd ?? null,
          latencyMs: options.llm.latencyMs ?? null,
          eventAt,
          hasLocation: normalizedLocation !== null,
        },
        create: {
          orgId: options.orgId,
          articleId: articleRecord.id,
          status: ProcessedArticleStatus.completed,
          title: options.cleaned.title ?? null,
          subtitle: options.cleaned.subtitle ?? null,
          author: options.cleaned.author ?? null,
          source: processedSource,
          publishedAt,
          category: options.cleaned.category ?? null,
          topics: options.cleaned.topics ?? [],
          summary: options.cleaned.summary ?? null,
          keyPoints: options.cleaned.key_points ?? [],
          entities: options.cleaned.entities ?? [],
          kgRelations: toPrismaJsonValue(options.cleaned.kg_relations ?? []),
          cleanedMarkdownRef: options.processedItemId,
          removedNoiseTypes: options.cleaned.removed_noise_types ?? [],
          qualityScore: options.cleaned.quality_score ?? null,
          llmModel: options.llm.model ?? options.cleaned.llm_model ?? null,
          llmPromptVersion:
            options.cleaned.llm_prompt_version ??
            options.llm.promptVersion ??
            null,
          language:
            options.cleaned.language ?? options.payload.language ?? null,
          location: normalizedLocation,
          promptTokens: options.llm.promptTokens ?? null,
          completionTokens: options.llm.completionTokens ?? null,
          totalTokens: options.llm.totalTokens ?? null,
          costUsd: options.llm.costUsd ?? null,
          latencyMs: options.llm.latencyMs ?? null,
          eventAt,
          hasLocation: normalizedLocation !== null,
        },
        select: {
          id: true,
        },
      });

      await tx.processedArticleTermHourly.deleteMany({
        where: {
          processedArticleId: processedArticleRecord.id,
        },
      });

      const extractedTerms = extractProcessedArticleTerms({
        title: options.cleaned.title ?? null,
        summary: options.cleaned.summary ?? null,
        topics: options.cleaned.topics ?? [],
      });
      if (extractedTerms.length > 0) {
        const bucketStart = alignUtcHourStart(eventAt);
        const source = normalizeProcessedArticleSource(processedSource);
        await tx.processedArticleTermHourly.createMany({
          data: extractedTerms.map((term) => ({
            orgId: options.orgId,
            processedArticleId: processedArticleRecord.id,
            bucketStart,
            term,
            source,
            articleCount: 1,
          })),
        });
      }
    } catch (error) {
      this.logger.warn(
        { error, contentHash: options.contentHash },
        "Failed to persist processed article",
      );
      throw error;
    }
  }

  private async resolveSourceIdForOrg(
    tx: Prisma.TransactionClient,
    orgId: string,
    sourceId: string,
  ) {
    const trimmed = sourceId.trim();
    if (!trimmed) {
      return undefined;
    }
    const existing = await tx.newsSource.findUnique({
      where: { id: trimmed },
      select: { orgId: true },
    });
    if (!existing || existing.orgId !== orgId) {
      return undefined;
    }
    return trimmed;
  }

  buildProcessedItemOutboxPayload(options: {
    processedItemId: string;
    raw: RawPipelineItem;
    orgId: string;
    sourceId?: string;
    payload: NormalizedNewsPayload;
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    summaryEmbedding?: number[] | null;
    summaryEmbeddingModel?: string | null;
    duplicateOf?: string | null;
    duplicateSimilarity?: number | null;
  }): ProcessedItemOutboxPayload {
    return {
      type: MongoOutboxType.processed_item,
      document: {
        _id: options.processedItemId,
        rawItemId: options.raw.id,
        itemMetaId: options.raw.itemMetaId,
        orgId: options.orgId,
        sourceId: options.sourceId ?? null,
        status: "completed",
        tags: buildTags(options.payload, options.cleaned),
        result: options.cleaned,
        llm: options.llm,
        summaryEmbedding: options.summaryEmbedding ?? undefined,
        summaryEmbeddingModel: options.summaryEmbeddingModel ?? undefined,
        duplicateOf: options.duplicateOf ?? undefined,
        duplicateSimilarity: options.duplicateSimilarity ?? undefined,
        error: undefined,
      },
    };
  }

  buildPendingProcessedItem(
    processedItemId: string,
  ): PersistedProcessedItem {
    return {
      _id: processedItemId,
      toJSON: () => ({ id: processedItemId }),
    };
  }

  private async deliverOutboxPayload(
    outboxId: string,
    payload: ProcessedItemOutboxPayload,
  ): Promise<ProcessedItemDocument | null> {
    const claimed = await this.claimOutboxEntry(outboxId);
    if (!claimed) {
      return null;
    }

    try {
      const itemMeta = await this.prisma.itemMeta.findUnique({
        where: { id: payload.document.itemMetaId },
        select: {
          id: true,
          orgId: true,
          externalId: true,
          name: true,
          status: true,
          mongoRef: true,
          version: true,
          createdAt: true,
          updatedAt: true,
          publishedAt: true,
          sortAt: true,
        },
      });
      const ingestedAt = itemMeta?.createdAt ?? new Date();
      const rawDoc = await RawItemModel.findById(payload.document.rawItemId, {
        itemMetaId: 1,
        source: 1,
        payload: 1,
        createdAt: 1,
        updatedAt: 1,
      }).lean();
      const rawPayload =
        rawDoc?.payload &&
        typeof rawDoc.payload === "object" &&
        !Array.isArray(rawDoc.payload)
          ? (rawDoc.payload as Record<string, unknown>)
          : null;
      const rawMetadata =
        rawPayload?.metadata &&
        typeof rawPayload.metadata === "object" &&
        !Array.isArray(rawPayload.metadata)
          ? (rawPayload.metadata as Record<string, unknown>)
          : null;
      let publishedAt = parseDate(
        payload.document.result?.published_at ?? null,
      );
      if (!publishedAt && itemMeta?.publishedAt) {
        publishedAt = itemMeta.publishedAt;
      }
      if (!publishedAt) {
        const rawCandidate = rawPayload
          ? ((rawPayload as { publishedAt?: unknown }).publishedAt ??
            (rawPayload as { published_at?: unknown }).published_at)
          : null;
        publishedAt = parseDate(
          typeof rawCandidate === "string" || rawCandidate instanceof Date
            ? rawCandidate
            : null,
        );
      }

      const cleanedTitleRaw =
        typeof payload.document.result?.title === "string"
          ? payload.document.result.title.trim()
          : "";
      const cleanedTitle = cleanedTitleRaw
        ? toItemMetaName(cleanedTitleRaw)
        : null;
      const shouldUpdateName =
        Boolean(cleanedTitle) &&
        Boolean(
          !itemMeta?.name ||
            itemMeta.name.includes("http://") ||
            itemMeta.name.includes("https://") ||
            itemMeta.name.includes("://"),
        );

      const sortAt = publishedAt ?? ingestedAt;
      const created = await this.writeProcessedItemFromPayload(
        payload.document,
        { ingestedAt, sortAt },
      );

      const vectorClient = this.vectorClient;
      const embedding = payload.document.summaryEmbedding;
      const embeddingModel =
        typeof payload.document.summaryEmbeddingModel === "string"
          ? payload.document.summaryEmbeddingModel.trim()
          : "";
      if (
        vectorClient &&
        !payload.document.duplicateOf &&
        Array.isArray(embedding) &&
        embedding.length > 0 &&
        embeddingModel
      ) {
        const createdAtMs =
          created?.createdAt instanceof Date &&
          Number.isFinite(created.createdAt.getTime())
            ? created.createdAt.getTime()
            : Date.now();
        await vectorClient.upsertOrThrow({
          orgId: payload.document.orgId,
          embeddingModel,
          points: [
            {
              processedItemId: payload.document._id,
              itemMetaId: payload.document.itemMetaId,
              createdAtMs,
              vector: embedding,
            },
          ],
        });
      }

      await this.prisma.itemMeta.updateMany({
        where: {
          id: payload.document.itemMetaId,
          status: { not: ItemStatus.Duplicate },
        },
        data: {
          status: ItemStatus.Completed,
          ...(shouldUpdateName && cleanedTitle ? { name: cleanedTitle } : {}),
          ...(publishedAt ? { publishedAt, sortAt: publishedAt } : {}),
        },
      });
      if (itemMeta) {
        const nextName =
          shouldUpdateName && cleanedTitle ? cleanedTitle : itemMeta.name;
        const nextPublishedAt = publishedAt ?? itemMeta.publishedAt ?? null;
        const nextSortAt = nextPublishedAt ?? itemMeta.sortAt ?? ingestedAt;
        const sourceIdFromRaw =
          typeof rawMetadata?.sourceId === "string" &&
          rawMetadata.sourceId.trim().length > 0
            ? rawMetadata.sourceId.trim()
            : null;
        const sourceId =
          typeof payload.document.sourceId === "string" &&
          payload.document.sourceId.trim().length > 0
            ? payload.document.sourceId.trim()
            : sourceIdFromRaw;
        const processedCreatedAt =
          created?.createdAt instanceof Date &&
          Number.isFinite(created.createdAt.getTime())
            ? created.createdAt
            : new Date();
        const processedUpdatedAt =
          created?.updatedAt instanceof Date &&
          Number.isFinite(created.updatedAt.getTime())
            ? created.updatedAt
            : processedCreatedAt;
        const errorValue =
          payload.document.error &&
          typeof payload.document.error === "object" &&
          !Array.isArray(payload.document.error)
            ? (payload.document.error as { message?: unknown; name?: unknown })
            : null;
        const readModelPatch = buildItemReadModelPatch({
          meta: {
            id: itemMeta.id,
            orgId: itemMeta.orgId,
            externalId: itemMeta.externalId,
            name: nextName,
            status: ItemStatus.Completed,
            mongoRef: itemMeta.mongoRef?.trim() || payload.document.rawItemId,
            version: itemMeta.version,
            publishedAt: nextPublishedAt,
            sortAt: nextSortAt,
            createdAt: itemMeta.createdAt,
            updatedAt: new Date(),
          },
          raw: rawDoc
            ? {
                id:
                  typeof rawDoc.id === "string"
                    ? rawDoc.id
                    : typeof rawDoc._id?.toString === "function"
                      ? rawDoc._id.toString()
                      : payload.document.rawItemId,
                itemMetaId:
                  typeof rawDoc.itemMetaId === "string"
                    ? rawDoc.itemMetaId
                    : payload.document.itemMetaId,
                source:
                  typeof rawDoc.source === "string" ? rawDoc.source : null,
                payload: rawPayload ?? {},
                createdAt:
                  rawDoc.createdAt instanceof Date
                    ? rawDoc.createdAt
                    : itemMeta.createdAt,
                updatedAt:
                  rawDoc.updatedAt instanceof Date
                    ? rawDoc.updatedAt
                    : itemMeta.updatedAt,
              }
            : undefined,
          processed: {
            id: payload.document._id,
            itemMetaId: payload.document.itemMetaId,
            rawItemId: payload.document.rawItemId,
            sourceId,
            status: payload.document.status,
            error: errorValue
              ? {
                  message:
                    typeof errorValue.message === "string" &&
                    errorValue.message.trim().length > 0
                      ? errorValue.message
                      : "Unknown error",
                  name:
                    typeof errorValue.name === "string"
                      ? errorValue.name
                      : null,
                }
              : null,
            tags: payload.document.tags,
            result: payload.document.result as Record<string, unknown>,
            duplicateOf: payload.document.duplicateOf ?? null,
            duplicateSimilarity: payload.document.duplicateSimilarity ?? null,
            summaryEmbeddingModel:
              payload.document.summaryEmbeddingModel ?? null,
            summaryEmbeddingDimensions: Array.isArray(
              payload.document.summaryEmbedding,
            )
              ? payload.document.summaryEmbedding.length
              : null,
            llm: payload.document.llm,
            createdAt: processedCreatedAt,
            updatedAt: processedUpdatedAt,
          },
          sourceId,
        });
        await ItemReadModelModel.updateOne(
          {
            orgId: payload.document.orgId,
            itemMetaId: payload.document.itemMetaId,
          },
          { $set: readModelPatch },
          { upsert: true },
        );
      }
      await this.prisma.mongoOutbox.delete({ where: { id: outboxId } });
      this.clearOutboxRetry(outboxId);
      return created;
    } catch (error) {
      const attempts = claimed?.attempts ?? 1;
      this.logger.warn(
        { error, outboxId, processedItemId: payload.document._id },
        "Mongo outbox delivery failed",
      );
      await this.markOutboxFailure(outboxId, attempts, error);
      return null;
    }
  }

  private async claimOutboxEntry(outboxId: string) {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.mongoOutbox.updateMany({
        where: {
          id: outboxId,
          type: MongoOutboxType.processed_item,
          OR: [
            { status: MongoOutboxStatus.pending, availableAt: { lte: now } },
            { status: MongoOutboxStatus.failed, availableAt: { lte: now } },
            {
              status: MongoOutboxStatus.processing,
              lockedAt: { lt: staleLockCutoff },
            },
          ],
        },
        data: {
          status: MongoOutboxStatus.processing,
          lockedAt: now,
          attempts: { increment: 1 },
          lastError: null,
        },
      });

      if (updated.count === 0) {
        return null;
      }

      return tx.mongoOutbox.findUnique({ where: { id: outboxId } });
    });
  }

  private async markOutboxFailure(
    outboxId: string,
    attempts: number,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= this.outboxMaxAttempts) {
      await this.markOutboxDead(outboxId, attempts, error);
      return;
    }

    const nextDelay = computeBackoffDelay(
      this.outboxRetryBaseDelayMs,
      attempts,
      5,
    );
    const availableAt = new Date(Date.now() + nextDelay);

    try {
      await this.prisma.mongoOutbox.update({
        where: { id: outboxId },
        data: {
          status: MongoOutboxStatus.failed,
          lastError: message,
          availableAt,
          lockedAt: null,
          attempts: Math.max(attempts, 1),
        },
      });
      this.scheduleOutboxRetry(outboxId, availableAt);
    } catch (updateError) {
      this.logger.warn(
        { error: updateError, outboxId, message },
        "Failed to update Mongo outbox status after delivery error",
      );
    }
  }

  private async markOutboxDead(
    outboxId: string,
    attempts: number,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    this.clearOutboxRetry(outboxId);

    try {
      await this.prisma.mongoOutbox.update({
        where: { id: outboxId },
        data: {
          status: MongoOutboxStatus.dead,
          lastError: message,
          availableAt: new Date(),
          lockedAt: null,
          attempts: Math.max(attempts, 1),
        },
      });
    } catch (updateError) {
      this.logger.warn(
        { error: updateError, outboxId, message },
        "Failed to mark Mongo outbox dead",
      );
    }

    // The queue job already returned success after createOutboxEntry, so no
    // worker will ever touch this item again. Without compensation the
    // processed item would stay in "processing" forever (and the read model
    // would never reflect the terminal state), leaving zombie items in the
    // user-facing lists. Mark the in-flight processed item as failed.
    try {
      const entry = await this.prisma.mongoOutbox.findUnique({
        where: { id: outboxId },
        select: { payload: true },
      });
      const payload = this.parseOutboxPayload(entry?.payload ?? null);
      if (!payload?.document?._id || !payload.document.itemMetaId) {
        return;
      }
      const documentId = new Types.ObjectId(payload.document._id);
      await ProcessedItemModel.updateOne(
        {
          _id: documentId,
          status: "processing",
        },
        {
          $set: {
            status: "failed",
            error: {
              message: message.slice(0, 2000),
              name: error instanceof Error ? error.name : "OutboxDeliveryError",
            },
            updatedAt: new Date(),
          },
        },
      );
      await ItemReadModelModel.updateOne(
        {
          orgId: payload.document.orgId,
          itemMetaId: payload.document.itemMetaId,
        },
        {
          $set: {
            status: ItemStatus.Failed,
            "processed.status": "failed",
            "processed.error": {
              message: message.slice(0, 2000),
              name: error instanceof Error ? error.name : "OutboxDeliveryError",
            },
            updatedAt: new Date(),
          },
        },
      );
    } catch (compensationError) {
      this.logger.warn(
        { error: compensationError, outboxId },
        "Failed to compensate dead Mongo outbox (processed item left processing)",
      );
    }
  }

  private scheduleOutboxRetry(outboxId: string, availableAt: Date) {
    const delayMs = availableAt.getTime() - Date.now();
    if (delayMs <= 0) {
      this.outboxEventEmitter.emit(OUTBOX_DELIVERY_REQUESTED_EVENT, {
        outboxId,
      });
      return;
    }

    const cappedDelayMs = Math.min(delayMs, MAX_TIMEOUT_MS);
    const existing = this.outboxRetryTimers.get(outboxId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.outboxRetryTimers.delete(outboxId);
      this.outboxEventEmitter.emit(OUTBOX_DELIVERY_REQUESTED_EVENT, {
        outboxId,
      });
    }, cappedDelayMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.outboxRetryTimers.set(outboxId, timer);
  }

  private clearOutboxRetry(outboxId: string) {
    const existing = this.outboxRetryTimers.get(outboxId);
    if (!existing) {
      return;
    }
    clearTimeout(existing);
    this.outboxRetryTimers.delete(outboxId);
  }

  private async writeProcessedItemFromPayload(
    document: ProcessedItemOutboxPayload["document"],
    options?: { ingestedAt?: Date; sortAt?: Date },
  ): Promise<ProcessedItemDocument> {
    try {
      const duplicateRef = normalizeProcessedItemRef(document.duplicateOf);
      const duplicateOf = duplicateRef
        ? new Types.ObjectId(duplicateRef)
        : undefined;
      const processedId = new Types.ObjectId(document._id);
      const rawItemId = new Types.ObjectId(document.rawItemId);
      const summaryEmbeddingDimensions = Array.isArray(document.summaryEmbedding)
        ? document.summaryEmbedding.length
        : null;
      const update: Record<string, unknown> = {
        rawItemId,
        itemMetaId: document.itemMetaId,
        orgId: document.orgId,
        sourceId: document.sourceId ?? null,
        ...(options?.ingestedAt ? { ingestedAt: options.ingestedAt } : {}),
        ...(options?.sortAt ? { sortAt: options.sortAt } : {}),
        status: document.status,
        hasLocation: processedItemHasLocation(document.result),
        tags: document.tags,
        result: document.result,
        llm: document.llm,
        summaryEmbedding: document.summaryEmbedding,
        summaryEmbeddingModel: document.summaryEmbeddingModel ?? null,
        summaryEmbeddingDimensions,
        duplicateOf,
        duplicateSimilarity: document.duplicateSimilarity ?? null,
        error: document.error ?? undefined,
      };
      const unset: Record<string, 1> = {};
      if (!document.error) {
        unset.error = 1;
      }

      const updated = await ProcessedItemModel.findOneAndUpdate(
        { _id: processedId },
        {
          $set: update,
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
          $setOnInsert: { _id: processedId },
        },
        { upsert: true, new: true },
      );
      if (!updated) {
        throw new Error("Processed item upsert returned no document");
      }
      return updated;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await ProcessedItemModel.findById(document._id);
        if (existing) {
          return existing as ProcessedItemDocument;
        }
      }
      throw error;
    }
  }

  private parseOutboxPayload(
    payload: Prisma.JsonValue | null,
  ): ProcessedItemOutboxPayload | null {
    const parsed = ProcessedItemOutboxPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }

  async retryPendingOutbox(): Promise<void> {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    try {
      const entries = await this.prisma.mongoOutbox.findMany({
        where: {
          type: MongoOutboxType.processed_item,
          OR: [
            { status: MongoOutboxStatus.pending, availableAt: { lte: now } },
            { status: MongoOutboxStatus.failed, availableAt: { lte: now } },
            {
              status: MongoOutboxStatus.processing,
              lockedAt: { lt: staleLockCutoff },
            },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: this.outboxBatchSize,
      });

      for (const entry of entries) {
        const payload = this.parseOutboxPayload(entry.payload);
        if (!payload) {
          await this.markOutboxDead(
            entry.id,
            (entry.attempts ?? 0) + 1,
            new Error("Invalid outbox payload"),
          );
          continue;
        }

        await this.deliverOutboxPayload(entry.id, payload);
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to process Mongo outbox batch");
    }
  }
}
