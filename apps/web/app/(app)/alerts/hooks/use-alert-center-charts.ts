"use client";

import type { EChartsOption } from "echarts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AlertEventReplayQuery } from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

type ReplayModel = NonNullable<AlertEventReplayQuery["alertEventReplay"]>;

import {
  buildAlertStats,
  buildAlertTrend,
  buildRuleTrendAnalysis,
  buildSimilarAlerts,
  type AlertEventItem,
  type AlertTimeWindow,
} from "../alert-center.utils";
import {
  buildReplayOption,
  buildRuleTrendOption,
  buildTrendOption,
  type ChartThemeInputs,
} from "../alert-chart-options";

/**
 * Alert Center 图表与统计派生（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - stats / trendPoints / similarAlerts / ruleTrendAnalysis 数据派生；
 * - replay / trend / ruleTrend 的 EChartsOption 构建（主题色注入）；
 * - 趋势窗口标签（locale 感知）。
 */

export interface UseAlertCenterChartsOptions {
  filteredEvents: AlertEventItem[];
  sortedEvents: AlertEventItem[];
  selectedEvent: AlertEventItem | null;
  filterWindow: AlertTimeWindow;
  replay: ReplayModel | null;
  replayPoints: ReplayModel["points"] | undefined;
  replayUnit: string | null | undefined;
  theme: ChartThemeInputs;
}

export interface UseAlertCenterChartsResult {
  stats: ReturnType<typeof buildAlertStats>;
  trendPoints: ReturnType<typeof buildAlertTrend>;
  similarAlerts: ReturnType<typeof buildSimilarAlerts>;
  ruleTrendAnalysis: ReturnType<typeof buildRuleTrendAnalysis>;
  replayOption: EChartsOption;
  trendOption: EChartsOption;
  ruleTrendOption: EChartsOption;
  trendWindowLabel: string;
}

export function useAlertCenterCharts({
  filteredEvents,
  sortedEvents,
  selectedEvent,
  filterWindow,
  replay,
  replayPoints,
  replayUnit,
  theme,
}: UseAlertCenterChartsOptions): UseAlertCenterChartsResult {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);

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

  const replayOption = useMemo<EChartsOption>(
    () =>
      buildReplayOption(
        { replay, replayPoints, replayUnit, selectedEvent },
        theme,
      ),
    [replay, replayPoints, replayUnit, selectedEvent, theme],
  );

  const trendOption = useMemo<EChartsOption>(
    () => buildTrendOption(trendPoints, theme, t),
    [t, theme, trendPoints],
  );

  const ruleTrendOption = useMemo<EChartsOption>(
    () => buildRuleTrendOption(ruleTrendAnalysis, theme, t),
    [ruleTrendAnalysis, t, theme],
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

  return {
    stats,
    trendPoints,
    similarAlerts,
    ruleTrendAnalysis,
    replayOption,
    trendOption,
    ruleTrendOption,
    trendWindowLabel,
  };
}
