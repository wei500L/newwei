"use client";

import {
  Alert,
  Button,
  Form,
  Grid,
  Input,
  InputNumber,
  List,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface RateLimitPolicy {
  feature: string;
  userLimit: number;
  ipLimit: number;
  windowSeconds: number;
  enabled: boolean;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface RateLimitPolicyFormValues {
  feature: string;
  userLimit: number;
  ipLimit: number;
  windowSeconds: number;
  enabled: boolean;
  description?: string;
}

const EMPTY_POLICIES: RateLimitPolicy[] = [];

const toPerMinute = (limit: number, windowSeconds: number) => {
  if (!windowSeconds || windowSeconds <= 0) {
    return 0;
  }
  return (limit * 60) / windowSeconds;
};

const formatRate = (limit: number, windowSeconds: number) => {
  const rate = toPerMinute(limit, windowSeconds);
  const rounded = Math.round(rate * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

export function RateLimitPoliciesPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [policies, setPolicies] = useState<RateLimitPolicy[]>(EMPTY_POLICIES);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<RateLimitPolicy | null>(null);
  const [createForm] = Form.useForm<RateLimitPolicyFormValues>();
  const [editForm] = Form.useForm<RateLimitPolicyFormValues>();
  const screens = Grid.useBreakpoint();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadPolicies = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<RateLimitPolicy[]>("system-settings/rate-limit-policies");
      setPolicies(response.data ?? EMPTY_POLICIES);
    } catch (error) {
      captureClientError("Failed to load rate limit policies", error);
      setErrorMessage(t("settings.rateLimitPolicies.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, t]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    if (editingPolicy) {
      editForm.setFieldsValue({
        feature: editingPolicy.feature,
        userLimit: editingPolicy.userLimit,
        ipLimit: editingPolicy.ipLimit,
        windowSeconds: editingPolicy.windowSeconds,
        enabled: editingPolicy.enabled,
        description: editingPolicy.description ?? ""
      });
    }
  }, [editingPolicy, editForm]);

  const openCreate = () => {
    createForm.setFieldsValue({ enabled: true });
    setCreateOpen(true);
  };

  const handleCreate = async (values: RateLimitPolicyFormValues) => {
    setSaving(true);
    try {
      await apiClient.post("system-settings/rate-limit-policies", values);
      await loadPolicies();
      setCreateOpen(false);
      createForm.resetFields();
      messageApi.success(t("settings.rateLimitPolicies.messages.created"));
    } catch (error) {
      captureClientError("Failed to create rate limit policy", error);
      messageApi.error(t("settings.rateLimitPolicies.errors.createFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (values: RateLimitPolicyFormValues) => {
    if (!editingPolicy) {
      return;
    }
    setSaving(true);
    try {
      const { feature, ...payload } = values;
      await apiClient.put(`system-settings/rate-limit-policies/${feature}`, payload);
      await loadPolicies();
      setEditingPolicy(null);
      editForm.resetFields();
      messageApi.success(t("settings.rateLimitPolicies.messages.updated"));
    } catch (error) {
      captureClientError("Failed to update rate limit policy", error);
      messageApi.error(t("settings.rateLimitPolicies.errors.updateFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (policy: RateLimitPolicy, nextEnabled: boolean) => {
    setToggling(policy.feature);
    try {
      await apiClient.put(`system-settings/rate-limit-policies/${policy.feature}`, {
        enabled: nextEnabled
      });
      await loadPolicies();
      messageApi.success(
        nextEnabled ? t("common.enabled") : t("common.disabled")
      );
    } catch (error) {
      captureClientError("Failed to toggle rate limit policy", error);
      messageApi.error(t("settings.rateLimitPolicies.errors.toggleFailed"));
    } finally {
      setToggling(null);
    }
  };

  const columns: ColumnsType<RateLimitPolicy> = [
    {
      title: t("settings.rateLimitPolicies.columns.feature"),
      dataIndex: "feature",
      key: "feature",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text code>{record.feature}</Typography.Text>
          {record.description ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.description}
            </Typography.Text>
          ) : null}
        </Space>
      )
    },
    {
      title: t("settings.rateLimitPolicies.columns.userPerMinute"),
      dataIndex: "userLimit",
      key: "userLimit",
      render: (_: unknown, record) => (
        <Typography.Text>{formatRate(record.userLimit, record.windowSeconds)}</Typography.Text>
      )
    },
    {
      title: t("settings.rateLimitPolicies.columns.ipPerMinute"),
      dataIndex: "ipLimit",
      key: "ipLimit",
      render: (_: unknown, record) => (
        <Typography.Text>{formatRate(record.ipLimit, record.windowSeconds)}</Typography.Text>
      )
    },
    {
      title: t("settings.rateLimitPolicies.columns.windowSeconds"),
      dataIndex: "windowSeconds",
      key: "windowSeconds",
      render: (value: number) => <Typography.Text>{value}</Typography.Text>
    },
    {
      title: t("settings.rateLimitPolicies.columns.status"),
      dataIndex: "enabled",
      key: "enabled",
      render: (value: boolean) => (
        <Tag color={value ? "green" : "red"}>
          {value ? t("common.enabled") : t("common.disabled")}
        </Tag>
      )
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, record) => (
        <Space>
          <Button
            size="small"
            onClick={() => setEditingPolicy(record)}
          >
            {t("common.edit")}
          </Button>
          <Switch
            size="small"
            checked={record.enabled}
            loading={toggling === record.feature}
            onChange={(checked) => handleToggle(record, checked)}
          />
        </Space>
      )
    }
  ];

  return (
    <>
      {contextHolder}
      <Space
        direction="vertical"
        size="middle"
        style={{ display: "flex", marginBottom: "1rem" }}
      >
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
        />
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            {t("settings.rateLimitPolicies.description")}
          </Typography.Paragraph>
          <Button type="primary" onClick={openCreate}>
            {t("settings.rateLimitPolicies.actions.new")}
          </Button>
        </div>
        {errorMessage ? <Alert type="error" message={errorMessage} showIcon /> : null}
      </Space>
      {!screens.md ? (
        <List
          dataSource={policies}
          loading={loading}
          pagination={{ pageSize: 6, align: "center" }}
          renderItem={(policy) => (
            <List.Item
              actions={[
                <Button
                  key="edit"
                  size="small"
                  onClick={() => setEditingPolicy(policy)}
                >
                  {t("common.edit")}
                </Button>,
                <Switch
                  key="toggle"
                  size="small"
                  checked={policy.enabled}
                  loading={toggling === policy.feature}
                  onChange={(checked) => handleToggle(policy, checked)}
                />
              ]}
            >
              <List.Item.Meta
                title={
                  <Space align="center">
                    <Typography.Text code>{policy.feature}</Typography.Text>
                    <Tag color={policy.enabled ? "green" : "red"}>
                      {policy.enabled ? t("common.enabled") : t("common.disabled")}
                    </Tag>
                  </Space>
                }
                description={
                  <Space direction="vertical" size={2}>
                    {policy.description ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {policy.description}
                      </Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t("settings.rateLimitPolicies.columns.userPerMinute")}:{" "}
                      {formatRate(policy.userLimit, policy.windowSeconds)} ·{" "}
                      {t("settings.rateLimitPolicies.columns.ipPerMinute")}:{" "}
                      {formatRate(policy.ipLimit, policy.windowSeconds)}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t("settings.rateLimitPolicies.columns.windowSeconds")}:{" "}
                      {policy.windowSeconds}
                    </Typography.Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <Table
          rowKey="feature"
          dataSource={policies}
          columns={columns}
          loading={loading}
          pagination={{ pageSize: 8 }}
        />
      )}

      <Form<RateLimitPolicyFormValues>
        form={createForm}
        layout="vertical"
        onFinish={handleCreate}
        component={false}
      >
        <Modal
          title={t("settings.rateLimitPolicies.modal.createTitle")}
          open={createOpen}
          onCancel={() => {
            setCreateOpen(false);
            createForm.resetFields();
          }}
          onOk={() => createForm.submit()}
          okButtonProps={{ loading: saving }}
          destroyOnHidden
        >
          <Form.Item
            name="feature"
            label={t("settings.rateLimitPolicies.fields.feature")}
            rules={[
              { required: true, message: t("settings.rateLimitPolicies.validation.featureRequired") },
              {
                pattern: /^[a-z][a-z0-9_.]*$/,
                message: t("settings.rateLimitPolicies.validation.featurePattern")
              }
            ]}
          >
            <Input placeholder={t("settings.rateLimitPolicies.placeholders.feature")} />
          </Form.Item>
          <Form.Item
            name="userLimit"
            label={t("settings.rateLimitPolicies.fields.userLimit")}
            rules={[
              { required: true, message: t("settings.rateLimitPolicies.validation.userLimitRequired") }
            ]}
          >
            <InputNumber min={0} max={100_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="ipLimit"
            label={t("settings.rateLimitPolicies.fields.ipLimit")}
            rules={[
              { required: true, message: t("settings.rateLimitPolicies.validation.ipLimitRequired") }
            ]}
          >
            <InputNumber min={0} max={100_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="windowSeconds"
            label={t("settings.rateLimitPolicies.fields.windowSeconds")}
            rules={[
              { required: true, message: t("settings.rateLimitPolicies.validation.windowRequired") }
            ]}
          >
            <InputNumber min={1} max={86_400} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="enabled"
            label={t("settings.rateLimitPolicies.fields.enabled")}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="description" label={t("settings.rateLimitPolicies.fields.description")}>
            <Input.TextArea rows={3} placeholder={t("settings.rateLimitPolicies.placeholders.description")} />
          </Form.Item>
        </Modal>
      </Form>

      <Form<RateLimitPolicyFormValues>
        form={editForm}
        layout="vertical"
        onFinish={handleEdit}
        component={false}
      >
        <Modal
          title={t("settings.rateLimitPolicies.modal.editTitle")}
          open={Boolean(editingPolicy)}
          onCancel={() => {
            setEditingPolicy(null);
            editForm.resetFields();
          }}
          onOk={() => editForm.submit()}
          okButtonProps={{ loading: saving }}
          destroyOnHidden
        >
          <Form.Item
            name="feature"
            label={t("settings.rateLimitPolicies.fields.feature")}
          >
            <Input disabled />
          </Form.Item>
          <Form.Item
            name="userLimit"
            label={t("settings.rateLimitPolicies.fields.userLimit")}
            rules={[
              { required: true, message: t("settings.rateLimitPolicies.validation.userLimitRequired") }
            ]}
          >
            <InputNumber min={0} max={100_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="ipLimit"
            label={t("settings.rateLimitPolicies.fields.ipLimit")}
            rules={[
              { required: true, message: t("settings.rateLimitPolicies.validation.ipLimitRequired") }
            ]}
          >
            <InputNumber min={0} max={100_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="windowSeconds"
            label={t("settings.rateLimitPolicies.fields.windowSeconds")}
            rules={[
              { required: true, message: t("settings.rateLimitPolicies.validation.windowRequired") }
            ]}
          >
            <InputNumber min={1} max={86_400} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="enabled"
            label={t("settings.rateLimitPolicies.fields.enabled")}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="description" label={t("settings.rateLimitPolicies.fields.description")}>
            <Input.TextArea rows={3} placeholder={t("settings.rateLimitPolicies.placeholders.description")} />
          </Form.Item>
        </Modal>
      </Form>
    </>
  );
}
