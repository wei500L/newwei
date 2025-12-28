"use client";

import { ApolloProvider } from "@apollo/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

  return (
    <I18nextProvider i18n={i18nInstance}>
      <ConfigProvider
        locale={antdLocale}
        theme={{
          algorithm: theme.darkAlgorithm,
          token: {
            colorPrimary: "#00f0ff", // Neon Cyan
            colorBgBase: "#030712", // Gray 950
            colorBgContainer: "#0b1221",
            borderRadius: 0, // Sharp edges for military feel
            fontFamily: "var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            colorBorder: "rgba(0, 240, 255, 0.15)",
          },
          components: {
            Card: {
              borderRadiusLG: 0,
              colorBgContainer: "rgba(11, 18, 33, 0.6)", // Transparent dark blue
              boxShadow: "0 0 0 1px rgba(0, 240, 255, 0.1)", // Subtle border glow instead of drop shadow
            },
            Button: {
              borderRadius: 0,
              controlHeight: 36,
              primaryShadow: "0 0 10px rgba(0, 240, 255, 0.4)", // Cyan glow
            },
            Table: {
              colorBgContainer: "transparent",
              borderColor: "rgba(255,255,255,0.05)",
            },
            Menu: {
              colorBgContainer: "transparent",
            },
            Modal: {
              borderRadiusLG: 0,
              colorBgElevated: "#030712",
              boxShadow: "0 0 30px rgba(0, 240, 255, 0.1)",
            }
          }
        }}
      >
        <AntApp>
          <ApolloProvider client={apolloClient}>
            <QueryClientProvider client={queryClient}>
              <UnauthorizedRedirect />
              <SessionErrorListener />
              <Toaster position="top-right" theme="dark" richColors />
              {children}
            </QueryClientProvider>
          </ApolloProvider>
        </AntApp>
      </ConfigProvider>
    </I18nextProvider>
  );
}
