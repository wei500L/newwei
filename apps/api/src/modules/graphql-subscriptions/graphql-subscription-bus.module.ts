import { Module } from "@nestjs/common";
import Redis from "ioredis";

import { EnvService } from "../config/config.service";
import { toIoredisConnection } from "../config/redis-connection";

import {
  GraphqlSubscriptionBus,
  type GraphqlSubscriptionBusMode,
  type GraphqlSubscriptionRedisConnection,
} from "./graphql-subscription-bus";

function attachRedisListeners(
  client: Redis,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (event === "message") {
    client.on("message", listener as (channel: string, message: string) => void);
    return;
  }
  if (event === "error") {
    client.on("error", listener as (error: Error) => void);
    return;
  }
  if (event === "ready") {
    client.on("ready", listener as () => void);
  }
}

function createRedisConnection(env: EnvService, role: "pub" | "sub"): GraphqlSubscriptionRedisConnection {
  const client = new Redis({
    ...toIoredisConnection(env.redisConfig),
    enableAutoPipelining: false,
    connectionName: `modular-api:gql-${role}:${process.pid}`,
    maxRetriesPerRequest: role === "pub" ? 1 : null,
    enableOfflineQueue: role === "sub",
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });
  return {
    publish: (channel, message) => client.publish(channel, message),
    subscribe: (...channels: string[]) =>
      (client.subscribe as (...args: string[]) => Promise<unknown>)(...channels),
    unsubscribe: (...channels: string[]) =>
      (client.unsubscribe as (...args: string[]) => Promise<unknown>)(...channels),
    on: (event, listener) => {
      attachRedisListeners(client, event, listener);
    },
    quit: () => client.quit(),
    disconnect: () => {
      client.disconnect();
    },
  };
}

@Module({
  providers: [
    {
      provide: GraphqlSubscriptionBus,
      inject: [EnvService],
      useFactory: (env: EnvService): GraphqlSubscriptionBus => {
        const mode: GraphqlSubscriptionBusMode = env.graphqlSubscriptionBus;
        if (mode === "local") {
          return new GraphqlSubscriptionBus("local");
        }
        return new GraphqlSubscriptionBus(
          "redis",
          createRedisConnection(env, "pub"),
          createRedisConnection(env, "sub"),
        );
      },
    },
  ],
  exports: [GraphqlSubscriptionBus],
})
export class GraphqlSubscriptionBusModule {}
