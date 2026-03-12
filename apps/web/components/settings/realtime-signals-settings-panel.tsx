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
  applyRealtimeSignalsSecretFields,
  REALTIME_SIGNALS_SECRET_FIELD_NAMES,
  type RealtimeSignalsSecretFieldName,
} from "@/lib/realtime-signals-settings-payload";

type RealtimeSignalsSettingsSource = "env" | "db";
type RealtimeSignalsSecretSource = "stored" | "env" | "none";
type RealtimeSignalsAcledAccessTokenStatus =
  | "ready"
  | "expiring"
  | "missing"
  | "refresh_failed";
type RealtimeSignalSourceKey =
  | "adsb"
  | "ais"
  | "unrest"
  | "outages"
  | "keyword_spike"
  | "pizzint"
  | "gdelt_tension"
  | "polymarket_leads";
type RealtimeSignalRuntimeStatus =
  | "ok"
  | "error"
  | "stale"
  | "not_configured"
  | "idle";

interface RealtimeSignalsSettingsResponse {
  source: RealtimeSignalsSettingsSource;
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  adsbEnabled: boolean;
  adsbIntervalSec: number;
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
  adsbBaseUrl?: string;
  relayBaseUrl?: string;
  polymarketProxyUrl?: string;
  hasRelaySharedSecret: boolean;
  relaySharedSecretSource: RealtimeSignalsSecretSource;
  hasAisApiKey: boolean;
  aisApiKeySource: RealtimeSignalsSecretSource;
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
  adsbEnabled: boolean;
  adsbIntervalSec: number;
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
  adsbBaseUrl?: string;
  relayBaseUrl?: string;
  polymarketProxyUrl?: string;
  relaySharedSecret?: string;
  aisApiKey?: string;
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

interface RealtimeSignalsRuntimeDiagnosticsResponse {
  checkedAt: string;
  settingsSource: RealtimeSignalsSettingsSource;
  runtimeEnabled: boolean;
  insight: {
    keywordSpikes: Array<Record<string, unknown>>;
    predictionLeads: Array<Record<string, unknown>>;
    tensions: Array<Record<string, unknown>>;
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
}

const EMPTY_SETTINGS: RealtimeSignalsSettingsResponse = {
  source: "env",
  enabled: true,
  requestTimeoutMs: 12_000,
  maxRetries: 2,
  adsbEnabled: true,
  adsbIntervalSec: 600,
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
  adsbBaseUrl: "https://api.adsb.lol",
  relayBaseUrl: "",
  polymarketProxyUrl: "",
  hasRelaySharedSecret: false,
  relaySharedSecretSource: "none",
  hasAisApiKey: false,
  aisApiKeySource: "none",
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
    sourceKey: "adsb",
    nameKey: "systemSettings.realtimeSignals.sources.adsb",
    fallbackName: "ADS-B military flights",
    enabledField: "adsbEnabled",
    intervalField: "adsbIntervalSec",
  },
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
    adsbEnabled: settings.adsbEnabled,
    adsbIntervalSec: settings.adsbIntervalSec,
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
    adsbBaseUrl: settings.adsbBaseUrl ?? "",
    relayBaseUrl: settings.relayBaseUrl ?? "",
    polymarketProxyUrl: settings.polymarketProxyUrl ?? "",
    relaySharedSecret: "",
    aisApiKey: "",
    acledOauthUsername: settings.acledOauthUsername ?? "",
    acledOauthPassword: "",
    acledOauthClientId: settings.acledOauthClientId || "acled",
    cloudflareApiToken: "",
    wingbitsApiKey: "",
  };
}

function summarizeRuntimeContext(
  source: RealtimeSignalSourceKey,
  context?: Record<string, unknown>,
) {
  if (!context) {
    return null;
  }

  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const str = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  switch (source) {
    case "adsb":
      return `military=${num(context.militaryCount) ?? 0}, aircraft=${num(context.totalAircraft) ?? 0}`;
    case "ais":
      return context.configured === false
        ? "relay not configured"
        : `disruptions=${num(context.disruptions) ?? 0}, density=${num(context.densityRegions) ?? 0}`;
    case "unrest":
      return `acled=${num(context.acledCount) ?? 0}, gdelt=${num(context.gdeltCount) ?? 0}, total=${num(context.unrestCount) ?? 0}`;
    case "outages":
      return context.configured === false
        ? "cloudflare token not configured"
        : `outages=${num(context.outages) ?? 0}`;
    case "keyword_spike":
      return `recent=${num(context.recentArticleCount) ?? 0}, baseline=${num(context.baselineArticleCount) ?? 0}, spikes=${Array.isArray(context.spikes) ? context.spikes.length : 0}`;
    case "pizzint":
      return `defcon=${num(context.defcon) ?? 0}, open=${num(context.openLocations) ?? 0}, spikes=${num(context.activeSpikes) ?? 0}`;
    case "gdelt_tension":
      return `pairs=${Array.isArray(context.tensions) ? context.tensions.length : 0}, window=${str(context.dateStart) ?? "-"}..${str(context.dateEnd) ?? "-"}`;
    case "polymarket_leads":
      return `leads=${Array.isArray(context.leads) ? context.leads.length : 0}`;
    default:
      return null;
  }
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
        adsbEnabled: values.adsbEnabled,
        adsbIntervalSec: values.adsbIntervalSec,
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
        adsbBaseUrl: values.adsbBaseUrl?.trim()
          ? values.adsbBaseUrl.trim()
          : null,
        relayBaseUrl: values.relayBaseUrl?.trim()
          ? values.relayBaseUrl.trim()
          : null,
        acledOauthUsername: values.acledOauthUsername?.trim()
          ? values.acledOauthUsername.trim()
          : null,
        acledOauthClientId: values.acledOauthClientId?.trim()
          ? values.acledOauthClientId.trim()
          : null,
        polymarketProxyUrl: values.polymarketProxyUrl?.trim()
          ? values.polymarketProxyUrl.trim()
          : null,
      };

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
      key: "relaySharedSecret",
      label: t("systemSettings.realtimeSignals.status.relaySharedSecret"),
      has: settings.hasRelaySharedSecret,
      source: settings.relaySharedSecretSource,
    },
    {
      key: "aisApiKey",
      label: t("systemSettings.realtimeSignals.status.aisApiKey"),
      has: settings.hasAisApiKey,
      source: settings.aisApiKeySource,
    },
    {
      key: "acledOauthPassword",
      label: t("systemSettings.realtimeSignals.status.acledOauthPassword"),
      has: settings.hasAcledOauthPassword,
      source: settings.acledOauthPasswordSource,
    },
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
  ] as const;

  const sourceStatusRows = SOURCE_CONFIGS.map((sourceConfig) => {
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
    };
  });

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
            {t("systemSettings.realtimeSignals.status.adsbBaseUrl")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.adsbBaseUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
          </Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.realtimeSignals.status.relayBaseUrl")}
          </Typography.Text>
          <Tag color="geekblue">
            {settings.relayBaseUrl ||
              t("systemSettings.realtimeSignals.status.notConfigured")}
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
              {typeof row.intervalSec === "number"
                ? ` · ${row.intervalSec}s`
                : ""}
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
            {diagnostics?.checkedAt ? (
              <Typography.Text type="secondary">
                {t("systemSettings.realtimeSignals.runtime.checkedAt", {
                  defaultValue: "Last checked: {{time}}",
                  time: formatTimestamp(diagnostics.checkedAt),
                })}
              </Typography.Text>
            ) : null}
            <Button onClick={() => void loadDiagnostics()} loading={diagnosticsLoading}>
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
                  <Tag key={`${row.source}-issue`} color={runtimeStatusColor(row.status)}>
                    {sourceNameByKey[row.source]} · {runtimeStatusLabel(row.status)}
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
              defaultValue: "Some sources are enabled but not fully configured.",
            })}
            description={
              <Space wrap size={[8, 8]}>
                {runtimeWarnings.map((row) => (
                  <Tag key={`${row.source}-warning`} color={runtimeStatusColor(row.status)}>
                    {sourceNameByKey[row.source]} · {runtimeStatusLabel(row.status)}
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
                    title={t("systemSettings.realtimeSignals.runtime.summary.healthy", {
                      defaultValue: "Healthy sources",
                    })}
                    value={
                      diagnostics.sources.filter((row) => row.status === "ok").length
                    }
                    suffix={`/ ${diagnostics.sources.length}`}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Card size="small">
                  <Statistic
                    title={t("systemSettings.realtimeSignals.runtime.summary.issues", {
                      defaultValue: "Issue sources",
                    })}
                    value={runtimeIssues.length}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Card size="small">
                  <Statistic
                    title={t("systemSettings.realtimeSignals.runtime.summary.markerReadiness", {
                      defaultValue: "News markers",
                    })}
                    value={
                      diagnostics.markerReadiness.newsMarkersReady
                        ? t("common.ok", { defaultValue: "OK" })
                        : t("common.unavailable", { defaultValue: "Unavailable" })
                    }
                  />
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Card size="small">
                  <Statistic
                    title={t("systemSettings.realtimeSignals.runtime.summary.pizzint", {
                      defaultValue: "PizzINT DEFCON",
                    })}
                    value={diagnostics.insight.pizzint?.defcon ?? "—"}
                  />
                </Card>
              </Col>
            </Row>

            {!diagnostics.markerReadiness.newsMarkersReady ? (
              <Alert
                type="warning"
                showIcon
                message={t("systemSettings.realtimeSignals.runtime.markerWarning.title", {
                  defaultValue: "War Map news markers are not ready.",
                })}
                description={t("systemSettings.realtimeSignals.runtime.markerWarning.body", {
                  defaultValue:
                    "Recent processed articles with location data are empty, so news markers will stay blank until the content pipeline produces geo-tagged results.",
                })}
              />
            ) : null}

            <Descriptions
              size="small"
              column={1}
              bordered
              title={t("systemSettings.realtimeSignals.runtime.markerReadiness", {
                defaultValue: "Marker readiness",
              })}
            >
              <Descriptions.Item
                label={t("systemSettings.realtimeSignals.runtime.markerWindow", {
                  defaultValue: "Lookback window",
                })}
              >
                {diagnostics.markerReadiness.windowHours}h
              </Descriptions.Item>
              <Descriptions.Item
                label={t("systemSettings.realtimeSignals.runtime.markerRecentArticles", {
                  defaultValue: "Recent processed articles",
                })}
              >
                {diagnostics.markerReadiness.recentProcessedArticles}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("systemSettings.realtimeSignals.runtime.markerRecentArticlesWithLocation", {
                  defaultValue: "Recent articles with location",
                })}
              >
                {diagnostics.markerReadiness.recentProcessedArticlesWithLocation}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("systemSettings.realtimeSignals.runtime.markerRecentMongo", {
                  defaultValue: "Recent Mongo processed items",
                })}
              >
                {diagnostics.markerReadiness.recentMongoProcessedItems}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("systemSettings.realtimeSignals.runtime.markerRecentMongoWithLocation", {
                  defaultValue: "Recent Mongo items with location",
                })}
              >
                {diagnostics.markerReadiness.recentMongoProcessedItemsWithLocation}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("systemSettings.realtimeSignals.runtime.markerLatestArticle", {
                  defaultValue: "Latest processed article",
                })}
              >
                {formatTimestamp(diagnostics.markerReadiness.latestProcessedArticleAt)}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("systemSettings.realtimeSignals.runtime.markerLatestMongo", {
                  defaultValue: "Latest processed item",
                })}
              >
                {formatTimestamp(diagnostics.markerReadiness.latestProcessedItemAt)}
              </Descriptions.Item>
            </Descriptions>

            <Row gutter={[12, 12]}>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title={t("systemSettings.realtimeSignals.runtime.insight.keywordSpikes", {
                      defaultValue: "Keyword spikes",
                    })}
                    value={diagnostics.insight.keywordSpikes.length}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title={t("systemSettings.realtimeSignals.runtime.insight.predictionLeads", {
                      defaultValue: "Prediction leads",
                    })}
                    value={diagnostics.insight.predictionLeads.length}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title={t("systemSettings.realtimeSignals.runtime.insight.tensions", {
                      defaultValue: "Tension pairs",
                    })}
                    value={diagnostics.insight.tensions.length}
                  />
                </Card>
              </Col>
            </Row>

            <Row gutter={[12, 12]}>
              {diagnostics.sources.map((row) => {
                const summary = summarizeRuntimeContext(row.source, row.context);
                return (
                  <Col key={row.source} xs={24} lg={12}>
                    <Card
                      size="small"
                      title={sourceNameByKey[row.source] ?? row.source}
                      extra={
                        <Space wrap size={[8, 8]}>
                          <Tag color={runtimeStatusColor(row.status)}>
                            {runtimeStatusLabel(row.status)}
                          </Tag>
                          <Tag color={row.enabled ? "green" : "default"}>
                            {row.intervalSec}s
                          </Tag>
                        </Space>
                      }
                    >
                      <Space direction="vertical" size="small" style={{ display: "flex" }}>
                        <Space wrap size={[8, 8]}>
                          <Typography.Text strong>
                            {t("systemSettings.realtimeSignals.runtime.latestValue", {
                              defaultValue: "Latest",
                            })}
                            : {row.latestValue ?? "—"}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {t("systemSettings.realtimeSignals.runtime.previousValue", {
                              defaultValue: "Previous",
                            })}
                            : {row.previousValue ?? "—"}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {t("systemSettings.realtimeSignals.runtime.changePercent", {
                              defaultValue: "Change",
                            })}
                            :{" "}
                            {typeof row.changePercent === "number"
                              ? `${row.changePercent.toFixed(2)}%`
                              : "—"}
                          </Typography.Text>
                        </Space>
                        {summary ? (
                          <Typography.Text type="secondary">{summary}</Typography.Text>
                        ) : null}
                        {row.statusReason ? (
                          <Typography.Text type="secondary">
                            {row.statusReason}
                          </Typography.Text>
                        ) : null}
                        <Space wrap size={[8, 8]}>
                          <Tag>
                            {t("systemSettings.realtimeSignals.runtime.lastRunAt", {
                              defaultValue: "Last run",
                            })}
                            : {formatTimestamp(row.lastRunAt)}
                          </Tag>
                          <Tag>
                            {t("systemSettings.realtimeSignals.runtime.lastAttemptAt", {
                              defaultValue: "Last attempt",
                            })}
                            : {formatTimestamp(row.lastAttemptAt)}
                          </Tag>
                          <Tag>
                            {t("systemSettings.realtimeSignals.runtime.lastSuccessAt", {
                              defaultValue: "Last success",
                            })}
                            : {formatTimestamp(row.lastSuccessAt)}
                          </Tag>
                        </Space>
                        {row.lastError ? (
                          <Alert
                            type="error"
                            showIcon
                            message={t("systemSettings.realtimeSignals.runtime.lastError", {
                              defaultValue: "Last error",
                            })}
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
          <div style={{ display: "flex", justifyContent: "center", padding: "1rem 0" }}>
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
        <Space wrap style={{ display: "flex", width: "100%" }}>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.adsbBaseUrl")}
            name="adsbBaseUrl"
            style={{ minWidth: 280, flex: 1 }}
            extra={t("systemSettings.realtimeSignals.hints.adsbBaseUrl")}
          >
            <Input
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.adsbBaseUrl",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.relayBaseUrl")}
            name="relayBaseUrl"
            style={{ minWidth: 280, flex: 1 }}
            extra={t("systemSettings.realtimeSignals.hints.relayBaseUrl")}
          >
            <Input
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.relayBaseUrl",
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
        <Space direction="vertical" style={{ width: "100%" }} size={0}>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.relaySharedSecret")}
            name="relaySharedSecret"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.aisApiKey")}
            name="aisApiKey"
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
