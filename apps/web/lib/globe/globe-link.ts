/**
 * globe-link.ts — 「在 3D 地球查看」的 URL 约定（纯逻辑，可测试）。
 *
 * `/globe?lat=<lat>&lon=<lon>&label=<标题>&focus=<layerId>:<newweiId>`
 */
export const GLOBE_LABEL_MAX = 80;

export interface GlobeFocus {
  layerId: string;
  newweiId: string;
}

export interface GlobeHrefInput {
  lat?: number | null;
  lon?: number | null;
  label?: string | null;
  focus?: GlobeFocus | null;
}

export interface GlobeParams {
  lat?: number;
  lon?: number;
  label?: string;
  focus?: GlobeFocus;
}

/** 合法经纬度：有限值且在 WGS84 范围内。 */
export function isValidLatLon(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
  );
}

/** 标题压缩为单行并截断到 `GLOBE_LABEL_MAX` 个码点。 */
export function truncateGlobeLabel(label: unknown): string {
  const text =
    typeof label === "string"
      ? label.replace(/\r\n?|\n/g, " ").trim()
      : typeof label === "number" && Number.isFinite(label)
        ? String(label)
        : "";
  const chars = Array.from(text);
  return chars.length > GLOBE_LABEL_MAX
    ? chars.slice(0, GLOBE_LABEL_MAX).join("")
    : text;
}

/** 构造 `/globe` 链接；无效坐标被丢弃，缺省返回 `/globe`。 */
export function buildGlobeHref(input: GlobeHrefInput = {}): string {
  const params = new URLSearchParams();
  const { lat, lon } = input;

  if (isValidLatLon(lat, lon)) {
    params.set("lat", String(lat));
    params.set("lon", String(lon));
  }

  const label = truncateGlobeLabel(input.label);
  if (label) params.set("label", label);

  const focus = input.focus;
  if (focus && focus.layerId && focus.newweiId) {
    params.set("focus", `${focus.layerId}:${focus.newweiId}`);
  }

  const query = params.toString();
  return query ? `/globe?${query}` : "/globe";
}

interface ReadonlySearchParams {
  get(key: string): string | null;
}

/** 解析 `/globe` 查询参数；坐标与 focus 都按约定校验。 */
export function parseGlobeParams(
  searchParams: ReadonlySearchParams,
): GlobeParams {
  const result: GlobeParams = {};

  const rawLat = searchParams.get("lat");
  const rawLon = searchParams.get("lon");
  if (rawLat !== null && rawLon !== null && rawLat.trim() && rawLon.trim()) {
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (isValidLatLon(lat, lon)) {
      result.lat = lat;
      result.lon = lon;
    }
  }

  const rawLabel = searchParams.get("label");
  if (rawLabel !== null) {
    const label = truncateGlobeLabel(rawLabel);
    if (label) result.label = label;
  }

  const rawFocus = searchParams.get("focus");
  if (rawFocus) {
    const separator = rawFocus.indexOf(":");
    if (separator > 0) {
      const layerId = rawFocus.slice(0, separator);
      const newweiId = rawFocus.slice(separator + 1);
      if (layerId && newweiId) result.focus = { layerId, newweiId };
    }
  }

  return result;
}
