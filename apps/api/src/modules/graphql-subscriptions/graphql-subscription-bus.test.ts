import type { AlertEventStatus, AlertSeverity } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { serializeAlertEventPayload } from "../../graphql/resolvers/alerts.serialization";
import type { AlertEventPayload } from "../alerts/alerts.pubsub";

import {
  GQL_SUBSCRIPTION_CHANNEL_PREFIX,
  GraphqlSubscriptionBus,
  type GraphqlSubscriptionRedisConnection,
} from "./graphql-subscription-bus";
import {
  decodeGraphqlSubscriptionPayload,
  encodeGraphqlSubscriptionPayload,
} from "./graphql-subscription-codec";
import { subscriptionPayloadMatchesOrg } from "./subscription-org";

class FakeRedis implements GraphqlSubscriptionRedisConnection {
  readonly channels = new Set<string>();
  subscribeCalls = 0;
  readonly quit = vi.fn(async () => "OK");
  readonly disconnect = vi.fn();
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  async publish(channel: string, message: string): Promise<number> {
    this.emit("message", channel, message);
    return this.channels.has(channel) ? 1 : 0;
  }

  async subscribe(...channels: string[]): Promise<number> {
    this.subscribeCalls += 1;
    for (const channel of channels) {
      this.channels.add(channel);
    }
    return channels.length;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    for (const channel of channels) {
      this.channels.delete(channel);
    }
    return channels.length;
  }

  on(event: "message" | "error" | "ready", listener: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: "message" | "error" | "ready", ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function createBus(): {
  bus: GraphqlSubscriptionBus;
  publisher: FakeRedis;
  subscriber: FakeRedis;
} {
  const publisher = new FakeRedis();
  const subscriber = new FakeRedis();
  publisher.publish = vi.fn(async (channel: string, message: string) => {
    subscriber.emit("message", channel, message);
    return subscriber.channels.has(channel) ? 1 : 0;
  });
  return {
    bus: new GraphqlSubscriptionBus("redis", publisher, subscriber),
    publisher,
    subscriber,
  };
}

describe("graphql subscription codec", () => {
  it("round-trips dates, numbers, nulls, omitted optionals, and context", () => {
    const triggeredAt = new Date("2026-01-02T03:04:05.000Z");
    const payload: AlertEventPayload = {
      orgId: "org-a",
      event: {
        id: "evt-1",
        ruleId: "rule-1",
        ruleName: "memory",
        triggeredAt,
        message: undefined,
        severity: "low" as AlertSeverity,
        metricValue: 12.5,
        changePercent: null,
        status: "delivered" as AlertEventStatus,
        context: {
          totalBytes: 100,
          nestedAt: triggeredAt,
          skipped: undefined,
        },
      },
    };

    const decoded = decodeGraphqlSubscriptionPayload(
      encodeGraphqlSubscriptionPayload(payload),
    ) as AlertEventPayload;

    expect(decoded.orgId).toBe("org-a");
    expect(decoded.event.triggeredAt).toBeInstanceOf(Date);
    expect(decoded.event.triggeredAt.toISOString()).toBe(triggeredAt.toISOString());
    expect(decoded.event.metricValue).toBe(12.5);
    expect(decoded.event.changePercent).toBeNull();
    expect(decoded.event).not.toHaveProperty("message");
    expect(decoded.event.context).toEqual({
      totalBytes: 100,
      nestedAt: triggeredAt,
    });

    const model = serializeAlertEventPayload(decoded);
    expect(model.triggeredAt.toISOString()).toBe(triggeredAt.toISOString());
    expect(model.metricValue).toBe(12.5);
    expect(model.changePercent).toBeNull();
    expect(model.message).toBeUndefined();
    expect(model.context).toMatchObject({ totalBytes: 100 });
    expect((model.context as { nestedAt: Date }).nestedAt).toBeInstanceOf(Date);
  });

  it("turns non-finite numbers into null the same way JSON does", () => {
    const decoded = decodeGraphqlSubscriptionPayload(
      encodeGraphqlSubscriptionPayload({ metricValue: Number.POSITIVE_INFINITY, changePercent: Number.NaN }),
    );
    expect(decoded).toEqual({ metricValue: null, changePercent: null });
  });
});

describe("subscription org isolation", () => {
  it("accepts only the authenticated org", () => {
    expect(subscriptionPayloadMatchesOrg({ orgId: "org-a" }, "org-a")).toBe(true);
    expect(subscriptionPayloadMatchesOrg({ orgId: "org-a" }, "org-b")).toBe(false);
    expect(subscriptionPayloadMatchesOrg({}, "org-a")).toBe(false);
    expect(subscriptionPayloadMatchesOrg(null, "org-a")).toBe(false);
  });
});

describe("graphql subscription bus", () => {
  it("delivers one decoded event and drops the Redis channel when the iterator returns", async () => {
    const { bus, subscriber } = createBus();
    subscriber.emit("ready");
    const iterator = bus.asyncIterator<{ orgId: string; event: { triggeredAt: Date } }>("alertEvents");
    const pending = iterator.next();
    const channel = `${GQL_SUBSCRIPTION_CHANNEL_PREFIX}alertEvents`;
    await vi.waitFor(() => {
      expect(subscriber.channels.has(channel)).toBe(true);
    });

    const triggeredAt = new Date("2026-04-05T06:07:08.000Z");
    await bus.publish("alertEvents", { orgId: "org-a", event: { triggeredAt } });
    const result = await pending;
    expect(result.done).toBe(false);
    if (result.done) {
      throw new Error("expected an event");
    }
    expect(result.value.orgId).toBe("org-a");
    expect(result.value.event.triggeredAt).toBeInstanceOf(Date);
    expect(result.value.event.triggeredAt.toISOString()).toBe(triggeredAt.toISOString());

    await iterator.return?.();
    await vi.waitFor(() => {
      expect(subscriber.channels.has(channel)).toBe(false);
    });
    await bus.onModuleDestroy();
  });

  it("keeps the Redis channel until the last local listener unsubscribes", async () => {
    const { bus, subscriber } = createBus();
    const channel = `${GQL_SUBSCRIPTION_CHANNEL_PREFIX}analysisEvents`;
    const first = await bus.subscribe("analysisEvents", () => undefined);
    const second = await bus.subscribe("analysisEvents", () => undefined);
    expect(subscriber.subscribeCalls).toBe(1);

    bus.unsubscribe(first);
    await Promise.resolve();
    expect(subscriber.channels.has(channel)).toBe(true);

    bus.unsubscribe(second);
    await vi.waitFor(() => {
      expect(subscriber.channels.has(channel)).toBe(false);
    });
  });

  it("does not deliver a different trigger and does not fall back when Redis publish fails", async () => {
    const { bus, publisher } = createBus();
    const received: string[] = [];
    await bus.subscribe("assistantEvents", (payload) => {
      received.push(JSON.stringify(payload));
    });
    await bus.publish("alertEvents", { orgId: "org-a" });
    expect(received).toEqual([]);

    publisher.publish = vi.fn(async () => {
      throw new Error("connection is closed");
    });
    await expect(bus.publish("assistantEvents", { orgId: "org-a" })).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });

  it("resubscribes active channels after the subscriber reconnects and quits both clients", async () => {
    const { bus, publisher, subscriber } = createBus();
    subscriber.emit("ready");
    await bus.subscribe("alertEvents", () => undefined);
    expect(subscriber.subscribeCalls).toBe(1);

    subscriber.emit("ready");
    await vi.waitFor(() => {
      expect(subscriber.subscribeCalls).toBe(2);
    });

    publisher.quit.mockRejectedValueOnce(new Error("quit failed"));
    await bus.onModuleDestroy();
    expect(publisher.disconnect).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it("uses a fresh in-process bus when rollback mode is local", () => {
    const bus = new GraphqlSubscriptionBus("local");
    const first = bus.forDomain(() => ({ kind: "local" }) as never);
    const second = bus.forDomain(() => ({ kind: "local" }) as never);
    expect(first).not.toBe(bus);
    expect(second).not.toBe(bus);
    expect(first).not.toBe(second);
  });
});
