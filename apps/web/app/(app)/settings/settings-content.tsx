"use client";

import {
  Button,
  Card,
  Empty,
  Form,
  InputNumber,
  List,
  message,
  Spin,
  Tabs,
  Tag,
  Typography
} from "antd";
import {
  useRateLimitSettingsQuery,
  useRbacOverviewQuery,
  useUpdateRateLimitSettingsMutation
} from "@/graphql/generated";
import type { UpdateRateLimitSettingsMutationVariables } from "@/graphql/generated";
import { useSession } from "next-auth/react";
import { useEffect } from "react";

export function SettingsContent() {
  const { data: session } = useSession();
  const canManageRateLimits = session?.permissions?.includes("settings.manage") ?? false;
  const { data, loading } = useRbacOverviewQuery();

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  const roles = data?.roles ?? [];
  const permissions = data?.permissions ?? [];
  const memberships = data?.memberships ?? [];

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

  if (canManageRateLimits) {
    tabItems.push({
      key: "rateLimits",
      label: "Rate Limits",
      children: <RateLimitSettingsPanel />
    });
  }

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
      console.error(error);
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
