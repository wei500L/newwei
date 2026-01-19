export enum NewsSentimentLabel {
  Positive = "positive",
  Neutral = "neutral",
  Negative = "negative"
}

export interface NewsSignalEntity {
  name: string;
  type: string | null;
  confidence: number | null;
}

export interface NewsSignal {
  articleId: string;
  processedArticleId: string;
  processedItemId: string | null;
  timestamp: Date;
  language: string | null;
  title: string | null;
  summary: string | null;
  topics: string[];
  entities: NewsSignalEntity[];
  sentiment: NewsSentimentLabel | null;
  qualityScore: number | null;
}

export interface BuildNewsSignalFromProcessedArticleInput {
  processedArticle: {
    id: string;
    articleId: string;
    processedAt: Date | null;
    publishedAt: Date | null;
    language: string | null;
    title: string | null;
    summary: string | null;
    topics: unknown;
    entities: unknown;
    qualityScore: number | null;
    cleanedMarkdownRef: string | null;
  };
  article?: {
    crawlAt: Date | null;
    language?: string | null;
  } | null;
  processedItemResult?: unknown;
}

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeTopics = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const topics = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        return normalizeOptionalString(record.name) ?? normalizeOptionalString(record.topic) ?? "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(topics));
};

const normalizeEntities = (value: unknown): NewsSignalEntity[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const entities: NewsSignalEntity[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const normalized = normalizeOptionalString(entry);
      if (normalized) {
        entities.push({ name: normalized, type: null, confidence: null });
      }
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = normalizeOptionalString(record.name);
    if (!name) {
      continue;
    }

    const type = normalizeOptionalString(record.type);
    const rawConfidence = typeof record.confidence === "number" ? record.confidence : null;
    const confidence =
      rawConfidence === null || !Number.isFinite(rawConfidence)
        ? null
        : Math.max(0, Math.min(1, rawConfidence));

    entities.push({ name, type, confidence });
  }
  return entities;
};

const normalizeSentimentLabel = (value: unknown): NewsSentimentLabel | null => {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === NewsSentimentLabel.Positive || normalized.startsWith("pos")) {
    return NewsSentimentLabel.Positive;
  }
  if (normalized === NewsSentimentLabel.Negative || normalized.startsWith("neg")) {
    return NewsSentimentLabel.Negative;
  }
  if (normalized === NewsSentimentLabel.Neutral || normalized.startsWith("neu")) {
    return NewsSentimentLabel.Neutral;
  }
  return null;
};

const resolveTimestamp = (options: {
  publishedAt: Date | null;
  crawlAt: Date | null;
  processedAt: Date | null;
}): Date => {
  const publishedAtMs = options.publishedAt?.getTime();
  if (typeof publishedAtMs === "number" && Number.isFinite(publishedAtMs)) {
    return new Date(publishedAtMs);
  }

  const crawlAtMs = options.crawlAt?.getTime();
  if (typeof crawlAtMs === "number" && Number.isFinite(crawlAtMs)) {
    return new Date(crawlAtMs);
  }

  const processedAtMs = options.processedAt?.getTime();
  if (typeof processedAtMs === "number" && Number.isFinite(processedAtMs)) {
    return new Date(processedAtMs);
  }

  return new Date();
};

const extractSentimentFromProcessedItemResult = (value: unknown): NewsSentimentLabel | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return (
    normalizeSentimentLabel(record.sentiment_label) ??
    normalizeSentimentLabel(record.sentimentLabel) ??
    normalizeSentimentLabel(record.sentiment)
  );
};

const normalizeQualityScore = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
};

export function buildNewsSignalFromProcessedArticle(
  input: BuildNewsSignalFromProcessedArticleInput
): NewsSignal {
  const processedArticleId = input.processedArticle.id;
  const articleId = input.processedArticle.articleId;
  const processedItemId = normalizeOptionalString(input.processedArticle.cleanedMarkdownRef);

  return {
    articleId,
    processedArticleId,
    processedItemId,
    timestamp: resolveTimestamp({
      publishedAt: input.processedArticle.publishedAt,
      crawlAt: input.article?.crawlAt ?? null,
      processedAt: input.processedArticle.processedAt
    }),
    language:
      normalizeOptionalString(input.processedArticle.language) ??
      normalizeOptionalString(input.article?.language) ??
      null,
    title: normalizeOptionalString(input.processedArticle.title),
    summary: normalizeOptionalString(input.processedArticle.summary),
    topics: normalizeTopics(input.processedArticle.topics),
    entities: normalizeEntities(input.processedArticle.entities),
    sentiment: extractSentimentFromProcessedItemResult(input.processedItemResult ?? null),
    qualityScore: normalizeQualityScore(input.processedArticle.qualityScore)
  };
}

