import { type ProcessedItemDocument } from "@modular/mongo";
import { parseDateTime } from "@modular/utils";
import { MongoOutboxType, type ProcessedArticle } from "@prisma/client";
import { Types } from "mongoose";
import { createHash } from "node:crypto";
import { z } from "zod";

import { resolveQueryParamAllowlist } from "../crawl/url-fingerprint";

import {
  inferNewsContentType,
  normalizeNewsContentType,
} from "./news-content-type";
import {
  CleanedNewsSchema,
  type CleanedNews,
  type NewsStageMeta,
  type NormalizedNewsPayload,
} from "./news-pipeline.schema";

export interface LlmCallMetadata {
  model: string | null;
  promptVersion: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}

export interface ArticleRepairMetadata {
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

export interface SummaryDedupeResult {
  summaryEmbedding?: number[] | null;
  summaryEmbeddingModel?: string | null;
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
  thresholdUsed?: number | null;
}

export type StageStatus = "completed" | "skipped" | "rejected" | "failed";

export type StageMetaEntry = NonNullable<NewsStageMeta["clean"]>;

export interface RankedLlmDedupeCandidate {
  id: string;
  summary: string;
  title: string | null;
  quick: number;
}

export interface PreparedLlmDedupeCandidate {
  id: string;
  title: string | null;
  text: string;
}

export interface ProcessedItemOutboxPayload {
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

export const NullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : null),
  z.string().nullable(),
);

export const NullableFiniteNumberSchema = z.preprocess(
  (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null,
  z.number().finite().nullable(),
);

export const OptionalNumberArraySchema = z
  .preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.number().finite()),
  )
  .optional();

export const LlmCallMetadataSchema: z.ZodType<
  LlmCallMetadata,
  z.ZodTypeDef,
  unknown
> = z.object({
  model: NullableStringSchema,
  promptVersion: NullableStringSchema,
  promptTokens: NullableFiniteNumberSchema,
  completionTokens: NullableFiniteNumberSchema,
  totalTokens: NullableFiniteNumberSchema,
  costUsd: NullableFiniteNumberSchema,
  latencyMs: NullableFiniteNumberSchema,
});

export const ProcessedItemOutboxPayloadSchema: z.ZodType<
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

export const ArticleRepairSchema = z.object({
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});

export interface CrawledArticle {
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

export interface PipelineMarkdownQuality {
  words: number;
  paragraphs: number;
  headingCount: number;
  linkCount: number;
  bulletLines: number;
  score: number;
  isChallenge: boolean;
  isListLike: boolean;
}

export type PersistedProcessedItem =
  | ProcessedItemDocument
  | { _id: string; toJSON: () => { id: string } };

export interface PersistResult {
  processedItem: PersistedProcessedItem;
  outboxId: string;
}

export interface OutboxDeliveryRequestedEvent {
  outboxId: string;
  payload?: ProcessedItemOutboxPayload;
}

export const OUTBOX_DELIVERY_REQUESTED_EVENT =
  "newsPipeline.outbox.deliveryRequested";
export const MAX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_LLM_DEDUPE_CONCURRENCY = 4;
export const MAX_LLM_DEDUPE_COMPARISONS = 12;
export const MAX_LLM_DEDUPE_CANDIDATE_CHARS = 1_200;
export const LLM_DEDUPE_EARLY_EXIT_SIMILARITY = 0.98;

export function extractUrlQueryParamAllowlist(
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

export function extractSeedDedupeWindowHours(
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

export function extractSourceId(
  payload: NormalizedNewsPayload,
): string | undefined {
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

export function extractCrawlResultId(
  payload: NormalizedNewsPayload,
): string | null {
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

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function parseDate(value?: string | Date | null): Date | null {
  return parseDateTime(value);
}

export function normalizeProcessedItemRef(
  ref?: string | null,
): string | null {
  if (!ref) {
    return null;
  }
  return Types.ObjectId.isValid(ref) ? ref : null;
}

export function parseStoredCleanedNewsResult(
  value: unknown,
): CleanedNews | null {
  const parsed = CleanedNewsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeStoredCategoryPath(value: unknown): string | null {
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

export function normalizeStoredCategoryMethod(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function applyCleanedMarkdownFallback(
  parsed: unknown,
  fallback: string,
): unknown {
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

export function withPromptMetadata(
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

export function withResolvedContentType(
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

export function resolveStoredContentTypeForBackfill(
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

export function emptyLlmMetadata(): LlmCallMetadata {
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

export function createStageMetaEntry(input: {
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

export function mergeLlmMetadata(
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

export function buildLlmMetadataFromProcessed(
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

export function toStringArray(value: unknown): string[] {
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

export function normalizeEntities(value: unknown): CleanedNews["entities"] {
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

export function normalizeKgRelations(
  value: unknown,
): CleanedNews["kg_relations"] {
  const parsed = CleanedNewsSchema.shape.kg_relations.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function buildTags(
  payload: NormalizedNewsPayload,
  cleaned: CleanedNews,
): string[] {
  const derived = new Set<string>();
  payload.tags.forEach((tag) => derived.add(tag));
  const topics = Array.isArray(cleaned.topics) ? cleaned.topics : [];
  topics.forEach((topic) => derived.add(topic.toLowerCase()));
  return Array.from(derived).slice(0, 20);
}

export function toItemMetaName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 191) {
    return trimmed;
  }
  return `${trimmed.slice(0, 190).trimEnd()}…`;
}

export function toArticleUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 512) {
    return trimmed;
  }
  return trimmed.slice(0, 512);
}

export function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "P2002",
  );
}

export function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000,
  );
}

export function computeBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxAttempts: number,
): number {
  const exponentialDelay =
    baseDelayMs * 2 ** Math.max(Math.min(attempt, maxAttempts) - 1, 0);
  const jitterFactor = 0.5 + Math.random(); // add jitter to avoid synchronized retries
  return Math.round(exponentialDelay * jitterFactor);
}

export function resolveFrontierLogMetadata(
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

export function readMarkdownField(
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

export function normalizeMarkdownCandidate(
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isLikelyBotChallengeMarkdown(markdown: string): boolean {
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

export function selectBestMarkdownFromContentDoc(
  record: Record<string, unknown>,
): string | undefined {
  const primary = normalizeMarkdownCandidate(
    readMarkdownField(record, ["markdown"]),
  );
  const citations = normalizeMarkdownCandidate(
    readMarkdownField(record, [
      "markdownWithCitations",
      "markdown_with_citations",
    ]),
  );
  const raw = normalizeMarkdownCandidate(
    readMarkdownField(record, ["rawMarkdown", "raw_markdown"]),
  );
  const fit = normalizeMarkdownCandidate(
    readMarkdownField(record, ["fitMarkdown", "fit_markdown"]),
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

  const currentChallenge = isLikelyBotChallengeMarkdown(current);
  const richerChallenge = isLikelyBotChallengeMarkdown(richer);
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
