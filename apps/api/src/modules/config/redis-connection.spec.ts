import {
  toBullmqConnection,
  toIoredisConnection,
  toNodeRedisConnection,
} from "./redis-connection";

describe("redis connection helpers", () => {
  const config = {
    host: "redis",
    port: 6379,
    username: "default",
    password: "secret",
    db: 2,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
  };

  it("passes tuning options to normal ioredis clients", () => {
    expect(toIoredisConnection(config)).toEqual({
      host: "redis",
      port: 6379,
      username: "default",
      password: "secret",
      db: 2,
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
    });
  });

  it("forces BullMQ retries to null", () => {
    expect(toBullmqConnection(config)).toEqual({
      host: "redis",
      port: 6379,
      username: "default",
      password: "secret",
      db: 2,
      enableAutoPipelining: true,
      maxRetriesPerRequest: null,
    });
  });

  it("keeps node-redis options compatible", () => {
    expect(toNodeRedisConnection(config)).toEqual({
      socket: {
        host: "redis",
        port: 6379,
      },
      username: "default",
      password: "secret",
      database: 2,
    });
  });
});
