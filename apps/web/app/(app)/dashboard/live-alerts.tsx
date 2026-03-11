"use client";

import { useApolloClient } from "@apollo/client";
import { App } from "antd";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { AlertEventsStreamDocument, type AlertEventsStreamSubscription } from "@/graphql/generated";
import { useBufferedBatch, useTimedValueDeduper } from "@/lib/use-realtime-helpers";

const LIVE_ALERTS_TOAST_KEY = "dashboard-live-alerts";
const LIVE_ALERTS_FLUSH_MS = 1000;
const LIVE_ALERTS_MAX_SEEN = 200;

export function LiveAlertsToasts() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useApolloClient();
  const shouldShowStreamError = useTimedValueDeduper(30_000);

  const formatAlertMessage = useCallback((evt: AlertEventsStreamSubscription["alertEvents"]) => {
    const metricValue =
      typeof evt.metricValue === "number" && Number.isFinite(evt.metricValue)
        ? evt.metricValue
        : null;
    const changePercent =
      typeof evt.changePercent === "number" && Number.isFinite(evt.changePercent)
        ? evt.changePercent
        : null;
    const context =
      evt.context && typeof evt.context === "object" && !Array.isArray(evt.context)
        ? (evt.context as Record<string, unknown>)
        : null;
    const contextTags = [
      typeof context?.countryName === "string" ? context.countryName : null,
      typeof context?.countryCode === "string" ? context.countryCode : null,
      typeof context?.itemName === "string" ? context.itemName : null,
      typeof context?.resource === "string" ? context.resource : null,
      typeof context?.action === "string" ? context.action : null
    ].filter(Boolean) as string[];
    const contextSuffix = contextTags.length > 0 ? ` · ${contextTags.slice(0, 3).join(" · ")}` : "";
    return t("alerts.live.message", {
      defaultValue: "[{{severity}}] {{title}} · value {{value}} · change {{change}}{{context}}",
      severity: evt.severity,
      title: evt.ruleName ?? evt.metricSlug ?? t("alerts.events.triggered", { defaultValue: "Alert triggered" }),
      value: metricValue ?? t("common.notAvailable", { defaultValue: "N/A" }),
      change:
        changePercent !== null ? `${changePercent.toFixed(2)}%` : t("common.notAvailable", { defaultValue: "N/A" }),
      context: contextSuffix
    });
  }, [t]);

  const { add: enqueueAlertToast } = useBufferedBatch<
    AlertEventsStreamSubscription["alertEvents"]
  >({
    delayMs: LIVE_ALERTS_FLUSH_MS,
    dedupeKey: (evt) => evt.id,
    maxSeenKeys: LIVE_ALERTS_MAX_SEEN,
    onFlush: (alerts) => {
      const firstAlert = alerts[0];
      if (!firstAlert) {
        return;
      }
      const content =
        alerts.length === 1
          ? formatAlertMessage(firstAlert)
          : t("alerts.live.batchMessage", {
              defaultValue: "{{count}} alerts triggered · {{titles}}",
              count: alerts.length,
              titles: alerts
                .map((evt) =>
                  evt.ruleName ??
                  evt.metricSlug ??
                  t("alerts.events.triggered", { defaultValue: "Alert triggered" }),
                )
                .filter((title, index, values) => values.indexOf(title) === index)
                .slice(0, 3)
                .join(" · "),
            });
      message.open({
        type: "warning",
        key: LIVE_ALERTS_TOAST_KEY,
        content,
      });
    },
  });

  useEffect(() => {
    const sub = client
      .subscribe<AlertEventsStreamSubscription>({
        query: AlertEventsStreamDocument,
      })
      .subscribe({
        next: (payload) => {
          const evt = payload.data?.alertEvents;
          if (!evt) {
            return;
          }
          enqueueAlertToast(evt);
        },
        error: (error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const toastMessage = t("alerts.streamError", { error: errorMessage });
          if (!shouldShowStreamError(toastMessage)) {
            return;
          }
          message.error(toastMessage);
        },
      });
    return () => {
      sub.unsubscribe();
    };
  }, [client, enqueueAlertToast, message, shouldShowStreamError, t]);

  return null;
}
