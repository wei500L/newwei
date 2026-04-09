import type { StyleSpecification } from "maplibre-gl";

export const LIGHT_MAP_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
export const DARK_MAP_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
export const MAP_STYLE_URL = LIGHT_MAP_STYLE_URL;

export function resolveMapStyleUrl(isDark: boolean): string {
  return isDark ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

export const MAP_STYLE_FALLBACK: StyleSpecification = {
  version: 8,
  name: "offline-fallback",
  sources: {},
  layers: [
    {
      id: "offline-background",
      type: "background",
      paint: {
        "background-color": "#f5f7fb",
      },
    },
  ],
};

export const DEFAULT_WORLD_BBOX: [number, number, number, number] = [
  -180, -85, 180, 85,
];
