"use client";

import {
  Alert,
  Button,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
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

interface LlmGatewayFormValues {
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

export function LlmGatewaySettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [settings, setSettings] = useState<LlmGatewaySettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<LlmGatewayProfile | null>(null);
  const [createForm] = Form.useForm<LlmGatewayFormValues>();
  const [editForm] = Form.useForm<LlmGatewayFormValues>();
  const screens = Grid.useBreakpoint();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
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
        messageApi.error(t("settings.llmGateway.errors.badRequest"));
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
        messageApi.error(t("settings.llmGateway.errors.badRequest"));
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

  const columns: ColumnsType<LlmGatewayProfile> = [
    {
      title: t("settings.llmGateway.columns.name"),
      dataIndex: "name",
      key: "name",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          <Space size={6} wrap>
            <Typography.Text strong>{record.name}</Typography.Text>
            {settings.activeId === record.id ? <Tag color="blue">{t("settings.llmGateway.active")}</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Typography.Text code>{record.apiBase}</Typography.Text>
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t("settings.llmGateway.columns.model"),
      dataIndex: "model",
      key: "model",
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>
    },
    {
      title: t("settings.llmGateway.columns.embeddingModel"),
      dataIndex: "embeddingModel",
      key: "embeddingModel",
      responsive: ["lg"],
      render: (value?: string | null) =>
        value ? <Typography.Text code>{value}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>
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
        okText={t("common.submit")}
        confirmLoading={saving}
        onOk={() => createForm.submit()}
        width={screens.md ? 720 : "100%"}
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
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
        okText={t("common.save")}
        confirmLoading={saving}
        onOk={() => editForm.submit()}
        width={screens.md ? 720 : "100%"}
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdate}>
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
    </>
  );
}
