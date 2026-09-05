"use client";

import { Tooltip } from "antd";

import {
  OVERLAY_PANEL_CHIP_CLASS_NAME,
  OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME,
  getSummaryMetricDetail,
  getSummaryMetricLabel,
  renderOverviewCardIcon,
} from "./war-map-controls-primitives";
import type {
  WarMapOverviewMetricCard,
  WarMapSummaryStatusCard,
  WarMapTranslateFn,
} from "./war-map-overlay-model";

/**
 * Controls 面板头部摘要（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * 窗口胶囊、指标卡与 stream/data 状态芯片。
 */
export function ControlsHeaderSummary({
  overviewMetricCards,
  summaryStatusCards,
  summaryDataLabel,
  overviewDataTagLabel,
  windowLabel,
  t,
  compact = false,
}: {
  overviewMetricCards: WarMapOverviewMetricCard[];
  summaryStatusCards: WarMapSummaryStatusCard[];
  summaryDataLabel: string;
  overviewDataTagLabel: string;
  windowLabel: string;
  t: WarMapTranslateFn;
  compact?: boolean;
}) {
  const streamStatus = summaryStatusCards.find((card) => card.key === "stream");
  const dataStatus = summaryStatusCards.find((card) => card.key === "data");
  const containerClassName = compact
    ? "mt-3 rounded-xl border border-[var(--border)] bg-slate-50/70 px-3 py-3 shadow-[0_8px_20px_-24px_rgba(15,23,42,0.24)] dark:bg-slate-900/60 dark:shadow-[0_12px_26px_-24px_rgba(2,6,23,0.62)]"
    : `${OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME} mt-4`;

  return (
    <div className={containerClassName}>
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip
          title={`${t("dashboard.charts.warMap.stats.window")}: ${windowLabel}`}
        >
          <span
            className={`${OVERLAY_PANEL_CHIP_CLASS_NAME} whitespace-nowrap px-2.5`}
          >
            <span className="font-medium text-slate-500 dark:text-slate-400">
              {t("dashboard.charts.warMap.stats.window")}
            </span>
            <span className="font-semibold text-slate-900 dark:text-slate-50">
              {windowLabel}
            </span>
          </span>
        </Tooltip>
        {compact
          ? null
          : overviewMetricCards.map((card) => (
              <Tooltip key={card.key} title={card.note}>
                <span
                  className={`${OVERLAY_PANEL_CHIP_CLASS_NAME} whitespace-nowrap px-2.5`}
                >
                  <span className="text-[13px]">
                    {renderOverviewCardIcon(card.key)}
                  </span>
                  <span className="font-medium text-slate-500 dark:text-slate-400">
                    {getSummaryMetricLabel(card, t)}
                  </span>
                  <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                    {card.value}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {getSummaryMetricDetail(card, t)}
                  </span>
                </span>
              </Tooltip>
            ))}
        {streamStatus ? (
          <Tooltip title={streamStatus.tooltip ?? streamStatus.detail}>
            <span
              className={`${OVERLAY_PANEL_CHIP_CLASS_NAME} whitespace-nowrap px-2.5`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${streamStatus.dotClassName}`}
              />
              <span className="font-medium text-slate-500 dark:text-slate-400">
                {streamStatus.label}
              </span>
              <span className="font-semibold text-slate-900 dark:text-slate-50">
                {streamStatus.value}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                {streamStatus.detail}
              </span>
            </span>
          </Tooltip>
        ) : null}
        {dataStatus ? (
          <Tooltip title={dataStatus.tooltip ?? summaryDataLabel}>
            <span
              className={`${OVERLAY_PANEL_CHIP_CLASS_NAME} whitespace-nowrap px-2.5`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${dataStatus.dotClassName}`}
              />
              <span className="font-medium text-slate-500 dark:text-slate-400">
                {dataStatus.label}
              </span>
              <span className="font-semibold text-slate-900 dark:text-slate-50">
                {overviewDataTagLabel}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                {summaryDataLabel}
              </span>
            </span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
