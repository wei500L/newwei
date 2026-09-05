"use client";

import {
  InfoCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";

import {
  resolveOverlayButtonClassName,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import { WarMapOverlayRailSummary } from "./war-map-overlay-summary";
import { WarMapOverlayQuickLegend } from "./war-map-overlay-quick-legend";
import type { WarMapOverlayRailProps } from "./war-map-overlay-rail-types";
import { getQuickLegendVisibility } from "./war-map-legend-model";

/**
 * Overlay rail 薄组合层（FE-批4B：原 330 行单组件拆分）。
 * props 收敛为六个领域切片（layout/summary/refreshing/quickLegend/
 * actions/panels）；状态摘要与 quick legend 分别由子组件渲染。
 */
export function WarMapOverlayRail({
  overlayRailRef,
  layout,
  summary,
  refreshing,
  quickLegend,
  actions,
  panels,
  t,
}: WarMapOverlayRailProps) {
  const {
    density,
    variant = "embedded",
    topClassName,
    railWidth,
    useDrawerControls,
    showActionLabels,
    openPanel,
  } = layout;
  const usesLegendDock = variant === "standalone";
  const controlsLabel = t("dashboard.charts.warMap.overlay.controls");
  const legendLabel = t("dashboard.charts.warMap.legend.title");
  const controlsActive = openPanel === "controls";
  const legendActive = !usesLegendDock && openPanel === "legend";
  const showQuickLegend =
    !usesLegendDock &&
    getQuickLegendVisibility(density) &&
    quickLegend.items.length > 0 &&
    !openPanel;
  const activePanel =
    !useDrawerControls && !usesLegendDock && openPanel
      ? openPanel === "controls"
        ? panels.controls
        : usesLegendDock
          ? null
          : panels.legend
      : null;
  const showLegendToolbarButton =
    !usesLegendDock && (useDrawerControls || legendActive || !showQuickLegend);

  return (
    <div
      ref={overlayRailRef}
      className={`pointer-events-none absolute ${topClassName} right-4 z-10 flex justify-end`}
      style={useDrawerControls ? undefined : { width: railWidth }}
    >
      <div
        className={`flex max-w-full flex-col items-end ${
          useDrawerControls ? "" : "w-full"
        } gap-2`}
      >
        <WarMapOverlayRailSummary
          density={density}
          statusCards={summary.statusCards}
          dataLabel={summary.dataLabel}
          t={t}
        />
        {showQuickLegend ? (
          <WarMapOverlayQuickLegend
            density={density}
            legendLabel={legendLabel}
            quickLegend={quickLegend}
            onOpenFullLegend={actions.onToggleLegend}
            t={t}
          />
        ) : null}
        <div
          className={`flex w-full items-center justify-end gap-2 rounded-2xl border border-[var(--border)] bg-white/[0.88] shadow-xl backdrop-blur transition-all duration-200 hover:bg-white/[0.95] pointer-events-auto px-2 py-2 dark:bg-slate-950/[0.72] dark:shadow-[0_20px_48px_-30px_rgba(2,6,23,0.88)] dark:hover:bg-slate-950/[0.82]`}
        >
          <Tooltip title={t("dashboard.actions.fetchLatest")}>
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
              loading={refreshing}
              onClick={actions.onRefresh}
            >
              {showActionLabels ? t("dashboard.actions.fetchLatest") : null}
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
              onClick={actions.onToggleControls}
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
                onClick={actions.onToggleLegend}
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
