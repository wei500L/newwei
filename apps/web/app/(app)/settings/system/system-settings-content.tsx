"use client";

import { Alert, Button, Card, Form, Input, InputNumber, Modal, Spin, Tabs, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  useAuditLogRetentionQuery,
  useAuthCacheSettingsQuery,
  useCrawlClientSettingsQuery,
  useNewsPromptConfigQuery,
  useRateLimitSettingsQuery,
  useUpdateAuditLogRetentionMutation,
  useUpdateAuthCacheSettingsMutation,
  useUpdateCrawlClientSettingsMutation,
  useUpdateNewsPromptConfigMutation,
  useUpdateRateLimitSettingsMutation
} from "@/graphql/generated";
import type {
  UpdateAuditLogRetentionMutationVariables,
  UpdateAuthCacheSettingsMutationVariables,
  UpdateCrawlClientSettingsMutationVariables,
  UpdateNewsPromptConfigMutationVariables,
  UpdateRateLimitSettingsMutationVariables
} from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

function estimateTokens(text: string) {
  if (!text) {
    return 0;
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return Math.ceil(text.length / 4);
  }
  return words.reduce((acc, word) => acc + Math.max(1, Math.ceil(word.length / 4)), 0);
}

interface RateLimitFieldGroupProps {
  title: string;
  description: string;
  field: "login" | "crawlCreate" | "rbacWrite";
}

function RateLimitFieldGroup({ title, description, field }: RateLimitFieldGroupProps) {
  return (
    <Card size="small" style={{ marginBottom: "1rem" }} title={title}>
      <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
      <div style={{ display: "flex", gap: "1rem" }}>
        <Form.Item
          label="Max attempts"
          name={[field, "limit"]}
          rules={[{ required: true, message: "Please enter a limit" }]}
        >
          <InputNumber min={1} max={1000} />
        </Form.Item>
        <Form.Item
          label="Window (seconds)"
          name={[field, "windowSeconds"]}
          rules={[{ required: true, message: "Please enter a window size" }]}
        >
          <InputNumber min={5} max={86_400} />
        </Form.Item>
      </div>
    </Card>
  );
}

function RateLimitSettingsPanel() {
  const [form] = Form.useForm<UpdateRateLimitSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useRateLimitSettingsQuery();
  const [updateRateLimitSettings, { loading: saving }] = useUpdateRateLimitSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.rateLimitSettings) {
      form.setFieldsValue(data.rateLimitSettings);
    }
  }, [data?.rateLimitSettings, form]);

  const handleSubmit = async (values: UpdateRateLimitSettingsMutationVariables["input"]) => {
    try {
      await updateRateLimitSettings({ variables: { input: values } });
      await refetch();
      messageApi.success("Rate limit settings saved");
    } catch (error) {
      captureClientError("Failed to save rate limits", error);
      messageApi.error("Failed to save rate limits");
    }
  };

  if (loading && !data?.rateLimitSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        Configure how many requests are allowed per time window for the most sensitive operations.
        Changes take effect immediately across the platform.
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <RateLimitFieldGroup
          title="Login attempts"
          field="login"
          description="Limits brute-force attacks by capping failed logins per IP/email."
        />
        <RateLimitFieldGroup
          title="Crawl task creation"
          field="crawlCreate"
          description="Protects crawl workers and downstream LLM workloads from abuse."
        />
        <RateLimitFieldGroup
          title="RBAC writes"
          field="rbacWrite"
          description="Prevents rapid privilege escalations or accidental bulk changes."
        />
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            Save Changes
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function AuditLogRetentionPanel() {
  const [form] = Form.useForm<UpdateAuditLogRetentionMutationVariables["input"]>();
  const { data, loading, refetch } = useAuditLogRetentionQuery();
  const [updateRetention, { loading: saving }] = useUpdateAuditLogRetentionMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.auditLogRetention?.retentionDays) {
      form.setFieldsValue({ retentionDays: data.auditLogRetention.retentionDays });
    }
  }, [data?.auditLogRetention?.retentionDays, form]);

  const handleSubmit = async (values: UpdateAuditLogRetentionMutationVariables["input"]) => {
    try {
      await updateRetention({ variables: { input: values } });
      await refetch();
      messageApi.success("Audit log retention updated");
    } catch (error) {
      captureClientError("Failed to update audit log retention", error);
      messageApi.error("Failed to update audit log retention");
    }
  };

  if (loading && !data?.auditLogRetention) {
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
        Control how long audit trail entries are retained before automatic cleanup. Old records are
        purged nightly at 01:00.
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label="Retention days"
          name="retentionDays"
          rules={[
            { required: true, message: "Please enter a retention window" },
            { type: "number", min: 1, max: 3650, message: "Enter between 1 and 3650 days" }
          ]}
        >
          <InputNumber min={1} max={3650} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            Save Changes
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function AuthCacheSettingsPanel() {
  const [form] = Form.useForm<UpdateAuthCacheSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useAuthCacheSettingsQuery();
  const [updateSettings, { loading: saving }] = useUpdateAuthCacheSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.authCacheSettings) {
      form.setFieldsValue(data.authCacheSettings);
    }
  }, [data?.authCacheSettings, form]);

  const handleSubmit = async (values: UpdateAuthCacheSettingsMutationVariables["input"]) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success("Auth cache settings saved");
    } catch (error) {
      captureClientError("Failed to save auth cache settings", error);
      messageApi.error("Failed to save auth cache settings");
    }
  };

  if (loading && !data?.authCacheSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        Tune profile cache TTL and stampede protection without redeploys.
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label="Profile cache TTL (seconds)"
          name="profileTtlSeconds"
          rules={[
            { required: true, message: "Please set a cache TTL" },
            { type: "number", min: 60, max: 86_400 }
          ]}
        >
          <InputNumber min={60} max={86_400} step={30} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label="Lock TTL (ms)"
          name="lockTtlMs"
          rules={[
            { required: true, message: "Please set a lock TTL" },
            { type: "number", min: 1_000, max: 120_000 }
          ]}
        >
          <InputNumber min={1_000} max={120_000} step={500} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label="Max wait time for lock (ms)"
          name="maxWaitMs"
          rules={[
            { required: true, message: "Please set a max wait time" },
            { type: "number", min: 50, max: 120_000 }
          ]}
        >
          <InputNumber min={50} max={120_000} step={50} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label="Retry delay between lock attempts (ms)"
          name="retryDelayMs"
          rules={[
            { required: true, message: "Please set a retry delay" },
            { type: "number", min: 10, max: 1_000 }
          ]}
        >
          <InputNumber min={10} max={1_000} step={10} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            Save Changes
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function CrawlClientSettingsPanel() {
  const [form] = Form.useForm<UpdateCrawlClientSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useCrawlClientSettingsQuery();
  const [updateSettings, { loading: saving }] = useUpdateCrawlClientSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.crawlClientSettings) {
      form.setFieldsValue(data.crawlClientSettings);
    }
  }, [data?.crawlClientSettings, form]);

  const handleSubmit = async (values: UpdateCrawlClientSettingsMutationVariables["input"]) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success("Crawl client settings saved");
    } catch (error) {
      captureClientError("Failed to save crawl client settings", error);
      messageApi.error("Failed to save crawl client settings");
    }
  };

  if (loading && !data?.crawlClientSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        Control crawl health check caching, HTTP timeout, and retry backoff without redeploying
        workers.
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label="Health check TTL (ms)"
          name="healthCheckTtlMs"
          rules={[{ required: true, message: "Please set a health check TTL" }]}
        >
          <InputNumber min={5_000} max={900_000} step={1_000} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label="Request timeout (ms)"
          name="requestTimeoutMs"
          rules={[{ required: true, message: "Please set a request timeout" }]}
        >
          <InputNumber min={5_000} max={300_000} step={1_000} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label="Max attempts"
          name="maxRetries"
          rules={[{ required: true, message: "Please set the max attempts" }]}
        >
          <InputNumber min={1} max={10} step={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label="Retry backoff (ms)"
          name="retryBackoffMs"
          rules={[{ required: true, message: "Please set a retry backoff delay" }]}
        >
          <InputNumber min={500} max={600_000} step={500} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            Save Changes
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function NewsPromptSettingsPanel() {
  const [form] = Form.useForm<UpdateNewsPromptConfigMutationVariables["input"]>();
  const { data, loading, refetch } = useNewsPromptConfigQuery();
  const [updateConfig, { loading: saving }] = useUpdateNewsPromptConfigMutation();
  const [messageApi, contextHolder] = message.useMessage();

  const systemTemplate = Form.useWatch("systemPromptTemplate", form) ?? "";
  const userTemplate = Form.useWatch("userPromptTemplate", form) ?? "";
  const systemTokens = useMemo(() => estimateTokens(systemTemplate), [systemTemplate]);
  const userTokens = useMemo(() => estimateTokens(userTemplate), [userTemplate]);
  const totalTokens = systemTokens + userTokens;

  useEffect(() => {
    if (data?.newsPromptConfig) {
      form.setFieldsValue(data.newsPromptConfig);
    }
  }, [data?.newsPromptConfig, form]);

  const handleSubmit = async (values: UpdateNewsPromptConfigMutationVariables["input"]) => {
    try {
      await updateConfig({ variables: { input: values } });
      await refetch();
      messageApi.success("Prompt configuration saved");
    } catch (error) {
      captureClientError("Failed to save prompt configuration", error);
      messageApi.error("Failed to save prompt configuration");
    }
  };

  if (loading && !data?.newsPromptConfig) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  const placeholderTokens = [
    "{{language_hint}}",
    "{{url}}",
    "{{cache_hit}}",
    "{{metadata_section}}",
    "{{keywords_section}}",
    "{{summary_hints_section}}",
    "{{markdown}}"
  ];

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "0.5rem" }}>
        Update prompt version and templates without restarting services. Changes apply immediately
        to new pipeline runs.
      </Typography.Paragraph>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
        {placeholderTokens.map((token) => (
          <Tag key={token}>{token}</Tag>
        ))}
      </div>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label="Prompt version"
          name="version"
          rules={[{ required: true, message: "Please enter a prompt version" }]}
        >
          <Input placeholder="news-clean-v2" />
        </Form.Item>
        <Form.Item
          label="System prompt template"
          name="systemPromptTemplate"
          rules={[{ required: true, message: "Please provide a system prompt template" }]}
          extra={`Estimated tokens: ${systemTokens}`}
        >
          <Input.TextArea rows={5} />
        </Form.Item>
        <Form.Item
          label="User prompt template"
          name="userPromptTemplate"
          rules={[{ required: true, message: "Please provide a user prompt template" }]}
          extra={`Estimated tokens: ${userTokens}`}
        >
          <Input.TextArea rows={10} />
        </Form.Item>
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: "0.75rem" }}>
          Estimated total tokens: {totalTokens}
        </Typography.Text>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            Save Changes
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

interface AkshareGatewayVersionResponse {
  akshareVersion: string;
  pythonVersion: string;
}

interface AkshareGatewayUpgradeAcceptedResponse {
  status: "accepted";
  requestId: string;
  beforeVersion: string;
}

interface AkshareGatewayUpgradeStatusResponse {
  inProgress: boolean;
  stage: "idle" | "queued" | "running" | "restarting" | "failed";
  requestId: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  restartScheduledAt: string | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  error: string | null;
  pipStdout: string | null;
  pipStderr: string | null;
  pid?: number;
  upgradeEnabled?: boolean;
  disabledReason?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function AkshareGatewaySettingsPanel() {
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [version, setVersion] = useState<AkshareGatewayVersionResponse | null>(null);
  const [status, setStatus] = useState<AkshareGatewayUpgradeStatusResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const fetchVersion = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<AkshareGatewayVersionResponse>("admin/akshare/version", {
        timeout: 10_000
      });
      setVersion(response.data);
    } catch (error) {
      captureClientError("Failed to load akshare gateway version", error);
      setErrorMessage("Failed to load akshare gateway version");
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await apiClient.get<AkshareGatewayUpgradeStatusResponse>("admin/akshare/status", {
        timeout: 10_000
      });
      setStatus(response.data);
      return response.data;
    } catch (error) {
      captureClientError("Failed to load akshare gateway status", error);
      setStatus(null);
      return null;
    }
  }, [apiClient]);

  useEffect(() => {
    void fetchVersion();
    void fetchStatus();
  }, [fetchStatus, fetchVersion]);

  const handleUpgrade = useCallback(() => {
    if (status?.upgradeEnabled === false) {
      const reason = status.disabledReason ?? "Akshare upgrade is disabled.";
      messageApi.warning(reason);
      return;
    }

    Modal.confirm({
      title: "Upgrade Akshare to latest",
      content:
        "This will run `pip install -U akshare` inside the akshare gateway container and restart the gateway process. Requests may fail briefly during the restart.",
      okText: "Upgrade now",
      okButtonProps: { danger: true },
      onOk: async () => {
        setUpgrading(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.post<AkshareGatewayUpgradeAcceptedResponse>(
            "admin/akshare/upgrade",
            {},
            { timeout: 30_000 }
          );
          messageApi.success(`Akshare upgrade started (current: ${response.data.beforeVersion})`);

          const requestId = response.data.requestId;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const currentStatus = await fetchStatus();
            if (currentStatus?.requestId === requestId) {
              if (currentStatus.stage === "failed") {
                const detail = currentStatus.error ? `: ${currentStatus.error}` : "";
                throw new Error(`Akshare upgrade failed${detail}`);
              }
              if (currentStatus.stage === "restarting") {
                break;
              }
            }
            await sleep(2000);
          }

          await sleep(2000);
          for (let attempt = 0; attempt < 30; attempt += 1) {
            try {
              await fetchVersion();
              break;
            } catch {
              // gateway may be restarting
            }
            await sleep(2000);
          }
        } catch (error) {
          const statusCode = (error as any)?.response?.status as number | undefined;
          if (statusCode === 409) {
            messageApi.info("Akshare upgrade is already in progress");
            void fetchStatus();
            return;
          }
          if (statusCode === 503) {
            messageApi.error("Akshare upgrade is disabled (missing AKSHARE_ADMIN_TOKEN)");
            setErrorMessage("Akshare upgrade is disabled (missing AKSHARE_ADMIN_TOKEN)");
            return;
          }
          if (statusCode === 404) {
            messageApi.error("Akshare gateway does not expose admin endpoints");
            setErrorMessage("Akshare gateway does not expose admin endpoints");
            return;
          }

          captureClientError("Failed to upgrade akshare gateway", error);
          messageApi.error("Failed to upgrade akshare");
          setErrorMessage("Failed to upgrade akshare");
          throw error;
        } finally {
          setUpgrading(false);
        }
      }
    });
  }, [apiClient, fetchStatus, fetchVersion, messageApi, status]);

  const currentVersion = version?.akshareVersion ?? "-";
  const pythonVersion = version?.pythonVersion ?? "-";
  const stage = status?.stage ?? "unknown";
  const upgradeDisabledReason =
    status?.upgradeEnabled === false ? status.disabledReason ?? "Akshare upgrade is disabled." : null;
  const stageColor =
    stage === "failed"
      ? "red"
      : stage === "restarting" || stage === "running" || stage === "queued"
        ? "orange"
        : stage === "idle"
          ? "green"
          : "default";

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary">
        Shows the Akshare version running inside the akshare gateway container. You can upgrade it to the latest version
        without rebuilding the image.
      </Typography.Paragraph>

      {errorMessage ? (
        <Alert style={{ marginBottom: "1rem" }} type="error" message={errorMessage} showIcon />
      ) : null}

      {upgradeDisabledReason ? (
        <Alert style={{ marginBottom: "1rem" }} type="warning" message={upgradeDisabledReason} showIcon />
      ) : null}

      <Card size="small" title="Akshare Gateway" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          <Typography.Text>Akshare</Typography.Text>
          <Tag color="blue">{currentVersion}</Tag>
          <Typography.Text type="secondary">Python {pythonVersion}</Typography.Text>
          <Tag color={stageColor}>{stage}</Tag>
          <Button onClick={() => void fetchVersion()} loading={loading}>
            Refresh
          </Button>
          <Button onClick={() => void fetchStatus()} disabled={loading}>
            Refresh status
          </Button>
          <Button
            type="primary"
            danger
            onClick={handleUpgrade}
            loading={upgrading}
            disabled={loading || upgrading || Boolean(status?.inProgress) || status?.upgradeEnabled === false}
          >
            Upgrade to latest
          </Button>
        </div>
        {status?.requestId ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            Request: {status.requestId}
            {status.beforeVersion ? ` · before: ${status.beforeVersion}` : ""}
            {status.afterVersion ? ` · after: ${status.afterVersion}` : ""}
          </Typography.Paragraph>
        ) : null}
        {status?.error ? (
          <Typography.Paragraph type="danger" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            {status.error}
          </Typography.Paragraph>
        ) : null}
      </Card>
    </>
  );
}

export function SystemSettingsContent() {
  const { data: session, status } = useSession();
  const canManageSettings = session?.permissions?.includes("settings.manage") ?? false;

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canManageSettings) {
    return (
      <Card className="content-card" title="System Settings">
        <Alert
          type="warning"
          message="Admins only"
          description="Only administrators can view and change system settings."
        />
      </Card>
    );
  }

  const items = [
    { key: "rateLimits", label: "Rate Limits", children: <RateLimitSettingsPanel /> },
    { key: "auditLog", label: "Audit Log", children: <AuditLogRetentionPanel /> },
    { key: "authCache", label: "Auth Cache", children: <AuthCacheSettingsPanel /> },
    { key: "crawlClient", label: "Crawl Client", children: <CrawlClientSettingsPanel /> },
    { key: "newsPrompts", label: "News Pipeline Prompts", children: <NewsPromptSettingsPanel /> },
    { key: "akshare", label: "Akshare", children: <AkshareGatewaySettingsPanel /> }
  ];

  return (
    <Card className="content-card" title="System Settings">
      <Typography.Paragraph type="secondary">
        View and update system-wide settings without redeploys.
      </Typography.Paragraph>
      <Tabs defaultActiveKey="rateLimits" items={items} />
    </Card>
  );
}
