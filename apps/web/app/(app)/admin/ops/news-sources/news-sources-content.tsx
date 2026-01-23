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
  Tooltip,
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

interface NewsSourceRecord {
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
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number | null;
  circuitOpenUntil?: string | null;
  nextRunAt?: string | null;
  config?: Record<string, unknown> | null;
}

interface CrawlTemplateRecord {
  id: string;
  name: string;
  isActive: boolean;
}

interface NewsSourcePreviewCandidate {
  url: string;
  status: "success" | "failed";
  title?: string;
  description?: string;
  author?: string;
  relevanceScore?: number;
  alreadyCrawled: boolean;
  lastCrawlAt?: string | null;
  alreadyQueued?: boolean;
  inFlightStatus?: string | null;
  error?: string;
}

interface NewsSourcePreviewResponse {
  mode: "single" | "sitemap" | "rss";
  sourceId: string;
  url: string;
  name: string;
  seed?: Record<string, unknown> | null;
  candidates: NewsSourcePreviewCandidate[];
  availableToSchedule?: number;
  inFlightCount?: number;
  inFlightLimit?: number;
  scheduleCount: number;
  skippedCount: number;
}

interface NewsSourceFormValues {
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
  seedEnabled?: boolean;
  seedMode?: "sitemap" | "rss";
  seedDomain?: string;
  seedPattern?: string;
  seedFeedUrl?: string;
  seedQuery?: string;
  seedMaxUrls?: number;
  seedMaxNewUrlsPerRun?: number;
  seedScoreThreshold?: number;
  seedDedupeWindowHours?: number;
  seedCacheTtlSeconds?: number;
  seedConcurrency?: number;
}

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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasSeedConfig = (
  config: unknown
): config is Record<string, unknown> & { seed: Record<string, unknown> } => {
  if (!isPlainObject(config)) {
    return false;
  }
  return isPlainObject((config as Record<string, unknown>).seed);
};

const isSeedEnabled = (config: unknown) =>
  hasSeedConfig(config) ? config.seed.enabled === true : false;

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
  const seedEnabledValue = Form.useWatch("seedEnabled", form);
  const seedModeValue = Form.useWatch("seedMode", form);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRunNowLoading, setPreviewRunNowLoading] = useState(false);
  const [previewSource, setPreviewSource] = useState<NewsSourceRecord | null>(null);
  const [previewData, setPreviewData] = useState<NewsSourcePreviewResponse | null>(null);

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
      isActive: true,
      seedEnabled: false,
      seedMode: "sitemap",
      seedMaxUrls: 20,
      seedMaxNewUrlsPerRun: 10,
      seedScoreThreshold: 0,
      seedDedupeWindowHours: 24,
      seedCacheTtlSeconds: 600,
      seedConcurrency: 5
    });
    setModalOpen(true);
  };

  const openEdit = (source: NewsSourceRecord) => {
    setEditingSource(source);
    const config =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : null;
    const seedConfig =
      config?.seed && typeof config.seed === "object" && !Array.isArray(config.seed)
        ? (config.seed as Record<string, unknown>)
        : null;
    const seedMaxUrls =
      typeof seedConfig?.maxUrls === "number" && Number.isFinite(seedConfig.maxUrls)
        ? seedConfig.maxUrls
        : 20;
    const seedMaxNewUrlsPerRun =
      typeof seedConfig?.maxNewUrlsPerRun === "number" && Number.isFinite(seedConfig.maxNewUrlsPerRun)
        ? seedConfig.maxNewUrlsPerRun
        : 10;
    const seedScoreThreshold =
      typeof seedConfig?.scoreThreshold === "number" && Number.isFinite(seedConfig.scoreThreshold)
        ? seedConfig.scoreThreshold
        : 0;
    const seedDedupeWindowHours =
      typeof seedConfig?.dedupeWindowHours === "number" && Number.isFinite(seedConfig.dedupeWindowHours)
        ? seedConfig.dedupeWindowHours
        : 24;
    const seedCacheTtlSeconds =
      typeof seedConfig?.cacheTtlSeconds === "number" && Number.isFinite(seedConfig.cacheTtlSeconds)
        ? seedConfig.cacheTtlSeconds
        : 600;
    const seedConcurrency =
      typeof seedConfig?.concurrency === "number" && Number.isFinite(seedConfig.concurrency)
        ? seedConfig.concurrency
        : 5;
    const seedMode = seedConfig?.mode === "rss" ? "rss" : "sitemap";
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
      forceRefresh: config?.forceRefresh === true,
      seedEnabled: seedConfig?.enabled === true,
      seedMode,
      seedDomain: typeof seedConfig?.domain === "string" ? seedConfig.domain : "",
      seedPattern: typeof seedConfig?.pattern === "string" ? seedConfig.pattern : "",
      seedFeedUrl: typeof seedConfig?.feedUrl === "string" ? seedConfig.feedUrl : "",
      seedQuery: typeof seedConfig?.query === "string" ? seedConfig.query : "",
      seedMaxUrls,
      seedMaxNewUrlsPerRun,
      seedScoreThreshold,
      seedDedupeWindowHours,
      seedCacheTtlSeconds,
      seedConcurrency
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

    const shouldIncludeSeed =
      values.seedEnabled === true || (editingSource?.config && hasSeedConfig(editingSource.config));
    if (shouldIncludeSeed) {
      const seedMode = values.seedMode === "rss" ? "rss" : "sitemap";
      const seed: Record<string, unknown> = {
        enabled: values.seedEnabled === true,
        mode: seedMode
      };

      if (seedMode === "rss") {
        const feedUrl = values.seedFeedUrl?.trim();
        if (feedUrl) {
          seed.feedUrl = feedUrl;
        }
      } else {
        const seedDomain = values.seedDomain?.trim();
        if (seedDomain) {
          seed.domain = seedDomain;
        }

        const seedPattern = values.seedPattern?.trim();
        if (seedPattern) {
          seed.pattern = seedPattern;
        }
      }

      const seedQuery = values.seedQuery?.trim();
      if (seedQuery) {
        seed.query = seedQuery;
      }

      if (typeof values.seedMaxUrls === "number" && Number.isFinite(values.seedMaxUrls)) {
        seed.maxUrls = values.seedMaxUrls;
      }
      if (
        typeof values.seedMaxNewUrlsPerRun === "number" &&
        Number.isFinite(values.seedMaxNewUrlsPerRun)
      ) {
        seed.maxNewUrlsPerRun = values.seedMaxNewUrlsPerRun;
      }
      if (typeof values.seedScoreThreshold === "number" && Number.isFinite(values.seedScoreThreshold)) {
        seed.scoreThreshold = values.seedScoreThreshold;
      }
      if (
        typeof values.seedDedupeWindowHours === "number" &&
        Number.isFinite(values.seedDedupeWindowHours)
      ) {
        seed.dedupeWindowHours = values.seedDedupeWindowHours;
      }
      if (
        typeof values.seedCacheTtlSeconds === "number" &&
        Number.isFinite(values.seedCacheTtlSeconds)
      ) {
        seed.cacheTtlSeconds = values.seedCacheTtlSeconds;
      }
      if (typeof values.seedConcurrency === "number" && Number.isFinite(values.seedConcurrency)) {
        seed.concurrency = values.seedConcurrency;
      }

      config.seed = seed;
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

  const handlePreview = async (source: NewsSourceRecord) => {
    setPreviewSource(source);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const response = await apiClient.get<NewsSourcePreviewResponse>(
        `admin/news-sources/${source.id}/preview`
      );
      setPreviewData(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to preview news source", error);
      messageApi.error(
        t("newsSources.errors.previewFailed", {
          defaultValue: "Failed to preview news source."
        })
      );
      setPreviewOpen(false);
      setPreviewSource(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const reloadPreview = async () => {
    if (!previewSource) {
      return;
    }
    await handlePreview(previewSource);
  };

  const handleRunNowFromPreview = async () => {
    if (!previewSource) {
      return;
    }
    setPreviewRunNowLoading(true);
    try {
      await handleRunNow(previewSource);
    } finally {
      setPreviewRunNowLoading(false);
    }
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
          <Space size={8} wrap>
            <Typography.Text strong>{record.name}</Typography.Text>
            {isSeedEnabled(record.config) ? (
              <Tag color="purple">
                {t("newsSources.seed.mode", { defaultValue: "Sitemap seed" })}
              </Tag>
            ) : null}
          </Space>
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
      render: (value: boolean, record) => {
        const failureCount = Number(record.consecutiveFailures ?? 0);
        const circuitOpenUntil = record.circuitOpenUntil ? new Date(record.circuitOpenUntil) : null;
        const circuitOpen = circuitOpenUntil ? circuitOpenUntil.getTime() > Date.now() : false;
        const lastFailureAt = record.lastFailureAt ?? null;

        const healthTag = circuitOpen ? (
          <Tooltip
            title={
              circuitOpenUntil
                ? t("newsSources.health.circuitOpenUntil", {
                    defaultValue: "Circuit open until {{time}}",
                    time: formatDateTime(circuitOpenUntil.toISOString(), locale, {
                      dateStyle: "medium",
                      timeStyle: "short"
                    })
                  })
                : t("newsSources.health.circuitOpen", { defaultValue: "Circuit open" })
            }
          >
            <Tag color="red">{t("newsSources.health.circuitOpen", { defaultValue: "Circuit open" })}</Tag>
          </Tooltip>
        ) : failureCount > 0 ? (
          <Tooltip
            title={
              lastFailureAt
                ? t("newsSources.health.lastFailureAt", {
                    defaultValue: "Last failure {{time}}",
                    time: formatDateTime(lastFailureAt, locale, {
                      dateStyle: "medium",
                      timeStyle: "short"
                    })
                  })
                : t("newsSources.health.failing", { defaultValue: "Failing" })
            }
          >
            <Tag color="orange">
              {t("newsSources.health.failingCount", {
                defaultValue: "Failing ({{count}})",
                count: failureCount
              })}
            </Tag>
          </Tooltip>
        ) : value ? (
          <Tag color="green">{t("newsSources.health.healthy", { defaultValue: "Healthy" })}</Tag>
        ) : null;

        return (
          <Space direction="vertical" size={2}>
            {canManage ? (
              <Switch checked={value} onChange={(next) => void handleToggleActive(record, next)} />
            ) : (
              <Tag color={value ? "green" : "default"}>
                {value ? t("common.enabled") : t("common.disabled")}
              </Tag>
            )}
            {healthTag}
          </Space>
        );
      }
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
      title: t("newsSources.columns.lastSuccess", { defaultValue: "Last success" }),
      dataIndex: "lastSuccessAt",
      key: "lastSuccessAt",
      responsive: ["md"],
      render: (value?: string | null) =>
        value ? formatDateTime(value, locale, { dateStyle: "medium", timeStyle: "short" }) : t("common.never")
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => void handlePreview(record)}>
            {t("newsSources.actions.preview", { defaultValue: "Preview" })}
          </Button>
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

  const previewColumns: ColumnsType<NewsSourcePreviewCandidate> = [
    {
      title: t("newsSources.preview.columns.url", { defaultValue: "URL" }),
      dataIndex: "url",
      key: "url",
      render: (value: string, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Link href={value} target="_blank" rel="noreferrer" title={value} ellipsis>
            {value}
          </Typography.Link>
          {record.title ? <Typography.Text type="secondary">{record.title}</Typography.Text> : null}
        </Space>
      )
    },
    {
      title: t("newsSources.preview.columns.relevance", { defaultValue: "Relevance" }),
      dataIndex: "relevanceScore",
      key: "relevanceScore",
      width: 110,
      render: (value?: number) =>
        typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "-"
    },
    {
      title: t("newsSources.preview.columns.status", { defaultValue: "Status" }),
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: NewsSourcePreviewCandidate["status"]) =>
        value === "success" ? (
          <Tag color="green">{t("common.success", { defaultValue: "Success" })}</Tag>
        ) : (
          <Tag color="red">{t("common.failed", { defaultValue: "Failed" })}</Tag>
        )
    },
    {
      title: t("newsSources.preview.columns.dedupe", { defaultValue: "Dedupe" }),
      dataIndex: "alreadyCrawled",
      key: "alreadyCrawled",
      width: 160,
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          {record.alreadyCrawled ? (
            <Tag color="default">
              {t("newsSources.preview.alreadyCrawled", { defaultValue: "Crawled" })}
            </Tag>
          ) : (
            <Tag color="blue">{t("newsSources.preview.newUrl", { defaultValue: "New" })}</Tag>
          )}
          {record.alreadyQueued ? (
            <Tooltip
              title={
                record.inFlightStatus
                  ? t("newsSources.preview.inFlightStatus", {
                      defaultValue: "In-flight: {{status}}",
                      status: record.inFlightStatus
                    })
                  : t("newsSources.preview.inFlight", { defaultValue: "In-flight" })
              }
            >
              <Tag color="orange">{t("newsSources.preview.inFlight", { defaultValue: "In-flight" })}</Tag>
            </Tooltip>
          ) : null}
          {record.lastCrawlAt
            ? formatDateTime(record.lastCrawlAt, locale, { dateStyle: "medium", timeStyle: "short" })
            : null}
        </Space>
      )
    },
    {
      title: t("newsSources.preview.columns.error", { defaultValue: "Error" }),
      dataIndex: "error",
      key: "error",
      render: (value?: string) =>
        value ? (
          <Tooltip title={value}>
            <Typography.Text type="danger" ellipsis={{ tooltip: value }}>
              {value}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
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
        destroyOnHidden
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

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t("newsSources.sections.seed", { defaultValue: "Seed discovery" })}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("newsSources.sections.seedHint", {
              defaultValue:
                "Discover article URLs from either a sitemap or an RSS/Atom feed, then schedule up to N fresh URLs per run."
            })}
          </Typography.Text>

          <Form.Item
            name="seedEnabled"
            label={t("newsSources.fields.seedEnabled", { defaultValue: "Enable seed discovery" })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <div style={{ display: seedEnabledValue ? "block" : "none" }}>
            <Form.Item
              name="seedMode"
              label={t("newsSources.fields.seedMode", { defaultValue: "Seed mode" })}
              tooltip={t("newsSources.fields.seedModeHint", {
                defaultValue: "Sitemap mode discovers URLs from sitemap.xml; RSS mode discovers URLs from the feed URL."
              })}
            >
              <Select
                options={[
                  { label: t("newsSources.seedMode.sitemap", { defaultValue: "Sitemap" }), value: "sitemap" },
                  { label: t("newsSources.seedMode.rss", { defaultValue: "RSS / Atom" }), value: "rss" }
                ]}
              />
            </Form.Item>

            {seedModeValue === "rss" ? (
              <Form.Item
                name="seedFeedUrl"
                label={t("newsSources.fields.seedFeedUrl", { defaultValue: "Feed URL (optional)" })}
                tooltip={t("newsSources.fields.seedFeedUrlHint", {
                  defaultValue: "If empty, the source URL will be used as the feed URL."
                })}
              >
                <Input placeholder="https://example.com/rss.xml" />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  name="seedDomain"
                  label={t("newsSources.fields.seedDomain", { defaultValue: "Seed domain (optional)" })}
                  tooltip={t("newsSources.fields.seedDomainHint", {
                    defaultValue: "Defaults to the source URL origin if empty."
                  })}
                >
                  <Input placeholder="https://example.com" />
                </Form.Item>
                <Form.Item
                  name="seedPattern"
                  label={t("newsSources.fields.seedPattern", { defaultValue: "URL pattern (optional)" })}
                  tooltip={t("newsSources.fields.seedPatternHint", {
                    defaultValue: "Supports '*' and '?' wildcards, e.g. '*news*' or '*/2026/*'."
                  })}
                >
                  <Input placeholder="*news*" />
                </Form.Item>
              </>
            )}
            <Form.Item
              name="seedQuery"
              label={t("newsSources.fields.seedQuery", { defaultValue: "Seed query (optional)" })}
              tooltip={t("newsSources.fields.seedQueryHint", {
                defaultValue: "If empty, keywords will be used to score URLs."
              })}
            >
              <Input
                placeholder={t("newsSources.fields.seedQueryPlaceholder", {
                  defaultValue: "e.g. earnings regulation"
                })}
              />
            </Form.Item>
            <Form.Item
              name="seedMaxUrls"
              label={t("newsSources.fields.seedMaxUrls", { defaultValue: "Max discovered URLs" })}
            >
              <InputNumber min={1} max={200} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="seedMaxNewUrlsPerRun"
              label={t("newsSources.fields.seedMaxNewUrlsPerRun", { defaultValue: "Max new URLs per run" })}
            >
              <InputNumber min={1} max={50} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="seedScoreThreshold"
              label={t("newsSources.fields.seedScoreThreshold", { defaultValue: "Score threshold" })}
              tooltip={t("newsSources.fields.seedScoreThresholdHint", {
                defaultValue: "0 disables the scoring filter; values range from 0..1."
              })}
            >
              <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="seedDedupeWindowHours"
              label={t("newsSources.fields.seedDedupeWindowHours", { defaultValue: "Dedupe window (hours)" })}
            >
              <InputNumber min={0} max={720} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="seedCacheTtlSeconds"
              label={t("newsSources.fields.seedCacheTtlSeconds", { defaultValue: "Seed cache TTL (seconds)" })}
            >
              <InputNumber min={10} max={3600} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="seedConcurrency"
              label={t("newsSources.fields.seedConcurrency", { defaultValue: "Preview concurrency" })}
              tooltip={t("newsSources.fields.seedConcurrencyHint", {
                defaultValue: "Used by Preview to fetch metadata; scheduling uses lightweight URL scoring."
              })}
            >
              <InputNumber min={1} max={10} style={{ width: "100%" }} />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      <Modal
        open={previewOpen}
        title={t("newsSources.preview.title", { defaultValue: "News source preview" })}
        width={screens.md ? 980 : "100%"}
        onCancel={() => {
          setPreviewOpen(false);
          setPreviewSource(null);
          setPreviewData(null);
        }}
        footer={
          <Space>
            {canManage ? (
              <Button
                type="primary"
                onClick={() => void handleRunNowFromPreview()}
                loading={previewRunNowLoading}
                disabled={!previewSource}
              >
                {t("newsSources.actions.runNow", { defaultValue: "Run now" })}
              </Button>
            ) : null}
            <Button onClick={() => void reloadPreview()} loading={previewLoading} disabled={!previewSource}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setPreviewOpen(false);
                setPreviewSource(null);
                setPreviewData(null);
              }}
            >
              {t("common.close", { defaultValue: "Close" })}
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        {previewData ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Space wrap>
              <Tag
                color={
                  previewData.mode === "sitemap"
                    ? "purple"
                    : previewData.mode === "rss"
                      ? "blue"
                      : "default"
                }
              >
                {previewData.mode === "sitemap"
                  ? t("newsSources.preview.modeSitemap", { defaultValue: "Sitemap" })
                  : previewData.mode === "rss"
                    ? t("newsSources.preview.modeRss", { defaultValue: "RSS" })
                    : t("newsSources.preview.modeSingle", { defaultValue: "Single" })}
              </Tag>
              <Typography.Text>
                {t("newsSources.preview.scheduleCount", {
                  defaultValue: "Would schedule: {{count}}",
                  count: previewData.scheduleCount
                })}
              </Typography.Text>
              {typeof previewData.availableToSchedule === "number" ? (
                <Typography.Text type="secondary">
                  {t("newsSources.preview.availableToSchedule", {
                    defaultValue: "Available: {{count}}",
                    count: previewData.availableToSchedule
                  })}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {t("newsSources.preview.skippedCount", {
                  defaultValue: "Skipped: {{count}}",
                  count: previewData.skippedCount
                })}
              </Typography.Text>
              {typeof previewData.inFlightCount === "number" &&
              typeof previewData.inFlightLimit === "number" ? (
                <Typography.Text type="secondary">
                  {t("newsSources.preview.inFlightCount", {
                    defaultValue: "In-flight: {{count}}/{{limit}}",
                    count: previewData.inFlightCount,
                    limit: previewData.inFlightLimit
                  })}
                </Typography.Text>
              ) : null}
            </Space>

            <Table
              rowKey="url"
              size="small"
              loading={previewLoading}
              columns={previewColumns}
              dataSource={previewData.candidates}
              pagination={{ pageSize: screens.md ? 10 : 5 }}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {previewLoading
              ? t("newsSources.preview.loading", { defaultValue: "Loading preview..." })
              : t("newsSources.preview.empty", { defaultValue: "No preview data." })}
          </Typography.Text>
        )}
      </Modal>
    </>
  );
}
