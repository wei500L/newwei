"use client";

import { useApolloClient } from "@apollo/client";
import { message } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { AlertEventsStreamDocument, type AlertEventsStreamSubscription } from "@/graphql/generated";

export function LiveAlertsToasts() {
  const { t } = useTranslation();
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
            message.warning(
              t("alerts.live.message", {
                severity: evt.severity,
                message: evt.message ?? t("alerts.events.triggered"),
                value: evt.metricValue ?? t("common.notAvailable")
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
  }, [client, t]);

  return null;
}
