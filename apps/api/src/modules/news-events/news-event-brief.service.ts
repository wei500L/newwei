import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import { safeJsonParseFromText } from "../../common/llm-json";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";
import { PrismaService } from "../config/prisma.service";

import { NewsEventBriefPayloadSchema, type NewsEventBriefPayload } from "./news-event-brief.schema";

const logger = createLogger({ name: "news-event-brief" });

interface BriefSource {
  index: number;
  url: string;
  sourceLabel: string | null;
  title: string | null;
  publishedAt: Date | null;
  processedItemId: string | null;
  processedArticleId: string | null;
  summary: string | null;
  keyPoints: string[];
}

interface CachedBriefSourceV1 {
  index: number;
  url: string;
  sourceLabel: string | null;
  title: string | null;
  publishedAt: string | null;
  processedItemId: string | null;
  processedArticleId: string | null;
}

interface CachedBriefV1 {
  version: 1;
  language: string;
  fingerprint: string;
  generatedAt: string;
  sources: CachedBriefSourceV1[];
  payload: NewsEventBriefPayload;
}

const EVENT_BRIEF_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(NewsEventBriefPayloadSchema, { $refStrategy: "none" });

const EVENT_BRIEF_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "news_event_brief_v1",
    schema: EVENT_BRIEF_JSON_SCHEMA
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(entries)).slice(0, 20);
}

function sanitizeCitations(citations: number[], max: number) {
  const filtered = citations
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= max)
    .slice(0, 12);
  return Array.from(new Set(filtered)).sort((a, b) => a - b);
}

function sanitizePayload(payload: NewsEventBriefPayload, maxSources: number): NewsEventBriefPayload {
  const sanitizePoint = (point: { text: string; citations: number[] }) => ({
    text: point.text.trim(),
    citations: sanitizeCitations(point.citations ?? [], maxSources)
  });

  return {
    ...payload,
    detailed_summary: payload.detailed_summary.trim(),
    tldr: payload.tldr.trim(),
    key_points: (payload.key_points ?? []).map(sanitizePoint).filter((p) => p.text.length > 0),
    why_it_matters: (payload.why_it_matters ?? []).map(sanitizePoint).filter((p) => p.text.length > 0),
    latest_update: payload.latest_update ? sanitizePoint(payload.latest_update) : payload.latest_update,
    what_to_watch: (payload.what_to_watch ?? []).map(sanitizePoint).filter((p) => p.text.length > 0),
    comparison: payload.comparison
      ? {
          consensus: (payload.comparison.consensus ?? []).map(sanitizePoint).filter((p) => p.text.length > 0),
          divergence: (payload.comparison.divergence ?? []).map(sanitizePoint).filter((p) => p.text.length > 0)
        }
      : undefined
  };
}

function computeFingerprint(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function safeReadCachedBrief(metadata: unknown): CachedBriefV1 | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const brief = metadata.briefV1;
  if (!isRecord(brief)) {
    return null;
  }
  if (brief.version !== 1) {
    return null;
  }
  const language = normalizeOptionalString(brief.language);
  const fingerprint = normalizeOptionalString(brief.fingerprint);
  const generatedAt = normalizeOptionalString(brief.generatedAt);
  const sources = Array.isArray(brief.sources) ? brief.sources : null;
  const payload = isRecord(brief.payload) ? brief.payload : null;
  if (!language || !fingerprint || !generatedAt || !sources || !payload) {
    return null;
  }

  try {
    const parsedPayload = NewsEventBriefPayloadSchema.parse(payload);
    const parsedSources = sources
      .map((entry) => (isRecord(entry) ? entry : null))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        index: typeof entry.index === "number" ? entry.index : null,
        url: normalizeOptionalString(entry.url),
        sourceLabel: normalizeOptionalString(entry.sourceLabel) ?? null,
        title: normalizeOptionalString(entry.title) ?? null,
        publishedAt: normalizeOptionalString(entry.publishedAt) ?? null,
        processedItemId: normalizeOptionalString(entry.processedItemId) ?? null,
        processedArticleId: normalizeOptionalString(entry.processedArticleId) ?? null
      }))
      .filter((entry): entry is CachedBriefSourceV1 => typeof entry.index === "number" && entry.index >= 1 && Boolean(entry.url))
      .map((entry) => ({
        ...entry,
        url: entry.url as string
      }));

    return {
      version: 1,
      language,
      fingerprint,
      generatedAt,
      sources: parsedSources,
      payload: parsedPayload
    };
  } catch {
    return null;
  }
}

@Injectable()
export class NewsEventBriefService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly litellm: LiteLlmService
  ) {}

  async getBrief(
    orgId: string,
    eventId: string,
    options?: { language?: string; maxSources?: number; forceRefresh?: boolean }
  ): Promise<{
    version: 1;
    generatedAt: Date;
    language: string;
    payload: NewsEventBriefPayload;
    sources: Array<Omit<BriefSource, "summary" | "keyPoints">>;
  } | null> {
    const language = this.normalizeLanguage(options?.language);
    const maxSources = this.normalizeMaxSources(options?.maxSources);
    const forceRefresh = options?.forceRefresh === true;

    const row = await this.prisma.newsEvent.findFirst({
      where: { orgId, id: eventId },
      include: {
        items: {
          orderBy: [{ createdAt: "desc" }],
          take: 200,
          include: {
            processedArticle: {
              include: {
                article: {
                  select: {
                    id: true,
                    url: true,
                    sourceLabel: true,
                    crawlAt: true
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!row) {
      return null;
    }

    const sources = this.selectSources(row.items ?? [], maxSources);
    if (sources.length === 0) {
      return null;
    }

    const fingerprint = computeFingerprint({
      version: 1,
      language,
      lastAt: row.lastAt?.toISOString?.() ?? null,
      sources: sources.map((source) => ({
        processedArticleId: source.processedArticleId,
        processedItemId: source.processedItemId,
        url: source.url
      }))
    });

    const cached = safeReadCachedBrief(row.metadata);
    if (!forceRefresh && cached && cached.version === 1 && cached.language === language && cached.fingerprint === fingerprint) {
      const generatedAt = new Date(cached.generatedAt);
      const parsedSources = cached.sources
        .map((source) => {
          const publishedAt = source.publishedAt ? new Date(source.publishedAt) : null;
          return {
            index: source.index,
            url: source.url,
            sourceLabel: source.sourceLabel,
            title: source.title,
            publishedAt: publishedAt && Number.isFinite(publishedAt.valueOf()) ? publishedAt : null,
            processedItemId: source.processedItemId,
            processedArticleId: source.processedArticleId
          };
        });
      return {
        version: 1,
        generatedAt: Number.isFinite(generatedAt.valueOf()) ? generatedAt : new Date(),
        language,
        payload: sanitizePayload(cached.payload, cached.sources.length),
        sources: parsedSources
      };
    }

    const generatedAt = new Date();
    const payload = await this.generateBriefWithLlm(
      orgId,
      {
        title: row.title ?? row.primaryEntity ?? row.primaryTopic ?? row.id,
        summary: row.summary ?? null,
        startAt: row.startAt,
        lastAt: row.lastAt,
        language: row.language ?? null
      },
      sources,
      language
    );

    const sanitizedPayload = sanitizePayload(payload, sources.length);
    const cacheSources: CachedBriefSourceV1[] = sources.map((source) => ({
      index: source.index,
      url: source.url,
      sourceLabel: source.sourceLabel,
      title: source.title,
      publishedAt: source.publishedAt ? source.publishedAt.toISOString() : null,
      processedItemId: source.processedItemId,
      processedArticleId: source.processedArticleId
    }));

    const nextMetadata = this.mergeMetadata(row.metadata, {
      briefV1: {
        version: 1,
        language,
        fingerprint,
        generatedAt: generatedAt.toISOString(),
        sources: cacheSources,
        payload: sanitizedPayload
      } satisfies CachedBriefV1
    });

    try {
      await this.prisma.newsEvent.update({
        where: { id: row.id },
        data: { metadata: nextMetadata as Prisma.InputJsonValue }
      });
    } catch (error) {
      logger.warn({ err: error, orgId, eventId: row.id }, "Failed to cache news event brief");
    }

    return {
      version: 1,
      generatedAt,
      language,
      payload: sanitizedPayload,
      sources: cacheSources.map((source) => ({
        index: source.index,
        url: source.url,
        sourceLabel: source.sourceLabel,
        title: source.title,
        publishedAt: source.publishedAt ? new Date(source.publishedAt) : null,
        processedItemId: source.processedItemId,
        processedArticleId: source.processedArticleId
      }))
    };
  }

  private normalizeLanguage(value?: string) {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
      return "zh";
    }
    const lower = normalized.toLowerCase();
    if (lower.startsWith("zh")) {
      return "zh";
    }
    if (lower.startsWith("en")) {
      return "en";
    }
    return lower.length <= 8 ? lower : "zh";
  }

  private normalizeMaxSources(value?: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 10;
    }
    return Math.max(3, Math.min(20, Math.round(value)));
  }

  private mergeMetadata(current: unknown, updates: Record<string, unknown>) {
    const base = isRecord(current) ? current : {};
    return { ...base, ...updates };
  }

  private selectSources(items: any[], maxSources: number): BriefSource[] {
    const candidates = items
      .map((item) => {
        const processed = item?.processedArticle;
        const article = processed?.article;
        const url = normalizeOptionalString(article?.url);
        if (!url) {
          return null;
        }
        const sourceLabel = normalizeOptionalString(article?.sourceLabel) ?? normalizeOptionalString(processed?.source) ?? null;
        const title = normalizeOptionalString(processed?.title) ?? null;
        const summary = normalizeOptionalString(processed?.summary) ?? null;
        const publishedAt = processed?.publishedAt instanceof Date ? processed.publishedAt : null;
        const crawlAt = article?.crawlAt instanceof Date ? article.crawlAt : null;
        const processedAt = processed?.processedAt instanceof Date ? processed.processedAt : null;
        const timestamp = publishedAt ?? crawlAt ?? processedAt;
        const processedItemId = normalizeOptionalString(item?.processedItemId) ?? null;
        const processedArticleId = normalizeOptionalString(item?.processedArticleId) ?? normalizeOptionalString(processed?.id) ?? null;

        return {
          url,
          sourceLabel,
          title,
          summary,
          publishedAt: publishedAt ?? null,
          processedItemId,
          processedArticleId,
          keyPoints: normalizeStringList(processed?.keyPoints),
          timestamp: timestamp ?? new Date(0)
        } as const;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => b.timestamp.valueOf() - a.timestamp.valueOf());

    const uniqueByUrl = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      if (!uniqueByUrl.has(candidate.url)) {
        uniqueByUrl.set(candidate.url, candidate);
      }
    }

    const deduped = Array.from(uniqueByUrl.values());
    const picked: (typeof deduped)[number][] = [];
    const usedSourceKeys = new Set<string>();

    const sourceKeyFor = (entry: (typeof deduped)[number]) => {
      const label = entry.sourceLabel?.toLowerCase().trim() ?? "";
      if (label) {
        return label;
      }
      try {
        return new URL(entry.url).hostname.toLowerCase();
      } catch {
        return entry.url;
      }
    };

    for (const entry of deduped) {
      if (picked.length >= maxSources) break;
      const key = sourceKeyFor(entry);
      if (usedSourceKeys.has(key)) {
        continue;
      }
      usedSourceKeys.add(key);
      picked.push(entry);
    }

    if (picked.length < maxSources) {
      for (const entry of deduped) {
        if (picked.length >= maxSources) break;
        if (picked.includes(entry)) continue;
        picked.push(entry);
      }
    }

    return picked.map((entry, idx) => ({
      index: idx + 1,
      url: entry.url,
      sourceLabel: entry.sourceLabel,
      title: entry.title,
      summary: entry.summary,
      keyPoints: entry.keyPoints,
      publishedAt: entry.publishedAt,
      processedItemId: entry.processedItemId,
      processedArticleId: entry.processedArticleId
    }));
  }

  private buildSystemPrompt(language: string) {
    const languageHint = language === "zh" ? "Write all free-text fields in Simplified Chinese." : `Write all free-text fields in ${language}.`;
    return [
      "You are an editor producing a one-page brief for a general audience.",
      "Use ONLY the provided sources. Do NOT invent facts.",
      "Be concise, concrete, and avoid fluff. Prefer numbers, dates, and named entities when present.",
      "Every point MUST include citations: a non-empty list of 1-based source indexes that support the point.",
      "If sources disagree, capture it under comparison.divergence with citations for each side.",
      "If information is uncertain or missing, state uncertainty explicitly.",
      languageHint
    ].join(" ");
  }

  private buildUserPrompt(
    event: { title: string; summary: string | null; startAt: Date; lastAt: Date; language: string | null },
    sources: BriefSource[]
  ) {
    const eventSummary = event.summary ? truncate(event.summary, 600) : "";
    const sourceCount = sources.length;
    const sourcesSection = sources
      .map((source) => {
        const when = source.publishedAt ? source.publishedAt.toISOString() : "unknown";
        const summary = source.summary ? truncate(source.summary, 700) : "";
        const keyPoints = source.keyPoints.length > 0 ? truncate(source.keyPoints.slice(0, 8).join(" | "), 900) : "";
        const bits = [
          `[${source.index}] ${source.sourceLabel ?? "Unknown source"}`,
          `time: ${when}`,
          `title: ${source.title ?? ""}`,
          `url: ${source.url}`,
          summary ? `summary: ${summary}` : "",
          keyPoints ? `key_points: ${keyPoints}` : ""
        ].filter(Boolean);
        return bits.join("\n");
      })
      .join("\n\n");

    return [
      "Event:",
      `title: ${event.title}`,
      `startAt: ${event.startAt.toISOString()}`,
      `lastAt: ${event.lastAt.toISOString()}`,
      event.language ? `sourceLanguage: ${event.language}` : "",
      eventSummary ? `eventSummary: ${eventSummary}` : "",
      "",
      "Sources (use only these):",
      sourcesSection,
      "",
      "Output requirements:",
      `- Citation indexes must be within 1..${sourceCount}. Do not output points without at least one valid citation.`,
      "- detailed_summary: 4-8 paragraphs, narrative style, explain chronology, current status, disagreements, and near-term watchpoints.",
      "- tldr: 1-2 sentences summarizing what happened and the latest state.",
      "- key_points: 4-8 bullets covering core facts and chronology (each with citations).",
      "- why_it_matters: 2-5 bullets about impact (each with citations).",
      "- latest_update: one bullet describing what's newest/changed, or null if none (with citations).",
      "- what_to_watch: 3-6 bullets about what to monitor next (each with citations).",
      "- comparison.consensus: 2-5 bullets that multiple sources agree on (citations should include multiple indexes).",
      "- comparison.divergence: 0-5 bullets highlighting differences/unique claims (with citations).",
      "- limitations: optional, one sentence about data gaps."
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async generateBriefWithLlm(
    orgId: string,
    event: { title: string; summary: string | null; startAt: Date; lastAt: Date; language: string | null },
    sources: BriefSource[],
    language: string
  ): Promise<NewsEventBriefPayload> {
    const systemPrompt = this.buildSystemPrompt(language);
    const userPrompt = this.buildUserPrompt(event, sources);

    const response = await this.litellm.acompletion({
      orgId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 1200,
      response_format: EVENT_BRIEF_RESPONSE_FORMAT,
      metadata: {
        feature: "news_event_brief",
        eventTitle: event.title,
        sources: sources.length
      }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LiteLLM returned empty content for news event brief");
    }

    const parsed = safeJsonParseFromText<unknown>(content);
    if (!parsed) {
      logger.warn({ contentPreview: truncate(content, 280) }, "Failed to parse brief JSON from LiteLLM output");
      throw new Error("LiteLLM returned invalid JSON for news event brief");
    }

    return NewsEventBriefPayloadSchema.parse(parsed);
  }
}
