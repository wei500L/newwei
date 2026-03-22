import type { ItemReadModel } from "@modular/mongo";
import { parseDateTime } from "@modular/utils";
import type { Prisma } from "@prisma/client";

import { normalizeProcessedResult } from "../../graphql/utils/normalize-processed-result";

type ItemMetaLike = Pick<
  Prisma.ItemMetaGetPayload<Record<string, never>>,
  | "id"
  | "orgId"
  | "externalId"
  | "name"
  | "status"
  | "mongoRef"
  | "version"
  | "publishedAt"
  | "sortAt"
  | "createdAt"
  | "updatedAt"
>;

export interface ItemReadModelRawSnapshotInput {
  id: string;
  itemMetaId: string;
  source?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemReadModelProcessedSnapshotInput {
  id: string;
  itemMetaId: string;
  rawItemId?: string | null;
  pipelineJobId?: string | null;
  sourceId?: string | null;
  status: string;
  error?: { message: string; name?: string | null } | null;
  tags?: string[] | null;
  result?: Record<string, unknown> | string | null;
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
  summaryEmbeddingModel?: string | null;
  summaryEmbeddingDimensions?: number | null;
  llm?: {
    model?: string | null;
    promptVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemReadModelProjectionInput {
  meta: ItemMetaLike;
  raw?: ItemReadModelRawSnapshotInput | null;
  processed?: ItemReadModelProcessedSnapshotInput | null;
  sourceId?: string | null;
}

export interface ItemMetaGraphRecord {
  id: string;
  externalId: string;
  name: string;
  status: string;
  mongoRef: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RawGraphRecord {
  id: string;
  itemMetaId: string;
  payload: string;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RawPreviewGraphRecord {
  url?: string | null;
  sourceName?: string | null;
  thumbnail?: string | null;
  summary?: string | null;
  sentiment?: string | null;
  region?: string | null;
  location?: string | null;
  ticker?: string | null;
  price?: number | null;
  changePercent?: number | null;
  history?: { timestamp: string; value: number }[] | null;
}

export interface ProcessedGraphRecord {
  id: string;
  itemMetaId: string;
  status: string;
  error?: { message: string; name?: string | null } | null;
  tags: string[];
  result?: string;
  resultJson?: Record<string, unknown> | null;
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
  llm?: {
    model?: string | null;
    promptVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  } | null;
  summaryEmbeddingModel?: string | null;
  summaryEmbeddingDimensions?: number | null;
  createdAt: Date;
}

export interface ProcessedPreviewGraphRecord {
  id: string;
  itemMetaId: string;
  status: string;
  tags: string[];
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
  llm?: {
    model?: string | null;
    promptVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  } | null;
  source?: string | null;
  title?: string | null;
  language?: string | null;
  publishedAt?: string | null;
  summary?: string | null;
  sentiment?: string | null;
  contentType?: string | null;
  topics: string[];
  entities: string[];
  qualityScore?: number | null;
  location?: string | null;
  createdAt: Date;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLowerKey(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase().replace(/\s+/g, " ").slice(0, 128);
}

function normalizeIsoDateTimeString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = parseDateTime(trimmed);
    return parsed ? parsed.toISOString() : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function pickFirstNonEmptyString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = normalizeNonEmptyString(obj[key]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function pickFirstFiniteNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        return (
          normalizeNonEmptyString(record.name) ??
          normalizeNonEmptyString(record.label) ??
          normalizeNonEmptyString(record.value) ??
          normalizeNonEmptyString(record.topic) ??
          ""
        );
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeEntityNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return normalizeNonEmptyString((entry as { name?: unknown }).name) ?? "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeSeriesPoints(
  value: unknown,
): { timestamp: string; value: number }[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const points = value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const timestamp = normalizeIsoDateTimeString(record.timestamp ?? record.time);
      const pointValue = pickFirstFiniteNumber(record, ["value", "price", "close"]);
      if (!timestamp || pointValue === null) {
        return null;
      }
      return { timestamp, value: pointValue };
    })
    .filter((entry): entry is { timestamp: string; value: number } => Boolean(entry));
  return points.length > 0 ? points : null;
}

function normalizeResultRecord(value: unknown): Record<string, unknown> {
  const normalized = normalizeProcessedResult(value);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    return normalized as Record<string, unknown>;
  }
  return {};
}

function resolvePublishedAtFromProcessedResult(result: unknown): string | null {
  const record = normalizeResultRecord(result);
  return normalizeIsoDateTimeString(record.published_at ?? record.publishedAt);
}

function resolvePublishedAtFromRawPayload(payload?: Record<string, unknown>): string | null {
  if (!payload) {
    return null;
  }
  return normalizeIsoDateTimeString(
    (payload as { publishedAt?: unknown }).publishedAt ??
      (payload as { published_at?: unknown }).published_at,
  );
}

function toDateOrFallback(value: unknown, fallback: Date): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

export function extractRawPayloadFields(
  payload?: Record<string, unknown> | null,
): RawPreviewGraphRecord {
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const metadataValue = (safePayload as { metadata?: unknown }).metadata;
  const metadata =
    metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
      ? (metadataValue as Record<string, unknown>)
      : {};
  const merged = { ...safePayload, ...metadata };

  return {
    url: pickFirstNonEmptyString(merged, ["url", "link", "sourceUrl"]),
    sourceName: pickFirstNonEmptyString(merged, [
      "sourceName",
      "source_name",
      "source",
      "publisher",
      "siteName",
      "site_name",
    ]),
    thumbnail: pickFirstNonEmptyString(merged, [
      "thumbnail",
      "thumbnailUrl",
      "image",
      "imageUrl",
      "image_url",
    ]),
    summary: pickFirstNonEmptyString(merged, ["summary", "abstract", "description"]),
    sentiment: pickFirstNonEmptyString(merged, ["sentiment_label", "sentimentLabel", "sentiment"]),
    region: pickFirstNonEmptyString(merged, ["region", "country", "area"]),
    location: pickFirstNonEmptyString(merged, ["location"]),
    ticker: pickFirstNonEmptyString(merged, ["ticker", "symbol"]),
    price: pickFirstFiniteNumber(merged, ["price"]),
    changePercent: pickFirstFiniteNumber(merged, ["changePercent", "change_percent", "change"]),
    history: normalizeSeriesPoints((merged as { history?: unknown }).history),
  };
}

export function extractProcessedResultFields(result?: unknown): {
  source: string | null;
  title: string | null;
  language: string | null;
  publishedAt: string | null;
  summary: string | null;
  sentiment: string | null;
  contentType: string | null;
  topics: string[];
  entities: string[];
  qualityScore: number | null;
  location: string | null;
  region: string | null;
} {
  const record = normalizeResultRecord(result);
  return {
    source: pickFirstNonEmptyString(record, ["source", "sourceName", "source_name", "publisher"]),
    title: pickFirstNonEmptyString(record, ["title", "headline", "title_zh", "titleZh"]),
    language: pickFirstNonEmptyString(record, ["language", "lang"]),
    publishedAt: normalizeIsoDateTimeString(record.published_at ?? record.publishedAt),
    summary: pickFirstNonEmptyString(record, ["summary", "abstract", "subtitle"]),
    sentiment: pickFirstNonEmptyString(record, ["sentiment_label", "sentimentLabel", "sentiment"]),
    contentType: normalizeLowerKey(record.content_type ?? record.contentType),
    topics: normalizeStringList(record.topics),
    entities: normalizeEntityNames(record.entities),
    qualityScore: pickFirstFiniteNumber(record, ["quality_score", "qualityScore"]),
    location: pickFirstNonEmptyString(record, ["location"]),
    region: pickFirstNonEmptyString(record, ["region"]),
  };
}

export function buildItemReadModelPatch(input: ItemReadModelProjectionInput): Record<string, unknown> {
  const rawPayload =
    input.raw?.payload && typeof input.raw.payload === "object" && !Array.isArray(input.raw.payload)
      ? input.raw.payload
      : {};
  const rawFields = extractRawPayloadFields(rawPayload);
  const processedFields = extractProcessedResultFields(input.processed?.result);

  const title = processedFields.title ?? input.meta.name;
  const publishedAtIso =
    processedFields.publishedAt ??
    resolvePublishedAtFromRawPayload(rawPayload) ??
    (input.meta.publishedAt ? input.meta.publishedAt.toISOString() : null);
  const publishedAt =
    typeof publishedAtIso === "string" ? toDateOrFallback(publishedAtIso, input.meta.sortAt) : null;
  const sortAt = publishedAt ?? input.meta.sortAt ?? input.meta.createdAt;
  const sourceName = processedFields.source ?? rawFields.sourceName ?? null;
  const region = processedFields.region ?? rawFields.region ?? null;
  const location = processedFields.location ?? rawFields.location ?? region;
  const topics = processedFields.topics.slice(0, 20);
  const entities = processedFields.entities.slice(0, 20);
  const tags = Array.isArray(input.processed?.tags)
    ? Array.from(new Set(input.processed.tags.map((tag) => tag.trim()).filter(Boolean)))
    : [];
  const searchParts = [
    title,
    input.meta.externalId,
    sourceName,
    rawFields.summary,
    processedFields.summary,
    rawFields.url,
    rawFields.ticker,
    region,
    location,
    ...topics,
    ...entities,
    ...tags,
  ].filter((entry): entry is string => Boolean(entry && entry.trim().length > 0));

  const searchTerms = Array.from(
    new Set(
      searchParts
        .flatMap((entry) =>
          entry
            .toLowerCase()
            .split(/[^a-z0-9_\u00c0-\u024f\u4e00-\u9fff]+/i)
            .map((term) => term.trim())
            .filter((term) => term.length >= 2),
        )
        .slice(0, 240),
    ),
  );

  const normalizedSummary = processedFields.summary ?? rawFields.summary ?? null;
  const sourceId = normalizeNonEmptyString(input.sourceId ?? input.processed?.sourceId) ?? null;
  const embeddingDimensions =
    typeof input.processed?.summaryEmbeddingDimensions === "number" &&
    Number.isFinite(input.processed.summaryEmbeddingDimensions)
      ? input.processed.summaryEmbeddingDimensions
      : null;

  return {
    orgId: input.meta.orgId,
    itemMetaId: input.meta.id,
    meta: {
      id: input.meta.id,
      externalId: input.meta.externalId,
      name: input.meta.name,
      status: input.meta.status,
      mongoRef: input.meta.mongoRef,
      version: input.meta.version,
      publishedAt: input.meta.publishedAt ?? null,
      sortAt: input.meta.sortAt ?? input.meta.createdAt,
      createdAt: input.meta.createdAt,
      updatedAt: input.meta.updatedAt,
    },
    raw: input.raw
      ? {
          id: input.raw.id,
          itemMetaId: input.raw.itemMetaId,
          source: input.raw.source ?? null,
          payload: rawPayload,
          createdAt: input.raw.createdAt,
          updatedAt: input.raw.updatedAt,
        }
      : null,
    processed: input.processed
      ? {
          id: input.processed.id,
          itemMetaId: input.processed.itemMetaId,
          rawItemId: input.processed.rawItemId ?? null,
          pipelineJobId: input.processed.pipelineJobId ?? null,
          sourceId,
          status: input.processed.status,
          error: input.processed.error ?? null,
          tags,
          result: normalizeProcessedResult(input.processed.result),
          duplicateOf: input.processed.duplicateOf ?? null,
          duplicateSimilarity:
            typeof input.processed.duplicateSimilarity === "number" &&
            Number.isFinite(input.processed.duplicateSimilarity)
              ? input.processed.duplicateSimilarity
              : null,
          summaryEmbeddingModel: input.processed.summaryEmbeddingModel ?? null,
          summaryEmbeddingDimensions: embeddingDimensions,
          llm: input.processed.llm ?? null,
          createdAt: input.processed.createdAt,
          updatedAt: input.processed.updatedAt,
        }
      : null,
    externalId: input.meta.externalId,
    externalIdLower: input.meta.externalId.toLowerCase(),
    title,
    titleLower: title.toLowerCase(),
    status: input.meta.status,
    ingestedAt: input.meta.createdAt,
    createdAt: input.meta.createdAt,
    updatedAt: input.meta.updatedAt,
    publishedAt,
    sortAt,
    sourceId,
    sourceName,
    sourceNameLower: sourceName ? sourceName.toLowerCase() : null,
    url: rawFields.url ?? null,
    thumbnail: rawFields.thumbnail ?? null,
    domain: normalizeUrlDomain(rawFields.url ?? null),
    language: processedFields.language ?? normalizeNonEmptyString((rawPayload as { language?: unknown }).language),
    summary: normalizedSummary,
    topics,
    topicKeys: topics.map((topic) => topic.toLowerCase()),
    entities,
    entityKeys: entities.map((entity) => entity.toLowerCase()),
    region,
    regionKey: region ? region.toLowerCase() : null,
    location,
    locationKey: location ? location.toLowerCase() : null,
    sentiment: processedFields.sentiment ? processedFields.sentiment.toLowerCase() : null,
    contentType: processedFields.contentType,
    qualityScore: processedFields.qualityScore,
    duplicateOf: input.processed?.duplicateOf ?? null,
    duplicateSimilarity:
      typeof input.processed?.duplicateSimilarity === "number" &&
      Number.isFinite(input.processed.duplicateSimilarity)
        ? input.processed.duplicateSimilarity
        : null,
    tags,
    hasVector: Boolean(input.processed?.summaryEmbeddingModel && embeddingDimensions && embeddingDimensions > 0),
    embeddingModel: input.processed?.summaryEmbeddingModel ?? null,
    searchText: searchParts.join("\n"),
    searchTerms,
    projectionUpdatedAt: new Date(),
  };
}

function normalizeUrlDomain(value: string | null): string | null {
  const candidate = normalizeNonEmptyString(value);
  if (!candidate) {
    return null;
  }
  const parse = (input: string): string | null => {
    try {
      const url = new URL(input);
      const hostname = url.hostname.trim().toLowerCase().replace(/^www\./, "");
      return hostname.length > 0 ? hostname : null;
    } catch {
      return null;
    }
  };
  return parse(candidate) ?? parse(`https://${candidate}`);
}

export function itemReadModelToMetaGraph(doc: ItemReadModel): ItemMetaGraphRecord {
  return {
    id: doc.meta.id,
    externalId: doc.meta.externalId,
    name: doc.meta.name,
    status: doc.meta.status,
    mongoRef: doc.meta.mongoRef,
    createdAt: doc.meta.createdAt,
    updatedAt: doc.meta.updatedAt,
  };
}

export function itemReadModelToRawGraph(doc: ItemReadModel): RawGraphRecord | null {
  if (!doc.raw) {
    return null;
  }
  return {
    id: doc.raw.id,
    itemMetaId: doc.raw.itemMetaId,
    payload: JSON.stringify(doc.raw.payload ?? {}),
    source: doc.raw.source ?? undefined,
    createdAt: doc.raw.createdAt,
    updatedAt: doc.raw.updatedAt,
  };
}

export function itemReadModelToRawPreviewGraph(doc: ItemReadModel): RawPreviewGraphRecord | null {
  if (!doc.raw) {
    return null;
  }
  return extractRawPayloadFields(doc.raw.payload as Record<string, unknown>);
}

export function itemReadModelToProcessedGraph(doc: ItemReadModel): ProcessedGraphRecord | null {
  if (!doc.processed) {
    return null;
  }
  const normalizedResult = normalizeProcessedResult(doc.processed.result);
  const resultJson =
    normalizedResult && typeof normalizedResult === "object" && !Array.isArray(normalizedResult)
      ? (normalizedResult as Record<string, unknown>)
      : null;
  return {
    id: doc.processed.id,
    itemMetaId: doc.processed.itemMetaId,
    status: doc.processed.status,
    error: doc.processed.error ?? null,
    tags: doc.processed.tags ?? [],
    result: normalizedResult === null ? undefined : JSON.stringify(normalizedResult),
    resultJson,
    duplicateOf: doc.processed.duplicateOf ?? null,
    duplicateSimilarity: doc.processed.duplicateSimilarity ?? null,
    llm: doc.processed.llm ?? null,
    summaryEmbeddingModel: doc.processed.summaryEmbeddingModel ?? null,
    summaryEmbeddingDimensions: doc.processed.summaryEmbeddingDimensions ?? null,
    createdAt: doc.processed.createdAt,
  };
}

export function itemReadModelToProcessedPreviewGraph(
  doc: ItemReadModel,
): ProcessedPreviewGraphRecord | null {
  if (!doc.processed) {
    return null;
  }
  const extracted = extractProcessedResultFields(doc.processed.result);
  return {
    id: doc.processed.id,
    itemMetaId: doc.processed.itemMetaId,
    status: doc.processed.status,
    tags: doc.processed.tags ?? [],
    duplicateOf: doc.processed.duplicateOf ?? null,
    duplicateSimilarity: doc.processed.duplicateSimilarity ?? null,
    llm: doc.processed.llm ?? null,
    source: extracted.source,
    title: extracted.title,
    language: extracted.language,
    publishedAt:
      extracted.publishedAt ??
      (doc.publishedAt instanceof Date && Number.isFinite(doc.publishedAt.getTime())
        ? doc.publishedAt.toISOString()
        : null),
    summary: extracted.summary,
    sentiment: extracted.sentiment,
    contentType: extracted.contentType,
    topics: extracted.topics,
    entities: extracted.entities,
    qualityScore: extracted.qualityScore,
    location: extracted.location ?? extracted.region,
    createdAt: doc.processed.createdAt,
  };
}

export function itemReadModelPublishedAt(doc: ItemReadModel): string | null {
  if (doc.publishedAt instanceof Date && Number.isFinite(doc.publishedAt.getTime())) {
    return doc.publishedAt.toISOString();
  }
  if (doc.processed) {
    const fromProcessed = resolvePublishedAtFromProcessedResult(doc.processed.result);
    if (fromProcessed) {
      return fromProcessed;
    }
  }
  if (doc.raw) {
    return resolvePublishedAtFromRawPayload(doc.raw.payload as Record<string, unknown>);
  }
  return null;
}
