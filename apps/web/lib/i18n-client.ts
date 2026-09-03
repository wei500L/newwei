"use client";

import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import {
  LANGUAGE_COOKIE_KEY,
  resolveLocale,
  supportedLocales,
  type SupportedLocale
} from "@/lib/i18n";

import en from "./locales/en.json";
import zh from "./locales/zh.json";

// i18next 运行时初始化与浏览器语言持久化。react-i18next 在模块顶层调用
// React.createContext，该 API 在 React Server Component 环境不存在，因此这些
// 代码必须与 lib/i18n.ts（服务端安全、被 app/layout.tsx 引用）拆分，且本文件
// 标注 "use client" 以阻止任何 Server Component 误引。
const STORAGE_KEY = "language";

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
