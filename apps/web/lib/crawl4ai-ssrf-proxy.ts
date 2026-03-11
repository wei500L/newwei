export interface Crawl4aiSsrfProxyRuntimeState {
  enabled: boolean;
  url?: string;
  ok?: boolean;
  durationMs?: number;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export function parseCrawl4aiSsrfProxyRuntimeState(
  payload: unknown,
): Crawl4aiSsrfProxyRuntimeState {
  return {
    enabled: asBoolean(getPath(payload, ["ssrfProxy", "enabled"])) ?? false,
    url: asString(getPath(payload, ["ssrfProxy", "url"])),
    ok: asBoolean(getPath(payload, ["ssrfProxy", "probe", "ok"])),
    durationMs: asNumber(getPath(payload, ["ssrfProxy", "probe", "durationMs"])),
    error: asString(getPath(payload, ["ssrfProxy", "probe", "error"])),
  };
}

export function getCrawl4aiSsrfProxyStatus(
  state: Crawl4aiSsrfProxyRuntimeState | null | undefined,
): "healthy" | "disabled" | "failing" | "unknown" {
  if (!state) {
    return "unknown";
  }
  if (!state.enabled) {
    return "disabled";
  }
  if (state.ok === true) {
    return "healthy";
  }
  if (state.ok === false) {
    return "failing";
  }
  return "unknown";
}
