import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import {
  applyRssTranslationsToListItems,
  buildRssReaderPreferencesFingerprint,
  buildRssReaderPreferencesStorageKey,
  filterRssSourcesByLanguages,
  normalizeRssReaderPreferences,
  resolveRssSourceLanguageOptions,
  resolveRssSourceSelectionOptions,
  resolveRssReaderPersistedPayload,
  resolveItemsViewFiltersWithFixedSources,
  resolveRssSourceSelectionUiState,
  resolveTopRssSourceIds,
} from '../lib/rss-reader-ui';

describe('rss reader ui helpers', () => {
  it('returns loading state for the initial source fetch', () => {
    expect(
      resolveRssSourceSelectionUiState({
        loading: true,
        hasData: false,
        hasError: false,
        sourcesCount: 0,
        selectionInitialized: false,
        selectedSourceCount: 0,
      }),
    ).toEqual({
      showLoading: true,
      showEmpty: false,
      selectionReady: false,
      showSelectionAlert: false,
      showItemsView: false,
    });
  });

  it('returns empty state after loading completes without sources', () => {
    expect(
      resolveRssSourceSelectionUiState({
        loading: false,
        hasData: true,
        hasError: false,
        sourcesCount: 0,
        selectionInitialized: false,
        selectedSourceCount: 0,
      }),
    ).toEqual({
      showLoading: false,
      showEmpty: true,
      selectionReady: false,
      showSelectionAlert: false,
      showItemsView: false,
    });
  });

  it('does not flash a selection alert before automatic source selection is ready', () => {
    expect(
      resolveRssSourceSelectionUiState({
        loading: false,
        hasData: true,
        hasError: false,
        sourcesCount: 3,
        selectionInitialized: false,
        selectedSourceCount: 0,
      }),
    ).toEqual({
      showLoading: false,
      showEmpty: false,
      selectionReady: false,
      showSelectionAlert: false,
      showItemsView: false,
    });
  });

  it('shows items once source selection is ready', () => {
    expect(
      resolveRssSourceSelectionUiState({
        loading: false,
        hasData: true,
        hasError: false,
        sourcesCount: 3,
        selectionInitialized: true,
        selectedSourceCount: 3,
      }),
    ).toEqual({
      showLoading: false,
      showEmpty: false,
      selectionReady: true,
      showSelectionAlert: false,
      showItemsView: true,
    });
  });

  it('shows the source selection alert only after initialization when the user clears all sources', () => {
    expect(
      resolveRssSourceSelectionUiState({
        loading: false,
        hasData: true,
        hasError: false,
        sourcesCount: 3,
        selectionInitialized: true,
        selectedSourceCount: 0,
      }),
    ).toEqual({
      showLoading: false,
      showEmpty: false,
      selectionReady: true,
      showSelectionAlert: true,
      showItemsView: false,
    });
  });

  it('keeps fixed source ids in query filters but hides them from display filters', () => {
    const result = resolveItemsViewFiltersWithFixedSources({
      filters: {
        sourceIds: ['stale-ui-source'],
        regions: ['APAC'],
        topics: ['AI'],
        dateRange: [dayjs('2026-03-01'), dayjs('2026-03-07')],
      },
      fixedSourceIds: [' source-a ', 'source-b', 'source-a'],
    });

    expect(result.normalizedFixedSourceIds).toEqual(['source-a', 'source-b']);
    expect(result.queryFilters).toEqual({
      sourceIds: ['source-a', 'source-b'],
      regions: ['APAC'],
      topics: ['AI'],
      dateRange: [dayjs('2026-03-01'), dayjs('2026-03-07')],
    });
    expect(result.displayFilters).toEqual({
      regions: ['APAC'],
      topics: ['AI'],
      dateRange: [dayjs('2026-03-01'), dayjs('2026-03-07')],
    });
  });

  it('sorts source options by activity, then recency, then name and builds search text', () => {
    const options = resolveRssSourceSelectionOptions([
      {
        id: 'b',
        name: 'Beta Feed',
        language: 'en',
        siteUrl: 'https://beta.example.com',
        feedUrl: 'https://beta.example.com/rss.xml',
        latestItemAt: '2026-03-07T10:00:00.000Z',
        itemCountWindow: 5,
      },
      {
        id: 'a',
        name: 'Alpha Feed',
        language: 'zh-CN',
        siteUrl: 'https://alpha.example.com',
        feedUrl: 'https://alpha.example.com/rss.xml',
        latestItemAt: '2026-03-07T12:00:00.000Z',
        itemCountWindow: 5,
      },
      {
        id: 'c',
        name: 'Gamma Feed',
        language: 'en',
        siteUrl: 'https://gamma.example.com',
        feedUrl: 'https://gamma.example.com/rss.xml',
        latestItemAt: '2026-03-07T08:00:00.000Z',
        itemCountWindow: 8,
      },
    ]);

    expect(options.map((option) => option.id)).toEqual(['c', 'a', 'b']);
    expect(options[0]?.searchText).toContain('gamma feed');
    expect(options[0]?.searchText).toContain('gamma.example.com');
    expect(options[0]?.language).toBe('EN');
  });

  it('returns the top source ids in sorted order', () => {
    const options = resolveRssSourceSelectionOptions([
      {
        id: 'a',
        name: 'Alpha Feed',
        language: 'zh-CN',
        siteUrl: 'https://alpha.example.com',
        feedUrl: 'https://alpha.example.com/rss.xml',
        latestItemAt: '2026-03-07T12:00:00.000Z',
        itemCountWindow: 5,
      },
      {
        id: 'b',
        name: 'Beta Feed',
        language: 'en',
        siteUrl: 'https://beta.example.com',
        feedUrl: 'https://beta.example.com/rss.xml',
        latestItemAt: '2026-03-07T10:00:00.000Z',
        itemCountWindow: 4,
      },
      {
        id: 'c',
        name: 'Gamma Feed',
        language: 'en',
        siteUrl: 'https://gamma.example.com',
        feedUrl: 'https://gamma.example.com/rss.xml',
        latestItemAt: '2026-03-07T08:00:00.000Z',
        itemCountWindow: 8,
      },
    ]);

    expect(resolveTopRssSourceIds(options, 2)).toEqual(['c', 'a']);
  });

  it('derives language filter options and filters sources accordingly', () => {
    const options = resolveRssSourceSelectionOptions([
      {
        id: 'a',
        name: 'Alpha Feed',
        language: 'zh-CN',
        siteUrl: 'https://alpha.example.com',
        feedUrl: 'https://alpha.example.com/rss.xml',
        latestItemAt: '2026-03-07T12:00:00.000Z',
        itemCountWindow: 5,
      },
      {
        id: 'b',
        name: 'Beta Feed',
        language: 'en',
        siteUrl: 'https://beta.example.com',
        feedUrl: 'https://beta.example.com/rss.xml',
        latestItemAt: '2026-03-07T10:00:00.000Z',
        itemCountWindow: 4,
      },
      {
        id: 'c',
        name: 'Gamma Feed',
        language: 'en',
        siteUrl: 'https://gamma.example.com',
        feedUrl: 'https://gamma.example.com/rss.xml',
        latestItemAt: '2026-03-07T08:00:00.000Z',
        itemCountWindow: 8,
      },
    ]);

    expect(resolveRssSourceLanguageOptions(options)).toEqual([
      { value: 'EN', count: 2 },
      { value: 'ZH-CN', count: 1 },
    ]);
    expect(filterRssSourcesByLanguages(options, ['en']).map((option) => option.id)).toEqual([
      'c',
      'b',
    ]);
  });

  it('builds a per-user RSS reader storage key', () => {
    expect(buildRssReaderPreferencesStorageKey('org-1', 'user-2')).toBe(
      'modular:rss-reader:v1:org=org-1:user=user-2',
    );
  });

  it('normalizes persisted RSS reader preferences and keeps explicit empty selections', () => {
    expect(
      normalizeRssReaderPreferences({
        value: {
          selectedSourceIds: [' source-a ', 'source-b', 'missing'],
          sourceLanguageFilters: [' en ', 'zh-cn', 'unknown'],
          translationEnabled: true,
          translationProvider: 'llm',
          targetLanguage: 'en',
          showOriginalContent: true,
        },
        availableSourceIds: ['source-a', 'source-b'],
        availableSourceLanguages: ['EN', 'ZH-CN'],
      }),
    ).toEqual({
      selectedSourceIds: ['source-a', 'source-b'],
      sourceLanguageFilters: ['EN', 'ZH-CN'],
      translationEnabled: true,
      translationProvider: 'llm',
      targetLanguage: 'en',
      showOriginalContent: true,
    });

    expect(
      normalizeRssReaderPreferences({
        value: {
          selectedSourceIds: [],
        },
      }),
    ).toEqual({
      selectedSourceIds: [],
      sourceLanguageFilters: [],
      translationEnabled: false,
      translationProvider: 'deeplx',
      targetLanguage: 'zh-CN',
      showOriginalContent: false,
    });
  });

  it('serializes RSS reader preferences for storage', () => {
    expect(
      resolveRssReaderPersistedPayload({
        selectedSourceIds: ['source-a', 'source-a', 'source-b'],
        sourceLanguageFilters: ['EN', 'EN', 'ZH-CN'],
        translationEnabled: true,
        translationProvider: 'llm',
        targetLanguage: 'en',
        showOriginalContent: false,
      }),
    ).toEqual({
      selectedSourceIds: ['source-a', 'source-b'],
      sourceLanguageFilters: ['EN', 'ZH-CN'],
      translationEnabled: true,
      translationProvider: 'llm',
      targetLanguage: 'en',
      showOriginalContent: false,
    });
  });

  it('builds a stable fingerprint for RSS reader preferences', () => {
    expect(
      buildRssReaderPreferencesFingerprint({
        selectedSourceIds: ['source-b', 'source-a'],
        sourceLanguageFilters: ['ZH-CN', 'EN'],
        translationEnabled: true,
        translationProvider: 'llm',
        targetLanguage: 'en',
        showOriginalContent: true,
      }),
    ).toBe(
      JSON.stringify({
        selectedSourceIds: ['source-b', 'source-a'],
        sourceLanguageFilters: ['EN', 'ZH-CN'],
        translationEnabled: true,
        translationProvider: 'llm',
        targetLanguage: 'en',
        showOriginalContent: true,
      }),
    );
  });

  it('leaves filters untouched when no fixed source ids are present', () => {
    const filters = {
      regions: ['Europe'],
      excludeDuplicates: true,
    };

    const result = resolveItemsViewFiltersWithFixedSources({
      filters,
    });

    expect(result.queryFilters).toBe(filters);
    expect(result.displayFilters).toBe(filters);
    expect(result.hasFixedSources).toBe(false);
  });

  it('overlays translated titles and summaries on list items', () => {
    const items = [
      { id: 'item-1', title: 'Original title', name: 'Original title', summary: 'Original summary' },
      { id: 'item-2', title: 'Second title', name: 'Second title', summary: 'Second summary' },
    ];

    expect(
      applyRssTranslationsToListItems({
        items,
        translatedByItemId: {
          'item-1': {
            title: 'Translated title',
            summary: 'Translated summary',
          },
        },
        enabled: true,
      }),
    ).toEqual([
      {
        id: 'item-1',
        rssHasTranslation: true,
        rssTranslationState: 'translated',
        title: 'Translated title',
        name: 'Translated title',
        summary: 'Translated summary',
      },
      {
        id: 'item-2',
        rssHasTranslation: false,
        rssTranslationState: 'original',
        title: 'Second title',
        name: 'Second title',
        summary: 'Second summary',
      },
    ]);
  });

  it('keeps original content when showOriginal is enabled', () => {
    const items = [
      { id: 'item-1', title: 'Original title', name: 'Original title', summary: 'Original summary' },
    ];

    const result = applyRssTranslationsToListItems({
      items,
      translatedByItemId: {
        'item-1': {
          title: 'Translated title',
          summary: 'Translated summary',
        },
      },
      enabled: true,
      showOriginal: true,
    });

    expect(result).toEqual([
      {
        id: 'item-1',
        rssHasTranslation: true,
        rssTranslationState: 'original',
        title: 'Original title',
        name: 'Original title',
        summary: 'Original summary',
      },
    ]);
  });

  it('preserves original rows when a translation payload is partial or blank', () => {
    const items = [
      { id: 'item-1', title: 'Original title', name: 'Original title', summary: 'Original summary' },
      { id: 'item-2', title: 'Second title', name: 'Second title', summary: 'Second summary' },
    ];

    expect(
      applyRssTranslationsToListItems({
        items,
        translatedByItemId: {
          'item-1': {
            title: '  ',
            summary: 'Updated summary',
          },
        },
        enabled: true,
      }),
    ).toEqual([
      {
        id: 'item-1',
        rssHasTranslation: true,
        rssTranslationState: 'translated',
        title: 'Original title',
        name: 'Original title',
        summary: 'Updated summary',
      },
      {
        id: 'item-2',
        rssHasTranslation: false,
        rssTranslationState: 'original',
        title: 'Second title',
        name: 'Second title',
        summary: 'Second summary',
      },
    ]);
  });
});
