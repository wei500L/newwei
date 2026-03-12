export type MapLoadErrorKind =
  | "network"
  | "authorization"
  | "style"
  | "tile_source"
  | "unknown";

export interface MapLoadErrorPresentation {
  kind: MapLoadErrorKind;
  title: string;
  description: string;
  rawMessage?: string;
}

export interface MapLoadErrorDetail {
  trigger: "map_error";
  error?: unknown;
  rawEvent?: unknown;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readErrorMessage(value: unknown): string | undefined {
  if (value instanceof Error) {
    return readString(value.message);
  }
  if (typeof value === "string") {
    return readString(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      readString(record.message) ??
      readString(record.statusText) ??
      readString(record.error)
    );
  }
  return undefined;
}

function extractRawMessage(detail: unknown): string | undefined {
  if (!detail || typeof detail !== "object") {
    return readErrorMessage(detail);
  }
  const record = detail as Record<string, unknown>;
  return (
    readErrorMessage(record.error) ??
    readErrorMessage(record.rawEvent) ??
    readErrorMessage(detail)
  );
}

function includesAny(haystack: string, needles: string[]) {
  return needles.some((needle) => haystack.includes(needle));
}

export function classifyMapLoadError(detail: unknown): MapLoadErrorPresentation {
  const rawMessage = extractRawMessage(detail);
  const normalized = rawMessage?.toLowerCase() ?? "";

  const auth =
    includesAny(normalized, [
      "401",
      "403",
      "unauthorized",
      "forbidden",
      "access denied",
    ]);
  if (auth) {
    return {
      kind: "authorization",
      title: "地图底图访问被拒绝",
      description: rawMessage
        ? `底图服务拒绝了当前请求。${rawMessage}`
        : "底图服务返回了 401/403，或发生了鉴权失败。",
      rawMessage,
    };
  }

  const style =
    includesAny(normalized, [
      "style.json",
      "style",
      "sprite",
      "glyph",
      "stylesheet",
    ]) && !includesAny(normalized, ["tilejson", "tile"]);
  if (style) {
    return {
      kind: "style",
      title: "地图底图样式加载失败",
      description: rawMessage
        ? `底图样式清单或其依赖资源在地图初始化前加载失败。${rawMessage}`
        : "底图样式 JSON、sprite 或 glyph 资源在地图初始化前加载失败。",
      rawMessage,
    };
  }

  const tileSource =
    includesAny(normalized, [
      "tile",
      "tiles",
      "tilejson",
      "vector source",
      "raster source",
      "source",
    ]);
  if (tileSource) {
    return {
      kind: "tile_source",
      title: "地图底图瓦片或数据源加载失败",
      description: rawMessage
        ? `底图样式已加载，但一个或多个瓦片/数据源请求失败。${rawMessage}`
        : "底图样式已加载，但一个或多个瓦片/数据源请求失败。",
      rawMessage,
    };
  }

  const network = includesAny(normalized, [
    "failed to fetch",
    "networkerror",
    "network request",
    "err_name_not_resolved",
    "enotfound",
    "eai_again",
    "dns",
    "timeout",
    "timed out",
    "load failed",
  ]);
  if (network) {
    return {
      kind: "network",
      title: "地图底图网络请求失败",
      description: rawMessage
        ? `浏览器无法连接到底图服务主机或资源。${rawMessage}`
        : "浏览器无法连接到底图服务主机或资源。",
      rawMessage,
    };
  }

  return {
    kind: "unknown",
    title: "地图底图初始化失败",
    description: rawMessage
      ? `地图在底图准备完成前初始化失败。${rawMessage}`
      : "地图在底图准备完成前初始化失败。",
    rawMessage,
  };
}
