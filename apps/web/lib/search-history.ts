export const SEARCH_HISTORY_KEY = "news_search_history";
export const MAX_SEARCH_HISTORY_ITEMS = 10;

export function normalizeSearchHistory(
  input: unknown,
  limit: number = MAX_SEARCH_HISTORY_ITEMS
): string[] {
  if (!Array.isArray(input) || limit < 1) {
    return [];
  }

  const normalized = input
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized)).slice(0, limit);
}

export function parseSearchHistory(
  raw: string | null,
  limit: number = MAX_SEARCH_HISTORY_ITEMS
): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return normalizeSearchHistory(parsed, limit);
  } catch {
    return [];
  }
}
