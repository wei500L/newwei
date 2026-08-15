import { createLogger } from "@modular/utils";
import { Injectable, Optional } from "@nestjs/common";
import { Types } from "mongoose";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import { NewsClassifierService } from "./news-classifier.service";
import {
  NewsExtractionPipelineMode,
  NewsExtractionSettingsService,
  type NewsExtractionSettings,
} from "./news-extraction-settings.service";
import {
  NewsExtractionStageService,
  type NewsStageContext,
} from "./news-extraction-stage.service";
import { NewsPipelineCleanService } from "./news-pipeline-clean.service";
import { NewsPipelineDedupeService } from "./news-pipeline-dedupe.service";
import {
  createStageMetaEntry,
  emptyLlmMetadata,
  extractSourceId,
  hashContent,
  isLikelyBotChallengeMarkdown,
  parseDate,
  type CrawledArticle,
  type LlmCallMetadata,
  type PersistResult,
  type StageMetaEntry,
} from "./news-pipeline-internal";
import { NewsPipelineOutboxService } from "./news-pipeline-outbox.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import {
  CleanedNewsSchema,
  type CleanedNews,
  type NewsStageMeta,
  type NormalizedNewsPayload,
  NormalizedNewsPayloadSchema,
} from "./news-pipeline.schema";
import {
  type PipelineJobContext,
  type RawPipelineItem,
} from "./news-pipeline.types";
import { NewsPromptConfigService } from "./news-prompt-config.service";

@Injectable()
export class NewsPipelineStagesService {
  private readonly logger = createLogger({ name: "news-pipeline" });

  constructor(
    private readonly configService: NewsPipelineConfigService,
    private readonly promptConfig: NewsPromptConfigService,
    private readonly extractionSettings: NewsExtractionSettingsService,
    private readonly extractionStages: NewsExtractionStageService,
    private readonly prisma: PrismaService,
    private readonly clean: NewsPipelineCleanService,
    private readonly dedupe: NewsPipelineDedupeService,
    private readonly outbox: NewsPipelineOutboxService,
    @Optional() private readonly classifier?: NewsClassifierService,
  ) {}

  async process(
    job: PipelineJobContext,
    raw: RawPipelineItem,
  ): Promise<Record<string, unknown> & { id: string }> {
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
      async () => this.clean.fetchArticle(job, payload),
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
      async () => this.clean.cleanArticle(payload, article, job),
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
                sourceId: extractSourceId(payload) ?? null,
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
      this.dedupe.evaluateSummaryDedupe({
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
      await this.dedupe.revertDuplicateMarkOnPersistFailure(job, dedupe.duplicateOf);
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
          preflight: createStageMetaEntry({
            status: "rejected",
            provider: "rules",
            reason: preflight.reason ?? "preflight_rejected",
          }),
          clean: createStageMetaEntry({
            status: "skipped",
            provider: "llm",
            reason: "preflight_rejected",
          }),
          quality_gate: createStageMetaEntry({
            status: "skipped",
            provider: "rules",
            reason: "preflight_rejected",
          }),
          entities: createStageMetaEntry({
            status: "skipped",
            provider: extractionSettings.providers.entities,
            reason: "preflight_rejected",
          }),
          sentiment: createStageMetaEntry({
            status: "skipped",
            provider: extractionSettings.providers.sentiment,
            reason: "preflight_rejected",
          }),
          kg: createStageMetaEntry({
            status: "skipped",
            provider: extractionSettings.providers.kg,
            reason: "preflight_rejected",
          }),
          classify: createStageMetaEntry({
            status: "skipped",
            provider: "classifier",
            reason: "preflight_rejected",
          }),
          dedupe: createStageMetaEntry({
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
            llm: emptyLlmMetadata(),
            contentHash: article.contentHash ?? hashContent(article.markdown),
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
      createStageMetaEntry({
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
        this.clean.cleanArticle(
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
      preflight: createStageMetaEntry({
        status: "completed",
        provider: "rules",
      }),
      clean: createStageMetaEntry({
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
    stagedCleaned.stage_meta.quality_gate = createStageMetaEntry({
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
      stagedCleaned.stage_meta.entities = createStageMetaEntry({
        status: "skipped",
        provider: extractionSettings.providers.entities,
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.sentiment = createStageMetaEntry({
        status: "skipped",
        provider: extractionSettings.providers.sentiment,
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.kg = createStageMetaEntry({
        status: "skipped",
        provider: extractionSettings.providers.kg,
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.classify = createStageMetaEntry({
        status: "skipped",
        provider: "classifier",
        reason: qualityGate.reason ?? "quality_gate_rejected",
      });
      stagedCleaned.stage_meta.dedupe = createStageMetaEntry({
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
        this.dedupe.evaluateSummaryDedupe({
          job,
          payload,
          cleaned: stagedCleaned,
          contentDuplicateOf,
        }),
      );
      stagedCleaned.stage_meta = {
        ...(stagedCleaned.stage_meta ?? {}),
        dedupe: createStageMetaEntry({
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
        await this.dedupe.revertDuplicateMarkOnPersistFailure(job, dedupe.duplicateOf);
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
    const markdown = this.clean.buildPipelineQualityMarkdown(article);
    const quality = this.clean.assessPipelineMarkdownQuality(markdown);
    const qualityScore = this.computePreflightQualityScore(quality);
    const qualityThreshold = gate.minQualityScore;
    if (
      gate.rejectBotChallenge &&
      (quality.isChallenge || isLikelyBotChallengeMarkdown(markdown))
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
    const fallbackMarkdown = this.clean.buildMarkdownForLlm(
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

    const next = { ...cleaned, stage_meta: { ...(cleaned.stage_meta ?? {}) } };

    if (!settings.capabilities.entities) {
      next.stage_meta.entities = createStageMetaEntry({
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
        next.stage_meta.entities = createStageMetaEntry({
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
        next.stage_meta.entities = createStageMetaEntry({
          status: "failed",
          provider: settings.providers.entities,
          reason: error instanceof Error ? error.message : "entity_extraction_failed",
        });
        await this.logStageFailure(job, "extract_entities", undefined, error);
        await this.recordStageOutcome(job, "extract_entities", next.stage_meta.entities);
      }
    }

    if (!settings.capabilities.sentiment) {
      next.stage_meta.sentiment = createStageMetaEntry({
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
        next.stage_meta.sentiment = createStageMetaEntry({
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
        next.stage_meta.sentiment = createStageMetaEntry({
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
      next.stage_meta.kg = createStageMetaEntry({
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
      next.stage_meta.kg = createStageMetaEntry({
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
      next.stage_meta.kg = createStageMetaEntry({
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
          classify: createStageMetaEntry({
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
          sourceId: extractSourceId(payload) ?? null,
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
      classify: createStageMetaEntry({
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
      parseDate(options.article.publishedAt)?.toISOString() ?? null;
    const cleaned: CleanedNews = {
      ...options.cleaned,
      published_at: options.cleaned.published_at ?? crawlPublishedAt,
    };
    const outboxPayload = this.outbox.buildProcessedItemOutboxPayload({
      processedItemId,
      raw: options.raw,
      orgId: options.job.orgId,
      sourceId: options.job.sourceId ?? extractSourceId(options.payload),
      payload: options.payload,
      cleaned,
      llm: options.llm,
      summaryEmbedding: options.summaryEmbedding ?? undefined,
      summaryEmbeddingModel: options.summaryEmbeddingModel ?? undefined,
      duplicateOf: options.duplicateOf ?? undefined,
      duplicateSimilarity: options.duplicateSimilarity ?? undefined,
    });

    const outboxEntry = await this.outbox.createOutboxEntry({
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
      processedItem: this.outbox.buildPendingProcessedItem(processedItemId),
      outboxId: outboxEntry.id,
    };
  }

  private normalizePayload(
    payload: Record<string, unknown>,
  ): NormalizedNewsPayload {
    return NormalizedNewsPayloadSchema.parse(payload);
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
