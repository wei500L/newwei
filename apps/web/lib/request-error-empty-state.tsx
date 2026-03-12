"use client";

import type { TFunction } from "i18next";
import type { ReactNode } from "react";

import type { ChartEmptyStateVariant } from "@/components/chart-empty-state";
import { extractApiError } from "@/lib/api-error";
import { classifyRequestError } from "@/lib/request-error";

export interface RequestErrorEmptyState {
  variant: ChartEmptyStateVariant;
  title: string;
  description: ReactNode;
  actionLabel?: string;
  actionLoading?: boolean;
  onAction?: () => void;
  detailText?: string;
}

interface BuildRequestErrorEmptyStateOptions {
  t: TFunction;
  error: unknown;
  onRetry?: () => void;
  actionLoading?: boolean;
  actionLabelOverride?: string;
  includeDetailText?: boolean;
}

const getLoginHref = (): string => {
  if (typeof window === "undefined") {
    return "/login?sessionExpired=1";
  }

  const callbackUrl = `${window.location.pathname}${window.location.search}`;
  return `/login?sessionExpired=1&callbackUrl=${encodeURIComponent(callbackUrl)}`;
};

const dedupeParts = (parts: (string | null | undefined)[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    result.push(part);
  }
  return result;
};

export const buildRequestErrorEmptyState = ({
  t,
  error,
  onRetry,
  actionLoading,
  actionLabelOverride,
  includeDetailText = true
}: BuildRequestErrorEmptyStateOptions): RequestErrorEmptyState => {
  const classification = classifyRequestError(error);
  const apiError = extractApiError(error);

  const base = (() => {
    switch (classification.kind) {
      case "network":
        return {
          variant: "offline" as const,
          title: t("dashboard.dataOffline.title", { defaultValue: "Offline" }),
          description: t("dashboard.dataOffline.description", {
            defaultValue: "Cannot reach the service. Check your connection and retry."
          })
        };
      case "auth":
        return {
          variant: "permission" as const,
          title: t("auth.sessionExpired", { defaultValue: "Session expired" }),
          description: t("auth.login.sessionExpired", {
            defaultValue: "Your session has expired. Please sign in again."
          }),
          actionLabel: t("auth.login.submit", { defaultValue: "Sign in" }),
          onAction: () => window.location.assign(getLoginHref())
        };
      case "permission":
        return {
          variant: "permission" as const,
          title: t("common.accessDenied", { defaultValue: "Access denied" }),
          description: t("common.accessDeniedDescription", {
            defaultValue:
              "You don't have permission to view this data. Contact an administrator if you need access."
          })
        };
      case "timeout":
        return {
          variant: "delayed" as const,
          title: t("common.requestTimeoutTitle", { defaultValue: "Request timed out" }),
          description: t("common.requestTimeoutDescription", {
            defaultValue: "The request took too long. Please retry in a moment."
          })
        };
      case "rateLimit":
        return {
          variant: "delayed" as const,
          title: t("common.rateLimitedTitle", { defaultValue: "Too many requests" }),
          description: t("common.rateLimitedDescription", {
            defaultValue: "You hit a rate limit. Please wait a bit and try again."
          })
        };
      case "notFound":
        return {
          variant: "error" as const,
          title: t("common.notFoundTitle", { defaultValue: "Not found" }),
          description: t("common.notFoundDescription", {
            defaultValue: "The requested resource is not available."
          })
        };
      case "validation":
        return {
          variant: "error" as const,
          title: t("common.invalidInput", { defaultValue: "Invalid input." }),
          description:
            apiError.message ||
            t("common.invalidRequestDescription", {
              defaultValue: "The request is invalid. Please adjust your input and retry."
            })
        };
      case "conflict":
        return {
          variant: "error" as const,
          title: t("common.conflictTitle", { defaultValue: "Conflict" }),
          description:
            apiError.message ||
            t("common.conflictDescription", {
              defaultValue: "The request conflicts with the current state. Please refresh and retry."
            })
        };
      case "cancelled":
        return {
          variant: "empty" as const,
          title: t("common.requestCancelledTitle", { defaultValue: "Request cancelled" }),
          description: t("common.requestCancelledDescription", {
            defaultValue: "The request was cancelled."
          })
        };
      case "service":
        return {
          variant: "error" as const,
          title: t("common.requestFailed", { defaultValue: "Request failed" }),
          description: t("common.serviceUnavailable", {
            defaultValue: "Service is unavailable. Please try again."
          })
        };
      case "unknown":
      default:
        return {
          variant: "error" as const,
          title: t("common.requestFailed", { defaultValue: "Request failed" }),
          description:
            apiError.message || t("common.unexpectedError", { defaultValue: "Unexpected error" })
        };
    }
  })();

  const detailParts = dedupeParts([
    classification.status ? `HTTP ${classification.status}` : null,
    classification.code ? `code: ${classification.code}` : null,
    apiError.code ? `code: ${apiError.code}` : null,
    apiError.detail ?? null,
    classification.kind === "unknown" || classification.kind === "validation" || classification.kind === "conflict"
      ? apiError.message
      : null
  ]);
  const detailText = detailParts.join(" • ");

  const shouldShowRetry =
    Boolean(onRetry) && !["permission", "auth", "cancelled"].includes(classification.kind);

  const actionLabel =
    actionLabelOverride ??
    base.actionLabel ??
    (shouldShowRetry ? t("common.retry", { defaultValue: "Retry" }) : undefined);
  const onAction = base.onAction ?? (shouldShowRetry ? onRetry : undefined);

  const descriptionNode: ReactNode =
    includeDetailText && detailText ? (
      <div className="flex flex-col items-center gap-1">
        <span>{base.description}</span>
        <span className="font-mono text-[10px] opacity-80">{detailText}</span>
      </div>
    ) : (
      base.description
    );

  return {
    variant: base.variant,
    title: base.title,
    description: descriptionNode,
    ...(actionLabel ? { actionLabel } : {}),
    ...(typeof actionLoading === "boolean" ? { actionLoading } : {}),
    ...(onAction ? { onAction } : {}),
    ...(detailText ? { detailText } : {})
  };
};
