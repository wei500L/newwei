"use client";

import { sanitizeCrawlOptions } from "@modular/utils";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Form,
  Grid,
  InputNumber,
  Popover,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import axios from "axios";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Crawl4aiHealthCard } from "@/app/(app)/crawl/components/Crawl4aiHealthCard";
import type { CreateCrawlTaskFormValues } from "@/app/(app)/crawl/types";
import { captureClientError } from "@/lib/client-telemetry";
import { findUnsupportedProxyIssues } from "@/lib/crawl-config-policy";
import { normalizeHeadlessModeFormValues } from "@/lib/crawl-headless-mode";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { resolveRssAdaptiveListUiModel } from "@/lib/news-source-rss-adaptive-ui";
import {
  normalizeSeedMode,
  shouldShowCrawlSettingsForSeedMode,
} from "@/lib/news-source-seed";

import { NewsSourcesModals } from "./news-sources-modals";
import { NewsSourcesOpsPanels } from "./news-sources-ops-panels";
import { NewsSourcesTable } from "./news-sources-table";
import {
  buildNewsSourceConfig,
  buildNewsSourceFormValues,
  extractApiErrorMessage,
  formatPolicyIssues,
  getNewsSourceSiteTypeOptions,
  inferSourceNameFromUrl,
  LIVE_EVENT_SOURCES,
  NEWS_SOURCE_CREATE_INITIAL_VALUES,
  resolveScheduleDeliveryMode,
} from "./news-sources.helpers";
import type {
  NewsSourceDispatchResponse,
  NewsSourceFormValues,
  NewsSourceOpmlImportReport,
  NewsSourceOpmlMode,
  NewsSourceOpmlPresetSummary,
  NewsSourceOpmlPreviewEntry,
  NewsSourceOpmlPreviewResponse,
  NewsSourcePreviewResponse,
  NewsSourceRecord,
  NewsSourceScheduleValues,
  NewsSourcesUiBusy,
} from "./news-sources.types";
import { useNewsSourcesData } from "./use-news-sources-data";

export function NewsSourcesContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const canWriteItems = permissions.includes("items.write");
  const [messageApi, contextHolder] = message.useMessage();
  const [saving, setSaving] = useState(false);
  const [creatingFromTaskDrawer, setCreatingFromTaskDrawer] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [opmlModalOpen, setOpmlModalOpen] = useState(false);
  const [opmlMode, setOpmlMode] = useState<NewsSourceOpmlMode>("preset");
  const [opmlPresets, setOpmlPresets] = useState<NewsSourceOpmlPresetSummary[]>(
    [],
  );
  const [opmlPresetId, setOpmlPresetId] = useState<string>("");
  const [opmlDefaultLanguage, setOpmlDefaultLanguage] = useState("zh");
  const [opmlContent, setOpmlContent] = useState("");
  const [opmlFileName, setOpmlFileName] = useState<string | null>(null);
  const [opmlPreview, setOpmlPreview] =
    useState<NewsSourceOpmlPreviewResponse | null>(null);
  const [opmlLoadingPresets, setOpmlLoadingPresets] = useState(false);
  const [opmlPreviewing, setOpmlPreviewing] = useState(false);
  const [opmlImporting, setOpmlImporting] = useState(false);
  const [opmlImportReport, setOpmlImportReport] =
    useState<NewsSourceOpmlImportReport | null>(null);
  const [editingSource, setEditingSource] = useState<NewsSourceRecord | null>(
    null,
  );
  const [modalFormValues, setModalFormValues] = useState<
    Partial<NewsSourceFormValues>
  >(NEWS_SOURCE_CREATE_INITIAL_VALUES);
  const [form] = Form.useForm<NewsSourceFormValues>();
  const [createDrawerForm] = Form.useForm<CreateCrawlTaskFormValues>();
  const [scheduleForm] = Form.useForm<NewsSourceScheduleValues>();
  const screens = Grid.useBreakpoint();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRunNowLoading, setPreviewRunNowLoading] = useState(false);
  const [previewSource, setPreviewSource] = useState<NewsSourceRecord | null>(
    null,
  );
  const [previewData, setPreviewData] =
    useState<NewsSourcePreviewResponse | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleTargets, setScheduleTargets] = useState<NewsSourceRecord[]>(
    [],
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [batchRunLoading, setBatchRunLoading] = useState(false);
  const [batchToggleLoading, setBatchToggleLoading] = useState(false);
  const [batchGroupLoading, setBatchGroupLoading] = useState(false);
  const [dispatchingSourceIds, setDispatchingSourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [opsLoadingSourceIds, setOpsLoadingSourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const seedModeRef = useRef<NewsSourceFormValues["seedMode"]>("sitemap");

  const uiBusy: NewsSourcesUiBusy = {
    modalOpen,
    createDrawerOpen,
    previewOpen,
    scheduleOpen,
    saving,
    scheduleLoading,
    previewLoading,
    previewRunNowLoading,
    batchRunLoading,
    batchToggleLoading,
    dispatchingCount: dispatchingSourceIds.size,
    opsLoadingCount: opsLoadingSourceIds.size,
  };

  const data = useNewsSourcesData({
    canView,
    canManage,
    accessToken: session?.accessToken,
    sessionStatus: status,
    t,
    messageApi,
    modalOpen,
    uiBusy,
  });
  const {
    apiClient,
    loading,
    sources,
    sourceTotal,
    sourcePage,
    sourcePageSize,
    setSourcePage,
    setSourcePageSize,
    sourceIndex,
    templates,
    workflowOptions,
    searchInput,
    setSearchInput,
    crawlQueueStats,
    crawlQueueLoading,
    crawlQueueError,
    crawlQualityStats,
    crawlQualityLoading,
    crawlQualityError,
    readinessSummary,
    readinessLoading,
    readinessError,
    uniqueGroups,
    seedSchedulerSettings,
    seedSchedulerSettingsLoadFailed,
    resolvedSeedRuntimeSettings,
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    autoRefreshSeconds,
    setAutoRefreshSeconds,
    liveUpdatesEnabled,
    setLiveUpdatesEnabled,
    liveStatus,
    liveError,
    liveLastEvent,
    liveEventCount,
    liveEventCountsBySource,
    liveRefreshSources,
    setLiveRefreshSources,
    lastUpdatedAt,
    loadSources,
    loadReadinessSummary,
    loadGroups,
    loadCrawlQueueStats,
    loadCrawlQualityStats,
    refreshAll,
    resetLiveCounters,
  } = data;

  const selectedSources = useMemo(
    () =>
      selectedSourceIds
        .map((id) => sourceIndex[id])
        .filter((source): source is NewsSourceRecord => Boolean(source)),
    [selectedSourceIds, sourceIndex],
  );
  const watchedSeedEnabled = Form.useWatch("seedEnabled", form);
  const watchedSeedMode = Form.useWatch("seedMode", form);
  const showCrawlSettings = useMemo(
    () =>
      shouldShowCrawlSettingsForSeedMode(watchedSeedEnabled, watchedSeedMode),
    [watchedSeedEnabled, watchedSeedMode],
  );
  const scheduleDeliveryMode = useMemo(
    () => resolveScheduleDeliveryMode(scheduleTargets),
    [scheduleTargets],
  );
  const siteTypeOptions = getNewsSourceSiteTypeOptions(t);
  const templateMap = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  );
  const templateOptions = useMemo(
    () =>
      templates.map((template) => ({
        value: template.id,
        label: template.isActive
          ? template.name
          : `${template.name} (${t("common.disabled")})`,
      })),
    [t, templates],
  );

  useEffect(() => {
    if (!modalOpen) {
      return;
    }

    seedModeRef.current = normalizeSeedMode(modalFormValues.seedMode);
    form.resetFields();
    form.setFieldsValue({
      ...modalFormValues,
      group: modalFormValues.group ?? undefined,
    });
  }, [form, modalFormValues, modalOpen]);

  const resolveRssAdaptiveObservability = useCallback(
    (record: NewsSourceRecord) =>
      resolveRssAdaptiveListUiModel({
        config: record.config,
        frequencySeconds: record.frequencySeconds,
        priority: record.priority,
        rssAdaptiveState: record.rssAdaptiveState,
        runtimeSettings: resolvedSeedRuntimeSettings,
      }),
    [resolvedSeedRuntimeSettings],
  );

  const loadOpmlPresets = useCallback(async () => {
    setOpmlLoadingPresets(true);
    try {
      const response = await apiClient.get<NewsSourceOpmlPresetSummary[]>(
        "admin/news-sources/opml-presets",
      );
      const presets = response.data ?? [];
      setOpmlPresets(presets);
      const firstPresetId = presets[0]?.id ?? "";
      const firstDefaultLanguage = presets[0]?.defaultLanguage ?? "zh";
      setOpmlPresetId((prev) => prev || firstPresetId);
      setOpmlDefaultLanguage((prev) => prev || firstDefaultLanguage);
    } catch (error) {
      captureClientError("Failed to load OPML presets", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.opml.errors.loadPresets"),
      );
    } finally {
      setOpmlLoadingPresets(false);
    }
  }, [apiClient, messageApi, t]);

  const livePopoverContent = (
    <div style={{ maxWidth: 420 }}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        {liveError ? (
          <Alert
            type="error"
            showIcon
            message={t("newsSources.liveUpdates.error")}
            description={liveError}
          />
        ) : null}

        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">
            {t("newsSources.liveUpdates.details.lastEvent")}
          </Typography.Text>
          {liveLastEvent ? (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Space wrap>
                <Tag>{liveLastEvent.source}</Tag>
                <Tag color="blue">{liveLastEvent.event}</Tag>
              </Space>
              {liveLastEvent.jobId ? (
                <Typography.Text
                  code
                  copyable
                  ellipsis={{ tooltip: liveLastEvent.jobId }}
                >
                  {liveLastEvent.jobId}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {formatDateTime(liveLastEvent.timestamp, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {t("common.noData")}
            </Typography.Text>
          )}
        </Space>

        <Divider style={{ margin: "4px 0" }} />

        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("newsSources.liveUpdates.details.refreshOn")}
          </Typography.Text>
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            {LIVE_EVENT_SOURCES.map((source) => (
              <div
                key={source}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Checkbox
                  checked={liveRefreshSources[source]}
                  onChange={(event) =>
                    setLiveRefreshSources((prev) => ({
                      ...prev,
                      [source]: event.target.checked,
                    }))
                  }
                >
                  {source}
                </Checkbox>
                <Typography.Text type="secondary">
                  {liveEventCountsBySource[source]}
                </Typography.Text>
              </div>
            ))}
          </Space>
          <Space>
            <Button size="small" onClick={resetLiveCounters}>
              {t("newsSources.liveUpdates.details.resetCounters")}
            </Button>
          </Space>
        </Space>
      </Space>
    </div>
  );

  const openCreate = () => {
    setEditingSource(null);
    setModalOpen(false);
    createDrawerForm.resetFields();
    setCreateDrawerOpen(true);
  };

  const openOpmlImport = async () => {
    setOpmlImportReport(null);
    setOpmlPreview(null);
    setOpmlContent("");
    setOpmlFileName(null);
    setOpmlMode("preset");
    setOpmlDefaultLanguage("zh");
    setOpmlModalOpen(true);
    if (opmlPresets.length === 0) {
      await loadOpmlPresets();
    }
  };


  const openEdit = (source: NewsSourceRecord) => {
    const nextFormValues = buildNewsSourceFormValues(
      source,
      resolvedSeedRuntimeSettings,
    );
    setEditingSource(source);
    setModalFormValues(nextFormValues);
    setModalOpen(true);
  };

  const buildConfig = (values: NewsSourceFormValues) =>
    buildNewsSourceConfig(values, editingSource, t);

  const closeCreateDrawer = () => {
    setCreateDrawerOpen(false);
    createDrawerForm.resetFields();
  };

  const normalizeCreateDrawerValues = (
    values: CreateCrawlTaskFormValues,
  ): CreateCrawlTaskFormValues => {
    return normalizeHeadlessModeFormValues(values);
  };

  const handleCreateFromTaskDrawer = async (
    values: CreateCrawlTaskFormValues,
  ) => {
    setCreatingFromTaskDrawer(true);
    let crawlOptions: ReturnType<typeof sanitizeCrawlOptions>;
    try {
      crawlOptions = sanitizeCrawlOptions(normalizeCreateDrawerValues(values));
      const proxyIssues = findUnsupportedProxyIssues(
        crawlOptions,
        "config.crawlOptions",
      );
      if (proxyIssues.length > 0) {
        messageApi.error(formatPolicyIssues(proxyIssues, t));
        setCreatingFromTaskDrawer(false);
        return;
      }
    } catch (error) {
      messageApi.error(
        error instanceof Error ? error.message : "Invalid crawl options",
      );
      setCreatingFromTaskDrawer(false);
      return;
    }

    const url = values.url.trim();
    const name =
      values.displayName?.trim() || inferSourceNameFromUrl(url) || url;
    const config: Record<string, unknown> = {};
    if (values.keywords?.length) {
      config.keywords = values.keywords;
    }
    if (Object.keys(crawlOptions).length > 0) {
      config.crawlOptions = crawlOptions;
    }

    const payload = {
      name,
      url,
      siteType: NEWS_SOURCE_CREATE_INITIAL_VALUES.siteType ?? "general",
      language: "",
      crawlTemplateId: null,
      frequencySeconds:
        NEWS_SOURCE_CREATE_INITIAL_VALUES.frequencySeconds ?? 3600,
      priority: NEWS_SOURCE_CREATE_INITIAL_VALUES.priority ?? 0,
      isActive: NEWS_SOURCE_CREATE_INITIAL_VALUES.isActive ?? true,
      config: Object.keys(config).length ? config : null,
    };

    try {
      const response = await apiClient.post<NewsSourceRecord>(
        "admin/news-sources",
        payload,
      );
      messageApi.success(
        t("newsSources.messages.created"),
      );
      closeCreateDrawer();
      await loadSources();
      if (response.data) {
        openEdit(response.data);
      }
    } catch (error) {
      captureClientError("Failed to create news source (task drawer)", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.errors.saveFailed")),
      );
    } finally {
      setCreatingFromTaskDrawer(false);
    }
  };

  const handleSubmit = async (values: NewsSourceFormValues) => {
    setSaving(true);
    try {
      const config = buildConfig(values);
      const groupValue = values.group?.[0]?.trim() ?? "";
      const payload = {
        name: values.name,
        url: values.url,
        siteType: values.siteType,
        language: values.language?.trim() ?? "",
        group: groupValue || null,
        crawlTemplateId: values.crawlTemplateId?.trim()
          ? values.crawlTemplateId.trim()
          : null,
        workflowId: values.workflowId?.trim() ? values.workflowId.trim() : null,
        workflowVersionId: values.workflowVersionId?.trim()
          ? values.workflowVersionId.trim()
          : null,
        workflowBindingMode: values.workflowBindingMode ?? "published",
        frequencySeconds: values.frequencySeconds,
        priority: values.priority,
        isActive: values.isActive,
        config,
      };
      if (editingSource) {
        await apiClient.patch(
          `admin/news-sources/${editingSource.id}`,
          payload,
        );
      } else {
        await apiClient.post("admin/news-sources", payload);
      }
      messageApi.success(
        editingSource
          ? t("newsSources.messages.updated")
          : t("newsSources.messages.created"),
      );
      setModalOpen(false);
      setEditingSource(null);
      form.resetFields();
      await loadSources();
    } catch (error) {
      captureClientError("Failed to save news source", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.errors.saveFailed")),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleOpmlModeChange = (mode: NewsSourceOpmlMode) => {
    setOpmlMode(mode);
    setOpmlPreview(null);
    setOpmlImportReport(null);
  };

  const handleOpmlFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      setOpmlContent(text);
      setOpmlFileName(file.name);
      setOpmlPreview(null);
      setOpmlImportReport(null);
      setOpmlMode("upload");
    } catch (error) {
      captureClientError("Failed to read OPML file", error);
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("newsSources.opml.errors.readFile"),
      );
    } finally {
      event.target.value = "";
    }
  };

  const handlePreviewOpml = async () => {
    setOpmlPreviewing(true);
    setOpmlImportReport(null);
    try {
      const payload =
        opmlMode === "preset"
          ? {
              presetId: opmlPresetId,
              defaultLanguage: opmlDefaultLanguage,
            }
          : {
              opmlContent,
              defaultLanguage: opmlDefaultLanguage,
            };
      const response = await apiClient.post<NewsSourceOpmlPreviewResponse>(
        "admin/news-sources/opml/preview",
        payload,
      );
      setOpmlPreview(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to preview OPML", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.opml.errors.preview")),
      );
    } finally {
      setOpmlPreviewing(false);
    }
  };

  const handleApplyOpmlDefaultLanguage = () => {
    const language = opmlDefaultLanguage.trim();
    if (!language) {
      return;
    }
    setOpmlPreview((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        entries: prev.entries.map((entry) =>
          entry.enabled
            ? {
                ...entry,
                language,
              }
            : entry,
        ),
      };
    });
  };

  const updateOpmlPreviewEntry = (
    index: number,
    patch: Partial<NewsSourceOpmlPreviewEntry>,
  ) => {
    setOpmlPreview((prev) => {
      if (!prev) {
        return prev;
      }
      if (index < 0 || index >= prev.entries.length) {
        return prev;
      }
      const nextEntries = [...prev.entries];
      const current = nextEntries[index];
      if (!current) {
        return prev;
      }
      nextEntries[index] = {
        ...current,
        ...patch,
      };
      return {
        ...prev,
        entries: nextEntries,
      };
    });
  };

  const handleImportOpml = async () => {
    if (!opmlPreview) {
      messageApi.warning(
        t("newsSources.opml.errors.previewFirst"),
      );
      return;
    }
    setOpmlImporting(true);
    try {
      const payload = {
        entries: opmlPreview.entries.map((entry) => ({
          name: entry.name,
          url: entry.url,
          feedUrl: entry.feedUrl,
          language: entry.language,
          enabled: entry.enabled,
          group: entry.group ?? null,
          siteType: "general",
        })),
        conflictPolicy: "skip",
        runtimeProfile: "steady",
      };

      const response = await apiClient.post<NewsSourceOpmlImportReport>(
        "admin/news-sources/opml/import",
        payload,
      );
      const report = response.data;
      setOpmlImportReport(report);
      messageApi.success(
        t("newsSources.opml.messages.imported", {
          created: report?.summary?.created ?? 0,
          skipped: report?.summary?.skipped ?? 0,
          failed: report?.summary?.failed ?? 0,
        }),
      );
      await loadSources();
    } catch (error) {
      captureClientError("Failed to import OPML", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.opml.errors.import")),
      );
    } finally {
      setOpmlImporting(false);
    }
  };

  const handleRunNow = async (source: NewsSourceRecord) => {
    setDispatchingSourceIds((prev) => {
      const next = new Set(prev);
      next.add(source.id);
      return next;
    });
    try {
      const response = await apiClient.post<NewsSourceDispatchResponse>(
        `admin/news-sources/${source.id}/dispatch`,
      );
      const payload = response.data;
      await loadSources();

      const nextRunAtLabel = payload?.nextRunAt
        ? formatDateTime(payload.nextRunAt, locale, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : null;

      const openTaskButton =
        payload?.crawlTaskIds?.length > 0 ? (
          <Button
            type="link"
            size="small"
            onClick={() =>
              router.push(`/admin/ops/crawl-tasks/${payload.crawlTaskIds[0]}`)
            }
          >
            {t("newsSources.actions.openTask")}
          </Button>
        ) : null;

      if (payload?.reason === "deduped") {
        const untilLabel = payload?.dedupeUntil
          ? formatDateTime(payload.dedupeUntil, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : null;
        messageApi.info(
          <Space size={6} wrap>
            <span>
              {t("newsSources.messages.runDeduped")}
              {untilLabel
                ? ` ${t("newsSources.messages.tryAfter", { time: untilLabel })}`
                : ""}
            </span>
            {openTaskButton}
          </Space>,
        );
        return;
      }

      if (payload?.reason === "in_flight") {
        messageApi.warning(
          <Space size={6} wrap>
            <span>
              {t("newsSources.messages.runSkippedInFlight", {
                count: payload.inFlightCount ?? 0,
                limit: payload.inFlightLimit ?? 0,
              })}
              {nextRunAtLabel
                ? ` ${t("newsSources.messages.nextRunAt", { time: nextRunAtLabel })}`
                : ""}
            </span>
          </Space>,
        );
        return;
      }

      if (payload?.reason === "no_new_urls") {
        messageApi.info(
          <Space size={6} wrap>
            <span>
              {t("newsSources.messages.noNewUrls")}
              {nextRunAtLabel
                ? ` ${t("newsSources.messages.nextRunAt", { time: nextRunAtLabel })}`
                : ""}
            </span>
          </Space>,
        );
        return;
      }

      const queuedText = t(
        payload?.mode === "rss"
          ? "newsSources.messages.runQueuedJobsCount"
          : "newsSources.messages.runQueuedCount",
        {
          defaultValue:
            payload?.mode === "rss"
              ? "Queued {{count}} job(s)."
              : "Queued {{count}} task(s).",
          count: payload?.scheduledCount ?? 0,
        },
      );
      const skippedText =
        typeof payload?.skippedCount === "number" && payload.skippedCount > 0
          ? t("newsSources.messages.runSkippedCount", {
              count: payload.skippedCount,
            })
          : null;
      const failureText =
        typeof payload?.enqueueFailures === "number" &&
        payload.enqueueFailures > 0
          ? t("newsSources.messages.runEnqueueFailures", {
              count: payload.enqueueFailures,
            })
          : null;
      const rssNoBodySkippedText =
        typeof payload?.rssSkippedNoBodyCount === "number" &&
        payload.rssSkippedNoBodyCount > 0
          ? t("newsSources.messages.runRssNoBodySkipped", {
              count: payload.rssSkippedNoBodyCount,
            })
          : null;

      const toastType =
        typeof payload?.enqueueFailures === "number" &&
        payload.enqueueFailures > 0
          ? "warning"
          : "success";
      messageApi.open({
        type: toastType,
        content: (
          <Space size={8} wrap>
            <span>
              {queuedText}
              {skippedText ? ` ${skippedText}` : ""}
              {rssNoBodySkippedText ? ` ${rssNoBodySkippedText}` : ""}
              {failureText ? ` ${failureText}` : ""}
              {nextRunAtLabel
                ? ` ${t("newsSources.messages.nextRunAt", { time: nextRunAtLabel })}`
                : ""}
            </span>
            {openTaskButton}
          </Space>
        ),
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        messageApi.info(
          t("newsSources.messages.dispatchInProgress"),
        );
        return;
      }
      captureClientError("Failed to run news source now", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.errors.runFailed"),
      );
    } finally {
      setDispatchingSourceIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
    }
  };
  const openSchedule = (source: NewsSourceRecord) => {
    const candidate = source.nextRunAt ? dayjs(source.nextRunAt) : null;
    const initial =
      candidate && candidate.isValid() && candidate.isAfter(dayjs())
        ? candidate
        : dayjs().add(5, "minute");
    setScheduleTargets([source]);
    setScheduleOpen(true);
    scheduleForm.setFieldsValue({ nextRunAt: initial });
  };

  const openBatchSchedule = (targets: NewsSourceRecord[]) => {
    if (targets.length === 0) {
      return;
    }
    setScheduleTargets(targets);
    setScheduleOpen(true);
    scheduleForm.setFieldsValue({ nextRunAt: dayjs().add(5, "minute") });
  };

  const closeSchedule = () => {
    setScheduleOpen(false);
    setScheduleTargets([]);
    scheduleForm.resetFields();
  };

  const handleSchedule = async (values: NewsSourceScheduleValues) => {
    const targets = scheduleTargets;
    if (!targets || targets.length === 0) {
      return;
    }

    if (!values.nextRunAt?.isValid?.() || values.nextRunAt.isBefore(dayjs())) {
      messageApi.error(
        t("newsSources.schedule.validation.future"),
      );
      return;
    }

    setScheduleLoading(true);
    try {
      const scheduledAtIso = values.nextRunAt.toISOString();
      const results = await Promise.allSettled(
        targets.map((target) =>
          apiClient.post(`admin/news-sources/${target.id}/schedule`, {
            nextRunAt: scheduledAtIso,
          }),
        ),
      );
      const okCount = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      const failedCount = results.length - okCount;
      const timeLabel = formatDateTime(scheduledAtIso, locale, {
        dateStyle: "medium",
        timeStyle: "short",
      });

      if (failedCount > 0) {
        messageApi.warning(
          t("newsSources.messages.scheduledBatchPartial", {
            ok: okCount,
            total: results.length,
            time: timeLabel,
          }),
        );
      } else {
        messageApi.success(
          t("newsSources.messages.scheduledBatch", {
            count: okCount,
            time: timeLabel,
          }),
        );
      }
      closeSchedule();
      setSelectedSourceIds([]);
      await loadSources();
    } catch (error) {
      captureClientError("Failed to schedule news source", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.errors.runFailed")),
      );
    } finally {
      setScheduleLoading(false);
    }
  };
  const handlePreview = async (source: NewsSourceRecord) => {
    setPreviewSource(source);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const response = await apiClient.get<NewsSourcePreviewResponse>(
        `admin/news-sources/${source.id}/preview`,
      );
      setPreviewData(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to preview news source", error);
      const detail =
        extractApiErrorMessage(error) ??
        (error instanceof Error ? error.message : null);
      messageApi.error(
        detail ??
          t("newsSources.errors.previewFailed"),
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

  const handleScheduleFromPreview = () => {
    if (!previewSource) {
      return;
    }
    const source = previewSource;
    setPreviewOpen(false);
    setPreviewSource(null);
    setPreviewData(null);
    openSchedule(source);
  };
  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Typography.Text type="secondary">
          {t("common.loading")}
        </Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("newsSources.title")}
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
    <>
      {contextHolder}
      <Card
        className="content-card"
        title={t("newsSources.title")}
        extra={
          <Space wrap>
            <Button
              size="small"
              onClick={() => void refreshAll()}
              loading={loading || crawlQueueLoading}
            >
              {t("common.refresh")}
            </Button>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("newsSources.autoRefresh.label")}
              </Typography.Text>
              <Switch
                checked={autoRefreshEnabled}
                onChange={(checked) => setAutoRefreshEnabled(checked)}
              />
              <InputNumber
                min={5}
                max={300}
                step={5}
                value={autoRefreshSeconds}
                onChange={(value) =>
                  setAutoRefreshSeconds(typeof value === "number" ? value : 30)
                }
                style={{ width: 88 }}
                disabled={!autoRefreshEnabled}
              />
              <Typography.Text type="secondary">s</Typography.Text>
            </Space>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("newsSources.liveUpdates.label")}
              </Typography.Text>
              <Switch
                checked={liveUpdatesEnabled}
                onChange={(checked) => setLiveUpdatesEnabled(checked)}
              />
              {liveUpdatesEnabled ? (
                <Popover
                  content={livePopoverContent}
                  trigger="click"
                  placement="bottomRight"
                >
                  <Tag
                    style={{ cursor: "pointer" }}
                    color={
                      liveError
                        ? "red"
                        : liveStatus === "connected"
                          ? "green"
                          : liveStatus === "connecting"
                            ? "blue"
                            : undefined
                    }
                  >
                    {liveError
                      ? t("newsSources.liveUpdates.error")
                      : liveStatus === "connected"
                        ? t("newsSources.liveUpdates.connected")
                        : liveStatus === "connecting"
                          ? t("newsSources.liveUpdates.connecting")
                          : t("newsSources.liveUpdates.disconnected")}
                    {liveStatus === "connected" && liveEventCount > 0
                      ? ` · ${liveEventCount}`
                      : ""}
                  </Tag>
                </Popover>
              ) : null}
            </Space>
            {canManage ? (
              <Space>
                <Button onClick={() => void openOpmlImport()}>
                  {t("newsSources.actions.importOpml")}
                </Button>
                <Button type="primary" onClick={openCreate}>
                  {t("newsSources.actions.new")}
                </Button>
              </Space>
            ) : null}
          </Space>

        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Crawl4aiHealthCard
            onOpenMonitor={() => router.push("/admin/ops/crawl-monitor")}
          />
          <NewsSourcesOpsPanels
            t={t}
            locale={locale}
            router={router}
            canManage={canManage}
            readinessSummary={readinessSummary}
            readinessLoading={readinessLoading}
            readinessError={readinessError}
            crawlQueueStats={crawlQueueStats}
            crawlQueueLoading={crawlQueueLoading}
            crawlQueueError={crawlQueueError}
            crawlQualityStats={crawlQualityStats}
            crawlQualityLoading={crawlQualityLoading}
            crawlQualityError={crawlQualityError}
            loadReadinessSummary={loadReadinessSummary}
            loadCrawlQueueStats={loadCrawlQueueStats}
            loadCrawlQualityStats={loadCrawlQualityStats}
            openCreate={openCreate}
            openOpmlImport={openOpmlImport}
          />
          {lastUpdatedAt ? (
            <Typography.Text type="secondary">
              {t("newsSources.autoRefresh.updatedAt", {
                time: formatDateTime(lastUpdatedAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </Typography.Text>
          ) : null}

          <NewsSourcesTable
            t={t}
            locale={locale}
            router={router}
            canManage={canManage}
            screens={screens}
            sources={sources}
            loading={loading}
            sourcePage={sourcePage}
            sourcePageSize={sourcePageSize}
            sourceTotal={sourceTotal}
            setSourcePage={setSourcePage}
            setSourcePageSize={setSourcePageSize}
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            selectedSourceIds={selectedSourceIds}
            setSelectedSourceIds={setSelectedSourceIds}
            selectedSources={selectedSources}
            uniqueGroups={uniqueGroups}
            templateMap={templateMap}
            siteTypeOptions={siteTypeOptions}
            resolveRssAdaptiveObservability={resolveRssAdaptiveObservability}
            dispatchingSourceIds={dispatchingSourceIds}
            opsLoadingSourceIds={opsLoadingSourceIds}
            setOpsLoadingSourceIds={setOpsLoadingSourceIds}
            batchRunLoading={batchRunLoading}
            setBatchRunLoading={setBatchRunLoading}
            batchToggleLoading={batchToggleLoading}
            setBatchToggleLoading={setBatchToggleLoading}
            batchGroupLoading={batchGroupLoading}
            setBatchGroupLoading={setBatchGroupLoading}
            scheduleLoading={scheduleLoading}
            apiClient={apiClient}
            loadSources={loadSources}
            loadGroups={loadGroups}
            messageApi={messageApi}
            handleRunNow={handleRunNow}
            openEdit={openEdit}
            handlePreview={handlePreview}
            openSchedule={openSchedule}
            openBatchSchedule={openBatchSchedule}
          />
        </Space>
      </Card>
      <NewsSourcesModals
        t={t}
        locale={locale}
        canManage={canManage}
        canWriteItems={canWriteItems}
        screens={screens}
        form={form}
        createDrawerForm={createDrawerForm}
        scheduleForm={scheduleForm}
        modalOpen={modalOpen}
        setModalOpen={setModalOpen}
        editingSource={editingSource}
        setEditingSource={setEditingSource}
        createDrawerOpen={createDrawerOpen}
        saving={saving}
        creatingFromTaskDrawer={creatingFromTaskDrawer}
        showCrawlSettings={showCrawlSettings}
        templateOptions={templateOptions}
        workflowOptions={workflowOptions}
        uniqueGroups={uniqueGroups}
        siteTypeOptions={siteTypeOptions}
        resolvedSeedRuntimeSettings={resolvedSeedRuntimeSettings}
        seedSchedulerSettings={seedSchedulerSettings}
        seedSchedulerSettingsLoadFailed={seedSchedulerSettingsLoadFailed}
        seedModeRef={seedModeRef}
        opmlModalOpen={opmlModalOpen}
        setOpmlModalOpen={setOpmlModalOpen}
        opmlMode={opmlMode}
        opmlPresets={opmlPresets}
        opmlPresetId={opmlPresetId}
        setOpmlPresetId={setOpmlPresetId}
        opmlDefaultLanguage={opmlDefaultLanguage}
        setOpmlDefaultLanguage={setOpmlDefaultLanguage}
        opmlContent={opmlContent}
        setOpmlContent={setOpmlContent}
        opmlFileName={opmlFileName}
        opmlPreview={opmlPreview}
        setOpmlPreview={setOpmlPreview}
        opmlLoadingPresets={opmlLoadingPresets}
        opmlPreviewing={opmlPreviewing}
        opmlImporting={opmlImporting}
        opmlImportReport={opmlImportReport}
        setOpmlImportReport={setOpmlImportReport}
        previewOpen={previewOpen}
        setPreviewOpen={setPreviewOpen}
        previewLoading={previewLoading}
        previewRunNowLoading={previewRunNowLoading}
        previewSource={previewSource}
        setPreviewSource={setPreviewSource}
        previewData={previewData}
        setPreviewData={setPreviewData}
        scheduleOpen={scheduleOpen}
        scheduleLoading={scheduleLoading}
        scheduleTargets={scheduleTargets}
        scheduleDeliveryMode={scheduleDeliveryMode}
        handleSubmit={handleSubmit}
        handleCreateFromTaskDrawer={handleCreateFromTaskDrawer}
        closeCreateDrawer={closeCreateDrawer}
        handleOpmlModeChange={handleOpmlModeChange}
        handleOpmlFileChange={handleOpmlFileChange}
        handlePreviewOpml={handlePreviewOpml}
        handleApplyOpmlDefaultLanguage={handleApplyOpmlDefaultLanguage}
        handleImportOpml={handleImportOpml}
        handleSchedule={handleSchedule}
        closeSchedule={closeSchedule}
        reloadPreview={reloadPreview}
        handleRunNowFromPreview={handleRunNowFromPreview}
        handleScheduleFromPreview={handleScheduleFromPreview}
        updateOpmlPreviewEntry={updateOpmlPreviewEntry}
        messageApi={messageApi}
      />
    </>
  );
}
