import type { FilterState } from './faceted-search';

export type FacetedFilterBehavior = 'legacy' | 'layered';

export const FACETED_SECTION_KEYS = ['region', 'topic', 'sentiment', 'contentType'] as const;
export type FacetedSectionKey = (typeof FACETED_SECTION_KEYS)[number];

export interface FacetedSelectionCounts {
  sourceIds: number;
  regions: number;
  topics: number;
  sentiments: number;
  contentTypes: number;
  dateRange: number;
}

export function getFacetedSelectionCounts(filters: FilterState): FacetedSelectionCounts {
  const sourceIds = Array.isArray(filters.sourceIds) ? filters.sourceIds.length : 0;
  const regions = Array.isArray(filters.regions) ? filters.regions.length : 0;
  const topics = Array.isArray(filters.topics) ? filters.topics.length : 0;
  const sentiments = Array.isArray(filters.sentiments) ? filters.sentiments.length : 0;
  const contentTypes = Array.isArray(filters.contentTypes) ? filters.contentTypes.length : 0;
  const dateRange = filters.dateRange?.[0] && filters.dateRange?.[1] ? 1 : 0;

  return {
    sourceIds,
    regions,
    topics,
    sentiments,
    contentTypes,
    dateRange
  };
}

export function resolveFacetedDefaultActiveKeys(input: {
  behavior: FacetedFilterBehavior;
  availableKeys: FacetedSectionKey[];
  filters: FilterState;
}): FacetedSectionKey[] {
  const { behavior, availableKeys, filters } = input;

  if (behavior === 'legacy') {
    return [...availableKeys];
  }

  return availableKeys.filter((key) => {
    if (key === 'region') {
      return Boolean(filters.regions?.length);
    }
    if (key === 'topic') {
      return Boolean(filters.topics?.length);
    }
    if (key === 'contentType') {
      return Boolean(filters.contentTypes?.length);
    }
    return Boolean(filters.sentiments?.length);
  });
}

export function filterFacetOptions(options: string[], query: string): string[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return options;
  }
  return options.filter((option) => option.toLowerCase().includes(keyword));
}
