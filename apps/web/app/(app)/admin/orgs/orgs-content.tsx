"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import { Alert, Button, Card, Form, Input, Modal, Space, Switch, Table, Tag, Typography, message, List, Grid } from "antd";
import { useSession } from "next-auth/react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BackendLoginResponse } from "@/lib/auth";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { createTraceHeaders } from "@/lib/trace";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CreateOrgInput {
  name: string;
  slug: string;
  description?: string;
}

interface UpdateOrgInput {
  name: string;
  slug: string;
  description?: string;
}

const EMPTY_ROWS: OrgRow[] = [];

function getGraphqlErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const graphQLErrors = (error as { graphQLErrors?: { message?: unknown }[] }).graphQLErrors;
  if (Array.isArray(graphQLErrors) && graphQLErrors.length > 0) {
    const firstMessage = graphQLErrors[0]?.message;
    if (typeof firstMessage === "string" && firstMessage.trim()) {
      return firstMessage.trim();
    }
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  return null;
}

const MY_ORGANIZATIONS_QUERY = gql`
  query MyOrganizations {
    myOrganizations {
      id
      name
      slug
      description
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_ORG_MUTATION = gql`
  mutation CreateOrg($input: CreateOrgInput!) {
    createOrg(input: $input) {
      id
      name
      slug
      description
      isActive
      createdAt
      updatedAt
    }
  }
`;

const UPDATE_ORG_MUTATION = gql`
  mutation UpdateOrg($input: UpdateOrgInput!) {
    updateOrg(input: $input) {
      id
      name
      slug
      description
      isActive
      createdAt
      updatedAt
    }
  }
`;

const SET_ORG_ACTIVE_MUTATION = gql`
  mutation SetOrgActive($input: SetOrgActiveInput!) {
    setOrgActive(input: $input) {
      id
      name
      slug
      description
      isActive
      createdAt
      updatedAt
    }
  }
`;

function slugifyOrgSlug(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (!normalized || normalized.length < 3) {
    return null;
  }

  const truncated = normalized.slice(0, 64).replace(/-+$/, "");
  const matches = /^[\p{L}\p{N}][\p{L}\p{N}-]{1,62}[\p{L}\p{N}]$/u.test(truncated);
  return matches ? truncated : null;
}

function mergeOrganizations(
  existing: { id: string; name?: string; slug?: string; isActive?: boolean }[],
  next: OrgRow[]
) {
  const map = new Map<string, { id: string; name?: string; slug?: string; isActive?: boolean }>();
  existing.forEach((org) => map.set(org.id, org));
  next.forEach((org) =>
    map.set(org.id, { id: org.id, name: org.name, slug: org.slug, isActive: org.isActive })
  );
  return Array.from(map.values());
}

export function OrgAdminContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status, update } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const canManageOrganizations = session?.permissions?.includes("org.write") ?? false;
  const currentOrgId = session?.orgId ?? null;

  const { data, loading, refetch } = useQuery<{ myOrganizations: OrgRow[] }>(MY_ORGANIZATIONS_QUERY, {
    skip: status !== "authenticated"
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingOrg, setEditingOrg] = useState<OrgRow | null>(null);

  const [createForm] = Form.useForm<CreateOrgInput>();
  const [editForm] = Form.useForm<UpdateOrgInput>();
  const createSlugModeRef = useRef<"auto" | "manual">("auto");

  const [createOrg, { loading: creating }] = useMutation<{ createOrg: OrgRow }, { input: CreateOrgInput }>(
    CREATE_ORG_MUTATION
  );
  const [updateOrg, { loading: saving }] = useMutation<{ updateOrg: OrgRow }, { input: { id: string } & UpdateOrgInput }>(
    UPDATE_ORG_MUTATION
  );
  const [setOrgActive, { loading: toggling }] = useMutation<
    { setOrgActive: OrgRow },
    { input: { id: string; isActive: boolean } }
  >(SET_ORG_ACTIVE_MUTATION);

  const rows = data?.myOrganizations ?? EMPTY_ROWS;
  const tableData = useMemo(() => rows.map((row) => ({ key: row.id, ...row })), [rows]);
  const screens = Grid.useBreakpoint();

  if (status === "loading" || loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Typography.Text type="secondary">{t("orgAdmin.loading")}</Typography.Text>
      </div>
    );
  }

  if (!canManageOrganizations) {
    return (
      <Card className="content-card" title={t("orgAdmin.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("orgAdmin.adminOnly")}
        />
      </Card>
    );
  }

  const handleCreate = async (values: CreateOrgInput) => {
    try {
      const result = await createOrg({ variables: { input: values } });
      const created = result.data?.createOrg;
      setCreateOpen(false);
      createForm.resetFields();
      createSlugModeRef.current = "auto";
      await refetch();

      if (created) {
        const existing = session?.organizations ?? [];
        await update({
          organizations: mergeOrganizations(existing, [...rows, created])
        });
      }

      messageApi.success(t("orgAdmin.created"));
    } catch (error) {
      captureClientError("Create org failed", error);
      messageApi.error(getGraphqlErrorMessage(error) ?? t("orgAdmin.errors.createFailed"));
    }
  };

  const handleEdit = async (values: UpdateOrgInput) => {
    if (!editingOrg) {
      return;
    }
    try {
      const result = await updateOrg({ variables: { input: { id: editingOrg.id, ...values } } });
      const updated = result.data?.updateOrg;
      setEditingOrg(null);
      editForm.resetFields();
      await refetch();

      if (updated) {
        const existing = session?.organizations ?? [];
        await update({
          organizations: mergeOrganizations(existing, rows.map((org) => (org.id === updated.id ? updated : org)))
        });
      }

      messageApi.success(t("orgAdmin.updated"));
    } catch (error) {
      captureClientError("Update org failed", error);
      messageApi.error(getGraphqlErrorMessage(error) ?? t("orgAdmin.errors.updateFailed"));
    }
  };

  const handleToggleActive = async (org: OrgRow, nextActive: boolean) => {
    try {
      if (!nextActive) {
        const confirmed = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: t("orgAdmin.confirmDisable.title", { defaultValue: "Disable organization?" }),
            content: t("orgAdmin.confirmDisable.description", {
              defaultValue:
                "Disabling an organization will block logins and API access for that org until re-enabled."
            }),
            okText: t("common.confirm", { defaultValue: "Confirm" }),
            cancelText: t("common.cancel", { defaultValue: "Cancel" }),
            okButtonProps: { danger: true },
            onOk: () => resolve(true),
            onCancel: () => resolve(false)
          });
        });
        if (!confirmed) {
          return;
        }
      }

      await setOrgActive({ variables: { input: { id: org.id, isActive: nextActive } } });
      await refetch();
      messageApi.success(
        nextActive ? t("orgAdmin.enabled") : t("orgAdmin.disabled")
      );
    } catch (error) {
      captureClientError("Toggle org active failed", error);
      messageApi.error(t("orgAdmin.errors.toggleFailed"));
    }
  };

  const handleSwitchOrg = async (org: OrgRow) => {
    try {
      if (!org.isActive) {
        messageApi.error(
          t("orgAdmin.errors.switchDisabled", { defaultValue: "Cannot switch to a disabled org" })
        );
        return;
      }
      const response = await fetch("/api/organizations/switch", {
        method: "POST",
        headers: createTraceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ orgId: org.slug || org.id })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
        messageApi.error(payload.details ?? payload.error ?? t("orgAdmin.errors.switchFailed", { defaultValue: "Switch failed" }));
        return;
      }
      const data = (await response.json()) as BackendLoginResponse;
      await update({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        accessTokenExpires: Date.now() + data.expiresIn * 1000,
        user: data.user,
        orgId: data.user.orgId,
        permissions: data.user.permissions,
        organizations: data.organizations ?? session?.organizations
      });
      messageApi.success(
        t("orgSwitcher.success", { org: org.name ?? org.slug ?? org.id })
      );
    } catch (error) {
      captureClientError("Switch org failed", error);
      messageApi.error(t("orgAdmin.errors.switchFailed", { defaultValue: "Switch failed" }));
    }
  };

  return (
    <>
      {contextHolder}
      <Card
        className="content-card"
        title={t("orgAdmin.title")}
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            {t("orgAdmin.new")}
          </Button>
        }
      >
        {!screens.md ? (
          <List
            dataSource={tableData}
            pagination={{ pageSize: 10, align: "center" }}
            renderItem={(org) => (
              <List.Item
                actions={[
                  <Button
                    key="switch"
                    size="small"
                    type="link"
                    disabled={!org.isActive || org.id === currentOrgId}
                    onClick={() => handleSwitchOrg(org)}
                  >
                    {org.id === currentOrgId ? t("orgAdmin.current", { defaultValue: "Current" }) : t("orgAdmin.switch", { defaultValue: "Switch" })}
                  </Button>,
                  <Button
                    key="edit"
                    size="small"
                    onClick={() => {
                      setEditingOrg(org);
                      editForm.setFieldsValue({
                        name: org.name,
                        slug: org.slug,
                        description: org.description ?? "",
                      });
                    }}
                  >
                    {t("common.edit")}
                  </Button>,
                  <Switch
                    key="toggle"
                    size="small"
                    checked={org.isActive}
                    loading={toggling}
                    onChange={(checked) => handleToggleActive(org, checked)}
                  />,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Typography.Text strong>{org.name}</Typography.Text>
                      {org.id === currentOrgId ? (
                        <Tag color="blue">{t("orgAdmin.current", { defaultValue: "Current" })}</Tag>
                      ) : null}
                      <Tag color={org.isActive ? "green" : "red"}>
                        {org.isActive
                          ? t("orgAdmin.active")
                          : t("orgAdmin.inactive")}
                      </Tag>
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      <Typography.Text code>{org.slug}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatDateTime(org.updatedAt, locale, {
                          dateStyle: "medium",
                        })}
                      </Typography.Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Table
            dataSource={tableData}
            pagination={{ pageSize: 10 }}
            columns={[
              {
                title: t("orgAdmin.columns.name"),
                dataIndex: "name",
                key: "name",
                render: (value: string) => (
                  <Typography.Text strong>{value}</Typography.Text>
                ),
              },
              {
                title: t("orgAdmin.columns.slug"),
                dataIndex: "slug",
                key: "slug",
                render: (value: string) => (
                  <Typography.Text code>{value}</Typography.Text>
                ),
              },
              {
                title: t("orgAdmin.columns.status"),
                dataIndex: "isActive",
                key: "isActive",
                render: (value: boolean) => (
                  <Tag color={value ? "green" : "red"}>
                    {value ? t("orgAdmin.active") : t("orgAdmin.inactive")}
                  </Tag>
                ),
              },
              {
                title: t("orgAdmin.columns.current", { defaultValue: "Current" }),
                key: "current",
                render: (_: unknown, org: OrgRow) =>
                  org.id === currentOrgId ? (
                    <Tag color="blue">{t("orgAdmin.current", { defaultValue: "Current" })}</Tag>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  )
              },
              {
                title: t("orgAdmin.columns.updated"),
                dataIndex: "updatedAt",
                key: "updatedAt",
                render: (value: string) =>
                  formatDateTime(value, locale, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
              },
              {
                title: t("common.actions"),
                key: "actions",
                render: (_: unknown, org: OrgRow) => (
                  <Space>
                    <Button
                      size="small"
                      type="link"
                      disabled={!org.isActive || org.id === currentOrgId}
                      onClick={() => handleSwitchOrg(org)}
                    >
                      {org.id === currentOrgId ? t("orgAdmin.current", { defaultValue: "Current" }) : t("orgAdmin.switch", { defaultValue: "Switch" })}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        setEditingOrg(org);
                        editForm.setFieldsValue({
                          name: org.name,
                          slug: org.slug,
                          description: org.description ?? "",
                        });
                      }}
                    >
                      {t("common.edit")}
                    </Button>
                    <Switch
                      size="small"
                      checked={org.isActive}
                      loading={toggling}
                      onChange={(checked) => handleToggleActive(org, checked)}
                    />
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Form<CreateOrgInput>
        form={createForm}
        layout="vertical"
        onFinish={handleCreate}
        component={false}
      >
        <Modal
          title={t("orgAdmin.createTitle")}
          open={createOpen}
          onCancel={() => {
            setCreateOpen(false);
            createForm.resetFields();
            createSlugModeRef.current = "auto";
          }}
          onOk={() => createForm.submit()}
          okButtonProps={{ loading: creating }}
          destroyOnHidden
        >
          <Form.Item
            name="name"
            label={t("orgAdmin.fields.name")}
            rules={[{ required: true, message: t("orgAdmin.validation.nameRequired") }]}
          >
            <Input
              placeholder={t("orgAdmin.placeholders.name")}
              onChange={(event) => {
                if (createSlugModeRef.current !== "auto") {
                  return;
                }
                const suggested = slugifyOrgSlug(event.target.value);
                if (suggested) {
                  createForm.setFieldsValue({ slug: suggested });
                }
              }}
            />
          </Form.Item>
          <Form.Item
            name="slug"
            label={t("orgAdmin.fields.slug")}
            normalize={(value) => (typeof value === "string" ? value.trim().toLowerCase() : value)}
            rules={[
              { required: true, message: t("orgAdmin.validation.slugRequired") },
              {
                pattern: /^[\p{L}\p{N}][\p{L}\p{N}-]{1,62}[\p{L}\p{N}]$/u,
                message: t("orgAdmin.validation.slugPattern")
              }
            ]}
          >
            <Input
              placeholder={t("orgAdmin.placeholders.slug")}
              onChange={(event) => {
                createSlugModeRef.current = event.target.value.trim() ? "manual" : "auto";
              }}
            />
          </Form.Item>
          <Form.Item name="description" label={t("orgAdmin.fields.description")} rules={[{ max: 500 }]}>
            <Input.TextArea rows={3} placeholder={t("orgAdmin.placeholders.description")} />
          </Form.Item>
        </Modal>
      </Form>

      <Form<UpdateOrgInput>
        form={editForm}
        layout="vertical"
        onFinish={handleEdit}
        component={false}
      >
        <Modal
          title={t("orgAdmin.editTitle")}
          open={Boolean(editingOrg)}
          onCancel={() => {
            setEditingOrg(null);
            editForm.resetFields();
          }}
          onOk={() => editForm.submit()}
          okButtonProps={{ loading: saving }}
          destroyOnHidden
        >
          <Form.Item
            name="name"
            label={t("orgAdmin.fields.name")}
            rules={[{ required: true, message: t("orgAdmin.validation.nameRequired") }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="slug"
            label={t("orgAdmin.fields.slug")}
            normalize={(value) => (typeof value === "string" ? value.trim().toLowerCase() : value)}
            rules={[
              { required: true, message: t("orgAdmin.validation.slugRequired") },
              {
                pattern: /^[\p{L}\p{N}][\p{L}\p{N}-]{1,62}[\p{L}\p{N}]$/u,
                message: t("orgAdmin.validation.slugPattern")
              }
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t("orgAdmin.fields.description")} rules={[{ max: 500 }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Modal>
      </Form>
    </>
  );
}
