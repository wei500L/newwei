import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import dayjs from "@/lib/dayjs";

import en from "./locales/en.json";
import zh from "./locales/zh.json";

export const supportedLocales = ["en-US", "zh-CN"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

const STORAGE_KEY = "language";

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
  return null;
}

export async function changeLanguage(next: SupportedLocale) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, next);
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

export function formatDateTime(
  value: string | number | Date,
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions
) {
  const defaultTimeZone = process.env.NEXT_PUBLIC_TIME_ZONE ?? "Asia/Shanghai";
  const timeZone = options.timeZone ?? defaultTimeZone;
  const zoned = dayjs(value).tz(timeZone);
  if (!zoned.isValid()) {
    return "";
  }

  const formatterOptions: Intl.DateTimeFormatOptions = { ...options, timeZone };
  if ((formatterOptions.dateStyle || formatterOptions.timeStyle) && formatterOptions.timeZoneName) {
    delete formatterOptions.timeZoneName;
  }

  try {
    return new Intl.DateTimeFormat(locale, formatterOptions).format(zoned.toDate());
  } catch {
    const withoutTimeZoneName: Intl.DateTimeFormatOptions = { ...formatterOptions };
    delete withoutTimeZoneName.timeZoneName;
    try {
      return new Intl.DateTimeFormat(locale, withoutTimeZoneName).format(zoned.toDate());
    } catch {
      return zoned.format("YYYY-MM-DD HH:mm");
    }
  }
}
