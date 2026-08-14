"use client";

import { Alert, Button, Card, Descriptions, Divider, Form, Input, InputNumber, Modal, Select, Space, Spin, Switch, Table, Tag, Typography, message, theme } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type AssistantSafetySettingsSource = "env" | "db";
type OpenAiKeysSettingsSource = "none" | "db";

interface AssistantSafetySettingsResponse {
  source: AssistantSafetySettingsSource;
  enabled: boolean;
  outputModerationEnabled: boolean;
  guardrails: string[];
}

interface OpenAiKeysSettingsResponse {
  source: OpenAiKeysSettingsSource;
  keysCount: number;
  hasKeys: boolean;
  keyFingerprints: string[];
  internalTokenConfigured: boolean;
  appliedAt: string | null;
  appliedSource: "db" | "env" | "none" | null;
  appliedKeyFingerprints: string[];
  restartRequired: boolean;
}

interface AssistantSafetyDiagnosticsResponse {
  checkedAt: string;
  litellm: {
    apiBase: string;
    liveliness: { ok: boolean; status: number | null; error: string | null };
    models: { ok: boolean; status: number | null; count: number | null; error: string | null };
    guardrails: {
      ok: boolean;
      status: number | null;
      count: number | null;
      expected: string[];
      missing: string[];
      error: string | null;
    };
  };
  assistantSafety: AssistantSafetySettingsResponse;
  openaiKeys: OpenAiKeysSettingsResponse;
}

interface AssistantSafetyMetricsRow {
  date: string;
  totalRuns: number;
  blockedRuns: number;
  blockedRate: number;
  guardrails: { name: string; count: number }[];
  codes: { code: string; count: number }[];
}

interface AssistantQuotaSettingsResponse {
  source: AssistantSafetySettingsSource;
  enabled: boolean;
  submitLimitPerHour: number;
  maxInFlightPerOrg: number;
  monthlyTokenBudget: number;
  usage: {
    monthStart: string;
    totalTokens: number;
    inFlight: number;
  };
}

interface AssistantSafetySettingsFormValues {
  enabled: boolean;
  outputModerationEnabled: boolean;
}

interface AssistantQuotaSettingsFormValues {
  enabled: boolean;
  submitLimitPerHour: number;
  maxInFlightPerOrg: number;
  monthlyTokenBudget: number;
}

interface OpenAiKeysFormValues {
  openaiKeys: string;
}

const EMPTY_SETTINGS: AssistantSafetySettingsResponse = {
  source: "env",
  enabled: true,
  outputModerationEnabled: false,
  guardrails: []
};

const EMPTY_QUOTA: AssistantQuotaSettingsResponse = {
  source: "env",
  enabled: true,
  submitLimitPerHour: 30,
  maxInFlightPerOrg: 2,
  monthlyTokenBudget: 2_000_000,
  usage: {
    monthStart: new Date().toISOString(),
    totalTokens: 0,
    inFlight: 0
  }
};

const EMPTY_OPENAI_KEYS: OpenAiKeysSettingsResponse = {
  source: "none",
  keysCount: 0,
  hasKeys: false,
  keyFingerprints: [],
  internalTokenConfigured: false,
  appliedAt: null,
  appliedSource: null,
  appliedKeyFingerprints: [],
  restartRequired: false
};

const parseKeyLines = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(/[\n,]+/g)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  );

const MAX_OPENAI_KEYS = 100;
const OPENAI_MODERATION_FREE_CALLS_PER_DAY = 5000;

export function AssistantSafetySettingsPanel() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<AssistantSafetySettingsFormValues>();
  const [quotaForm] = Form.useForm<AssistantQuotaSettingsFormValues>();
  const [openaiForm] = Form.useForm<OpenAiKeysFormValues>();
  const [settings, setSettings] = useState<AssistantSafetySettingsResponse>(EMPTY_SETTINGS);
  const [quota, setQuota] = useState<AssistantQuotaSettingsResponse>(EMPTY_QUOTA);
  const [openaiKeys, setOpenaiKeys] = useState<OpenAiKeysSettingsResponse>(EMPTY_OPENAI_KEYS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingQuota, setSavingQuota] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resettingQuota, setResettingQuota] = useState(false);
  const [savingKeys, setSavingKeys] = useState(false);
  const [resettingKeys, setResettingKeys] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [keysErrorMessage, setKeysErrorMessage] = useState<string | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AssistantSafetyDiagnosticsResponse | null>(null);
  const [metricsDays, setMetricsDays] = useState<number>(14);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsRows, setMetricsRows] = useState<AssistantSafetyMetricsRow[]>([]);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<AssistantSafetySettingsResponse>("system-settings/assistant-safety");
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        enabled: data.enabled,
        outputModerationEnabled: data.outputModerationEnabled
      });

      const quotaResponse = await apiClient.get<AssistantQuotaSettingsResponse>(
        "system-settings/assistant-quota"
      );
      const quotaData = quotaResponse.data ?? EMPTY_QUOTA;
      setQuota(quotaData);
      quotaForm.setFieldsValue({
        enabled: quotaData.enabled,
        submitLimitPerHour: quotaData.submitLimitPerHour,
        maxInFlightPerOrg: quotaData.maxInFlightPerOrg,
        monthlyTokenBudget: quotaData.monthlyTokenBudget
      });

      const keysResponse = await apiClient.get<OpenAiKeysSettingsResponse>("system-settings/openai-keys");
      setOpenaiKeys(keysResponse.data ?? EMPTY_OPENAI_KEYS);
    } catch (error) {
      captureClientError("Failed to load assistant safety settings", error);
      setErrorMessage(
        t("settings.assistantSafety.errors.loadFailed")
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, quotaForm, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const response = await apiClient.get<AssistantSafetyMetricsRow[]>("system-settings/assistant-safety/metrics", {
        params: { days: metricsDays }
      });
      setMetricsRows(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      captureClientError("Failed to load assistant safety metrics", error);
      messageApi.error(
        extractApiError(error).message ??
          t("settings.assistantSafety.metrics.errors.loadFailed")
      );
    } finally {
      setMetricsLoading(false);
    }
  }, [apiClient, messageApi, metricsDays, t]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const runDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      const response = await apiClient.get<AssistantSafetyDiagnosticsResponse>("system-settings/assistant-safety/diagnostics");
      setDiagnostics(response.data ?? null);
      messageApi.success(
        t("settings.assistantSafety.diagnostics.messages.done")
      );
    } catch (error) {
      captureClientError("Failed to run assistant safety diagnostics", error);
      messageApi.error(
        extractApiError(error).message ??
          t("settings.assistantSafety.diagnostics.errors.failed")
      );
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const handleSave = async (values: AssistantSafetySettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.put<AssistantSafetySettingsResponse>("system-settings/assistant-safety", {
        enabled: Boolean(values.enabled),
        outputModerationEnabled: Boolean(values.outputModerationEnabled)
      });
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        enabled: data.enabled,
        outputModerationEnabled: data.outputModerationEnabled
      });
      messageApi.success(
        t("settings.assistantSafety.messages.saved")
      );
    } catch (error) {
      captureClientError("Failed to save assistant safety settings", error);
      messageApi.error(
        extractApiError(error).message ??
          t("settings.assistantSafety.errors.saveFailed")
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    Modal.confirm({
      title: t("settings.assistantSafety.reset.modal.title"),
      content: t("settings.assistantSafety.reset.modal.content"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.delete<AssistantSafetySettingsResponse>("system-settings/assistant-safety");
          const data = response.data ?? EMPTY_SETTINGS;
          setSettings(data);
          form.setFieldsValue({
            enabled: data.enabled,
            outputModerationEnabled: data.outputModerationEnabled
          });
          messageApi.success(
            t("settings.assistantSafety.reset.messages.done")
          );
        } catch (error) {
          captureClientError("Failed to reset assistant safety settings", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.reset.errors.failed")
          );
        } finally {
          setResetting(false);
        }
      }
    });
  };

  const applyQuota = (data: AssistantQuotaSettingsResponse) => {
    setQuota(data);
    quotaForm.setFieldsValue({
      enabled: data.enabled,
      submitLimitPerHour: data.submitLimitPerHour,
      maxInFlightPerOrg: data.maxInFlightPerOrg,
      monthlyTokenBudget: data.monthlyTokenBudget
    });
  };

  const handleSaveQuota = async (values: AssistantQuotaSettingsFormValues) => {
    setSavingQuota(true);
    try {
      const response = await apiClient.put<AssistantQuotaSettingsResponse>("system-settings/assistant-quota", {
        enabled: Boolean(values.enabled),
        submitLimitPerHour: Number(values.submitLimitPerHour),
        maxInFlightPerOrg: Number(values.maxInFlightPerOrg),
        monthlyTokenBudget: Number(values.monthlyTokenBudget)
      });
      applyQuota(response.data ?? EMPTY_QUOTA);
      messageApi.success(t("settings.assistantSafety.quota.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save assistant quota settings", error);
      messageApi.error(
        extractApiError(error).message ?? t("settings.assistantSafety.quota.errors.saveFailed")
      );
    } finally {
      setSavingQuota(false);
    }
  };

  const handleResetQuota = async () => {
    Modal.confirm({
      title: t("settings.assistantSafety.quota.reset.modal.title"),
      content: t("settings.assistantSafety.quota.reset.modal.content"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResettingQuota(true);
        try {
          const response = await apiClient.delete<AssistantQuotaSettingsResponse>(
            "system-settings/assistant-quota"
          );
          applyQuota(response.data ?? EMPTY_QUOTA);
          messageApi.success(t("settings.assistantSafety.quota.reset.messages.done"));
        } catch (error) {
          captureClientError("Failed to reset assistant quota settings", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.quota.reset.errors.failed")
          );
        } finally {
          setResettingQuota(false);
        }
      }
    });
  };

  const loadOpenAiKeys = useCallback(async () => {
    setKeysErrorMessage(null);
    try {
      const response = await apiClient.get<OpenAiKeysSettingsResponse>("system-settings/openai-keys");
      setOpenaiKeys(response.data ?? EMPTY_OPENAI_KEYS);
    } catch (error) {
      captureClientError("Failed to load OpenAI keys settings", error);
      setKeysErrorMessage(
        t("settings.assistantSafety.openaiKeys.errors.loadFailed")
      );
    }
  }, [apiClient, t]);

  const openaiKeysInputValue = Form.useWatch("openaiKeys", openaiForm) ?? "";
  const pendingKeys = useMemo(() => parseKeyLines(openaiKeysInputValue), [openaiKeysInputValue]);
  const remainingKeySlots = Math.max(0, MAX_OPENAI_KEYS - (openaiKeys.keysCount ?? 0));
  const willExceedLimit = openaiKeys.keysCount + pendingKeys.length > MAX_OPENAI_KEYS;
  const callsPerRun = settings.enabled ? (settings.outputModerationEnabled ? 2 : 1) : 0;
  const estimatedDailyQuota =
    openaiKeys.keysCount > 0 ? openaiKeys.keysCount * OPENAI_MODERATION_FREE_CALLS_PER_DAY : 0;
  const lbBuckets = useMemo(() => {
    const fingerprints = openaiKeys.keyFingerprints ?? [];
    if (fingerprints.length <= 1) {
      return [];
    }
    return fingerprints.map((fingerprint, index) => {
      const bucket = index + 1;
      const pre = bucket === 1 ? "openai-moderation-pre" : `openai-moderation-pre-${bucket}`;
      const post = bucket === 1 ? "openai-moderation-post" : `openai-moderation-post-${bucket}`;
      return {
        bucket,
        fingerprint,
        guardrailPre: pre,
        guardrailPost: settings.outputModerationEnabled ? post : "-"
      };
    });
  }, [openaiKeys.keyFingerprints, settings.outputModerationEnabled]);

  const handleAppendOpenAiKeys = async () => {
    const keys = pendingKeys;
    if (keys.length === 0) {
      messageApi.warning(
        t("settings.assistantSafety.openaiKeys.messages.emptyInput")
      );
      return;
    }
    if (willExceedLimit) {
      messageApi.warning(
        t("settings.assistantSafety.openaiKeys.messages.tooManyKeys", {
          max: MAX_OPENAI_KEYS
        })
      );
      return;
    }
    setSavingKeys(true);
    setKeysErrorMessage(null);
    try {
      const response = await apiClient.post<OpenAiKeysSettingsResponse>("system-settings/openai-keys", { keys });
      setOpenaiKeys(response.data ?? EMPTY_OPENAI_KEYS);
      openaiForm.resetFields();
      messageApi.success(
        t("settings.assistantSafety.openaiKeys.messages.appended")
      );
    } catch (error) {
      captureClientError("Failed to append OpenAI keys settings", error);
      messageApi.error(
        extractApiError(error).message ??
          t("settings.assistantSafety.openaiKeys.errors.appendFailed")
      );
    } finally {
      setSavingKeys(false);
    }
  };

  const handleReplaceOpenAiKeys = async () => {
    const keys = pendingKeys;
    if (keys.length === 0) {
      messageApi.warning(
        t("settings.assistantSafety.openaiKeys.messages.emptyInput")
      );
      return;
    }
    if (keys.length > MAX_OPENAI_KEYS) {
      messageApi.warning(
        t("settings.assistantSafety.openaiKeys.messages.tooManyKeys", {
          max: MAX_OPENAI_KEYS
        })
      );
      return;
    }
    Modal.confirm({
      title: t("settings.assistantSafety.openaiKeys.replace.modal.title"),
      content: t("settings.assistantSafety.openaiKeys.replace.modal.content"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setSavingKeys(true);
        setKeysErrorMessage(null);
        try {
          const response = await apiClient.put<OpenAiKeysSettingsResponse>("system-settings/openai-keys", { keys });
          setOpenaiKeys(response.data ?? EMPTY_OPENAI_KEYS);
          openaiForm.resetFields();
          messageApi.success(
            t("settings.assistantSafety.openaiKeys.messages.saved")
          );
        } catch (error) {
          captureClientError("Failed to save OpenAI keys settings", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.openaiKeys.errors.saveFailed")
          );
        } finally {
          setSavingKeys(false);
        }
      }
    });
  };

  const handleRemoveOpenAiKey = (fingerprint: string) => {
    Modal.confirm({
      title: t("settings.assistantSafety.openaiKeys.remove.modal.title"),
      content: t("settings.assistantSafety.openaiKeys.remove.modal.content"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setRemovingKey(fingerprint);
        setKeysErrorMessage(null);
        try {
          const response = await apiClient.delete<OpenAiKeysSettingsResponse>(`system-settings/openai-keys/key/${fingerprint}`);
          setOpenaiKeys(response.data ?? EMPTY_OPENAI_KEYS);
          messageApi.success(
            t("settings.assistantSafety.openaiKeys.remove.messages.done")
          );
        } catch (error) {
          captureClientError("Failed to remove OpenAI key", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.openaiKeys.remove.errors.failed")
          );
        } finally {
          setRemovingKey(null);
        }
      }
    });
  };

  const handleResetOpenAiKeys = async () => {
    Modal.confirm({
      title: t("settings.assistantSafety.openaiKeys.reset.modal.title"),
      content: t("settings.assistantSafety.openaiKeys.reset.modal.content"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResettingKeys(true);
        setKeysErrorMessage(null);
        try {
          const response = await apiClient.delete<OpenAiKeysSettingsResponse>("system-settings/openai-keys");
          setOpenaiKeys(response.data ?? EMPTY_OPENAI_KEYS);
          openaiForm.resetFields();
          messageApi.success(
            t("settings.assistantSafety.openaiKeys.reset.messages.done")
          );
        } catch (error) {
          captureClientError("Failed to reset OpenAI keys settings", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.openaiKeys.reset.errors.failed")
          );
        } finally {
          setResettingKeys(false);
        }
      }
    });
  };

  const sourceTag =
    settings.source === "db" ? (
      <Tag color="purple">{t("settings.assistantSafety.source.db")}</Tag>
    ) : (
      <Tag>{t("settings.assistantSafety.source.env")}</Tag>
    );

  const enabledTag = settings.enabled ? (
    <Tag color="green">{t("common.enabled")}</Tag>
  ) : (
    <Tag color="default">{t("common.disabled")}</Tag>
  );

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Card
        size="small"
        title={t("settings.assistantSafety.title")}
        extra={
          <Space wrap>
            {sourceTag}
            {enabledTag}
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ display: "flex" }}>
          <Alert
            type="info"
            showIcon
            message={t("settings.assistantSafety.hint.title")}
            description={
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t("settings.assistantSafety.hint.body")}
              </Typography.Paragraph>
            }
          />

          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("settings.assistantSafety.docs.scope")}
          </Typography.Paragraph>

          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("settings.assistantSafety.docs.setupTitle")}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
            {t("settings.assistantSafety.docs.setupBody")}
          </Typography.Paragraph>

          <Space wrap>
            <Button onClick={() => void runDiagnostics()} loading={diagnosticsLoading}>
              {t("settings.assistantSafety.diagnostics.actions.run")}
            </Button>
            {diagnostics?.checkedAt ? (
              <Typography.Text type="secondary">
                {t("settings.assistantSafety.diagnostics.lastChecked", {
                  time: new Date(diagnostics.checkedAt).toLocaleString()
                })}
              </Typography.Text>
            ) : null}
          </Space>

          {diagnostics ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item
                label={t("settings.assistantSafety.diagnostics.fields.litellmBase")}
              >
                {diagnostics.litellm.apiBase}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("settings.assistantSafety.diagnostics.fields.litellmLiveliness")}
              >
                {diagnostics.litellm.liveliness.ok ? (
                  <Tag color="green">{t("common.ok")}</Tag>
                ) : (
                  <Tag color="red">{t("common.failed")}</Tag>
                )}
                {diagnostics.litellm.liveliness.status ? ` (HTTP ${diagnostics.litellm.liveliness.status})` : ""}
                {diagnostics.litellm.liveliness.error ? `: ${diagnostics.litellm.liveliness.error}` : ""}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("settings.assistantSafety.diagnostics.fields.litellmModels")}
              >
                {diagnostics.litellm.models.ok ? (
                  <Tag color="green">{t("common.ok")}</Tag>
                ) : (
                  <Tag color="red">{t("common.failed")}</Tag>
                )}
                {diagnostics.litellm.models.status ? ` (HTTP ${diagnostics.litellm.models.status})` : ""}
                {typeof diagnostics.litellm.models.count === "number" ? `, ${diagnostics.litellm.models.count} models` : ""}
                {diagnostics.litellm.models.error ? `: ${diagnostics.litellm.models.error}` : ""}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("settings.assistantSafety.diagnostics.fields.litellmGuardrailsList")}
              >
                <Space direction="vertical" size={4} style={{ display: "flex" }}>
                  <Space wrap>
                    {diagnostics.litellm.guardrails.ok ? (
                      <Tag color="green">{t("common.ok")}</Tag>
                    ) : (
                      <Tag color="red">{t("common.failed")}</Tag>
                    )}
                    {diagnostics.litellm.guardrails.status ? (
                      <Typography.Text type="secondary">{`HTTP ${diagnostics.litellm.guardrails.status}`}</Typography.Text>
                    ) : null}
                    {typeof diagnostics.litellm.guardrails.count === "number" ? (
                      <Typography.Text type="secondary">
                        {t("settings.assistantSafety.diagnostics.guardrails.count", {
                          count: diagnostics.litellm.guardrails.count
                        })}
                      </Typography.Text>
                    ) : null}
                    {diagnostics.litellm.guardrails.ok && (diagnostics.litellm.guardrails.expected ?? []).length > 0 ? (
                      diagnostics.litellm.guardrails.missing.length === 0 ? (
                        <Tag color="green">
                          {t("settings.assistantSafety.diagnostics.guardrails.allPresent")}
                        </Tag>
                      ) : (
                        <Tag color="orange">
                          {t("settings.assistantSafety.diagnostics.guardrails.missingCount", {
                            count: diagnostics.litellm.guardrails.missing.length
                          })}
                        </Tag>
                      )
                    ) : null}
                    {diagnostics.litellm.guardrails.error ? (
                      <Typography.Text type="secondary">{diagnostics.litellm.guardrails.error}</Typography.Text>
                    ) : null}
                  </Space>

                  {diagnostics.litellm.guardrails.ok && diagnostics.litellm.guardrails.missing.length > 0 ? (
                    <Space wrap>
                      {diagnostics.litellm.guardrails.missing.map((name) => (
                        <Tag key={name} color="orange">
                          {name}
                        </Tag>
                      ))}
                    </Space>
                  ) : null}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item
                label={t("settings.assistantSafety.diagnostics.fields.guardrails")}
              >
                {(diagnostics.assistantSafety.guardrails ?? []).length > 0 ? (
                  <Space wrap>
                    {diagnostics.assistantSafety.guardrails.map((name) => (
                      <Tag key={name}>{name}</Tag>
                    ))}
                  </Space>
                ) : (
                  "-"
                )}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("settings.assistantSafety.diagnostics.fields.openaiKeys")}
              >
                <Space wrap>
                  <Tag>{t("settings.assistantSafety.openaiKeys.status.count", { count: diagnostics.openaiKeys.keysCount })}</Tag>
                  {diagnostics.openaiKeys.restartRequired ? (
                    <Tag color="orange">
                      {t("settings.assistantSafety.openaiKeys.status.restartRequired")}
                    </Tag>
                  ) : diagnostics.openaiKeys.appliedAt ? (
                    <Tag color="green">
                      {t("settings.assistantSafety.openaiKeys.status.applied")}
                    </Tag>
                  ) : (
                    <Tag color="default">
                      {t("settings.assistantSafety.openaiKeys.status.notApplied")}
                    </Tag>
                  )}
                </Space>
              </Descriptions.Item>
            </Descriptions>
          ) : null}

          <Divider style={{ margin: "8px 0" }} />

          <Space wrap align="center">
            <Typography.Text strong>
              {t("settings.assistantSafety.metrics.title")}
            </Typography.Text>
            <Select
              style={{ width: 140 }}
              value={metricsDays}
              onChange={(value) => setMetricsDays(Number(value))}
              options={[
                { value: 7, label: t("settings.assistantSafety.metrics.days", { days: 7 }) },
                { value: 14, label: t("settings.assistantSafety.metrics.days", { days: 14 }) },
                { value: 30, label: t("settings.assistantSafety.metrics.days", { days: 30 }) }
              ]}
            />
            <Button onClick={() => void loadMetrics()} loading={metricsLoading}>
              {t("common.refresh")}
            </Button>
          </Space>

          <Table<AssistantSafetyMetricsRow>
            size="small"
            rowKey="date"
            loading={metricsLoading}
            dataSource={metricsRows}
            pagination={false}
            columns={[
              {
                title: t("settings.assistantSafety.metrics.columns.date"),
                dataIndex: "date",
                key: "date",
                width: 110
              },
              {
                title: t("settings.assistantSafety.metrics.columns.total"),
                dataIndex: "totalRuns",
                key: "totalRuns",
                width: 90
              },
              {
                title: t("settings.assistantSafety.metrics.columns.blocked"),
                dataIndex: "blockedRuns",
                key: "blockedRuns",
                width: 100,
                render: (value: number) => (
                  <span style={{ color: value > 0 ? token.colorError : undefined }}>
                    {value}
                  </span>
                )
              },
              {
                title: t("settings.assistantSafety.metrics.columns.rate"),
                dataIndex: "blockedRate",
                key: "blockedRate",
                width: 120,
                render: (value: number) => `${(Number(value) * 100).toFixed(1)}%`
              },
              {
                title: t("settings.assistantSafety.metrics.columns.moderationCalls"),
                key: "moderationCalls",
                width: 170,
                render: (_value: unknown, row: AssistantSafetyMetricsRow) => row.totalRuns * callsPerRun
              },
              {
                title: t("settings.assistantSafety.metrics.columns.guardrails"),
                dataIndex: "guardrails",
                key: "guardrails",
                render: (value: AssistantSafetyMetricsRow["guardrails"]) => (
                  <Space wrap>
                    {(value ?? []).map((entry) => (
                      <Tag key={entry.name} color="geekblue">
                        {entry.name} ({entry.count})
                      </Tag>
                    ))}
                  </Space>
                )
              },
              {
                title: t("settings.assistantSafety.metrics.columns.codes"),
                dataIndex: "codes",
                key: "codes",
                render: (value: AssistantSafetyMetricsRow["codes"]) => (
                  <Space wrap>
                    {(value ?? []).map((entry) => (
                      <Tag key={entry.code} color="default">
                        {entry.code} ({entry.count})
                      </Tag>
                    ))}
                  </Space>
                )
              }
            ]}
          />

          <Divider style={{ margin: "8px 0" }} />

          <Space direction="vertical" size={8}>
            <Space wrap>
              <Typography.Text strong>
                {t("settings.assistantSafety.openaiKeys.title")}
              </Typography.Text>
              {openaiKeys.hasKeys ? (
                <Tag color="green">
                  {t("settings.assistantSafety.openaiKeys.status.configured")}
                </Tag>
              ) : (
                <Tag color="default">
                  {t("settings.assistantSafety.openaiKeys.status.empty")}
                </Tag>
              )}
              <Tag>
                {t("settings.assistantSafety.openaiKeys.status.count", {
                  count: openaiKeys.keysCount
                })}
              </Tag>
              <Tag>
                {t("settings.assistantSafety.openaiKeys.status.remaining", {
                  count: remainingKeySlots
                })}
              </Tag>
              {openaiKeys.restartRequired ? (
                <Tag color="orange">
                  {t("settings.assistantSafety.openaiKeys.status.restartRequired")}
                </Tag>
              ) : openaiKeys.hasKeys ? (
                openaiKeys.appliedAt ? (
                  <Tag color="green">
                    {t("settings.assistantSafety.openaiKeys.status.applied")}
                  </Tag>
                ) : (
                  <Tag color="orange">
                    {t("settings.assistantSafety.openaiKeys.status.notApplied")}
                  </Tag>
                )
              ) : null}
              {openaiKeys.internalTokenConfigured ? (
                <Tag color="green">
                  {t("settings.assistantSafety.openaiKeys.status.tokenOk")}
                </Tag>
              ) : (
                <Tag color="red">
                  {t("settings.assistantSafety.openaiKeys.status.tokenMissing")}
                </Tag>
              )}
              {openaiKeys.keysCount > 1 ? (
                <Tag color="geekblue">
                  {t("settings.assistantSafety.openaiKeys.status.lbOn")}
                </Tag>
              ) : (
                <Tag>
                  {t("settings.assistantSafety.openaiKeys.status.lbOff")}
                </Tag>
              )}
            </Space>

            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("settings.assistantSafety.openaiKeys.description")}
            </Typography.Paragraph>

            {openaiKeys.keysCount > 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t("settings.assistantSafety.openaiKeys.quotaHint", {
                  quota: estimatedDailyQuota,
                  perKey: OPENAI_MODERATION_FREE_CALLS_PER_DAY,
                  callsPerRun
                })}
              </Typography.Paragraph>
            ) : null}

            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("settings.assistantSafety.openaiKeys.compliance")}
            </Typography.Paragraph>

            {!openaiKeys.internalTokenConfigured ? (
              <Alert
                type="warning"
                showIcon
                message={t("settings.assistantSafety.openaiKeys.warnings.tokenMissing")}
              />
            ) : null}
            {openaiKeys.restartRequired ? (
              <Alert
                type="warning"
                showIcon
                message={t("settings.assistantSafety.openaiKeys.warnings.restartRequired")}
                description={
                  <Typography.Paragraph
                    style={{ marginBottom: 0 }}
                    copyable={{
                      text: "docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml restart litellm"
                    }}
                  >
                    <Typography.Text code>
                      docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml restart litellm
                    </Typography.Text>
                  </Typography.Paragraph>
                }
              />
            ) : null}

            {keysErrorMessage ? <Alert type="error" showIcon message={keysErrorMessage} /> : null}

            <Form form={openaiForm} layout="vertical" initialValues={{ openaiKeys: "" }}>
              <Form.Item
                name="openaiKeys"
                label={t("settings.assistantSafety.openaiKeys.fields.keys")}
                extra={t("settings.assistantSafety.openaiKeys.fields.keysHint")}
              >
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  placeholder={t("settings.assistantSafety.openaiKeys.fields.keysPlaceholder")}
                />
              </Form.Item>

              <Typography.Text type="secondary">
                {t("settings.assistantSafety.openaiKeys.preview", {
                  count: pendingKeys.length
                })}
              </Typography.Text>
              {willExceedLimit ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t("settings.assistantSafety.openaiKeys.warnings.tooManyKeys", {
                    max: MAX_OPENAI_KEYS
                  })}
                />
              ) : null}

              <Space wrap>
                <Button type="primary" onClick={() => void handleAppendOpenAiKeys()} loading={savingKeys}>
                  {t("settings.assistantSafety.openaiKeys.actions.append")}
                </Button>
                <Button danger onClick={() => void handleReplaceOpenAiKeys()} loading={savingKeys}>
                  {t("settings.assistantSafety.openaiKeys.actions.replace")}
                </Button>
                <Button onClick={() => void loadOpenAiKeys()} disabled={savingKeys || resettingKeys}>
                  {t("common.refresh")}
                </Button>
                <Button danger onClick={handleResetOpenAiKeys} loading={resettingKeys} disabled={savingKeys}>
                  {t("settings.assistantSafety.openaiKeys.reset.action")}
                </Button>
              </Space>
            </Form>

            <Divider style={{ margin: "8px 0" }} />

            <Typography.Text type="secondary">
              {t("settings.assistantSafety.openaiKeys.list.title")}
            </Typography.Text>

            {openaiKeys.keyFingerprints.length > 0 ? (
              <Space wrap>
                {openaiKeys.keyFingerprints.map((fingerprint) => (
                  <Tag
                    key={fingerprint}
                    closable={!savingKeys && !resettingKeys && !removingKey}
                    onClose={(e) => {
                      e.preventDefault();
                      handleRemoveOpenAiKey(fingerprint);
                    }}
                  >
                    {fingerprint.slice(0, 8)}…{fingerprint.slice(-4)}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {t("settings.assistantSafety.openaiKeys.list.empty")}
              </Typography.Text>
            )}

            {lbBuckets.length > 0 ? (
              <>
                <Divider style={{ margin: "8px 0" }} />

                <Typography.Text type="secondary">
                  {t("settings.assistantSafety.openaiKeys.buckets.title")}
                </Typography.Text>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  {t("settings.assistantSafety.openaiKeys.buckets.hint")}
                </Typography.Paragraph>
                <Table
                  size="small"
                  rowKey="bucket"
                  pagination={false}
                  dataSource={lbBuckets}
                  columns={[
                    {
                      title: t("settings.assistantSafety.openaiKeys.buckets.columns.bucket"),
                      dataIndex: "bucket",
                      key: "bucket",
                      width: 90
                    },
                    {
                      title: t("settings.assistantSafety.openaiKeys.buckets.columns.fingerprint"),
                      dataIndex: "fingerprint",
                      key: "fingerprint",
                      render: (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`
                    },
                    {
                      title: t("settings.assistantSafety.openaiKeys.buckets.columns.pre"),
                      dataIndex: "guardrailPre",
                      key: "guardrailPre",
                      render: (value: string) => <Typography.Text code>{value}</Typography.Text>
                    },
                    {
                      title: t("settings.assistantSafety.openaiKeys.buckets.columns.post"),
                      dataIndex: "guardrailPost",
                      key: "guardrailPost",
                      render: (value: string) => <Typography.Text code>{value}</Typography.Text>
                    }
                  ]}
                />
              </>
            ) : null}

            <Divider style={{ margin: "8px 0" }} />

            <Typography.Text type="secondary">
              {t("settings.assistantSafety.openaiKeys.applied.title")}
              {openaiKeys.appliedAt ? (
                <Typography.Text type="secondary">
                  {" "}
                  ({t("settings.assistantSafety.openaiKeys.applied.at")}{" "}
                  {new Date(openaiKeys.appliedAt).toLocaleString()})
                </Typography.Text>
              ) : null}
            </Typography.Text>

            {openaiKeys.appliedSource ? (
              <Typography.Text type="secondary">
                {t("settings.assistantSafety.openaiKeys.applied.source")}:{" "}
                <Tag>{openaiKeys.appliedSource}</Tag>
              </Typography.Text>
            ) : null}

            {openaiKeys.appliedKeyFingerprints.length > 0 ? (
              <Space wrap>
                {openaiKeys.appliedKeyFingerprints.map((fingerprint) => (
                  <Tag key={fingerprint} color="blue">
                    {fingerprint.slice(0, 8)}…{fingerprint.slice(-4)}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {t("settings.assistantSafety.openaiKeys.applied.empty")}
              </Typography.Text>
            )}
          </Space>

          <Typography.Text type="secondary">
            {t("settings.assistantSafety.guardrails.label")}:
          </Typography.Text>
          <Space wrap>
            {(settings.guardrails ?? []).length > 0 ? (
              settings.guardrails.map((name) => (
                <Tag key={name} color="geekblue">
                  {name}
                </Tag>
              ))
            ) : (
              <Typography.Text type="secondary">-</Typography.Text>
            )}
          </Space>

          {errorMessage ? <Alert type="error" showIcon message={errorMessage} /> : null}

          <Form form={form} layout="vertical" onFinish={handleSave}>
            <Form.Item
              label={t("settings.assistantSafety.fields.enabled")}
              name="enabled"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>

            <Form.Item
              label={t("settings.assistantSafety.fields.outputModerationEnabled")}
              name="outputModerationEnabled"
              valuePropName="checked"
              extra={t("settings.assistantSafety.fields.outputModerationHint")}
            >
              <Switch />
            </Form.Item>

            <Space wrap>
              <Button type="primary" htmlType="submit" loading={saving}>
                {t("common.save")}
              </Button>
              <Button onClick={() => void loadSettings()} disabled={saving || resetting}>
                {t("common.refresh")}
              </Button>
              <Button danger onClick={handleReset} loading={resetting} disabled={saving}>
                {t("settings.assistantSafety.reset.action")}
              </Button>
            </Space>
          </Form>
        </Space>
      </Card>

      <Card
        size="small"
        title={t("settings.assistantSafety.quota.title")}
        extra={
          <Tag color={quota.enabled ? "green" : "default"}>
            {quota.enabled ? t("common.enabled") : t("common.disabled")}
          </Tag>
        }
        style={{ marginTop: 16 }}
      >
        <Space direction="vertical" size="middle" style={{ display: "flex" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("settings.assistantSafety.quota.description")}
          </Typography.Paragraph>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label={t("settings.assistantSafety.quota.usage.monthStart")}>
              {new Date(quota.usage.monthStart).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label={t("settings.assistantSafety.quota.usage.totalTokens")}>
              {quota.usage.totalTokens.toLocaleString()}
              {quota.monthlyTokenBudget > 0
                ? ` / ${quota.monthlyTokenBudget.toLocaleString()}`
                : ` (${t("settings.assistantSafety.quota.usage.unlimited")})`}
            </Descriptions.Item>
            <Descriptions.Item label={t("settings.assistantSafety.quota.usage.inFlight")}>
              {quota.usage.inFlight.toLocaleString()}
              {quota.maxInFlightPerOrg > 0
                ? ` / ${quota.maxInFlightPerOrg.toLocaleString()}`
                : ` (${t("settings.assistantSafety.quota.usage.unlimited")})`}
            </Descriptions.Item>
          </Descriptions>
          <Form form={quotaForm} layout="vertical" onFinish={handleSaveQuota}>
            <Form.Item
              label={t("settings.assistantSafety.quota.fields.enabled")}
              name="enabled"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label={t("settings.assistantSafety.quota.fields.submitLimitPerHour")}
              name="submitLimitPerHour"
              extra={t("settings.assistantSafety.quota.fields.zeroUnlimited")}
            >
              <InputNumber min={0} max={10000} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.assistantSafety.quota.fields.maxInFlightPerOrg")}
              name="maxInFlightPerOrg"
              extra={t("settings.assistantSafety.quota.fields.zeroUnlimited")}
            >
              <InputNumber min={0} max={100} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.assistantSafety.quota.fields.monthlyTokenBudget")}
              name="monthlyTokenBudget"
              extra={t("settings.assistantSafety.quota.fields.zeroUnlimited")}
            >
              <InputNumber min={0} max={1_000_000_000_000} style={{ width: "100%" }} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={savingQuota}>
                {t("common.save")}
              </Button>
              <Button
                onClick={() => void loadSettings()}
                disabled={savingQuota || resettingQuota}
              >
                {t("common.refresh")}
              </Button>
              <Button
                danger
                onClick={() => void handleResetQuota()}
                loading={resettingQuota}
                disabled={savingQuota}
              >
                {t("settings.assistantSafety.quota.reset.action")}
              </Button>
            </Space>
          </Form>
        </Space>
      </Card>
    </>
  );
}
