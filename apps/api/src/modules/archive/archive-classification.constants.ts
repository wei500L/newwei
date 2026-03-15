export const ARCHIVE_CLASSIFICATION_SOURCE = 'archive-classification';
export const ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION = 'archive-vertical-v2';
export const ARCHIVE_CLASSIFICATION_PIPELINE_VERSION = 'archive-hybrid-v2';
export const ARCHIVE_CLASSIFICATION_TEXT_VERSION = 'archive-text-v2';
export const ARCHIVE_CLASSIFICATION_EMPTY_TEXT =
  [
    'Title: none',
    'Summary: none',
    'Topics: none',
    'Entities: none',
    'Location: none',
    'Source: none',
    'Country hint: none',
    'Region hint: OTHER',
  ].join('\n');

export const ARCHIVE_FUSION_WEIGHTS = {
  rule: 0.4,
  embedding: 0.3,
  rerank: 0.3,
} as const;

export const ARCHIVE_RULE_STRONG_SCORE = 1;
export const ARCHIVE_RULE_STRONG_KEYWORD_INCREMENT = 0.35;
export const ARCHIVE_RULE_WEAK_KEYWORD_INCREMENT = 0.18;
export const ARCHIVE_RULE_EXCLUDED_KEYWORD_PENALTY = 0.2;
export const ARCHIVE_RULE_CONFLICT_KEYWORD_PENALTY = 0.25;
export const ARCHIVE_CLASSIFICATION_EMBEDDING_BATCH_SIZE = 64;
export const ARCHIVE_CLASSIFICATION_PERSIST_BATCH_SIZE = 100;
export const ARCHIVE_CLASSIFICATION_RERANK_CONCURRENCY = 8;
