import type {
  ItemsDensity,
  ItemsExperiencePreset,
  ItemsFilterBehavior
} from '../items/items-view-layout';

export interface RssItemsViewPreset {
  experiencePreset: ItemsExperiencePreset;
  density: ItemsDensity;
  filterBehavior: ItemsFilterBehavior;
}

export const RSS_ITEMS_VIEW_PRESET: RssItemsViewPreset = {
  experiencePreset: 'reader',
  density: 'compact',
  filterBehavior: 'layered'
};
