/**
 * War Map 符号调色板与 Deck icon 缓存（FE-批4B：自 war-map-symbols.tsx 拆出）。
 *
 * icon cache 的唯一所有者：key 为 symbolKey:state:accent（accent 仅
 * generic-point 参与），相同输入命中同一缓存对象。
 */
import { coerceHexColor } from "./war-map-symbol-color";
import {
  buildSymbolSvg,
  SYMBOL_ICON_ANCHOR,
  SYMBOL_ICON_SIZE,
  toSvgDataUrl,
  type SymbolPalette,
} from "./war-map-symbol-svg";
import type { WarMapSymbolKey, WarMapSymbolState } from "./war-map-symbol-types";

export interface DeckIconDefinition {
  url: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  mask: false;
}

const symbolIconCache = new Map<string, DeckIconDefinition>();

export function resolvePalette(
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
