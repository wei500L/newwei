"use client";

import {
  Button,
  Col,
  Row,
  Space,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DataStateBoundary, type DataStateBoundaryState } from "@/components/data-state-boundary";
import type { AlertMetricProvider } from "@/graphql/generated";
import { useAlertRuleTuningSuggestionQuery } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import {
  createCopyAlertMarkdownHandler,
  createCopyRawContextHandler,
  createExportHandlers,
} from "./alert-center-actions";
import { buildAlertDataState } from "./alert-center-data-state";
import { AlertCenterFilters } from "./alert-center-filters";
import { buildThresholdSummary } from "./alert-center-list-model";
import { AlertCenterSummary } from "./alert-center-summary";
import {
  DEFAULT_FILTER_STATE,
  filterAlertEvents,
  resolveAlertCenterAccess,
  resolveFilterTimeWindow,
  type AlertFilterState,
} from "./alert-center.utils";
import {
  buildSelectionController,
  buildToolbarController,
} from "./alert-event-controllers";
import { AlertEventDetail } from "./alert-event-detail";
import { CONTEXT_OBJECT_KEYS } from "./alert-event-detail-model";
import { AlertEventList } from "./alert-event-list";
import type { AlertExportScope } from "./alert-event-list-toolbar";
import { toNumber } from "./evidence-utils";
import { useAlertCenterCharts } from "./hooks/use-alert-center-charts";
import { useAlertCenterUrlState } from "./hooks/use-alert-center-url-state";
import { useAlertEventBatch } from "./hooks/use-alert-event-batch";
import { useAlertEventDetail } from "./hooks/use-alert-event-detail";
import { useAlertEventSelection } from "./hooks/use-alert-event-selection";
import { useAlertEventStatusActions } from "./hooks/use-alert-event-status-actions";
import { useAlertEventsFeed } from "./hooks/use-alert-events-feed";

export function AlertCenterContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status: sessionStatus } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const { authenticated, canReadAlerts, shouldQueryEvents } =
    resolveAlertCenterAccess(sessionStatus, permissions);
  const canManageAlerts = permissions.includes("alerts.manage");
  const [messageApi, messageContext] = message.useMessage();

  const [bulkNote, setBulkNote] = useState<string>("");
  const [includeRawExport, setIncludeRawExport] = useState<boolean>(false);
  const [exportScope, setExportScope] = useState<AlertExportScope>("selected");

  // 数据 feed（FE-批3B）：query/订阅/合并 refetch/300→500；messageApi 为已渲染实例
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

  // FE-01：筛选/分页/关键字/日期/eventId URL-backed（内存态清单见 hook 注释）
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

  // keyword 过滤消费 debounced 值（220ms debounce 在 useAlertCenterUrlState）
  const filterStateForQuery = useMemo<AlertFilterState>(
    () => ({ ...filterState, ruleKeyword: appliedRuleKeyword }),
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

  const listPageCount = Math.max(
    1,
    Math.ceil(filteredEvents.length / listPageSize),
  );
  const currentPageEvents = useMemo(() => {
    const start = (listPage - 1) * listPageSize;
    return filteredEvents.slice(start, start + listPageSize);
  }, [filteredEvents, listPage, listPageSize]);

  // 选择与分页协调（FE-批3B）：FE-01 优先级契约整体见 hook 注释
  const isEventsDataReady =
    shouldQueryEvents && !eventsLoading && eventsData !== undefined;
  const {
    selectedEventId,
    selectedEvent,
    handleSelectEvent,
    selectedIndexInFiltered,
    previousEventId,
    nextEventId,
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

  // 详情域状态（FE-批3B）：replay 懒加载 / feedback note 预填 / tab 重置
  const {
    loadReplay,
    replay,
    replayPoints,
    replayUnit,
    replayLoading,
    replayError,
    detailTab,
    setDetailTab,
    expandMessage,
    toggleExpandMessage,
    expandContext,
    toggleExpandContext,
    feedbackNote,
    setFeedbackNote,
  } = useAlertEventDetail({ selectedEvent, selectedEventId });

  const handleReloadReplay = () =>
    selectedEvent
      ? loadReplay({
          variables: { eventId: selectedEvent.id, windowDays: 30 },
        })
      : undefined;

  // 批量选择域（FE-批3B）：勾选/全选/隐藏选中清理
  const batch = useAlertEventBatch({
    sortedEvents,
    filteredEvents,
    currentPageEvents,
  });
  const {
    selectedEventIds,
    clearSelection,
  } = batch;

  // 深链事件不在当前数据集：feed 扩充 limit 至 500 并 refetch（一次性）
  const handleOpenEvent = async (eventId: string) => {
    if (!eventId) return;
    await ensureEventLoaded(eventId);
    handleSelectEvent(eventId);
  };

  const handleEventStatusUpdate = async (status: "confirmed" | "ignored") => {
    if (!selectedEvent || !canManageAlerts) return;
    const note = feedbackNote.trim() ? feedbackNote.trim() : null;
    await executeStatusUpdate([selectedEvent.id], status, note);
  };

  const handleQuickConfirm = async () => {
    if (!selectedEvent || !canManageAlerts) return;
    await executeStatusUpdate([selectedEvent.id], "confirmed", null);
  };

  const handleBulkUpdate = async (status: "confirmed" | "ignored") => {
    if (selectedEventIds.length === 0) return;
    const note = bulkNote.trim() ? bulkNote.trim() : null;
    const updated = await executeStatusUpdate(selectedEventIds, status, note);
    if (updated > 0) {
      clearSelection();
      setBulkNote("");
    }
  };

  const exportEvents = useMemo(
    () =>
      exportScope === "page"
        ? currentPageEvents
        : sortedEvents.filter((e) => batch.selectedEventIdSet.has(e.id)),
    [batch.selectedEventIdSet, currentPageEvents, exportScope, sortedEvents],
  );

  // 导出域（FE-批3B）：scope/includeRaw 语义在 alert-center-actions 保持
  const { exportCsv: handleExportCsv, exportJson: handleExportJson } =
    createExportHandlers({
      getExportEvents: () => exportEvents,
      includeRawExport,
      messageApi,
      t,
    });

  const handleRefresh = async () => {
    await refetchEvents();
    if (canManageAlerts && selectedRuleId) {
      await refetchTuning({ ruleId: selectedRuleId, windowDays: 30 });
    }
  };

  // 图表与统计派生（FE-批3B）：stats/trend/replay option 构建与窗口标签
  const {
    stats,
    trendPoints,
    similarAlerts,
    ruleTrendAnalysis,
    replayOption,
    trendOption,
    ruleTrendOption,
    trendWindowLabel,
  } = useAlertCenterCharts({
    filteredEvents,
    sortedEvents,
    selectedEvent,
    filterWindow,
    replay,
    replayPoints,
    replayUnit,
    theme: { primary: colors.primary, accent: colors.accent, fontFamily },
  });

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

  const handleCopyRawContext = createCopyRawContextHandler(context, {
    messageApi,
    t,
  });

  const handleCopyAlertMarkdown = createCopyAlertMarkdownHandler({
    selectedEvent,
    context,
    locale,
    messageApi,
    t,
    formatDateTime,
    metricProviderLabel,
    thresholdSummary,
  });

  const hasEventsData = sortedEvents.length > 0;
  const onRetry = () => {
    void handleRefresh();
  };
  const dataState: DataStateBoundaryState = buildAlertDataState({
    sessionStatus,
    authenticated,
    canReadAlerts,
    eventsError,
    hasEventsData,
    onRetry,
    eventsLoading,
    t,
  });
  // 列表域领域契约装配（第四轮收口）：hook 结果 → 具名控制器
  const listSelection = buildSelectionController(
    batch,
    selectedEventId,
  );
  const listToolbar = buildToolbarController({
    canManageAlerts,
    bulkNote,
    setBulkNote,
    includeRawExport,
    setIncludeRawExport,
    exportScope,
    setExportScope,
    exportEventsCount: exportEvents.length,
    exportCsv: () => void handleExportCsv(),
    exportJson: () => handleExportJson(),
    batchProgress,
    updatingStatus,
    bulkUpdate: (status) => void handleBulkUpdate(status),
  });

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
          <Button size="small" onClick={onRetry}>
            {t("common.refresh")}
          </Button>
        ) : null}
      </Space>

      <DataStateBoundary
        state={dataState}
        onRetry={onRetry}
        retrying={eventsLoading}
        retryLabel={t("dashboard.actions.retryFetch")}
      >

      <AlertCenterSummary
        isLikelySampled={isLikelySampled}
        canLoadMoreHistory={canLoadMoreHistory}
        eventsLimit={eventsLimit}
        eventsLoading={eventsLoading}
        onLoadMore={() => void loadMoreEvents()}
        stats={stats}
        trendPoints={trendPoints}
        trendOption={trendOption}
        echartsTheme={echartsTheme}
        trendWindowLabel={trendWindowLabel}
      />

      <AlertCenterFilters
        filterState={filterState}
        updateFilters={updateFilters}
        ruleKeywordInput={ruleKeywordInput}
        setRuleKeywordInput={setRuleKeywordInput}
        filteredCount={filteredEvents.length}
        totalCount={sortedEvents.length}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <AlertEventList
            model={{
              currentPageEvents,
              filteredEventsCount: filteredEvents.length,
              eventsLoading,
              locale,
              objectKeyLabels,
            }}
            selection={listSelection}
            toolbar={listToolbar}
            pagination={{
              page: listPage,
              pageSize: listPageSize,
              setPage: setListPage,
              setPageSize: setListPageSize,
            }}
            onSelectEvent={handleSelectEvent}
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
            onToggleExpandMessage={toggleExpandMessage}
            onToggleExpandContext={toggleExpandContext}
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
            onReloadReplay={handleReloadReplay}
            canManageAlerts={canManageAlerts}
            feedbackNote={feedbackNote}
            onSetFeedbackNote={setFeedbackNote}
            updatingStatus={updatingStatus}
            onEventStatusUpdate={(status) => void handleEventStatusUpdate(status)}
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
