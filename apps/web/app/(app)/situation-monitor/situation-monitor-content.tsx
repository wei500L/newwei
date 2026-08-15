"use client";

import {
  DragOutlined,
  InfoCircleOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Divider,
  Drawer,
  List,
  Popover,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState, type ComponentType } from "react";
import type { Layout } from "react-grid-layout";
import { useTranslation } from "react-i18next";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import {
  SITUATION_MONITOR_PANELS,
  SITUATION_MONITOR_PRESETS,
  type SituationMonitorPanelId,
} from "@/store/situation-monitor-layout";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";
import { useUserUiSyncStatusStore } from "@/store/user-ui-sync-status";

import { SituationMonitorCorrelationPanel } from "./components/situation-monitor-correlation-panel";
import { SituationMonitorFedPanel } from "./components/situation-monitor-fed-panel";
import { SituationMonitorFeedsPanel } from "./components/situation-monitor-feeds-panel";
import { useSituationMonitorHeadlines } from "./components/situation-monitor-headlines";
import { SituationMonitorLeadersPanel, SituationMonitorSituationCard } from "./components/situation-monitor-leaders-panel";
import { SituationMonitorLiveNewsPanel } from "./components/situation-monitor-live-news-panel";
import { SituationMonitorLiveWebcamsPanel } from "./components/situation-monitor-live-webcams-panel";
import { SituationMonitorMapPanel, SituationMonitorRealtimeSnapshotPanel } from "./components/situation-monitor-map-panels";
import { SituationMonitorCryptoPanel, SituationMonitorMarketsPanel } from "./components/situation-monitor-markets-panel";
import { SituationMonitorMainCharacterPanel, SituationMonitorNarrativePanel } from "./components/situation-monitor-narrative-panel";
import { SituationMonitorPanelShell } from "./components/situation-monitor-panel-shell";
import { SituationMonitorOrefAlertsPanel, SituationMonitorTelegramFeedPanel } from "./components/situation-monitor-signals-panels";
import { SituationMonitorAlertsPanel, SituationMonitorCoveragePanel, SituationMonitorNextActionsPanel, SituationMonitorSummaryPanel } from "./components/situation-monitor-summary-panels";
import { useSituationMonitorData } from "./hooks/use-situation-monitor-data";
import { useSituationMonitorLayout } from "./hooks/use-situation-monitor-layout";
import { SituationMonitorMonitorsPanel } from "./situation-monitor-monitors-panel";
import {
  SITUATION_MONITOR_CATEGORY_KEYS,
  type SituationMonitorCategory,
  type SituationMonitorHeadline,
} from "./types/situation-monitor-content";
import type { SituationMonitorMatchResult } from "./types/situation-monitor-monitors";
import {
  GRID_BREAKPOINTS,
  GRID_COLS,
} from "./utils/layout-grid";
import {
  extractWarningCategories,
  formatWindowOptionLabel,
  getScopeBadgeLabel,
  getSituationMonitorCategoryLabels,
  SITUATION_MONITOR_INTERACTIVE_SELECTOR,
  toAlertType,
} from "./utils/situation-monitor-format";

type GridLayoutComponent = ComponentType<Record<string, unknown>>;

const ResponsiveGridLayout = dynamic(
  () =>
    import("react-grid-layout").then((mod) => {
      const responsive =
        mod.Responsive ??
        (typeof mod.default === "function" || typeof mod.default === "object"
          ? (mod.default as { Responsive?: unknown }).Responsive
          : undefined);

      const widthProvider =
        mod.WidthProvider ??
        (typeof mod.default === "function" || typeof mod.default === "object"
          ? (mod.default as { WidthProvider?: unknown }).WidthProvider
          : undefined);

      if (
        typeof responsive !== "function" ||
        typeof widthProvider !== "function"
      ) {
        throw new Error("react-grid-layout exports are not available");
      }

      return (
        widthProvider as (component: GridLayoutComponent) => GridLayoutComponent
      )(responsive as GridLayoutComponent);
    }),
  {
    ssr: false,
  },
);

export function SituationMonitorContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session, status } = useSession();
  const uiSync = useUserUiSyncStatusStore(
    (state) => state.sections["situation-monitor"],
  );
  const requestUiSyncReload = useUserUiSyncStatusStore(
    (state) => state.requestReload,
  );
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems =
    permissions.includes("items.read") || permissions.includes("items.write");
  const canViewNewsSources =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManageSettings = permissions.includes("settings.manage");
  const hasSignalSession =
    status === "authenticated" && Boolean(session?.accessToken);
  const monitoringSettingsHref = buildAdminSettingsHref({
    page: "monitoring",
    panel: "situation-monitor",
  });

  const windowHours = useSituationMonitorSettingsStore(
    (state) => state.windowHours,
  );
  const setWindowHours = useSituationMonitorSettingsStore(
    (state) => state.setWindowHours,
  );
  const scope = useSituationMonitorSettingsStore((state) => state.scope);
  const setScope = useSituationMonitorSettingsStore((state) => state.setScope);
  const autoRefresh = useSituationMonitorSettingsStore(
    (state) => state.autoRefresh,
  );
  const setAutoRefresh = useSituationMonitorSettingsStore(
    (state) => state.setAutoRefresh,
  );
  const translateToZh = useSituationMonitorSettingsStore(
    (state) => state.translateToZh,
  );
  const setTranslateToZh = useSituationMonitorSettingsStore(
    (state) => state.setTranslateToZh,
  );

  const monitorData = useSituationMonitorData({
    accessToken: session?.accessToken,
    canReadItems,
    hasSignalSession,
    windowHours,
    scope,
    translateToZh,
    autoRefresh,
  });
  const {
    apiClient,
    refreshStage,
    error,
    data,
    loading,
    manualRefreshPending,
    runManualRefresh,
    telegramFeed,
    orefAlerts,
    orefHistory,
    telegramTopicFilter,
    setTelegramTopicFilter,
    telegramChannelFilter,
    setTelegramChannelFilter,
    signalsLoading,
    signalErrors,
    catalogLoading,
    signalCatalog,
    loadSignalCatalog,
    load,
    realtimeState,
    telegramTopicOptions,
    telegramChannelOptions,
    handleMonitorsChanged,
  } = monitorData;

  const layoutState = useSituationMonitorLayout();
  const {
    screens,
    visibility,
    setPanelVisible,
    applyPreset,
    resetPanels,
    panelsOpen,
    setPanelsOpen,
    resetLayoutOnPreset,
    setResetLayoutOnPreset,
    activePreset,
    visiblePanels,
    isCompactGrid,
    canEditLayout,
    toggleLayoutEdit,
    gridMetrics,
    gridMargin,
    gridLayouts,
    gridClassName,
    activeGridLayoutMap,
    layoutPreviewItem,
    setLayoutPreviewItem,
    handleGridBreakpointChange,
    handleLayoutChange,
    handleResetPanelSize,
    layoutHint,
    gridBreakpoint,
  } = layoutState;

  const effectiveScope = data?.diagnostics?.effectiveScope ?? scope;
  const taggedScopeNoResults =
    !loading &&
    !error &&
    effectiveScope === "tagged" &&
    (data?.analyzedItems ?? 0) === 0;
  const allScopeNoResults =
    !loading &&
    !error &&
    effectiveScope === "all" &&
    (data?.analyzedItems ?? 0) === 0;
  const insightsWarnings = data?.warnings ?? [];
  const coverageSummary = data?.coverageSummary;
  const recommendedWindowHours =
    coverageSummary?.recommendedWindowHours ?? null;
  const noActiveSourcesConfigured =
    (signalCatalog?.refreshReadiness.activeSourceCount ?? 0) === 0;
  const rateLimitedCategories = useMemo(
    () =>
      new Set(
        (data?.externalSnapshot?.warnings ?? [])
          .filter((warning) => warning.code === "gdelt_rate_limited")
          .flatMap((warning) => extractWarningCategories(warning)),
      ),
    [data?.externalSnapshot?.warnings],
  );
  const freshSnapshotCategoryCount = useMemo(
    () =>
      SITUATION_MONITOR_CATEGORY_KEYS.filter(
        (category) =>
          data?.externalSnapshot?.categories?.[category]?.status === "fresh",
      ).length,
    [data?.externalSnapshot?.categories],
  );
  const reusedSnapshotCategoryCount = useMemo(
    () =>
      SITUATION_MONITOR_CATEGORY_KEYS.filter(
        (category) =>
          data?.externalSnapshot?.categories?.[category]?.status === "reused",
      ).length,
    [data?.externalSnapshot?.categories],
  );
  const allScopeEmptyState = useMemo(() => {
    if (!allScopeNoResults) {
      return null;
    }

    if (noActiveSourcesConfigured) {
      return {
        type: "info" as const,
        message: t("situationMonitor.empty.unconfigured.title"),
        description: t("situationMonitor.empty.unconfigured.description"),
      };
    }

    if (coverageSummary?.hasOlderItemsOutsideWindow && recommendedWindowHours) {
      return {
        type: "info" as const,
        message: t("situationMonitor.empty.window.title"),
        description: t("situationMonitor.empty.window.description"),
      };
    }

    if (data?.externalSnapshot?.status === "partial") {
      return {
        type: "warning" as const,
        message: t("situationMonitor.empty.partial.title"),
        description: t("situationMonitor.empty.partial.description"),
      };
    }

    return {
      type: "warning" as const,
      message: t("situationMonitor.empty.generic.title"),
      description: t("situationMonitor.empty.generic.description"),
    };
  }, [
    allScopeNoResults,
    coverageSummary?.hasOlderItemsOutsideWindow,
    data?.externalSnapshot?.status,
    noActiveSourcesConfigured,
    recommendedWindowHours,
    t,
  ]);
  const refreshActionItems = useMemo(() => {
    const actions: {
      key: string;
      label: string;
      onClick: () => void;
    }[] = [];

    if (noActiveSourcesConfigured && canViewNewsSources) {
      actions.push({
        key: "news-sources",
        label: t("situationMonitor.actions.openNewsSources"),
        onClick: () => router.push("/admin/ops/news-sources"),
      });
    }

    if (
      ((data?.externalSnapshot?.warnings.length ?? 0) > 0 ||
        signalErrors.telegram ||
        signalErrors.oref) &&
      canManageSettings
    ) {
      actions.push({
        key: "monitoring-settings",
        label: t("situationMonitor.actions.openSettings"),
        onClick: () => router.push(monitoringSettingsHref),
      });
    }

    return actions;
  }, [
    canManageSettings,
    canViewNewsSources,
    data?.externalSnapshot?.warnings.length,
    monitoringSettingsHref,
    noActiveSourcesConfigured,
    router,
    signalErrors.oref,
    signalErrors.telegram,
    t,
  ]);

  const [feedbackNotice, setFeedbackNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [feedbackDrawerOpen, setFeedbackDrawerOpen] = useState(false);
  const [missedSignalType, setMissedSignalType] = useState<
    "narrative" | "correlation"
  >("narrative");
  const [missedSignalId, setMissedSignalId] = useState<string>("");
  const [missedHeadlineId, setMissedHeadlineId] = useState<string>("");
  const [expandedClusterIds, setExpandedClusterIds] = useState<string[]>([]);

  const handleManualRefresh = useCallback(() => {
    void runManualRefresh();
  }, [runManualRefresh]);
  const toggleClusterExpansion = useCallback((clusterId: string) => {
    setExpandedClusterIds((previous) =>
      previous.includes(clusterId)
        ? previous.filter((value) => value !== clusterId)
        : [...previous, clusterId],
    );
  }, []);
  const summaryActionItems = useMemo(() => {
    const actions: {
      key: string;
      label: string;
      onClick: () => void;
      type?: "primary" | "default";
    }[] = [
      {
        key: "refresh-page-data",
        label: t("situationMonitor.actions.refreshPageData"),
        onClick: handleManualRefresh,
        type: "primary",
      },
    ];

    if (recommendedWindowHours) {
      actions.push({
        key: "recommended-window",
        label: t("situationMonitor.actions.switchWindow", {
          window: formatWindowOptionLabel(recommendedWindowHours, t, locale),
        }),
        onClick: () => {
          setWindowHours(recommendedWindowHours);
        },
      });
    }

    for (const action of refreshActionItems) {
      actions.push({
        key: action.key,
        label: action.label,
        onClick: action.onClick,
      });
    }

    return actions;
  }, [
    handleManualRefresh,
    recommendedWindowHours,
    refreshActionItems,
    locale,
    setWindowHours,
    t,
  ]);

  const submitSignalFeedback = useCallback(
    async (payload: {
      signalType: "narrative" | "correlation";
      signalId: string;
      label: "false_positive" | "false_negative";
      item?: {
        itemMetaId?: string;
        title?: string;
        source?: string;
        link?: string;
      } | null;
    }) => {
      if (!session?.accessToken) {
        return;
      }
      try {
        setFeedbackNotice(null);
        await apiClient.post("situation-monitor/feedback", {
          signalType: payload.signalType,
          signalId: payload.signalId,
          label: payload.label,
          itemMetaId: payload.item?.itemMetaId,
          itemTitle: payload.item?.title,
          itemSource: payload.item?.source,
          itemLink: payload.item?.link,
        });
        setFeedbackNotice({
          type: "success",
          message:
            payload.label === "false_positive"
              ? t("common.feedbackSaved")
              : t("common.feedbackSaved"),
        });
        void load({ includeExternal: false });
        setTimeout(() => setFeedbackNotice(null), 3500);
      } catch (err) {
        captureClientError("Failed to submit situation monitor feedback", err);
        setFeedbackNotice({
          type: "error",
          message: t("common.feedbackFailed"),
        });
        setTimeout(() => setFeedbackNotice(null), 4000);
      }
    },
    [apiClient, load, session?.accessToken, t],
  );

  const feedbackCandidateHeadlines = useMemo(() => {
    const headlinesByCategory = data?.headlines;
    if (!headlinesByCategory) {
      return [] as SituationMonitorHeadline[];
    }

    const entries = Object.values(headlinesByCategory).flatMap((list) =>
      Array.isArray(list) ? list : [],
    );
    const results: SituationMonitorHeadline[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = entry.itemMetaId ?? entry.link;
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(entry);
      if (results.length >= 80) {
        break;
      }
    }
    return results;
  }, [data?.headlines]);

  const feedbackHeadlineById = useMemo(() => {
    return new Map<string, SituationMonitorHeadline>(
      feedbackCandidateHeadlines.map((headline) => [headline.id, headline]),
    );
  }, [feedbackCandidateHeadlines]);

  const allMonitorMatches = useMemo(() => {
    return [
      ...(data?.monitorMatches ?? []),
      ...(telegramFeed?.monitorMatches ?? []),
      ...(orefAlerts?.monitorMatches ?? []),
      ...(orefHistory?.monitorMatches ?? []),
    ];
  }, [
    data?.monitorMatches,
    orefAlerts?.monitorMatches,
    orefHistory?.monitorMatches,
    telegramFeed?.monitorMatches,
  ]);

  const monitorColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const match of allMonitorMatches) {
      if (match.monitorColor) {
        map.set(match.monitorId, match.monitorColor);
      }
    }
    return map;
  }, [allMonitorMatches]);

  const monitorMatchesByKey = useMemo(() => {
    const map = new Map<string, SituationMonitorMatchResult[]>();
    for (const match of allMonitorMatches) {
      const existing = map.get(match.itemKey);
      if (existing) {
        existing.push(match);
      } else {
        map.set(match.itemKey, [match]);
      }
    }

    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          b.score - a.score || a.monitorName.localeCompare(b.monitorName),
      );
    }

    return map;
  }, [allMonitorMatches]);

  const categoryLabels = useMemo(
    () => getSituationMonitorCategoryLabels(t),
    [t],
  );
  const { renderHeadlineSummary } = useSituationMonitorHeadlines({
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  });
  const initialLoading = loading && !data;
  const updatedAt = data?.generatedAt ? dayjs(data.generatedAt).toDate() : null;

  const onReportMissed = useCallback(() => {
    setFeedbackDrawerOpen(true);
    void loadSignalCatalog();
  }, [loadSignalCatalog]);

  const sharedHeadlineProps = {
    monitorMatchesByKey,
    monitorColorById,
  };

  const renderPanel = (panelId: SituationMonitorPanelId) => {
    switch (panelId) {
      case "summary":
        return (
          <SituationMonitorSummaryPanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
            coverageSummary={coverageSummary}
            windowHours={windowHours}
          />
        );
      case "coverage":
        return (
          <SituationMonitorCoveragePanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
            coverageSummary={coverageSummary}
            freshSnapshotCategoryCount={freshSnapshotCategoryCount}
            reusedSnapshotCategoryCount={reusedSnapshotCategoryCount}
          />
        );
      case "next-actions":
        return (
          <SituationMonitorNextActionsPanel
            initialLoading={initialLoading}
            recommendedWindowHours={recommendedWindowHours}
            locale={locale}
            summaryActionItems={summaryActionItems}
          />
        );
      case "map":
        return <SituationMonitorMapPanel translateToZh={translateToZh} />;
      case "realtime-snapshot":
        return (
          <SituationMonitorRealtimeSnapshotPanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
          />
        );
      case "feeds-politics":
      case "feeds-tech":
      case "feeds-finance":
      case "feeds-gov":
      case "feeds-ai":
      case "feeds-intel":
        return (
          <SituationMonitorFeedsPanel
            category={
              panelId.replace("feeds-", "") as SituationMonitorCategory
            }
            data={data}
            initialLoading={initialLoading}
            translateToZh={translateToZh}
            locale={locale}
            rateLimitedCategories={rateLimitedCategories}
            noActiveSourcesConfigured={noActiveSourcesConfigured}
            coverageSummary={coverageSummary}
            recommendedWindowHours={recommendedWindowHours}
            expandedClusterIds={expandedClusterIds}
            toggleClusterExpansion={toggleClusterExpansion}
            {...sharedHeadlineProps}
          />
        );
      case "alerts":
        return (
          <SituationMonitorAlertsPanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
            coverageSummary={coverageSummary}
            {...sharedHeadlineProps}
          />
        );
      case "telegram-feed":
        return (
          <SituationMonitorTelegramFeedPanel
            telegramFeed={telegramFeed}
            signalsLoadingTelegram={signalsLoading.telegram}
            signalErrorTelegram={signalErrors.telegram}
            telegramTopicFilter={telegramTopicFilter}
            telegramChannelFilter={telegramChannelFilter}
            telegramTopicOptions={telegramTopicOptions}
            telegramChannelOptions={telegramChannelOptions}
            setTelegramTopicFilter={setTelegramTopicFilter}
            setTelegramChannelFilter={setTelegramChannelFilter}
            hasAccessToken={Boolean(session?.accessToken)}
            canReadItems={canReadItems}
            canManageSettings={canManageSettings}
            monitoringSettingsHref={monitoringSettingsHref}
            locale={locale}
            translateToZh={translateToZh}
            {...sharedHeadlineProps}
          />
        );
      case "oref-alerts":
        return (
          <SituationMonitorOrefAlertsPanel
            orefAlerts={orefAlerts}
            orefHistory={orefHistory}
            signalsLoadingOref={signalsLoading.oref}
            signalErrorOref={signalErrors.oref}
            hasAccessToken={Boolean(session?.accessToken)}
            canReadItems={canReadItems}
            canManageSettings={canManageSettings}
            monitoringSettingsHref={monitoringSettingsHref}
            locale={locale}
            translateToZh={translateToZh}
            {...sharedHeadlineProps}
          />
        );
      case "markets":
        return (
          <SituationMonitorMarketsPanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            refreshStage={refreshStage}
          />
        );
      case "crypto":
        return (
          <SituationMonitorCryptoPanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            refreshStage={refreshStage}
          />
        );
      case "fed":
        return (
          <SituationMonitorFedPanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
            refreshStage={refreshStage}
          />
        );
      case "leaders":
        return (
          <SituationMonitorLeadersPanel
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
          />
        );
      case "situation-venezuela":
        return (
          <SituationMonitorSituationCard
            id="venezuela"
            fallbackTitle={t("situationMonitor.situations.venezuela")}
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
            refreshStage={refreshStage}
          />
        );
      case "situation-greenland":
        return (
          <SituationMonitorSituationCard
            id="greenland"
            fallbackTitle={t("situationMonitor.situations.greenland")}
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
            refreshStage={refreshStage}
          />
        );
      case "situation-iran":
        return (
          <SituationMonitorSituationCard
            id="iran"
            fallbackTitle={t("situationMonitor.situations.iran")}
            data={data}
            initialLoading={initialLoading}
            locale={locale}
            translateToZh={translateToZh}
            refreshStage={refreshStage}
          />
        );
      case "correlation":
        return (
          <SituationMonitorCorrelationPanel
            data={data}
            initialLoading={initialLoading}
            translateToZh={translateToZh}
            submitSignalFeedback={submitSignalFeedback}
            onReportMissed={onReportMissed}
          />
        );
      case "narrative":
        return (
          <SituationMonitorNarrativePanel
            data={data}
            initialLoading={initialLoading}
            translateToZh={translateToZh}
            locale={locale}
            submitSignalFeedback={submitSignalFeedback}
            onReportMissed={onReportMissed}
          />
        );
      case "main-character":
        return (
          <SituationMonitorMainCharacterPanel
            data={data}
            initialLoading={initialLoading}
            translateToZh={translateToZh}
          />
        );
      case "live-news":
        return <SituationMonitorLiveNewsPanel />;
      case "live-webcams":
        return <SituationMonitorLiveWebcamsPanel />;
      case "monitors":
        return (
          <SituationMonitorMonitorsPanel
            matches={allMonitorMatches}
            onChanged={handleMonitorsChanged}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.situationMonitor.title")}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.situationMonitor.subtitle")}
        </Typography.Text>

        <Space wrap align="center" style={{ width: "100%" }}>
          <Select
            value={windowHours}
            onChange={(value) => setWindowHours(value)}
            options={[
              {
                label: t("situationMonitor.window.6h"),
                value: 6,
              },
              {
                label: t("situationMonitor.window.24h"),
                value: 24,
              },
              {
                label: t("situationMonitor.window.72h"),
                value: 72,
              },
              {
                label: t("situationMonitor.window.168h"),
                value: 168,
              },
            ]}
            style={{ width: 160 }}
          />
          <Select
            value={scope}
            onChange={(value) => setScope(value)}
            options={[
              {
                label: t("situationMonitor.scope.tagged"),
                value: "tagged",
              },
              {
                label: t("situationMonitor.scope.all"),
                value: "all",
              },
            ]}
            style={{ width: 160 }}
          />
          <Tag color="default">{getScopeBadgeLabel(effectiveScope, t)}</Tag>
          <Button
            onClick={handleManualRefresh}
            loading={loading || manualRefreshPending}
          >
            {t("situationMonitor.actions.refreshPageData")}
          </Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setPanelsOpen(true)}
          >
            {t("situationMonitor.panels.title")}
          </Button>
          <Popover
            placement="bottom"
            content={
              <Space direction="vertical" size={6}>
                <Space wrap size={8}>
                  <Tag color="default">
                    {t("situationMonitor.shared.label")}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.globalSignals")}
                  </Typography.Text>
                </Space>
                <Space wrap size={8}>
                  <Tag color="blue">
                    {t("situationMonitor.notice.internalLabel")}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.internalDescription")}
                  </Typography.Text>
                  <Tag color="purple">
                    {t("situationMonitor.notice.gdeltLabel")}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.gdeltDescription")}
                  </Typography.Text>
                </Space>
              </Space>
            }
          >
            <Button icon={<InfoCircleOutlined />}>
              {t("situationMonitor.notice.title")}
            </Button>
          </Popover>
          <Button
            type={canEditLayout ? "primary" : "default"}
            icon={<DragOutlined />}
            onClick={toggleLayoutEdit}
          >
            {canEditLayout
              ? t("situationMonitor.layout.done")
              : t("situationMonitor.layout.edit")}
          </Button>
          {session?.accessToken ? (
            <Space size={6} align="center">
              {uiSync.state === "error" ? (
                uiSync.lastErrorMessage ? (
                  <Popover content={uiSync.lastErrorMessage}>
                    <Tag color="red">
                      {t("common.syncError")}
                    </Tag>
                  </Popover>
                ) : (
                  <Tag color="red">
                    {t("common.syncError")}
                  </Tag>
                )
              ) : uiSync.state === "syncing" ? (
                <Tag color="processing">
                  {t("common.syncing")}
                </Tag>
              ) : uiSync.state === "loading" ? (
                <Tag color="processing">
                  {t("common.loading")}
                </Tag>
              ) : (
                <Tag color="green">
                  {t("common.synced")}
                </Tag>
              )}
              {uiSync.state === "error" ? (
                <Button size="small" onClick={() => requestUiSyncReload()}>
                  {t("common.retry")}
                </Button>
              ) : null}
            </Space>
          ) : null}
          {session?.accessToken ? (
            <Space size={6} align="center">
              <Tag color={realtimeState.connected ? "green" : "default"}>
                {realtimeState.connected
                  ? t("situationMonitor.realtime.connected")
                  : t("situationMonitor.realtime.disconnected")}
              </Tag>
              {!realtimeState.connected && realtimeState.error ? (
                <Popover content={realtimeState.error}>
                  <Tag color="orange">
                    {t("situationMonitor.realtime.error")}
                  </Tag>
                </Popover>
              ) : null}
            </Space>
          ) : null}
          <Space size={8} align="center">
            <Switch
              checked={autoRefresh}
              onChange={(checked) => setAutoRefresh(checked)}
            />
            <Typography.Text type="secondary">
              {t("situationMonitor.autoRefresh")}
            </Typography.Text>
          </Space>
          <Space size={8} align="center">
            <Switch
              checked={translateToZh}
              onChange={(checked) => setTranslateToZh(checked)}
            />
            <Typography.Text type="secondary">
              {t("situationMonitor.translateToZh")}
            </Typography.Text>
          </Space>
          {translateToZh && data?.translation && !data.translation.applied ? (
            data.translation.error ? (
              <Popover content={data.translation.error}>
                <Tag color="red">
                  {t("situationMonitor.translateError")}
                </Tag>
              </Popover>
            ) : (
              <Tag color="red">
                {t("situationMonitor.translateError")}
              </Tag>
            )
          ) : null}
          {updatedAt ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.updatedAt", {
                time: formatDateTime(updatedAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </Typography.Text>
          ) : null}
          {refreshStage !== "idle" ? (
            <Tag color="processing">
              {refreshStage === "core"
                ? t("situationMonitor.refresh.core")
                : t("situationMonitor.refresh.external")}
            </Tag>
          ) : null}
          {typeof data?.analyzedItems === "number" ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.sampleSize", {
                count: data.analyzedItems,
              })}
            </Typography.Text>
          ) : null}
        </Space>
      </div>

      {insightsWarnings.map((warning) => (
        <div className="mt-3" key={`${warning.source}:${warning.code}`}>
          <Alert
            type={toAlertType(warning.severity)}
            showIcon
            message={warning.message}
            description={warning.detail}
          />
        </div>
      ))}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {taggedScopeNoResults ? (
        <div className="mt-3">
          <Alert
            type="warning"
            showIcon
            message={t("situationMonitor.scopeRecovery.title")}
            description={t("situationMonitor.scopeRecovery.description")}
            action={
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  setScope("all");
                  void load({ scopeOverride: "all" });
                }}
              >
                {t("situationMonitor.scopeRecovery.action")}
              </Button>
            }
          />
        </div>
      ) : null}
      {allScopeNoResults ? (
        <div className="mt-3">
          <Alert
            type={allScopeEmptyState?.type ?? "warning"}
            showIcon
            message={
              allScopeEmptyState?.message ??
              t("situationMonitor.empty.generic.title")
            }
            description={
              allScopeEmptyState?.description ??
              t("situationMonitor.empty.generic.description")
            }
            action={
              summaryActionItems.length > 0 ? (
                <Space wrap>
                  {summaryActionItems.map((action) => (
                    <Button
                      key={`no-coverage:${action.key}`}
                      size="small"
                      type={action.type}
                      onClick={action.onClick}
                    >
                      {action.label}
                    </Button>
                  ))}
                </Space>
              ) : null
            }
          />
        </div>
      ) : null}
      {feedbackNotice ? (
        <div className="mt-3">
          <Alert
            showIcon
            type={feedbackNotice.type}
            message={feedbackNotice.message}
            closable
            onClose={() => setFeedbackNotice(null)}
            action={
              feedbackNotice.type === "success" ? (
                <Button
                  size="small"
                  onClick={() => void load({ includeExternal: false })}
                >
                  {t("common.refresh")}
                </Button>
              ) : null
            }
          />
        </div>
      ) : null}

      <Drawer
        title={t("situationMonitor.panels.title")}
        open={panelsOpen}
        onClose={() => setPanelsOpen(false)}
        width={screens.sm ? 360 : "100%"}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">{layoutHint}</Typography.Text>
          {isCompactGrid ? (
            <Alert
              type="info"
              showIcon
              message={t("situationMonitor.notice.title")}
              description={
                <Space direction="vertical" size={6}>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.notice.globalSignals")}
                  </Typography.Text>
                  <Space wrap size={8}>
                    <Tag color="default">
                      {t("situationMonitor.shared.label")}
                    </Tag>
                    <Tag color="blue">
                      {t("situationMonitor.notice.internalLabel")}
                    </Tag>
                    <Tag color="purple">
                      {t("situationMonitor.notice.gdeltLabel")}
                    </Tag>
                  </Space>
                </Space>
              }
            />
          ) : null}
          {isCompactGrid ? (
            <Button
              block
              type={canEditLayout ? "primary" : "default"}
              icon={<DragOutlined />}
              onClick={toggleLayoutEdit}
            >
              {canEditLayout
                ? t("situationMonitor.layout.done")
                : t("situationMonitor.layout.edit")}
            </Button>
          ) : null}
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space size={8} wrap>
              <Typography.Text>
                {t("situationMonitor.presets.title")}
              </Typography.Text>
              {activePreset ? (
                <Tag color="geekblue">
                  {activePreset.nameKey
                    ? t(activePreset.nameKey, {
                        defaultValue: activePreset.name,
                      })
                    : activePreset.name}
                </Tag>
              ) : (
                <Tag color="default">
                  {t("situationMonitor.presets.custom")}
                </Tag>
              )}
            </Space>
            <Space size={8} wrap>
              <Switch
                checked={resetLayoutOnPreset}
                onChange={(checked) => setResetLayoutOnPreset(checked)}
              />
              <Typography.Text type="secondary">
                {t("situationMonitor.presets.resetLayout")}
              </Typography.Text>
            </Space>
            <List
              size="small"
              dataSource={SITUATION_MONITOR_PRESETS.slice()}
              renderItem={(preset) => (
                <List.Item
                  actions={[
                    <Button
                      key={preset.id}
                      size="small"
                      onClick={() =>
                        applyPreset(preset.id, {
                          resetLayout: resetLayoutOnPreset,
                        })
                      }
                    >
                      {t("common.apply")}
                    </Button>,
                  ]}
                >
                  <Space direction="vertical" size={0}>
                    <Typography.Text>
                      {preset.nameKey
                        ? t(preset.nameKey, { defaultValue: preset.name })
                        : preset.name}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {preset.descriptionKey
                        ? t(preset.descriptionKey, {
                            defaultValue: preset.description,
                          })
                        : preset.description}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </Space>
          <Space wrap>
            <Button onClick={() => resetPanels()}>
              {t("situationMonitor.panels.reset")}
            </Button>
          </Space>
          <List
            size="small"
            dataSource={SITUATION_MONITOR_PANELS.slice()}
            renderItem={(panel) => (
              <List.Item
                actions={[
                  <Switch
                    key={panel.id}
                    checked={visibility[panel.id]}
                    onChange={(checked) => setPanelVisible(panel.id, checked)}
                  />,
                ]}
              >
                <Space size={8}>
                  <Typography.Text>
                    {panel.titleKey
                      ? t(panel.titleKey, { defaultValue: panel.title })
                      : panel.title}
                  </Typography.Text>
                  {panel.locked ? (
                    <Tag color="default">
                      {t("situationMonitor.panels.fixed")}
                    </Tag>
                  ) : null}
                </Space>
              </List.Item>
            )}
          />
        </Space>
      </Drawer>

      <Drawer
        title={t("situationMonitor.narrative.reportMissed")}
        open={feedbackDrawerOpen}
        onClose={() => setFeedbackDrawerOpen(false)}
        width={screens.md ? 420 : "100%"}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("situationMonitor.narrative.reportMissedHint")}
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>
              {t("situationMonitor.narrative.missedHeadline")}
            </Typography.Text>
            <Select
              showSearch
              value={missedHeadlineId || undefined}
              placeholder={t(
                "situationMonitor.narrative.missedHeadlinePlaceholder",
              )}
              options={feedbackCandidateHeadlines.map((headline) => ({
                value: headline.id,
                label: `${headline.source} · ${translateToZh ? (headline.titleZh ?? headline.title) : headline.title}`,
              }))}
              filterOption={(input, option) =>
                String(option?.label ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={(value) => setMissedHeadlineId(value)}
            />
          </Space>
          {missedHeadlineId && feedbackHeadlineById.has(missedHeadlineId) ? (
            <Card size="small" styles={{ body: { padding: 12 } }}>
              {(() => {
                const headline = feedbackHeadlineById.get(missedHeadlineId);
                if (!headline) return null;
                const href = headline.link ? safeHttpUrl(headline.link) : null;
                const title = translateToZh
                  ? (headline.titleZh ?? headline.title)
                  : headline.title;
                const date = Number.isFinite(headline.timestamp)
                  ? new Date(headline.timestamp)
                  : null;
                return (
                  <Space
                    direction="vertical"
                    size={6}
                    style={{ width: "100%" }}
                  >
                    {href ? (
                      <Typography.Link
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {title}
                      </Typography.Link>
                    ) : (
                      <Typography.Text>{title}</Typography.Text>
                    )}
                    <Space size={8} wrap>
                      <Typography.Text type="secondary">
                        {headline.source}
                      </Typography.Text>
                      {date ? (
                        <Typography.Text type="secondary">
                          {formatDateTime(date, locale, {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Typography.Text>
                      ) : null}
                      <Tag color="blue">
                        {categoryLabels[headline.category]}
                      </Tag>
                    </Space>
                    {renderHeadlineSummary(headline)}
                  </Space>
                );
              })()}
            </Card>
          ) : null}
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>
              {t("situationMonitor.narrative.missedSignalType")}
            </Typography.Text>
            <Select
              value={missedSignalType}
              options={[
                {
                  value: "narrative",
                  label: t("situationMonitor.narrative.title"),
                },
                {
                  value: "correlation",
                  label: t("situationMonitor.correlation.title"),
                },
              ]}
              onChange={(value) => {
                setMissedSignalType(value as "narrative" | "correlation");
                setMissedSignalId("");
              }}
            />
          </Space>
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text>
              {t("situationMonitor.narrative.missedSignal")}
            </Typography.Text>
            <Select
              showSearch
              loading={catalogLoading}
              value={missedSignalId || undefined}
              placeholder={t(
                "situationMonitor.narrative.missedSignalPlaceholder",
              )}
              options={
                (missedSignalType === "narrative"
                  ? signalCatalog?.narratives
                  : signalCatalog?.correlations
                )?.map((entry) => ({
                  value: entry.id,
                  label: `${entry.name} · ${entry.category}`,
                })) ?? []
              }
              filterOption={(input, option) =>
                String(option?.label ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={(value) => setMissedSignalId(value)}
            />
          </Space>
          <Space>
            <Button
              type="primary"
              disabled={!missedHeadlineId || !missedSignalId}
              onClick={() => {
                const headline = missedHeadlineId
                  ? feedbackHeadlineById.get(missedHeadlineId)
                  : undefined;
                if (!headline) {
                  return;
                }
                void submitSignalFeedback({
                  signalType: missedSignalType,
                  signalId: missedSignalId,
                  label: "false_negative",
                  item: {
                    itemMetaId: headline.itemMetaId,
                    title: headline.title,
                    source: headline.source,
                    link: headline.link,
                  },
                });
                setFeedbackDrawerOpen(false);
                setMissedHeadlineId("");
                setMissedSignalId("");
              }}
            >
              {t("common.submit")}
            </Button>
            <Button
              onClick={() => {
                setFeedbackDrawerOpen(false);
              }}
            >
              {t("common.cancel")}
            </Button>
          </Space>
        </Space>
      </Drawer>

      {canEditLayout ? (
        <Alert
          type="info"
          showIcon
          message={t("situationMonitor.layout.editing")}
          description={layoutHint}
        />
      ) : null}

      {visiblePanels.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("situationMonitor.panels.none")}
        />
      ) : (
        <ResponsiveGridLayout
          className={gridClassName}
          layouts={gridLayouts}
          breakpoints={GRID_BREAKPOINTS}
          cols={GRID_COLS}
          rowHeight={gridMetrics.rowHeight}
          isResizable={canEditLayout}
          isDraggable={canEditLayout}
          resizeHandles={["s", "se"]}
          compactType="vertical"
          margin={gridMargin}
          draggableHandle=".ant-card-head"
          draggableCancel={`${SITUATION_MONITOR_INTERACTIVE_SELECTOR},.ant-btn,.ant-select,.ant-select-selector,.ant-switch,a,button,input,textarea,[role='button']`}
          onBreakpointChange={(nextBreakpoint: string) =>
            handleGridBreakpointChange(nextBreakpoint)
          }
          onDragStop={(nextLayout: Layout[]) => {
            handleLayoutChange(nextLayout, { source: "drag" });
          }}
          onResize={(
            _nextLayout: Layout[],
            _oldItem: Layout,
            nextItem: Layout,
          ) => {
            setLayoutPreviewItem({ ...nextItem });
          }}
          onResizeStop={(nextLayout: Layout[]) => {
            handleLayoutChange(nextLayout, { source: "resize" });
          }}
        >
          {visiblePanels.map((panel) => (
            <SituationMonitorPanelShell
              key={panel.id}
              panelId={panel.id}
              layoutItem={activeGridLayoutMap.get(panel.id)}
              gridBreakpoint={gridBreakpoint}
              rowHeight={gridMetrics.rowHeight}
              gridMargin={gridMargin}
              canEditLayout={canEditLayout}
              isPreviewingResize={layoutPreviewItem?.i === panel.id}
              onResetPanelSize={handleResetPanelSize}
            >
              {renderPanel(panel.id)}
            </SituationMonitorPanelShell>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}
