"use client";

import { useEffect } from "react";
import { message } from "antd";
import { useApolloClient } from "@apollo/client";
import { AlertEventsStreamDocument, AlertEventsStreamSubscription } from "@/graphql/generated";

export function LiveAlertsToasts() {
  const client = useApolloClient();

  useEffect(() => {
    const sub = client.subscribe<AlertEventsStreamSubscription>({ query: AlertEventsStreamDocument }).subscribe({
      next: (payload) => {
        const evt = payload.data?.alertEvents;
        if (evt) {
          message.warning(`[Alert] ${evt.severity} • ${evt.message ?? "Triggered"} • value=${evt.metricValue ?? "n/a"}`);
        }
      }
    });
    return () => sub.unsubscribe();
  }, [client]);

  return null;
}
