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
import { AlertEventDetail } from "./alert-event-detail";
import { CONTEXT_OBJECT_KEYS } from "./alert-event-detail-model";
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
import {
  buildReplayOption,
  buildRuleTrendOption,
  buildTrendOption,
} from "./alert-chart-options";
import { AlertEventList } from "./alert-event-list";
import type { AlertExportScope } from "./alert-event-list-toolbar";
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

  const objectKeyLabels = useMemo(
    () =>
      CONTEXT_OBJECT_KEYS.map((entry) => ({
        ...entry,
        label: t(entry.labelKey, { defaultValue: entry.defaultLabel }),
      })),
    [t],
  );

  // 复制 Markdown 需要的最小详情派生（完整派生在 alert-event-detail-model）
  const context =
    selectedEvent?.context && typeof selectedEvent.context === "object"
      ? (selectedEvent.context as Record<string, unknown>)
      : null;
  const metricProviderLabel = (
    provider: AlertMetricProvider | string | null | undefined,
  ) =>
    provider
      ? t(`alerts.metricProviders.${provider}`, { defaultValue: provider })
      : t("common.notAvailable");
  const thresholdSummary = selectedEvent
    ? buildThresholdSummary(
        selectedEvent.operator,
        selectedEvent.thresholdValue ?? toNumber(context?.threshold),
        selectedEvent.thresholdLower ?? toNumber(context?.lower),
        selectedEvent.thresholdUpper ?? toNumber(context?.upper),
        t,
      )
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
          <AlertEventDetail
            selectedEvent={selectedEvent}
            selectedEventId={selectedEventId}
            selectedIndexInFiltered={selectedIndexInFiltered}
            filteredEvents={filteredEvents}
            locale={locale}
            objectKeyLabels={objectKeyLabels}
            detailTab={detailTab}
            onSetDetailTab={setDetailTab}
            expandMessage={expandMessage}
            expandContext={expandContext}
            onToggleExpandMessage={() => setExpandMessage((prev) => !prev)}
            onToggleExpandContext={() => setExpandContext((prev) => !prev)}
            onCopyRawContext={() => void handleCopyRawContext()}
            onCopyAlertMarkdown={() => void handleCopyAlertMarkdown()}
            onSelectEvent={handleSelectEvent}
            onOpenEvent={(eventId) => void handleOpenEvent(eventId)}
            previousEventId={previousEventId}
            nextEventId={nextEventId}
            similarAlerts={similarAlerts}
            ruleTrendAnalysis={ruleTrendAnalysis}
            ruleTrendOption={ruleTrendOption}
            replay={replay}
            replayPoints={replayPoints}
            replayLoading={replayLoading}
            replayError={replayError}
            replayOption={replayOption}
            onReloadReplay={() =>
              selectedEvent
                ? loadReplay({
                    variables: {
                      eventId: selectedEvent.id,
                      windowDays: 30,
                    },
                  })
                : undefined
            }
            canManageAlerts={canManageAlerts}
            feedbackNote={feedbackNote}
            onSetFeedbackNote={setFeedbackNote}
            updatingStatus={updatingStatus}
            onEventStatusUpdate={(status) =>
              void handleEventStatusUpdate(status)
            }
            onQuickConfirm={() => void handleQuickConfirm()}
            tuningData={tuningData}
            tuningLoading={tuningLoading}
            tuningError={tuningError}
            echartsTheme={echartsTheme}
            colors={{ primary: colors.primary, accent: colors.accent }}
            fontFamily={fontFamily}
          />
        </Col>
      </Row>
      </DataStateBoundary>
    </div>
  );
}
