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
import { fromPromise } from "@apollo/client/link/utils";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";

import { emitForbidden, emitUnauthorized } from "./auth-events";
import {
  getCachedBrowserAuthSession,
  invalidateBrowserAuthSessionCache,
  refreshBrowserAccessToken,
  setBrowserAuthAccessToken,
  type BrowserAuthSession,
} from "./browser-auth-session";
import { captureClientError } from "./client-telemetry";
import { env } from "./env";
import { createTraceHeaders } from "./trace";

type SessionWithAccessToken = BrowserAuthSession;

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
const GRAPHQL_WS_CONNECTION_ACK_TIMEOUT_MS = 10_000;

const toWsUrl = (url: string): string => url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const httpLink = new HttpLink({
  uri: env.graphqlUrl,
  credentials: "include"
});

export const setApolloAccessToken = (token: string | null | undefined) => {
  setBrowserAuthAccessToken(token);
};

const refreshAccessToken = async (): Promise<string | null> => {
  if (typeof window === "undefined") {
    return null;
  }

  return refreshBrowserAccessToken();
};

const getCachedSession = async (): Promise<SessionWithAccessToken | null> => {
  return (await getCachedBrowserAuthSession()) as SessionWithAccessToken | null;
};

const authLink = setContext(async (_, { headers }) => {
  const session = await getCachedSession();
  const token = session?.accessToken;
  const traceHeaders = createTraceHeaders(headers);
  return {
    headers: {
      ...traceHeaders,
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  };
});

const errorLink = onError(({ graphQLErrors, networkError, operation, response, forward }) => {
  const responseTraceId =
    (networkError as unknown as NetworkErrorWithResponse)?.response?.headers?.get?.("x-trace-id") ??
    (response as Response | undefined)?.headers?.get?.("x-trace-id") ??
    undefined;

  const statusCode =
    (networkError as NetworkErrorWithResponse | undefined)?.statusCode ??
    (networkError as NetworkErrorWithResponse | undefined)?.response?.status;

  const unauthenticatedGraphqlError =
    graphQLErrors?.find((error) => {
      const code = error.extensions?.code;
      return code === "UNAUTHENTICATED" || code === "UNAUTHORIZED";
    }) ?? null;

  const alreadyRetried = Boolean(operation.getContext()._retry);

  if ((statusCode === 401 || unauthenticatedGraphqlError) && typeof window !== "undefined" && forward && !alreadyRetried) {
    operation.setContext({ _retry: true });
    invalidateBrowserAuthSessionCache();

    return fromPromise(refreshAccessToken()).flatMap((token) => {
      if (token) {
        return forward(operation);
      }

      invalidateBrowserAuthSessionCache();
      emitUnauthorized({ status: 401, reason: unauthenticatedGraphqlError?.message });

      const originalError =
        networkError ??
        new Error(unauthenticatedGraphqlError?.message ?? "Unauthenticated");
      return fromPromise(Promise.reject(originalError));
    });
  }

  if (graphQLErrors) {
    graphQLErrors.forEach((error) => {
      if (error.extensions?.code === "UNAUTHENTICATED" || error.extensions?.code === "UNAUTHORIZED") {
        invalidateBrowserAuthSessionCache();
        emitUnauthorized({ status: 401, reason: error.message });
      }
      if (error.extensions?.code === "FORBIDDEN") {
        const detail =
          typeof error.extensions?.detail === "string" && error.extensions.detail.trim()
            ? error.extensions.detail.trim()
            : "";
        emitForbidden({
          status: 403,
          reason: detail ? `${error.message}: ${detail}` : error.message
        });
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
    if (statusCode === 401) {
      invalidateBrowserAuthSessionCache();
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

  return undefined;
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
            connectionAckWaitTimeout: GRAPHQL_WS_CONNECTION_ACK_TIMEOUT_MS,
            connectionParams: async () => {
              const session = await getCachedSession();
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
        // Modules that need background refresh should opt in explicitly.
        fetchPolicy: "cache-first"
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
