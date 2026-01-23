"use client";

import {
  Alert,
  Button,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

interface LlmGatewayProfile {
  id: string;
  name: string;
  apiBase: string;
  model: string;
  embeddingModel?: string | null;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  fallbackModels: string[];
  requestsPerMinute: number;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LlmGatewaySettingsResponse {
  activeId: string | null;
  profiles: LlmGatewayProfile[];
}

interface LlmGatewayTestResponse {
  apiBase: string;
  completion: {
    model: string;
    content: string | null;
    finishReason?: string;
    latencyMs: number;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    costUsd?: number;
    keySpendUsd?: number;
  };
  embedding?: {
    model: string;
    dimensions: number;
    latencyMs: number;
    usage?: { prompt_tokens: number; total_tokens: number };
    costUsd?: number;
    keySpendUsd?: number;
  };
  embeddingError?: {
    message: string;
    status?: number;
  };
}

interface LlmGatewayModelsResponse {
  apiBase: string;
  models: string[];
}

interface LlmGatewayTestFormValues {
  model?: string;
  prompt?: string;
  includeEmbeddings: boolean;
  embeddingModel?: string;
  embeddingInput?: string;
}

interface LlmGatewayFormValues {
  preset?: string;
  name: string;
  apiBase: string;
  apiKey?: string;
  model: string;
  embeddingModel?: string;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  requestsPerMinute: number;
  fallbackModels?: string;
  clearApiKey?: boolean;
  enabled: boolean;
}

const EMPTY_SETTINGS: LlmGatewaySettingsResponse = { activeId: null, profiles: [] };
const DRAFT_CREATE_KEY = "__draft_create__";
const DRAFT_EDIT_KEY = "__draft_edit__";

function toFallbackModels(input: string | undefined) {
  if (!input) {
    return undefined;
  }
  const models = input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(models));
}

function toFallbackModelsText(models: string[]) {
  return (models ?? []).join(", ");
}

function formatApiErrorMessage(error: unknown): string | null {
  const apiMessage =
    typeof error === "object" && error && "response" in error
      ? (error as { response?: { data?: { message?: unknown } } }).response?.data?.message
      : undefined;
  if (typeof apiMessage === "string") {
    return apiMessage;
  }
  if (Array.isArray(apiMessage)) {
    return apiMessage.filter((entry) => typeof entry === "string").join("; ");
  }
  return null;
}

export function LlmGatewaySettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [settings, setSettings] = useState<LlmGatewaySettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<LlmGatewayProfile | null>(null);
  const [createForm] = Form.useForm<LlmGatewayFormValues>();
  const [editForm] = Form.useForm<LlmGatewayFormValues>();
  const [testProfile, setTestProfile] = useState<LlmGatewayProfile | null>(null);
  const [testResult, setTestResult] = useState<LlmGatewayTestResponse | null>(null);
  const [testErrorMessage, setTestErrorMessage] = useState<string | null>(null);
  const [testForm] = Form.useForm<LlmGatewayTestFormValues>();
  const screens = Grid.useBreakpoint();
  const includeEmbeddings = Form.useWatch("includeEmbeddings", testForm) ?? false;

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const presets = useMemo(
    () => [
      {
        key: "glm",
        label: t("settings.llmGateway.presets.glm"),
        apiBase: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-4-plus"
      },
      {
        key: "kimi",
        label: t("settings.llmGateway.presets.kimi"),
        apiBase: "https://api.moonshot.cn/v1",
        model: "moonshot-v1-8k"
      },
      {
        key: "deepseek",
        label: t("settings.llmGateway.presets.deepseek"),
        apiBase: "https://api.deepseek.com/v1",
        model: "deepseek-chat"
      },
      {
        key: "qwen",
        label: t("settings.llmGateway.presets.qwen"),
        apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-turbo"
      }
    ],
    [t]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<LlmGatewaySettingsResponse>("system-settings/llm-gateways");
      setSettings(response.data ?? EMPTY_SETTINGS);
    } catch (error) {
      captureClientError("Failed to load LLM gateway settings", error);
      setErrorMessage(t("settings.llmGateway.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!editing) {
      return;
    }
    editForm.setFieldsValue({
      preset: undefined,
      name: editing.name,
      apiBase: editing.apiBase,
      model: editing.model,
      embeddingModel: editing.embeddingModel ?? undefined,
      timeoutMs: editing.timeoutMs,
      temperature: editing.temperature,
      topP: editing.topP,
      maxOutputTokens: editing.maxOutputTokens,
      maxRetries: editing.maxRetries,
      requestsPerMinute: editing.requestsPerMinute,
      fallbackModels: toFallbackModelsText(editing.fallbackModels),
      enabled: editing.enabled,
      apiKey: "",
      clearApiKey: false
    });
  }, [editing, editForm]);

  const openCreate = () => {
    const template =
      settings.profiles.find((profile) => profile.id === settings.activeId) ?? settings.profiles[0] ?? null;
    const templateFallbackModels = template ? toFallbackModelsText(template.fallbackModels) : "";

    createForm.setFieldsValue({
      preset: undefined,
      name: "",
      apiBase: template?.apiBase ?? "http://localhost:4001",
      model: template?.model ?? "openai/gpt-4o-mini",
      embeddingModel: template?.embeddingModel ?? "",
      timeoutMs: template?.timeoutMs ?? 60_000,
      temperature: template?.temperature ?? 0.2,
      topP: template?.topP ?? 0.9,
      maxOutputTokens: template?.maxOutputTokens ?? 1_200,
      maxRetries: template?.maxRetries ?? 3,
      requestsPerMinute: template?.requestsPerMinute ?? 60,
      fallbackModels: templateFallbackModels,
      enabled: true
    });
    setCreateOpen(true);
  };

  const handleCreate = async (values: LlmGatewayFormValues) => {
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        apiBase: values.apiBase.trim(),
        apiKey: values.apiKey?.trim() ? values.apiKey.trim() : undefined,
        model: values.model.trim(),
        embeddingModel: values.embeddingModel?.trim() ? values.embeddingModel.trim() : null,
        timeoutMs: values.timeoutMs,
        temperature: values.temperature,
        topP: values.topP,
        maxOutputTokens: values.maxOutputTokens,
        maxRetries: values.maxRetries,
        requestsPerMinute: values.requestsPerMinute,
        fallbackModels: toFallbackModels(values.fallbackModels),
        enabled: values.enabled
      };
      await apiClient.post("system-settings/llm-gateways", payload);
      await loadSettings();
      setCreateOpen(false);
      createForm.resetFields();
      messageApi.success(t("settings.llmGateway.messages.created"));
    } catch (error) {
      captureClientError("Failed to create LLM gateway profile", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(extractApiError(error).message ?? t("settings.llmGateway.errors.badRequest"));
      } else {
        messageApi.error(t("settings.llmGateway.errors.createFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (values: LlmGatewayFormValues) => {
    if (!editing) {
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: values.name.trim(),
        apiBase: values.apiBase.trim(),
        model: values.model.trim(),
        embeddingModel: values.embeddingModel?.trim() ? values.embeddingModel.trim() : null,
        timeoutMs: values.timeoutMs,
        temperature: values.temperature,
        topP: values.topP,
        maxOutputTokens: values.maxOutputTokens,
        maxRetries: values.maxRetries,
        requestsPerMinute: values.requestsPerMinute,
        fallbackModels: toFallbackModels(values.fallbackModels),
        enabled: values.enabled
      };

      if (values.clearApiKey) {
        payload.apiKey = "";
      } else if (values.apiKey?.trim()) {
        payload.apiKey = values.apiKey.trim();
      }

      await apiClient.put(`system-settings/llm-gateways/${editing.id}`, payload);
      await loadSettings();
      setEditing(null);
      editForm.resetFields();
      messageApi.success(t("settings.llmGateway.messages.updated"));
    } catch (error) {
      captureClientError("Failed to update LLM gateway profile", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(extractApiError(error).message ?? t("settings.llmGateway.errors.badRequest"));
      } else {
        messageApi.error(t("settings.llmGateway.errors.updateFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (profile: LlmGatewayProfile, nextEnabled: boolean) => {
    setToggling(profile.id);
    try {
      await apiClient.put(`system-settings/llm-gateways/${profile.id}`, {
        enabled: nextEnabled
      });
      await loadSettings();
      messageApi.success(nextEnabled ? t("common.enabled") : t("common.disabled"));
    } catch (error) {
      captureClientError("Failed to toggle LLM gateway profile", error);
      messageApi.error(t("settings.llmGateway.errors.toggleFailed"));
    } finally {
      setToggling(null);
    }
  };

  const handleActivate = async (profileId: string) => {
    setActivating(true);
    try {
      await apiClient.put("system-settings/llm-gateways/active", { activeId: profileId });
      await loadSettings();
      messageApi.success(t("settings.llmGateway.messages.activated"));
    } catch (error) {
      captureClientError("Failed to activate LLM gateway profile", error);
      messageApi.error(t("settings.llmGateway.errors.activateFailed"));
    } finally {
      setActivating(false);
    }
  };

  const handleDelete = async (profile: LlmGatewayProfile) => {
    Modal.confirm({
      title: t("settings.llmGateway.modal.deleteTitle"),
      content: t("settings.llmGateway.modal.deleteContent", { name: profile.name }),
      okButtonProps: { danger: true },
      okText: t("common.delete"),
      onOk: async () => {
        try {
          await apiClient.delete(`system-settings/llm-gateways/${profile.id}`);
          await loadSettings();
          messageApi.success(t("settings.llmGateway.messages.deleted"));
        } catch (error) {
          captureClientError("Failed to delete LLM gateway profile", error);
          messageApi.error(t("settings.llmGateway.errors.deleteFailed"));
        }
      }
    });
  };

  const applyPreset = useCallback(
    (form: typeof createForm, presetKey: string | undefined) => {
      if (!presetKey) {
        return;
      }
      const preset = presets.find((entry) => entry.key === presetKey);
      if (!preset) {
        return;
      }
      const nextValues: Partial<LlmGatewayFormValues> = {
        apiBase: preset.apiBase,
        model: preset.model,
        embeddingModel: "",
        fallbackModels: ""
      };
      const currentName = form.getFieldValue("name");
      if (!currentName) {
        nextValues.name = preset.label;
      }
      form.setFieldsValue(nextValues);
    },
    [presets]
  );

  const openModelsModal = useCallback(
    (title: string, apiBase: string, models: string[]) => {
      type ModelRow = { id: string };
      const rows: ModelRow[] = models.map((id) => ({ id }));
      const columns: ColumnsType<ModelRow> = [
        {
          title: t("settings.llmGateway.models.columns.id"),
          dataIndex: "id",
          key: "id",
          render: (value: string) => (
            <Typography.Text code copyable>
              {value}
            </Typography.Text>
          )
        }
      ];

      Modal.info({
        title,
        width: screens.md ? 720 : "100%",
        content: (
          <Space direction="vertical" size="small" style={{ display: "flex" }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("settings.llmGateway.fields.apiBase")}:{" "}
              <Typography.Text code copyable>
                {apiBase}
              </Typography.Text>
            </Typography.Paragraph>
            <Typography.Text type="secondary">
              {t("settings.llmGateway.models.count", { count: models.length })}
            </Typography.Text>
            <Table<ModelRow>
              size="small"
              rowKey="id"
              dataSource={rows}
              columns={columns}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              scroll={{ y: 360 }}
              locale={{ emptyText: t("common.empty") }}
            />
          </Space>
        )
      });
    },
    [screens.md, t]
  );

  const handleListModels = async (profile: LlmGatewayProfile) => {
    setLoadingModels(profile.id);
    try {
      const response = await apiClient.get<LlmGatewayModelsResponse>(
        `system-settings/llm-gateways/${profile.id}/models`
      );
      const result = response.data;
      const models = result?.models ?? [];
      openModelsModal(
        t("settings.llmGateway.models.modal.title", { name: profile.name }),
        result?.apiBase ?? profile.apiBase,
        models
      );
    } catch (error) {
      captureClientError("Failed to list LLM gateway models", error);
      const messageText = formatApiErrorMessage(error);
      messageApi.error(messageText ? messageText : t("settings.llmGateway.models.errors.failed"));
    } finally {
      setLoadingModels((current) => (current === profile.id ? null : current));
    }
  };

  const renderTestResult = useCallback(
    (result: LlmGatewayTestResponse) => (
      <Space direction="vertical" size="small" style={{ display: "flex" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.fields.apiBase")}:{" "}
          <Typography.Text code copyable>
            {result.apiBase}
          </Typography.Text>
        </Typography.Paragraph>

        <Typography.Title level={5} style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.test.sections.completion")}
        </Typography.Title>
        <Space wrap>
          <Tag color="blue">{result.completion.model}</Tag>
          <Tag>{result.completion.latencyMs}ms</Tag>
          {result.completion.finishReason ? <Tag>{result.completion.finishReason}</Tag> : null}
          {result.completion.usage ? (
            <Tag>{t("settings.llmGateway.test.tokens", { total: result.completion.usage.total_tokens })}</Tag>
          ) : null}
          {typeof result.completion.costUsd === "number" ? (
            <Tag color="geekblue">{t("settings.llmGateway.test.cost", { cost: result.completion.costUsd.toFixed(6) })}</Tag>
          ) : null}
        </Space>
        <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
          {result.completion.content ?? "-"}
        </Typography.Paragraph>

        {result.embedding ? (
          <>
            <Typography.Title level={5} style={{ marginBottom: 0, marginTop: 8 }}>
              {t("settings.llmGateway.test.sections.embedding")}
            </Typography.Title>
            <Space wrap>
              <Tag color="blue">{result.embedding.model}</Tag>
              <Tag>{t("settings.llmGateway.test.dimensions", { n: result.embedding.dimensions })}</Tag>
              <Tag>{result.embedding.latencyMs}ms</Tag>
              {typeof result.embedding.costUsd === "number" ? (
                <Tag color="geekblue">
                  {t("settings.llmGateway.test.cost", { cost: result.embedding.costUsd.toFixed(6) })}
                </Tag>
              ) : null}
            </Space>
          </>
        ) : result.embeddingError ? (
          <>
            <Typography.Title level={5} style={{ marginBottom: 0, marginTop: 8 }}>
              {t("settings.llmGateway.test.sections.embedding")}
            </Typography.Title>
            <Alert type="error" showIcon message={result.embeddingError.message} />
          </>
        ) : null}
      </Space>
    ),
    [t]
  );

  const testUnsavedConfig = useCallback(
    async (source: "create" | "edit") => {
      const form = source === "create" ? createForm : editForm;
      const draftKey = source === "create" ? DRAFT_CREATE_KEY : DRAFT_EDIT_KEY;
      const profileId = source === "edit" && editing ? editing.id : undefined;

      setTesting(draftKey);
      try {
        const values = await form.validateFields(
          source === "edit"
            ? [
                "apiBase",
                "apiKey",
                "clearApiKey",
                "model",
                "embeddingModel",
                "timeoutMs",
                "temperature",
                "topP",
                "maxOutputTokens",
                "fallbackModels"
              ]
            : [
                "apiBase",
                "apiKey",
                "model",
                "embeddingModel",
                "timeoutMs",
                "temperature",
                "topP",
                "maxOutputTokens",
                "fallbackModels"
              ]
        );

        const apiKeyValue = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
        const includeApiKey = apiKeyValue.length > 0;
        const clearApiKey = Boolean(values.clearApiKey);

        const payload: Record<string, unknown> = {
          ...(profileId ? { profileId } : {}),
          apiBase: values.apiBase.trim(),
          model: values.model.trim(),
          timeoutMs: values.timeoutMs,
          temperature: values.temperature,
          topP: values.topP,
          maxOutputTokens: values.maxOutputTokens,
          fallbackModels: toFallbackModels(values.fallbackModels),
          ...(values.embeddingModel?.trim() ? { embeddingModel: values.embeddingModel.trim() } : {}),
          includeEmbeddings: Boolean(values.embeddingModel?.trim())
        };

        if (includeApiKey) {
          payload.apiKey = apiKeyValue;
        } else if (profileId && clearApiKey) {
          payload.apiKey = "";
        }

        const response = await apiClient.post<LlmGatewayTestResponse>(
          "system-settings/llm-gateways/test-config",
          payload
        );
        const result = response.data;
        if (!result?.completion) {
          messageApi.error(t("settings.llmGateway.testUnsaved.errors.failed"));
          return;
        }

        Modal.info({
          title: t("settings.llmGateway.testUnsaved.modal.title"),
          width: screens.md ? 720 : "100%",
          content: renderTestResult(result)
        });
      } catch (error) {
        if (typeof error === "object" && error && "errorFields" in error) {
          return;
        }
        captureClientError("Failed to test unsaved LLM gateway config", error);
        const messageText = formatApiErrorMessage(error);
        messageApi.error(messageText ? messageText : t("settings.llmGateway.testUnsaved.errors.failed"));
      } finally {
        setTesting((current) => (current === draftKey ? null : current));
      }
    },
    [apiClient, createForm, editForm, editing, messageApi, renderTestResult, screens.md, t]
  );

  const listModelsUnsavedConfig = useCallback(
    async (source: "create" | "edit") => {
      const form = source === "create" ? createForm : editForm;
      const draftKey = source === "create" ? DRAFT_CREATE_KEY : DRAFT_EDIT_KEY;
      const profileId = source === "edit" && editing ? editing.id : undefined;

      setLoadingModels(draftKey);
      try {
        const values = await form.validateFields(
          source === "edit"
            ? ["apiBase", "apiKey", "clearApiKey", "timeoutMs"]
            : ["apiBase", "apiKey", "timeoutMs"]
        );
        const apiKeyValue = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
        const includeApiKey = apiKeyValue.length > 0;
        const clearApiKey = Boolean(values.clearApiKey);

        const payload: Record<string, unknown> = {
          ...(profileId ? { profileId } : {}),
          apiBase: values.apiBase.trim(),
          timeoutMs: values.timeoutMs
        };

        if (includeApiKey) {
          payload.apiKey = apiKeyValue;
        } else if (profileId && clearApiKey) {
          payload.apiKey = "";
        }

        const response = await apiClient.post<LlmGatewayModelsResponse>(
          "system-settings/llm-gateways/models-config",
          payload
        );
        const result = response.data;
        const models = result?.models ?? [];

        openModelsModal(
          t("settings.llmGateway.modelsUnsaved.modal.title"),
          result?.apiBase ?? values.apiBase.trim(),
          models
        );
      } catch (error) {
        if (typeof error === "object" && error && "errorFields" in error) {
          return;
        }
        captureClientError("Failed to list unsaved LLM gateway models", error);
        const messageText = formatApiErrorMessage(error);
        messageApi.error(messageText ? messageText : t("settings.llmGateway.models.errors.failed"));
      } finally {
        setLoadingModels((current) => (current === draftKey ? null : current));
      }
    },
    [apiClient, createForm, editForm, editing, messageApi, openModelsModal, t]
  );

  const closeTest = () => {
    setTestProfile(null);
    setTestResult(null);
    setTestErrorMessage(null);
    testForm.resetFields();
  };

  const runTest = async (profileId: string, values: LlmGatewayTestFormValues) => {
    setTesting(profileId);
    setTestErrorMessage(null);
    try {
      const payload = {
        ...(values.model?.trim() ? { model: values.model.trim() } : {}),
        ...(values.prompt?.trim() ? { prompt: values.prompt.trim() } : {}),
        includeEmbeddings: values.includeEmbeddings,
        ...(values.embeddingModel?.trim() ? { embeddingModel: values.embeddingModel.trim() } : {}),
        ...(values.embeddingInput?.trim() ? { embeddingInput: values.embeddingInput.trim() } : {})
      };
      const response = await apiClient.post<LlmGatewayTestResponse>(
        `system-settings/llm-gateways/${profileId}/test`,
        payload
      );
      const result = response.data;
      if (!result?.completion) {
        setTestResult(null);
        setTestErrorMessage(t("settings.llmGateway.test.errors.failed"));
        return;
      }
      setTestResult(result);
    } catch (error) {
      captureClientError("Failed to test LLM gateway profile", error);
      const messageText = formatApiErrorMessage(error);
      setTestResult(null);
      setTestErrorMessage(messageText ? messageText : t("settings.llmGateway.test.errors.failed"));
    } finally {
      setTesting((current) => (current === profileId ? null : current));
    }
  };

  const openTest = (profile: LlmGatewayProfile) => {
    const initialValues: LlmGatewayTestFormValues = {
      model: "",
      prompt: "",
      includeEmbeddings: Boolean(profile.embeddingModel),
      embeddingModel: "",
      embeddingInput: ""
    };

    setTestProfile(profile);
    setTestResult(null);
    setTestErrorMessage(null);
    testForm.setFieldsValue(initialValues);
    void runTest(profile.id, initialValues);
  };

  const columns: ColumnsType<LlmGatewayProfile> = [
    {
      title: t("settings.llmGateway.columns.name"),
      dataIndex: "name",
      key: "name",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          <Space size={6} wrap>
            <Typography.Text strong>{record.name}</Typography.Text>
            {settings.activeId === record.id && record.enabled ? (
              <Tag color="blue">{t("settings.llmGateway.active")}</Tag>
            ) : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Typography.Text code copyable>
              {record.apiBase}
            </Typography.Text>
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t("settings.llmGateway.columns.model"),
      dataIndex: "model",
      key: "model",
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      )
    },
    {
      title: t("settings.llmGateway.columns.embeddingModel"),
      dataIndex: "embeddingModel",
      key: "embeddingModel",
      responsive: ["lg"],
      render: (value?: string | null) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        )
    },
    {
      title: t("settings.llmGateway.columns.rpm"),
      dataIndex: "requestsPerMinute",
      key: "requestsPerMinute",
      responsive: ["md"],
      render: (value: number) => <Typography.Text>{value}</Typography.Text>
    },
    {
      title: t("settings.llmGateway.columns.status"),
      dataIndex: "enabled",
      key: "enabled",
      render: (value: boolean) => (
        <Tag color={value ? "green" : "red"}>{value ? t("common.enabled") : t("common.disabled")}</Tag>
      )
    },
    {
      title: t("settings.llmGateway.columns.apiKey"),
      dataIndex: "hasApiKey",
      key: "hasApiKey",
      responsive: ["md"],
      render: (value: boolean) => (
        <Tag color={value ? "green" : "default"}>
          {value ? t("settings.llmGateway.keySet") : t("settings.llmGateway.keyMissing")}
        </Tag>
      )
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, record) => (
        <Space wrap>
          <Button size="small" onClick={() => openTest(record)} loading={testing === record.id}>
            {t("settings.llmGateway.actions.test")}
          </Button>
          <Button size="small" onClick={() => void handleListModels(record)} loading={loadingModels === record.id}>
            {t("settings.llmGateway.actions.models")}
          </Button>
          <Button
            size="small"
            type="primary"
            disabled={settings.activeId === record.id || !record.enabled}
            loading={activating}
            onClick={() => void handleActivate(record.id)}
          >
            {t("settings.llmGateway.actions.activate")}
          </Button>
          <Button size="small" onClick={() => setEditing(record)}>
            {t("common.edit")}
          </Button>
          <Button size="small" danger onClick={() => handleDelete(record)}>
            {t("common.delete")}
          </Button>
          <Switch
            size="small"
            checked={record.enabled}
            loading={toggling === record.id}
            onChange={(checked) => void handleToggle(record, checked)}
          />
        </Space>
      )
    }
  ];

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size="middle" style={{ display: "flex" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.description")}
        </Typography.Paragraph>

        {errorMessage ? (
          <Alert type="error" showIcon message={errorMessage} />
        ) : null}

        <Space wrap>
          <Button type="primary" onClick={openCreate}>
            {t("settings.llmGateway.actions.new")}
          </Button>
          <Button onClick={() => void loadSettings()} loading={loading}>
            {t("common.refresh")}
          </Button>
        </Space>

        <Table<LlmGatewayProfile>
          rowKey="id"
          size={screens.lg ? "middle" : "small"}
          loading={loading}
          dataSource={settings.profiles}
          columns={columns}
          pagination={false}
          locale={{ emptyText: t("common.empty") }}
        />
      </Space>

      <Modal
        title={t("settings.llmGateway.modal.createTitle")}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        width={screens.md ? 720 : "100%"}
        footer={[
          <Button
            key="test"
            onClick={() => void testUnsavedConfig("create")}
            loading={testing === DRAFT_CREATE_KEY}
          >
            {t("settings.llmGateway.actions.testUnsaved")}
          </Button>,
          <Button
            key="models"
            onClick={() => void listModelsUnsavedConfig("create")}
            loading={loadingModels === DRAFT_CREATE_KEY}
          >
            {t("settings.llmGateway.actions.models")}
          </Button>,
          <Button key="cancel" onClick={() => setCreateOpen(false)}>
            {t("common.cancel")}
          </Button>,
          <Button key="submit" type="primary" onClick={() => createForm.submit()} loading={saving}>
            {t("common.submit")}
          </Button>
        ]}
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item label={t("settings.llmGateway.fields.preset")} name="preset">
            <Select
              allowClear
              placeholder={t("settings.llmGateway.placeholders.preset")}
              options={presets.map((preset) => ({ value: preset.key, label: preset.label }))}
              onChange={(value) => applyPreset(createForm, value)}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.name")}
            name="name"
            rules={[{ required: true, message: t("settings.llmGateway.validation.nameRequired") }]}
          >
            <Input placeholder={t("settings.llmGateway.placeholders.name")} />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiBase")}
            name="apiBase"
            extra={t("settings.llmGateway.hints.apiBase")}
            rules={[
              { required: true, message: t("settings.llmGateway.validation.apiBaseRequired") },
              { type: "url", message: t("settings.llmGateway.validation.apiBaseUrl") }
            ]}
          >
            <Input placeholder="http://localhost:4001" />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiKey")}
            name="apiKey"
            extra={t("settings.llmGateway.hints.apiKey")}
          >
            <Input.Password placeholder={t("settings.llmGateway.placeholders.apiKey")} />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.model")}
            name="model"
            rules={[{ required: true, message: t("settings.llmGateway.validation.modelRequired") }]}
          >
            <Input placeholder="openai/gpt-4o-mini" />
          </Form.Item>
          <Form.Item label={t("settings.llmGateway.fields.embeddingModel")} name="embeddingModel">
            <Input placeholder="openai/text-embedding-3-small" />
          </Form.Item>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.timeoutMs")}
              name="timeoutMs"
              rules={[{ required: true, message: t("settings.llmGateway.validation.timeoutRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={1_000} max={900_000} step={1_000} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxRetries")}
              name="maxRetries"
              rules={[{ required: true, message: t("settings.llmGateway.validation.maxRetriesRequired") }]}
              style={{ minWidth: 160, flex: 1 }}
            >
              <InputNumber min={1} max={20} step={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.requestsPerMinute")}
              name="requestsPerMinute"
              rules={[{ required: true, message: t("settings.llmGateway.validation.rpmRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={1} max={100_000} step={1} style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.temperature")}
              name="temperature"
              rules={[{ required: true, message: t("settings.llmGateway.validation.temperatureRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={0} max={2} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.topP")}
              name="topP"
              rules={[{ required: true, message: t("settings.llmGateway.validation.topPRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxOutputTokens")}
              name="maxOutputTokens"
              rules={[{ required: true, message: t("settings.llmGateway.validation.maxOutputTokensRequired") }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={100_000} step={50} style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Form.Item
            label={t("settings.llmGateway.fields.fallbackModels")}
            name="fallbackModels"
            extra={t("settings.llmGateway.hints.fallbackModels")}
          >
            <Input placeholder={t("settings.llmGateway.placeholders.fallbackModels")} />
          </Form.Item>

          <Form.Item name="enabled" valuePropName="checked" label={t("settings.llmGateway.fields.enabled")}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t("settings.llmGateway.modal.editTitle")}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        width={screens.md ? 720 : "100%"}
        footer={[
          <Button
            key="test"
            onClick={() => void testUnsavedConfig("edit")}
            disabled={!editing}
            loading={testing === DRAFT_EDIT_KEY}
          >
            {t("settings.llmGateway.actions.testUnsaved")}
          </Button>,
          <Button
            key="models"
            onClick={() => void listModelsUnsavedConfig("edit")}
            disabled={!editing}
            loading={loadingModels === DRAFT_EDIT_KEY}
          >
            {t("settings.llmGateway.actions.models")}
          </Button>,
          <Button key="cancel" onClick={() => setEditing(null)}>
            {t("common.cancel")}
          </Button>,
          <Button key="save" type="primary" onClick={() => editForm.submit()} loading={saving}>
            {t("common.save")}
          </Button>
        ]}
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdate}>
          <Form.Item label={t("settings.llmGateway.fields.preset")} name="preset">
            <Select
              allowClear
              placeholder={t("settings.llmGateway.placeholders.preset")}
              options={presets.map((preset) => ({ value: preset.key, label: preset.label }))}
              onChange={(value) => applyPreset(editForm, value)}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.name")}
            name="name"
            rules={[{ required: true, message: t("settings.llmGateway.validation.nameRequired") }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiBase")}
            name="apiBase"
            extra={t("settings.llmGateway.hints.apiBase")}
            rules={[
              { required: true, message: t("settings.llmGateway.validation.apiBaseRequired") },
              { type: "url", message: t("settings.llmGateway.validation.apiBaseUrl") }
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiKey")}
            name="apiKey"
            extra={t("settings.llmGateway.hints.apiKeyEdit")}
          >
            <Input.Password placeholder={t("settings.llmGateway.placeholders.apiKeyEdit")} />
          </Form.Item>
          <Form.Item name="clearApiKey" valuePropName="checked">
            <Switch checkedChildren={t("settings.llmGateway.actions.clearKey")} unCheckedChildren={t("settings.llmGateway.actions.keepKey")} />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.model")}
            name="model"
            rules={[{ required: true, message: t("settings.llmGateway.validation.modelRequired") }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label={t("settings.llmGateway.fields.embeddingModel")} name="embeddingModel">
            <Input allowClear />
          </Form.Item>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.timeoutMs")}
              name="timeoutMs"
              rules={[{ required: true, message: t("settings.llmGateway.validation.timeoutRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={1_000} max={900_000} step={1_000} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxRetries")}
              name="maxRetries"
              rules={[{ required: true, message: t("settings.llmGateway.validation.maxRetriesRequired") }]}
              style={{ minWidth: 160, flex: 1 }}
            >
              <InputNumber min={1} max={20} step={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.requestsPerMinute")}
              name="requestsPerMinute"
              rules={[{ required: true, message: t("settings.llmGateway.validation.rpmRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={1} max={100_000} step={1} style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.temperature")}
              name="temperature"
              rules={[{ required: true, message: t("settings.llmGateway.validation.temperatureRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={0} max={2} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.topP")}
              name="topP"
              rules={[{ required: true, message: t("settings.llmGateway.validation.topPRequired") }]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxOutputTokens")}
              name="maxOutputTokens"
              rules={[{ required: true, message: t("settings.llmGateway.validation.maxOutputTokensRequired") }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={100_000} step={50} style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Form.Item
            label={t("settings.llmGateway.fields.fallbackModels")}
            name="fallbackModels"
            extra={t("settings.llmGateway.hints.fallbackModels")}
          >
            <Input />
          </Form.Item>

          <Form.Item name="enabled" valuePropName="checked" label={t("settings.llmGateway.fields.enabled")}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={testProfile ? t("settings.llmGateway.test.modal.title", { name: testProfile.name }) : undefined}
        open={Boolean(testProfile)}
        onCancel={closeTest}
        width={screens.md ? 720 : "100%"}
        footer={[
          <Button
            key="models"
            onClick={() => {
              if (testProfile) {
                void handleListModels(testProfile);
              }
            }}
            disabled={!testProfile}
            loading={testProfile ? loadingModels === testProfile.id : false}
          >
            {t("settings.llmGateway.actions.models")}
          </Button>,
          <Button key="close" onClick={closeTest}>
            {t("common.close")}
          </Button>,
          <Button
            key="run"
            type="primary"
            onClick={() => testForm.submit()}
            disabled={!testProfile}
            loading={testProfile ? testing === testProfile.id : false}
          >
            {t("settings.llmGateway.test.actions.run")}
          </Button>
        ]}
      >
        <Form
          form={testForm}
          layout="vertical"
          onFinish={(values) => {
            if (!testProfile) {
              return;
            }
            void runTest(testProfile.id, values);
          }}
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            {t("settings.llmGateway.fields.apiBase")}:{" "}
            <Typography.Text code copyable>
              {testProfile?.apiBase ?? "-"}
            </Typography.Text>
          </Typography.Paragraph>

          <Form.Item
            label={t("settings.llmGateway.test.fields.model")}
            name="model"
            extra={t("settings.llmGateway.test.hints.model")}
          >
            <Input allowClear placeholder={testProfile?.model ?? ""} />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.prompt")}
            name="prompt"
          >
            <Input.TextArea
              placeholder={t("settings.llmGateway.test.placeholders.prompt")}
              autoSize={{ minRows: 2, maxRows: 6 }}
            />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.includeEmbeddings")}
            name="includeEmbeddings"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.embeddingModel")}
            name="embeddingModel"
            extra={t("settings.llmGateway.test.hints.embeddingModel")}
          >
            <Input allowClear disabled={!includeEmbeddings} placeholder={testProfile?.embeddingModel ?? ""} />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.embeddingInput")}
            name="embeddingInput"
          >
            <Input disabled={!includeEmbeddings} placeholder={t("settings.llmGateway.test.placeholders.embeddingInput")} />
          </Form.Item>
        </Form>

        {testErrorMessage ? (
          <Alert type="error" showIcon message={testErrorMessage} style={{ marginTop: 12 }} />
        ) : null}

        {testResult ? <div style={{ marginTop: 12 }}>{renderTestResult(testResult)}</div> : null}
      </Modal>
    </>
  );
}
