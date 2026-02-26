const DEFAULT_URL_QUERY_PARAM_ALLOWLIST_VALUES = [
  "id",
  "story",
  "article",
  "post",
  "item",
  "p",
  "page",
  "v",
  "ver",
  "lang",
  "locale",
  "hl"
] as const;

export const DEFAULT_URL_QUERY_PARAM_ALLOWLIST = [
  ...DEFAULT_URL_QUERY_PARAM_ALLOWLIST_VALUES
];

export const MAX_URL_QUERY_PARAM_ALLOWLIST_SIZE = 64;

const MAX_QUERY_PARAM_KEY_LENGTH = 64;
const QUERY_PARAM_KEY_PATTERN = /^[a-z0-9_.-]+$/i;

const normalizeParamKey = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_QUERY_PARAM_KEY_LENGTH) {
    return null;
  }
  if (!QUERY_PARAM_KEY_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const parseAllowlistInput = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
};

export const normalizeUrlQueryParamAllowlist = (
  value: unknown,
  fallback: string[] = DEFAULT_URL_QUERY_PARAM_ALLOWLIST
): string[] => {
  if (value !== undefined && value !== null) {
    const input = parseAllowlistInput(value);
    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const entry of input) {
      const key = normalizeParamKey(entry);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push(key);
      if (normalized.length >= MAX_URL_QUERY_PARAM_ALLOWLIST_SIZE) {
        break;
      }
    }

    return normalized;
  }

  const fallbackInput = parseAllowlistInput(fallback);
  const fallbackNormalized: string[] = [];
  const fallbackSeen = new Set<string>();
  for (const entry of fallbackInput) {
    const key = normalizeParamKey(entry);
    if (!key || fallbackSeen.has(key)) {
      continue;
    }
    fallbackSeen.add(key);
    fallbackNormalized.push(key);
    if (fallbackNormalized.length >= MAX_URL_QUERY_PARAM_ALLOWLIST_SIZE) {
      break;
    }
  }
  return fallbackNormalized;
};

const parseHttpUrl = (value: string): URL | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const normalizePathname = (value: string): string => {
  const collapsed = value.replace(/\/{2,}/g, "/");
  if (collapsed === "/") {
    return "/";
  }
  return collapsed.replace(/\/+$/, "");
};

const normalizeSearch = (url: URL, allowlist: Set<string>) => {
  if (allowlist.size === 0) {
    url.search = "";
    return;
  }

  const accepted: Array<{ key: string; value: string }> = [];
  for (const [rawKey, value] of url.searchParams.entries()) {
    const key = normalizeParamKey(rawKey);
    if (!key || !allowlist.has(key)) {
      continue;
    }
    accepted.push({ key, value });
  }

  accepted.sort((left, right) => {
    if (left.key !== right.key) {
      return left.key.localeCompare(right.key);
    }
    return left.value.localeCompare(right.value);
  });

  url.search = "";
  for (const entry of accepted) {
    url.searchParams.append(entry.key, entry.value);
  }
};

export const canonicalizeUrlWithQueryAllowlist = (
  value: string,
  options?: { queryParamAllowlist?: unknown }
): string | null => {
  const parsed = parseHttpUrl(value);
  if (!parsed) {
    return null;
  }

  const allowlist = normalizeUrlQueryParamAllowlist(
    options?.queryParamAllowlist,
    DEFAULT_URL_QUERY_PARAM_ALLOWLIST
  );
  const allowlistSet = new Set(allowlist);

  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = normalizePathname(parsed.pathname);

  if (parsed.protocol === "http:" && parsed.port === "80") {
    parsed.port = "";
  }
  if (parsed.protocol === "https:" && parsed.port === "443") {
    parsed.port = "";
  }

  normalizeSearch(parsed, allowlistSet);

  return parsed.toString();
};
