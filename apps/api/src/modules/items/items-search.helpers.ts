import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { ItemStatus } from "../../common/pipeline-status";

import {
  DEFAULT_RECENCY_HALFLIFE_HOURS,
  DEFAULT_SOURCE_TRUST_SCORE,
  FULLTEXT_MIN_TOKEN_LENGTH,
  ITEMS_FILTERS_SEARCH_PREFIX,
  ITEMS_VECTOR_SEARCH_PREFIX,
  MAX_FACET_OPTIONS,
  MONGO_MIN_TOKEN_LENGTH,
  SEARCH_SUGGESTIONS_MIN_SEMANTIC_CHARS,
  SOURCE_TRUST_SCORE_MAP,
  type ItemDateRangeFilter,
  type ItemFilters,
  type ParsedSearchPayload,
  type SearchCandidateSource,
  type SearchStrategy,
  type ItemsRankingMode,
} from "./items.shared";

export function buildProcessedSortAtExpression() {
  return {
    $ifNull: [
      "$sortAt",
      {
        $dateFromString: {
          dateString: { $ifNull: ["$result.published_at", null] },
          onError: { $ifNull: ["$ingestedAt", "$createdAt"] },
          onNull: { $ifNull: ["$ingestedAt", "$createdAt"] },
        },
      },
    ],
  };
}

export function resolveProcessedSortAt(record: {
  sortAt?: Date | string | null;
  ingestedAt?: Date | string | null;
  createdAt?: Date | string | null;
  result?: unknown;
}): Date | null {
  const directSortAt = asDate(record.sortAt);
  if (directSortAt) {
    return directSortAt;
  }

  const result =
    record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : null;
  const publishedAt = asDate(result?.published_at ?? null);
  if (publishedAt) {
    return publishedAt;
  }

  return asDate(record.ingestedAt) ?? asDate(record.createdAt);
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

export function dedupeItemMetaIds(ids: string[]): string[] {
  return Array.from(
    new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id): id is string => id.length > 0),
    ),
  );
}

export function rankSearchCandidateIds(
  sources: Partial<Record<SearchCandidateSource, string[]>>,
): string[] {
  const weights: Record<SearchCandidateSource, number> = {
    meta: 1.3,
    processed: 1.15,
    processedArticle: 1.05,
    vector: 1.45,
    elasticsearch: 1.6,
  };
  const scoreById = new Map<
    string,
    { score: number; bestRank: number; sourceCount: number }
  >();

  (Object.entries(sources) as [SearchCandidateSource, string[] | undefined][])
    .forEach(([source, ids]) => {
      const uniqueIds = dedupeItemMetaIds(ids ?? []);
      uniqueIds.forEach((id, index) => {
        const rankScore = weights[source] / (1 + index / 20);
        const current = scoreById.get(id);
        if (!current) {
          scoreById.set(id, {
            score: rankScore,
            bestRank: index,
            sourceCount: 1,
          });
          return;
        }
        current.score += rankScore;
        current.sourceCount += 1;
        current.bestRank = Math.min(current.bestRank, index);
      });
    });

  return Array.from(scoreById.entries())
    .map(([id, entry]) => ({
      id,
      score: entry.score + Math.max(0, entry.sourceCount - 1) * 0.2,
      bestRank: entry.bestRank,
    }))
    .sort((left, right) => {
      if (Math.abs(right.score - left.score) > 1e-9) {
        return right.score - left.score;
      }
      if (left.bestRank !== right.bestRank) {
        return left.bestRank - right.bestRank;
      }
      return left.id.localeCompare(right.id);
    })
    .map((entry) => entry.id);
}

export function parseSearchPayload(search?: string): ParsedSearchPayload {
  const normalized = search?.trim();
  if (!normalized) {
    return {};
  }
  if (!normalized.startsWith(ITEMS_FILTERS_SEARCH_PREFIX)) {
    return { search: normalized };
  }
  const payload = normalized.slice(ITEMS_FILTERS_SEARCH_PREFIX.length);
  if (!payload) {
    return {};
  }
  try {
    const decoded = decodeURIComponent(payload);
    const parsed = JSON.parse(decoded) as { q?: unknown; filters?: unknown };
    const searchValue = typeof parsed.q === "string" ? parsed.q.trim() : undefined;
    return {
      search: searchValue || undefined,
      filters: normalizeFilters(parsed.filters)
    };
  } catch {
    return { search: normalized };
  }
}

export function normalizeFilters(raw: unknown): ItemFilters | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = raw as Record<string, unknown>;
  const sourceIds = normalizeFilterList(input.sourceIds);
  const regions = normalizeFilterList(input.regions);
  const topics = normalizeFilterList(input.topics);
  const sentiments = normalizeFilterList(input.sentiments, { lowerCase: true });
  const contentTypes = normalizeFilterList(input.contentTypes, {
    lowerCase: true,
  });
  const excludeDuplicates = input.excludeDuplicates === true;
  const dateRange = normalizeDateRange(input.dateRange);
  if (
    !sourceIds &&
    !regions &&
    !topics &&
    !sentiments &&
    !contentTypes &&
    !excludeDuplicates &&
    !dateRange
  ) {
    return undefined;
  }
  return {
    sourceIds,
    regions,
    topics,
    sentiments,
    contentTypes,
    ...(excludeDuplicates ? { excludeDuplicates: true } : {}),
    dateRange
  };
}

export function normalizeFilterList(
  value: unknown,
  options?: { lowerCase?: boolean }
): string[] | undefined {
  const values = Array.isArray(value) ? value : [];
  const normalized = values
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => (options?.lowerCase ? entry.toLowerCase() : entry));
  if (normalized.length === 0) {
    return undefined;
  }
  return Array.from(new Set(normalized));
}

export function normalizeDateRange(raw: unknown): ItemDateRangeFilter | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = raw as Record<string, unknown>;
  const start = parseDateValue(input.start);
  const end = parseDateValue(input.end);
  if (!start && !end) {
    return undefined;
  }
  return { start, end };
}

export function parseDateValue(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.valueOf())) {
      return parsed;
    }
  }
  return undefined;
}

export function hasActiveFilters(filters?: ItemFilters): boolean {
  if (!filters) {
    return false;
  }
  return Boolean(
    (filters.sourceIds && filters.sourceIds.length > 0) ||
    (filters.regions && filters.regions.length > 0) ||
    (filters.topics && filters.topics.length > 0) ||
    (filters.sentiments && filters.sentiments.length > 0) ||
    (filters.contentTypes && filters.contentTypes.length > 0) ||
    filters.excludeDuplicates === true ||
    filters.dateRange?.start ||
    filters.dateRange?.end
  );
}

export function combineSearchAndFilterIds(
  searchIds?: string[],
  filterIds?: string[]
): string[] | null {
  if (searchIds && filterIds) {
    const filterSet = new Set(filterIds);
    const intersection = searchIds.filter((id) => filterSet.has(id));
    return Array.from(new Set(intersection));
  }
  if (searchIds) {
    return Array.from(new Set(searchIds));
  }
  if (filterIds) {
    return Array.from(new Set(filterIds));
  }
  return null;
}

export function resolveSearchStrategy(search?: string): SearchStrategy {
  const normalized = search?.trim();
  if (!normalized) {
    return { type: "none" };
  }

  const fullTextQuery = buildFullTextQuery(normalized);
  if (fullTextQuery) {
    return { type: "fulltext", query: fullTextQuery };
  }

  return { type: "prefix", term: normalized };
}

export function incrementFacetCount(target: Map<string, number>, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  target.set(trimmed, (target.get(trimmed) ?? 0) + 1);
}

export function buildFacetOptions(target: Map<string, number>) {
  return Array.from(target.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, MAX_FACET_OPTIONS)
    .map(([value, count]) => ({ value, count }));
}

export function buildFullTextQuery(search: string): string | null {
  const tokens = tokenizeSearch(search, FULLTEXT_MIN_TOKEN_LENGTH);

  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `${token}*`).join(" ");
}

export function tokenizeSearch(search: string, minLength: number) {
  return search
    .split(/\s+/)
    .map((token) => token.replace(/[+-><()~"*@]+/g, ""))
    .filter((token) => token.length >= minLength);
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cosineSimilarity(a: number[], b: number[]) {
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

export function vectorSearchCacheKey(orgId: string, query: string) {
  const hash = createHash("sha256").update(query).digest("hex");
  return `${ITEMS_VECTOR_SEARCH_PREFIX}${orgId}:${hash}`;
}

export function buildReadModelBaseMatch(orgId: string): Record<string, unknown> {
  return {
    orgId,
    status: { $ne: ItemStatus.Duplicate },
  };
}

export function buildReadModelMatchFromItemMetaWhere(
  orgId: string,
  where: Prisma.ItemMetaWhereInput,
): Record<string, unknown> {
  const baseMatch = buildReadModelBaseMatch(orgId);
  const conditions: Record<string, unknown>[] = [baseMatch];
  const record = where as Record<string, unknown>;
  const idFilter =
    record.id && typeof record.id === "object" && !Array.isArray(record.id)
      ? (record.id as Record<string, unknown>)
      : null;
  if (typeof record.id === "string" && record.id.trim().length > 0) {
    conditions.push({ itemMetaId: record.id.trim() });
  } else if (idFilter?.in && Array.isArray(idFilter.in) && idFilter.in.length > 0) {
    conditions.push({
      itemMetaId: {
        $in: idFilter.in.filter((value): value is string => typeof value === "string" && value.trim().length > 0),
      },
    });
  }
  return conditions.length === 1 ? baseMatch : { $and: conditions };
}

export function buildReadModelMatch(orgId: string, filters?: ItemFilters): Record<string, unknown> {
  const baseMatch = buildReadModelBaseMatch(orgId);
  const conditions: Record<string, unknown>[] = [baseMatch];
  const normalizedFilters = filters ? normalizeFilters(filters) ?? filters : undefined;
  if (!normalizedFilters) {
    return baseMatch;
  }

  if (normalizedFilters.sourceIds?.length) {
    conditions.push({ sourceId: { $in: normalizedFilters.sourceIds } });
  }
  if (normalizedFilters.regions?.length) {
    const values = normalizedFilters.regions.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (values.length > 0) {
      conditions.push({
        $or: [{ regionKey: { $in: values } }, { locationKey: { $in: values } }],
      });
    }
  }
  if (normalizedFilters.topics?.length) {
    const values = normalizedFilters.topics.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (values.length > 0) {
      conditions.push({
        $or: [{ topicKeys: { $in: values } }, { entityKeys: { $in: values } }],
      });
    }
  }
  if (normalizedFilters.sentiments?.length) {
    const values = normalizedFilters.sentiments.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (values.length > 0) {
      conditions.push({ sentiment: { $in: values } });
    }
  }
  if (normalizedFilters.contentTypes?.length) {
    const values = normalizedFilters.contentTypes.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (values.length > 0) {
      conditions.push({ contentType: { $in: values } });
    }
  }
  if (normalizedFilters.excludeDuplicates) {
    conditions.push({
      $or: [{ duplicateOf: null }, { duplicateOf: { $exists: false } }],
    });
  }
  if (normalizedFilters.dateRange?.start || normalizedFilters.dateRange?.end) {
    const sortAt: Record<string, Date> = {};
    if (normalizedFilters.dateRange.start) {
      sortAt.$gte = normalizedFilters.dateRange.start;
    }
    if (normalizedFilters.dateRange.end) {
      sortAt.$lte = normalizedFilters.dateRange.end;
    }
    conditions.push({ sortAt });
  }

  return conditions.length === 1 ? baseMatch : { $and: conditions };
}

export function shouldUseSemanticSuggestions(prefix: string) {
  const tokens = tokenizeSearch(prefix, MONGO_MIN_TOKEN_LENGTH);
  return tokens.length >= 2 || prefix.length >= SEARCH_SUGGESTIONS_MIN_SEMANTIC_CHARS;
}

export function collectSuggestionValuesFromProcessed(input: { tags?: unknown; result?: unknown }) {
  const resultRecord = normalizeResultRecord(input.result);
  const topicSet = new Set<string>();
  pickResultStringArray(resultRecord, ["topics"]).forEach((value) => topicSet.add(value));
  pickResultStringArray(resultRecord, ["entities"]).forEach((value) => topicSet.add(value));
  if (Array.isArray(input.tags)) {
    for (const tag of input.tags) {
      if (typeof tag !== "string") {
        continue;
      }
      const normalized = tag.trim();
      if (normalized) {
        topicSet.add(normalized);
      }
    }
  }

  const region = pickResultString(resultRecord, ["location", "region"]);
  const source = pickResultString(resultRecord, [
    "source",
    "sourceName",
    "source_name",
    "publisher"
  ]);

  const sentiments = new Set<string>();
  const sentiment = pickResultString(resultRecord, ["sentiment", "sentiment_label"]);
  if (sentiment) {
    const normalized = sentiment.toLowerCase();
    if (normalized === "positive" || normalized === "neutral" || normalized === "negative") {
      sentiments.add(normalized);
    }
  }
  if (Array.isArray(input.tags)) {
    for (const tag of input.tags) {
      if (typeof tag !== "string") {
        continue;
      }
      const normalized = tag.trim().toLowerCase();
      if (normalized === "positive" || normalized === "neutral" || normalized === "negative") {
        sentiments.add(normalized);
      }
    }
  }

  return {
    topics: Array.from(topicSet).slice(0, 10),
    regions: region ? [region] : [],
    sources: source ? [source] : [],
    sentiments: Array.from(sentiments)
  };
}

export function pushSemanticSuggestions(
  bucket: Map<
    string,
    { type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT"; value: string; score: number }
  >,
  values: string[],
  type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT",
  normalizedPrefix: string,
  tokens: string[],
  baseScore: number
) {
  for (const value of values) {
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue) {
      continue;
    }
    const startsWithPrefix = normalizedValue.startsWith(normalizedPrefix);
    const containsPrefix = normalizedValue.includes(normalizedPrefix);
    const tokenHits = tokens.filter((token) => normalizedValue.includes(token)).length;
    if (
      !startsWithPrefix &&
      !containsPrefix &&
      tokenHits === 0 &&
      tokens.length < 2 &&
      normalizedPrefix.length < SEARCH_SUGGESTIONS_MIN_SEMANTIC_CHARS
    ) {
      continue;
    }

    const score =
      baseScore +
      (startsWithPrefix ? 48 : 0) +
      (containsPrefix ? 24 : 0) +
      tokenHits * 10;

    const key = `${type}:${normalizedValue}`;
    const current = bucket.get(key);
    if (!current) {
      bucket.set(key, { type, value: value.trim(), score });
      continue;
    }
    current.score += score;
  }
}

export function buildMongoTextSearchQuery(strategy: SearchStrategy): string | null {
  if (strategy.type !== "fulltext") {
    return null;
  }

  const tokens = strategy.query
    .split(/\s+/)
    .map((token) => token.replace(/\*+$/g, "").trim())
    .filter((token) => token.length >= FULLTEXT_MIN_TOKEN_LENGTH);

  return tokens.length > 0 ? tokens.join(" ") : null;
}

export function resolveRankingMode(mode: ItemsRankingMode, search?: string) {
  if (mode === "RELEVANCE" && typeof search === "string" && search.trim().length > 0) {
    return "RELEVANCE" as const;
  }
  return "RECENCY" as const;
}

export function normalizeResultRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function pickResultString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

export function pickResultNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

export function pickResultStringArray(record: Record<string, unknown>, keys: string[]) {
  const values: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          values.push(trimmed);
        }
        continue;
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const name = (entry as { name?: unknown }).name;
        if (typeof name === "string" && name.trim().length > 0) {
          values.push(name.trim());
        }
      }
    }
  }
  return Array.from(new Set(values));
}

export function computeLexicalScore(query: string, document: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const normalizedDoc = document.trim().toLowerCase();
  if (!normalizedDoc) {
    return 0;
  }
  if (normalizedDoc.includes(normalizedQuery)) {
    return 1;
  }
  const tokens = tokenizeSearch(normalizedQuery, MONGO_MIN_TOKEN_LENGTH);
  if (tokens.length === 0) {
    return 0;
  }
  const matched = tokens.filter((token) => normalizedDoc.includes(token.toLowerCase())).length;
  return clamp01(matched / tokens.length);
}

export function computeRecencyScore(timestamp: Date, halfLifeHours = DEFAULT_RECENCY_HALFLIFE_HOURS) {
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) {
    return 0;
  }
  const halfLifeMs = Math.max(1, halfLifeHours) * 60 * 60 * 1000;
  const ageMs = Math.max(0, Date.now() - timestamp.getTime());
  const decay = Math.exp((-Math.log(2) * ageMs) / halfLifeMs);
  return clamp01(decay);
}

export function computeSourceTrustScore(source?: string | null) {
  const normalized = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (!normalized) {
    return DEFAULT_SOURCE_TRUST_SCORE;
  }
  for (const [needle, score] of Object.entries(SOURCE_TRUST_SCORE_MAP)) {
    if (normalized.includes(needle)) {
      return score;
    }
  }
  return DEFAULT_SOURCE_TRUST_SCORE;
}

export function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

export function buildBaseWhere(orgId: string) {
  return { orgId, status: { not: ItemStatus.Duplicate } };
}

export function buildPrefixWhere(baseWhere: { orgId: string; status: { not: string } }, term: string) {
  return {
    ...baseWhere,
    OR: [
      { name: { startsWith: term } },
      { externalId: { startsWith: term } }
    ]
  };
}
