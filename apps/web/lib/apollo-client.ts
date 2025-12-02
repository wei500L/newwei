"use client";

import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { onError, type ServerError } from "@apollo/client/link/error";
import { setContext } from "@apollo/client/link/context";
import { getSession } from "next-auth/react";
import { captureClientError } from "./client-telemetry";
import { env } from "./env";
import { createTraceHeaders } from "./trace";

let apolloClient: ApolloClient<any> | null = null;

const httpLink = new HttpLink({
  uri: env.graphqlUrl,
  credentials: "include"
});

const authLink = setContext(async (_, { headers }) => {
  const session = (await getSession()) as (Record<string, any> & { accessToken?: string }) | null;
  const token = session?.accessToken;
  const traceHeaders = createTraceHeaders(headers);
  return {
    headers: {
      ...traceHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  };
});

const errorLink = onError(({ graphQLErrors, networkError, operation, response }) => {
  const responseTraceId =
    (networkError as ServerError | undefined)?.response?.headers?.get("x-trace-id") ??
    (response as Response | undefined)?.headers?.get?.("x-trace-id");

  if (graphQLErrors) {
    graphQLErrors.forEach((error) => {
      const traceId =
        (error.extensions?.traceId as string | undefined) ?? responseTraceId ?? undefined;
      captureClientError(`[GraphQL error]: ${error.message}`, error, {
        traceId,
        tags: {
          path: error.path?.join(".") ?? "unknown",
          operation: operation?.operationName ?? "unknown"
        },
        extras: { extensions: error.extensions }
      });
    });
  }
  if (networkError) {
    captureClientError("[Network error]", networkError, {
      traceId: responseTraceId ?? undefined,
      tags: { operation: operation?.operationName ?? "unknown" }
    });
  }
});

function createApolloClient() {
  return new ApolloClient({
    link: ApolloLink.from([errorLink, authLink, httpLink]),
    cache: new InMemoryCache(),
    defaultOptions: {
      watchQuery: {
        fetchPolicy: "cache-and-network"
      }
    }
  });
}

export function getApolloClient() {
  if (typeof window === "undefined") {
    return createApolloClient();
  }

  if (!apolloClient) {
    apolloClient = createApolloClient();
  }

  return apolloClient;
}
