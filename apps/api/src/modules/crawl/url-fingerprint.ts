import {
  canonicalizeUrlWithQueryAllowlist,
  DEFAULT_URL_QUERY_PARAM_ALLOWLIST,
  normalizeUrlQueryParamAllowlist,
} from "@modular/utils";
import { createHash } from "node:crypto";

export const DEFAULT_CRAWL_ORG_CONTENT_DEDUPE_WINDOW_HOURS = 24;
export const MAX_CRAWL_ORG_CONTENT_DEDUPE_WINDOW_HOURS = 24 * 30;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const clampWindowHours = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.max(
    0,
    Math.min(MAX_CRAWL_ORG_CONTENT_DEDUPE_WINDOW_HOURS, rounded),
  );
};

export const resolveQueryParamAllowlist = (
  value: unknown,
  fallback: string[] = DEFAULT_URL_QUERY_PARAM_ALLOWLIST,
): string[] => normalizeUrlQueryParamAllowlist(value, fallback);

export const buildCanonicalUrlFingerprint = (
  value: string,
  queryParamAllowlist?: unknown,
): { canonicalUrl: string; fingerprint: string } | null => {
  const canonicalUrl = canonicalizeUrlWithQueryAllowlist(value, {
    queryParamAllowlist,
  });
  if (!canonicalUrl) {
    return null;
  }
  const fingerprint = createHash("sha256").update(canonicalUrl).digest("hex");
  return { canonicalUrl, fingerprint };
};

export const extractUrlQueryParamAllowlistFromTaskConfig = (
  config: unknown,
  fallback: string[] = DEFAULT_URL_QUERY_PARAM_ALLOWLIST,
): string[] => {
  if (!isRecord(config)) {
    return [...fallback];
  }

  const direct = resolveQueryParamAllowlist(config.urlQueryParamAllowlist, []);
  if (direct.length > 0) {
    return direct;
  }

  const itemPayload =
    isRecord(config.itemPayload) ? config.itemPayload : undefined;
  const metadata =
    itemPayload && isRecord(itemPayload.metadata)
      ? itemPayload.metadata
      : undefined;
  const fromMetadata = resolveQueryParamAllowlist(
    metadata?.urlQueryParamAllowlist,
    [],
  );
  if (fromMetadata.length > 0) {
    return fromMetadata;
  }

  return [...fallback];
};

export const extractOrgContentDedupeWindowHoursFromTaskConfig = (
  config: unknown,
  fallback = DEFAULT_CRAWL_ORG_CONTENT_DEDUPE_WINDOW_HOURS,
): number => {
  if (!isRecord(config)) {
    return clampWindowHours(fallback, DEFAULT_CRAWL_ORG_CONTENT_DEDUPE_WINDOW_HOURS);
  }
  const direct = clampWindowHours(
    config.orgContentDedupeWindowHours,
    Number.NaN,
  );
  if (Number.isFinite(direct)) {
    return direct;
  }

  const seed =
    isRecord(config.itemPayload) && isRecord(config.itemPayload.metadata)
      ? config.itemPayload.metadata.newsSourceSeed
      : undefined;
  const fromSeed =
    isRecord(seed) && "dedupeWindowHours" in seed
      ? clampWindowHours(
          (seed as { dedupeWindowHours?: unknown }).dedupeWindowHours,
          Number.NaN,
        )
      : Number.NaN;
  if (Number.isFinite(fromSeed)) {
    return fromSeed;
  }

  return clampWindowHours(fallback, DEFAULT_CRAWL_ORG_CONTENT_DEDUPE_WINDOW_HOURS);
};
