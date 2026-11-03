/**
 * intel-geojson.ts — 把我们的战争地图「事件」与「新闻标记」转换成 GEV 本地
 * GeoJSON 图层能直接读取的 GeoJSON Lines（每行一个 Feature）。
 *
 * 纯逻辑，无 React / 无 GEV / 无网络。坐标约定为 `[lon, lat]`；字段名以
 * `@modular/utils` 的 `WarMapEvent` / `WarMapNewsMarker` 实际类型为准。
 */
import type { WarMapEvent, WarMapNewsMarker } from "@modular/utils";

import { safeHttpUrl } from "@/lib/url";

export type IntelGeojsonLocale = "zh-CN" | "en" | "en-US";

export interface IntelGeojsonOptions {
  /** 当前语言；中文时优先使用 `nameZh` / `titleZh`。 */
  locale?: IntelGeojsonLocale | string;
  /** 控制台地址前缀（通常为空，即同源相对路径）。 */
  consoleBase?: string;
}

/** 每类最多上图点数。 */
export const INTEL_MAX_POINTS = 2000;
/** 标题最多字数。 */
export const INTEL_MAX_NAME = 80;
/** 摘要最多字数。 */
export const INTEL_MAX_SUMMARY = 200;

interface IntelFeatureProperties {
  name: string;
  /** 事件图层其实按国家/地区聚合，故用 `region`；新闻用 `news`。 */
  kind: "region" | "news";
  severity?: string;
  time: string;
  summary: string;
  /** 地区：指向该地区事件列表（或无可靠筛选时的站内搜索）。新闻没有此项。 */
  consoleUrl?: string;
  /** 新闻：原文地址（仅合法的 http(s)）。 */
  url?: string;
  /** 新闻：地点（按 locale 选择中文优先）。 */
  location?: string;
  newweiId: string;
  /** 地区：国家代码（即事件 id）。 */
  countryCode?: string;
  newsCount?: number;
  alertCount?: number;
  /** 地区：热度（derivedScore）。 */
  score?: number;
}

interface IntelFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: IntelFeatureProperties;
}

function isZhLocale(locale: string | undefined): boolean {
  return String(locale ?? "")
    .toLowerCase()
    .startsWith("zh");
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 单行化（换行替换为空格）+ 截断到 `max` 个码点。 */
export function clampIntelText(value: unknown, max: number): string {
  const collapsed = asText(value).replace(/\r\n?|\n/g, " ");
  const chars = Array.from(collapsed);
  return chars.length > max ? chars.slice(0, max).join("") : collapsed;
}

function clampUrlBase(base: string | undefined): string {
  const trimmed = String(base ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  return trimmed.replace(/\/+$/, "");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 合法经纬度：有限值且在 WGS84 范围内。 */
export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    isFiniteNumber(lat) &&
    isFiniteNumber(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function severityRank(severity: unknown): number {
  return SEVERITY_RANK[String(severity ?? "").toLowerCase()] ?? 0;
}

function eventTitle(event: WarMapEvent, zh: boolean): string {
  if (zh) {
    const zhName = (event as { nameZh?: unknown }).nameZh;
    const text = asText(zhName);
    if (text.trim()) return text;
  }
  return asText(event.name);
}

function newsTitle(marker: WarMapNewsMarker, zh: boolean): string {
  if (zh) {
    const zhTitle = (marker as { titleZh?: unknown }).titleZh;
    const text = asText(zhTitle);
    if (text.trim()) return text;
  }
  return asText(marker.title);
}

/** 地点：中文时优先 `locationZh`，否则用 `location`。 */
function newsLocation(marker: WarMapNewsMarker, zh: boolean): string {
  if (zh) {
    const zhLocation = (marker as { locationZh?: unknown }).locationZh;
    const text = asText(zhLocation);
    if (text.trim()) return text;
  }
  return asText(marker.location);
}

/**
 * 「该地区事件」链接。`/events?entity=` 的 `entity` 由 api-go 的 newsEvents
 * 解析为对 `primaryEntity` 的**精确匹配**（`graphqlread/newsevents/store.go`
 * 的 `AND primaryEntity = ?`），而这里的事件 name 是国家/地区的地理英文名，
 * 并不等于事件的主实体，无法可靠筛出该地区的事件。因此退回站内搜索。
 */
function regionEventsUrl(base: string, name: string): string {
  const term = asText(name).trim();
  return `${base}/search?q=${encodeURIComponent(term)}`;
}

function newsTime(marker: WarMapNewsMarker): string {
  return asText(marker.publishedAt) || asText(marker.ingestedAt);
}

function newsTimeMs(marker: WarMapNewsMarker): number {
  const value = newsTime(marker);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toFeature(feature: IntelFeature): string {
  return JSON.stringify(feature);
}

/**
 * 事件 → GeoJSONL。丢弃无效坐标的点；按严重程度降序排序后最多截断到
 * `INTEL_MAX_POINTS` 个。
 */
export function eventsToGeojsonl(
  events: WarMapEvent[],
  opts: IntelGeojsonOptions = {},
): string {
  const zh = isZhLocale(opts.locale);
  const base = clampUrlBase(opts.consoleBase);

  const sorted = [...events]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const rankDiff = severityRank(b.event.severity) - severityRank(a.event.severity);
      if (rankDiff !== 0) return rankDiff;
      const scoreDiff =
        (Number(b.event.derivedScore) || 0) - (Number(a.event.derivedScore) || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return a.index - b.index;
    })
    .map(({ event }) => event);

  const lines: string[] = [];
  for (const event of sorted) {
    if (lines.length >= INTEL_MAX_POINTS) break;
    if (!isValidCoordinate(event.lat, event.lng)) continue;
    const id = asText(event.id);
    if (!id) continue;
    const summarySource = (event as { summary?: unknown }).summary;
    const countryCode = id;
    lines.push(
      toFeature({
        type: "Feature",
        id: `evt:${id}`,
        geometry: {
          type: "Point",
          coordinates: [event.lng, event.lat],
        },
        properties: {
          name: clampIntelText(eventTitle(event, zh), INTEL_MAX_NAME),
          kind: "region",
          severity: asText(event.severity),
          time: asText(event.latestAt),
          summary: clampIntelText(summarySource, INTEL_MAX_SUMMARY),
          consoleUrl: regionEventsUrl(base, asText(event.name)),
          newweiId: id,
          countryCode,
          newsCount: isFiniteNumber(event.newsCount) ? event.newsCount : 0,
          alertCount: isFiniteNumber(event.alertCount) ? event.alertCount : 0,
          score: isFiniteNumber(event.derivedScore) ? event.derivedScore : 0,
        },
      }),
    );
  }
  return lines.join("\n");
}

/**
 * 新闻标记 → GeoJSONL。丢弃无效坐标的点；按时间倒序排序后最多截断到
 * `INTEL_MAX_POINTS` 个。没有可用的站内详情页，故只带原文 `url`（合法
 * http(s) 才保留）与地点，不再生成 `consoleUrl`。
 */
export function newsMarkersToGeojsonl(
  markers: WarMapNewsMarker[],
  opts: IntelGeojsonOptions = {},
): string {
  const zh = isZhLocale(opts.locale);

  const sorted = [...markers]
    .map((marker, index) => ({ marker, index, time: newsTimeMs(marker) }))
    .sort((a, b) => {
      if (b.time !== a.time) return b.time - a.time;
      return a.index - b.index;
    })
    .map(({ marker }) => marker);

  const lines: string[] = [];
  for (const marker of sorted) {
    if (lines.length >= INTEL_MAX_POINTS) break;
    if (!isValidCoordinate(marker.lat, marker.lng)) continue;
    const id = asText(marker.id);
    if (!id) continue;
    const summarySource =
      (marker as { summary?: unknown }).summary ?? marker.location;
    const url = safeHttpUrl(marker.url);
    lines.push(
      toFeature({
        type: "Feature",
        id: `news:${id}`,
        geometry: {
          type: "Point",
          coordinates: [marker.lng, marker.lat],
        },
        properties: {
          name: clampIntelText(newsTitle(marker, zh), INTEL_MAX_NAME),
          kind: "news",
          time: newsTime(marker),
          summary: clampIntelText(summarySource, INTEL_MAX_SUMMARY),
          location: clampIntelText(newsLocation(marker, zh), INTEL_MAX_SUMMARY),
          ...(url ? { url } : {}),
          newweiId: id,
        },
      }),
    );
  }
  return lines.join("\n");
}
