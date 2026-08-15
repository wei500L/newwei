import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable, Optional } from "@nestjs/common";
import { type Prisma } from "@prisma/client";
import { Types } from "mongoose";

import { safeJsonParseFromText } from "../../common/llm-json";
import { ItemStatus } from "../../common/pipeline-status";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";
import { VectorClientService } from "../vector/vector-client.service";

import { LiteLlmService } from "./litellm.service";
import {
  buildNewsDedupeSystemPrompt,
  buildNewsDedupeUserPrompt,
  NEWS_DEDUPE_RESPONSE_FORMAT,
  NewsDedupeJudgeSchema,
} from "./news-dedupe-llm";
import { NewsDedupeSettingsService } from "./news-dedupe-settings.service";
import {
  DEFAULT_LLM_DEDUPE_CONCURRENCY,
  extractSourceId,
  isPrismaUniqueConstraintError,
  LLM_DEDUPE_EARLY_EXIT_SIMILARITY,
  MAX_LLM_DEDUPE_CANDIDATE_CHARS,
  MAX_LLM_DEDUPE_COMPARISONS,
  type PreparedLlmDedupeCandidate,
  type RankedLlmDedupeCandidate,
  type SummaryDedupeResult,
} from "./news-pipeline-internal";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { type CleanedNews, type NormalizedNewsPayload } from "./news-pipeline.schema";
import { type PipelineJobContext } from "./news-pipeline.types";

@Injectable()
export class NewsPipelineDedupeService {
  private readonly logger = createLogger({ name: "news-pipeline" });

  constructor(
    private readonly liteLlm: LiteLlmService,
    private readonly configService: NewsPipelineConfigService,
    private readonly dedupeSettings: NewsDedupeSettingsService,
    private readonly prisma: PrismaService,
    @Optional() private readonly vectorClient?: VectorClientService,
  ) {}

  async evaluateSummaryDedupe(options: {
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
      options.job.sourceId ?? extractSourceId(options.payload);
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
  async upsertOrgScopedArticle(
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
      if (!isPrismaUniqueConstraintError(error)) {
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
  async revertDuplicateMarkOnPersistFailure(
    job: PipelineJobContext,
    duplicateOf?: string | null,
  ): Promise<void> {
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
}
