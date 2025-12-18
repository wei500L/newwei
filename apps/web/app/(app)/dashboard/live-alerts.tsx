"use client";

import { useApolloClient } from "@apollo/client";
import { message } from "antd";
import { useEffect, useRef } from "react";

import { AlertEventsStreamDocument, type AlertEventsStreamSubscription } from "@/graphql/generated";

export function LiveAlertsToasts() {
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
              `[Alert] ${evt.severity} • ${evt.message ?? "Triggered"} • value=${evt.metricValue ?? "n/a"}`,
            );
          }
        },
        error: (error) => {
          if (notifiedRef.current) {
            return;
          }
          notifiedRef.current = true;
          const errorMessage = error instanceof Error ? error.message : String(error);
          message.error(`Alert stream error: ${errorMessage}`);
        },
      });
    return () => {
      sub.unsubscribe();
      notifiedRef.current = false;
    };
  }, [client]);

  return null;
}
