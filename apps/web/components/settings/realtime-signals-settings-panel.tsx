"use client";

import {
  Alert,
  Button,
  Card,
  Col,
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

type RealtimeSignalsSettingsSource = "env" | "db";
type RealtimeSignalsSecretSource = "stored" | "env" | "none";

interface RealtimeSignalsSettingsResponse {
  source: RealtimeSignalsSettingsSource;
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  openskyEnabled: boolean;
  openskyIntervalSec: number;
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
  relayBaseUrl?: string;
  polymarketProxyUrl?: string;
  hasRelaySharedSecret: boolean;
  relaySharedSecretSource: RealtimeSignalsSecretSource;
  hasOpenskyClientId: boolean;
  openskyClientIdSource: RealtimeSignalsSecretSource;
  hasOpenskyClientSecret: boolean;
  openskyClientSecretSource: RealtimeSignalsSecretSource;
  hasAisApiKey: boolean;
  aisApiKeySource: RealtimeSignalsSecretSource;
  hasAcledAccessToken: boolean;
  acledAccessTokenSource: RealtimeSignalsSecretSource;
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
  relayBaseUrl?: string;
  polymarketProxyUrl?: string;
  relaySharedSecret?: string;
  openskyClientId?: string;
  openskyClientSecret?: string;
  aisApiKey?: string;
  acledAccessToken?: string;
  cloudflareApiToken?: string;
  wingbitsApiKey?: string;
}

const EMPTY_SETTINGS: RealtimeSignalsSettingsResponse = {
  source: "env",
  enabled: true,
  requestTimeoutMs: 12_000,
  maxRetries: 2,
  openskyEnabled: true,
  openskyIntervalSec: 600,
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
  relayBaseUrl: "",
  polymarketProxyUrl: "",
  hasRelaySharedSecret: false,
  relaySharedSecretSource: "none",
  hasOpenskyClientId: false,
  openskyClientIdSource: "none",
  hasOpenskyClientSecret: false,
  openskyClientSecretSource: "none",
  hasAisApiKey: false,
  aisApiKeySource: "none",
  hasAcledAccessToken: false,
  acledAccessTokenSource: "none",
  hasCloudflareApiToken: false,
  cloudflareApiTokenSource: "none",
  hasWingbitsApiKey: false,
  wingbitsApiKeySource: "none",
};

const SOURCE_CONFIGS = [
  {
    nameKey: "systemSettings.realtimeSignals.sources.opensky",
    fallbackName: "OpenSky",
    enabledField: "openskyEnabled",
    intervalField: "openskyIntervalSec",
  },
  {
    nameKey: "systemSettings.realtimeSignals.sources.ais",
    fallbackName: "AIS",
    enabledField: "aisEnabled",
    intervalField: "aisIntervalSec",
  },
  {
    nameKey: "systemSettings.realtimeSignals.sources.unrest",
    fallbackName: "Unrest",
    enabledField: "unrestEnabled",
    intervalField: "unrestIntervalSec",
  },
  {
    nameKey: "systemSettings.realtimeSignals.sources.outages",
    fallbackName: "Internet outages",
    enabledField: "outagesEnabled",
    intervalField: "outagesIntervalSec",
  },
  {
    nameKey: "systemSettings.realtimeSignals.sources.keywordSpike",
    fallbackName: "Keyword spike",
    enabledField: "keywordSpikeEnabled",
    intervalField: "keywordSpikeIntervalSec",
  },
  {
    nameKey: "systemSettings.realtimeSignals.sources.pizzint",
    fallbackName: "PizzINT",
    enabledField: "pizzintEnabled",
    intervalField: "pizzintIntervalSec",
  },
  {
    nameKey: "systemSettings.realtimeSignals.sources.gdeltTension",
    fallbackName: "GDELT tension",
    enabledField: "gdeltTensionEnabled",
    intervalField: "gdeltTensionIntervalSec",
  },
  {
    nameKey: "systemSettings.realtimeSignals.sources.polymarketLeads",
    fallbackName: "Polymarket leads",
    enabledField: "polymarketLeadsEnabled",
    intervalField: "polymarketLeadsIntervalSec",
  },
] as const;

const SECRET_FIELD_NAMES = [
  "relaySharedSecret",
  "openskyClientId",
  "openskyClientSecret",
  "aisApiKey",
  "acledAccessToken",
  "cloudflareApiToken",
  "wingbitsApiKey",
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
    relayBaseUrl: settings.relayBaseUrl ?? "",
    polymarketProxyUrl: settings.polymarketProxyUrl ?? "",
    relaySharedSecret: "",
    openskyClientId: "",
    openskyClientSecret: "",
    aisApiKey: "",
    acledAccessToken: "",
    cloudflareApiToken: "",
    wingbitsApiKey: "",
  };
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

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

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
        relayBaseUrl: values.relayBaseUrl?.trim()
          ? values.relayBaseUrl.trim()
          : null,
        polymarketProxyUrl: values.polymarketProxyUrl?.trim()
          ? values.polymarketProxyUrl.trim()
          : null,
      };

      for (const fieldName of SECRET_FIELD_NAMES) {
        const nextValue = values[fieldName]?.trim();
        if (nextValue) {
          payload[fieldName] = nextValue;
        }
      }

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
          const response = await apiClient.delete<RealtimeSignalsSettingsResponse>(
            "system-settings/realtime-signals",
          );
          const data: RealtimeSignalsSettingsResponse = {
            ...EMPTY_SETTINGS,
            ...(response.data ?? {}),
          };
          setSettings(data);
          form.setFieldsValue(toFormValues(data));
          messageApi.success(t("systemSettings.realtimeSignals.messages.reset"));
        } catch (error) {
          captureClientError("Failed to reset realtime signals settings", error);
          messageApi.error(t("systemSettings.realtimeSignals.errors.resetFailed"));
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

  const secretStatusRows = [
    {
      key: "relaySharedSecret",
      label: t("systemSettings.realtimeSignals.status.relaySharedSecret"),
      has: settings.hasRelaySharedSecret,
      source: settings.relaySharedSecretSource,
    },
    {
      key: "openskyClientId",
      label: t("systemSettings.realtimeSignals.status.openskyClientId"),
      has: settings.hasOpenskyClientId,
      source: settings.openskyClientIdSource,
    },
    {
      key: "openskyClientSecret",
      label: t("systemSettings.realtimeSignals.status.openskyClientSecret"),
      has: settings.hasOpenskyClientSecret,
      source: settings.openskyClientSecretSource,
    },
    {
      key: "aisApiKey",
      label: t("systemSettings.realtimeSignals.status.aisApiKey"),
      has: settings.hasAisApiKey,
      source: settings.aisApiKeySource,
    },
    {
      key: "acledAccessToken",
      label: t("systemSettings.realtimeSignals.status.acledAccessToken"),
      has: settings.hasAcledAccessToken,
      source: settings.acledAccessTokenSource,
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
      key: sourceConfig.enabledField,
      sourceName,
      enabled,
      intervalSec,
    };
  });

  const enabledSourceCount = sourceStatusRows.filter((row) => row.enabled).length;
  const disabledSourceCount = sourceStatusRows.length - enabledSourceCount;
  const fastestEnabledInterval = sourceStatusRows
    .filter((row) => row.enabled && typeof row.intervalSec === "number")
    .reduce<number | null>(
      (acc, row) =>
        acc === null || (row.intervalSec as number) < acc
          ? (row.intervalSec as number)
          : acc,
      null,
    );
  const configuredSecretCount = secretStatusRows.filter((row) => row.has).length;

  if (loading && !loadedOnce) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
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
              title={t("systemSettings.realtimeSignals.overview.enabledSources", {
                defaultValue: "Enabled sources",
              })}
              value={enabledSourceCount}
              suffix={`/ ${sourceStatusRows.length}`}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t("systemSettings.realtimeSignals.overview.disabledSources", {
                defaultValue: "Disabled sources",
              })}
              value={disabledSourceCount}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t("systemSettings.realtimeSignals.overview.fastestInterval", {
                defaultValue: "Fastest interval",
              })}
              value={fastestEnabledInterval ?? "—"}
              suffix={fastestEnabledInterval ? "sec" : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title={t("systemSettings.realtimeSignals.overview.configuredSecrets", {
                defaultValue: "Configured secrets",
              })}
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
              {typeof row.intervalSec === "number" ? ` · ${row.intervalSec}s` : ""}
            </Tag>
          ))}
        </Space>
      </Space>

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
            <InputNumber min={1_000} max={120_000} step={500} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.maxRetries")}
            name="maxRetries"
            style={{ minWidth: 220, flex: 1 }}
            rules={[
              {
                required: true,
                message: t("systemSettings.realtimeSignals.validation.maxRetries"),
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
                label={t("systemSettings.realtimeSignals.fields.sourceEnabled", {
                  source: sourceName,
                })}
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
            label={t("systemSettings.realtimeSignals.fields.keywordSpikeMinCount")}
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
            <InputNumber min={1} max={100} step={0.1} style={{ width: "100%" }} />
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
            <InputNumber min={1} max={100} step={0.1} style={{ width: "100%" }} />
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
            <InputNumber min={0} max={1_000} step={1} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Typography.Title level={5}>
          {t("systemSettings.realtimeSignals.sections.endpoints")}
        </Typography.Title>
        <Space wrap style={{ display: "flex", width: "100%" }}>
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
            label={t("systemSettings.realtimeSignals.fields.polymarketProxyUrl")}
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
        <Typography.Paragraph type="secondary" style={{ marginBottom: "0.75rem" }}>
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
            label={t("systemSettings.realtimeSignals.fields.openskyClientId")}
            name="openskyClientId"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.openskyClientSecret")}
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
            label={t("systemSettings.realtimeSignals.fields.acledAccessToken")}
            name="acledAccessToken"
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={t(
                "systemSettings.realtimeSignals.placeholders.secretValue",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.realtimeSignals.fields.cloudflareApiToken")}
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
          <Button danger onClick={handleReset} loading={resetting} disabled={saving}>
            {t("systemSettings.realtimeSignals.actions.reset")}
          </Button>
        </Space>
      </Form>
    </>
  );
}
