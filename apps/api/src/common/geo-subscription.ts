import {
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  normalizeCountryCode,
} from "@modular/utils";

const AMBIGUOUS_REGION_CODES = new Set([
  "AP",
  "APAC",
  "EA",
  "EMEA",
  "EU",
  "GCC",
  "LA",
  "LATAM",
  "MEA",
  "MENA",
  "NA",
  "ROW",
  "SA",
  "SEA",
  "SSA",
  "WA",
  "WORLD",
]);

export interface CanonicalGeoValue {
  normalizedValue: string;
  displayValue: string;
  countryCodeAlpha2?: string;
}

export function normalizeGeoDisplayValue(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, " ").slice(0, 128);
}

export function extractGeoCountryAlpha2(
  value?: string | null,
): string | undefined {
  const displayValue = normalizeGeoDisplayValue(value);
  if (!displayValue) {
    return undefined;
  }

  const upper = displayValue.toUpperCase();
  if (AMBIGUOUS_REGION_CODES.has(upper)) {
    return undefined;
  }

  const countryCode =
    normalizeCountryCode(displayValue) ??
    extractCountryCodeFromText(displayValue);
  if (!countryCode) {
    return undefined;
  }

  return getCountryAlpha2(countryCode) ?? undefined;
}

export function canonicalizeGeoValue(value: unknown): CanonicalGeoValue {
  const displayValue = normalizeGeoDisplayValue(value);
  if (!displayValue) {
    return { normalizedValue: "", displayValue: "" };
  }

  const upper = displayValue.toUpperCase();
  const countryCode = AMBIGUOUS_REGION_CODES.has(upper)
    ? null
    : normalizeCountryCode(displayValue);
  const countryCodeAlpha2 = countryCode
    ? (getCountryAlpha2(countryCode) ?? undefined)
    : undefined;
  if (!countryCodeAlpha2) {
    return {
      normalizedValue: displayValue.toLowerCase(),
      displayValue,
    };
  }

  return {
    normalizedValue: countryCodeAlpha2.toLowerCase(),
    displayValue: getCountryName(countryCodeAlpha2) ?? displayValue,
    countryCodeAlpha2,
  };
}
