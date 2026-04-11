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
  tone?: "default" | "degraded";
  accentColor?: string;
  countLabel?: string;
  matchSymbolKeys?: WarMapSymbolKey[];
  matchLayerIds?: string[];
}

export type WarMapLegendStatusTone = "info" | "warning" | "critical";

export interface WarMapLegendSection {
  key: string;
  title: string;
  description?: string;
  statusLabel?: string;
  statusTone?: WarMapLegendStatusTone;
  statusHint?: string;
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

export interface WarMapTransportLegendItemState {
  note?: string;
  countLabel?: string;
  tone?: "default" | "degraded";
}

export interface WarMapTransportLegendState {
  sectionStatusLabel?: string;
  sectionStatusTone?: WarMapLegendStatusTone;
  sectionStatusHint?: string;
  flights?: WarMapTransportLegendItemState;
  aisPrimary?: WarMapTransportLegendItemState;
  aisDisruption?: WarMapTransportLegendItemState;
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

function mapStrokeCircle(
  radius: number,
  stroke: string,
  width: number,
): string {
  return [
    `<circle cx="12" cy="12" r="${radius}" ${strokeAttrs(width + 1.15, WHITE)} opacity="0.94" />`,
    `<circle cx="12" cy="12" r="${radius}" ${strokeAttrs(width, stroke)} />`,
  ].join("");
}

function mapStrokeRect({
  x,
  y,
  width,
  height,
  rx,
  stroke,
  strokeWidth,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  stroke: string;
  strokeWidth: number;
}): string {
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" ${strokeAttrs(strokeWidth + 1.05, WHITE)} opacity="0.92" />`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" ${strokeAttrs(strokeWidth, stroke)} />`,
  ].join("");
}

function buildCircularStateMarkup({
  state,
  target,
  accent,
}: {
  state: Exclude<WarMapSymbolState, "default" | "cluster">;
  target: WarMapSymbolRenderTarget;
  accent: string;
}): string {
  const outerRadius = target === "map" ? 8.8 : 9.15;
  const hoverStroke = withAlpha(accent, target === "map" ? 0.18 : 0.24);
  const hoverFill = withAlpha(WHITE, target === "map" ? 0.46 : 0.74);
  const selectedStroke = withAlpha(accent, target === "map" ? 0.3 : 0.36);
  const selectedFill = withAlpha(accent, target === "map" ? 0.05 : 0.07);

  if (state === "hover") {
    return [
      `<circle cx="12" cy="12" r="${outerRadius}" fill="${hoverFill}" />`,
      `<circle cx="12" cy="12" r="${outerRadius}" ${strokeAttrs(1.05, hoverStroke)} />`,
    ].join("");
  }

  return [
    `<circle cx="12" cy="12" r="${outerRadius + 0.1}" fill="${selectedFill}" />`,
    `<circle cx="12" cy="12" r="${outerRadius}" ${strokeAttrs(1.45, withAlpha(WHITE, target === "map" ? 0.84 : 0.94))} />`,
    `<circle cx="12" cy="12" r="${outerRadius}" ${strokeAttrs(1.15, selectedStroke)} />`,
  ].join("");
}

function buildPlateStateMarkup({
  state,
  target,
  accent,
  x,
  y,
  width,
  height,
  rx,
}: {
  state: Exclude<WarMapSymbolState, "default" | "cluster">;
  target: WarMapSymbolRenderTarget;
  accent: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}): string {
  const hoverFill = withAlpha(WHITE, target === "map" ? 0.5 : 0.76);
  const hoverStroke = withAlpha(accent, target === "map" ? 0.18 : 0.24);
  const selectedFill = withAlpha(accent, target === "map" ? 0.07 : 0.09);
  const selectedStroke = withAlpha(accent, target === "map" ? 0.32 : 0.38);

  if (state === "hover") {
    return [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${hoverFill}" />`,
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" ${strokeAttrs(1.05, hoverStroke)} />`,
    ].join("");
  }

  return [
    `<rect x="${x - 0.15}" y="${y - 0.15}" width="${width + 0.3}" height="${height + 0.3}" rx="${rx + 0.2}" fill="${selectedFill}" />`,
    target === "map"
      ? mapStrokeRect({
          x,
          y,
          width,
          height,
          rx,
          stroke: selectedStroke,
          strokeWidth: 1.15,
        })
      : `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" ${strokeAttrs(1.15, selectedStroke)} />`,
  ].join("");
}

function buildStateMarkup({
  state,
  target,
  accent,
  family,
}: {
  state: WarMapSymbolState;
  target: WarMapSymbolRenderTarget;
  accent: string;
  family: SymbolPalette["family"];
}): string {
  if (state === "default" || state === "cluster") {
    return "";
  }

  if (
    family === "signal" ||
    family === "news" ||
    family === "monitor" ||
    family === "generic"
  ) {
    return buildCircularStateMarkup({ state, target, accent });
  }

  if (family === "flight") {
    return buildPlateStateMarkup({
      state,
      target,
      accent,
      x: 5,
      y: 7.05,
      width: 14,
      height: 9.9,
      rx: 4.25,
    });
  }

  if (family === "vessel") {
    return buildPlateStateMarkup({
      state,
      target,
      accent,
      x: 6.05,
      y: 6.2,
      width: 11.9,
      height: 11.6,
      rx: 4.4,
    });
  }

  return buildPlateStateMarkup({
    state,
    target,
    accent,
    x: 5.35,
    y: 5.95,
    width: 13.3,
    height: 12.2,
    rx: 4.35,
  });
}

function buildClusterBubble(
  accent: string,
  target: WarMapSymbolRenderTarget,
): string {
  const arcPath = "M7.7 9a5.2 5.2 0 0 1 8.6 0";
  return [
    `<circle cx="12" cy="12" r="7.55" fill="${mixHex(accent, WHITE, 0.975)}" ${strokeAttrs(1.05, withAlpha(accent, 0.16))} />`,
    target === "map"
      ? `<circle cx="12" cy="12" r="7.55" ${strokeAttrs(1.55, WHITE)} opacity="0.92" />`
      : "",
    `<path d="${arcPath}" ${strokeAttrs(1.7, accent)} />`,
    `<circle cx="12" cy="12.35" r="3.45" fill="${withAlpha(WHITE, target === "map" ? 0.92 : 0.98)}" />`,
    `<circle cx="12" cy="12.35" r="3.45" ${strokeAttrs(0.8, withAlpha(accent, 0.08))} />`,
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

function buildFlightSymbol(
  accent: string,
  target: WarMapSymbolRenderTarget,
): string {
  const bodyFill = mixHex(accent, WHITE, target === "map" ? 0.9 : 0.94);
  const wingFill = mixHex(accent, WHITE, target === "map" ? 0.82 : 0.88);
  const fuselagePath =
    "M12 4.35c.54 0 1 .44 1 1v4.1l4.9 1.95c.38.15.63.51.63.92 0 .42-.26.79-.65.93L13 14.72v3.95c0 .4-.24.77-.61.92l-.39.17-.39-.17a.98.98 0 0 1-.61-.92v-3.95L6.12 13.25a1 1 0 0 1-.65-.93c0-.41.25-.77.63-.92L11 9.45v-4.1c0-.56.44-1 1-1Z";
  const cabinPath =
    "M12 5.55c.2 0 .38.17.38.38v2.6a.38.38 0 0 1-.25.36L9.55 9.9a.38.38 0 0 1-.47-.5l2.54-3.58a.38.38 0 0 1 .31-.16Z";
  const wingPath = "M7.1 11.55 12 9.9l4.9 1.65-4.9 1.3-4.9-1.3Z";
  const tailPath = "M10.62 15.55 12 14.98l1.38.57-.57 2.02H11.2l-.58-2.02Z";

  const outline =
    target === "map"
      ? [
          `<path d="${fuselagePath}" fill="${bodyFill}" ${strokeAttrs(1.9, WHITE)} opacity="0.95" />`,
          `<path d="${fuselagePath}" fill="${bodyFill}" ${strokeAttrs(1.2, accent)} />`,
        ].join("")
      : `<path d="${fuselagePath}" fill="${bodyFill}" ${strokeAttrs(1.2, accent)} />`;

  return [
    `<path d="${wingPath}" fill="${wingFill}" />`,
    outline,
    `<path d="${cabinPath}" fill="${withAlpha(accent, 0.14)}" />`,
    `<path d="${tailPath}" fill="${withAlpha(accent, 0.16)}" />`,
    `<path d="M12 6.15v8.3" ${strokeAttrs(0.9, withAlpha(accent, 0.42))} />`,
  ].join("");
}

function buildVesselSymbol(
  accent: string,
  target: WarMapSymbolRenderTarget,
  symbolKey: WarMapSymbolKey,
): string {
  const hullFill = mixHex(accent, WHITE, target === "map" ? 0.9 : 0.95);
  const deckFill = mixHex(accent, WHITE, target === "map" ? 0.78 : 0.84);
  const detailStroke = withAlpha(accent, 0.6);
  const detailFill = withAlpha(accent, 0.14);
  const vesselStructure =
    symbolKey === "ais-vessel-military"
      ? {
          hullPath:
            "M6.92 14.02h8.72l1.52.56-1 1.44a2.55 2.55 0 0 1-2.11 1.12h-3.92a2.56 2.56 0 0 1-2.12-1.13l-1.09-1.99Z",
          deckLine: "M8.35 12.34h6.92",
          cabinPath:
            "M11.44 8.08c0-.35.28-.63.63-.63h1.06c.35 0 .63.28.63.63v3.54h-2.32V8.08Z",
          detail: [
            `<path d="M12.24 6.48v5.05" ${strokeAttrs(0.95, detailStroke)} />`,
            `<path d="M12.24 6.92 14.7 7.82 12.24 8.7Z" fill="${detailFill}" ${strokeAttrs(0.72, detailStroke)} />`,
            `<path d="M9.58 10.72h1.66" ${strokeAttrs(0.82, detailStroke)} />`,
            `<path d="M14.95 13.22 16.38 12.68" ${strokeAttrs(0.78, detailStroke)} />`,
          ].join(""),
          waveLeft:
            "M7.55 18.08c.78.56 1.47.56 2.25 0 .78-.57 1.48-.57 2.25 0",
          waveRight:
            "M12.34 18.08c.74.52 1.42.52 2.16 0 .74-.53 1.42-.53 2.16 0",
        }
      : symbolKey === "ais-vessel-fishing"
        ? {
            hullPath:
              "M7.16 14.12h9.48l-1.06 1.88a2.42 2.42 0 0 1-2.1 1.24h-3.14a2.42 2.42 0 0 1-2.09-1.21l-1.09-1.91Z",
            deckLine: "M8.28 12.28h6.88",
            cabinPath:
              "M9.24 8.86c0-.35.28-.63.63-.63h1.78c.35 0 .63.28.63.63v3.06H9.24V8.86Z",
            detail: [
              `<path d="M10.58 7.58v4.05" ${strokeAttrs(0.88, detailStroke)} />`,
              `<path d="M10.58 8.08 14.22 10.18" ${strokeAttrs(0.78, detailStroke)} />`,
              `<path d="M14.22 10.18v1.24" ${strokeAttrs(0.72, detailStroke)} />`,
              `<circle cx="14.22" cy="11.78" r="0.52" fill="${detailStroke}" />`,
            ].join(""),
          waveLeft:
            "M7.52 18.06c.7.5 1.34.5 2.04 0 .7-.51 1.34-.51 2.04 0",
          waveRight:
            "M11.98 18.06c.8.58 1.5.58 2.3 0 .8-.58 1.5-.58 2.3 0",
          }
        : symbolKey === "ais-vessel-passenger"
          ? {
              hullPath:
                "M6.78 13.92h10.56l-1.04 2.04a2.5 2.5 0 0 1-2.22 1.35h-4.16a2.5 2.5 0 0 1-2.21-1.33l-.93-2.06Z",
              deckLine: "M8.14 12.34h7.78",
              cabinPath:
                "M8.58 8.08c0-.38.3-.68.68-.68h5.08c.38 0 .68.3.68.68v3.84H8.58V8.08Z",
              detail: [
                `<path d="M9.24 9.36h5.12" ${strokeAttrs(0.8, detailStroke)} />`,
                `<path d="M9.68 10.52h4.34" ${strokeAttrs(0.72, detailStroke)} />`,
                `<circle cx="10.14" cy="9.98" r="0.42" fill="${detailStroke}" />`,
                `<circle cx="11.98" cy="9.98" r="0.42" fill="${detailStroke}" />`,
                `<circle cx="13.82" cy="9.98" r="0.42" fill="${detailStroke}" />`,
              ].join(""),
              waveLeft:
                "M7.48 18.02c.76.54 1.44.54 2.2 0 .76-.55 1.45-.55 2.2 0",
              waveRight:
                "M12.18 18.02c.76.54 1.44.54 2.2 0 .76-.55 1.45-.55 2.2 0",
            }
          : symbolKey === "ais-vessel-cargo"
            ? {
                hullPath:
                  "M7.08 14.06h10l-1 1.88a2.45 2.45 0 0 1-2.14 1.27h-3.42a2.45 2.45 0 0 1-2.14-1.27l-1.3-1.88Z",
                deckLine: "M7.98 12.22h7.96",
                cabinPath:
                  "M13.18 8.72c0-.35.29-.64.64-.64h1.04c.36 0 .64.29.64.64v3.12h-2.32V8.72Z",
                detail: [
                  `<rect x="8.34" y="8.9" width="2.34" height="1.5" rx="0.24" fill="${detailFill}" ${strokeAttrs(0.72, detailStroke)} />`,
                  `<rect x="10.96" y="8.9" width="2.34" height="1.5" rx="0.24" fill="${detailFill}" ${strokeAttrs(0.72, detailStroke)} />`,
                  `<rect x="8.92" y="10.62" width="4.18" height="1.16" rx="0.24" fill="${detailFill}" ${strokeAttrs(0.7, detailStroke)} />`,
                ].join(""),
                waveLeft:
                  "M7.58 18.04c.72.52 1.38.52 2.1 0 .72-.52 1.38-.52 2.1 0",
                waveRight:
                  "M12.18 18.04c.72.52 1.38.52 2.1 0 .72-.52 1.38-.52 2.1 0",
              }
            : symbolKey === "ais-vessel-tanker"
              ? {
                  hullPath:
                    "M7.04 14.08h9.94l-1 1.96a2.44 2.44 0 0 1-2.13 1.24h-3.36a2.44 2.44 0 0 1-2.13-1.24l-1.32-1.96Z",
                  deckLine: "M8.12 12.26h7.62",
                  cabinPath:
                    "M13.08 8.7c0-.36.29-.65.65-.65h1.12c.36 0 .65.29.65.65v3.18h-2.42V8.7Z",
                  detail: [
                    `<rect x="8.46" y="9.04" width="5.18" height="1.74" rx="0.87" fill="${detailFill}" ${strokeAttrs(0.76, detailStroke)} />`,
                    `<path d="M13.98 9.18v1.48" ${strokeAttrs(0.7, detailStroke)} />`,
                    `<circle cx="9.92" cy="9.92" r="0.34" fill="${detailStroke}" />`,
                  ].join(""),
                  waveLeft:
                    "M7.6 18.05c.76.54 1.44.54 2.2 0 .76-.54 1.44-.54 2.2 0",
                  waveRight:
                    "M12.28 18.05c.7.5 1.34.5 2.04 0 .7-.5 1.34-.5 2.04 0",
                }
              : {
                  hullPath:
                    "M7.12 14.04h9.8l-1.02 1.92a2.42 2.42 0 0 1-2.12 1.23h-3.28a2.42 2.42 0 0 1-2.11-1.23l-1.27-1.92Z",
                  deckLine: "M8.24 12.3h7.34",
                  cabinPath:
                    "M9.88 8.5c0-.37.3-.67.67-.67h2.88c.37 0 .67.3.67.67v3.4H9.88V8.5Z",
                  detail: [
                    `<circle cx="10.82" cy="10.1" r="0.42" fill="${detailStroke}" />`,
                    `<circle cx="12.48" cy="10.1" r="0.42" fill="${detailStroke}" />`,
                    `<path d="M9.86 9.12h4.26" ${strokeAttrs(0.7, detailStroke)} />`,
                  ].join(""),
                  waveLeft:
                    "M7.64 18.05c.72.52 1.38.52 2.1 0 .72-.53 1.38-.53 2.1 0",
                  waveRight:
                    "M12.22 18.05c.72.52 1.38.52 2.1 0 .72-.53 1.38-.53 2.1 0",
                };

  const hull =
    target === "map"
      ? [
          `<path d="${vesselStructure.hullPath}" fill="${hullFill}" ${strokeAttrs(1.85, WHITE)} opacity="0.94" />`,
          `<path d="${vesselStructure.hullPath}" fill="${hullFill}" ${strokeAttrs(1.18, accent)} />`,
        ].join("")
      : `<path d="${vesselStructure.hullPath}" fill="${hullFill}" ${strokeAttrs(1.18, accent)} />`;

  return [
    `<path d="${vesselStructure.cabinPath}" fill="${deckFill}" ${strokeAttrs(1.05, accent)} />`,
    `<path d="${vesselStructure.deckLine}" ${strokeAttrs(1.05, accent)} />`,
    vesselStructure.detail,
    hull,
    `<path d="${vesselStructure.waveLeft}" ${strokeAttrs(0.9, withAlpha(accent, 0.4))} />`,
    `<path d="${vesselStructure.waveRight}" ${strokeAttrs(0.9, withAlpha(accent, 0.4))} />`,
  ].join("");
}

function buildDensitySymbol(
  accent: string,
  target: WarMapSymbolRenderTarget,
): string {
  const accentSoft = withAlpha(accent, target === "map" ? 0.11 : 0.09);
  const contourStroke = withAlpha(accent, target === "map" ? 0.24 : 0.3);
  return [
    `<circle cx="12" cy="12" r="8.1" fill="${accentSoft}" />`,
    `<circle cx="12" cy="12" r="6.4" fill="${withAlpha(accent, target === "map" ? 0.05 : 0.045)}" />`,
    `<circle cx="12" cy="12" r="6.15" ${strokeAttrs(0.85, contourStroke)} />`,
    `<circle cx="12" cy="12" r="4.95" fill="${withAlpha(accent, target === "map" ? 0.07 : 0.055)}" />`,
    target === "map"
      ? mapStrokeCircle(4.85, accent, 1.05)
      : `<circle cx="12" cy="12" r="4.85" ${strokeAttrs(1.05, accent)} />`,
    `<circle cx="12" cy="12" r="2.55" fill="${withAlpha(accent, 0.12)}" />`,
    `<circle cx="12" cy="12" r="1.55" fill="${accent}" />`,
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
  const trianglePath = "M12 5.55 17.1 16.3H6.9Z";
  const innerTrianglePath = "M12 7.55 15.28 14.38H8.72Z";
  const fillOpacity =
    severity === "high" ? 0.12 : severity === "medium" ? 0.09 : 0.06;
  const triangle =
    target === "map"
      ? [
          `<path d="${trianglePath}" fill="${withAlpha(accent, fillOpacity)}" ${strokeAttrs(1.8, WHITE)} opacity="0.92" />`,
          `<path d="${trianglePath}" fill="${withAlpha(accent, fillOpacity)}" ${strokeAttrs(1.28, accent)} />`,
        ].join("")
      : `<path d="${trianglePath}" fill="${withAlpha(accent, fillOpacity)}" ${strokeAttrs(1.28, accent)} />`;
  const severityAccent =
    severity === "high"
      ? withAlpha(accent, 0.2)
      : severity === "medium"
        ? withAlpha(accent, 0.15)
        : withAlpha(accent, 0.1);
  const severityDetail =
    severity === "high"
      ? [
          `<path d="M12 8.9v4.45" ${strokeAttrs(1.45, accent)} />`,
          `<circle cx="12" cy="14.98" r="0.78" fill="${accent}" />`,
          `<circle cx="12" cy="6.95" r="0.62" fill="${withAlpha(accent, 0.42)}" />`,
        ].join("")
      : severity === "medium"
        ? [
            `<path d="M12 9.2v3.78" ${strokeAttrs(1.25, accent)} />`,
            `<circle cx="12" cy="14.62" r="0.7" fill="${accent}" />`,
            `<path d="M10.02 8.88h3.96" ${strokeAttrs(0.72, withAlpha(accent, 0.32))} />`,
          ].join("")
        : [
            `<circle cx="12" cy="12.15" r="1.52" fill="${withAlpha(accent, 0.14)}" ${strokeAttrs(0.9, accent)} />`,
            `<circle cx="12" cy="12.15" r="0.62" fill="${accent}" />`,
            `<path d="M9.25 14.78h5.5" ${strokeAttrs(0.72, withAlpha(accent, 0.3))} />`,
          ].join("");

  return [
    triangle,
    `<path d="${innerTrianglePath}" fill="${severityAccent}" />`,
    `<path d="M8.7 15.1h6.6" ${strokeAttrs(0.8, withAlpha(accent, 0.34))} />`,
    severityDetail,
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
      return buildFlightSymbol(accent, target);
    case "vessel":
      return buildVesselSymbol(accent, target, symbolKey);
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
    buildStateMarkup({ state, target, accent, family }),
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

function getQuickLegendMaxVisibleCount(density: OverlayDensity): number {
  if (density === "expanded") {
    return 7;
  }
  if (density === "compact") {
    return 6;
  }
  return 0;
}

export function selectVisibleQuickLegendItems({
  density,
  items,
}: {
  density: OverlayDensity;
  items: WarMapLegendItem[];
}): {
  visibleItems: WarMapLegendItem[];
  hiddenCount: number;
} {
  const maxVisibleCount = getQuickLegendMaxVisibleCount(density);
  if (maxVisibleCount <= 0 || items.length === 0) {
    return {
      visibleItems: [],
      hiddenCount: items.length,
    };
  }

  const visibleKeys = items.slice(0, maxVisibleCount).map((item) => item.key);
  const removablePriority = [
    "signal-low",
    "signal-medium",
    "monitor",
    "news-geocoded",
  ];
  const requiredKeys = [
    items.find((item) => item.key === "flight")?.key,
    items.find((item) =>
      ["ais-density", "ais-vessel-generic", "ais-vessel-military"].includes(
        item.key,
      ),
    )?.key,
  ].filter((value): value is string => Boolean(value));

  for (const requiredKey of requiredKeys) {
    if (visibleKeys.includes(requiredKey)) {
      continue;
    }

    const replacementKey = removablePriority.find((candidate) =>
      visibleKeys.includes(candidate),
    );
    const replacementIndex =
      replacementKey === undefined
        ? visibleKeys.length < maxVisibleCount
          ? visibleKeys.length
          : Math.max(visibleKeys.length - 1, 0)
        : visibleKeys.indexOf(replacementKey);

    visibleKeys[replacementIndex] = requiredKey;
  }

  const visibleKeySet = new Set(visibleKeys);
  const visibleItems = items
    .filter((item) => visibleKeySet.has(item.key))
    .slice(0, maxVisibleCount);

  return {
    visibleItems,
    hiddenCount: Math.max(0, items.length - visibleItems.length),
  };
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
  transportState,
}: {
  t: WarMapTranslateFn;
  showMonitors: boolean;
  showFlights: boolean;
  showAis: boolean;
  effectiveAisMode: WarMapAisMode;
  transportState?: WarMapTransportLegendState;
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
      note: transportState?.flights?.note,
      countLabel: transportState?.flights?.countLabel,
      tone: transportState?.flights?.tone,
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
          note: transportState?.aisPrimary?.note,
          countLabel: transportState?.aisPrimary?.countLabel,
          tone: transportState?.aisPrimary?.tone,
          matchSymbolKeys: ["ais-density"],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick", {
            defaultValue: "AIS disruption",
          }),
          note: transportState?.aisDisruption?.note,
          countLabel: transportState?.aisDisruption?.countLabel,
          tone: transportState?.aisDisruption?.tone,
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
          note:
            transportState?.aisPrimary?.note ??
            t("dashboard.charts.warMap.legend.quickColorByCategory", {
              defaultValue: "Color shows vessel category",
            }),
          countLabel: transportState?.aisPrimary?.countLabel,
          tone: transportState?.aisPrimary?.tone,
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
          note: transportState?.aisDisruption?.note,
          countLabel: transportState?.aisDisruption?.countLabel,
          tone: transportState?.aisDisruption?.tone,
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
          note: transportState?.aisPrimary?.note,
          countLabel: transportState?.aisPrimary?.countLabel,
          tone: transportState?.aisPrimary?.tone,
          matchSymbolKeys: ["ais-vessel-military"],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick", {
            defaultValue: "AIS disruption",
          }),
          note: transportState?.aisDisruption?.note,
          countLabel: transportState?.aisDisruption?.countLabel,
          tone: transportState?.aisDisruption?.tone,
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
  transportState,
}: {
  t: WarMapTranslateFn;
  showMonitors: boolean;
  showFlights: boolean;
  showAis: boolean;
  effectiveAisMode: WarMapAisMode;
  activePointLayers: WarMapActivePointLayerLegendItem[];
  transportState?: WarMapTransportLegendState;
}): WarMapLegendSection[] {
  const sections: WarMapLegendSection[] = [
    {
      key: "signals",
      title: t("dashboard.charts.warMap.legend.signalsTitle", {
        defaultValue: "Signals",
      }),
      description: t("dashboard.charts.warMap.legend.signalsHint", {
        defaultValue: "Color indicates urgency.",
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
      key: "transport",
      title: t("dashboard.charts.warMap.legend.transportTitle", {
        defaultValue: "Air & Sea",
      }),
      description: t("dashboard.charts.warMap.legend.transportHint", {
        defaultValue:
          "Aircraft, vessels, density zones, and disruptions use dedicated shapes.",
      }),
      statusLabel: transportState?.sectionStatusLabel,
      statusTone: transportState?.sectionStatusTone,
      statusHint: transportState?.sectionStatusHint,
      defaultExpanded: true,
      items: [],
    },
    {
      key: "news",
      title: t("dashboard.charts.warMap.legend.newsTitle", {
        defaultValue: "News & Monitoring",
      }),
      description: t("dashboard.charts.warMap.legend.newsHint", {
        defaultValue:
          "Solid marks are precise locations; hollow marks are fallback locations.",
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
      note: transportState?.flights?.note,
      countLabel: transportState?.flights?.countLabel,
      tone: transportState?.flights?.tone,
      matchSymbolKeys: ["flight"],
    });
  }

  if (showAis) {
    if (effectiveAisMode === "density") {
      transportItems.push({
        key: "ais-density",
        symbolKey: "ais-density",
        label: resolveWarMapLegendLabel("ais-density", t),
        note: transportState?.aisPrimary?.note,
        countLabel: transportState?.aisPrimary?.countLabel,
        tone: transportState?.aisPrimary?.tone,
        matchSymbolKeys: ["ais-density"],
      });
    }

    transportItems.push(
      {
        key: "ais-disruption-high",
        symbolKey: "ais-disruption-high",
        label: resolveWarMapLegendLabel("ais-disruption-high", t),
        note: transportState?.aisDisruption?.note,
        countLabel: transportState?.aisDisruption?.countLabel,
        tone: transportState?.aisDisruption?.tone,
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
          note:
            effectiveAisMode === "military"
              ? transportState?.aisPrimary?.note
              : undefined,
          countLabel:
            effectiveAisMode === "military"
              ? transportState?.aisPrimary?.countLabel
              : undefined,
          tone:
            effectiveAisMode === "military"
              ? transportState?.aisPrimary?.tone
              : undefined,
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
    const transportSection = sections.find(
      (section) => section.key === "transport",
    );
    if (transportSection) {
      transportSection.items = transportItems;
    }
  } else {
    const transportSectionIndex = sections.findIndex(
      (section) => section.key === "transport",
    );
    if (transportSectionIndex >= 0) {
      sections.splice(transportSectionIndex, 1);
    }
  }

  if (activePointLayers.length > 0) {
    sections.push({
      key: "other-point-layers",
      title: t("dashboard.charts.warMap.legend.otherLayersTitle", {
        defaultValue: "Other Active Point Layers",
      }),
      description: t("dashboard.charts.warMap.legend.otherLayersHint", {
        defaultValue:
          "Custom point overlays reuse the shared map symbol style.",
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

export function buildWarMapInteractionLegendItems({
  t,
}: {
  t: WarMapTranslateFn;
}): WarMapLegendItem[] {
  return [
    {
      key: "hover",
      symbolKey: "signal-medium",
      state: "hover",
      label: t("dashboard.charts.warMap.legend.hoverState", {
        defaultValue: "Hover preview",
      }),
      matchSymbolKeys: ["signal-medium"],
    },
    {
      key: "selected",
      symbolKey: "signal-medium",
      state: "selected",
      label: t("dashboard.charts.warMap.legend.selectedState", {
        defaultValue: "Pinned focus",
      }),
      matchSymbolKeys: ["signal-medium"],
    },
    {
      key: "cluster",
      symbolKey: "signal-medium",
      state: "cluster",
      countLabel: "12",
      label: t("dashboard.charts.warMap.legend.clusterState", {
        defaultValue: "Cluster",
      }),
      matchSymbolKeys: ["signal-medium"],
    },
  ];
}

export function formatWarMapClusterCountLabel(count: number): string {
  if (!Number.isFinite(count)) {
    return "";
  }
  const normalizedCount = Math.max(0, Math.round(count));
  if (normalizedCount === 0) {
    return "";
  }
  if (normalizedCount > 999) {
    return "999+";
  }
  return String(normalizedCount);
}

export function WarMapLegendSwatch({
  symbolKey,
  label,
  note,
  state = "default",
  tone = "default",
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
  const iconMarkup = getWarMapLegendSvgMarkup({
    symbolKey,
    state,
    accentColor,
  });
  const containerClassName =
    variant === "quick"
      ? `flex min-w-0 items-center gap-2.5 rounded-[14px] border px-2.5 py-2 text-left transition-[border-color,background-color,box-shadow,transform,opacity] duration-150 ${
          active
            ? "border-slate-300/90 bg-white/[0.96] shadow-[0_12px_22px_-20px_rgba(15,23,42,0.2)] dark:border-slate-500/70 dark:bg-slate-950/[0.86]"
            : "border-slate-200/75 bg-white/[0.72] dark:border-slate-700/70 dark:bg-slate-950/[0.52]"
        } ${
          tone === "degraded"
            ? "border-amber-200/90 bg-amber-50/80 dark:border-amber-400/30 dark:bg-amber-950/22"
            : ""
        } ${muted ? "opacity-55" : "opacity-100"} ${
          interactive
            ? "hover:border-slate-300/85 hover:bg-white/[0.9] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.7]"
            : ""
        }`
      : `flex min-w-0 items-center gap-3 rounded-[18px] border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,opacity] duration-150 ${
          active
            ? "border-slate-300 bg-white shadow-[0_14px_28px_-24px_rgba(15,23,42,0.18)] dark:border-slate-500/75 dark:bg-slate-950/82"
            : "border-slate-200/80 bg-white/[0.76] dark:border-slate-700/80 dark:bg-slate-950/[0.54]"
        } ${
          tone === "degraded"
            ? "border-amber-200/90 bg-amber-50/75 dark:border-amber-400/28 dark:bg-amber-950/20"
            : ""
        } ${muted ? "opacity-50" : "opacity-100"} ${
          interactive
            ? "hover:border-slate-300/90 hover:bg-white/[0.9] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.72]"
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
