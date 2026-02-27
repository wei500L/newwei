"use client";

import { ApolloProvider } from "@apollo/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider, theme, unstableSetRender } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import "dayjs/locale/en";
import "dayjs/locale/zh-cn";
import type { PropsWithChildren } from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { Toaster } from "sonner";

import { useTheme } from "@/hooks/use-theme";
import { getApolloClient } from "@/lib/apollo-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import {
  changeLanguage,
  getStoredLanguage,
  initI18n,
  resolveLocale,
  type SupportedLocale
} from "@/lib/i18n";
import { classifyRequestError } from "@/lib/request-error";

import { ApolloAuthSync } from "./apollo-auth-sync";
import { ForbiddenNotice } from "./forbidden-notice";
import { SessionErrorListener } from "./session-error-listener";
import { UnauthorizedRedirect } from "./unauthorized-redirect";

const antdRoots = new WeakMap<Element | DocumentFragment, Root>();
const i18nInstance = initI18n();

unstableSetRender((node, container) => {
  let root = antdRoots.get(container);
  if (!root) {
    root = createRoot(container);
    antdRoots.set(container, root);
  }
  root.render(node);

  return async () => {
    root.unmount();
    antdRoots.delete(container);
  };
});

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() =>
    new QueryClient({
      queryCache: new QueryCache({
        onError: (error, query) => {
          const classification = classifyRequestError(error);
          if (classification.kind === "cancelled") {
            return;
          }
          captureClientError("React Query request failed", error, {
            tags: { area: "react-query", queryHash: query.queryHash },
            extras: { queryKey: query.queryKey }
          });
        }
      }),
      mutationCache: new MutationCache({
        onError: (error, variables, _, mutation) => {
          const classification = classifyRequestError(error);
          if (classification.kind === "cancelled") {
            return;
          }
          captureClientError("React Query mutation failed", error, {
            tags: { area: "react-query", mutationKey: String(mutation.options.mutationKey ?? "unknown") },
            extras: { variables }
          });
        }
      }),
       defaultOptions: {
         queries: {
           retry: (failureCount, error) => {
             const classification = classifyRequestError(error);
             if (
               classification.kind === "auth" ||
               classification.kind === "permission" ||
               classification.kind === "validation" ||
               classification.kind === "conflict" ||
               classification.kind === "notFound" ||
               classification.kind === "cancelled"
             ) {
               return false;
             }
             if (classification.kind === "rateLimit") {
               return failureCount < 2;
             }
             if (classification.kind === "timeout" || classification.kind === "network") {
               return failureCount < 2;
             }
             if (classification.kind === "service") {
               return classification.status === 503 ? failureCount < 2 : false;
             }
             return failureCount < 1;
           },
           refetchOnWindowFocus: false,
           staleTime: 30_000
         }
      }
    })
  );
  const [apolloClient] = useState(() => getApolloClient());
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    resolveLocale(i18nInstance.language)
  );
  const { theme: themeMode } = useTheme();

  useEffect(() => {
    const handleChange = (language: string) => {
      setLocale(resolveLocale(language));
    };
    i18nInstance.on("languageChanged", handleChange);
    return () => {
      i18nInstance.off("languageChanged", handleChange);
    };
  }, []);

  useEffect(() => {
    const stored = getStoredLanguage();
    if (stored && stored !== resolveLocale(i18nInstance.language)) {
      void changeLanguage(stored);
      return;
    }
    if (!stored && typeof navigator !== "undefined") {
      const browserLocale = resolveLocale(navigator.language);
      if (browserLocale !== resolveLocale(i18nInstance.language)) {
        void i18nInstance.changeLanguage(browserLocale);
      }
    }
  }, []);

  useEffect(() => {
    dayjs.locale(locale === "zh-CN" ? "zh-cn" : "en");
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.title = i18nInstance.t("metadata.title");
      const metaDescription = document.querySelector("meta[name=\"description\"]");
      if (metaDescription) {
        metaDescription.setAttribute(
          "content",
          i18nInstance.t("metadata.description")
        );
      }
    }
  }, [locale]);

  const antdLocale = useMemo(
    () => (locale === "zh-CN" ? zhCN : enUS),
    [locale]
  );

  const antdTheme = useMemo(() => {
    const isDark = themeMode === "dark";
    const getVar = (name: string, fallback: string) => {
      if (typeof window === "undefined") return fallback;
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    };

    const colorPrimary = getVar("--primary", "#1f3b7b");
    const colorBgBase = getVar("--background", "#f7f6f2");
    const colorTextBase = getVar("--foreground", "#1f2933");
    const colorTextSecondary = getVar("--secondary-foreground", "#475569");
    const colorFillSecondary = getVar("--secondary", "#f1f5f9");
    const colorBorder = getVar("--border", "#e2e8f0");
    const colorBgContainer = isDark ? "rgba(15, 23, 42, 0.82)" : "#ffffff";
    const colorBgElevated = isDark ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.98)";
    const colorBgSpotlight = isDark ? "rgba(2, 6, 23, 0.98)" : "rgba(15, 23, 42, 0.95)";
    const colorTextPlaceholder = isDark ? "#94a3b8" : "#64748b";
    const cardShadow = isDark
      ? "0 4px 6px rgba(0,0,0,0.2), 0 12px 28px rgba(2,6,23,0.4), 0 0 48px rgba(99,102,241,0.04)"
      : "0 4px 6px rgba(31,59,123,0.04), 0 12px 28px rgba(31,59,123,0.06), 0 24px 48px rgba(31,59,123,0.03)";
    const modalShadow = isDark
      ? "0 18px 42px rgba(2, 6, 23, 0.55), 0 0 64px rgba(99,102,241,0.06)"
      : "0 16px 40px rgba(15, 23, 42, 0.18), 0 24px 64px rgba(31,59,123,0.05)";

    return {
      algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        colorPrimary,
        colorBgBase,
        colorBgLayout: colorBgBase,
        colorBgContainer,
        colorBgElevated,
        colorBgSpotlight,
        colorTextBase,
        colorTextSecondary,
        colorTextPlaceholder,
        colorTextLightSolid: "#f8fafc",
        colorFillSecondary,
        borderRadius: 10,
        fontFamily:
          "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        colorBorder,
      },
      components: {
        Card: {
          borderRadiusLG: 14,
          colorBgContainer,
          boxShadow: cardShadow,
        },
        Button: {
          borderRadius: 8,
          controlHeight: 36,
          primaryShadow: "none",
        },
        Table: {
          colorBgContainer,
          borderColor: colorBorder,
        },
        Menu: {
          colorBgContainer: "transparent",
        },
        Modal: {
          borderRadiusLG: 14,
          colorBgElevated,
          boxShadow: modalShadow,
        }
      }
    };
  }, [themeMode]);

  return (
    <I18nextProvider i18n={i18nInstance}>
      <ConfigProvider
        locale={antdLocale}
        theme={antdTheme}
        input={{ autoComplete: "off" }}
        textArea={{ autoComplete: "off" }}
      >
        <AntApp>
          <ApolloProvider client={apolloClient}>
            <QueryClientProvider client={queryClient}>
              <UnauthorizedRedirect />
              <ForbiddenNotice />
              <ApolloAuthSync />
              <SessionErrorListener />
              <Toaster position="top-right" theme={themeMode} richColors />
              {children}
            </QueryClientProvider>
          </ApolloProvider>
        </AntApp>
      </ConfigProvider>
    </I18nextProvider>
  );
}
