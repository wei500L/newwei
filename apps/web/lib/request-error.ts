"use client";

import axios from "axios";

export type RequestErrorKind =
  | "network"
  | "timeout"
  | "auth"
  | "permission"
  | "rateLimit"
  | "notFound"
  | "validation"
  | "conflict"
  | "service"
  | "cancelled"
  | "unknown";

export interface RequestErrorClassification {
  kind: RequestErrorKind;
  status?: number;
  code?: string;
}

interface GraphQLErrorLike {
  extensions?: {
    code?: unknown;
    http?: {
      status?: unknown;
    };
    exception?: {
      status?: unknown;
    };
  };
}

interface ApolloErrorLike {
  graphQLErrors?: unknown;
  networkError?: unknown;
}

interface NetworkErrorWithResponse {
  statusCode?: unknown;
  code?: unknown;
  response?: {
    status?: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const toNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

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

const getNetworkErrorCode = (networkError: unknown): string | undefined => {
  if (!isRecord(networkError)) {
    return undefined;
  }
  return toNonEmptyString((networkError as NetworkErrorWithResponse).code);
};

const extractGraphQLErrorCodes = (graphQLErrors: unknown): string[] => {
  if (!Array.isArray(graphQLErrors)) {
    return [];
  }

  return graphQLErrors
    .map((entry) => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const code = (entry as GraphQLErrorLike).extensions?.code;
      return toNonEmptyString(code);
    })
    .filter((value): value is string => Boolean(value));
};

const extractGraphQLErrorStatus = (graphQLErrors: unknown): number | undefined => {
  if (!Array.isArray(graphQLErrors)) {
    return undefined;
  }

  for (const entry of graphQLErrors) {
    if (!isRecord(entry)) {
      continue;
    }

    const extensions = (entry as GraphQLErrorLike).extensions;
    const httpStatus = extensions?.http?.status;
    if (typeof httpStatus === "number") {
      return httpStatus;
    }
    const exceptionStatus = extensions?.exception?.status;
    if (typeof exceptionStatus === "number") {
      return exceptionStatus;
    }
  }

  return undefined;
};

const classifyHttpStatus = (status: number): RequestErrorClassification => {
  if (status === 401) {
    return { kind: "auth", status };
  }
  if (status === 403) {
    return { kind: "permission", status };
  }
  if (status === 404) {
    return { kind: "notFound", status };
  }
  if (status === 408 || status === 504) {
    return { kind: "timeout", status };
  }
  if (status === 409) {
    return { kind: "conflict", status };
  }
  if (status === 429) {
    return { kind: "rateLimit", status };
  }
  if (status === 400 || status === 422) {
    return { kind: "validation", status };
  }
  if (status >= 500) {
    return { kind: "service", status };
  }
  if (status >= 400) {
    return { kind: "unknown", status };
  }
  return { kind: "unknown", status };
};

const classifyGraphQLErrorCodes = (codes: string[]): RequestErrorKind | undefined => {
  if (codes.some((code) => ["UNAUTHENTICATED"].includes(code))) {
    return "auth";
  }
  if (codes.some((code) => ["FORBIDDEN", "UNAUTHORIZED"].includes(code))) {
    return "permission";
  }
  if (codes.some((code) => ["RATE_LIMITED", "TOO_MANY_REQUESTS"].includes(code))) {
    return "rateLimit";
  }
  if (
    codes.some((code) => ["BAD_USER_INPUT", "GRAPHQL_VALIDATION_FAILED", "BAD_REQUEST"].includes(code))
  ) {
    return "validation";
  }
  if (codes.some((code) => ["NOT_FOUND"].includes(code))) {
    return "notFound";
  }
  if (codes.some((code) => ["CONFLICT"].includes(code))) {
    return "conflict";
  }
  if (codes.some((code) => ["INTERNAL_SERVER_ERROR"].includes(code))) {
    return "service";
  }
  return undefined;
};

const isAbortError = (error: unknown): boolean => {
  if (error instanceof Error) {
    return error.name === "AbortError";
  }
  if (isRecord(error)) {
    return error.name === "AbortError";
  }
  return false;
};

const withCode = (classification: RequestErrorClassification, code: string | undefined): RequestErrorClassification =>
  code ? { ...classification, code } : classification;

export const classifyRequestError = (error: unknown): RequestErrorClassification => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { kind: "network" };
  }

  if (isAbortError(error)) {
    return { kind: "cancelled" };
  }

  if (axios.isAxiosError(error)) {
    if (axios.isCancel(error) || error.code === "ERR_CANCELED") {
      return withCode({ kind: "cancelled" }, typeof error.code === "string" ? error.code : undefined);
    }

    const axiosCode = typeof error.code === "string" ? error.code : undefined;
    const axiosMessage = typeof error.message === "string" ? error.message.toLowerCase() : "";
    if (axiosCode === "ECONNABORTED" || axiosMessage.includes("timeout")) {
      return withCode({ kind: "timeout" }, axiosCode);
    }

    const status = error.response?.status;
    if (typeof status === "number") {
      return withCode(classifyHttpStatus(status), axiosCode);
    }
    return withCode({ kind: "network" }, axiosCode);
  }

  if (isRecord(error)) {
    const apolloError = error as ApolloErrorLike;
    const networkStatus = getNetworkStatusCode(apolloError.networkError);
    const networkCode = getNetworkErrorCode(apolloError.networkError);

    if (typeof networkStatus === "number") {
      return withCode(classifyHttpStatus(networkStatus), networkCode);
    }

    if (apolloError.networkError) {
      if (networkCode === "ECONNABORTED") {
        return withCode({ kind: "timeout" }, networkCode);
      }
      return withCode({ kind: "network" }, networkCode);
    }

    const graphQLErrorStatus = extractGraphQLErrorStatus(apolloError.graphQLErrors);
    if (typeof graphQLErrorStatus === "number") {
      return classifyHttpStatus(graphQLErrorStatus);
    }

    const codes = extractGraphQLErrorCodes(apolloError.graphQLErrors);
    const classifiedKind = classifyGraphQLErrorCodes(codes);
    if (classifiedKind) {
      return { kind: classifiedKind, code: codes[0] };
    }
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timeout") || message.includes("timed out")) {
      return { kind: "timeout" };
    }
    if (message.includes("canceled") || message.includes("cancelled") || message.includes("abort")) {
      return { kind: "cancelled" };
    }
    if (message.includes("failed to fetch") || message.includes("network") || message.includes("offline")) {
      return { kind: "network" };
    }
  }

  return { kind: "unknown" };
};
