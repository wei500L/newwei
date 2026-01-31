"use client";

import { Alert, Button, Card, Divider, Form, Input, Modal, Space, Spin, Switch, Tag, Typography, message } from "antd";
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
}

interface AssistantSafetySettingsFormValues {
  enabled: boolean;
  outputModerationEnabled: boolean;
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

const EMPTY_OPENAI_KEYS: OpenAiKeysSettingsResponse = {
  source: "none",
  keysCount: 0,
  hasKeys: false,
  keyFingerprints: [],
  internalTokenConfigured: false
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

export function AssistantSafetySettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<AssistantSafetySettingsFormValues>();
  const [openaiForm] = Form.useForm<OpenAiKeysFormValues>();
  const [settings, setSettings] = useState<AssistantSafetySettingsResponse>(EMPTY_SETTINGS);
  const [openaiKeys, setOpenaiKeys] = useState<OpenAiKeysSettingsResponse>(EMPTY_OPENAI_KEYS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [savingKeys, setSavingKeys] = useState(false);
  const [resettingKeys, setResettingKeys] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [keysErrorMessage, setKeysErrorMessage] = useState<string | null>(null);

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

      const keysResponse = await apiClient.get<OpenAiKeysSettingsResponse>("system-settings/openai-keys");
      setOpenaiKeys(keysResponse.data ?? EMPTY_OPENAI_KEYS);
    } catch (error) {
      captureClientError("Failed to load assistant safety settings", error);
      setErrorMessage(
        t("settings.assistantSafety.errors.loadFailed", {
          defaultValue: "Failed to load assistant safety settings."
        })
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

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
        t("settings.assistantSafety.messages.saved", { defaultValue: "Saved." })
      );
    } catch (error) {
      captureClientError("Failed to save assistant safety settings", error);
      messageApi.error(
        extractApiError(error).message ??
          t("settings.assistantSafety.errors.saveFailed", { defaultValue: "Save failed." })
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    Modal.confirm({
      title: t("settings.assistantSafety.reset.modal.title", { defaultValue: "Reset to env defaults?" }),
      content: t("settings.assistantSafety.reset.modal.content", {
        defaultValue: "This removes the database override and falls back to the env configuration."
      }),
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
            t("settings.assistantSafety.reset.messages.done", { defaultValue: "Reset." })
          );
        } catch (error) {
          captureClientError("Failed to reset assistant safety settings", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.reset.errors.failed", { defaultValue: "Reset failed." })
          );
        } finally {
          setResetting(false);
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
        t("settings.assistantSafety.openaiKeys.errors.loadFailed", {
          defaultValue: "Failed to load OpenAI keys configuration."
        })
      );
    }
  }, [apiClient, t]);

  const openaiKeysInputValue = Form.useWatch("openaiKeys", openaiForm) ?? "";
  const pendingKeys = useMemo(() => parseKeyLines(openaiKeysInputValue), [openaiKeysInputValue]);

  const handleAppendOpenAiKeys = async () => {
    const keys = pendingKeys;
    if (keys.length === 0) {
      messageApi.warning(
        t("settings.assistantSafety.openaiKeys.messages.emptyInput", {
          defaultValue: "Please paste at least one key."
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
        t("settings.assistantSafety.openaiKeys.messages.appended", { defaultValue: "Added." })
      );
    } catch (error) {
      captureClientError("Failed to append OpenAI keys settings", error);
      messageApi.error(
        extractApiError(error).message ??
          t("settings.assistantSafety.openaiKeys.errors.appendFailed", { defaultValue: "Add failed." })
      );
    } finally {
      setSavingKeys(false);
    }
  };

  const handleReplaceOpenAiKeys = async () => {
    const keys = pendingKeys;
    if (keys.length === 0) {
      messageApi.warning(
        t("settings.assistantSafety.openaiKeys.messages.emptyInput", {
          defaultValue: "Please paste at least one key."
        })
      );
      return;
    }
    Modal.confirm({
      title: t("settings.assistantSafety.openaiKeys.replace.modal.title", {
        defaultValue: "Replace key list?"
      }),
      content: t("settings.assistantSafety.openaiKeys.replace.modal.content", {
        defaultValue: "This will overwrite the stored key list."
      }),
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
            t("settings.assistantSafety.openaiKeys.messages.saved", { defaultValue: "Saved." })
          );
        } catch (error) {
          captureClientError("Failed to save OpenAI keys settings", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.openaiKeys.errors.saveFailed", { defaultValue: "Save failed." })
          );
        } finally {
          setSavingKeys(false);
        }
      }
    });
  };

  const handleRemoveOpenAiKey = (fingerprint: string) => {
    Modal.confirm({
      title: t("settings.assistantSafety.openaiKeys.remove.modal.title", {
        defaultValue: "Remove this key?"
      }),
      content: t("settings.assistantSafety.openaiKeys.remove.modal.content", {
        defaultValue: "This removes the selected key from the database."
      }),
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
            t("settings.assistantSafety.openaiKeys.remove.messages.done", { defaultValue: "Removed." })
          );
        } catch (error) {
          captureClientError("Failed to remove OpenAI key", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.openaiKeys.remove.errors.failed", { defaultValue: "Remove failed." })
          );
        } finally {
          setRemovingKey(null);
        }
      }
    });
  };

  const handleResetOpenAiKeys = async () => {
    Modal.confirm({
      title: t("settings.assistantSafety.openaiKeys.reset.modal.title", {
        defaultValue: "Clear OpenAI keys?"
      }),
      content: t("settings.assistantSafety.openaiKeys.reset.modal.content", {
        defaultValue: "This removes stored OpenAI API keys from the database."
      }),
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
            t("settings.assistantSafety.openaiKeys.reset.messages.done", { defaultValue: "Cleared." })
          );
        } catch (error) {
          captureClientError("Failed to reset OpenAI keys settings", error);
          messageApi.error(
            extractApiError(error).message ??
              t("settings.assistantSafety.openaiKeys.reset.errors.failed", { defaultValue: "Clear failed." })
          );
        } finally {
          setResettingKeys(false);
        }
      }
    });
  };

  const sourceTag =
    settings.source === "db" ? (
      <Tag color="purple">{t("settings.assistantSafety.source.db", { defaultValue: "DB override" })}</Tag>
    ) : (
      <Tag>{t("settings.assistantSafety.source.env", { defaultValue: "Env" })}</Tag>
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
        title={t("settings.assistantSafety.title", { defaultValue: "Assistant Safety" })}
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
            message={t("settings.assistantSafety.hint.title", {
              defaultValue: "Guardrails are enforced via LiteLLM Proxy"
            })}
            description={
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t("settings.assistantSafety.hint.body", {
                  defaultValue:
                    "Enable/disable moderation guardrails for the AI assistant. Make sure the LiteLLM Proxy config defines the required guardrails."
                })}
              </Typography.Paragraph>
            }
          />

          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("settings.assistantSafety.docs.scope", {
              defaultValue:
                "This setting ONLY affects the AI Assistant page (/assistant). Other features using LiteLlmService (news pipeline / analysis / monitoring) do not pass guardrails, so they are NOT moderated by this switch."
            })}
          </Typography.Paragraph>

          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("settings.assistantSafety.docs.setupTitle", { defaultValue: "Setup checklist:" })}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
            {t("settings.assistantSafety.docs.setupBody", {
              defaultValue:
                "1) Configure LiteLLM Proxy guardrails in infra/litellm/litellm-config.yaml (openai-moderation-pre / openai-moderation-post).\n2) In this panel, save OpenAI API keys (stored in MySQL).\n3) Set LITELLM_CONFIG_INTERNAL_TOKEN in both API and litellm env (root .env or infra/docker/.env) so litellm can fetch keys on startup, then restart the litellm service.\n4) (Optional) In this panel, enable output moderation if you also want to moderate assistant responses (may impact streaming)."
            })}
          </Typography.Paragraph>

          <Divider style={{ margin: "8px 0" }} />

          <Space direction="vertical" size={8}>
            <Space wrap>
              <Typography.Text strong>
                {t("settings.assistantSafety.openaiKeys.title", {
                  defaultValue: "OpenAI keys (LiteLLM upstream)"
                })}
              </Typography.Text>
              {openaiKeys.hasKeys ? (
                <Tag color="green">
                  {t("settings.assistantSafety.openaiKeys.status.configured", {
                    defaultValue: "Configured"
                  })}
                </Tag>
              ) : (
                <Tag color="default">
                  {t("settings.assistantSafety.openaiKeys.status.empty", {
                    defaultValue: "Not configured"
                  })}
                </Tag>
              )}
              <Tag>
                {t("settings.assistantSafety.openaiKeys.status.count", {
                  defaultValue: "{{count}} keys",
                  count: openaiKeys.keysCount
                })}
              </Tag>
              {openaiKeys.internalTokenConfigured ? (
                <Tag color="green">
                  {t("settings.assistantSafety.openaiKeys.status.tokenOk", {
                    defaultValue: "Internal token configured"
                  })}
                </Tag>
              ) : (
                <Tag color="red">
                  {t("settings.assistantSafety.openaiKeys.status.tokenMissing", {
                    defaultValue: "Missing internal token"
                  })}
                </Tag>
              )}
              {openaiKeys.keysCount > 1 ? (
                <Tag color="geekblue">
                  {t("settings.assistantSafety.openaiKeys.status.lbOn", { defaultValue: "LB on" })}
                </Tag>
              ) : (
                <Tag>
                  {t("settings.assistantSafety.openaiKeys.status.lbOff", { defaultValue: "LB off" })}
                </Tag>
              )}
            </Space>

            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("settings.assistantSafety.openaiKeys.description", {
                defaultValue:
                  "These keys are stored in MySQL and fetched by LiteLLM Proxy at startup (requires LITELLM_CONFIG_INTERNAL_TOKEN), used for OpenAI model calls and omni-moderation guardrails. If you provide multiple keys, assistant moderation calls are spread across them. Restart the litellm service after updating."
              })}
            </Typography.Paragraph>

            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("settings.assistantSafety.openaiKeys.compliance", {
                defaultValue:
                  "Please ensure your usage complies with OpenAI's terms. Do not use multiple keys to bypass provider limits or billing policies."
              })}
            </Typography.Paragraph>

            {!openaiKeys.internalTokenConfigured ? (
              <Alert
                type="warning"
                showIcon
                message={t("settings.assistantSafety.openaiKeys.warnings.tokenMissing", {
                  defaultValue:
                    "LITELLM_CONFIG_INTERNAL_TOKEN is not configured. LiteLLM cannot fetch keys from MySQL at startup."
                })}
              />
            ) : null}

            {keysErrorMessage ? <Alert type="error" showIcon message={keysErrorMessage} /> : null}

            <Form form={openaiForm} layout="vertical" initialValues={{ openaiKeys: "" }}>
              <Form.Item
                name="openaiKeys"
                label={t("settings.assistantSafety.openaiKeys.fields.keys", { defaultValue: "OpenAI API keys" })}
                extra={t("settings.assistantSafety.openaiKeys.fields.keysHint", {
                  defaultValue:
                    "Comma or newline separated. Add (append) will merge/dedupe; Save (replace) will overwrite the stored list."
                })}
              >
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  placeholder={t("settings.assistantSafety.openaiKeys.fields.keysPlaceholder", {
                    defaultValue: "sk-...\nsk-...\n..."
                  })}
                />
              </Form.Item>

              <Typography.Text type="secondary">
                {t("settings.assistantSafety.openaiKeys.preview", {
                  defaultValue: "Detected {{count}} key(s) in input.",
                  count: pendingKeys.length
                })}
              </Typography.Text>

              <Space wrap>
                <Button type="primary" onClick={() => void handleAppendOpenAiKeys()} loading={savingKeys}>
                  {t("settings.assistantSafety.openaiKeys.actions.append", { defaultValue: "Add (append)" })}
                </Button>
                <Button danger onClick={() => void handleReplaceOpenAiKeys()} loading={savingKeys}>
                  {t("settings.assistantSafety.openaiKeys.actions.replace", { defaultValue: "Save (replace)" })}
                </Button>
                <Button onClick={() => void loadOpenAiKeys()} disabled={savingKeys || resettingKeys}>
                  {t("common.refresh", { defaultValue: "Refresh" })}
                </Button>
                <Button danger onClick={handleResetOpenAiKeys} loading={resettingKeys} disabled={savingKeys}>
                  {t("settings.assistantSafety.openaiKeys.reset.action", { defaultValue: "Clear keys" })}
                </Button>
              </Space>
            </Form>

            <Divider style={{ margin: "8px 0" }} />

            <Typography.Text type="secondary">
              {t("settings.assistantSafety.openaiKeys.list.title", { defaultValue: "Stored key fingerprints" })}
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
                {t("settings.assistantSafety.openaiKeys.list.empty", { defaultValue: "No keys stored." })}
              </Typography.Text>
            )}
          </Space>

          <Typography.Text type="secondary">
            {t("settings.assistantSafety.guardrails.label", { defaultValue: "Effective guardrails" })}:
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
              label={t("settings.assistantSafety.fields.enabled", { defaultValue: "Enable guardrails" })}
              name="enabled"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>

            <Form.Item
              label={t("settings.assistantSafety.fields.outputModerationEnabled", {
                defaultValue: "Enable output moderation"
              })}
              name="outputModerationEnabled"
              valuePropName="checked"
              extra={t("settings.assistantSafety.fields.outputModerationHint", {
                defaultValue: "May buffer streaming responses depending on upstream guardrail behavior."
              })}
            >
              <Switch />
            </Form.Item>

            <Space wrap>
              <Button type="primary" htmlType="submit" loading={saving}>
                {t("common.save")}
              </Button>
              <Button onClick={() => void loadSettings()} disabled={saving || resetting}>
                {t("common.refresh", { defaultValue: "Refresh" })}
              </Button>
              <Button danger onClick={handleReset} loading={resetting} disabled={saving}>
                {t("settings.assistantSafety.reset.action", { defaultValue: "Reset to env" })}
              </Button>
            </Space>
          </Form>
        </Space>
      </Card>
    </>
  );
}
