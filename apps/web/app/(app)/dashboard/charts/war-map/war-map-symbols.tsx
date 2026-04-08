"use client";

import type { ReactNode } from "react";
import type { WarMapAisMode } from "@modular/utils";

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
  shape:
    | "diamond"
    | "rounded-square"
    | "hexagon"
    | "circle"
    | "rounded-rect"
    | "triangle";
  glyph?: "dot" | "flight" | "vessel" | "grid" | "warning" | "crosshair";
}

interface DeckIconDefinition {
  url: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  mask: false;
}

const SYMBOL_ICON_SIZE = 72;
const SYMBOL_ICON_ANCHOR = SYMBOL_ICON_SIZE / 2;
const OUTLINE = "#0f172a";
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

function buildSymbolPath(shape: SymbolPalette["shape"]): string {
  switch (shape) {
    case "diamond":
      return "M36 10 56 30 36 62 16 30Z";
    case "rounded-square":
      return "M22 14h28c8 0 14 6 14 14v16c0 8-6 14-14 14H22c-8 0-14-6-14-14V28c0-8 6-14 14-14Z";
    case "hexagon":
      return "M36 10 56 22 56 50 36 62 16 50 16 22Z";
    case "rounded-rect":
      return "M18 16h36c9 0 16 7 16 16v8c0 9-7 16-16 16H18C9 56 2 49 2 40v-8c0-9 7-16 16-16Z";
    case "triangle":
      return "M36 8 62 58H10Z";
    case "circle":
    default:
      return "M36 10a26 26 0 1 1 0 52a26 26 0 1 1 0-52Z";
  }
}

function buildGlyphSvg(glyph: SymbolPalette["glyph"], accent: string): string {
  switch (glyph) {
    case "dot":
      return `<circle cx="36" cy="36" r="6.5" fill="${OUTLINE}" /><circle cx="36" cy="36" r="3.5" fill="${WHITE}" />`;
    case "flight":
      return `<path fill="${WHITE}" d="M36 18c2.1 0 3.8 1.6 3.8 3.7v9.7l18.5 8.9c2.9 1.4 4 5 2.5 7.8l-1.4 2.5-19.6-4.8v10.7l7.6 5.8v4.9l-11.4-2.9-11.4 2.9v-4.9l7.6-5.8V45.8l-19.6 4.8-1.4-2.5c-1.5-2.8-.4-6.4 2.5-7.8l18.5-8.9v-9.7c0-2.1 1.7-3.7 3.8-3.7Z"/>`;
    case "vessel":
      return `<path fill="${WHITE}" d="M36 18 47.5 31h-5.3v10.7h12.2L64 57.7l-8.7 8.3H16.7L8 57.7l9.6-15.9h12.2V31h-5.3L36 18Zm-10.6 28.8-5 8.5h31.1l-5-8.5H25.4Zm1.7 13.6 3 3.9h11.9l3-3.9H27.1Z"/>`;
    case "grid":
      return `<rect x="24" y="24" width="6" height="6" rx="2" fill="${WHITE}" /><rect x="34" y="24" width="6" height="6" rx="2" fill="${WHITE}" /><rect x="24" y="34" width="6" height="6" rx="2" fill="${WHITE}" /><rect x="34" y="34" width="6" height="6" rx="2" fill="${WHITE}" /><path d="M47 22v28" stroke="${withAlpha(WHITE, 0.72)}" stroke-width="3" stroke-linecap="round" />`;
    case "warning":
      return `<path d="M36 22v16" stroke="${WHITE}" stroke-width="5" stroke-linecap="round" /><circle cx="36" cy="46.5" r="3.2" fill="${WHITE}" />`;
    case "crosshair":
      return `<circle cx="36" cy="36" r="7" fill="${WHITE}" /><path d="M36 19v8M36 45v8M19 36h8M45 36h8" stroke="${WHITE}" stroke-width="4" stroke-linecap="round" /><circle cx="36" cy="36" r="14" stroke="${withAlpha(WHITE, 0.76)}" stroke-width="3" fill="none" />`;
    default:
      return `<circle cx="36" cy="36" r="4" fill="${mixHex(accent, WHITE, 0.88)}" />`;
  }
}

function buildSymbolSvg({
  accent,
  glyph,
  shape,
  state,
}: SymbolPalette & { state: WarMapSymbolState }): string {
  const basePath = buildSymbolPath(shape);
  const isCluster = state === "cluster";
  const innerFill = isCluster
    ? mixHex(accent, WHITE, 0.86)
    : state === "selected"
      ? mixHex(accent, WHITE, 0.08)
      : state === "hover"
        ? mixHex(accent, WHITE, 0.14)
        : accent;
  const outlineStrokeWidth = isCluster ? 3.8 : state === "selected" ? 4.2 : 3.3;
  const haloStrokeWidth = isCluster ? 11 : state === "selected" ? 12 : 10;
  const innerStroke = isCluster ? accent : OUTLINE;
  const innerShadowStroke = isCluster
    ? withAlpha(accent, 0.26)
    : withAlpha(OUTLINE, state === "hover" ? 0.4 : 0.24);
  const glyphMarkup = buildGlyphSvg(glyph, accent);

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${SYMBOL_ICON_SIZE}" height="${SYMBOL_ICON_SIZE}" viewBox="0 0 72 72">
      <path d="${basePath}" fill="none" stroke="${WHITE}" stroke-width="${haloStrokeWidth}" stroke-linejoin="round" stroke-linecap="round" />
      <path d="${basePath}" fill="none" stroke="${innerShadowStroke}" stroke-width="${outlineStrokeWidth + 4}" stroke-linejoin="round" stroke-linecap="round" opacity="0.45" />
      <path d="${basePath}" fill="${innerFill}" stroke="${innerStroke}" stroke-width="${outlineStrokeWidth}" stroke-linejoin="round" stroke-linecap="round" />
      ${glyphMarkup}
    </svg>
  `;
}

function resolvePalette(
  symbolKey: WarMapSymbolKey,
  accentColor?: string,
): SymbolPalette {
  switch (symbolKey) {
    case "signal-high":
      return { accent: "#dc2626", shape: "diamond", glyph: "crosshair" };
    case "signal-medium":
      return { accent: "#d97706", shape: "diamond", glyph: "crosshair" };
    case "signal-low":
      return { accent: "#2563eb", shape: "diamond", glyph: "crosshair" };
    case "news-geocoded":
      return { accent: "#059669", shape: "rounded-square", glyph: "dot" };
    case "news-fallback":
      return { accent: "#0891b2", shape: "rounded-square", glyph: "dot" };
    case "monitor":
      return { accent: "#4f46e5", shape: "hexagon", glyph: "crosshair" };
    case "flight":
      return { accent: "#334155", shape: "circle", glyph: "flight" };
    case "ais-vessel-military":
      return { accent: "#dc2626", shape: "rounded-rect", glyph: "vessel" };
    case "ais-vessel-fishing":
      return { accent: "#22c55e", shape: "rounded-rect", glyph: "vessel" };
    case "ais-vessel-passenger":
      return { accent: "#3b82f6", shape: "rounded-rect", glyph: "vessel" };
    case "ais-vessel-cargo":
      return { accent: "#94a3b8", shape: "rounded-rect", glyph: "vessel" };
    case "ais-vessel-tanker":
      return { accent: "#f97316", shape: "rounded-rect", glyph: "vessel" };
    case "ais-vessel-other":
      return { accent: "#64748b", shape: "rounded-rect", glyph: "vessel" };
    case "ais-vessel-generic":
      return { accent: "#475569", shape: "rounded-rect", glyph: "vessel" };
    case "ais-density":
      return { accent: "#2563eb", shape: "rounded-square", glyph: "grid" };
    case "ais-disruption-high":
      return { accent: "#dc2626", shape: "triangle", glyph: "warning" };
    case "ais-disruption-medium":
      return { accent: "#ea580c", shape: "triangle", glyph: "warning" };
    case "ais-disruption-low":
      return { accent: "#f59e0b", shape: "triangle", glyph: "warning" };
    case "generic-point":
    default:
      return {
        accent: coerceHexColor(accentColor, "#3b82f6"),
        shape: "circle",
        glyph: "dot",
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
    url: toSvgDataUrl(buildSymbolSvg({ ...palette, state })),
    width: SYMBOL_ICON_SIZE,
    height: SYMBOL_ICON_SIZE,
    anchorX: SYMBOL_ICON_ANCHOR,
    anchorY: SYMBOL_ICON_ANCHOR,
    mask: false,
  } as const satisfies DeckIconDefinition;

  symbolIconCache.set(cacheKey, icon);
  return icon;
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
        defaultValue: "Severity is encoded by both shape treatment and color.",
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
          "Shape distinguishes precision and source, not just color.",
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
        "Hover, selected, and clustered markers use explicit ring and badge states.",
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
  const icon = getWarMapDeckIcon({ symbolKey, state, accentColor });
  const containerClassName =
    variant === "quick"
      ? `flex min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-[border-color,background-color,box-shadow,transform,opacity] duration-150 ${
          active
            ? "border-slate-300/90 bg-white/[0.94] shadow-[0_10px_18px_-18px_rgba(15,23,42,0.28)] dark:border-slate-500/70 dark:bg-slate-950/[0.84]"
            : "border-slate-200/70 bg-white/[0.72] shadow-[0_8px_16px_-20px_rgba(15,23,42,0.22)] dark:border-slate-700/70 dark:bg-slate-950/[0.58]"
        } ${muted ? "opacity-55" : "opacity-100"} ${
          interactive
            ? "hover:-translate-y-[1px] hover:border-slate-300/85 hover:bg-white/[0.9] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.78]"
            : ""
        }`
      : `flex min-w-0 items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,opacity] duration-150 ${
          active
            ? "border-slate-300 bg-white shadow-[0_14px_28px_-24px_rgba(15,23,42,0.22)] dark:border-slate-500/75 dark:bg-slate-950/82"
            : "border-slate-200/75 bg-white/[0.74] shadow-[0_12px_26px_-26px_rgba(15,23,42,0.18)] dark:border-slate-700/80 dark:bg-slate-950/[0.62]"
        } ${muted ? "opacity-50" : "opacity-100"} ${
          interactive
            ? "hover:border-slate-300/90 hover:bg-white/[0.92] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.8]"
            : ""
        }`;
  const content = (
    <>
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <img
          alt=""
          src={icon.url}
          className="h-full w-full object-contain"
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
