import { PubSub } from "graphql-subscriptions";
import { AlertEventStatus, AlertMetricProvider, AlertSeverity } from "@prisma/client";

export const ALERTS_PUBSUB = Symbol("ALERTS_PUBSUB");

export interface AlertEventPayload {
  orgId: string;
  event: {
    id: string;
    ruleId: string;
    ruleName?: string;
    metricProvider?: AlertMetricProvider;
    metricSlug?: string;
    triggeredAt: Date;
    message?: string;
    severity: AlertSeverity;
    metricValue: number;
    changePercent?: number | null;
    status: AlertEventStatus;
    context?: Record<string, unknown> | null;
  };
}

export const createAlertsPubSub = () => new PubSub();
