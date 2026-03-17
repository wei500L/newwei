"use client";

import {
  DatabaseOutlined,
  FundOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import type { WarMapPreset, WarMapTimeRangePreset } from "@modular/utils";
import { Button, Space, Tag, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";

import {
  OVERLAY_BUTTON_GROUP_CLASS_NAME,
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
  resolveOverlayButtonClassName,
  type OverlayControlsSection,
  type WarMapControlsSectionMeta,
  type WarMapDetailedChainStatus,
  type WarMapFeedSummaryCard,
  type WarMapOverviewMetricCard,
  type WarMapOverlayTab,
  type WarMapSelectableOption,
  type WarMapSummaryStatusCard,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";

type FlightMode = "military" | "all";
type AisMode = "military" | "density" | "all";

interface WarMapControlsPanelViewProps {
  presets: WarMapSelectableOption<WarMapPreset>[];
  timeRanges: WarMapSelectableOption<WarMapTimeRangePreset>[];
  layerVisibilityControls: ReactNode;
  onPresetSelect: (preset: WarMapPreset) => void;
  onTimeRangeSelect: (preset: WarMapTimeRangePreset) => void;
  onResetLayers: () => void;
}

interface WarMapControlsPanelTransportProps {
  flightMode: FlightMode;
  onFlightModeChange: (mode: FlightMode) => void;
  flightsLayerVisible: boolean;
  flightsSourceBadgeLabel: string | null;
  flightsTooltipText: string | null;
  flightsReturnedCount?: number;
  flightsSnapshotCount?: number;
  flightsRawLabel?: string | null;
  flightsFreshness?: string;
  flightsTruncated: boolean;
  aisLayerVisible: boolean;
  aisMode: AisMode;
  onAisModeChange: (mode: AisMode) => void;
  aisAllModeDisabled: boolean;
  aisAllModeDisabledLabel: string | null;
  aisTooltipText: string | null;
  aisSourceStatusColor: string;
  aisSourceStatusLabel: string;
  aisFreshness?: string;
  aisModeLabel: string;
  aisRelayVesselCount?: number;
  aisSnapshotRelative: string | null;
  aisSnapshotExact: string | null;
  aisPrimaryCountValue?: number;
  aisPrimaryCountLabel: string;
  aisDisruptionsCount?: number;
}

interface WarMapControlsPanelLegendProps {
  showAisLegend: boolean;
}

export interface WarMapControlsPanelProps {
  controlsSection: OverlayControlsSection;
  controlsSectionMeta: Record<
    OverlayControlsSection,
    WarMapControlsSectionMeta
  >;
  controlsTabs: WarMapOverlayTab[];
  useDrawerControls: boolean;
  overlayPanelMaxHeight: number;
  overviewMetricCards: WarMapOverviewMetricCard[];
  summaryStatusCards: WarMapSummaryStatusCard[];
  summaryDataLabel: string;
  overviewDataTagLabel: string;
  windowLabel: string;
  feedSummaryCards: WarMapFeedSummaryCard[];
  detailedChainStatuses: WarMapDetailedChainStatus[];
  view: WarMapControlsPanelViewProps;
  transport: WarMapControlsPanelTransportProps;
  legend: WarMapControlsPanelLegendProps;
  onControlsSectionChange: (section: OverlayControlsSection) => void;
  t: WarMapTranslateFn;
}

const OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME =
  "rounded-2xl border border-[var(--border)] bg-slate-50/80 px-3 py-3 shadow-[0_10px_24px_-22px_rgba(15,23,42,0.16)] dark:bg-slate-900/70 dark:shadow-[0_16px_34px_-26px_rgba(2,6,23,0.66)]";
const OVERLAY_PANEL_CHIP_CLASS_NAME =
  "inline-flex items-center gap-1 rounded-full border border-slate-200/80 bg-white/[0.85] px-2 py-1 text-[11px] text-slate-700 shadow-[0_8px_18px_-18px_rgba(15,23,42,0.26)] transition-[border-color,background-color,color,box-shadow] duration-200 hover:border-slate-300/[0.85] hover:bg-white hover:text-slate-900 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-200 dark:shadow-[0_10px_20px_-18px_rgba(2,6,23,0.7)] dark:hover:border-slate-500/80 dark:hover:bg-slate-900 dark:hover:text-slate-50";

function renderOverviewCardIcon(key: WarMapOverviewMetricCard["key"]) {
  switch (key) {
    case "signals":
      return <FundOutlined className="text-sky-600 dark:text-sky-300" />;
    case "news":
      return <GlobalOutlined className="text-emerald-600 dark:text-emerald-300" />;
    case "monitors":
      return <DatabaseOutlined className="text-cyan-600 dark:text-cyan-300" />;
    case "layers":
    default:
      return <InfoCircleOutlined className="text-violet-600 dark:text-violet-300" />;
  }
}

function OverviewSection({
  controlsSectionMeta,
  overviewMetricCards,
  summaryStatusCards,
  summaryDataLabel,
  overviewDataTagLabel,
  windowLabel,
  t,
}: Pick<
  WarMapControlsPanelProps,
  | "controlsSectionMeta"
  | "overviewMetricCards"
  | "summaryStatusCards"
  | "summaryDataLabel"
  | "overviewDataTagLabel"
  | "windowLabel"
  | "t"
>) {
  const streamStatus = summaryStatusCards.find((card) => card.key === "stream");
  const dataStatus = summaryStatusCards.find((card) => card.key === "data");

  return (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      <div className="grid grid-cols-2 gap-2">
        {overviewMetricCards.map((card) => (
          <div
            key={card.key}
            className={`rounded-2xl border border-[var(--border)] bg-gradient-to-br ${card.className} px-3 py-3 shadow-[0_10px_24px_-22px_rgba(15,23,42,0.18)] dark:shadow-[0_16px_34px_-24px_rgba(2,6,23,0.72)]`}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="text-base">{renderOverviewCardIcon(card.key)}</span>
              <Typography.Text type="secondary" className="text-[11px]">
                {card.label}
              </Typography.Text>
            </div>
            <Typography.Text className="mt-3 block text-lg font-semibold text-slate-900 dark:text-slate-50">
              {card.value}
            </Typography.Text>
            <Typography.Text type="secondary" className="text-[11px]">
              {card.note}
            </Typography.Text>
          </div>
        ))}
      </div>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Typography.Text strong className="block text-sm text-slate-900 dark:text-slate-100">
                {controlsSectionMeta.overview.label}
              </Typography.Text>
              <Typography.Text type="secondary" className="text-xs">
                {t("dashboard.charts.warMap.stats.window", {
                  defaultValue: "Window",
                })}
                : {windowLabel}
              </Typography.Text>
            </div>
            <Tag color="default" className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {windowLabel}
            </Tag>
          </div>
          <div className="h-px bg-slate-200/80 dark:bg-slate-700/80" />
          {streamStatus ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Typography.Text strong className="block text-sm text-slate-900 dark:text-slate-100">
                  {streamStatus.label}
                </Typography.Text>
                <Typography.Text type="secondary" className="text-xs">
                  {streamStatus.detail}
                </Typography.Text>
              </div>
              <Tooltip title={streamStatus.tooltip}>
                <Tag
                  color={streamStatus.tagColor}
                  className={OVERLAY_STATUS_TAG_CLASS_NAME}
                >
                  {streamStatus.value}
                </Tag>
              </Tooltip>
            </div>
          ) : null}
          {dataStatus ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Typography.Text strong className="block text-sm text-slate-900 dark:text-slate-100">
                  {dataStatus.label}
                </Typography.Text>
                <Typography.Text type="secondary" className="text-xs">
                  {summaryDataLabel}
                </Typography.Text>
              </div>
              <Tooltip title={dataStatus.tooltip}>
                <Tag
                  color={dataStatus.tagColor}
                  className={OVERLAY_STATUS_TAG_CLASS_NAME}
                >
                  {overviewDataTagLabel}
                </Tag>
              </Tooltip>
            </div>
          ) : null}
        </Space>
      </div>
    </Space>
  );
}

function ViewSection({
  view,
  t,
}: Pick<WarMapControlsPanelProps, "view" | "t">) {
  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.presets.title", {
            defaultValue: "Regions",
          })}
        </Typography.Text>
        <div className={`mt-2 ${OVERLAY_BUTTON_GROUP_CLASS_NAME}`}>
          {view.presets.map((preset) => (
            <Button
              key={preset.key}
              size="small"
              type="default"
              className={resolveOverlayButtonClassName({
                tone: preset.active ? "active" : "neutral",
              })}
              onClick={() => view.onPresetSelect(preset.key)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.stats.window", {
            defaultValue: "Window",
          })}
        </Typography.Text>
        <div className={`mt-2 ${OVERLAY_BUTTON_GROUP_CLASS_NAME}`}>
          {view.timeRanges.map((preset) => (
            <Button
              key={preset.key}
              size="small"
              type="default"
              className={resolveOverlayButtonClassName({
                tone: preset.active ? "active" : "neutral",
              })}
              onClick={() => view.onTimeRangeSelect(preset.key)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.layers", {
            defaultValue: "Layers",
          })}
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
        {t("common.reset", { defaultValue: "Reset" })}
      </Button>
    </Space>
  );
}

function TransportSection({
  transport,
  t,
}: Pick<WarMapControlsPanelProps, "transport" | "t">) {
  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.overlay.flights", {
            defaultValue: "Flights",
          })}
        </Typography.Text>
        <div className={`mt-2 ${OVERLAY_BUTTON_GROUP_CLASS_NAME}`}>
          <Button
            size="small"
            type="default"
            className={resolveOverlayButtonClassName({
              tone: transport.flightMode === "military" ? "active" : "neutral",
            })}
            onClick={() => transport.onFlightModeChange("military")}
          >
            {t("dashboard.charts.warMap.stats.flightModeMilitary", {
              defaultValue: "Military",
            })}
          </Button>
          <Button
            size="small"
            type="default"
            className={resolveOverlayButtonClassName({
              tone: transport.flightMode === "all" ? "active" : "neutral",
            })}
            onClick={() => transport.onFlightModeChange("all")}
          >
            {t("dashboard.charts.warMap.stats.flightModeAll", {
              defaultValue: "All",
            })}
          </Button>
        </div>
        <Space size={[6, 6]} wrap className="mt-2">
          {transport.flightsLayerVisible && transport.flightsSourceBadgeLabel ? (
            <Tooltip
              title={
                transport.flightsTooltipText ? (
                  <span className="whitespace-pre-line">
                    {transport.flightsTooltipText}
                  </span>
                ) : null
              }
            >
              <Tag color="geekblue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                {transport.flightsSourceBadgeLabel}
              </Tag>
            </Tooltip>
          ) : null}
          {transport.flightsLayerVisible &&
          typeof transport.flightsReturnedCount === "number" ? (
            <Tooltip
              title={
                transport.flightsTooltipText ? (
                  <span className="whitespace-pre-line">
                    {transport.flightsTooltipText}
                  </span>
                ) : null
              }
            >
              <Tag
                color={
                  transport.flightsFreshness === "stale"
                    ? "orange"
                    : transport.flightsFreshness === "zoom_required"
                      ? "purple"
                      : transport.flightsFreshness === "budget_limited"
                        ? "magenta"
                        : transport.flightsFreshness === "not_configured"
                          ? "red"
                          : transport.flightsFreshness === "missing"
                            ? "default"
                            : transport.flightsTruncated
                              ? "gold"
                              : "cyan"
                }
                className={OVERLAY_STATUS_TAG_CLASS_NAME}
              >
                {t("dashboard.charts.warMap.stats.flights", {
                  defaultValue: "Flights",
                })}
                : {transport.flightsReturnedCount}
                {typeof transport.flightsSnapshotCount === "number"
                  ? `/${transport.flightsSnapshotCount}`
                  : ""}
                {transport.flightsRawLabel ? ` ${transport.flightsRawLabel}` : ""}
              </Tag>
            </Tooltip>
          ) : (
            <Typography.Text type="secondary" className="text-xs">
              {t("dashboard.charts.warMap.overlay.flightStatusHint", {
                defaultValue:
                  "Flight source badges appear when the layer is visible.",
              })}
            </Typography.Text>
          )}
        </Space>
      </div>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.layerNames.ais", {
            defaultValue: "AIS traffic",
          })}
        </Typography.Text>
        {transport.aisLayerVisible ? (
          <>
            <div className={`mt-2 ${OVERLAY_BUTTON_GROUP_CLASS_NAME}`}>
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName({
                  tone: transport.aisMode === "military" ? "active" : "neutral",
                })}
                onClick={() => transport.onAisModeChange("military")}
              >
                {t("dashboard.charts.warMap.stats.aisModeMilitary", {
                  defaultValue: "Military candidates",
                })}
              </Button>
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName({
                  tone: transport.aisMode === "density" ? "active" : "neutral",
                })}
                onClick={() => transport.onAisModeChange("density")}
              >
                {t("dashboard.charts.warMap.stats.aisModeDensity", {
                  defaultValue: "Density only",
                })}
              </Button>
              <Tooltip
                title={
                  transport.aisAllModeDisabled
                    ? transport.aisAllModeDisabledLabel
                    : null
                }
              >
                <Button
                  size="small"
                  type="default"
                  className={resolveOverlayButtonClassName({
                    tone: transport.aisMode === "all" ? "active" : "neutral",
                  })}
                  disabled={transport.aisAllModeDisabled}
                  onClick={() => transport.onAisModeChange("all")}
                >
                  {t("dashboard.charts.warMap.stats.aisModeAll", {
                    defaultValue: "All vessels",
                  })}
                </Button>
              </Tooltip>
            </div>
            <Space size={[6, 6]} wrap className="mt-2">
              <Tooltip
                title={
                  transport.aisTooltipText ? (
                    <span className="whitespace-pre-line">
                      {transport.aisTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag
                  color={transport.aisSourceStatusColor}
                  className={OVERLAY_STATUS_TAG_CLASS_NAME}
                >
                  {t("dashboard.charts.warMap.layerNames.ais", {
                    defaultValue: "AIS traffic",
                  })}
                  : {transport.aisSourceStatusLabel}
                </Tag>
              </Tooltip>
              <Tooltip
                title={
                  transport.aisTooltipText ? (
                    <span className="whitespace-pre-line">
                      {transport.aisTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag color="cyan" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {transport.aisModeLabel}
                </Tag>
              </Tooltip>
              {typeof transport.aisRelayVesselCount === "number" ? (
                <Tooltip
                  title={
                    transport.aisTooltipText ? (
                      <span className="whitespace-pre-line">
                        {transport.aisTooltipText}
                      </span>
                    ) : null
                  }
                >
                  <Tag color="blue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                    {t("dashboard.charts.warMap.stats.aisTrackedVessels", {
                      defaultValue: "Tracked vessels",
                    })}
                    : {transport.aisRelayVesselCount}
                  </Tag>
                </Tooltip>
              ) : null}
              {transport.aisSnapshotRelative ? (
                <Tooltip
                  title={
                    transport.aisSnapshotExact
                      ? `${t("dashboard.charts.warMap.stats.aisSnapshotUpdated", {
                          defaultValue: "AIS updated",
                        })}: ${transport.aisSnapshotExact}`
                      : undefined
                  }
                >
                  <Tag
                    color={transport.aisFreshness === "stale" ? "gold" : "default"}
                    className={
                      transport.aisFreshness === "stale"
                        ? OVERLAY_STATUS_TAG_CLASS_NAME
                        : OVERLAY_NEUTRAL_TAG_CLASS_NAME
                    }
                  >
                    {t("dashboard.charts.warMap.stats.aisSnapshotUpdated", {
                      defaultValue: "AIS updated",
                    })}
                    : {transport.aisSnapshotRelative}
                  </Tag>
                </Tooltip>
              ) : null}
              {typeof transport.aisPrimaryCountValue === "number" ? (
                <Tooltip
                  title={
                    transport.aisTooltipText ? (
                      <span className="whitespace-pre-line">
                        {transport.aisTooltipText}
                      </span>
                    ) : null
                  }
                >
                  <Tag color="geekblue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                    {transport.aisPrimaryCountLabel}: {transport.aisPrimaryCountValue}
                  </Tag>
                </Tooltip>
              ) : null}
              {typeof transport.aisDisruptionsCount === "number" ? (
                <Tooltip
                  title={
                    transport.aisTooltipText ? (
                      <span className="whitespace-pre-line">
                        {transport.aisTooltipText}
                      </span>
                    ) : null
                  }
                >
                  <Tag color="orange" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                    {t("dashboard.charts.warMap.stats.aisDisruptions", {
                      defaultValue: "Disruptions",
                    })}
                    : {transport.aisDisruptionsCount}
                  </Tag>
                </Tooltip>
              ) : null}
              {transport.aisMode === "all" && transport.aisAllModeDisabled ? (
                <Tooltip title={transport.aisAllModeDisabledLabel}>
                  <Tag color="magenta" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                    {t("dashboard.charts.warMap.stats.aisAllUnavailable", {
                      defaultValue: "All vessels unavailable",
                    })}
                  </Tag>
                </Tooltip>
              ) : null}
            </Space>
          </>
        ) : (
          <Typography.Text type="secondary" className="text-xs">
            {t("dashboard.charts.warMap.overlay.aisStatusHint", {
              defaultValue:
                "Enable the AIS layer to inspect vessel source, freshness, and disruption signals.",
            })}
          </Typography.Text>
        )}
      </div>
    </Space>
  );
}

function FeedsSection({
  feedSummaryCards,
  detailedChainStatuses,
}: Pick<
  WarMapControlsPanelProps,
  "feedSummaryCards" | "detailedChainStatuses"
>) {
  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <div className="grid grid-cols-3 gap-2">
        {feedSummaryCards.map((card) => (
          <div
            key={card.key}
            className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}
          >
            <Typography.Text
              className={`block text-lg font-semibold ${card.toneClassName}`}
            >
              {card.value}
            </Typography.Text>
            <Typography.Text type="secondary" className="text-[11px]">
              {card.label}
            </Typography.Text>
          </div>
        ))}
      </div>
      {detailedChainStatuses.map((status) => (
        <Tooltip
          key={status.key}
          title={<span className="whitespace-pre-line">{status.tooltip}</span>}
        >
          <div className="rounded-xl border border-[var(--border)] bg-slate-50/90 px-3 py-2 dark:bg-slate-900/76">
            <Tag color={status.color} className={OVERLAY_STATUS_TAG_CLASS_NAME}>
              {status.text}
            </Tag>
          </div>
        </Tooltip>
      ))}
    </Space>
  );
}

function LegendSection({
  legend,
  t,
}: Pick<WarMapControlsPanelProps, "legend" | "t">) {
  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
        {t("dashboard.charts.warMap.legend.title", {
          defaultValue: "Legend",
        })}
      </Typography.Text>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.overlay.signalLegend", {
            defaultValue: "Signals",
          })}
        </Typography.Text>
        <Space size={[6, 6]} wrap className="mt-2">
          <Tag color="red" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.stats.high", {
              defaultValue: "High",
            })}
          </Tag>
          <Tag color="gold" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.stats.medium", {
              defaultValue: "Medium",
            })}
          </Tag>
          <Tag color="blue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.stats.low", {
              defaultValue: "Low",
            })}
          </Tag>
        </Space>
      </div>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.overlay.newsLegend", {
            defaultValue: "News & monitors",
          })}
        </Typography.Text>
        <Space size={[6, 6]} wrap className="mt-2">
          <Tag color="green" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.stats.geocoded", {
              defaultValue: "Geocoded news",
            })}
          </Tag>
          <Tag color="cyan" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.stats.fallbackCountry", {
              defaultValue: "Fallback country",
            })}
          </Tag>
          <Tag color="purple" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.stats.monitors", {
              defaultValue: "Monitors",
            })}
          </Tag>
        </Space>
      </div>
      {legend.showAisLegend ? (
        <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
          <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
            {t("dashboard.charts.warMap.legend.aisTitle", {
              defaultValue: "AIS",
            })}
          </Typography.Text>
          <Space size={[6, 6]} wrap className="mt-2">
            {[
              {
                key: "military",
                color: "rgb(220 38 38)",
                label: t("dashboard.charts.warMap.legend.aisMilitary", {
                  defaultValue: "Military / government",
                }),
              },
              {
                key: "fishing",
                color: "rgb(34 197 94)",
                label: t("dashboard.charts.warMap.legend.aisFishing", {
                  defaultValue: "Fishing",
                }),
              },
              {
                key: "passenger",
                color: "rgb(59 130 246)",
                label: t("dashboard.charts.warMap.legend.aisPassenger", {
                  defaultValue: "Passenger",
                }),
              },
              {
                key: "cargo",
                color: "rgb(148 163 184)",
                label: t("dashboard.charts.warMap.legend.aisCargo", {
                  defaultValue: "Cargo",
                }),
              },
              {
                key: "tanker",
                color: "rgb(249 115 22)",
                label: t("dashboard.charts.warMap.legend.aisTanker", {
                  defaultValue: "Tanker",
                }),
              },
              {
                key: "other",
                color: "rgb(248 250 252)",
                label: t("dashboard.charts.warMap.legend.aisOther", {
                  defaultValue: "Other",
                }),
              },
            ].map((item) => (
              <span
                key={item.key}
                className={OVERLAY_PANEL_CHIP_CLASS_NAME}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full border border-slate-300/80 dark:border-slate-600/80"
                  style={{ backgroundColor: item.color }}
                />
                <span>{item.label}</span>
              </span>
            ))}
          </Space>
          <Space size={[6, 6]} wrap className="mt-2">
            {[
              {
                key: "density",
                color:
                  "linear-gradient(90deg, rgb(147 197 253), rgb(185 28 28))",
                label: t("dashboard.charts.warMap.legend.aisDensity", {
                  defaultValue: "Traffic density heatmap",
                }),
                gradient: true,
              },
              {
                key: "disruption",
                color: "rgb(220 38 38)",
                label: t("dashboard.charts.warMap.legend.aisDisruption", {
                  defaultValue: "Chokepoint disruption",
                }),
              },
            ].map((item) => (
              <span
                key={item.key}
                className={OVERLAY_PANEL_CHIP_CLASS_NAME}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full border border-slate-300/80 dark:border-slate-600/80"
                  style={
                    item.gradient
                      ? { backgroundImage: item.color }
                      : { backgroundColor: item.color }
                  }
                />
                <span>{item.label}</span>
              </span>
            ))}
          </Space>
        </div>
      ) : null}
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-white/70 px-3 py-3 dark:bg-slate-950/55">
        <Typography.Text type="secondary" className="text-xs">
          {t("dashboard.charts.warMap.legend.radius", {
            defaultValue:
              "Larger points indicate stronger aggregated signal density.",
          })}
        </Typography.Text>
      </div>
    </Space>
  );
}

export function WarMapControlsPanel({
  controlsSection,
  controlsSectionMeta,
  controlsTabs,
  useDrawerControls,
  overlayPanelMaxHeight,
  overviewMetricCards,
  summaryStatusCards,
  summaryDataLabel,
  overviewDataTagLabel,
  windowLabel,
  feedSummaryCards,
  detailedChainStatuses,
  view,
  transport,
  legend,
  onControlsSectionChange,
  t,
}: WarMapControlsPanelProps) {
  const activeControlsSectionMeta = controlsSectionMeta[controlsSection];

  let controlsSectionContent: ReactNode;
  switch (controlsSection) {
    case "view":
      controlsSectionContent = <ViewSection view={view} t={t} />;
      break;
    case "transport":
      controlsSectionContent = <TransportSection transport={transport} t={t} />;
      break;
    case "feeds":
      controlsSectionContent = (
        <FeedsSection
          feedSummaryCards={feedSummaryCards}
          detailedChainStatuses={detailedChainStatuses}
        />
      );
      break;
    case "legend":
      controlsSectionContent = <LegendSection legend={legend} t={t} />;
      break;
    case "overview":
    default:
      controlsSectionContent = (
        <OverviewSection
          controlsSectionMeta={controlsSectionMeta}
          overviewMetricCards={overviewMetricCards}
          summaryStatusCards={summaryStatusCards}
          summaryDataLabel={summaryDataLabel}
          overviewDataTagLabel={overviewDataTagLabel}
          windowLabel={windowLabel}
          t={t}
        />
      );
      break;
  }

  return (
    <div className="flex flex-col">
      <div className="border-b border-[var(--border)] bg-gradient-to-b from-white to-slate-50/90 px-3 py-3 dark:from-slate-950/90 dark:to-slate-900/90">
        <Typography.Text strong className="block text-sm text-slate-900 dark:text-slate-100">
          {activeControlsSectionMeta.label}
        </Typography.Text>
        <Typography.Text type="secondary" className="mt-1 block text-xs">
          {activeControlsSectionMeta.description}
        </Typography.Text>
        <div
          className={`mt-3 flex gap-2 overflow-x-auto rounded-[20px] border border-[var(--border)] bg-white/55 p-1 pb-1 [scrollbar-width:none] shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] [&::-webkit-scrollbar]:hidden dark:bg-slate-950/55 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]`}
        >
          {controlsTabs.map((tab) => (
            <Button
              key={tab.key}
              size="small"
              type="default"
              className={resolveOverlayButtonClassName({
                tone: controlsSection === tab.key ? "active" : "neutral",
                extraClassName: "shrink-0",
              })}
              onClick={() => onControlsSectionChange(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      </div>
      <div
        className="overflow-y-auto px-3 py-3"
        style={
          useDrawerControls
            ? undefined
            : { maxHeight: Math.max(180, overlayPanelMaxHeight - 64) }
        }
      >
        {controlsSectionContent}
      </div>
    </div>
  );
}
