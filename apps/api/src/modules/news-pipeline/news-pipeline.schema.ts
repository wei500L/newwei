import { parseDateTime } from "@modular/utils";
import { z } from "zod";

import type { CrawlTaskOptions } from "../crawl/crawl.types";

import { normalizeNewsContentType } from "./news-content-type";

const stringList = z
  .preprocess((value) => (Array.isArray(value) ? value : []), z.array(z.string()))
  .transform((values) =>
    values
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

const optionalTrimmedString = z
  .string()
  .optional()
  .transform((value) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

const optionalNullableTrimmedString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

const optionalNullableIsoDateTimeString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = parseDateTime(trimmed);
    return parsed ? parsed.toISOString() : null;
  });

const optionalNullableSentimentLabel = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed.toLowerCase();
    const isPositive =
      normalized === "positive" ||
      normalized.startsWith("pos") ||
      normalized.includes("正面") ||
      normalized.includes("积极") ||
      normalized.includes("利好");
    if (isPositive) {
      return "positive";
    }

    const isNegative =
      normalized === "negative" ||
      normalized.startsWith("neg") ||
      normalized.includes("负面") ||
      normalized.includes("消极") ||
      normalized.includes("利空");
    if (isNegative) {
      return "negative";
    }

    const isNeutral =
      normalized === "neutral" ||
      normalized.startsWith("neu") ||
      normalized.includes("中性") ||
      normalized.includes("中立");
    if (isNeutral) {
      return "neutral";
    }
    return normalized;
  });

const optionalNullableContentType = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    return normalizeNewsContentType(value) ?? null;
  });

const crawlOptionsSchema: z.ZodType<Partial<CrawlTaskOptions>> = z
  .object({})
  .catchall(z.unknown());

const optionalJsonObject = z.preprocess(
  (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : undefined),
  z.record(z.unknown()).optional()
);

const KgEntityRefSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1)
});

const KgRelationSchema = z.object({
  subject: KgEntityRefSchema,
  predicate: z.string().min(1),
  object: KgEntityRefSchema,
  confidence: z.number().min(0).max(1),
  properties: optionalJsonObject,
  evidence: z.string().nullable().optional()
});

const StageMetaEntrySchema = z.object({
  status: z.enum(["completed", "skipped", "rejected", "failed"]),
  provider: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  prompt_version: z.string().nullable().optional(),
  prompt_tokens: z.number().finite().nullable().optional(),
  completion_tokens: z.number().finite().nullable().optional(),
  total_tokens: z.number().finite().nullable().optional(),
  cost_usd: z.number().finite().nullable().optional(),
  latency_ms: z.number().finite().nullable().optional(),
});

const StageMetaSchema = z.object({
  preflight: StageMetaEntrySchema.optional(),
  clean: StageMetaEntrySchema.optional(),
  quality_gate: StageMetaEntrySchema.optional(),
  entities: StageMetaEntrySchema.optional(),
  sentiment: StageMetaEntrySchema.optional(),
  kg: StageMetaEntrySchema.optional(),
  classify: StageMetaEntrySchema.optional(),
  dedupe: StageMetaEntrySchema.optional(),
});

export const NormalizedNewsPayloadSchema = z
  .object({
    url: z.string().trim().min(1, "url is required"),
    language: optionalTrimmedString,
    sourceName: optionalNullableTrimmedString,
    keywords: stringList,
    tags: stringList,
    summaryHints: stringList,
    metadata: z.preprocess(
      (value) =>
        value && typeof value === "object" && !Array.isArray(value) ? value : {},
      z.record(z.unknown()),
    ),
    crawlOptions: z.preprocess(
      (value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : undefined,
      crawlOptionsSchema.optional(),
    ),
    prefetchedArticle: z
      .object({
        title: optionalTrimmedString,
        description: optionalTrimmedString,
        author: optionalTrimmedString,
        markdown: optionalTrimmedString,
        publishedAt: optionalNullableIsoDateTimeString,
        metadata: optionalJsonObject,
      })
      .optional(),
    forceRefresh: z.preprocess((value) => Boolean(value), z.boolean()),
  });

export type NormalizedNewsPayload = z.infer<typeof NormalizedNewsPayloadSchema>;

const cleanedMarkdownSourceSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized === "llm" || normalized === "crawl_fallback" ? normalized : undefined;
  },
  z.enum(["llm", "crawl_fallback"]).optional(),
);

const ClassificationCandidateSchema = z.object({
  path: z.string().min(1),
  score: z.number().min(0).max(1),
  legacy_category: z.string().min(1),
  reason: z.string().nullable().optional(),
});

export const CleanedNewsSchema = z.object({
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  published_at: optionalNullableIsoDateTimeString,
  language: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  content_type: optionalNullableContentType,
  category_path: z.string().nullable().optional(),
  category_labels: z.array(z.string().min(1)).default([]),
  category_confidence: z.number().min(0).max(1).nullable().optional(),
  category_reason: z.string().nullable().optional(),
  category_method: z.string().nullable().optional(),
  category_candidates: z.array(ClassificationCandidateSchema).default([]),
  sentiment: optionalNullableSentimentLabel,
  sentiment_label: optionalNullableSentimentLabel,
  topics: z.array(z.string().min(1)).default([]),
  summary: z.string().nullable().optional(),
  key_points: z.array(z.string().min(1)).default([]),
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  kg_relations: z.array(KgRelationSchema).default([]),
  stage_meta: StageMetaSchema.optional(),
  cleaned_markdown: z.string().min(1),
  cleaned_markdown_source: cleanedMarkdownSourceSchema,
  removed_noise_types: z.array(z.string().min(1)).default([]),
  quality_score: z.number().min(0).max(1).nullable().optional(),
  llm_model: z.string().nullable().optional(),
  llm_prompt_version: z.string().nullable().optional(),
});

export type CleanedNews = z.infer<typeof CleanedNewsSchema>;
export type NewsStageMeta = z.infer<typeof StageMetaSchema>;
