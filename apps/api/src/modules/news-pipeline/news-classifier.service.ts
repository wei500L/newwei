import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { type JsonSchema7Type, zodToJsonSchema } from "zod-to-json-schema";

import { safeJsonParseFromText } from "../../common/llm-json";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import {
  classifySourceByLabelAndUrl,
  getDefaultNewsEventSourcePolicy,
  normalizeSourceCategoryAuthority,
  normalizeSourcePolicy,
  type NewsEventSourcePolicy,
} from "../news-events/news-event-source-classifier";

import { LiteLlmService } from "./litellm.service";
import {
  NewsClassificationSettingsService,
  type NewsClassificationTaxonomyNode,
} from "./news-classification-settings.service";
import type { CleanedNews } from "./news-pipeline.schema";
import type { JsonSchemaResponseFormat } from "./news-prompt.builder";

const LlmClassificationResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        path: z.string().min(1),
        score: z.number().min(0).max(1),
        reason: z.string().max(240).optional().nullable(),
      }),
    )
    .min(1)
    .max(10),
  rationale: z.string().max(280).optional().nullable(),
});

type LlmClassificationResponse = z.infer<typeof LlmClassificationResponseSchema>;

const SOURCE_POLICY_SYSTEM_SETTING_KEY_PREFIX = "news_event_source_policy:";
const SOURCE_POLICY_CATEGORY_AUTHORITY_KEY_PREFIX =
  "news_event_source_policy_category_authority:";
const SOURCE_POLICY_CACHE_KEY_PREFIX = "newsClassification:sourcePolicy:";
const SOURCE_POLICY_CACHE_TTL_SECONDS = 60;

const LLM_CLASSIFICATION_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  LlmClassificationResponseSchema,
  { $refStrategy: "none" },
);

const LLM_CLASSIFICATION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "news_classification_response",
    schema: LLM_CLASSIFICATION_JSON_SCHEMA,
  },
};

interface CandidateScore {
  path: string;
  legacyCategory: string;
  llmScore?: number;
  embeddingScore?: number;
  rerankScore?: number;
  reason?: string | null;
}

export interface NewsClassificationCandidate {
  path: string;
  score: number;
  legacy_category: string;
  reason?: string | null;
}

export interface NewsClassificationResult {
  legacyCategory: string | null;
  categoryPath: string | null;
  labels: string[];
  confidence: number | null;
  reason: string | null;
  method: string;
  candidates: NewsClassificationCandidate[];
  metrics: {
    taxonomyVersion: string;
    llmLatencyMs: number | null;
    embeddingLatencyMs: number | null;
    rerankLatencyMs: number | null;
    candidateCount: number;
    layerSuccess: {
      llm: boolean;
      embedding: boolean;
      rerank: boolean;
    };
  };
}

@Injectable()
export class NewsClassifierService {
  private readonly logger = createLogger({ name: "news-classifier" });

  constructor(
    private readonly settingsService: NewsClassificationSettingsService,
    private readonly liteLlm: LiteLlmService,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async classify(
    orgId: string,
    cleaned: CleanedNews,
    options?: {
      jobId?: string;
      sourceId?: string | null;
      sourceUrl?: string | null;
      sourceLabel?: string | null;
    },
  ): Promise<NewsClassificationResult> {
    const settings = await this.settingsService.getSettings(orgId);
    if (!settings.enabled) {
      return this.classifyByRule(cleaned, settings.taxonomyVersion);
    }

    const taxonomy = settings.taxonomy;
    const taxonomyByPath = new Map(taxonomy.map((node) => [node.path, node]));
    if (taxonomy.length === 0) {
      if (settings.strictFail) {
        throw new Error("News classification taxonomy is empty");
      }
      return this.classifyByRule(cleaned, settings.taxonomyVersion);
    }

    const metrics = {
      taxonomyVersion: settings.taxonomyVersion,
      llmLatencyMs: null as number | null,
      embeddingLatencyMs: null as number | null,
      rerankLatencyMs: null as number | null,
      candidateCount: 0,
      layerSuccess: {
        llm: false,
        embedding: false,
        rerank: false,
      },
    };

    const candidateByPath = new Map<string, CandidateScore>();
    const queryText = this.buildQueryText(cleaned);

    let llmRationale: string | null = null;
    if (settings.enableLlm) {
      const startedAt = Date.now();
      try {
        const llmResult = await this.runLlmLayer(
          orgId,
          settings.llmModel,
          queryText,
          taxonomy,
          options?.jobId,
        );
        metrics.llmLatencyMs = Date.now() - startedAt;
        metrics.layerSuccess.llm = true;
        llmRationale = llmResult.rationale ?? null;

        for (const candidate of llmResult.candidates) {
          const node = taxonomyByPath.get(candidate.path);
          if (!node) {
            continue;
          }
          const existing =
            candidateByPath.get(node.path) ??
            ({
              path: node.path,
              legacyCategory: node.legacyCategory,
            } as CandidateScore);
          existing.llmScore = this.clamp01(candidate.score);
          if (!existing.reason && candidate.reason) {
            existing.reason = candidate.reason;
          }
          candidateByPath.set(node.path, existing);
        }
      } catch (error) {
        metrics.llmLatencyMs = Date.now() - startedAt;
        if (settings.strictFail) {
          throw error;
        }
        this.logger.warn(
          {
            err: error,
            orgId,
            taxonomyVersion: settings.taxonomyVersion,
          },
          "LLM classification layer failed; falling back to remaining layers",
        );
      }
    }

    if (settings.enableEmbedding) {
      const startedAt = Date.now();
      try {
        const embeddingScores = await this.runEmbeddingLayer(
          orgId,
          queryText,
          taxonomy,
          settings.embeddingTopK,
          options?.jobId,
        );
        metrics.embeddingLatencyMs = Date.now() - startedAt;
        metrics.layerSuccess.embedding = true;

        for (const entry of embeddingScores) {
          const node = taxonomyByPath.get(entry.path);
          if (!node) {
            continue;
          }
          const existing =
            candidateByPath.get(node.path) ??
            ({
              path: node.path,
              legacyCategory: node.legacyCategory,
            } as CandidateScore);
          existing.embeddingScore = entry.score;
          candidateByPath.set(node.path, existing);
        }
      } catch (error) {
        metrics.embeddingLatencyMs = Date.now() - startedAt;
        if (settings.strictFail) {
          throw error;
        }
        this.logger.warn(
          {
            err: error,
            orgId,
            taxonomyVersion: settings.taxonomyVersion,
          },
          "Embedding classification layer failed; falling back to remaining layers",
        );
      }
    }

    if (settings.enableRerank) {
      const startedAt = Date.now();
      try {
        const rerankPaths =
          candidateByPath.size > 0
            ? Array.from(candidateByPath.keys())
            : taxonomy
                .slice(0, Math.max(settings.embeddingTopK, settings.rerankTopN))
                .map((node) => node.path);

        const rerankScores = await this.runRerankLayer(
          orgId,
          queryText,
          rerankPaths,
          taxonomyByPath,
          settings.rerankTopN,
          options?.jobId,
        );

        metrics.rerankLatencyMs = Date.now() - startedAt;
        metrics.layerSuccess.rerank = true;

        for (const entry of rerankScores) {
          const node = taxonomyByPath.get(entry.path);
          if (!node) {
            continue;
          }
          const existing =
            candidateByPath.get(node.path) ??
            ({
              path: node.path,
              legacyCategory: node.legacyCategory,
            } as CandidateScore);
          existing.rerankScore = entry.score;
          candidateByPath.set(node.path, existing);
        }
      } catch (error) {
        metrics.rerankLatencyMs = Date.now() - startedAt;
        if (settings.strictFail) {
          throw error;
        }
        this.logger.warn(
          {
            err: error,
            orgId,
            taxonomyVersion: settings.taxonomyVersion,
          },
          "Rerank classification layer failed; falling back to remaining layers",
        );
      }
    }

    const weighted = this.combineScores(candidateByPath, {
      llm: settings.enableLlm,
      embedding: settings.enableEmbedding,
      rerank: settings.enableRerank,
    });

    const weightedWithSource = await this.applySourceCategoryAuthority(
      orgId,
      weighted,
      {
        sourceId: options?.sourceId ?? null,
        sourceUrl: options?.sourceUrl ?? null,
        sourceLabel: options?.sourceLabel ?? cleaned.source ?? null,
      },
    );

    metrics.candidateCount = weightedWithSource.length;

    if (
      weightedWithSource.length === 0 ||
      weightedWithSource[0]!.score < settings.minConfidence
    ) {
      const fallback = this.classifyByRule(cleaned, settings.taxonomyVersion);
      return {
        ...fallback,
        method:
          weightedWithSource.length === 0
            ? "rule-fallback-empty"
            : "rule-fallback-low-confidence",
        candidates:
          weightedWithSource.length > 0
            ? weightedWithSource
                .slice(0, settings.rerankTopN)
                .map((entry) => ({
                path: entry.path,
                score: entry.score,
                legacy_category: entry.legacy_category,
                reason: entry.reason,
              }))
            : fallback.candidates,
        metrics,
      };
    }

    const topCandidates = weightedWithSource
      .slice(0, Math.max(settings.rerankTopN, 1))
      .map((entry) => ({
        path: entry.path,
        score: entry.score,
        legacy_category: entry.legacy_category,
        reason: entry.reason,
      }));

    const best = topCandidates[0]!;
    return {
      legacyCategory: best.legacy_category,
      categoryPath: best.path,
      labels: best.path.split("/").filter((entry) => entry.length > 0),
      confidence: this.clamp01(best.score),
      reason: best.reason ?? llmRationale,
      method: this.resolveMethod(metrics.layerSuccess),
      candidates: topCandidates,
      metrics,
    };
  }

  applyToCleanedNews(
    cleaned: CleanedNews,
    classification: NewsClassificationResult,
  ): CleanedNews {
    return {
      ...cleaned,
      category: classification.legacyCategory ?? cleaned.category ?? null,
      category_path: classification.categoryPath,
      category_labels: classification.labels,
      category_confidence: classification.confidence,
      category_reason: classification.reason,
      category_method: classification.method,
      category_candidates: classification.candidates,
    };
  }

  private async runLlmLayer(
    orgId: string,
    model: string | null,
    queryText: string,
    taxonomy: NewsClassificationTaxonomyNode[],
    jobId?: string,
  ): Promise<LlmClassificationResponse> {
    const taxonomyPrompt = taxonomy
      .map(
        (entry, idx) =>
          `${idx + 1}. path=${entry.path}; legacy=${entry.legacyCategory}; description=${entry.description}; keywords=${entry.keywords.join(", ")}; synonyms=${entry.synonyms.join(", ")}`,
      )
      .join("\n");

    const response = await this.liteLlm.acompletion({
      orgId,
      ...(model ? { model } : {}),
      messages: [
        {
          role: "system",
          content:
            "You are a strict news taxonomy classifier. Select the best taxonomy paths for the article. Return JSON only.",
        },
        {
          role: "user",
          content: [
            "Classify this news article into the provided taxonomy.",
            "Return 1-5 candidates sorted by confidence.",
            "Do not invent paths that are not in the taxonomy list.",
            "",
            "Article:",
            queryText,
            "",
            "Taxonomy:",
            taxonomyPrompt,
          ].join("\n"),
        },
      ],
      temperature: 0,
      top_p: 1,
      max_tokens: 450,
      response_format: LLM_CLASSIFICATION_RESPONSE_FORMAT,
      metadata: {
        source: "news-classifier",
        orgId,
        ...(jobId ? { jobId } : {}),
      },
    });

    const text = response.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("LLM classification returned empty content");
    }

    const parsed = safeJsonParseFromText<unknown>(text);
    if (!parsed) {
      throw new Error("LLM classification did not return valid JSON");
    }
    return LlmClassificationResponseSchema.parse(parsed);
  }

  private async runEmbeddingLayer(
    orgId: string,
    queryText: string,
    taxonomy: NewsClassificationTaxonomyNode[],
    topK: number,
    jobId?: string,
  ): Promise<{ path: string; score: number }[]> {
    const documents = taxonomy.map((entry) => this.taxonomyDocument(entry));
    const response = await this.liteLlm.embedding({
      orgId,
      input: [queryText, ...documents],
      metadata: {
        source: "news-classifier",
        layer: "embedding",
        orgId,
        ...(jobId ? { jobId } : {}),
      },
    });

    const vectors = new Map<number, number[]>();
    for (const row of response.data ?? []) {
      if (!row || typeof row.index !== "number" || !Array.isArray(row.embedding)) {
        continue;
      }
      vectors.set(row.index, row.embedding);
    }

    const queryVector = vectors.get(0);
    if (!queryVector || queryVector.length === 0) {
      throw new Error("Embedding classification missing query vector");
    }

    const normalizedQuery = this.normalizeVector(queryVector);
    if (normalizedQuery.length === 0) {
      throw new Error("Embedding classification query vector is invalid");
    }

    const scores: { path: string; score: number }[] = [];
    for (let i = 0; i < taxonomy.length; i += 1) {
      const vector = vectors.get(i + 1);
      if (!vector || vector.length !== normalizedQuery.length) {
        continue;
      }
      const normalized = this.normalizeVector(vector);
      if (normalized.length === 0) {
        continue;
      }
      const cosine = this.dot(normalizedQuery, normalized);
      const score = this.clamp01((cosine + 1) / 2);
      scores.push({ path: taxonomy[i]!.path, score });
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, Math.max(1, topK));
  }

  private async runRerankLayer(
    orgId: string,
    queryText: string,
    candidatePaths: string[],
    taxonomyByPath: Map<string, NewsClassificationTaxonomyNode>,
    topN: number,
    jobId?: string,
  ): Promise<{ path: string; score: number }[]> {
    if (candidatePaths.length === 0) {
      return [];
    }

    const docs = candidatePaths
      .map((path) => taxonomyByPath.get(path))
      .filter((node): node is NewsClassificationTaxonomyNode => Boolean(node))
      .map((node) => this.taxonomyDocument(node));

    if (docs.length === 0) {
      return [];
    }

    const response = await this.liteLlm.rerank({
      orgId,
      query: queryText,
      documents: docs,
      topN: Math.min(Math.max(1, topN), docs.length),
      metadata: {
        source: "news-classifier",
        layer: "rerank",
        orgId,
        ...(jobId ? { jobId } : {}),
      },
    });

    const raw = (response.results ?? [])
      .map((result) => {
        const index = typeof result.index === "number" ? result.index : -1;
        const score = typeof result.score === "number" ? result.score : null;
        if (index < 0 || index >= candidatePaths.length || score === null) {
          return null;
        }
        return { path: candidatePaths[index]!, score };
      })
      .filter((entry): entry is { path: string; score: number } => Boolean(entry));

    if (raw.length === 0) {
      throw new Error("Rerank classification returned no usable results");
    }

    const minScore = Math.min(...raw.map((entry) => entry.score));
    const maxScore = Math.max(...raw.map((entry) => entry.score));

    return raw.map((entry) => ({
      path: entry.path,
      score:
        maxScore === minScore
          ? 1
          : this.clamp01((entry.score - minScore) / (maxScore - minScore)),
    }));
  }

  private combineScores(
    candidateByPath: Map<string, CandidateScore>,
    options: { llm: boolean; embedding: boolean; rerank: boolean },
  ): NewsClassificationCandidate[] {
    const weights = {
      llm: options.llm ? 0.5 : 0,
      embedding: options.embedding ? 0.3 : 0,
      rerank: options.rerank ? 0.2 : 0,
    };

    const scoreList: NewsClassificationCandidate[] = [];
    for (const candidate of candidateByPath.values()) {
      let score = 0;
      let appliedWeight = 0;
      if (typeof candidate.llmScore === "number") {
        score += candidate.llmScore * weights.llm;
        appliedWeight += weights.llm;
      }
      if (typeof candidate.embeddingScore === "number") {
        score += candidate.embeddingScore * weights.embedding;
        appliedWeight += weights.embedding;
      }
      if (typeof candidate.rerankScore === "number") {
        score += candidate.rerankScore * weights.rerank;
        appliedWeight += weights.rerank;
      }
      if (appliedWeight <= 0) {
        continue;
      }

      scoreList.push({
        path: candidate.path,
        score: this.clamp01(score / appliedWeight),
        legacy_category: candidate.legacyCategory,
        reason: candidate.reason ?? null,
      });
    }

    return scoreList.sort((a, b) => b.score - a.score);
  }

  private async applySourceCategoryAuthority(
    orgId: string,
    candidates: NewsClassificationCandidate[],
    sourceContext: {
      sourceId: string | null;
      sourceUrl: string | null;
      sourceLabel: string | null;
    },
  ): Promise<NewsClassificationCandidate[]> {
    if (candidates.length === 0) {
      return candidates;
    }

    const sourceUrl =
      typeof sourceContext.sourceUrl === "string"
        ? sourceContext.sourceUrl.trim()
        : "";
    const sourceLabel =
      typeof sourceContext.sourceLabel === "string"
        ? sourceContext.sourceLabel.trim()
        : "";

    if (!sourceUrl && !sourceLabel) {
      return candidates;
    }

    const policy = await this.getSourcePolicy(orgId);
    const rules = normalizeSourceCategoryAuthority(policy.categoryAuthority);
    if (rules.length === 0) {
      return candidates;
    }

    const sourceType = classifySourceByLabelAndUrl(sourceLabel, sourceUrl, policy);
    const hostname = this.extractHostname(sourceUrl);

    const adjusted = candidates.map((candidate) => {
      let nextScore = candidate.score;
      let floor = 0;

      for (const rule of rules) {
        if (!this.pathStartsWithPrefix(candidate.path, rule.categoryPrefix)) {
          continue;
        }

        if (sourceType === "authoritative") {
          nextScore += rule.authoritativeBoost;
          floor = Math.max(floor, rule.minConfidenceFloor);
        } else if (sourceType === "blog") {
          nextScore += rule.blogPenalty;
          nextScore -= Math.max(0, rule.mismatchPenalty);
        } else {
          nextScore += rule.unknownPenalty;
        }

        for (const boost of rule.domainBoosts) {
          if (this.hostnameMatchesDomain(hostname, boost.domain)) {
            nextScore += boost.delta;
          }
        }
      }

      if (sourceType === "authoritative" && floor > 0) {
        nextScore = Math.max(nextScore, floor);
      }

      return {
        ...candidate,
        score: this.clamp01(nextScore),
      };
    });

    return adjusted.sort((a, b) => b.score - a.score);
  }

  private async getSourcePolicy(orgId: string): Promise<NewsEventSourcePolicy> {
    const cacheKey = `${SOURCE_POLICY_CACHE_KEY_PREFIX}${orgId}`;
    try {
      const cached = await this.cache.get<NewsEventSourcePolicy>(cacheKey);
      if (cached) {
        return normalizeSourcePolicy(cached, getDefaultNewsEventSourcePolicy());
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read source policy cache for classification; falling back to database",
      );
    }

    const [policyRecord, categoryAuthorityRecord] = await Promise.all([
      this.prisma.systemSetting.findUnique({
        where: { key: `${SOURCE_POLICY_SYSTEM_SETTING_KEY_PREFIX}${orgId}` },
        select: { value: true },
      }),
      this.prisma.systemSetting.findUnique({
        where: {
          key: `${SOURCE_POLICY_CATEGORY_AUTHORITY_KEY_PREFIX}${orgId}`,
        },
        select: { value: true },
      }),
    ]);

    const base = this.parseSourcePolicyRecordValue(policyRecord?.value);
    const categoryAuthority = normalizeSourceCategoryAuthority(
      categoryAuthorityRecord?.value,
      base.categoryAuthority,
    );
    const policy: NewsEventSourcePolicy =
      categoryAuthority.length > 0 ? { ...base, categoryAuthority } : base;

    try {
      await this.cache.set(cacheKey, policy, SOURCE_POLICY_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write source policy cache for classification",
      );
    }
    return policy;
  }

  private parseSourcePolicyRecordValue(raw: unknown): NewsEventSourcePolicy {
    const fallback = getDefaultNewsEventSourcePolicy();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fallback;
    }
    const record = raw as Record<string, unknown>;

    if (record.version === 2 && record.delta && typeof record.delta === "object") {
      const delta = record.delta as Record<string, unknown>;
      const effective = {
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
      } satisfies Partial<NewsEventSourcePolicy>;
      return normalizeSourcePolicy(effective, fallback);
    }

    return normalizeSourcePolicy(record as Partial<NewsEventSourcePolicy>, fallback);
  }

  private applyDeltaList(
    base: string[],
    adds: string[],
    removes: string[],
  ): string[] {
    const next = new Set(base);
    for (const entry of adds) {
      if (entry) {
        next.add(entry);
      }
    }
    for (const entry of removes) {
      if (entry) {
        next.delete(entry);
      }
    }
    return Array.from(next);
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      result.push(trimmed);
      if (result.length >= 1000) {
        break;
      }
    }
    return result;
  }

  private pathStartsWithPrefix(path: string, prefix: string): boolean {
    const normalizedPath = path.trim().toLowerCase();
    const normalizedPrefix = prefix.trim().toLowerCase().replace(/\/+$/, "");
    if (!normalizedPrefix) {
      return false;
    }
    return (
      normalizedPath === normalizedPrefix ||
      normalizedPath.startsWith(`${normalizedPrefix}/`)
    );
  }

  private hostnameMatchesDomain(hostname: string | null, domain: string): boolean {
    if (!hostname) {
      return false;
    }
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }

  private extractHostname(url: string): string | null {
    if (!url) {
      return null;
    }
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private classifyByRule(
    cleaned: CleanedNews,
    taxonomyVersion: string,
  ): NewsClassificationResult {
    const text = this.buildQueryText(cleaned).toLowerCase();

    const rules: { pattern: RegExp; legacy: string; path: string }[] = [
      {
        pattern: /\b(openai|anthropic|deepmind|llm|gpt|model release|ai model)\b/i,
        legacy: "ai",
        path: "tech/ai/model-release",
      },
      {
        pattern: /\b(fed|fomc|inflation|cpi|gdp|bond|yield|stock|equity|nasdaq|dow)\b/i,
        legacy: "finance",
        path: "finance/macro/monetary-policy",
      },
      {
        pattern: /\b(regulation|regulatory|sec|doj|congress|white house|policy)\b/i,
        legacy: "gov",
        path: "gov/regulation/enforcement",
      },
      {
        pattern: /\b(cyber|breach|malware|ransomware|defense|military|missile|osint)\b/i,
        legacy: "intel",
        path: "intel/defense/military-operation",
      },
      {
        pattern: /\b(election|campaign|parliament|geopolitic|sanction|ceasefire|conflict)\b/i,
        legacy: "politics",
        path: "politics/geopolitics/conflict",
      },
      {
        pattern: /\b(semiconductor|chip|software|hardware|cloud|startup|technology)\b/i,
        legacy: "tech",
        path: "tech/semiconductor/supply-chain",
      },
    ];

    for (const rule of rules) {
      if (!rule.pattern.test(text)) {
        continue;
      }
      return {
        legacyCategory: rule.legacy,
        categoryPath: rule.path,
        labels: rule.path.split("/").filter((entry) => entry.length > 0),
        confidence: 0.35,
        reason: "rule-based fallback",
        method: "rule-only",
        candidates: [
          {
            path: rule.path,
            score: 0.35,
            legacy_category: rule.legacy,
            reason: "rule-based fallback",
          },
        ],
        metrics: {
          taxonomyVersion,
          llmLatencyMs: null,
          embeddingLatencyMs: null,
          rerankLatencyMs: null,
          candidateCount: 1,
          layerSuccess: {
            llm: false,
            embedding: false,
            rerank: false,
          },
        },
      };
    }

    return {
      legacyCategory: null,
      categoryPath: null,
      labels: [],
      confidence: 0,
      reason: "no-classification-match",
      method: "rule-only",
      candidates: [],
      metrics: {
        taxonomyVersion,
        llmLatencyMs: null,
        embeddingLatencyMs: null,
        rerankLatencyMs: null,
        candidateCount: 0,
        layerSuccess: {
          llm: false,
          embedding: false,
          rerank: false,
        },
      },
    };
  }

  private resolveMethod(layerSuccess: {
    llm: boolean;
    embedding: boolean;
    rerank: boolean;
  }): string {
    const parts: string[] = [];
    if (layerSuccess.llm) {
      parts.push("llm");
    }
    if (layerSuccess.embedding) {
      parts.push("embedding");
    }
    if (layerSuccess.rerank) {
      parts.push("rerank");
    }
    return parts.length > 0 ? parts.join("+") : "rule-only";
  }

  private buildQueryText(cleaned: CleanedNews): string {
    return [
      cleaned.title,
      cleaned.subtitle,
      cleaned.summary,
      cleaned.source,
      cleaned.language,
      ...(Array.isArray(cleaned.topics) ? cleaned.topics : []),
      ...(Array.isArray(cleaned.key_points) ? cleaned.key_points : []),
    ]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .join("\n");
  }

  private taxonomyDocument(node: NewsClassificationTaxonomyNode): string {
    const keywords = node.keywords.join(", ");
    const synonyms = node.synonyms.join(", ");
    return [
      `path=${node.path}`,
      `legacy=${node.legacyCategory}`,
      `name=${node.displayName}`,
      `description=${node.description}`,
      keywords ? `keywords=${keywords}` : "",
      synonyms ? `synonyms=${synonyms}` : "",
    ]
      .filter((entry) => entry.length > 0)
      .join("\n");
  }

  private normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      return [];
    }
    return vector.map((value) => value / magnitude);
  }

  private dot(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      sum += a[i]! * b[i]!;
    }
    return sum;
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
}
