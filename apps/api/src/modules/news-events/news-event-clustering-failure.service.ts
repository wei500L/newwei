import { NewsEventClusteringFailureModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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

export type NewsEventClusteringFailureStatus =
  | "pending"
  | "processing"
  | "resolved"
  | "ignored";

export interface NewsEventClusteringFailureSummary {
  groupId: string;
  status: NewsEventClusteringFailureStatus;
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
  activeJobId: string | null;
  progressProcessedCount: number;
  progressTotalCount: number;
  lastRecoveryModel: string | null;
  resolvedAt: string | null;
  resolutionMode: string | null;
  resolvedEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewsEventClusteringFailureOverview {
  pendingCount: number;
  processingCount: number;
  resolvedCount: number;
  ignoredCount: number;
  latestFailureAt: string | null;
}

export interface NewsEventClusteringFailureRecord {
  orgId: string;
  groupId: string;
  status: NewsEventClusteringFailureStatus;
  attemptCount: number;
  items: NewsEventClusteringFailureItemInput[];
  activeJobId: string | null;
  progressProcessedCount: number;
  progressTotalCount: number;
  lastRecoveryModel: string | null;
  lastError: string | null;
  resolvedEventIds: string[];
}

export interface NewsEventClusteringAutoRetryCandidate {
  orgId: string;
  groupId: string;
  attemptCount: number;
  itemCount: number;
  lastAttemptAt: Date | null;
}

interface NewsEventClusteringFailureSummaryRow {
  orgId?: string | null;
  groupId?: string | null;
  status?: NewsEventClusteringFailureStatus | null;
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
  activeJobId?: string | null;
  progressProcessedCount?: number | null;
  progressTotalCount?: number | null;
  lastRecoveryModel?: string | null;
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
          activeJobId: null,
          progressProcessedCount: 0,
          progressTotalCount: itemCount,
          lastRecoveryModel: null,
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

  async getOverview(
    orgId: string,
  ): Promise<NewsEventClusteringFailureOverview> {
    const [
      pendingCount,
      processingCount,
      resolvedCount,
      ignoredCount,
      latestFailure,
    ] = await Promise.all([
      NewsEventClusteringFailureModel.countDocuments({
        orgId,
        status: "pending",
      }),
      NewsEventClusteringFailureModel.countDocuments({
        orgId,
        status: "processing",
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
      processingCount,
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
      status?: NewsEventClusteringFailureStatus;
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

  async listPendingAutoRetryCandidates(options?: {
    limit?: number;
    retryAfterMs?: number;
    now?: Date;
  }): Promise<NewsEventClusteringAutoRetryCandidate[]> {
    const limit = Math.min(Math.max(options?.limit ?? 25, 1), 100);
    const retryAfterMs = Math.max(options?.retryAfterMs ?? 15 * 60 * 1000, 0);
    const now = options?.now ?? new Date();
    const retryBefore = new Date(now.getTime() - retryAfterMs);
    const rows = await NewsEventClusteringFailureModel.find({
      status: "pending",
      clusteringMode: "bertopic_primary",
      itemCount: { $gt: 0 },
      $or: [{ lastAttemptAt: null }, { lastAttemptAt: { $lte: retryBefore } }],
    })
      .sort({ lastAttemptAt: 1, createdAt: 1 })
      .limit(limit)
      .select({
        orgId: 1,
        groupId: 1,
        attemptCount: 1,
        itemCount: 1,
        lastAttemptAt: 1,
      })
      .lean()
      .exec();

    return rows
      .map((row) => ({
        orgId: this.normalizeRowString(row.orgId),
        groupId: this.normalizeRowString(row.groupId),
        attemptCount: Math.max(0, Number(row.attemptCount ?? 0)),
        itemCount: Math.max(0, Number(row.itemCount ?? 0)),
        lastAttemptAt: row.lastAttemptAt ? new Date(row.lastAttemptAt) : null,
      }))
      .filter((row) => row.orgId && row.groupId);
  }

  async getFailureGroupOrThrow(
    orgId: string,
    groupId: string,
  ): Promise<NewsEventClusteringFailureRecord> {
    const row = await NewsEventClusteringFailureModel.findOne({
      orgId,
      groupId,
    })
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException("News event clustering failure not found");
    }

    return {
      orgId,
      groupId: row.groupId ?? groupId,
      status: row.status ?? "pending",
      attemptCount: Math.max(0, Number(row.attemptCount ?? 0)),
      items: Array.isArray(row.items)
        ? (row.items as NewsEventClusteringFailureItemInput[])
        : [],
      activeJobId:
        typeof row.activeJobId === "string" && row.activeJobId.trim().length > 0
          ? row.activeJobId.trim()
          : null,
      progressProcessedCount: Math.max(
        0,
        Number(row.progressProcessedCount ?? 0),
      ),
      progressTotalCount: Math.max(0, Number(row.progressTotalCount ?? 0)),
      lastRecoveryModel:
        typeof row.lastRecoveryModel === "string" &&
        row.lastRecoveryModel.trim().length > 0
          ? row.lastRecoveryModel.trim()
          : null,
      lastError: row.lastError ?? null,
      resolvedEventIds: Array.isArray(row.resolvedEventIds)
        ? row.resolvedEventIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    };
  }

  async markLlmBackfillQueued(input: {
    orgId: string;
    actorId: string;
    groupId: string;
    jobId: string;
    model: string | null;
  }) {
    const startedAt = new Date();
    const row = await NewsEventClusteringFailureModel.findOneAndUpdate(
      {
        orgId: input.orgId,
        groupId: input.groupId,
        status: "pending",
      },
      [
        {
          $set: {
            status: "processing",
            lastAttemptAt: startedAt,
            lastError: null,
            activeJobId: input.jobId,
            progressProcessedCount: 0,
            progressTotalCount: {
              $size: {
                $ifNull: ["$items", []],
              },
            },
            lastRecoveryModel: input.model,
            resolvedAt: null,
            resolvedById: null,
            resolutionMode: null,
            resolvedEventIds: [],
            attemptCount: {
              $add: [{ $ifNull: ["$attemptCount", 0] }, 1],
            },
          },
        },
      ],
      { new: true },
    )
      .lean()
      .exec();

    if (!row) {
      const existing = await this.getFailureGroupOrThrow(
        input.orgId,
        input.groupId,
      );
      if (existing.status === "processing") {
        throw new BadRequestException("Failure group is already processing");
      }
      if (existing.status === "resolved" || existing.status === "ignored") {
        throw new BadRequestException(
          "Failure group can no longer be recovered",
        );
      }
      throw new BadRequestException("Failure group is not ready for recovery");
    }

    const attemptCount = Math.max(0, Number(row.attemptCount ?? 0));
    const progressTotalCount = Math.max(
      0,
      Number(
        row.progressTotalCount ??
          (Array.isArray(row.items) ? row.items.length : 0),
      ),
    );

    return {
      attemptCount,
      startedAt,
      progressTotalCount,
    };
  }

  async updateLlmBackfillProgress(input: {
    orgId: string;
    groupId: string;
    processedCount: number;
    totalCount: number;
    jobId?: string | null;
    model?: string | null;
  }) {
    await NewsEventClusteringFailureModel.updateOne(
      { orgId: input.orgId, groupId: input.groupId },
      {
        $set: {
          status: "processing",
          progressProcessedCount: Math.max(0, input.processedCount),
          progressTotalCount: Math.max(0, input.totalCount),
          ...(input.jobId ? { activeJobId: input.jobId } : {}),
          ...(input.model ? { lastRecoveryModel: input.model } : {}),
        },
      },
    ).exec();
  }

  async markLlmBackfillResolved(input: {
    orgId: string;
    actorId: string;
    groupId: string;
    processedCount: number;
    totalCount: number;
    model: string | null;
    resolvedEventIds: string[];
  }) {
    const resolvedAt = new Date();
    await NewsEventClusteringFailureModel.updateOne(
      { orgId: input.orgId, groupId: input.groupId },
      {
        $set: {
          status: "resolved",
          progressProcessedCount: Math.max(0, input.processedCount),
          progressTotalCount: Math.max(0, input.totalCount),
          lastError: null,
          activeJobId: null,
          resolvedAt,
          resolvedById: input.actorId,
          resolutionMode: "llm_backfill",
          resolvedEventIds: input.resolvedEventIds.slice().sort(),
          lastRecoveryModel: input.model,
        },
      },
    ).exec();
    return resolvedAt;
  }

  async markLlmBackfillFailed(input: {
    orgId: string;
    groupId: string;
    processedCount: number;
    totalCount: number;
    errorMessage: string;
    model: string | null;
  }) {
    await NewsEventClusteringFailureModel.updateOne(
      { orgId: input.orgId, groupId: input.groupId },
      {
        $set: {
          status: "pending",
          progressProcessedCount: Math.max(0, input.processedCount),
          progressTotalCount: Math.max(0, input.totalCount),
          lastError: input.errorMessage,
          activeJobId: null,
          lastRecoveryModel: input.model,
        },
      },
    ).exec();
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
    const status = row.status ?? "pending";
    if (status === "processing") {
      throw new BadRequestException("Failure group is already processing");
    }
    if (status === "resolved" || status === "ignored") {
      throw new BadRequestException("Failure group can no longer be recovered");
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
            activeJobId: null,
            progressProcessedCount: items.length,
            progressTotalCount: items.length,
            lastRecoveryModel: row.lastRecoveryModel ?? null,
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
            activeJobId: null,
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

      this.logger.warn(
        { err: error, orgId, groupId },
        "Vector backfill failed",
      );
      throw error;
    }
  }

  async ignoreFailureGroup(orgId: string, actorId: string, groupId: string) {
    const result = await NewsEventClusteringFailureModel.findOneAndUpdate(
      { orgId, groupId },
      {
        $set: {
          status: "ignored",
          activeJobId: null,
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

  private normalizeRowString(value: string | null | undefined) {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
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
      activeJobId: row.activeJobId ?? null,
      progressProcessedCount: Math.max(
        0,
        Number(row.progressProcessedCount ?? 0),
      ),
      progressTotalCount: Math.max(0, Number(row.progressTotalCount ?? 0)),
      lastRecoveryModel: row.lastRecoveryModel ?? null,
      resolvedAt: row.resolvedAt
        ? new Date(row.resolvedAt).toISOString()
        : null,
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
