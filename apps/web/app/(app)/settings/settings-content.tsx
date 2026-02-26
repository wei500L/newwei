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
  Switch,
  Tabs,
  Tag,
  Typography
} from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { NumberRangeExtra, TokenEstimateExtra, TotalTokenEstimateText } from "@/components/settings/form-field-feedback";
import { RateLimitPoliciesPanel } from "@/components/settings/rate-limit-policies-panel";
import { UnitInputNumber } from "@/components/settings/unit-input-number";
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
import { captureClientError } from "@/lib/client-telemetry";

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
  const { t } = useTranslation();
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
  const roles = data?.roles ?? [];
  const permissions = data?.permissions ?? [];
  const memberships = data?.memberships ?? [];
  const adminRoleIds = roles
    .filter((role) => role.name.toLowerCase() === "admin")
    .map((role) => role.id);
  const isAdmin =
    canViewSettings &&
    (adminRoleIds.length === 0 ||
      Boolean(session?.user?.roleIds?.some((roleId) => adminRoleIds.includes(roleId))));

  if (status === "loading" || (loading && canViewSettings)) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canViewSettings) {
    return (
      <Card className="content-card" title={t("settings.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

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
      messageApi.success(t("settings.roles.updated"));
    } catch (error) {
      captureClientError("Failed to update role", error);
      messageApi.error(t("settings.roles.updateFailed"));
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
      messageApi.success(t("settings.members.updated"));
    } catch (error) {
      captureClientError("Failed to update member role", error);
      messageApi.error(t("settings.members.updateFailed"));
    } finally {
      setSavingMembershipId(null);
    }
  };

  if (!isAdmin) {
    return (
      <Card className="content-card" title={t("settings.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  const tabItems = [
    {
      key: "roles",
      label: t("settings.tabs.roles"),
      children: roles.length > 0 ? (
        <RolesPanel
          roles={roles}
          permissions={permissions}
          onSave={handleRoleSave}
          savingRoleId={savingRoleId}
          updating={updatingRole}
        />
      ) : (
        <Empty description={t("settings.roles.empty")} />
      )
    },
    {
      key: "permissions",
      label: t("settings.tabs.permissions"),
      children: permissions.length > 0 ? (
        <List
          dataSource={permissions}
          renderItem={(permission) => (
            <List.Item>
              <List.Item.Meta
                title={permission.name}
                description={permission.description || t("settings.permissions.pending")}
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty description={t("settings.permissions.empty")} />
      )
    },
    {
      key: "members",
      label: t("settings.tabs.members"),
      children: memberships.length > 0 ? (
        <MembersPanel
          memberships={memberships}
          roles={roles}
          onSave={handleMembershipSave}
          savingMembershipId={savingMembershipId}
          assigning={assigningRole}
        />
      ) : (
        <Empty description={t("settings.members.empty")} />
      )
    }
  ];

  tabItems.push({
    key: "authCache",
    label: t("settings.tabs.authCache"),
    children: <AuthCacheSettingsPanel />
  });
  tabItems.push({
    key: "rateLimits",
    label: t("settings.tabs.rateLimits"),
    children: <RateLimitSettingsPanel />
  });
  tabItems.push({
    key: "rateLimitPolicies",
    label: t("settings.tabs.rateLimitPolicies"),
    children: <RateLimitPoliciesPanel />
  });
  tabItems.push({
    key: "crawlClient",
    label: t("settings.tabs.crawlClient"),
    children: <CrawlClientSettingsPanel />
  });
  tabItems.push({
    key: "auditLog",
    label: t("settings.tabs.auditLog"),
    children: <AuditLogRetentionPanel />
  });
  tabItems.push({
    key: "newsPrompts",
    label: t("settings.tabs.newsPrompts"),
    children: <NewsPromptSettingsPanel />
  });

  return (
    <Card className="content-card" title={t("settings.title")}>
      {messageContext}
      <Tabs defaultActiveKey="roles" items={tabItems} />
      <Typography.Paragraph type="secondary" style={{ marginTop: "1.5rem" }}>
        {t("settings.footerNote")}
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
  const { t } = useTranslation();
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
        {role.isSystem ? <Tag color="gold">{t("settings.roles.system")}</Tag> : null}
      </div>
      <Form.Item label={t("settings.roles.description")} name="description">
        <Input.TextArea
          rows={2}
          maxLength={240}
          disabled={isBusy}
          placeholder={t("settings.roles.descriptionPlaceholder")}
        />
      </Form.Item>
      <Form.Item
        label={t("settings.roles.permissions")}
        name="permissions"
        rules={[{ required: true, message: t("settings.roles.permissionsRequired") }]}
      >
        <Select
          mode="multiple"
          placeholder={t("settings.roles.permissionsPlaceholder")}
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
          {t("common.reset")}
        </Button>
        <Button
          type="primary"
          htmlType="submit"
          loading={saving}
          disabled={!hasChanges || isBusy}
        >
          {t("settings.roles.saveChanges")}
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
  const { t } = useTranslation();
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
        <Typography.Text type="secondary">{t("settings.members.roleAssignment")}</Typography.Text>
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
          {selectedRole?.isSystem ? <Tag color="gold">{t("settings.roles.system")}</Tag> : null}
          <Button
            type="primary"
            onClick={() => onSave(membership, selectedRoleId)}
            disabled={!hasChanges || isBusy}
            loading={saving}
          >
            {t("common.update")}
          </Button>
        </div>
      </div>
    </>
  );
}

function AuthCacheSettingsPanel() {
  const { t } = useTranslation();
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
      messageApi.success(t("settings.authCache.saved"));
    } catch (error) {
      captureClientError("Failed to save auth cache settings", error);
      messageApi.error(t("settings.authCache.saveFailed"));
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
          {t("settings.authCache.description")}
        </Typography.Paragraph>

        <div className="cache-summary">
          <Card size="small" className="cache-pill">
            <Typography.Text strong>{t("settings.authCache.summary.profileTtl")}</Typography.Text>
            <Typography.Title level={3} style={{ margin: "0.25rem 0" }}>
              {t("settings.authCache.summary.profileTtlValue", { value: ttlMinutes })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("settings.authCache.summary.profileTtlSeconds", { value: profileTtlSeconds })}
            </Typography.Text>
          </Card>
          <Card size="small" className="cache-pill" style={{ background: "linear-gradient(135deg, #ecfeff, #e0f2fe)" }}>
            <Typography.Text strong>{t("settings.authCache.summary.lockWindow")}</Typography.Text>
            <Typography.Title level={4} style={{ margin: "0.25rem 0" }}>
              {t("settings.authCache.summary.lockWindowValue", {
                lock: lockSeconds,
                wait: maxWaitSeconds
              })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("settings.authCache.summary.retryDelay", { value: retryDelayMs })}
            </Typography.Text>
          </Card>
        </div>

        <Card className="cache-card">
          <Form layout="vertical" form={form} onFinish={handleSubmit}>
            <Form.Item
              label={t("settings.authCache.fields.profileTtl")}
              name="profileTtlSeconds"
              rules={[
                { required: true, message: t("settings.authCache.validation.profileTtlRequired") },
                { type: "number", min: 60, max: 86_400 }
              ]}
              extra={t("settings.authCache.fields.profileTtlHint")}
            >
              <InputNumber min={60} max={86_400} step={30} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.authCache.fields.lockTtl")}
              name="lockTtlMs"
              rules={[
                { required: true, message: t("settings.authCache.validation.lockTtlRequired") },
                { type: "number", min: 100, max: 60_000 }
              ]}
              extra={t("settings.authCache.fields.lockTtlHint")}
            >
              <InputNumber min={100} max={60_000} step={50} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.authCache.fields.maxWait")}
              name="maxWaitMs"
              rules={[
                { required: true, message: t("settings.authCache.validation.maxWaitRequired") },
                { type: "number", min: 50, max: 120_000 }
              ]}
              extra={t("settings.authCache.fields.maxWaitHint")}
            >
              <InputNumber min={50} max={120_000} step={50} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.authCache.fields.retryDelay")}
              name="retryDelayMs"
              rules={[
                { required: true, message: t("settings.authCache.validation.retryDelayRequired") },
                { type: "number", min: 10, max: 1_000 }
              ]}
              extra={t("settings.authCache.fields.retryDelayHint")}
            >
              <InputNumber min={10} max={1_000} step={10} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <Button type="primary" htmlType="submit" loading={saving}>
                  {t("settings.authCache.save")}
                </Button>
                <Typography.Text type="secondary">
                  {t("settings.authCache.saveHint")}
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
  const { t } = useTranslation();
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
      messageApi.success(t("settings.rateLimits.saved"));
    } catch (error) {
      captureClientError("Failed to save rate limits", error);
      messageApi.error(t("settings.rateLimits.saveFailed"));
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
      <Alert
        type="warning"
        showIcon
        message={t("settings.rateLimits.riskTitle")}
        description={
          <span>
            {t("settings.rateLimits.riskDescription")}{" "}
            <Link href="/admin/audit-logs">{t("settings.rateLimits.auditLink")}</Link>
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

function CrawlClientSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<UpdateCrawlClientSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useCrawlClientSettingsQuery();
  const [updateSettings, { loading: saving }] = useUpdateCrawlClientSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();
  const adaptiveConcurrencyEnabled =
    Form.useWatch("adaptiveConcurrencyEnabled", form) ??
    data?.crawlClientSettings?.adaptiveConcurrencyEnabled ??
    false;

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
      messageApi.success(t("settings.crawlClient.saved"));
    } catch (error) {
      captureClientError("Failed to save crawl client settings", error);
      messageApi.error(t("settings.crawlClient.saveFailed"));
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
        {t("settings.crawlClient.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.crawlClient.fields.healthCheckTtl")}
          name="healthCheckTtlMs"
          rules={[
            { required: true, message: t("settings.crawlClient.validation.healthCheckTtl") },
            { type: "number", min: 5_000, max: 900_000, message: t("common.validation.numberRange", { min: 5_000, max: 900_000 }) }
          ]}
          extra={<NumberRangeExtra name="healthCheckTtlMs" min={5_000} max={900_000} unit="ms" />}
        >
          <UnitInputNumber min={5_000} max={900_000} step={1_000} unit="ms" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.requestTimeoutHot", {
            defaultValue: "Hot request timeout"
          })}
          name="requestTimeoutHotMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.requestTimeoutHot", {
                defaultValue: "Please enter hot request timeout."
              })
            },
            { type: "number", min: 5_000, max: 900_000, message: t("common.validation.numberRange", { min: 5_000, max: 900_000 }) }
          ]}
          extra={<NumberRangeExtra name="requestTimeoutHotMs" min={5_000} max={900_000} unit="ms" />}
        >
          <UnitInputNumber min={5_000} max={900_000} step={1_000} unit="ms" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.requestTimeoutNormal", {
            defaultValue: "Normal request timeout"
          })}
          name="requestTimeoutNormalMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.requestTimeoutNormal", {
                defaultValue: "Please enter normal request timeout."
              })
            },
            { type: "number", min: 5_000, max: 900_000, message: t("common.validation.numberRange", { min: 5_000, max: 900_000 }) }
          ]}
          extra={<NumberRangeExtra name="requestTimeoutNormalMs" min={5_000} max={900_000} unit="ms" />}
        >
          <UnitInputNumber min={5_000} max={900_000} step={1_000} unit="ms" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.detailPublishSignalHeadFetchTimeout", {
            defaultValue: "Detail publish-signal head fetch timeout"
          })}
          name="detailPublishSignalHeadFetchTimeoutMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.detailPublishSignalHeadFetchTimeout", {
                defaultValue: "Please enter detail publish-signal head fetch timeout."
              })
            },
            { type: "number", min: 500, max: 10_000, message: t("common.validation.numberRange", { min: 500, max: 10_000 }) }
          ]}
          extra={<NumberRangeExtra name="detailPublishSignalHeadFetchTimeoutMs" min={500} max={10_000} unit="ms" />}
        >
          <UnitInputNumber min={500} max={10_000} step={100} unit="ms" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.detailPublishSignalHeadFetchConcurrency", {
            defaultValue: "Detail publish-signal head fetch concurrency"
          })}
          name="detailPublishSignalHeadFetchConcurrency"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.detailPublishSignalHeadFetchConcurrency", {
                defaultValue: "Please enter detail publish-signal head fetch concurrency."
              })
            },
            { type: "number", min: 1, max: 8, message: t("common.validation.numberRange", { min: 1, max: 8 }) }
          ]}
          extra={<NumberRangeExtra name="detailPublishSignalHeadFetchConcurrency" min={1} max={8} />}
        >
          <InputNumber min={1} max={8} step={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.detailPublishSignalHeadFetchMaxReadBytes", {
            defaultValue: "Detail publish-signal head fetch max read bytes"
          })}
          name="detailPublishSignalHeadFetchMaxReadBytes"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.detailPublishSignalHeadFetchMaxReadBytes", {
                defaultValue: "Please enter detail publish-signal head fetch max read bytes."
              })
            },
            { type: "number", min: 1_048_576, max: 64_000_000, message: t("common.validation.numberRange", { min: 1_048_576, max: 64_000_000 }) }
          ]}
          extra={<NumberRangeExtra name="detailPublishSignalHeadFetchMaxReadBytes" min={1_048_576} max={64_000_000} unit="B" />}
        >
          <UnitInputNumber min={1_048_576} max={64_000_000} step={262_144} unit="B" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.maxAttempts")}
          name="maxRetries"
          rules={[
            { required: true, message: t("settings.crawlClient.validation.maxAttempts") },
            { type: "number", min: 1, max: 10, message: t("common.validation.numberRange", { min: 1, max: 10 }) }
          ]}
          extra={<NumberRangeExtra name="maxRetries" min={1} max={10} />}
        >
          <InputNumber min={1} max={10} step={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.retryBackoff")}
          name="retryBackoffMs"
          rules={[
            { required: true, message: t("settings.crawlClient.validation.retryBackoff") },
            { type: "number", min: 500, max: 600_000, message: t("common.validation.numberRange", { min: 500, max: 600_000 }) }
          ]}
          extra={<NumberRangeExtra name="retryBackoffMs" min={500} max={600_000} unit="ms" />}
        >
          <UnitInputNumber min={500} max={600_000} step={500} unit="ms" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.queueOverloadCooldown", {
            defaultValue: "Queue overload cooldown"
          })}
          name="queueOverloadCooldownMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.queueOverloadCooldown", {
                defaultValue: "Please enter queue overload cooldown."
              })
            },
            { type: "number", min: 5_000, max: 600_000, message: t("common.validation.numberRange", { min: 5_000, max: 600_000 }) }
          ]}
          extra={<NumberRangeExtra name="queueOverloadCooldownMs" min={5_000} max={600_000} unit="ms" />}
        >
          <UnitInputNumber min={5_000} max={600_000} step={1_000} unit="ms" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.adaptiveConcurrency", {
            defaultValue: "Adaptive concurrency"
          })}
          name="adaptiveConcurrencyEnabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          {adaptiveConcurrencyEnabled
            ? t("settings.crawlClient.hints.adaptiveEnabled", {
                defaultValue:
                  "Adaptive mode is enabled. Window and threshold fields below are active."
              })
            : t("settings.crawlClient.hints.adaptiveDisabled", {
                defaultValue:
                  "Adaptive mode is disabled. Enable it to configure window and threshold fields."
              })}
        </Typography.Paragraph>
        {adaptiveConcurrencyEnabled ? (
          <>
            <Form.Item
              label={t("settings.crawlClient.fields.adaptiveWindowMinutes", {
                defaultValue: "Adaptive window"
              })}
              name="adaptiveWindowMinutes"
              rules={[
                {
                  required: true,
                  message: t("settings.crawlClient.validation.adaptiveWindowMinutes", {
                    defaultValue: "Please enter adaptive window in minutes."
                  })
                },
                { type: "number", min: 1, max: 180, message: t("common.validation.numberRange", { min: 1, max: 180 }) }
              ]}
              extra={<NumberRangeExtra name="adaptiveWindowMinutes" min={1} max={180} unit="min" />}
            >
              <UnitInputNumber min={1} max={180} step={1} unit="min" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.crawlClient.fields.adaptiveCooldownMinutes", {
                defaultValue: "Adaptive cooldown"
              })}
              name="adaptiveCooldownMinutes"
              rules={[
                {
                  required: true,
                  message: t("settings.crawlClient.validation.adaptiveCooldownMinutes", {
                    defaultValue: "Please enter adaptive cooldown in minutes."
                  })
                },
                { type: "number", min: 1, max: 60, message: t("common.validation.numberRange", { min: 1, max: 60 }) }
              ]}
              extra={<NumberRangeExtra name="adaptiveCooldownMinutes" min={1} max={60} unit="min" />}
            >
              <UnitInputNumber min={1} max={60} step={1} unit="min" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.crawlClient.fields.adaptiveLatencyThresholdRatio", {
                defaultValue: "Adaptive latency threshold"
              })}
              name="adaptiveLatencyThresholdRatio"
              rules={[
                {
                  required: true,
                  message: t("settings.crawlClient.validation.adaptiveLatencyThresholdRatio", {
                    defaultValue: "Please enter adaptive latency threshold ratio."
                  })
                },
                {
                  type: "number",
                  min: 0.01,
                  max: 0.99,
                  message: t("common.validation.numberRange", { min: 0.01, max: 0.99 })
                }
              ]}
            >
              <InputNumber min={0.01} max={0.99} step={0.01} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.crawlClient.fields.adaptiveErrorRateThreshold", {
                defaultValue: "Adaptive error-rate threshold"
              })}
              name="adaptiveErrorRateThreshold"
              rules={[
                {
                  required: true,
                  message: t("settings.crawlClient.validation.adaptiveErrorRateThreshold", {
                    defaultValue: "Please enter adaptive error-rate threshold ratio."
                  })
                },
                {
                  type: "number",
                  min: 0.01,
                  max: 0.99,
                  message: t("common.validation.numberRange", { min: 0.01, max: 0.99 })
                }
              ]}
            >
              <InputNumber min={0.01} max={0.99} step={0.01} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("settings.crawlClient.fields.adaptiveMemoryHeadroomThreshold", {
                defaultValue: "Adaptive memory headroom threshold"
              })}
              name="adaptiveMemoryHeadroomThreshold"
              rules={[
                {
                  required: true,
                  message: t("settings.crawlClient.validation.adaptiveMemoryHeadroomThreshold", {
                    defaultValue: "Please enter adaptive memory headroom threshold ratio."
                  })
                },
                {
                  type: "number",
                  min: 0.01,
                  max: 0.99,
                  message: t("common.validation.numberRange", { min: 0.01, max: 0.99 })
                }
              ]}
            >
              <InputNumber min={0.01} max={0.99} step={0.01} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          </>
        ) : null}
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("settings.crawlClient.save")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

function AuditLogRetentionPanel() {
  const { t } = useTranslation();
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
      messageApi.success(t("settings.auditLog.saved"));
    } catch (error) {
      captureClientError("Failed to update audit log retention", error);
      messageApi.error(t("settings.auditLog.saveFailed"));
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
        {t("settings.auditLog.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Card size="small" style={{ marginBottom: "1rem" }} title={t("settings.auditLog.retentionTitle")}>
          <Typography.Paragraph type="secondary">
            {t("settings.auditLog.retentionHint")}
          </Typography.Paragraph>
	          <Form.Item
	            label={t("settings.auditLog.fields.retentionDays")}
	            name="retentionDays"
	            rules={[
	              { required: true, message: t("settings.auditLog.validation.retentionRequired") },
	              { type: "number", min: 1, max: 3650, message: t("settings.auditLog.validation.retentionRange") }
	            ]}
	            extra={<NumberRangeExtra name="retentionDays" min={1} max={3650} />}
	          >
	            <InputNumber min={1} max={3650} />
	          </Form.Item>
        </Card>
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
  const [form] = Form.useForm<UpdateNewsPromptConfigMutationVariables["input"]>();
  const { data, loading, refetch } = useNewsPromptConfigQuery();
  const [updateConfig, { loading: saving }] = useUpdateNewsPromptConfigMutation();
  const [messageApi, contextHolder] = message.useMessage();

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
      messageApi.success(t("settings.newsPrompts.saved"));
    } catch (error) {
      captureClientError("Failed to save prompt configuration", error);
      messageApi.error(t("settings.newsPrompts.saveFailed"));
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
        {t("settings.newsPrompts.description")}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: "0.5rem" }}>
        {t("settings.newsPrompts.placeholdersTitle")}
      </Typography.Paragraph>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
        {placeholderTokens.map((token) => (
          <Tag key={token}>{token}</Tag>
        ))}
      </div>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsPrompts.fields.version")}
          name="version"
          rules={[{ required: true, message: t("settings.newsPrompts.validation.version") }]}
        >
          <Input placeholder={t("settings.newsPrompts.placeholders.version")} />
        </Form.Item>
        <Form.Item
          label={t("settings.newsPrompts.fields.systemTemplate")}
          name="systemPromptTemplate"
          rules={[{ required: true, message: t("settings.newsPrompts.validation.systemTemplate") }]}
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
          rules={[{ required: true, message: t("settings.newsPrompts.validation.userTemplate") }]}
          extra={<TokenEstimateExtra name="userPromptTemplate" />}
        >
          <Input.TextArea
            rows={10}
            placeholder={t("settings.newsPrompts.placeholders.userTemplate")}
          />
        </Form.Item>
        <TotalTokenEstimateText systemName="systemPromptTemplate" userName="userPromptTemplate" />
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
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
  const { t } = useTranslation();
  return (
    <Card size="small" style={{ marginBottom: "1rem" }} title={title}>
      <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
      <div style={{ display: "flex", gap: "1rem" }}>
        <Form.Item
          label={t("settings.rateLimits.fields.maxAttempts")}
          name={[field, "limit"]}
          rules={[
            { required: true, message: t("settings.rateLimits.validation.maxAttempts") },
            { type: "number", min: 1, max: 1000, message: t("common.validation.numberRange", { min: 1, max: 1000 }) }
          ]}
          extra={<NumberRangeExtra name={[field, "limit"]} min={1} max={1000} />}
        >
          <InputNumber min={1} max={1000} />
        </Form.Item>
        <Form.Item
          label={t("settings.rateLimits.fields.windowSeconds")}
          name={[field, "windowSeconds"]}
          rules={[
            { required: true, message: t("settings.rateLimits.validation.windowSeconds") },
            { type: "number", min: 5, max: 86_400, message: t("common.validation.numberRange", { min: 5, max: 86_400 }) }
          ]}
          extra={<NumberRangeExtra name={[field, "windowSeconds"]} min={5} max={86_400} unit="s" />}
        >
          <UnitInputNumber min={5} max={86_400} unit="s" />
        </Form.Item>
      </div>
    </Card>
  );
}
