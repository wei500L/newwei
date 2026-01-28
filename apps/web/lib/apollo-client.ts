"use client";

import {
  ApolloClient,
  ApolloLink,
  HttpLink,
  InMemoryCache,
  split,
  type NormalizedCacheObject,
} from "@apollo/client";
import { setContext } from "@apollo/client/link/context";
import { onError } from "@apollo/client/link/error";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";
import { getSession } from "next-auth/react";

import { emitForbidden, emitUnauthorized } from "./auth-events";
import { captureClientError } from "./client-telemetry";
import { env } from "./env";
import { createTraceHeaders } from "./trace";

interface SessionWithAccessToken extends Record<string, unknown> {
  accessToken?: string;
}

interface NetworkErrorWithResponse {
  statusCode?: number;
  response?: {
    status?: number;
    headers?: {
      get?: (name: string) => string | null;
    };
  };
}

let apolloClient: ApolloClient<NormalizedCacheObject> | null = null;

const toWsUrl = (url: string): string => url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const httpLink = new HttpLink({
  uri: env.graphqlUrl,
  credentials: "include"
});

const authLink = setContext(async (_, { headers }) => {
  const session = (await getSession()) as SessionWithAccessToken | null;
  const token = session?.accessToken;
  const traceHeaders = createTraceHeaders(headers);
  return {
    headers: {
      ...traceHeaders,
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  };
});

const errorLink = onError(({ graphQLErrors, networkError, operation, response }) => {
  const responseTraceId =
    (networkError as unknown as NetworkErrorWithResponse)?.response?.headers?.get?.("x-trace-id") ??
    (response as Response | undefined)?.headers?.get?.("x-trace-id") ??
    undefined;

  if (graphQLErrors) {
    graphQLErrors.forEach((error) => {
      if (error.extensions?.code === "UNAUTHENTICATED") {
        emitUnauthorized({ status: 401, reason: error.message });
      }
      if (error.extensions?.code === "FORBIDDEN") {
        emitForbidden({ status: 403, reason: error.message });
      }
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
    const statusCode =
      (networkError as NetworkErrorWithResponse)?.statusCode ??
      (networkError as NetworkErrorWithResponse)?.response?.status;
    if (statusCode === 401) {
      emitUnauthorized({ status: statusCode });
    }
    if (statusCode === 403) {
      emitForbidden({ status: statusCode });
    }
    captureClientError("[Network error]", networkError, {
      traceId: responseTraceId ?? undefined,
      tags: { operation: operation?.operationName ?? "unknown" }
    });
  }
});

function createApolloClient() {
  const httpChain = ApolloLink.from([authLink, httpLink]);
  const wsLink =
    typeof window === "undefined"
      ? null
      : new GraphQLWsLink(
          createClient({
            url: toWsUrl(env.graphqlUrl),
            lazy: true,
            connectionParams: async () => {
              const session = (await getSession()) as SessionWithAccessToken | null;
              const token = session?.accessToken;
              const traceHeaders = createTraceHeaders();
              return {
                ...traceHeaders,
                ...(token ? { authorization: `Bearer ${token}` } : {})
              };
            }
          })
        );

  const link =
    wsLink === null
      ? httpChain
      : split(
          ({ query }) => {
            const definition = getMainDefinition(query);
            return definition.kind === "OperationDefinition" && definition.operation === "subscription";
          },
          wsLink,
          httpChain
        );

  return new ApolloClient({
    link: ApolloLink.from([errorLink, link]),
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
