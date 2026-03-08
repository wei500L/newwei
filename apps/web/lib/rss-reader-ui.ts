import type { FilterState } from '@/app/(app)/items/components/faceted-search';
import type { RssTranslationProvider } from '@/lib/rss-translation';

export interface ResolveRssSourceSelectionUiStateInput {
  loading: boolean;
  hasData: boolean;
  hasError: boolean;
  sourcesCount: number;
  selectionInitialized: boolean;
  selectedSourceCount: number;
}

export interface RssSourceSelectionUiState {
  showLoading: boolean;
  showEmpty: boolean;
  selectionReady: boolean;
  showSelectionAlert: boolean;
  showItemsView: boolean;
}

export interface RssSourceSelectionOptionInput {
  id: string;
  name: string;
  language?: string | null;
  siteUrl?: string | null;
  feedUrl?: string | null;
  latestItemAt?: string | null;
  itemCountWindow: number;
}

export interface RssSourceSelectionOptionModel {
  id: string;
  name: string;
  language: string | null;
  siteHostname: string | null;
  feedHostname: string | null;
  latestItemAt: string | null;
  itemCountWindow: number;
  searchText: string;
}

export interface RssSourceLanguageOption {
  value: string;
  count: number;
}

export type RssTranslationIndicatorState = 'translated' | 'original';

export interface PersistedRssReaderPreferences {
  selectedSourceIds: string[] | null;
  sourceLanguageFilters: string[];
  translationEnabled: boolean;
  translationProvider: RssTranslationProvider;
  targetLanguage: string;
  showOriginalContent: boolean;
}

export interface NormalizedRssReaderPreferences {
  selectedSourceIds: string[] | null;
  sourceLanguageFilters: string[];
  translationEnabled: boolean;
  translationProvider: RssTranslationProvider;
  targetLanguage: string;
  showOriginalContent: boolean;
}

const RSS_READER_STORAGE_PREFIX = 'modular:rss-reader:v1';
const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
const DEFAULT_TRANSLATION_PROVIDER: RssTranslationProvider = 'deeplx';

const normalizeStringList = (values?: string[]): string[] | undefined => {
  if (!values) {
    return undefined;
  }

  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (normalized.length === 0) {
    return undefined;
  }

  return Array.from(new Set(normalized));
};

const normalizePersistedSourceIds = (
  value: unknown,
  allowedIds?: string[],
): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const allowedSet = allowedIds ? new Set(allowedIds) : null;
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
    .filter((entry) => (allowedSet ? allowedSet.has(entry) : true));

  return Array.from(new Set(normalized));
};

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toTimestamp = (value?: string | null): number => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toHostname = (value?: string | null): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
};

const normalizeLanguage = (value: unknown): string | null => {
  const normalized = toNonEmptyString(value);
  return normalized ? normalized.toUpperCase() : null;
};

const normalizePersistedLanguageFilters = (
  value: unknown,
  allowedLanguages?: string[],
): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const allowedSet = allowedLanguages ? new Set(allowedLanguages) : null;
  return Array.from(
    new Set(
      value
        .map((entry) => normalizeLanguage(entry))
        .filter((entry): entry is string => Boolean(entry))
        .filter((entry) => (allowedSet ? allowedSet.has(entry) : true)),
    ),
  );
};

const normalizeTranslationProvider = (
  value: unknown,
  fallback: RssTranslationProvider,
): RssTranslationProvider => {
  return value === 'llm' ? 'llm' : fallback;
};

const normalizeTargetLanguage = (
  value: unknown,
  fallback: string,
): string => {
  const normalized = toNonEmptyString(value);
  return normalized ?? fallback;
};

export function buildRssReaderPreferencesStorageKey(
  orgId?: string | null,
  userId?: string | null,
): string {
  const normalizedOrgId = toNonEmptyString(orgId) ?? 'anonymous-org';
  const normalizedUserId = toNonEmptyString(userId) ?? 'anonymous-user';
  return `${RSS_READER_STORAGE_PREFIX}:org=${normalizedOrgId}:user=${normalizedUserId}`;
}

export function createDefaultRssReaderPreferences(): NormalizedRssReaderPreferences {
  return {
    selectedSourceIds: null,
    sourceLanguageFilters: [],
    translationEnabled: false,
    translationProvider: DEFAULT_TRANSLATION_PROVIDER,
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    showOriginalContent: false,
  };
}

export function normalizeRssReaderPreferences(input: {
  value: unknown;
  availableSourceIds?: string[];
  availableSourceLanguages?: string[];
  defaultTargetLanguage?: string;
  defaultProvider?: RssTranslationProvider;
}): NormalizedRssReaderPreferences {
  const record =
    input.value && typeof input.value === 'object' && !Array.isArray(input.value)
      ? (input.value as Record<string, unknown>)
      : null;

  const defaultTargetLanguage = input.defaultTargetLanguage ?? DEFAULT_TARGET_LANGUAGE;
  const defaultProvider = input.defaultProvider ?? DEFAULT_TRANSLATION_PROVIDER;

  return {
    selectedSourceIds: normalizePersistedSourceIds(
      record?.selectedSourceIds,
      input.availableSourceIds,
    ),
    sourceLanguageFilters: normalizePersistedLanguageFilters(
      record?.sourceLanguageFilters,
      input.availableSourceLanguages,
    ),
    translationEnabled: record?.translationEnabled === true,
    translationProvider: normalizeTranslationProvider(
      record?.translationProvider,
      defaultProvider,
    ),
    targetLanguage: normalizeTargetLanguage(
      record?.targetLanguage,
      defaultTargetLanguage,
    ),
    showOriginalContent: record?.showOriginalContent === true,
  };
}

export function resolveRssReaderPersistedPayload(input: {
  selectedSourceIds: string[] | null;
  sourceLanguageFilters: string[];
  translationEnabled: boolean;
  translationProvider: RssTranslationProvider;
  targetLanguage: string;
  showOriginalContent: boolean;
}): PersistedRssReaderPreferences {
  return {
    selectedSourceIds: input.selectedSourceIds
      ? Array.from(new Set(input.selectedSourceIds))
      : null,
    sourceLanguageFilters: Array.from(new Set(input.sourceLanguageFilters)),
    translationEnabled: input.translationEnabled,
    translationProvider: input.translationProvider,
    targetLanguage: input.targetLanguage,
    showOriginalContent: input.showOriginalContent,
  };
}

export function buildRssReaderPreferencesFingerprint(
  input: PersistedRssReaderPreferences,
): string {
  return JSON.stringify({
    selectedSourceIds: input.selectedSourceIds ?? null,
    sourceLanguageFilters: [...input.sourceLanguageFilters].sort((a, b) =>
      a.localeCompare(b),
    ),
    translationEnabled: input.translationEnabled,
    translationProvider: input.translationProvider,
    targetLanguage: input.targetLanguage,
    showOriginalContent: input.showOriginalContent,
  });
}

export function resolveRssSourceSelectionUiState(
  input: ResolveRssSourceSelectionUiStateInput,
): RssSourceSelectionUiState {
  const showLoading = input.loading && !input.hasData && !input.hasError;
  const selectionReady =
    input.sourcesCount > 0 &&
    (input.selectionInitialized || input.selectedSourceCount > 0);
  const showEmpty = !showLoading && !input.hasError && input.sourcesCount === 0;
  const showSelectionAlert =
    !showLoading &&
    input.sourcesCount > 0 &&
    selectionReady &&
    input.selectedSourceCount === 0;
  const showItemsView =
    !showLoading &&
    input.sourcesCount > 0 &&
    selectionReady &&
    input.selectedSourceCount > 0;

  return {
    showLoading,
    showEmpty,
    selectionReady,
    showSelectionAlert,
    showItemsView,
  };
}

export function resolveRssSourceSelectionOptions(
  sources: RssSourceSelectionOptionInput[],
): RssSourceSelectionOptionModel[] {
  return [...sources]
    .map((source) => {
      const siteHostname = toHostname(source.siteUrl);
      const feedHostname = toHostname(source.feedUrl);
      const language = normalizeLanguage(source.language);
      const searchParts = [
        source.name,
        language,
        siteHostname,
        feedHostname,
        source.siteUrl,
        source.feedUrl,
      ]
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .join(' ')
        .toLowerCase();

      return {
        id: source.id,
        name: source.name,
        language,
        siteHostname,
        feedHostname,
        latestItemAt: toNonEmptyString(source.latestItemAt) ?? null,
        itemCountWindow: source.itemCountWindow,
        searchText: searchParts,
      };
    })
    .sort((left, right) => {
      if (right.itemCountWindow !== left.itemCountWindow) {
        return right.itemCountWindow - left.itemCountWindow;
      }

      const latestDiff =
        toTimestamp(right.latestItemAt) - toTimestamp(left.latestItemAt);
      if (latestDiff !== 0) {
        return latestDiff;
      }

      return left.name.localeCompare(right.name);
    });
}

export function resolveRssSourceLanguageOptions(
  sources: RssSourceSelectionOptionModel[],
): RssSourceLanguageOption[] {
  const counts = new Map<string, number>();

  sources.forEach((source) => {
    if (!source.language) {
      return;
    }
    counts.set(source.language, (counts.get(source.language) ?? 0) + 1);
  });

  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.value.localeCompare(right.value);
    });
}

export function filterRssSourcesByLanguages(
  sources: RssSourceSelectionOptionModel[],
  selectedLanguages: string[],
): RssSourceSelectionOptionModel[] {
  const normalizedLanguages = normalizePersistedLanguageFilters(selectedLanguages);
  if (normalizedLanguages.length === 0) {
    return sources;
  }

  const languageSet = new Set(normalizedLanguages);
  return sources.filter((source) =>
    source.language ? languageSet.has(source.language) : false,
  );
}

export function resolveTopRssSourceIds(
  sources: RssSourceSelectionOptionModel[],
  limit: number,
): string[] {
  return sources.slice(0, Math.max(0, limit)).map((source) => source.id);
}

export interface ItemsViewResolvedFilters {
  queryFilters: FilterState;
  displayFilters: FilterState;
  normalizedFixedSourceIds?: string[];
  hasFixedSources: boolean;
}

export function resolveItemsViewFiltersWithFixedSources(input: {
  filters: FilterState;
  fixedSourceIds?: string[];
}): ItemsViewResolvedFilters {
  const normalizedFixedSourceIds = normalizeStringList(input.fixedSourceIds);

  if (!normalizedFixedSourceIds || normalizedFixedSourceIds.length === 0) {
    return {
      queryFilters: input.filters,
      displayFilters: input.filters,
      normalizedFixedSourceIds: undefined,
      hasFixedSources: false,
    };
  }

  const displayFilters: FilterState = { ...input.filters };
  delete displayFilters.sourceIds;

  return {
    queryFilters: {
      ...input.filters,
      sourceIds: normalizedFixedSourceIds,
    },
    displayFilters,
    normalizedFixedSourceIds,
    hasFixedSources: true,
  };
}

export interface RssTranslatedListItem {
  id: string;
  title: string;
  name: string;
  summary?: string;
  rssHasTranslation?: boolean;
  rssTranslationState?: RssTranslationIndicatorState;
}

export interface RssListTranslationRecord {
  title?: string | null;
  summary?: string | null;
}

export function applyRssTranslationsToListItems<T extends RssTranslatedListItem>(
  input: {
    items: T[];
    translatedByItemId: Record<string, RssListTranslationRecord>;
    enabled?: boolean;
    showOriginal?: boolean;
  },
): T[] {
  const {
    items,
    translatedByItemId,
    enabled = false,
    showOriginal = false,
  } = input;

  if (!enabled) {
    return items;
  }

  let hasChanges = false;
  const nextItems = items.map((item) => {
    const translated = translatedByItemId[item.id];
    const translatedTitle = toNonEmptyString(translated?.title);
    const translatedSummary = toNonEmptyString(translated?.summary);
    const hasTranslation = Boolean(translatedTitle || translatedSummary);
    const rssTranslationState: RssTranslationIndicatorState =
      hasTranslation && !showOriginal ? 'translated' : 'original';
    const title =
      hasTranslation && !showOriginal ? translatedTitle ?? item.title : item.title;
    const summary =
      hasTranslation && !showOriginal
        ? translatedSummary ?? item.summary
        : item.summary;

    if (
      title === item.title &&
      summary === item.summary &&
      item.rssHasTranslation === hasTranslation &&
      item.rssTranslationState === rssTranslationState
    ) {
      return item;
    }

    hasChanges = true;
    return {
      ...item,
      title,
      name: title,
      summary,
      rssHasTranslation: hasTranslation,
      rssTranslationState,
    };
  });

  return hasChanges ? nextItems : items;
}
