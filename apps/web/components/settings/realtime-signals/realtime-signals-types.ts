import type { RealtimeAisRuntimeDiagnostics } from "@modular/utils";
import type { FormInstance } from "antd";

import type {
  RealtimeSignalErrorCode,
  RealtimeSignalRuntimeStatus,
} from "@/lib/realtime-signals-runtime";

export type RealtimeSignalsSettingsSource = "env" | "db";
export type RealtimeSignalsRuntimeSettingsSource =
  | RealtimeSignalsSettingsSource
  | "unknown";
export type RealtimeSignalsSecretSource = "stored" | "env" | "none";
export type RealtimeSignalsAcledAccessTokenStatus =
  | "ready"
  | "expiring"
  | "missing"
  | "refresh_failed";
export type RealtimeSignalSourceKey =
  | "opensky"
  | "ais"
  | "unrest"
  | "outages"
  | "keyword_spike"
  | "pizzint"
  | "gdelt_tension"
  | "polymarket_leads";
export type RealtimeOpenskySnapshotFreshness = "fresh" | "stale" | "missing";
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
export type RealtimeSignalsTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

export interface RealtimeSignalsSettingsResponse {
  source: RealtimeSignalsSettingsSource;
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  acledApiEnabled: boolean;
  acledApiDisabledReason?: string;
  openskyEnabled: boolean;
  openskyIntervalSec: number;
  openskyDailyCreditBudget: number;
  openskyDayIntervalSec: number;
  openskyNightIntervalSec: number;
  openskyDayStartHourHkt: number;
  openskyNightStartHourHkt: number;
  openskyWarningRemainingPct: number;
  openskyCriticalRemainingPct: number;
  aisEnabled: boolean;
  aisIntervalSec: number;
  unrestEnabled: boolean;
  unrestIntervalSec: number;
  outagesEnabled: boolean;
  outagesIntervalSec: number;
  keywordSpikeEnabled: boolean;
  keywordSpikeIntervalSec: number;
  pizzintEnabled: boolean;
  pizzintIntervalSec: number;
  gdeltTensionEnabled: boolean;
  gdeltTensionIntervalSec: number;
  polymarketLeadsEnabled: boolean;
  polymarketLeadsIntervalSec: number;
  keywordSpikeMinCount: number;
  keywordSpikeMultiplier: number;
  predictionShiftThreshold: number;
  predictionNewsActivityThreshold: number;
  openskyBaseUrl?: string;
  openskyTokenUrl?: string;
  aisRelayBaseUrl?: string;
  polymarketProxyUrl?: string;
  openskyClientId?: string;
  openskyClientIdSource: RealtimeSignalsSecretSource;
  hasAisRelaySharedSecret: boolean;
  aisRelaySharedSecretSource: RealtimeSignalsSecretSource;
  hasOpenskyClientSecret: boolean;
  openskyClientSecretSource: RealtimeSignalsSecretSource;
  hasAcledAccessToken: boolean;
  acledAccessTokenSource: RealtimeSignalsSecretSource;
  acledAccessTokenStatus: RealtimeSignalsAcledAccessTokenStatus;
  acledAccessTokenExpiresAt?: string;
  acledAccessTokenRefreshedAt?: string;
  acledAccessTokenLastAttemptAt?: string;
  acledAccessTokenLastError?: string;
  acledOauthUsername?: string;
  acledOauthUsernameSource: RealtimeSignalsSecretSource;
  hasAcledOauthPassword: boolean;
  acledOauthPasswordSource: RealtimeSignalsSecretSource;
  acledOauthClientId: string;
  acledOauthClientIdSource: RealtimeSignalsSecretSource;
  hasCloudflareApiToken: boolean;
  cloudflareApiTokenSource: RealtimeSignalsSecretSource;
  hasWingbitsApiKey: boolean;
  wingbitsApiKeySource: RealtimeSignalsSecretSource;
}

export interface RealtimeSignalsSettingsFormValues {
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  openskyEnabled: boolean;
  openskyIntervalSec: number;
  openskyDailyCreditBudget: number;
  openskyDayIntervalSec: number;
  openskyNightIntervalSec: number;
  openskyDayStartHourHkt: number;
  openskyNightStartHourHkt: number;
  openskyWarningRemainingPct: number;
  openskyCriticalRemainingPct: number;
  aisEnabled: boolean;
  aisIntervalSec: number;
  unrestEnabled: boolean;
  unrestIntervalSec: number;
  outagesEnabled: boolean;
  outagesIntervalSec: number;
  keywordSpikeEnabled: boolean;
  keywordSpikeIntervalSec: number;
  pizzintEnabled: boolean;
  pizzintIntervalSec: number;
  gdeltTensionEnabled: boolean;
  gdeltTensionIntervalSec: number;
  polymarketLeadsEnabled: boolean;
  polymarketLeadsIntervalSec: number;
  keywordSpikeMinCount: number;
  keywordSpikeMultiplier: number;
  predictionShiftThreshold: number;
  predictionNewsActivityThreshold: number;
  openskyBaseUrl?: string;
  openskyTokenUrl?: string;
  aisRelayBaseUrl?: string;
  polymarketProxyUrl?: string;
  openskyClientId?: string;
  aisRelaySharedSecret?: string;
  openskyClientSecret?: string;
  acledOauthUsername?: string;
  acledOauthPassword?: string;
  acledOauthClientId?: string;
  cloudflareApiToken?: string;
  wingbitsApiKey?: string;
}

export interface RealtimeSignalRuntimeDiagnosticsSource {
  source: RealtimeSignalSourceKey;
  enabled: boolean;
  intervalSec: number;
  configuredIntervalSec?: number;
  status: RealtimeSignalRuntimeStatus;
  statusReason?: string;
  statusReasonCode?: string;
  lastRunAt?: string;
  lastAttemptAt?: string;
  nextEligibleAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastErrorCode?: RealtimeSignalErrorCode;
  lastErrorKind?: RealtimeOpenskyErrorKind;
  lastErrorStatus?: number;
  lastRateLimit?: {
    retryAfterSec?: number;
    rateLimit?: string;
    rateLimitPolicy?: string;
    cfRay?: string;
  };
  latestValue: number | null;
  previousValue: number | null;
  changePercent: number | null;
  context?: Record<string, unknown>;
  aisDiagnostics?: RealtimeAisRuntimeDiagnostics;
  openskySnapshot?: {
    freshness: RealtimeOpenskySnapshotFreshness;
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
  };
  adsbSnapshot?: {
    freshness: RealtimeOpenskySnapshotFreshness;
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
  };
}

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

export interface RealtimeSignalsRuntimeDiagnosticsResponse {
  checkedAt: string;
  settingsSource: RealtimeSignalsRuntimeSettingsSource;
  runtimeEnabled: boolean;
  insight: {
    keywordSpikes: Record<string, unknown>[];
    predictionLeads: Record<string, unknown>[];
    tensions: Record<string, unknown>[];
    pizzint?: {
      defcon: number;
      updatedAt: string;
    };
  };
  markerReadiness: {
    windowHours: number;
    recentProcessedArticles: number;
    recentProcessedArticlesWithLocation: number;
    recentMongoProcessedItems: number;
    recentMongoProcessedItemsWithLocation: number;
    latestProcessedArticleAt?: string;
    latestProcessedItemAt?: string;
    newsMarkersReady: boolean;
  };
  sources: RealtimeSignalRuntimeDiagnosticsSource[];
  openskyBudget?: RealtimeOpenskyBudgetSummary;
}

/**
 * 面板加载状态：
 * - initialLoading 首次 GET 尚未返回，尚无真实服务器配置。
 * - blockingError  首次 GET 失败且没有任何真实数据（FE-RT-01），不允许
 *   把 EMPTY_SETTINGS 伪装成服务器状态。
 * - ready           已成功加载（可能带一次非阻断刷新失败）。
 */
export type RealtimeSignalsLoadState =
  | { kind: "initialLoading" }
  | { kind: "blockingError" }
  | { kind: "ready" };

export type RealtimeSignalsFormInstance = FormInstance<RealtimeSignalsSettingsFormValues>;

export interface RealtimeSignalSourceStatusRow {
  sourceKey: RealtimeSignalSourceKey;
  key: string;
  sourceName: string;
  enabled: boolean;
  intervalSec: number | null;
  intervalLabel?: string;
}

export interface RealtimeSignalsSecretStatusRow {
  key: string;
  label: string;
  has: boolean;
  source: RealtimeSignalsSecretSource;
}
