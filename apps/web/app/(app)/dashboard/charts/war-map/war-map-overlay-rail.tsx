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
  type OverlayDensity,
  type WarMapLayoutVariant,
  type OverlayPanelKey,
  type WarMapSummaryStatusCard,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import {
  WarMapLegendSwatch,
  getQuickLegendVisibility,
  selectVisibleQuickLegendItems,
  type WarMapLegendItem,
} from "./war-map-symbols";

export interface WarMapOverlayRailProps {
  overlayRailRef: RefObject<HTMLDivElement | null>;
  overlayDensity: OverlayDensity;
  layoutVariant?: WarMapLayoutVariant;
  overlayTopClassName: string;
  overlayRailWidth: number;
  useDrawerControls: boolean;
  summaryStatusCards: WarMapSummaryStatusCard[];
  summaryDataLabel: string;
  refreshingMapData: boolean;
  showActionLabels: boolean;
  openOverlayPanel: OverlayPanelKey | null;
  quickLegendItems: WarMapLegendItem[];
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onRefresh: () => void;
  onToggleControls: () => void;
  onToggleLegend: () => void;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
  controlsPanel: ReactNode;
  legendPanel: ReactNode;
  t: WarMapTranslateFn;
}

export function WarMapOverlayRail({
  overlayRailRef,
  overlayDensity,
  layoutVariant = "embedded",
  overlayTopClassName,
  overlayRailWidth,
  useDrawerControls,
  summaryStatusCards,
  summaryDataLabel,
  refreshingMapData,
  showActionLabels,
  openOverlayPanel,
  quickLegendItems,
  activeLegendKey,
  highlightedLegendKey,
  onRefresh,
  onToggleControls,
  onToggleLegend,
  onLegendItemHover,
  onLegendItemFocus,
  controlsPanel,
  legendPanel,
  t,
}: WarMapOverlayRailProps) {
  const usesLegendDock = layoutVariant === "standalone";
  const streamStatus = summaryStatusCards.find((card) => card.key === "stream");
  const dataStatus = summaryStatusCards.find((card) => card.key === "data");
  const controlsLabel = t("dashboard.charts.warMap.overlay.controls", {
    defaultValue: "Controls",
  });
  const legendLabel = t("dashboard.charts.warMap.legend.title", {
    defaultValue: "Legend",
  });
  const controlsActive = openOverlayPanel === "controls";
  const legendActive = !usesLegendDock && openOverlayPanel === "legend";
  const showQuickLegend =
    !usesLegendDock &&
    getQuickLegendVisibility(overlayDensity) &&
    quickLegendItems.length > 0 &&
    !openOverlayPanel;
  const {
    visibleItems: visibleQuickLegendItems,
    hiddenCount: hiddenQuickLegendCount,
  } = selectVisibleQuickLegendItems({
    density: overlayDensity,
    items: quickLegendItems,
  });
  const activePanel =
    !useDrawerControls && !usesLegendDock && openOverlayPanel
      ? openOverlayPanel === "controls"
        ? controlsPanel
        : usesLegendDock
          ? null
          : legendPanel
      : null;
  const showLegendToolbarButton =
    !usesLegendDock && (useDrawerControls || legendActive || !showQuickLegend);

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
        {overlayDensity === "minimal" ? (
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
            className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex w-full flex-wrap items-center gap-2 px-3 py-2.5`}
          >
            {streamStatus ? (
              <Tooltip title={streamStatus.tooltip}>
                <div className="min-w-0 rounded-full border border-slate-200/80 bg-white/[0.92] px-3 py-2 shadow-[0_10px_18px_-18px_rgba(15,23,42,0.2)] dark:border-slate-700/80 dark:bg-slate-950/[0.78] dark:shadow-[0_12px_22px_-18px_rgba(2,6,23,0.7)]">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${streamStatus.dotClassName}`}
                    />
                    <Typography.Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-[0.16em]"
                    >
                      {streamStatus.label}
                    </Typography.Text>
                    <Typography.Text className="text-[12px] font-semibold text-slate-900 dark:text-slate-50">
                      {streamStatus.value}
                    </Typography.Text>
                    <Typography.Text
                      type="secondary"
                      className="max-w-[8rem] truncate text-[10px]"
                    >
                      {streamStatus.detail}
                    </Typography.Text>
                  </div>
                </div>
              </Tooltip>
            ) : null}
            <Tooltip title={dataStatus?.tooltip}>
              <div className="min-w-0 rounded-full border border-slate-200/80 bg-white/[0.92] px-3 py-2 shadow-[0_10px_18px_-18px_rgba(15,23,42,0.2)] dark:border-slate-700/80 dark:bg-slate-950/[0.78] dark:shadow-[0_12px_22px_-18px_rgba(2,6,23,0.7)]">
                <div className="flex items-center gap-2">
                  {dataStatus ? (
                    <span
                      className={`h-2 w-2 rounded-full ${dataStatus.dotClassName}`}
                    />
                  ) : null}
                  <Typography.Text
                    type="secondary"
                    className="text-[10px] uppercase tracking-[0.16em]"
                  >
                    {dataStatus?.label ?? "Data"}
                  </Typography.Text>
                  <span className="max-w-[180px] truncate text-[11px] text-slate-600 dark:text-slate-300">
                    {summaryDataLabel}
                  </span>
                </div>
              </div>
            </Tooltip>
          </div>
        )}
        {showQuickLegend ? (
          <div
            className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto w-full px-3 py-2.5`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Typography.Text className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {legendLabel}
                </Typography.Text>
                <Typography.Text className="mt-0.5 block text-[11px] leading-4 text-slate-600 dark:text-slate-300">
                  {t("dashboard.charts.warMap.legend.quickLegendCompactHint", {
                    defaultValue: "Active symbol cues",
                  })}
                </Typography.Text>
              </div>
              <Tooltip
                title={t("dashboard.charts.warMap.overlay.openFullLegend", {
                  defaultValue: "Open full legend",
                })}
              >
                <Button
                  size="small"
                  type="default"
                  className={resolveOverlayButtonClassName({
                    tone: "ghost",
                    iconOnly: true,
                    extraClassName:
                      "!h-8 !min-w-8 !rounded-full !border !border-slate-200/80 !bg-white/[0.76] dark:!border-slate-700/80 dark:!bg-slate-950/[0.68]",
                  })}
                  aria-label={legendLabel}
                  icon={<InfoCircleOutlined />}
                  onClick={onToggleLegend}
                />
              </Tooltip>
            </div>
            <div className="mt-2.5 grid gap-2">
              {visibleQuickLegendItems.map(({ key, ...item }) => (
                <WarMapLegendSwatch
                  key={key}
                  {...item}
                  size={22}
                  variant="quick"
                  interactive
                  active={activeLegendKey === key}
                  muted={
                    Boolean(highlightedLegendKey) &&
                    highlightedLegendKey !== key
                  }
                  onClick={() =>
                    onLegendItemFocus?.(activeLegendKey === key ? null : key)
                  }
                  onMouseEnter={() => onLegendItemHover?.(key)}
                  onMouseLeave={() => onLegendItemHover?.(null)}
                />
              ))}
              {hiddenQuickLegendCount > 0 ? (
                <Button
                  type="default"
                  className={resolveOverlayButtonClassName({
                    tone: "neutral",
                    extraClassName:
                      "!h-9 !justify-start !rounded-xl !px-3 !text-[11px] !font-medium",
                  })}
                  onClick={onToggleLegend}
                >
                  {t("dashboard.charts.warMap.legend.moreItems", {
                    defaultValue: "+{{count}} more",
                    count: hiddenQuickLegendCount,
                  })}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
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
                extraClassName: useDrawerControls
                  ? "!h-10 !min-w-10"
                  : undefined,
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
          <Tooltip title={controlsLabel}>
            <Button
              size="small"
              type="default"
              className={resolveOverlayButtonClassName({
                tone: controlsActive ? "active" : "neutral",
                iconOnly: !showActionLabels && useDrawerControls,
                extraClassName: useDrawerControls
                  ? "!h-10 !min-w-10"
                  : "!h-10 !min-w-[6.5rem] !px-4 !text-xs !font-semibold",
              })}
              icon={<SettingOutlined />}
              aria-label={controlsLabel}
              aria-expanded={controlsActive}
              onClick={onToggleControls}
            >
              {!useDrawerControls || showActionLabels ? controlsLabel : null}
            </Button>
          </Tooltip>
          {showLegendToolbarButton ? (
            <Tooltip title={legendLabel}>
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName({
                  tone: legendActive ? "active" : "neutral",
                  iconOnly: !showActionLabels && useDrawerControls,
                  extraClassName: useDrawerControls
                    ? "!h-10 !min-w-10"
                    : "!h-10 !min-w-[6.5rem] !px-4 !text-xs !font-semibold",
                })}
                icon={<InfoCircleOutlined />}
                aria-label={legendLabel}
                onClick={onToggleLegend}
              >
                {!useDrawerControls || showActionLabels ? legendLabel : null}
              </Button>
            </Tooltip>
          ) : null}
        </div>
        {activePanel}
      </div>
    </div>
  );
}
