import type { RedisOptions } from "ioredis";
import type { RedisClientOptions } from "redis";

export interface RedisConnectionConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: number;
  enableAutoPipelining?: boolean;
  maxRetriesPerRequest?: number;
}

export function toIoredisConnection(
  config: RedisConnectionConfig,
): RedisOptions {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    db: config.db,
    enableAutoPipelining: config.enableAutoPipelining,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
  };
}

export function toBullmqConnection(
  config: RedisConnectionConfig,
): RedisOptions {
  return {
    ...toIoredisConnection(config),
    maxRetriesPerRequest: null,
  };
}

export function toNodeRedisConnection(
  config: RedisConnectionConfig,
): RedisClientOptions<any, any, any, any> {
  return {
    socket: {
      host: config.host,
      port: config.port,
    },
    username: config.username,
    password: config.password,
    database: config.db,
  };
}
