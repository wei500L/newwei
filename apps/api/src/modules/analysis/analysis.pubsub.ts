import { PubSub } from "graphql-subscriptions";

export const ANALYSIS_PUBSUB = Symbol("ANALYSIS_PUBSUB");

export interface AnalysisEventPayload {
  orgId: string;
  result: {
    id: string;
    type: string;
    status: string;
    summary?: string;
    error?: string;
    createdAt: string;
  };
}

/** In-process bus restored by GRAPHQL_SUBSCRIPTION_BUS=local. */
export const createAnalysisPubSub = () => new PubSub();
