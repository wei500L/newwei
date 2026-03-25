"use client";

import {
  InfoCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Button, Tag, Tooltip, Typography } from "antd";
import type { ReactNode, RefObject } from "react";

import {
  OVERLAY_STATUS_TAG_CLASS_NAME,
  OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME,
  resolveOverlayButtonClassName,
  type OverlayControlsSection,
  type OverlayDensity,
  type OverlayPanelKey,
  type WarMapSummaryStatusCard,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";

export interface WarMapOverlayRailProps {
  overlayRailRef: RefObject<HTMLDivElement | null>;
  overlayDensity: OverlayDensity;
  overlayTopClassName: string;
  overlayRailWidth: number;
  useDrawerControls: boolean;
  summaryStatusCards: WarMapSummaryStatusCard[];
  summaryDataLabel: string;
  refreshingMapData: boolean;
  showActionLabels: boolean;
  openOverlayPanel: OverlayPanelKey | null;
  controlsSection: OverlayControlsSection;
  onRefresh: () => void;
  onToggleControls: () => void;
  onOpenLegendDrawer: () => void;
  controlsPanel: ReactNode;
  t: WarMapTranslateFn;
}

export function WarMapOverlayRail({
  overlayRailRef,
  overlayDensity,
  overlayTopClassName,
  overlayRailWidth,
  useDrawerControls,
  summaryStatusCards,
  summaryDataLabel,
  refreshingMapData,
  showActionLabels,
  openOverlayPanel,
  controlsSection,
  onRefresh,
  onToggleControls,
  onOpenLegendDrawer,
  controlsPanel,
  t,
}: WarMapOverlayRailProps) {
  const streamStatus = summaryStatusCards.find((card) => card.key === "stream");
  const dataStatus = summaryStatusCards.find((card) => card.key === "data");
  const hideRailSummaryCards =
    !useDrawerControls && openOverlayPanel === "controls";
  const controlsLabel = t("dashboard.charts.warMap.overlay.controls", {
    defaultValue: "Controls",
  });
  const legendLabel = t("dashboard.charts.warMap.legend.title", {
    defaultValue: "Legend",
  });
  const controlsActive = openOverlayPanel === "controls";

  return (
    <div
      ref={overlayRailRef}
      className={`pointer-events-none absolute ${overlayTopClassName} right-4 z-10 flex justify-end`}
      style={useDrawerControls ? undefined : { width: overlayRailWidth }}
    >
      <div
        className={`flex max-w-full flex-col items-end ${
          useDrawerControls ? "" : "w-full"
        } gap-2`}
      >
        {!useDrawerControls ? (
          <div
            className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex items-center rounded-[22px] px-2 py-2 shadow-[0_18px_36px_-26px_rgba(15,23,42,0.42)] ring-1 ring-white/60 dark:ring-white/10`}
          >
            <Tooltip title={controlsLabel}>
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName({
                  tone: controlsActive ? "active" : "neutral",
                  extraClassName:
                    "!h-10 !min-w-[7rem] !px-4 !text-xs !font-semibold",
                })}
                icon={<SettingOutlined />}
                aria-label={controlsLabel}
                aria-expanded={controlsActive}
                onClick={onToggleControls}
              >
                {controlsLabel}
              </Button>
            </Tooltip>
          </div>
        ) : null}
        {hideRailSummaryCards ? null : overlayDensity === "minimal" ? (
          <div
            className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex max-w-full items-center gap-2 px-3 py-2`}
          >
            {streamStatus ? (
              <Tooltip title={streamStatus.tooltip}>
                <Tag
                  color={streamStatus.tagColor}
                  className={OVERLAY_STATUS_TAG_CLASS_NAME}
                >
                  {streamStatus.value}
                </Tag>
              </Tooltip>
            ) : null}
            {dataStatus ? (
              <Tooltip title={dataStatus.tooltip}>
                <span className="inline-flex max-w-[160px] items-center truncate rounded-full border border-[var(--border)] bg-white/[0.92] px-2.5 py-1 text-xs text-slate-700 dark:bg-slate-950/[0.78] dark:text-slate-200">
                  {summaryDataLabel}
                </span>
              </Tooltip>
            ) : null}
          </div>
        ) : (
          <div
            className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto grid w-full grid-cols-2 gap-1.5 px-2 py-2`}
          >
            {summaryStatusCards.map((card) => (
              <Tooltip key={card.key} title={card.tooltip}>
                <div className="min-w-0 rounded-xl border border-white/80 bg-gradient-to-br from-white via-white to-slate-50 px-2.5 py-2 shadow-sm ring-1 ring-white/40 dark:border-white/10 dark:from-slate-950/[0.92] dark:via-slate-950/[0.86] dark:to-slate-900/80 dark:shadow-[0_16px_28px_-24px_rgba(2,6,23,0.82)] dark:ring-white/5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${card.dotClassName}`}
                    />
                    <Typography.Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-[0.16em]"
                    >
                      {card.label}
                    </Typography.Text>
                  </div>
                  <Typography.Text className="mt-1 block text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {card.value}
                  </Typography.Text>
                  <Typography.Text
                    type="secondary"
                    className="block truncate text-[10px]"
                  >
                    {card.detail}
                  </Typography.Text>
                </div>
              </Tooltip>
            ))}
          </div>
        )}
        <div
          className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex w-full items-center justify-end gap-2 px-2 py-2`}
        >
          <Tooltip
            title={t("dashboard.actions.fetchLatest", {
              defaultValue: "Refresh",
            })}
          >
            <Button
              size="small"
              type="default"
              className={resolveOverlayButtonClassName({
                iconOnly: !showActionLabels,
              })}
              icon={<ReloadOutlined />}
              loading={refreshingMapData}
              onClick={onRefresh}
            >
              {showActionLabels
                ? t("dashboard.actions.fetchLatest", {
                    defaultValue: "Refresh",
                  })
                : null}
            </Button>
          </Tooltip>
          {useDrawerControls ? (
            <Tooltip title={controlsLabel}>
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName({
                  tone: controlsActive ? "active" : "neutral",
                  iconOnly: !showActionLabels,
                })}
                icon={<SettingOutlined />}
                aria-label={controlsLabel}
                aria-expanded={controlsActive}
                onClick={onToggleControls}
              >
                {showActionLabels ? controlsLabel : null}
              </Button>
            </Tooltip>
          ) : null}
          {useDrawerControls ? (
            <Tooltip title={legendLabel}>
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName({
                  tone:
                    openOverlayPanel === "controls" &&
                    controlsSection === "legend"
                      ? "active"
                      : "neutral",
                  iconOnly: !showActionLabels,
                })}
                icon={<InfoCircleOutlined />}
                aria-label={legendLabel}
                onClick={onOpenLegendDrawer}
              >
                {showActionLabels ? legendLabel : null}
              </Button>
            </Tooltip>
          ) : null}
        </div>
        {!useDrawerControls && openOverlayPanel === "controls"
          ? controlsPanel
          : null}
      </div>
    </div>
  );
}
