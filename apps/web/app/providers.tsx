"use client";

import { ApolloProvider } from "@apollo/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider, theme } from "antd";
import { PropsWithChildren, useState } from "react";
import { UnauthorizedRedirect } from "./unauthorized-redirect";
import { SessionErrorListener } from "./session-error-listener";
import { getApolloClient } from "@/lib/apollo-client";

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

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff"
        }
      }}
    >
      <AntApp>
        <ApolloProvider client={apolloClient}>
          <QueryClientProvider client={queryClient}>
            <UnauthorizedRedirect />
            <SessionErrorListener />
            {children}
          </QueryClientProvider>
        </ApolloProvider>
      </AntApp>
    </ConfigProvider>
  );
}
