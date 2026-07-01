import type {
  ArchiveClassificationDetailModel,
  ArchiveClassificationScoreEntryModel,
} from '@/graphql/generated';

export type ArchiveRegion =
  | 'APAC'
  | 'MIDDLE_EAST'
  | 'AMERICAS'
  | 'EUROPE'
  | 'AFRICA'
  | 'OTHER';

export type ArchiveVertical =
  | 'EAST_SEA'
  | 'SOUTH_SEA'
  | 'WEST_FRONT'
  | 'FOREIGN_AFFAIRS'
  | 'DOMESTIC_AFFAIRS';

export type ArchiveWeight = 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
export type ArchiveMatchOrigin = 'LEXICAL' | 'SEMANTIC' | 'HYBRID';
export type ArchiveClassificationStaleReason =
  ArchiveClassificationDetailModel['staleReasons'][number];
export type ArchiveClassificationI18nKey = `pages.eventsArchive.detail.${string}`;

export interface ArchiveEventItem {
  processedArticleId: string;
  eventId?: string | null;
  title?: string | null;
  summary?: string | null;
  countryLabel?: string | null;
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  weight: number;
  qualityScore?: number | null;
  publishedAt?: string | null;
  sortAt: string;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  entityTags: string[];
  keywordHighlights: string[];
  matchOrigin?: ArchiveMatchOrigin | null;
  relevanceScore?: number | null;
}

export type ArchiveClassificationScoreEntry = Omit<
  ArchiveClassificationScoreEntryModel,
  '__typename' | 'vertical'
> & {
  vertical: ArchiveVertical;
};

export type ArchiveClassificationDetail = Omit<
  ArchiveClassificationDetailModel,
  | '__typename'
  | 'region'
  | 'vertical'
  | 'scoreEntries'
  | 'staleReasons'
  | 'staleReasonI18nKeys'
> & {
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  scoreEntries: ArchiveClassificationScoreEntry[];
  staleReasons: ArchiveClassificationStaleReason[];
  staleReasonI18nKeys: ArchiveClassificationI18nKey[];
};

export interface ArchiveVerticalTone {
  accentDotClassName: string;
  accentGlowClassName: string;
  actionClassName: string;
  titlePillClassName: string;
}

export type ArchiveSearchFeedbackTone =
  | 'pending'
  | 'info'
  | 'loading'
  | 'error'
  | 'empty'
  | 'ready';

export type ArchiveSearchFeedbackVisualState =
  | 'debouncing'
  | 'minChars'
  | 'loading'
  | 'error'
  | 'empty'
  | 'ready';

export const REGION_OPTIONS: ArchiveRegion[] = [
  'APAC',
  'MIDDLE_EAST',
  'AMERICAS',
  'EUROPE',
  'AFRICA',
  'OTHER',
];

export const VERTICAL_SECTIONS: {
  key: string;
  verticals: ArchiveVertical[];
}[] = [
  {
    key: 'geo',
    verticals: ['EAST_SEA', 'SOUTH_SEA', 'WEST_FRONT'],
  },
  {
    key: 'macro',
    verticals: ['FOREIGN_AFFAIRS', 'DOMESTIC_AFFAIRS'],
  },
];

export const VERTICAL_FALLBACK_LABEL: Record<ArchiveVertical, string> = {
  EAST_SEA: '【东海】',
  SOUTH_SEA: '【南海】',
  WEST_FRONT: '【西面】',
  FOREIGN_AFFAIRS: '【外务】',
  DOMESTIC_AFFAIRS: '【内务】',
};

export const MATCH_ORIGIN_TAG_COLOR: Record<ArchiveMatchOrigin, string> = {
  LEXICAL: 'blue',
  SEMANTIC: 'purple',
  HYBRID: 'geekblue',
};

export const DEFAULT_REGION: ArchiveRegion = 'APAC';
export const DEFAULT_WEIGHTS = [5, 4, 3, 2, 1] as const;
export const ARCHIVE_PAGE_SIZE = 6;
export const MIN_ARCHIVE_SEARCH_QUERY_LENGTH = 2;

const ARCHIVE_VERTICAL_TONES: Record<ArchiveVertical, ArchiveVerticalTone> = {
  EAST_SEA: {
    accentDotClassName: 'bg-sky-500 dark:bg-sky-300',
    accentGlowClassName:
      'from-sky-500/22 via-sky-500/10 to-transparent dark:from-sky-400/26 dark:via-sky-400/10',
    actionClassName:
      'text-sky-700 hover:bg-sky-500/12 hover:text-sky-800 dark:text-sky-300 dark:hover:bg-sky-400/12 dark:hover:text-sky-100',
    titlePillClassName:
      'bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:bg-sky-400/15 dark:text-sky-200 dark:ring-sky-400/30',
  },
  SOUTH_SEA: {
    accentDotClassName: 'bg-cyan-500 dark:bg-cyan-300',
    accentGlowClassName:
      'from-cyan-500/22 via-cyan-500/10 to-transparent dark:from-cyan-400/26 dark:via-cyan-400/10',
    actionClassName:
      'text-cyan-700 hover:bg-cyan-500/12 hover:text-cyan-800 dark:text-cyan-300 dark:hover:bg-cyan-400/12 dark:hover:text-cyan-100',
    titlePillClassName:
      'bg-cyan-500/10 text-cyan-700 ring-cyan-500/20 dark:bg-cyan-400/15 dark:text-cyan-200 dark:ring-cyan-400/30',
  },
  WEST_FRONT: {
    accentDotClassName: 'bg-violet-500 dark:bg-violet-300',
    accentGlowClassName:
      'from-violet-500/22 via-violet-500/10 to-transparent dark:from-violet-400/26 dark:via-violet-400/10',
    actionClassName:
      'text-violet-700 hover:bg-violet-500/12 hover:text-violet-800 dark:text-violet-300 dark:hover:bg-violet-400/12 dark:hover:text-violet-100',
    titlePillClassName:
      'bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:bg-violet-400/15 dark:text-violet-200 dark:ring-violet-400/30',
  },
  FOREIGN_AFFAIRS: {
    accentDotClassName: 'bg-amber-500 dark:bg-amber-300',
    accentGlowClassName:
      'from-amber-500/22 via-amber-500/10 to-transparent dark:from-amber-400/26 dark:via-amber-400/10',
    actionClassName:
      'text-amber-700 hover:bg-amber-500/12 hover:text-amber-800 dark:text-amber-300 dark:hover:bg-amber-400/12 dark:hover:text-amber-100',
    titlePillClassName:
      'bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:bg-amber-400/15 dark:text-amber-200 dark:ring-amber-400/30',
  },
  DOMESTIC_AFFAIRS: {
    accentDotClassName: 'bg-emerald-500 dark:bg-emerald-300',
    accentGlowClassName:
      'from-emerald-500/22 via-emerald-500/10 to-transparent dark:from-emerald-400/26 dark:via-emerald-400/10',
    actionClassName:
      'text-emerald-700 hover:bg-emerald-500/12 hover:text-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-400/12 dark:hover:text-emerald-100',
    titlePillClassName:
      'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-400/15 dark:text-emerald-200 dark:ring-emerald-400/30',
  },
};

export const resolveArchiveVerticalTone = (
  vertical: ArchiveVertical,
): ArchiveVerticalTone => ARCHIVE_VERTICAL_TONES[vertical];

export const resolveArchiveItemPreview = (
  item: Pick<ArchiveEventItem, 'countryLabel' | 'summary' | 'title'>,
  fallbacks: {
    countryLabel: string;
    summary: string;
  },
) => ({
  country: item.countryLabel?.trim() || fallbacks.countryLabel,
  summary: item.summary?.trim() || item.title?.trim() || fallbacks.summary,
});

export const resolveArchiveWeightStars = (weight: number) =>
  '★'.repeat(Math.max(1, Math.min(Math.round(weight), 5)));

export const resolveArchiveRelevancePercent = (score?: number | null) =>
  typeof score === 'number' && Number.isFinite(score)
    ? Math.round(score * 100)
    : null;

export const resolveArchiveClassificationSignals = (
  signals: string[],
  limit = 6,
) =>
  Array.from(
    new Set(
      signals
        .map((signal) => signal.trim())
        .filter((signal) => signal.length > 0),
    ),
  ).slice(0, Math.max(1, limit));

export const resolveArchiveClassificationI18nKeys = (
  keys: string[],
  limit = 4,
) =>
  Array.from(
    new Set(
      keys
        .map((key) => key.trim())
        .filter((key) => key.length > 0),
    ),
  ).slice(0, Math.max(1, limit));

export const resolveArchiveSearchFeedbackVisualState = (
  tone: ArchiveSearchFeedbackTone,
): ArchiveSearchFeedbackVisualState => {
  if (tone === 'pending') {
    return 'debouncing';
  }
  if (tone === 'info') {
    return 'minChars';
  }
  return tone;
};
