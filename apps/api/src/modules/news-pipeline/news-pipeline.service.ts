import {
  CrawlResultContentModel,
  ProcessedItemModel,
  RawItemModel,
  TaskLogModel,
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
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import { extractFirstJson, safeJsonParseFromText } from "../../common/llm-json";
import { ItemStatus } from "../../common/pipeline-status";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { Crawl4aiClient } from "../crawl/crawl4ai.client";
import { VectorClientService } from "../vector/vector-client.service";

import { LiteLlmService } from "./litellm.service";
import {
  buildNewsDedupeSystemPrompt,
  buildNewsDedupeUserPrompt,
  NEWS_DEDUPE_RESPONSE_FORMAT,
  NewsDedupeJudgeSchema,
} from "./news-dedupe-llm";
import { NewsDedupeSettingsService } from "./news-dedupe-settings.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import {
  Crawl4aiResponseSchema,
  ParsedCrawl4aiArticle,
  ParsedCrawl4aiResponse,
} from "./news-pipeline.crawl.schema";
import {
  CleanedNewsSchema,
  CleanedNews,
  NormalizedNewsPayload,
  NormalizedNewsPayloadSchema,
} from "./news-pipeline.schema";
import {
  CrawlCacheEntry,
  PipelineJobContext,
  RawPipelineItem,
} from "./news-pipeline.types";
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

interface SummaryDedupeResult {
  summaryEmbedding?: number[] | null;
  summaryEmbeddingModel?: string | null;
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
  thresholdUsed?: number | null;
}

interface ProcessedItemOutboxPayload {
  type: typeof MongoOutboxType.processed_item;
  document: {
    _id: string;
    rawItemId: string;
    itemMetaId: string;
    orgId: string;
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

const OptionalNumberArraySchema = z.preprocess(
  (value) => (Array.isArray(value) ? value : undefined),
  z.array(z.number().finite()),
).optional();

const LlmCallMetadataSchema: z.ZodType<LlmCallMetadata, z.ZodTypeDef, unknown> = z.object({
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

interface CrawledArticle {
  sourceUrl: string;
  markdown: string;
  markdownWithCitations?: string;
  referencesMarkdown?: string;
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
const MAX_LLM_DEDUPE_COMPARISONS = 12;
const MAX_LLM_DEDUPE_CANDIDATE_CHARS = 1_200;

@Injectable()
export class NewsPipelineService implements OnModuleDestroy {
  private readonly logger = createLogger({ name: "news-pipeline" });
  private readonly crawlCachePrefix = "news:crawl:";
  private readonly outboxRetryBaseDelayMs = 30_000;
  private readonly outboxStaleLockMs = 5 * 60_000;
  private readonly outboxBatchSize = 10;
  private readonly outboxEventEmitter = new EventEmitter();
  private outboxDeliveryQueue = new Map<string, ProcessedItemOutboxPayload | null>();
  private outboxDeliveryScheduled = false;
  private outboxDeliveryInFlight = false;
  private readonly outboxRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly crawlClient: Crawl4aiClient,
    private readonly liteLlm: LiteLlmService,
    private readonly configService: NewsPipelineConfigService,
    private readonly promptBuilder: NewsPromptBuilder,
    private readonly promptConfig: NewsPromptConfigService,
    private readonly dedupeSettings: NewsDedupeSettingsService,
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
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
        onProcessingData: () => ({
          rawItemId: raw.id,
        }),
        onSuccessData: (normalized) => ({
          url: normalized.url,
          forceRefresh: normalized.forceRefresh,
        }),
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
        onProcessingData: () => ({
          url: payload.url,
          forceRefresh: payload.forceRefresh,
        }),
        onSuccessData: (fetched) => ({
          url: fetched.sourceUrl,
          fromCache: fetched.fromCache,
          runId: fetched.runId,
        }),
        onErrorData: () => ({
          url: payload.url,
        }),
      },
    );

    const {
      cleaned,
      llm,
      contentHash,
      processedArticleId,
      contentDuplicateOf,
    } = await this.runStage(
      job,
      "llm",
      async () => this.cleanArticle(payload, article, job),
      {
        onProcessingData: () => ({
          url: payload.url,
          runId: article.runId,
        }),
        onSuccessData: ({ llm }) => ({
          model: llm.model,
          totalTokens: llm.totalTokens,
          costUsd: llm.costUsd,
          latencyMs: llm.latencyMs,
        }),
        onErrorData: () => ({
          url: payload.url,
          runId: article.runId,
        }),
      },
    );

    const dedupe = await this.runStage(
      job,
      "dedupe",
      async () =>
        this.evaluateSummaryDedupe({
          job,
          cleaned,
          contentDuplicateOf,
        }),
      {
        onProcessingData: () => ({
          itemMetaId: job.itemMetaId,
          summaryLength: cleaned.summary?.length ?? 0,
        }),
        onSuccessData: (result) => ({
          duplicateOf: result.duplicateOf ?? undefined,
          similarity: result.duplicateSimilarity ?? undefined,
          embeddingModel: result.summaryEmbeddingModel ?? undefined,
          threshold: result.thresholdUsed ?? undefined,
        }),
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
          llm,
          contentHash,
          processedArticleId,
          processedItemId: job.processedItemId,
          summaryEmbedding: dedupe.summaryEmbedding ?? undefined,
          summaryEmbeddingModel: dedupe.summaryEmbeddingModel ?? undefined,
          duplicateOf: dedupe.duplicateOf ?? undefined,
          duplicateSimilarity: dedupe.duplicateSimilarity ?? undefined,
        }),
      {
        onProcessingData: () => ({
          rawItemId: raw.id,
          itemMetaId: job.itemMetaId,
        }),
        onSuccessData: (result) => ({
          processedId: result.processedItem._id.toString(),
          outboxId: result.outboxId,
        }),
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

  private async persistProcessedResult(options: {
    job: PipelineJobContext;
    raw: RawPipelineItem;
    payload: NormalizedNewsPayload;
    article: CrawledArticle & { fromCache: boolean };
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    contentHash: string;
    processedArticleId?: string | null;
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
    const crawlPublishedAt = this.parseDate(options.article.publishedAt)?.toISOString() ?? null;
    const cleaned: CleanedNews = {
      ...options.cleaned,
      published_at: options.cleaned.published_at ?? crawlPublishedAt
    };
    const outboxPayload = this.buildProcessedItemOutboxPayload({
      processedItemId,
      raw: options.raw,
      orgId: options.job.orgId,
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
    payload: NormalizedNewsPayload
  ): Promise<CrawledArticle & { fromCache: boolean }> {
    const crawlResultId = this.extractCrawlResultId(payload);
    if (crawlResultId) {
      try {
        const stored = await this.fetchStoredCrawlResult(job.orgId, crawlResultId);
        return {
          ...stored,
          fromCache: true,
        };
      } catch (error) {
        this.logger.warn(
          { error, orgId: job.orgId, crawlResultId, url: payload.url },
          "Failed to load stored crawl result; falling back to crawl4ai",
        );
      }
    }

    const cacheKey = this.cacheKey(job.orgId, payload.url);
    if (payload.forceRefresh) {
      await this.cache.del(cacheKey);
    } else {
      const cached = await this.cache.get<CrawlCacheEntry>(cacheKey);
      if (cached?.markdown) {
        const cachedWithHash = {
          ...cached,
          contentHash: cached.contentHash ?? this.hashContent(cached.markdown),
        };
        const metadata =
          cachedWithHash.metadata &&
          typeof cachedWithHash.metadata === "object" &&
          !Array.isArray(cachedWithHash.metadata)
            ? (cachedWithHash.metadata as Record<string, unknown>)
            : {};
        return {
          sourceUrl: payload.url,
          markdown: cachedWithHash.markdown,
          markdownWithCitations: cachedWithHash.markdownWithCitations ?? undefined,
          referencesMarkdown: cachedWithHash.referencesMarkdown ?? undefined,
          metadata,
          publishedAt: cachedWithHash.publishedAt ?? null,
          runId: cachedWithHash.runId ?? null,
          fetchedAt: cachedWithHash.fetchedAt ?? new Date().toISOString(),
          contentHash: cachedWithHash.contentHash,
          fromCache: true,
        };
      }
    }

    let executedCrawl = false;
    const normalized = await this.cache.wrap(
      cacheKey,
      this.configService.config.pipeline.cacheTtlSeconds,
      async () => {
        executedCrawl = true;
        const crawlResponse = await this.executeCrawl(payload);
        const article = this.pickSuccessfulArticle(crawlResponse.results);
        return this.normalizeArticle(
          article,
          payload.url,
          crawlResponse.runId ?? null,
        );
      },
      {
        lockTtlMs: this.getCrawlLockTtlMs(),
        retryDelayMs: 100,
        maxWaitMs: this.getCrawlLockTtlMs(),
      },
    );
    const normalizedWithHash = {
      ...normalized,
      contentHash: normalized.contentHash ?? this.hashContent(normalized.markdown),
    };
    return {
      ...normalizedWithHash,
      fromCache: !executedCrawl,
    };
  }

  private extractCrawlResultId(payload: NormalizedNewsPayload): string | null {
    const metadata =
      payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : null;
    const raw = metadata && typeof metadata.crawlResultId === "string" ? metadata.crawlResultId : "";
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async fetchStoredCrawlResult(orgId: string, crawlResultId: string): Promise<CrawledArticle> {
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
      typeof crawlResult.markdownRef === "string" ? crawlResult.markdownRef.trim() : "";
    if (!markdownRef) {
      throw new Error("crawl result content reference missing");
    }

    const doc = await CrawlResultContentModel.findById(markdownRef).lean();
    if (!doc) {
      throw new Error("crawl result content not found");
    }

    const markdown = typeof (doc as { markdown?: unknown }).markdown === "string" ? (doc as { markdown: string }).markdown : "";
    if (!markdown) {
      throw new Error("crawl result markdown missing");
    }

    const mysqlMetadata =
      crawlResult.metadata && typeof crawlResult.metadata === "object" && !Array.isArray(crawlResult.metadata)
        ? (crawlResult.metadata as Record<string, unknown>)
        : {};
    const mongoMetadata =
      doc && typeof (doc as { metadata?: unknown }).metadata === "object" && !Array.isArray((doc as { metadata?: unknown }).metadata)
        ? ((doc as { metadata: Record<string, unknown> }).metadata ?? {})
        : {};

    const metadata: Record<string, unknown> = {
      ...mongoMetadata,
      ...mysqlMetadata,
      crawlResultId: crawlResult.id,
    };

    const contentHash =
      typeof crawlResult.contentHash === "string" && crawlResult.contentHash.length > 0
        ? crawlResult.contentHash
        : this.hashContent(markdown);

    const markdownWithCitationsRaw = (doc as { markdownWithCitations?: unknown }).markdownWithCitations;
    const markdownWithCitations =
      typeof markdownWithCitationsRaw === "string" ? markdownWithCitationsRaw : undefined;

    const referencesMarkdownRaw = (doc as { referencesMarkdown?: unknown }).referencesMarkdown;
    const referencesMarkdown =
      typeof referencesMarkdownRaw === "string" ? referencesMarkdownRaw : undefined;

    const crawlRunId =
      typeof (doc as { crawlRunId?: unknown }).crawlRunId === "string"
        ? ((doc as { crawlRunId?: string }).crawlRunId ?? null)
        : null;

    const fetchedAt = crawlResult.fetchedAt ? crawlResult.fetchedAt.toISOString() : new Date().toISOString();

    return {
      sourceUrl: crawlResult.sourceUrl,
      markdown,
      markdownWithCitations,
      referencesMarkdown,
      metadata,
      publishedAt: fetchedAt,
      runId: crawlRunId,
      fetchedAt,
      contentHash,
    };
  }

  private async executeCrawl(payload: NormalizedNewsPayload): Promise<ParsedCrawl4aiResponse> {
    const cfg = this.configService.config.crawl4ai;
    const options = {
      ...cfg.crawlerDefaults,
      cleanMarkdown: cfg.cleanMarkdown ?? cfg.crawlerDefaults.cleanMarkdown,
      markdownOptions: cfg.markdown ?? cfg.crawlerDefaults.markdownOptions,
      ...payload.crawlOptions,
      userAgent: payload.crawlOptions?.userAgent ?? cfg.crawlerDefaults.userAgent ?? cfg.userAgent,
    };
    const request = {
      url: payload.url,
      keywords: payload.keywords.length > 0 ? payload.keywords : undefined,
      options,
    };
    const response = await this.retry(
      async () => this.crawlClient.crawl(request),
      3,
      2_000,
    );
    return Crawl4aiResponseSchema.parse(response);
  }

  private pickSuccessfulArticle(results: ParsedCrawl4aiArticle[]) {
    const article = results.find((result) => result.success !== false);
    if (!article) {
      throw new Error("crawl4ai returned no successful article");
    }
    return article;
  }

  private normalizeArticle(
    article: ParsedCrawl4aiArticle,
    url: string,
    runId?: string | null,
  ): CrawledArticle {
    const markdown = this.extractMarkdown(article);
    if (!markdown) {
      throw new Error("Crawl result missing markdown");
    }
    const contentHash = this.hashContent(markdown);
    const markdownRecord =
      typeof article.markdown === "string" || !article.markdown ? null : article.markdown;

    const markdownWithCitations =
      typeof markdownRecord?.markdown_with_citations === "string"
        ? markdownRecord.markdown_with_citations
        : typeof markdownRecord?.markdownWithCitations === "string"
          ? markdownRecord.markdownWithCitations
          : undefined;

    const referencesMarkdown =
      typeof markdownRecord?.references_markdown === "string"
        ? markdownRecord.references_markdown
        : typeof markdownRecord?.referencesMarkdown === "string"
          ? markdownRecord.referencesMarkdown
          : undefined;

    const metadata =
      article.metadata && typeof article.metadata === "object" && !Array.isArray(article.metadata)
        ? (article.metadata as Record<string, unknown>)
        : {};

    return {
      sourceUrl: article.url ?? url,
      markdown,
      markdownWithCitations,
      referencesMarkdown,
      metadata,
      publishedAt: article.publishedAt ?? null,
      runId: article.success === false ? null : (runId ?? null),
      fetchedAt: new Date().toISOString(),
      contentHash,
    };
  }

  private extractMarkdown(article: ParsedCrawl4aiArticle) {
    if (!article) {
      return "";
    }
    if (typeof article.markdown === "string") {
      return article.markdown;
    }
    if (article.markdown) {
      const record = article.markdown;
      return (
        record.fit_markdown ??
        record.fitMarkdown ??
        record.raw_markdown ??
        record.rawMarkdown ??
        record.markdown ??
        record.text ??
        ""
      );
    }
    return article.text ?? "";
  }

  private async cleanArticle(
    payload: NormalizedNewsPayload,
    article: CrawledArticle & { fromCache: boolean },
    job: PipelineJobContext,
  ): Promise<{
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    contentHash: string;
    processedArticleId?: string | null;
    contentDuplicateOf?: string | null;
  }> {
    const contentHash = article.contentHash ?? this.hashContent(article.markdown);
    const existing = await this.findProcessedArticle(contentHash);
    if (existing) {
      const cleanedFromExisting = await this.resolveCleanedNews(existing);
      if (cleanedFromExisting) {
        const contentDuplicateOf = this.normalizeProcessedItemRef(
          existing.cleanedMarkdownRef,
        );
        return {
          cleaned: cleanedFromExisting,
          llm: this.buildLlmMetadataFromProcessed(existing),
          contentHash,
          processedArticleId: existing.id,
          contentDuplicateOf,
        };
      }
    }

    const pipelineCfg = this.configService.config.pipeline;
    const truncated = article.markdown.slice(0, pipelineCfg.maxInputChars);
    const promptConfig = await this.promptConfig.getConfig();
    const completionTimeoutMs = Math.max(
      await this.liteLlm.getCompletionTimeoutMs(),
      180_000
    );
    const response = await this.liteLlm.acompletion({
      messages: [
        {
          role: "system",
          content: this.promptBuilder.buildSystemPrompt(
            promptConfig,
            payload.language,
          ),
        },
        {
          role: "user",
          content: this.promptBuilder.buildDenoisePrompt(promptConfig),
        },
        {
          role: "user",
          content: this.promptBuilder.buildUserPrompt(promptConfig, {
            url: article.sourceUrl,
            markdown: truncated,
            metadata: {
              ...payload.metadata,
              publishedAt: article.publishedAt,
              sourceName: payload.sourceName,
            },
            keywords: payload.keywords,
            summaryHints: payload.summaryHints,
            language: payload.language,
            cacheHit: article.fromCache,
          }),
        },
      ],
      response_format: this.promptBuilder.buildResponseFormat(),
      metadata: {
        jobId: job.jobId,
        source: "news-pipeline",
      },
      timeoutMs: completionTimeoutMs,
    });

    const cleaned = this.withPromptMetadata(
      this.parseResponse(response, { fallbackCleanedMarkdown: truncated }),
      promptConfig.version,
      response.model,
    );
    const llm: LlmCallMetadata = {
      model: response.model,
      promptVersion: promptConfig.version,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      costUsd: response.costUsd ?? null,
      latencyMs: response.latencyMs ?? null,
    };
    return { cleaned, llm, contentHash };
  }

  private async evaluateSummaryDedupe(options: {
    job: PipelineJobContext;
    cleaned: CleanedNews;
    contentDuplicateOf?: string | null;
  }): Promise<SummaryDedupeResult> {
    const cfg = this.configService.config.pipeline;
    if (options.contentDuplicateOf) {
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

    if (!cfg.summaryDedupEnabled) {
      return {};
    }

    const summary = options.cleaned.summary?.trim();
    if (!summary || summary.length < cfg.summaryDedupMinChars) {
      return {};
    }

    const settings = await this.dedupeSettings.getSettings(options.job.orgId);
    const thresholdBase = this.dedupeSettings.resolveBaseThreshold(settings, {
      category: options.cleaned.category,
      topics: options.cleaned.topics,
    }).threshold;
    const threshold = this.resolveSummaryDedupThreshold(summary.length, thresholdBase);
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
        llmJudgeMaxComparisons: settings.llmJudgeMaxComparisons,
        llmJudgeCandidateChars: settings.llmJudgeCandidateChars,
        llmJudgePromptVersion: settings.llmJudgePromptVersion,
        llmJudgeSystemPromptTemplate: settings.llmJudgeSystemPromptTemplate,
        llmJudgeUserPromptTemplate: settings.llmJudgeUserPromptTemplate,
      });
      if (!duplicate) {
        return baseResult;
      }

      await this.markItemMetaDuplicate(options.job, duplicate.id, duplicate.similarity);
      return {
        ...baseResult,
        duplicateOf: duplicate.id,
        duplicateSimilarity: duplicate.similarity,
      };
    }

    const embeddingData = await this.buildSummaryEmbedding(summary, options.job);
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
      typeof options.llmJudgeMaxComparisons === "number" && Number.isFinite(options.llmJudgeMaxComparisons)
        ? Math.max(1, Math.round(options.llmJudgeMaxComparisons))
        : MAX_LLM_DEDUPE_COMPARISONS;
    const candidateChars =
      typeof options.llmJudgeCandidateChars === "number" && Number.isFinite(options.llmJudgeCandidateChars)
        ? Math.max(1, Math.round(options.llmJudgeCandidateChars))
        : MAX_LLM_DEDUPE_CANDIDATE_CHARS;

    const candidates = await ProcessedItemModel.find({
      orgId: options.orgId,
      status: "completed",
      duplicateOf: null,
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
            ? this.quickSimilarity(normalizedQuery, this.normalizeForQuickSimilarity(summary))
            : 0;
        const id = (candidate as { _id?: unknown })._id?.toString?.() ?? "";
        return { id, summary, title, quick };
      })
      .filter((entry) => entry.id && entry.summary)
      .sort((a, b) => b.quick - a.quick)
      .slice(0, Math.min(cfg.summaryDedupMaxCandidates, maxComparisons * 3));

    const queryText = options.summary.slice(0, candidateChars);
    let best: { id: string; similarity: number } | null = null;
    for (const candidate of ranked.slice(0, maxComparisons)) {
      const candidateText = candidate.summary!.slice(0, candidateChars);
      if (this.normalizeForQuickSimilarity(candidateText) === normalizedQuery) {
        return { id: candidate.id, similarity: 1 };
      }

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
      if (!score || !score.isDuplicate) {
        continue;
      }

      if (!best || score.similarity > best.similarity) {
        best = { id: candidate.id, similarity: score.similarity };
      }

      if (score.similarity >= 0.98) {
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
      const isDuplicate = parsed.data.is_duplicate || similarity >= options.threshold;
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
    return typeof summary === "string" && summary.trim() ? summary.trim() : null;
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
    const n = Math.min(3, Math.max(2, Math.min(a.length, b.length) >= 64 ? 3 : 2));
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
        if (matches.length === 0 && !(await vectorClient.fallbackToMongoEnabled())) {
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
                createdAt: { $gte: cutoff },
              },
              { _id: 1 },
            ).lean();
            const allowedSet = new Set(
              allowed
                .map((doc) => (doc as { _id?: unknown })._id)
                .map((id) => (typeof id === "string" ? id : id?.toString?.() ?? ""))
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
            { similarity, candidatesChecked, totalCandidates: candidates.length },
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

  private resolveSummaryDedupThreshold(summaryLength: number, baseThreshold?: number) {
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
      if (ai === undefined || bi === undefined || !Number.isFinite(ai) || !Number.isFinite(bi)) {
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

  private async findProcessedArticle(contentHash: string) {
    return this.prisma.processedArticle.findFirst({
      where: { article: { contentHash } },
      include: { article: true },
    });
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
    const cleanedMarkdown =
      (processed.cleanedMarkdownRef && processed.cleanedMarkdownRef.length > 0
        ? processed.cleanedMarkdownRef
        : null) ??
      processed.summary ??
      processed.article.url ??
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
      cleaned_markdown: cleanedMarkdown,
      removed_noise_types: removedNoiseTypes,
      quality_score: processed.qualityScore ?? null,
      llm_model: processed.llmModel ?? null,
      llm_prompt_version: processed.llmPromptVersion ?? null,
    });
  }

  private buildLlmMetadataFromProcessed(processed: ProcessedArticle): LlmCallMetadata {
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
      parsed = this.applyCleanedMarkdownFallback(parsed, options.fallbackCleanedMarkdown);
    }
    return CleanedNewsSchema.parse(parsed);
  }

  private applyCleanedMarkdownFallback(parsed: unknown, fallback: string) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return parsed;
    }

    const record = parsed as Record<string, unknown>;
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

  private async createOutboxEntry(options: {
    orgId: string;
    payload: ProcessedItemOutboxPayload;
    processedItemId: string;
    contentHash: string;
    article: CrawledArticle;
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
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
            ? await this.resolveSourceIdForOrg(tx, options.orgId, payloadSourceId)
            : undefined);
        const resolvedPipelineJobId =
          typeof options.pipelineJobId === "string" && options.pipelineJobId.length > 0
            ? options.pipelineJobId
            : undefined;

        if (!options.processedArticleId) {
          await this.upsertArticleAndProcessed(tx, {
            orgId: options.orgId,
            contentHash: options.contentHash,
            article: options.article,
            cleaned: options.cleaned,
            llm: options.llm,
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
        const concurrency = this.configService.config.pipeline.outboxDeliveryConcurrency ?? 10;
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
          { duration: Date.now() - startTime, total: totalProcessed, succeeded, failed },
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

    const entry = await this.prisma.mongoOutbox.findUnique({ where: { id: outboxId } });
    if (!entry) {
      return;
    }

    const parsed = this.parseOutboxPayload(entry.payload);
    if (!parsed) {
      await this.markOutboxFailure(
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

      const articleRecord = await tx.article.upsert({
        where: { contentHash: options.contentHash },
        update: {
          url: options.article.sourceUrl,
          sourceLabel: options.payload.sourceName ?? null,
          language: options.cleaned.language ?? options.payload.language ?? null,
          titleGuess: options.cleaned.title ?? undefined,
          metadata: toPrismaJsonValue(options.article.metadata ?? {}),
          crawlAt,
        },
        create: {
          orgId: options.orgId,
          sourceId: options.sourceId,
          url: options.article.sourceUrl,
          sourceLabel: options.payload.sourceName ?? null,
          language: options.cleaned.language ?? options.payload.language ?? null,
          titleGuess: options.cleaned.title ?? undefined,
          crawlAt,
          contentHash: options.contentHash,
          metadata: toPrismaJsonValue(options.article.metadata ?? {}),
        },
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

      await tx.processedArticle.upsert({
        where: { articleId: articleRecord.id },
        update: {
          status: ProcessedArticleStatus.completed,
          title: options.cleaned.title ?? null,
          subtitle: options.cleaned.subtitle ?? null,
          author: options.cleaned.author ?? null,
          source: options.cleaned.source ?? options.payload.sourceName ?? null,
          publishedAt:
            this.parseDate(options.cleaned.published_at) ??
            this.parseDate(options.article.publishedAt),
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
          language: options.cleaned.language ?? options.payload.language ?? null,
          location: options.cleaned.location ?? null,
          promptTokens: options.llm.promptTokens ?? null,
          completionTokens: options.llm.completionTokens ?? null,
          totalTokens: options.llm.totalTokens ?? null,
          costUsd: options.llm.costUsd ?? null,
          latencyMs: options.llm.latencyMs ?? null,
        },
        create: {
          articleId: articleRecord.id,
          status: ProcessedArticleStatus.completed,
          title: options.cleaned.title ?? null,
          subtitle: options.cleaned.subtitle ?? null,
          author: options.cleaned.author ?? null,
          source: options.cleaned.source ?? options.payload.sourceName ?? null,
          publishedAt:
            this.parseDate(options.cleaned.published_at) ??
            this.parseDate(options.article.publishedAt),
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
          language: options.cleaned.language ?? options.payload.language ?? null,
          location: options.cleaned.location ?? null,
          promptTokens: options.llm.promptTokens ?? null,
          completionTokens: options.llm.completionTokens ?? null,
          totalTokens: options.llm.totalTokens ?? null,
          costUsd: options.llm.costUsd ?? null,
          latencyMs: options.llm.latencyMs ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        { error, contentHash: options.contentHash },
        "Failed to persist processed article",
      );
      throw error;
    }
  }

  private extractSourceId(payload: NormalizedNewsPayload) {
    const raw = payload?.metadata ? (payload.metadata as Record<string, unknown>) : undefined;
    const sourceId = raw && typeof raw.sourceId === "string" ? raw.sourceId.trim() : "";
    return sourceId.length > 0 ? sourceId : undefined;
  }

  private async resolveSourceIdForOrg(tx: Prisma.TransactionClient, orgId: string, sourceId: string) {
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

  private buildPendingProcessedItem(processedItemId: string): PersistedProcessedItem {
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
        select: { id: true, orgId: true, name: true, createdAt: true, publishedAt: true }
      });
      const ingestedAt = itemMeta?.createdAt ?? new Date();
      let publishedAt = this.parseDate(payload.document.result?.published_at ?? null);
      if (!publishedAt && itemMeta?.publishedAt) {
        publishedAt = itemMeta.publishedAt;
      }
      if (!publishedAt) {
        const raw = await RawItemModel.findById(payload.document.rawItemId, { payload: 1 }).lean();
        const rawPayload =
          raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
            ? (raw.payload as Record<string, unknown>)
            : null;
        const rawCandidate = rawPayload
          ? ((rawPayload as { publishedAt?: unknown }).publishedAt ??
              (rawPayload as { published_at?: unknown }).published_at)
          : null;
        publishedAt = this.parseDate(
          typeof rawCandidate === "string" || rawCandidate instanceof Date ? rawCandidate : null
        );
      }

      const cleanedTitleRaw =
        typeof payload.document.result?.title === "string" ? payload.document.result.title.trim() : "";
      const cleanedTitle = cleanedTitleRaw ? this.toItemMetaName(cleanedTitleRaw) : null;
      const shouldUpdateName =
        Boolean(cleanedTitle) &&
        Boolean(
          !itemMeta?.name ||
            itemMeta.name.includes("http://") ||
            itemMeta.name.includes("https://") ||
            itemMeta.name.includes("://"),
        );

      const sortAt = publishedAt ?? ingestedAt;
      const created = await this.writeProcessedItemFromPayload(payload.document, { ingestedAt, sortAt });

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
          created?.createdAt instanceof Date && Number.isFinite(created.createdAt.getTime())
            ? created.createdAt.getTime()
            : Date.now();
        void vectorClient.upsertBestEffort({
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
          ...(publishedAt ? { publishedAt, sortAt: publishedAt } : {})
        },
      });
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
            { status: MongoOutboxStatus.processing, lockedAt: { lt: staleLockCutoff } },
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

  private async markOutboxFailure(outboxId: string, attempts: number, error: unknown) {
    const nextDelay = this.computeBackoffDelay(this.outboxRetryBaseDelayMs, attempts, 5);
    const availableAt = new Date(Date.now() + nextDelay);
    const message = error instanceof Error ? error.message : String(error);

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

  private scheduleOutboxRetry(outboxId: string, availableAt: Date) {
    const delayMs = availableAt.getTime() - Date.now();
    if (delayMs <= 0) {
      this.outboxEventEmitter.emit(OUTBOX_DELIVERY_REQUESTED_EVENT, { outboxId });
      return;
    }

    const cappedDelayMs = Math.min(delayMs, MAX_TIMEOUT_MS);
    const existing = this.outboxRetryTimers.get(outboxId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.outboxRetryTimers.delete(outboxId);
      this.outboxEventEmitter.emit(OUTBOX_DELIVERY_REQUESTED_EVENT, { outboxId });
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
      const duplicateOf = duplicateRef ? new Types.ObjectId(duplicateRef) : undefined;
      const processedId = new Types.ObjectId(document._id);
      const rawItemId = new Types.ObjectId(document.rawItemId);
      const update: Record<string, unknown> = {
        rawItemId,
        itemMetaId: document.itemMetaId,
        orgId: document.orgId,
        ...(options?.ingestedAt ? { ingestedAt: options.ingestedAt } : {}),
        ...(options?.sortAt ? { sortAt: options.sortAt } : {}),
        status: document.status,
        tags: document.tags,
        result: document.result,
        llm: document.llm,
        summaryEmbedding: document.summaryEmbedding,
        summaryEmbeddingModel: document.summaryEmbeddingModel ?? null,
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
            { status: MongoOutboxStatus.processing, lockedAt: { lt: staleLockCutoff } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: this.outboxBatchSize,
      });

      for (const entry of entries) {
        const payload = this.parseOutboxPayload(entry.payload);
        if (!payload) {
          await this.markOutboxFailure(
            entry.id,
            (entry.attempts ?? 0) + 1,
            new Error("Invalid outbox payload"),
          );
          continue;
        }

        await this.deliverOutboxPayload(entry.id, payload);
      }
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to process Mongo outbox batch",
      );
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
      .filter(
        (entity): entity is CleanedNews["entities"][number] => Boolean(entity),
      );
  }

  private normalizeProcessedItemRef(ref?: string | null) {
    if (!ref) {
      return null;
    }
    return Types.ObjectId.isValid(ref) ? ref : null;
  }

  private cacheKey(orgId: string, url: string) {
    const hash = this.hashContent(url);
    return `${this.crawlCachePrefix}${orgId}:${hash}`;
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

  private getCrawlLockTtlMs() {
    const timeoutMs = this.configService.config.crawl4ai.timeoutMs;
    return Math.max(timeoutMs + 5_000, 10_000);
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

  private async retry<T>(
    fn: () => Promise<T>,
    attempts: number,
    delayMs: number,
  ) {
    let tries = 0;
    let lastError: unknown;
    while (tries < attempts) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        tries += 1;
        if (tries >= attempts) {
          throw error;
        }
        const backoffDelay = this.computeBackoffDelay(delayMs, tries, attempts);
        await sleep(backoffDelay);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("operation failed");
  }

  private async runStage<T>(
    job: PipelineJobContext,
    stage: string,
    action: () => Promise<T>,
    options?: {
      onProcessingData?: () => Record<string, unknown>;
      onSuccessData?: (result: T) => Record<string, unknown>;
      onErrorData?: () => Record<string, unknown>;
    },
  ): Promise<T> {
    await this.logStage(
      job,
      stage,
      "processing",
      options?.onProcessingData ? options.onProcessingData() : undefined,
    );
    try {
      const result = await action();
      if (options?.onSuccessData) {
        await this.logStage(job, stage, "completed", options.onSuccessData(result));
      } else {
        await this.logStage(job, stage, "completed");
      }
      return result;
    } catch (error) {
      await this.logStage(
        job,
        stage,
        "failed",
        options?.onErrorData ? options.onErrorData() : undefined,
        error,
      );
      throw error;
    }
  }

  private async logStage(
    job: PipelineJobContext,
    stage: string,
    status: "pending" | "processing" | "completed" | "failed",
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

    try {
      await TaskLogModel.create({
        queue: job.queue,
        jobId: job.jobId,
        orgId: job.orgId,
        stage,
        status,
        data,
        error: errorDetails,
      });
    } catch (logError) {
      this.logger.warn(
        { logError, stage, status, jobId: job.jobId, orgId: job.orgId },
        "Failed to persist task log",
      );
    }
  }
}
