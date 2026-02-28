import type { FilterState } from './components/faceted-search';

export type ItemsExperiencePreset = 'default' | 'reader';
export type ItemsDensity = 'compact' | 'comfortable';
export type ItemsFilterBehavior = 'legacy' | 'layered';

export interface ItemsViewLayoutState {
  experiencePreset: ItemsExperiencePreset;
  density: ItemsDensity;
  filterBehavior: ItemsFilterBehavior;
  isReaderPreset: boolean;
  isLayeredFilters: boolean;
}

export function resolveItemsViewLayoutState(input: {
  experiencePreset?: ItemsExperiencePreset;
  density?: ItemsDensity;
  filterBehavior?: ItemsFilterBehavior;
} = {}): ItemsViewLayoutState {
  const experiencePreset = input.experiencePreset ?? 'default';
  const density = input.density ?? 'compact';
  const filterBehavior = input.filterBehavior ?? 'legacy';

  return {
    experiencePreset,
    density,
    filterBehavior,
    isReaderPreset: experiencePreset === 'reader',
    isLayeredFilters: filterBehavior === 'layered'
  };
}

export function countItemsFilterDimensions(filters: FilterState): number {
  let count = 0;

  if (filters.sourceIds?.length) {
    count += 1;
  }
  if (filters.regions?.length) {
    count += 1;
  }
  if (filters.topics?.length) {
    count += 1;
  }
  if (filters.sentiments?.length) {
    count += 1;
  }
  if (filters.contentTypes?.length) {
    count += 1;
  }
  if (filters.excludeDuplicates) {
    count += 1;
  }
  if (filters.dateRange?.[0] && filters.dateRange?.[1]) {
    count += 1;
  }

  return count;
}
