"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import { Alert, Button, Card, Form, Input, Modal, Space, Switch, Table, Tag, Typography, message } from "antd";
import dayjs from "dayjs";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";

import { captureClientError } from "@/lib/client-telemetry";

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type CreateOrgInput = {
  name: string;
  slug: string;
  description?: string;
};

type UpdateOrgInput = {
  name: string;
  slug: string;
  description?: string;
};

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

function mergeOrganizations(existing: Array<{ id: string; name?: string; slug?: string }>, next: OrgRow[]) {
  const map = new Map<string, { id: string; name?: string; slug?: string }>();
  existing.forEach((org) => map.set(org.id, org));
  next.forEach((org) => map.set(org.id, { id: org.id, name: org.name, slug: org.slug }));
  return Array.from(map.values());
}

export function OrgAdminContent() {
  const { data: session, status, update } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const canManageOrganizations = session?.permissions?.includes("org.write") ?? false;

  const { data, loading, refetch } = useQuery<{ myOrganizations: OrgRow[] }>(MY_ORGANIZATIONS_QUERY, {
    skip: status !== "authenticated"
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingOrg, setEditingOrg] = useState<OrgRow | null>(null);

  const [createForm] = Form.useForm<CreateOrgInput>();
  const [editForm] = Form.useForm<UpdateOrgInput>();

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

  const rows = data?.myOrganizations ?? [];
  const tableData = useMemo(() => rows.map((row) => ({ key: row.id, ...row })), [rows]);

  if (status === "loading" || loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Typography.Text type="secondary">Loading organizations…</Typography.Text>
      </div>
    );
  }

  if (!canManageOrganizations) {
    return (
      <Card className="content-card" title="Organizations">
        <Alert
          type="warning"
          message="Admins only"
          description="Only administrators can create, update, or disable organizations."
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
      await refetch();

      if (created) {
        const existing = session?.organizations ?? [];
        await update({
          organizations: mergeOrganizations(existing, [...rows, created])
        });
      }

      messageApi.success("Organization created");
    } catch (error) {
      captureClientError("Create org failed", error);
      messageApi.error("Failed to create organization");
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

      messageApi.success("Organization updated");
    } catch (error) {
      captureClientError("Update org failed", error);
      messageApi.error("Failed to update organization");
    }
  };

  const handleToggleActive = async (org: OrgRow, nextActive: boolean) => {
    try {
      await setOrgActive({ variables: { input: { id: org.id, isActive: nextActive } } });
      await refetch();
      messageApi.success(nextActive ? "Organization enabled" : "Organization disabled");
    } catch (error) {
      captureClientError("Toggle org active failed", error);
      messageApi.error("Failed to update organization status");
    }
  };

  return (
    <>
      {contextHolder}
      <Card
        className="content-card"
        title="Organizations"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            New organization
          </Button>
        }
      >
        <Table
          dataSource={tableData}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "Name",
              dataIndex: "name",
              key: "name",
              render: (value: string) => <Typography.Text strong>{value}</Typography.Text>
            },
            {
              title: "Slug",
              dataIndex: "slug",
              key: "slug",
              render: (value: string) => <Typography.Text code>{value}</Typography.Text>
            },
            {
              title: "Status",
              dataIndex: "isActive",
              key: "isActive",
              render: (value: boolean) => (
                <Tag color={value ? "green" : "red"}>{value ? "Active" : "Disabled"}</Tag>
              )
            },
            {
              title: "Updated",
              dataIndex: "updatedAt",
              key: "updatedAt",
              render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm")
            },
            {
              title: "Actions",
              key: "actions",
              render: (_: unknown, org: OrgRow) => (
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditingOrg(org);
                      editForm.setFieldsValue({
                        name: org.name,
                        slug: org.slug,
                        description: org.description ?? ""
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Switch
                    size="small"
                    checked={org.isActive}
                    loading={toggling}
                    onChange={(checked) => handleToggleActive(org, checked)}
                  />
                </Space>
              )
            }
          ]}
        />
      </Card>

      <Modal
        title="Create organization"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={() => createForm.submit()}
        okButtonProps={{ loading: creating }}
        destroyOnClose
      >
        <Form<CreateOrgInput> form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: "Name is required" }]}>
            <Input placeholder="Acme Corp" />
          </Form.Item>
          <Form.Item
            name="slug"
            label="Slug"
            rules={[
              { required: true, message: "Slug is required" },
              {
                pattern: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/,
                message: "Use lowercase letters, numbers, and hyphens"
              }
            ]}
          >
            <Input placeholder="acme" />
          </Form.Item>
          <Form.Item name="description" label="Description" rules={[{ max: 500 }]}>
            <Input.TextArea rows={3} placeholder="Optional" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Edit organization"
        open={Boolean(editingOrg)}
        onCancel={() => {
          setEditingOrg(null);
          editForm.resetFields();
        }}
        onOk={() => editForm.submit()}
        okButtonProps={{ loading: saving }}
        destroyOnClose
      >
        <Form<UpdateOrgInput> form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: "Name is required" }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="slug"
            label="Slug"
            rules={[
              { required: true, message: "Slug is required" },
              {
                pattern: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/,
                message: "Use lowercase letters, numbers, and hyphens"
              }
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description" rules={[{ max: 500 }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
