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

export type RealtimeSignalFlightMode = "military" | "all";

export interface RealtimeOpenskyAircraftSnapshot {
  id: string;
  icao24: string;
  callsign?: string;
  registration?: string;
  aircraftType?: string;
  lat: number;
  lng: number;
  heading?: number;
  altitudeFt?: number;
  groundSpeedKt?: number;
  countryCode?: string;
  countryName?: string;
  observedAt: string;
  source: "opensky";
}

export type RealtimeAdsbAircraftSnapshot = RealtimeOpenskyAircraftSnapshot;

export interface RealtimeOpenskySnapshotDiagnostics {
  latestObservedAt?: string;
  oldestObservedAt?: string;
  staleThresholdSec: number;
  droppedInvalidPositionCount: number;
  droppedMissingIdentityCount: number;
  droppedStalePositionCount: number;
  deduplicatedCount: number;
  retainedPreviousSnapshot: boolean;
}

export type RealtimeAdsbSnapshotDiagnostics = RealtimeOpenskySnapshotDiagnostics;

export interface RealtimeOpenskyLatestSnapshot {
  source: "opensky";
  sourceEndpoint: string;
  updatedAt: string;
  totalAircraft: number;
  validPositionCount: number;
  latestObservedAt?: string;
  diagnostics: RealtimeOpenskySnapshotDiagnostics;
  aircraft: RealtimeOpenskyAircraftSnapshot[];
}

export type RealtimeAdsbLatestSnapshot = RealtimeOpenskyLatestSnapshot;

export type RealtimeOpenskySnapshotFreshness = "fresh" | "stale" | "missing";

export type RealtimeAdsbSnapshotFreshness = RealtimeOpenskySnapshotFreshness;

export interface RealtimeOpenskyRuntimeDiagnostics {
  freshness: RealtimeAdsbSnapshotFreshness;
  rawAircraftCount: number;
  currentValidPositionCount: number;
  snapshotValidPositionCount: number;
  snapshotUpdatedAt?: string;
  snapshotAgeSec?: number;
  latestObservedAt?: string;
  latestObservedAgeSec?: number;
  staleThresholdSec: number;
  retainedPreviousSnapshot: boolean;
  droppedInvalidPositionCount: number;
  droppedMissingIdentityCount: number;
  droppedStalePositionCount: number;
  deduplicatedCount: number;
}

export type RealtimeAdsbRuntimeDiagnostics = RealtimeOpenskyRuntimeDiagnostics;

export interface RealtimeSignalsRuntimeConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  capabilities: {
    acledApiEnabled: boolean;
    acledApiDisabledReason?: string;
  };
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
  opensky: {
    baseUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
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
  openskySnapshot?: RealtimeOpenskyRuntimeDiagnostics;
  adsbSnapshot?: RealtimeOpenskyRuntimeDiagnostics;
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

export type RealtimeSignalsRuntimeSettingsSource = "env" | "db" | "unknown";

export interface RealtimeSignalsRuntimeDiagnostics {
  checkedAt: string;
  settingsSource: RealtimeSignalsRuntimeSettingsSource;
  runtimeEnabled: boolean;
  sources: RealtimeSignalRuntimeSourceDiagnostics[];
  insight: RealtimeSignalsInsightSnapshot;
  markerReadiness: RealtimeSignalsMarkerReadiness;
}
