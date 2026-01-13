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
          captureClientError("React Query request failed", error, {
            tags: { area: "react-query", queryHash: query.queryHash },
            extras: { queryKey: query.queryKey }
          });
        }
      }),
      mutationCache: new MutationCache({
        onError: (error, variables, _, mutation) => {
          captureClientError("React Query mutation failed", error, {
            tags: { area: "react-query", mutationKey: String(mutation.options.mutationKey ?? "unknown") },
            extras: { variables }
          });
        }
      }),
      defaultOptions: {
        queries: {
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

    return {
      algorithm: theme.defaultAlgorithm,
      token: {
        colorPrimary,
        colorBgBase,
        colorBgLayout: colorBgBase,
        colorBgContainer: "#ffffff",
        colorBgElevated: "rgba(255, 255, 255, 0.98)",
        colorBgSpotlight: "rgba(15, 23, 42, 0.95)",
        colorTextBase,
        colorTextSecondary,
        colorTextPlaceholder: "#64748b",
        colorTextLightSolid: "#f8fafc",
        colorFillSecondary,
        borderRadius: 10,
        fontFamily:
          "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        colorBorder,
      },
      components: {
        Card: {
          borderRadiusLG: 12,
          colorBgContainer: "#ffffff",
          boxShadow: "0 8px 20px rgba(15, 23, 42, 0.08)",
        },
        Button: {
          borderRadius: 8,
          controlHeight: 36,
          primaryShadow: "none",
        },
        Table: {
          colorBgContainer: "#ffffff",
          borderColor: colorBorder,
        },
        Menu: {
          colorBgContainer: "transparent",
        },
        Modal: {
          borderRadiusLG: 12,
          colorBgElevated: "#ffffff",
          boxShadow: "0 16px 40px rgba(15, 23, 42, 0.18)",
        }
      }
    };
  }, []);

  return (
    <I18nextProvider i18n={i18nInstance}>
      <ConfigProvider
        locale={antdLocale}
        theme={antdTheme}
      >
        <AntApp>
          <ApolloProvider client={apolloClient}>
            <QueryClientProvider client={queryClient}>
              <UnauthorizedRedirect />
              <SessionErrorListener />
              <Toaster position="top-right" theme="light" richColors />
              {children}
            </QueryClientProvider>
          </ApolloProvider>
        </AntApp>
      </ConfigProvider>
    </I18nextProvider>
  );
}
