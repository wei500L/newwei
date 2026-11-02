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
  accentBarClassName: string;
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
  LEXICAL: 'default',
  SEMANTIC: 'default',
  HYBRID: 'default',
};

export const DEFAULT_REGION: ArchiveRegion = 'APAC';
export const DEFAULT_WEIGHTS = [5, 4, 3, 2, 1] as const;
export const ARCHIVE_PAGE_SIZE = 6;
export const MIN_ARCHIVE_SEARCH_QUERY_LENGTH = 2;

const ARCHIVE_VERTICAL_TONES: Record<ArchiveVertical, ArchiveVerticalTone> = {
  EAST_SEA: {
    accentDotClassName: 'bg-[var(--muted-foreground)]',
    accentBarClassName: 'bg-[var(--border-strong)]',
    actionClassName:
      'text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
    titlePillClassName:
      'bg-[var(--secondary)] text-[var(--foreground)] ring-[var(--border)]',
  },
  SOUTH_SEA: {
    accentDotClassName: 'bg-[var(--muted-foreground)]',
    accentBarClassName: 'bg-[var(--border-strong)]',
    actionClassName:
      'text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
    titlePillClassName:
      'bg-[var(--secondary)] text-[var(--foreground)] ring-[var(--border)]',
  },
  WEST_FRONT: {
    accentDotClassName: 'bg-[var(--muted-foreground)]',
    accentBarClassName: 'bg-[var(--border-strong)]',
    actionClassName:
      'text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
    titlePillClassName:
      'bg-[var(--secondary)] text-[var(--foreground)] ring-[var(--border)]',
  },
  FOREIGN_AFFAIRS: {
    accentDotClassName: 'bg-[var(--muted-foreground)]',
    accentBarClassName: 'bg-[var(--border-strong)]',
    actionClassName:
      'text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
    titlePillClassName:
      'bg-[var(--secondary)] text-[var(--foreground)] ring-[var(--border)]',
  },
  DOMESTIC_AFFAIRS: {
    accentDotClassName: 'bg-[var(--muted-foreground)]',
    accentBarClassName: 'bg-[var(--border-strong)]',
    actionClassName:
      'text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
    titlePillClassName:
      'bg-[var(--secondary)] text-[var(--foreground)] ring-[var(--border)]',
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
