"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  Tabs,
  Typography,
  message,
} from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DataStateBoundary, type DataStateBoundaryState } from "@/components/data-state-boundary";
import { DashboardChart } from "@/components/echart";
import {
  AlertMetricProvider,
  useAlertEventReplayLazyQuery,
  useAlertRuleTuningSuggestionQuery,
} from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import {
  buildCsv,
  downloadCsv,
  downloadTextFile,
  formatDateForFilename,
} from "@/lib/data-export";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { classifyRequestError } from "@/lib/request-error";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";

import { AlertCenterFilters } from "./alert-center-filters";
import { buildThresholdSummary } from "./alert-center-list-model";
import {
  buildAlertExportJson,
  buildAlertExportRows,
  buildAlertStats,
  buildAlertTrend,
  buildRuleTrendAnalysis,
  buildSimilarAlerts,
  DEFAULT_FILTER_STATE,
  filterAlertEvents,
  resolveAlertCenterAccess,
  resolveFilterTimeWindow,
  type AlertFilterState,
} from "./alert-center.utils";
import { AlertEventList } from "./alert-event-list";
import type { AlertExportScope } from "./alert-event-list-toolbar";
import {
  buildReplayOption,
  buildRuleTrendOption,
  buildTrendOption,
} from "./alert-chart-options";
import { EconomicAnomalyEvidence } from "./economic-anomaly-evidence";
import { EntityAssociationEvidence } from "./entity-association-evidence";
import { EntitySentimentEvidence } from "./entity-sentiment-evidence";
import {
  DetailRow,
  formatContextValue,
  formatMetricChange,
  safeJsonStringify,
  toNumber,
  toStringValue,
} from "./evidence-utils";
import { useAlertCenterUrlState } from "./hooks/use-alert-center-url-state";
import { useAlertEventSelection } from "./hooks/use-alert-event-selection";
import { useAlertEventStatusActions } from "./hooks/use-alert-event-status-actions";
import { useAlertEventsFeed } from "./hooks/use-alert-events-feed";
import { RealtimeSignalEvidence } from "./realtime-signal-evidence";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red",
};

const deliveryStatusColor: Record<string, string> = {
  pending: "orange",
  sending: "blue",
  sent: "green",
  failed: "red",
};


const CONTEXT_OBJECT_KEYS = [
  {
    key: "countryName",
    labelKey: "alerts.center.detail.object.country",
    defaultLabel: "Country",
  },
  {
    key: "countryCode",
    labelKey: "alerts.center.detail.object.countryCode",
    defaultLabel: "Country code",
  },
  {
    key: "resource",
    labelKey: "alerts.center.detail.object.resource",
    defaultLabel: "Resource",
  },
  {
    key: "action",
    labelKey: "alerts.center.detail.object.action",
    defaultLabel: "Action",
  },
  {
    key: "queueName",
    labelKey: "alerts.center.detail.object.queue",
    defaultLabel: "Queue",
  },
  {
    key: "sourceId",
    labelKey: "alerts.center.detail.object.source",
    defaultLabel: "Source",
  },
  {
    key: "createdById",
    labelKey: "alerts.center.detail.object.actor",
    defaultLabel: "Actor",
  },
  {
    key: "statuses",
    labelKey: "alerts.center.detail.object.statuses",
    defaultLabel: "Statuses",
  },
];

export function AlertCenterContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status: sessionStatus } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const { authenticated, canReadAlerts, shouldQueryEvents } =
    resolveAlertCenterAccess(sessionStatus, permissions);
  const canManageAlerts = permissions.includes("alerts.manage");
  const [messageApi, messageContext] = message.useMessage();

  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [feedbackNote, setFeedbackNote] = useState<string>("");
  const [bulkNote, setBulkNote] = useState<string>("");
  const [includeRawExport, setIncludeRawExport] = useState<boolean>(false);
  const [detailTab, setDetailTab] = useState<string>("overview");
  const [exportScope, setExportScope] = useState<AlertExportScope>("selected");
  const [expandMessage, setExpandMessage] = useState<boolean>(false);
  const [expandContext, setExpandContext] = useState<boolean>(false);

  // 数据 feed（FE-批3B）：query / 订阅 / coalesced refetch / 排序 / 300→500。
  // messageApi 来自本组件已渲染的 useMessage 实例（提示真正展示）
  const {
    eventsData,
    eventsError,
    eventsLoading,
    refetchEvents,
    sortedEvents,
    isLikelySampled,
    canLoadMoreHistory,
    eventsLimit,
    loadMoreEvents,
    ensureEventLoaded,
  } = useAlertEventsFeed({
    shouldQueryEvents,
    messageApi,
    errorMessage: () => t("common.error.unexpected"),
  });

  // FE-01：筛选 / 分页 / 关键字 / 日期 / eventId 全部 URL-backed
  // （批量选择、备注、导出 scope、展开态、detailTab 仍为
  // 组件内存态，见 useAlertCenterUrlState 的契约注释）
  const {
    filterState,
    appliedRuleKeyword,
    ruleKeywordInput,
    setRuleKeywordInput,
    page: listPage,
    pageSize: listPageSize,
    eventId: eventParam,
    updateFilters,
    setPage: setListPage,
    setPageSize: setListPageSize,
    setPagePreservingEventId,
    setEventId,
  } = useAlertCenterUrlState();

  const { echartsTheme, colors, fontFamily } = useChartTheme();

  const [
    loadReplay,
    { data: replayData, loading: replayLoading, error: replayError },
  ] = useAlertEventReplayLazyQuery();

  // rule keyword 的 220ms debounce 由 useAlertCenterUrlState 承载
  // （输入即时值 ruleKeywordInput → 静默后写入 URL q → appliedRuleKeyword）
  const filterStateForQuery = useMemo<AlertFilterState>(
    () => ({
      ...filterState,
      ruleKeyword: appliedRuleKeyword,
    }),
    [appliedRuleKeyword, filterState],
  );
  const filterWindow = useMemo(
    () =>
      resolveFilterTimeWindow({
        ...DEFAULT_FILTER_STATE,
        datePreset: filterState.datePreset,
        customRangeMs: filterState.customRangeMs,
      }),
    [filterState.customRangeMs, filterState.datePreset],
  );
  const filteredEvents = useMemo(
    () => filterAlertEvents(sortedEvents, filterStateForQuery, filterWindow),
    [filterStateForQuery, filterWindow, sortedEvents],
  );
  const filteredEventIdSet = useMemo(
    () => new Set(filteredEvents.map((event) => event.id)),
    [filteredEvents],
  );

  const listPageCount = Math.max(
    1,
    Math.ceil(filteredEvents.length / listPageSize),
  );
  const currentPageEvents = useMemo(() => {
    const start = (listPage - 1) * listPageSize;
    return filteredEvents.slice(start, start + listPageSize);
  }, [filteredEvents, listPage, listPageSize]);

  // 选择与分页协调（FE-批3B）：默认选中 / filtered-out 保留 / URL eventId
  // 协调 / 一次性深链定位 / page 越界收敛（FE-01 优先级契约，见 hook 注释）
  const isEventsDataReady =
    shouldQueryEvents && !eventsLoading && eventsData !== undefined;
  const {
    selectedEventId,
    selectedEvent,
    handleSelectEvent,
    selectedIndexInFiltered,
  } = useAlertEventSelection({
    eventParam,
    sortedEvents,
    filteredEvents,
    listPage,
    listPageSize,
    listPageCount,
    isEventsDataReady,
    setEventId,
    setPagePreservingEventId,
  });

  const selectedRuleId = useMemo(
    () =>
      sortedEvents.find((event) => event.id === selectedEventId)?.ruleId ??
      null,
    [selectedEventId, sortedEvents],
  );

  const {
    data: tuningData,
    loading: tuningLoading,
    error: tuningError,
    refetch: refetchTuning,
  } = useAlertRuleTuningSuggestionQuery({
    variables: { ruleId: selectedRuleId ?? "", windowDays: 30 },
    skip: !canManageAlerts || !selectedRuleId,
  });

  // 状态修改与批量操作（FE-批3B）：20 条分批 + alerts.manage 双重门禁
  const {
    updatingStatus,
    batchProgress,
    executeStatusUpdate,
  } = useAlertEventStatusActions({
    canManageAlerts,
    messageApi,
    successMessage: (count, status) =>
      t("alerts.center.batch.updateSuccess", { count, status }),
    partialFailureMessage: (count) =>
      t("alerts.center.batch.updatePartial", { count }),
    refetchAfterSuccess: async () => {
      await refetchEvents();
      if (selectedRuleId && canManageAlerts) {
        await refetchTuning({ ruleId: selectedRuleId, windowDays: 30 });
      }
    },
  });

  useEffect(() => {
    const existingIds = new Set(sortedEvents.map((event) => event.id));
    setSelectedEventIds((prev) => prev.filter((id) => existingIds.has(id)));
  }, [sortedEvents]);

  useEffect(() => {
    if (!selectedEvent) {
      setFeedbackNote("");
      return;
    }
    const eventContext =
      selectedEvent.context && typeof selectedEvent.context === "object"
        ? (selectedEvent.context as Record<string, unknown>)
        : null;
    const feedback =
      eventContext?.feedback &&
      typeof eventContext.feedback === "object" &&
      !Array.isArray(eventContext.feedback)
        ? (eventContext.feedback as Record<string, unknown>)
        : null;
    const note = typeof feedback?.note === "string" ? feedback.note : "";
    setFeedbackNote(note);
  }, [selectedEvent]);

  useEffect(() => {
    setDetailTab("overview");
    setExpandContext(false);
    setExpandMessage(false);
  }, [selectedEventId]);

  // 筛选变化后的 page 重置由 useAlertCenterUrlState 的 updateFilters 承载
  // （任何筛选 patch 都将 page 归 1；URL 外部变化时筛选与 page 同源采纳）

  useEffect(() => {
    if (detailTab !== "replay" || !selectedEvent) {
      return;
    }
    if (replayData?.alertEventReplay?.eventId === selectedEvent.id) {
      return;
    }
    loadReplay({
      variables: {
        eventId: selectedEvent.id,
        windowDays: 30,
      },
    });
  }, [
    detailTab,
    loadReplay,
    replayData?.alertEventReplay?.eventId,
    selectedEvent,
  ]);

  const replay =
    replayData?.alertEventReplay &&
    replayData.alertEventReplay.eventId === selectedEvent?.id
      ? replayData.alertEventReplay
      : null;
  const replayPoints = replay?.points;
  const replayUnit = replay?.unit;

  const handleOpenEvent = async (eventId: string) => {
    if (!eventId) {
      return;
    }
    // 深链事件不在当前数据集：feed 扩充 limit 至 500 并 refetch（一次性）
    await ensureEventLoaded(eventId);
    handleSelectEvent(eventId);
  };

  const handleEventStatusUpdate = async (status: "confirmed" | "ignored") => {
    if (!selectedEvent || !canManageAlerts) {
      return;
    }
    const note = feedbackNote.trim() ? feedbackNote.trim() : null;
    await executeStatusUpdate([selectedEvent.id], status, note);
  };

  const handleQuickConfirm = async () => {
    if (!selectedEvent || !canManageAlerts) {
      return;
    }
    await executeStatusUpdate([selectedEvent.id], "confirmed", null);
  };

  const handleBulkUpdate = async (status: "confirmed" | "ignored") => {
    if (selectedEventIds.length === 0) {
      return;
    }
    const note = bulkNote.trim() ? bulkNote.trim() : null;
    const updated = await executeStatusUpdate(selectedEventIds, status, note);
    if (updated > 0) {
      setSelectedEventIds([]);
      setBulkNote("");
    }
  };

  const selectedEventIdSet = useMemo(
    () => new Set(selectedEventIds),
    [selectedEventIds],
  );
  const selectedEventsForBatch = useMemo(
    () => sortedEvents.filter((event) => selectedEventIdSet.has(event.id)),
    [selectedEventIdSet, sortedEvents],
  );
  const exportEvents = useMemo(
    () => (exportScope === "page" ? currentPageEvents : selectedEventsForBatch),
    [currentPageEvents, exportScope, selectedEventsForBatch],
  );

  const handleExportCsv = async () => {
    if (exportEvents.length === 0) {
      return;
    }
    try {
      const rows = buildAlertExportRows(exportEvents, {
        includeContext: includeRawExport,
        includeDeliveries: includeRawExport,
      });
      const csv = await buildCsv(rows);
      const filename = `alerts-${formatDateForFilename(new Date())}.csv`;
      downloadCsv({ csv, filename });
      messageApi.success(
        t("alerts.center.export.success"),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("alerts.center.export.failed"),
      );
    }
  };

  const handleExportJson = () => {
    if (exportEvents.length === 0) {
      return;
    }
    try {
      const filename = `alerts-${formatDateForFilename(new Date())}.json`;
      const payload = JSON.stringify(
        buildAlertExportJson(exportEvents, {
          includeContext: includeRawExport,
          includeDeliveries: includeRawExport,
        }),
        null,
        2,
      );
      downloadTextFile(payload, filename, "application/json;charset=utf-8");
      messageApi.success(
        t("alerts.center.export.success"),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("alerts.center.export.failed"),
      );
    }
  };

  const stats = useMemo(
    () => buildAlertStats(filteredEvents),
    [filteredEvents],
  );
  const trendPoints = useMemo(
    () => buildAlertTrend(filteredEvents, filterWindow),
    [filterWindow, filteredEvents],
  );

  const similarAlerts = useMemo(
    () => buildSimilarAlerts(selectedEvent, sortedEvents, 5),
    [selectedEvent, sortedEvents],
  );
  const ruleTrendAnalysis = useMemo(
    () =>
      buildRuleTrendAnalysis(selectedEvent?.ruleId, sortedEvents, filterWindow),
    [filterWindow, selectedEvent?.ruleId, sortedEvents],
  );

  const previousEventId =
    selectedIndexInFiltered > 0
      ? filteredEvents[selectedIndexInFiltered - 1]?.id
      : null;
  const nextEventId =
    selectedIndexInFiltered >= 0 &&
    selectedIndexInFiltered < filteredEvents.length - 1
      ? filteredEvents[selectedIndexInFiltered + 1]?.id
      : null;

  const selectedInFilterCount = useMemo(
    () =>
      selectedEventIds.reduce(
        (count, eventId) =>
          filteredEventIdSet.has(eventId) ? count + 1 : count,
        0,
      ),
    [filteredEventIdSet, selectedEventIds],
  );
  const selectedVisibleCount = useMemo(
    () =>
      currentPageEvents.reduce(
        (count, event) =>
          selectedEventIdSet.has(event.id) ? count + 1 : count,
        0,
      ),
    [currentPageEvents, selectedEventIdSet],
  );
  const hiddenSelectedCount = Math.max(
    selectedEventIds.length - selectedInFilterCount,
    0,
  );
  const allVisibleSelected =
    currentPageEvents.length > 0 &&
    selectedVisibleCount === currentPageEvents.length;

  const handleSelectAllVisible = (checked: boolean) => {
    const visibleIds = currentPageEvents.map((event) => event.id);
    if (checked) {
      setSelectedEventIds((prev) => [...new Set([...prev, ...visibleIds])]);
      return;
    }
    const visibleSet = new Set(visibleIds);
    setSelectedEventIds((prev) => prev.filter((id) => !visibleSet.has(id)));
  };

  const handleToggleEventSelection = (eventId: string, checked: boolean) => {
    setSelectedEventIds((prev) => {
      if (checked) {
        return [...new Set([...prev, eventId])];
      }
      return prev.filter((id) => id !== eventId);
    });
  };

  const handleRefresh = async () => {
    await refetchEvents();
    if (canManageAlerts && selectedRuleId) {
      await refetchTuning({ ruleId: selectedRuleId, windowDays: 30 });
    }
  };

  const replayOption = useMemo<EChartsOption>(
    () =>
      buildReplayOption(
        { replay, replayPoints, replayUnit, selectedEvent },
        { primary: colors.primary, accent: colors.accent, fontFamily },
      ),
    [colors.accent, colors.primary, fontFamily, replay, replayPoints, replayUnit, selectedEvent],
  );

  const trendOption = useMemo<EChartsOption>(
    () =>
      buildTrendOption(
        trendPoints,
        { primary: colors.primary, accent: colors.accent, fontFamily },
        t,
      ),
    [colors.accent, colors.primary, fontFamily, t, trendPoints],
  );

  const ruleTrendOption = useMemo<EChartsOption>(
    () =>
      buildRuleTrendOption(
        ruleTrendAnalysis,
        { primary: colors.primary, accent: colors.accent, fontFamily },
        t,
      ),
    [colors.accent, colors.primary, fontFamily, ruleTrendAnalysis, t],
  );

  const trendWindowLabel = useMemo(() => {
    if (filterWindow.startMs === null || filterWindow.endMs === null) {
      return t("alerts.center.trend.followFilters");
    }
    const startLabel = formatDateTime(filterWindow.startMs, locale, {
      month: "2-digit",
      day: "2-digit",
    });
    const endLabel = formatDateTime(filterWindow.endMs, locale, {
      month: "2-digit",
      day: "2-digit",
    });
    return `${startLabel} - ${endLabel}`;
  }, [filterWindow.endMs, filterWindow.startMs, locale, t]);

  const context =
    selectedEvent?.context && typeof selectedEvent.context === "object"
      ? (selectedEvent.context as Record<string, unknown>)
      : null;
  const contextEntries = context ? Object.entries(context) : [];
  const objectKeyLabels = useMemo(
    () =>
      CONTEXT_OBJECT_KEYS.map((entry) => ({
        ...entry,
        label: t(entry.labelKey, { defaultValue: entry.defaultLabel }),
      })),
    [t],
  );
  const objectEntries = objectKeyLabels
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: context?.[entry.key],
    }))
    .filter(
      (entry) =>
        entry.value !== null && entry.value !== undefined && entry.value !== "",
    );

  const excludedContextKeys = new Set([
    ...objectKeyLabels.map((entry) => entry.key),
    "feedback",
    "latest",
    "previous",
    "metricSlug",
    "threshold",
    "lower",
    "upper",
    "changePercent",
    "windowMinutes",
    "sourceName",
    "sourceEndpoint",
    "sourceFunction",
    "sourceDocUrl",
    "sourceField",
    "unit",
    "recordedAt",
    "itemName",
  ]);

  if (selectedEvent?.metricProvider === AlertMetricProvider.EconomicAnomaly) {
    [
      "observed",
      "expected",
      "sigma",
      "residual",
      "score",
      "model",
      "diagnostics",
      "fallback",
    ].forEach((key) => excludedContextKeys.add(key));
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntitySentiment) {
    [
      "entityName",
      "entityType",
      "window",
      "baseline",
      "z",
      "minEntityConfidence",
      "evidence",
    ].forEach((key) => excludedContextKeys.add(key));
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntityAssociation) {
    [
      "seed",
      "sourceEvent",
      "targets",
      "minAssociationWeight",
      "maxTargets",
    ].forEach((key) => excludedContextKeys.add(key));
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.RealtimeSignal) {
    [
      "source",
      "stale",
      "latestTimestamp",
      "maxStaleMinutes",
      "countryCodes",
      "militaryCount",
      "disruptions",
      "outages",
      "unrestCount",
      "acledCount",
      "gdeltCount",
      "dedupeReducedBy",
      "defcon",
      "adjustedScore",
      "openLocations",
      "activeSpikes",
      "avgPop",
      "tensions",
      "leads",
      "spikes",
    ].forEach((key) => excludedContextKeys.add(key));
  }

  const additionalContext = contextEntries.filter(
    ([key]) => !excludedContextKeys.has(key),
  );
  const visibleAdditionalContext = expandContext
    ? additionalContext
    : additionalContext.slice(0, 6);

  const buildContextSummary = (input: Record<string, unknown> | null) => {
    if (!input) {
      return [];
    }
    return objectKeyLabels
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        value: input[entry.key],
      }))
      .filter(
        (entry) =>
          entry.value !== null &&
          entry.value !== undefined &&
          entry.value !== "",
      )
      .slice(0, 3);
  };

  const evidenceWindowMinutes =
    selectedEvent?.changeWindowMin ?? toNumber(context?.windowMinutes);
  const evidenceUnit = toStringValue(context?.unit);
  const evidencePrevious = toNumber(context?.previous);
  const evidenceRecordedAt =
    typeof context?.recordedAt === "string" ||
    typeof context?.recordedAt === "number"
      ? context?.recordedAt
      : undefined;
  const evidenceRecordedAtLabel = evidenceRecordedAt
    ? formatDateTime(evidenceRecordedAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : "";
  const evidenceSource =
    toStringValue(context?.sourceName) ??
    toStringValue(context?.sourceEndpoint) ??
    toStringValue(context?.sourceFunction) ??
    toStringValue(context?.sourceField) ??
    toStringValue(context?.source) ??
    toStringValue(selectedEvent?.metricSlug);
  const evidenceSourceDoc = toStringValue(context?.sourceDocUrl);

  const feedback =
    context?.feedback &&
    typeof context.feedback === "object" &&
    !Array.isArray(context.feedback)
      ? (context.feedback as Record<string, unknown>)
      : null;
  const feedbackStatus = toStringValue(feedback?.status);
  const feedbackUpdatedAt =
    typeof feedback?.updatedAt === "string" ||
    typeof feedback?.updatedAt === "number"
      ? feedback.updatedAt
      : undefined;
  const feedbackUpdatedAtLabel = feedbackUpdatedAt
    ? formatDateTime(feedbackUpdatedAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : "";
  const feedbackUpdatedById = toStringValue(feedback?.updatedById);
  const feedbackStoredNote =
    typeof feedback?.note === "string" ? feedback.note : null;

  const reviewStatus =
    feedbackStatus === "confirmed" || feedbackStatus === "ignored"
      ? feedbackStatus
      : selectedEvent?.status === "confirmed" ||
          selectedEvent?.status === "ignored"
        ? selectedEvent.status
        : null;

  const thresholdSummary = selectedEvent
    ? buildThresholdSummary(
        selectedEvent.operator,
        selectedEvent.thresholdValue ?? toNumber(context?.threshold),
        selectedEvent.thresholdLower ?? toNumber(context?.lower),
        selectedEvent.thresholdUpper ?? toNumber(context?.upper),
        t,
      )
    : t("common.notAvailable");

  const metricProviderLabel = (
    provider: AlertMetricProvider | string | null | undefined,
  ) =>
    provider
      ? t(`alerts.metricProviders.${provider}`, { defaultValue: provider })
      : t("common.notAvailable");

  const handleCopyRawContext = async () => {
    if (!context) {
      return;
    }
    try {
      await navigator.clipboard.writeText(safeJsonStringify(context));
      messageApi.success(
        t("alerts.center.contextCopied"),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("alerts.center.contextCopyFailed"),
      );
    }
  };

  const handleCopyAlertMarkdown = async () => {
    if (!selectedEvent) {
      return;
    }

    const markdownLines = [
      `# ${t("alerts.center.markdown.title")}`,
      "",
      `- **ID**: ${selectedEvent.id}`,
      `- **${t("alerts.center.detail.triggeredAt")}**: ${formatDateTime(
        selectedEvent.triggeredAt,
        locale,
        {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        },
      )}`,
      `- **${t("alerts.center.detail.rule")}**: ${selectedEvent.ruleName ?? t("common.notAvailable")}`,
      `- **${t("alerts.center.detail.metric", { metric: "" })}**: ${selectedEvent.metricSlug ?? t("common.notAvailable")}`,
      `- **${t("alerts.center.detail.provider", { provider: "" })}**: ${metricProviderLabel(selectedEvent.metricProvider)}`,
      `- **${t("alerts.center.detail.status")}**: ${selectedEvent.status}`,
      `- **${t("alerts.center.detail.metricValue")}**: ${selectedEvent.metricValue}`,
      `- **${t("alerts.center.detail.threshold")}**: ${thresholdSummary}`,
      "",
      `## ${t("alerts.center.detail.message")}`,
      selectedEvent.message ?? t("alerts.events.triggered"),
      "",
      `## ${t("alerts.center.detail.context")}`,
      "```json",
      safeJsonStringify(context ?? {}),
      "```",
      "",
      `## ${t("alerts.center.detail.deliveries")}`,
    ];

    if (selectedEvent.deliveries.length === 0) {
      markdownLines.push(
        `- ${t("alerts.center.deliveriesEmpty")}`,
      );
    } else {
      selectedEvent.deliveries.forEach((delivery) => {
        markdownLines.push(
          `- ${delivery.status} · ${delivery.channelType} · ${delivery.channelName ?? delivery.target ?? t("common.notAvailable")}`,
        );
      });
    }

    try {
      await navigator.clipboard.writeText(markdownLines.join("\n"));
      messageApi.success(
        t("alerts.center.markdown.copied"),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("alerts.center.contextCopyFailed"),
      );
    }
  };

  const falsePositivePercent =
    typeof stats.falsePositiveRate === "number"
      ? Number((stats.falsePositiveRate * 100).toFixed(1))
      : null;

  const detailTabs = selectedEvent
    ? [
        {
          key: "overview",
          label: t("alerts.center.tabs.overview"),
          children: (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <DetailRow
                label={t("alerts.center.detail.rule")}
              >
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>
                    {selectedEvent.ruleName ?? t("common.notAvailable")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("alerts.center.detail.metric", {
                      metric:
                        selectedEvent.metricSlug ?? t("common.notAvailable"),
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("alerts.center.detail.provider", {
                      provider: metricProviderLabel(
                        selectedEvent.metricProvider,
                      ),
                    })}
                  </Typography.Text>
                </Space>
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.threshold")}
              >
                <Space direction="vertical" size={2}>
                  <Typography.Text>
                    {t("alerts.center.detail.operator", {
                      operator:
                        selectedEvent.operator ?? t("common.notAvailable"),
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {thresholdSummary}
                  </Typography.Text>
                  {evidenceWindowMinutes !== null &&
                  evidenceWindowMinutes !== undefined ? (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.window", {
                        minutes: evidenceWindowMinutes,
                      })}
                    </Typography.Text>
                  ) : null}
                </Space>
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.triggeredAt")}
              >
                <Typography.Text>
                  {formatDateTime(selectedEvent.triggeredAt, locale, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    timeZoneName: "short",
                  })}
                </Typography.Text>
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.metricValue")}
              >
                <Space direction="vertical" size={2}>
                  <Space size="small" align="baseline">
                    <Typography.Text strong>
                      {selectedEvent.metricValue}
                    </Typography.Text>
                    {evidenceUnit ? (
                      <Typography.Text type="secondary">
                        {evidenceUnit}
                      </Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.changePercent", {
                        value: formatMetricChange(
                          selectedEvent.changePercent,
                          t("common.notAvailable"),
                        ),
                      })}
                    </Typography.Text>
                  </Space>
                  {evidencePrevious !== undefined ? (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.previousValue", {
                        value: evidencePrevious,
                      })}
                    </Typography.Text>
                  ) : null}
                  {evidenceRecordedAtLabel ? (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.recordedAt", {
                        time: evidenceRecordedAtLabel,
                      })}
                    </Typography.Text>
                  ) : null}
                </Space>
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.source")}
              >
                {evidenceSource || evidenceSourceDoc ? (
                  <Space direction="vertical" size={2}>
                    {evidenceSource ? (
                      <Typography.Text>{evidenceSource}</Typography.Text>
                    ) : null}
                    {evidenceSourceDoc ? (
                      <Typography.Link
                        href={evidenceSourceDoc}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {evidenceSourceDoc}
                      </Typography.Link>
                    ) : null}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {t("common.notAvailable")}
                  </Typography.Text>
                )}
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.objects")}
              >
                {objectEntries.length > 0 ? (
                  <Space size={[8, 8]} wrap>
                    {objectEntries.map((entry) => (
                      <Tag key={entry.key}>
                        {entry.label}: {formatContextValue(entry.value)}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {t("alerts.center.detail.objectsEmpty")}
                  </Typography.Text>
                )}
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.status")}
              >
                <Space>
                  <Tag color={severityColor[selectedEvent.severity] ?? "blue"}>
                    {selectedEvent.severity}
                  </Tag>
                  <Tag>{selectedEvent.status}</Tag>
                </Space>
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.message")}
              >
                <Typography.Paragraph
                  style={{ marginBottom: 4 }}
                  ellipsis={expandMessage ? false : { rows: 3 }}
                >
                  {selectedEvent.message ?? t("alerts.events.triggered")}
                </Typography.Paragraph>
                {(selectedEvent.message?.length ?? 0) > 180 ? (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setExpandMessage((prev) => !prev)}
                  >
                    {expandMessage
                      ? t("alerts.center.actions.collapse")
                      : t("alerts.center.actions.expand")}
                  </Button>
                ) : null}
              </DetailRow>
              <DetailRow
                label={t("alerts.center.detail.context")}
              >
                <Space direction="vertical" size={4} style={{ width: "100%" }}>
                  <Button
                    size="small"
                    onClick={() => void handleCopyRawContext()}
                    disabled={!context}
                  >
                    {t("alerts.center.detail.copyRawContext")}
                  </Button>
                  {visibleAdditionalContext.length > 0 ? (
                    visibleAdditionalContext.map(([key, value]) => (
                      <div key={key} className="flex justify-between gap-4">
                        <Typography.Text type="secondary">
                          {key}
                        </Typography.Text>
                        <Typography.Text>
                          {formatContextValue(value)}
                        </Typography.Text>
                      </div>
                    ))
                  ) : (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.contextEmpty")}
                    </Typography.Text>
                  )}
                  {additionalContext.length > 6 ? (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setExpandContext((prev) => !prev)}
                    >
                      {expandContext
                        ? t("alerts.center.actions.showLessContext")
                        : t("alerts.center.actions.showAllContext", {
                            count: additionalContext.length,
                          })}
                    </Button>
                  ) : null}
                </Space>
              </DetailRow>
            </Space>
          ),
        },
        {
          key: "evidence",
          label: t("alerts.center.tabs.evidence"),
          children: (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <DetailRow
                label={t("alerts.center.detail.evidence")}
              >
                {selectedEvent.metricProvider ===
                AlertMetricProvider.EconomicAnomaly ? (
                  <EconomicAnomalyEvidence
                    context={context}
                    locale={locale}
                    t={t}
                  />
                ) : selectedEvent.metricProvider ===
                  AlertMetricProvider.EntitySentiment ? (
                  <EntitySentimentEvidence
                    context={context}
                    locale={locale}
                    t={t}
                    colors={{ primary: colors.primary, accent: colors.accent }}
                    fontFamily={fontFamily}
                  />
                ) : selectedEvent.metricProvider ===
                  AlertMetricProvider.EntityAssociation ? (
                  <EntityAssociationEvidence
                    context={context}
                    locale={locale}
                    t={t}
                    onOpenEvent={(eventId) => void handleOpenEvent(eventId)}
                  />
                ) : selectedEvent.metricProvider ===
                  AlertMetricProvider.RealtimeSignal ? (
                  <RealtimeSignalEvidence
                    context={context}
                    locale={locale}
                    t={t}
                  />
                ) : (
                  <Typography.Text type="secondary">
                    {t("alerts.center.evidence.unsupported")}
                  </Typography.Text>
                )}
              </DetailRow>

              <Card
                size="small"
                title={t("alerts.center.analysis.similarTitle")}
              >
                {similarAlerts.length === 0 ? (
                  <Typography.Text type="secondary">
                    {t("alerts.center.analysis.similarEmpty")}
                  </Typography.Text>
                ) : (
                  <List
                    size="small"
                    dataSource={similarAlerts}
                    renderItem={(item) => (
                      <List.Item>
                        <Space
                          direction="vertical"
                          size={0}
                          style={{ width: "100%" }}
                        >
                          <Space size="small" wrap>
                            <Button
                              type="link"
                              size="small"
                              onClick={() => handleSelectEvent(item.event.id)}
                            >
                              {item.event.ruleName ?? item.event.id}
                            </Button>
                            <Tag color="blue">
                              {item.reason === "same_rule"
                                ? t("alerts.center.analysis.sameRule")
                                : t("alerts.center.analysis.sameMetric")}
                            </Tag>
                            <Tag>{item.event.status}</Tag>
                          </Space>
                          <Typography.Text type="secondary">
                            {formatDateTime(item.event.triggeredAt, locale, {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZoneName: "short",
                            })}
                          </Typography.Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                )}
              </Card>

              <Card
                size="small"
                title={t("alerts.center.analysis.ruleTrendTitle")}
              >
                <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("alerts.center.analysis.totalTriggers")}
                      value={ruleTrendAnalysis.totalTriggers}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("alerts.center.analysis.dailyAverage")}
                      value={Number(
                        ruleTrendAnalysis.averageDailyTriggers.toFixed(2),
                      )}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("alerts.center.analysis.falsePositiveRate")}
                      value={
                        typeof ruleTrendAnalysis.falsePositiveRate === "number"
                          ? Number(
                              (
                                ruleTrendAnalysis.falsePositiveRate * 100
                              ).toFixed(1),
                            )
                          : "--"
                      }
                      suffix={
                        typeof ruleTrendAnalysis.falsePositiveRate === "number"
                          ? "%"
                          : undefined
                      }
                    />
                  </Col>
                </Row>
                {ruleTrendAnalysis.points.length === 0 ? (
                  <ChartEmptyState
                    className="h-auto py-6"
                    description={t("alerts.center.analysis.ruleTrendEmpty")}
                  />
                ) : (
                  <DashboardChart
                    option={ruleTrendOption}
                    theme={echartsTheme}
                    height={240}
                  />
                )}
              </Card>
            </Space>
          ),
        },
        {
          key: "replay",
          label: t("alerts.center.tabs.replay"),
          children: (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Space size="small" wrap>
                <Button
                  size="small"
                  onClick={() =>
                    selectedEvent
                      ? loadReplay({
                          variables: {
                            eventId: selectedEvent.id,
                            windowDays: 30,
                          },
                        })
                      : undefined
                  }
                  loading={replayLoading}
                  disabled={!selectedEvent}
                >
                  {t("alerts.center.detail.openReplay")}
                </Button>
                <Typography.Text type="secondary">
                  {t("alerts.center.detail.replayHint")}
                </Typography.Text>
              </Space>
              {replayLoading ? (
                <div className="flex justify-center py-10">
                  <Spin />
                </div>
              ) : replayError ? (
                <Alert
                  type="error"
                  showIcon
                  message={t("alerts.center.detail.replayError")}
                  description={replayError.message}
                />
              ) : replay ? (
                replayPoints && replayPoints.length > 0 ? (
                  <DashboardChart
                    option={replayOption}
                    theme={echartsTheme}
                    height={300}
                  />
                ) : (
                  <ChartEmptyState
                    className="h-auto py-8"
                    description={t("alerts.center.detail.replayEmpty")}
                  />
                )
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message={t("alerts.center.detail.replayUnsupported")}
                />
              )}
            </Space>
          ),
        },
        {
          key: "feedback",
          label: t("alerts.center.tabs.feedback"),
          children: (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <DetailRow
                label={t("alerts.center.detail.feedback")}
              >
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Space size="small" wrap>
                    {reviewStatus ? (
                      <Tag
                        color={
                          reviewStatus === "confirmed" ? "green" : "default"
                        }
                      >
                        {reviewStatus}
                      </Tag>
                    ) : (
                      <Tag>
                        {t("alerts.center.detail.unreviewed")}
                      </Tag>
                    )}
                    {feedbackUpdatedAtLabel ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.feedbackUpdatedAt", {
                          time: feedbackUpdatedAtLabel,
                        })}
                      </Typography.Text>
                    ) : null}
                    {feedbackUpdatedById ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.feedbackUpdatedBy", {
                          user: feedbackUpdatedById,
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>

                  {feedbackStoredNote ? (
                    <Typography.Text>{feedbackStoredNote}</Typography.Text>
                  ) : reviewStatus ? (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.feedbackEmpty")}
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.feedbackNotReviewed")}
                    </Typography.Text>
                  )}

                  {canManageAlerts ? (
                    <>
                      <Input.TextArea
                        id="alerts-feedback-note"
                        name="alertsFeedbackNote"
                        value={feedbackNote}
                        onChange={(event) =>
                          setFeedbackNote(event.target.value)
                        }
                        rows={2}
                        placeholder={t(
                          "alerts.center.detail.feedbackNotePlaceholder",
                        )}
                      />
                      <Space wrap>
                        <Button
                          type="primary"
                          size="small"
                          loading={updatingStatus}
                          onClick={() =>
                            void handleEventStatusUpdate("confirmed")
                          }
                        >
                          {t("alerts.center.detail.confirm")}
                        </Button>
                        <Button
                          size="small"
                          loading={updatingStatus}
                          onClick={() =>
                            void handleEventStatusUpdate("ignored")
                          }
                        >
                          {t("alerts.center.detail.ignore")}
                        </Button>
                        <Button
                          size="small"
                          loading={updatingStatus}
                          onClick={() => void handleQuickConfirm()}
                        >
                          {t("alerts.center.actions.quickConfirm")}
                        </Button>
                      </Space>
                    </>
                  ) : (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.feedbackAdminOnly")}
                    </Typography.Text>
                  )}
                </Space>
              </DetailRow>

              <DetailRow
                label={t("alerts.center.detail.tuning")}
              >
                {canManageAlerts ? (
                  tuningLoading ? (
                    <Spin size="small" />
                  ) : tuningError ? (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.tuningError")}
                    </Typography.Text>
                  ) : tuningData?.alertRuleTuningSuggestion ? (
                    <Space direction="vertical" size={2}>
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.tuningStats", {
                          reviewed:
                            tuningData.alertRuleTuningSuggestion.reviewedEvents,
                          confirmed:
                            tuningData.alertRuleTuningSuggestion
                              .confirmedEvents,
                          ignored:
                            tuningData.alertRuleTuningSuggestion.ignoredEvents,
                          rate:
                            typeof tuningData.alertRuleTuningSuggestion
                              .falsePositiveRate === "number"
                              ? `${(tuningData.alertRuleTuningSuggestion.falsePositiveRate * 100).toFixed(1)}%`
                              : t("common.notAvailable"),
                        })}
                      </Typography.Text>
                      {tuningData.alertRuleTuningSuggestion.message ? (
                        <Typography.Text>
                          {tuningData.alertRuleTuningSuggestion.message}
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary">
                          {t("alerts.center.detail.tuningEmpty")}
                        </Typography.Text>
                      )}
                      {typeof tuningData.alertRuleTuningSuggestion
                        .suggestedThresholdValue === "number" ? (
                        <Typography.Text type="secondary">
                          {t("alerts.center.detail.tuningThreshold", {
                            value:
                              tuningData.alertRuleTuningSuggestion
                                .suggestedThresholdValue,
                          })}
                        </Typography.Text>
                      ) : null}
                      {typeof tuningData.alertRuleTuningSuggestion
                        .suggestedThresholdLower === "number" ||
                      typeof tuningData.alertRuleTuningSuggestion
                        .suggestedThresholdUpper === "number" ? (
                        <Typography.Text type="secondary">
                          {t("alerts.center.detail.tuningRange", {
                            lower:
                              tuningData.alertRuleTuningSuggestion
                                .suggestedThresholdLower ??
                              t("common.notAvailable"),
                            upper:
                              tuningData.alertRuleTuningSuggestion
                                .suggestedThresholdUpper ??
                              t("common.notAvailable"),
                          })}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">
                      {t("common.notAvailable")}
                    </Typography.Text>
                  )
                ) : (
                  <Typography.Text type="secondary">
                    {t("alerts.center.detail.feedbackAdminOnly")}
                  </Typography.Text>
                )}
              </DetailRow>
            </Space>
          ),
        },
        {
          key: "deliveries",
          label: t("alerts.center.tabs.deliveries"),
          children: (
            <List
              size="small"
              dataSource={selectedEvent.deliveries}
              locale={{
                emptyText: t("alerts.center.deliveriesEmpty"),
              }}
              renderItem={(delivery) => (
                <List.Item>
                  <Space size="small" wrap>
                    <Tag
                      color={deliveryStatusColor[delivery.status] ?? "default"}
                    >
                      {delivery.status}
                    </Tag>
                    <Tag>{delivery.channelType}</Tag>
                    {delivery.channelName ? (
                      <Typography.Text>{delivery.channelName}</Typography.Text>
                    ) : null}
                    {!delivery.channelName && delivery.target ? (
                      <Typography.Text>{delivery.target}</Typography.Text>
                    ) : null}
                    {delivery.channelName && delivery.target ? (
                      <Typography.Text type="secondary">
                        {delivery.target}
                      </Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary">
                      {delivery.sentAt
                        ? formatDateTime(delivery.sentAt, locale, {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZoneName: "short",
                          })
                        : t("common.notAvailable")}
                    </Typography.Text>
                    {delivery.error ? (
                      <Typography.Text type="secondary">
                        {delivery.error}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </List.Item>
              )}
            />
          ),
        },
      ]
    : [];

  const blockingEventsErrorState =
    eventsError && sortedEvents.length === 0
      ? (() => {
          const baseState = buildRequestErrorEmptyState({
            t,
            error: eventsError,
            onRetry: () => {
              void handleRefresh();
            },
            actionLoading: eventsLoading,
            actionLabelOverride: t("dashboard.actions.retryFetch"),
            includeDetailText: false,
          });
          const errorKind = classifyRequestError(eventsError).kind;
          const description =
            errorKind === "permission" || errorKind === "auth"
              ? t("alerts.center.loadFailed.permission")
              : errorKind === "network" ||
                  errorKind === "timeout" ||
                  errorKind === "service"
                ? t("alerts.center.loadFailed.service")
                : t("alerts.center.loadFailed.default");

          return {
            ...baseState,
            title: t("alerts.center.loadFailed.title"),
            description: (
              <div className="flex flex-col items-center gap-1">
                <span>{description}</span>
                {baseState.detailText ? (
                  <span className="font-mono text-[10px] opacity-80">
                    {t("alerts.center.loadFailed.detail")}
                    : {baseState.detailText}
                  </span>
                ) : null}
              </div>
            ),
          };
        })()
      : null;

  // 数据状态分派（DataStateBoundary 首个消费方）：
  // - 会话 loading / 无读权限 / 无数据 blockingError → 整页状态
  // - 有旧数据时刷新失败 → nonBlockingError（内容保留 + 非阻断提示，新增语义）
  // - 空态仍由事件列表内的 emptyText 承载（本 PR 不全站替换 loading/error/empty 分支）
  const hasEventsData = sortedEvents.length > 0;
  const dataState: DataStateBoundaryState = sessionStatus === "loading"
    ? { kind: "initialLoading" }
    : authenticated && !canReadAlerts
      ? { kind: "permissionDenied" }
      : eventsError && !hasEventsData
        ? {
            kind: "blockingError",
            error: eventsError,
            errorStateOverride: blockingEventsErrorState ?? undefined,
          }
        : eventsError && hasEventsData
          ? { kind: "nonBlockingError", error: eventsError }
          : { kind: "ready" };
  const isContentReady =
    dataState.kind === "ready" || dataState.kind === "nonBlockingError";

  return (
    <div className="flex flex-col gap-6">
      {messageContext}

      <Space align="center" size="middle" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("alerts.center.title")}
        </Typography.Title>
        {isContentReady ? (
          <Button size="small" onClick={() => void handleRefresh()}>
            {t("common.refresh")}
          </Button>
        ) : null}
      </Space>

      <DataStateBoundary
        state={dataState}
        onRetry={() => {
          void handleRefresh();
        }}
        retrying={eventsLoading}
        retryLabel={t("dashboard.actions.retryFetch")}
      >

      {isLikelySampled ? (
        <Alert
          type="warning"
          showIcon
          message={t("alerts.center.sampleWarning.message", {
            count: eventsLimit,
          })}
          description={
            canLoadMoreHistory ? (
              <Button
                size="small"
                onClick={() => void loadMoreEvents()}
                loading={eventsLoading}
              >
                {t("alerts.center.sampleWarning.loadMore")}
              </Button>
            ) : (
              t("alerts.center.sampleWarning.reachLimit")
            )
          }
        />
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.total")}
              value={stats.total}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.pending")}
              value={stats.pending}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.confirmed")}
              value={stats.confirmed}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.ignored")}
              value={stats.ignored}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} xl={8}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.falsePositiveRate")}
              value={falsePositivePercent ?? "--"}
              suffix={falsePositivePercent !== null ? "%" : undefined}
            />
          </Card>
        </Col>
      </Row>

      <AlertCenterFilters
        filterState={filterState}
        updateFilters={updateFilters}
        ruleKeywordInput={ruleKeywordInput}
        setRuleKeywordInput={setRuleKeywordInput}
        filteredCount={filteredEvents.length}
        totalCount={sortedEvents.length}
      />

      <Card
        className="content-card"
        title={t("alerts.center.trend.title")}
        extra={
          <Typography.Text type="secondary">{trendWindowLabel}</Typography.Text>
        }
      >
        {trendPoints.length === 0 ? (
          <ChartEmptyState
            className="h-auto py-8"
            description={t("alerts.center.trend.empty")}
          />
        ) : (
          <DashboardChart
            option={trendOption}
            theme={echartsTheme}
            height={280}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <AlertEventList
            currentPageEvents={currentPageEvents}
            filteredEventsCount={filteredEvents.length}
            selectedEventId={selectedEventId}
            selectedEventIdSet={selectedEventIdSet}
            locale={locale}
            objectKeyLabels={objectKeyLabels}
            listPage={listPage}
            listPageSize={listPageSize}
            eventsLoading={eventsLoading}
            canManageAlerts={canManageAlerts}
            selectedEventIdsCount={selectedEventIds.length}
            allVisibleSelected={allVisibleSelected}
            selectedVisibleCount={selectedVisibleCount}
            hiddenSelectedCount={hiddenSelectedCount}
            exportScope={exportScope}
            exportEventsCount={exportEvents.length}
            includeRawExport={includeRawExport}
            bulkNote={bulkNote}
            batchProgress={batchProgress}
            updatingStatus={updatingStatus}
            onToggleSelectAllVisible={handleSelectAllVisible}
            onClearHiddenSelection={() =>
              setSelectedEventIds((prev) =>
                prev.filter((id) => filteredEventIdSet.has(id)),
              )
            }
            onSetExportScope={setExportScope}
            onSetIncludeRawExport={setIncludeRawExport}
            onSetBulkNote={setBulkNote}
            onExportCsv={() => void handleExportCsv()}
            onExportJson={() => handleExportJson()}
            onBulkUpdate={(status) => void handleBulkUpdate(status)}
            onToggleEventSelection={handleToggleEventSelection}
            onSelectEvent={handleSelectEvent}
            onSetPage={setListPage}
            onSetPageSize={setListPageSize}
            onRefresh={() => void refetchEvents()}
          />
        </Col>

        <Col xs={24} xl={10}>
          <Card
            className="content-card"
            title={t("alerts.center.evidenceTitle")}
            extra={
              <Space wrap>
                <Button
                  size="small"
                  onClick={() =>
                    previousEventId && handleSelectEvent(previousEventId)
                  }
                  disabled={!previousEventId}
                >
                  {t("alerts.center.actions.previous")}
                </Button>
                <Button
                  size="small"
                  onClick={() => nextEventId && handleSelectEvent(nextEventId)}
                  disabled={!nextEventId}
                >
                  {t("alerts.center.actions.next")}
                </Button>
                <Button
                  size="small"
                  onClick={() => void handleCopyAlertMarkdown()}
                  disabled={!selectedEvent}
                >
                  {t("alerts.center.actions.copyMarkdown")}
                </Button>
              </Space>
            }
          >
            {selectedEvent ? (
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                {selectedIndexInFiltered === -1 && filteredEvents.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t("alerts.center.actions.filteredOut")}
                  />
                ) : null}
                <Tabs
                  activeKey={detailTab}
                  onChange={setDetailTab}
                  items={detailTabs}
                />
              </Space>
            ) : (
              <ChartEmptyState
                className="h-auto py-6"
                description={t("alerts.center.selectEvent")}
              />
            )}
          </Card>
        </Col>
      </Row>
      </DataStateBoundary>
    </div>
  );
}
