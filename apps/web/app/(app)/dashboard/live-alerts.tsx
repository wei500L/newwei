"use client";

import { useApolloClient } from "@apollo/client";
import { App } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { AlertEventsStreamDocument, type AlertEventsStreamSubscription } from "@/graphql/generated";

export function LiveAlertsToasts() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useApolloClient();
  const notifiedRef = useRef(false);

  useEffect(() => {
    const sub = client
      .subscribe<AlertEventsStreamSubscription>({
        query: AlertEventsStreamDocument,
      })
      .subscribe({
        next: (payload) => {
          const evt = payload.data?.alertEvents;
          if (evt) {
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
            message.warning(
              t("alerts.live.message", {
                defaultValue: "[{{severity}}] {{title}} · value {{value}} · change {{change}}{{context}}",
                severity: evt.severity,
                title: evt.ruleName ?? evt.metricSlug ?? t("alerts.events.triggered", { defaultValue: "Alert triggered" }),
                value: metricValue ?? t("common.notAvailable", { defaultValue: "N/A" }),
                change:
                  changePercent !== null ? `${changePercent.toFixed(2)}%` : t("common.notAvailable", { defaultValue: "N/A" }),
                context: contextSuffix
              })
            );
          }
        },
        error: (error) => {
          if (notifiedRef.current) {
            return;
          }
          notifiedRef.current = true;
          const errorMessage = error instanceof Error ? error.message : String(error);
          message.error(t("alerts.streamError", { error: errorMessage }));
        },
      });
    return () => {
      sub.unsubscribe();
      notifiedRef.current = false;
    };
  }, [client, message, t]);

  return null;
}
