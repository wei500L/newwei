const PRESERVED_QUERY_KEYS = [
  "mode",
  "ranking",
  "pageSize",
  "archiveDate",
  "archiveRegion",
  "archiveWeights",
] as const;

export function buildHotTopicQueryString(
  currentParams: URLSearchParams,
  topic: string,
): string {
  const trimmedTopic = topic.trim();
  if (!trimmedTopic) {
    return "";
  }

  const next = new URLSearchParams();
  for (const key of PRESERVED_QUERY_KEYS) {
    const value = currentParams.get(key);
    if (!value) {
      continue;
    }
    next.set(key, value);
  }
  next.set("q", trimmedTopic);
  return next.toString();
}

export function buildGuidedSearchHref(
  pathname: string,
  currentParams: URLSearchParams,
  topic: string,
): string {
  const queryString = buildHotTopicQueryString(currentParams, topic);
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export function shouldResetStaleSearchQuery(
  query: string,
  searchInput: string,
): boolean {
  return query.trim().length > 0 && searchInput.trim().length === 0;
}
