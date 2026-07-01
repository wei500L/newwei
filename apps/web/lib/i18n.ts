import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import dayjs from "@/lib/dayjs";

import en from "./locales/en.json";
import zh from "./locales/zh.json";
import { getDefaultTimeZone } from "./time-zone";

export const supportedLocales = ["en-US", "zh-CN"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

const STORAGE_KEY = "language";
export const LANGUAGE_COOKIE_KEY = "language";

function readLanguageCookie(): SupportedLocale | null {
  if (typeof document === "undefined") {
    return null;
  }
  const segments = document.cookie.split(";").map((segment) => segment.trim());
  const match = segments.find((segment) =>
    segment.startsWith(`${LANGUAGE_COOKIE_KEY}=`)
  );
  if (!match) {
    return null;
  }
  const rawValue = decodeURIComponent(match.slice(LANGUAGE_COOKIE_KEY.length + 1));
  return supportedLocales.includes(rawValue as SupportedLocale)
    ? (rawValue as SupportedLocale)
    : null;
}

export function normalizeLocale(locale?: string): SupportedLocale {
  if (!locale) {
    return "en-US";
  }
  const lowered = locale.toLowerCase();
  if (lowered.startsWith("zh")) {
    return "zh-CN";
  }
  if (lowered.startsWith("en")) {
    return "en-US";
  }
  return "en-US";
}

export function resolveLocale(locale?: string): SupportedLocale {
  const normalized = normalizeLocale(locale);
  return supportedLocales.includes(normalized) ? normalized : "en-US";
}

export function getInitialLanguage(): SupportedLocale {
  if (typeof document !== "undefined") {
    const htmlLang = document.documentElement.lang;
    if (htmlLang) {
      return resolveLocale(htmlLang);
    }
  }
  return "en-US";
}

export function getStoredLanguage(): SupportedLocale | null {
  if (typeof window === "undefined") {
    return null;
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && supportedLocales.includes(stored as SupportedLocale)) {
    return stored as SupportedLocale;
  }
  return readLanguageCookie();
}

export async function changeLanguage(next: SupportedLocale) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  if (typeof document !== "undefined") {
    document.cookie = `${LANGUAGE_COOKIE_KEY}=${encodeURIComponent(next)}; path=/; max-age=31536000; samesite=lax`;
  }
  await i18next.changeLanguage(next);
}

export function initI18n() {
  if (!i18next.isInitialized) {
    i18next.use(initReactI18next).init({
      resources: {
        "en-US": { translation: en },
        "zh-CN": { translation: zh }
      },
      lng: getInitialLanguage(),
      fallbackLng: "en-US",
      supportedLngs: supportedLocales,
      interpolation: {
        escapeValue: false
      },
      returnNull: false,
      react: {
        useSuspense: false
      }
    });
  }
  return i18next;
}

export { getDefaultTimeZone };

function extractTimeZoneName(
  date: Date,
  locale: SupportedLocale,
  timeZone: string,
  timeZoneName: Intl.DateTimeFormatOptions["timeZoneName"]
): string | null {
  if (!timeZoneName) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName
    }).formatToParts(date);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

export function formatDateTime(
  value: string | number | Date,
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions
) {
  const timeZone = options.timeZone ?? getDefaultTimeZone();
  const zoned = dayjs(value).tz(timeZone);
  if (!zoned.isValid()) {
    return "";
  }

  const formatterOptions: Intl.DateTimeFormatOptions = { ...options, timeZone };
  const requestedTimeZoneName = formatterOptions.timeZoneName;

  try {
    return new Intl.DateTimeFormat(locale, formatterOptions).format(zoned.toDate());
  } catch {
    const withoutTimeZoneName: Intl.DateTimeFormatOptions = { ...formatterOptions };
    delete withoutTimeZoneName.timeZoneName;
    try {
      const formatted = new Intl.DateTimeFormat(locale, withoutTimeZoneName).format(zoned.toDate());
      const timeZoneLabel = extractTimeZoneName(zoned.toDate(), locale, timeZone, requestedTimeZoneName);
      return timeZoneLabel ? `${formatted} ${timeZoneLabel}` : formatted;
    } catch {
      return zoned.format("YYYY-MM-DD HH:mm");
    }
  }
}

export function formatUpdatedAt(value: string | number | Date, locale: SupportedLocale) {
  return formatDateTime(value, locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

export function formatTimeZoneOffsetLabel(value: string | number | Date, timeZone?: string): string {
  const resolvedTimeZone = timeZone ?? getDefaultTimeZone();
  const zoned = dayjs(value).tz(resolvedTimeZone);
  if (!zoned.isValid()) {
    return "";
  }
  const offset = zoned.format("Z"); // e.g. +08:00
  if (offset === "+00:00" && resolvedTimeZone.toUpperCase() === "UTC") {
    return "UTC";
  }
  return `UTC${offset}`;
}

export interface FormatRelativeTimeOptions {
  base?: string | number | Date;
  timeZone?: string;
  numeric?: Intl.RelativeTimeFormatNumeric;
  style?: Intl.RelativeTimeFormatStyle;
}

export function formatRelativeTime(
  value: string | number | Date,
  locale: SupportedLocale,
  options: FormatRelativeTimeOptions = {}
): string {
  if (typeof Intl === "undefined" || typeof Intl.RelativeTimeFormat === "undefined") {
    return "";
  }

  const timeZone = options.timeZone ?? getDefaultTimeZone();
  const base = options.base ?? new Date();

  const zoned = dayjs(value).tz(timeZone);
  const zonedBase = dayjs(base).tz(timeZone);
  if (!zoned.isValid() || !zonedBase.isValid()) {
    return "";
  }

  const diffMs = zoned.valueOf() - zonedBase.valueOf();
  const absSeconds = Math.abs(diffMs) / 1000;

  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, {
      numeric: options.numeric ?? "auto",
      style: options.style ?? "long"
    });
  } catch {
    return "";
  }

  if (absSeconds < 60) {
    return rtf.format(Math.round(diffMs / 1000), "second");
  }
  if (absSeconds < 60 * 60) {
    return rtf.format(Math.round(diffMs / (60 * 1000)), "minute");
  }
  if (absSeconds < 60 * 60 * 24) {
    return rtf.format(Math.round(diffMs / (60 * 60 * 1000)), "hour");
  }
  if (absSeconds < 60 * 60 * 24 * 7) {
    return rtf.format(Math.round(diffMs / (24 * 60 * 60 * 1000)), "day");
  }
  if (absSeconds < 60 * 60 * 24 * 30) {
    return rtf.format(Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)), "week");
  }
  if (absSeconds < 60 * 60 * 24 * 365) {
    return rtf.format(Math.round(diffMs / (30 * 24 * 60 * 60 * 1000)), "month");
  }
  return rtf.format(Math.round(diffMs / (365 * 24 * 60 * 60 * 1000)), "year");
}
