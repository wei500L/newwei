import { createHash } from "node:crypto";

export function normalizeKeywords(input?: string[] | null) {
  if (!input || input.length === 0) {
    return [];
  }
  const normalized = input
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);
  const seen = new Set<string>();
  for (const keyword of normalized) {
    if (seen.size >= 25) {
      break;
    }
    seen.add(keyword);
  }
  return Array.from(seen);
}

export function clampResultLimit(limit?: number | null, fallback = 20) {
  if (limit == null || Number.isNaN(limit)) {
    return fallback;
  }
  return Math.max(1, Math.min(100, limit));
}

export function coerceDate(value?: string | Date | null) {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

export function hashMarkdown(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
