export type SituationMonitorMatchReasonCode =
  | "keyword"
  | "topic"
  | "entity"
  | "source"
  | "semantic"
  | "rerank"
  | "geo";

export interface SituationMonitorMatchReason {
  code: SituationMonitorMatchReasonCode;
  label: string;
  matchedValues?: string[];
  score?: number;
}

export type SituationMonitorMatchGeoStatus =
  | "not_configured"
  | "matched"
  | "country_match"
  | "conflict"
  | "unresolved";

export interface SituationMonitorMatchResult {
  itemKey: string;
  itemType:
    | "headline"
    | "alert"
    | "situation"
    | "telegram"
    | "oref_alert"
    | "oref_history";
  monitorId: string;
  monitorKind: "manual" | "system_sync";
  monitorName: string;
  monitorColor?: string;
  score: number;
  geoStatus: SituationMonitorMatchGeoStatus;
  matchedTerms: string[];
  reasons: SituationMonitorMatchReason[];
  itemMetaId?: string;
  title: string;
  titleZh?: string;
  summary?: string;
  summaryZh?: string;
  link: string;
  source: string;
  timestamp: number;
  category?: string;
}

export interface SituationMonitorLocation {
  name: string;
  lat: number;
  lng: number;
  bounds?: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  countryCodeAlpha2?: string;
}

export interface SituationMonitorRejectedSuggestions {
  topics: string[];
  entities: string[];
  lexicalTerms: string[];
}

export interface StoredSituationMonitor {
  id: string;
  kind: "manual" | "system_sync";
  name: string;
  enabled: boolean;
  color?: string;
  rawKeywords: string[];
  approvedTopics: string[];
  approvedEntities: string[];
  approvedSources: string[];
  approvedGeos: string[];
  approvedLexicalTerms: string[];
  rejectedSuggestions: SituationMonitorRejectedSuggestions;
  location?: SituationMonitorLocation;
  queryEmbeddingModel?: string;
  lastResolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SituationMonitorPreviewSuggestion {
  value: string;
  normalizedValue: string;
  displayValue: string;
  reason: "lexical" | "semantic" | "rerank";
  score?: number;
  matchedTerms?: string[];
  taxonomyPath?: string | null;
  taxonomyDisplayName?: string | null;
}

export interface SituationMonitorPreviewResponse {
  name: string;
  rawKeywords: string[];
  locationResolution: SituationMonitorLocation | null;
  suggestedTopics: SituationMonitorPreviewSuggestion[];
  suggestedEntities: SituationMonitorPreviewSuggestion[];
  suggestedLexicalTerms: SituationMonitorPreviewSuggestion[];
  modelInfo: {
    embeddingModel?: string;
    rerankModel?: string;
  };
}
