"use client";

import { useEffect } from "react";
import { message } from "antd";
import { useApolloClient } from "@apollo/client";
import { AlertEventsDocument, AlertEventsSubscription } from "@/graphql/generated";

export function LiveAlertsToasts() {
  const client = useApolloClient();

  useEffect(() => {
    const sub = client.subscribe<AlertEventsSubscription>({ query: AlertEventsDocument }).subscribe({
      next: (payload) => {
        const evt = payload.data?.alertEvents;
        if (evt) {
          message.warning(`[Alert] ${evt.severity} • ${evt.message ?? "Triggered"} • ${evt.triggeredAt}`);
        }
      }
    });
    return () => sub.unsubscribe();
  }, [client]);

  return null;
}
