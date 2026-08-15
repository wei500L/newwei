import {
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  normalizeCountryCode,
} from "@modular/utils";

import { fetchWithIpv4Fallback } from "../../common/http/fetch-with-ipv4-fallback";
import {
  classifyUpstreamRequestError,
  readHttpStatus,
} from "../../common/http/upstream-error-classification";

import type {
  AdsbNormalizationResult,
  DiagnosticErrorDetails,
  JsonFetchError,
  JsonFetchOptions,
  OpenSkyStateResponse,
  OpenSkyStateVector,
  RealtimeAdsbAircraftSnapshot,
  RealtimeAdsbLatestSnapshot,
  RealtimeAdsbRuntimeDiagnostics,
  RealtimeOpenskyErrorKind,
  RealtimeSignalErrorCode,
  RealtimeSignalRateLimitDetails,
  RealtimeSignalsRuntimeConfig,
} from "./realtime-signals.types";

export const MIN_ADSB_STALE_THRESHOLD_SEC = 10 * 60;
export const MAX_ADSB_STALE_THRESHOLD_SEC = 30 * 60;
export const FEET_PER_METER = 3.28084;
export const KNOTS_PER_METER_PER_SECOND = 1.94384;

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isValidCoordinate(
  lat: number | null,
  lng: number | null,
): boolean {
  return (
    lat !== null &&
    lng !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

export function parseTimestampMs(value: string | undefined): number | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractCountryCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeCountryCode(value);
  if (normalized) {
    return normalized;
  }
  return extractCountryCodeFromText(value) ?? undefined;
}

export function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

export function toDateBucket(value: string): string {
  const ts = Date.parse(value);
  if (Number.isFinite(ts)) {
    return new Date(ts).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

export function toCompactDayString(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  }
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      if (/^\d{8}$/.test(trimmed)) {
        const y = trimmed.slice(0, 4);
        const m = trimmed.slice(4, 6);
        const d = trimmed.slice(6, 8);
        const parsed = Date.parse(`${y}-${m}-${d}T00:00:00.000Z`);
        if (Number.isFinite(parsed)) {
          return new Date(parsed).toISOString();
        }
      }
      // GDELT formats: "20240812T143000Z" (gkg_geojson urlpubtimedate)
      // and compact "20240812143000" / 14-digit UTC timestamps.
      const compactDateTime = trimmed.match(
        /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/,
      );
      if (compactDateTime) {
        const [, y, mo, d, h, mi, s] = compactDateTime;
        const parsed = Date.UTC(
          Number(y),
          Number(mo) - 1,
          Number(d),
          Number(h),
          Number(mi),
          Number(s),
        );
        if (Number.isFinite(parsed)) {
          return new Date(parsed).toISOString();
        }
      }
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed);
        // 14-digit values like "20240812143000" are compact UTC datetimes,
        // not milliseconds since epoch; treat them as such instead of
        // producing a year-2610 timestamp.
        if (/^\d{14}$/.test(trimmed)) {
          const y = trimmed.slice(0, 4);
          const mo = trimmed.slice(4, 6);
          const d = trimmed.slice(6, 8);
          const h = trimmed.slice(8, 10);
          const mi = trimmed.slice(10, 12);
          const s = trimmed.slice(12, 14);
          const parsed = Date.UTC(
            Number(y),
            Number(mo) - 1,
            Number(d),
            Number(h),
            Number(mi),
            Number(s),
          );
          if (Number.isFinite(parsed)) {
            return new Date(parsed).toISOString();
          }
        }
        const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
        return new Date(ms).toISOString();
      }
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
    return new Date().toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 10_000_000 && value <= 99_999_999) {
      const dayValue = Math.trunc(value).toString();
      const y = dayValue.slice(0, 4);
      const m = dayValue.slice(4, 6);
      const d = dayValue.slice(6, 8);
      const parsed = Date.parse(`${y}-${m}-${d}T00:00:00.000Z`);
      if (Number.isFinite(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
    const ms = value > 1_000_000_000_000 ? value : value * 1_000;
    return new Date(ms).toISOString();
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  return new Date().toISOString();
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.toLowerCase().includes("aborted"))
  );
}

export function classifyRealtimeSignalErrorCode(
  error: unknown,
): RealtimeSignalErrorCode {
  return classifyUpstreamRequestError(error);
}

export function classifyOpenskyError(error: unknown): RealtimeOpenskyErrorKind {
  const status = readHttpStatus(error);
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (typeof status === "number" && status >= 500) {
    return "server";
  }
  if (isAbortError(error)) {
    return "timeout";
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("oauth client credentials") ||
      message.includes("access_token") ||
      message.includes("unauthorized") ||
      message.includes("forbidden")
    ) {
      return "auth";
    }
    if (message.includes("429") || message.includes("rate limit")) {
      return "rate_limited";
    }
    if (message.includes("fetch failed") || message.includes("network")) {
      return "network";
    }
  }
  return "unknown";
}

export function toDiagnosticErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const status = readHttpStatus(error);
    const statusText = normalizeString(
      (error as { statusText?: unknown }).statusText,
    );
    const body = normalizeString((error as { body?: unknown }).body);
    const detail = [status, statusText].filter(Boolean).join(" ");
    if (detail && body) {
      return `${detail}: ${body}`.slice(0, 400);
    }
    if (detail) {
      return detail.slice(0, 240);
    }
    if (body) {
      return body.slice(0, 400);
    }
  }
  return "Unknown realtime signal fetch error";
}

export function toDiagnosticErrorDetails(
  error: unknown,
): DiagnosticErrorDetails {
  const status = readHttpStatus(error);
  return {
    code: classifyRealtimeSignalErrorCode(error),
    kind: classifyOpenskyError(error),
    status,
    message: toDiagnosticErrorMessage(error),
  };
}

export function getRetryAfterMs(error: unknown): number | null {
  const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
    ? retryAfterMs
    : null;
}

export function getRateLimitDetails(
  error: unknown,
): RealtimeSignalRateLimitDetails | undefined {
  const rateLimit = (error as { rateLimit?: unknown })?.rateLimit;
  if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) {
    return undefined;
  }
  const details = rateLimit as RealtimeSignalRateLimitDetails;
  if (
    typeof details.retryAfterSec !== "number" &&
    !details.rateLimit &&
    !details.rateLimitPolicy &&
    !details.cfRay
  ) {
    return undefined;
  }
  return details;
}

export function parseRetryAfterMs(value: string | undefined): number | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const numericSeconds = Number(normalized);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.round(numericSeconds * 1_000);
  }
  const retryAtMs = Date.parse(normalized);
  if (!Number.isFinite(retryAtMs)) {
    return null;
  }
  return Math.max(0, retryAtMs - Date.now());
}

export function readRateLimitDetails(headers: Headers) {
  const retryAfterRaw = normalizeString(headers.get("retry-after"));
  const retryAfterMs = parseRetryAfterMs(retryAfterRaw);
  const details: RealtimeSignalRateLimitDetails = {
    ...(retryAfterMs !== null
      ? { retryAfterSec: Math.max(0, Math.ceil(retryAfterMs / 1_000)) }
      : {}),
    ...(normalizeString(headers.get("ratelimit"))
      ? { rateLimit: normalizeString(headers.get("ratelimit")) }
      : {}),
    ...(normalizeString(headers.get("ratelimit-policy"))
      ? {
          rateLimitPolicy: normalizeString(headers.get("ratelimit-policy")),
        }
      : {}),
    ...(normalizeString(headers.get("cf-ray"))
      ? { cfRay: normalizeString(headers.get("cf-ray")) }
      : {}),
  };

  return {
    retryAfterMs,
    details:
      typeof details.retryAfterSec === "number" ||
      details.rateLimit ||
      details.rateLimitPolicy ||
      details.cfRay
        ? details
        : undefined,
  };
}

export function shouldRetryFetchError(error: unknown): boolean {
  const status = toFiniteNumber((error as { status?: unknown })?.status);
  if (typeof status === "number") {
    if (status === 408 || status === 425) {
      return true;
    }
    if (status === 429) {
      return false;
    }
    return status >= 500;
  }

  const message = normalizeString(
    (error as { message?: unknown })?.message,
  )?.toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("eai_again")
  );
}

export async function fetchJsonWithRetry<T>(
  url: string,
  runtime: RealtimeSignalsRuntimeConfig,
  options: JsonFetchOptions = {},
): Promise<T> {
  const timeoutMs = Math.max(1_000, Math.trunc(runtime.requestTimeoutMs));
  const maxRetries = Math.max(
    0,
    Math.trunc(options.maxRetries ?? runtime.maxRetries),
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await options.beforeAttempt?.();
      const response = await fetchWithIpv4Fallback(
        url,
        {
          body:
            typeof options.rawBody === "string"
              ? options.rawBody
              : options.body
                ? JSON.stringify(options.body)
                : undefined,
          headers: {
            accept: "application/json",
            ...(options.body && !options.rawBody
              ? { "content-type": "application/json" }
              : {}),
            ...(options.headers ?? {}),
          },
          method: options.method ?? "GET",
        },
        { timeoutMs },
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const rateLimit = readRateLimitDetails(response.headers);
        const error = new Error(
          `HTTP ${response.status} ${response.statusText}`,
        ) as JsonFetchError;
        Object.assign(error, {
          body,
          rateLimit: rateLimit.details,
          retryAfterMs: rateLimit.retryAfterMs ?? undefined,
          status: response.status,
          statusText: response.statusText,
        });
        throw error;
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      const shouldRetry =
        attempt < maxRetries &&
        (options.shouldRetry
          ? options.shouldRetry(error)
          : shouldRetryFetchError(error));
      if (!shouldRetry) {
        break;
      }
      if (shouldRetry) {
        const delayMs = Math.min(5_000, 300 * (attempt + 1));
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error("Unknown fetch error");
}

export function parseOpenskyStateVector(
  entry: unknown,
): OpenSkyStateVector | null {
  if (!Array.isArray(entry)) {
    return null;
  }

  const icao24 = normalizeString(entry[0])?.toLowerCase();
  if (!icao24) {
    return null;
  }

  const callsign = normalizeString(entry[1]);
  const countryName = normalizeString(entry[2]);
  const lastContactSec =
    toFiniteNumber(entry[4]) ?? toFiniteNumber(entry[3]) ?? 0;
  const lastContactMs = Math.max(0, Math.trunc(lastContactSec * 1_000));
  const altitudeMeters = toFiniteNumber(entry[13]) ?? toFiniteNumber(entry[7]);
  const velocityMetersPerSecond = toFiniteNumber(entry[9]);
  const heading = toFiniteNumber(entry[10]);
  const longitude = toFiniteNumber(entry[5]) ?? undefined;
  const latitude = toFiniteNumber(entry[6]) ?? undefined;

  return {
    icao24,
    ...(callsign ? { callsign } : {}),
    ...(countryName ? { countryName } : {}),
    ...(lastContactMs > 0
      ? {
          lastContactAt: new Date(lastContactMs).toISOString(),
        }
      : {}),
    lastContactMs,
    ...(typeof longitude === "number" ? { longitude } : {}),
    ...(typeof latitude === "number" ? { latitude } : {}),
    ...(typeof heading === "number" ? { heading } : {}),
    ...(typeof altitudeMeters === "number"
      ? { altitudeFt: Math.round(altitudeMeters * FEET_PER_METER) }
      : {}),
    ...(typeof velocityMetersPerSecond === "number"
      ? {
          groundSpeedKt: Math.round(
            velocityMetersPerSecond * KNOTS_PER_METER_PER_SECOND,
          ),
        }
      : {}),
    raw: entry,
  };
}

export function readOpenskyStateVectors(
  payload: unknown,
): OpenSkyStateVector[] {
  const states = readArray((payload as OpenSkyStateResponse)?.states);
  const parsed: OpenSkyStateVector[] = [];
  for (const entry of states) {
    const state = parseOpenskyStateVector(entry);
    if (state) {
      parsed.push(state);
    }
  }
  return parsed;
}

export function toAdsbDisplayCountryCode(
  code: string | undefined,
): string | undefined {
  return getCountryAlpha2(code) ?? undefined;
}

export function resolveOpenSkyCountryCode(
  countryName: string | undefined,
): string | undefined {
  if (!countryName) {
    return undefined;
  }
  const extractedCountryCode =
    extractCountryCodeFromText(countryName) ?? undefined;
  const normalizedCountryCode = normalizeCountryCode(countryName) ?? undefined;
  return (
    toAdsbDisplayCountryCode(extractedCountryCode) ??
    toAdsbDisplayCountryCode(normalizedCountryCode) ??
    toAdsbDisplayCountryCode(countryName)
  );
}

export function getAdsbStaleThresholdSeconds(intervalSec: number): number {
  const safeIntervalSec = Math.max(60, Math.trunc(intervalSec));
  return Math.max(
    MIN_ADSB_STALE_THRESHOLD_SEC,
    Math.min(MAX_ADSB_STALE_THRESHOLD_SEC, safeIntervalSec * 6),
  );
}

export function getAdsbSnapshotRetentionGraceSeconds(
  intervalSec: number,
): number {
  return getAdsbStaleThresholdSeconds(intervalSec);
}

export function getAdsbSnapshotTtlSeconds(intervalSec: number): number {
  const safeIntervalSec = Math.max(60, Math.trunc(intervalSec));
  return Math.max(20 * 60, safeIntervalSec * 2);
}

export function resolveAdsbAircraftPosition(record: Record<string, unknown>) {
  const lat = toFiniteNumber(record.lat);
  const lng = toFiniteNumber(record.lon);
  if (isValidCoordinate(lat, lng)) {
    return { lat: lat!, lng: lng! };
  }

  const lastPosition =
    record.lastPosition &&
    typeof record.lastPosition === "object" &&
    !Array.isArray(record.lastPosition)
      ? (record.lastPosition as Record<string, unknown>)
      : null;
  const lastLat = toFiniteNumber(lastPosition?.lat);
  const lastLng = toFiniteNumber(lastPosition?.lon);
  if (isValidCoordinate(lastLat, lastLng)) {
    return { lat: lastLat!, lng: lastLng! };
  }

  return null;
}

export function resolveAdsbObservedAt(
  record: Record<string, unknown>,
  fetchedAtMs: number,
) {
  const seenPosSec =
    toFiniteNumber(record.seen_pos) ??
    toFiniteNumber(
      record.lastPosition &&
        typeof record.lastPosition === "object" &&
        !Array.isArray(record.lastPosition)
        ? (record.lastPosition as Record<string, unknown>).seen_pos
        : undefined,
    ) ??
    0;
  const observedAtMs = fetchedAtMs - Math.max(0, seenPosSec) * 1_000;
  return new Date(observedAtMs).toISOString();
}

export function resolveAdsbHeading(record: Record<string, unknown>) {
  return (
    toFiniteNumber(record.track) ??
    toFiniteNumber(record.calc_track) ??
    toFiniteNumber(record.nav_heading)
  );
}

export function resolveAdsbAltitudeFt(record: Record<string, unknown>) {
  return toFiniteNumber(record.alt_baro) ?? toFiniteNumber(record.alt_geom);
}

export function resolveAdsbGroundSpeedKt(record: Record<string, unknown>) {
  return toFiniteNumber(record.gs);
}

export function scoreAdsbAircraftSnapshot(
  snapshot: RealtimeAdsbAircraftSnapshot,
): number {
  let score = 0;
  if (snapshot.callsign) score += 1;
  if (snapshot.registration) score += 1;
  if (snapshot.aircraftType) score += 1;
  if (snapshot.countryCode) score += 1;
  if (typeof snapshot.heading === "number") score += 1;
  if (typeof snapshot.altitudeFt === "number") score += 1;
  if (typeof snapshot.groundSpeedKt === "number") score += 1;
  return score;
}

export function selectPreferredAdsbAircraftSnapshot(
  current: RealtimeAdsbAircraftSnapshot,
  candidate: RealtimeAdsbAircraftSnapshot,
) {
  const currentObservedMs = Date.parse(current.observedAt);
  const candidateObservedMs = Date.parse(candidate.observedAt);
  if (
    Number.isFinite(candidateObservedMs) &&
    Number.isFinite(currentObservedMs)
  ) {
    if (candidateObservedMs > currentObservedMs) {
      return candidate;
    }
    if (candidateObservedMs < currentObservedMs) {
      return current;
    }
  }

  return scoreAdsbAircraftSnapshot(candidate) >=
    scoreAdsbAircraftSnapshot(current)
    ? candidate
    : current;
}

export function normalizeAdsbAircraftSnapshot(
  entry: unknown,
  fetchedAtMs: number,
  staleThresholdSec: number,
): AdsbNormalizationResult {
  const state = parseOpenskyStateVector(entry);
  if (!state) {
    return { snapshot: null, dropReason: "invalid_position" };
  }

  if (
    typeof state.latitude !== "number" ||
    typeof state.longitude !== "number" ||
    state.latitude < -90 ||
    state.latitude > 90 ||
    state.longitude < -180 ||
    state.longitude > 180
  ) {
    return { snapshot: null, dropReason: "invalid_position" };
  }

  if (!state.icao24) {
    return { snapshot: null, dropReason: "missing_identity" };
  }

  const observedAt = state.lastContactAt ?? new Date(fetchedAtMs).toISOString();
  const observedAtMs = Date.parse(observedAt);
  if (
    Number.isFinite(observedAtMs) &&
    fetchedAtMs - observedAtMs > staleThresholdSec * 1_000
  ) {
    return { snapshot: null, dropReason: "stale_position" };
  }
  const countryCode = resolveOpenSkyCountryCode(state.countryName);
  const countryName =
    normalizeString(state.countryName) ??
    (countryCode ? getCountryName(countryCode) : undefined);

  return {
    snapshot: {
      id: state.icao24,
      icao24: state.icao24,
      ...(state.callsign ? { callsign: state.callsign } : {}),
      lat: state.latitude,
      lng: state.longitude,
      ...(typeof state.heading === "number" ? { heading: state.heading } : {}),
      ...(typeof state.altitudeFt === "number"
        ? { altitudeFt: state.altitudeFt }
        : {}),
      ...(typeof state.groundSpeedKt === "number"
        ? { groundSpeedKt: state.groundSpeedKt }
        : {}),
      ...(countryCode ? { countryCode } : {}),
      ...(countryName ? { countryName } : {}),
      observedAt,
      source: "opensky",
    },
  };
}

export function buildAdsbLatestSnapshot(
  endpoint: string,
  aircraft: unknown[],
  totalAircraft: number,
  fetchedAtMs: number,
  staleThresholdSec: number,
): RealtimeAdsbLatestSnapshot {
  const normalizedAircraft = new Map<string, RealtimeAdsbAircraftSnapshot>();
  let droppedInvalidPositionCount = 0;
  let droppedMissingIdentityCount = 0;
  let droppedStalePositionCount = 0;
  let deduplicatedCount = 0;

  for (const entry of aircraft) {
    const result = normalizeAdsbAircraftSnapshot(
      entry,
      fetchedAtMs,
      staleThresholdSec,
    );
    if (!result.snapshot) {
      if (result.dropReason === "stale_position") {
        droppedStalePositionCount += 1;
      } else if (result.dropReason === "missing_identity") {
        droppedMissingIdentityCount += 1;
      } else {
        droppedInvalidPositionCount += 1;
      }
      continue;
    }
    const existing = normalizedAircraft.get(result.snapshot.id);
    if (existing) {
      deduplicatedCount += 1;
      normalizedAircraft.set(
        result.snapshot.id,
        selectPreferredAdsbAircraftSnapshot(existing, result.snapshot),
      );
      continue;
    }
    normalizedAircraft.set(result.snapshot.id, result.snapshot);
  }

  const normalizedEntries = Array.from(normalizedAircraft.values()).sort(
    (left, right) => {
      const observedDelta =
        Date.parse(right.observedAt) - Date.parse(left.observedAt);
      if (Number.isFinite(observedDelta) && observedDelta !== 0) {
        return observedDelta;
      }
      return left.id.localeCompare(right.id);
    },
  );
  const latestObservedAt = normalizedEntries[0]?.observedAt;
  const oldestObservedAt =
    normalizedEntries[normalizedEntries.length - 1]?.observedAt;

  return {
    source: "opensky",
    sourceEndpoint: endpoint,
    updatedAt: new Date(fetchedAtMs).toISOString(),
    totalAircraft,
    validPositionCount: normalizedAircraft.size,
    ...(latestObservedAt ? { latestObservedAt } : {}),
    diagnostics: {
      ...(latestObservedAt ? { latestObservedAt } : {}),
      ...(oldestObservedAt ? { oldestObservedAt } : {}),
      staleThresholdSec,
      droppedInvalidPositionCount,
      droppedMissingIdentityCount,
      droppedStalePositionCount,
      deduplicatedCount,
      retainedPreviousSnapshot: false,
    },
    aircraft: normalizedEntries,
  };
}

export function selectAdsbSnapshotToStore(
  previousSnapshot: RealtimeAdsbLatestSnapshot | null | undefined,
  nextSnapshot: RealtimeAdsbLatestSnapshot,
  fetchedAtMs: number,
  intervalSec: number,
): RealtimeAdsbLatestSnapshot {
  if (nextSnapshot.validPositionCount > 0 || !previousSnapshot) {
    return nextSnapshot;
  }

  const previousUpdatedMs = parseTimestampMs(previousSnapshot.updatedAt);
  if (
    previousUpdatedMs === null ||
    fetchedAtMs - previousUpdatedMs >
      getAdsbSnapshotRetentionGraceSeconds(intervalSec) * 1_000
  ) {
    return nextSnapshot;
  }

  return {
    ...previousSnapshot,
    sourceEndpoint: nextSnapshot.sourceEndpoint,
    totalAircraft: nextSnapshot.totalAircraft,
    ...((previousSnapshot.latestObservedAt ??
    previousSnapshot.diagnostics.latestObservedAt)
      ? {
          latestObservedAt:
            previousSnapshot.latestObservedAt ??
            previousSnapshot.diagnostics.latestObservedAt,
        }
      : {}),
    diagnostics: {
      ...((previousSnapshot.latestObservedAt ??
      previousSnapshot.diagnostics.latestObservedAt)
        ? {
            latestObservedAt:
              previousSnapshot.latestObservedAt ??
              previousSnapshot.diagnostics.latestObservedAt,
          }
        : {}),
      ...(previousSnapshot.diagnostics.oldestObservedAt
        ? { oldestObservedAt: previousSnapshot.diagnostics.oldestObservedAt }
        : {}),
      staleThresholdSec: nextSnapshot.diagnostics.staleThresholdSec,
      droppedInvalidPositionCount:
        nextSnapshot.diagnostics.droppedInvalidPositionCount,
      droppedMissingIdentityCount:
        nextSnapshot.diagnostics.droppedMissingIdentityCount,
      droppedStalePositionCount:
        nextSnapshot.diagnostics.droppedStalePositionCount,
      deduplicatedCount: nextSnapshot.diagnostics.deduplicatedCount,
      retainedPreviousSnapshot: true,
    },
  };
}

export function buildAdsbRuntimeDiagnostics(
  snapshot: RealtimeAdsbLatestSnapshot | null | undefined,
  current: {
    rawAircraftCount: number;
    currentValidPositionCount: number;
  },
  nowMs: number,
  intervalSec: number,
): RealtimeAdsbRuntimeDiagnostics {
  const staleThresholdSec =
    snapshot?.diagnostics.staleThresholdSec ??
    getAdsbStaleThresholdSeconds(intervalSec);

  if (!snapshot) {
    return {
      freshness: "missing",
      rawAircraftCount: current.rawAircraftCount,
      currentValidPositionCount: current.currentValidPositionCount,
      snapshotValidPositionCount: 0,
      staleThresholdSec,
      retainedPreviousSnapshot: false,
      droppedInvalidPositionCount: 0,
      droppedMissingIdentityCount: 0,
      droppedStalePositionCount: 0,
      deduplicatedCount: 0,
    };
  }

  const snapshotUpdatedMs = parseTimestampMs(snapshot.updatedAt);
  const latestObservedMs = parseTimestampMs(
    snapshot.latestObservedAt ?? snapshot.diagnostics.latestObservedAt,
  );
  const snapshotAgeSec =
    snapshotUpdatedMs === null
      ? undefined
      : Math.max(0, Math.round((nowMs - snapshotUpdatedMs) / 1_000));
  const latestObservedAgeSec =
    latestObservedMs === null
      ? undefined
      : Math.max(0, Math.round((nowMs - latestObservedMs) / 1_000));
  const freshness =
    snapshot.validPositionCount <= 0 ||
    (typeof snapshotAgeSec === "number" &&
      snapshotAgeSec > staleThresholdSec) ||
    (typeof latestObservedAgeSec === "number" &&
      latestObservedAgeSec > staleThresholdSec)
      ? "stale"
      : "fresh";

  return {
    freshness,
    rawAircraftCount: current.rawAircraftCount,
    currentValidPositionCount: current.currentValidPositionCount,
    snapshotValidPositionCount: snapshot.validPositionCount,
    snapshotUpdatedAt: snapshot.updatedAt,
    ...(typeof snapshotAgeSec === "number" ? { snapshotAgeSec } : {}),
    ...(snapshot.latestObservedAt
      ? { latestObservedAt: snapshot.latestObservedAt }
      : snapshot.diagnostics.latestObservedAt
        ? { latestObservedAt: snapshot.diagnostics.latestObservedAt }
        : {}),
    ...(typeof latestObservedAgeSec === "number"
      ? { latestObservedAgeSec }
      : {}),
    staleThresholdSec,
    retainedPreviousSnapshot: snapshot.diagnostics.retainedPreviousSnapshot,
    droppedInvalidPositionCount:
      snapshot.diagnostics.droppedInvalidPositionCount,
    droppedMissingIdentityCount:
      snapshot.diagnostics.droppedMissingIdentityCount,
    droppedStalePositionCount: snapshot.diagnostics.droppedStalePositionCount,
    deduplicatedCount: snapshot.diagnostics.deduplicatedCount,
  };
}

export function computeAdsbSnapshotHealthValue(
  snapshot: RealtimeAdsbLatestSnapshot,
  diagnostics: RealtimeAdsbRuntimeDiagnostics,
): number {
  if (
    diagnostics.freshness === "missing" ||
    diagnostics.freshness === "stale"
  ) {
    return 2;
  }
  if (snapshot.diagnostics.retainedPreviousSnapshot) {
    return 1;
  }
  return 0;
}
