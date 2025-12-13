import { PubSub } from "graphql-subscriptions";

export const ANALYSIS_PUBSUB = Symbol("ANALYSIS_PUBSUB");

export type AnalysisEventPayload = {
  orgId: string;
  result: {
    id: string;
    type: string;
    status: string;
    summary?: string;
    error?: string;
    createdAt: string;
  };
};

export const createAnalysisPubSub = () => new PubSub<AnalysisEventPayload>();
