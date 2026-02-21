"use client";

import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Spin,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AssistantSafetySettingsPanel } from "@/components/settings/assistant-safety-settings-panel";
import { EmailSettingsPanel } from "@/components/settings/email-settings-panel";
import { EntityImpactGraphSettingsPanel } from "@/components/settings/entity-impact-graph-settings-panel";
import {
  NumberRangeExtra,
  TokenEstimateExtra,
  TotalTokenEstimateText,
} from "@/components/settings/form-field-feedback";
import { GeoNominatimSettingsPanel } from "@/components/settings/geo-nominatim-settings-panel";
import { KnowledgeGraphReviewPanel } from "@/components/settings/knowledge-graph-review-panel";
import { KnowledgeGraphSettingsPanel } from "@/components/settings/knowledge-graph-settings-panel";
import { LlmGatewaySettingsPanel } from "@/components/settings/llm-gateway-settings-panel";
import { ModelServiceSettingsPanel } from "@/components/settings/model-service-settings-panel";
import { NewsDedupeSettingsPanel } from "@/components/settings/news-dedupe-settings-panel";
import { NewsEventsSettingsPanel } from "@/components/settings/news-events-settings-panel";
import { NewsEventSourcePolicySettingsPanel } from "@/components/settings/news-event-source-policy-settings-panel";
import { NewsIndicatorSettingsPanel } from "@/components/settings/news-indicator-settings-panel";
import { NewsSourceSchedulerSettingsPanel } from "@/components/settings/news-source-scheduler-settings-panel";
import { RateLimitPoliciesPanel } from "@/components/settings/rate-limit-policies-panel";
import { RssDiagnosticsPanel } from "@/components/settings/rss-diagnostics-panel";
import { RssTranslationMetricsPanel } from "@/components/settings/rss-translation-metrics-panel";
import { SituationMonitorSettingsPanel } from "@/components/settings/situation-monitor-settings-panel";
import { SystemSecuritySettingsPanel } from "@/components/settings/system-security-settings-panel";
import { UnitInputNumber } from "@/components/settings/unit-input-number";
import { VectorServiceSettingsPanel } from "@/components/settings/vector-service-settings-panel";
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
  useUpdateRateLimitSettingsMutation,
} from "@/graphql/generated";
import type {
  UpdateAuditLogRetentionMutationVariables,
  UpdateAuthCacheSettingsMutationVariables,
  UpdateCrawlClientSettingsMutationVariables,
  UpdateNewsPromptConfigMutationVariables,
  UpdateRateLimitSettingsMutationVariables,
} from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface RateLimitFieldGroupProps {
  title: string;
  description: string;
  field: "login" | "crawlCreate" | "rbacWrite";
}

function RateLimitFieldGroup({
  title,
  description,
  field,
}: RateLimitFieldGroupProps) {
  const { t } = useTranslation();
  return (
    <Card size="small" style={{ marginBottom: "1rem" }} title={title}>
      <Typography.Paragraph type="secondary">
        {description}
      </Typography.Paragraph>
      <div style={{ display: "flex", gap: "1rem" }}>
        <Form.Item
          label={t("settings.rateLimits.fields.maxAttempts")}
          name={[field, "limit"]}
          rules={[
            {
              required: true,
              message: t("settings.rateLimits.validation.maxAttempts"),
            },
            {
              type: "number",
              min: 1,
              max: 1000,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 1000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra name={[field, "limit"]} min={1} max={1000} />
          }
        >
          <InputNumber min={1} max={1000} />
        </Form.Item>
        <Form.Item
          label={t("settings.rateLimits.fields.windowSeconds")}
          name={[field, "windowSeconds"]}
          rules={[
            {
              required: true,
              message: t("settings.rateLimits.validation.windowSeconds"),
            },
            {
              type: "number",
              min: 5,
              max: 86_400,
              message: t("common.validation.numberRange", {
                min: 5,
                max: 86_400,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name={[field, "windowSeconds"]}
              min={5}
              max={86_400}
              unit="s"
            />
          }
        >
          <UnitInputNumber min={5} max={86_400} unit="s" />
        </Form.Item>
      </div>
    </Card>
  );
}

function RateLimitSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateRateLimitSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useRateLimitSettingsQuery();
  const [updateRateLimitSettings, { loading: saving }] =
    useUpdateRateLimitSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.rateLimitSettings) {
      form.setFieldsValue(data.rateLimitSettings);
    }
  }, [data?.rateLimitSettings, form]);

  const handleSubmit = async (
    values: UpdateRateLimitSettingsMutationVariables["input"],
  ) => {
    try {
      await updateRateLimitSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.rateLimits.saved"));
    } catch (error) {
      captureClientError("Failed to save rate limits", error);
      messageApi.error(t("settings.rateLimits.saveFailed"));
    }
  };

  if (loading && !data?.rateLimitSettings) {
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
      <Alert
        type="warning"
        showIcon
        message={t("settings.rateLimits.riskTitle")}
        description={
          <span>
            {t("settings.rateLimits.riskDescription")}{" "}
            <Link href="/admin/audit-logs">
              {t("settings.rateLimits.auditLink")}
            </Link>
          </span>
        }
        style={{ marginBottom: "1rem" }}
      />
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        {t("settings.rateLimits.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <RateLimitFieldGroup
          title={t("settings.rateLimits.login.title")}
          field="login"
          description={t("settings.rateLimits.login.description")}
        />
        <RateLimitFieldGroup
          title={t("settings.rateLimits.crawlCreate.title")}
          field="crawlCreate"
          description={t("settings.rateLimits.crawlCreate.description")}
        />
        <RateLimitFieldGroup
          title={t("settings.rateLimits.rbacWrite.title")}
          field="rbacWrite"
          description={t("settings.rateLimits.rbacWrite.description")}
        />
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function AuditLogRetentionPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateAuditLogRetentionMutationVariables["input"]>();
  const { data, loading, refetch } = useAuditLogRetentionQuery();
  const [updateRetention, { loading: saving }] =
    useUpdateAuditLogRetentionMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.auditLogRetention?.retentionDays) {
      form.setFieldsValue({
        retentionDays: data.auditLogRetention.retentionDays,
      });
    }
  }, [data?.auditLogRetention?.retentionDays, form]);

  const handleSubmit = async (
    values: UpdateAuditLogRetentionMutationVariables["input"],
  ) => {
    try {
      await updateRetention({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.auditLog.saved"));
    } catch (error) {
      captureClientError("Failed to update audit log retention", error);
      messageApi.error(t("settings.auditLog.saveFailed"));
    }
  };

  if (loading && !data?.auditLogRetention) {
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
        {t("settings.auditLog.descriptionSystem")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.auditLog.fields.retentionDays")}
          name="retentionDays"
          rules={[
            {
              required: true,
              message: t("settings.auditLog.validation.retentionRequired"),
            },
            {
              type: "number",
              min: 1,
              max: 3650,
              message: t("settings.auditLog.validation.retentionRange"),
            },
          ]}
          extra={<NumberRangeExtra name="retentionDays" min={1} max={3650} />}
        >
          <InputNumber min={1} max={3650} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function AuthCacheSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateAuthCacheSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useAuthCacheSettingsQuery();
  const [updateSettings, { loading: saving }] =
    useUpdateAuthCacheSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.authCacheSettings) {
      form.setFieldsValue(data.authCacheSettings);
    }
  }, [data?.authCacheSettings, form]);

  const handleSubmit = async (
    values: UpdateAuthCacheSettingsMutationVariables["input"],
  ) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.authCache.saved"));
    } catch (error) {
      captureClientError("Failed to save auth cache settings", error);
      messageApi.error(t("settings.authCache.saveFailed"));
    }
  };

  if (loading && !data?.authCacheSettings) {
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
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        {t("settings.authCache.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.authCache.fields.profileTtl")}
          name="profileTtlSeconds"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.profileTtlRequired"),
            },
            {
              type: "number",
              min: 60,
              max: 86_400,
              message: t("common.validation.numberRange", {
                min: 60,
                max: 86_400,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="profileTtlSeconds"
              min={60}
              max={86_400}
              unit="s"
            />
          }
        >
          <UnitInputNumber
            min={60}
            max={86_400}
            step={30}
            unit="s"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.authCache.fields.lockTtl")}
          name="lockTtlMs"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.lockTtlRequired"),
            },
            {
              type: "number",
              min: 100,
              max: 60_000,
              message: t("common.validation.numberRange", {
                min: 100,
                max: 60_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="lockTtlMs"
              min={100}
              max={60_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={100}
            max={60_000}
            step={50}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.authCache.fields.maxWait")}
          name="maxWaitMs"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.maxWaitRequired"),
            },
            {
              type: "number",
              min: 50,
              max: 120_000,
              message: t("common.validation.numberRange", {
                min: 50,
                max: 120_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="maxWaitMs"
              min={50}
              max={120_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={50}
            max={120_000}
            step={50}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.authCache.fields.retryDelay")}
          name="retryDelayMs"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.retryDelayRequired"),
            },
            {
              type: "number",
              min: 10,
              max: 1_000,
              message: t("common.validation.numberRange", {
                min: 10,
                max: 1_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="retryDelayMs"
              min={10}
              max={1_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={10}
            max={1_000}
            step={10}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function CrawlClientSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateCrawlClientSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useCrawlClientSettingsQuery();
  const [updateSettings, { loading: saving }] =
    useUpdateCrawlClientSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.crawlClientSettings) {
      form.setFieldsValue(data.crawlClientSettings);
    }
  }, [data?.crawlClientSettings, form]);

  const handleSubmit = async (
    values: UpdateCrawlClientSettingsMutationVariables["input"],
  ) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.crawlClient.saved"));
    } catch (error) {
      captureClientError("Failed to save crawl client settings", error);
      messageApi.error(t("settings.crawlClient.saveFailed"));
    }
  };

  if (loading && !data?.crawlClientSettings) {
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
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        {t("settings.crawlClient.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.crawlClient.fields.healthCheckTtl")}
          name="healthCheckTtlMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.healthCheckTtl"),
            },
            {
              type: "number",
              min: 5_000,
              max: 900_000,
              message: t("common.validation.numberRange", {
                min: 5_000,
                max: 900_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="healthCheckTtlMs"
              min={5_000}
              max={900_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={5_000}
            max={900_000}
            step={1_000}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.requestTimeout")}
          name="requestTimeoutMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.requestTimeout"),
            },
            {
              type: "number",
              min: 5_000,
              max: 900_000,
              message: t("common.validation.numberRange", {
                min: 5_000,
                max: 900_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="requestTimeoutMs"
              min={5_000}
              max={900_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={5_000}
            max={900_000}
            step={1_000}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.maxAttempts")}
          name="maxRetries"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.maxAttempts"),
            },
            {
              type: "number",
              min: 1,
              max: 10,
              message: t("common.validation.numberRange", { min: 1, max: 10 }),
            },
          ]}
          extra={<NumberRangeExtra name="maxRetries" min={1} max={10} />}
        >
          <InputNumber min={1} max={10} step={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.retryBackoff")}
          name="retryBackoffMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.retryBackoff"),
            },
            {
              type: "number",
              min: 500,
              max: 600_000,
              message: t("common.validation.numberRange", {
                min: 500,
                max: 600_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="retryBackoffMs"
              min={500}
              max={600_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={500}
            max={600_000}
            step={500}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.queueOverloadCooldown", {
            defaultValue: "Queue overload cooldown",
          })}
          name="queueOverloadCooldownMs"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.queueOverloadCooldown",
                {
                  defaultValue: "Please enter queue overload cooldown.",
                },
              ),
            },
            {
              type: "number",
              min: 5_000,
              max: 600_000,
              message: t("common.validation.numberRange", {
                min: 5_000,
                max: 600_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="queueOverloadCooldownMs"
              min={5_000}
              max={600_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={5_000}
            max={600_000}
            step={1_000}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function NewsPromptSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateNewsPromptConfigMutationVariables["input"]>();
  const { data, loading, refetch } = useNewsPromptConfigQuery();
  const [updateConfig, { loading: saving }] =
    useUpdateNewsPromptConfigMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.newsPromptConfig) {
      form.setFieldsValue(data.newsPromptConfig);
    }
  }, [data?.newsPromptConfig, form]);

  const handleSubmit = async (
    values: UpdateNewsPromptConfigMutationVariables["input"],
  ) => {
    try {
      await updateConfig({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.newsPrompts.saved"));
    } catch (error) {
      captureClientError("Failed to save prompt configuration", error);
      messageApi.error(t("settings.newsPrompts.saveFailed"));
    }
  };

  if (loading && !data?.newsPromptConfig) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
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
    "{{markdown}}",
  ];

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "0.5rem" }}>
        {t("settings.newsPrompts.description")}
      </Typography.Paragraph>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        {placeholderTokens.map((token) => (
          <Tag key={token}>{token}</Tag>
        ))}
      </div>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsPrompts.fields.version")}
          name="version"
          rules={[
            {
              required: true,
              message: t("settings.newsPrompts.validation.version"),
            },
          ]}
        >
          <Input placeholder={t("settings.newsPrompts.placeholders.version")} />
        </Form.Item>
        <Form.Item
          label={t("settings.newsPrompts.fields.systemTemplate")}
          name="systemPromptTemplate"
          rules={[
            {
              required: true,
              message: t("settings.newsPrompts.validation.systemTemplate"),
            },
          ]}
          extra={<TokenEstimateExtra name="systemPromptTemplate" />}
        >
          <Input.TextArea
            rows={5}
            placeholder={t("settings.newsPrompts.placeholders.systemTemplate")}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.newsPrompts.fields.userTemplate")}
          name="userPromptTemplate"
          rules={[
            {
              required: true,
              message: t("settings.newsPrompts.validation.userTemplate"),
            },
          ]}
          extra={<TokenEstimateExtra name="userPromptTemplate" />}
        >
          <Input.TextArea
            rows={10}
            placeholder={t("settings.newsPrompts.placeholders.userTemplate")}
          />
        </Form.Item>
        <TotalTokenEstimateText
          systemName="systemPromptTemplate"
          userName="userPromptTemplate"
        />
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
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
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [version, setVersion] = useState<AkshareGatewayVersionResponse | null>(
    null,
  );
  const [status, setStatus] =
    useState<AkshareGatewayUpgradeStatusResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const fetchVersion = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<AkshareGatewayVersionResponse>(
        "admin/akshare/version",
        {
          timeout: 10_000,
        },
      );
      setVersion(response.data);
    } catch (error) {
      captureClientError("Failed to load akshare gateway version", error);
      setErrorMessage(t("systemSettings.akshare.errors.loadVersion"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, t]);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await apiClient.get<AkshareGatewayUpgradeStatusResponse>(
        "admin/akshare/status",
        {
          timeout: 10_000,
        },
      );
      setStatus(response.data);
      return response.data;
    } catch (error) {
      captureClientError("Failed to load akshare gateway status", error);
      setStatus(null);
      setErrorMessage(t("systemSettings.akshare.errors.loadStatus"));
      return null;
    }
  }, [apiClient, t]);

  useEffect(() => {
    void fetchVersion();
    void fetchStatus();
  }, [fetchStatus, fetchVersion]);

  const handleUpgrade = useCallback(() => {
    if (status?.upgradeEnabled === false) {
      const reason =
        status.disabledReason ??
        t("systemSettings.akshare.errors.upgradeDisabled");
      messageApi.warning(reason);
      return;
    }

    Modal.confirm({
      title: t("systemSettings.akshare.modal.title"),
      content: t("systemSettings.akshare.modal.content"),
      okText: t("systemSettings.akshare.modal.confirm"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setUpgrading(true);
        setErrorMessage(null);
        try {
          const response =
            await apiClient.post<AkshareGatewayUpgradeAcceptedResponse>(
              "admin/akshare/upgrade",
              {},
              { timeout: 30_000 },
            );
          messageApi.success(
            t("systemSettings.akshare.upgradeStarted", {
              version: response.data.beforeVersion,
            }),
          );

          const requestId = response.data.requestId;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const currentStatus = await fetchStatus();
            if (currentStatus?.requestId === requestId) {
              if (currentStatus.stage === "failed") {
                const detail = currentStatus.error
                  ? `: ${currentStatus.error}`
                  : "";
                throw new Error(
                  t("systemSettings.akshare.errors.upgradeFailed") + detail,
                );
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
          const statusCode =
            typeof error === "object" && error && "response" in error
              ? (error as { response?: { status?: number } }).response?.status
              : undefined;
          if (statusCode === 409) {
            messageApi.info(t("systemSettings.akshare.errors.inProgress"));
            void fetchStatus();
            return;
          }
          if (statusCode === 503) {
            messageApi.error(t("systemSettings.akshare.errors.missingToken"));
            setErrorMessage(t("systemSettings.akshare.errors.missingToken"));
            return;
          }
          if (statusCode === 404) {
            messageApi.error(t("systemSettings.akshare.errors.noAdmin"));
            setErrorMessage(t("systemSettings.akshare.errors.noAdmin"));
            return;
          }

          captureClientError("Failed to upgrade akshare gateway", error);
          messageApi.error(t("systemSettings.akshare.errors.upgradeFailed"));
          setErrorMessage(t("systemSettings.akshare.errors.upgradeFailed"));
          throw error;
        } finally {
          setUpgrading(false);
        }
      },
    });
  }, [apiClient, fetchStatus, fetchVersion, messageApi, status, t]);

  const currentVersion = version?.akshareVersion ?? "-";
  const pythonVersion = version?.pythonVersion ?? "-";
  const stage = status?.stage ?? "unknown";
  const upgradeDisabledReason =
    status?.upgradeEnabled === false
      ? (status.disabledReason ??
        t("systemSettings.akshare.errors.upgradeDisabled"))
      : null;
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
        {t("systemSettings.akshare.description")}
      </Typography.Paragraph>

      {errorMessage ? (
        <Alert
          style={{ marginBottom: "1rem" }}
          type="error"
          message={errorMessage}
          showIcon
        />
      ) : null}

      {upgradeDisabledReason ? (
        <Alert
          style={{ marginBottom: "1rem" }}
          type="warning"
          message={upgradeDisabledReason}
          showIcon
        />
      ) : null}

      <Card
        size="small"
        title={t("systemSettings.akshare.title")}
        style={{ marginBottom: "1rem" }}
      >
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Typography.Text>{t("systemSettings.akshare.label")}</Typography.Text>
          <Tag color="blue">{currentVersion}</Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.akshare.python", { version: pythonVersion })}
          </Typography.Text>
          <Tag color={stageColor}>
            {t(`systemSettings.akshare.stage.${stage}`, {
              defaultValue: stage,
            })}
          </Tag>
          <Button onClick={() => void fetchVersion()} loading={loading}>
            {t("common.refresh")}
          </Button>
          <Button onClick={() => void fetchStatus()} disabled={loading}>
            {t("systemSettings.akshare.refreshStatus")}
          </Button>
          <Button
            type="primary"
            danger
            onClick={handleUpgrade}
            loading={upgrading}
            disabled={
              loading ||
              upgrading ||
              Boolean(status?.inProgress) ||
              status?.upgradeEnabled === false
            }
          >
            {t("systemSettings.akshare.upgrade")}
          </Button>
        </div>
        {status?.requestId ? (
          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: "0.75rem", marginBottom: 0 }}
          >
            {t("systemSettings.akshare.request", {
              requestId: status.requestId,
              before: status.beforeVersion ?? null,
              after: status.afterVersion ?? null,
            })}
          </Typography.Paragraph>
        ) : null}
        {status?.error ? (
          <Typography.Paragraph
            type="danger"
            style={{ marginTop: "0.75rem", marginBottom: 0 }}
          >
            {status.error}
          </Typography.Paragraph>
        ) : null}
      </Card>
    </>
  );
}

export function SystemSettingsContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageSettings = permissions.includes("settings.manage");
  const canReviewKnowledgeGraph = permissions.includes("knowledgegraph.review");
  const canViewSystemSettings = canManageSettings || canReviewKnowledgeGraph;

  const items = useMemo(() => {
    const allItems = [
      {
        key: "rateLimits",
        label: t("settings.tabs.rateLimits"),
        children: <RateLimitSettingsPanel />,
      },
      {
        key: "rateLimitPolicies",
        label: t("settings.tabs.rateLimitPolicies"),
        children: <RateLimitPoliciesPanel />,
      },
      {
        key: "security",
        label: t("systemSettings.tabs.security"),
        children: <SystemSecuritySettingsPanel />,
      },
      {
        key: "llmGateway",
        label: t("settings.tabs.llmGateway"),
        children: <LlmGatewaySettingsPanel />,
      },
      {
        key: "assistantSafety",
        label: t("settings.tabs.assistantSafety", {
          defaultValue: "Assistant Safety",
        }),
        children: <AssistantSafetySettingsPanel />,
      },
      {
        key: "situationMonitor",
        label: t("systemSettings.tabs.situationMonitor"),
        children: <SituationMonitorSettingsPanel />,
      },
      {
        key: "rssTranslationMetrics",
        label: t("settings.tabs.rssTranslationMetrics"),
        children: <RssTranslationMetricsPanel />,
      },
      {
        key: "rssDiagnostics",
        label: t("settings.tabs.rssDiagnostics", {
          defaultValue: "RSS Diagnostics",
        }),
        children: <RssDiagnosticsPanel />,
      },
      {
        key: "vectorService",
        label: t("systemSettings.tabs.vectorService"),
        children: <VectorServiceSettingsPanel />,
      },
      {
        key: "modelService",
        label: t("systemSettings.tabs.modelService"),
        children: <ModelServiceSettingsPanel />,
      },
      {
        key: "geoNominatim",
        label: t("systemSettings.tabs.geoNominatim"),
        children: <GeoNominatimSettingsPanel />,
      },
      {
        key: "email",
        label: t("systemSettings.tabs.email"),
        children: <EmailSettingsPanel />,
      },
      {
        key: "auditLog",
        label: t("settings.tabs.auditLog"),
        children: <AuditLogRetentionPanel />,
      },
      {
        key: "authCache",
        label: t("settings.tabs.authCache"),
        children: <AuthCacheSettingsPanel />,
      },
      {
        key: "crawlClient",
        label: t("settings.tabs.crawlClient"),
        children: <CrawlClientSettingsPanel />,
      },
      {
        key: "entityImpactGraph",
        label: t("settings.tabs.entityImpactGraph"),
        children: <EntityImpactGraphSettingsPanel />,
      },
      {
        key: "knowledgeGraph",
        label: t("settings.tabs.knowledgeGraph"),
        children: <KnowledgeGraphSettingsPanel />,
      },
      {
        key: "knowledgeGraphReview",
        label: t("settings.tabs.knowledgeGraphReview"),
        children: <KnowledgeGraphReviewPanel />,
      },
      {
        key: "newsEvents",
        label: t("settings.tabs.newsEvents"),
        children: <NewsEventsSettingsPanel />,
      },
      {
        key: "newsEventSourcePolicy",
        label: t("settings.tabs.newsEventSourcePolicy"),
        children: <NewsEventSourcePolicySettingsPanel />,
      },
      {
        key: "newsSourceScheduler",
        label: t("systemSettings.tabs.newsSourceScheduler"),
        children: <NewsSourceSchedulerSettingsPanel />,
      },
      {
        key: "newsIndicator",
        label: t("settings.tabs.newsIndicator"),
        children: <NewsIndicatorSettingsPanel />,
      },
      {
        key: "newsDedupe",
        label: t("settings.tabs.newsDedupe"),
        children: <NewsDedupeSettingsPanel />,
      },
      {
        key: "newsPrompts",
        label: t("settings.tabs.newsPrompts"),
        children: <NewsPromptSettingsPanel />,
      },
      {
        key: "akshare",
        label: t("systemSettings.tabs.akshare"),
        children: <AkshareGatewaySettingsPanel />,
      },
    ];

    if (canManageSettings) {
      return allItems;
    }

    if (canReviewKnowledgeGraph) {
      return allItems.filter((item) => item.key === "knowledgeGraphReview");
    }

    return [];
  }, [canManageSettings, canReviewKnowledgeGraph, t]);

  const defaultTabKey = items[0]?.key ?? "rateLimits";

  const activeKey = useMemo(() => {
    const candidate = searchParams.get("tab");
    if (!candidate) {
      return defaultTabKey;
    }
    const valid = new Set(items.map((item) => item.key));
    return valid.has(candidate) ? candidate : defaultTabKey;
  }, [defaultTabKey, items, searchParams]);

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!canViewSystemSettings) {
    return (
      <Card className="content-card" title={t("systemSettings.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("systemSettings.adminOnly")}
        />
      </Card>
    );
  }

  const handleTabChange = (key: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (key === defaultTabKey) {
      next.delete("tab");
    } else {
      next.set("tab", key);
    }
    const nextQuery = next.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  };

  return (
    <Card
      className="content-card"
      title={
        canManageSettings
          ? t("systemSettings.title")
          : t("settings.tabs.knowledgeGraphReview")
      }
    >
      <Typography.Paragraph type="secondary">
        {canManageSettings
          ? t("systemSettings.description")
          : t("settings.knowledgeGraphReview.description")}
      </Typography.Paragraph>
      <Tabs activeKey={activeKey} onChange={handleTabChange} items={items} />
    </Card>
  );
}
