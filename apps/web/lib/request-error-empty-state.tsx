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
          title: t("dashboard.dataOffline.title"),
          description: t("dashboard.dataOffline.description")
        };
      case "auth":
        return {
          variant: "permission" as const,
          title: t("auth.sessionExpired"),
          description: t("auth.login.sessionExpired"),
          actionLabel: t("auth.login.submit"),
          onAction: () => window.location.assign(getLoginHref())
        };
      case "permission":
        return {
          variant: "permission" as const,
          title: t("common.accessDenied"),
          description: t("common.accessDeniedDescription")
        };
      case "timeout":
        return {
          variant: "delayed" as const,
          title: t("common.requestTimeoutTitle"),
          description: t("common.requestTimeoutDescription")
        };
      case "rateLimit":
        return {
          variant: "delayed" as const,
          title: t("common.rateLimitedTitle"),
          description: t("common.rateLimitedDescription")
        };
      case "notFound":
        return {
          variant: "error" as const,
          title: t("common.notFoundTitle"),
          description: t("common.notFoundDescription")
        };
      case "validation":
        return {
          variant: "error" as const,
          title: t("common.invalidInput"),
          description:
            apiError.message ||
            t("common.invalidRequestDescription")
        };
      case "conflict":
        return {
          variant: "error" as const,
          title: t("common.conflictTitle"),
          description:
            apiError.message ||
            t("common.conflictDescription")
        };
      case "cancelled":
        return {
          variant: "empty" as const,
          title: t("common.requestCancelledTitle"),
          description: t("common.requestCancelledDescription")
        };
      case "service":
        return {
          variant: "error" as const,
          title: t("common.requestFailed"),
          description: t("common.serviceUnavailable")
        };
      case "unknown":
      default:
        return {
          variant: "error" as const,
          title: t("common.requestFailed"),
          description:
            apiError.message || t("common.unexpectedError")
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
    (shouldShowRetry ? t("common.retry") : undefined);
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
