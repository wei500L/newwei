/**
 * War Map 符号 SVG 公共装配（FE-批4B 收口：纯实现拆至 primitives/glyphs）。
 *
 * 本文件保留 war-map-symbol-icons.ts 依赖的稳定出口（常量/类型/
 * toSvgDataUrl/buildSymbolSvg），SVG 生成语义与拆分前逐字一致：
 * 纯字符串、不依赖 React、无 "use client"。
 */
import { buildSymbolBody } from "./war-map-symbol-glyphs";
import {
  buildStateMarkup,
  svgOpenTag,
  type SymbolPalette,
  type WarMapSymbolRenderTarget,
} from "./war-map-symbol-svg-primitives";
import type { WarMapSymbolKey, WarMapSymbolState } from "./war-map-symbol-types";

export {
  SYMBOL_GRID_SIZE,
  SYMBOL_ICON_ANCHOR,
  SYMBOL_ICON_SIZE,
  toSvgDataUrl,
  type SymbolPalette,
  type WarMapSymbolRenderTarget,
} from "./war-map-symbol-svg-primitives";

export function buildSymbolSvg({
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
