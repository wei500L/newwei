import { createLogger, getCountryAlpha2, getCountryName, normalizeCountryCode } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

import { CacheService } from "../cache/cache.service";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { EnvService } from "../config/config.service";
import { GeoNominatimSettingsService } from "../system-settings/geo-nominatim-settings.service";

export enum GeocodeProvider {
  Nominatim = "nominatim",
}

export interface GeocodeBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName?: string;
  bounds?: GeocodeBounds;
  provider: GeocodeProvider;
  query: string;
  countryCodeAlpha2?: string;
}

interface CachedGeocodeEntry {
  ok: boolean;
  cachedAt: number;
  result?: GeocodeResult;
}

interface ResolveCandidatesOptions {
  countryCodeAlpha2?: string;
  allowNetwork?: boolean;
}

const CACHE_PREFIX = "geo:geocode:v1";

@Injectable()
export class GeocodingService {
  private readonly logger = createLogger({ name: "geocoding" });

  constructor(
    private readonly cache: CacheService,
    private readonly rateLimiter: RateLimiterService,
    private readonly env: EnvService,
    private readonly nominatimSettings: GeoNominatimSettingsService
  ) {}

  async getCached(query: string, options: ResolveCandidatesOptions = {}): Promise<GeocodeResult | null> {
    const normalized = this.normalizeQuery(query);
    if (!normalized) {
      return null;
    }
    const cacheKey = this.cacheKey(normalized, options.countryCodeAlpha2);
    const cached = await this.cache.get<CachedGeocodeEntry>(cacheKey);
    if (!cached) {
      return null;
    }

    if (!cached.ok) {
      const negativeTtlMs = (this.env.get<number>("GEO_GEOCODE_NEGATIVE_TTL_SECONDS", { infer: true }) ?? 86_400) * 1000;
      if (Date.now() - cached.cachedAt > negativeTtlMs) {
        return null;
      }
      return null;
    }

    return cached.result ?? null;
  }

  async resolveCandidates(
    candidates: string[],
    options: ResolveCandidatesOptions = {}
  ): Promise<GeocodeResult | null> {
    const uniqueCandidates = Array.from(
      new Set(
        candidates
          .map((candidate) => candidate.trim())
          .filter((candidate) => candidate.length > 0)
      )
    );
    if (uniqueCandidates.length === 0) {
      return null;
    }

    for (const candidate of uniqueCandidates) {
      const cached = await this.getCached(candidate, options);
      if (cached) {
        return cached;
      }
    }

    if (!options.allowNetwork) {
      return null;
    }

    // Network budget is enforced by the caller; within one record we only attempt the top candidate.
    const bestCandidate = uniqueCandidates[0]!;
    return this.geocode(bestCandidate, options);
  }

  async geocode(query: string, options: ResolveCandidatesOptions = {}): Promise<GeocodeResult | null> {
    const normalized = this.normalizeQuery(query);
    if (!normalized) {
      return null;
    }

    const normalizedCountry = normalizeCountryCode(normalized);
    const countryCodeAlpha2 =
      options.countryCodeAlpha2 ??
      (normalizedCountry ? getCountryAlpha2(normalizedCountry) ?? undefined : undefined);
    const effectiveQuery = this.normalizeQueryForProvider(normalized) ?? normalized;

    const cacheKey = this.cacheKey(effectiveQuery, countryCodeAlpha2);
    const cached = await this.cache.get<CachedGeocodeEntry>(cacheKey);
    if (cached?.ok && cached.result) {
      return cached.result;
    }
    if (cached && !cached.ok) {
      const negativeTtlMs = (this.env.get<number>("GEO_GEOCODE_NEGATIVE_TTL_SECONDS", { infer: true }) ?? 86_400) * 1000;
      if (Date.now() - cached.cachedAt <= negativeTtlMs) {
        return null;
      }
    }

    const cacheTtlSeconds =
      this.env.get<number>("GEO_GEOCODE_CACHE_TTL_SECONDS", { infer: true }) ?? 2_592_000;
    const rateLimitPerSecond =
      this.env.get<number>("GEO_GEOCODE_RATE_LIMIT_PER_SECOND", { infer: true }) ?? 1;

    const allowed = await this.rateLimiter.consume(
      "geocode:nominatim",
      Math.max(1, rateLimitPerSecond),
      1
    );
    if (!allowed) {
      return null;
    }

    const result = await this.fetchNominatim(effectiveQuery, countryCodeAlpha2);
    const payload: CachedGeocodeEntry = result
      ? { ok: true, cachedAt: Date.now(), result }
      : { ok: false, cachedAt: Date.now() };

    await this.cache.set(cacheKey, payload, cacheTtlSeconds);
    return result;
  }

  private cacheKey(query: string, countryCodeAlpha2?: string) {
    const country = countryCodeAlpha2 ? countryCodeAlpha2.toLowerCase() : "any";
    return `${CACHE_PREFIX}:${country}:${this.hashKey(query)}`;
  }

  private normalizeQuery(value: string): string {
    return value
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 200);
  }

  private normalizeQueryForProvider(query: string): string | null {
    const code = normalizeCountryCode(query);
    if (!code) {
      return query;
    }
    const name = getCountryName(code);
    if (name) {
      return name;
    }
    return query;
  }

  private hashKey(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private async fetchNominatim(query: string, countryCodeAlpha2?: string): Promise<GeocodeResult | null> {
    const baseUrl =
      this.env.get<string>("GEO_NOMINATIM_BASE_URL", { infer: true }) ??
      "https://nominatim.openstreetmap.org";
    const timeoutMs = this.env.get<number>("GEO_GEOCODE_TIMEOUT_MS", { infer: true }) ?? 3_000;
    const identity = await this.nominatimSettings.getEffectiveIdentity();
    const userAgent = identity.userAgent;
    const email = identity.email;
    const acceptLanguage =
      this.env.get<string>("GEO_NOMINATIM_ACCEPT_LANGUAGE", { infer: true }) ??
      "zh-CN,zh;q=0.9,en;q=0.7";

    const url = new URL("/search", baseUrl);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("namedetails", "0");
    if (countryCodeAlpha2) {
      url.searchParams.set("countrycodes", countryCodeAlpha2.toLowerCase());
    }
    if (email) {
      url.searchParams.set("email", email);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          "Accept-Language": acceptLanguage
        },
        signal: controller.signal
      });

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, statusText: response.statusText, query },
          "Nominatim geocode request failed"
        );
        return null;
      }

      const body = (await response.json()) as unknown;
      const top = Array.isArray(body) ? body[0] : null;
      if (!top || typeof top !== "object") {
        return null;
      }
      const record = top as Record<string, unknown>;
      const latRaw = record.lat;
      const lngRaw = record.lon;
      const lat = typeof latRaw === "string" ? Number(latRaw) : typeof latRaw === "number" ? latRaw : NaN;
      const lng = typeof lngRaw === "string" ? Number(lngRaw) : typeof lngRaw === "number" ? lngRaw : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      const displayName =
        typeof record.display_name === "string" ? record.display_name : undefined;
      const bounds = this.parseBoundingBox(record.boundingbox);
      const resolvedCountryCodeAlpha2 = this.parseCountryCodeAlpha2(record.address) ?? countryCodeAlpha2;

      return {
        lat,
        lng,
        displayName,
        bounds,
        provider: GeocodeProvider.Nominatim,
        query,
        countryCodeAlpha2: resolvedCountryCodeAlpha2
      };
    } catch (error) {
      this.logger.warn({ error, query }, "Nominatim geocode request error");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseBoundingBox(input: unknown): GeocodeBounds | undefined {
    if (!Array.isArray(input) || input.length < 4) {
      return undefined;
    }
    const minLat = Number(input[0]);
    const maxLat = Number(input[1]);
    const minLng = Number(input[2]);
    const maxLng = Number(input[3]);
    if (
      !Number.isFinite(minLat) ||
      !Number.isFinite(maxLat) ||
      !Number.isFinite(minLng) ||
      !Number.isFinite(maxLng)
    ) {
      return undefined;
    }
    return { minLat, maxLat, minLng, maxLng };
  }

  private parseCountryCodeAlpha2(input: unknown): string | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }
    const raw = (input as Record<string, unknown>).country_code;
    if (typeof raw !== "string") {
      return undefined;
    }
    const trimmed = raw.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(trimmed) ? trimmed : undefined;
  }
}
