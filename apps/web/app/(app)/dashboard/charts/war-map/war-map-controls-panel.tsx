"use client";

import {
  CloseOutlined,
  DatabaseOutlined,
  DownOutlined,
  FundOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  PushpinOutlined,
  RightOutlined,
} from "@ant-design/icons";
import type { WarMapPreset, WarMapTimeRangePreset } from "@modular/utils";
import { Button, Space, Tag, Tooltip, Typography } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
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
import {
  WarMapLegendSwatch,
  type WarMapLegendItem,
  type WarMapLegendSection,
} from "./war-map-symbols";

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
  aisEffectiveMode: AisMode;
  onAisModeChange: (mode: AisMode) => void;
  aisHighlightCandidates: boolean;
  onAisHighlightCandidatesChange: (enabled: boolean) => void;
  aisAllModeDisabled: boolean;
  aisAllModeDisabledLabel: string | null;
  aisTooltipText: string | null;
  aisStatusReason: string | null;
  aisSourceStatusColor: string;
  aisSourceStatusLabel: string;
  aisFreshness?: string;
  aisModeLabel: string;
  aisRelayVesselCount?: number;
  aisSnapshotRelative: string | null;
  aisSnapshotExact: string | null;
  aisPrimaryCountValue?: number;
  aisPrimaryCountLabel: string;
  aisHighlightCountValue?: number;
  aisHighlightCountLabel?: string;
  aisDisruptionsCount?: number;
  aisViewportEmptyStateActive: boolean;
  aisViewportEmptyStateLabel: string | null;
  aisViewportEmptyStateHint: string | null;
  canAnalyzeCurrentView: boolean;
  analyzingCurrentView: boolean;
  onAnalyzeCurrentView: () => void;
  onOpenLegend: () => void;
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
  legendSections: WarMapLegendSection[];
  view: WarMapControlsPanelViewProps;
  transport: WarMapControlsPanelTransportProps;
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
  onControlsSectionChange: (section: OverlayControlsSection) => void;
  onClose?: () => void;
  t: WarMapTranslateFn;
}

export interface WarMapLegendPanelProps {
  legendSections: WarMapLegendSection[];
  summaryDataLabel?: string;
  onClose?: () => void;
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
  t: WarMapTranslateFn;
}

const OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME =
  "rounded-2xl border border-[var(--border)] bg-slate-50/80 px-4 py-4 shadow-[0_10px_24px_-22px_rgba(15,23,42,0.16)] dark:bg-slate-900/70 dark:shadow-[0_16px_34px_-26px_rgba(2,6,23,0.66)]";
const OVERLAY_PANEL_CHIP_CLASS_NAME =
  "inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/[0.88] px-3 py-1.5 text-[12px] text-slate-700 shadow-[0_8px_18px_-18px_rgba(15,23,42,0.26)] transition-[border-color,background-color,color,box-shadow] duration-200 hover:border-slate-300/[0.85] hover:bg-white hover:text-slate-900 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-200 dark:shadow-[0_10px_20px_-18px_rgba(2,6,23,0.7)] dark:hover:border-slate-500/80 dark:hover:bg-slate-900 dark:hover:text-slate-50";
const OVERLAY_PANEL_STACK_CLASS_NAME = "flex w-full flex-col gap-4";
const OVERLAY_PANEL_OPTION_GRID_CLASS_NAME = "mt-3 grid gap-3 sm:grid-cols-2";
const OVERLAY_PANEL_AIS_MODE_GRID_CLASS_NAME = "mt-3 grid gap-2 sm:grid-cols-3";
const OVERLAY_PANEL_TAB_GRID_CLASS_NAME =
  "mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3";
const OVERLAY_PANEL_OPTION_BUTTON_CLASS_NAME =
  "!h-auto !min-h-10 !w-full !justify-start !rounded-[16px] !px-3.5 !py-2.5 !text-left !text-[12px] !font-semibold !leading-5";
const OVERLAY_PANEL_TAB_BUTTON_CLASS_NAME =
  "!h-auto !min-h-[3rem] !w-full !justify-center !rounded-[18px] !px-3.5 !py-2.5 !text-center !text-[12px] !font-semibold !leading-5";
const AIS_SECTION_CARD_CLASS_NAME = `${OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME} border-cyan-200/70 bg-cyan-50/55 dark:border-cyan-400/25 dark:bg-cyan-950/12`;
const FLIGHTS_SECTION_CARD_CLASS_NAME = `${OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME} border-indigo-200/70 bg-indigo-50/45 dark:border-indigo-400/25 dark:bg-indigo-950/12`;
const OVERLAY_PANEL_MODE_HINT_CLASS_NAME =
  "mt-3 rounded-2xl border border-amber-200/80 bg-amber-50/85 px-3.5 py-3 text-[12px] leading-5 text-amber-900 shadow-[0_12px_28px_-24px_rgba(180,83,9,0.45)] dark:border-amber-400/30 dark:bg-amber-950/25 dark:text-amber-100";

function ControlsChoiceButton({
  active,
  children,
  disabled = false,
  tooltip,
  onClick,
  align = "start",
}: {
  active: boolean;
  children: ReactNode;
  disabled?: boolean;
  tooltip?: ReactNode;
  onClick: () => void;
  align?: "start" | "center";
}) {
  const button = (
    <Button
      type="default"
      disabled={disabled}
      className={resolveOverlayButtonClassName({
        tone: active ? "active" : "neutral",
        extraClassName:
          align === "center"
            ? OVERLAY_PANEL_TAB_BUTTON_CLASS_NAME
            : OVERLAY_PANEL_OPTION_BUTTON_CLASS_NAME,
      })}
      onClick={onClick}
    >
      <span
        className={`whitespace-normal leading-5 ${
          align === "center" ? "text-center" : "text-left"
        }`}
      >
        {children}
      </span>
    </Button>
  );

  if (!tooltip) {
    return button;
  }

  return (
    <Tooltip title={tooltip}>
      <span className="w-full">{button}</span>
    </Tooltip>
  );
}

function renderOverviewCardIcon(key: WarMapOverviewMetricCard["key"]) {
  switch (key) {
    case "signals":
      return <FundOutlined className="text-sky-600 dark:text-sky-300" />;
    case "news":
      return (
        <GlobalOutlined className="text-emerald-600 dark:text-emerald-300" />
      );
    case "monitors":
      return <DatabaseOutlined className="text-cyan-600 dark:text-cyan-300" />;
    case "layers":
    default:
      return (
        <InfoCircleOutlined className="text-violet-600 dark:text-violet-300" />
      );
  }
}

function TransportSectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <Typography.Text className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
        {eyebrow}
      </Typography.Text>
      <Typography.Text
        strong
        className={`${OVERLAY_SECTION_TITLE_CLASS_NAME} mt-1 block`}
      >
        {title}
      </Typography.Text>
      <Typography.Text
        type="secondary"
        className="mt-1 block text-xs leading-5"
      >
        {description}
      </Typography.Text>
    </div>
  );
}

function resolveActiveControlsSection(
  controlsSection: OverlayControlsSection,
): Exclude<OverlayControlsSection, "overview"> {
  return controlsSection === "overview" ? "view" : controlsSection;
}

function getSummaryMetricLabel(
  card: WarMapOverviewMetricCard,
  t: WarMapTranslateFn,
): string {
  if (card.key === "layers") {
    return t("dashboard.charts.warMap.layers", {
      defaultValue: "Layers",
    });
  }

  return card.label;
}

function getSummaryMetricDetail(
  card: WarMapOverviewMetricCard,
  t: WarMapTranslateFn,
): string {
  switch (card.key) {
    case "signals":
      return t("dashboard.charts.warMap.overlay.signalDensityShort", {
        defaultValue: "active",
      });
    case "news":
      return t("dashboard.charts.warMap.overlay.newsCoverageShort", {
        defaultValue: "mapped",
      });
    case "monitors":
      return t("dashboard.charts.warMap.overlay.monitorCoverageShort", {
        defaultValue: "tracked",
      });
    case "layers":
    default:
      return t("dashboard.charts.warMap.overlay.layerCoverageShort", {
        defaultValue: "visible",
      });
  }
}

function LegendItemsGrid({
  items,
  compact = false,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
}: {
  items: WarMapLegendItem[];
  compact?: boolean;
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={compact ? "mt-2.5 grid gap-2" : "mt-2.5 grid gap-2"}>
      {items.map(({ key, ...item }) => (
        <WarMapLegendSwatch
          key={key}
          size={compact ? 30 : 34}
          variant={compact ? "quick" : "panel"}
          interactive={Boolean(onLegendItemHover || onLegendItemFocus)}
          active={activeLegendKey === key}
          muted={Boolean(highlightedLegendKey) && highlightedLegendKey !== key}
          onClick={
            onLegendItemFocus
              ? () => onLegendItemFocus(activeLegendKey === key ? null : key)
              : undefined
          }
          onMouseEnter={
            onLegendItemHover ? () => onLegendItemHover(key) : undefined
          }
          onMouseLeave={
            onLegendItemHover ? () => onLegendItemHover(null) : undefined
          }
          endAdornment={
            activeLegendKey === key ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200/80 bg-white/90 px-2 py-1 text-[10px] font-medium text-slate-600 dark:border-slate-600/80 dark:bg-slate-950/78 dark:text-slate-300">
                <PushpinOutlined />
                {compact ? null : "Focus"}
              </span>
            ) : null
          }
          {...item}
        />
      ))}
    </div>
  );
}

function LegendSectionCard({
  section,
  expanded,
  activeLegendKey,
  highlightedLegendKey,
  onToggle,
  onLegendItemHover,
  onLegendItemFocus,
}: {
  section: WarMapLegendSection;
  expanded: boolean;
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onToggle: () => void;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
}) {
  return (
    <div className="rounded-[18px] border border-slate-200/75 bg-white/[0.68] px-3.5 py-3 shadow-[0_10px_24px_-24px_rgba(15,23,42,0.14)] dark:border-slate-700/80 dark:bg-slate-950/[0.58] dark:shadow-[0_14px_28px_-24px_rgba(2,6,23,0.72)]">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={onToggle}
      >
        <div className="min-w-0">
          <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
            {section.title}
          </Typography.Text>
          {section.description ? (
            <Typography.Text
              type="secondary"
              className="mt-1 block text-[11px] leading-[1.15rem]"
            >
              {section.description}
            </Typography.Text>
          ) : null}
        </div>
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200/80 bg-white/88 text-[11px] text-slate-500 dark:border-slate-700/80 dark:bg-slate-950/80 dark:text-slate-300">
          {expanded ? <DownOutlined /> : <RightOutlined />}
        </span>
      </button>
      {expanded ? (
        <LegendItemsGrid
          items={section.items}
          activeLegendKey={activeLegendKey}
          highlightedLegendKey={highlightedLegendKey}
          onLegendItemHover={onLegendItemHover}
          onLegendItemFocus={onLegendItemFocus}
        />
      ) : null}
    </div>
  );
}

function LegendSectionsList({
  legendSections,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
}: {
  legendSections: WarMapLegendSection[];
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
}) {
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >(() =>
    Object.fromEntries(
      legendSections.map((section) => [
        section.key,
        section.defaultExpanded !== false,
      ]),
    ),
  );

  useEffect(() => {
    setExpandedSections((current) =>
      Object.fromEntries(
        legendSections.map((section) => [
          section.key,
          current[section.key] ?? section.defaultExpanded !== false,
        ]),
      ),
    );
  }, [legendSections]);

  return (
    <div className="flex w-full flex-col gap-2.5">
      {legendSections.map((section) => (
        <LegendSectionCard
          key={section.key}
          section={section}
          expanded={
            expandedSections[section.key] ?? section.defaultExpanded !== false
          }
          activeLegendKey={activeLegendKey}
          highlightedLegendKey={highlightedLegendKey}
          onToggle={() =>
            setExpandedSections((current) => ({
              ...current,
              [section.key]: !current[section.key],
            }))
          }
          onLegendItemHover={onLegendItemHover}
          onLegendItemFocus={onLegendItemFocus}
        />
      ))}
    </div>
  );
}

function renderControlsTabLabel(
  tab: WarMapOverlayTab,
  active: boolean,
): ReactNode {
  const attentionToneClassName =
    tab.attentionTone === "critical"
      ? active
        ? "border-white/25 bg-white/12 text-white"
        : "border-rose-200/90 bg-rose-50 text-rose-700 dark:border-rose-400/35 dark:bg-rose-400/12 dark:text-rose-200"
      : active
        ? "border-white/25 bg-white/12 text-white"
        : "border-amber-200/90 bg-amber-50 text-amber-700 dark:border-amber-400/35 dark:bg-amber-400/12 dark:text-amber-200";

  return (
    <span className="flex flex-wrap items-center justify-center gap-1.5 whitespace-normal leading-5">
      <span>{tab.label}</span>
      {tab.attentionLabel ? (
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${attentionToneClassName}`}
        >
          {tab.attentionLabel}
        </span>
      ) : null}
    </span>
  );
}

function ControlsHeaderSummary({
  overviewMetricCards,
  summaryStatusCards,
  summaryDataLabel,
  overviewDataTagLabel,
  windowLabel,
  t,
  compact = false,
}: Pick<
  WarMapControlsPanelProps,
  | "overviewMetricCards"
  | "summaryStatusCards"
  | "summaryDataLabel"
  | "overviewDataTagLabel"
  | "windowLabel"
  | "t"
> & {
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
          title={`${t("dashboard.charts.warMap.stats.window", {
            defaultValue: "Window",
          })}: ${windowLabel}`}
        >
          <span
            className={`${OVERLAY_PANEL_CHIP_CLASS_NAME} whitespace-nowrap px-2.5`}
          >
            <span className="font-medium text-slate-500 dark:text-slate-400">
              {t("dashboard.charts.warMap.stats.window", {
                defaultValue: "Window",
              })}
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

function ViewSection({
  view,
  t,
}: Pick<WarMapControlsPanelProps, "view" | "t">) {
  return (
    <div className={OVERLAY_PANEL_STACK_CLASS_NAME}>
      <div className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}>
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.presets.title", {
            defaultValue: "Regions",
          })}
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
          {t("dashboard.charts.warMap.stats.window", {
            defaultValue: "Window",
          })}
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
    </div>
  );
}

function TransportSection({
  transport,
  legendSections,
  t,
}: Pick<WarMapControlsPanelProps, "transport" | "legendSections" | "t">) {
  const transportLegendItems =
    legendSections.find((section) => section.key === "transport")?.items ?? [];
  const aisReferenceItems = transportLegendItems
    .filter((item) => item.symbolKey.startsWith("ais-"))
    .slice(0, 4);
  const aisHighlightCandidatesHint = t(
    "dashboard.charts.warMap.overlay.aisHighlightCandidatesHint",
    {
      defaultValue:
        "Highlight rule-based government and military AIS candidates on top of the full vessel layer.",
    },
  );
  const aisCandidatesOnlyHint = t(
    "dashboard.charts.warMap.overlay.aisCandidatesOnlyHint",
    {
      defaultValue:
        "Candidate vessels shows a filtered subset based on AIS name and ship-type rules, not a complete vessel inventory.",
    },
  );
  const aisAllVesselsHint = t(
    "dashboard.charts.warMap.overlay.aisAllVesselsHint",
    {
      defaultValue:
        "All vessels shows the full AIS vessel snapshot for the current viewport.",
    },
  );
  const aisSectionDescription = t(
    transport.aisAllModeDisabled
      ? "dashboard.charts.warMap.overlay.aisSectionDescriptionUnavailable"
      : "dashboard.charts.warMap.overlay.aisSectionDescription",
    transport.aisAllModeDisabled
      ? {
          defaultValue:
            "Full-vessel AIS is temporarily unavailable from the relay snapshot. Use candidate or density views until vessel snapshots recover.",
        }
      : {
          defaultValue:
            "Start with the full vessel layer, then switch to filtered candidate or density views when you need narrower maritime signals.",
        },
  );
  const aisAllUnavailableInlineHint = t(
    "dashboard.charts.warMap.overlay.aisAllUnavailableInlineHint",
    {
      defaultValue:
        "All vessels is currently unavailable because relay vessel snapshots are missing.",
    },
  );
  const flightsSectionDescription = t(
    "dashboard.charts.warMap.overlay.flightsSectionDescription",
    {
      defaultValue:
        "Review OpenSky air traffic scope and switch between military-focused and broader flight coverage.",
    },
  );

  return (
    <div className={OVERLAY_PANEL_STACK_CLASS_NAME}>
      <div className={AIS_SECTION_CARD_CLASS_NAME}>
        <TransportSectionHeader
          eyebrow={t("dashboard.charts.warMap.overlay.maritimeEyebrow", {
            defaultValue: "Maritime",
          })}
          title={t("dashboard.charts.warMap.layerNames.ais", {
            defaultValue: "AIS traffic",
          })}
          description={aisSectionDescription}
        />
        {transport.aisLayerVisible ? (
          <>
            <div className={OVERLAY_PANEL_AIS_MODE_GRID_CLASS_NAME}>
              <ControlsChoiceButton
                active={transport.aisMode === "all"}
                disabled={transport.aisAllModeDisabled}
                tooltip={
                  transport.aisAllModeDisabled
                    ? transport.aisAllModeDisabledLabel
                    : aisAllVesselsHint
                }
                onClick={() => transport.onAisModeChange("all")}
              >
                {t("dashboard.charts.warMap.stats.aisModeAll", {
                  defaultValue: "All vessels",
                })}
              </ControlsChoiceButton>
              <ControlsChoiceButton
                active={transport.aisMode === "military"}
                tooltip={aisCandidatesOnlyHint}
                onClick={() => transport.onAisModeChange("military")}
              >
                {t("dashboard.charts.warMap.stats.aisModeMilitary", {
                  defaultValue: "Candidate vessels",
                })}
              </ControlsChoiceButton>
              <ControlsChoiceButton
                active={transport.aisMode === "density"}
                onClick={() => transport.onAisModeChange("density")}
              >
                {t("dashboard.charts.warMap.stats.aisModeDensity", {
                  defaultValue: "Density only",
                })}
              </ControlsChoiceButton>
            </div>
            {transport.aisAllModeDisabled ? (
              <div className={OVERLAY_PANEL_MODE_HINT_CLASS_NAME}>
                <Typography.Text className="block text-inherit">
                  {transport.aisAllModeDisabledLabel ??
                    aisAllUnavailableInlineHint}
                </Typography.Text>
              </div>
            ) : null}
            {transport.aisMode === "military" &&
            !transport.aisAllModeDisabled ? (
              <div className={OVERLAY_PANEL_MODE_HINT_CLASS_NAME}>
                <Typography.Text className="block text-inherit">
                  {t(
                    "dashboard.charts.warMap.overlay.aisCandidatesOnlyActiveHint",
                    {
                      defaultValue:
                        "Candidate vessels is a filtered subset. Some ships are intentionally hidden in this mode.",
                    },
                  )}
                </Typography.Text>
                {!transport.aisAllModeDisabled ? (
                  <Button
                    type="link"
                    size="small"
                    className={resolveOverlayButtonClassName({ tone: "link" })}
                    style={{ padding: 0, height: "auto", marginTop: 8 }}
                    onClick={() => transport.onAisModeChange("all")}
                  >
                    {t("dashboard.charts.warMap.overlay.aisShowAllAction", {
                      defaultValue: "Switch to All vessels",
                    })}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {transport.aisMode === "density" &&
            !transport.aisAllModeDisabled ? (
              <div className={OVERLAY_PANEL_MODE_HINT_CLASS_NAME}>
                <Typography.Text className="block text-inherit">
                  {t(
                    "dashboard.charts.warMap.overlay.aisDensityOnlyActiveHint",
                    {
                      defaultValue:
                        "Density only summarizes chokepoints and hotspots instead of showing individual ships.",
                    },
                  )}
                </Typography.Text>
                {!transport.aisAllModeDisabled ? (
                  <Button
                    type="link"
                    size="small"
                    className={resolveOverlayButtonClassName({ tone: "link" })}
                    style={{ padding: 0, height: "auto", marginTop: 8 }}
                    onClick={() => transport.onAisModeChange("all")}
                  >
                    {t("dashboard.charts.warMap.overlay.aisShowAllAction", {
                      defaultValue: "Switch to All vessels",
                    })}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {transport.aisMode === "all" ? (
              <div className="mt-3">
                <ControlsChoiceButton
                  active={transport.aisHighlightCandidates}
                  tooltip={aisHighlightCandidatesHint}
                  onClick={() =>
                    transport.onAisHighlightCandidatesChange(
                      !transport.aisHighlightCandidates,
                    )
                  }
                >
                  {t("dashboard.charts.warMap.stats.aisHighlightCandidates", {
                    defaultValue: "Highlight candidates",
                  })}
                </ControlsChoiceButton>
              </div>
            ) : null}
            <Space size={[8, 8]} wrap className="mt-3">
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
              {transport.aisStatusReason ? (
                <Tooltip title={transport.aisStatusReason}>
                  <Tag
                    color="volcano"
                    className={OVERLAY_STATUS_TAG_CLASS_NAME}
                  >
                    {t("dashboard.charts.warMap.stats.aisIssue", {
                      defaultValue: "Relay issue",
                    })}
                  </Tag>
                </Tooltip>
              ) : null}
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
              {transport.aisMode === "all" ? (
                <Tooltip title={aisHighlightCandidatesHint}>
                  <Tag
                    color={
                      transport.aisHighlightCandidates ? "orange" : "default"
                    }
                    className={
                      transport.aisHighlightCandidates
                        ? OVERLAY_STATUS_TAG_CLASS_NAME
                        : OVERLAY_NEUTRAL_TAG_CLASS_NAME
                    }
                  >
                    {transport.aisHighlightCandidates
                      ? t("dashboard.charts.warMap.stats.aisHighlightOn", {
                          defaultValue: "Candidates highlighted",
                        })
                      : t("dashboard.charts.warMap.stats.aisHighlightOff", {
                          defaultValue: "Candidates not highlighted",
                        })}
                  </Tag>
                </Tooltip>
              ) : null}
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
                      ? `${t(
                          "dashboard.charts.warMap.stats.aisSnapshotUpdated",
                          {
                            defaultValue: "AIS updated",
                          },
                        )}: ${transport.aisSnapshotExact}`
                      : undefined
                  }
                >
                  <Tag
                    color={
                      transport.aisFreshness === "stale" ? "gold" : "default"
                    }
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
                  <Tag
                    color="geekblue"
                    className={OVERLAY_STATUS_TAG_CLASS_NAME}
                  >
                    {transport.aisPrimaryCountLabel}:{" "}
                    {transport.aisPrimaryCountValue}
                  </Tag>
                </Tooltip>
              ) : null}
              {typeof transport.aisHighlightCountValue === "number" &&
              transport.aisHighlightCountLabel ? (
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
                    {transport.aisHighlightCountLabel}:{" "}
                    {transport.aisHighlightCountValue}
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
              {transport.aisEffectiveMode === "all" &&
              transport.aisAllModeDisabled ? (
                <Tooltip title={transport.aisAllModeDisabledLabel}>
                  <Tag
                    color="magenta"
                    className={OVERLAY_STATUS_TAG_CLASS_NAME}
                  >
                    {t("dashboard.charts.warMap.stats.aisAllUnavailable", {
                      defaultValue: "All vessels unavailable",
                    })}
                  </Tag>
                </Tooltip>
              ) : null}
              {transport.aisViewportEmptyStateActive &&
              transport.aisViewportEmptyStateLabel ? (
                <Tag color="gold" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {transport.aisViewportEmptyStateLabel}
                </Tag>
              ) : null}
            </Space>
            {transport.aisViewportEmptyStateActive &&
            transport.aisViewportEmptyStateHint ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {transport.aisViewportEmptyStateHint}
              </p>
            ) : null}
          </>
        ) : (
          <Typography.Text type="secondary" className="text-xs">
            {t("dashboard.charts.warMap.overlay.aisStatusHint", {
              defaultValue:
                "Enable the AIS layer to inspect vessel source, freshness, and disruption signals.",
            })}
          </Typography.Text>
        )}
        <AisReferenceSection
          items={aisReferenceItems}
          onOpenLegend={transport.onOpenLegend}
          t={t}
        />
      </div>
      <div className={FLIGHTS_SECTION_CARD_CLASS_NAME}>
        <TransportSectionHeader
          eyebrow={t("dashboard.charts.warMap.overlay.airEyebrow", {
            defaultValue: "Air",
          })}
          title={t("dashboard.charts.warMap.overlay.flights", {
            defaultValue: "Flights",
          })}
          description={flightsSectionDescription}
        />
        <div className={OVERLAY_PANEL_OPTION_GRID_CLASS_NAME}>
          <ControlsChoiceButton
            active={transport.flightMode === "military"}
            onClick={() => transport.onFlightModeChange("military")}
          >
            {t("dashboard.charts.warMap.stats.flightModeMilitary", {
              defaultValue: "Military focus",
            })}
          </ControlsChoiceButton>
          <ControlsChoiceButton
            active={transport.flightMode === "all"}
            onClick={() => transport.onFlightModeChange("all")}
          >
            {t("dashboard.charts.warMap.stats.flightModeAll", {
              defaultValue: "All flights",
            })}
          </ControlsChoiceButton>
        </div>
        <Space size={[8, 8]} wrap className="mt-3">
          {transport.flightsLayerVisible &&
          transport.flightsSourceBadgeLabel ? (
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
                {transport.flightsRawLabel
                  ? ` ${transport.flightsRawLabel}`
                  : ""}
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
      <Button
        type="primary"
        className="!h-11 !rounded-[16px] !px-4 !text-[13px] !font-semibold"
        loading={transport.analyzingCurrentView}
        disabled={!transport.canAnalyzeCurrentView}
        onClick={transport.onAnalyzeCurrentView}
      >
        {t("dashboard.charts.warMap.actions.analyzeCurrentView", {
          defaultValue: "Analyze current view",
        })}
      </Button>
    </div>
  );
}

function AisReferenceSection({
  items,
  onOpenLegend,
  t,
}: {
  items: WarMapLegendItem[];
  onOpenLegend: () => void;
  t: WarMapTranslateFn;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4 dark:bg-slate-950/55">
      <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
        {t("dashboard.charts.warMap.legend.aisTitle", {
          defaultValue: "AIS",
        })}
      </Typography.Text>
      <Typography.Text type="secondary" className="mt-2 block text-xs">
        {t("dashboard.charts.warMap.overlay.transportLegendHint", {
          defaultValue:
            "Need symbol meanings? Use the AIS reference before changing modes.",
        })}
      </Typography.Text>
      <LegendItemsGrid items={items} compact />
      <Button
        type="link"
        size="small"
        className={resolveOverlayButtonClassName({ tone: "link" })}
        style={{ padding: 0, height: "auto" }}
        onClick={onOpenLegend}
      >
        {t("dashboard.charts.warMap.overlay.openFullLegend", {
          defaultValue: "Open full legend",
        })}
      </Button>
    </div>
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
    <div className="flex w-full flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
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
    </div>
  );
}

function LegendSection({
  legendSections,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: Pick<WarMapControlsPanelProps, "legendSections" | "t"> & {
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
        {t("dashboard.charts.warMap.legend.title", {
          defaultValue: "Legend",
        })}
      </Typography.Text>
      <LegendSectionsList
        legendSections={legendSections}
        activeLegendKey={activeLegendKey}
        highlightedLegendKey={highlightedLegendKey}
        onLegendItemHover={onLegendItemHover}
        onLegendItemFocus={onLegendItemFocus}
      />
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-white/70 px-3 py-3 dark:bg-slate-950/55">
        <Typography.Text type="secondary" className="text-xs">
          {t("dashboard.charts.warMap.legend.radius", {
            defaultValue:
              "Larger points indicate stronger aggregated signal density.",
          })}
        </Typography.Text>
      </div>
    </div>
  );
}

export function WarMapLegendPanel({
  legendSections,
  summaryDataLabel,
  onClose,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: WarMapLegendPanelProps) {
  return (
    <div className="flex h-full min-h-0 max-h-full flex-col">
      <div className="border-b border-[var(--border)] bg-gradient-to-b from-white to-slate-50/90 px-4 py-3.5 dark:from-slate-950/90 dark:to-slate-900/86">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Typography.Text
              strong
              className="block text-base text-slate-900 dark:text-slate-100"
            >
              {t("dashboard.charts.warMap.legend.title", {
                defaultValue: "Legend",
              })}
            </Typography.Text>
            <Typography.Text
              type="secondary"
              className="mt-1 block text-[12px] leading-5"
            >
              {t("dashboard.charts.warMap.legend.quickLegendHint", {
                defaultValue:
                  "Hover to preview a symbol family. Click to pin focus on the map.",
              })}
            </Typography.Text>
          </div>
          {onClose ? (
            <Button
              type="default"
              aria-label={t("common.close", { defaultValue: "Close" })}
              className={resolveOverlayButtonClassName({
                tone: "neutral",
                iconOnly: true,
                extraClassName: "!h-10 !min-w-10 !rounded-full",
              })}
              icon={<CloseOutlined />}
              onClick={onClose}
            />
          ) : null}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          {summaryDataLabel ? (
            <span className="truncate">{summaryDataLabel}</span>
          ) : null}
          <span>
            {t("dashboard.charts.warMap.legend.previewHint", {
              defaultValue: "Hover previews, click pins focus.",
            })}
          </span>
          {activeLegendKey ? (
            <Button
              type="link"
              size="small"
              className={resolveOverlayButtonClassName({ tone: "link" })}
              style={{ padding: 0, height: "auto", fontSize: 11 }}
              onClick={() => onLegendItemFocus?.(null)}
            >
              {t("dashboard.charts.warMap.legend.clearFocus", {
                defaultValue: "Clear focus",
              })}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3.5">
        <LegendSectionsList
          legendSections={legendSections}
          activeLegendKey={activeLegendKey}
          highlightedLegendKey={highlightedLegendKey}
          onLegendItemHover={onLegendItemHover}
          onLegendItemFocus={onLegendItemFocus}
        />
      </div>
    </div>
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
  legendSections,
  view,
  transport,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  onControlsSectionChange,
  onClose,
  t,
}: WarMapControlsPanelProps) {
  const activeControlsSection = resolveActiveControlsSection(controlsSection);
  const activeControlsSectionMeta = controlsSectionMeta[activeControlsSection];
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const showCloseButton = useDrawerControls && typeof onClose === "function";

  useEffect(() => {
    const headerNode = headerRef.current;
    if (!headerNode) {
      return;
    }

    let frameId: number | null = null;
    const updateHeight = () => {
      const nextHeight = Math.ceil(headerNode.getBoundingClientRect().height);
      setHeaderHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };
    const measure = () => {
      if (
        typeof window !== "undefined" &&
        typeof window.requestAnimationFrame === "function"
      ) {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        frameId = window.requestAnimationFrame(updateHeight);
        return;
      }

      updateHeight();
    };

    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        measure();
      });
      observer.observe(headerNode);

      return () => {
        if (
          frameId !== null &&
          typeof window !== "undefined" &&
          typeof window.cancelAnimationFrame === "function"
        ) {
          window.cancelAnimationFrame(frameId);
        }
        observer.disconnect();
      };
    }

    window.addEventListener("resize", measure);

    return () => {
      if (
        frameId !== null &&
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", measure);
    };
  }, [
    activeControlsSection,
    controlsTabs,
    overviewDataTagLabel,
    overviewMetricCards,
    summaryDataLabel,
    summaryStatusCards,
    windowLabel,
  ]);

  let controlsSectionContent: ReactNode;
  switch (activeControlsSection) {
    case "view":
      controlsSectionContent = <ViewSection view={view} t={t} />;
      break;
    case "transport":
      controlsSectionContent = (
        <TransportSection
          transport={transport}
          legendSections={legendSections}
          t={t}
        />
      );
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
      controlsSectionContent = (
        <LegendSection
          legendSections={legendSections}
          activeLegendKey={activeLegendKey}
          highlightedLegendKey={highlightedLegendKey}
          onLegendItemHover={onLegendItemHover}
          onLegendItemFocus={onLegendItemFocus}
          t={t}
        />
      );
      break;
    default:
      controlsSectionContent = <ViewSection view={view} t={t} />;
      break;
  }
  const controlsBodyMaxHeight =
    !useDrawerControls && headerHeight > 0
      ? Math.max(112, overlayPanelMaxHeight - headerHeight)
      : undefined;

  return (
    <div className="flex h-full min-h-0 max-h-full flex-col">
      <div
        ref={headerRef}
        className="border-b border-[var(--border)] bg-gradient-to-b from-white to-slate-50/90 px-4 py-3 dark:from-slate-950/90 dark:to-slate-900/90"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Typography.Text
              strong
              className="block text-base text-slate-900 dark:text-slate-100"
            >
              {activeControlsSectionMeta.label}
            </Typography.Text>
            {activeControlsSection === "view" ? (
              <Typography.Text
                type="secondary"
                className="mt-1 block text-[13px] leading-5"
              >
                {activeControlsSectionMeta.description}
              </Typography.Text>
            ) : null}
          </div>
          {showCloseButton ? (
            <Button
              type="default"
              aria-label={t("common.close", { defaultValue: "Close" })}
              className={resolveOverlayButtonClassName({
                tone: "neutral",
                iconOnly: true,
                extraClassName: "!h-10 !min-w-10 !rounded-full",
              })}
              icon={<CloseOutlined />}
              onClick={onClose}
            />
          ) : null}
        </div>
        {activeControlsSection === "view" ? (
          <ControlsHeaderSummary
            overviewMetricCards={overviewMetricCards}
            summaryStatusCards={summaryStatusCards}
            summaryDataLabel={summaryDataLabel}
            overviewDataTagLabel={overviewDataTagLabel}
            windowLabel={windowLabel}
            t={t}
          />
        ) : null}
        <div
          className={`rounded-[20px] border border-[var(--border)] bg-white/55 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:bg-slate-950/55 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${OVERLAY_PANEL_TAB_GRID_CLASS_NAME}`}
        >
          {controlsTabs.map((tab) => {
            const isActive = activeControlsSection === tab.key;
            const button = (
              <ControlsChoiceButton
                active={isActive}
                align="center"
                onClick={() => onControlsSectionChange(tab.key)}
              >
                {renderControlsTabLabel(tab, isActive)}
              </ControlsChoiceButton>
            );

            if (tab.attentionTooltip) {
              return (
                <Tooltip key={tab.key} title={tab.attentionTooltip}>
                  {button}
                </Tooltip>
              );
            }

            return <span key={tab.key}>{button}</span>;
          })}
        </div>
      </div>
      <div
        className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4"
        style={
          controlsBodyMaxHeight
            ? { maxHeight: controlsBodyMaxHeight }
            : undefined
        }
      >
        {controlsSectionContent}
      </div>
    </div>
  );
}
