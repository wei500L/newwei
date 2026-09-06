import type {
  RealtimeSignalSourceStatusRow,
  RealtimeSignalsSettingsFormValues,
  RealtimeSignalsSettingsResponse,
} from "./realtime-signals-types";

/**
 * EMPTY_SETTINGS 只描述「成功响应字段补全」时使用的安全默认值。
 * 它不得用于初始 GET 失败后的表单填充（FE-RT-01）。
 */
export const EMPTY_SETTINGS: RealtimeSignalsSettingsResponse = {
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

export const REALTIME_SIGNALS_SETTINGS_URL = "system-settings/realtime-signals";
export const REALTIME_SIGNALS_RUNTIME_URL =
  "system-settings/realtime-signals/runtime";

export const SOURCE_CONFIGS = [
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

export function toFormValues(
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

/** 用安全默认值补全成功响应中缺失的字段（不用于失败兜底）。 */
export function mergeSettingsDefaults(
  response: Partial<RealtimeSignalsSettingsResponse> | undefined,
): RealtimeSignalsSettingsResponse {
  return {
    ...EMPTY_SETTINGS,
    ...(response ?? {}),
  };
}

export function buildSourceStatusRows(
  t: (key: string, options?: Record<string, unknown>) => string,
  settings: RealtimeSignalsSettingsResponse,
  openskySourceName: string,
): RealtimeSignalSourceStatusRow[] {
  const rows: RealtimeSignalSourceStatusRow[] = [
    {
      sourceKey: "opensky",
      key: "openskyEnabled",
      sourceName: openskySourceName,
      enabled: settings.openskyEnabled,
      intervalSec: settings.openskyDayIntervalSec,
      intervalLabel: `${settings.openskyDayIntervalSec}s / ${settings.openskyNightIntervalSec}s`,
    },
  ];
  for (const sourceConfig of SOURCE_CONFIGS) {
    const sourceName = t(sourceConfig.nameKey, {
      defaultValue: sourceConfig.fallbackName,
    });
    const enabled = Boolean(settings[sourceConfig.enabledField]);
    const intervalSec =
      typeof settings[sourceConfig.intervalField] === "number"
        ? settings[sourceConfig.intervalField]
        : null;
    rows.push({
      sourceKey: sourceConfig.sourceKey,
      key: sourceConfig.enabledField,
      sourceName,
      enabled,
      intervalSec,
      intervalLabel:
        typeof intervalSec === "number" ? `${intervalSec}s` : undefined,
    });
  }
  return rows;
}
