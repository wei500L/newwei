/**
 * event-coordinates.ts — 从事件详情数据里解析可用于「在 3D 地球查看」的坐标。
 *
 * 事件详情页的 GraphQL `NewsEventModel` 只有 `metadata`（任意 JSON）可能携带
 * 位置信息，不同生成路径写进去的字段名不完全一致，所以这里按常见形状做
 * 只读兼容：`metadata.{lat,lng}`、`{latitude,longitude}`、`geo.*`、`location.*`、
 * `coordinates`（数组或对象），以及顶层同名字段。无效值返回 null。
 */
export interface EventCoordinateSource {
  metadata?: unknown;
  lat?: unknown;
  lng?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

export interface EventCoordinates {
  lat: number;
  lon: number;
}

function isValid(lat: unknown, lon: unknown): boolean {
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

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fromLatLngObject(value: unknown): EventCoordinates | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const lat = toNumber(record.lat ?? record.latitude);
  const lon = toNumber(record.lng ?? record.lon ?? record.longitude);
  return lat !== null && lon !== null && isValid(lat, lon)
    ? { lat, lon }
    : null;
}

/** 解析事件坐标；没有可用的合法坐标时返回 null。 */
export function resolveEventCoordinates(
  event: EventCoordinateSource | null | undefined,
): EventCoordinates | null {
  if (!event) return null;

  // 1) 顶层字段（部分数据源直接平铺经纬度）。
  const topLat = toNumber(event.lat ?? event.latitude);
  const topLon = toNumber(event.lng ?? event.longitude);
  if (topLat !== null && topLon !== null && isValid(topLat, topLon)) {
    return { lat: topLat, lon: topLon };
  }

  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;

  // 2) metadata 平铺与常见嵌套对象。
  const candidates: unknown[] = [
    record,
    record.geo,
    record.location,
    record.coordinates,
    record.centroid,
  ];
  for (const candidate of candidates) {
    const parsed = fromLatLngObject(candidate);
    if (parsed) return parsed;
  }

  // 3) GeoJSON 风格的 coordinates: [lon, lat]。
  const coordinates = record.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    const lon = toNumber(coordinates[0]);
    const lat = toNumber(coordinates[1]);
    if (lat !== null && lon !== null && isValid(lat, lon)) {
      return { lat, lon };
    }
  }

  return null;
}
