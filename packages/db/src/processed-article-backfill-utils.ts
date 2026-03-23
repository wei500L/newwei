const SIMPLE_STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "will",
  "have",
  "about",
  "their",
  "there",
  "after",
  "before",
  "where",
  "which",
  "while",
  "into",
  "within",
  "across",
  "against",
  "under",
  "between",
  "said",
  "says",
  "report",
  "reports",
  "update",
  "latest",
  "breaking",
  "market",
  "global",
  "world",
  "news",
  "analysis",
  "today",
  "live",
]);

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export function alignUtcHourStart(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      value.getUTCHours(),
      0,
      0,
      0,
    ),
  );
}

export function normalizeProcessedArticleSource(value: unknown): string {
  return normalizeString(value)?.toLowerCase() ?? "unknown";
}

export function extractProcessedArticleTerms(article: {
  title?: string | null;
  summary?: string | null;
  topics?: unknown;
}): string[] {
  const terms = new Set<string>();
  const pushTokens = (text: string | null | undefined) => {
    if (!text) {
      return;
    }
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/g)) {
      const normalized = token.trim();
      if (normalized.length < 4 || SIMPLE_STOPWORDS.has(normalized)) {
        continue;
      }
      terms.add(normalized);
    }
  };

  pushTokens(article.title ?? undefined);
  pushTokens(article.summary ?? undefined);
  if (Array.isArray(article.topics)) {
    for (const topic of article.topics) {
      if (typeof topic === "string") {
        pushTokens(topic);
        continue;
      }
      if (!topic || typeof topic !== "object") {
        continue;
      }
      const record = topic as Record<string, unknown>;
      pushTokens(normalizeString(record.name) ?? undefined);
      pushTokens(normalizeString(record.label) ?? undefined);
    }
  }

  return Array.from(terms);
}
