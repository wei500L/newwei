import { PubSub } from "graphql-subscriptions";

export const ASSISTANT_PUBSUB = Symbol("ASSISTANT_PUBSUB");

export interface AssistantEventPayload {
  orgId: string;
  run: {
    id: string;
    type: string;
    status: string;
    summary?: string;
    error?: string;
    createdAt: string;
  };
}

/** In-process bus restored by GRAPHQL_SUBSCRIPTION_BUS=local. */
export const createAssistantPubSub = () => new PubSub();

