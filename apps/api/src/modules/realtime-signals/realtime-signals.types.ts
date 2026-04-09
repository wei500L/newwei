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

export interface RealtimeAisRelayStatusSnapshot {
  connected: boolean;
  vessels: number;
  messages: number;
  clients: number;
  droppedMessages: number;
}

export type RealtimeAisRelayHealthState = "ok" | "degraded";

export interface RealtimeAisRelayDiagnostics {
  healthState: RealtimeAisRelayHealthState;
  statusReason?: string;
  statusReasonCode?: string;
  positionReportsSeen: number;
  positionReportsProcessed: number;
  ignoredPositionReports: number;
  parseErrors: number;
  lastHealthyAt?: string;
  lastIssueAt?: string;
  lastUpstreamErrorAt?: string;
  lastUpstreamError?: string;
  lastParseErrorAt?: string;
  lastParseError?: string;
}

export type RealtimeAisDisruptionSeverity = "low" | "elevated" | "high";

export interface RealtimeAisDisruptionSnapshot {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  severity: RealtimeAisDisruptionSeverity;
  changePct?: number;
  windowHours?: number;
  vesselCount?: number;
  region?: string;
  description?: string;
  darkShips?: number;
}

export interface RealtimeAisDensitySnapshot {
  id: string;
  name?: string;
  lat: number;
  lng: number;
  intensity: number;
  deltaPct?: number;
  shipsPerDay?: number;
  note?: string;
}

export interface RealtimeAisVesselSnapshot {
  mmsi: string;
  name?: string;
  lat: number;
  lng: number;
  shipType?: number;
  heading?: number;
  speed?: number;
  course?: number;
  observedAt: string;
}

export interface RealtimeAisLatestSnapshot {
  source: "relay";
  sourceEndpoint: string;
  updatedAt: string;
  status: RealtimeAisRelayStatusSnapshot;
  diagnostics: RealtimeAisRelayDiagnostics;
  disruptions: RealtimeAisDisruptionSnapshot[];
  density: RealtimeAisDensitySnapshot[];
  candidateReports: RealtimeAisVesselSnapshot[];
  vessels: RealtimeAisVesselSnapshot[];
  hasVesselSnapshot: boolean;
}

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

export type RealtimeAdsbSnapshotDiagnostics =
  RealtimeOpenskySnapshotDiagnostics;

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

export type RealtimeOpenskyBudgetPeriod = "day" | "night";

export type RealtimeOpenskyBudgetDegradationLevel =
  | "normal"
  | "warning"
  | "critical"
  | "exhausted";

export type RealtimeOpenskyErrorKind =
  | "auth"
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "unknown";

export interface RealtimeOpenskyBudgetDaySummary {
  dateHkt: string;
  usedCredits: number;
  requestCount: number;
  militaryCredits: number;
  allCredits: number;
  militaryCalls: number;
  allCalls: number;
  errorCalls: number;
  authErrorCalls: number;
  rateLimitedErrorCalls: number;
  serverErrorCalls: number;
  timeoutErrorCalls: number;
  networkErrorCalls: number;
  unknownErrorCalls: number;
  blockedAllModeCount: number;
  skippedMilitaryCount: number;
}

export interface RealtimeOpenskyBudgetSummary {
  timezone: string;
  dateHkt: string;
  dailyBudget: number;
  usedCredits: number;
  remainingCredits: number;
  usagePct: number;
  remainingPct: number;
  requestCount: number;
  militaryCredits: number;
  allCredits: number;
  militaryCalls: number;
  allCalls: number;
  errorCalls: number;
  authErrorCalls: number;
  rateLimitedErrorCalls: number;
  serverErrorCalls: number;
  timeoutErrorCalls: number;
  networkErrorCalls: number;
  unknownErrorCalls: number;
  blockedAllModeCount: number;
  skippedMilitaryCount: number;
  currentPeriod: RealtimeOpenskyBudgetPeriod;
  dayIntervalSec: number;
  nightIntervalSec: number;
  effectiveMilitaryIntervalSec: number;
  degradationLevel: RealtimeOpenskyBudgetDegradationLevel;
  allModeBlocked: boolean;
  militaryPaused: boolean;
  warningRemainingPct: number;
  criticalRemainingPct: number;
  recentDays: RealtimeOpenskyBudgetDaySummary[];
}

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
  aisRelay: {
    baseUrl?: string;
    sharedSecret?: string;
  };
  opensky: {
    baseUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    dailyCreditBudget: number;
    dayIntervalSec: number;
    nightIntervalSec: number;
    dayStartHourHkt: number;
    nightStartHourHkt: number;
    warningRemainingPct: number;
    criticalRemainingPct: number;
  };
  credentials: {
    acledAccessToken?: string;
    cloudflareApiToken?: string;
    wingbitsApiKey?: string;
  };
  polymarket: {
    proxyUrl?: string;
  };
}

export interface RealtimeSignalsInsightSnapshot {
  keywordSpikes: {
    id: string;
    term: string;
    count: number;
    baseline: number;
    multiplier: number;
    sourceCount: number;
    confidence: number;
  }[];
  predictionLeads: {
    id: string;
    title: string;
    shift: number;
    newsActivity: number;
    confidence: number;
  }[];
  pizzint?: {
    defcon: number;
    adjustedScore: number;
    openLocations: number;
    activeSpikes: number;
    avgPop: number;
    updatedAt: string;
  };
  tensions: {
    id: string;
    label: string;
    score: number;
    changePercent: number;
    trend: "rising" | "stable" | "falling";
    countries: string[];
    updatedAt: string;
  }[];
}

export interface RealtimeSignalSourceState {
  source: RealtimeSignalSource;
  status: "success" | "error";
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastErrorKind?: RealtimeOpenskyErrorKind;
  lastErrorStatus?: number;
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
  configuredIntervalSec?: number;
  status: RealtimeSignalRuntimeStatus;
  statusReason?: string;
  statusReasonCode?: string;
  lastRunAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastErrorKind?: RealtimeOpenskyErrorKind;
  lastErrorStatus?: number;
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
  openskyBudget?: RealtimeOpenskyBudgetSummary;
}
