"use client";

import axios from "axios";

export type RequestErrorKind = "network" | "permission" | "service" | "unknown";

export interface RequestErrorClassification {
  kind: RequestErrorKind;
  status?: number;
}

interface GraphQLErrorLike {
  extensions?: {
    code?: unknown;
  };
}

interface ApolloErrorLike {
  graphQLErrors?: unknown;
  networkError?: unknown;
}

interface NetworkErrorWithResponse {
  statusCode?: unknown;
  response?: {
    status?: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const getNetworkStatusCode = (networkError: unknown): number | undefined => {
  if (!isRecord(networkError)) {
    return undefined;
  }

  const statusCode = (networkError as NetworkErrorWithResponse).statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }

  const responseStatus = (networkError as NetworkErrorWithResponse).response?.status;
  if (typeof responseStatus === "number") {
    return responseStatus;
  }

  return undefined;
};

const hasGraphQLErrorCode = (
  graphQLErrors: unknown,
  predicate: (code: string) => boolean
): boolean => {
  if (!Array.isArray(graphQLErrors)) {
    return false;
  }

  return graphQLErrors.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const extensions = (entry as GraphQLErrorLike).extensions;
    const code = extensions?.code;
    return typeof code === "string" && predicate(code);
  });
};

export const classifyRequestError = (error: unknown): RequestErrorClassification => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { kind: "network" };
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return { kind: "permission", status };
    }
    if (typeof status === "number") {
      return status >= 500 ? { kind: "service", status } : { kind: "unknown", status };
    }
    return { kind: "network" };
  }

  if (isRecord(error)) {
    const apolloError = error as ApolloErrorLike;
    const networkStatus = getNetworkStatusCode(apolloError.networkError);

    if (networkStatus === 401 || networkStatus === 403) {
      return { kind: "permission", status: networkStatus };
    }

    if (typeof networkStatus === "number") {
      return networkStatus >= 500
        ? { kind: "service", status: networkStatus }
        : { kind: "network", status: networkStatus };
    }

    if (apolloError.networkError) {
      return { kind: "network" };
    }

    if (
      hasGraphQLErrorCode(apolloError.graphQLErrors, (code) =>
        ["UNAUTHENTICATED", "FORBIDDEN", "UNAUTHORIZED"].includes(code)
      )
    ) {
      return { kind: "permission" };
    }

    if (hasGraphQLErrorCode(apolloError.graphQLErrors, (code) => code === "INTERNAL_SERVER_ERROR")) {
      return { kind: "service" };
    }
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("failed to fetch") || message.includes("network") || message.includes("offline")) {
      return { kind: "network" };
    }
  }

  return { kind: "unknown" };
};
