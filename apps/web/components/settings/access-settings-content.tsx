"use client";

import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Select,
  List,
  message,
  Spin,
  Tag,
  Typography,
} from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  buildAdminSettingsPanelSelectionHref,
  getAdminSettingsPanelDescriptionKey,
} from "@/lib/admin-settings-panel-links";
import type {
  AssignRoleMutationVariables,
  UpdateRoleMutationVariables,
  RbacOverviewQuery,
} from "@/graphql/generated";
import {
  useRbacOverviewQuery,
  useAssignRoleMutation,
  useUpdateRoleMutation,
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

export function AccessSettingsContent() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const [messageApi, messageContext] = message.useMessage();
  const canViewSettings =
    session?.permissions?.includes("settings.manage") ?? false;
  const { data, loading, refetch } = useRbacOverviewQuery({
    skip: !canViewSettings,
  });
  const [assignRoleMutation, { loading: assigningRole }] =
    useAssignRoleMutation();
  const [updateRoleMutation, { loading: updatingRole }] =
    useUpdateRoleMutation();
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [savingMembershipId, setSavingMembershipId] = useState<string | null>(
    null,
  );
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const roles = data?.roles ?? [];
  const permissions = data?.permissions ?? [];
  const memberships = data?.memberships ?? [];
  const adminRoleIds = roles
    .filter((role) => role.name.toLowerCase() === "admin")
    .map((role) => role.id);
  const isAdmin =
    canViewSettings &&
    (adminRoleIds.length === 0 ||
      Boolean(
        session?.user?.roleIds?.some((roleId) => adminRoleIds.includes(roleId)),
      ));

  const handleRoleSave = async (roleId: string, values: RoleFormValues) => {
    setSavingRoleId(roleId);
    try {
      await updateRoleMutation({
        variables: {
          input: {
            id: roleId,
            description: values.description,
            permissions: values.permissions,
          },
        },
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
    roleId: AssignRoleMutationVariables["input"]["roleId"],
  ) => {
    setSavingMembershipId(membership.id);
    try {
      await assignRoleMutation({
        variables: {
          input: {
            userId: membership.user.id,
            roleId,
          },
        },
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

  const sections = [
    {
      key: "roles",
      title: t("settings.tabs.roles"),
      description: t(getAdminSettingsPanelDescriptionKey("roles"), {
        defaultValue:
          "Define permission bundles for administrators and operators.",
      }),
      content:
        roles.length > 0 ? (
          <RolesPanel
            roles={roles}
            permissions={permissions}
            onSave={handleRoleSave}
            savingRoleId={savingRoleId}
            updating={updatingRole}
          />
        ) : (
          <Empty description={t("settings.roles.empty")} />
        ),
    },
    {
      key: "permissions",
      title: t("settings.tabs.permissions"),
      description: t(getAdminSettingsPanelDescriptionKey("permissions"), {
        defaultValue:
          "Inspect the full permission catalog available to this workspace.",
      }),
      content:
        permissions.length > 0 ? (
          <List
            dataSource={permissions}
            renderItem={(permission) => (
              <List.Item>
                <List.Item.Meta
                  title={permission.name}
                  description={
                    permission.description || t("settings.permissions.pending")
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description={t("settings.permissions.empty")} />
        ),
    },
    {
      key: "members",
      title: t("settings.tabs.members"),
      description: t(getAdminSettingsPanelDescriptionKey("members"), {
        defaultValue:
          "Assign roles to members and verify who currently has access.",
      }),
      content:
        memberships.length > 0 ? (
          <MembersPanel
            memberships={memberships}
            roles={roles}
            onSave={handleMembershipSave}
            savingMembershipId={savingMembershipId}
            assigning={assigningRole}
          />
        ) : (
          <Empty description={t("settings.members.empty")} />
        ),
    },
  ];

  const selectedPanel = (() => {
    const candidate = searchParams.get("panel");
    return sections.some((section) => section.key === candidate)
      ? candidate
      : null;
  })();

  useEffect(() => {
    if (!selectedPanel) {
      return;
    }

    const target = sectionRefs.current[selectedPanel];
    if (!target) {
      return;
    }

    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);

    return () => window.clearTimeout(timer);
  }, [selectedPanel]);

  const handleSectionSelect = (key: string) => {
    router.replace(
      buildAdminSettingsPanelSelectionHref(pathname, searchParams, key),
    );
  };

  if (status === "loading" || (loading && canViewSettings)) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
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

  if (!isAdmin) {
    return (
      <Card
        className="content-card"
        title={t("adminConsole.links.settings.title", {
          defaultValue: "Access Settings",
        })}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card
        className="content-card"
        title={t("adminConsole.links.settings.title", {
          defaultValue: "Access Settings",
        })}
      >
        {messageContext}
        <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
          {t("adminConsole.links.settings.description", {
            defaultValue: "Manage roles, permissions, and memberships",
          })}
        </Typography.Paragraph>
        <div className="flex flex-wrap gap-2">
          {sections.map((section) => (
            <Button
              key={section.key}
              size="small"
              type={selectedPanel === section.key ? "primary" : "default"}
              onClick={() => handleSectionSelect(section.key)}
            >
              {section.title}
            </Button>
          ))}
        </div>
      </Card>

      {sections.map((section) => (
        <section
          key={section.key}
          id={section.key}
          ref={(node) => {
            sectionRefs.current[section.key] = node;
          }}
          className={`scroll-mt-28 rounded-[28px] border bg-white/75 p-5 shadow-sm backdrop-blur ${
            selectedPanel === section.key
              ? "border-[var(--primary)] ring-2 ring-[rgba(59,130,246,0.18)]"
              : "border-[var(--border)]"
          }`}
        >
          <Typography.Title level={5} style={{ marginBottom: 6 }}>
            {section.title}
          </Typography.Title>
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: "1rem" }}
          >
            {section.description}
          </Typography.Paragraph>
          {section.content}
        </section>
      ))}
    </div>
  );
}

function RolesPanel({
  roles,
  permissions,
  onSave,
  savingRoleId,
  updating,
}: {
  roles: RoleListItem[];
  permissions: PermissionListItem[];
  onSave: (roleId: string, values: RoleFormValues) => Promise<void>;
  savingRoleId: string | null;
  updating: boolean;
}) {
  const sortedPermissions = useMemo(
    () => [...permissions].sort((a, b) => a.name.localeCompare(b.name)),
    [permissions],
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
  updating,
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
      permissions: role.permissions.map((permission) => permission.name),
    }),
    [role.description, role.permissions],
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
          marginBottom: "0.25rem",
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          {role.name}
        </Typography.Title>
        {role.isSystem ? (
          <Tag color="gold">{t("settings.roles.system")}</Tag>
        ) : null}
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
        rules={[
          { required: true, message: t("settings.roles.permissionsRequired") },
        ]}
      >
        <Select
          mode="multiple"
          placeholder={t("settings.roles.permissionsPlaceholder")}
          optionFilterProp="label"
          options={permissions.map((permission) => ({
            label: `${permission.name}${
              permission.description ? ` - ${permission.description}` : ""
            }`,
            value: permission.name,
          }))}
          disabled={isBusy}
        />
      </Form.Item>
      <div
        style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}
      >
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
  assigning,
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
  assigning,
}: {
  membership: MembershipListItem;
  roles: RoleListItem[];
  onSave: (membership: MembershipListItem, roleId: string) => Promise<void>;
  saving: boolean;
  assigning: boolean;
}) {
  const { t } = useTranslation();
  const [selectedRoleId, setSelectedRoleId] = useState<string>(
    membership.role.id,
  );
  const roleOptions = useMemo(
    () =>
      roles.map((role) => ({
        value: role.id,
        label: role.name,
        isSystem: role.isSystem,
        description: role.description,
      })),
    [roles],
  );

  useEffect(() => {
    setSelectedRoleId(membership.role.id);
  }, [membership.role.id]);

  const selectedRole = roleOptions.find(
    (role) => role.value === selectedRoleId,
  );
  const noRolesAvailable = roles.length === 0;
  const hasChanges = !noRolesAvailable && selectedRoleId !== membership.role.id;
  const isBusy = saving || assigning || noRolesAvailable;

  return (
    <>
      <List.Item.Meta
        title={`${membership.user.firstName} ${membership.user.lastName}`}
        description={`${membership.user.email} • ${membership.role.name}`}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          width: "100%",
        }}
      >
        <Typography.Text type="secondary">
          {t("settings.members.roleAssignment")}
        </Typography.Text>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Select
            value={selectedRoleId}
            onChange={setSelectedRoleId}
            style={{ minWidth: "220px" }}
            options={roleOptions.map((option) => ({
              label: option.label,
              value: option.value,
              title: option.description ?? undefined,
            }))}
            optionFilterProp="label"
            disabled={isBusy}
          />
          {selectedRole?.isSystem ? (
            <Tag color="gold">{t("settings.roles.system")}</Tag>
          ) : null}
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
