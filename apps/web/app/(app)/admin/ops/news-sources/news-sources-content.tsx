"use client";

import {
  Alert,
  Button,
  Card,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Select,
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
import { formatDateTime, resolveLocale } from "@/lib/i18n";

type NewsSourceRecord = {
  id: string;
  name: string;
  url: string;
  siteType: string;
  language?: string | null;
  crawlTemplateId?: string | null;
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  config?: Record<string, unknown> | null;
};

type CrawlTemplateRecord = {
  id: string;
  name: string;
  isActive: boolean;
};

type NewsSourceFormValues = {
  name: string;
  url: string;
  siteType: string;
  language?: string;
  crawlTemplateId?: string;
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  keywords?: string;
  tags?: string;
  summaryHints?: string;
  metadataJson?: string;
  crawlOptionsJson?: string;
  forceRefresh?: boolean;
};

const parseStringList = (value?: string) =>
  (value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const formatStringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join("\n") : "";

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
    throw new Error(
      error instanceof Error ? error.message : `${label} must be a valid JSON object`
    );
  }
};

export function NewsSourcesContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState<NewsSourceRecord[]>([]);
  const [templates, setTemplates] = useState<CrawlTemplateRecord[]>([]);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<NewsSourceRecord | null>(null);
  const [form] = Form.useForm<NewsSourceFormValues>();
  const screens = Grid.useBreakpoint();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<NewsSourceRecord[]>("admin/news-sources");
      setSources(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load news sources", error);
      messageApi.error(
        t("newsSources.errors.loadFailed", { defaultValue: "Failed to load news sources." })
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, t]);

  const loadTemplates = useCallback(async () => {
    try {
      const response = await apiClient.get<CrawlTemplateRecord[]>("admin/crawl-templates");
      setTemplates(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl templates", error);
    }
  }, [apiClient]);

  useEffect(() => {
    if (canView) {
      void loadSources();
      void loadTemplates();
    }
  }, [canView, loadSources, loadTemplates]);

  const filteredSources = useMemo(() => {
    if (!search.trim()) {
      return sources;
    }
    const needle = search.trim().toLowerCase();
    return sources.filter((source) => {
      const haystack = [source.name, source.url, source.siteType, source.language ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [search, sources]);

  const siteTypeOptions = [
    { value: "general", label: t("newsSources.types.general", { defaultValue: "General" }) },
    { value: "finance", label: t("newsSources.types.finance", { defaultValue: "Finance" }) },
    { value: "technology", label: t("newsSources.types.technology", { defaultValue: "Technology" }) },
    { value: "politics", label: t("newsSources.types.politics", { defaultValue: "Politics" }) },
    { value: "regulatory", label: t("newsSources.types.regulatory", { defaultValue: "Regulatory" }) },
    { value: "other", label: t("newsSources.types.other", { defaultValue: "Other" }) }
  ];

  const templateMap = useMemo(() => new Map(templates.map((template) => [template.id, template])), [templates]);
  const templateOptions = useMemo(
    () =>
      templates.map((template) => ({
        value: template.id,
        label: template.isActive ? template.name : `${template.name} (${t("common.disabled")})`
      })),
    [t, templates]
  );

  const openCreate = () => {
    setEditingSource(null);
    form.resetFields();
    form.setFieldsValue({
      siteType: "general",
      frequencySeconds: 3600,
      priority: 0,
      isActive: true
    });
    setModalOpen(true);
  };

  const openEdit = (source: NewsSourceRecord) => {
    setEditingSource(source);
    const config =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : null;
    form.setFieldsValue({
      name: source.name,
      url: source.url,
      siteType: source.siteType,
      language: source.language ?? "",
      crawlTemplateId: source.crawlTemplateId ?? undefined,
      frequencySeconds: source.frequencySeconds,
      priority: source.priority,
      isActive: source.isActive,
      keywords: formatStringList(config?.keywords),
      tags: formatStringList(config?.tags),
      summaryHints: formatStringList(config?.summaryHints),
      metadataJson: config?.metadata ? JSON.stringify(config.metadata, null, 2) : "",
      crawlOptionsJson: config?.crawlOptions ? JSON.stringify(config.crawlOptions, null, 2) : "",
      forceRefresh: config?.forceRefresh === true
    });
    setModalOpen(true);
  };

  const buildConfig = (values: NewsSourceFormValues) => {
    const config: Record<string, unknown> = {};
    const keywords = parseStringList(values.keywords);
    const tags = parseStringList(values.tags);
    const summaryHints = parseStringList(values.summaryHints);

    if (keywords.length) {
      config.keywords = keywords;
    }
    if (tags.length) {
      config.tags = tags;
    }
    if (summaryHints.length) {
      config.summaryHints = summaryHints;
    }

    const metadata = parseJsonField(values.metadataJson, "metadata");
    if (metadata) {
      config.metadata = metadata;
    }
    const crawlOptions = parseJsonField(values.crawlOptionsJson, "crawlOptions");
    if (crawlOptions) {
      config.crawlOptions = crawlOptions;
    }
    if (values.forceRefresh) {
      config.forceRefresh = true;
    }

    return Object.keys(config).length ? config : null;
  };

  const handleSubmit = async (values: NewsSourceFormValues) => {
    setSaving(true);
    try {
      const config = buildConfig(values);
      const payload = {
        name: values.name,
        url: values.url,
        siteType: values.siteType,
        language: values.language?.trim() ?? "",
        crawlTemplateId: values.crawlTemplateId?.trim() ? values.crawlTemplateId.trim() : null,
        frequencySeconds: values.frequencySeconds,
        priority: values.priority,
        isActive: values.isActive,
        config
      };
      if (editingSource) {
        await apiClient.patch(`admin/news-sources/${editingSource.id}`, payload);
      } else {
        await apiClient.post("admin/news-sources", payload);
      }
      messageApi.success(
        editingSource
          ? t("newsSources.messages.updated", { defaultValue: "News source updated." })
          : t("newsSources.messages.created", { defaultValue: "News source created." })
      );
      setModalOpen(false);
      setEditingSource(null);
      form.resetFields();
      await loadSources();
    } catch (error) {
      captureClientError("Failed to save news source", error);
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("newsSources.errors.saveFailed", { defaultValue: "Failed to save news source." })
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (source: NewsSourceRecord, nextActive: boolean) => {
    try {
      await apiClient.patch(`admin/news-sources/${source.id}`, { isActive: nextActive });
      await loadSources();
      messageApi.success(
        nextActive
          ? t("newsSources.messages.enabled", { defaultValue: "Source enabled." })
          : t("newsSources.messages.disabled", { defaultValue: "Source disabled." })
      );
    } catch (error) {
      captureClientError("Failed to update news source", error);
      messageApi.error(
        t("newsSources.errors.saveFailed", { defaultValue: "Failed to save news source." })
      );
    }
  };

  const handleRunNow = async (source: NewsSourceRecord) => {
    try {
      await apiClient.post(`admin/news-sources/${source.id}/run`);
      await loadSources();
      messageApi.success(
        t("newsSources.messages.runQueued", { defaultValue: "Source queued for crawl." })
      );
    } catch (error) {
      captureClientError("Failed to run news source now", error);
      messageApi.error(
        t("newsSources.errors.runFailed", { defaultValue: "Failed to schedule source." })
      );
    }
  };

  const handleDelete = (source: NewsSourceRecord) => {
    Modal.confirm({
      title: t("newsSources.delete.title", { defaultValue: "Delete source?" }),
      content: t("newsSources.delete.description", {
        defaultValue: "This removes the source and stops scheduled crawls."
      }),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await apiClient.delete(`admin/news-sources/${source.id}`);
          await loadSources();
          messageApi.success(
            t("newsSources.messages.deleted", { defaultValue: "News source deleted." })
          );
        } catch (error) {
          captureClientError("Failed to delete news source", error);
          messageApi.error(
            t("newsSources.errors.deleteFailed", { defaultValue: "Failed to delete news source." })
          );
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
      <Card className="content-card" title={t("newsSources.title", { defaultValue: "News Sources" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  const columns: ColumnsType<NewsSourceRecord> = [
    {
      title: t("newsSources.columns.name", { defaultValue: "Name" }),
      dataIndex: "name",
      key: "name",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" ellipsis={{ tooltip: record.url }}>
            {record.url}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t("newsSources.columns.type", { defaultValue: "Type" }),
      dataIndex: "siteType",
      key: "siteType",
      render: (value: string) => {
        const label = siteTypeOptions.find((option) => option.value === value)?.label ?? value;
        return <Tag>{label}</Tag>;
      }
    },
    {
      title: t("newsSources.columns.template", { defaultValue: "Template" }),
      dataIndex: "crawlTemplateId",
      key: "crawlTemplateId",
      render: (value?: string | null) => {
        if (!value) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        const template = templateMap.get(value);
        if (!template) {
          return <Tag color="default">{value}</Tag>;
        }
        return (
          <Tag color={template.isActive ? "blue" : "orange"}>
            {template.isActive ? template.name : `${template.name} (${t("common.disabled")})`}
          </Tag>
        );
      }
    },
    {
      title: t("newsSources.columns.frequency", { defaultValue: "Frequency (s)" }),
      dataIndex: "frequencySeconds",
      key: "frequencySeconds"
    },
    {
      title: t("newsSources.columns.priority", { defaultValue: "Priority" }),
      dataIndex: "priority",
      key: "priority"
    },
    {
      title: t("newsSources.columns.status", { defaultValue: "Status" }),
      dataIndex: "isActive",
      key: "isActive",
      render: (value: boolean, record) =>
        canManage ? (
          <Switch checked={value} onChange={(next) => void handleToggleActive(record, next)} />
        ) : (
          <Tag color={value ? "green" : "default"}>
            {value ? t("common.enabled") : t("common.disabled")}
          </Tag>
        )
    },
    {
      title: t("newsSources.columns.nextRun", { defaultValue: "Next run" }),
      dataIndex: "nextRunAt",
      key: "nextRunAt",
      render: (value?: string | null) =>
        value ? formatDateTime(value, locale, { dateStyle: "medium", timeStyle: "short" }) : t("common.never")
    },
    {
      title: t("newsSources.columns.lastRun", { defaultValue: "Last run" }),
      dataIndex: "lastRunAt",
      key: "lastRunAt",
      render: (value?: string | null) =>
        value ? formatDateTime(value, locale, { dateStyle: "medium", timeStyle: "short" }) : t("common.never")
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_, record) => (
        <Space>
          {canManage ? (
            <Button size="small" onClick={() => openEdit(record)}>
              {t("common.edit")}
            </Button>
          ) : null}
          {canManage ? (
            <Button size="small" onClick={() => void handleRunNow(record)}>
              {t("newsSources.actions.runNow", { defaultValue: "Run now" })}
            </Button>
          ) : null}
          {canManage ? (
            <Button size="small" danger onClick={() => handleDelete(record)}>
              {t("common.delete")}
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
        title={t("newsSources.title", { defaultValue: "News Sources" })}
        extra={
          canManage ? (
            <Button type="primary" onClick={openCreate}>
              {t("newsSources.actions.new", { defaultValue: "New source" })}
            </Button>
          ) : null
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Input.Search
            placeholder={t("newsSources.searchPlaceholder", { defaultValue: "Search by name or URL" })}
            allowClear
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={filteredSources}
            pagination={{ pageSize: screens.md ? 10 : 5, showSizeChanger: screens.md }}
          />
        </Space>
      </Card>

      <Modal
        open={modalOpen}
        title={
          editingSource
            ? t("newsSources.actions.edit", { defaultValue: "Edit source" })
            : t("newsSources.actions.new", { defaultValue: "New source" })
        }
        onCancel={() => {
          setModalOpen(false);
          setEditingSource(null);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        okButtonProps={{ loading: saving }}
        destroyOnClose
      >
        <Form layout="vertical" form={form} onFinish={handleSubmit} preserve={false}>
          <Form.Item
            name="name"
            label={t("newsSources.fields.name", { defaultValue: "Name" })}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="url"
            label={t("newsSources.fields.url", { defaultValue: "URL" })}
            rules={[{ required: true, type: "url" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="siteType"
            label={t("newsSources.fields.type", { defaultValue: "Type" })}
            rules={[{ required: true }]}
          >
            <Select options={siteTypeOptions} />
          </Form.Item>
          <Form.Item
            name="language"
            label={t("newsSources.fields.language", { defaultValue: "Language" })}
          >
            <Input placeholder={t("newsSources.fields.languageHint", { defaultValue: "e.g. en, zh" })} />
          </Form.Item>
          <Form.Item
            name="crawlTemplateId"
            label={t("newsSources.fields.template", { defaultValue: "Crawl template" })}
          >
            <Select
              showSearch
              allowClear
              options={templateOptions}
              placeholder={t("common.none", { defaultValue: "None" })}
            />
          </Form.Item>
          <Form.Item
            name="frequencySeconds"
            label={t("newsSources.fields.frequency", { defaultValue: "Frequency (seconds)" })}
            rules={[{ required: true }]}
          >
            <InputNumber min={60} max={2_592_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="priority"
            label={t("newsSources.fields.priority", { defaultValue: "Priority" })}
            rules={[{ required: true }]}
          >
            <InputNumber min={-100} max={100} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="isActive"
            label={t("newsSources.fields.active", { defaultValue: "Active" })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="keywords"
            label={t("newsSources.fields.keywords", { defaultValue: "Keywords" })}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.keywordsHint", { defaultValue: "One keyword per line" })}
            />
          </Form.Item>
          <Form.Item name="tags" label={t("newsSources.fields.tags", { defaultValue: "Tags" })}>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.tagsHint", { defaultValue: "One tag per line" })}
            />
          </Form.Item>
          <Form.Item
            name="summaryHints"
            label={t("newsSources.fields.summaryHints", { defaultValue: "Summary hints" })}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.summaryHintsHint", { defaultValue: "One hint per line" })}
            />
          </Form.Item>
          <Form.Item
            name="metadataJson"
            label={t("newsSources.fields.metadata", { defaultValue: "Metadata (JSON)" })}
          >
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
          <Form.Item
            name="crawlOptionsJson"
            label={t("newsSources.fields.crawlOptions", { defaultValue: "Crawl options (JSON)" })}
          >
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
          <Form.Item
            name="forceRefresh"
            label={t("newsSources.fields.forceRefresh", { defaultValue: "Force refresh" })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
