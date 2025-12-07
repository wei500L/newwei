"use client";

import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
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
  useAuthCacheSettingsQuery,
  useCrawlClientSettingsQuery,
  useNewsPromptConfigQuery,
  useRateLimitSettingsQuery,
  useRbacOverviewQuery,
  useUpdateAuditLogRetentionMutation,
  useUpdateAuthCacheSettingsMutation,
  useUpdateCrawlClientSettingsMutation,
  useUpdateNewsPromptConfigMutation,
  useUpdateRateLimitSettingsMutation,
  useAssignRoleMutation,
  useUpdateRoleMutation
} from "@/graphql/generated";
import type {
  UpdateAuditLogRetentionMutationVariables,
  UpdateAuthCacheSettingsMutationVariables,
  UpdateCrawlClientSettingsMutationVariables,
  UpdateNewsPromptConfigMutationVariables,
  UpdateRateLimitSettingsMutationVariables,
  AssignRoleMutationVariables,
  UpdateRoleMutationVariables,
  RbacOverviewQuery
} from "@/graphql/generated";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
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

type RoleListItem = RbacOverviewQuery["roles"][number];
type PermissionListItem = RbacOverviewQuery["permissions"][number];
type MembershipListItem = RbacOverviewQuery["memberships"][number];
type RoleFormValues = Omit<UpdateRoleMutationVariables["input"], "id">;

function haveSameMembers(a: string[], b: string[]) {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function SettingsContent() {
  const { data: session, status } = useSession();
  const [messageApi, messageContext] = message.useMessage();
  const canViewSettings = session?.permissions?.includes("settings.manage") ?? false;
  const { data, loading, refetch } = useRbacOverviewQuery({
    skip: !canViewSettings
  });
  const [assignRoleMutation, { loading: assigningRole }] = useAssignRoleMutation();
  const [updateRoleMutation, { loading: updatingRole }] = useUpdateRoleMutation();
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [savingMembershipId, setSavingMembershipId] = useState<string | null>(null);

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

  const handleRoleSave = async (roleId: string, values: RoleFormValues) => {
    setSavingRoleId(roleId);
    try {
      await updateRoleMutation({
        variables: {
          input: {
            id: roleId,
            description: values.description,
            permissions: values.permissions
          }
        }
      });
      await refetch();
      messageApi.success("Role updated");
    } catch (error) {
      captureClientError("Failed to update role", error);
      messageApi.error("Failed to update role");
    } finally {
      setSavingRoleId(null);
    }
  };

  const handleMembershipSave = async (
    membership: MembershipListItem,
    roleId: AssignRoleMutationVariables["input"]["roleId"]
  ) => {
    setSavingMembershipId(membership.id);
    try {
      await assignRoleMutation({
        variables: {
          input: {
            userId: membership.user.id,
            roleId
          }
        }
      });
      await refetch();
      messageApi.success("Member role updated");
    } catch (error) {
      captureClientError("Failed to update member role", error);
      messageApi.error("Failed to update member role");
    } finally {
      setSavingMembershipId(null);
    }
  };

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
        <RolesPanel
          roles={roles}
          permissions={permissions}
          onSave={handleRoleSave}
          savingRoleId={savingRoleId}
          updating={updatingRole}
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
        <MembersPanel
          memberships={memberships}
          roles={roles}
          onSave={handleMembershipSave}
          savingMembershipId={savingMembershipId}
          assigning={assigningRole}
        />
      ) : (
        <Empty description="No members assigned" />
      )
    }
  ];

  tabItems.push({
    key: "authCache",
    label: "Auth Cache",
    children: <AuthCacheSettingsPanel />
  });
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
      {messageContext}
      <Tabs defaultActiveKey="roles" items={tabItems} />
      <Typography.Paragraph type="secondary" style={{ marginTop: "1.5rem" }}>
        Make changes directly from this page. RBAC updates are saved instantly and enforced across the
        platform.
      </Typography.Paragraph>
    </Card>
  );
}

function RolesPanel({
  roles,
  permissions,
  onSave,
  savingRoleId,
  updating
}: {
  roles: RoleListItem[];
  permissions: PermissionListItem[];
  onSave: (roleId: string, values: RoleFormValues) => Promise<void>;
  savingRoleId: string | null;
  updating: boolean;
}) {
  const sortedPermissions = useMemo(
    () => [...permissions].sort((a, b) => a.name.localeCompare(b.name)),
    [permissions]
  );

  return (
    <List
      dataSource={roles}
      renderItem={(role) => (
        <List.Item key={role.id}>
          <RoleInlineEditor
            role={role}
            permissions={sortedPermissions}
            onSave={onSave}
            saving={savingRoleId === role.id}
            updating={updating}
          />
        </List.Item>
      )}
    />
  );
}

function RoleInlineEditor({
  role,
  permissions,
  onSave,
  saving,
  updating
}: {
  role: RoleListItem;
  permissions: PermissionListItem[];
  onSave: (roleId: string, values: RoleFormValues) => Promise<void>;
  saving: boolean;
  updating: boolean;
}) {
  const [form] = Form.useForm<RoleFormValues>();
  const initialValues = useMemo(
    () => ({
      description: role.description ?? "",
      permissions: role.permissions.map((permission) => permission.name)
    }),
    [role.description, role.permissions]
  );

  useEffect(() => {
    form.setFieldsValue(initialValues);
  }, [form, initialValues]);

  const currentPermissions =
    Form.useWatch("permissions", form) ?? initialValues.permissions;
  const currentDescription =
    Form.useWatch("description", form) ?? initialValues.description ?? "";
  const isLocked = role.isSystem;
  const isBusy = isLocked || updating || saving;
  const hasChanges =
    !isLocked &&
    (currentDescription !== (role.description ?? "") ||
      !haveSameMembers(currentPermissions, initialValues.permissions));

  const handleReset = () => form.setFieldsValue(initialValues);

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initialValues}
      onFinish={(values) => onSave(role.id, values)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.25rem"
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          {role.name}
        </Typography.Title>
        {role.isSystem ? <Tag color="gold">System</Tag> : null}
      </div>
      <Form.Item label="Description" name="description">
        <Input.TextArea
          rows={2}
          maxLength={240}
          disabled={isBusy}
          placeholder="Add a short summary for this role"
        />
      </Form.Item>
      <Form.Item
        label="Permissions"
        name="permissions"
        rules={[{ required: true, message: "Select at least one permission" }]}
      >
        <Select
          mode="multiple"
          placeholder="Select permissions"
          optionFilterProp="label"
          options={permissions.map((permission) => ({
            label: `${permission.name}${
              permission.description ? ` — ${permission.description}` : ""
            }`,
            value: permission.name
          }))}
          disabled={isBusy}
        />
      </Form.Item>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
        <Button onClick={handleReset} disabled={!hasChanges || isBusy}>
          Reset
        </Button>
        <Button
          type="primary"
          htmlType="submit"
          loading={saving}
          disabled={!hasChanges || isBusy}
        >
          Save changes
        </Button>
      </div>
    </Form>
  );
}

function MembersPanel({
  memberships,
  roles,
  onSave,
  savingMembershipId,
  assigning
}: {
  memberships: MembershipListItem[];
  roles: RoleListItem[];
  onSave: (membership: MembershipListItem, roleId: string) => Promise<void>;
  savingMembershipId: string | null;
  assigning: boolean;
}) {
  return (
    <List
      dataSource={memberships}
      renderItem={(membership) => (
        <List.Item key={membership.id}>
          <MemberInlineEditor
            membership={membership}
            roles={roles}
            onSave={onSave}
            saving={savingMembershipId === membership.id}
            assigning={assigning}
          />
        </List.Item>
      )}
    />
  );
}

function MemberInlineEditor({
  membership,
  roles,
  onSave,
  saving,
  assigning
}: {
  membership: MembershipListItem;
  roles: RoleListItem[];
  onSave: (membership: MembershipListItem, roleId: string) => Promise<void>;
  saving: boolean;
  assigning: boolean;
}) {
  const [selectedRoleId, setSelectedRoleId] = useState<string>(membership.role.id);
  const roleOptions = useMemo(
    () =>
      roles.map((role) => ({
        value: role.id,
        label: role.name,
        isSystem: role.isSystem,
        description: role.description
      })),
    [roles]
  );

  useEffect(() => {
    setSelectedRoleId(membership.role.id);
  }, [membership.role.id]);

  const selectedRole = roleOptions.find((role) => role.value === selectedRoleId);
  const noRolesAvailable = roles.length === 0;
  const hasChanges = !noRolesAvailable && selectedRoleId !== membership.role.id;
  const isBusy = saving || assigning || noRolesAvailable;

  return (
    <>
      <List.Item.Meta
        title={`${membership.user.firstName} ${membership.user.lastName}`}
        description={`${membership.user.email} • ${membership.role.name}`}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
        <Typography.Text type="secondary">Role assignment</Typography.Text>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Select
            value={selectedRoleId}
            onChange={setSelectedRoleId}
            style={{ minWidth: "220px" }}
            options={roleOptions.map((option) => ({
              label: option.label,
              value: option.value,
              title: option.description ?? undefined
            }))}
            optionFilterProp="label"
            disabled={isBusy}
          />
          {selectedRole?.isSystem ? <Tag color="gold">System</Tag> : null}
          <Button
            type="primary"
            onClick={() => onSave(membership, selectedRoleId)}
            disabled={!hasChanges || isBusy}
            loading={saving}
          >
            Update
          </Button>
        </div>
      </div>
    </>
  );
}

function AuthCacheSettingsPanel() {
  const [form] = Form.useForm<UpdateAuthCacheSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useAuthCacheSettingsQuery();
  const [updateSettings, { loading: saving }] = useUpdateAuthCacheSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  const profileTtlSeconds =
    Form.useWatch("profileTtlSeconds", form) ??
    data?.authCacheSettings?.profileTtlSeconds ??
    0;
  const lockTtlMs =
    Form.useWatch("lockTtlMs", form) ?? data?.authCacheSettings?.lockTtlMs ?? 0;
  const maxWaitMs =
    Form.useWatch("maxWaitMs", form) ?? data?.authCacheSettings?.maxWaitMs ?? 0;
  const retryDelayMs =
    Form.useWatch("retryDelayMs", form) ?? data?.authCacheSettings?.retryDelayMs ?? 0;

  useEffect(() => {
    if (data?.authCacheSettings) {
      form.setFieldsValue(data.authCacheSettings);
    }
  }, [data?.authCacheSettings, form]);

  const handleSubmit = async (values: UpdateAuthCacheSettingsMutationVariables["input"]) => {
    try {
      await updateSettings({
        variables: { input: values }
      });
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

  const ttlMinutes = Math.max(1, Math.round(profileTtlSeconds / 60));
  const lockSeconds = Math.max(1, Math.round(lockTtlMs / 1000));
  const maxWaitSeconds = Math.max(1, Math.round(maxWaitMs / 1000));

  return (
    <>
      {contextHolder}
      <div className="settings-entrance">
        <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
          Tune profile cache TTL and stampede protection without redeploys. Longer TTLs lower DB
          pressure; locks keep a single request responsible for rebuilding the cache.
        </Typography.Paragraph>

        <div className="cache-summary">
          <Card size="small" className="cache-pill">
            <Typography.Text strong>Profile TTL</Typography.Text>
            <Typography.Title level={3} style={{ margin: "0.25rem 0" }}>
              {ttlMinutes} min
            </Typography.Title>
            <Typography.Text type="secondary">{profileTtlSeconds} seconds</Typography.Text>
          </Card>
          <Card size="small" className="cache-pill" style={{ background: "linear-gradient(135deg, #ecfeff, #e0f2fe)" }}>
            <Typography.Text strong>Lock window</Typography.Text>
            <Typography.Title level={4} style={{ margin: "0.25rem 0" }}>
              {lockSeconds}s lock / {maxWaitSeconds}s wait
            </Typography.Title>
            <Typography.Text type="secondary">
              Retry delay {retryDelayMs}ms to smooth bursts
            </Typography.Text>
          </Card>
        </div>

        <Card className="cache-card">
          <Form layout="vertical" form={form} onFinish={handleSubmit}>
            <Form.Item
              label="Profile cache TTL (seconds)"
              name="profileTtlSeconds"
              rules={[
                { required: true, message: "Please set a cache TTL" },
                { type: "number", min: 60, max: 86_400 }
              ]}
              extra="Aim for 5–10 minutes in production; shorten temporarily when debugging profile changes."
            >
              <InputNumber min={60} max={86_400} step={30} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="Lock TTL (ms)"
              name="lockTtlMs"
              rules={[
                { required: true, message: "Please set a lock TTL" },
                { type: "number", min: 100, max: 60_000 }
              ]}
              extra="How long a worker holds the rebuild lock. Keep this just above the 99th percentile profile query time."
            >
              <InputNumber min={100} max={60_000} step={50} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="Max wait for lock (ms)"
              name="maxWaitMs"
              rules={[
                { required: true, message: "Please set a max wait" },
                { type: "number", min: 50, max: 120_000 }
              ]}
              extra="How long other callers wait before giving up and rebuilding themselves."
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
              extra="Short delays reduce lock churn at peak load."
            >
              <InputNumber min={10} max={1_000} step={10} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <Button type="primary" htmlType="submit" loading={saving}>
                  Save auth cache settings
                </Button>
                <Typography.Text type="secondary">
                  Saves apply instantly; caches will refresh on the next miss.
                </Typography.Text>
              </div>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </>
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
