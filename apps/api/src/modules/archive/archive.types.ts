export enum ArchiveRegion {
  APAC = "APAC",
  MIDDLE_EAST = "MIDDLE_EAST",
  AMERICAS = "AMERICAS",
  EUROPE = "EUROPE",
  AFRICA = "AFRICA",
  OTHER = "OTHER",
}

export enum ArchiveVertical {
  EAST_SEA = "EAST_SEA",
  SOUTH_SEA = "SOUTH_SEA",
  WEST_FRONT = "WEST_FRONT",
  FOREIGN_AFFAIRS = "FOREIGN_AFFAIRS",
  DOMESTIC_AFFAIRS = "DOMESTIC_AFFAIRS",
}

export enum ArchiveWeight {
  ONE = "ONE",
  TWO = "TWO",
  THREE = "THREE",
  FOUR = "FOUR",
  FIVE = "FIVE",
}

export enum ArchiveMatchOrigin {
  LEXICAL = "LEXICAL",
  SEMANTIC = "SEMANTIC",
  HYBRID = "HYBRID",
}

export enum ArchivePreparationState {
  IDLE = "IDLE",
  QUEUED = "QUEUED",
  PROCESSING = "PROCESSING",
  PARTIAL = "PARTIAL",
  READY = "READY",
  FAILED = "FAILED",
}

export enum ArchiveClassificationDecisionReason {
  FUSED_WINNER = "FUSED_WINNER",
  STRONG_RULE_OVERRIDE = "STRONG_RULE_OVERRIDE",
  RULE_FALLBACK_LOW_SEMANTIC_CONFIDENCE = "RULE_FALLBACK_LOW_SEMANTIC_CONFIDENCE",
  DEFAULT_FOREIGN_AFFAIRS_FALLBACK = "DEFAULT_FOREIGN_AFFAIRS_FALLBACK",
  STALE_CACHED_RESULT = "STALE_CACHED_RESULT",
}

export enum ArchiveClassificationStaleReason {
  TAXONOMY_VERSION_CHANGED = "taxonomy-version-changed",
  PIPELINE_VERSION_CHANGED = "pipeline-version-changed",
  EMBEDDING_MODEL_CHANGED = "embedding-model-changed",
  RERANK_MODEL_CHANGED = "rerank-model-changed",
}

export const ARCHIVE_CLASSIFICATION_DECISION_I18N_KEY: Record<
  ArchiveClassificationDecisionReason,
  string
> = {
  [ArchiveClassificationDecisionReason.FUSED_WINNER]:
    "pages.eventsArchive.detail.classificationReason.fusedWinner",
  [ArchiveClassificationDecisionReason.STRONG_RULE_OVERRIDE]:
    "pages.eventsArchive.detail.classificationReason.strongRuleOverride",
  [ArchiveClassificationDecisionReason.RULE_FALLBACK_LOW_SEMANTIC_CONFIDENCE]:
    "pages.eventsArchive.detail.classificationReason.ruleFallbackLowSemanticConfidence",
  [ArchiveClassificationDecisionReason.DEFAULT_FOREIGN_AFFAIRS_FALLBACK]:
    "pages.eventsArchive.detail.classificationReason.defaultForeignAffairsFallback",
  [ArchiveClassificationDecisionReason.STALE_CACHED_RESULT]:
    "pages.eventsArchive.detail.classificationReason.staleCachedResult",
};

export const ARCHIVE_CLASSIFICATION_STALE_REASON_I18N_KEY: Record<
  ArchiveClassificationStaleReason,
  string
> = {
  [ArchiveClassificationStaleReason.TAXONOMY_VERSION_CHANGED]:
    "pages.eventsArchive.detail.classificationStaleReason.taxonomyVersionChanged",
  [ArchiveClassificationStaleReason.PIPELINE_VERSION_CHANGED]:
    "pages.eventsArchive.detail.classificationStaleReason.pipelineVersionChanged",
  [ArchiveClassificationStaleReason.EMBEDDING_MODEL_CHANGED]:
    "pages.eventsArchive.detail.classificationStaleReason.embeddingModelChanged",
  [ArchiveClassificationStaleReason.RERANK_MODEL_CHANGED]:
    "pages.eventsArchive.detail.classificationStaleReason.rerankModelChanged",
};

export type ArchiveWeightValue = 1 | 2 | 3 | 4 | 5;

export const ARCHIVE_WEIGHT_TO_VALUE: Record<
  ArchiveWeight,
  ArchiveWeightValue
> = {
  [ArchiveWeight.ONE]: 1,
  [ArchiveWeight.TWO]: 2,
  [ArchiveWeight.THREE]: 3,
  [ArchiveWeight.FOUR]: 4,
  [ArchiveWeight.FIVE]: 5,
};

export const ARCHIVE_VERTICAL_DISPLAY_NAME: Record<ArchiveVertical, string> = {
  [ArchiveVertical.EAST_SEA]: "【东海】",
  [ArchiveVertical.SOUTH_SEA]: "【南海】",
  [ArchiveVertical.WEST_FRONT]: "【西面】",
  [ArchiveVertical.FOREIGN_AFFAIRS]: "【外务】",
  [ArchiveVertical.DOMESTIC_AFFAIRS]: "【内务】",
};

export const ARCHIVE_VERTICAL_ORDER: ArchiveVertical[] = [
  ArchiveVertical.EAST_SEA,
  ArchiveVertical.SOUTH_SEA,
  ArchiveVertical.WEST_FRONT,
  ArchiveVertical.FOREIGN_AFFAIRS,
  ArchiveVertical.DOMESTIC_AFFAIRS,
];

export type ArchiveVerticalScores = Record<ArchiveVertical, number>;

export const createArchiveVerticalScoreMap = (
  initialValue = 0,
): ArchiveVerticalScores => ({
  [ArchiveVertical.EAST_SEA]: initialValue,
  [ArchiveVertical.SOUTH_SEA]: initialValue,
  [ArchiveVertical.WEST_FRONT]: initialValue,
  [ArchiveVertical.FOREIGN_AFFAIRS]: initialValue,
  [ArchiveVertical.DOMESTIC_AFFAIRS]: initialValue,
});

export interface ArchiveDigestQueryInput {
  anchorDate: Date;
  region: ArchiveRegion;
  search?: string;
  weights?: ArchiveWeight[];
  limitPerVertical?: number;
  pageSize?: number;
  cursors?: ArchiveVerticalCursorInput[];
}

export interface ArchiveVerticalCursorInput {
  vertical: ArchiveVertical;
  cursor?: string;
}

export interface ArchiveCalendarQueryInput {
  month: string;
  region?: ArchiveRegion;
  vertical?: ArchiveVertical;
}

export interface ArchiveDigestItem {
  processedArticleId: string;
  eventId?: string | null;
  title: string | null;
  summary: string | null;
  countryLabel: string | null;
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  weight: ArchiveWeightValue;
  qualityScore: number | null;
  publishedAt: Date | null;
  sortAt: Date;
  sourceLabel: string | null;
  sourceUrl: string | null;
  entityTags: string[];
  keywordHighlights: string[];
  matchOrigin?: ArchiveMatchOrigin | null;
  relevanceScore?: number | null;
  rerankScore?: number | null;
}

export interface ArchiveVerticalGroup {
  vertical: ArchiveVertical;
  displayName: string;
  totalCount: number;
  items: ArchiveDigestItem[];
  pageInfo: ArchiveVerticalPageInfo;
}

export interface ArchiveVerticalPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ArchiveDigestResult {
  anchorDate: Date;
  region: ArchiveRegion;
  totalCount: number;
  groups: ArchiveVerticalGroup[];
  preparation: ArchivePreparationStatus;
}

export interface ArchivePreparationStatus {
  state: ArchivePreparationState;
  readyCount: number;
  missingCount: number;
  updatedAt: Date;
  errorMessage?: string | null;
}

export interface ArchiveCalendarDayResult {
  date: string;
  count: number;
}

export interface ArchiveTimelineEntryResult {
  id: string;
  bucketStart: Date;
  title: string | null;
  summary: string | null;
}

export interface ArchiveRelatedArticleResult {
  processedArticleId: string;
  title: string | null;
  summary: string | null;
  publishedAt: Date | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
}

export interface ArchiveClassificationScoreEntryResult {
  vertical: ArchiveVertical;
  ruleScore: number;
  embeddingScore: number;
  rerankScore: number;
  fusedScore: number;
}

export interface ArchiveClassificationDetailResult {
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  taxonomyVersion: string;
  pipelineVersion: string;
  embeddingModel: string;
  rerankModel: string;
  decisionReason: ArchiveClassificationDecisionReason;
  decisionReasonI18nKey: string;
  isStale: boolean;
  staleReasons: ArchiveClassificationStaleReason[];
  staleReasonI18nKeys: string[];
  ruleSignals: string[];
  scoreEntries: ArchiveClassificationScoreEntryResult[];
}

export interface ArchiveDetailResult {
  processedArticleId: string;
  eventId: string | null;
  title: string | null;
  summary: string | null;
  fullEntities: string[];
  sourceUrl: string | null;
  sourceLabel: string | null;
  classification: ArchiveClassificationDetailResult | null;
  timeline: ArchiveTimelineEntryResult[];
  relatedArticles: ArchiveRelatedArticleResult[];
}
