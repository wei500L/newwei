import type { MetadataResponse, Source } from "../hooks/use-news-sources";

export interface NewsnowSearchSourceResult {
  id: string;
  source: Source;
  column: string;
}

const OTHER_COLUMN_NAME = "其他";

export function buildNewsnowSearchSources(
  metadata: MetadataResponse | undefined,
  searchText: string
): NewsnowSearchSourceResult[] {
  if (!metadata) {
    return [];
  }

  const keyword = searchText.trim().toLowerCase();
  const sourceColumnMap = new Map<string, string>();

  Object.values(metadata.columns).forEach((column) => {
    column.sources.forEach((sourceId) => {
      if (!sourceColumnMap.has(sourceId)) {
        sourceColumnMap.set(sourceId, column.name);
      }
    });
  });

  const results: NewsnowSearchSourceResult[] = [];

  Object.entries(metadata.sources).forEach(([id, source]) => {
    if (source.redirect) {
      return;
    }

    const matched = keyword.length === 0
      || source.name.toLowerCase().includes(keyword)
      || Boolean(source.title && source.title.toLowerCase().includes(keyword));

    if (!matched) {
      return;
    }

    results.push({
      id,
      source,
      column: sourceColumnMap.get(id) ?? OTHER_COLUMN_NAME,
    });
  });

  return results;
}
