import {
  ProcessedItemModel,
  TaskLogModel,
  type ProcessedItemDocument,
} from "@modular/mongo";
import { createLogger, parseDateTime } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  MongoOutboxStatus,
  MongoOutboxType,
  type Article,
  type Prisma,
  type ProcessedArticle,
} from "@prisma/client";
import { Types } from "mongoose";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { Crawl4aiClient } from "../crawl/crawl4ai.client";


import { LiteLlmService } from "./litellm.service";
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

interface ProcessedItemOutboxPayload {
  type: MongoOutboxType.processed_item;
  document: {
    _id: string;
    rawItemId: string;
    itemMetaId: string;
    orgId: string;
    status: "completed";
    tags: string[];
    result: CleanedNews;
    llm: LlmCallMetadata;
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

const LlmCallMetadataSchema: z.ZodType<LlmCallMetadata> = z.object({
  model: NullableStringSchema,
  promptVersion: NullableStringSchema,
  promptTokens: NullableFiniteNumberSchema,
  completionTokens: NullableFiniteNumberSchema,
  totalTokens: NullableFiniteNumberSchema,
  costUsd: NullableFiniteNumberSchema,
  latencyMs: NullableFiniteNumberSchema,
});

const ProcessedItemOutboxPayloadSchema: z.ZodType<ProcessedItemOutboxPayload> =
  z.object({
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
      error: z.unknown().optional(),
    }),
  });

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

@Injectable()
export class NewsPipelineService {
  private readonly logger = createLogger({ name: "news-pipeline" });
  private readonly crawlCachePrefix = "news:crawl:";
  private readonly outboxRetryBaseDelayMs = 30_000;
  private readonly outboxStaleLockMs = 5 * 60_000;
  private readonly outboxBatchSize = 10;
  private readonly outboxEventEmitter = new EventEmitter();
  private readonly outboxDeliveryQueue = new Map<string, ProcessedItemOutboxPayload | null>();
  private outboxDeliveryScheduled = false;
  private outboxDeliveryInFlight = false;
  private readonly outboxRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly crawlClient: Crawl4aiClient,
    private readonly liteLlm: LiteLlmService,
    private readonly configService: NewsPipelineConfigService,
    private readonly promptBuilder: NewsPromptBuilder,
    private readonly promptConfig: NewsPromptConfigService,
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {
    this.outboxEventEmitter.on(
      OUTBOX_DELIVERY_REQUESTED_EVENT,
      (event: OutboxDeliveryRequestedEvent) => {
        this.enqueueOutboxDelivery(event);
      },
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

    const { cleaned, llm, contentHash, processedArticleId } = await this.runStage(
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
    article: ReturnType<typeof this.normalizeArticle> & { fromCache: boolean };
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    contentHash: string;
    processedArticleId?: string | null;
  }): Promise<PersistResult> {
    const processedItemId = new Types.ObjectId().toHexString();
    const outboxPayload = this.buildProcessedItemOutboxPayload({
      processedItemId,
      raw: options.raw,
      orgId: options.job.orgId,
      payload: options.payload,
      cleaned: options.cleaned,
      llm: options.llm,
    });

    const outboxEntry = await this.createOutboxEntry({
      orgId: options.job.orgId,
      payload: outboxPayload,
      processedItemId,
      contentHash: options.contentHash,
      article: options.article,
      cleaned: options.cleaned,
      llm: options.llm,
      processedArticleId: options.processedArticleId,
      normalizedPayload: options.payload,
    });

    return {
      processedItem: this.buildPendingProcessedItem(processedItemId),
      outboxId: outboxEntry.id,
    };
  }

  private async fetchArticle(job: PipelineJobContext, payload: NormalizedNewsPayload) {
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
        return {
          sourceUrl: payload.url,
          markdown: cachedWithHash.markdown,
          markdownWithCitations: cachedWithHash.markdownWithCitations,
          referencesMarkdown: cachedWithHash.referencesMarkdown,
          metadata: cachedWithHash.metadata ?? {},
          publishedAt: cachedWithHash.publishedAt ?? null,
          runId: cachedWithHash.runId ?? null,
          fetchedAt: cachedWithHash.fetchedAt ?? null,
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

  private async executeCrawl(payload: NormalizedNewsPayload): Promise<ParsedCrawl4aiResponse> {
    const cfg = this.configService.config.crawl4ai;
    const options = {
      ...cfg.crawlerDefaults,
      cleanMarkdown: cfg.cleanMarkdown ?? cfg.crawlerDefaults.cleanMarkdown,
      markdownOptions: cfg.markdown ?? cfg.crawlerDefaults.markdownOptions,
      userAgent: cfg.crawlerDefaults.userAgent ?? cfg.userAgent,
      ...payload.crawlOptions,
      userAgent: payload.crawlOptions?.userAgent ?? cfg.userAgent,
    };
    const request = {
      url: payload.url,
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
  ) {
    const markdown = this.extractMarkdown(article);
    if (!markdown) {
      throw new Error("Crawl result missing markdown");
    }
    const contentHash = this.hashContent(markdown);
    const markdownRecord =
      typeof article.markdown === "string" || !article.markdown ? null : article.markdown;
    return {
      sourceUrl: article.url ?? url,
      markdown,
      markdownWithCitations:
        markdownRecord?.markdown_with_citations ??
        markdownRecord?.markdownWithCitations,
      referencesMarkdown:
        markdownRecord?.references_markdown ??
        markdownRecord?.referencesMarkdown,
      metadata: article.metadata ?? {},
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
    article: ReturnType<typeof this.normalizeArticle> & { fromCache: boolean },
    job: PipelineJobContext,
  ): Promise<{
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    contentHash: string;
    processedArticleId?: string | null;
  }> {
    const contentHash = article.contentHash ?? this.hashContent(article.markdown);
    const existing = await this.findProcessedArticle(contentHash);
    if (existing) {
      const cleanedFromExisting = await this.resolveCleanedNews(existing);
      if (cleanedFromExisting) {
        return {
          cleaned: cleanedFromExisting,
          llm: this.buildLlmMetadataFromProcessed(existing),
          contentHash,
          processedArticleId: existing.id,
        };
      }
    }

    const pipelineCfg = this.configService.config.pipeline;
    const truncated = article.markdown.slice(0, pipelineCfg.maxInputChars);
    const promptConfig = await this.promptConfig.getConfig();
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
    });

    const cleaned = this.withPromptMetadata(
      this.parseResponse(response),
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
  ): CleanedNews {
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LiteLLM returned empty content");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      this.logger.error({ error }, "Failed to parse LiteLLM JSON output");
      throw new Error("LiteLLM return was not valid JSON");
    }
    return CleanedNewsSchema.parse(parsed);
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
    article: ReturnType<typeof this.normalizeArticle>;
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
    processedArticleId?: string | null;
    normalizedPayload: NormalizedNewsPayload;
  }) {
    try {
      const outboxEntry = await this.prisma.runInTransaction(async (tx) => {
        if (!options.processedArticleId) {
          await this.upsertArticleAndProcessed(tx, {
            orgId: options.orgId,
            contentHash: options.contentHash,
            article: options.article,
            cleaned: options.cleaned,
            llm: options.llm,
            processedItemId: options.processedItemId,
            payload: options.normalizedPayload,
          });
        }

        return tx.mongoOutbox.create({
          data: {
            orgId: options.orgId,
            type: MongoOutboxType.processed_item,
            payload: options.payload,
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
    try {
      while (this.outboxDeliveryQueue.size > 0) {
        const batch = Array.from(this.outboxDeliveryQueue.entries());
        this.outboxDeliveryQueue.clear();

        for (const [outboxId, payload] of batch) {
          await this.deliverOutboxFromQueue(outboxId, payload);
        }
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to flush outbox delivery queue");
    } finally {
      this.outboxDeliveryInFlight = false;
    }
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
      article: ReturnType<typeof this.normalizeArticle>;
      cleaned: CleanedNews;
      llm: LlmCallMetadata;
      processedItemId: string;
      payload: NormalizedNewsPayload;
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
          metadata: options.article.metadata ?? {},
          crawlAt,
        },
        create: {
          orgId: options.orgId,
          url: options.article.sourceUrl,
          sourceLabel: options.payload.sourceName ?? null,
          language: options.cleaned.language ?? options.payload.language ?? null,
          titleGuess: options.cleaned.title ?? undefined,
          crawlAt,
          contentHash: options.contentHash,
          metadata: options.article.metadata ?? {},
        },
      });

      await tx.processedArticle.upsert({
        where: { articleId: articleRecord.id },
        update: {
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

  private buildProcessedItemOutboxPayload(options: {
    processedItemId: string;
    raw: RawPipelineItem;
    orgId: string;
    payload: NormalizedNewsPayload;
    cleaned: CleanedNews;
    llm: LlmCallMetadata;
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
      const created = await this.writeProcessedItemFromPayload(payload.document);
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
  ): Promise<ProcessedItemDocument> {
    try {
      return await ProcessedItemModel.create({
        ...document,
        _id: new Types.ObjectId(document._id),
        rawItemId: new Types.ObjectId(document.rawItemId),
      });
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

  private cacheKey(orgId: string, url: string) {
    const hash = this.hashContent(url);
    return `${this.crawlCachePrefix}${orgId}:${hash}`;
  }

  private hashContent(content: string) {
    return createHash("sha256").update(content).digest("hex");
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
