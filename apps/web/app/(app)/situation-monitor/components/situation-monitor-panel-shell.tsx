"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { ReactNode } from "react";
import type { Layout } from "react-grid-layout";
import { useTranslation } from "react-i18next";

import type { SituationMonitorPanelId } from "@/store/situation-monitor-layout";

import { isPanelSizeCustomizedForBreakpoint, type GridBreakpoint } from "../utils/layout-grid";
import { stopSituationMonitorInteractiveEvent } from "../utils/situation-monitor-format";

export function SituationMonitorPanelShell(props: {
  panelId: SituationMonitorPanelId;
  layoutItem: Layout | undefined;
  gridBreakpoint: GridBreakpoint;
  rowHeight: number;
  gridMargin: [number, number];
  canEditLayout: boolean;
  isPreviewingResize: boolean;
  onResetPanelSize: (panelId: SituationMonitorPanelId) => void;
  children: ReactNode;
}) {
  const {
    panelId,
    layoutItem,
    gridBreakpoint,
    rowHeight,
    gridMargin,
    canEditLayout,
    isPreviewingResize,
    onResetPanelSize,
    children,
  } = props;
  const { t } = useTranslation();
  const estimatedHeight = layoutItem
    ? layoutItem.h * rowHeight + Math.max(0, layoutItem.h - 1) * gridMargin[1]
    : null;
  const isSizeCustomized = layoutItem
    ? isPanelSizeCustomizedForBreakpoint(layoutItem, gridBreakpoint)
    : false;
  const resetPanelSizeLabel = t("situationMonitor.layout.resetPanelSize");

  return (
    <div className="sm-layout-panel-shell h-full" data-panel-id={panelId}>
      {canEditLayout && layoutItem ? (
        <div
          className={[
            "sm-layout-panel-tools",
            isPreviewingResize ? "sm-layout-panel-tools--active" : null,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <span className="sm-layout-panel-metrics">
            {t("situationMonitor.layout.sizeBadge", {
              cols: layoutItem.w,
              rows: layoutItem.h,
              height: estimatedHeight ?? 0,
            })}
          </span>
          {isSizeCustomized ? (
            <Button
              size="small"
              type="default"
              icon={<ReloadOutlined />}
              className="sm-layout-panel-reset"
              data-sm-interactive
              aria-label={resetPanelSizeLabel}
              title={resetPanelSizeLabel}
              onPointerDown={stopSituationMonitorInteractiveEvent}
              onMouseDown={stopSituationMonitorInteractiveEvent}
              onClick={() => onResetPanelSize(panelId)}
            />
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
