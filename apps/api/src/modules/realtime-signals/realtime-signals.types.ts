export type RealtimeSignalSource =
  | "adsb"
  | "ais"
  | "unrest"
  | "outages"
  | "keyword_spike"
  | "pizzint"
  | "gdelt_tension"
  | "polymarket_leads";

export interface RealtimeSignalMetricPoint {
  ts: string;
  value: number;
  context?: Record<string, unknown>;
}

export interface RealtimeSignalMetricSeries {
  metricSlug: string;
  points: RealtimeSignalMetricPoint[];
}

export interface RealtimeSignalSnapshotEvaluation {
  latest: number | null;
  previous: number | null;
  changePercent: number | null;
  context?: Record<string, unknown>;
}

export interface RealtimeSignalFetchResult {
  metricSlug: string;
  value: number;
  context?: Record<string, unknown>;
}

export interface RealtimeSignalsRuntimeConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  sources: Record<
    RealtimeSignalSource,
    {
      enabled: boolean;
      intervalSec: number;
    }
  >;
  thresholds: {
    keywordSpikeMinCount: number;
    keywordSpikeMultiplier: number;
    predictionShiftThreshold: number;
    predictionNewsActivityThreshold: number;
  };
  relay: {
    baseUrl?: string;
    sharedSecret?: string;
  };
  adsb: {
    baseUrl?: string;
  };
  credentials: {
    aisApiKey?: string;
    acledAccessToken?: string;
    cloudflareApiToken?: string;
    wingbitsApiKey?: string;
  };
  polymarket: {
    proxyUrl?: string;
  };
}

export interface RealtimeSignalsInsightSnapshot {
  keywordSpikes: Array<{
    id: string;
    term: string;
    count: number;
    baseline: number;
    multiplier: number;
    sourceCount: number;
    confidence: number;
  }>;
  predictionLeads: Array<{
    id: string;
    title: string;
    shift: number;
    newsActivity: number;
    confidence: number;
  }>;
  pizzint?: {
    defcon: number;
    adjustedScore: number;
    openLocations: number;
    activeSpikes: number;
    avgPop: number;
    updatedAt: string;
  };
  tensions: Array<{
    id: string;
    label: string;
    score: number;
    changePercent: number;
    trend: "rising" | "stable" | "falling";
    countries: string[];
    updatedAt: string;
  }>;
}

export interface RealtimeSignalSourceState {
  source: RealtimeSignalSource;
  status: "success" | "error";
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  metricSlug?: string;
  latestValue?: number;
  context?: Record<string, unknown>;
}

export type RealtimeSignalRuntimeStatus =
  | "ok"
  | "error"
  | "stale"
  | "not_configured"
  | "idle";

export interface RealtimeSignalRuntimeSourceDiagnostics {
  source: RealtimeSignalSource;
  enabled: boolean;
  intervalSec: number;
  status: RealtimeSignalRuntimeStatus;
  statusReason?: string;
  lastRunAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  latestValue: number | null;
  previousValue: number | null;
  changePercent: number | null;
  context?: Record<string, unknown>;
}

export interface RealtimeSignalsMarkerReadiness {
  windowHours: number;
  recentProcessedArticles: number;
  recentProcessedArticlesWithLocation: number;
  recentMongoProcessedItems: number;
  recentMongoProcessedItemsWithLocation: number;
  latestProcessedArticleAt?: string;
  latestProcessedItemAt?: string;
  newsMarkersReady: boolean;
}

export interface RealtimeSignalsRuntimeDiagnostics {
  checkedAt: string;
  settingsSource: "env" | "db";
  runtimeEnabled: boolean;
  sources: RealtimeSignalRuntimeSourceDiagnostics[];
  insight: RealtimeSignalsInsightSnapshot;
  markerReadiness: RealtimeSignalsMarkerReadiness;
}
