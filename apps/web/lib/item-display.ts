import { safeHttpUrl } from "@/lib/url";

interface ResolveDisplayTitleInput {
  processedTitle?: unknown;
  itemTitle?: unknown;
  source?: unknown;
  originalUrl?: unknown;
  fallbackTitle?: string;
}

interface ResolveDisplaySummaryInput {
  processedSummary?: unknown;
  rawSummary?: unknown;
  keyPoints?: unknown;
}

interface ResolveDisplayContentInput {
  cleanedMarkdown?: unknown;
}

const URL_LIKE_TITLE_PATTERN = /https?:\/\/|:\s*https?:\/\//i;

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function looksLikeUrlTitle(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("://")) {
    return true;
  }
  return URL_LIKE_TITLE_PATTERN.test(trimmed);
}

function resolveHostname(value: unknown): string | undefined {
  const safe = safeHttpUrl(value);
  if (!safe) {
    return undefined;
  }
  try {
    return new URL(safe).hostname;
  } catch {
    return undefined;
  }
}

export function resolveDisplayTitle(input: ResolveDisplayTitleInput): string {
  const fallback = input.fallbackTitle?.trim() || "Untitled article";
  const processedTitle = toNonEmptyString(input.processedTitle);
  if (processedTitle) {
    return processedTitle;
  }

  const itemTitle = toNonEmptyString(input.itemTitle);
  if (itemTitle && !looksLikeUrlTitle(itemTitle)) {
    return itemTitle;
  }

  const source = toNonEmptyString(input.source);
  if (source) {
    return source;
  }

  const hostname = resolveHostname(input.originalUrl);
  if (hostname) {
    return hostname;
  }

  return itemTitle || fallback;
}

export function resolveDisplaySummary(input: ResolveDisplaySummaryInput): string | undefined {
  const summary = toNonEmptyString(input.processedSummary) ?? toNonEmptyString(input.rawSummary);
  if (summary) {
    return summary;
  }

  const keyPoints = toStringList(input.keyPoints);
  if (keyPoints.length > 0) {
    return keyPoints.slice(0, 3).join(" ");
  }

  return undefined;
}

export function resolveDisplayContent(input: ResolveDisplayContentInput): string | undefined {
  return toNonEmptyString(input.cleanedMarkdown);
}

export function isChineseLanguage(value: unknown): boolean {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.startsWith("zh") || normalized.includes("chinese") || normalized.includes("中文");
}

export function resolveLanguageLabel(value: unknown): string | undefined {
  return toNonEmptyString(value);
}
