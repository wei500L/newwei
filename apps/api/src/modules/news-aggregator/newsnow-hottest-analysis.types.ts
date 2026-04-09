import type { NewsnowDataState } from './news-aggregator.types';

export type NewsnowContentKind =
  | 'article'
  | 'discussion'
  | 'video'
  | 'mixed'
  | 'unknown';

export enum NewsnowHottestAnalysisEmptyReason {
  NoHottestSourcesConfigured = 'no_hottest_sources_configured',
  AllSourcesFailed = 'all_sources_failed',
  NoSourceItems = 'no_source_items',
  NoHotSignals = 'no_hot_signals',
  NoCandidates = 'no_candidates',
}

export interface NewsnowHottestAnalysisDiagnostics {
  sourcesRequested: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  sourceItemsFetched: number;
}

export interface NewsnowHotSignalState {
  firstSeenAt: string;
  lastSeenAt: string;
  lastRank: number | null;
}

export interface NewsnowHotSignalSeed {
  signalKey: string;
  sourceId: string;
  sourceName: string;
  sourceHome: string | null;
  sourceUpdatedTime: string | null;
  itemId: string;
  title: string;
  url: string;
  mobileUrl: string | null;
  hoverSummary: string | null;
  heatText: string | null;
  heatValue: number | null;
  rank: number;
  normalizedTitle: string;
  authority: number;
}

export interface NewsnowHotSignal extends NewsnowHotSignalSeed {
  capturedAt: string;
  state: NewsnowHotSignalState | null;
  isNew: boolean;
  isRising: boolean;
  freshnessScore: number;
}

export interface NewsnowHottestGlobalSnapshot {
  signature: string;
  generatedAt: string;
  diagnostics: NewsnowHottestAnalysisDiagnostics;
  errors: { sourceId: string; message: string }[];
  totalDomesticSourceCount: number;
  globalMaxHeatValue: number;
  signalSeeds: NewsnowHotSignalSeed[];
  clusters: NewsnowHotSignalCluster[];
  clusterInsights: NewsnowClusterInsight[];
}

export interface NewsnowHotSignalCluster {
  clusterId: string;
  itemKeys: string[];
  sourceIds: string[];
  representativeTitle: string;
  totalHeatValue: number;
  maxHeatValue: number;
  avgRank: number;
}

export interface NewsnowClusterInsight {
  clusterId: string;
  theme: string;
  label: string;
  summary: string | null;
  reason: string | null;
  topics: string[];
  entities: { name: string; type: string | null }[];
  contentKind: NewsnowContentKind;
  bridgeEligibleSuggestion: boolean;
  confidence: number;
}

export interface NewsnowAnalyzedItem {
  sourceId: string;
  itemId: string;
  clusterId: string;
  theme: string | null;
  candidateLabel: string | null;
  candidateSummary: string | null;
  reason: string | null;
  topics: string[];
  entities: string[];
  contentKind: NewsnowContentKind;
  sourceCount: number;
  heatScore: number;
  freshnessScore: number;
  candidateScore: number;
  isNew: boolean;
  isRising: boolean;
  bridgeEligible: boolean;
  bridgeStatus: 'existing' | 'queued' | 'eligible' | 'not_supported';
  matchedItemId?: string;
  matchedEventId?: string;
}

export interface NewsnowEventCandidate {
  candidateId: string;
  label: string;
  summary: string | null;
  reason: string | null;
  themes: string[];
  entities: string[];
  sourceIds: string[];
  sourceCount: number;
  itemCount: number;
  heatScore: number;
  freshnessScore: number;
  candidateScore: number;
  itemRefs: {
    sourceId: string;
    itemId: string;
    title: string;
    matchedItemId?: string;
    matchedEventId?: string;
  }[];
}

export interface NewsnowHottestAnalysisResponse {
  generatedAt: string;
  cached: boolean;
  dataState: NewsnowDataState;
  emptyReason: NewsnowHottestAnalysisEmptyReason | null;
  diagnostics: NewsnowHottestAnalysisDiagnostics;
  sourcesAnalyzed: number;
  itemsAnalyzed: number;
  bySource: Record<string, Record<string, NewsnowAnalyzedItem>>;
  candidates: NewsnowEventCandidate[];
  errors: { sourceId: string; message: string }[];
}
