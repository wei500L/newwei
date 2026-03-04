"use client";

import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
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
  applySituationMonitorSecretFields,
  SITUATION_MONITOR_SECRET_FIELD_NAMES,
  type SituationMonitorSecretFieldName,
} from "@/lib/situation-monitor-settings-payload";

type SituationMonitorSettingsSource = "env" | "db";
type SituationMonitorTranslationProvider = "deeplx";
type SituationMonitorTranslationApiKeySource = "stored" | "env" | "none";
type SituationMonitorExternalApiKeySource = "stored" | "env" | "none";
type SituationMonitorTelegramSecretSource = "stored" | "env" | "none";

interface SituationMonitorSettingsResponse {
  source: SituationMonitorSettingsSource;
  translationMaxConcurrency: number;
  translationProvider: SituationMonitorTranslationProvider;
  translationApiEnabled: boolean;
  translationApiBaseUrl: string;
  translationFallbackApiEnabled: boolean;
  translationFallbackApiBaseUrl: string;
  translationApiTimeoutMs: number;
  translationApiMaxRetries: number;
  hasTranslationApiKey: boolean;
  translationApiKeySource: SituationMonitorTranslationApiKeySource;
  hasFinnhubApiKey: boolean;
  finnhubApiKeySource: SituationMonitorExternalApiKeySource;
  hasFredApiKey: boolean;
  fredApiKeySource: SituationMonitorExternalApiKeySource;
  telegramEnabled: boolean;
  hasTelegramApiId: boolean;
  telegramApiIdSource: SituationMonitorTelegramSecretSource;
  telegramApiId?: string;
  hasTelegramApiHash: boolean;
  telegramApiHashSource: SituationMonitorTelegramSecretSource;
  hasTelegramSession: boolean;
  telegramSessionSource: SituationMonitorTelegramSecretSource;
  telegramChannelSet: string;
  telegramMaxFeedItems: number;
  telegramMaxTextChars: number;
  telegramChannelTimeoutMs: number;
  telegramPollCycleTimeoutMs: number;
  telegramStartupDelayMs: number;
  telegramRateLimitMs: number;
  telegramPollIntervalMs: number;
}

interface SituationMonitorSettingsFormValues {
  translationMaxConcurrency: number;
  translationApiEnabled: boolean;
  translationApiBaseUrl?: string;
  translationApiKey?: string;
  translationFallbackApiEnabled: boolean;
  translationFallbackApiBaseUrl?: string;
  finnhubApiKey?: string;
  fredApiKey?: string;
  translationApiTimeoutMs: number;
  translationApiMaxRetries: number;
  telegramEnabled: boolean;
  telegramApiId?: string;
  telegramApiHash?: string;
  telegramChannelSet?: string;
  telegramMaxFeedItems: number;
  telegramMaxTextChars: number;
  telegramChannelTimeoutMs: number;
  telegramPollCycleTimeoutMs: number;
  telegramStartupDelayMs: number;
  telegramRateLimitMs: number;
  telegramPollIntervalMs: number;
}

interface StartTelegramAuthResponse {
  requestId: string;
  isCodeViaApp: boolean;
  expiresAt: string;
}

const TELEGRAM_AUTH_ERROR_CODE_I18N_KEY: Record<string, string> = {
  TELEGRAM_AUTH_INVALID_INPUT: "systemSettings.situationMonitor.errors.telegramAuthInvalidInput",
  TELEGRAM_AUTH_PHONE_FORMAT_INVALID: "systemSettings.situationMonitor.errors.telegramPhoneFormatInvalid",
  TELEGRAM_AUTH_REQUEST_EXPIRED: "systemSettings.situationMonitor.errors.telegramAuthRequestExpired",
  TELEGRAM_AUTH_REQUEST_MISMATCH: "systemSettings.situationMonitor.errors.telegramAuthRequestMismatch",
  TELEGRAM_AUTH_CODE_INVALID: "systemSettings.situationMonitor.errors.telegramAuthCodeInvalid",
  TELEGRAM_AUTH_CODE_EXPIRED: "systemSettings.situationMonitor.errors.telegramAuthCodeExpired",
  TELEGRAM_AUTH_CODE_REQUIRED: "systemSettings.situationMonitor.errors.telegramCodeRequired",
  TELEGRAM_AUTH_PASSWORD_REQUIRED: "systemSettings.situationMonitor.errors.telegramAuthPasswordRequired",
  TELEGRAM_AUTH_PASSWORD_INVALID: "systemSettings.situationMonitor.errors.telegramAuthPasswordInvalid",
  TELEGRAM_AUTH_RATE_LIMIT: "systemSettings.situationMonitor.errors.telegramAuthRateLimited",
  TELEGRAM_AUTH_PHONE_INVALID: "systemSettings.situationMonitor.errors.telegramPhoneInvalid",
  TELEGRAM_AUTH_PHONE_BANNED: "systemSettings.situationMonitor.errors.telegramPhoneBanned",
  TELEGRAM_AUTH_PHONE_UNOCCUPIED: "systemSettings.situationMonitor.errors.telegramPhoneUnoccupied",
  TELEGRAM_AUTH_API_ID_INVALID: "systemSettings.situationMonitor.errors.telegramApiIdInvalid",
  TELEGRAM_AUTH_API_CREDENTIALS_REQUIRED:
    "systemSettings.situationMonitor.errors.telegramApiCredentialsRequired",
  TELEGRAM_AUTH_RESTART_REQUIRED: "systemSettings.situationMonitor.errors.telegramAuthRestartRequired",
  TELEGRAM_AUTH_SIGNUP_REQUIRED: "systemSettings.situationMonitor.errors.telegramAuthSignupRequired",
  TELEGRAM_AUTH_FAILED: "systemSettings.situationMonitor.errors.telegramAuthFailed",
  INSUFFICIENT_PERMISSIONS: "systemSettings.situationMonitor.errors.telegramAuthPermissionDenied",
  MISSING_USER_CONTEXT: "systemSettings.situationMonitor.errors.telegramAuthPermissionDenied",
};

function formatTelegramAuthError(
  error: unknown,
  fallback: string,
  t: (key: string, options?: { defaultValue?: string }) => string
): string {
  const parsed = extractApiError(error);
  const normalizedCode =
    parsed.code?.trim() ||
    (parsed.message?.trim() && /^TELEGRAM_AUTH_[A-Z0-9_]+$/.test(parsed.message.trim())
      ? parsed.message.trim()
      : undefined);
  const key = normalizedCode ? TELEGRAM_AUTH_ERROR_CODE_I18N_KEY[normalizedCode] : undefined;
  const message =
    key !== undefined
      ? t(key, { defaultValue: parsed.message?.trim() || fallback })
      : parsed.message?.trim() || fallback;
  const detail = parsed.detail?.trim();
  if (!detail || detail === message) {
    return message;
  }
  return `${message} (${detail})`;
}

const EMPTY_SETTINGS: SituationMonitorSettingsResponse = {
  source: "env",
  translationMaxConcurrency: 2,
  translationProvider: "deeplx",
  translationApiEnabled: true,
  translationApiBaseUrl: "https://api.deeplx.org",
  translationFallbackApiEnabled: false,
  translationFallbackApiBaseUrl: "",
  translationApiTimeoutMs: 15_000,
  translationApiMaxRetries: 2,
  hasTranslationApiKey: false,
  translationApiKeySource: "none",
  hasFinnhubApiKey: false,
  finnhubApiKeySource: "none",
  hasFredApiKey: false,
  fredApiKeySource: "none",
  telegramEnabled: false,
  hasTelegramApiId: false,
  telegramApiIdSource: "none",
  telegramApiId: "",
  hasTelegramApiHash: false,
  telegramApiHashSource: "none",
  hasTelegramSession: false,
  telegramSessionSource: "none",
  telegramChannelSet: "full",
  telegramMaxFeedItems: 200,
  telegramMaxTextChars: 800,
  telegramChannelTimeoutMs: 15_000,
  telegramPollCycleTimeoutMs: 180_000,
  telegramStartupDelayMs: 60_000,
  telegramRateLimitMs: 800,
  telegramPollIntervalMs: 60_000,
};

function toFormValues(settings: SituationMonitorSettingsResponse): SituationMonitorSettingsFormValues {
  return {
    translationMaxConcurrency: settings.translationMaxConcurrency,
    translationApiEnabled: settings.translationApiEnabled,
    translationApiBaseUrl: settings.translationApiBaseUrl ?? "",
    translationApiKey: "",
    translationFallbackApiEnabled: settings.translationFallbackApiEnabled,
    translationFallbackApiBaseUrl: settings.translationFallbackApiBaseUrl ?? "",
    finnhubApiKey: "",
    fredApiKey: "",
    translationApiTimeoutMs: settings.translationApiTimeoutMs,
    translationApiMaxRetries: settings.translationApiMaxRetries,
    telegramEnabled: settings.telegramEnabled,
    telegramApiId: settings.telegramApiId ?? "",
    telegramApiHash: "",
    telegramChannelSet: settings.telegramChannelSet,
    telegramMaxFeedItems: settings.telegramMaxFeedItems,
    telegramMaxTextChars: settings.telegramMaxTextChars,
    telegramChannelTimeoutMs: settings.telegramChannelTimeoutMs,
    telegramPollCycleTimeoutMs: settings.telegramPollCycleTimeoutMs,
    telegramStartupDelayMs: settings.telegramStartupDelayMs,
    telegramRateLimitMs: settings.telegramRateLimitMs,
    telegramPollIntervalMs: settings.telegramPollIntervalMs,
  };
}

export function SituationMonitorSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<SituationMonitorSettingsFormValues>();
  const [settings, setSettings] = useState<SituationMonitorSettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [telegramPhoneNumber, setTelegramPhoneNumber] = useState("");
  const [telegramAuthRequestId, setTelegramAuthRequestId] = useState<string | null>(null);
  const [telegramAuthCode, setTelegramAuthCode] = useState("");
  const [telegramAuthPassword, setTelegramAuthPassword] = useState("");
  const [telegramAuthCodeViaApp, setTelegramAuthCodeViaApp] = useState(false);
  const [telegramAuthExpiresAt, setTelegramAuthExpiresAt] = useState<string | null>(null);
  const [telegramAuthStarting, setTelegramAuthStarting] = useState(false);
  const [telegramAuthCompleting, setTelegramAuthCompleting] = useState(false);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const applySettings = useCallback(
    (next: SituationMonitorSettingsResponse) => {
      setSettings(next);
      form.setFieldsValue(toFormValues(next));
    },
    [form]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<SituationMonitorSettingsResponse>("system-settings/situation-monitor");
      const data: SituationMonitorSettingsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {}),
      };
      applySettings(data);
    } catch (error) {
      captureClientError("Failed to load situation monitor settings", error);
      setErrorMessage(t("systemSettings.situationMonitor.errors.loadFailed"));
      applySettings(EMPTY_SETTINGS);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [apiClient, applySettings, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (values: SituationMonitorSettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload: Record<string, unknown> = {
        translationMaxConcurrency: values.translationMaxConcurrency,
        translationApiEnabled: values.translationApiEnabled,
        translationApiBaseUrl: values.translationApiBaseUrl?.trim() ? values.translationApiBaseUrl.trim() : null,
        translationFallbackApiEnabled: values.translationFallbackApiEnabled,
        translationFallbackApiBaseUrl: values.translationFallbackApiBaseUrl?.trim()
          ? values.translationFallbackApiBaseUrl.trim()
          : null,
        translationApiTimeoutMs: values.translationApiTimeoutMs,
        translationApiMaxRetries: values.translationApiMaxRetries,
        telegramEnabled: values.telegramEnabled,
        telegramChannelSet: values.telegramChannelSet?.trim() ? values.telegramChannelSet.trim() : "full",
        telegramMaxFeedItems: values.telegramMaxFeedItems,
        telegramMaxTextChars: values.telegramMaxTextChars,
        telegramChannelTimeoutMs: values.telegramChannelTimeoutMs,
        telegramPollCycleTimeoutMs: values.telegramPollCycleTimeoutMs,
        telegramStartupDelayMs: values.telegramStartupDelayMs,
        telegramRateLimitMs: values.telegramRateLimitMs,
        telegramPollIntervalMs: values.telegramPollIntervalMs,
      };

      const touchedSecrets = Object.fromEntries(
        SITUATION_MONITOR_SECRET_FIELD_NAMES.map((fieldName) => [
          fieldName,
          form.isFieldTouched(fieldName),
        ])
      ) as Partial<Record<SituationMonitorSecretFieldName, boolean>>;

      applySituationMonitorSecretFields(payload, values, touchedSecrets);

      const response = await apiClient.put<SituationMonitorSettingsResponse>(
        "system-settings/situation-monitor",
        payload
      );
      const data: SituationMonitorSettingsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {}),
      };
      applySettings(data);
      messageApi.success(t("systemSettings.situationMonitor.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save situation monitor settings", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(extractApiError(error).message ?? t("systemSettings.situationMonitor.errors.badRequest"));
      } else {
        messageApi.error(t("systemSettings.situationMonitor.errors.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.situationMonitor.modal.resetTitle"),
      content: t("systemSettings.situationMonitor.modal.resetContent"),
      okText: t("systemSettings.situationMonitor.modal.confirm"),
      cancelText: t("systemSettings.situationMonitor.modal.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.delete<SituationMonitorSettingsResponse>(
            "system-settings/situation-monitor"
          );
          const data: SituationMonitorSettingsResponse = {
            ...EMPTY_SETTINGS,
            ...(response.data ?? {}),
          };
          applySettings(data);
          setTelegramAuthRequestId(null);
          setTelegramAuthCode("");
          setTelegramAuthPassword("");
          setTelegramAuthExpiresAt(null);
          setTelegramAuthCodeViaApp(false);
          messageApi.success(t("systemSettings.situationMonitor.messages.reset"));
        } catch (error) {
          captureClientError("Failed to reset situation monitor settings", error);
          messageApi.error(t("systemSettings.situationMonitor.errors.resetFailed"));
        } finally {
          setResetting(false);
        }
      },
    });
  };

  const handleTelegramStartAuth = async () => {
    const apiId = form.getFieldValue("telegramApiId")?.trim();
    const apiHash = form.getFieldValue("telegramApiHash")?.trim();
    if (!telegramPhoneNumber.trim()) {
      messageApi.error(t("systemSettings.situationMonitor.errors.telegramPhoneRequired"));
      return;
    }

    const startPayload: {
      phoneNumber: string;
      telegramApiId?: string;
      telegramApiHash?: string;
    } = {
      phoneNumber: telegramPhoneNumber.trim(),
    };
    if (apiId) {
      startPayload.telegramApiId = apiId;
    }
    if (apiHash) {
      startPayload.telegramApiHash = apiHash;
    }

    setTelegramAuthStarting(true);
    try {
      const response = await apiClient.post<StartTelegramAuthResponse>(
        "system-settings/situation-monitor/telegram-auth/start",
        startPayload
      );

      const data = response.data;
      if (!data?.requestId) {
        throw new Error("Missing telegram auth request id");
      }
      setTelegramAuthRequestId(data.requestId);
      setTelegramAuthCodeViaApp(Boolean(data.isCodeViaApp));
      setTelegramAuthExpiresAt(data.expiresAt ?? null);
      setTelegramAuthCode("");
      setTelegramAuthPassword("");
      messageApi.success(t("systemSettings.situationMonitor.messages.telegramCodeSent"));
    } catch (error) {
      captureClientError("Failed to start telegram auth", error);
      messageApi.error(
        formatTelegramAuthError(
          error,
          t("systemSettings.situationMonitor.errors.telegramAuthStartFailed"),
          t
        )
      );
    } finally {
      setTelegramAuthStarting(false);
    }
  };

  const askEnableTelegram = async (): Promise<boolean> => {
    return new Promise((resolve) => {
      Modal.confirm({
        title: t("systemSettings.situationMonitor.modal.telegramEnableTitle"),
        content: t("systemSettings.situationMonitor.modal.telegramEnableContent"),
        okText: t("systemSettings.situationMonitor.modal.telegramEnableConfirm"),
        cancelText: t("systemSettings.situationMonitor.modal.telegramEnableSkip"),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  };

  const handleTelegramCompleteAuth = async () => {
    if (!telegramAuthRequestId) {
      messageApi.error(t("systemSettings.situationMonitor.errors.telegramAuthRequestMissing"));
      return;
    }
    if (!telegramAuthCode.trim()) {
      messageApi.error(t("systemSettings.situationMonitor.errors.telegramCodeRequired"));
      return;
    }

    setTelegramAuthCompleting(true);
    try {
      const enableTelegram = await askEnableTelegram();
      const response = await apiClient.post<SituationMonitorSettingsResponse>(
        "system-settings/situation-monitor/telegram-auth/complete",
        {
          requestId: telegramAuthRequestId,
          phoneCode: telegramAuthCode.trim(),
          password: telegramAuthPassword.trim() || undefined,
          enableTelegram,
        }
      );

      const data: SituationMonitorSettingsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {}),
      };
      applySettings(data);
      setTelegramAuthRequestId(null);
      setTelegramAuthCode("");
      setTelegramAuthPassword("");
      setTelegramAuthExpiresAt(null);
      setTelegramAuthCodeViaApp(false);
      messageApi.success(t("systemSettings.situationMonitor.messages.telegramSessionSaved"));
    } catch (error) {
      captureClientError("Failed to complete telegram auth", error);
      messageApi.error(
        formatTelegramAuthError(
          error,
          t("systemSettings.situationMonitor.errors.telegramAuthCompleteFailed"),
          t
        )
      );
    } finally {
      setTelegramAuthCompleting(false);
    }
  };

  const sourceColor = settings.source === "db" ? "green" : "default";
  const sourceLabel =
    settings.source === "db"
      ? t("systemSettings.situationMonitor.status.saved")
      : t("systemSettings.situationMonitor.status.env");
  const translationEnabledColor = settings.translationApiEnabled ? "green" : "default";
  const translationEnabledLabel = settings.translationApiEnabled
    ? t("systemSettings.situationMonitor.status.enabled")
    : t("systemSettings.situationMonitor.status.disabled");
  const telegramEnabledColor = settings.telegramEnabled ? "green" : "default";
  const telegramEnabledLabel = settings.telegramEnabled
    ? t("systemSettings.situationMonitor.status.enabled")
    : t("systemSettings.situationMonitor.status.disabled");
  const fallbackEnabledColor = settings.translationFallbackApiEnabled ? "green" : "default";
  const fallbackEnabledLabel = settings.translationFallbackApiEnabled
    ? t("systemSettings.situationMonitor.status.enabled")
    : t("systemSettings.situationMonitor.status.disabled");
  const providerLabel = settings.translationProvider.toUpperCase();

  const translationKeySourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.translationApiKeySource}`,
    { defaultValue: settings.translationApiKeySource }
  );
  const finnhubKeySourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.finnhubApiKeySource}`,
    { defaultValue: settings.finnhubApiKeySource }
  );
  const fredKeySourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.fredApiKeySource}`,
    { defaultValue: settings.fredApiKeySource }
  );
  const telegramApiIdSourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.telegramApiIdSource}`,
    { defaultValue: settings.telegramApiIdSource }
  );
  const telegramApiHashSourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.telegramApiHashSource}`,
    { defaultValue: settings.telegramApiHashSource }
  );
  const telegramSessionSourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.telegramSessionSource}`,
    { defaultValue: settings.telegramSessionSource }
  );

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
        {t("systemSettings.situationMonitor.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.situationMonitor.notice.title")}
        description={t("systemSettings.situationMonitor.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} /> : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.situationMonitor.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag color={translationEnabledColor}>{translationEnabledLabel}</Tag>
          <Tag>{providerLabel}</Tag>
          <Tag color={telegramEnabledColor}>{telegramEnabledLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.situationMonitor.status.translationApiKeySource")}
          </Typography.Text>
          <Tag color={settings.hasTranslationApiKey ? "blue" : "default"}>{translationKeySourceLabel}</Tag>
          <Tag color="geekblue">{settings.translationApiBaseUrl}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.situationMonitor.status.translationFallbackApi")}
          </Typography.Text>
          <Tag color={fallbackEnabledColor}>{fallbackEnabledLabel}</Tag>
          <Tag color="geekblue">
            {settings.translationFallbackApiBaseUrl || t("systemSettings.situationMonitor.status.notConfigured")}
          </Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.situationMonitor.status.finnhubApiKeySource")}
          </Typography.Text>
          <Tag color={settings.hasFinnhubApiKey ? "blue" : "default"}>{finnhubKeySourceLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">{t("systemSettings.situationMonitor.status.fredApiKeySource")}</Typography.Text>
          <Tag color={settings.hasFredApiKey ? "blue" : "default"}>{fredKeySourceLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">{t("systemSettings.situationMonitor.status.telegramApiIdSource")}</Typography.Text>
          <Tag color={settings.hasTelegramApiId ? "blue" : "default"}>{telegramApiIdSourceLabel}</Tag>
          <Tag>{settings.telegramApiId || t("systemSettings.situationMonitor.status.notConfigured")}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">{t("systemSettings.situationMonitor.status.telegramApiHashSource")}</Typography.Text>
          <Tag color={settings.hasTelegramApiHash ? "blue" : "default"}>{telegramApiHashSourceLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">{t("systemSettings.situationMonitor.status.telegramSessionSource")}</Typography.Text>
          <Tag color={settings.hasTelegramSession ? "blue" : "default"}>{telegramSessionSourceLabel}</Tag>
          <Tag color="geekblue">{settings.telegramChannelSet}</Tag>
          <Tag>{t("systemSettings.situationMonitor.status.telegramPollInterval", { ms: settings.telegramPollIntervalMs })}</Tag>
        </Space>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationMaxConcurrency")}
          name="translationMaxConcurrency"
          rules={[
            { required: true, message: t("systemSettings.situationMonitor.validation.translationMaxConcurrency") },
            {
              type: "number",
              min: 1,
              max: 5_000,
              message: t("common.validation.numberRange", { min: 1, max: 5_000 }),
            },
          ]}
          extra={t("systemSettings.situationMonitor.hints.translationMaxConcurrency")}
        >
          <InputNumber min={1} max={5_000} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
          {t("systemSettings.situationMonitor.sections.translationApi")}
        </Typography.Title>

        <Form.Item
          name="translationApiEnabled"
          valuePropName="checked"
          label={t("systemSettings.situationMonitor.fields.translationApiEnabled")}
          extra={t("systemSettings.situationMonitor.hints.translationApiEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationApiBaseUrl")}
          name="translationApiBaseUrl"
          extra={t("systemSettings.situationMonitor.hints.translationApiBaseUrl")}
        >
          <Input placeholder={t("systemSettings.situationMonitor.placeholders.translationApiBaseUrl")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationApiKey")}
          name="translationApiKey"
          extra={t("systemSettings.situationMonitor.hints.translationApiKey")}
        >
          <Input.Password placeholder={t("systemSettings.situationMonitor.placeholders.translationApiKey")} />
        </Form.Item>

        <Form.Item
          name="translationFallbackApiEnabled"
          valuePropName="checked"
          label={t("systemSettings.situationMonitor.fields.translationFallbackApiEnabled")}
          extra={t("systemSettings.situationMonitor.hints.translationFallbackApiEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationFallbackApiBaseUrl")}
          name="translationFallbackApiBaseUrl"
          extra={t("systemSettings.situationMonitor.hints.translationFallbackApiBaseUrl")}
        >
          <Input placeholder={t("systemSettings.situationMonitor.placeholders.translationFallbackApiBaseUrl")} />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
          {t("systemSettings.situationMonitor.sections.externalApis")}
        </Typography.Title>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.finnhubApiKey")}
          name="finnhubApiKey"
          extra={t("systemSettings.situationMonitor.hints.finnhubApiKey")}
        >
          <Input.Password placeholder={t("systemSettings.situationMonitor.placeholders.finnhubApiKey")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.fredApiKey")}
          name="fredApiKey"
          extra={t("systemSettings.situationMonitor.hints.fredApiKey")}
        >
          <Input.Password placeholder={t("systemSettings.situationMonitor.placeholders.fredApiKey")} />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.translationApiTimeoutMs")}
            name="translationApiTimeoutMs"
            rules={[
              { required: true, message: t("systemSettings.situationMonitor.validation.translationApiTimeoutMs") },
              {
                type: "number",
                min: 1_000,
                max: 120_000,
                message: t("common.validation.numberRange", { min: 1_000, max: 120_000 }),
              },
            ]}
            extra={t("systemSettings.situationMonitor.hints.translationApiTimeoutMs")}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={1_000} max={120_000} step={1_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.translationApiMaxRetries")}
            name="translationApiMaxRetries"
            rules={[
              {
                required: true,
                message: t("systemSettings.situationMonitor.validation.translationApiMaxRetries"),
              },
              { type: "number", min: 0, max: 5, message: t("common.validation.numberRange", { min: 0, max: 5 }) },
            ]}
            extra={t("systemSettings.situationMonitor.hints.translationApiMaxRetries")}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber min={0} max={5} step={1} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Typography.Title level={5} style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
          {t("systemSettings.situationMonitor.sections.telegram")}
        </Typography.Title>

        <Form.Item
          name="telegramEnabled"
          valuePropName="checked"
          label={t("systemSettings.situationMonitor.fields.telegramEnabled")}
          extra={t("systemSettings.situationMonitor.hints.telegramEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.telegramChannelSet")}
          name="telegramChannelSet"
          extra={t("systemSettings.situationMonitor.hints.telegramChannelSet")}
        >
          <Input placeholder={t("systemSettings.situationMonitor.placeholders.telegramChannelSet")} />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.telegramMaxFeedItems")}
            name="telegramMaxFeedItems"
            rules={[{ required: true, message: t("systemSettings.situationMonitor.validation.telegramMaxFeedItems") }]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={50} max={500} step={10} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.telegramMaxTextChars")}
            name="telegramMaxTextChars"
            rules={[{ required: true, message: t("systemSettings.situationMonitor.validation.telegramMaxTextChars") }]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={200} max={10_000} step={100} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.telegramChannelTimeoutMs")}
            name="telegramChannelTimeoutMs"
            rules={[
              { required: true, message: t("systemSettings.situationMonitor.validation.telegramChannelTimeoutMs") },
            ]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={3_000} max={120_000} step={1_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.telegramPollCycleTimeoutMs")}
            name="telegramPollCycleTimeoutMs"
            rules={[
              { required: true, message: t("systemSettings.situationMonitor.validation.telegramPollCycleTimeoutMs") },
            ]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={30_000} max={600_000} step={5_000} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.telegramStartupDelayMs")}
            name="telegramStartupDelayMs"
            rules={[
              { required: true, message: t("systemSettings.situationMonitor.validation.telegramStartupDelayMs") },
            ]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={0} max={600_000} step={1_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.telegramRateLimitMs")}
            name="telegramRateLimitMs"
            rules={[{ required: true, message: t("systemSettings.situationMonitor.validation.telegramRateLimitMs") }]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={100} max={60_000} step={100} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.telegramPollIntervalMs")}
            name="telegramPollIntervalMs"
            rules={[
              { required: true, message: t("systemSettings.situationMonitor.validation.telegramPollIntervalMs") },
            ]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={15_000} max={3_600_000} step={1_000} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Typography.Title level={5} style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
          {t("systemSettings.situationMonitor.sections.telegramAuth")}
        </Typography.Title>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.telegramApiId")}
          name="telegramApiId"
          extra={t("systemSettings.situationMonitor.hints.telegramApiId")}
        >
          <Input placeholder={t("systemSettings.situationMonitor.placeholders.telegramApiId")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.telegramApiHash")}
          name="telegramApiHash"
          extra={t("systemSettings.situationMonitor.hints.telegramApiHash")}
        >
          <Input.Password placeholder={t("systemSettings.situationMonitor.placeholders.telegramApiHash")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.telegramPhoneNumber")}
          extra={t("systemSettings.situationMonitor.hints.telegramPhoneNumber")}
        >
          <Space.Compact style={{ width: "100%" }}>
            <Input
              value={telegramPhoneNumber}
              onChange={(event) => setTelegramPhoneNumber(event.target.value)}
              placeholder={t("systemSettings.situationMonitor.placeholders.telegramPhoneNumber")}
            />
            <Button onClick={handleTelegramStartAuth} loading={telegramAuthStarting}>
              {t("systemSettings.situationMonitor.actions.telegramSendCode")}
            </Button>
          </Space.Compact>
        </Form.Item>

        {telegramAuthRequestId ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: "1rem" }}
            message={t("systemSettings.situationMonitor.messages.telegramAuthRequestReady")}
            description={
              <Space direction="vertical" size={2}>
                <Typography.Text>
                  {t("systemSettings.situationMonitor.status.telegramCodeDelivery", {
                    via: telegramAuthCodeViaApp
                      ? t("systemSettings.situationMonitor.status.telegramCodeViaApp")
                      : t("systemSettings.situationMonitor.status.telegramCodeViaSms"),
                  })}
                </Typography.Text>
                {telegramAuthExpiresAt ? (
                  <Typography.Text type="secondary">
                    {t("systemSettings.situationMonitor.status.telegramAuthExpiresAt", {
                      time: telegramAuthExpiresAt,
                    })}
                  </Typography.Text>
                ) : null}
              </Space>
            }
          />
        ) : null}

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.telegramPhoneCode")}
          extra={t("systemSettings.situationMonitor.hints.telegramPhoneCode")}
        >
          <Input
            value={telegramAuthCode}
            onChange={(event) => setTelegramAuthCode(event.target.value)}
            placeholder={t("systemSettings.situationMonitor.placeholders.telegramPhoneCode")}
          />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.telegram2faPassword")}
          extra={t("systemSettings.situationMonitor.hints.telegram2faPassword")}
        >
          <Input.Password
            value={telegramAuthPassword}
            onChange={(event) => setTelegramAuthPassword(event.target.value)}
            placeholder={t("systemSettings.situationMonitor.placeholders.telegram2faPassword")}
          />
        </Form.Item>

        <Space wrap style={{ marginBottom: "1rem" }}>
          <Button
            onClick={handleTelegramCompleteAuth}
            loading={telegramAuthCompleting}
            disabled={!telegramAuthRequestId}
          >
            {t("systemSettings.situationMonitor.actions.telegramCompleteAuth")}
          </Button>
          <Button
            onClick={() => {
              setTelegramAuthRequestId(null);
              setTelegramAuthCode("");
              setTelegramAuthPassword("");
              setTelegramAuthExpiresAt(null);
              setTelegramAuthCodeViaApp(false);
            }}
            disabled={!telegramAuthRequestId || telegramAuthCompleting}
          >
            {t("systemSettings.situationMonitor.actions.telegramClearAuthState")}
          </Button>
        </Space>

        <Space wrap>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
          <Button danger onClick={handleReset} loading={resetting} disabled={saving || resetting}>
            {t("systemSettings.situationMonitor.actions.reset")}
          </Button>
        </Space>
      </Form>
    </>
  );
}
