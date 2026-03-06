import { ArchiveVertical } from './archive.types';

export const ARCHIVE_CLASSIFICATION_SOURCE = 'archive-classification';
export const ARCHIVE_CLASSIFICATION_TAXONOMY_VERSION = 'archive-vertical-v1';
export const ARCHIVE_CLASSIFICATION_PIPELINE_VERSION = 'archive-hybrid-v1';
export const ARCHIVE_CLASSIFICATION_TEXT_VERSION = 'archive-text-v1';
export const ARCHIVE_CLASSIFICATION_EMPTY_TEXT =
  'Title: none\nSummary: none\nTopics: none\nEntities: none\nLocation: none';

export const ARCHIVE_FUSION_WEIGHTS = {
  rule: 0.4,
  embedding: 0.3,
  rerank: 0.3,
} as const;

export const ARCHIVE_RULE_STRONG_SCORE = 1;
export const ARCHIVE_RULE_WEAK_SCORE = 0.65;
export const ARCHIVE_CLASSIFICATION_EMBEDDING_BATCH_SIZE = 64;
export const ARCHIVE_CLASSIFICATION_PERSIST_BATCH_SIZE = 100;
export const ARCHIVE_CLASSIFICATION_RERANK_CONCURRENCY = 8;

export const ARCHIVE_VERTICAL_ANCHORS: Record<ArchiveVertical, string> = {
  [ArchiveVertical.EAST_SEA]:
    '东海、朝鲜半岛、日本、韩国、台海周边海空安全态势；East China Sea, Korean Peninsula, Japan, South Korea, Taiwan Strait, maritime security, air defense, missile launch, naval patrol, coast guard, military posture, alliance exercises, regional deterrence.',
  [ArchiveVertical.SOUTH_SEA]:
    '南海、岛礁、海警、航道、东盟沿海争议；South China Sea, reefs and shoals, islands, coast guard, freedom of navigation, maritime claims, Spratly, Paracel, Scarborough, shipping lane, ASEAN coastal disputes, maritime confrontation.',
  [ArchiveVertical.WEST_FRONT]:
    '西面、中亚、阿富汗、印巴、边境安全；western frontier, Central Asia, Afghanistan, India Pakistan, Kashmir, border security, cross-border infiltration, militant activity, frontier tension, Tajikistan, Uzbekistan, regional instability.',
  [ArchiveVertical.FOREIGN_AFFAIRS]:
    '外交、制裁、双多边关系、经贸摩擦、国际博弈；foreign affairs, diplomacy, sanction, countermeasure, summit, bilateral relations, multilateral talks, trade friction, export control, geopolitical contest, embassy, foreign ministry, international negotiation.',
  [ArchiveVertical.DOMESTIC_AFFAIRS]:
    '内政、政策、经济治理、基建、能源、社会治理；domestic affairs, internal policy, economic governance, macro policy, infrastructure, energy strategy, industrial policy, social governance, provincial development, regulation, reform, domestic administration.',
};
