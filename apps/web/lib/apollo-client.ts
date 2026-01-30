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

const SESSION_CACHE_TTL_MS = 5_000;
let cachedSession: SessionWithAccessToken | null | undefined;
let cachedSessionAt = 0;
let cachedSessionPromise: Promise<SessionWithAccessToken | null> | null = null;
let accessTokenOverride: string | undefined;

const invalidateSessionCache = () => {
  cachedSession = undefined;
  cachedSessionAt = 0;
};

export const setApolloAccessToken = (token: string | null | undefined) => {
  accessTokenOverride = token ?? undefined;
  invalidateSessionCache();
};

let refreshTokenPromise: Promise<string | null> | null = null;

const refreshAccessToken = async (): Promise<string | null> => {
  if (typeof window === "undefined") {
    return null;
  }

  if (!refreshTokenPromise) {
    refreshTokenPromise = getSession()
      .then((session) => (session as SessionWithAccessToken | null)?.accessToken ?? null)
      .catch(() => null)
      .finally(() => {
        refreshTokenPromise = null;
      });
  }

  return refreshTokenPromise;
};

const getCachedSession = async (): Promise<SessionWithAccessToken | null> => {
  if (typeof window === "undefined") {
    return null;
  }

  const now = Date.now();
  if (cachedSessionPromise) {
    return cachedSessionPromise;
  }

  if (cachedSession !== undefined && now - cachedSessionAt < SESSION_CACHE_TTL_MS) {
    return cachedSession;
  }

  cachedSessionPromise = getSession()
    .then((session) => (session as SessionWithAccessToken | null) ?? null)
    .catch(() => null)
    .then((session) => {
      cachedSession = session;
      cachedSessionAt = Date.now();
      return session;
    })
    .finally(() => {
      cachedSessionPromise = null;
    });

  return cachedSessionPromise;
};

const authLink = setContext(async (_, { headers }) => {
  const session = accessTokenOverride ? null : await getCachedSession();
  const token = accessTokenOverride ?? session?.accessToken;
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

    return fromPromise(refreshAccessToken()).flatMap((token) => {
      if (token) {
        setApolloAccessToken(token);
        return forward(operation);
      }

      invalidateSessionCache();
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
        invalidateSessionCache();
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
      invalidateSessionCache();
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
            connectionParams: async () => {
              const session = accessTokenOverride ? null : await getCachedSession();
              const token = accessTokenOverride ?? session?.accessToken;
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
