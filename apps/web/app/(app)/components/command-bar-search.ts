export function normalizeCommandBarQuery(query: string): string {
  return query.trim();
}

export function buildCommandBarSearchHref(query: string): string | null {
  const normalizedQuery = normalizeCommandBarQuery(query);
  if (!normalizedQuery) {
    return null;
  }

  return `/search?q=${encodeURIComponent(normalizedQuery)}`;
}
