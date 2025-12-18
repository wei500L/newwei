"use client";

import { ApolloProvider } from "@apollo/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider, theme, unstableSetRender } from "antd";
import type { PropsWithChildren } from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { getApolloClient } from "@/lib/apollo-client";

import { SessionErrorListener } from "./session-error-listener";
import { UnauthorizedRedirect } from "./unauthorized-redirect";

const antdRoots = new WeakMap<Element | DocumentFragment, Root>();

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
