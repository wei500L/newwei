export type SearchFeedbackState =
  | "idle"
  | "minChars"
  | "debouncing"
  | "loading"
  | "ready"
  | "empty"
  | "error";

interface ResolveSearchFeedbackStateInput {
  query: string;
  debouncedQuery?: string;
  loading: boolean;
  hasResults: boolean;
  hasError: boolean;
  minChars?: number;
}

const DEFAULT_MIN_CHARS = 2;

export function resolveSearchFeedbackState({
  query,
  debouncedQuery,
  loading,
  hasResults,
  hasError,
  minChars = DEFAULT_MIN_CHARS,
}: ResolveSearchFeedbackStateInput): SearchFeedbackState {
  const normalizedQuery = query.trim();
  const normalizedDebouncedQuery = (debouncedQuery ?? query).trim();

  if (!normalizedQuery) {
    return "idle";
  }

  if (normalizedQuery.length < minChars) {
    return "minChars";
  }

  if (hasError) {
    return "error";
  }

  if (loading) {
    return "loading";
  }

  if (normalizedDebouncedQuery !== normalizedQuery) {
    return "debouncing";
  }

  if (hasResults) {
    return "ready";
  }

  return "empty";
}

export function getSearchRemainingChars(query: string, minChars = DEFAULT_MIN_CHARS): number {
  return Math.max(0, minChars - query.trim().length);
}
