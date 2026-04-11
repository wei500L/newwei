"use client";

import type { WarMapAisMode } from "@modular/utils";
import type { ReactNode } from "react";

import type {
  OverlayDensity,
  WarMapTranslateFn,
} from "./war-map-overlay-model";

export type WarMapSymbolState = "default" | "hover" | "selected" | "cluster";

export type WarMapSymbolKey =
  | "signal-high"
  | "signal-medium"
  | "signal-low"
  | "news-geocoded"
  | "news-fallback"
  | "monitor"
  | "flight"
  | "ais-vessel-military"
  | "ais-vessel-fishing"
  | "ais-vessel-passenger"
  | "ais-vessel-cargo"
  | "ais-vessel-tanker"
  | "ais-vessel-other"
  | "ais-vessel-generic"
  | "ais-density"
  | "ais-disruption-high"
  | "ais-disruption-medium"
  | "ais-disruption-low"
  | "generic-point";

export interface WarMapLegendItem {
  key: string;
  symbolKey: WarMapSymbolKey;
  label: string;
  note?: string;
  state?: WarMapSymbolState;
  accentColor?: string;
  countLabel?: string;
  matchSymbolKeys?: WarMapSymbolKey[];
  matchLayerIds?: string[];
}

export interface WarMapLegendSection {
  key: string;
  title: string;
  description?: string;
  defaultExpanded?: boolean;
  items: WarMapLegendItem[];
}

export interface WarMapActivePointLayerLegendItem {
  key: string;
  label: string;
  accentColor?: string;
}

export interface WarMapLegendMatchablePoint {
  symbolKey: WarMapSymbolKey;
  layerId?: string;
}

interface SymbolPalette {
  accent: string;
  family:
    | "signal"
    | "news"
    | "monitor"
    | "flight"
    | "vessel"
    | "density"
    | "warning"
    | "generic";
}

interface DeckIconDefinition {
  url: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  mask: false;
}

type WarMapSymbolRenderTarget = "map" | "legend";

const SYMBOL_GRID_SIZE = 24;
const SYMBOL_ICON_SIZE = 48;
const SYMBOL_ICON_ANCHOR = SYMBOL_ICON_SIZE / 2;
const NEUTRAL_DARK = "#0f172a";
const WHITE = "#ffffff";
const QUICK_LEGEND_DENSITIES = new Set<OverlayDensity>(["expanded", "compact"]);

const symbolIconCache = new Map<string, DeckIconDefinition>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function parseHexColor(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return [
      Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+\s*)?\)$/i,
  );
  if (!rgbMatch) {
    return null;
  }

  return [
    clamp(Number.parseInt(rgbMatch[1] ?? "0", 10), 0, 255),
    clamp(Number.parseInt(rgbMatch[2] ?? "0", 10), 0, 255),
    clamp(Number.parseInt(rgbMatch[3] ?? "0", 10), 0, 255),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((value) =>
      clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"),
    )
    .join("")}`;
}

function mixHex(base: string, target: string, ratio: number): string {
  const baseRgb = parseHexColor(base) ?? [59, 130, 246];
  const targetRgb = parseHexColor(target) ?? [255, 255, 255];
  const progress = clamp(ratio, 0, 1);
  return rgbToHex([
    Math.round(baseRgb[0] + (targetRgb[0] - baseRgb[0]) * progress),
    Math.round(baseRgb[1] + (targetRgb[1] - baseRgb[1]) * progress),
    Math.round(baseRgb[2] + (targetRgb[2] - baseRgb[2]) * progress),
  ]);
}

function withAlpha(color: string, alpha: number): string {
  const rgb = parseHexColor(color) ?? [59, 130, 246];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1)})`;
}

export function coerceHexColor(
  value: string | undefined,
  fallback = "#3b82f6",
): string {
  if (!value) {
    return fallback;
  }
  const parsed = parseHexColor(value);
  return parsed ? rgbToHex(parsed) : fallback;
}

function svgOpenTag(target: WarMapSymbolRenderTarget): string {
  const size = target === "map" ? SYMBOL_ICON_SIZE : SYMBOL_GRID_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${SYMBOL_GRID_SIZE} ${SYMBOL_GRID_SIZE}" fill="none">`;
}

function strokeAttrs(width: number, color: string): string {
  return `stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
}

function mapStrokePath(path: string, stroke: string, width: number): string {
  return [
    `<path d="${path}" ${strokeAttrs(width + 1.15, WHITE)} opacity="0.94" />`,
    `<path d="${path}" ${strokeAttrs(width, stroke)} />`,
  ].join("");
}

function mapStrokeCircle(radius: number, stroke: string, width: number): string {
  return [
    `<circle cx="12" cy="12" r="${radius}" ${strokeAttrs(width + 1.15, WHITE)} opacity="0.94" />`,
    `<circle cx="12" cy="12" r="${radius}" ${strokeAttrs(width, stroke)} />`,
  ].join("");
}

function buildStateMarkup(
  state: WarMapSymbolState,
  target: WarMapSymbolRenderTarget,
): string {
  if (target !== "legend") {
    return "";
  }
  if (state === "hover") {
    return `<circle cx="12" cy="12" r="10.2" ${strokeAttrs(1.5, withAlpha(NEUTRAL_DARK, 0.18))} />`;
  }
  if (state === "selected") {
    return `<circle cx="12" cy="12" r="10.2" ${strokeAttrs(2, withAlpha(NEUTRAL_DARK, 0.32))} />`;
  }
  return "";
}

function buildClusterBubble(accent: string, target: WarMapSymbolRenderTarget): string {
  const arcPath = "M6.4 8.35a6.8 6.8 0 0 1 11.2 0";
  return [
    `<circle cx="12" cy="12" r="8.05" fill="${mixHex(accent, WHITE, 0.94)}" ${strokeAttrs(1.2, withAlpha(NEUTRAL_DARK, 0.14))} />`,
    target === "map"
      ? `<circle cx="12" cy="12" r="8.05" ${strokeAttrs(2.2, WHITE)} opacity="0.9" />`
      : "",
    `<path d="${arcPath}" ${strokeAttrs(2.15, accent)} />`,
    `<circle cx="12" cy="12" r="3.35" fill="${withAlpha(accent, 0.12)}" />`,
  ].join("");
}

function buildRingDotSymbol({
  accent,
  centerRadius,
  outerRing,
  target,
  hollowCenter = false,
  monitorTicks = false,
}: {
  accent: string;
  centerRadius: number;
  outerRing?: boolean;
  target: WarMapSymbolRenderTarget;
  hollowCenter?: boolean;
  monitorTicks?: boolean;
}): string {
  const primaryRing =
    target === "map"
      ? mapStrokeCircle(6.15, accent, 1.75)
      : `<circle cx="12" cy="12" r="6.15" fill="${WHITE}" ${strokeAttrs(1.75, accent)} />`;
  const outerRingMarkup = outerRing
    ? `<circle cx="12" cy="12" r="8.55" ${strokeAttrs(1.1, withAlpha(accent, 0.28))} />`
    : "";
  const center = hollowCenter
    ? `<circle cx="12" cy="12" r="${centerRadius}" fill="${WHITE}" ${strokeAttrs(1.35, accent)} />`
    : `<circle cx="12" cy="12" r="${centerRadius}" fill="${accent}" />`;
  const ticks = monitorTicks
    ? [
        `<path d="M12 2.8v2.2" ${strokeAttrs(1.4, accent)} />`,
        `<path d="M21.2 12H19" ${strokeAttrs(1.4, accent)} />`,
        `<path d="M12 21.2V19" ${strokeAttrs(1.4, accent)} />`,
        `<path d="M2.8 12H5" ${strokeAttrs(1.4, accent)} />`,
      ].join("")
    : "";

  return [outerRingMarkup, primaryRing, center, ticks].join("");
}

function buildTransportGlyph({
  accent,
  path,
  target,
}: {
  accent: string;
  path: string;
  target: WarMapSymbolRenderTarget;
}): string {
  return target === "map"
    ? mapStrokePath(path, accent, 1.9)
    : `<path d="${path}" ${strokeAttrs(1.9, accent)} />`;
}

function buildDensitySymbol(accent: string, target: WarMapSymbolRenderTarget): string {
  const accentSoft = withAlpha(accent, target === "map" ? 0.18 : 0.12);
  return [
    `<circle cx="12" cy="12" r="8.6" fill="${accentSoft}" />`,
    `<circle cx="12" cy="12" r="5.9" fill="${withAlpha(accent, target === "map" ? 0.14 : 0.1)}" />`,
    target === "map"
      ? mapStrokeCircle(5.4, accent, 1.35)
      : `<circle cx="12" cy="12" r="5.4" ${strokeAttrs(1.35, accent)} />`,
    `<circle cx="12" cy="12" r="1.95" fill="${accent}" />`,
  ].join("");
}

function buildWarningSymbol({
  accent,
  target,
  severity,
}: {
  accent: string;
  target: WarMapSymbolRenderTarget;
  severity: "high" | "medium" | "low";
}): string {
  const trianglePath = "M12 4.5 19 17.4H5Z";
  const fillOpacity = severity === "high" ? 0.18 : severity === "medium" ? 0.12 : 0.08;
  const triangle =
    target === "map"
      ? [
          `<path d="${trianglePath}" fill="${withAlpha(accent, fillOpacity)}" ${strokeAttrs(2.2, WHITE)} opacity="0.9" />`,
          `<path d="${trianglePath}" fill="${withAlpha(accent, fillOpacity)}" ${strokeAttrs(1.55, accent)} />`,
        ].join("")
      : `<path d="${trianglePath}" fill="${withAlpha(accent, fillOpacity)}" ${strokeAttrs(1.55, accent)} />`;

  return [
    triangle,
    `<path d="M12 8.6v4.9" ${strokeAttrs(1.7, accent)} />`,
    `<circle cx="12" cy="15.9" r="0.9" fill="${accent}" />`,
  ].join("");
}

function buildSymbolBody({
  family,
  accent,
  state,
  symbolKey,
  target,
}: SymbolPalette & {
  state: WarMapSymbolState;
  symbolKey: WarMapSymbolKey;
  target: WarMapSymbolRenderTarget;
}): string {
  if (state === "cluster") {
    return buildClusterBubble(accent, target);
  }

  switch (family) {
    case "signal":
      return buildRingDotSymbol({
        accent,
        centerRadius:
          symbolKey === "signal-high"
            ? 2.45
            : symbolKey === "signal-medium"
              ? 2.1
              : 1.75,
        outerRing: symbolKey !== "signal-low",
        target,
      });
    case "news":
      return buildRingDotSymbol({
        accent,
        centerRadius: symbolKey === "news-fallback" ? 1.9 : 2.15,
        hollowCenter: symbolKey === "news-fallback",
        target,
      });
    case "monitor":
      return buildRingDotSymbol({
        accent,
        centerRadius: 2.05,
        target,
        monitorTicks: true,
      });
    case "flight":
      return buildTransportGlyph({
        accent,
        target,
        path:
          "M12 3.9 13.95 9.1l5.05 1.1v1.5l-5.05-.1.95 5.95-1.15.66L12 13.85l-1.75 4.36-1.15-.66.95-5.95-5.05.1v-1.5l5.05-1.1L12 3.9Z",
      });
    case "vessel":
      return buildTransportGlyph({
        accent,
        target,
        path:
          "M12 5.1 14.25 8.2h-1.6v2.2h4.3l1.45 3.1-2.4 4.45H8.02l-2.4-4.45 1.45-3.1h4.28V8.2H9.8L12 5.1Zm-2.85 7.15-.98 2h5.66l-.98-2H9.15Zm.95 3.45.8 1.22h2.2l.8-1.22h-3.8Z",
      });
    case "density":
      return buildDensitySymbol(accent, target);
    case "warning":
      return buildWarningSymbol({
        accent,
        target,
        severity:
          symbolKey === "ais-disruption-high"
            ? "high"
            : symbolKey === "ais-disruption-medium"
              ? "medium"
              : "low",
      });
    case "generic":
    default:
      return buildRingDotSymbol({
        accent,
        centerRadius: 1.8,
        target,
      });
  }
}

function buildSymbolSvg({
  accent,
  family,
  state,
  symbolKey,
  target,
}: SymbolPalette & {
  state: WarMapSymbolState;
  symbolKey: WarMapSymbolKey;
  target: WarMapSymbolRenderTarget;
}): string {
  return [
    svgOpenTag(target),
    buildStateMarkup(state, target),
    buildSymbolBody({ accent, family, state, symbolKey, target }),
    "</svg>",
  ].join("");
}

function resolvePalette(
  symbolKey: WarMapSymbolKey,
  accentColor?: string,
): SymbolPalette {
  switch (symbolKey) {
    case "signal-high":
      return { accent: "#b42318", family: "signal" };
    case "signal-medium":
      return { accent: "#c26a14", family: "signal" };
    case "signal-low":
      return { accent: "#2563eb", family: "signal" };
    case "news-geocoded":
      return { accent: "#0f8a63", family: "news" };
    case "news-fallback":
      return { accent: "#217b93", family: "news" };
    case "monitor":
      return { accent: "#5b5bd6", family: "monitor" };
    case "flight":
      return { accent: "#334155", family: "flight" };
    case "ais-vessel-military":
      return { accent: "#b42318", family: "vessel" };
    case "ais-vessel-fishing":
      return { accent: "#2f9f5d", family: "vessel" };
    case "ais-vessel-passenger":
      return { accent: "#2f74d0", family: "vessel" };
    case "ais-vessel-cargo":
      return { accent: "#7c8da4", family: "vessel" };
    case "ais-vessel-tanker":
      return { accent: "#d96b1c", family: "vessel" };
    case "ais-vessel-other":
      return { accent: "#607289", family: "vessel" };
    case "ais-vessel-generic":
      return { accent: "#526277", family: "vessel" };
    case "ais-density":
      return { accent: "#2563eb", family: "density" };
    case "ais-disruption-high":
      return { accent: "#b42318", family: "warning" };
    case "ais-disruption-medium":
      return { accent: "#c8691a", family: "warning" };
    case "ais-disruption-low":
      return { accent: "#c99316", family: "warning" };
    case "generic-point":
    default:
      return {
        accent: coerceHexColor(accentColor, "#3b82f6"),
        family: "generic",
      };
  }
}

export function getWarMapSymbolAccentColor(
  symbolKey: WarMapSymbolKey,
  accentColor?: string,
): string {
  return resolvePalette(symbolKey, accentColor).accent;
}

export function getWarMapDeckIcon({
  symbolKey,
  state = "default",
  accentColor,
}: {
  symbolKey: WarMapSymbolKey;
  state?: WarMapSymbolState;
  accentColor?: string;
}): DeckIconDefinition {
  const normalizedAccent =
    symbolKey === "generic-point" ? coerceHexColor(accentColor) : undefined;
  const cacheKey = [symbolKey, state, normalizedAccent ?? ""].join(":");
  const cached = symbolIconCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const palette = resolvePalette(symbolKey, normalizedAccent);
  const icon = {
    url: toSvgDataUrl(
      buildSymbolSvg({ ...palette, state, symbolKey, target: "map" }),
    ),
    width: SYMBOL_ICON_SIZE,
    height: SYMBOL_ICON_SIZE,
    anchorX: SYMBOL_ICON_ANCHOR,
    anchorY: SYMBOL_ICON_ANCHOR,
    mask: false,
  } as const satisfies DeckIconDefinition;

  symbolIconCache.set(cacheKey, icon);
  return icon;
}

export function getWarMapLegendSvgMarkup({
  symbolKey,
  state = "default",
  accentColor,
}: {
  symbolKey: WarMapSymbolKey;
  state?: WarMapSymbolState;
  accentColor?: string;
}): string {
  const palette = resolvePalette(
    symbolKey,
    symbolKey === "generic-point" ? coerceHexColor(accentColor) : accentColor,
  );
  return buildSymbolSvg({
    ...palette,
    state,
    symbolKey,
    target: "legend",
  });
}

export function getQuickLegendVisibility(density: OverlayDensity): boolean {
  return QUICK_LEGEND_DENSITIES.has(density);
}

export function matchesWarMapLegendItem(
  item: Pick<
    WarMapLegendItem,
    "symbolKey" | "matchSymbolKeys" | "matchLayerIds"
  >,
  point: WarMapLegendMatchablePoint,
): boolean {
  if (
    point.layerId &&
    Array.isArray(item.matchLayerIds) &&
    item.matchLayerIds.includes(point.layerId)
  ) {
    return true;
  }

  const matchSymbolKeys = item.matchSymbolKeys ?? [item.symbolKey];
  return matchSymbolKeys.includes(point.symbolKey);
}

export function resolveWarMapLegendLabel(
  symbolKey: WarMapSymbolKey,
  t: WarMapTranslateFn,
): string {
  switch (symbolKey) {
    case "signal-high":
      return t("dashboard.charts.warMap.legend.signalHigh", {
        defaultValue: "Signal / high severity",
      });
    case "signal-medium":
      return t("dashboard.charts.warMap.legend.signalMedium", {
        defaultValue: "Signal / medium severity",
      });
    case "signal-low":
      return t("dashboard.charts.warMap.legend.signalLow", {
        defaultValue: "Signal / low severity",
      });
    case "news-geocoded":
      return t("dashboard.charts.warMap.legend.newsGeocoded", {
        defaultValue: "Geo-tagged news",
      });
    case "news-fallback":
      return t("dashboard.charts.warMap.legend.newsFallback", {
        defaultValue: "Country fallback news",
      });
    case "monitor":
      return t("dashboard.charts.warMap.legend.monitor", {
        defaultValue: "Situation monitor",
      });
    case "flight":
      return t("dashboard.charts.warMap.legend.flight", {
        defaultValue: "Flight activity",
      });
    case "ais-vessel-military":
      return t("dashboard.charts.warMap.legend.aisMilitary", {
        defaultValue: "Military / government",
      });
    case "ais-vessel-fishing":
      return t("dashboard.charts.warMap.legend.aisFishing", {
        defaultValue: "Fishing",
      });
    case "ais-vessel-passenger":
      return t("dashboard.charts.warMap.legend.aisPassenger", {
        defaultValue: "Passenger",
      });
    case "ais-vessel-cargo":
      return t("dashboard.charts.warMap.legend.aisCargo", {
        defaultValue: "Cargo",
      });
    case "ais-vessel-tanker":
      return t("dashboard.charts.warMap.legend.aisTanker", {
        defaultValue: "Tanker",
      });
    case "ais-vessel-other":
      return t("dashboard.charts.warMap.legend.aisOther", {
        defaultValue: "Other / unknown",
      });
    case "ais-vessel-generic":
      return t("dashboard.charts.warMap.legend.aisAllVesselsQuick", {
        defaultValue: "AIS vessels",
      });
    case "ais-density":
      return t("dashboard.charts.warMap.legend.aisDensity", {
        defaultValue: "Traffic density zone",
      });
    case "ais-disruption-high":
      return t("dashboard.charts.warMap.legend.aisDisruptionHigh", {
        defaultValue: "Disruption / high",
      });
    case "ais-disruption-medium":
      return t("dashboard.charts.warMap.legend.aisDisruptionMedium", {
        defaultValue: "Disruption / medium",
      });
    case "ais-disruption-low":
      return t("dashboard.charts.warMap.legend.aisDisruptionLow", {
        defaultValue: "Disruption / low",
      });
    case "generic-point":
    default:
      return t("dashboard.charts.warMap.legend.otherPointLayer", {
        defaultValue: "Other point layer",
      });
  }
}

export function buildWarMapQuickLegendItems({
  t,
  showMonitors,
  showFlights,
  showAis,
  effectiveAisMode,
}: {
  t: WarMapTranslateFn;
  showMonitors: boolean;
  showFlights: boolean;
  showAis: boolean;
  effectiveAisMode: WarMapAisMode;
}): WarMapLegendItem[] {
  const items: WarMapLegendItem[] = [
    {
      key: "signal-high",
      symbolKey: "signal-high",
      label: resolveWarMapLegendLabel("signal-high", t),
      matchSymbolKeys: ["signal-high"],
    },
    {
      key: "signal-medium",
      symbolKey: "signal-medium",
      label: resolveWarMapLegendLabel("signal-medium", t),
      matchSymbolKeys: ["signal-medium"],
    },
    {
      key: "signal-low",
      symbolKey: "signal-low",
      label: resolveWarMapLegendLabel("signal-low", t),
      matchSymbolKeys: ["signal-low"],
    },
    {
      key: "news-geocoded",
      symbolKey: "news-geocoded",
      label: resolveWarMapLegendLabel("news-geocoded", t),
      matchSymbolKeys: ["news-geocoded"],
    },
  ];

  if (showMonitors) {
    items.push({
      key: "monitor",
      symbolKey: "monitor",
      label: resolveWarMapLegendLabel("monitor", t),
      matchSymbolKeys: ["monitor" as const],
    });
  }

  if (showFlights) {
    items.push({
      key: "flight",
      symbolKey: "flight",
      label: resolveWarMapLegendLabel("flight", t),
      matchSymbolKeys: ["flight"],
    });
  }

  if (showAis) {
    if (effectiveAisMode === "density") {
      items.push(
        {
          key: "ais-density",
          symbolKey: "ais-density",
          label: resolveWarMapLegendLabel("ais-density", t),
          matchSymbolKeys: ["ais-density"],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick", {
            defaultValue: "AIS disruption",
          }),
          matchSymbolKeys: [
            "ais-disruption-high",
            "ais-disruption-medium",
            "ais-disruption-low",
          ],
        },
      );
    } else if (effectiveAisMode === "all") {
      items.push(
        {
          key: "ais-vessel-generic",
          symbolKey: "ais-vessel-generic",
          label: resolveWarMapLegendLabel("ais-vessel-generic", t),
          note: t("dashboard.charts.warMap.legend.quickColorByCategory", {
            defaultValue: "Color shows vessel category",
          }),
          matchSymbolKeys: [
            "ais-vessel-military",
            "ais-vessel-fishing",
            "ais-vessel-passenger",
            "ais-vessel-cargo",
            "ais-vessel-tanker",
            "ais-vessel-other",
            "ais-vessel-generic",
          ],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick", {
            defaultValue: "AIS disruption",
          }),
          matchSymbolKeys: [
            "ais-disruption-high",
            "ais-disruption-medium",
            "ais-disruption-low",
          ],
        },
      );
    } else {
      items.push(
        {
          key: "ais-vessel-military",
          symbolKey: "ais-vessel-military",
          label: resolveWarMapLegendLabel("ais-vessel-military", t),
          matchSymbolKeys: ["ais-vessel-military"],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick", {
            defaultValue: "AIS disruption",
          }),
          matchSymbolKeys: [
            "ais-disruption-high",
            "ais-disruption-medium",
            "ais-disruption-low",
          ],
        },
      );
    }
  }

  return items;
}

export function buildWarMapLegendSections({
  t,
  showMonitors,
  showFlights,
  showAis,
  effectiveAisMode,
  activePointLayers,
}: {
  t: WarMapTranslateFn;
  showMonitors: boolean;
  showFlights: boolean;
  showAis: boolean;
  effectiveAisMode: WarMapAisMode;
  activePointLayers: WarMapActivePointLayerLegendItem[];
}): WarMapLegendSection[] {
  const sections: WarMapLegendSection[] = [
    {
      key: "signals",
      title: t("dashboard.charts.warMap.legend.signalsTitle", {
        defaultValue: "Signals",
      }),
      description: t("dashboard.charts.warMap.legend.signalsHint", {
        defaultValue: "Severity is encoded through color and emphasis.",
      }),
      defaultExpanded: true,
      items: ["signal-high", "signal-medium", "signal-low"].map(
        (symbolKey) => ({
          key: symbolKey,
          symbolKey: symbolKey as WarMapSymbolKey,
          label: resolveWarMapLegendLabel(symbolKey as WarMapSymbolKey, t),
          matchSymbolKeys: [symbolKey as WarMapSymbolKey],
        }),
      ),
    },
    {
      key: "news",
      title: t("dashboard.charts.warMap.legend.newsTitle", {
        defaultValue: "News & Monitoring",
      }),
      description: t("dashboard.charts.warMap.legend.newsHint", {
        defaultValue:
          "Filled and hollow centers distinguish precise and fallback locations.",
      }),
      defaultExpanded: true,
      items: [
        {
          key: "news-geocoded",
          symbolKey: "news-geocoded",
          label: resolveWarMapLegendLabel("news-geocoded", t),
          matchSymbolKeys: ["news-geocoded"],
        },
        {
          key: "news-fallback",
          symbolKey: "news-fallback",
          label: resolveWarMapLegendLabel("news-fallback", t),
          matchSymbolKeys: ["news-fallback"],
        },
        ...(showMonitors
          ? [
              {
                key: "monitor",
                symbolKey: "monitor" as const,
                label: resolveWarMapLegendLabel("monitor", t),
                matchSymbolKeys: ["monitor" as const],
              },
            ]
          : []),
      ],
    },
  ];

  const transportItems: WarMapLegendItem[] = [];

  if (showFlights) {
    transportItems.push({
      key: "flight",
      symbolKey: "flight",
      label: resolveWarMapLegendLabel("flight", t),
      matchSymbolKeys: ["flight"],
    });
  }

  if (showAis) {
    if (effectiveAisMode === "density") {
      transportItems.push({
        key: "ais-density",
        symbolKey: "ais-density",
        label: resolveWarMapLegendLabel("ais-density", t),
        matchSymbolKeys: ["ais-density"],
      });
    }

    transportItems.push(
      {
        key: "ais-disruption-high",
        symbolKey: "ais-disruption-high",
        label: resolveWarMapLegendLabel("ais-disruption-high", t),
        matchSymbolKeys: ["ais-disruption-high"],
      },
      {
        key: "ais-disruption-medium",
        symbolKey: "ais-disruption-medium",
        label: resolveWarMapLegendLabel("ais-disruption-medium", t),
        matchSymbolKeys: ["ais-disruption-medium"],
      },
      {
        key: "ais-disruption-low",
        symbolKey: "ais-disruption-low",
        label: resolveWarMapLegendLabel("ais-disruption-low", t),
        matchSymbolKeys: ["ais-disruption-low"],
      },
    );

    if (effectiveAisMode !== "density") {
      transportItems.push(
        {
          key: "ais-vessel-military",
          symbolKey: "ais-vessel-military",
          label: resolveWarMapLegendLabel("ais-vessel-military", t),
          matchSymbolKeys: ["ais-vessel-military"],
        },
        {
          key: "ais-vessel-fishing",
          symbolKey: "ais-vessel-fishing",
          label: resolveWarMapLegendLabel("ais-vessel-fishing", t),
          matchSymbolKeys: ["ais-vessel-fishing"],
        },
        {
          key: "ais-vessel-passenger",
          symbolKey: "ais-vessel-passenger",
          label: resolveWarMapLegendLabel("ais-vessel-passenger", t),
          matchSymbolKeys: ["ais-vessel-passenger"],
        },
        {
          key: "ais-vessel-cargo",
          symbolKey: "ais-vessel-cargo",
          label: resolveWarMapLegendLabel("ais-vessel-cargo", t),
          matchSymbolKeys: ["ais-vessel-cargo"],
        },
        {
          key: "ais-vessel-tanker",
          symbolKey: "ais-vessel-tanker",
          label: resolveWarMapLegendLabel("ais-vessel-tanker", t),
          matchSymbolKeys: ["ais-vessel-tanker"],
        },
        {
          key: "ais-vessel-other",
          symbolKey: "ais-vessel-other",
          label: resolveWarMapLegendLabel("ais-vessel-other", t),
          matchSymbolKeys: ["ais-vessel-other"],
        },
      );
    }
  }

  if (transportItems.length > 0) {
    sections.push({
      key: "transport",
      title: t("dashboard.charts.warMap.legend.transportTitle", {
        defaultValue: "Air & Sea",
      }),
      description: t("dashboard.charts.warMap.legend.transportHint", {
        defaultValue:
          "Flights and AIS layers share the same map symbols and quick legend.",
      }),
      defaultExpanded: false,
      items: transportItems,
    });
  }

  sections.push({
    key: "states",
    title: t("dashboard.charts.warMap.legend.statesTitle", {
      defaultValue: "Display states",
    }),
    description: t("dashboard.charts.warMap.legend.statesHint", {
      defaultValue:
        "Focus rings and cluster bubbles highlight interaction state.",
    }),
    items: [
      {
        key: "hover",
        symbolKey: "signal-medium",
        state: "hover",
        label: t("dashboard.charts.warMap.legend.hoverState", {
          defaultValue: "Hover focus",
        }),
        matchSymbolKeys: ["signal-medium"],
      },
      {
        key: "selected",
        symbolKey: "signal-medium",
        state: "selected",
        label: t("dashboard.charts.warMap.legend.selectedState", {
          defaultValue: "Selected",
        }),
        matchSymbolKeys: ["signal-medium"],
      },
      {
        key: "cluster",
        symbolKey: "signal-medium",
        state: "cluster",
        countLabel: "12",
        label: t("dashboard.charts.warMap.legend.clusterState", {
          defaultValue: "Cluster badge",
        }),
        matchSymbolKeys: ["signal-medium"],
      },
    ],
    defaultExpanded: false,
  });

  if (activePointLayers.length > 0) {
    sections.push({
      key: "other-point-layers",
      title: t("dashboard.charts.warMap.legend.otherLayersTitle", {
        defaultValue: "Other Active Point Layers",
      }),
      description: t("dashboard.charts.warMap.legend.otherLayersHint", {
        defaultValue:
          "Point-based overlays without a bespoke symbol still use the shared halo and outline treatment.",
      }),
      defaultExpanded: false,
      items: activePointLayers.map((item) => ({
        key: item.key,
        symbolKey: "generic-point",
        accentColor: item.accentColor,
        label: item.label,
        matchLayerIds: [item.key],
      })),
    });
  }

  return sections;
}

export function WarMapLegendSwatch({
  symbolKey,
  label,
  note,
  state = "default",
  accentColor,
  countLabel,
  size = 42,
  variant = "panel",
  interactive = false,
  active = false,
  muted = false,
  endAdornment,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: WarMapLegendItem & {
  size?: number;
  variant?: "quick" | "panel";
  interactive?: boolean;
  active?: boolean;
  muted?: boolean;
  endAdornment?: ReactNode;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const iconMarkup = getWarMapLegendSvgMarkup({ symbolKey, state, accentColor });
  const containerClassName =
    variant === "quick"
      ? `flex min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-[border-color,background-color,box-shadow,transform,opacity] duration-150 ${
          active
            ? "border-slate-300/90 bg-white/[0.94] dark:border-slate-500/70 dark:bg-slate-950/[0.84]"
            : "border-slate-200/70 bg-white/[0.54] dark:border-slate-700/70 dark:bg-slate-950/[0.46]"
        } ${muted ? "opacity-55" : "opacity-100"} ${
          interactive
            ? "hover:border-slate-300/85 hover:bg-white/[0.82] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.68]"
            : ""
        }`
      : `flex min-w-0 items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,opacity] duration-150 ${
          active
            ? "border-slate-300 bg-white dark:border-slate-500/75 dark:bg-slate-950/82"
            : "border-slate-200/75 bg-white/[0.62] dark:border-slate-700/80 dark:bg-slate-950/[0.52]"
        } ${muted ? "opacity-50" : "opacity-100"} ${
          interactive
            ? "hover:border-slate-300/90 hover:bg-white/[0.84] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.72]"
            : ""
        }`;
  const content = (
    <>
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <span
          className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: iconMarkup }}
          aria-hidden="true"
        />
        {countLabel ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-slate-950 dark:text-slate-900">
            {countLabel}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block ${
            variant === "quick" ? "truncate text-[12px]" : "text-[13px]"
          } font-medium text-slate-900 dark:text-slate-100`}
        >
          {label}
        </span>
        {note ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">
            {note}
          </span>
        ) : null}
      </span>
      {endAdornment ? <span className="shrink-0">{endAdornment}</span> : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={containerClassName}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {content}
      </button>
    );
  }

  return <div className={containerClassName}>{content}</div>;
}
