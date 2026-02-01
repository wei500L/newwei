"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";

export interface RequestErrorBannerProps {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  showCachedDataHint?: boolean;
  includeDetailText?: boolean;
  presentation?: "banner" | "center";
}

export function RequestErrorBanner({
  error,
  onRetry,
  className,
  showCachedDataHint = false,
  includeDetailText = false,
  presentation = "banner"
}: RequestErrorBannerProps) {
  const { t } = useTranslation();
  const state = buildRequestErrorEmptyState({ t, error, onRetry, includeDetailText });

  const cachedHint = showCachedDataHint
    ? t("common.showingCachedData", { defaultValue: "Showing cached data." })
    : null;

  const description: ReactNode =
    cachedHint || (!includeDetailText && state.detailText) ? (
      <div className="flex flex-col gap-1">
        {cachedHint ? <span>{cachedHint}</span> : null}
        <span>{state.description}</span>
        {!includeDetailText && state.detailText ? (
          <span className="font-mono text-[10px] opacity-80">{state.detailText}</span>
        ) : null}
      </div>
    ) : (
      state.description
    );

  return (
    <ChartEmptyState
      className={className}
      presentation={presentation}
      variant={state.variant}
      title={state.title}
      description={description}
      actionLabel={state.actionLabel}
      onAction={state.onAction}
    />
  );
}

