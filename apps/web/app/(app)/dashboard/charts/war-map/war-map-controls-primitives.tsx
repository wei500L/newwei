"use client";

import {
  DatabaseOutlined,
  FundOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { Button, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";

import {
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  resolveOverlayButtonClassName,
  type WarMapOverviewMetricCard,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";

/**
 * Controls 面板展示原语（FE-批4B：自 war-map-controls-panel.tsx 拆出）：
 * 选择按钮、区块标题、布局 class 常量与指标卡图标。
 */

export const OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME =
  "rounded-2xl border border-[var(--border)] bg-slate-50/80 px-4 py-4 shadow-[0_10px_24px_-22px_rgba(15,23,42,0.16)] dark:bg-slate-900/70 dark:shadow-[0_16px_34px_-26px_rgba(2,6,23,0.66)]";
export const OVERLAY_PANEL_CHIP_CLASS_NAME =
  "inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/[0.88] px-3 py-1.5 text-[12px] text-slate-700 shadow-[0_8px_18px_-18px_rgba(15,23,42,0.26)] transition-[border-color,background-color,color,box-shadow] duration-200 hover:border-slate-300/[0.85] hover:bg-white hover:text-slate-900 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-200 dark:shadow-[0_10px_20px_-18px_rgba(2,6,23,0.7)] dark:hover:border-slate-500/80 dark:hover:bg-slate-900 dark:hover:text-slate-50";
export const OVERLAY_PANEL_STACK_CLASS_NAME = "flex w-full flex-col gap-4";
export const OVERLAY_PANEL_OPTION_GRID_CLASS_NAME = "mt-3 grid gap-3 sm:grid-cols-2";
export const OVERLAY_PANEL_AIS_MODE_GRID_CLASS_NAME = "mt-3 grid gap-2 sm:grid-cols-3";
export const OVERLAY_PANEL_TAB_GRID_CLASS_NAME =
  "mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3";
export const OVERLAY_PANEL_STANDALONE_SPLIT_GRID_CLASS_NAME =
  "grid gap-4 xl:grid-cols-2";
export const OVERLAY_PANEL_OPTION_BUTTON_CLASS_NAME =
  "!h-auto !min-h-10 !w-full !justify-start !rounded-[16px] !px-3.5 !py-2.5 !text-left !text-xs !font-semibold !leading-5";
export const OVERLAY_PANEL_TAB_BUTTON_CLASS_NAME =
  "!h-auto !min-h-[3rem] !w-full !justify-center !rounded-[18px] !px-3.5 !py-2.5 !text-center !text-xs !font-semibold !leading-5";
export const AIS_SECTION_CARD_CLASS_NAME = `${OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME} border-cyan-200/70 bg-cyan-50/55 dark:border-cyan-400/25 dark:bg-cyan-950/12`;
export const FLIGHTS_SECTION_CARD_CLASS_NAME = `${OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME} border-indigo-200/70 bg-indigo-50/45 dark:border-indigo-400/25 dark:bg-indigo-950/12`;
export const OVERLAY_PANEL_MODE_HINT_CLASS_NAME =
  "mt-3 rounded-2xl border border-amber-200/80 bg-amber-50/85 px-3.5 py-3 text-xs leading-5 text-amber-900 shadow-[0_12px_28px_-24px_rgba(180,83,9,0.45)] dark:border-amber-400/30 dark:bg-amber-950/25 dark:text-amber-100";

export function ControlsChoiceButton({
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

export function TransportSectionHeader({
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

export function renderOverviewCardIcon(key: WarMapOverviewMetricCard["key"]) {
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

export function getSummaryMetricLabel(
  card: WarMapOverviewMetricCard,
  t: WarMapTranslateFn,
): string {
  if (card.key === "layers") {
    return t("dashboard.charts.warMap.layers");
  }

  return card.label;
}

export function getSummaryMetricDetail(
  card: WarMapOverviewMetricCard,
  t: WarMapTranslateFn,
): string {
  switch (card.key) {
    case "signals":
      return t("dashboard.charts.warMap.overlay.signalDensityShort");
    case "news":
      return t("dashboard.charts.warMap.overlay.newsCoverageShort");
    case "monitors":
      return t("dashboard.charts.warMap.overlay.monitorCoverageShort");
    case "layers":
    default:
      return t("dashboard.charts.warMap.overlay.layerCoverageShort");
  }
}

export function renderControlsTabLabel(
  tab: {
    label: string;
    attentionLabel?: string;
    attentionTone?: "warning" | "critical";
  },
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
