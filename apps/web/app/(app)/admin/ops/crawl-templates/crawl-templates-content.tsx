"use client";

import {
  Alert,
  Button,
  Card,
  Form,
  Grid,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface CrawlTemplateRecord {
  id: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  crawlOptions?: Record<string, unknown> | null;
}

interface CrawlTemplateFormValues {
  name: string;
  description?: string;
  isActive: boolean;
  proxyUrl?: string;
  userAgent?: string;
  enableStealthMode: boolean;
  enableUndetectedBrowser: boolean;
  includeImages: boolean;
  crawlOptionsJson?: string;
}

const parseJsonField = (value: string | undefined, label: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `${label} must be a valid JSON object`);
  }
};

const normalizeString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const normalizeBoolean = (value: unknown) => (typeof value === "boolean" ? value : false);

const normalizeOptions = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function CrawlTemplatesContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<CrawlTemplateRecord[]>([]);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CrawlTemplateRecord | null>(null);
  const [form] = Form.useForm<CrawlTemplateFormValues>();
  const screens = Grid.useBreakpoint();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<CrawlTemplateRecord[]>("admin/crawl-templates", {
        params: { search: search.trim() || undefined }
      });
      setTemplates(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl templates", error);
      messageApi.error(t("crawlTemplates.errors.loadFailed", { defaultValue: "Failed to load crawl templates." }));
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, search, t]);

  useEffect(() => {
    if (canView) {
      void loadTemplates();
    }
  }, [canView, loadTemplates]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      enableStealthMode: false,
      enableUndetectedBrowser: false,
      includeImages: true,
      crawlOptionsJson: "{}"
    });
    setModalOpen(true);
  };

  const openEdit = (template: CrawlTemplateRecord) => {
    setEditing(template);
    const options = normalizeOptions(template.crawlOptions);
    form.setFieldsValue({
      name: template.name,
      description: template.description ?? "",
      isActive: template.isActive,
      proxyUrl: normalizeString(options?.proxyUrl),
      userAgent: normalizeString(options?.userAgent),
      enableStealthMode: normalizeBoolean(options?.enableStealthMode),
      enableUndetectedBrowser: normalizeBoolean(options?.enableUndetectedBrowser),
      includeImages: options?.includeImages === false ? false : true,
      crawlOptionsJson: options ? JSON.stringify(options, null, 2) : "{}"
    });
    setModalOpen(true);
  };

  const buildCrawlOptions = (values: CrawlTemplateFormValues) => {
    const base = parseJsonField(values.crawlOptionsJson, "crawlOptions") ?? {};

    const proxyUrl = values.proxyUrl?.trim() ?? "";
    if (proxyUrl) {
      base.proxyUrl = proxyUrl;
    } else {
      delete base.proxyUrl;
    }

    const userAgent = values.userAgent?.trim() ?? "";
    if (userAgent) {
      base.userAgent = userAgent;
    } else {
      delete base.userAgent;
    }

    if (values.enableStealthMode) {
      base.enableStealthMode = true;
    } else {
      delete base.enableStealthMode;
    }

    if (values.enableUndetectedBrowser) {
      base.enableUndetectedBrowser = true;
    } else {
      delete base.enableUndetectedBrowser;
    }

    if (values.includeImages === false) {
      base.includeImages = false;
    } else {
      delete base.includeImages;
    }

    return Object.keys(base).length ? base : null;
  };

  const handleSubmit = async (values: CrawlTemplateFormValues) => {
    setSaving(true);
    try {
      const crawlOptions = buildCrawlOptions(values);
      const payload = {
        name: values.name,
        description: values.description?.trim() ?? "",
        isActive: values.isActive,
        crawlOptions
      };
      if (editing) {
        await apiClient.patch(`admin/crawl-templates/${editing.id}`, payload);
      } else {
        await apiClient.post("admin/crawl-templates", payload);
      }
      messageApi.success(
        editing
          ? t("crawlTemplates.messages.updated", { defaultValue: "Template updated." })
          : t("crawlTemplates.messages.created", { defaultValue: "Template created." })
      );
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      await loadTemplates();
    } catch (error) {
      captureClientError("Failed to save crawl template", error);
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("crawlTemplates.errors.saveFailed", { defaultValue: "Failed to save crawl template." })
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (template: CrawlTemplateRecord) => {
    Modal.confirm({
      title: t("crawlTemplates.delete.title", { defaultValue: "Delete template?" }),
      content: t("crawlTemplates.delete.description", {
        defaultValue: "News sources using this template will stop applying it."
      }),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await apiClient.delete(`admin/crawl-templates/${template.id}`);
          await loadTemplates();
          messageApi.success(t("crawlTemplates.messages.deleted", { defaultValue: "Template deleted." }));
        } catch (error) {
          captureClientError("Failed to delete crawl template", error);
          messageApi.error(t("crawlTemplates.errors.deleteFailed", { defaultValue: "Failed to delete template." }));
        }
      }
    });
  };

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Typography.Text type="secondary">{t("common.loading", { defaultValue: "Loading..." })}</Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("crawlTemplates.title", { defaultValue: "Crawl Templates" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  const columns: ColumnsType<CrawlTemplateRecord> = [
    {
      title: t("crawlTemplates.columns.name", { defaultValue: "Name" }),
      dataIndex: "name",
      key: "name",
      render: (value: string, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{value}</Typography.Text>
          {record.description ? (
            <Typography.Text type="secondary" ellipsis={{ tooltip: record.description }}>
              {record.description}
            </Typography.Text>
          ) : null}
        </Space>
      )
    },
    {
      title: t("crawlTemplates.columns.status", { defaultValue: "Status" }),
      dataIndex: "isActive",
      key: "isActive",
      render: (value: boolean) => (
        <Tag color={value ? "green" : "default"}>
          {value ? t("common.enabled", { defaultValue: "Enabled" }) : t("common.disabled", { defaultValue: "Disabled" })}
        </Tag>
      )
    },
    {
      title: t("common.actions", { defaultValue: "Actions" }),
      key: "actions",
      render: (_, record) => (
        <Space>
          {canManage ? (
            <Button size="small" onClick={() => openEdit(record)}>
              {t("common.edit", { defaultValue: "Edit" })}
            </Button>
          ) : null}
          {canManage ? (
            <Button size="small" danger onClick={() => handleDelete(record)}>
              {t("common.delete", { defaultValue: "Delete" })}
            </Button>
          ) : null}
        </Space>
      )
    }
  ];

  return (
    <>
      {contextHolder}
      <Card
        className="content-card"
        title={t("crawlTemplates.title", { defaultValue: "Crawl Templates" })}
        extra={
          canManage ? (
            <Button type="primary" onClick={openCreate}>
              {t("crawlTemplates.actions.new", { defaultValue: "New template" })}
            </Button>
          ) : null
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Input.Search
            placeholder={t("crawlTemplates.searchPlaceholder", { defaultValue: "Search templates" })}
            allowClear
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onSearch={() => void loadTemplates()}
          />
          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={templates}
            pagination={{ pageSize: screens.md ? 10 : 5, showSizeChanger: screens.md }}
          />
        </Space>
      </Card>

      <Modal
        open={modalOpen}
        title={
          editing
            ? t("crawlTemplates.actions.edit", { defaultValue: "Edit template" })
            : t("crawlTemplates.actions.new", { defaultValue: "New template" })
        }
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        okButtonProps={{ loading: saving }}
        destroyOnClose
      >
        <Form layout="vertical" form={form} onFinish={handleSubmit} preserve={false}>
          <Form.Item
            name="name"
            label={t("crawlTemplates.fields.name", { defaultValue: "Name" })}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="description"
            label={t("crawlTemplates.fields.description", { defaultValue: "Description" })}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="isActive"
            label={t("crawlTemplates.fields.active", { defaultValue: "Active" })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t("crawlTemplates.sections.commonOptions", { defaultValue: "Common Options" })}
          </Typography.Title>

          <Form.Item
            name="proxyUrl"
            label={t("crawlTemplates.fields.proxyUrl", { defaultValue: "Proxy URL" })}
          >
            <Input placeholder="http(s)://user:pass@host:port" />
          </Form.Item>
          <Form.Item
            name="userAgent"
            label={t("crawlTemplates.fields.userAgent", { defaultValue: "User Agent" })}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="enableStealthMode"
            label={t("crawlTemplates.fields.stealth", { defaultValue: "Stealth mode" })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="enableUndetectedBrowser"
            label={t("crawlTemplates.fields.undetected", { defaultValue: "Undetected browser" })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="includeImages"
            label={t("crawlTemplates.fields.images", { defaultValue: "Include images" })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="crawlOptionsJson"
            label={t("crawlTemplates.fields.advancedJson", { defaultValue: "Advanced crawl options (JSON)" })}
          >
            <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
