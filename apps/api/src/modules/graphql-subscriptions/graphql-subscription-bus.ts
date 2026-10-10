import { createLogger } from "@modular/utils";
import type { OnModuleDestroy } from "@nestjs/common";
import type { PubSubEngine } from "graphql-subscriptions";

import {
  decodeGraphqlSubscriptionPayload,
  encodeGraphqlSubscriptionPayload,
} from "./graphql-subscription-codec";

export const GQL_SUBSCRIPTION_CHANNEL_PREFIX = "gqlsub:";

export type GraphqlSubscriptionBusMode = "redis" | "local";

export interface GraphqlSubscriptionRedisConnection {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: "message" | "error" | "ready", listener: (...args: unknown[]) => void): void;
  quit(): Promise<unknown>;
  disconnect(): void;
}

interface LocalSubscription {
  triggerName: string;
  onMessage: (payload: unknown) => void;
}

const DELIVERY_FAILURE_IMPACT =
  "Persisted alert, analysis, and assistant rows stay as written. Live subscribers on every instance missed this event. Delivery does not fall back to an in-process bus.";

/**
 * One Redis publisher connection and one Redis subscriber connection shared by
 * alerts, analysis, and assistant. The subscriber connection is never the
 * cache/command client: a connection in subscribe mode cannot run commands.
 */
export class GraphqlSubscriptionBus implements PubSubEngine, OnModuleDestroy {
  private readonly logger = createLogger({ name: "gql-subscription-bus" });
  private readonly subscriptions = new Map<number, LocalSubscription>();
  private readonly triggerCounts = new Map<string, number>();
  private nextSubscriptionId = 0;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private subscriberReady = false;

  constructor(
    readonly mode: GraphqlSubscriptionBusMode,
    private readonly publisher?: GraphqlSubscriptionRedisConnection,
    private readonly subscriber?: GraphqlSubscriptionRedisConnection,
  ) {
    if (mode === "redis") {
      if (!publisher || !subscriber) {
        throw new Error("Redis GraphQL subscription bus requires a publisher and a subscriber connection");
      }
      subscriber.on("message", (channel: unknown, message: unknown) => {
        if (typeof channel === "string" && typeof message === "string") {
          this.handleMessage(channel, message);
        }
      });
      subscriber.on("error", (error: unknown) => {
        this.logger.error({ error }, "GraphQL subscription Redis subscriber error");
      });
      publisher.on("error", (error: unknown) => {
        this.logger.error({ error }, "GraphQL subscription Redis publisher error");
      });
      subscriber.on("ready", () => {
        if (!this.subscriberReady) {
          this.subscriberReady = true;
          return;
        }
        void this.enqueue(() => this.restoreSubscriptions()).catch((error: unknown) => {
          this.logger.error({ error }, "Failed to restore GraphQL subscription channels");
        });
      });
    }
  }

  forDomain(createLocal: () => PubSubEngine): PubSubEngine {
    if (this.mode === "local") {
      return createLocal();
    }
    return this;
  }

  async publish<T>(triggerName: string, payload: T): Promise<void> {
    if (this.mode !== "redis" || !this.publisher || this.closing) {
      this.logDeliveryFailure(triggerName, payload, new Error("Redis subscription bus is not active"));
      return;
    }

    let encoded: string;
    try {
      encoded = encodeGraphqlSubscriptionPayload(payload);
    } catch (error) {
      this.logDeliveryFailure(triggerName, payload, error);
      return;
    }
    if (typeof encoded !== "string") {
      this.logDeliveryFailure(triggerName, payload, new Error("Subscription payload did not encode to JSON"));
      return;
    }

    try {
      await this.publisher.publish(this.channel(triggerName), encoded);
    } catch (error) {
      this.logDeliveryFailure(triggerName, payload, error);
    }
  }

  subscribe(triggerName: string, onMessage: (payload: unknown) => void): Promise<number> {
    return this.enqueue(() => this.subscribeLocked(triggerName, onMessage));
  }

  unsubscribe(subId: number): void {
    const subscription = this.subscriptions.get(subId);
    if (!subscription) {
      return;
    }
    this.subscriptions.delete(subId);
    void this.enqueue(() => this.releaseTrigger(subscription.triggerName)).catch((error: unknown) => {
      this.logger.warn({ error, subId }, "Failed to release GraphQL subscription channel");
    });
  }

  asyncIterator<T>(triggers: string | string[]): AsyncIterator<T> {
    const triggerList = typeof triggers === "string" ? [triggers] : [...triggers];
    return new GraphqlSubscriptionAsyncIterator<T>(this, triggerList);
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.subscriptions.clear();
    const channels = [...this.triggerCounts.keys()].map((triggerName) => this.channel(triggerName));
    this.triggerCounts.clear();
    if (this.subscriber && channels.length > 0) {
      try {
        await this.subscriber.unsubscribe(...channels);
      } catch (error) {
        this.logger.warn({ error }, "Failed to unsubscribe GraphQL subscription channels during shutdown");
      }
    }
    await this.quitConnection(this.publisher, "publisher");
    await this.quitConnection(this.subscriber, "subscriber");
  }

  private async subscribeLocked(
    triggerName: string,
    onMessage: (payload: unknown) => void,
  ): Promise<number> {
    if (this.closing || !this.subscriber) {
      throw new Error("GraphQL subscription bus is closed");
    }
    const current = this.triggerCounts.get(triggerName) ?? 0;
    if (current === 0) {
      await this.subscriber.subscribe(this.channel(triggerName));
    }
    const id = ++this.nextSubscriptionId;
    this.subscriptions.set(id, { triggerName, onMessage });
    this.triggerCounts.set(triggerName, current + 1);
    return id;
  }

  private async releaseTrigger(triggerName: string): Promise<void> {
    const remaining = (this.triggerCounts.get(triggerName) ?? 1) - 1;
    if (remaining > 0) {
      this.triggerCounts.set(triggerName, remaining);
      return;
    }
    this.triggerCounts.delete(triggerName);
    if (!this.subscriber || this.closing) {
      return;
    }
    await this.subscriber.unsubscribe(this.channel(triggerName));
  }

  private async restoreSubscriptions(): Promise<void> {
    if (!this.subscriber || this.closing) {
      return;
    }
    const channels = [...this.triggerCounts.keys()].map((triggerName) => this.channel(triggerName));
    if (channels.length === 0) {
      return;
    }
    await this.subscriber.subscribe(...channels);
    this.logger.info(
      { channels: channels.length },
      "Restored GraphQL subscription channels after Redis reconnect",
    );
  }

  private handleMessage = (channel: string, message: string): void => {
    if (this.closing) {
      return;
    }
    const triggerName = this.triggerFromChannel(channel);
    if (!triggerName) {
      return;
    }
    let payload: unknown;
    try {
      payload = decodeGraphqlSubscriptionPayload(message);
    } catch (error) {
      this.logger.error({ error, channel }, "Failed to decode GraphQL subscription payload");
      return;
    }
    for (const subscription of this.subscriptions.values()) {
      if (subscription.triggerName === triggerName) {
        subscription.onMessage(payload);
      }
    }
  };

  private logDeliveryFailure(triggerName: string, payload: unknown, error: unknown): void {
    const orgId =
      payload && typeof payload === "object" && "orgId" in payload
        ? (payload as { orgId?: unknown }).orgId
        : undefined;
    this.logger.error(
      { triggerName, orgId, error, impact: DELIVERY_FAILURE_IMPACT },
      "GraphQL subscription delivery failed",
    );
  }

  private async quitConnection(
    connection: GraphqlSubscriptionRedisConnection | undefined,
    role: "publisher" | "subscriber",
  ): Promise<void> {
    if (!connection) {
      return;
    }
    try {
      await connection.quit();
    } catch (error) {
      this.logger.warn({ error, role }, "Failed to quit GraphQL subscription Redis connection");
      connection.disconnect();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private channel(triggerName: string): string {
    return `${GQL_SUBSCRIPTION_CHANNEL_PREFIX}${triggerName}`;
  }

  private triggerFromChannel(channel: string): string | undefined {
    if (!channel.startsWith(GQL_SUBSCRIPTION_CHANNEL_PREFIX)) {
      return undefined;
    }
    const triggerName = channel.slice(GQL_SUBSCRIPTION_CHANNEL_PREFIX.length);
    return triggerName.length > 0 ? triggerName : undefined;
  }
}

class GraphqlSubscriptionAsyncIterator<T> implements AsyncIterator<T> {
  private readonly pullQueue: Array<(result: IteratorResult<T>) => void> = [];
  private readonly pushQueue: T[] = [];
  private subscriptionIds: number[] | undefined;
  private subscribeTask: Promise<void> | undefined;
  private listening = true;
  private closed = false;

  constructor(
    private readonly bus: GraphqlSubscriptionBus,
    private readonly triggers: string[],
  ) {}

  async next(): Promise<IteratorResult<T>> {
    if (!this.listening) {
      return { value: undefined, done: true };
    }
    await this.subscribeAll();
    if (!this.listening) {
      return { value: undefined, done: true };
    }
    return this.pullValue();
  }

  async return(): Promise<IteratorResult<T>> {
    this.listening = false;
    this.rejectWaiters();
    await this.closeSubscriptions();
    return { value: undefined, done: true };
  }

  async throw(error?: unknown): Promise<IteratorResult<T>> {
    await this.return();
    return Promise.reject(error);
  }

  private pullValue(): Promise<IteratorResult<T>> {
    const queued = this.pushQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ value: queued, done: false });
    }
    return new Promise((resolve) => {
      this.pullQueue.push(resolve);
    });
  }

  private push(value: T): void {
    if (!this.listening) {
      return;
    }
    const waiter = this.pullQueue.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.pushQueue.push(value);
  }

  private rejectWaiters(): void {
    while (this.pullQueue.length > 0) {
      const waiter = this.pullQueue.shift();
      waiter?.({ value: undefined, done: true });
    }
    this.pushQueue.length = 0;
  }

  private async subscribeAll(): Promise<void> {
    if (!this.subscribeTask) {
      this.subscribeTask = this.openSubscriptions();
    }
    await this.subscribeTask;
  }

  private async openSubscriptions(): Promise<void> {
    const ids: number[] = [];
    try {
      for (const triggerName of this.triggers) {
        if (!this.listening) {
          break;
        }
        const id = await this.bus.subscribe(triggerName, (payload: unknown) => {
          this.push(payload as T);
        });
        ids.push(id);
      }
    } catch (error) {
      this.subscriptionIds = ids;
      await this.closeSubscriptions();
      throw error;
    }
    this.subscriptionIds = ids;
    if (!this.listening) {
      await this.closeSubscriptions();
    }
  }

  private async closeSubscriptions(): Promise<void> {
    if (this.closed || !this.subscriptionIds) {
      return;
    }
    this.closed = true;
    const ids = this.subscriptionIds;
    this.subscriptionIds = [];
    for (const id of ids) {
      this.bus.unsubscribe(id);
    }
  }
}
