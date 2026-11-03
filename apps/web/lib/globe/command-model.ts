/**
 * command-model.ts — 命令坞的纯逻辑（不依赖 GEV / React / Cesium）。
 *
 * 风格与按键顺序移植自 GEV：
 * - `ui/applicationShortcuts.js` 的 `STYLE_KEYS`（1–6）
 * - `ui/views/CommandDockView.vue` 的 6 个 style 按钮（normal / retro /
 *   surveillance / thermal / anime / noir）
 * - `maps/catalog.js` 的 `MAP_STACKS`（只取 photoreal / esri-imagery / osm；
 *   bing-aerial / bing-labels 需要 Cesium ion，我们没有令牌，不显示）
 */

export type GlobeStyleId =
  | "normal"
  | "retro"
  | "surveillance"
  | "thermal"
  | "anime"
  | "noir";

export interface GlobeStyleOption {
  id: GlobeStyleId;
  /** 键盘快捷键（`ui/applicationShortcuts.js` 的 1–6）。 */
  key: string;
  labelKey: string;
}

/** 顺序与按键和 GEV `STYLE_KEYS` 一致。 */
export const GLOBE_STYLES: readonly GlobeStyleOption[] = [
  { id: "normal", key: "1", labelKey: "globe.styles.normal" },
  { id: "retro", key: "2", labelKey: "globe.styles.retro" },
  { id: "surveillance", key: "3", labelKey: "globe.styles.surveillance" },
  { id: "thermal", key: "4", labelKey: "globe.styles.thermal" },
  { id: "anime", key: "5", labelKey: "globe.styles.anime" },
  { id: "noir", key: "6", labelKey: "globe.styles.noir" },
];

export type GlobeMapStackId = "photoreal" | "esri-imagery" | "osm";

export interface GlobeMapStackOption {
  id: GlobeMapStackId;
  labelKey: string;
  /** `photoreal`（Google 3D）需要浏览器端 Google Maps 密钥。 */
  requiresGoogleKey: boolean;
}

/** 只保留不需要 Cesium ion 令牌的底图栈（`maps/catalog.js`）。 */
export const GLOBE_MAP_STACKS: readonly GlobeMapStackOption[] = [
  {
    id: "photoreal",
    labelKey: "globe.mapStacks.photoreal",
    requiresGoogleKey: true,
  },
  {
    id: "esri-imagery",
    labelKey: "globe.mapStacks.esri-imagery",
    requiresGoogleKey: false,
  },
  { id: "osm", labelKey: "globe.mapStacks.osm", requiresGoogleKey: false },
];

/** 把按键（"1"–"6"）映射到风格 id。 */
export function styleIdForKey(key: string): GlobeStyleId | undefined {
  return GLOBE_STYLES.find((style) => style.key === key)?.id;
}

export function isGlobeStyleId(value: string): value is GlobeStyleId {
  return GLOBE_STYLES.some((style) => style.id === value);
}

export interface CoordinateQuery {
  lat: number;
  lon: number;
  /** 即时预览文案里的坐标部分，如 `31.2300, 121.4700`。 */
  label: string;
}

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const PAIR = new RegExp(`^\\s*(${NUMBER})\\s*[,;]\\s*(${NUMBER})\\s*$`);
const SPACED_PAIR = new RegExp(`^\\s*(${NUMBER})\\s+(${NUMBER})\\s*$`);
const GEO_URI = new RegExp(
  `^geo:(${NUMBER}),(${NUMBER})(?:;crs=wgs84)?$`,
  "i",
);

/**
 * 识别 `lat, lon`、`lat lon`、`geo:lat,lon` 三种十进制坐标写法。
 *
 * 只用于搜索框的**即时预览**（命中时直接显示「飞到 …」、不发请求）；
 * 真正的飞行仍由 GEV 的 placeSearch 处理。任何含糊或越界的输入一律
 * 返回 null，避免把 `12junk, 34oops` 猜成坐标。
 */
export function parseCoordinateQuery(query: string): CoordinateQuery | null {
  if (typeof query !== "string") return null;
  const text = query.trim();
  if (!text) return null;

  const geo = GEO_URI.exec(text);
  let latText: string | undefined;
  let lonText: string | undefined;
  if (geo) {
    [, latText, lonText] = geo;
  } else {
    const pair = PAIR.exec(text) ?? SPACED_PAIR.exec(text);
    if (!pair) return null;
    [, latText, lonText] = pair;
  }

  const lat = Number(latText);
  const lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;

  return {
    lat,
    lon,
    label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
  };
}

/** 由 geocoder 返回的 `types` 归纳出结果项的 kicker 类型。 */
export function placeKindFromTypes(types?: readonly string[] | null): string {
  const set = new Set((types ?? []).map((type) => String(type).toLowerCase()));
  if (set.has("coordinate")) return "coordinate";
  if (set.has("locality") || set.has("postal_town")) return "city";
  if (
    set.has("country") ||
    set.has("administrative_area_level_1") ||
    set.has("administrative_area_level_2")
  ) {
    return "region";
  }
  if (
    set.has("point_of_interest") ||
    set.has("establishment") ||
    set.has("premise")
  ) {
    return "landmark";
  }
  return "place";
}
