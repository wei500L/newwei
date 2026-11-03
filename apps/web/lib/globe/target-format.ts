/**
 * target-format.ts — 目标详情卡的纯格式化逻辑。
 *
 * 输入是 GEV 上下文记录（`data/contextStore.js` 里 `registerEntityContext` /
 * `selectTrackedSubjectContext` 存下来的对象），输出卡片视图模型。
 * 各图层的字段名以源码里注册 metadata 的调用点为准：
 * - flights: `layers/flights/tracking.js:86-140`
 * - military: `layers/military/tracking.js:94-140`
 * - satellites: `layers/satellites/tracking.js:221-252`
 * - ais-live-vessels: `layers/vessels/selection.js:203-223`
 * - local-firms: `layers/firms/selection.js:190-210`
 * - local-adsb: `layers/localAdsb/index.js:298-327`
 * - installations: `layers/installations/rendering.js:282-303`
 * - ALPR: `layers/alpr/presentation.js:448-468`
 * - 通用 GeoJSON（地震等）：`data/localGeojsonCore.js:692-706`
 */
import { formatTimestamp, type SupportedLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

export interface TargetField {
  labelKey: string;
  value: string;
  mono?: boolean;
  /** G6：状态类字段的 antd Tag 颜色（error / warning）；低严重度不传。 */
  tagColor?: "error" | "warning" | "default";
}

export interface TargetLink {
  labelKey: string;
  href: string;
}

/** G6：详情卡的主按钮（跳回控制台的事件 / 新闻详情，或打开原文）。 */
export interface TargetConsoleAction {
  labelKey: string;
  href: string;
  /** G6：为 true 时是外部原文，用新标签页打开，不走站内路由。 */
  external?: boolean;
}

export interface TargetView {
  kindKey: string;
  title: string;
  subtitle: string;
  fields: TargetField[];
  links: TargetLink[];
  position?: { lat: number; lon: number; altM?: number };
  /** 图层 id（卡片头部用它把英文图层名翻成当前语言）。 */
  layerId: string;
  /** G6：主按钮；默认格式化器不设置。 */
  console?: TargetConsoleAction;
}

export type TargetRecord = Record<string, unknown>;

export interface FormatTargetOptions {
  locale?: SupportedLocale;
}

const KIND_KEYS: Record<string, string> = {
  flights: "globe.target.kinds.flights",
  military: "globe.target.kinds.military",
  "local-adsb": "globe.target.kinds.adsb",
  "ais-live-vessels": "globe.target.kinds.vessel",
  satellites: "globe.target.kinds.satellite",
  earthquakes: "globe.target.kinds.earthquake",
  "local-firms": "globe.target.kinds.firm",
  cctv: "globe.target.kinds.cctv",
  "military-installations": "globe.target.kinds.installation",
  "alpr-cameras": "globe.target.kinds.alpr",
  "newwei-intel": "globe.target.kinds.intel",
  "newwei-events": "globe.target.kinds.region",
  "newwei-news": "globe.target.kinds.news",
};

const GENERIC_EXCLUDE = new Set(["entity", "id", "layerId"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function props(record: TargetRecord): Record<string, unknown> {
  return isPlainObject(record.properties) ? record.properties : {};
}

function pushField(
  fields: TargetField[],
  labelKey: string,
  value: unknown,
  options: { mono?: boolean; suffix?: string } = {},
): void {
  const rendered = text(value);
  if (!rendered) return;
  fields.push({
    labelKey,
    value: options.suffix ? `${rendered}${options.suffix}` : rendered,
    ...(options.mono ? { mono: true } : {}),
  });
}

/** "35000 ft" / "12000 m" → 米；无法识别时返回 null。 */
function parseAltitudeM(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = /(-?\d+(?:\.\d+)?)\s*(ft|feet|m|km)?/i.exec(
    value.replace(/,/g, ""),
  );
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "m").toLowerCase();
  if (unit === "ft" || unit === "feet") return Math.round(amount * 0.3048);
  if (unit === "km") return Math.round(amount * 1000);
  return Math.round(amount);
}

function positionOf(record: TargetRecord): TargetView["position"] | undefined {
  const p = props(record);
  const lat = numberOf(record.latitude ?? p.latitude);
  const lon = numberOf(record.longitude ?? p.longitude);
  if (lat === null || lon === null) return undefined;
  const feet = numberOf(p.altitudeFt);
  const altM =
    numberOf(record.altitudeM ?? p.altitudeM) ??
    parseAltitudeM(p.altitude) ??
    (feet === null ? null : Math.round(feet * 0.3048));
  return altM === null ? { lat, lon } : { lat, lon, altM };
}

function collectLinks(record: TargetRecord): TargetLink[] {
  const p = props(record);
  const sources: [Record<string, unknown>, string][] = [
    [record, "globe.target.links.external"],
    [p, "globe.target.links.external"],
  ];
  const links: TargetLink[] = [];
  const seen = new Set<string>();
  const push = (href: string, labelKey: string) => {
    if (!/^https?:\/\//i.test(href) || seen.has(href)) return;
    seen.add(href);
    links.push({ labelKey, href });
  };
  for (const [source, externalKey] of sources) {
    for (const [key, value] of Object.entries(source)) {
      const href = text(value);
      if (!href) continue;
      const normalized = key.toLowerCase();
      if (
        normalized === "flightaware" ||
        normalized === "flightawareurl" ||
        normalized === "flightaware_url"
      ) {
        push(href, "globe.target.links.flightaware");
      } else if (
        normalized === "marinetraffic" ||
        normalized === "marinetrafficurl" ||
        normalized === "marinetraffic_url"
      ) {
        push(href, "globe.target.links.marinetraffic");
      } else if (
        ["url", "link", "href", "website", "homepage", "externalurl"].includes(
          normalized,
        )
      ) {
        push(href, externalKey);
      }
    }
  }
  return links;
}

function baseTitle(record: TargetRecord): string {
  const p = props(record);
  return (
    text(record.label) ||
    text(p.name) ||
    text(p.callsign) ||
    text(record.id) ||
    "—"
  );
}

function formatAircraft(record: TargetRecord, layerId: string): TargetView {
  const p = props(record);
  const title = baseTitle(record);
  const fields: TargetField[] = [];
  pushField(fields, "globe.target.field.callsign", p.callsign);
  pushField(fields, "globe.target.field.registration", p.registration);
  pushField(
    fields,
    "globe.target.field.aircraftType",
    p.type || p.typeName || p.typeCode || p.category,
  );
  pushField(fields, "globe.target.field.altitude", p.altitude, { mono: true });
  if (!text(p.altitude)) {
    pushField(fields, "globe.target.field.altitude", p.altitudeFt, {
      mono: true,
      suffix: " ft",
    });
  }
  pushField(fields, "globe.target.field.speed", p.speed, { mono: true });
  if (!text(p.speed)) {
    pushField(fields, "globe.target.field.speed", p.groundSpeedKt, {
      mono: true,
      suffix: " kt",
    });
  }
  pushField(fields, "globe.target.field.heading", p.heading, { mono: true });
  if (!text(p.heading)) {
    pushField(fields, "globe.target.field.heading", p.trackDeg, {
      mono: true,
      suffix: "°",
    });
  }
  pushField(fields, "globe.target.field.route", p.route);
  pushField(fields, "globe.target.field.operator", p.operator);

  return {
    kindKey: KIND_KEYS[layerId] ?? "globe.target.kinds.flights",
    title,
    subtitle: text(p.registration) || text(p.type) || text(p.operator),
    fields,
    links: collectLinks(record),
    position: positionOf(record),
    layerId,
  };
}

function formatVessel(record: TargetRecord): TargetView {
  const p = props(record);
  const fields: TargetField[] = [];
  pushField(fields, "globe.target.field.mmsi", p.mmsi, { mono: true });
  pushField(fields, "globe.target.field.vesselType", p.type);
  pushField(fields, "globe.target.field.speed", p.speedKt, {
    mono: true,
    suffix: " kn",
  });
  pushField(fields, "globe.target.field.course", p.course, {
    mono: true,
    suffix: "°",
  });
  pushField(fields, "globe.target.field.destination", p.destination);

  return {
    kindKey: KIND_KEYS["ais-live-vessels"] ?? "globe.target.kinds.vessel",
    title: baseTitle(record),
    subtitle: text(p.type) || text(p.mmsi),
    fields,
    links: collectLinks(record),
    position: positionOf(record),
    layerId: "ais-live-vessels",
  };
}

function formatSatellite(record: TargetRecord): TargetView {
  const p = props(record);
  const fields: TargetField[] = [];
  pushField(fields, "globe.target.field.noradId", p.noradId, { mono: true });
  pushField(fields, "globe.target.field.class", p.class);
  pushField(fields, "globe.target.field.orbitAltitude", p.altitude, {
    mono: true,
  });

  return {
    kindKey: KIND_KEYS.satellites ?? "globe.target.kinds.satellite",
    title: text(p.name) || baseTitle(record),
    subtitle: text(p.class) || text(p.noradId),
    fields,
    links: collectLinks(record),
    position: positionOf(record),
    layerId: "satellites",
  };
}

function formatEarthquake(
  record: TargetRecord,
  locale: SupportedLocale,
): TargetView {
  const p = props(record);
  const magnitude = numberOf(p.mag);
  const time = p.time ?? p.timeMs ?? p.occurredAt;
  const fields: TargetField[] = [];
  pushField(fields, "globe.target.field.magnitude", p.mag, { mono: true });
  pushField(fields, "globe.target.field.depth", p.depth, {
    mono: true,
    suffix: " km",
  });
  pushField(fields, "globe.target.field.place", p.place);
  if (time !== undefined && time !== null && text(time) !== "") {
    const numeric = numberOf(time);
    const value = numeric !== null ? formatTimestamp(numeric, locale) : text(time);
    if (value) fields.push({ labelKey: "globe.target.field.time", value });
  }

  return {
    kindKey: KIND_KEYS.earthquakes ?? "globe.target.kinds.earthquake",
    title: text(p.place) || baseTitle(record),
    subtitle: magnitude === null ? "" : `M${magnitude.toFixed(1)}`,
    fields,
    links: collectLinks(record),
    position: positionOf(record),
    layerId: "earthquakes",
  };
}

function formatFirm(record: TargetRecord): TargetView {
  const p = props(record);
  const fields: TargetField[] = [];
  pushField(fields, "globe.target.field.frp", p.frp, {
    mono: true,
    suffix: " MW",
  });
  pushField(fields, "globe.target.field.confidence", p.confidence);
  pushField(fields, "globe.target.field.detectedAt", p.age ?? p.acquiredAt);
  pushField(fields, "globe.target.field.satellite", p.sensor ?? p.satellite);

  return {
    kindKey: KIND_KEYS["local-firms"] ?? "globe.target.kinds.firm",
    title: baseTitle(record),
    subtitle: text(p.sensor) || "",
    fields,
    links: collectLinks(record),
    position: positionOf(record),
    layerId: "local-firms",
  };
}

function formatCctv(
  record: TargetRecord,
  locale: SupportedLocale,
): TargetView {
  const p = props(record);
  const fields: TargetField[] = [];
  pushField(
    fields,
    "globe.target.field.cameraName",
    p.name ?? p.cameraName ?? record.label,
  );
  pushField(fields, "globe.target.field.agency", p.agency ?? p.source ?? record.source);
  const lastFrame =
    p.lastFrameAt ?? p.lastFrame ?? p.updatedAt ?? record.updatedAt;
  if (lastFrame !== undefined && lastFrame !== null && text(lastFrame) !== "") {
    const numeric = numberOf(lastFrame);
    const value =
      numeric !== null ? formatTimestamp(numeric, locale) : text(lastFrame);
    if (value) fields.push({ labelKey: "globe.target.field.lastFrame", value });
  }

  return {
    kindKey: KIND_KEYS.cctv ?? "globe.target.kinds.cctv",
    title: text(p.name) || text(p.cameraName) || baseTitle(record),
    subtitle: text(p.agency) || text(p.source) || text(record.source),
    fields,
    links: collectLinks(record),
    position: positionOf(record),
    layerId: "cctv",
  };
}

function formatGeneric(record: TargetRecord): TargetView {
  const source = isPlainObject(record.properties) ? record.properties : record;
  const entries = Object.entries(source)
    .filter(
      ([key, value]) =>
        !GENERIC_EXCLUDE.has(key) &&
        !key.startsWith("_") &&
        primitive(value) &&
        text(value) !== "",
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 12);

  const fields: TargetField[] = entries.map(([key, value]) => ({
    labelKey: key,
    value: text(value),
    ...(typeof value === "number" || typeof value === "boolean"
      ? { mono: true }
      : {}),
  }));

  const layerId = text(record.layerId);

  return {
    kindKey: KIND_KEYS[layerId] ?? "globe.target.kinds.unknown",
    title: baseTitle(record),
    subtitle: text(record.layerName),
    fields,
    links: collectLinks(record),
    position: positionOf(record),
    layerId,
  };
}

/** 严重程度 → Tag 颜色（高 error / 中 warning / 低不加色）。 */
function severityTone(severity: string): "error" | "warning" | undefined {
  if (severity === "high") return "error";
  if (severity === "medium") return "warning";
  return undefined;
}

function severityLabel(severity: string, zh: boolean): string {
  switch (severity) {
    case "high":
      return zh ? "高" : "High";
    case "medium":
      return zh ? "中" : "Medium";
    case "low":
      return zh ? "低" : "Low";
    default:
      return severity;
  }
}

/** 把时间值格式化为「发生时间」字段；空值不显示。 */
function pushTimeField(
  fields: TargetField[],
  value: unknown,
  locale: SupportedLocale,
): void {
  if (value === undefined || value === null || text(value) === "") return;
  const numeric = numberOf(value);
  const rendered =
    numeric !== null ? formatTimestamp(numeric, locale) : text(value);
  if (rendered) fields.push({ labelKey: "globe.target.field.time", value: rendered });
}

/**
 * G6：情报点（地区聚合 / 新闻）的详情格式化器。数据来自记录的 `properties`。
 * - 地区：显示地区名、严重程度、新闻数、告警数、热度、最近时间；摘要为空不显示。
 * - 新闻：主按钮「打开原文」，用外部链接（新标签页）；没有合法 url 时不给主按钮。
 */
function formatNewweiIntel(
  record: TargetRecord,
  layerId: string,
  locale: SupportedLocale,
): TargetView {
  const p = props(record);
  const isNews = layerId === "newwei-news";
  const zh = String(locale).toLowerCase().startsWith("zh");
  const fields: TargetField[] = [];

  if (isNews) {
    fields.push({
      labelKey: "globe.target.field.type",
      value: zh ? "新闻" : "News",
    });
    pushField(fields, "globe.target.field.place", p.location);

    const severity = text(p.severity).toLowerCase();
    const tone = severityTone(severity);
    if (severity) {
      fields.push({
        labelKey: "globe.target.field.severity",
        value: severityLabel(severity, zh),
        ...(tone ? { tagColor: tone } : {}),
      });
    }

    pushTimeField(fields, p.time ?? p.publishedAt ?? p.ingestedAt, locale);
    pushField(fields, "globe.target.field.summary", p.summary);

    const url = safeHttpUrl(p.url);
    return {
      kindKey: "globe.target.kinds.news",
      title: text(p.name) || baseTitle(record),
      subtitle: "",
      fields,
      links: [],
      position: positionOf(record),
      layerId,
      ...(url
        ? {
            console: {
              labelKey: "globe.intel.openSource",
              href: url,
              external: true,
            },
          }
        : {}),
    };
  }

  // 地区态势：事件图层的每个点是一个国家/地区聚合，不是单个事件。
  pushField(fields, "globe.target.field.region", p.name);

  const severity = text(p.severity).toLowerCase();
  const tone = severityTone(severity);
  if (severity) {
    fields.push({
      labelKey: "globe.target.field.severity",
      value: severityLabel(severity, zh),
      ...(tone ? { tagColor: tone } : {}),
    });
  }

  pushField(fields, "globe.target.field.newsCount", p.newsCount, { mono: true });
  pushField(fields, "globe.target.field.alertCount", p.alertCount, {
    mono: true,
  });
  pushField(fields, "globe.target.field.score", p.score, { mono: true });
  pushTimeField(fields, p.time ?? p.latestAt, locale);
  pushField(fields, "globe.target.field.summary", p.summary);

  const regionName = text(p.name);
  // 兜底链接与 intel-geojson 同规则：没有可用的地区事件筛选，退回站内搜索，
  // 绝不再拼 `/events/<国家代码>`。
  const consoleHref =
    text(p.consoleUrl) ||
    (regionName ? `/search?q=${encodeURIComponent(regionName)}` : "");

  return {
    kindKey: "globe.target.kinds.region",
    title: regionName || baseTitle(record),
    subtitle: "",
    fields,
    links: [],
    position: positionOf(record),
    layerId,
    ...(consoleHref
      ? {
          console: {
            labelKey: "globe.intel.openEvent",
            href: consoleHref,
          },
        }
      : {}),
  };
}

/** 主入口：按图层选择专用格式化器，其它图层走通用格式化器。 */
export function formatTarget(
  record: TargetRecord,
  options: FormatTargetOptions = {},
): TargetView {
  const locale = options.locale ?? "en-US";
  const layerId = text(record.layerId);
  switch (layerId) {
    case "flights":
    case "military":
    case "local-adsb":
      return formatAircraft(record, layerId);
    case "ais-live-vessels":
      return formatVessel(record);
    case "satellites":
      return formatSatellite(record);
    case "earthquakes":
      return formatEarthquake(record, locale);
    case "local-firms":
      return formatFirm(record);
    case "cctv":
      return formatCctv(record, locale);
    case "newwei-events":
    case "newwei-news":
      return formatNewweiIntel(record, layerId, locale);
    default:
      return formatGeneric(record);
  }
}
