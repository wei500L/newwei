export type RealtimeSignalSource =
  | "opensky"
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
  credentials: {
    openskyClientId?: string;
    openskyClientSecret?: string;
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
