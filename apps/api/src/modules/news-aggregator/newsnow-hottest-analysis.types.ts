export type NewsnowContentKind =
  | 'article'
  | 'discussion'
  | 'video'
  | 'mixed'
  | 'unknown';

export interface NewsnowHotSignalState {
  firstSeenAt: string;
  lastSeenAt: string;
  lastRank: number | null;
}

export interface NewsnowHotSignal {
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
  capturedAt: string;
  normalizedTitle: string;
  authority: number;
  state: NewsnowHotSignalState | null;
  isNew: boolean;
  isRising: boolean;
  freshnessScore: number;
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
  entities: Array<{ name: string; type: string | null }>;
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
  itemRefs: Array<{
    sourceId: string;
    itemId: string;
    title: string;
    matchedItemId?: string;
    matchedEventId?: string;
  }>;
}

export interface NewsnowHottestAnalysisResponse {
  generatedAt: string;
  cached: boolean;
  sourcesAnalyzed: number;
  itemsAnalyzed: number;
  bySource: Record<string, Record<string, NewsnowAnalyzedItem>>;
  candidates: NewsnowEventCandidate[];
  errors: Array<{ sourceId: string; message: string }>;
}
