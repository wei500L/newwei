import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { type JsonSchema7Type, zodToJsonSchema } from "zod-to-json-schema";

import { safeJsonParseFromText } from "../../common/llm-json";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";

import type {
  CrawlFrontierPageType,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
} from "./crawl.types";
import { resolveEffectiveLlmAssistConfig } from "./crawl-frontier.utils";

export interface FrontierLlmCandidate {
  url: string;
  pageType: CrawlFrontierPageType;
  score: number;
  freshnessScore: number;
  metadata: Record<string, unknown>;
}

export interface FrontierLlmJudgeResult {
  candidates: FrontierLlmCandidate[];
  diagnostics: Record<string, unknown>;
}

export interface FrontierProfileLearningSuggestion {
  confidence: number;
  rationale?: string | null;
  profilePatch?: Partial<CrawlSiteProfileConfig>;
  snapshot: Record<string, unknown>;
}

const FrontierJudgeDecisionSchema = z.object({
  url: z.string().url(),
  action: z.enum(["expand", "fetch", "drop"]),
  pageType: z.enum(["home", "category", "list", "article"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(280).optional().nullable(),
  clusterLabel: z.string().max(120).optional().nullable(),
  localeHint: z.string().max(32).optional().nullable(),
  selectorHints: z.array(z.string().min(1).max(120)).max(5).optional(),
});

const FrontierJudgeResponseSchema = z.object({
  decisions: z.array(FrontierJudgeDecisionSchema).max(48).default([]),
  rationale: z.string().max(320).optional().nullable(),
});

const FrontierProfilePatchSchema = z.object({
  seedDiscovery: z
    .object({
      strategy: z
        .enum(["auto", "seed_first", "frontier_first", "frontier_only"])
        .optional(),
      mode: z
        .enum(["robots", "common_paths", "sitemap_only", "disabled"])
        .optional(),
      freshnessWindowHours: z.number().int().min(1).max(24 * 365).optional(),
      maxSeedUrls: z.number().int().min(1).max(500).optional(),
      topologyBudgetPages: z.number().int().min(1).max(100).optional(),
      topologyBudgetDepth: z.number().int().min(1).max(8).optional(),
      qualityThresholds: z
        .object({
          minCandidates: z.number().int().min(1).max(200).optional(),
          minArticleRatio: z.number().min(0).max(1).optional(),
          maxNoiseRatio: z.number().min(0).max(1).optional(),
          minFreshRatio: z.number().min(0).max(1).optional(),
        })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
  urlPatterns: z
    .object({
      home: z.array(z.string().min(1)).max(24).optional(),
      category: z.array(z.string().min(1)).max(24).optional(),
      list: z.array(z.string().min(1)).max(24).optional(),
      article: z.array(z.string().min(1)).max(24).optional(),
      exclude: z.array(z.string().min(1)).max(24).optional(),
    })
    .partial()
    .optional(),
  pageTypeSignals: z
    .object({
      home: z
        .object({
          patterns: z.array(z.string().min(1)).max(24).optional(),
          keywords: z.array(z.string().min(1)).max(24).optional(),
        })
        .partial()
        .optional(),
      category: z
        .object({
          patterns: z.array(z.string().min(1)).max(24).optional(),
          keywords: z.array(z.string().min(1)).max(24).optional(),
        })
        .partial()
        .optional(),
      list: z
        .object({
          patterns: z.array(z.string().min(1)).max(24).optional(),
          keywords: z.array(z.string().min(1)).max(24).optional(),
        })
        .partial()
        .optional(),
      article: z
        .object({
          patterns: z.array(z.string().min(1)).max(24).optional(),
          keywords: z.array(z.string().min(1)).max(24).optional(),
        })
        .partial()
        .optional(),
      deny: z
        .object({
          patterns: z.array(z.string().min(1)).max(24).optional(),
          keywords: z.array(z.string().min(1)).max(24).optional(),
        })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
  localeScope: z
    .object({
      locale: z.string().min(1).max(16).optional(),
      acceptLanguages: z.array(z.string().min(1)).max(8).optional(),
      denyUrlPatterns: z.array(z.string().min(1)).max(24).optional(),
      denyHostPatterns: z.array(z.string().min(1)).max(12).optional(),
    })
    .partial()
    .optional(),
  domLinkScopes: z.array(z.string().min(1)).max(16).optional(),
  domLinkExcludeSelectors: z.array(z.string().min(1)).max(24).optional(),
  priorityKeywords: z.array(z.string().min(1)).max(24).optional(),
  denyKeywords: z.array(z.string().min(1)).max(24).optional(),
  sourceTier: z.enum(["tier1", "tier2", "tier3"]).optional(),
});

const FrontierLearnResponseSchema = z.object({
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400).optional().nullable(),
  profilePatch: FrontierProfilePatchSchema.optional(),
});

const FRONTIER_JUDGE_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "crawl_frontier_judge",
    schema: zodToJsonSchema(FrontierJudgeResponseSchema, {
      $refStrategy: "none",
    }) as JsonSchema7Type,
  },
};

const FRONTIER_LEARN_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "crawl_frontier_learn",
    schema: zodToJsonSchema(FrontierLearnResponseSchema, {
      $refStrategy: "none",
    }) as JsonSchema7Type,
  },
};

const LLM_CIRCUIT_FAILURE_THRESHOLD = 3;
const LLM_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

interface LlmCircuitState {
  consecutiveFailures: number;
  openUntilTs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function clamp01(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function uniqueStringList(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = Array.from(
    new Set(
      lists.flatMap((list) =>
        (list ?? [])
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ),
  );
  return merged.length > 0 ? merged : undefined;
}

function parseCompletionJson<T>(
  value: { choices?: Array<{ message?: { content?: string | null } }> },
  schema: z.ZodType<T>,
): T | null {
  const text = (value.choices ?? [])
    .map((choice) => choice.message?.content ?? "")
    .filter((entry) => entry.length > 0)
    .join("\n")
    .trim();
  if (!text) {
    return null;
  }
  const parsed = safeJsonParseFromText<unknown>(text);
  if (!parsed) {
    return null;
  }
  const validated = schema.safeParse(parsed);
  return validated.success ? validated.data : null;
}

@Injectable()
export class CrawlFrontierLlmService {
  private readonly logger = createLogger({ name: "crawl-frontier-llm" });
  private readonly circuits: Record<"judge" | "learn", LlmCircuitState> = {
    judge: {
      consecutiveFailures: 0,
      openUntilTs: 0,
    },
    learn: {
      consecutiveFailures: 0,
      openUntilTs: 0,
    },
  };

  constructor(private readonly liteLlm: LiteLlmService) {}

  isEnabled(
    config: CrawlSiteProfileConfig,
    purpose: "judge" | "learn" = "judge",
  ): boolean {
    return Boolean(resolveEffectiveLlmAssistConfig(config, purpose));
  }

  async judgeCandidates(options: {
    orgId: string;
    runId: string;
    nodeId: string;
    profileId?: string;
    seedUrl: string;
    parentUrl: string;
    parentPageType: CrawlFrontierPageType;
    config: CrawlSiteProfileConfig;
    candidates: FrontierLlmCandidate[];
  }): Promise<FrontierLlmJudgeResult> {
    const llmAssist = resolveEffectiveLlmAssistConfig(options.config, "judge");
    if (!llmAssist || options.candidates.length === 0) {
      return {
        candidates: options.candidates,
        diagnostics: {
          llmJudgeEnabled: false,
          llmJudgeAttempted: false,
          warningFlags: [],
        },
      };
    }
    if (this.isCircuitOpen("judge")) {
      return {
        candidates: options.candidates,
        diagnostics: {
          llmJudgeEnabled: true,
          llmJudgeAttempted: false,
          llmJudgeCircuitOpen: true,
          warningFlags: ["llm_judge_circuit_open"],
        },
      };
    }

    const candidateBudget = this.resolveCandidateBudget(
      llmAssist,
      options.parentPageType,
    );
    if (candidateBudget <= 0) {
      return {
        candidates: options.candidates,
        diagnostics: {
          llmJudgeEnabled: true,
          llmJudgeAttempted: false,
          llmJudgeBudget: 0,
          warningFlags: [],
        },
      };
    }

    let reranked = [...options.candidates];
    let rerankApplied = false;
    try {
      reranked = await this.rerankCandidates({
        orgId: options.orgId,
        runId: options.runId,
        nodeId: options.nodeId,
        profileId: options.profileId,
        model: llmAssist?.judgeModel,
        query: this.buildJudgeQuery(options),
        candidates: reranked,
        topN: Math.min(
          Math.max(candidateBudget, 8),
          this.resolveRecallBudget(llmAssist, options.parentPageType),
        ),
      });
      rerankApplied = true;
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          runId: options.runId,
          nodeId: options.nodeId,
        },
        "Frontier rerank failed; continuing with rule-ranked candidates",
      );
    }

    const candidatesForJudge = reranked.slice(0, candidateBudget);
    if (candidatesForJudge.length === 0) {
      return {
        candidates: reranked,
        diagnostics: {
          llmJudgeEnabled: true,
          llmJudgeAttempted: false,
          llmJudgeBudget: candidateBudget,
          llmRerankApplied: rerankApplied,
          warningFlags: [],
        },
      };
    }

    let response;
    try {
      response = await this.liteLlm.acompletion({
        orgId: options.orgId,
        model: llmAssist?.judgeModel,
        temperature: 0.1,
        max_tokens: 1600,
        response_format: FRONTIER_JUDGE_RESPONSE_FORMAT,
        metadata: {
          feature: "crawl_frontier_judge",
          source: "crawl-frontier",
          runId: options.runId,
          nodeId: options.nodeId,
          ...(options.profileId ? { profileId: options.profileId } : {}),
          frontierRunId: options.runId,
          frontierNodeId: options.nodeId,
          frontierParentPageType: options.parentPageType,
        },
        messages: [
          {
            role: "system",
            content:
              "You are helping a news intelligence crawler choose frontier links. " +
              "Use only the provided URL, anchor text, page type hints, freshness, and scores. " +
              "Prefer real news section pages, latest/list pages, and current article pages. " +
              "Drop utility/legal/account/newsletter/podcast/video/gallery/profile/author/tag/search links unless the evidence strongly shows a news landing page. " +
              "Return strict JSON only.",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                seedUrl: options.seedUrl,
                parentUrl: options.parentUrl,
                parentPageType: options.parentPageType,
                preferredLocale: options.config.localeScope?.locale ?? null,
                priorityKeywords: options.config.priorityKeywords ?? [],
                denyKeywords: options.config.denyKeywords ?? [],
                urlPatterns: options.config.urlPatterns ?? {},
                pageTypeSignals: options.config.pageTypeSignals ?? {},
                candidates: candidatesForJudge.map((candidate) => ({
                  url: candidate.url,
                  pageType: candidate.pageType,
                  score: candidate.score,
                  freshnessScore: candidate.freshnessScore,
                  linkText: asString(candidate.metadata.linkText) ?? null,
                  discoveryPath: candidate.metadata.discoveryPath ?? null,
                })),
              },
              null,
              2,
            ),
          },
        ],
      });
    } catch (error) {
      this.recordCircuitFailure("judge");
      throw error;
    }

    const parsed = parseCompletionJson(response, FrontierJudgeResponseSchema);
    if (!parsed) {
      this.recordCircuitFailure("judge");
      return {
        candidates: reranked,
        diagnostics: {
          llmJudgeEnabled: true,
          llmJudgeAttempted: true,
          llmJudgeParsed: false,
          llmJudgeBudget: candidateBudget,
          llmRerankApplied: rerankApplied,
          warningFlags: ["llm_judge_parse_failed"],
        },
      };
    }
    this.recordCircuitSuccess("judge");

    const minJudgeConfidence = clamp01(
      llmAssist?.minJudgeConfidence ?? 0.72,
      0.72,
    );
    const decisions = new Map(
      (parsed.decisions ?? []).map((entry) => [entry.url, entry]),
    );
    let dropped = 0;
    let retyped = 0;
    let judged = 0;
    const candidates = reranked.flatMap((candidate) => {
      const decision = decisions.get(candidate.url);
      if (!decision) {
        return [
          {
            ...candidate,
            metadata: {
              ...candidate.metadata,
              judgeMethod: rerankApplied ? "rerank" : "rule",
            },
          },
        ];
      }
      judged += 1;
      if (decision.action === "drop" && decision.confidence >= minJudgeConfidence) {
        dropped += 1;
        return [];
      }
      const pageType = decision.pageType ?? candidate.pageType;
      if (pageType !== candidate.pageType) {
        retyped += 1;
      }
      const confidence = clamp01(decision.confidence, 0.5);
      const scoreBoost =
        decision.action === "fetch"
          ? pageType === "article"
            ? 0.35
            : 0.18
          : decision.action === "expand"
            ? pageType === "article"
              ? 0.05
              : 0.2
            : -0.15;
      return [
        {
          ...candidate,
          pageType,
          score: Number((candidate.score + scoreBoost * confidence).toFixed(4)),
          metadata: {
            ...candidate.metadata,
            judgeMethod: "llm",
            judgeAction: decision.action,
            judgeConfidence: confidence,
            judgeReason: decision.reason ?? null,
            clusterLabel: decision.clusterLabel ?? null,
            selectorHints: decision.selectorHints ?? [],
            localeHint: decision.localeHint ?? null,
          },
        },
      ];
    });

    return {
      candidates,
      diagnostics: {
        llmJudgeEnabled: true,
        llmJudgeAttempted: true,
        llmJudgeParsed: true,
        llmJudgeBudget: candidateBudget,
        llmJudgeJudged: judged,
        llmJudgeDropped: dropped,
        llmJudgeRetyped: retyped,
        llmJudgeRationale: parsed.rationale ?? null,
        llmRerankApplied: rerankApplied,
        warningFlags: [],
      },
    };
  }

  async learnShadowProfile(options: {
    orgId: string;
    run: {
      id: string;
      seedUrl: string;
      status: string;
      articleCount: number;
      pageCount: number;
      failedCount: number;
      duplicateCount: number;
      metadata?: Record<string, unknown> | null;
    };
    profile: CrawlSiteProfileRecord;
    nodes: Array<{
      url: string;
      pageType: CrawlFrontierPageType;
      status: string;
      score?: number | null;
      freshnessScore?: number | null;
      metadata?: Record<string, unknown> | null;
    }>;
  }): Promise<FrontierProfileLearningSuggestion | null> {
    const llmAssist = resolveEffectiveLlmAssistConfig(
      options.profile.config,
      "learn",
    );
    if (!llmAssist) {
      return null;
    }
    if (this.isCircuitOpen("learn")) {
      throw new Error("llm_learn_circuit_open");
    }
    const snapshot = this.buildLearningSnapshot(options);
    let response;
    try {
      response = await this.liteLlm.acompletion({
        orgId: options.orgId,
        model: llmAssist.siteLearnerModel,
        temperature: 0.15,
        max_tokens: 1800,
        response_format: FRONTIER_LEARN_RESPONSE_FORMAT,
        metadata: {
          feature: "crawl_frontier_learn",
          source: "crawl-frontier",
          runId: options.run.id,
          profileId: options.profile.id,
          frontierRunId: options.run.id,
          crawlSiteProfileId: options.profile.id,
        },
        messages: [
          {
            role: "system",
            content:
              "You are improving a reusable news crawl site profile. " +
              "Only suggest constrained config fields that improve article discovery and reduce navigation noise. " +
              "Do not output arbitrary crawl payloads, JavaScript, extraction strategies, auth, or bypass logic. " +
              "Return strict JSON only.",
          },
          {
            role: "user",
            content: JSON.stringify(snapshot, null, 2),
          },
        ],
      });
    } catch (error) {
      this.recordCircuitFailure("learn");
      throw error;
    }

    const parsed = parseCompletionJson(response, FrontierLearnResponseSchema);
    if (!parsed) {
      this.recordCircuitFailure("learn");
      throw new Error("llm_learn_parse_failed");
    }
    this.recordCircuitSuccess("learn");

    return {
      confidence: clamp01(parsed.confidence, 0.5),
      rationale: parsed.rationale ?? null,
      profilePatch: parsed.profilePatch
        ? (parsed.profilePatch as Partial<CrawlSiteProfileConfig>)
        : undefined,
      snapshot,
    };
  }

  private isCircuitOpen(purpose: "judge" | "learn"): boolean {
    const state = this.circuits[purpose];
    return state.openUntilTs > Date.now();
  }

  private recordCircuitSuccess(purpose: "judge" | "learn") {
    this.circuits[purpose] = {
      consecutiveFailures: 0,
      openUntilTs: 0,
    };
  }

  private recordCircuitFailure(purpose: "judge" | "learn") {
    const state = this.circuits[purpose];
    const nextFailures = state.consecutiveFailures + 1;
    this.circuits[purpose] = {
      consecutiveFailures: nextFailures,
      openUntilTs:
        nextFailures >= LLM_CIRCUIT_FAILURE_THRESHOLD
          ? Date.now() + LLM_CIRCUIT_COOLDOWN_MS
          : 0,
    };
  }

  private resolveRecallBudget(
    llmAssist: CrawlSiteProfileConfig["llmAssist"],
    pageType: CrawlFrontierPageType,
  ): number {
    const recallMode = llmAssist?.recallMode ?? "high_recall";
    if (recallMode === "low_cost") {
      return pageType === "list" ? 12 : 16;
    }
    if (recallMode === "balanced") {
      return pageType === "list" ? 14 : 20;
    }
    return pageType === "list" ? 18 : 28;
  }

  private resolveCandidateBudget(
    llmAssist: CrawlSiteProfileConfig["llmAssist"],
    pageType: CrawlFrontierPageType,
  ): number {
    const configured = llmAssist?.candidateBudgetByPageType?.[pageType];
    if (typeof configured === "number" && Number.isFinite(configured)) {
      return Math.max(0, Math.min(64, Math.round(configured)));
    }
    if (pageType === "list") {
      return 16;
    }
    if (pageType === "article") {
      return 0;
    }
    return 24;
  }

  private async rerankCandidates(options: {
    orgId: string;
    runId: string;
    nodeId: string;
    profileId?: string;
    model?: string;
    query: string;
    candidates: FrontierLlmCandidate[];
    topN: number;
  }): Promise<FrontierLlmCandidate[]> {
    const documents = options.candidates.map((candidate) => ({
      url: candidate.url,
      body: JSON.stringify({
        url: candidate.url,
        pageType: candidate.pageType,
        score: candidate.score,
        freshnessScore: candidate.freshnessScore,
        linkText: asString(candidate.metadata.linkText) ?? null,
      }),
    }));
    const candidateIndexByUrl = new Map(
      documents.map((entry, index) => [entry.url, index] as const),
    );
    const response = await this.liteLlm.rerank({
      orgId: options.orgId,
      model: options.model,
      query: options.query,
      documents: documents.map((entry) => entry.body),
      topN: Math.min(options.topN, documents.length),
      metadata: {
        feature: "crawl_frontier_judge",
        source: "crawl-frontier",
        runId: options.runId,
        nodeId: options.nodeId,
        ...(options.profileId ? { profileId: options.profileId } : {}),
        mode: "rerank",
      },
    });
    const byIndex = new Map(response.results.map((entry) => [entry.index, entry.score]));
    return [...options.candidates].sort((left, right) => {
      const leftIndex = candidateIndexByUrl.get(left.url) ?? -1;
      const rightIndex = candidateIndexByUrl.get(right.url) ?? -1;
      const leftScore = byIndex.get(leftIndex) ?? -1;
      const rightScore = byIndex.get(rightIndex) ?? -1;
      return rightScore - leftScore || right.score - left.score;
    });
  }

  private buildJudgeQuery(options: {
    seedUrl: string;
    parentUrl: string;
    parentPageType: CrawlFrontierPageType;
    config: CrawlSiteProfileConfig;
  }): string {
    const parts = uniqueStringList(
      [options.seedUrl, options.parentUrl, options.parentPageType],
      options.config.priorityKeywords,
      options.config.keywords,
      options.config.pageTypeSignals?.category?.keywords,
      options.config.pageTypeSignals?.list?.keywords,
      options.config.pageTypeSignals?.article?.keywords,
    );
    return (parts ?? []).slice(0, 20).join(" ");
  }

  private buildLearningSnapshot(options: {
    run: {
      id: string;
      seedUrl: string;
      status: string;
      articleCount: number;
      pageCount: number;
      failedCount: number;
      duplicateCount: number;
      metadata?: Record<string, unknown> | null;
    };
    profile: CrawlSiteProfileRecord;
    nodes: Array<{
      url: string;
      pageType: CrawlFrontierPageType;
      status: string;
      score?: number | null;
      freshnessScore?: number | null;
      metadata?: Record<string, unknown> | null;
    }>;
  }): Record<string, unknown> {
    const topArticles = options.nodes
      .filter((node) => node.pageType === "article")
      .slice(0, 12)
      .map((node) => ({
        url: node.url,
        status: node.status,
        score: node.score ?? null,
        freshnessScore: node.freshnessScore ?? null,
        judgeMethod: asString(node.metadata?.judgeMethod) ?? null,
      }));
    const topRejected = Object.entries(
      isRecord(options.run.metadata?.rejectionCounts)
        ? (options.run.metadata?.rejectionCounts as Record<string, unknown>)
        : {},
    )
      .sort((left, right) => Number(right[1] ?? 0) - Number(left[1] ?? 0))
      .slice(0, 10)
      .map(([reason, count]) => ({
        reason,
        count: typeof count === "number" ? count : Number(count ?? 0),
      }));
    const pageSamples = options.nodes.slice(0, 24).map((node) => ({
      url: node.url,
      pageType: node.pageType,
      status: node.status,
      discoveryPath: node.metadata?.discoveryPath ?? null,
      judgeMethod: asString(node.metadata?.judgeMethod) ?? null,
      judgeReason: asString(node.metadata?.judgeReason) ?? null,
    }));
    return {
      seedUrl: options.run.seedUrl,
      runId: options.run.id,
      runStatus: options.run.status,
      articleCount: options.run.articleCount,
      pageCount: options.run.pageCount,
      failedCount: options.run.failedCount,
      duplicateCount: options.run.duplicateCount,
      rootDiagnosis: options.run.metadata?.rootDiagnosis ?? null,
      coverage: options.run.metadata?.coverage ?? null,
      candidateStats: options.run.metadata?.candidateStats ?? null,
      seedDiagnostics: options.run.metadata?.seedDiagnostics ?? null,
      seedQuality: options.run.metadata?.seedQuality ?? null,
      seedYield: options.run.metadata?.seedYield ?? null,
      fallbackStage:
        typeof options.run.metadata?.fallbackStage === "string"
          ? options.run.metadata.fallbackStage
          : null,
      warningFlags: asStringArray(options.run.metadata?.warningFlags),
      activeProfile: {
        id: options.profile.id,
        name: options.profile.name,
        matchHost: options.profile.matchHost,
        executionMode: options.profile.executionMode,
        seedDiscovery: options.profile.config.seedDiscovery ?? null,
        sourceTier: options.profile.config.sourceTier ?? "tier2",
        hostScope: options.profile.config.hostScope ?? "registrable_domain",
        localeScope: options.profile.config.localeScope ?? null,
        urlPatterns: options.profile.config.urlPatterns ?? null,
        pageTypeSignals: options.profile.config.pageTypeSignals ?? null,
        domLinkScopes: options.profile.config.domLinkScopes ?? [],
        domLinkExcludeSelectors: options.profile.config.domLinkExcludeSelectors ?? [],
        priorityKeywords: options.profile.config.priorityKeywords ?? [],
        denyKeywords: options.profile.config.denyKeywords ?? [],
      },
      topArticles,
      topRejected,
      pageSamples,
    };
  }
}
