"use client";

import { CloseOutlined, ExpandOutlined } from "@ant-design/icons";
import { Button, Drawer, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";

import type { WarMapInspectorPanelProps } from "./war-map-inspector-types";
import { getSelectedInspectorTitle } from "./war-map-inspector-types";
import {
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
  OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME,
  resolveOverlayButtonClassName,
  type SelectedInspector,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";

/**
 * Inspector 外壳（FE-批4B：自 war-map-inspector-panel.tsx 拆出）。
 * 头部（类型徽标/标题/动作）与 desktop normal / minimized / mobile
 * Drawer 三种呈现包装。
 */

function inspectorKindLabel(
  selectedInspector: SelectedInspector,
  t: WarMapTranslateFn,
): string {
  return selectedInspector.kind === "event" ||
    selectedInspector.kind === "event-cluster"
    ? t("dashboard.charts.warMap.overlay.signalLegend")
    : selectedInspector.kind === "flight"
      ? t("dashboard.charts.warMap.overlay.flights")
      : selectedInspector.kind === "vessel"
        ? t("dashboard.charts.warMap.layerNames.ais")
        : t("dashboard.charts.warMap.overlay.newsLegend");
}

function inspectorKindTagLabel(
  selectedInspector: SelectedInspector,
  t: WarMapTranslateFn,
): string {
  return selectedInspector.kind === "event" ||
    selectedInspector.kind === "event-cluster"
    ? t("dashboard.charts.warMap.panel.signalsTitle")
    : selectedInspector.kind === "flight"
      ? t("dashboard.charts.warMap.overlay.flights")
      : selectedInspector.kind === "vessel"
        ? t("dashboard.charts.warMap.layerNames.ais")
        : t("dashboard.charts.warMap.panel.newsTitle");
}

function inspectorMinimizedKindLabel(
  selectedInspector: SelectedInspector,
  t: WarMapTranslateFn,
): string {
  return selectedInspector.kind === "event" ||
    selectedInspector.kind === "event-cluster"
    ? t("dashboard.charts.warMap.panel.signalsTitle")
    : selectedInspector.kind === "flight"
      ? t("dashboard.charts.warMap.overlay.flights")
      : selectedInspector.kind === "vessel"
        ? t("dashboard.charts.warMap.layerNames.ais")
        : t("dashboard.charts.warMap.panel.newsTitle");
}

export function InspectorPanelShellHeader({
  selectedInspector,
  inspectorHeaderGradient,
  useDesktopInspector,
  onZoom,
  onMinimize,
  onClose,
  t,
}: {
  selectedInspector: SelectedInspector;
  inspectorHeaderGradient: string;
  useDesktopInspector: boolean;
  onZoom: () => void;
  onMinimize: () => void;
  onClose: () => void;
  t: WarMapTranslateFn;
}) {
  return (
    <div
      className={`border-b border-[var(--border)] bg-gradient-to-br ${inspectorHeaderGradient} px-4 py-4`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Typography.Text
            type="secondary"
            className="block text-[11px] uppercase tracking-[0.14em]"
          >
            {inspectorKindLabel(selectedInspector, t)}
          </Typography.Text>
          <Space size={[6, 6]} wrap>
            <Tag
              color={
                selectedInspector.kind === "event" ||
                selectedInspector.kind === "event-cluster"
                  ? "gold"
                  : "green"
              }
              className={OVERLAY_STATUS_TAG_CLASS_NAME}
            >
              {inspectorKindTagLabel(selectedInspector, t)}
            </Tag>
            {"count" in selectedInspector ? (
              <Tag color="default" className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                {t("dashboard.charts.warMap.panel.count", {
                  count: selectedInspector.count,
                })}
              </Tag>
            ) : null}
          </Space>
          <Typography.Title
            level={5}
            className="!mb-1 !mt-2 !text-slate-900 dark:!text-slate-50"
          >
            {"item" in selectedInspector
              ? selectedInspector.item.label
              : selectedInspector.kind === "event-cluster"
                ? t("dashboard.charts.warMap.panel.signalsTitle")
                : t("dashboard.charts.warMap.panel.newsTitle")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {"item" in selectedInspector
              ? selectedInspector.kind === "event"
                ? t("dashboard.charts.warMap.panel.signalDetailSummary")
                : selectedInspector.kind === "flight"
                  ? t("dashboard.charts.warMap.panel.flightDetailSummary")
                  : selectedInspector.kind === "vessel"
                    ? t("dashboard.charts.warMap.panel.vesselDetailSummary")
                    : t("dashboard.charts.warMap.panel.newsDetailSummary")
              : selectedInspector.kind === "event-cluster"
                ? t("dashboard.charts.warMap.panel.signalsSummary", {
                    count: selectedInspector.count,
                  })
                : t("dashboard.charts.warMap.panel.newsSummary", {
                    count: selectedInspector.count,
                  })}
          </Typography.Text>
        </div>
        <Space size={8}>
          <Button
            size="small"
            type="default"
            className={resolveOverlayButtonClassName()}
            icon={<ExpandOutlined />}
            onClick={onZoom}
          >
            {t("dashboard.charts.warMap.panel.zoomIn")}
          </Button>
          {useDesktopInspector ? (
            <Button
              size="small"
              type="default"
              className={resolveOverlayButtonClassName()}
              onClick={onMinimize}
            >
              {t("common.minimize")}
            </Button>
          ) : null}
          {useDesktopInspector ? (
            <Button
              size="small"
              type="text"
              className={resolveOverlayButtonClassName({
                tone: "ghost",
                iconOnly: true,
              })}
              icon={<CloseOutlined />}
              onClick={onClose}
              aria-label={t("common.close")}
            />
          ) : null}
        </Space>
      </div>
    </div>
  );
}

export function InspectorPanelFrame({
  selectedInspector,
  content,
  layout,
  actions,
  t,
}: {
  selectedInspector: SelectedInspector;
  content: ReactNode;
  layout: WarMapInspectorPanelProps["layout"];
  actions: WarMapInspectorPanelProps["actions"];
  t: WarMapTranslateFn;
}) {
  const inspectorPanelContent = (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-white/[0.92] shadow-2xl backdrop-blur-xl dark:bg-slate-950/[0.78] dark:shadow-[0_26px_56px_-34px_rgba(2,6,23,0.92)]">
      {content}
    </div>
  );

  if (layout.useDesktopInspector && !layout.minimized) {
    return (
      <div className="pointer-events-none absolute bottom-4 right-4 z-20">
        <div
          className="pointer-events-auto transition-all duration-200"
          style={{
            width: layout.width,
            height: layout.height,
          }}
        >
          {inspectorPanelContent}
        </div>
      </div>
    );
  }

  if (layout.useDesktopInspector && layout.minimized) {
    return (
      <div className="pointer-events-none absolute bottom-4 right-4 z-20">
        <div
          className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex items-center gap-3 px-3 py-2`}
          style={{ width: layout.width }}
        >
          <div className="min-w-0 flex-1">
            <Typography.Text
              type="secondary"
              className="block text-[11px] uppercase tracking-[0.14em]"
            >
              {inspectorMinimizedKindLabel(selectedInspector, t)}
            </Typography.Text>
            <Typography.Text
              strong
              className="block truncate text-sm text-slate-900 dark:text-slate-100"
            >
              {getSelectedInspectorTitle(selectedInspector, t)}
            </Typography.Text>
          </div>
          <Button
            size="small"
            type="default"
            className={resolveOverlayButtonClassName({ tone: "active" })}
            onClick={actions.onExpand}
          >
            {t("dashboard.charts.warMap.overlay.expandInspector")}
          </Button>
          <Button
            size="small"
            type="text"
            className={resolveOverlayButtonClassName({
              tone: "ghost",
              iconOnly: true,
            })}
            icon={<CloseOutlined />}
            onClick={actions.onClose}
            aria-label={t("common.close")}
          />
        </div>
      </div>
    );
  }

  return (
    <Drawer
      open
      onClose={actions.onClose}
      placement="right"
      width="100%"
      destroyOnClose={false}
      title={null}
    >
      {inspectorPanelContent}
    </Drawer>
  );
}
