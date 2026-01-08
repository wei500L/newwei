"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import type { ChartDataState } from "@/lib/chart-data-state";
import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

export interface ChartStateBannerProps {
  state: ChartDataState;
  hasData: boolean;
  error?: Error | null;
  latestTimestamp?: Date | null;
  delayMs?: number | null;
  expectedIntervalMs?: number | null;
  locale: SupportedLocale;
  onRetry?: (() => void) | undefined;
}

function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days > 0) {
    return minutes > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, totalMinutes)}m`;
}

function isLikelyOfflineError(error: Error | null | undefined): boolean {
  if (!error) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  const networkError = (error as unknown as { networkError?: unknown }).networkError;
  if (networkError) {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("failed to fetch") || message.includes("network") || message.includes("offline");
}

export function ChartStateBanner({
  state,
  hasData,
  error,
  latestTimestamp,
  delayMs,
  expectedIntervalMs,
  locale,
  onRetry
}: ChartStateBannerProps) {
  const { t } = useTranslation();

  const isOffline = useMemo(() => isLikelyOfflineError(error), [error]);

  if (state === "error") {
    return (
      <ChartEmptyState
        presentation="banner"
        variant={isOffline ? "offline" : "error"}
        title={
          isOffline
            ? t("dashboard.dataOffline.title", { defaultValue: "Offline" })
            : t("dashboard.dataAbnormal", { defaultValue: "Data error" })
        }
        description={
          isOffline
            ? t("dashboard.dataOffline.description", {
                defaultValue: "Cannot reach the service. Check your connection and retry."
              })
            : error?.message ??
              t("common.error.unexpected", { defaultValue: "Unexpected error" })
        }
        actionLabel={onRetry ? t("common.retry") : undefined}
        onAction={onRetry}
      />
    );
  }

  if (state === "backfilling") {
    if (!hasData) {
      return null;
    }
    return (
      <ChartEmptyState
        presentation="banner"
        variant="backfilling"
        title={t("dashboard.dataBackfilling.title", { defaultValue: "Updating data" })}
        description={t("dashboard.dataBackfilling.description", {
          defaultValue: "Data is being backfilled. Values may update shortly."
        })}
      />
    );
  }

  if (state === "delayed") {
    const formattedLatest = latestTimestamp
      ? formatDateTime(latestTimestamp.toISOString(), locale, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        })
      : null;

    const lagText = delayMs ? formatDurationShort(delayMs) : null;
    const intervalText = expectedIntervalMs ? formatDurationShort(expectedIntervalMs) : null;

    const description =
      formattedLatest && lagText && intervalText
        ? t("dashboard.dataDelayed.explained", {
            defaultValue:
              "Latest data at {{time}} (≈{{lag}} behind). Expected interval ≈{{interval}}.",
            time: formattedLatest,
            lag: lagText,
            interval: intervalText
          })
        : latestTimestamp
          ? t("dashboard.dataDelayed.latest", {
              defaultValue: "Latest data at {{time}}.",
              time:
                formattedLatest ??
                formatDateTime(latestTimestamp.toISOString(), locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                })
            })
          : t("dashboard.dataDelayed.missing", {
              defaultValue: "Latest data time unavailable."
            });

    return (
      <ChartEmptyState
        presentation="banner"
        variant="delayed"
        title={t("dashboard.dataDelayed.title", { defaultValue: "Data delayed" })}
        description={description}
        actionLabel={onRetry ? t("common.refresh") : undefined}
        onAction={onRetry}
      />
    );
  }

  if (state === "empty") {
    return (
      <ChartEmptyState
        title={t("dashboard.dataEmpty", { defaultValue: "No data" })}
        description={t("dashboard.dataEmptyHint", {
          defaultValue: "No data for the selected range. Try expanding the range."
        })}
      />
    );
  }

  return null;
}

