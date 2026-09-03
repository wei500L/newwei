import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { NewsEventAssignmentMethod } from "@prisma/client";
import { randomUUID } from "node:crypto";

import {
  ModelServiceClient,
  type ModelServiceTopicClusteringDocument,
} from "../model-service/model-service.client";
import { buildNewsSignalFromProcessedArticle } from "../news-signals/news-signal";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import { NewsEventClusteringFailureService } from "./news-event-clustering-failure.service";
import {
  type NewsEventSettings,
} from "./news-events-settings.service";
import { NewsEventsService } from "./news-events.service";

const logger = createLogger({ name: "news-events-bertopic" });

export interface NewsEventIngestionBatchEntry {
  id: string;
  articleId: string;
  processedAt: Date;
  publishedAt: Date | null;
  language: string | null;
  title: string | null;
  summary: string | null;
  category: string | null;
  topics: unknown;
  entities: unknown;
  qualityScore: number | null;
  cleanedMarkdownRef: string | null;
  article?: { crawlAt: Date | null } | null;
}

interface BatchSignalDocument {
  entry: NewsEventIngestionBatchEntry;
  signal: ReturnType<typeof buildNewsSignalFromProcessedArticle>;
  embedding: number[] | null;
  embeddingModel: string | null;
}

@Injectable()
export class NewsEventsBertopicService {
  constructor(
    private readonly modelService: ModelServiceClient,
    private readonly events: NewsEventsService,
    private readonly failures: NewsEventClusteringFailureService,
  ) {}

  async processBatch(input: {
    orgId: string;
    batch: NewsEventIngestionBatchEntry[];
    processedItemResultById: Map<string, unknown>;
    settings: NewsEventSettings;
  }): Promise<{
    processedArticles: number;
    assigned: number;
    queuedForManual: number;
  }> {
    const documents = await this.buildBatchSignalDocuments(
      input.batch,
      input.processedItemResultById,
    );

    let assigned = 0;
    let queuedForManual = 0;

    const groups = new Map<string, BatchSignalDocument[]>();
    const immediateFallback: BatchSignalDocument[] = [];

    for (const document of documents) {
      if (
        !document.embedding ||
        !document.embeddingModel ||
        !this.hasClusterableText(document)
      ) {
        immediateFallback.push(document);
        continue;
      }
      const key = `${document.signal.language ?? "unknown"}::${document.embeddingModel}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(document);
      } else {
        groups.set(key, [document]);
      }
    }

    assigned += await this.assignSequentially(
      input.orgId,
      immediateFallback,
      input.settings,
    );

    for (const group of groups.values()) {
      if (group.length < input.settings.bertopicMinItemsPerGroup) {
        assigned += await this.assignSequentially(
          input.orgId,
          group,
          input.settings,
        );
        continue;
      }

      const chunks = this.chunkDocuments(
        group,
        input.settings.bertopicMaxItemsPerRequest,
      );
      for (const chunk of chunks) {
        if (chunk.length < input.settings.bertopicMinItemsPerGroup) {
          assigned += await this.assignSequentially(
            input.orgId,
            chunk,
            input.settings,
          );
          continue;
        }

        const result = await this.clusterChunk(input.orgId, chunk, input.settings);
        assigned += result.assigned;
        queuedForManual += result.queuedForManual;
      }
    }

    return {
      processedArticles: input.batch.length,
      assigned,
      queuedForManual,
    };
  }

  private async clusterChunk(
    orgId: string,
    chunk: BatchSignalDocument[],
    settings: NewsEventSettings,
  ): Promise<{ assigned: number; queuedForManual: number }> {
    const requestId = randomUUID();
    const language = chunk[0]?.signal.language ?? null;
    const embeddingModel = chunk[0]?.embeddingModel ?? null;
    try {
      const response = await this.modelService.clusterTopicsOrThrow({
        requestId,
        minTopicSize: settings.bertopicMinTopicSize,
        documents: chunk.map(
          (item) =>
            ({
              id: item.signal.processedArticleId,
              text: this.toClusterText(item),
              embedding: item.embedding as number[],
            }) satisfies ModelServiceTopicClusteringDocument,
        ),
      });

      let assigned = 0;
      const byProcessedArticleId = new Map(
        chunk.map((item) => [item.signal.processedArticleId, item]),
      );
      const handledIds = new Set<string>();

      for (const cluster of response.clusters) {
        const representative = byProcessedArticleId.get(cluster.representativeId);
        if (!representative) {
          continue;
        }
        handledIds.add(cluster.representativeId);
        const anchor = await this.events.assignNewsSignalToEvent(
          orgId,
          representative.signal,
          settings,
        );
        if (anchor.created) {
          assigned += 1;
        }

        for (const memberId of cluster.itemIds) {
          if (memberId === cluster.representativeId) {
            continue;
          }
          const member = byProcessedArticleId.get(memberId);
          if (!member) {
            continue;
          }
          handledIds.add(memberId);
          const similarity =
            representative.embedding && member.embedding
              ? this.cosineSimilarity(representative.embedding, member.embedding)
              : 0;
          if ((anchor.eventId ?? "").trim() && similarity >= settings.vectorMinScore) {
            const result = await this.events.assignNewsSignalToSpecificEventWithSettings(
              orgId,
              anchor.eventId,
              member.signal,
              settings,
              {
                similarity,
                assignedBy: NewsEventAssignmentMethod.manual,
              },
            );
            if (result.created) {
              assigned += 1;
            }
            continue;
          }

          const result = await this.events.assignNewsSignalToEvent(
            orgId,
            member.signal,
            settings,
          );
          if (result.created) {
            assigned += 1;
          }
        }
      }

      const outlierIds = new Set(response.outlierIds);
      const sequentialFallback = chunk.filter(
        (item) =>
          outlierIds.has(item.signal.processedArticleId) ||
          !handledIds.has(item.signal.processedArticleId),
      );
      assigned += await this.assignSequentially(orgId, sequentialFallback, settings);

      await writeTaskLogBestEffort({
        queue: "news_events",
        jobId: requestId,
        orgId,
        stage: "bertopic_cluster",
        status: "completed",
        data: {
          requestId,
          language,
          embeddingModel,
          clusterCount: response.clusters.length,
          outlierCount: response.outlierIds.length,
          documentCount: chunk.length,
          diagnostics: response.diagnostics,
        },
      });

      return { assigned, queuedForManual: 0 };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "BERTopic clustering failed";
      const groupId = await this.failures.recordFailure({
        orgId,
        clusteringMode: "bertopic_primary",
        failureReason: "bertopic_request_failed",
        failureMessage: message,
        requestId,
        language,
        embeddingModel,
        items: chunk.map((item) => ({
          processedArticleId: item.signal.processedArticleId,
          processedItemId: item.signal.processedItemId,
          articleId: item.signal.articleId,
          title: item.signal.title,
          summary: item.signal.summary,
          language: item.signal.language,
          category: item.signal.legacyCategory ?? null,
          categoryPath: item.signal.categoryPath ?? null,
          categoryConfidence:
            typeof item.signal.categoryConfidence === "number"
              ? item.signal.categoryConfidence
              : null,
          topics: item.signal.topics,
          entities: item.signal.entities,
          qualityScore: item.signal.qualityScore,
          publishedAt: item.entry.publishedAt,
          processedAt: item.entry.processedAt,
          crawlAt: item.entry.article?.crawlAt ?? null,
        })),
        metadata: {
          requestId,
          documentCount: chunk.length,
        },
      });

      logger.warn(
        { err: error, orgId, requestId, groupId, chunkSize: chunk.length },
        "BERTopic chunk failed and was queued for clustering recovery",
      );
      return { assigned: 0, queuedForManual: chunk.length };
    }
  }

  private async buildBatchSignalDocuments(
    batch: NewsEventIngestionBatchEntry[],
    processedItemResultById: Map<string, unknown>,
  ): Promise<BatchSignalDocument[]> {
    const processedItemIds = Array.from(
      new Set(
        batch
          .map((entry) =>
            typeof entry.cleanedMarkdownRef === "string"
              ? entry.cleanedMarkdownRef.trim()
              : "",
          )
          .filter((entry) => entry.length > 0),
      ),
    );
    const embeddingsByProcessedItemId = await this.loadEmbeddings(processedItemIds);

    return batch.map((entry) => {
      const processedItemId =
        typeof entry.cleanedMarkdownRef === "string"
          ? entry.cleanedMarkdownRef.trim()
          : "";
      const signal = buildNewsSignalFromProcessedArticle({
        processedArticle: {
          id: entry.id,
          articleId: entry.articleId,
          processedAt: entry.processedAt ?? null,
          publishedAt: entry.publishedAt ?? null,
          language: entry.language ?? null,
          title: entry.title ?? null,
          summary: entry.summary ?? null,
          category: entry.category ?? null,
          topics: entry.topics,
          entities: entry.entities,
          qualityScore: entry.qualityScore ?? null,
          cleanedMarkdownRef: entry.cleanedMarkdownRef ?? null,
        },
        article: {
          crawlAt: entry.article?.crawlAt ?? null,
        },
        processedItemResult: processedItemId
          ? processedItemResultById.get(processedItemId) ?? null
          : null,
      });
      const embeddingRecord = processedItemId
        ? embeddingsByProcessedItemId.get(processedItemId) ?? null
        : null;

      return {
        entry,
        signal,
        embedding: embeddingRecord?.embedding ?? null,
        embeddingModel: embeddingRecord?.model ?? null,
      };
    });
  }

  private async loadEmbeddings(processedItemIds: string[]) {
    if (processedItemIds.length === 0) {
      return new Map<string, { embedding: number[]; model: string }>();
    }

    const docs = await ProcessedItemModel.find(
      { _id: { $in: processedItemIds } },
      { _id: 1, summaryEmbedding: 1, summaryEmbeddingModel: 1 },
    )
      .lean()
      .exec();
    const out = new Map<string, { embedding: number[]; model: string }>();
    for (const doc of docs) {
      const record = doc as {
        _id?: unknown;
        summaryEmbedding?: unknown;
        summaryEmbeddingModel?: unknown;
      };
      const id = String(record._id ?? "").trim();
      const model =
        typeof record.summaryEmbeddingModel === "string"
          ? record.summaryEmbeddingModel.trim()
          : "";
      if (!id || !model || !Array.isArray(record.summaryEmbedding)) {
        continue;
      }
      const embedding = record.summaryEmbedding.filter(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) as number[];
      if (embedding.length !== record.summaryEmbedding.length || embedding.length === 0) {
        continue;
      }
      out.set(id, { embedding, model });
    }
    return out;
  }

  private chunkDocuments<T>(items: T[], size: number) {
    const normalizedSize = Math.max(1, size);
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += normalizedSize) {
      chunks.push(items.slice(index, index + normalizedSize));
    }
    return chunks;
  }

  private async assignSequentially(
    orgId: string,
    documents: BatchSignalDocument[],
    settings: NewsEventSettings,
  ) {
    let assigned = 0;
    for (const document of documents) {
      const result = await this.events.assignNewsSignalToEvent(
        orgId,
        document.signal,
        settings,
      );
      if (result.created) {
        assigned += 1;
      }
    }
    return assigned;
  }

  private hasClusterableText(document: BatchSignalDocument) {
    return this.toClusterText(document).length > 0;
  }

  private toClusterText(document: BatchSignalDocument) {
    return [document.signal.title ?? "", document.signal.summary ?? ""]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  private cosineSimilarity(a: number[], b: number[]) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index += 1) {
      dot += a[index]! * b[index]!;
      normA += a[index]! * a[index]!;
      normB += b[index]! * b[index]!;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator > 0 ? dot / denominator : 0;
  }
}
