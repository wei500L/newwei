import { PubSub } from "graphql-subscriptions";

export const ALERTS_PUBSUB = Symbol("ALERTS_PUBSUB");

export type AlertEventPayload = {
  orgId: string;
  event: {
    id: string;
    ruleId: string;
    triggeredAt: string;
    message?: string;
    severity: string;
    metricValue: number;
    changePercent?: number | null;
    status: string;
  };
};

export const createAlertsPubSub = () => new PubSub<AlertEventPayload>();
