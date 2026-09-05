"use client";

import { Button, Typography } from "antd";

import {
  ControlsChoiceButton,
  OVERLAY_PANEL_OPTION_GRID_CLASS_NAME,
  OVERLAY_PANEL_STACK_CLASS_NAME,
  OVERLAY_PANEL_STANDALONE_SPLIT_GRID_CLASS_NAME,
  OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME,
} from "./war-map-controls-primitives";
import type { WarMapControlsPanelViewProps } from "./war-map-controls-types";
import {
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  resolveOverlayButtonClassName,
  type WarMapLayoutVariant,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";

/**
 * View 节（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * preset、时间范围与图层可见性槽位。
 */
export function ViewSection({
  view,
  t,
  layoutVariant,
}: {
  view: WarMapControlsPanelViewProps;
  t: WarMapTranslateFn;
  layoutVariant?: WarMapLayoutVariant;
}) {
  const standaloneLayout = layoutVariant === "standalone";

  return (
    <div
      className={
        standaloneLayout
          ? "flex w-full flex-col gap-5"
          : OVERLAY_PANEL_STACK_CLASS_NAME
      }
    >
      <div
        className={
          standaloneLayout
            ? OVERLAY_PANEL_STANDALONE_SPLIT_GRID_CLASS_NAME
            : OVERLAY_PANEL_STACK_CLASS_NAME
        }
      >
        <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
          <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
            {t("dashboard.charts.warMap.presets.title")}
          </Typography.Text>
          <div className={OVERLAY_PANEL_OPTION_GRID_CLASS_NAME}>
            {view.presets.map((preset) => (
              <ControlsChoiceButton
                key={preset.key}
                active={preset.active}
                onClick={() => view.onPresetSelect(preset.key)}
              >
                {preset.label}
              </ControlsChoiceButton>
            ))}
          </div>
        </div>
        <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
          <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
            {t("dashboard.charts.warMap.stats.window")}
          </Typography.Text>
          <div className={OVERLAY_PANEL_OPTION_GRID_CLASS_NAME}>
            {view.timeRanges.map((preset) => (
              <ControlsChoiceButton
                key={preset.key}
                active={preset.active}
                onClick={() => view.onTimeRangeSelect(preset.key)}
              >
                {preset.label}
              </ControlsChoiceButton>
            ))}
          </div>
        </div>
      </div>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.layers")}
        </Typography.Text>
        <div className="mt-3">{view.layerVisibilityControls}</div>
      </div>
      <Button
        type="link"
        size="small"
        className={resolveOverlayButtonClassName({ tone: "link" })}
        style={{ padding: 0, height: "auto" }}
        onClick={view.onResetLayers}
      >
        {t("common.reset")}
      </Button>
    </div>
  );
}
