"use client";

import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Alert,
  List,
  message,
  Spin,
  Tabs,
  Tag,
  Typography
} from "antd";
import {
  useAuditLogRetentionQuery,
  useCrawlClientSettingsQuery,
  useNewsPromptConfigQuery,
  useRateLimitSettingsQuery,
  useRbacOverviewQuery,
  useUpdateAuditLogRetentionMutation,
  useUpdateCrawlClientSettingsMutation,
  useUpdateNewsPromptConfigMutation,
  useUpdateRateLimitSettingsMutation
} from "@/graphql/generated";
import type {
  UpdateAuditLogRetentionMutationVariables,
  UpdateCrawlClientSettingsMutationVariables,
  UpdateNewsPromptConfigMutationVariables,
  UpdateRateLimitSettingsMutationVariables
} from "@/graphql/generated";
import { useSession } from "next-auth/react";
import { useEffect, useMemo } from "react";
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

export function SettingsContent() {
  const { data: session, status } = useSession();
  const canViewSettings = session?.permissions?.includes("settings.manage") ?? false;
  const { data, loading } = useRbacOverviewQuery({
    skip: !canViewSettings
  });

  if (status === "loading" || (loading && canViewSettings)) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canViewSettings) {
    return (
      <Card className="content-card" title="Organization Settings">
        <Alert
          type="warning"
          message="Admins only"
          description="Only administrators can view and change organization settings."
        />
      </Card>
    );
  }

  const roles = data?.roles ?? [];
  const permissions = data?.permissions ?? [];
  const memberships = data?.memberships ?? [];
  const adminRoleIds = useMemo(
    () => roles.filter((role) => role.name.toLowerCase() === "admin").map((role) => role.id),
    [roles]
  );
  const isAdmin = useMemo(
    () => {
      if (!canViewSettings) {
        return false;
      }
      if (adminRoleIds.length === 0) {
        return true;
      }
      return Boolean(session?.user?.roleIds?.some((roleId) => adminRoleIds.includes(roleId)));
    },
    [adminRoleIds, canViewSettings, session?.user?.roleIds]
  );

  if (!isAdmin) {
    return (
      <Card className="content-card" title="Organization Settings">
        <Alert
          type="warning"
          message="Admins only"
          description="Only administrators can view and change organization settings."
        />
      </Card>
    );
  }

  const tabItems = [
    {
      key: "roles",
      label: "Roles",
      children: roles.length > 0 ? (
        <List
          dataSource={roles}
          renderItem={(role) => (
            <List.Item>
              <List.Item.Meta
                title={role.name}
                description={
                  <div>
                    <Typography.Paragraph type="secondary">
                      {role.description || "No description provided."}
                    </Typography.Paragraph>
                    <div>
                      {role.permissions.map((permission) => (
                        <Tag key={permission.id}>{permission.name}</Tag>
                      ))}
                    </div>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty description="No roles configured yet" />
      )
    },
    {
      key: "permissions",
      label: "Permissions",
      children: permissions.length > 0 ? (
        <List
          dataSource={permissions}
          renderItem={(permission) => (
            <List.Item>
              <List.Item.Meta
                title={permission.name}
                description={permission.description || "Pending documentation."}
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty description="No permissions found" />
      )
    },
    {
      key: "members",
      label: "Members",
      children: memberships.length > 0 ? (
        <List
          dataSource={memberships}
          renderItem={(member) => (
            <List.Item>
              <List.Item.Meta
                title={`${member.user.firstName} ${member.user.lastName}`}
                description={`${member.user.email} • ${member.role.name}`}
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty description="No members assigned" />
      )
    }
  ];

  tabItems.push({
    key: "rateLimits",
    label: "Rate Limits",
    children: <RateLimitSettingsPanel />
  });
  tabItems.push({
    key: "crawlClient",
    label: "Crawl Client",
    children: <CrawlClientSettingsPanel />
  });
  tabItems.push({
    key: "auditLog",
    label: "Audit Log",
    children: <AuditLogRetentionPanel />
  });
  tabItems.push({
    key: "newsPrompts",
    label: "News Pipeline Prompts",
    children: <NewsPromptSettingsPanel />
  });

  return (
    <Card className="content-card" title="Organization Settings">
      <Tabs defaultActiveKey="roles" items={tabItems} />
      <Typography.Paragraph type="secondary" style={{ marginTop: "1.5rem" }}>
        TODO: add inline editing for role assignments and permission bundles. Hook into audit trail to
        visualize configuration drift over time.
      </Typography.Paragraph>
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
      await updateRateLimitSettings({
        variables: {
          input: values
        }
      });
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
      await updateSettings({
        variables: { input: values }
      });
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
            Save crawl settings
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
      await updateRetention({
        variables: { input: values }
      });
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
        Control how long audit trail entries are retained before automatic cleanup. Use a shorter
        window to reduce storage costs while keeping enough history for investigations.
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Card size="small" style={{ marginBottom: "1rem" }} title="Retention">
          <Typography.Paragraph type="secondary">
            Old records are purged nightly at 01:00. Minimum retention is 1 day.
          </Typography.Paragraph>
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
        </Card>
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
      await updateConfig({
        variables: { input: values }
      });
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
        Update the prompt version and templates without restarting services. Changes apply to new
        pipeline runs immediately.
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: "0.5rem" }}>
        Supported placeholders for templates:
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
          <Input.TextArea
            rows={5}
            placeholder="You are part of a news normalization pipeline that outputs structured JSON..."
          />
        </Form.Item>
        <Form.Item
          label="User prompt template"
          name="userPromptTemplate"
          rules={[{ required: true, message: "Please provide a user prompt template" }]}
          extra={`Estimated tokens: ${userTokens}`}
        >
          <Input.TextArea
            rows={10}
            placeholder={`URL: {{url}}\nCache hit: {{cache_hit}}\nMetadata: {...}\nClean this markdown while keeping only the newsworthy sections:\n{{markdown}}`}
          />
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
