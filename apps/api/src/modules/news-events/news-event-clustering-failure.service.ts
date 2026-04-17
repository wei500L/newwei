import {
  NewsEventClusteringFailureModel,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";

import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import {
  NewsEventsSettingsService,
  type NewsEventClusteringMode,
} from "./news-events-settings.service";
import { NewsEventsService } from "./news-events.service";

interface NewsEventClusteringFailureItemInput {
  processedArticleId: string;
  processedItemId: string | null;
  articleId: string;
  title: string | null;
  summary: string | null;
  language: string | null;
  category: string | null;
  categoryPath: string | null;
  categoryConfidence: number | null;
  topics: string[];
  entities: { name: string; type: string | null; confidence: number | null }[];
  qualityScore: number | null;
  publishedAt: Date | null;
  processedAt: Date | null;
  crawlAt: Date | null;
}

export interface NewsEventClusteringFailureSummary {
  groupId: string;
  status: "pending" | "resolved" | "ignored";
  clusteringMode: string;
  failureReason: string;
  failureMessage: string | null;
  language: string | null;
  embeddingModel: string | null;
  itemCount: number;
  sampleTitles: string[];
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  resolvedAt: string | null;
  resolutionMode: string | null;
  resolvedEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewsEventClusteringFailureOverview {
  pendingCount: number;
  resolvedCount: number;
  ignoredCount: number;
  latestFailureAt: string | null;
}

interface NewsEventClusteringFailureSummaryRow {
  groupId?: string | null;
  status?: "pending" | "resolved" | "ignored" | null;
  clusteringMode?: string | null;
  failureReason?: string | null;
  failureMessage?: string | null;
  language?: string | null;
  embeddingModel?: string | null;
  itemCount?: number | null;
  sampleTitles?: unknown;
  attemptCount?: number | null;
  lastAttemptAt?: Date | string | null;
  lastError?: string | null;
  resolvedAt?: Date | string | null;
  resolutionMode?: string | null;
  resolvedEventIds?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

@Injectable()
export class NewsEventClusteringFailureService {
  private readonly logger = createLogger({
    name: "news-event-clustering-failure",
  });

  constructor(
    private readonly events: NewsEventsService,
    private readonly settings: NewsEventsSettingsService,
  ) {}

  async recordFailure(input: {
    orgId: string;
    clusteringMode: NewsEventClusteringMode;
    failureReason: string;
    failureMessage: string;
    requestId?: string | null;
    language?: string | null;
    embeddingModel?: string | null;
    items: NewsEventClusteringFailureItemInput[];
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const groupId = this.buildGroupId(
      input.orgId,
      input.failureReason,
      input.items.map((item) => item.processedArticleId),
    );
    const sampleTitles = input.items
      .map((item) => item.title?.trim())
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);
    const itemCount = input.items.length;

    await NewsEventClusteringFailureModel.findOneAndUpdate(
      { orgId: input.orgId, groupId },
      {
        $set: {
          status: "pending",
          clusteringMode: input.clusteringMode,
          failureReason: input.failureReason,
          failureMessage: input.failureMessage,
          requestId: input.requestId ?? null,
          language: input.language ?? null,
          embeddingModel: input.embeddingModel ?? null,
          itemCount,
          sampleTitles,
          items: input.items,
          metadata: input.metadata ?? undefined,
          resolvedAt: null,
          resolvedById: null,
          resolutionMode: null,
          resolvedEventIds: [],
          lastError: input.failureMessage,
        },
        $setOnInsert: {
          attemptCount: 0,
          lastAttemptAt: null,
        },
      },
      { upsert: true, new: true },
    )
      .lean()
      .exec();

    await writeTaskLogBestEffort({
      queue: "news_events",
      jobId: groupId,
      orgId: input.orgId,
      stage: "bertopic_failure_queue",
      status: "failed",
      message: input.failureMessage,
      data: {
        failureReason: input.failureReason,
        clusteringMode: input.clusteringMode,
        itemCount,
        language: input.language ?? null,
        embeddingModel: input.embeddingModel ?? null,
      },
    });

    return groupId;
  }

  async getOverview(orgId: string): Promise<NewsEventClusteringFailureOverview> {
    const [pendingCount, resolvedCount, ignoredCount, latestFailure] =
      await Promise.all([
        NewsEventClusteringFailureModel.countDocuments({
          orgId,
          status: "pending",
        }),
        NewsEventClusteringFailureModel.countDocuments({
          orgId,
          status: "resolved",
        }),
        NewsEventClusteringFailureModel.countDocuments({
          orgId,
          status: "ignored",
        }),
        NewsEventClusteringFailureModel.findOne({ orgId })
          .sort({ createdAt: -1 })
          .select({ createdAt: 1 })
          .lean()
          .exec(),
      ]);

    return {
      pendingCount,
      resolvedCount,
      ignoredCount,
      latestFailureAt: latestFailure?.createdAt
        ? new Date(latestFailure.createdAt).toISOString()
        : null,
    };
  }

  async listFailures(
    orgId: string,
    options?: {
      status?: "pending" | "resolved" | "ignored";
      limit?: number;
    },
  ): Promise<NewsEventClusteringFailureSummary[]> {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 200);
    const rows = await NewsEventClusteringFailureModel.find({
      orgId,
      ...(options?.status ? { status: options.status } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((row) => this.toSummary(row));
  }

  async resolveFailureGroupByVectorBackfill(
    orgId: string,
    actorId: string,
    groupId: string,
  ) {
    const row = await NewsEventClusteringFailureModel.findOne({
      orgId,
      groupId,
    })
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException("News event clustering failure not found");
    }

    const startedAt = new Date();
    const nextAttemptCount = Math.max(0, Number(row.attemptCount ?? 0)) + 1;
    try {
      const settings = await this.settings.getSettings(orgId);
      const resolvedEventIds = new Set<string>();
      let assignedCount = 0;
      let skippedCount = 0;

      const items = Array.isArray(row.items) ? row.items : [];
      for (const item of items) {
        const signal = this.toSignal(item);
        const result = await this.events.assignNewsSignalToEvent(
          orgId,
          signal,
          settings,
        );
        if (result.eventId) {
          resolvedEventIds.add(result.eventId);
        }
        if (result.created) {
          assignedCount += 1;
        } else {
          skippedCount += 1;
        }
      }

      const resolvedAt = new Date();
      await NewsEventClusteringFailureModel.updateOne(
        { orgId, groupId },
        {
          $set: {
            status: "resolved",
            attemptCount: nextAttemptCount,
            lastAttemptAt: startedAt,
            lastError: null,
            resolvedAt,
            resolvedById: actorId,
            resolutionMode: "vector_backfill",
            resolvedEventIds: Array.from(resolvedEventIds.values()).sort(),
          },
        },
      ).exec();

      await writeTaskLogBestEffort({
        queue: "news_events",
        jobId: groupId,
        orgId,
        stage: "bertopic_vector_backfill",
        status: "completed",
        data: {
          itemCount: items.length,
          assignedCount,
          skippedCount,
          resolvedEventIds: Array.from(resolvedEventIds.values()).sort(),
        },
      });

      return {
        groupId,
        assignedCount,
        skippedCount,
        resolvedEventIds: Array.from(resolvedEventIds.values()).sort(),
        resolvedAt: resolvedAt.toISOString(),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Vector backfill failed";
      await NewsEventClusteringFailureModel.updateOne(
        { orgId, groupId },
        {
          $set: {
            status: "pending",
            attemptCount: nextAttemptCount,
            lastAttemptAt: startedAt,
            lastError: message,
          },
        },
      ).exec();

      await writeTaskLogBestEffort({
        queue: "news_events",
        jobId: groupId,
        orgId,
        stage: "bertopic_vector_backfill",
        status: "failed",
        message,
      });

      this.logger.warn({ err: error, orgId, groupId }, "Vector backfill failed");
      throw error;
    }
  }

  async ignoreFailureGroup(orgId: string, actorId: string, groupId: string) {
    const result = await NewsEventClusteringFailureModel.findOneAndUpdate(
      { orgId, groupId },
      {
        $set: {
          status: "ignored",
          resolvedById: actorId,
          resolvedAt: new Date(),
          resolutionMode: "ignored",
        },
      },
      { new: true },
    )
      .lean()
      .exec();
    if (!result) {
      throw new NotFoundException("News event clustering failure not found");
    }
    return this.toSummary(result);
  }

  private buildGroupId(
    orgId: string,
    failureReason: string,
    processedArticleIds: string[],
  ) {
    const hash = createHash("sha1");
    hash.update(orgId);
    hash.update("|");
    hash.update(failureReason);
    hash.update("|");
    for (const id of processedArticleIds.slice().sort()) {
      hash.update(id);
      hash.update(",");
    }
    return hash.digest("hex").slice(0, 24);
  }

  private toSignal(item: NewsEventClusteringFailureItemInput) {
    const timestamp =
      item.publishedAt ?? item.crawlAt ?? item.processedAt ?? new Date();
    return {
      articleId: item.articleId,
      processedArticleId: item.processedArticleId,
      processedItemId: item.processedItemId,
      timestamp,
      language: item.language,
      title: item.title,
      summary: item.summary,
      topics: item.topics,
      entities: item.entities,
      sentiment: null,
      qualityScore: item.qualityScore,
      legacyCategory: item.category,
      categoryPath: item.categoryPath,
      categoryConfidence: item.categoryConfidence,
    };
  }

  private toSummary(
    row: NewsEventClusteringFailureSummaryRow,
  ): NewsEventClusteringFailureSummary {
    return {
      groupId: row.groupId ?? "",
      status: row.status ?? "pending",
      clusteringMode: row.clusteringMode ?? "bertopic_primary",
      failureReason: row.failureReason ?? "unknown_failure",
      failureMessage: row.failureMessage ?? null,
      language: row.language ?? null,
      embeddingModel: row.embeddingModel ?? null,
      itemCount: row.itemCount ?? 0,
      sampleTitles: Array.isArray(row.sampleTitles)
        ? row.sampleTitles.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      attemptCount: row.attemptCount ?? 0,
      lastAttemptAt: row.lastAttemptAt
        ? new Date(row.lastAttemptAt).toISOString()
        : null,
      lastError: row.lastError ?? null,
      resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
      resolutionMode: row.resolutionMode ?? null,
      resolvedEventIds: Array.isArray(row.resolvedEventIds)
        ? row.resolvedEventIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : "",
    };
  }
}
