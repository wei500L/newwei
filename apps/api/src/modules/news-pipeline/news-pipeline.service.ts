import {
  processedItemHasLocation,
  CrawlResultContentModel,
  ItemReadModelModel,
  ProcessedItemModel,
  RawItemModel,
  type ProcessedItemDocument,
} from "@modular/mongo";
import { createLogger, parseDateTime } from "@modular/utils";
import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  MongoOutboxStatus,
  MongoOutboxType,
  ProcessedArticleStatus,
  type Article,
  type Prisma,
  type ProcessedArticle,
} from "@prisma/client";
import { Types } from "mongoose";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";

import { extractFirstJson, safeJsonParseFromText } from "../../common/llm-json";
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
import { CrawlExecutionService } from "../crawl/crawl-execution.service";
import { assertNoCrawl4aiLlmOptions } from "../crawl/crawl4ai-llm.guard";
import { NewsSourceOpsSnapshotService } from "../crawl/news-source-ops-snapshot.service";
import {
  buildCanonicalUrlFingerprint,
  resolveQueryParamAllowlist,
} from "../crawl/url-fingerprint";
import { buildItemReadModelPatch } from "../items/item-read-model.utils";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";
import { VectorClientService } from "../vector/vector-client.service";

import { LiteLlmService } from "./litellm.service";
import { NewsClassifierService } from "./news-classifier.service";
import {
  inferNewsContentType,
  normalizeNewsContentType,
} from "./news-content-type";
import {
  buildNewsDedupeSystemPrompt,
  buildNewsDedupeUserPrompt,
  NEWS_DEDUPE_RESPONSE_FORMAT,
  NewsDedupeJudgeSchema,
} from "./news-dedupe-llm";
import { NewsDedupeSettingsService } from "./news-dedupe-settings.service";
import {
  NewsExtractionPipelineMode,
  NewsExtractionSettingsService,
  type NewsExtractionSettings,
} from "./news-extraction-settings.service";
import {
  NewsExtractionStageService,
  type NewsStageContext,
  type NewsStageLlmMetadata,
} from "./news-extraction-stage.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import {
  CleanedNewsSchema,
  CleanedNews,
  type NewsStageMeta,
  NormalizedNewsPayload,
  NormalizedNewsPayloadSchema,
} from "./news-pipeline.schema";
import { PipelineJobContext, RawPipelineItem } from "./news-pipeline.types";
import { NewsPromptConfigService } from "./news-prompt-config.service";
import { NewsPromptBuilder } from "./news-prompt.builder";

interface LlmCallMetadata {
  model: string | null;
  promptVersion: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}

interface ArticleRepairMetadata {
  applied: boolean;
  missingFields: string[];
  repairedFields: string[];
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  error?: string | null;
}

interface SummaryDedupeResult {
  summaryEmbedding?: number[] | null;
  summaryEmbeddingModel?: string | null;
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
  thresholdUsed?: number | null;
}

type StageStatus = "completed" | "skipped" | "rejected" | "failed";

type StageMetaEntry = NonNullable<NewsStageMeta["clean"]>;

interface RankedLlmDedupeCandidate {
  id: string;
  summary: string;
  title: string | null;
  quick: number;
}

interface PreparedLlmDedupeCandidate {
  id: string;
  title: string | null;
  text: string;
}

interface ProcessedItemOutboxPayload {
  type: typeof MongoOutboxType.processed_item;
  document: {
    _id: string;
    rawItemId: string;
    itemMetaId: string;
    orgId: string;
    sourceId?: string | null;
    status: "completed";
    tags: string[];
    result: CleanedNews;
    llm: LlmCallMetadata;
    summaryEmbedding?: number[];
    summaryEmbeddingModel?: string | null;
    duplicateOf?: string | null;
    duplicateSimilarity?: number | null;
    error?: unknown;
  };
}

const NullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : null),
  z.string().nullable(),
);

const NullableFiniteNumberSchema = z.preprocess(
  (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null,
  z.number().finite().nullable(),
);

const OptionalNumberArraySchema = z
  .preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.number().finite()),
  )
  .optional();

const LlmCallMetadataSchema: z.ZodType<LlmCallMetadata, z.ZodTypeDef, unknown> =
  z.object({
    model: NullableStringSchema,
    promptVersion: NullableStringSchema,
    promptTokens: NullableFiniteNumberSchema,
    completionTokens: NullableFiniteNumberSchema,
    totalTokens: NullableFiniteNumberSchema,
    costUsd: NullableFiniteNumberSchema,
    latencyMs: NullableFiniteNumberSchema,
  });

const ProcessedItemOutboxPayloadSchema: z.ZodType<
  ProcessedItemOutboxPayload,
  z.ZodTypeDef,
  unknown
> = z.object({
  type: z.literal(MongoOutboxType.processed_item),
  document: z.object({
    _id: z.string(),
    rawItemId: z.string(),
    itemMetaId: z.string(),
    orgId: z.string(),
    sourceId: NullableStringSchema.optional(),
    status: z.literal("completed"),
    tags: z.array(z.string()).default([]),
    result: CleanedNewsSchema,
    llm: LlmCallMetadataSchema,
    summaryEmbedding: OptionalNumberArraySchema,
    summaryEmbeddingModel: NullableStringSchema.optional(),
    duplicateOf: NullableStringSchema.optional(),
    duplicateSimilarity: NullableFiniteNumberSchema.optional(),
    error: z.unknown().optional(),
  }),
});

const ArticleRepairSchema = z.object({
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});

interface CrawledArticle {
  sourceUrl: string;
  markdown: string;
  markdownWithCitations?: string;
  referencesMarkdown?: string;
  rawMarkdown?: string;
  fitMarkdown?: string;
  metadata: Record<string, unknown>;
  publishedAt: string | null;
  runId: string | null;
  fetchedAt: string;
  contentHash: string;
}

type PersistedProcessedItem =
  | ProcessedItemDocument
  | { _id: string; toJSON: () => { id: string } };

interface PersistResult {
  processedItem: PersistedProcessedItem;
  outboxId: string;
}

interface OutboxDeliveryRequestedEvent {
  outboxId: string;
  payload?: ProcessedItemOutboxPayload;
}

const OUTBOX_DELIVERY_REQUESTED_EVENT = "newsPipeline.outbox.deliveryRequested";
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_LLM_DEDUPE_CONCURRENCY = 4;
const MAX_LLM_DEDUPE_COMPARISONS = 12;
const MAX_LLM_DEDUPE_CANDIDATE_CHARS = 1_200;
const LLM_DEDUPE_EARLY_EXIT_SIMILARITY = 0.98;

@Injectable()
export class NewsPipelineService implements OnModuleDestroy {
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
  private readonly crawlActorByOrgId = new Map<string, string>();

  constructor(
    private readonly liteLlm: LiteLlmService,
    private readonly configService: NewsPipelineConfigService,
    private readonly promptBuilder: NewsPromptBuilder,
    private readonly promptConfig: NewsPromptConfigService,
    private readonly dedupeSettings: NewsDedupeSettingsService,
    private readonly extractionSettings: NewsExtractionSettingsService,
    private readonly extractionStages: NewsExtractionStageService,
    private readonly prisma: PrismaService,
    private readonly crawlExecution: CrawlExecutionService,
    @Optional()
    private readonly newsSourceOpsSnapshots?: NewsSourceOpsSnapshotService,
    @Optional() private readonly vectorClient?: VectorClientService,
    @Optional() private readonly classifier?: NewsClassifierService,
  ) {
    this.outboxEventEmitter.on(
      OUTBOX_DELIVERY_REQUESTED_EVENT,
      (event: OutboxDeliveryRequestedEvent) => {
        this.enqueueOutboxDelivery(event);
      },
    );
  }

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
      const processedItemId = this.normalizeProcessedItemRef(
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
      const processedItemId = this.normalizeProcessedItemRef(
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

      const cleaned = this.parseStoredCleanedNewsResult(
        (doc as { result?: unknown }).result,
      );
      if (!cleaned) {
        skippedCount += 1;
        continue;
      }

      const hasContentType = Boolean(
        normalizeNewsContentType(cleaned.content_type),
      );
      const hasCategoryPath = this.normalizeStoredCategoryPath(
        cleaned.category_path,
      );
      const hasCategoryMethod = this.normalizeStoredCategoryMethod(
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
      const resolvedCleaned = this.resolveStoredContentTypeForBackfill(
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

  private buildCrawlTaskOptions(
    payload: NormalizedNewsPayload,
  ): Record<string, unknown> {
    const cfg = this.configService.config.crawl4ai;
    const options = {
      ...cfg.crawlerDefaults,
      cleanMarkdown: cfg.cleanMarkdown ?? cfg.crawlerDefaults.cleanMarkdown,
      markdownOptions: cfg.markdown ?? cfg.crawlerDefaults.markdownOptions,
      ...payload.crawlOptions,
      userAgent:
        payload.crawlOptions?.userAgent ??
        cfg.crawlerDefaults.userAgent ??
        cfg.userAgent,
    };
    assertNoCrawl4aiLlmOptions(options, "newsPipeline.crawlOptions");
    return options;
  }

  private async resolveCrawlActorId(orgId: string): Promise<string | null> {
    const cached = this.crawlActorByOrgId.get(orgId);
    if (cached) {
      return cached;
    }

    const membership = await this.prisma.membership.findFirst({
      where: { orgId },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });

    const userId =
      typeof membership?.userId === "string" ? membership.userId : "";
    if (!userId) {
      return null;
    }

    this.crawlActorByOrgId.set(orgId, userId);
    return userId;
  }

  private async findRecentStoredCrawlResultId(options: {
    orgId: string;
    url: string;
    since: Date;
    queryParamAllowlist?: string[];
  }): Promise<string | null> {
    const canonical = buildCanonicalUrlFingerprint(
      options.url,
      options.queryParamAllowlist,
    );

    if (canonical) {
      const fingerprintMatch = await this.prisma.crawlResult.findFirst({
        where: {
          orgId: options.orgId,
          sourceUrlFingerprint: canonical.fingerprint,
          fetchedAt: { gte: options.since },
        },
        orderBy: { fetchedAt: "desc" },
        select: { id: true },
      });
      if (fingerprintMatch?.id) {
        return fingerprintMatch.id;
      }
    }

    const fallback = await this.prisma.crawlResult.findFirst({
      where: {
        sourceUrl: options.url,
        fetchedAt: { gte: options.since },
        orgId: options.orgId,
      },
      orderBy: { fetchedAt: "desc" },
      select: { id: true },
    });
    return fallback?.id ?? null;
  }

  private async crawlViaCrawlTask(options: {
    orgId: string;
    url: string;
    payload: NormalizedNewsPayload;
  }): Promise<{ crawlResultId: string; crawlTaskId: string }> {
    const crawlOptions = this.buildCrawlTaskOptions(options.payload);
    const urlQueryParamAllowlist = this.extractUrlQueryParamAllowlist(
      options.payload,
    );
    const orgContentDedupeWindowHours = this.extractSeedDedupeWindowHours(
      options.payload,
    );
    const crawlTaskConfig: Record<string, unknown> = {
      ...crawlOptions,
      ...(urlQueryParamAllowlist.length > 0 ? { urlQueryParamAllowlist } : {}),
      ...(typeof orgContentDedupeWindowHours === "number"
        ? { orgContentDedupeWindowHours }
        : {}),
    };
    const displayNameLabel = options.payload.sourceName?.trim()
      ? options.payload.sourceName.trim()
      : (() => {
          try {
            return new URL(options.url).hostname;
          } catch {
            return options.url;
          }
        })();
    const displayName = `NewsPipeline: ${displayNameLabel}`.slice(0, 80);

    const existingTask = await this.prisma.crawlTask.findFirst({
      where: {
        orgId: options.orgId,
        targetUrl: options.url,
        OR: [
          { displayName: { startsWith: "NewsPipeline:" } },
          { displayName: { startsWith: "NewsSource:" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    let crawlTaskId: string;
    if (existingTask) {
      crawlTaskId = existingTask.id;
      await this.prisma.crawlTask.update({
        where: { id: crawlTaskId },
        data: {
          displayName,
          keywords: toPrismaJsonValue(options.payload.keywords),
          config: toPrismaJsonValue(crawlTaskConfig),
        },
        select: { id: true },
      });
    } else {
      const actorId = await this.resolveCrawlActorId(options.orgId);
      if (!actorId) {
        throw new Error("crawl task actor unavailable");
      }

      const createdTask = await this.prisma.crawlTask.create({
        data: {
          orgId: options.orgId,
          createdById: actorId,
          targetUrl: options.url,
          displayName,
          status: "pending",
          concurrency: 1,
          keywords: toPrismaJsonValue(options.payload.keywords),
          config: toPrismaJsonValue(crawlTaskConfig),
        },
        select: { id: true },
      });
      crawlTaskId = createdTask.id;
    }

    const executionSummary = await this.crawlExecution.runTask(
      crawlTaskId,
      options.orgId,
    );
    const reusedResultId =
      typeof executionSummary.reusedResultId === "string" &&
      executionSummary.reusedResultId.trim().length > 0
        ? executionSummary.reusedResultId.trim()
        : null;

    const preferredResult =
      (reusedResultId
        ? await this.prisma.crawlResult.findFirst({
            where: {
              id: reusedResultId,
              orgId: options.orgId,
            },
            select: { id: true },
          })
        : null) ??
      (await this.prisma.crawlResult.findFirst({
        where: { taskId: crawlTaskId, sourceUrl: options.url },
        orderBy: { fetchedAt: "desc" },
        select: { id: true },
      })) ??
      (await this.prisma.crawlResult.findFirst({
        where: { taskId: crawlTaskId },
        orderBy: { fetchedAt: "desc" },
        select: { id: true },
      }));

    if (!preferredResult) {
      throw new Error("crawl task produced no results");
    }

    const crawlResultId = await this.selectBestPipelineCrawlResultId({
      orgId: options.orgId,
      crawlTaskId,
      preferredResultId: preferredResult.id,
      preferredSourceUrl: options.url,
    });

    return { crawlResultId, crawlTaskId };
  }

  private async selectBestPipelineCrawlResultId(options: {
    orgId: string;
    crawlTaskId: string;
    preferredResultId: string;
    preferredSourceUrl: string;
  }): Promise<string> {
    const findMany = (
      this.prisma.crawlResult as {
        findMany?: (args: unknown) => Promise<unknown>;
      }
    ).findMany;
    if (typeof findMany !== "function") {
      return options.preferredResultId;
    }

    const rows = (await findMany({
      where: {
        taskId: options.crawlTaskId,
        task: { orgId: options.orgId },
      },
      orderBy: { fetchedAt: "desc" },
      take: 12,
      select: {
        id: true,
        sourceUrl: true,
      },
    })) as
      | {
          id?: unknown;
          sourceUrl?: unknown;
        }[]
      | null;

    if (!Array.isArray(rows) || rows.length === 0) {
      return options.preferredResultId;
    }

    const contentByResultId =
      await this.loadPipelineCrawlResultCandidateContent(
        rows
          .map((row) => (typeof row.id === "string" ? row.id : ""))
          .filter((candidateId) => candidateId.length > 0),
      );

    let bestId = options.preferredResultId;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const row of rows) {
      const candidateId = typeof row.id === "string" ? row.id : "";
      if (!candidateId) {
        continue;
      }
      const candidateSourceUrl =
        typeof row.sourceUrl === "string" ? row.sourceUrl : "";

      const score = await this.scorePipelineCrawlResultCandidate({
        sourceUrl: candidateSourceUrl,
        contentDoc: contentByResultId.get(candidateId),
        preferredSourceUrl: options.preferredSourceUrl,
      });

      if (score > bestScore) {
        bestScore = score;
        bestId = candidateId;
      }
    }

    if (bestId !== options.preferredResultId) {
      await writeTaskLogBestEffort({
        queue: "news_pipeline",
        jobId: options.crawlTaskId,
        orgId: options.orgId,
        stage: "crawl",
        status: "completed",
        message: "Selected alternative crawl result for higher content quality",
        data: {
          preferredResultId: options.preferredResultId,
          selectedResultId: bestId,
          preferredSourceUrl: options.preferredSourceUrl,
        },
      });
    }

    return bestId;
  }

  private async loadPipelineCrawlResultCandidateContent(resultIds: string[]) {
    const normalizedIds = [
      ...new Set(resultIds.map((resultId) => resultId.trim()).filter(Boolean)),
    ];
    if (normalizedIds.length === 0) {
      return new Map<string, Record<string, unknown>>();
    }

    const docs = await CrawlResultContentModel.find(
      { resultId: { $in: normalizedIds } },
      {
        resultId: 1,
        markdown: 1,
        markdownWithCitations: 1,
        rawMarkdown: 1,
        fitMarkdown: 1,
      },
    ).lean();

    const byResultId = new Map<string, Record<string, unknown>>();
    if (!Array.isArray(docs)) {
      return byResultId;
    }

    for (const doc of docs) {
      if (!doc || typeof doc !== "object") {
        continue;
      }
      const record = doc as Record<string, unknown>;
      const resultId =
        typeof record.resultId === "string" ? record.resultId.trim() : "";
      if (!resultId) {
        continue;
      }
      byResultId.set(resultId, record);
    }

    return byResultId;
  }

  private async scorePipelineCrawlResultCandidate(options: {
    sourceUrl: string;
    contentDoc?: Record<string, unknown>;
    preferredSourceUrl: string;
  }): Promise<number> {
    if (!options.contentDoc) {
      return Number.NEGATIVE_INFINITY;
    }

    const selectedMarkdown = this.selectBestMarkdownFromContentDoc(
      options.contentDoc,
    );
    if (!selectedMarkdown) {
      return Number.NEGATIVE_INFINITY;
    }

    const normalized = selectedMarkdown.trim();
    if (!normalized) {
      return Number.NEGATIVE_INFINITY;
    }

    const words = normalized
      .split(/\s+/)
      .filter((entry) => entry.length > 0).length;
    const paragraphs = normalized
      .split(/\n\s*\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length;
    const isChallenge = this.isLikelyBotChallengeMarkdown(normalized);

    let score =
      Math.min(normalized.length, 24_000) +
      Math.min(words, 12_000) +
      Math.min(paragraphs, 200) * 4;

    if (options.sourceUrl === options.preferredSourceUrl) {
      score += 120;
    }

    if (isChallenge) {
      score -= 16_000;
    }

    return score;
  }

  /**
   * Cleanup timers and event listeners on module destroy to prevent memory leaks.
   * NP-BUG-002: Fix memory leak by clearing outbox retry timers and event listeners.
   */
  onModuleDestroy() {
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

  async process(job: PipelineJobContext, raw: RawPipelineItem) {
    const payload = await this.runStage(
      job,
      "normalize",
      async () => this.normalizePayload(raw.payload),
      {
        onErrorData: () => ({
          rawItemId: raw.id,
        }),
      },
    );

    const article = await this.runStage(
      job,
      "crawl",
      async () => this.fetchArticle(job, payload),
      {
        onErrorData: () => ({
          url: payload.url,
        }),
      },
    );

    const extractionSettings = await this.extractionSettings.getSettings(
      job.orgId,
    );

    if (
      extractionSettings.pipelineMode !== NewsExtractionPipelineMode.staged
    ) {
      return this.processLegacyPipeline(job, raw, payload, article);
    }

    return this.processStagedPipeline(
      job,
      raw,
      payload,
      article,
      extractionSettings,
    );
  }

  private async processLegacyPipeline(
    job: PipelineJobContext,
    raw: RawPipelineItem,
    payload: NormalizedNewsPayload,
    article: CrawledArticle & { fromCache: boolean },
  ) {
    const {
      cleaned,
      llm,
      contentHash,
      processedArticleId,
      contentDuplicateOf,
      articleMetadataPatch,
    } = await this.runStage(
      job,
      "llm",
      async () => this.cleanArticle(payload, article, job),
      {
        onErrorData: () => ({
          url: payload.url,
          runId: article.runId,
        }),
      },
    );

    const cleanedWithClassification = this.classifier
      ? this.classifier.applyToCleanedNews(
          cleaned,
          await this.runStage(
            job,
            "classify",
            async () =>
              this.classifier!.classify(job.orgId, cleaned, {
                jobId: job.jobId,
                sourceId: this.extractSourceId(payload) ?? null,
                sourceUrl:
                  (typeof article.sourceUrl === "string" &&
                  article.sourceUrl.trim().length > 0
                    ? article.sourceUrl.trim()
                    : payload.url) ?? null,
                sourceLabel: cleaned.source ?? payload.sourceName ?? null,
              }),
            {
              onErrorData: () => ({
                itemMetaId: job.itemMetaId,
              }),
            },
          ),
        )
      : cleaned;

    const dedupe = await this.runStage(job, "dedupe", async () =>
      this.evaluateSummaryDedupe({
        job,
        payload,
        cleaned: cleanedWithClassification,
        contentDuplicateOf,
      }),
    );

    let persistResult;
    try {
      persistResult = await this.runStage(
        job,
        "persist",
        async () =>
          this.persistProcessedResult({
            job,
            raw,
            payload,
            article,
            cleaned: cleanedWithClassification,
            llm,
            contentHash,
            processedArticleId,
            articleMetadataPatch,
            processedItemId: job.processedItemId,
            summaryEmbedding: dedupe.summaryEmbedding ?? undefined,
            summaryEmbeddingModel: dedupe.summaryEmbeddingModel ?? undefined,
            duplicateOf: dedupe.duplicateOf ?? undefined,
            duplicateSimilarity: dedupe.duplicateSimilarity ?? undefined,
          }),
        {
          onErrorData: () => ({
            rawItemId: raw.id,
            itemMetaId: job.itemMetaId,
          }),
        },
      );
    } catch (error) {
      // The dedupe stage already marked the item Duplicate; if persist fails
      // the item must not stay Duplicate with no processed document.
      await this.revertDuplicateMarkOnPersistFailure(job, dedupe.duplicateOf);
      throw error;
    }

    const document = persistResult.processedItem.toJSON() as { id?: string };
    return {
      ...document,
      id: document.id ?? persistResult.processedItem._id.toString(),
    };
  }

  private async processStagedPipeline(
    job: PipelineJobContext,
    raw: RawPipelineItem,
    payload: NormalizedNewsPayload,
    article: CrawledArticle & { fromCache: boolean },
    extractionSettings: NewsExtractionSettings,
  ) {
    const preflight = this.evaluatePreflightGate(article, extractionSettings);
    const preflightOutcomeData = {
      ...(preflight.reason ? { reason: preflight.reason } : {}),
      ...(typeof preflight.qualityScore === "number"
        ? { preflightQualityScore: preflight.qualityScore }
        : {}),
      ...(typeof preflight.qualityThreshold === "number"
        ? { preflightQualityThreshold: preflight.qualityThreshold }
        : {}),
    };
    if (preflight.rejected) {
      const cleaned = this.buildGateRejectedCleanedNews({
        article,
        payload,
        reason: preflight.reason ?? "preflight_rejected",
        stageMeta: {
          preflight: this.createStageMetaEntry({
            status: "rejected",
            provider: "rules",
            reason: preflight.reason ?? "preflight_rejected",
          }),
          clean: this.createStageMetaEntry({
            status: "skipped",
            provider: "llm",
            reason: "preflight_rejected",
          }),
          quality_gate: this.createStageMetaEntry({
            status: "skipped",
            provider: "rules",
            reason: "preflight_rejected",
          }),
          entities: this.createStageMetaEntry({
            status: "skipped",
            provider: extractionSettings.providers.entities,
            reason: "preflight_rejected",
          }),
          sentiment: this.createStageMetaEntry({
            status: "skipped",
            provider: extractionSettings.providers.sentiment,
            reason: "preflight_rejected",
          }),
          kg: this.createStageMetaEntry({
            status: "skipped",
            provider: extractionSettings.providers.kg,
            reason: "preflight_rejected",
          }),
          classify: this.createStageMetaEntry({
            status: "skipped",
            provider: "classifier",
            reason: "preflight_rejected",
          }),
          dedupe: this.createStageMetaEntry({
            status: "skipped",
            provider: "dedupe",
            reason: "preflight_rejected",
          }),
        },
      });
      await this.recordStageOutcome(
        job,
        "preflight",
        cleaned.stage_meta?.preflight,
        {
          reason: preflight.reason ?? "preflight_rejected",
          ...preflightOutcomeData,
        },
      );
      const persistResult = await this.runStage(
        job,
        "persist",
        async () =>
          this.persistProcessedResult({
            job,
            raw,
            payload,
            article,
            cleaned,
            llm: this.emptyLlmMetadata(),
            contentHash: article.contentHash ?? this.hashContent(article.markdown),
            articleMetadataPatch: {
              extraction: {
                mode: NewsExtractionPipelineMode.staged,
                gateRejected: true,
                gateReason: preflight.reason ?? "preflight_rejected",
                preflightQualityScore: preflight.qualityScore ?? null,
              },
            },
            processedItemId: job.processedItemId,
          }),
        {
          onErrorData: () => ({
            rawItemId: raw.id,
            itemMetaId: job.itemMetaId,
          }),
        },
      );

      const document = persistResult.processedItem.toJSON() as { id?: string };
      return {
        ...document,
        id: document.id ?? persistResult.processedItem._id.toString(),
      };
    }

    await this.recordStageOutcome(
      job,
      "preflight",
      this.createStageMetaEntry({
        status: "completed",
        provider: "rules",
      }),
      Object.keys(preflightOutcomeData).length > 0
        ? preflightOutcomeData
        : undefined,
    );

    const {
      cleaned: cleanResult,
      llm,
      contentHash,
      processedArticleId,
      contentDuplicateOf,
      articleMetadataPatch,
    } = await this.runStage(
      job,
      "clean",
      async () =>
        this.cleanArticle(
          payload,
          article,
          job,
          extractionSettings.providers.clean,
        ),
      {
        onErrorData: () => ({
          url: payload.url,
          runId: article.runId,
        }),
      },
    );

    let stagedCleaned = this.stripEnrichmentFields(cleanResult);
    stagedCleaned.stage_meta = {
      ...(stagedCleaned.stage_meta ?? {}),
      preflight: this.createStageMetaEntry({
        status: "completed",
        provider: "rules",
      }),
      clean: this.createStageMetaEntry({
        status: "completed",
        provider: llm.model ? "llm" : "processed_cache",
        reason: null,
        model: llm.model,
        promptVersion: llm.promptVersion,
        promptTokens: llm.promptTokens,
        completionTokens: llm.completionTokens,
        totalTokens: llm.totalTokens,
        costUsd: llm.costUsd,
        latencyMs: llm.latencyMs,
      }),
    };
    await this.recordStageOutcome(job, "clean", stagedCleaned.stage_meta.clean);

    const qualityGate = this.evaluatePostCleanGate(
      stagedCleaned,
      extractionSettings,
    );
    stagedCleaned.stage_meta.quality_gate = this.createStageMetaEntry({
      status: qualityGate.rejected ? "rejected" : "completed",
      provider: "rules",
      reason: qualityGate.reason ?? null,
    });
    await this.recordStageOutcome(
      job,
      "quality_gate",
      stagedCleaned.stage_meta.quality_gate,
      qualityGate.reason ? { reason: qualityGate.reason } : undefined,
    );

    if (qualityGate.rejected) {
      stagedCleaned.stage_meta.entities = this.createStageMetaEntry({
        status: "skipped",
        provider: extractionSettings.providers.entities,
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.sentiment = this.createStageMetaEntry({
        status: "skipped",
        provider: extractionSettings.providers.sentiment,
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.kg = this.createStageMetaEntry({
        status: "skipped",
        provider: extractionSettings.providers.kg,
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.classify = this.createStageMetaEntry({
        status: "skipped",
        provider: "classifier",
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.dedupe = this.createStageMetaEntry({
        status: "skipped",
        provider: "dedupe",
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      await this.recordStageOutcome(job, "extract_entities", stagedCleaned.stage_meta.entities);
      await this.recordStageOutcome(job, "extract_sentiment", stagedCleaned.stage_meta.sentiment);
      await this.recordStageOutcome(job, "extract_kg", stagedCleaned.stage_meta.kg);
      await this.recordStageOutcome(job, "classify", stagedCleaned.stage_meta.classify);
      await this.recordStageOutcome(job, "dedupe", stagedCleaned.stage_meta.dedupe);
    } else {
      stagedCleaned = await this.runIndependentEnrichmentStages(
        job,
        payload,
        article,
        stagedCleaned,
        extractionSettings,
      );

      const cleanedWithClassification = await this.runClassificationStage(
        job,
        payload,
        article,
        stagedCleaned,
      );

      stagedCleaned = cleanedWithClassification;

      const dedupe = await this.runStage(job, "dedupe", async () =>
        this.evaluateSummaryDedupe({
          job,
          payload,
          cleaned: stagedCleaned,
          contentDuplicateOf,
        }),
      );
      stagedCleaned.stage_meta = {
        ...(stagedCleaned.stage_meta ?? {}),
        dedupe: this.createStageMetaEntry({
          status: "completed",
          provider: "dedupe",
          reason:
            dedupe.duplicateOf && dedupe.duplicateSimilarity !== null
              ? `duplicate:${dedupe.duplicateOf}`
              : null,
        }),
      };
      await this.recordStageOutcome(job, "dedupe", stagedCleaned.stage_meta.dedupe);

      let persistResult;
      try {
        persistResult = await this.runStage(
          job,
          "persist",
          async () =>
            this.persistProcessedResult({
              job,
              raw,
              payload,
              article,
              cleaned: stagedCleaned,
              llm,
              contentHash,
              processedArticleId,
              articleMetadataPatch: {
                ...articleMetadataPatch,
                extraction: {
                  mode: NewsExtractionPipelineMode.staged,
                  gateRejected: false,
                  preflightQualityScore: preflight.qualityScore ?? null,
                },
              },
              processedItemId: job.processedItemId,
              summaryEmbedding: dedupe.summaryEmbedding ?? undefined,
              summaryEmbeddingModel: dedupe.summaryEmbeddingModel ?? undefined,
              duplicateOf: dedupe.duplicateOf ?? undefined,
              duplicateSimilarity: dedupe.duplicateSimilarity ?? undefined,
            }),
          {
            onErrorData: () => ({
              rawItemId: raw.id,
              itemMetaId: job.itemMetaId,
            }),
          },
        );
      } catch (error) {
        // The dedupe stage already marked the item Duplicate; if persist
        // fails the item must not stay Duplicate with no processed document.
        await this.revertDuplicateMarkOnPersistFailure(job, dedupe.duplicateOf);
        throw error;
      }

      const document = persistResult.processedItem.toJSON() as { id?: string };
      return {
        ...document,
        id: document.id ?? persistResult.processedItem._id.toString(),
      };
    }

    const persistResult = await this.runStage(
      job,
      "persist",
      async () =>
        this.persistProcessedResult({
          job,
          raw,
          payload,
          article,
          cleaned: stagedCleaned,
          llm,
          contentHash,
          processedArticleId,
          articleMetadataPatch: {
            ...articleMetadataPatch,
            extraction: {
              mode: NewsExtractionPipelineMode.staged,
              gateRejected: true,
              gateReason: qualityGate.reason ?? "quality_gate_rejected",
              preflightQualityScore: preflight.qualityScore ?? null,
            },
          },
          processedItemId: job.processedItemId,
        }),
      {
        onErrorData: () => ({
          rawItemId: raw.id,
          itemMetaId: job.itemMetaId,
        }),
      },
    );

    const document = persistResult.processedItem.toJSON() as { id?: string };
    return {
      ...document,
      id: document.id ?? persistResult.processedItem._id.toString(),
    };
  }

  private emptyLlmMetadata(): LlmCallMetadata {
    return {
      model: null,
      promptVersion: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
      latencyMs: null,
    };
  }

  private createStageMetaEntry(input: {
    status: StageStatus;
    provider: string | null;
    reason?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  }): StageMetaEntry {
    return {
      status: input.status,
      provider: input.provider,
      reason: input.reason ?? null,
      model: input.model ?? null,
      prompt_version: input.promptVersion ?? null,
      prompt_tokens: input.promptTokens ?? null,
      completion_tokens: input.completionTokens ?? null,
      total_tokens: input.totalTokens ?? null,
      cost_usd: input.costUsd ?? null,
      latency_ms: input.latencyMs ?? null,
    };
  }

  private evaluatePreflightGate(
    article: CrawledArticle,
    settings: NewsExtractionSettings,
  ): {
    rejected: boolean;
    reason?: string;
    qualityScore?: number;
    qualityThreshold?: number;
  } {
    const gate = settings.preflightGate;
    if (!gate.enabled) {
      return { rejected: false };
    }
    const markdown = this.buildPipelineQualityMarkdown(article);
    const quality = this.assessPipelineMarkdownQuality(markdown);
    const qualityScore = this.computePreflightQualityScore(quality);
    const qualityThreshold = gate.minQualityScore;
    if (
      gate.rejectBotChallenge &&
      (quality.isChallenge || this.isLikelyBotChallengeMarkdown(markdown))
    ) {
      return {
        rejected: true,
        reason: "bot_challenge_markdown",
        qualityScore,
        qualityThreshold,
      };
    }
    if (gate.rejectListLike && quality.isListLike) {
      return {
        rejected: true,
        reason: "list_like_markdown",
        qualityScore,
        qualityThreshold,
      };
    }
    if (quality.words < gate.minWordCount) {
      return {
        rejected: true,
        reason: "insufficient_word_count",
        qualityScore,
        qualityThreshold,
      };
    }
    if (qualityScore < qualityThreshold) {
      return {
        rejected: true,
        reason: "preflight_quality_score_below_threshold",
        qualityScore,
        qualityThreshold,
      };
    }
    return { rejected: false, qualityScore, qualityThreshold };
  }

  private computePreflightQualityScore(quality: {
    words: number;
    paragraphs: number;
    headingCount: number;
    linkCount: number;
    bulletLines: number;
    isChallenge: boolean;
    isListLike: boolean;
  }) {
    if (quality.words <= 0 || quality.isChallenge) {
      return 0;
    }

    const score = this.clamp01(
      0.15 +
        0.45 * this.clamp01(quality.words / 300) +
        0.25 * this.clamp01(quality.paragraphs / 5) +
        0.1 * this.clamp01(quality.headingCount / 4) -
        0.2 * this.clamp01(quality.linkCount / 30) -
        0.1 * this.clamp01(quality.bulletLines / 40),
    );

    return quality.isListLike ? Math.min(score, 0.3) : score;
  }

  private clamp01(value: number) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.min(1, Math.max(0, value));
  }

  private evaluatePostCleanGate(
    cleaned: CleanedNews,
    settings: NewsExtractionSettings,
  ): { rejected: boolean; reason?: string } {
    const gate = settings.postCleanGate;
    if (!gate.enabled) {
      return { rejected: false };
    }
    const cleanedChars = cleaned.cleaned_markdown.trim().length;
    if (cleanedChars < gate.minCleanedChars) {
      return { rejected: true, reason: "cleaned_markdown_too_short" };
    }
    if (gate.requireSummary && !(cleaned.summary && cleaned.summary.trim())) {
      return { rejected: true, reason: "missing_summary" };
    }
    const qualityScore =
      typeof cleaned.quality_score === "number" &&
      Number.isFinite(cleaned.quality_score)
        ? cleaned.quality_score
        : null;
    if (qualityScore !== null && qualityScore < gate.minQualityScore) {
      return { rejected: true, reason: "quality_score_below_threshold" };
    }
    return { rejected: false };
  }

  private buildGateRejectedCleanedNews(options: {
    article: CrawledArticle;
    payload: NormalizedNewsPayload;
    reason: string;
    stageMeta: NewsStageMeta;
  }): CleanedNews {
    const fallbackMarkdown = this.buildMarkdownForLlm(
      options.article,
      Math.min(this.configService.config.pipeline.maxInputChars, 8_000),
    );
    const summaryText = fallbackMarkdown.markdown
      .split(/\n\s*\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 2)
      .join(" ")
      .slice(0, 300);

    return CleanedNewsSchema.parse({
      title: options.payload.sourceName ?? null,
      subtitle: null,
      author: null,
      source: options.payload.sourceName ?? null,
      published_at: options.article.publishedAt ?? null,
      language: options.payload.language ?? null,
      location: null,
      category: null,
      content_type: null,
      category_path: null,
      category_labels: [],
      category_confidence: null,
      category_reason: null,
      category_method: null,
      category_candidates: [],
      sentiment: null,
      sentiment_label: null,
      topics: [],
      summary: summaryText || null,
      key_points: [],
      entities: [],
      kg_relations: [],
      stage_meta: options.stageMeta,
      cleaned_markdown: fallbackMarkdown.markdown || options.article.markdown,
      cleaned_markdown_source: "crawl_fallback",
      removed_noise_types: [options.reason],
      quality_score: null,
      llm_model: null,
      llm_prompt_version: null,
    });
  }

  private stripEnrichmentFields(cleaned: CleanedNews): CleanedNews {
    return {
      ...cleaned,
      sentiment: null,
      sentiment_label: null,
      entities: [],
      kg_relations: [],
    };
  }

  private async runIndependentEnrichmentStages(
    job: PipelineJobContext,
    payload: NormalizedNewsPayload,
    article: CrawledArticle,
    cleaned: CleanedNews,
    settings: NewsExtractionSettings,
  ): Promise<CleanedNews> {
    const promptConfig = await this.promptConfig.getConfig();
    const context: NewsStageContext = {
      orgId: job.orgId,
      jobId: job.jobId,
    };
    const promptInput = {
      title: cleaned.title ?? null,
      summary: cleaned.summary ?? null,
      language: cleaned.language ?? payload.language ?? null,
      markdown: cleaned.cleaned_markdown,
    };

    let next = { ...cleaned, stage_meta: { ...(cleaned.stage_meta ?? {}) } };

    if (!settings.capabilities.entities) {
      next.stage_meta.entities = this.createStageMetaEntry({
        status: "skipped",
        provider: settings.providers.entities,
        reason: "capability_disabled",
      });
      await this.recordStageOutcome(job, "extract_entities", next.stage_meta.entities);
    } else {
      try {
        const entities = await this.extractionStages.extractEntities(
          context,
          promptConfig,
          settings.providers.entities,
          promptInput,
        );
        next.entities = entities.entities;
        next.stage_meta.entities = this.createStageMetaEntry({
          status: "completed",
          provider: entities.llm?.provider ?? settings.providers.entities,
          model: entities.llm?.model ?? null,
          promptVersion: entities.llm?.promptVersion ?? promptConfig.version,
          promptTokens: entities.llm?.promptTokens ?? null,
          completionTokens: entities.llm?.completionTokens ?? null,
          totalTokens: entities.llm?.totalTokens ?? null,
          costUsd: entities.llm?.costUsd ?? null,
          latencyMs: entities.llm?.latencyMs ?? null,
        });
        await this.recordStageOutcome(job, "extract_entities", next.stage_meta.entities);
      } catch (error) {
        next.entities = [];
        next.stage_meta.entities = this.createStageMetaEntry({
          status: "failed",
          provider: settings.providers.entities,
          reason: error instanceof Error ? error.message : "entity_extraction_failed",
        });
        await this.logStageFailure(job, "extract_entities", undefined, error);
        await this.recordStageOutcome(job, "extract_entities", next.stage_meta.entities);
      }
    }

    if (!settings.capabilities.sentiment) {
      next.stage_meta.sentiment = this.createStageMetaEntry({
        status: "skipped",
        provider: settings.providers.sentiment,
        reason: "capability_disabled",
      });
      await this.recordStageOutcome(job, "extract_sentiment", next.stage_meta.sentiment);
    } else {
      try {
        const sentiment = await this.extractionStages.analyzeSentiment(
          context,
          promptConfig,
          settings.providers.sentiment,
          promptInput,
        );
        next.sentiment = sentiment.sentimentLabel;
        next.sentiment_label = sentiment.sentimentLabel;
        next.stage_meta.sentiment = this.createStageMetaEntry({
          status: "completed",
          provider: sentiment.llm?.provider ?? settings.providers.sentiment,
          model: sentiment.llm?.model ?? null,
          promptVersion: sentiment.llm?.promptVersion ?? promptConfig.version,
          promptTokens: sentiment.llm?.promptTokens ?? null,
          completionTokens: sentiment.llm?.completionTokens ?? null,
          totalTokens: sentiment.llm?.totalTokens ?? null,
          costUsd: sentiment.llm?.costUsd ?? null,
          latencyMs: sentiment.llm?.latencyMs ?? null,
        });
        await this.recordStageOutcome(job, "extract_sentiment", next.stage_meta.sentiment);
      } catch (error) {
        next.sentiment = null;
        next.sentiment_label = null;
        next.stage_meta.sentiment = this.createStageMetaEntry({
          status: "failed",
          provider: settings.providers.sentiment,
          reason:
            error instanceof Error ? error.message : "sentiment_extraction_failed",
        });
        await this.logStageFailure(job, "extract_sentiment", undefined, error);
        await this.recordStageOutcome(job, "extract_sentiment", next.stage_meta.sentiment);
      }
    }

    if (!settings.capabilities.kg) {
      next.stage_meta.kg = this.createStageMetaEntry({
        status: "skipped",
        provider: settings.providers.kg,
        reason: "capability_disabled",
      });
      await this.recordStageOutcome(job, "extract_kg", next.stage_meta.kg);
      return next;
    }

    try {
      const kg = await this.extractionStages.extractKgRelations(
        context,
        promptConfig,
        settings.providers.kg,
        {
          ...promptInput,
          markdown: this.buildKgExtractionMarkdown(promptInput, next.entities),
        },
      );
      next.kg_relations = kg.relations;
      next.stage_meta.kg = this.createStageMetaEntry({
        status: "completed",
        provider: kg.llm?.provider ?? settings.providers.kg,
        model: kg.llm?.model ?? null,
        promptVersion: kg.llm?.promptVersion ?? promptConfig.version,
        promptTokens: kg.llm?.promptTokens ?? null,
        completionTokens: kg.llm?.completionTokens ?? null,
        totalTokens: kg.llm?.totalTokens ?? null,
        costUsd: kg.llm?.costUsd ?? null,
        latencyMs: kg.llm?.latencyMs ?? null,
      });
      await this.recordStageOutcome(job, "extract_kg", next.stage_meta.kg);
    } catch (error) {
      next.kg_relations = [];
      next.stage_meta.kg = this.createStageMetaEntry({
        status: "failed",
        provider: settings.providers.kg,
        reason: error instanceof Error ? error.message : "kg_extraction_failed",
      });
      await this.logStageFailure(job, "extract_kg", undefined, error);
      await this.recordStageOutcome(job, "extract_kg", next.stage_meta.kg);
    }

    return next;
  }

  private buildKgExtractionMarkdown(
    input: {
      markdown: string;
      title?: string | null;
      summary?: string | null;
      language?: string | null;
    },
    entities: CleanedNews["entities"],
  ) {
    const entitySummary =
      entities.length > 0
        ? `Entities: ${entities
            .slice(0, 20)
            .map((entity) => `${entity.name} (${entity.type})`)
            .join(", ")}`
        : "";
    return [entitySummary, input.markdown].filter(Boolean).join("\n\n");
  }

  private async runClassificationStage(
    job: PipelineJobContext,
    payload: NormalizedNewsPayload,
    article: CrawledArticle,
    cleaned: CleanedNews,
  ): Promise<CleanedNews> {
    if (!this.classifier) {
      const next = {
        ...cleaned,
        stage_meta: {
          ...(cleaned.stage_meta ?? {}),
          classify: this.createStageMetaEntry({
            status: "skipped",
            provider: "classifier",
            reason: "classifier_unavailable",
          }),
        },
      };
      await this.recordStageOutcome(job, "classify", next.stage_meta.classify);
      return next;
    }

    const classification = await this.runStage(
      job,
      "classify",
      async () =>
        this.classifier!.classify(job.orgId, cleaned, {
          jobId: job.jobId,
          sourceId: this.extractSourceId(payload) ?? null,
          sourceUrl:
            (typeof article.sourceUrl === "string" &&
            article.sourceUrl.trim().length > 0
              ? article.sourceUrl.trim()
              : payload.url) ?? null,
          sourceLabel: cleaned.source ?? payload.sourceName ?? null,
        }),
      {
        onErrorData: () => ({
          itemMetaId: job.itemMetaId,
        }),
      },
    );
    const next = this.classifier.applyToCleanedNews(cleaned, classification);
    next.stage_meta = {
      ...(next.stage_meta ?? {}),
      classify: this.createStageMetaEntry({
        status: "completed",
        provider: "classifier",
        reason: classification.method,
      }),
    };
    await this.recordStageOutcome(job, "classify", next.stage_meta.classify);
    return next;
  }

  private async recordStageOutcome(
    job: PipelineJobContext,
    stage: string,
    entry: StageMetaEntry | undefined,
    data?: Record<string, unknown>,
  ) {
    await writeTaskLogBestEffort({
      queue: job.queue,
      jobId: job.jobId,
      orgId: job.orgId,
      stage,
      status: entry?.status === "failed" ? "failed" : "completed",
      data: {
        ...(data ?? {}),
        ...(entry ? { stageMeta: entry } : {}),
      },
    });
    await this.updatePipelineJobStageMetadata(job, stage, entry);
  }

  private async updatePipelineJobStageMetadata(
    job: PipelineJobContext,
    stage: string,
    entry: StageMetaEntry | undefined,
  ) {
    if (!job.pipelineJobId || !entry) {
      return;
    }
    try {
      const current = await this.prisma.pipelineJob.findUnique({
        where: { id: job.pipelineJobId },
        select: { metadata: true },
      });
      const metadata =
        current?.metadata &&
        typeof current.metadata === "object" &&
        !Array.isArray(current.metadata)
          ? ({ ...current.metadata } as Record<string, unknown>)
          : {};
      const extraction =
        metadata.extraction &&
        typeof metadata.extraction === "object" &&
        !Array.isArray(metadata.extraction)
          ? ({
              ...(metadata.extraction as Record<string, unknown>),
            } as Record<string, unknown>)
          : {};
      const stages =
        extraction.stages &&
        typeof extraction.stages === "object" &&
        !Array.isArray(extraction.stages)
          ? ({
              ...(extraction.stages as Record<string, unknown>),
            } as Record<string, unknown>)
          : {};

      stages[stage] = entry;
      extraction.stages = stages;
      extraction.updatedAt = new Date().toISOString();
      metadata.extraction = extraction;

      await this.prisma.pipelineJob.updateMany({
        where: { id: job.pipelineJobId },
        data: {
          metadata: toPrismaJsonValue(metadata),
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pipelineJobId: job.pipelineJobId, stage },
        "Failed to update pipeline job extraction metadata",
      );
    }
  }

  private async persistProcessedResult(options: {
    job: PipelineJobContext;
    raw: RawPipelineItem;
    payload: NormalizedNewsPayload;
    article: CrawledArticle & { fromCache: boolean };
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    contentHash: string;
    processedArticleId?: string | null;
    articleMetadataPatch?: Record<string, unknown>;
    processedItemId?: string;
    summaryEmbedding?: number[] | null;
    summaryEmbeddingModel?: string | null;
    duplicateOf?: string | null;
    duplicateSimilarity?: number | null;
  }): Promise<PersistResult> {
    const processedItemId =
      options.processedItemId && Types.ObjectId.isValid(options.processedItemId)
        ? options.processedItemId
        : new Types.ObjectId().toHexString();
    const crawlPublishedAt =
      this.parseDate(options.article.publishedAt)?.toISOString() ?? null;
    const cleaned: CleanedNews = {
      ...options.cleaned,
      published_at: options.cleaned.published_at ?? crawlPublishedAt,
    };
    const outboxPayload = this.buildProcessedItemOutboxPayload({
      processedItemId,
      raw: options.raw,
      orgId: options.job.orgId,
      sourceId: options.job.sourceId ?? this.extractSourceId(options.payload),
      payload: options.payload,
      cleaned,
      llm: options.llm,
      summaryEmbedding: options.summaryEmbedding ?? undefined,
      summaryEmbeddingModel: options.summaryEmbeddingModel ?? undefined,
      duplicateOf: options.duplicateOf ?? undefined,
      duplicateSimilarity: options.duplicateSimilarity ?? undefined,
    });

    const outboxEntry = await this.createOutboxEntry({
      orgId: options.job.orgId,
      payload: outboxPayload,
      processedItemId,
      contentHash: options.contentHash,
      article: options.article,
      cleaned,
      llm: options.llm,
      articleMetadataPatch: options.articleMetadataPatch,
      processedArticleId: options.processedArticleId,
      normalizedPayload: options.payload,
      pipelineJobId: options.job.pipelineJobId,
      sourceId: options.job.sourceId,
    });

    return {
      processedItem: this.buildPendingProcessedItem(processedItemId),
      outboxId: outboxEntry.id,
    };
  }

  private async fetchArticle(
    job: PipelineJobContext,
    payload: NormalizedNewsPayload,
  ): Promise<CrawledArticle & { fromCache: boolean }> {
    const prefetchedMarkdown = payload.prefetchedArticle?.markdown?.trim();
    if (prefetchedMarkdown) {
      const prefetchedMetadataRaw = payload.prefetchedArticle?.metadata;
      const prefetchedMetadata =
        prefetchedMetadataRaw &&
        typeof prefetchedMetadataRaw === "object" &&
        !Array.isArray(prefetchedMetadataRaw)
          ? (prefetchedMetadataRaw as Record<string, unknown>)
          : {};
      const prefetchedPublishedAt =
        this.parseDate(payload.prefetchedArticle?.publishedAt)?.toISOString() ??
        null;
      const fetchedAt = new Date().toISOString();
      const contentHash = createHash("sha256")
        .update(prefetchedMarkdown)
        .digest("hex");
      return {
        sourceUrl: payload.url,
        markdown: prefetchedMarkdown,
        metadata: {
          ...payload.metadata,
          ...prefetchedMetadata,
          prefetchedArticle: true,
          ...(payload.prefetchedArticle?.title
            ? { title: payload.prefetchedArticle.title }
            : {}),
          ...(payload.prefetchedArticle?.description
            ? { description: payload.prefetchedArticle.description }
            : {}),
          ...(payload.prefetchedArticle?.author
            ? { author: payload.prefetchedArticle.author }
            : {}),
        },
        publishedAt: prefetchedPublishedAt,
        runId: null,
        fetchedAt,
        contentHash,
        fromCache: false,
      };
    }

    const queryParamAllowlist = this.extractUrlQueryParamAllowlist(payload);
    if (!payload.forceRefresh) {
      const crawlResultId = this.extractCrawlResultId(payload);
      if (crawlResultId) {
        try {
          const stored = await this.fetchStoredCrawlResult(
            job.orgId,
            crawlResultId,
          );
          return this.expandListLikeArticleIfNeeded({
            job,
            payload,
            article: stored,
            fromCache: true,
          });
        } catch (error) {
          this.logger.warn(
            { error, orgId: job.orgId, crawlResultId, url: payload.url },
            "Failed to load stored crawl result; continuing with crawl task",
          );
        }
      }

      const cacheTtlSeconds =
        this.configService.config.pipeline.cacheTtlSeconds;
      const since = new Date(Date.now() - cacheTtlSeconds * 1000);
      try {
        const recentResultId = await this.findRecentStoredCrawlResultId({
          orgId: job.orgId,
          url: payload.url,
          since,
          queryParamAllowlist,
        });
        if (recentResultId) {
          const stored = await this.fetchStoredCrawlResult(
            job.orgId,
            recentResultId,
          );
          payload.metadata.crawlResultId = recentResultId;
          return this.expandListLikeArticleIfNeeded({
            job,
            payload,
            article: stored,
            fromCache: true,
          });
        }
      } catch (error) {
        this.logger.warn(
          { error, orgId: job.orgId, url: payload.url },
          "Failed to load recent stored crawl result; continuing with crawl task",
        );
      }
    }

    const created = await this.crawlViaCrawlTask({
      orgId: job.orgId,
      url: payload.url,
      payload,
    });

    const stored = await this.fetchStoredCrawlResult(
      job.orgId,
      created.crawlResultId,
    );
    payload.metadata.crawlResultId = created.crawlResultId;
    payload.metadata.crawlTaskId = created.crawlTaskId;
    return this.expandListLikeArticleIfNeeded({
      job,
      payload,
      article: stored,
      fromCache: false,
    });
  }

  private async expandListLikeArticleIfNeeded(options: {
    job: PipelineJobContext;
    payload: NormalizedNewsPayload;
    article: CrawledArticle;
    fromCache: boolean;
  }): Promise<CrawledArticle & { fromCache: boolean }> {
    const expanded = await this.expandListLikeArticle({
      job: options.job,
      payload: options.payload,
      article: options.article,
    });

    if (!expanded) {
      return {
        ...options.article,
        fromCache: options.fromCache,
      };
    }

    options.payload.metadata.crawlResultId = expanded.crawlResultId;
    options.payload.metadata.crawlTaskId = expanded.crawlTaskId;
    options.payload.metadata.expandedFromUrl = options.article.sourceUrl;

    return {
      ...expanded.article,
      fromCache: false,
    };
  }

  private async expandListLikeArticle(options: {
    job: PipelineJobContext;
    payload: NormalizedNewsPayload;
    article: CrawledArticle;
  }): Promise<{
    article: CrawledArticle;
    crawlResultId: string;
    crawlTaskId: string;
  } | null> {
    const baseQuality = this.assessPipelineMarkdownQuality(
      this.buildPipelineQualityMarkdown(options.article),
    );
    const shouldExpand =
      !baseQuality.isChallenge &&
      (baseQuality.isListLike ||
        (baseQuality.linkCount >= 12 && baseQuality.words < 360));

    if (!shouldExpand) {
      return null;
    }

    const candidates = this.extractDetailLinkCandidates(options.article);
    if (candidates.length === 0) {
      if (baseQuality.isListLike && baseQuality.words < 260) {
        throw new Error(
          `crawl markdown is list-like and low-signal (words=${baseQuality.words}, links=${baseQuality.linkCount}), and no detail candidate URLs were extracted`,
        );
      }
      return null;
    }

    const maxCandidates = Math.min(candidates.length, 5);
    let best: {
      article: CrawledArticle;
      crawlResultId: string;
      crawlTaskId: string;
      score: number;
      words: number;
    } | null = null;

    for (let index = 0; index < maxCandidates; index += 1) {
      const candidateUrl = candidates[index]!;
      try {
        const created = await this.crawlViaCrawlTask({
          orgId: options.job.orgId,
          url: candidateUrl,
          payload: options.payload,
        });
        const stored = await this.fetchStoredCrawlResult(
          options.job.orgId,
          created.crawlResultId,
        );
        const quality = this.assessPipelineMarkdownQuality(stored.markdown);
        if (quality.isChallenge) {
          continue;
        }

        const passesMinimum =
          quality.words >= Math.max(baseQuality.words + 80, 160);
        if (!passesMinimum) {
          continue;
        }

        if (!best || quality.score > best.score) {
          best = {
            article: stored,
            crawlResultId: created.crawlResultId,
            crawlTaskId: created.crawlTaskId,
            score: quality.score,
            words: quality.words,
          };
        }
      } catch (error) {
        this.logger.warn(
          { error, jobId: options.job.jobId, candidateUrl },
          "Failed to expand list-like crawl page via detail candidate",
        );
      }
    }

    if (!best) {
      if (baseQuality.isListLike && baseQuality.words < 260) {
        throw new Error(
          `crawl markdown is list-like and low-signal (words=${baseQuality.words}, links=${baseQuality.linkCount}), and detail crawling failed for all candidates`,
        );
      }
      return null;
    }

    const significantImprovement =
      best.score >= baseQuality.score + 220 ||
      best.words >= baseQuality.words + 120;

    if (!significantImprovement) {
      return null;
    }

    return {
      article: best.article,
      crawlResultId: best.crawlResultId,
      crawlTaskId: best.crawlTaskId,
    };
  }

  private buildPipelineQualityMarkdown(article: CrawledArticle) {
    const candidates = [
      article.markdown,
      article.markdownWithCitations,
      article.rawMarkdown,
      article.fitMarkdown,
    ]
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
      .map((entry) => entry.trim());

    if (candidates.length === 0) {
      return "";
    }

    const scored = candidates
      .map((value) => ({
        value,
        quality: this.assessPipelineMarkdownQuality(value),
      }))
      .sort((left, right) => {
        if (right.quality.score !== left.quality.score) {
          return right.quality.score - left.quality.score;
        }
        return right.value.length - left.value.length;
      });

    const best = scored[0];
    return best ? best.value : candidates[0]!;
  }

  private assessPipelineMarkdownQuality(markdown: string) {
    const normalized = markdown.trim();
    if (!normalized) {
      return {
        words: 0,
        paragraphs: 0,
        headingCount: 0,
        linkCount: 0,
        bulletLines: 0,
        score: Number.NEGATIVE_INFINITY,
        isChallenge: false,
        isListLike: false,
      };
    }

    const words = normalized
      .split(/\s+/)
      .filter((entry) => entry.length > 0).length;
    const paragraphs = normalized
      .split(/\n\s*\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length;
    const headingCount = (normalized.match(/^#{1,6}\s+/gm) ?? []).length;
    const linkCount = (normalized.match(/\]\((https?:\/\/|\/)/g) ?? []).length;
    const bulletLines = normalized
      .split(/\n/g)
      .map((entry) => entry.trim())
      .filter(
        (entry) =>
          entry.startsWith("- ") ||
          entry.startsWith("* ") ||
          entry.startsWith("• "),
      ).length;

    const isChallenge = this.isLikelyBotChallengeMarkdown(normalized);
    const linkDensity = words > 0 ? linkCount / words : linkCount;
    const isListLike =
      (linkCount >= 16 && words <= 900) ||
      (bulletLines >= 10 && linkCount >= 10) ||
      (linkDensity >= 0.09 && words <= 600);

    const score =
      Math.min(words, 12_000) +
      Math.min(paragraphs, 220) * 6 +
      headingCount * 3 -
      linkCount * 6 -
      bulletLines * 2;

    return {
      words,
      paragraphs,
      headingCount,
      linkCount,
      bulletLines,
      score,
      isChallenge,
      isListLike,
    };
  }

  private extractDetailLinkCandidates(article: CrawledArticle) {
    const fragments = [
      article.referencesMarkdown,
      article.markdownWithCitations,
      article.rawMarkdown,
      article.markdown,
      article.fitMarkdown,
    ]
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
      .join("\n");

    if (!fragments) {
      return [];
    }

    const seedUrls: string[] = [];

    const absoluteMatches = fragments.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
    seedUrls.push(...absoluteMatches);

    const inlineMarkdownLinks = Array.from(
      fragments.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
    )
      .map((match) => match[1])
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      );
    seedUrls.push(...inlineMarkdownLinks);

    const referenceDefinitions = Array.from(
      fragments.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm),
    )
      .map((match) => match[1])
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      );
    seedUrls.push(...referenceDefinitions);

    const baseUrl = article.sourceUrl;
    const seen = new Set<string>();
    const candidates: string[] = [];

    for (const seedUrl of seedUrls) {
      const normalized = this.normalizeDetailCandidateUrl(seedUrl, baseUrl);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      if (!this.isLikelyDetailArticleUrl(normalized, baseUrl)) {
        continue;
      }
      seen.add(normalized);
      candidates.push(normalized);
      if (candidates.length >= 20) {
        break;
      }
    }

    return candidates;
  }

  private normalizeDetailCandidateUrl(rawUrl: string, baseUrl: string) {
    const trimmed = rawUrl
      .trim()
      .replace(/^<+|>+$/g, "")
      .replace(/[,:;]+$/g, "");
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = new URL(trimmed, baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return undefined;
      }
      parsed.hash = "";
      const pathnameLower = parsed.pathname.toLowerCase();
      if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|pdf)$/i.test(pathnameLower)) {
        return undefined;
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private isLikelyDetailArticleUrl(url: string, baseUrl: string) {
    try {
      const parsed = new URL(url);
      const base = new URL(baseUrl);

      if (parsed.hostname !== base.hostname) {
        return false;
      }

      const normalizedPath = parsed.pathname.replace(/\/+$/, "");
      const segments = normalizedPath
        .split("/")
        .filter((entry) => entry.length > 0);
      if (segments.length < 2) {
        return false;
      }

      const lastSegment = segments[segments.length - 1]!;
      const articleDateSuffixPattern = /-\d{4}-\d{2}-\d{2}$/;
      if (articleDateSuffixPattern.test(lastSegment)) {
        return true;
      }

      if (/^\d{4}\/\d{2}\/\d{2}/.test(segments.slice(-3).join("/"))) {
        return true;
      }

      if (
        segments.some(
          (segment) => segment === "article" || segment === "articles",
        )
      ) {
        return true;
      }

      if (
        lastSegment.length >= 24 &&
        lastSegment.includes("-") &&
        segments.length >= 3
      ) {
        return true;
      }

      const likelySectionTail = new Set([
        "world",
        "business",
        "markets",
        "technology",
        "tech",
        "opinion",
        "sport",
        "sports",
        "news",
      ]);
      if (
        segments.length <= 2 &&
        likelySectionTail.has(lastSegment.toLowerCase())
      ) {
        return false;
      }

      if (
        segments.length >= 4 &&
        lastSegment.length >= 14 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment)
      ) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private extractCrawlResultId(payload: NormalizedNewsPayload): string | null {
    const metadata =
      payload.metadata &&
      typeof payload.metadata === "object" &&
      !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : null;
    const raw =
      metadata && typeof metadata.crawlResultId === "string"
        ? metadata.crawlResultId
        : "";
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async fetchStoredCrawlResult(
    orgId: string,
    crawlResultId: string,
  ): Promise<CrawledArticle> {
    const crawlResult = await this.prisma.crawlResult.findFirst({
      where: {
        id: crawlResultId,
        task: { orgId },
      },
      select: {
        id: true,
        sourceUrl: true,
        fetchedAt: true,
        markdownRef: true,
        contentHash: true,
        metadata: true,
      },
    });

    if (!crawlResult) {
      throw new Error("crawl result not found");
    }

    const markdownRef =
      typeof crawlResult.markdownRef === "string"
        ? crawlResult.markdownRef.trim()
        : "";
    if (!markdownRef) {
      throw new Error("crawl result content reference missing");
    }

    const doc = await CrawlResultContentModel.findById(markdownRef).lean();
    if (!doc || typeof doc !== "object") {
      throw new Error("crawl result content not found");
    }

    const docRecord = doc as Record<string, unknown>;
    const markdown = this.selectBestMarkdownFromContentDoc(docRecord);
    if (!markdown) {
      throw new Error("crawl result markdown missing");
    }

    const mysqlMetadata =
      crawlResult.metadata &&
      typeof crawlResult.metadata === "object" &&
      !Array.isArray(crawlResult.metadata)
        ? (crawlResult.metadata as Record<string, unknown>)
        : {};
    const mongoMetadata =
      docRecord.metadata &&
      typeof docRecord.metadata === "object" &&
      !Array.isArray(docRecord.metadata)
        ? ((docRecord.metadata as Record<string, unknown>) ?? {})
        : {};

    const metadata: Record<string, unknown> = {
      ...mongoMetadata,
      ...mysqlMetadata,
      crawlResultId: crawlResult.id,
    };

    const contentHash =
      typeof crawlResult.contentHash === "string" &&
      crawlResult.contentHash.length > 0
        ? crawlResult.contentHash
        : this.hashContent(markdown);

    const markdownWithCitations = this.normalizeMarkdownCandidate(
      this.readMarkdownField(docRecord, [
        "markdownWithCitations",
        "markdown_with_citations",
      ]),
    );

    const rawMarkdown = this.normalizeMarkdownCandidate(
      this.readMarkdownField(docRecord, ["rawMarkdown", "raw_markdown"]),
    );

    const fitMarkdown = this.normalizeMarkdownCandidate(
      this.readMarkdownField(docRecord, ["fitMarkdown", "fit_markdown"]),
    );

    const referencesMarkdown = this.normalizeMarkdownCandidate(
      this.readMarkdownField(docRecord, [
        "referencesMarkdown",
        "references_markdown",
      ]),
    );

    const crawlRunId =
      typeof docRecord.crawlRunId === "string"
        ? (docRecord.crawlRunId as string)
        : null;

    const fetchedAt = crawlResult.fetchedAt
      ? crawlResult.fetchedAt.toISOString()
      : new Date().toISOString();

    return {
      sourceUrl: crawlResult.sourceUrl,
      markdown,
      markdownWithCitations,
      referencesMarkdown,
      rawMarkdown,
      fitMarkdown,
      metadata,
      publishedAt: fetchedAt,
      runId: crawlRunId,
      fetchedAt,
      contentHash,
    };
  }

  private readMarkdownField(
    record: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") {
        return value;
      }
    }
    return undefined;
  }

  private normalizeMarkdownCandidate(
    value: string | undefined,
  ): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private selectBestMarkdownFromContentDoc(
    record: Record<string, unknown>,
  ): string | undefined {
    const primary = this.normalizeMarkdownCandidate(
      this.readMarkdownField(record, ["markdown"]),
    );
    const citations = this.normalizeMarkdownCandidate(
      this.readMarkdownField(record, [
        "markdownWithCitations",
        "markdown_with_citations",
      ]),
    );
    const raw = this.normalizeMarkdownCandidate(
      this.readMarkdownField(record, ["rawMarkdown", "raw_markdown"]),
    );
    const fit = this.normalizeMarkdownCandidate(
      this.readMarkdownField(record, ["fitMarkdown", "fit_markdown"]),
    );

    const current = primary ?? citations ?? raw ?? fit;
    if (!current) {
      return undefined;
    }

    const richerCandidates = [citations, raw]
      .filter((entry): entry is string => Boolean(entry))
      .sort((left, right) => right.length - left.length);
    const richer = richerCandidates[0];

    if (!richer || richer === current) {
      return current;
    }

    const currentChallenge = this.isLikelyBotChallengeMarkdown(current);
    const richerChallenge = this.isLikelyBotChallengeMarkdown(richer);
    if (currentChallenge && !richerChallenge) {
      return richer;
    }

    if (current === fit && richer.length >= 1600 && current.length <= 800) {
      return richer;
    }

    if (richer.length >= 1200 && current.length < richer.length * 0.33) {
      return richer;
    }

    if (current.length < 320 && richer.length >= 1000) {
      return richer;
    }

    return current;
  }

  private isLikelyBotChallengeMarkdown(markdown: string): boolean {
    const normalized = markdown.toLowerCase();

    const strongIndicators = [
      "verification required",
      "please enable js and disable any ad blocker",
      "please enable javascript",
      "checking your browser before accessing",
      "you are being rate limited",
      "verify you are human",
      "verifying the device",
    ];

    if (strongIndicators.some((indicator) => normalized.includes(indicator))) {
      return true;
    }

    const weakIndicators = [
      "captcha",
      "cloudflare",
      "datadome",
      "are you human",
      "access denied",
      "security check",
      "automated requests",
      "bot detection",
    ];

    const weakHits = weakIndicators.reduce(
      (total, indicator) => total + (normalized.includes(indicator) ? 1 : 0),
      0,
    );

    return weakHits >= 2 && normalized.length < 12000;
  }

  private buildMarkdownForLlm(
    article: CrawledArticle,
    maxInputChars: number,
  ): {
    markdown: string;
    source: "primary" | "citations";
    variant: "primary" | "citations" | "raw" | "fit";
    referencesAppended: boolean;
  } {
    const normalize = (value?: string) =>
      typeof value === "string" ? value.trim() : "";

    const primary = normalize(article.markdown);
    const citations = normalize(article.markdownWithCitations);
    const raw = normalize(article.rawMarkdown);
    const fit = normalize(article.fitMarkdown);
    const references = normalize(article.referencesMarkdown);

    const candidates: {
      source: "primary" | "citations" | "raw" | "fit";
      value: string;
    }[] = [];

    if (primary) {
      candidates.push({ source: "primary", value: primary });
    }
    if (citations) {
      candidates.push({ source: "citations", value: citations });
    }
    if (raw) {
      candidates.push({ source: "raw", value: raw });
    }
    if (fit) {
      candidates.push({ source: "fit", value: fit });
    }

    const fallback = primary || citations || raw || fit;
    if (!fallback) {
      return {
        markdown: "",
        source: "primary",
        variant: "primary",
        referencesAppended: false,
      };
    }

    const scored = [...candidates].sort(
      (left, right) =>
        this.scoreMarkdownForLlmCandidate(right) -
        this.scoreMarkdownForLlmCandidate(left),
    );

    let selected = scored[0] ?? { source: "primary" as const, value: fallback };

    if (this.isLikelyBotChallengeMarkdown(selected.value)) {
      const nonChallenge = scored.find(
        (candidate) => !this.isLikelyBotChallengeMarkdown(candidate.value),
      );
      if (nonChallenge) {
        selected = nonChallenge;
      }
    }

    if (
      selected.source === "fit" &&
      raw &&
      !this.isLikelyBotChallengeMarkdown(raw)
    ) {
      if (raw.length >= 1600 && selected.value.length < raw.length * 0.45) {
        selected = { source: "raw", value: raw };
      }
    }

    let merged = selected.value;
    let referencesAppended = false;

    if (
      references &&
      this.hasCitationMarkers(merged) &&
      !this.hasCitationReferenceDefinitions(merged)
    ) {
      const separator = merged.endsWith("\n") ? "\n" : "\n\n";
      merged = merged + separator + references;
      referencesAppended = true;
    }

    return {
      markdown: merged.slice(0, maxInputChars),
      source: selected.source === "citations" ? "citations" : "primary",
      variant: selected.source,
      referencesAppended,
    };
  }

  private scoreMarkdownForLlmCandidate(candidate: {
    source: "primary" | "citations" | "raw" | "fit";
    value: string;
  }) {
    const trimmed = candidate.value.trim();
    if (!trimmed) {
      return Number.NEGATIVE_INFINITY;
    }

    if (this.isLikelyBotChallengeMarkdown(trimmed)) {
      return -5000;
    }

    const words = trimmed
      .split(/\s+/)
      .filter((entry) => entry.length > 0).length;
    const headings = (trimmed.match(/^#{1,6}\s+/gm) ?? []).length;
    const paragraphs = trimmed
      .split(/\n\s*\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length;
    const markdownLinks = (trimmed.match(/\]\((https?:\/\/|\/)/g) ?? []).length;
    const citations = (trimmed.match(/\[\^[^\]]+\]/g) ?? []).length;

    let score =
      Math.min(words, 12000) +
      headings * 8 +
      Math.min(paragraphs, 200) * 3 +
      citations * 2 -
      markdownLinks * 2;

    if (candidate.source === "citations") {
      score += 30;
    }
    if (candidate.source === "fit") {
      score -= 80;
    }
    if (candidate.source === "raw") {
      score += 12;
    }

    return score;
  }

  private hasCitationMarkers(markdown: string) {
    return /\[\^[^\]]+\]/.test(markdown);
  }

  private hasCitationReferenceDefinitions(markdown: string) {
    return /^\[\^[^\]]+\]:\s+/m.test(markdown);
  }

  private async cleanArticle(
    payload: NormalizedNewsPayload,
    article: CrawledArticle & { fromCache: boolean },
    job: PipelineJobContext,
    cleanProvider = "llm",
  ): Promise<{
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    contentHash: string;
    processedArticleId?: string | null;
    contentDuplicateOf?: string | null;
    articleMetadataPatch?: Record<string, unknown>;
  }> {
    const contentHash =
      article.contentHash ?? this.hashContent(article.markdown);
    const existing = await this.findProcessedArticle(contentHash, job.orgId);
    if (existing) {
      const cleanedFromExisting = await this.resolveCleanedNews(existing);
      if (cleanedFromExisting) {
        const contentDuplicateOf = this.normalizeProcessedItemRef(
          existing.cleanedMarkdownRef,
        );
        return {
          cleaned: this.withResolvedContentType(cleanedFromExisting, {
            payload,
            article,
          }),
          llm: this.buildLlmMetadataFromProcessed(existing),
          contentHash,
          processedArticleId: existing.id,
          contentDuplicateOf,
          articleMetadataPatch: {
            llmRepair: {
              applied: false,
              missingFields: [],
              repairedFields: [],
              model: null,
              promptTokens: null,
              completionTokens: null,
              totalTokens: null,
              costUsd: null,
              latencyMs: null,
              source: "processed_cache",
            },
          },
        };
      }
    }

    const pipelineCfg = this.configService.config.pipeline;
    const markdownForPrompt = this.buildMarkdownForLlm(
      article,
      pipelineCfg.maxInputChars,
    );
    const truncated = markdownForPrompt.markdown;
    const promptConfig = await this.promptConfig.getConfig();
    const completionTimeoutMs = Math.max(
      await this.liteLlm.getCompletionTimeoutMs(),
      180_000,
    );
    if (cleanProvider !== "llm") {
      throw new Error(`Unsupported clean provider: ${cleanProvider}`);
    }
    const stageResponse = await this.extractionStages.cleanWithLlm(
      { orgId: job.orgId, jobId: job.jobId },
      promptConfig,
      {
        systemPrompt: this.promptBuilder.buildSystemPrompt(
          promptConfig,
          payload.language,
        ),
        denoisePrompt: this.promptBuilder.buildDenoisePrompt(promptConfig),
        userPrompt: this.promptBuilder.buildUserPrompt(promptConfig, {
          url: article.sourceUrl,
          markdown: truncated,
          metadata: {
            ...payload.metadata,
            publishedAt: article.publishedAt,
            sourceName: payload.sourceName,
            markdownSource: markdownForPrompt.source,
            markdownVariant: markdownForPrompt.variant,
            markdownReferencesAppended: markdownForPrompt.referencesAppended,
          },
          keywords: payload.keywords,
          summaryHints: payload.summaryHints,
          language: payload.language,
          cacheHit: article.fromCache,
        }),
        completionTimeoutMs,
      },
    );

    const cleaned = this.withResolvedContentType(
      this.withPromptMetadata(
        this.parseStoredCleanedNewsResult(
          this.applyCleanedMarkdownFallback(stageResponse.cleaned, truncated),
        ) ?? stageResponse.cleaned,
        promptConfig.version,
        stageResponse.llm.model,
      ),
      { payload, article },
    );
    const llm: LlmCallMetadata = {
      model: stageResponse.llm.model,
      promptVersion: promptConfig.version,
      promptTokens: stageResponse.llm.promptTokens,
      completionTokens: stageResponse.llm.completionTokens,
      totalTokens: stageResponse.llm.totalTokens,
      costUsd: stageResponse.llm.costUsd,
      latencyMs: stageResponse.llm.latencyMs,
    };
    const repaired = await this.maybeRepairCleanedArticle({
      job,
      payload,
      article,
      cleaned,
    });
    return {
      cleaned: repaired.cleaned,
      llm: this.mergeLlmMetadata(llm, repaired.llmDelta),
      contentHash,
      articleMetadataPatch: {
        llmRepair: repaired.metadata,
      },
    };
  }

  private async maybeRepairCleanedArticle(options: {
    job: PipelineJobContext;
    payload: NormalizedNewsPayload;
    article: CrawledArticle;
    cleaned: CleanedNews;
  }): Promise<{
    cleaned: CleanedNews;
    llmDelta?: LlmCallMetadata;
    metadata: ArticleRepairMetadata;
  }> {
    const missingFields = [
      options.cleaned.title ? null : "title",
      options.cleaned.source || options.payload.sourceName ? null : "source",
      options.cleaned.published_at || options.article.publishedAt
        ? null
        : "published_at",
      options.cleaned.author ? null : "author",
    ].filter((value): value is string => typeof value === "string");
    if (missingFields.length === 0) {
      return {
        cleaned: options.cleaned,
        metadata: {
          applied: false,
          missingFields: [],
          repairedFields: [],
          model: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          costUsd: null,
          latencyMs: null,
        },
      };
    }

    const markdownForPrompt = this.buildMarkdownForLlm(
      options.article,
      Math.min(this.configService.config.pipeline.maxInputChars, 12_000),
    );
    try {
      const response = await this.liteLlm.acompletion({
        orgId: options.job.orgId,
        temperature: 0.05,
        max_tokens: 600,
        metadata: {
          jobId: options.job.jobId,
          source: "news-pipeline",
          feature: "crawl_article_repair",
          ...(this.resolveFrontierLogMetadata(options.article.metadata) ?? {}),
        },
        messages: [
          {
            role: "system",
            content:
              "You repair missing structured news fields from cleaned markdown. " +
              "Only fill missing fields when the evidence is explicit. " +
              "Return strict JSON only and never rewrite existing non-empty fields.",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                url: options.article.sourceUrl,
                missingFields,
                existing: {
                  title: options.cleaned.title ?? null,
                  subtitle: options.cleaned.subtitle ?? null,
                  author: options.cleaned.author ?? null,
                  source:
                    options.cleaned.source ??
                    options.payload.sourceName ??
                    null,
                  published_at:
                    options.cleaned.published_at ??
                    options.article.publishedAt ??
                    null,
                  category: options.cleaned.category ?? null,
                },
                metadata: {
                  sourceName: options.payload.sourceName ?? null,
                  language: options.payload.language ?? null,
                  publishedAt: options.article.publishedAt,
                },
                markdown: markdownForPrompt.markdown,
              },
              null,
              2,
            ),
          },
        ],
      });
      const content = response.choices[0]?.message?.content;
      const jsonText = content ? extractFirstJson(content) : null;
      if (!jsonText) {
        throw new Error("crawl_article_repair returned invalid JSON");
      }
      const parsed = ArticleRepairSchema.parse(JSON.parse(jsonText));
      const repairedFields: string[] = [];
      const cleaned: CleanedNews = {
        ...options.cleaned,
        title:
          options.cleaned.title ??
          (parsed.title?.trim().length
            ? (repairedFields.push("title"), parsed.title.trim())
            : null),
        subtitle:
          options.cleaned.subtitle ??
          (parsed.subtitle?.trim().length
            ? (repairedFields.push("subtitle"), parsed.subtitle.trim())
            : null),
        author:
          options.cleaned.author ??
          (parsed.author?.trim().length
            ? (repairedFields.push("author"), parsed.author.trim())
            : null),
        source:
          options.cleaned.source ??
          options.payload.sourceName ??
          (parsed.source?.trim().length
            ? (repairedFields.push("source"), parsed.source.trim())
            : null),
        published_at:
          options.cleaned.published_at ??
          (typeof parsed.published_at === "string" &&
          parsed.published_at.trim().length > 0
            ? (this.parseDate(parsed.published_at)?.toISOString() ?? null)
            : (options.article.publishedAt ?? null)),
        category:
          options.cleaned.category ??
          (parsed.category?.trim().length
            ? (repairedFields.push("category"), parsed.category.trim())
            : null),
      };
      if (
        !options.cleaned.published_at &&
        typeof parsed.published_at === "string" &&
        parsed.published_at.trim().length > 0 &&
        this.parseDate(parsed.published_at)
      ) {
        repairedFields.push("published_at");
      }

      return {
        cleaned,
        llmDelta: {
          model: response.model,
          promptVersion: options.cleaned.llm_prompt_version ?? null,
          promptTokens: response.usage?.prompt_tokens ?? null,
          completionTokens: response.usage?.completion_tokens ?? null,
          totalTokens: response.usage?.total_tokens ?? null,
          costUsd: response.costUsd ?? null,
          latencyMs: response.latencyMs ?? null,
        },
        metadata: {
          applied: repairedFields.length > 0,
          missingFields,
          repairedFields,
          model: response.model,
          promptTokens: response.usage?.prompt_tokens ?? null,
          completionTokens: response.usage?.completion_tokens ?? null,
          totalTokens: response.usage?.total_tokens ?? null,
          costUsd: response.costUsd ?? null,
          latencyMs: response.latencyMs ?? null,
        },
      };
    } catch (error) {
      return {
        cleaned: options.cleaned,
        metadata: {
          applied: false,
          missingFields,
          repairedFields: [],
          model: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          costUsd: null,
          latencyMs: null,
          error:
            error instanceof Error
              ? error.message
              : "crawl_article_repair_failed",
        },
      };
    }
  }

  private mergeLlmMetadata(
    base: LlmCallMetadata,
    extra?: LlmCallMetadata,
  ): LlmCallMetadata {
    if (!extra) {
      return base;
    }
    const sumOrNull = (left: number | null, right: number | null) =>
      left === null && right === null
        ? null
        : Number(((left ?? 0) + (right ?? 0)).toFixed(6));
    return {
      model: base.model ?? extra.model,
      promptVersion: base.promptVersion ?? extra.promptVersion,
      promptTokens: sumOrNull(base.promptTokens, extra.promptTokens),
      completionTokens: sumOrNull(
        base.completionTokens,
        extra.completionTokens,
      ),
      totalTokens: sumOrNull(base.totalTokens, extra.totalTokens),
      costUsd: sumOrNull(base.costUsd, extra.costUsd),
      latencyMs: sumOrNull(base.latencyMs, extra.latencyMs),
    };
  }

  private resolveFrontierLogMetadata(
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, string> | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }
    const read = (...keys: string[]) => {
      for (const key of keys) {
        const value = metadata[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
      return null;
    };
    const runId = read("frontierRunId", "runId");
    const nodeId = read("frontierNodeId", "nodeId");
    const profileId = read("crawlSiteProfileId", "profileId");
    const resolved = {
      ...(runId ? { runId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(profileId ? { profileId } : {}),
    };
    return Object.keys(resolved).length > 0 ? resolved : null;
  }

  private async evaluateSummaryDedupe(options: {
    job: PipelineJobContext;
    payload: NormalizedNewsPayload;
    cleaned: CleanedNews;
    contentDuplicateOf?: string | null;
  }): Promise<SummaryDedupeResult> {
    const cfg = this.configService.config.pipeline;
    if (options.contentDuplicateOf) {
      // The content cache may legitimately hit this item's own previous run
      // (replay / retry clones the same content under a new rawItemId). In
      // that case the cached processed item belongs to the same itemMetaId,
      // so it is a cache reuse, not a duplicate — marking it would
      // permanently flip the item to Duplicate with no recovery path.
      const isSelfReference = await this.isSelfProcessedItemRef(
        options.job,
        options.contentDuplicateOf,
      );
      if (!isSelfReference) {
        await this.markItemMetaDuplicate(
          options.job,
          options.contentDuplicateOf,
          1,
        );
        return {
          duplicateOf: options.contentDuplicateOf,
          duplicateSimilarity: 1,
        };
      }
      return {};
    }

    if (!cfg.summaryDedupEnabled) {
      return {};
    }

    const summary = options.cleaned.summary?.trim();
    if (!summary || summary.length < cfg.summaryDedupMinChars) {
      return {};
    }

    const settings = await this.dedupeSettings.getSettings(options.job.orgId);
    const sourceId =
      options.job.sourceId ?? this.extractSourceId(options.payload);
    const thresholdBase = this.dedupeSettings.resolveBaseThreshold(settings, {
      sourceId,
      language: options.cleaned.language ?? options.payload.language,
      categoryPath: options.cleaned.category_path,
    }).threshold;
    const threshold = this.resolveSummaryDedupThreshold(
      summary.length,
      thresholdBase,
    );
    const baseResult: SummaryDedupeResult = { thresholdUsed: threshold };

    if (!settings.useEmbeddings) {
      const duplicate = await this.findLlmDuplicate({
        orgId: options.job.orgId,
        summary,
        threshold,
        job: options.job,
        cleaned: options.cleaned,
        llmJudgeInstructions: settings.llmJudgeInstructions,
        llmJudgeModel: settings.llmJudgeModel,
        llmJudgeConcurrency: settings.llmJudgeConcurrency,
        llmJudgeMaxComparisons: settings.llmJudgeMaxComparisons,
        llmJudgeCandidateChars: settings.llmJudgeCandidateChars,
        llmJudgePromptVersion: settings.llmJudgePromptVersion,
        llmJudgeSystemPromptTemplate: settings.llmJudgeSystemPromptTemplate,
        llmJudgeUserPromptTemplate: settings.llmJudgeUserPromptTemplate,
      });
      if (!duplicate) {
        return baseResult;
      }

      await this.markItemMetaDuplicate(
        options.job,
        duplicate.id,
        duplicate.similarity,
      );
      return {
        ...baseResult,
        duplicateOf: duplicate.id,
        duplicateSimilarity: duplicate.similarity,
      };
    }

    const embeddingData = await this.buildSummaryEmbedding(
      summary,
      options.job,
    );
    if (!embeddingData) {
      return baseResult;
    }

    const embeddingBaseResult: SummaryDedupeResult = {
      ...baseResult,
      summaryEmbedding: embeddingData.embedding,
      summaryEmbeddingModel: embeddingData.model,
    };

    const duplicate = await this.findSemanticDuplicate(
      options.job.orgId,
      embeddingData.embedding,
      embeddingData.model,
      threshold,
      options.job.itemMetaId,
    );
    if (!duplicate) {
      return embeddingBaseResult;
    }

    await this.markItemMetaDuplicate(
      options.job,
      duplicate.id,
      duplicate.similarity,
    );

    return {
      ...embeddingBaseResult,
      duplicateOf: duplicate.id,
      duplicateSimilarity: duplicate.similarity,
    };
  }

  private async findLlmDuplicate(options: {
    orgId: string;
    summary: string;
    threshold: number;
    job: PipelineJobContext;
    cleaned: CleanedNews;
    llmJudgeInstructions?: string | null;
    llmJudgeModel?: string | null;
    llmJudgeConcurrency?: number;
    llmJudgeMaxComparisons?: number;
    llmJudgeCandidateChars?: number;
    llmJudgePromptVersion?: string;
    llmJudgeSystemPromptTemplate?: string;
    llmJudgeUserPromptTemplate?: string;
  }): Promise<{ id: string; similarity: number } | null> {
    const cfg = this.configService.config.pipeline;
    const lookbackMs = cfg.summaryDedupLookbackHours * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - lookbackMs);
    const maxComparisons =
      typeof options.llmJudgeMaxComparisons === "number" &&
      Number.isFinite(options.llmJudgeMaxComparisons)
        ? Math.max(1, Math.round(options.llmJudgeMaxComparisons))
        : MAX_LLM_DEDUPE_COMPARISONS;
    const concurrency =
      typeof options.llmJudgeConcurrency === "number" &&
      Number.isFinite(options.llmJudgeConcurrency)
        ? Math.max(1, Math.round(options.llmJudgeConcurrency))
        : DEFAULT_LLM_DEDUPE_CONCURRENCY;
    const candidateChars =
      typeof options.llmJudgeCandidateChars === "number" &&
      Number.isFinite(options.llmJudgeCandidateChars)
        ? Math.max(1, Math.round(options.llmJudgeCandidateChars))
        : MAX_LLM_DEDUPE_CANDIDATE_CHARS;

    const candidates = await ProcessedItemModel.find({
      orgId: options.orgId,
      status: "completed",
      duplicateOf: null,
      // Exclude this item's own previous runs: replay/retry produce identical
      // content, so the current run's own completed document must never be a
      // dedupe candidate (quick-similarity would hit 1 and mark it Duplicate).
      itemMetaId: { $ne: options.job.itemMetaId },
      createdAt: { $gte: cutoff },
      "result.summary": { $exists: true, $ne: null },
    })
      .select({ _id: 1, "result.summary": 1, "result.title": 1 })
      .sort({ createdAt: -1 })
      .limit(cfg.summaryDedupMaxCandidates)
      .lean();

    const normalizedQuery = this.normalizeForQuickSimilarity(options.summary);
    const ranked = candidates
      .map((candidate) => {
        const summary = this.extractCandidateSummary(candidate);
        const title = this.extractCandidateTitle(candidate);
        const quick =
          summary && normalizedQuery
            ? this.quickSimilarity(
                normalizedQuery,
                this.normalizeForQuickSimilarity(summary),
              )
            : 0;
        const id = (candidate as { _id?: unknown })._id?.toString?.() ?? "";
        return {
          id,
          summary,
          title,
          quick,
        };
      })
      .filter(
        (entry): entry is RankedLlmDedupeCandidate =>
          Boolean(entry.id) && typeof entry.summary === "string",
      )
      .sort((a, b) => b.quick - a.quick)
      .slice(0, Math.min(cfg.summaryDedupMaxCandidates, maxComparisons * 3));

    const queryText = options.summary.slice(0, candidateChars);
    const rankedCandidates = ranked
      .slice(0, maxComparisons)
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        text: candidate.summary.slice(0, candidateChars),
      })) satisfies PreparedLlmDedupeCandidate[];

    for (const candidate of rankedCandidates) {
      const candidateText = candidate.text;
      if (this.normalizeForQuickSimilarity(candidateText) === normalizedQuery) {
        return { id: candidate.id, similarity: 1 };
      }
    }

    const scores = new Array<{
      similarity: number;
      isDuplicate: boolean;
    } | null>(rankedCandidates.length).fill(null);
    let shouldStop = false;
    let nextIndex = 0;

    const worker = async () => {
      while (!shouldStop) {
        const currentIndex = nextIndex++;
        if (currentIndex >= rankedCandidates.length) {
          return;
        }

        const candidate = rankedCandidates[currentIndex]!;
        const candidateText = candidate.text;

        const score = await this.scoreSummaryDuplicateWithLlm({
          job: options.job,
          threshold: options.threshold,
          summaryA: queryText,
          summaryB: candidateText,
          titleA: options.cleaned.title,
          titleB: candidate.title,
          language: options.cleaned.language,
          instructions: options.llmJudgeInstructions,
          model: options.llmJudgeModel,
          promptVersion: options.llmJudgePromptVersion,
          systemPromptTemplate: options.llmJudgeSystemPromptTemplate,
          userPromptTemplate: options.llmJudgeUserPromptTemplate,
        });
        if (!score) {
          continue;
        }

        scores[currentIndex] = score;
        if (
          score.isDuplicate &&
          score.similarity >= LLM_DEDUPE_EARLY_EXIT_SIMILARITY
        ) {
          shouldStop = true;
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(concurrency, rankedCandidates.length),
        },
        () => worker(),
      ),
    );

    let best: { id: string; similarity: number } | null = null;
    for (let index = 0; index < scores.length; index += 1) {
      const score = scores[index];
      if (!score?.isDuplicate) {
        continue;
      }

      const candidate = rankedCandidates[index];
      if (!candidate) {
        continue;
      }

      if (!best || score.similarity > best.similarity) {
        best = { id: candidate.id, similarity: score.similarity };
      }

      if (score.similarity >= LLM_DEDUPE_EARLY_EXIT_SIMILARITY) {
        break;
      }
    }

    return best && best.similarity >= options.threshold ? best : null;
  }

  private async scoreSummaryDuplicateWithLlm(options: {
    job: PipelineJobContext;
    threshold: number;
    summaryA: string;
    summaryB: string;
    titleA?: string | null;
    titleB?: string | null;
    language?: string | null;
    instructions?: string | null;
    model?: string | null;
    promptVersion?: string;
    systemPromptTemplate?: string;
    userPromptTemplate?: string;
  }): Promise<{ similarity: number; isDuplicate: boolean } | null> {
    try {
      const model = options.model?.trim() ? options.model.trim() : undefined;
      const response = await this.liteLlm.acompletion({
        orgId: options.job.orgId,
        ...(model ? { model } : {}),
        messages: [
          {
            role: "system",
            content: buildNewsDedupeSystemPrompt(
              options.language,
              options.instructions,
              options.systemPromptTemplate,
            ),
          },
          {
            role: "user",
            content: buildNewsDedupeUserPrompt(
              {
                threshold: options.threshold,
                summaryA: options.summaryA,
                summaryB: options.summaryB,
                titleA: options.titleA,
                titleB: options.titleB,
              },
              options.userPromptTemplate,
            ),
          },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 256,
        response_format: NEWS_DEDUPE_RESPONSE_FORMAT,
        metadata: {
          jobId: options.job.jobId,
          source: "news-pipeline",
          stage: "dedupe",
          threshold: options.threshold,
          promptVersion: options.promptVersion,
        },
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        return null;
      }

      const raw = safeJsonParseFromText<unknown>(content);
      const parsed = NewsDedupeJudgeSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(
          { jobId: options.job.jobId, issues: parsed.error.issues },
          "LLM dedupe judge returned invalid payload",
        );
        return null;
      }

      const similarity = Math.min(1, Math.max(0, parsed.data.similarity));
      const isDuplicate =
        parsed.data.is_duplicate || similarity >= options.threshold;
      return { similarity, isDuplicate };
    } catch (error) {
      this.logger.warn(
        { error, jobId: options.job.jobId },
        "LLM dedupe judge call failed",
      );
      return null;
    }
  }

  private extractCandidateSummary(candidate: unknown): string | null {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    const result = record.result;
    if (!result || typeof result !== "object") {
      return null;
    }
    const summary = (result as Record<string, unknown>).summary;
    return typeof summary === "string" && summary.trim()
      ? summary.trim()
      : null;
  }

  private extractCandidateTitle(candidate: unknown): string | null {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    const result = record.result;
    if (!result || typeof result !== "object") {
      return null;
    }
    const title = (result as Record<string, unknown>).title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  }

  private normalizeForQuickSimilarity(text: string): string {
    return text
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, "")
      .trim();
  }

  private quickSimilarity(a: string, b: string): number {
    if (!a || !b) {
      return 0;
    }
    if (a === b) {
      return 1;
    }
    const n = Math.min(
      3,
      Math.max(2, Math.min(a.length, b.length) >= 64 ? 3 : 2),
    );
    const aSet = this.toNgrams(a, n);
    const bSet = this.toNgrams(b, n);
    if (aSet.size === 0 || bSet.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const token of aSet) {
      if (bSet.has(token)) {
        intersection += 1;
      }
    }
    const union = aSet.size + bSet.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private toNgrams(text: string, n: number): Set<string> {
    const grams = new Set<string>();
    if (n <= 1) {
      for (const ch of text) {
        grams.add(ch);
      }
      return grams;
    }
    for (let i = 0; i <= text.length - n; i += 1) {
      grams.add(text.slice(i, i + n));
    }
    return grams;
  }

  private async buildSummaryEmbedding(
    summary: string,
    job: PipelineJobContext,
  ): Promise<{ embedding: number[]; model: string } | null> {
    const model = await this.liteLlm.getEmbeddingModel();
    if (!model) {
      this.logger.warn(
        { jobId: job.jobId },
        "Summary embedding model not configured; skipping semantic dedupe",
      );
      return null;
    }

    try {
      const response = await this.liteLlm.embedding({
        orgId: job.orgId,
        model,
        input: summary,
        metadata: {
          jobId: job.jobId,
          source: "news-pipeline",
          stage: "dedupe",
        },
      });
      const embedding = response.data?.[0]?.embedding;
      if (!embedding || embedding.length === 0) {
        return null;
      }
      return { embedding, model: response.model ?? model };
    } catch (error) {
      this.logger.warn(
        { error, jobId: job.jobId },
        "Failed to generate summary embedding",
      );
      return null;
    }
  }

  private async findSemanticDuplicate(
    orgId: string,
    embedding: number[],
    model: string,
    threshold: number,
    excludeItemMetaId?: string,
  ): Promise<{ id: string; similarity: number } | null> {
    const cfg = this.configService.config.pipeline;
    const lookbackMs = cfg.summaryDedupLookbackHours * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - lookbackMs);
    const startTime = Date.now();

    const vectorClient = this.vectorClient;
    if (vectorClient) {
      const matches = await vectorClient.searchBestEffort({
        orgId,
        embeddingModel: model,
        vector: embedding,
        limit: Math.min(Math.max(cfg.summaryDedupMaxCandidates, 1), 200),
        minScore: threshold,
        lookbackMs,
      });
      if (matches) {
        if (
          matches.length === 0 &&
          !(await vectorClient.fallbackToMongoEnabled())
        ) {
          return null;
        }
        if (matches.length > 0) {
          const ordered = matches
            .map((match) => match.processedItemId)
            .filter((id) => Types.ObjectId.isValid(id));
          const objectIds = ordered.map((id) => new Types.ObjectId(id));
          if (objectIds.length > 0) {
            const allowed = await ProcessedItemModel.find(
              {
                _id: { $in: objectIds },
                orgId,
                status: "completed",
                summaryEmbeddingModel: model,
                duplicateOf: null,
                // Never allow this item's own previous run to match itself.
                ...(excludeItemMetaId
                  ? { itemMetaId: { $ne: excludeItemMetaId } }
                  : {}),
                createdAt: { $gte: cutoff },
              },
              { _id: 1 },
            ).lean();
            const allowedSet = new Set(
              allowed
                .map((doc) => (doc as { _id?: unknown })._id)
                .map((id) =>
                  typeof id === "string" ? id : (id?.toString?.() ?? ""),
                )
                .filter(Boolean),
            );

            for (const match of matches) {
              if (allowedSet.has(match.processedItemId)) {
                return { id: match.processedItemId, similarity: match.score };
              }
            }
          }
        }
      } else if (!(await vectorClient.fallbackToMongoEnabled())) {
        return null;
      }
    }

    const candidates = await ProcessedItemModel.find({
      orgId,
      status: "completed",
      summaryEmbeddingModel: model,
      summaryEmbedding: { $exists: true, $ne: [] },
      duplicateOf: null,
      // Exclude this item's own previous runs from semantic matching.
      ...(excludeItemMetaId
        ? { itemMetaId: { $ne: excludeItemMetaId } }
        : {}),
      createdAt: { $gte: cutoff },
    })
      .select({ summaryEmbedding: 1 })
      .sort({ createdAt: -1 })
      .limit(cfg.summaryDedupMaxCandidates)
      .lean();

    // NP-PERF-003: Pre-normalize the query embedding for faster dot product comparison
    const normalizedEmbedding = this.normalizeVector(embedding);
    const HIGH_CONFIDENCE_THRESHOLD = 0.98;

    let best: { id: string; similarity: number } | null = null;
    let candidatesChecked = 0;

    for (const candidate of candidates) {
      const vector = (candidate as { summaryEmbedding?: number[] })
        .summaryEmbedding;
      if (!Array.isArray(vector) || vector.length !== embedding.length) {
        continue;
      }
      candidatesChecked++;

      // NP-PERF-003: Use optimized cosine similarity with pre-normalized vectors
      const similarity = this.cosineSimilarity(normalizedEmbedding, vector);
      if (!Number.isFinite(similarity)) {
        continue;
      }
      if (similarity < threshold) {
        continue;
      }
      if (!best || similarity > best.similarity) {
        const rawId = (candidate as { _id: unknown })._id;
        const id = typeof rawId === "string" ? rawId : rawId?.toString?.();
        if (!id) {
          continue;
        }
        best = { id, similarity };

        // NP-PERF-003: Early termination for high-confidence matches
        if (similarity > HIGH_CONFIDENCE_THRESHOLD) {
          this.logger.debug(
            {
              similarity,
              candidatesChecked,
              totalCandidates: candidates.length,
            },
            "Early termination on high-confidence match",
          );
          break;
        }
      }
    }

    this.logger.debug(
      {
        duration: Date.now() - startTime,
        candidatesChecked,
        totalCandidates: candidates.length,
        foundMatch: !!best,
      },
      "Similarity search completed",
    );

    return best;
  }

  private resolveSummaryDedupThreshold(
    summaryLength: number,
    baseThreshold?: number,
  ) {
    const base =
      typeof baseThreshold === "number" && Number.isFinite(baseThreshold)
        ? baseThreshold
        : this.configService.config.pipeline.summaryDedupThreshold;
    if (summaryLength < 80) {
      return Math.min(0.96, base + 0.04);
    }
    if (summaryLength < 120) {
      return Math.min(0.94, base + 0.02);
    }
    if (summaryLength > 280) {
      return Math.max(0.86, base - 0.03);
    }
    if (summaryLength > 200) {
      return Math.max(0.88, base - 0.02);
    }
    return base;
  }

  private async isSelfProcessedItemRef(
    job: PipelineJobContext,
    ref?: string | null,
  ): Promise<boolean> {
    if (!ref || !Types.ObjectId.isValid(ref)) {
      return false;
    }
    const doc = await ProcessedItemModel.exists({
      _id: new Types.ObjectId(ref),
      orgId: job.orgId,
      itemMetaId: job.itemMetaId,
    });
    return Boolean(doc);
  }

  /**
   * Article rows are sharded by orgId: uniqueness of url/contentHash is per
   * org, so an upsert must never touch another org's row (previously a global
   * contentHash unique constraint let org B silently rewrite org A's article,
   * leaving ProcessedArticle.orgId != Article.orgId).
   */
  private async upsertOrgScopedArticle(
    tx: Prisma.TransactionClient,
    input: {
      orgId: string;
      sourceId: string | null | undefined;
      contentHash: string;
      persistedUrl: string;
      persistedMetadata: Record<string, unknown>;
      canonical: { fingerprint: string | null } | null;
      payload: NormalizedNewsPayload;
      cleaned: CleanedNews;
      crawlAt: Date;
    },
  ): Promise<{ id: string }> {
    const updateData: Prisma.ArticleUpdateManyMutationInput = {
      url: input.persistedUrl,
      urlFingerprint: input.canonical?.fingerprint ?? null,
      sourceLabel: input.payload.sourceName ?? null,
      language:
        input.cleaned.language ?? input.payload.language ?? null,
      titleGuess: input.cleaned.title ?? undefined,
      metadata: toPrismaJsonValue(input.persistedMetadata),
      crawlAt: input.crawlAt,
    };

    const existing = await tx.article.findFirst({
      where: {
        orgId: input.orgId,
        contentHash: input.contentHash,
      },
      select: { id: true },
    });
    if (existing) {
      await tx.article.update({
        where: { id: existing.id },
        data: updateData,
      });
      return existing;
    }

    try {
      return await tx.article.create({
        data: {
          orgId: input.orgId,
          sourceId: input.sourceId,
          url: input.persistedUrl,
          urlFingerprint: input.canonical?.fingerprint ?? null,
          sourceLabel: input.payload.sourceName ?? null,
          language:
            input.cleaned.language ?? input.payload.language ?? null,
          titleGuess: input.cleaned.title ?? undefined,
          crawlAt: input.crawlAt,
          contentHash: input.contentHash,
          metadata: toPrismaJsonValue(input.persistedMetadata),
        },
        select: { id: true },
      });
    } catch (error) {
      if (!this.isPrismaUniqueConstraintError(error)) {
        throw error;
      }
      // Concurrent write or the (orgId, url) uniqueness fired (e.g. the URL
      // was crawled by this org under a different content hash): resolve to
      // this org's row.
      const raced = await tx.article.findFirst({
        where: {
          orgId: input.orgId,
          OR: [
            { contentHash: input.contentHash },
            { url: input.persistedUrl },
          ],
        },
        select: { id: true },
      });
      if (!raced) {
        throw error;
      }
      await tx.article.update({
        where: { id: raced.id },
        data: updateData,
      });
      return raced;
    }
  }

  /**
   * Reverts a Duplicate mark applied by the dedupe stage when the subsequent
   * persist fails: leaving the item Duplicate would permanently exclude it
   * from lists and block every retry path (skipIfDuplicate guards).
   */
  private async revertDuplicateMarkOnPersistFailure(
    job: PipelineJobContext,
    duplicateOf?: string | null,
  ) {
    if (!duplicateOf) {
      return;
    }
    try {
      const reverted = await this.prisma.itemMeta.updateMany({
        where: { id: job.itemMetaId, status: ItemStatus.Duplicate },
        data: { status: ItemStatus.Pending },
      });
      if (reverted.count > 0) {
        this.logger.warn(
          { itemMetaId: job.itemMetaId, duplicateOf },
          "Reverted Duplicate mark after persist failure",
        );
      }
    } catch (error) {
      this.logger.warn(
        { error, itemMetaId: job.itemMetaId },
        "Failed to revert Duplicate mark after persist failure",
      );
    }
  }

  private async markItemMetaDuplicate(
    job: PipelineJobContext,
    duplicateOf: string,
    similarity: number,
  ) {
    try {
      await this.prisma.itemMeta.update({
        where: { id: job.itemMetaId },
        data: { status: ItemStatus.Duplicate },
      });
    } catch (error) {
      this.logger.warn(
        { error, duplicateOf, similarity, itemMetaId: job.itemMetaId },
        "Failed to mark item meta as duplicate",
      );
    }
  }

  /**
   * NP-PERF-003: Normalize vector to unit length for faster dot product comparison.
   * Dot product of normalized vectors equals cosine similarity.
   */
  private normalizeVector(v: number[]): number[] {
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    if (norm === 0) {
      return v;
    }
    return v.map((x) => x / norm);
  }

  private cosineSimilarity(a: number[], b: number[]) {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const ai = a[i];
      const bi = b[i];
      if (
        ai === undefined ||
        bi === undefined ||
        !Number.isFinite(ai) ||
        !Number.isFinite(bi)
      ) {
        return 0;
      }
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async findProcessedArticle(contentHash: string, orgId?: string) {
    return this.prisma.processedArticle.findFirst({
      where: {
        article: {
          contentHash,
          // Content cache hits must stay within the org: without the filter
          // an org B run would hit org A's article and either cross-tenant
          // duplicate-mark or read foreign metadata.
          ...(orgId ? { orgId } : {}),
        },
      },
      include: { article: true },
    });
  }

  private isPrismaUniqueConstraintError(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "P2002",
    );
  }

  private async resolveCleanedNews(
    processed: ProcessedArticle & { article: Article },
  ): Promise<CleanedNews | null> {
    const cleanedFromRef = await this.loadCleanedNewsFromRef(
      processed.cleanedMarkdownRef,
    );
    if (cleanedFromRef) {
      return this.withPromptMetadata(
        cleanedFromRef,
        processed.llmPromptVersion ?? null,
        processed.llmModel ?? null,
      );
    }

    try {
      return this.mapProcessedArticleToCleanedNews(processed);
    } catch (error) {
      this.logger.error(
        { error, processedArticleId: processed.id },
        "Failed to map processed article to cleaned news",
      );
      throw error;
    }
  }

  private async loadCleanedNewsFromRef(ref?: string | null) {
    if (!ref) {
      return null;
    }
    try {
      const query = ProcessedItemModel.findById(ref);
      if (!query) {
        return null;
      }
      const doc =
        query && typeof (query as { lean?: () => unknown }).lean === "function"
          ? await (query as { lean: () => unknown }).lean()
          : await query;
      const result = (doc as { result?: unknown } | null | undefined)?.result;
      if (!result) {
        return null;
      }
      return CleanedNewsSchema.parse(result);
    } catch (error) {
      this.logger.warn({ error, ref }, "Failed to load cleaned news by ref");
      return null;
    }
  }

  private mapProcessedArticleToCleanedNews(
    processed: ProcessedArticle & { article: Article },
  ): CleanedNews {
    const topics = this.toStringArray(processed.topics);
    const keyPoints = this.toStringArray(processed.keyPoints);
    const removedNoiseTypes = this.toStringArray(processed.removedNoiseTypes);
    const entities = this.normalizeEntities(processed.entities);
    const kgRelations = this.normalizeKgRelations(processed.kgRelations);
    let cleanedMarkdown = "";
    if (processed.title) {
      cleanedMarkdown = `# ${processed.title}\n\n`;
    }
    if (processed.summary) {
      cleanedMarkdown = `${cleanedMarkdown}${processed.summary}`;
    }
    cleanedMarkdown =
      cleanedMarkdown.trim() ||
      processed.article.url ||
      processed.article.contentHash;

    return CleanedNewsSchema.parse({
      title: processed.title ?? null,
      subtitle: processed.subtitle ?? null,
      author: processed.author ?? null,
      source: processed.source ?? processed.article.sourceLabel ?? null,
      published_at: processed.publishedAt
        ? processed.publishedAt.toISOString()
        : null,
      language: processed.language ?? processed.article.language ?? null,
      location: processed.location ?? null,
      category: processed.category ?? null,
      topics,
      summary: processed.summary ?? null,
      key_points: keyPoints,
      entities,
      kg_relations: kgRelations,
      cleaned_markdown: cleanedMarkdown,
      removed_noise_types: removedNoiseTypes,
      quality_score: processed.qualityScore ?? null,
      llm_model: processed.llmModel ?? null,
      llm_prompt_version: processed.llmPromptVersion ?? null,
    });
  }

  private buildLlmMetadataFromProcessed(
    processed: ProcessedArticle,
  ): LlmCallMetadata {
    return {
      model: processed.llmModel ?? null,
      promptVersion: processed.llmPromptVersion ?? null,
      promptTokens: processed.promptTokens ?? null,
      completionTokens: processed.completionTokens ?? null,
      totalTokens: processed.totalTokens ?? null,
      costUsd: processed.costUsd ?? null,
      latencyMs: processed.latencyMs ?? null,
    };
  }

  private parseResponse(
    response: Awaited<ReturnType<LiteLlmService["acompletion"]>>,
    options?: { fallbackCleanedMarkdown?: string },
  ): CleanedNews {
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LiteLLM returned empty content");
    }
    let parsed: unknown;
    const jsonText = extractFirstJson(content);
    if (!jsonText) {
      throw new Error("LiteLLM return was not valid JSON");
    }
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      this.logger.error({ error }, "Failed to parse LiteLLM JSON output");
      throw new Error("LiteLLM return was not valid JSON");
    }
    if (options?.fallbackCleanedMarkdown) {
      parsed = this.applyCleanedMarkdownFallback(
        parsed,
        options.fallbackCleanedMarkdown,
      );
    }
    return CleanedNewsSchema.parse(parsed);
  }

  private applyCleanedMarkdownFallback(parsed: unknown, fallback: string) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return parsed;
    }

    const record = parsed as Record<string, unknown>;
    const contentTypeAlias =
      typeof record.contentType === "string"
        ? record.contentType
        : typeof record.content_type === "string"
          ? record.content_type
          : undefined;
    if (contentTypeAlias) {
      record.content_type = contentTypeAlias;
    }
    const candidate =
      typeof record.cleaned_markdown === "string"
        ? record.cleaned_markdown
        : typeof record.cleanedMarkdown === "string"
          ? record.cleanedMarkdown
          : undefined;

    if (typeof candidate === "string" && candidate.trim().length > 0) {
      record.cleaned_markdown = candidate;
      return record;
    }

    if (fallback.trim().length > 0) {
      record.cleaned_markdown = fallback;
      record.cleaned_markdown_source = "crawl_fallback";
    }

    return record;
  }

  private withPromptMetadata(
    cleaned: CleanedNews,
    promptVersion: string | null,
    model?: string | null,
  ): CleanedNews {
    return {
      ...cleaned,
      llm_model: cleaned.llm_model ?? model ?? null,
      llm_prompt_version: cleaned.llm_prompt_version ?? promptVersion ?? null,
    };
  }

  private withResolvedContentType(
    cleaned: CleanedNews,
    context: {
      payload: NormalizedNewsPayload;
      article?: CrawledArticle;
    },
  ): CleanedNews {
    const normalized = normalizeNewsContentType(cleaned.content_type);
    const resolved =
      normalized ??
      inferNewsContentType({
        title: cleaned.title,
        summary: cleaned.summary,
        source: cleaned.source ?? context.payload.sourceName,
        url: context.article?.sourceUrl ?? context.payload.url,
        topics: cleaned.topics,
        tags: context.payload.tags,
      });
    return {
      ...cleaned,
      content_type: resolved,
    };
  }

  private resolveStoredContentTypeForBackfill(
    cleaned: CleanedNews,
    sourceUrl: string | null,
    sourceLabel: string | null,
  ): CleanedNews {
    const normalized = normalizeNewsContentType(cleaned.content_type);
    const resolved =
      normalized ??
      inferNewsContentType({
        title: cleaned.title,
        summary: cleaned.summary,
        source: cleaned.source ?? sourceLabel,
        url: sourceUrl,
        topics: cleaned.topics,
        tags: [],
      });
    return {
      ...cleaned,
      content_type: resolved,
    };
  }

  private parseStoredCleanedNewsResult(value: unknown): CleanedNews | null {
    const parsed = CleanedNewsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private normalizeStoredCategoryPath(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeStoredCategoryMethod(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async createOutboxEntry(options: {
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
  }) {
    try {
      const outboxEntry = await this.prisma.runInTransaction(async (tx) => {
        const payloadSourceId = this.extractSourceId(options.normalizedPayload);
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
        this.parseDate(options.article.publishedAt) ??
        this.parseDate(options.article.fetchedAt) ??
        new Date();

      const sourceUrl = options.article.sourceUrl?.trim() ?? "";
      const queryParamAllowlist = this.extractUrlQueryParamAllowlist(
        options.payload,
      );
      const canonical = buildCanonicalUrlFingerprint(
        sourceUrl,
        queryParamAllowlist,
      );
      const persistedUrl = this.toArticleUrl(
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

      const articleRecord = await this.upsertOrgScopedArticle(tx, {
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
        this.parseDate(options.cleaned.published_at) ??
        this.parseDate(options.article.publishedAt);
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

  private extractUrlQueryParamAllowlist(
    payload: NormalizedNewsPayload,
  ): string[] {
    const metadata =
      payload.metadata &&
      typeof payload.metadata === "object" &&
      !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : {};
    return resolveQueryParamAllowlist(
      metadata.urlQueryParamAllowlist,
      undefined,
    );
  }

  private extractSeedDedupeWindowHours(
    payload: NormalizedNewsPayload,
  ): number | undefined {
    const metadata =
      payload.metadata &&
      typeof payload.metadata === "object" &&
      !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : {};
    const seed =
      metadata.newsSourceSeed &&
      typeof metadata.newsSourceSeed === "object" &&
      !Array.isArray(metadata.newsSourceSeed)
        ? (metadata.newsSourceSeed as Record<string, unknown>)
        : null;
    const raw = seed?.dedupeWindowHours;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return undefined;
    }
    return Math.max(0, Math.min(24 * 30, Math.round(raw)));
  }

  private extractSourceId(payload: NormalizedNewsPayload) {
    const raw = payload?.metadata
      ? (payload.metadata as Record<string, unknown>)
      : undefined;
    const sourceId =
      raw && typeof raw.sourceId === "string" ? raw.sourceId.trim() : "";
    if (sourceId.length > 0) {
      return sourceId;
    }

    const newsnowSourceId =
      raw &&
      raw.newsnow &&
      typeof raw.newsnow === "object" &&
      !Array.isArray(raw.newsnow) &&
      typeof (raw.newsnow as { sourceId?: unknown }).sourceId === "string"
        ? (raw.newsnow as { sourceId: string }).sourceId.trim()
        : "";

    return newsnowSourceId.length > 0 ? newsnowSourceId : undefined;
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

  private buildProcessedItemOutboxPayload(options: {
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
        tags: this.buildTags(options.payload, options.cleaned),
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

  private buildPendingProcessedItem(
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
      let publishedAt = this.parseDate(
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
        publishedAt = this.parseDate(
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
        ? this.toItemMetaName(cleanedTitleRaw)
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

    const nextDelay = this.computeBackoffDelay(
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
      const duplicateRef = this.normalizeProcessedItemRef(document.duplicateOf);
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
      if (this.isDuplicateKeyError(error)) {
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

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryPendingOutbox() {
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

  private buildTags(payload: NormalizedNewsPayload, cleaned: CleanedNews) {
    const derived = new Set<string>();
    payload.tags.forEach((tag) => derived.add(tag));
    const topics = Array.isArray(cleaned.topics) ? cleaned.topics : [];
    topics.forEach((topic) => derived.add(topic.toLowerCase()));
    return Array.from(derived).slice(0, 20);
  }

  private normalizePayload(
    payload: Record<string, unknown>,
  ): NormalizedNewsPayload {
    return NormalizedNewsPayloadSchema.parse(payload);
  }

  private parseDate(value?: string | Date | null) {
    return parseDateTime(value);
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (typeof entry === "number") {
          return entry.toString();
        }
        return null;
      })
      .filter((entry): entry is string => Boolean(entry && entry.trim()))
      .map((entry) => entry.trim());
  }

  private normalizeEntities(value: unknown): CleanedNews["entities"] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const { name, type, confidence } = entry as {
          name?: unknown;
          type?: unknown;
          confidence?: unknown;
        };
        if (typeof name !== "string" || typeof type !== "string") {
          return null;
        }
        const numericConfidence =
          typeof confidence === "number" && Number.isFinite(confidence)
            ? Math.min(1, Math.max(0, confidence))
            : 0;
        return { name, type, confidence: numericConfidence };
      })
      .filter((entity): entity is CleanedNews["entities"][number] =>
        Boolean(entity),
      );
  }

  private normalizeKgRelations(value: unknown): CleanedNews["kg_relations"] {
    const parsed = CleanedNewsSchema.shape.kg_relations.safeParse(value);
    return parsed.success ? parsed.data : [];
  }

  private normalizeProcessedItemRef(ref?: string | null) {
    if (!ref) {
      return null;
    }
    return Types.ObjectId.isValid(ref) ? ref : null;
  }

  private hashContent(content: string) {
    return createHash("sha256").update(content).digest("hex");
  }

  private toItemMetaName(value: string) {
    const trimmed = value.trim();
    if (trimmed.length <= 191) {
      return trimmed;
    }
    return `${trimmed.slice(0, 190).trimEnd()}…`;
  }

  private toArticleUrl(value: string) {
    const trimmed = value.trim();
    if (trimmed.length <= 512) {
      return trimmed;
    }
    return trimmed.slice(0, 512);
  }

  private isDuplicateKeyError(error: unknown) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: number }).code === 11000,
    );
  }

  private computeBackoffDelay(
    baseDelayMs: number,
    attempt: number,
    maxAttempts: number,
  ) {
    const exponentialDelay =
      baseDelayMs * 2 ** Math.max(Math.min(attempt, maxAttempts) - 1, 0);
    const jitterFactor = 0.5 + Math.random(); // add jitter to avoid synchronized retries
    return Math.round(exponentialDelay * jitterFactor);
  }

  private async runStage<T>(
    job: PipelineJobContext,
    stage: string,
    action: () => Promise<T>,
    options?: {
      onErrorData?: () => Record<string, unknown>;
    },
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      await this.logStageFailure(
        job,
        stage,
        options?.onErrorData ? options.onErrorData() : undefined,
        error,
      );
      throw error;
    }
  }

  private async logStageFailure(
    job: PipelineJobContext,
    stage: string,
    data?: Record<string, unknown>,
    error?: unknown,
  ) {
    const errorDetails = error
      ? {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        }
      : undefined;

    await writeTaskLogBestEffort({
      queue: job.queue,
      jobId: job.jobId,
      orgId: job.orgId,
      stage,
      status: "failed",
      data,
      error: errorDetails,
    });
  }
}
