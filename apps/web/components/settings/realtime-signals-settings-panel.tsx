"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import {
  buildAisRuntimeFeedbackAlert,
  formatAisRuntimeReason,
  formatRealtimeSignalErrorCode,
  isOutagesRateLimited,
  type RealtimeSignalErrorCode,
  type RealtimeSignalRuntimeStatus,
} from "@/lib/realtime-signals-runtime";
import {
  applyRealtimeSignalsSecretFields,
  REALTIME_SIGNALS_SECRET_FIELD_NAMES,
  type RealtimeSignalsSecretFieldName,
} from "@/lib/realtime-signals-settings-payload";

type RealtimeSignalsSettingsSource = "env" | "db";
type RealtimeSignalsRuntimeSettingsSource =
  | RealtimeSignalsSettingsSource
  | "unknown";
type RealtimeSignalsSecretSource = "stored" | "env" | "none";
type RealtimeSignalsAcledAccessTokenStatus =
  | "ready"
  | "expiring"
  | "missing"
  | "refresh_failed";
type RealtimeSignalSourceKey =
  | "opensky"
  | "ais"
  | "unrest"
  | "outages"
  | "keyword_spike"
  | "pizzint"
  | "gdelt_tension"
  | "polymarket_leads";
type RealtimeOpenskySnapshotFreshness = "fresh" | "stale" | "missing";
type RealtimeOpenskyBudgetPeriod = "day" | "night";
type RealtimeOpenskyBudgetDegradationLevel =
  | "normal"
  | "warning"
  | "critical"
  | "exhausted";
type RealtimeOpenskyErrorKind =
  | "auth"
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "unknown";
type RealtimeSignalsTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

interface RealtimeSignalsSettingsResponse {
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

interface RealtimeSignalsSettingsFormValues {
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

interface RealtimeSignalRuntimeDiagnosticsSource {
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

interface RealtimeOpenskyBudgetDaySummary {
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

interface RealtimeOpenskyBudgetSummary {
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

interface RealtimeSignalsRuntimeDiagnosticsResponse {
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

const EMPTY_SETTINGS: RealtimeSignalsSettingsResponse = {
  source: "env",
  enabled: true,
  requestTimeoutMs: 12_000,
  maxRetries: 2,
  acledApiEnabled: false,
  acledApiDisabledReason: undefined,
  openskyEnabled: true,
  openskyIntervalSec: 900,
  openskyDailyCreditBudget: 4000,
  openskyDayIntervalSec: 600,
  openskyNightIntervalSec: 1800,
  openskyDayStartHourHkt: 8,
  openskyNightStartHourHkt: 22,
  openskyWarningRemainingPct: 20,
  openskyCriticalRemainingPct: 10,
  aisEnabled: true,
  aisIntervalSec: 600,
  unrestEnabled: true,
  unrestIntervalSec: 600,
  outagesEnabled: true,
  outagesIntervalSec: 600,
  keywordSpikeEnabled: true,
  keywordSpikeIntervalSec: 600,
  pizzintEnabled: true,
  pizzintIntervalSec: 600,
  gdeltTensionEnabled: true,
  gdeltTensionIntervalSec: 600,
  polymarketLeadsEnabled: true,
  polymarketLeadsIntervalSec: 600,
  keywordSpikeMinCount: 5,
  keywordSpikeMultiplier: 3,
  predictionShiftThreshold: 5,
  predictionNewsActivityThreshold: 3,
  openskyBaseUrl: "https://opensky-network.org/api",
  openskyTokenUrl:
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
  aisRelayBaseUrl: "",
  polymarketProxyUrl: "",
  openskyClientId: "",
  openskyClientIdSource: "none",
  hasAisRelaySharedSecret: false,
  aisRelaySharedSecretSource: "none",
  hasOpenskyClientSecret: false,
  openskyClientSecretSource: "none",
  hasAcledAccessToken: false,
  acledAccessTokenSource: "none",
  acledAccessTokenStatus: "missing",
  acledAccessTokenExpiresAt: undefined,
  acledAccessTokenRefreshedAt: undefined,
  acledAccessTokenLastAttemptAt: undefined,
  acledAccessTokenLastError: undefined,
  acledOauthUsername: "",
  acledOauthUsernameSource: "none",
  hasAcledOauthPassword: false,
  acledOauthPasswordSource: "none",
  acledOauthClientId: "acled",
  acledOauthClientIdSource: "none",
  hasCloudflareApiToken: false,
  cloudflareApiTokenSource: "none",
  hasWingbitsApiKey: false,
  wingbitsApiKeySource: "none",
};

const SOURCE_CONFIGS = [
  {
    sourceKey: "ais",
    nameKey: "systemSettings.realtimeSignals.sources.ais",
    fallbackName: "AIS",
    enabledField: "aisEnabled",
    intervalField: "aisIntervalSec",
  },
  {
    sourceKey: "unrest",
    nameKey: "systemSettings.realtimeSignals.sources.unrest",
    fallbackName: "Unrest",
    enabledField: "unrestEnabled",
    intervalField: "unrestIntervalSec",
  },
  {
    sourceKey: "outages",
    nameKey: "systemSettings.realtimeSignals.sources.outages",
    fallbackName: "Internet outages",
    enabledField: "outagesEnabled",
    intervalField: "outagesIntervalSec",
  },
  {
    sourceKey: "keyword_spike",
    nameKey: "systemSettings.realtimeSignals.sources.keywordSpike",
    fallbackName: "Keyword spike",
    enabledField: "keywordSpikeEnabled",
    intervalField: "keywordSpikeIntervalSec",
  },
  {
    sourceKey: "pizzint",
    nameKey: "systemSettings.realtimeSignals.sources.pizzint",
    fallbackName: "PizzINT",
    enabledField: "pizzintEnabled",
    intervalField: "pizzintIntervalSec",
  },
  {
    sourceKey: "gdelt_tension",
    nameKey: "systemSettings.realtimeSignals.sources.gdeltTension",
    fallbackName: "GDELT tension",
    enabledField: "gdeltTensionEnabled",
    intervalField: "gdeltTensionIntervalSec",
  },
  {
    sourceKey: "polymarket_leads",
    nameKey: "systemSettings.realtimeSignals.sources.polymarketLeads",
    fallbackName: "Polymarket leads",
    enabledField: "polymarketLeadsEnabled",
    intervalField: "polymarketLeadsIntervalSec",
  },
] as const;

function toFormValues(
  settings: RealtimeSignalsSettingsResponse,
): RealtimeSignalsSettingsFormValues {
  return {
    enabled: settings.enabled,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxRetries: settings.maxRetries,
    openskyEnabled: settings.openskyEnabled,
    openskyIntervalSec: settings.openskyIntervalSec,
    openskyDailyCreditBudget: settings.openskyDailyCreditBudget,
    openskyDayIntervalSec: settings.openskyDayIntervalSec,
    openskyNightIntervalSec: settings.openskyNightIntervalSec,
    openskyDayStartHourHkt: settings.openskyDayStartHourHkt,
    openskyNightStartHourHkt: settings.openskyNightStartHourHkt,
    openskyWarningRemainingPct: settings.openskyWarningRemainingPct,
    openskyCriticalRemainingPct: settings.openskyCriticalRemainingPct,
    aisEnabled: settings.aisEnabled,
    aisIntervalSec: settings.aisIntervalSec,
    unrestEnabled: settings.unrestEnabled,
    unrestIntervalSec: settings.unrestIntervalSec,
    outagesEnabled: settings.outagesEnabled,
    outagesIntervalSec: settings.outagesIntervalSec,
    keywordSpikeEnabled: settings.keywordSpikeEnabled,
    keywordSpikeIntervalSec: settings.keywordSpikeIntervalSec,
    pizzintEnabled: settings.pizzintEnabled,
    pizzintIntervalSec: settings.pizzintIntervalSec,
    gdeltTensionEnabled: settings.gdeltTensionEnabled,
    gdeltTensionIntervalSec: settings.gdeltTensionIntervalSec,
    polymarketLeadsEnabled: settings.polymarketLeadsEnabled,
    polymarketLeadsIntervalSec: settings.polymarketLeadsIntervalSec,
    keywordSpikeMinCount: settings.keywordSpikeMinCount,
    keywordSpikeMultiplier: settings.keywordSpikeMultiplier,
    predictionShiftThreshold: settings.predictionShiftThreshold,
    predictionNewsActivityThreshold: settings.predictionNewsActivityThreshold,
    openskyBaseUrl: settings.openskyBaseUrl ?? "",
    openskyTokenUrl: settings.openskyTokenUrl ?? "",
    aisRelayBaseUrl: settings.aisRelayBaseUrl ?? "",
    polymarketProxyUrl: settings.polymarketProxyUrl ?? "",
    openskyClientId: settings.openskyClientId ?? "",
    aisRelaySharedSecret: "",
    openskyClientSecret: "",
    acledOauthUsername: settings.acledOauthUsername ?? "",
    acledOauthPassword: "",
    acledOauthClientId: settings.acledOauthClientId || "acled",
    cloudflareApiToken: "",
    wingbitsApiKey: "",
  };
}

function summarizeRuntimeContext(
  t: RealtimeSignalsTranslate,
  source: RealtimeSignalSourceKey,
  context?: Record<string, unknown>,
  openskySnapshot?: RealtimeSignalRuntimeDiagnosticsSource["openskySnapshot"],
) {
  if (!context && source !== "opensky") {
    return null;
  }
  const resolvedContext = context ?? {};

  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const str = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  switch (source) {
    case "opensky":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.opensky",
        {
          defaultValue:
            "scope={{scope}}, military={{military}}, raw={{raw}}, current={{current}}, map={{map}}",
          scope: str(resolvedContext.scope) ?? "military",
          military: num(resolvedContext.militaryCount) ?? 0,
          raw:
            openskySnapshot?.rawAircraftCount ??
            num(resolvedContext.totalAircraft) ??
            0,
          current:
            openskySnapshot?.currentValidPositionCount ??
            num(resolvedContext.validPositionCount) ??
            0,
          map:
            openskySnapshot?.snapshotValidPositionCount ??
            num(resolvedContext.snapshotValidPositionCount) ??
            num(resolvedContext.validPositionCount) ??
            0,
        },
      );
    case "ais":
      return resolvedContext.configured === false
        ? t(
            "systemSettings.realtimeSignals.runtime.contextSummary.aisNotConfigured",
            {
              defaultValue: "AIS relay root URL not configured",
            },
          )
        : t("systemSettings.realtimeSignals.runtime.contextSummary.ais", {
            defaultValue:
              "disruptions={{disruptions}}, density={{density}}, vessels={{vessels}}, seen={{seen}}, processed={{processed}}, ignored={{ignored}}, parse={{parse}}",
            disruptions: num(resolvedContext.disruptions) ?? 0,
            density: num(resolvedContext.densityRegions) ?? 0,
            vessels: num(resolvedContext.vesselCount) ?? 0,
            seen: num(resolvedContext.positionReportsSeen) ?? 0,
            processed: num(resolvedContext.positionReportsProcessed) ?? 0,
            ignored: num(resolvedContext.ignoredPositionReports) ?? 0,
            parse: num(resolvedContext.parseErrors) ?? 0,
          });
    case "unrest":
      if (resolvedContext.acledApiEnabled === false) {
        return t(
          "systemSettings.realtimeSignals.runtime.contextSummary.unrestGdeltOnly",
          {
            defaultValue: "mode=gdelt-only, gdelt={{gdelt}}, total={{total}}",
            gdelt: num(resolvedContext.gdeltCount) ?? 0,
            total: num(resolvedContext.unrestCount) ?? 0,
          },
        );
      }
      return t("systemSettings.realtimeSignals.runtime.contextSummary.unrest", {
        defaultValue: "acled={{acled}}, gdelt={{gdelt}}, total={{total}}",
        acled: num(resolvedContext.acledCount) ?? 0,
        gdelt: num(resolvedContext.gdeltCount) ?? 0,
        total: num(resolvedContext.unrestCount) ?? 0,
      });
    case "outages":
      return resolvedContext.configured === false
        ? t(
            "systemSettings.realtimeSignals.runtime.contextSummary.outagesNotConfigured",
            {
              defaultValue: "Cloudflare token not configured",
            },
          )
        : t("systemSettings.realtimeSignals.runtime.contextSummary.outages", {
            defaultValue: "outages={{outages}}",
            outages: num(resolvedContext.outages) ?? 0,
          });
    case "keyword_spike":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.keywordSpike",
        {
          defaultValue:
            "recent={{recent}}, baseline={{baseline}}, spikes={{spikes}}",
          recent: num(resolvedContext.recentArticleCount) ?? 0,
          baseline: num(resolvedContext.baselineArticleCount) ?? 0,
          spikes: Array.isArray(resolvedContext.spikes)
            ? resolvedContext.spikes.length
            : 0,
        },
      );
    case "pizzint":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.pizzint",
        {
          defaultValue: "defcon={{defcon}}, open={{open}}, spikes={{spikes}}",
          defcon: num(resolvedContext.defcon) ?? 0,
          open: num(resolvedContext.openLocations) ?? 0,
          spikes: num(resolvedContext.activeSpikes) ?? 0,
        },
      );
    case "gdelt_tension":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.gdeltTension",
        {
          defaultValue: "pairs={{pairs}}, window={{start}}..{{end}}",
          pairs: Array.isArray(resolvedContext.tensions)
            ? resolvedContext.tensions.length
            : 0,
          start: str(resolvedContext.dateStart) ?? "-",
          end: str(resolvedContext.dateEnd) ?? "-",
        },
      );
    case "polymarket_leads":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.polymarketLeads",
        {
          defaultValue: "leads={{leads}}",
          leads: Array.isArray(resolvedContext.leads)
            ? resolvedContext.leads.length
            : 0,
        },
      );
    default:
      return null;
  }
}

function runtimeFreshnessColor(freshness: RealtimeOpenskySnapshotFreshness) {
  switch (freshness) {
    case "fresh":
      return "green";
    case "stale":
      return "orange";
    default:
      return "default";
  }
}

function openskyBudgetDegradationColor(
  degradation: RealtimeOpenskyBudgetDegradationLevel | undefined,
) {
  switch (degradation) {
    case "warning":
      return "gold";
    case "critical":
      return "orange";
    case "exhausted":
      return "red";
    default:
      return "green";
  }
}

function formatPercentValue(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)}%`
    : "—";
}

function formatOpenskyRuntimeReason(
  t: RealtimeSignalsTranslate,
  code: string | undefined,
  fallback: string | undefined,
) {
  if (!code) {
    return fallback;
  }
  return t(`systemSettings.realtimeSignals.runtime.openskyReason.${code}`, {
    defaultValue: fallback ?? code,
  });
}

function formatOpenskyErrorKindLabel(
  t: RealtimeSignalsTranslate,
  kind: RealtimeOpenskyErrorKind | undefined,
) {
  if (!kind) {
    return undefined;
  }
  return t(`systemSettings.realtimeSignals.runtime.openskyErrorKind.${kind}`, {
    defaultValue: kind,
  });
}

function buildRuntimeFeedbackAlert(
  t: RealtimeSignalsTranslate,
  row: RealtimeSignalRuntimeDiagnosticsSource,
  formatTimestamp: (value?: string) => string,
) {
  const context =
    row.context && typeof row.context === "object" && !Array.isArray(row.context)
      ? row.context
      : undefined;

  if (row.source === "ais") {
    return buildAisRuntimeFeedbackAlert(t, row, formatTimestamp);
  }

  if (row.source === "outages" && isOutagesRateLimited(row)) {
    const retryAfterValue =
      typeof row.lastRateLimit?.retryAfterSec === "number"
        ? `${row.lastRateLimit.retryAfterSec}s`
        : undefined;
    const nextEligibleAt = row.nextEligibleAt
      ? formatTimestamp(row.nextEligibleAt)
      : undefined;
    return {
      type: "warning" as const,
      message: t(
        "systemSettings.realtimeSignals.runtime.feedback.outagesRateLimited.title",
        {
          defaultValue:
            "Cloudflare Radar outages source is currently rate limited.",
        },
      ),
      description: `${t(
        "systemSettings.realtimeSignals.runtime.feedback.outagesRateLimited.body",
        {
          defaultValue:
            "The API is honoring the upstream limit window and will not retry before {{time}}.",
          time:
            nextEligibleAt ??
            t("systemSettings.realtimeSignals.status.notConfigured", {
              defaultValue: "Not configured",
            }),
        },
      )}${
        retryAfterValue
          ? ` ${t(
              "systemSettings.realtimeSignals.runtime.feedback.retryAfterWindow",
              {
                defaultValue: "Retry-After requested {{value}} of backoff.",
                value: retryAfterValue,
              },
            )}`
          : ""
      }`,
    };
  }

  return null;
}

export function RealtimeSignalsSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<RealtimeSignalsSettingsFormValues>();
  const [settings, setSettings] =
    useState<RealtimeSignalsSettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] =
    useState<RealtimeSignalsRuntimeDiagnosticsResponse | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<RealtimeSignalsSettingsResponse>(
        "system-settings/realtime-signals",
      );
      const data: RealtimeSignalsSettingsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue(toFormValues(data));
    } catch (error) {
      captureClientError("Failed to load realtime signals settings", error);
      setErrorMessage(t("systemSettings.realtimeSignals.errors.loadFailed"));
      setSettings(EMPTY_SETTINGS);
      form.setFieldsValue(toFormValues(EMPTY_SETTINGS));
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [apiClient, form, t]);

  const loadDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const response =
        await apiClient.get<RealtimeSignalsRuntimeDiagnosticsResponse>(
          "system-settings/realtime-signals/runtime",
        );
      setDiagnostics(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to load realtime signals diagnostics", error);
      setDiagnosticsError(
        t("systemSettings.realtimeSignals.runtime.errors.loadFailed", {
          defaultValue: "Failed to load runtime diagnostics.",
        }),
      );
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [apiClient, t]);

  useEffect(() => {
    void loadSettings();
    void loadDiagnostics();
  }, [loadDiagnostics, loadSettings]);

  const handleSubmit = async (values: RealtimeSignalsSettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload: Record<string, unknown> = {
        enabled: values.enabled,
        requestTimeoutMs: values.requestTimeoutMs,
        maxRetries: values.maxRetries,
        openskyEnabled: values.openskyEnabled,
        openskyIntervalSec: values.openskyIntervalSec,
        openskyDailyCreditBudget: values.openskyDailyCreditBudget,
        openskyDayIntervalSec: values.openskyDayIntervalSec,
        openskyNightIntervalSec: values.openskyNightIntervalSec,
        openskyDayStartHourHkt: values.openskyDayStartHourHkt,
        openskyNightStartHourHkt: values.openskyNightStartHourHkt,
        openskyWarningRemainingPct: values.openskyWarningRemainingPct,
        openskyCriticalRemainingPct: values.openskyCriticalRemainingPct,
        aisEnabled: values.aisEnabled,
        aisIntervalSec: values.aisIntervalSec,
        unrestEnabled: values.unrestEnabled,
        unrestIntervalSec: values.unrestIntervalSec,
        outagesEnabled: values.outagesEnabled,
        outagesIntervalSec: values.outagesIntervalSec,
        keywordSpikeEnabled: values.keywordSpikeEnabled,
        keywordSpikeIntervalSec: values.keywordSpikeIntervalSec,
        pizzintEnabled: values.pizzintEnabled,
        pizzintIntervalSec: values.pizzintIntervalSec,
        gdeltTensionEnabled: values.gdeltTensionEnabled,
        gdeltTensionIntervalSec: values.gdeltTensionIntervalSec,
        polymarketLeadsEnabled: values.polymarketLeadsEnabled,
        polymarketLeadsIntervalSec: values.polymarketLeadsIntervalSec,
        keywordSpikeMinCount: values.keywordSpikeMinCount,
        keywordSpikeMultiplier: values.keywordSpikeMultiplier,
        predictionShiftThreshold: values.predictionShiftThreshold,
        predictionNewsActivityThreshold: values.predictionNewsActivityThreshold,
        openskyBaseUrl: values.openskyBaseUrl?.trim()
          ? values.openskyBaseUrl.trim()
          : null,
        openskyTokenUrl: values.openskyTokenUrl?.trim()
          ? values.openskyTokenUrl.trim()
          : null,
        aisRelayBaseUrl: values.aisRelayBaseUrl?.trim()
          ? values.aisRelayBaseUrl.trim()
          : null,
        polymarketProxyUrl: values.polymarketProxyUrl?.trim()
          ? values.polymarketProxyUrl.trim()
          : null,
        openskyClientId: values.openskyClientId?.trim()
          ? values.openskyClientId.trim()
          : null,
      };

      if (settings.acledApiEnabled) {
        payload.acledOauthUsername = values.acledOauthUsername?.trim()
          ? values.acledOauthUsername.trim()
          : null;
        payload.acledOauthClientId = values.acledOauthClientId?.trim()
          ? values.acledOauthClientId.trim()
          : null;
      }

      const touchedSecrets = Object.fromEntries(
        REALTIME_SIGNALS_SECRET_FIELD_NAMES.map((fieldName) => [
          fieldName,
          form.isFieldTouched(fieldName),
        ]),
      ) as Partial<Record<RealtimeSignalsSecretFieldName, boolean>>;

      applyRealtimeSignalsSecretFields(payload, values, touchedSecrets);

      const response = await apiClient.put<RealtimeSignalsSettingsResponse>(
        "system-settings/realtime-signals",
        payload,
      );
      const data: RealtimeSignalsSettingsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue(toFormValues(data));
      messageApi.success(t("systemSettings.realtimeSignals.messages.saved"));
      void loadDiagnostics();
    } catch (error) {
      captureClientError("Failed to save realtime signals settings", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(
          extractApiError(error).message ??
            t("systemSettings.realtimeSignals.errors.badRequest"),
        );
      } else {
        messageApi.error(t("systemSettings.realtimeSignals.errors.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.realtimeSignals.modal.resetTitle"),
      content: t("systemSettings.realtimeSignals.modal.resetContent"),
      okText: t("systemSettings.realtimeSignals.modal.confirm"),
      cancelText: t("systemSettings.realtimeSignals.modal.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response =
            await apiClient.delete<RealtimeSignalsSettingsResponse>(
              "system-settings/realtime-signals",
            );
          const data: RealtimeSignalsSettingsResponse = {
            ...EMPTY_SETTINGS,
            ...(response.data ?? {}),
          };
          setSettings(data);
          form.setFieldsValue(toFormValues(data));
          messageApi.success(
            t("systemSettings.realtimeSignals.messages.reset"),
          );
          void loadDiagnostics();
        } catch (error) {
          captureClientError(
            "Failed to reset realtime signals settings",
            error,
          );
          messageApi.error(
            t("systemSettings.realtimeSignals.errors.resetFailed"),
          );
        } finally {
          setResetting(false);
        }
      },
    });
  };

  const sourceTagColor = settings.source === "db" ? "green" : "default";
  const sourceTagLabel =
    settings.source === "db"
      ? t("systemSettings.realtimeSignals.status.saved")
      : t("systemSettings.realtimeSignals.status.env");
  const acledApiDisabled = !settings.acledApiEnabled;
  const acledApiStatusLabel = settings.acledApiEnabled
    ? t("systemSettings.realtimeSignals.status.acledApiEnabled", {
        defaultValue: "Available",
      })
    : t("systemSettings.realtimeSignals.status.acledApiDisabled", {
        defaultValue: "Disabled for now",
      });
  const runtimeSettingsSource = diagnostics?.settingsSource ?? "unknown";
  const runtimeSettingsSourceColor =
    runtimeSettingsSource === "db"
      ? "green"
      : runtimeSettingsSource === "unknown"
        ? "gold"
        : "default";
  const runtimeSettingsSourceLabel = t(
    `systemSettings.realtimeSignals.runtime.settingsSources.${runtimeSettingsSource}`,
    {
      defaultValue:
        runtimeSettingsSource === "db"
          ? "Saved override"
          : runtimeSettingsSource === "env"
            ? "Using env defaults"
            : "Source unavailable",
    },
  );
  const enabledTagColor = settings.enabled ? "green" : "default";
  const enabledTagLabel = settings.enabled
    ? t("systemSettings.realtimeSignals.status.enabled")
    : t("systemSettings.realtimeSignals.status.disabled");
  const secretSourceLabel = (value: RealtimeSignalsSecretSource) =>
    t(`systemSettings.realtimeSignals.status.secretSources.${value}`, {
      defaultValue: value,
    });
  const acledTokenStatusLabel = t(
    `systemSettings.realtimeSignals.status.acledTokenStatuses.${settings.acledAccessTokenStatus}`,
    {
      defaultValue: settings.acledAccessTokenStatus,
    },
  );
  const acledTokenStatusColor =
    settings.acledAccessTokenStatus === "ready"
      ? "green"
      : settings.acledAccessTokenStatus === "expiring"
        ? "gold"
        : settings.acledAccessTokenStatus === "refresh_failed"
          ? "red"
          : "default";
  const formatTimestamp = (value?: string) => {
    if (!value) {
      return t("systemSettings.realtimeSignals.status.notConfigured");
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return value;
    }
    return new Date(parsed).toLocaleString();
  };

  const secretStatusRows = [
    {
      key: "aisRelaySharedSecret",
      label: t("systemSettings.realtimeSignals.status.aisRelaySharedSecret", {
        defaultValue: "AIS relay shared secret",
      }),
      has: settings.hasAisRelaySharedSecret,
      source: settings.aisRelaySharedSecretSource,
    },
    {
      key: "openskyClientSecret",
      label: t("systemSettings.realtimeSignals.status.openskyClientSecret", {
        defaultValue: "OpenSky client secret",
      }),
      has: settings.hasOpenskyClientSecret,
      source: settings.openskyClientSecretSource,
    },
    ...(settings.acledApiEnabled
      ? [
          {
            key: "acledOauthPassword",
            label: t(
              "systemSettings.realtimeSignals.status.acledOauthPassword",
            ),
            has: settings.hasAcledOauthPassword,
            source: settings.acledOauthPasswordSource,
          },
        ]
      : []),
    {
      key: "cloudflareApiToken",
      label: t("systemSettings.realtimeSignals.status.cloudflareApiToken"),
      has: settings.hasCloudflareApiToken,
      source: settings.cloudflareApiTokenSource,
    },
    {
      key: "wingbitsApiKey",
      label: t("systemSettings.realtimeSignals.status.wingbitsApiKey"),
      has: settings.hasWingbitsApiKey,
      source: settings.wingbitsApiKeySource,
    },
  ];

  const openskySourceName = t(
    "systemSettings.realtimeSignals.sources.opensky",
    {
      defaultValue: "OpenSky military flights",
    },
  );
  const sourceStatusRows = [
    {
      sourceKey: "opensky" as const,
      key: "openskyEnabled",
      sourceName: openskySourceName,
      enabled: settings.openskyEnabled,
      intervalSec: settings.openskyDayIntervalSec,
      intervalLabel: `${settings.openskyDayIntervalSec}s / ${settings.openskyNightIntervalSec}s`,
    },
    ...SOURCE_CONFIGS.map((sourceConfig) => {
      const sourceName = t(sourceConfig.nameKey, {
        defaultValue: sourceConfig.fallbackName,
      });
      const enabled = Boolean(settings[sourceConfig.enabledField]);
      const intervalSec =
        typeof settings[sourceConfig.intervalField] === "number"
          ? settings[sourceConfig.intervalField]
          : null;
      return {
        sourceKey: sourceConfig.sourceKey,
        key: sourceConfig.enabledField,
        sourceName,
        enabled,
        intervalSec,
        intervalLabel:
          typeof intervalSec === "number" ? `${intervalSec}s` : undefined,
      };
    }),
  ];

  const enabledSourceCount = sourceStatusRows.filter(
    (row) => row.enabled,
  ).length;
  const disabledSourceCount = sourceStatusRows.length - enabledSourceCount;
  const fastestEnabledInterval = sourceStatusRows
    .filter((row) => row.enabled && typeof row.intervalSec === "number")
    .reduce<
      number | null
    >((acc, row) => (acc === null || (row.intervalSec as number) < acc ? (row.intervalSec as number) : acc), null);
  const configuredSecretCount = secretStatusRows.filter(
    (row) => row.has,
  ).length;
  const runtimeStatusColor = (status: RealtimeSignalRuntimeStatus) =>
    status === "ok"
      ? "green"
      : status === "error"
        ? "red"
        : status === "stale"
          ? "orange"
          : status === "not_configured"
            ? "gold"
            : "default";
  const runtimeStatusLabel = (status: RealtimeSignalRuntimeStatus) =>
    t(`systemSettings.realtimeSignals.runtime.status.${status}`, {
      defaultValue:
        status === "ok"
          ? "OK"
          : status === "error"
            ? "Error"
            : status === "stale"
              ? "Stale"
              : status === "not_configured"
                ? "Not configured"
                : "Idle",
    });
  const sourceNameByKey = Object.fromEntries(
    sourceStatusRows.map((row) => [row.sourceKey, row.sourceName]),
  ) as Record<RealtimeSignalSourceKey, string>;
  const runtimeIssues =
    diagnostics?.sources.filter(
      (row) => row.status === "error" || row.status === "stale",
    ) ?? [];
  const runtimeWarnings =
    diagnostics?.sources.filter((row) => row.status === "not_configured") ?? [];
  const openskyBudget = diagnostics?.openskyBudget;
  const openskyBudgetPeriodLabel =
    openskyBudget?.currentPeriod === "day"
      ? t("systemSettings.realtimeSignals.runtime.openskyBudget.periods.day", {
          defaultValue: "HKT day",
        })
      : openskyBudget?.currentPeriod === "night"
        ? t(
            "systemSettings.realtimeSignals.runtime.openskyBudget.periods.night",
            {
              defaultValue: "HKT night",
            },
          )
        : "—";
  const openskyBudgetDegradationLabel = openskyBudget
    ? t(
        `systemSettings.realtimeSignals.runtime.openskyBudget.degradation.${openskyBudget.degradationLevel}`,
        {
          defaultValue: openskyBudget.degradationLevel,
        },
      )
    : "—";
  const openskyBudgetErrorBreakdown = openskyBudget
    ? [
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.auth", {
          defaultValue: "auth",
        })} ${openskyBudget.authErrorCalls}`,
        `${t(
          "systemSettings.realtimeSignals.runtime.openskyErrorKind.rate_limited",
          {
            defaultValue: "rate_limited",
          },
        )} ${openskyBudget.rateLimitedErrorCalls}`,
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.server", {
          defaultValue: "server",
        })} ${openskyBudget.serverErrorCalls}`,
        `${t(
          "systemSettings.realtimeSignals.runtime.openskyErrorKind.timeout",
          {
            defaultValue: "timeout",
          },
        )} ${openskyBudget.timeoutErrorCalls}`,
        `${t(
          "systemSettings.realtimeSignals.runtime.openskyErrorKind.network",
          {
            defaultValue: "network",
          },
        )} ${openskyBudget.networkErrorCalls}`,
        `${t(
          "systemSettings.realtimeSignals.runtime.openskyErrorKind.unknown",
          {
            defaultValue: "unknown",
          },
        )} ${openskyBudget.unknownErrorCalls}`,
      ].join(" / ")
    : "—";
  const openskyBudgetColumns = useMemo(
    () => [
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.date",
          {
            defaultValue: "Date (HKT)",
          },
        ),
        dataIndex: "dateHkt",
        key: "dateHkt",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.usedCredits",
          {
            defaultValue: "Used",
          },
        ),
        dataIndex: "usedCredits",
        key: "usedCredits",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.militaryCredits",
          {
            defaultValue: "Military",
          },
        ),
        dataIndex: "militaryCredits",
        key: "militaryCredits",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.allCredits",
          {
            defaultValue: "All",
          },
        ),
        dataIndex: "allCredits",
        key: "allCredits",
      },
      {
        title: t(
          "systemSettings.realtimeSignals.runtime.openskyBudget.table.calls",
          {
            defaultValue: "Calls",
          },
        ),
        dataIndex: "requestCount",
        key: "requestCount",
      },
    ],
    [t],
  );

  if (loading && !loadedOnce) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.realtimeSignals.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.realtimeSignals.notice.title")}
        description={t("systemSettings.realtimeSignals.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert
          type="error"
          showIcon
          message={errorMessage}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: "1rem" }}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.enabledSources",
                {
                  defaultValue: "Enabled sources",
                },
              )}
              value={enabledSourceCount}
              suffix={`/ ${sourceStatusRows.length}`}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.disabledSources",
                {
                  defaultValue: "Disabled sources",
                },
              )}
              value={disabledSourceCount}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.fastestInterval",
                {
                  defaultValue: "Fastest interval",
                },
              )}
              value={fastestEnabledInterval ?? "—"}
              suffix={fastestEnabledInterval ? "sec" : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t(
                "systemSettings.realtimeSignals.overview.configuredSecrets",
                {
                  defaultValue: "Configured secrets",
                },
              )}
              value={configuredSecretCount}
              suffix={`/ ${secretStatusRows.length}`}
            />
          </Card>
        </Col>
      </Row>

      <Space
        direction="vertical"
        size="small"
        style={{ display: "flex", marginBottom: "1rem" }}
      >
        <Space wrap>
          <Typography.Text>
            {t("systemSettings.realtimeSignals.status.label")}
          </Typography.Text>
          <Tag color={sourceTagColor}>{sourceTagLabel}</Tag>
          <Tag color={enabledTagColor}>{enabledTagLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.openskyBaseUrl", {
              defaultValue: "OpenSky base URL",
            })}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.openskyBaseUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.openskyTokenUrl", {
              defaultValue: "OpenSky token URL",
            })}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.openskyTokenUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.aisRelayBaseUrl", {
              defaultValue: "AIS relay root URL",
            })}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.aisRelayBaseUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.openskyClientId", {
              defaultValue: "OpenSky client ID",
            })}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.openskyClientId ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Tag color={settings.openskyClientId ? "blue" : "default"}>
            {secretSourceLabel(settings.openskyClientIdSource)}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.polymarketProxyUrl")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.polymarketProxyUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.acledApi")}
          </Typography.Text>
          <Tag color={settings.acledApiEnabled ? "green" : "gold"}>
            {acledApiStatusLabel}
          </Tag>
          {acledApiDisabled ? (
            <Typography.Text type="secondary">
              {t("systemSettings.realtimeSignals.alerts.acledDisabled.inline", {
                defaultValue: "Open myACLED does not include API access.",
              })}
            </Typography.Text>
          ) : null}
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.acledOauthUsername")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.acledOauthUsername ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Tag color={settings.acledOauthUsername ? "blue" : "default"}>
            {secretSourceLabel(settings.acledOauthUsernameSource)}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.acledOauthClientId")}
          </Typography.Text>
          <Tag color="geekblue">{settings.acledOauthClientId || "acled"}</Tag>
          <Tag
            color={
              settings.acledOauthClientIdSource === "none" ? "default" : "blue"
            }
          >
            {secretSourceLabel(settings.acledOauthClientIdSource)}
          </Tag>
        </Space>
        {settings.acledApiEnabled ? (
          <>
            <Space wrap>
              <Typography.Text type="secondary">
                {t("systemSettings.realtimeSignals.status.acledAccessToken")}
              </Typography.Text>
              <Tag color={acledTokenStatusColor}>{acledTokenStatusLabel}</Tag>
              <Tag color={settings.hasAcledAccessToken ? "blue" : "default"}>
                {secretSourceLabel(settings.acledAccessTokenSource)}
              </Tag>
              <Typography.Text type="secondary">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenExpiresAt",
                )}
              </Typography.Text>
              <Tag color="geekblue">
                {formatTimestamp(settings.acledAccessTokenExpiresAt)}
              </Tag>
              <Typography.Text type="secondary">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenRefreshedAt",
                )}
              </Typography.Text>
              <Tag color="geekblue">
                {formatTimestamp(settings.acledAccessTokenRefreshedAt)}
              </Tag>
              <Typography.Text type="secondary">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenLastAttemptAt",
                )}
              </Typography.Text>
              <Tag color="geekblue">
                {formatTimestamp(settings.acledAccessTokenLastAttemptAt)}
              </Tag>
            </Space>
            {settings.acledAccessTokenLastError ? (
              <Typography.Text type="danger">
                {t(
                  "systemSettings.realtimeSignals.status.acledAccessTokenLastError",
                )}
                {`: ${settings.acledAccessTokenLastError}`}
              </Typography.Text>
            ) : null}
          </>
        ) : null}
        {secretStatusRows.map((row) => (
          <Space key={row.key} wrap>
            <Typography.Text type="secondary">{row.label}</Typography.Text>
            <Tag color={row.has ? "blue" : "default"}>
              {secretSourceLabel(row.source)}
            </Tag>
          </Space>
        ))}

        <Divider style={{ margin: "8px 0" }} />

        <Typography.Text type="secondary">
          {t("systemSettings.realtimeSignals.status.sourceSnapshot", {
            defaultValue: "Source snapshot",
          })}
        </Typography.Text>
        <Space wrap size={[8, 8]}>
          {sourceStatusRows.map((row) => (
            <Tag key={row.key} color={row.enabled ? "green" : "default"}>
              {row.sourceName} ·{" "}
              {row.enabled
                ? t("systemSettings.realtimeSignals.status.enabled", {
                    defaultValue: "Enabled",
                  })
                : t("systemSettings.realtimeSignals.status.disabled", {
                    defaultValue: "Disabled",
                  })}
              {row.intervalLabel ? ` · ${row.intervalLabel}` : ""}
            </Tag>
          ))}
        </Space>
      </Space>

      <Card
        size="small"
        title={t("systemSettings.realtimeSignals.runtime.title", {
          defaultValue: "Runtime diagnostics",
        })}
        extra={
          <Space wrap>
            {diagnostics ? (
              <Tag color={runtimeSettingsSourceColor}>
                {t("systemSettings.realtimeSignals.runtime.settingsSource", {
                  defaultValue: "Settings source",
                })}
                : {runtimeSettingsSourceLabel}
              </Tag>
            ) : null}
            {diagnostics?.checkedAt ? (
              <Typography.Text type="secondary">
                {t("systemSettings.realtimeSignals.runtime.checkedAt", {
                  defaultValue: "Last checked: {{time}}",
                  time: formatTimestamp(diagnostics.checkedAt),
                })}
              </Typography.Text>
            ) : null}
            <Button
              onClick={() => void loadDiagnostics()}
              loading={diagnosticsLoading}
            >
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
          </Space>
        }
        style={{ marginBottom: "1rem" }}
      >
        {diagnosticsError ? (
          <Alert
            type="error"
            showIcon
            message={diagnosticsError}
            style={{ marginBottom: "1rem" }}
          />
        ) : null}

        {diagnostics?.settingsSource === "unknown" ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: "1rem" }}
            message={t(
              "systemSettings.realtimeSignals.runtime.settingsSourceUnknown.title",
              {
                defaultValue: "Settings source could not be resolved.",
              },
            )}
            description={t(
              "systemSettings.realtimeSignals.runtime.settingsSourceUnknown.body",
              {
                defaultValue:
                  "Runtime diagnostics are still shown, but the system could not confirm whether the effective realtime settings came from DB overrides or env defaults for this request.",
              },
            )}
          />
        ) : null}

        {runtimeIssues.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: "1rem" }}
            message={t("systemSettings.realtimeSignals.runtime.issues", {
              defaultValue: "Detected {{count}} runtime issue(s).",
              count: runtimeIssues.length,
            })}
            description={
              <Space wrap size={[8, 8]}>
                {runtimeIssues.map((row) => (
                  <Tag
                    key={`${row.source}-issue`}
                    color={runtimeStatusColor(row.status)}
                  >
                    {sourceNameByKey[row.source]} ·{" "}
                    {runtimeStatusLabel(row.status)}
                  </Tag>
                ))}
              </Space>
            }
          />
        ) : null}

        {!diagnosticsError && runtimeWarnings.length > 0 ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: "1rem" }}
            message={t("systemSettings.realtimeSignals.runtime.warnings", {
              defaultValue:
                "Some sources are enabled but not fully configured.",
            })}
            description={
              <Space wrap size={[8, 8]}>
                {runtimeWarnings.map((row) => (
                  <Tag
                    key={`${row.source}-warning`}
                    color={runtimeStatusColor(row.status)}
                  >
                    {sourceNameByKey[row.source]} ·{" "}
                    {runtimeStatusLabel(row.status)}
                  </Tag>
                ))}
              </Space>
            }
          />
        ) : null}

        {diagnostics ? (
          <Space direction="vertical" size="large" style={{ display: "flex" }}>
            <Row gutter={[12, 12]}>
              <Col xs={24} sm={12} lg={6}>
                <Card size="small">
                  <Statistic
                    title={t(
                      "systemSettings.realtimeSignals.runtime.summary.healthy",
                      {
                        defaultValue: "Healthy sources",
                      },
                    )}
                    value={
                      diagnostics.sources.filter((row) => row.status === "ok")
                        .length
                    }
                    suffix={`/ ${diagnostics.sources.length}`}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Card size="small">
                  <Statistic
                    title={t(
                      "systemSettings.realtimeSignals.runtime.summary.issues",
                      {
                        defaultValue: "Issue sources",
                      },
                    )}
                    value={runtimeIssues.length}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Card size="small">
                  <Statistic
                    title={t(
                      "systemSettings.realtimeSignals.runtime.summary.markerReadiness",
                      {
                        defaultValue: "News markers",
                      },
                    )}
                    value={
                      diagnostics.markerReadiness.newsMarkersReady
                        ? t("common.ok", { defaultValue: "OK" })
                        : t("common.unavailable", {
                            defaultValue: "Unavailable",
                          })
                    }
                  />
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Card size="small">
                  <Statistic
                    title={t(
                      "systemSettings.realtimeSignals.runtime.summary.pizzint",
                      {
                        defaultValue: "PizzINT DEFCON",
                      },
                    )}
                    value={diagnostics.insight.pizzint?.defcon ?? "—"}
                  />
                </Card>
              </Col>
            </Row>

            <Card
              size="small"
              title={t(
                "systemSettings.realtimeSignals.runtime.openskyBudget.title",
                {
                  defaultValue: "OpenSky budget & schedule",
                },
              )}
            >
              <Space
                direction="vertical"
                size="middle"
                style={{ display: "flex" }}
              >
                <Space wrap size={[8, 8]}>
                  <Tag color="geekblue">
                    {t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.date",
                      {
                        defaultValue: "Date",
                      },
                    )}
                    : {openskyBudget?.dateHkt ?? "—"}
                  </Tag>
                  <Tag color="purple">
                    {t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.timezone",
                      {
                        defaultValue: "Timezone",
                      },
                    )}
                    : {openskyBudget?.timezone ?? "Asia/Hong_Kong"}
                  </Tag>
                  <Tag
                    color={openskyBudgetDegradationColor(
                      openskyBudget?.degradationLevel,
                    )}
                  >
                    {t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.degradationLabel",
                      {
                        defaultValue: "Degradation",
                      },
                    )}
                    : {openskyBudgetDegradationLabel}
                  </Tag>
                  {openskyBudget?.allModeBlocked ? (
                    <Tag color="magenta">
                      {t(
                        "systemSettings.realtimeSignals.runtime.openskyBudget.allModeBlocked",
                        {
                          defaultValue: "All mode limited",
                        },
                      )}
                    </Tag>
                  ) : null}
                </Space>

                <Row gutter={[12, 12]}>
                  <Col xs={24} sm={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title={t(
                          "systemSettings.realtimeSignals.runtime.openskyBudget.dailyBudget",
                          {
                            defaultValue: "Daily budget",
                          },
                        )}
                        value={openskyBudget?.dailyBudget ?? "—"}
                      />
                    </Card>
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title={t(
                          "systemSettings.realtimeSignals.runtime.openskyBudget.usedCredits",
                          {
                            defaultValue: "Used credits",
                          },
                        )}
                        value={openskyBudget?.usedCredits ?? "—"}
                        suffix={
                          openskyBudget
                            ? `/ ${formatPercentValue(openskyBudget.usagePct)}`
                            : undefined
                        }
                      />
                    </Card>
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title={t(
                          "systemSettings.realtimeSignals.runtime.openskyBudget.remainingCredits",
                          {
                            defaultValue: "Remaining credits",
                          },
                        )}
                        value={openskyBudget?.remainingCredits ?? "—"}
                        suffix={
                          openskyBudget
                            ? `/ ${formatPercentValue(openskyBudget.remainingPct)}`
                            : undefined
                        }
                      />
                    </Card>
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title={t(
                          "systemSettings.realtimeSignals.runtime.openskyBudget.currentPeriod",
                          {
                            defaultValue: "Current period",
                          },
                        )}
                        value={openskyBudgetPeriodLabel}
                      />
                    </Card>
                  </Col>
                </Row>

                <Descriptions size="small" bordered column={1}>
                  <Descriptions.Item
                    label={t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.effectiveInterval",
                      {
                        defaultValue: "Effective military interval",
                      },
                    )}
                  >
                    {typeof openskyBudget?.effectiveMilitaryIntervalSec ===
                    "number"
                      ? `${openskyBudget.effectiveMilitaryIntervalSec}s`
                      : "—"}
                  </Descriptions.Item>
                  <Descriptions.Item
                    label={t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.configuredSchedule",
                      {
                        defaultValue: "Configured HKT schedule",
                      },
                    )}
                  >
                    {openskyBudget
                      ? `${openskyBudget.dayIntervalSec}s (${settings.openskyDayStartHourHkt.toString().padStart(2, "0")}:00-${settings.openskyNightStartHourHkt.toString().padStart(2, "0")}:00) / ${openskyBudget.nightIntervalSec}s (${settings.openskyNightStartHourHkt.toString().padStart(2, "0")}:00-${settings.openskyDayStartHourHkt.toString().padStart(2, "0")}:00)`
                      : "—"}
                  </Descriptions.Item>
                  <Descriptions.Item
                    label={t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.calls",
                      {
                        defaultValue: "Today calls",
                      },
                    )}
                  >
                    {openskyBudget
                      ? `${openskyBudget.requestCount} charged / ${openskyBudget.militaryCalls} military / ${openskyBudget.allCalls} all / ${openskyBudget.errorCalls} errors`
                      : "—"}
                  </Descriptions.Item>
                  <Descriptions.Item
                    label={t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.errorBreakdown",
                      {
                        defaultValue: "Error breakdown",
                      },
                    )}
                  >
                    {openskyBudgetErrorBreakdown}
                  </Descriptions.Item>
                  <Descriptions.Item
                    label={t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.resetAt",
                      {
                        defaultValue: "Daily reset",
                      },
                    )}
                  >
                    {t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.resetAtValue",
                      {
                        defaultValue: "00:00 HKT",
                      },
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item
                    label={t(
                      "systemSettings.realtimeSignals.runtime.openskyBudget.blockedCounts",
                      {
                        defaultValue: "Budget blocks",
                      },
                    )}
                  >
                    {openskyBudget
                      ? `${openskyBudget.blockedAllModeCount} all blocked / ${openskyBudget.skippedMilitaryCount} military skipped`
                      : "—"}
                  </Descriptions.Item>
                </Descriptions>

                <Table
                  size="small"
                  pagination={false}
                  columns={openskyBudgetColumns}
                  dataSource={openskyBudget?.recentDays ?? []}
                  rowKey="dateHkt"
                />
              </Space>
            </Card>

            {!diagnostics.markerReadiness.newsMarkersReady ? (
              <Alert
                type="warning"
                showIcon
                message={t(
                  "systemSettings.realtimeSignals.runtime.markerWarning.title",
                  {
                    defaultValue: "War Map news markers are not ready.",
                  },
                )}
                description={t(
                  "systemSettings.realtimeSignals.runtime.markerWarning.body",
                  {
                    defaultValue:
                      "Recent processed articles with location data are empty, so news markers will stay blank until the content pipeline produces geo-tagged results.",
                  },
                )}
              />
            ) : null}

            <Descriptions
              size="small"
              column={1}
              bordered
              title={t(
                "systemSettings.realtimeSignals.runtime.markerReadiness",
                {
                  defaultValue: "Marker readiness",
                },
              )}
            >
              <Descriptions.Item
                label={t(
                  "systemSettings.realtimeSignals.runtime.markerWindow",
                  {
                    defaultValue: "Lookback window",
                  },
                )}
              >
                {diagnostics.markerReadiness.windowHours}h
              </Descriptions.Item>
              <Descriptions.Item
                label={t(
                  "systemSettings.realtimeSignals.runtime.markerRecentArticles",
                  {
                    defaultValue: "Recent processed articles",
                  },
                )}
              >
                {diagnostics.markerReadiness.recentProcessedArticles}
              </Descriptions.Item>
              <Descriptions.Item
                label={t(
                  "systemSettings.realtimeSignals.runtime.markerRecentArticlesWithLocation",
                  {
                    defaultValue: "Recent articles with location",
                  },
                )}
              >
                {
                  diagnostics.markerReadiness
                    .recentProcessedArticlesWithLocation
                }
              </Descriptions.Item>
              <Descriptions.Item
                label={t(
                  "systemSettings.realtimeSignals.runtime.markerRecentMongo",
                  {
                    defaultValue: "Recent Mongo processed items",
                  },
                )}
              >
                {diagnostics.markerReadiness.recentMongoProcessedItems}
              </Descriptions.Item>
              <Descriptions.Item
                label={t(
                  "systemSettings.realtimeSignals.runtime.markerRecentMongoWithLocation",
                  {
                    defaultValue: "Recent Mongo items with location",
                  },
                )}
              >
                {
                  diagnostics.markerReadiness
                    .recentMongoProcessedItemsWithLocation
                }
              </Descriptions.Item>
              <Descriptions.Item
                label={t(
                  "systemSettings.realtimeSignals.runtime.markerLatestArticle",
                  {
                    defaultValue: "Latest processed article",
                  },
                )}
              >
                {formatTimestamp(
                  diagnostics.markerReadiness.latestProcessedArticleAt,
                )}
              </Descriptions.Item>
              <Descriptions.Item
                label={t(
                  "systemSettings.realtimeSignals.runtime.markerLatestMongo",
                  {
                    defaultValue: "Latest processed item",
                  },
                )}
              >
                {formatTimestamp(
                  diagnostics.markerReadiness.latestProcessedItemAt,
                )}
              </Descriptions.Item>
            </Descriptions>

            <Row gutter={[12, 12]}>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title={t(
                      "systemSettings.realtimeSignals.runtime.insight.keywordSpikes",
                      {
                        defaultValue: "Keyword spikes",
                      },
                    )}
                    value={diagnostics.insight.keywordSpikes.length}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title={t(
                      "systemSettings.realtimeSignals.runtime.insight.predictionLeads",
                      {
                        defaultValue: "Prediction leads",
                      },
                    )}
                    value={diagnostics.insight.predictionLeads.length}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title={t(
                      "systemSettings.realtimeSignals.runtime.insight.tensions",
                      {
                        defaultValue: "Tension pairs",
                      },
                    )}
                    value={diagnostics.insight.tensions.length}
                  />
                </Card>
              </Col>
            </Row>

            <Row gutter={[12, 12]}>
              {diagnostics.sources.map((row) => {
                const openskySnapshot = row.openskySnapshot ?? row.adsbSnapshot;
                const summary = summarizeRuntimeContext(
                  t,
                  row.source,
                  row.context,
                  openskySnapshot,
                );
                const runtimeStatusReason =
                  row.source === "opensky"
                    ? formatOpenskyRuntimeReason(
                        t,
                        row.statusReasonCode,
                        row.statusReason,
                      )
                    : row.source === "ais"
                      ? formatAisRuntimeReason(
                          t,
                          row.statusReasonCode,
                          row.statusReason,
                        )
                      : row.statusReason;
                const runtimeFeedbackAlert = buildRuntimeFeedbackAlert(
                  t,
                  row,
                  formatTimestamp,
                );
                const showRuntimeStatusReason =
                  Boolean(runtimeStatusReason) &&
                  runtimeStatusReason !== runtimeFeedbackAlert?.message &&
                  runtimeStatusReason !== runtimeFeedbackAlert?.description;
                const openskyErrorKindLabel =
                  row.source === "opensky"
                    ? formatOpenskyErrorKindLabel(t, row.lastErrorKind)
                    : undefined;
                const errorCodeLabel =
                  row.source !== "opensky"
                    ? formatRealtimeSignalErrorCode(t, row.lastErrorCode)
                    : undefined;
                const aisContext =
                  row.source === "ais" && row.context ? row.context : undefined;
                const aisTrackedVessels =
                  typeof aisContext?.vesselCount === "number" &&
                  Number.isFinite(aisContext.vesselCount)
                    ? aisContext.vesselCount
                    : null;
                const aisCandidates =
                  typeof aisContext?.candidateCount === "number" &&
                  Number.isFinite(aisContext.candidateCount)
                    ? aisContext.candidateCount
                    : null;
                const aisReportsSeen =
                  typeof aisContext?.positionReportsSeen === "number" &&
                  Number.isFinite(aisContext.positionReportsSeen)
                    ? aisContext.positionReportsSeen
                    : null;
                const aisReportsProcessed =
                  typeof aisContext?.positionReportsProcessed === "number" &&
                  Number.isFinite(aisContext.positionReportsProcessed)
                    ? aisContext.positionReportsProcessed
                    : null;
                const aisReportsIgnored =
                  typeof aisContext?.ignoredPositionReports === "number" &&
                  Number.isFinite(aisContext.ignoredPositionReports)
                    ? aisContext.ignoredPositionReports
                    : null;
                const aisParseErrors =
                  typeof aisContext?.parseErrors === "number" &&
                  Number.isFinite(aisContext.parseErrors)
                    ? aisContext.parseErrors
                    : null;
                const aisLastUpstreamError =
                  typeof aisContext?.lastUpstreamError === "string" &&
                  aisContext.lastUpstreamError.trim().length > 0
                    ? aisContext.lastUpstreamError.trim()
                    : null;
                const aisLastParseError =
                  typeof aisContext?.lastParseError === "string" &&
                  aisContext.lastParseError.trim().length > 0
                    ? aisContext.lastParseError.trim()
                    : null;
                return (
                  <Col key={row.source} xs={24} lg={12}>
                    <Card
                      size="small"
                      title={sourceNameByKey[row.source] ?? row.source}
                      extra={
                        <Space wrap size={[8, 8]}>
                          {row.source === "unrest" && acledApiDisabled ? (
                            <Tag color="gold">
                              {t(
                                "systemSettings.realtimeSignals.runtime.unrestModeGdeltOnly",
                                {
                                  defaultValue: "GDELT-only",
                                },
                              )}
                            </Tag>
                          ) : null}
                          <Tag color={runtimeStatusColor(row.status)}>
                            {runtimeStatusLabel(row.status)}
                          </Tag>
                          <Tag color={row.enabled ? "green" : "default"}>
                            {row.source === "opensky"
                              ? t(
                                  "systemSettings.realtimeSignals.runtime.effectiveIntervalTag",
                                  {
                                    defaultValue: "effective {{value}}s",
                                    value: row.intervalSec,
                                  },
                                )
                              : `${row.intervalSec}s`}
                          </Tag>
                          {typeof row.configuredIntervalSec === "number" ? (
                            <Tag color="default">
                              {t(
                                "systemSettings.realtimeSignals.runtime.configuredIntervalTag",
                                {
                                  defaultValue: "base {{value}}s",
                                  value: row.configuredIntervalSec,
                                },
                              )}
                            </Tag>
                          ) : null}
                        </Space>
                      }
                    >
                      <Space
                        direction="vertical"
                        size="small"
                        style={{ display: "flex" }}
                      >
                        <Space wrap size={[8, 8]}>
                          <Typography.Text strong>
                            {t(
                              "systemSettings.realtimeSignals.runtime.latestValue",
                              {
                                defaultValue: "Latest",
                              },
                            )}
                            : {row.latestValue ?? "—"}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {t(
                              "systemSettings.realtimeSignals.runtime.previousValue",
                              {
                                defaultValue: "Previous",
                              },
                            )}
                            : {row.previousValue ?? "—"}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {t(
                              "systemSettings.realtimeSignals.runtime.changePercent",
                              {
                                defaultValue: "Change",
                              },
                            )}
                            :{" "}
                            {typeof row.changePercent === "number"
                              ? `${row.changePercent.toFixed(2)}%`
                              : "—"}
                          </Typography.Text>
                        </Space>
                        {summary ? (
                          <Typography.Text type="secondary">
                            {summary}
                          </Typography.Text>
                        ) : null}
                        {row.source === "unrest" && acledApiDisabled ? (
                          <Typography.Text type="secondary">
                            {t(
                              "systemSettings.realtimeSignals.runtime.unrestAcledDisabled",
                              {
                                defaultValue:
                                  "ACLED API is disabled. Unrest events currently use GDELT only.",
                              },
                            )}
                          </Typography.Text>
                        ) : null}
                        {openskySnapshot ? (
                          <Space wrap size={[8, 8]}>
                            <Tag
                              color={runtimeFreshnessColor(
                                openskySnapshot.freshness,
                              )}
                            >
                              {t(
                                "systemSettings.realtimeSignals.runtime.openskySnapshotFreshness",
                                {
                                  defaultValue: "Snapshot",
                                },
                              )}
                              :{" "}
                              {t(
                                `systemSettings.realtimeSignals.runtime.openskyFreshness.${openskySnapshot.freshness}`,
                                {
                                  defaultValue: openskySnapshot.freshness,
                                },
                              )}
                            </Tag>
                            <Tag>
                              {t(
                                "systemSettings.realtimeSignals.runtime.openskyMapPoints",
                                {
                                  defaultValue: "Map points",
                                },
                              )}
                              : {openskySnapshot.snapshotValidPositionCount}
                            </Tag>
                            <Tag>
                              {t(
                                "systemSettings.realtimeSignals.runtime.openskyCurrentValidPoints",
                                {
                                  defaultValue: "Current valid",
                                },
                              )}
                              : {openskySnapshot.currentValidPositionCount}
                            </Tag>
                            <Tag>
                              {t(
                                "systemSettings.realtimeSignals.runtime.openskyDroppedStale",
                                {
                                  defaultValue: "Dropped stale",
                                },
                              )}
                              : {openskySnapshot.droppedStalePositionCount}
                            </Tag>
                          </Space>
                        ) : null}
                        {row.source === "ais" ? (
                          <Space wrap size={[8, 8]}>
                            {aisTrackedVessels !== null ? (
                              <Tag>
                                {t(
                                  "systemSettings.realtimeSignals.runtime.aisTrackedVessels",
                                  {
                                    defaultValue: "Tracked vessels",
                                  },
                                )}
                                : {aisTrackedVessels}
                              </Tag>
                            ) : null}
                            {aisCandidates !== null ? (
                              <Tag>
                                {t(
                                  "systemSettings.realtimeSignals.runtime.aisCandidates",
                                  {
                                    defaultValue: "Candidates",
                                  },
                                )}
                                : {aisCandidates}
                              </Tag>
                            ) : null}
                            {aisReportsSeen !== null ? (
                              <Tag>
                                {t(
                                  "systemSettings.realtimeSignals.runtime.aisReportsSeen",
                                  {
                                    defaultValue: "Reports seen",
                                  },
                                )}
                                : {aisReportsSeen}
                              </Tag>
                            ) : null}
                            {aisReportsProcessed !== null ? (
                              <Tag color="green">
                                {t(
                                  "systemSettings.realtimeSignals.runtime.aisReportsProcessed",
                                  {
                                    defaultValue: "Reports processed",
                                  },
                                )}
                                : {aisReportsProcessed}
                              </Tag>
                            ) : null}
                            {aisReportsIgnored !== null ? (
                              <Tag
                                color={
                                  aisReportsIgnored > 0 ? "gold" : "default"
                                }
                              >
                                {t(
                                  "systemSettings.realtimeSignals.runtime.aisReportsIgnored",
                                  {
                                    defaultValue: "Reports ignored",
                                  },
                                )}
                                : {aisReportsIgnored}
                              </Tag>
                            ) : null}
                            {aisParseErrors !== null ? (
                              <Tag
                                color={
                                  aisParseErrors > 0 ? "volcano" : "default"
                                }
                              >
                                {t(
                                  "systemSettings.realtimeSignals.runtime.aisParseErrors",
                                  {
                                    defaultValue: "Parse errors",
                                  },
                                )}
                                : {aisParseErrors}
                              </Tag>
                            ) : null}
                          </Space>
                        ) : null}
                        {openskySnapshot?.latestObservedAt ? (
                          <Typography.Text type="secondary">
                            {t(
                              "systemSettings.realtimeSignals.runtime.openskyLatestObservedAt",
                              {
                                defaultValue: "Latest observed",
                              },
                            )}
                            :{" "}
                            {formatTimestamp(openskySnapshot.latestObservedAt)}
                            {typeof openskySnapshot.latestObservedAgeSec ===
                            "number"
                              ? ` (${openskySnapshot.latestObservedAgeSec}s)`
                              : ""}
                          </Typography.Text>
                        ) : null}
                        {openskySnapshot?.snapshotUpdatedAt ? (
                          <Typography.Text type="secondary">
                            {t(
                              "systemSettings.realtimeSignals.runtime.openskySnapshotUpdatedAt",
                              {
                                defaultValue: "Snapshot updated",
                              },
                            )}
                            :{" "}
                            {formatTimestamp(openskySnapshot.snapshotUpdatedAt)}
                            {typeof openskySnapshot.snapshotAgeSec === "number"
                              ? ` (${openskySnapshot.snapshotAgeSec}s)`
                              : ""}
                          </Typography.Text>
                        ) : null}
                        {openskySnapshot?.retainedPreviousSnapshot ? (
                          <Alert
                            type="warning"
                            showIcon
                            message={t(
                              "systemSettings.realtimeSignals.runtime.openskyRetainedPrevious",
                              {
                                defaultValue:
                                  "Using the previous OpenSky snapshot because the latest fetch returned no usable positions.",
                              },
                            )}
                          />
                        ) : null}
                        {runtimeFeedbackAlert ? (
                          <Alert
                            type={runtimeFeedbackAlert.type}
                            showIcon
                            message={runtimeFeedbackAlert.message}
                            description={runtimeFeedbackAlert.description}
                          />
                        ) : null}
                        {showRuntimeStatusReason ? (
                          <Typography.Text type="secondary">
                            {runtimeStatusReason}
                          </Typography.Text>
                        ) : null}
                        {row.source === "ais" &&
                        (aisLastUpstreamError || aisLastParseError) ? (
                          <Alert
                            type="warning"
                            showIcon
                            message={t(
                              "systemSettings.realtimeSignals.runtime.aisRelayDiagnostics",
                              {
                                defaultValue: "AIS relay diagnostics",
                              },
                            )}
                            description={[
                              aisLastUpstreamError
                                ? `${t(
                                    "systemSettings.realtimeSignals.runtime.aisLastUpstreamError",
                                    {
                                      defaultValue: "Last upstream error",
                                    },
                                  )}: ${aisLastUpstreamError}`
                                : null,
                              aisLastParseError
                                ? `${t(
                                    "systemSettings.realtimeSignals.runtime.aisLastParseError",
                                    {
                                      defaultValue: "Last parse error",
                                    },
                                  )}: ${aisLastParseError}`
                                : null,
                            ]
                              .filter((value): value is string =>
                                Boolean(value),
                              )
                              .join(" | ")}
                          />
                        ) : null}
                        <Space wrap size={[8, 8]}>
                          <Tag>
                            {t(
                              "systemSettings.realtimeSignals.runtime.lastRunAt",
                              {
                                defaultValue: "Last run",
                              },
                            )}
                            : {formatTimestamp(row.lastRunAt)}
                          </Tag>
                          <Tag>
                            {t(
                              "systemSettings.realtimeSignals.runtime.lastAttemptAt",
                              {
                                defaultValue: "Last attempt",
                              },
                            )}
                            : {formatTimestamp(row.lastAttemptAt)}
                          </Tag>
                          <Tag>
                            {t(
                              "systemSettings.realtimeSignals.runtime.nextEligibleAt",
                              {
                                defaultValue: "Next eligible",
                              },
                            )}
                            : {formatTimestamp(row.nextEligibleAt)}
                          </Tag>
                          <Tag>
                            {t(
                              "systemSettings.realtimeSignals.runtime.lastSuccessAt",
                              {
                                defaultValue: "Last success",
                              },
                            )}
                            : {formatTimestamp(row.lastSuccessAt)}
                          </Tag>
                        </Space>
                        {openskyErrorKindLabel ||
                        errorCodeLabel ||
                        typeof row.lastErrorStatus === "number" ? (
                          <Space wrap size={[8, 8]}>
                            {openskyErrorKindLabel ? (
                              <Tag color="volcano">{openskyErrorKindLabel}</Tag>
                            ) : null}
                            {errorCodeLabel ? (
                              <Tag color="default">{errorCodeLabel}</Tag>
                            ) : null}
                            {typeof row.lastErrorStatus === "number" ? (
                              <Tag color="default">{`HTTP ${row.lastErrorStatus}`}</Tag>
                            ) : null}
                            {typeof row.lastRateLimit?.retryAfterSec === "number" ? (
                              <Tag color="gold">
                                {t(
                                  "systemSettings.realtimeSignals.runtime.retryAfter",
                                  {
                                    defaultValue: "Retry-After",
                                  },
                                )}
                                : {`${row.lastRateLimit.retryAfterSec}s`}
                              </Tag>
                            ) : null}
                          </Space>
                        ) : null}
                        {row.lastRateLimit ? (
                          <Alert
                            type="warning"
                            showIcon
                            message={t(
                              "systemSettings.realtimeSignals.runtime.rateLimit",
                              {
                                defaultValue: "Rate limit diagnostics",
                              },
                            )}
                            description={[
                              row.lastRateLimit.rateLimit
                                ? `${t(
                                    "systemSettings.realtimeSignals.runtime.rateLimitHeader",
                                    {
                                      defaultValue: "RateLimit",
                                    },
                                  )}: ${row.lastRateLimit.rateLimit}`
                                : null,
                              row.lastRateLimit.rateLimitPolicy
                                ? `${t(
                                    "systemSettings.realtimeSignals.runtime.rateLimitPolicy",
                                    {
                                      defaultValue: "RateLimit-Policy",
                                    },
                                  )}: ${row.lastRateLimit.rateLimitPolicy}`
                                : null,
                              row.lastRateLimit.cfRay
                                ? `${t(
                                    "systemSettings.realtimeSignals.runtime.cfRay",
                                    {
                                      defaultValue: "CF-Ray",
                                    },
                                  )}: ${row.lastRateLimit.cfRay}`
                                : null,
                            ]
                              .filter((value): value is string => Boolean(value))
                              .join(" | ")}
                          />
                        ) : null}
                        {row.lastError ? (
                          <Alert
                            type="error"
                            showIcon
                            message={t(
                              "systemSettings.realtimeSignals.runtime.lastError",
                              {
                                defaultValue: "Last error",
                              },
                            )}
                            description={`${row.lastError}${row.lastErrorAt ? ` (${formatTimestamp(row.lastErrorAt)})` : ""}`}
                          />
                        ) : null}
                      </Space>
                    </Card>
                  </Col>
                );
              })}
            </Row>
          </Space>
        ) : diagnosticsLoading ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "1rem 0",
            }}
          >
            <Spin />
          </div>
        ) : (
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.runtime.empty", {
              defaultValue: "Runtime diagnostics have not been loaded yet.",
            })}
          </Typography.Text>
        )}
      </Card>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {t("systemSettings.realtimeSignals.sections.general")}
        </Typography.Title>
        <Form.Item
          name="enabled"
          valuePropName="checked"
          label={t("systemSettings.realtimeSignals.fields.enabled")}
        >
          <Switch />
        </Form.Item>
        <Space wrap style={{ display: "flex", width: "100%" }}>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.requestTimeoutMs")}
            name="requestTimeoutMs"
            style={{ minWidth: 220, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.requestTimeoutMs",
                ),
              },
              {
                type: "number",
                min: 1_000,
                max: 120_000,
                message: t("common.validation.numberRange", {
                  min: 1_000,
                  max: 120_000,
                }),
              },
            ]}
          >
            <InputNumber
              min={1_000}
              max={120_000}
              step={500}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.maxRetries")}
            name="maxRetries"
            style={{ minWidth: 220, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.maxRetries",
                ),
              },
              {
                type: "number",
                min: 0,
                max: 6,
                message: t("common.validation.numberRange", { min: 0, max: 6 }),
              },
            ]}
          >
            <InputNumber min={0} max={6} step={1} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Typography.Title level={5}>
          {t("systemSettings.realtimeSignals.sections.sources")}
        </Typography.Title>
        {SOURCE_CONFIGS.map((sourceConfig) => {
          const sourceName = t(sourceConfig.nameKey, {
            defaultValue: sourceConfig.fallbackName,
          });
          return (
            <Space
              key={sourceConfig.enabledField}
              wrap
              style={{ display: "flex", width: "100%" }}
            >
              <Form.Item
                name={sourceConfig.enabledField}
                valuePropName="checked"
                label={t(
                  "systemSettings.realtimeSignals.fields.sourceEnabled",
                  {
                    source: sourceName,
                  },
                )}
                style={{ minWidth: 280, flex: 1 }}
              >
                <Switch />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prev, next) =>
                  prev[sourceConfig.enabledField] !==
                  next[sourceConfig.enabledField]
                }
              >
                {({ getFieldValue }) => (
                  <Form.Item
                    name={sourceConfig.intervalField}
                    label={t(
                      "systemSettings.realtimeSignals.fields.sourceIntervalSec",
                      { source: sourceName },
                    )}
                    style={{ minWidth: 280, flex: 1 }}
                    rules={[
                      {
                        required: true,
                        message: t(
                          "systemSettings.realtimeSignals.validation.sourceIntervalSec",
                        ),
                      },
                      {
                        type: "number",
                        min: 30,
                        max: 86_400,
                        message: t("common.validation.numberRange", {
                          min: 30,
                          max: 86_400,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={30}
                      max={86_400}
                      step={30}
                      style={{ width: "100%" }}
                      disabled={!getFieldValue(sourceConfig.enabledField)}
                    />
                  </Form.Item>
                )}
              </Form.Item>
            </Space>
          );
        })}

        <Typography.Title level={5}>
          {t("systemSettings.realtimeSignals.sections.openskyBudget", {
            defaultValue: "OpenSky budget & schedule",
          })}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          {t("systemSettings.realtimeSignals.hints.openskyBudget", {
            defaultValue:
              "Configure the HKT day/night polling profile and the daily credit guardrails used to protect OpenSky /states/all usage.",
          })}
        </Typography.Paragraph>
        <Space wrap style={{ display: "flex", width: "100%" }}>
          <Form.Item
            name="openskyEnabled"
            valuePropName="checked"
            label={t("systemSettings.realtimeSignals.fields.sourceEnabled", {
              source: openskySourceName,
            })}
            style={{ minWidth: 280, flex: 1 }}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyDailyCreditBudget",
              {
                defaultValue: "OpenSky daily credit budget",
              },
            )}
            name="openskyDailyCreditBudget"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.openskyDailyCreditBudget",
                  {
                    defaultValue: "Daily credit budget is required",
                  },
                ),
              },
              {
                type: "number",
                min: 1,
                max: 100_000,
                message: t("common.validation.numberRange", {
                  min: 1,
                  max: 100_000,
                }),
              },
            ]}
          >
            <InputNumber
              min={1}
              max={100_000}
              step={100}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyDayIntervalSec",
              {
                defaultValue: "OpenSky day interval (sec)",
              },
            )}
            name="openskyDayIntervalSec"
            style={{ minWidth: 280, flex: 1 }}
            extra={t(
              "systemSettings.realtimeSignals.hints.openskyDayIntervalSec",
              {
                defaultValue: "Applied during HKT daytime.",
              },
            )}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.openskyDayIntervalSec",
                  {
                    defaultValue: "Day interval is required",
                  },
                ),
              },
              {
                type: "number",
                min: 30,
                max: 86_400,
                message: t("common.validation.numberRange", {
                  min: 30,
                  max: 86_400,
                }),
              },
            ]}
          >
            <InputNumber
              min={30}
              max={86_400}
              step={30}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyNightIntervalSec",
              {
                defaultValue: "OpenSky night interval (sec)",
              },
            )}
            name="openskyNightIntervalSec"
            style={{ minWidth: 280, flex: 1 }}
            extra={t(
              "systemSettings.realtimeSignals.hints.openskyNightIntervalSec",
              {
                defaultValue:
                  "Applied during HKT nighttime and critical budget mode.",
              },
            )}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.openskyNightIntervalSec",
                  {
                    defaultValue: "Night interval is required",
                  },
                ),
              },
              {
                type: "number",
                min: 30,
                max: 86_400,
                message: t("common.validation.numberRange", {
                  min: 30,
                  max: 86_400,
                }),
              },
            ]}
          >
            <InputNumber
              min={30}
              max={86_400}
              step={30}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyDayStartHourHkt",
              {
                defaultValue: "HKT day start hour",
              },
            )}
            name="openskyDayStartHourHkt"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.openskyDayStartHourHkt",
                  {
                    defaultValue: "Day start hour is required",
                  },
                ),
              },
              {
                type: "number",
                min: 0,
                max: 23,
                message: t("common.validation.numberRange", {
                  min: 0,
                  max: 23,
                }),
              },
            ]}
          >
            <InputNumber min={0} max={23} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyNightStartHourHkt",
              {
                defaultValue: "HKT night start hour",
              },
            )}
            name="openskyNightStartHourHkt"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.openskyNightStartHourHkt",
                  {
                    defaultValue: "Night start hour is required",
                  },
                ),
              },
              {
                type: "number",
                min: 0,
                max: 23,
                message: t("common.validation.numberRange", {
                  min: 0,
                  max: 23,
                }),
              },
            ]}
          >
            <InputNumber min={0} max={23} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyWarningRemainingPct",
              {
                defaultValue: "Warning threshold remaining (%)",
              },
            )}
            name="openskyWarningRemainingPct"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.openskyWarningRemainingPct",
                  {
                    defaultValue: "Warning threshold is required",
                  },
                ),
              },
              {
                type: "number",
                min: 1,
                max: 99,
                message: t("common.validation.numberRange", {
                  min: 1,
                  max: 99,
                }),
              },
            ]}
          >
            <InputNumber min={1} max={99} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyCriticalRemainingPct",
              {
                defaultValue: "Critical threshold remaining (%)",
              },
            )}
            name="openskyCriticalRemainingPct"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.openskyCriticalRemainingPct",
                  {
                    defaultValue: "Critical threshold is required",
                  },
                ),
              },
              {
                type: "number",
                min: 0,
                max: 98,
                message: t("common.validation.numberRange", {
                  min: 0,
                  max: 98,
                }),
              },
            ]}
          >
            <InputNumber min={0} max={98} step={1} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Typography.Title level={5}>
          {t("systemSettings.realtimeSignals.sections.thresholds")}
        </Typography.Title>
        <Space wrap style={{ display: "flex", width: "100%" }}>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.keywordSpikeMinCount",
            )}
            name="keywordSpikeMinCount"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.keywordSpikeMinCount",
                ),
              },
              {
                type: "number",
                min: 1,
                max: 500,
                message: t("common.validation.numberRange", {
                  min: 1,
                  max: 500,
                }),
              },
            ]}
          >
            <InputNumber min={1} max={500} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.keywordSpikeMultiplier",
            )}
            name="keywordSpikeMultiplier"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.keywordSpikeMultiplier",
                ),
              },
              {
                type: "number",
                min: 1,
                max: 100,
                message: t("common.validation.numberRange", {
                  min: 1,
                  max: 100,
                }),
              },
            ]}
          >
            <InputNumber
              min={1}
              max={100}
              step={0.1}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.predictionShiftThreshold",
            )}
            name="predictionShiftThreshold"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.predictionShiftThreshold",
                ),
              },
              {
                type: "number",
                min: 1,
                max: 100,
                message: t("common.validation.numberRange", {
                  min: 1,
                  max: 100,
                }),
              },
            ]}
          >
            <InputNumber
              min={1}
              max={100}
              step={0.1}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.predictionNewsActivityThreshold",
            )}
            name="predictionNewsActivityThreshold"
            style={{ minWidth: 280, flex: 1 }}
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.realtimeSignals.validation.predictionNewsActivityThreshold",
                ),
              },
              {
                type: "number",
                min: 0,
                max: 1_000,
                message: t("common.validation.numberRange", {
                  min: 0,
                  max: 1_000,
                }),
              },
            ]}
          >
            <InputNumber
              min={0}
              max={1_000}
              step={1}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Space>

        <Typography.Title level={5}>
          {t("systemSettings.realtimeSignals.sections.endpoints")}
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t(
            "systemSettings.realtimeSignals.alerts.aisRelayPurpose.title",
            {
              defaultValue:
                "AIS relay address means the aggregation service root",
            },
          )}
          description={t(
            "systemSettings.realtimeSignals.alerts.aisRelayPurpose.body",
            {
              defaultValue:
                "This is not a generic proxy. The backend calls `/ais/snapshot` on the AIS relay service and expects structured `disruptions` and `density` data. The Polymarket proxy setting below is separate.",
            },
          )}
        />
        <Space wrap style={{ display: "flex", width: "100%" }}>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.openskyBaseUrl", {
              defaultValue: "OpenSky base URL",
            })}
            name="openskyBaseUrl"
            style={{ minWidth: 280, flex: 1 }}
            extra={t("systemSettings.realtimeSignals.hints.openskyBaseUrl", {
              defaultValue: "REST API base URL for OpenSky state queries.",
            })}
          >
            <Input
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.openskyBaseUrl",
                {
                  defaultValue: "https://opensky-network.org/api",
                },
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.openskyTokenUrl", {
              defaultValue: "OpenSky token URL",
            })}
            name="openskyTokenUrl"
            style={{ minWidth: 280, flex: 1 }}
            extra={t("systemSettings.realtimeSignals.hints.openskyTokenUrl", {
              defaultValue:
                "OAuth token endpoint used for client-credentials authentication.",
            })}
          >
            <Input
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.openskyTokenUrl",
                {
                  defaultValue:
                    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
                },
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.aisRelayBaseUrl", {
              defaultValue: "AIS relay root URL",
            })}
            name="aisRelayBaseUrl"
            style={{ minWidth: 280, flex: 1 }}
            extra={t("systemSettings.realtimeSignals.hints.aisRelayBaseUrl", {
              defaultValue:
                "Root URL of the AIS aggregation service. For Docker Compose, use `http://ais-relay:3004`.",
            })}
          >
            <Input
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.aisRelayBaseUrl",
                {
                  defaultValue: "http://ais-relay:3004",
                },
              )}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.polymarketProxyUrl",
            )}
            name="polymarketProxyUrl"
            style={{ minWidth: 280, flex: 1 }}
            extra={t("systemSettings.realtimeSignals.hints.polymarketProxyUrl")}
          >
            <Input
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.polymarketProxyUrl",
              )}
            />
          </Form.Item>
        </Space>

        <Typography.Title level={5}>
          {t("systemSettings.realtimeSignals.sections.credentials")}
        </Typography.Title>
        <Typography.Paragraph
          type="secondary"
          style={{ marginBottom: "0.75rem" }}
        >
          {t("systemSettings.realtimeSignals.hints.secretOptional")}
        </Typography.Paragraph>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t(
            "systemSettings.realtimeSignals.alerts.aisCredentials.title",
            {
              defaultValue:
                "Most AIS setups only need the relay shared secret here",
            },
          )}
          description={t(
            "systemSettings.realtimeSignals.alerts.aisCredentials.body",
            {
              defaultValue:
                "Set the relay shared secret to match `AIS_RELAY_SHARED_SECRET` on the AIS relay service. The relay reads `AISSTREAM_API_KEY` from its own environment.",
            },
          )}
        />
        {acledApiDisabled ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: "1rem" }}
            message={t(
              "systemSettings.realtimeSignals.alerts.acledDisabled.title",
              {
                defaultValue: "ACLED API is disabled for now",
              },
            )}
            description={t(
              "systemSettings.realtimeSignals.alerts.acledDisabled.body",
              {
                defaultValue:
                  "Open myACLED does not include API access. ACLED credentials remain visible for future use, and unrest events currently run in GDELT-only mode.",
              },
            )}
          />
        ) : null}
        <Space direction="vertical" style={{ width: "100%" }} size={0}>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.aisRelaySharedSecret",
              {
                defaultValue: "AIS relay shared secret",
              },
            )}
            name="aisRelaySharedSecret"
            extra={t(
              "systemSettings.realtimeSignals.hints.aisRelaySharedSecret",
              {
                defaultValue:
                  "Shared auth secret expected by the AIS relay service.",
              },
            )}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.openskyClientId", {
              defaultValue: "OpenSky client ID",
            })}
            name="openskyClientId"
            extra={t("systemSettings.realtimeSignals.hints.openskyClientId", {
              defaultValue: "OAuth client ID used for OpenSky access tokens.",
            })}
          >
            <Input
              autoComplete="username"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.openskyClientId",
                {
                  defaultValue: "client-id",
                },
              )}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.openskyClientSecret",
              {
                defaultValue: "OpenSky client secret",
              },
            )}
            name="openskyClientSecret"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.acledOauthUsername",
            )}
            name="acledOauthUsername"
            extra={t("systemSettings.realtimeSignals.hints.acledOauthUsername")}
          >
            <Input
              autoComplete="username"
              disabled={acledApiDisabled}
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.acledOauthUsername",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.acledOauthPassword",
            )}
            name="acledOauthPassword"
          >
            <Input.Password
              autoComplete="new-password"
              disabled={acledApiDisabled}
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.acledOauthClientId",
            )}
            name="acledOauthClientId"
            extra={t("systemSettings.realtimeSignals.hints.acledOauthClientId")}
          >
            <Input
              autoComplete="off"
              disabled={acledApiDisabled}
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.acledOauthClientId",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.realtimeSignals.fields.cloudflareApiToken",
            )}
            name="cloudflareApiToken"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.wingbitsApiKey")}
            name="wingbitsApiKey"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
        </Space>

        <Space wrap>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
          <Button
            danger
            onClick={handleReset}
            loading={resetting}
            disabled={saving}
          >
            {t("systemSettings.realtimeSignals.actions.reset")}
          </Button>
        </Space>
      </Form>
    </>
  );
}
