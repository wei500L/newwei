/**
 * War Map 符号 SVG 基础原语（FE-批4B 收口：自 war-map-symbol-svg.ts 拆出）。
 *
 * 画布常量、渲染目标与调色板类型、data URL 转换、SVG open tag、stroke
 * helper 与 circular/plate/state 标记：纯字符串生成，不依赖 React。
 */
import { mixHex, withAlpha } from "./war-map-symbol-color";
import type { WarMapSymbolState } from "./war-map-symbol-types";

export const SYMBOL_GRID_SIZE = 24;
export const SYMBOL_ICON_SIZE = 48;
export const SYMBOL_ICON_ANCHOR = SYMBOL_ICON_SIZE / 2;

export type WarMapSymbolRenderTarget = "map" | "legend";

export interface SymbolPalette {
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

export const WHITE = "#ffffff";

export function toSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function svgOpenTag(target: WarMapSymbolRenderTarget): string {
  const size = target === "map" ? SYMBOL_ICON_SIZE : SYMBOL_GRID_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${SYMBOL_GRID_SIZE} ${SYMBOL_GRID_SIZE}" fill="none">`;
}

export function strokeAttrs(width: number, color: string): string {
  return `stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
}

export function mapStrokeCircle(
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

export function buildStateMarkup({
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
