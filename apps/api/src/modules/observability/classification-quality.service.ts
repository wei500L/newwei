import {
  ClassificationAnnotationModel,
  ClassificationReportJobModel,
  ClassificationReportResultModel,
  ClassificationReviewModel,
  ClassificationSampleModel,
  ProcessedItemModel,
  TaskLogModel,
} from "@modular/mongo";
import {
  createLogger,
  ensureTraceId,
  getCurrentTraceId,
  NotificationPresentationKind,
} from "@modular/utils";
import { NotificationType } from "@prisma/client";
import { Queue } from "bullmq";
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";

import { writeAuditLogBestEffort } from "../../modules/audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { NewsClassificationQualitySettingsService } from "../news-pipeline/news-classification-quality-settings.service";
import {
  classifySourceByLabelAndUrl,
  getDefaultNewsEventSourcePolicy,
  normalizeSourcePolicy,
  type ClassifiedSourceType,
  type NewsEventSourcePolicy,
} from "../news-events/news-event-source-classifier";
import { NotificationsService } from "../notifications/notifications.service";
import {
  CLASSIFICATION_QUALITY_QUEUE,
  type ClassificationQualityJobPayload,
} from "./classification-quality.constants";

interface SourceInfo {
  id: string;
  name: string;
  url: string;
}

interface ArticleContext {
  processedItemId: string;
  articleUrl: string | null;
  sourceId: string | null;
}

type ConfidenceBand = "low" | "medium" | "high";

export interface ClassificationQualitySummary {
  window: "1h" | "24h" | "7d";
  from: string;
  to: string;
  totalItems: number;
  methodDistribution: Array<{
    group: "llm_embedding_rerank" | "rule_fallback";
    count: number;
    share: number;
  }>;
  confidenceHistogram: Array<{
    bucket: string;
    min: number;
    max: number;
    count: number;
  }>;
  confidenceTrend: Array<{
    bucketStart: string;
    total: number;
    avgConfidence: number | null;
    lowConfidenceCount: number;
  }>;
  lowConfidenceSources: Array<{
    sourceId: string;
    sourceName: string;
    sourceUrl: string;
    total: number;
    lowConfidenceCount: number;
    lowConfidenceRate: number;
    avgConfidence: number | null;
  }>;
  latencyPercentiles: {
    llm: {
      sampleSize: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
    embedding: {
      sampleSize: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
    rerank: {
      sampleSize: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
  };
  categoryGate: {
    reject: number;
    penalized: number;
    total: number;
    rejectRate: number;
    penalizedRate: number;
  };
  sourceCategoryBreakdown: Array<{
    sourceType: ClassifiedSourceType;
    categoryPrefix: string;
    count: number;
  }>;
  pendingReviewCount: number;
  alertStatus: Array<{
    stage: "llm" | "embedding" | "rerank";
    thresholdMs: number;
    p95Ms: number | null;
    triggered: boolean;
  }>;
  gateAlertStatus: Array<{
    metric: "reject_rate" | "penalized_rate";
    threshold: number;
    value: number;
    triggered: boolean;
  }>;
  sampling: {
    classifiedItems: {
      matched: number;
      scanned: number;
      limit: number;
      truncated: boolean;
      coverage: number;
    };
    latencyLogs: {
      matched: number;
      scanned: number;
      limit: number;
      truncated: boolean;
      coverage: number;
    };
    gateLogs: {
      matched: number;
      scanned: number;
      limit: number;
      truncated: boolean;
      coverage: number;
    };
  };
}

export interface ClassificationSourceItemsResponse {
  sourceId: string;
  from: string;
  to: string;
  items: Array<{
    processedItemId: string;
    itemMetaId: string | null;
    articleUrl: string | null;
    articleTitle: string | null;
    articleSummary: string | null;
    categoryPath: string | null;
    confidence: number | null;
    method: string | null;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

const SUMMARY_CACHE_TTL_SECONDS = 60;
const SUMMARY_CACHE_PREFIX = "quality:classification:summary:";
const SOURCE_ITEMS_LIMIT_DEFAULT = 50;
const SOURCE_ITEMS_LIMIT_MAX = 200;
const REVIEW_QUEUE_LIMIT_DEFAULT = 50;
const REVIEW_QUEUE_LIMIT_MAX = 200;
const SAMPLING_FETCH_LIMIT = 3000;
const SUMMARY_ITEMS_LIMIT = 10_000;
const LATENCY_LOGS_LIMIT = 20_000;
const GATE_LOGS_LIMIT = 20_000;
const GATE_SETTINGS_KEY_PREFIX = "news_event_settings:";
const SOURCE_POLICY_KEY_PREFIX = "news_event_source_policy:";
const REVIEW_RETENTION_DAYS = 180;
const SAMPLE_RETENTION_DAYS = 180;
const ANNOTATION_RETENTION_DAYS = 365;
const REPORT_JOB_RETENTION_DAYS = 365;
const REPORT_RESULT_RETENTION_DAYS = 365;
const ALERT_NOTIFICATION_CACHE_PREFIX = "quality:classification:alert:notify:";
const ALERT_NOTIFICATION_TTL_SECONDS = 15 * 60;
const ALERT_RECIPIENTS_CACHE_PREFIX =
  "quality:classification:alert:recipients:";
const ALERT_RECIPIENTS_CACHE_TTL_SECONDS = 5 * 60;
const SETTINGS_MANAGE_PERMISSION = "settings.manage";
const REVIEW_SEED_QUEUE_JOB_PREFIX = "classification-quality-review-seed-item:";

@Injectable()
export class ClassificationQualityService {
  private readonly logger = createLogger({ name: "classification-quality" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly qualitySettings: NewsClassificationQualitySettingsService,
    private readonly notifications: NotificationsService,
    @Inject(CLASSIFICATION_QUALITY_QUEUE)
    private readonly reportQueue: Queue<ClassificationQualityJobPayload>,
  ) {}

  async getSummary(input: {
    orgId: string;
    window: "1h" | "24h" | "7d";
    sourceId?: string;
    categoryPrefix?: string;
  }): Promise<ClassificationQualitySummary> {
    const cacheKey = `${SUMMARY_CACHE_PREFIX}${input.orgId}:${input.window}:${input.sourceId ?? "all"}:${input.categoryPrefix ?? "all"}`;
    return this.cache.wrap(
      cacheKey,
      SUMMARY_CACHE_TTL_SECONDS,
      async () => this.buildSummary(input),
      { lockTtlMs: 2000, retryDelayMs: 50, maxWaitMs: 3000 },
    );
  }

  async getLowConfidenceSourceItems(input: {
    orgId: string;
    sourceId: string;
    window: "1h" | "24h" | "7d";
    maxConfidence?: number;
    limit?: number;
    cursor?: string;
  }): Promise<ClassificationSourceItemsResponse> {
    const { from, to } = this.resolveWindow(input.window);
    const settings = await this.qualitySettings.getSettings(input.orgId);
    const maxConfidence =
      typeof input.maxConfidence === "number" &&
      Number.isFinite(input.maxConfidence)
        ? Math.max(0, Math.min(1, input.maxConfidence))
        : settings.lowConfidenceThreshold;
    const limit = Math.max(
      1,
      Math.min(
        SOURCE_ITEMS_LIMIT_MAX,
        Math.floor(input.limit ?? SOURCE_ITEMS_LIMIT_DEFAULT),
      ),
    );
    const beforeCursor = this.parseCursor(input.cursor);

    const where: Record<string, unknown> = {
      orgId: input.orgId,
      status: "completed",
      sourceId: input.sourceId,
      createdAt: {
        $gte: from,
        $lte: to,
        ...(beforeCursor ? { $lt: beforeCursor } : {}),
      },
      "result.category_confidence": { $type: "number", $lte: maxConfidence },
    };

    const docs = await ProcessedItemModel.find(where)
      .select({
        _id: 1,
        itemMetaId: 1,
        createdAt: 1,
        "result.title": 1,
        "result.summary": 1,
        "result.category_path": 1,
        "result.category_confidence": 1,
        "result.category_method": 1,
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const processedItemIds = docs
      .map((doc) => this.readId(doc?._id))
      .filter((entry): entry is string => Boolean(entry));
    const articleContextMap = await this.loadArticleContextMap(
      input.orgId,
      processedItemIds,
    );

    const items = docs.map((doc) => {
      const processedItemId = this.readId(doc?._id) ?? "";
      const result = this.readResultRecord(doc?.result);
      const articleContext = articleContextMap.get(processedItemId);
      return {
        processedItemId,
        itemMetaId: this.readString(doc?.itemMetaId),
        articleUrl: articleContext?.articleUrl ?? null,
        articleTitle: this.readString(result?.title),
        articleSummary: this.readString(result?.summary),
        categoryPath: this.readString(result?.category_path),
        confidence: this.readConfidence(result?.category_confidence),
        method: this.readString(result?.category_method),
        createdAt:
          this.readDate(doc?.createdAt)?.toISOString() ??
          new Date().toISOString(),
      };
    });

    const last = docs[docs.length - 1];
    const nextCursor = last
      ? (this.readDate(last.createdAt)?.toISOString() ?? null)
      : null;

    return {
      sourceId: input.sourceId,
      from: from.toISOString(),
      to: to.toISOString(),
      items,
      nextCursor,
    };
  }

  async listReviewQueue(input: {
    orgId: string;
    actorId: string;
    window: "1h" | "24h" | "7d";
    onlyUnreviewed: boolean;
    limit?: number;
    maxConfidence?: number;
  }) {
    const { from, to } = this.resolveWindow(input.window);
    const limit = Math.max(
      1,
      Math.min(
        REVIEW_QUEUE_LIMIT_MAX,
        Math.floor(input.limit ?? REVIEW_QUEUE_LIMIT_DEFAULT),
      ),
    );
    const where: Record<string, unknown> = {
      orgId: input.orgId,
      createdAt: { $gte: from, $lte: to },
      ...(input.onlyUnreviewed ? { status: "pending" } : {}),
      ...(typeof input.maxConfidence === "number"
        ? {
            predictedConfidence: {
              $lte: Math.max(0, Math.min(1, input.maxConfidence)),
            },
          }
        : {}),
    };

    const rows = await ClassificationReviewModel.find(where)
      .select({
        _id: 1,
        evidenceId: 1,
        processedItemId: 1,
        itemMetaId: 1,
        sourceId: 1,
        sourceType: 1,
        articleUrl: 1,
        articleTitle: 1,
        articleSummary: 1,
        predictedCategoryPath: 1,
        predictedLegacyCategory: 1,
        predictedConfidence: 1,
        predictedMethod: 1,
        candidatePaths: 1,
        status: 1,
        correctedCategoryPath: 1,
        note: 1,
        quickTags: 1,
        reviewerId: 1,
        reviewedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return rows.map((row) => ({
      id: this.readId(row?._id) ?? "",
      evidenceId: this.readString(row?.evidenceId),
      processedItemId: this.readString(row?.processedItemId),
      itemMetaId: this.readString(row?.itemMetaId),
      sourceId: this.readString(row?.sourceId),
      sourceType: this.readString(row?.sourceType),
      articleUrl: this.readString(row?.articleUrl),
      articleTitle: this.readString(row?.articleTitle),
      articleSummary: this.readString(row?.articleSummary),
      predictedCategoryPath: this.readString(row?.predictedCategoryPath),
      predictedLegacyCategory: this.readString(row?.predictedLegacyCategory),
      predictedConfidence: this.readConfidence(row?.predictedConfidence),
      predictedMethod: this.readString(row?.predictedMethod),
      candidatePaths: Array.isArray(row?.candidatePaths)
        ? row.candidatePaths
        : [],
      status: this.readString(row?.status) ?? "pending",
      correctedCategoryPath: this.readString(row?.correctedCategoryPath),
      note: this.readString(row?.note),
      quickTags: this.readStringArray(row?.quickTags),
      reviewerId: this.readString(row?.reviewerId),
      reviewedAt: this.readDate(row?.reviewedAt)?.toISOString() ?? null,
      createdAt:
        this.readDate(row?.createdAt)?.toISOString() ??
        new Date().toISOString(),
      updatedAt:
        this.readDate(row?.updatedAt)?.toISOString() ??
        new Date().toISOString(),
    }));
  }

  async submitReviewDecision(input: {
    orgId: string;
    actorId: string;
    reviewId: string;
    status: "approved" | "rejected" | "corrected";
    correctedCategoryPath?: string | null;
    note?: string | null;
    quickTags?: string[];
  }) {
    const reviewId = input.reviewId.trim();
    if (!reviewId) {
      throw new BadRequestException("reviewId is required");
    }

    const row = await ClassificationReviewModel.findOne({
      _id: reviewId,
      orgId: input.orgId,
    })
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException("Review item not found");
    }

    await ClassificationReviewModel.updateOne(
      { _id: reviewId, orgId: input.orgId },
      {
        $set: {
          status: input.status,
          correctedCategoryPath:
            input.status === "corrected"
              ? this.normalizePath(input.correctedCategoryPath)
              : null,
          note: this.normalizeText(input.note, 500),
          quickTags: this.normalizeQuickTags(input.quickTags),
          reviewerId: input.actorId,
          reviewedAt: new Date(),
        },
      },
    ).exec();

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: input.orgId,
          actorId: input.actorId,
          resource: "classification_review",
          action: "classification_review_decision",
          metadata: {
            reviewId,
            status: input.status,
          },
        },
      },
      {
        orgId: input.orgId,
        actorId: input.actorId,
        reviewId,
        status: input.status,
      },
    );

    return ClassificationReviewModel.findOne({
      _id: reviewId,
      orgId: input.orgId,
    })
      .lean()
      .exec();
  }

  async batchReviewDecision(input: {
    orgId: string;
    actorId: string;
    reviewIds: string[];
    status: "approved" | "rejected" | "corrected";
    correctedCategoryPath?: string | null;
    note?: string | null;
    quickTags?: string[];
  }) {
    const reviewIds = Array.from(
      new Set(
        (input.reviewIds ?? [])
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ).slice(0, 500);

    if (reviewIds.length === 0) {
      return { matched: 0, modified: 0 };
    }

    const result = await ClassificationReviewModel.updateMany(
      {
        orgId: input.orgId,
        _id: { $in: reviewIds },
      },
      {
        $set: {
          status: input.status,
          correctedCategoryPath:
            input.status === "corrected"
              ? this.normalizePath(input.correctedCategoryPath)
              : null,
          note: this.normalizeText(input.note, 500),
          quickTags: this.normalizeQuickTags(input.quickTags),
          reviewerId: input.actorId,
          reviewedAt: new Date(),
        },
      },
    ).exec();

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId: input.orgId,
          actorId: input.actorId,
          resource: "classification_review",
          action: "classification_review_batch_decision",
          metadata: {
            count: reviewIds.length,
            status: input.status,
          },
        },
      },
      {
        orgId: input.orgId,
        actorId: input.actorId,
        count: reviewIds.length,
        status: input.status,
      },
    );

    return {
      matched: result.matchedCount ?? 0,
      modified: result.modifiedCount ?? 0,
    };
  }

  async createSample(input: {
    orgId: string;
    actorId: string;
    window: "1h" | "24h" | "7d";
    sourceType?: ClassifiedSourceType;
    categoryPrefix?: string;
    sourceIds?: string[];
    confidenceBands?: ConfidenceBand[];
    methods?: string[];
    perStratum?: number;
  }) {
    const { from, to } = this.resolveWindow(input.window);
    const policy = await this.getSourcePolicy(input.orgId);
    const sourceFilterSet = this.toSet(input.sourceIds);
    const methodFilterSet = this.toSet(input.methods);
    const bandFilterSet = this.toSet(input.confidenceBands);
    const perStratum = Math.max(
      1,
      Math.min(200, Math.floor(input.perStratum ?? 20)),
    );
    const sourceFilterValues = Array.from(sourceFilterSet);
    const methodFilterValues = Array.from(methodFilterSet);
    const normalizedCategoryPrefix = this.normalizePath(input.categoryPrefix);
    const categoryPrefixRegex = normalizedCategoryPrefix
      ? this.buildCategoryPrefixRegex(normalizedCategoryPrefix)
      : null;

    const docs = await ProcessedItemModel.find({
      orgId: input.orgId,
      status: "completed",
      createdAt: { $gte: from, $lte: to },
      "result.category_confidence": { $type: "number" },
      ...(sourceFilterValues.length > 0
        ? { sourceId: { $in: sourceFilterValues } }
        : {}),
      ...(methodFilterValues.length > 0
        ? {
            "result.category_method": {
              $in: methodFilterValues,
            },
          }
        : {}),
      ...(categoryPrefixRegex
        ? {
            "result.category_path": {
              $regex: categoryPrefixRegex,
            },
          }
        : {}),
    })
      .select({
        _id: 1,
        itemMetaId: 1,
        sourceId: 1,
        createdAt: 1,
        "result.title": 1,
        "result.summary": 1,
        "result.source": 1,
        "result.category": 1,
        "result.category_path": 1,
        "result.category_confidence": 1,
        "result.category_method": 1,
      })
      .sort({ createdAt: -1 })
      .limit(SAMPLING_FETCH_LIMIT)
      .lean();

    const processedItemIds = docs
      .map((doc) => this.readId(doc?._id))
      .filter((entry): entry is string => Boolean(entry));
    const articleContextMap = await this.loadArticleContextMap(
      input.orgId,
      processedItemIds,
    );
    const sourceIds = Array.from(
      new Set(
        docs
          .flatMap((doc) => {
            const processedItemId = this.readId(doc?._id);
            const articleContext = processedItemId
              ? articleContextMap.get(processedItemId)
              : undefined;
            return [
              this.readString(doc.sourceId),
              articleContext?.sourceId ?? null,
            ];
          })
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
    const sourceMap = await this.loadSourceMapByIds(input.orgId, sourceIds);

    const strataMap = new Map<string, Array<Record<string, unknown>>>();
    for (const doc of docs) {
      const processedItemId = this.readId(doc?._id);
      if (!processedItemId) {
        continue;
      }
      const result = this.readResultRecord(doc.result);
      const confidence = this.readConfidence(result?.category_confidence);
      if (confidence === null) {
        continue;
      }
      const band = this.toConfidenceBand(confidence);
      if (bandFilterSet.size > 0 && !bandFilterSet.has(band)) {
        continue;
      }

      const method = this.normalizeMethod(result?.category_method);
      const categoryPath = this.readString(result?.category_path);

      const sourceId = this.readString(doc.sourceId);
      const articleContext = articleContextMap.get(processedItemId);
      const sourceInfo =
        (sourceId && sourceMap.get(sourceId)) ||
        (articleContext?.sourceId
          ? sourceMap.get(articleContext.sourceId)
          : undefined) ||
        null;
      const sourceType = classifySourceByLabelAndUrl(
        sourceInfo?.name ?? result?.source,
        sourceInfo?.url ?? articleContext?.articleUrl ?? null,
        policy,
      );
      if (input.sourceType && sourceType !== input.sourceType) {
        continue;
      }

      const key = `${band}|${method}`;
      const list = strataMap.get(key) ?? [];
      list.push({
        processedItemId,
        itemMetaId: this.readString(doc.itemMetaId),
        sourceId: sourceId ?? articleContext?.sourceId ?? null,
        sourceType,
        articleUrl: articleContext?.articleUrl ?? null,
        articleTitle: this.readString(result?.title),
        predictedCategoryPath: categoryPath,
        predictedLegacyCategory: this.readString(result?.category),
        predictedConfidence: confidence,
        predictedMethod: method,
        confidenceBand: band,
        sampledAt: this.readDate(doc.createdAt) ?? new Date(),
      });
      strataMap.set(key, list);
    }

    const selectedItems: Record<string, unknown>[] = [];
    for (const entries of strataMap.values()) {
      this.shuffleInPlace(entries);
      selectedItems.push(...entries.slice(0, perStratum));
    }

    const sampleDoc = await ClassificationSampleModel.create({
      orgId: input.orgId,
      createdById: input.actorId,
      expiresAt: this.computeExpiryDate(SAMPLE_RETENTION_DAYS),
      filters: {
        window: input.window,
        sourceType: input.sourceType ?? null,
        sourceIds: sourceFilterSet.size > 0 ? Array.from(sourceFilterSet) : [],
        categoryPrefix: input.categoryPrefix ?? null,
        confidenceBands:
          bandFilterSet.size > 0 ? Array.from(bandFilterSet) : [],
        methods: methodFilterSet.size > 0 ? Array.from(methodFilterSet) : [],
      },
      strata: Array.from(strataMap.entries()).map(([key, rows]) => ({
        key,
        count: rows.length,
      })),
      itemCount: selectedItems.length,
      items: selectedItems,
    });

    return {
      sampleId: this.readId(sampleDoc?._id),
      itemCount: selectedItems.length,
      strata: Array.from(strataMap.entries()).map(([key, rows]) => ({
        key,
        count: rows.length,
      })),
      items: selectedItems,
      createdAt:
        this.readDate(sampleDoc?.createdAt)?.toISOString() ??
        new Date().toISOString(),
    };
  }

  async submitAnnotations(input: {
    orgId: string;
    actorId: string;
    sampleId: string;
    annotations: Array<{
      processedItemId: string;
      humanCategoryPath: string;
      note?: string | null;
      quickTags?: string[];
    }>;
  }) {
    const sampleId = input.sampleId.trim();
    if (!sampleId) {
      throw new BadRequestException("sampleId is required");
    }
    const sample = await ClassificationSampleModel.findOne({
      _id: sampleId,
      orgId: input.orgId,
    })
      .lean()
      .exec();
    if (!sample) {
      throw new NotFoundException("Sample not found");
    }

    const sampleItems = new Map<string, Record<string, unknown>>();
    for (const item of Array.isArray(sample.items) ? sample.items : []) {
      const processedItemId = this.readString(item?.processedItemId);
      if (processedItemId) {
        sampleItems.set(
          processedItemId,
          item as unknown as Record<string, unknown>,
        );
      }
    }

    let updated = 0;
    for (const annotation of input.annotations) {
      const processedItemId = annotation.processedItemId.trim();
      if (!processedItemId) {
        continue;
      }
      const humanCategoryPath = this.normalizePath(
        annotation.humanCategoryPath,
      );
      if (!humanCategoryPath) {
        continue;
      }
      const sampleItem = sampleItems.get(processedItemId);
      if (!sampleItem) {
        continue;
      }

      await ClassificationAnnotationModel.findOneAndUpdate(
        {
          orgId: input.orgId,
          sampleId,
          processedItemId,
        },
        {
          $set: {
            annotatorId: input.actorId,
            predictedCategoryPath: this.readString(
              sampleItem.predictedCategoryPath,
            ),
            predictedMethod: this.readString(sampleItem.predictedMethod),
            predictedConfidence: this.readConfidence(
              sampleItem.predictedConfidence,
            ),
            humanCategoryPath,
            note: this.normalizeText(annotation.note, 500),
            quickTags: this.normalizeQuickTags(annotation.quickTags),
          },
          $setOnInsert: {
            expiresAt: this.computeExpiryDate(ANNOTATION_RETENTION_DAYS),
          },
        },
        { upsert: true, new: true },
      ).exec();
      updated += 1;
    }

    const metrics = await this.computeSampleMetrics(input.orgId, sampleId);
    return {
      sampleId,
      updated,
      ...metrics,
    };
  }

  async createReportJob(input: {
    orgId: string;
    actorId: string;
    sampleId?: string | null;
  }) {
    const sampleId = this.readString(input.sampleId);
    const job = await ClassificationReportJobModel.create({
      orgId: input.orgId,
      requestedById: input.actorId,
      sampleId,
      status: "pending",
      progress: 0,
      expiresAt: this.computeExpiryDate(REPORT_JOB_RETENTION_DAYS),
    });
    const jobId = this.readId(job?._id) ?? "";

    try {
      const traceId = ensureTraceId(getCurrentTraceId());
      await this.reportQueue.add(
        `classification-quality-report:${jobId}`,
        {
          jobType: "report",
          orgId: input.orgId,
          reportJobId: jobId,
          traceId,
        },
        {
          jobId: `classification-quality-report:${jobId}`,
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 2000,
          },
        },
      );
    } catch (error) {
      this.logger.error(
        { err: error, orgId: input.orgId, jobId },
        "Failed to enqueue classification report job",
      );
      await ClassificationReportJobModel.updateOne(
        { _id: jobId, orgId: input.orgId },
        {
          $set: {
            status: "failed",
            completedAt: new Date(),
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
        },
      ).exec();
      throw new InternalServerErrorException(
        "Failed to enqueue classification report job",
      );
    }

    return {
      jobId,
      status: "pending",
      sampleId,
      createdAt:
        this.readDate(job?.createdAt)?.toISOString() ??
        new Date().toISOString(),
    };
  }

  async enqueueReviewSeedItemJob(input: {
    orgId: string;
    processedItemId: string;
  }) {
    const processedItemId = input.processedItemId.trim();
    if (!processedItemId) {
      return;
    }
    const traceId = ensureTraceId(getCurrentTraceId());
    const jobId = `${REVIEW_SEED_QUEUE_JOB_PREFIX}${input.orgId}:${processedItemId}`;
    try {
      await this.reportQueue.add(
        jobId,
        {
          jobType: "review_seed_item",
          orgId: input.orgId,
          processedItemId,
          traceId,
        },
        {
          jobId,
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 2000,
          },
        },
      );
    } catch (error) {
      this.logger.warn(
        { err: error, orgId: input.orgId, processedItemId },
        "Failed to enqueue classification review seed item job",
      );
    }
  }

  async getReportJob(input: { orgId: string; jobId: string }) {
    const job = await ClassificationReportJobModel.findOne({
      _id: input.jobId,
      orgId: input.orgId,
    })
      .lean()
      .exec();
    if (!job) {
      return null;
    }
    const reportResultId = this.readString(job.reportResultId);
    const result =
      reportResultId &&
      (await ClassificationReportResultModel.findOne({
        _id: reportResultId,
        orgId: input.orgId,
      })
        .lean()
        .exec());
    return {
      job: {
        id: this.readId(job?._id),
        status: this.readString(job?.status) ?? "pending",
        sampleId: this.readString(job?.sampleId),
        progress:
          typeof job?.progress === "number" && Number.isFinite(job.progress)
            ? Math.max(0, Math.min(1, job.progress))
            : 0,
        startedAt: this.readDate(job?.startedAt)?.toISOString() ?? null,
        completedAt: this.readDate(job?.completedAt)?.toISOString() ?? null,
        error: job?.error ?? null,
        createdAt:
          this.readDate(job?.createdAt)?.toISOString() ??
          new Date().toISOString(),
        updatedAt:
          this.readDate(job?.updatedAt)?.toISOString() ??
          new Date().toISOString(),
      },
      result: result
        ? {
            id: this.readId(result?._id),
            total: this.readNumber(result?.total) ?? 0,
            correct: this.readNumber(result?.correct) ?? 0,
            accuracy: this.readConfidence(result?.accuracy) ?? 0,
            confusionMatrix: Array.isArray(result?.confusionMatrix)
              ? result.confusionMatrix
              : [],
            problemPathPairs: Array.isArray(result?.problemPathPairs)
              ? result.problemPathPairs
              : [],
            metadata: result?.metadata ?? null,
          }
        : null,
    };
  }

  async processReviewSeedItemJob(input: {
    orgId: string;
    processedItemId: string;
  }) {
    const processedItemId = input.processedItemId.trim();
    if (!processedItemId) {
      return;
    }

    const gateThreshold = await this.getGateMinConfidence(input.orgId);
    const doc = await ProcessedItemModel.findOne({
      _id: processedItemId,
      orgId: input.orgId,
      status: "completed",
    })
      .select({
        _id: 1,
        itemMetaId: 1,
        sourceId: 1,
        "result.title": 1,
        "result.summary": 1,
        "result.source": 1,
        "result.category": 1,
        "result.category_path": 1,
        "result.category_confidence": 1,
        "result.category_method": 1,
        "result.category_candidates": 1,
        createdAt: 1,
      })
      .lean();
    if (!doc) {
      return;
    }

    const result = this.readResultRecord(doc.result);
    const confidence = this.readConfidence(result?.category_confidence);
    if (confidence === null || confidence >= gateThreshold) {
      return;
    }

    const policy = await this.getSourcePolicy(input.orgId);
    const articleContextMap = await this.loadArticleContextMap(input.orgId, [
      processedItemId,
    ]);
    const sourceId = this.readString(doc.sourceId);
    const articleContext = articleContextMap.get(processedItemId);
    const resolvedSourceId = sourceId ?? articleContext?.sourceId ?? null;
    const sourceInfo = resolvedSourceId
      ? await this.loadSourceInfo(input.orgId, resolvedSourceId)
      : null;
    const sourceType = classifySourceByLabelAndUrl(
      sourceInfo?.name ?? result?.source,
      sourceInfo?.url ?? articleContext?.articleUrl ?? null,
      policy,
    );

    await ClassificationReviewModel.updateOne(
      { orgId: input.orgId, processedItemId },
      {
        $setOnInsert: {
          orgId: input.orgId,
          evidenceId: `${processedItemId}:${this.readDate(doc.createdAt)?.toISOString() ?? Date.now()}`,
          processedItemId,
          itemMetaId: this.readString(doc.itemMetaId),
          sourceId: resolvedSourceId,
          sourceType,
          articleUrl: articleContext?.articleUrl ?? null,
          articleTitle: this.readString(result?.title),
          articleSummary: this.readString(result?.summary),
          predictedCategoryPath: this.readString(result?.category_path),
          predictedLegacyCategory: this.readString(result?.category),
          predictedConfidence: confidence,
          predictedMethod: this.normalizeMethod(result?.category_method),
          candidatePaths: Array.isArray(result?.category_candidates)
            ? result?.category_candidates
            : [],
          status: "pending",
          expiresAt: this.computeExpiryDate(REVIEW_RETENTION_DAYS),
        },
      },
      { upsert: true },
    ).exec();
  }

  async processReportJob(orgId: string, jobId: string) {
    await ClassificationReportJobModel.updateOne(
      { _id: jobId, orgId },
      { $set: { status: "running", progress: 0.1, startedAt: new Date() } },
    ).exec();

    try {
      const job = await ClassificationReportJobModel.findOne({
        _id: jobId,
        orgId,
      })
        .lean()
        .exec();
      if (!job) {
        return;
      }
      const sampleId = this.readString(job.sampleId);
      const metrics = await this.computeSampleMetrics(orgId, sampleId);
      await ClassificationReportJobModel.updateOne(
        { _id: jobId, orgId },
        { $set: { progress: 0.75 } },
      ).exec();

      const report = await ClassificationReportResultModel.create({
        orgId,
        jobId,
        sampleId,
        total: metrics.total,
        correct: metrics.correct,
        accuracy: metrics.accuracy,
        confusionMatrix: metrics.confusionMatrix,
        problemPathPairs: metrics.problemPathPairs,
        expiresAt: this.computeExpiryDate(REPORT_RESULT_RETENTION_DAYS),
      });

      await ClassificationReportJobModel.updateOne(
        { _id: jobId, orgId },
        {
          $set: {
            status: "completed",
            progress: 1,
            completedAt: new Date(),
            reportResultId: this.readId(report?._id),
            error: null,
          },
        },
      ).exec();
    } catch (error) {
      this.logger.error(
        { err: error, orgId, jobId },
        "Failed to build classification quality report",
      );
      await ClassificationReportJobModel.updateOne(
        { _id: jobId, orgId },
        {
          $set: {
            status: "failed",
            completedAt: new Date(),
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
        },
      ).exec();
    }
  }

  private async buildSummary(input: {
    orgId: string;
    window: "1h" | "24h" | "7d";
    sourceId?: string;
    categoryPrefix?: string;
  }): Promise<ClassificationQualitySummary> {
    const settings = await this.qualitySettings.getSettings(input.orgId);
    const { from, to, bucketMinutes } = this.resolveWindow(input.window);
    const policy = await this.getSourcePolicy(input.orgId);

    const normalizedCategoryPrefix = this.normalizePath(input.categoryPrefix);
    const categoryPrefixRegex = normalizedCategoryPrefix
      ? this.buildCategoryPrefixRegex(normalizedCategoryPrefix)
      : null;

    const processedItemsWhere: Record<string, unknown> = {
      orgId: input.orgId,
      status: "completed",
      createdAt: { $gte: from, $lte: to },
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(categoryPrefixRegex
        ? {
            "result.category_path": {
              $regex: categoryPrefixRegex,
            },
          }
        : {}),
    };

    const aggregated = await ProcessedItemModel.aggregate<{
      total: Array<{ count: number }>;
      sampled: Array<{
        _id: unknown;
        sourceId?: unknown;
        createdAt?: unknown;
        result?: unknown;
      }>;
    }>([
      { $match: processedItemsWhere },
      {
        $facet: {
          total: [{ $count: "count" }],
          sampled: [
            { $sort: { createdAt: -1 } },
            { $limit: SUMMARY_ITEMS_LIMIT },
            {
              $project: {
                _id: 1,
                sourceId: 1,
                createdAt: 1,
                "result.source": 1,
                "result.category_path": 1,
                "result.category_confidence": 1,
                "result.category_method": 1,
              },
            },
          ],
        },
      },
    ]);

    const first = aggregated[0];
    const totalMatchedItems =
      first &&
      Array.isArray(first.total) &&
      first.total.length > 0 &&
      typeof first.total[0]?.count === "number"
        ? Math.max(0, Math.floor(first.total[0].count))
        : 0;
    const docs = first && Array.isArray(first.sampled) ? first.sampled : [];
    const sourceIds = Array.from(
      new Set(
        docs
          .map((doc) => this.readString(doc.sourceId))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
    const sourceMap = await this.loadSourceMapByIds(input.orgId, sourceIds);

    const methodCounters: Record<
      "llm_embedding_rerank" | "rule_fallback",
      number
    > = {
      llm_embedding_rerank: 0,
      rule_fallback: 0,
    };
    const confidenceValues: number[] = [];
    const trendBuckets = new Map<
      number,
      { total: number; low: number; sum: number }
    >();
    const lowBySource = new Map<
      string,
      { total: number; low: number; sum: number }
    >();
    const sourceCategory = new Map<string, number>();

    for (const doc of docs) {
      const result = this.readResultRecord(doc.result);
      const categoryPath = this.readString(result?.category_path);

      const method = this.normalizeMethod(result?.category_method);
      const methodGroup =
        method.startsWith("rule") || method.startsWith("fallback")
          ? "rule_fallback"
          : "llm_embedding_rerank";
      methodCounters[methodGroup] += 1;

      const confidence = this.readConfidence(result?.category_confidence);
      if (confidence === null) {
        continue;
      }
      confidenceValues.push(confidence);
      const createdAt = this.readDate(doc.createdAt) ?? new Date();
      const bucketStart = this.floorDate(createdAt, bucketMinutes).getTime();
      const trend = trendBuckets.get(bucketStart) ?? {
        total: 0,
        low: 0,
        sum: 0,
      };
      trend.total += 1;
      trend.sum += confidence;
      if (confidence < settings.lowConfidenceThreshold) {
        trend.low += 1;
      }
      trendBuckets.set(bucketStart, trend);

      const sourceId = this.readString(doc.sourceId) ?? "unknown";
      const sourceEntry = lowBySource.get(sourceId) ?? {
        total: 0,
        low: 0,
        sum: 0,
      };
      sourceEntry.total += 1;
      sourceEntry.sum += confidence;
      if (confidence < settings.lowConfidenceThreshold) {
        sourceEntry.low += 1;
      }
      lowBySource.set(sourceId, sourceEntry);

      const sourceInfo = sourceId ? sourceMap.get(sourceId) : null;
      const sourceType = classifySourceByLabelAndUrl(
        sourceInfo?.name ?? result?.source,
        sourceInfo?.url ?? null,
        policy,
      );
      const categoryPrefix = this.extractCategoryPrefix(categoryPath);
      const key = `${sourceType}|${categoryPrefix}`;
      sourceCategory.set(key, (sourceCategory.get(key) ?? 0) + 1);
    }

    const methodDistributionTotal =
      methodCounters.llm_embedding_rerank + methodCounters.rule_fallback;
    const totalItems = totalMatchedItems;
    const methodDistribution: ClassificationQualitySummary["methodDistribution"] =
      [
        {
          group: "llm_embedding_rerank",
          count: methodCounters.llm_embedding_rerank,
          share:
            methodDistributionTotal > 0
              ? Number(
                  (
                    methodCounters.llm_embedding_rerank /
                    methodDistributionTotal
                  ).toFixed(4),
                )
              : 0,
        },
        {
          group: "rule_fallback",
          count: methodCounters.rule_fallback,
          share:
            methodDistributionTotal > 0
              ? Number(
                  (
                    methodCounters.rule_fallback / methodDistributionTotal
                  ).toFixed(4),
                )
              : 0,
        },
      ];

    const confidenceHistogram = this.buildHistogram(confidenceValues, 10);
    const confidenceTrend = Array.from(trendBuckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bucketStart, entry]) => ({
        bucketStart: new Date(bucketStart).toISOString(),
        total: entry.total,
        avgConfidence:
          entry.total > 0 ? Number((entry.sum / entry.total).toFixed(4)) : null,
        lowConfidenceCount: entry.low,
      }));

    const lowConfidenceSources = Array.from(lowBySource.entries())
      .map(([sourceId, entry]) => {
        const sourceInfo = sourceMap.get(sourceId);
        const lowConfidenceRate =
          entry.total > 0 ? Number((entry.low / entry.total).toFixed(4)) : 0;
        return {
          sourceId,
          sourceName: sourceInfo?.name ?? sourceId,
          sourceUrl: sourceInfo?.url ?? "",
          total: entry.total,
          lowConfidenceCount: entry.low,
          lowConfidenceRate,
          avgConfidence:
            entry.total > 0
              ? Number((entry.sum / entry.total).toFixed(4))
              : null,
        };
      })
      .sort((a, b) => b.lowConfidenceCount - a.lowConfidenceCount)
      .slice(0, 10);

    const latencyPercentilesResult = await this.computeLatencyPercentiles(
      input.orgId,
      from,
      to,
    );
    const categoryGateResult = await this.computeCategoryGateStats(
      input.orgId,
      from,
      to,
    );
    const { meta: latencySamplingMeta, ...latencyPercentiles } =
      latencyPercentilesResult;
    const { meta: gateSamplingMeta, ...categoryGate } = categoryGateResult;
    const sourceCategoryBreakdown = Array.from(sourceCategory.entries())
      .map(([key, count]) => {
        const [sourceType, categoryPrefix] = key.split("|");
        return {
          sourceType: (sourceType as ClassifiedSourceType) ?? "unknown",
          categoryPrefix: categoryPrefix || "unknown",
          count,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    const pendingReviewCount = await ClassificationReviewModel.countDocuments({
      orgId: input.orgId,
      status: "pending",
    }).exec();

    const alertStatus: ClassificationQualitySummary["alertStatus"] = [
      {
        stage: "llm",
        thresholdMs: settings.llmP95LatencyWarnMs,
        p95Ms: latencyPercentiles.llm.p95Ms,
        triggered:
          latencyPercentiles.llm.p95Ms !== null &&
          latencyPercentiles.llm.p95Ms > settings.llmP95LatencyWarnMs,
      },
      {
        stage: "embedding",
        thresholdMs: settings.embeddingP95LatencyWarnMs,
        p95Ms: latencyPercentiles.embedding.p95Ms,
        triggered:
          latencyPercentiles.embedding.p95Ms !== null &&
          latencyPercentiles.embedding.p95Ms >
            settings.embeddingP95LatencyWarnMs,
      },
      {
        stage: "rerank",
        thresholdMs: settings.rerankP95LatencyWarnMs,
        p95Ms: latencyPercentiles.rerank.p95Ms,
        triggered:
          latencyPercentiles.rerank.p95Ms !== null &&
          latencyPercentiles.rerank.p95Ms > settings.rerankP95LatencyWarnMs,
      },
    ];

    for (const alert of alertStatus.filter((entry) => entry.triggered)) {
      this.logger.warn(
        {
          orgId: input.orgId,
          window: input.window,
          stage: alert.stage,
          p95Ms: alert.p95Ms,
          thresholdMs: alert.thresholdMs,
        },
        "Classification latency percentile exceeded configured threshold",
      );
    }

    const gateAlertStatus: ClassificationQualitySummary["gateAlertStatus"] = [
      {
        metric: "reject_rate",
        threshold: settings.gateRejectRateWarn,
        value: categoryGate.rejectRate,
        triggered: categoryGate.rejectRate > settings.gateRejectRateWarn,
      },
      {
        metric: "penalized_rate",
        threshold: settings.gatePenalizedRateWarn,
        value: categoryGate.penalizedRate,
        triggered: categoryGate.penalizedRate > settings.gatePenalizedRateWarn,
      },
    ];

    for (const alert of gateAlertStatus.filter((entry) => entry.triggered)) {
      this.logger.warn(
        {
          orgId: input.orgId,
          window: input.window,
          metric: alert.metric,
          value: alert.value,
          threshold: alert.threshold,
        },
        "Classification category gate rate exceeded configured threshold",
      );
    }

    await this.notifyThresholdBreaches({
      orgId: input.orgId,
      window: input.window,
      latencyAlerts: alertStatus,
      gateAlerts: gateAlertStatus,
    });

    return {
      window: input.window,
      from: from.toISOString(),
      to: to.toISOString(),
      totalItems,
      methodDistribution,
      confidenceHistogram,
      confidenceTrend,
      lowConfidenceSources,
      latencyPercentiles,
      categoryGate,
      sourceCategoryBreakdown,
      pendingReviewCount,
      alertStatus,
      gateAlertStatus,
      sampling: {
        classifiedItems: this.toSamplingMeta(
          totalMatchedItems,
          docs.length,
          SUMMARY_ITEMS_LIMIT,
        ),
        latencyLogs: latencySamplingMeta,
        gateLogs: gateSamplingMeta,
      },
    };
  }

  private async computeLatencyPercentiles(orgId: string, from: Date, to: Date) {
    const logsWhere: Record<string, unknown> = {
      orgId,
      queue: "news_pipeline",
      stage: "classify",
      status: "completed",
      createdAt: { $gte: from, $lte: to },
    };

    const aggregated = await TaskLogModel.aggregate<{
      total: Array<{ count: number }>;
      sampled: Array<{ data?: unknown }>;
    }>([
      { $match: logsWhere },
      {
        $facet: {
          total: [{ $count: "count" }],
          sampled: [
            { $sort: { createdAt: -1 } },
            { $limit: LATENCY_LOGS_LIMIT },
            {
              $project: {
                "data.llmLatencyMs": 1,
                "data.embeddingLatencyMs": 1,
                "data.rerankLatencyMs": 1,
              },
            },
          ],
        },
      },
    ]);
    const first = aggregated[0];
    const matchedCount =
      first &&
      Array.isArray(first.total) &&
      first.total.length > 0 &&
      typeof first.total[0]?.count === "number"
        ? Math.max(0, Math.floor(first.total[0].count))
        : 0;
    const logs = first && Array.isArray(first.sampled) ? first.sampled : [];

    const llm: number[] = [];
    const embedding: number[] = [];
    const rerank: number[] = [];

    for (const log of logs) {
      const data =
        log?.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : {};
      const llmLatency = this.readNumber(data.llmLatencyMs);
      const embeddingLatency = this.readNumber(data.embeddingLatencyMs);
      const rerankLatency = this.readNumber(data.rerankLatencyMs);
      if (llmLatency !== null && llmLatency >= 0) {
        llm.push(llmLatency);
      }
      if (embeddingLatency !== null && embeddingLatency >= 0) {
        embedding.push(embeddingLatency);
      }
      if (rerankLatency !== null && rerankLatency >= 0) {
        rerank.push(rerankLatency);
      }
    }

    const toPercentiles = (values: number[]) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        sampleSize: sorted.length,
        p50Ms: this.percentile(sorted, 0.5),
        p95Ms: this.percentile(sorted, 0.95),
        p99Ms: this.percentile(sorted, 0.99),
      };
    };

    return {
      llm: toPercentiles(llm),
      embedding: toPercentiles(embedding),
      rerank: toPercentiles(rerank),
      meta: this.toSamplingMeta(matchedCount, logs.length, LATENCY_LOGS_LIMIT),
    };
  }

  private async computeCategoryGateStats(orgId: string, from: Date, to: Date) {
    const logsWhere: Record<string, unknown> = {
      orgId,
      queue: "news_events",
      stage: "category_gate",
      status: "completed",
      createdAt: { $gte: from, $lte: to },
    };

    const aggregated = await TaskLogModel.aggregate<{
      total: Array<{ count: number }>;
      sampled: Array<{ data?: unknown }>;
    }>([
      { $match: logsWhere },
      {
        $facet: {
          total: [{ $count: "count" }],
          sampled: [
            { $sort: { createdAt: -1 } },
            { $limit: GATE_LOGS_LIMIT },
            { $project: { "data.decision": 1 } },
          ],
        },
      },
    ]);
    const first = aggregated[0];
    const matchedCount =
      first &&
      Array.isArray(first.total) &&
      first.total.length > 0 &&
      typeof first.total[0]?.count === "number"
        ? Math.max(0, Math.floor(first.total[0].count))
        : 0;
    const logs = first && Array.isArray(first.sampled) ? first.sampled : [];

    let reject = 0;
    let penalized = 0;
    let accepted = 0;
    for (const log of logs) {
      const data =
        log?.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : {};
      const decision = this.readString(data.decision);
      if (decision === "reject") {
        reject += 1;
      } else if (decision === "penalized") {
        penalized += 1;
      } else if (decision === "accepted") {
        accepted += 1;
      }
    }
    const total = reject + penalized + accepted;
    return {
      reject,
      penalized,
      total,
      rejectRate: total > 0 ? Number((reject / total).toFixed(4)) : 0,
      penalizedRate: total > 0 ? Number((penalized / total).toFixed(4)) : 0,
      meta: this.toSamplingMeta(matchedCount, logs.length, GATE_LOGS_LIMIT),
    };
  }

  private async notifyThresholdBreaches(input: {
    orgId: string;
    window: "1h" | "24h" | "7d";
    latencyAlerts: ClassificationQualitySummary["alertStatus"];
    gateAlerts: ClassificationQualitySummary["gateAlertStatus"];
  }) {
    const triggeredLatency = input.latencyAlerts.filter(
      (entry) => entry.triggered,
    );
    const triggeredGate = input.gateAlerts.filter((entry) => entry.triggered);
    if (triggeredLatency.length === 0 && triggeredGate.length === 0) {
      return;
    }

    const signature = [
      ...triggeredLatency.map((entry) => `latency:${entry.stage}`),
      ...triggeredGate.map((entry) => `gate:${entry.metric}`),
    ]
      .sort()
      .join("|");
    if (!signature) {
      return;
    }

    const throttleKey = `${ALERT_NOTIFICATION_CACHE_PREFIX}${input.orgId}:${input.window}:${signature}`;
    let shouldNotify = false;
    try {
      shouldNotify = await this.cache.setIfAbsent(
        throttleKey,
        { triggeredAt: new Date().toISOString(), signature },
        ALERT_NOTIFICATION_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        { err: error, orgId: input.orgId, window: input.window, signature },
        "Failed to evaluate classification alert notification throttle; notifying without cache guard",
      );
      shouldNotify = true;
    }
    if (!shouldNotify) {
      return;
    }

    const latencySummary = triggeredLatency
      .map(
        (entry) =>
          `${entry.stage} p95=${entry.p95Ms ?? "-"}ms > ${entry.thresholdMs}ms`,
      )
      .join(", ");
    const gateSummary = triggeredGate
      .map(
        (entry) =>
          `${entry.metric}=${Number((entry.value * 100).toFixed(2))}% > ${Number((entry.threshold * 100).toFixed(2))}%`,
      )
      .join(", ");
    const bodyParts: string[] = [];
    if (latencySummary) {
      bodyParts.push(`Latency alerts: ${latencySummary}`);
    }
    if (gateSummary) {
      bodyParts.push(`Category gate alerts: ${gateSummary}`);
    }

    const payload = {
      orgId: input.orgId,
      type: NotificationType.system,
      title: "Classification quality threshold exceeded",
      body: bodyParts.join(" | "),
      data: {
        domain: "classification_quality",
        window: input.window,
        latencyAlerts: triggeredLatency,
        gateAlerts: triggeredGate,
        presentation: {
          kind: NotificationPresentationKind.ClassificationQualityThresholdExceeded,
          params: {
            window: input.window,
            latencyAlertCount: triggeredLatency.length,
            gateAlertCount: triggeredGate.length,
            ...(latencySummary ? { latencySummary } : {}),
            ...(gateSummary ? { gateSummary } : {}),
            latencyStages: triggeredLatency.map((entry) => entry.stage),
            gateMetrics: triggeredGate.map((entry) => entry.metric),
          },
          technicalDetail: bodyParts.join(" | "),
        },
      },
    } as const;

    try {
      const recipients = await this.getAlertRecipientUserIds(input.orgId);
      if (recipients.length === 0) {
        await this.notifications.notify({
          ...payload,
          userId: null,
        });
        return;
      }

      const notifyResults = await Promise.allSettled(
        recipients.map((userId) =>
          this.notifications.notify({
            ...payload,
            userId,
          }),
        ),
      );
      const failed = notifyResults.filter(
        (entry) => entry.status === "rejected",
      ).length;
      if (failed > 0) {
        this.logger.warn(
          {
            orgId: input.orgId,
            window: input.window,
            signature,
            failed,
            total: notifyResults.length,
          },
          "Classification quality notifications partially failed",
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId: input.orgId, window: input.window, signature },
        "Failed to send classification quality threshold notification",
      );
    }
  }

  private async getAlertRecipientUserIds(orgId: string) {
    const cacheKey = `${ALERT_RECIPIENTS_CACHE_PREFIX}${orgId}`;
    try {
      const cached = await this.cache.get<string[]>(cacheKey);
      if (Array.isArray(cached)) {
        return cached;
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read classification alert recipients from cache",
      );
    }

    const rows = await this.prisma.membership.findMany({
      where: {
        orgId,
        user: { isActive: true },
        OR: [
          {
            role: {
              permissions: {
                some: {
                  permission: { name: SETTINGS_MANAGE_PERMISSION },
                },
              },
            },
          },
          {
            roles: {
              some: {
                role: {
                  permissions: {
                    some: {
                      permission: { name: SETTINGS_MANAGE_PERMISSION },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      select: { userId: true },
      take: 500,
    });

    const userIds = Array.from(
      new Set(
        rows
          .map((row) => this.readString(row.userId))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );

    try {
      await this.cache.set(
        cacheKey,
        userIds,
        ALERT_RECIPIENTS_CACHE_TTL_SECONDS,
      );
    } catch {
      // best effort cache
    }
    return userIds;
  }

  private async computeSampleMetrics(orgId: string, sampleId: string | null) {
    const settings = await this.qualitySettings.getSettings(orgId);
    const where: Record<string, unknown> = {
      orgId,
      ...(sampleId ? { sampleId } : {}),
    };

    const rows = await ClassificationAnnotationModel.find(where)
      .select({
        predictedCategoryPath: 1,
        humanCategoryPath: 1,
      })
      .lean()
      .exec();

    const confusion = new Map<string, number>();
    let total = 0;
    let correct = 0;
    for (const row of rows) {
      const predicted =
        this.normalizePath(this.readString(row?.predictedCategoryPath)) ??
        "unknown";
      const actual =
        this.normalizePath(this.readString(row?.humanCategoryPath)) ??
        "unknown";
      total += 1;
      if (predicted === actual) {
        correct += 1;
      }
      const key = `${predicted}=>${actual}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }

    const confusionMatrix = Array.from(confusion.entries())
      .map(([key, count]) => {
        const [predictedPath, actualPath] = key.split("=>");
        return {
          predictedPath,
          actualPath,
          count,
        };
      })
      .sort((a, b) => b.count - a.count);

    const problemPathPairs = confusionMatrix
      .filter((entry) => entry.predictedPath !== entry.actualPath)
      .map((entry) => ({
        ...entry,
        errorRate: total > 0 ? Number((entry.count / total).toFixed(4)) : 0,
      }))
      .filter(
        (entry) =>
          entry.count >= settings.reportMinPairCount &&
          entry.errorRate >= settings.reportMinPairErrorRate,
      )
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    return {
      total,
      correct,
      accuracy: total > 0 ? Number((correct / total).toFixed(4)) : 0,
      confusionMatrix,
      problemPathPairs,
    };
  }

  private async loadSourceMapByIds(orgId: string, sourceIds: string[]) {
    const normalizedIds = Array.from(
      new Set(
        sourceIds
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ).slice(0, 2000);
    if (normalizedIds.length === 0) {
      return new Map<string, SourceInfo>();
    }

    const rows = await this.prisma.newsSource.findMany({
      where: {
        orgId,
        id: { in: normalizedIds },
      },
      select: { id: true, name: true, url: true },
    });

    const map = new Map<string, SourceInfo>();
    for (const row of rows) {
      map.set(row.id, {
        id: row.id,
        name: row.name,
        url: row.url,
      });
    }
    return map;
  }

  private async loadSourceInfo(
    orgId: string,
    sourceId: string,
  ): Promise<SourceInfo | null> {
    const row = await this.prisma.newsSource.findFirst({
      where: {
        id: sourceId,
        orgId,
      },
      select: { id: true, name: true, url: true },
    });
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      url: row.url,
    };
  }

  private async loadArticleContextMap(
    orgId: string,
    processedItemIds: string[],
  ) {
    if (processedItemIds.length === 0) {
      return new Map<string, ArticleContext>();
    }
    const rows = await this.prisma.processedArticle.findMany({
      where: {
        cleanedMarkdownRef: { in: processedItemIds },
        article: { orgId },
      },
      select: {
        cleanedMarkdownRef: true,
        article: {
          select: {
            url: true,
            sourceId: true,
          },
        },
      },
      take: Math.max(100, processedItemIds.length),
    });

    const map = new Map<string, ArticleContext>();
    for (const row of rows) {
      const key =
        typeof row.cleanedMarkdownRef === "string"
          ? row.cleanedMarkdownRef.trim()
          : "";
      if (!key) {
        continue;
      }
      map.set(key, {
        processedItemId: key,
        articleUrl: row.article?.url ?? null,
        sourceId: row.article?.sourceId ?? null,
      });
    }
    return map;
  }

  private async getSourcePolicy(orgId: string): Promise<NewsEventSourcePolicy> {
    const cacheKey = `${SOURCE_POLICY_KEY_PREFIX}${orgId}`;
    try {
      const cached = await this.cache.get<NewsEventSourcePolicy>(cacheKey);
      if (cached) {
        return normalizeSourcePolicy(cached, getDefaultNewsEventSourcePolicy());
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read source policy cache for quality service; falling back to database",
      );
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: `${SOURCE_POLICY_KEY_PREFIX}${orgId}` },
      select: { value: true },
    });
    const fallback = getDefaultNewsEventSourcePolicy();
    const policy = this.parseSourcePolicyRecord(record?.value, fallback);
    try {
      await this.cache.set(cacheKey, policy, 60);
    } catch {
      // best effort
    }
    return policy;
  }

  private parseSourcePolicyRecord(
    raw: unknown,
    fallback: NewsEventSourcePolicy,
  ): NewsEventSourcePolicy {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fallback;
    }
    const record = raw as Record<string, unknown>;
    if (
      record.version === 2 &&
      record.delta &&
      typeof record.delta === "object"
    ) {
      const delta = record.delta as Record<string, unknown>;
      return normalizeSourcePolicy(
        {
          authoritativeDomains: this.applyDeltaList(
            fallback.authoritativeDomains,
            this.readStringArray(delta.authoritativeDomainsAdd),
            this.readStringArray(delta.authoritativeDomainsRemove),
          ),
          authoritativeLabels: this.applyDeltaList(
            fallback.authoritativeLabels,
            this.readStringArray(delta.authoritativeLabelsAdd),
            this.readStringArray(delta.authoritativeLabelsRemove),
          ),
          blogDomains: this.applyDeltaList(
            fallback.blogDomains,
            this.readStringArray(delta.blogDomainsAdd),
            this.readStringArray(delta.blogDomainsRemove),
          ),
          blogLabels: this.applyDeltaList(
            fallback.blogLabels,
            this.readStringArray(delta.blogLabelsAdd),
            this.readStringArray(delta.blogLabelsRemove),
          ),
        },
        fallback,
      );
    }
    return normalizeSourcePolicy(
      record as Partial<NewsEventSourcePolicy>,
      fallback,
    );
  }

  private applyDeltaList(base: string[], adds: string[], removes: string[]) {
    const set = new Set(base);
    for (const entry of adds) {
      if (entry) {
        set.add(entry);
      }
    }
    for (const entry of removes) {
      if (entry) {
        set.delete(entry);
      }
    }
    return Array.from(set);
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const set = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim();
      if (!normalized) {
        continue;
      }
      set.add(normalized);
      if (set.size >= 1000) {
        break;
      }
    }
    return Array.from(set);
  }

  private resolveWindow(window: "1h" | "24h" | "7d") {
    const now = new Date();
    const hours = window === "1h" ? 1 : window === "24h" ? 24 : 24 * 7;
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const bucketMinutes = window === "1h" ? 5 : window === "24h" ? 60 : 360;
    return { from, to: now, bucketMinutes };
  }

  private percentile(sorted: number[], pct: number) {
    if (sorted.length === 0) {
      return null;
    }
    const clamped = Math.max(0, Math.min(1, pct));
    const index = Math.floor(clamped * (sorted.length - 1));
    const value = sorted[index];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : null;
  }

  private buildHistogram(values: number[], bins: number) {
    const safeBins = Math.max(1, Math.min(20, Math.round(bins)));
    const counters = new Array<number>(safeBins).fill(0);
    for (const value of values) {
      const normalized = Math.max(0, Math.min(1, value));
      const index = Math.min(safeBins - 1, Math.floor(normalized * safeBins));
      counters[index] = (counters[index] ?? 0) + 1;
    }
    return counters.map((count, index) => {
      const min = index / safeBins;
      const max = (index + 1) / safeBins;
      return {
        bucket: `${min.toFixed(1)}-${max.toFixed(1)}`,
        min: Number(min.toFixed(4)),
        max: Number(max.toFixed(4)),
        count,
      };
    });
  }

  private floorDate(value: Date, bucketMinutes: number) {
    const ms = bucketMinutes * 60 * 1000;
    return new Date(Math.floor(value.getTime() / ms) * ms);
  }

  private toSamplingMeta(matched: number, scanned: number, limit: number) {
    const safeMatched = Math.max(0, Math.floor(matched));
    const safeScanned = Math.max(0, Math.floor(scanned));
    const safeLimit = Math.max(1, Math.floor(limit));
    const coverage =
      safeMatched > 0
        ? Number((Math.min(safeScanned, safeMatched) / safeMatched).toFixed(4))
        : 1;
    return {
      matched: safeMatched,
      scanned: safeScanned,
      limit: safeLimit,
      truncated: safeMatched > safeScanned && safeScanned >= safeLimit,
      coverage,
    };
  }

  private parseCursor(cursor?: string) {
    if (!cursor) {
      return null;
    }
    const time = new Date(cursor).getTime();
    if (!Number.isFinite(time)) {
      return null;
    }
    return new Date(time);
  }

  private computeExpiryDate(retentionDays: number) {
    const normalizedDays = Math.max(1, Math.floor(retentionDays));
    const ms = normalizedDays * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }

  private toConfidenceBand(value: number): ConfidenceBand {
    if (value < 0.4) {
      return "low";
    }
    if (value < 0.75) {
      return "medium";
    }
    return "high";
  }

  private normalizeMethod(value: unknown) {
    const method = this.readString(value);
    return method ?? "unknown";
  }

  private extractCategoryPrefix(path: string | null) {
    if (!path) {
      return "unknown";
    }
    const parts = path
      .split("/")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (parts.length === 0) {
      return "unknown";
    }
    return parts.slice(0, Math.min(2, parts.length)).join("/");
  }

  private buildCategoryPrefixRegex(prefix: string) {
    return new RegExp(`^${this.escapeRegExp(prefix)}(?:/|$)`, "i");
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private normalizePath(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    return normalized.length > 0 ? normalized.slice(0, 160) : null;
  }

  private normalizeText(value: unknown, maxLength: number) {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }
    return normalized.slice(0, maxLength);
  }

  private normalizeQuickTags(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    const set = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      set.add(normalized.slice(0, 60));
      if (set.size >= 20) {
        break;
      }
    }
    return Array.from(set);
  }

  private toSet<T>(value: unknown): Set<T> {
    if (!Array.isArray(value)) {
      return new Set<T>();
    }
    const set = new Set<T>();
    for (const entry of value) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed) {
          set.add(trimmed as T);
        }
      }
    }
    return set;
  }

  private shuffleInPlace<T>(items: T[]) {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
  }

  private async getGateMinConfidence(orgId: string) {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: `${GATE_SETTINGS_KEY_PREFIX}${orgId}` },
      select: { value: true },
    });
    if (
      !record?.value ||
      typeof record.value !== "object" ||
      Array.isArray(record.value)
    ) {
      return 0.4;
    }
    const raw = record.value as Record<string, unknown>;
    const value = this.readNumber(raw.minCategoryConfidenceForGate);
    if (value === null) {
      return 0.4;
    }
    return Math.max(0, Math.min(1, value));
  }

  private readId(value: unknown) {
    if (!value) {
      return null;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "object" && value && "toString" in value) {
      const raw = String((value as { toString: () => string }).toString());
      return raw && raw !== "[object Object]" ? raw : null;
    }
    return null;
  }

  private readString(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private readNumber(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  private readConfidence(value: unknown) {
    const num = this.readNumber(value);
    if (num === null) {
      return null;
    }
    return Math.max(0, Math.min(1, Number(num.toFixed(4))));
  }

  private readDate(value: unknown) {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    return null;
  }

  private readResultRecord(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }
}
