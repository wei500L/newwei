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
import {
  ANTD_COLORS_DARK,
  ANTD_COLORS_LIGHT,
  SHADOW_PRESETS,
} from "@/lib/antd-theme-tokens";
import {
  extractApiError,
  isRuntimeSecretRequiredApiError,
} from "@/lib/api-error";
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
let browserQueryClient: QueryClient | null = null;

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

function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        const classification = classifyRequestError(error);
        if (classification.kind === "cancelled") {
          return;
        }
        if (isRuntimeSecretRequiredApiError(error)) {
          const apiError = extractApiError(error);
          captureClientError("News source runtime secret required", error, {
            tags: {
              area: "react-query",
              queryHash: query.queryHash,
              errorCode: apiError.code ?? "unknown",
              ...(apiError.sourceId ? { sourceId: apiError.sourceId } : {}),
            },
            extras: {
              queryKey: query.queryKey,
              detail: apiError.detail,
              requiredKeys: apiError.requiredKeys,
            },
          });
          return;
        }
        captureClientError("React Query request failed", error, {
          tags: { area: "react-query", queryHash: query.queryHash },
          extras: { queryKey: query.queryKey },
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, variables, _, mutation) => {
        const classification = classifyRequestError(error);
        if (classification.kind === "cancelled") {
          return;
        }
        captureClientError("React Query mutation failed", error, {
          tags: {
            area: "react-query",
            mutationKey: String(mutation.options.mutationKey ?? "unknown"),
          },
          extras: { variables },
        });
      },
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
          if (
            classification.kind === "timeout" ||
            classification.kind === "network"
          ) {
            return failureCount < 2;
          }
          if (classification.kind === "service") {
            return classification.status === 503 ? failureCount < 2 : false;
          }
          return failureCount < 1;
        },
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
    },
  });
}

function getQueryClient() {
  if (typeof window === "undefined") {
    return createQueryClient();
  }

  if (!browserQueryClient) {
    browserQueryClient = createQueryClient();
  }

  return browserQueryClient;
}

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => getQueryClient());
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
        void changeLanguage(browserLocale);
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

  useEffect(() => {
    if (process.env.NODE_ENV !== "development" || typeof window === "undefined") {
      return;
    }
    const debugWindow = window as typeof window & {
      __MODULAR_APOLLO_CLIENT__?: typeof apolloClient;
      __MODULAR_QUERY_CLIENT__?: QueryClient;
    };
    debugWindow.__MODULAR_APOLLO_CLIENT__ = apolloClient;
    debugWindow.__MODULAR_QUERY_CLIENT__ = queryClient;
    return () => {
      delete debugWindow.__MODULAR_APOLLO_CLIENT__;
      delete debugWindow.__MODULAR_QUERY_CLIENT__;
    };
  }, [apolloClient, queryClient]);

  const antdLocale = useMemo(
    () => (locale === "zh-CN" ? zhCN : enUS),
    [locale]
  );

  const antdTheme = useMemo(() => {
    const isDark = themeMode === "dark";
    const colors = isDark ? ANTD_COLORS_DARK : ANTD_COLORS_LIGHT;
    const shadows = isDark ? SHADOW_PRESETS.dark : SHADOW_PRESETS.light;
    const colorPrimary = colors.colorPrimary;
    const colorBgBase = colors.colorBgBase;
    const colorTextBase = colors.colorTextBase;
    const colorTextSecondary = colors.colorTextSecondary;
    const colorFillSecondary = colors.colorFillSecondary;
    const colorBorder = colors.colorBorder;
    const colorBgContainer = colors.colorBgContainer;
    const colorBgElevated = colors.colorBgElevated;
    const colorBgSpotlight = colors.colorBgSpotlight;
    const colorTextPlaceholder = colors.colorTextPlaceholder;
    const cardShadow = shadows.card;
    const modalShadow = shadows.modal;

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
