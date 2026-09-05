"use client";

import { Button, Space, Tag, Tooltip, Typography } from "antd";

import { AisControlsCard } from "./war-map-ais-reference";
import {
  FLIGHTS_SECTION_CARD_CLASS_NAME,
  ControlsChoiceButton,
  OVERLAY_PANEL_OPTION_GRID_CLASS_NAME,
  OVERLAY_PANEL_STACK_CLASS_NAME,
  OVERLAY_PANEL_STANDALONE_SPLIT_GRID_CLASS_NAME,
  TransportSectionHeader,
} from "./war-map-controls-primitives";
import type {
  WarMapControlsPanelTransportProps,
} from "./war-map-controls-types";
import {
  OVERLAY_STATUS_TAG_CLASS_NAME,
  type WarMapLayoutVariant,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import type { WarMapLegendSection } from "./war-map-symbols";

/**
 * Transport 节（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * AIS 卡片（war-map-ais-reference.tsx）与航班卡的编排及分析提交。
 */
export function TransportSection({
  transport,
  legendSections,
  t,
  layoutVariant,
}: {
  transport: WarMapControlsPanelTransportProps;
  legendSections: WarMapLegendSection[];
  t: WarMapTranslateFn;
  layoutVariant?: WarMapLayoutVariant;
}) {
  const standaloneLayout = layoutVariant === "standalone";
  const transportLegendItems =
    legendSections.find((section) => section.key === "transport")?.items ?? [];
  const aisReferenceItems = transportLegendItems
    .filter((item) => item.symbolKey.startsWith("ais-"))
    .slice(0, 4);
  // 领域切片局部别名（presentation 整体读取，不在装配层摊平）
  const flights = transport.flights;
  const flightsPresentation = flights.presentation;
  const flightsSectionDescription = t(
    "dashboard.charts.warMap.overlay.flightsSectionDescription",
  );

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
        <AisControlsCard
          ais={transport.ais}
          aisReferenceItems={aisReferenceItems}
          onOpenLegend={transport.legend.onOpen}
          t={t}
        />
        <div className={FLIGHTS_SECTION_CARD_CLASS_NAME}>
          <TransportSectionHeader
            eyebrow={t("dashboard.charts.warMap.overlay.airEyebrow")}
            title={t("dashboard.charts.warMap.overlay.flights")}
            description={flightsSectionDescription}
          />
          <div className={OVERLAY_PANEL_OPTION_GRID_CLASS_NAME}>
            <ControlsChoiceButton
              active={flights.mode === "military"}
              onClick={() => flights.onModeChange("military")}
            >
              {t("dashboard.charts.warMap.stats.flightModeMilitary")}
            </ControlsChoiceButton>
            <ControlsChoiceButton
              active={flights.mode === "all"}
              onClick={() => flights.onModeChange("all")}
            >
              {t("dashboard.charts.warMap.stats.flightModeAll")}
            </ControlsChoiceButton>
          </div>
          <Space size={[8, 8]} wrap className="mt-3">
            {flights.visible &&
            flightsPresentation.flightsSourceBadgeLabel ? (
              <Tooltip
                title={
                  flightsPresentation.flightsTooltipText ? (
                    <span className="whitespace-pre-line">
                      {flightsPresentation.flightsTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag color="geekblue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {flightsPresentation.flightsSourceBadgeLabel}
                </Tag>
              </Tooltip>
            ) : null}
            {flights.visible &&
            typeof flightsPresentation.flightsReturnedCount === "number" ? (
              <Tooltip
                title={
                  flightsPresentation.flightsTooltipText ? (
                    <span className="whitespace-pre-line">
                      {flightsPresentation.flightsTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag
                  color={
                    flightsPresentation.flightsFreshness === "stale"
                      ? "orange"
                      : flightsPresentation.flightsFreshness === "zoom_required"
                        ? "purple"
                        : flightsPresentation.flightsFreshness ===
                            "budget_limited"
                          ? "magenta"
                          : flightsPresentation.flightsFreshness ===
                              "not_configured"
                            ? "red"
                            : flightsPresentation.flightsFreshness === "missing"
                              ? "default"
                              : flightsPresentation.flightsTruncated
                                ? "gold"
                                : "cyan"
                  }
                  className={OVERLAY_STATUS_TAG_CLASS_NAME}
                >
                  {t("dashboard.charts.warMap.stats.flights")}
                  : {flightsPresentation.flightsReturnedCount}
                  {typeof flightsPresentation.flightsSnapshotCount === "number"
                    ? `/${flightsPresentation.flightsSnapshotCount}`
                    : ""}
                  {flightsPresentation.flightsRawLabel
                    ? ` ${flightsPresentation.flightsRawLabel}`
                    : ""}
                </Tag>
              </Tooltip>
            ) : (
              <Typography.Text type="secondary" className="text-xs">
                {t("dashboard.charts.warMap.overlay.flightStatusHint")}
              </Typography.Text>
            )}
          </Space>
        </div>
      </div>
      <Button
        type="primary"
        className="!h-11 !rounded-[16px] !px-4 !text-[13px] !font-semibold"
        loading={transport.analysis.submitting}
        disabled={!transport.analysis.allowed}
        onClick={transport.analysis.onSubmit}
      >
        {t("dashboard.charts.warMap.actions.analyzeCurrentView")}
      </Button>
    </div>
  );
}
