import type { TFunction } from "i18next";
import type { Layout } from "react-grid-layout";

import type { SituationMonitorPanelId } from "@/store/situation-monitor-layout";

import type {
  SituationMonitorCategory,
  SituationMonitorExternalSnapshotCategoryState,
  SituationMonitorInsightsResponse,
  SituationMonitorWarning,
} from "../types/situation-monitor-content";

export const SITUATION_MONITOR_INTERACTIVE_SELECTOR = "[data-sm-interactive]";

export function stopSituationMonitorInteractiveEvent(event: {
  stopPropagation: () => void;
}) {
  event.stopPropagation();
}

export function mergeTranslationStatus(
  base: SituationMonitorInsightsResponse["translation"],
  next: SituationMonitorInsightsResponse["translation"],
): SituationMonitorInsightsResponse["translation"] {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }
  if (base.target !== next.target) {
    return base;
  }
  if (base.applied && next.applied) {
    return base;
  }
  const error = [base.error, next.error].filter(Boolean).join(" | ");
  return {
    target: base.target,
    applied: false,
    ...(error ? { error } : {}),
  };
}

export function getHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("response" in error)) {
    return null;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === "number" ? response.status : null;
}

export function toAlertType(
  severity: SituationMonitorWarning["severity"],
): "info" | "warning" | "error" {
  if (severity === "error") {
    return "error";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "info";
}

export function getExternalSnapshotStatusColor(
  status: NonNullable<
    SituationMonitorInsightsResponse["externalSnapshot"]
  >["status"],
): string {
  if (status === "completed") {
    return "green";
  }
  if (status === "partial") {
    return "gold";
  }
  if (status === "failed") {
    return "red";
  }
  return "default";
}

export function getExternalSnapshotCategoryStatusColor(
  status: SituationMonitorExternalSnapshotCategoryState["status"],
): string {
  if (status === "fresh") {
    return "green";
  }
  if (status === "reused") {
    return "gold";
  }
  return "default";
}

export function getWindowPresetKey(
  hours: number,
): "6h" | "24h" | "72h" | "168h" | null {
  if (hours === 168) {
    return "168h";
  }
  if (hours === 72) {
    return "72h";
  }
  if (hours === 24) {
    return "24h";
  }
  if (hours === 6) {
    return "6h";
  }
  return null;
}

export function getCoverageModeColor(
  mode: NonNullable<
    SituationMonitorInsightsResponse["coverageSummary"]
  >["mode"],
): string {
  if (mode === "internal+external") {
    return "green";
  }
  if (mode === "internal-only") {
    return "blue";
  }
  if (mode === "external-only") {
    return "purple";
  }
  return "default";
}

export function extractWarningCategories(
  warning: SituationMonitorWarning | undefined,
): string[] {
  if (!warning?.detail) {
    return [];
  }
  const match = warning.detail.match(/Categories:\s*([^.]+)/i);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function toTagColor(level: string) {
  switch (level.toLowerCase()) {
    case "high":
      return "red";
    case "elevated":
      return "orange";
    case "emerging":
      return "blue";
    default:
      return "default";
  }
}

export function toCredibilityColor(level: string) {
  switch (level.toLowerCase()) {
    case "high":
      return "green";
    case "medium":
      return "orange";
    case "low":
      return "red";
    default:
      return "default";
  }
}

export function formatUsd(value: number, locale: string) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (Math.abs(value) >= 1_000_000_000) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  }
  if (Math.abs(value) >= 1_000_000) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatDurationMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function mergePanelLayouts(existing: Layout[], updates: Layout[]): Layout[] {
  const updatesById = new Map(updates.map((item) => [item.i, item]));
  const merged = existing.map((item) => {
    const update = updatesById.get(item.i);
    if (!update) {
      return item;
    }
    updatesById.delete(item.i);
    return {
      ...item,
      ...update,
      i: item.i,
      static: item.static ?? update.static,
    };
  });

  for (const update of updatesById.values()) {
    merged.push(update);
  }

  return merged;
}

export function filterVisibleLayoutItems(
  layout: Layout[],
  visibility: Record<SituationMonitorPanelId, boolean>,
): Layout[] {
  return layout.filter((item) => visibility[item.i as SituationMonitorPanelId]);
}

function spansOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return startA < endB && startB < endA;
}

export function stretchCorrelationToMonitorArea(layout: Layout[]): Layout[] {
  const correlation = layout.find((item) => item.i === "correlation");
  const monitors = layout.find((item) => item.i === "monitors");
  if (!correlation || !monitors) {
    return layout;
  }

  const correlationX = typeof correlation.x === "number" ? correlation.x : 0;
  const correlationY = typeof correlation.y === "number" ? correlation.y : 0;
  const correlationW = typeof correlation.w === "number" ? correlation.w : 0;
  const correlationH = typeof correlation.h === "number" ? correlation.h : 0;

  const monitorsX = typeof monitors.x === "number" ? monitors.x : 0;
  const monitorsY = typeof monitors.y === "number" ? monitors.y : 0;
  const monitorsW = typeof monitors.w === "number" ? monitors.w : 0;

  if (
    !spansOverlap(
      correlationX,
      correlationX + correlationW,
      monitorsX,
      monitorsX + monitorsW,
    )
  ) {
    return layout;
  }
  if (monitorsY <= correlationY) {
    return layout;
  }

  let boundaryY = monitorsY;
  for (const item of layout) {
    if (item.i === "correlation" || item.i === "monitors") {
      continue;
    }
    const x = typeof item.x === "number" ? item.x : 0;
    const y = typeof item.y === "number" ? item.y : 0;
    const w = typeof item.w === "number" ? item.w : 0;
    if (y <= correlationY) {
      continue;
    }
    if (!spansOverlap(correlationX, correlationX + correlationW, x, x + w)) {
      continue;
    }
    boundaryY = Math.min(boundaryY, y);
  }

  const desiredHeight = Math.max(1, boundaryY - correlationY);
  if (!Number.isFinite(desiredHeight) || desiredHeight <= correlationH) {
    return layout;
  }

  return layout.map((item) =>
    item.i === "correlation" ? { ...item, h: desiredHeight } : item,
  );
}

export function isVisibilityMatchingPreset(
  visibility: Record<SituationMonitorPanelId, boolean>,
  panels: SituationMonitorPanelId[],
): boolean {
  const enabled = new Set<SituationMonitorPanelId>(panels);
  for (const [key, value] of Object.entries(visibility)) {
    const id = key as SituationMonitorPanelId;
    if (value !== enabled.has(id)) {
      return false;
    }
  }
  return true;
}


export function formatWindowOptionLabel(
  hours: number,
  t: TFunction,
  locale: string,
): string {
  const presetKey = getWindowPresetKey(hours);
  if (presetKey) {
    return t(`situationMonitor.window.${presetKey}`, {
      defaultValue:
        presetKey === "168h"
          ? "Last 7d"
          : presetKey === "72h"
            ? "Last 72h"
            : presetKey === "24h"
              ? "Last 24h"
              : "Last 6h",
    });
  }
  return locale === "zh-CN" ? `近${hours}小时` : `${hours}h`;
}

export function formatWindowCompactLabel(
  hours: number,
  t: TFunction,
  locale: string,
): string {
  const presetKey = getWindowPresetKey(hours);
  if (presetKey) {
    return t(`situationMonitor.windowCompact.${presetKey}`, {
      defaultValue:
        presetKey === "168h"
          ? "7D"
          : presetKey === "72h"
            ? "72H"
            : presetKey === "24h"
              ? "24H"
              : "6H",
    });
  }
  return locale === "zh-CN" ? `${hours}小时` : `${hours}H`;
}

export function getScopeBadgeLabel(
  value: "tagged" | "all",
  t: TFunction,
): string {
  return t(`situationMonitor.scopeBadge.${value}`, {
    defaultValue: value === "tagged" ? "TAGGED" : "ALL",
  });
}

export function getCoverageModeLabel(
  mode: NonNullable<
    SituationMonitorInsightsResponse["coverageSummary"]
  >["mode"],
  t: TFunction,
): string {
  return t(`situationMonitor.coverage.mode.${mode}`, {
    defaultValue:
      mode === "internal+external"
        ? "INT + EXT"
        : mode === "internal-only"
          ? "INT ONLY"
          : mode === "external-only"
            ? "EXT ONLY"
            : "EMPTY",
  });
}

export function getExternalSnapshotStatusLabel(
  value: NonNullable<
    SituationMonitorInsightsResponse["externalSnapshot"]
  >["status"],
  t: TFunction,
): string {
  return t(`situationMonitor.snapshot.status.${value}`, {
    defaultValue: value.toUpperCase(),
  });
}

export function getFedMoneyPrinterLabel(
  enabled: boolean,
  t: TFunction,
): string {
  return t(`situationMonitor.fed.moneyPrinter.${enabled ? "on" : "off"}`, {
    defaultValue: enabled ? "PRINTER ON" : "PRINTER OFF",
  });
}

export function getSituationMonitorCategoryLabels(
  t: TFunction,
): Record<SituationMonitorCategory, string> {
  return {
    politics: t("situationMonitor.categories.politics"),
    tech: t("situationMonitor.categories.tech"),
    finance: t("situationMonitor.categories.finance"),
    gov: t("situationMonitor.categories.gov"),
    ai: t("situationMonitor.categories.ai"),
    intel: t("situationMonitor.categories.intel"),
  };
}
