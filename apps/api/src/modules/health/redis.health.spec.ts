import { HealthCheckError } from "@nestjs/terminus";
import type Redis from "ioredis";

import { RedisHealthIndicator } from "./redis.health";

describe("RedisHealthIndicator", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env = { ...envSnapshot };
    delete process.env.HEALTH_REDIS_TIMEOUT_MS;
    delete process.env.HEALTH_REDIS_WRITE_CHECK_ENABLED;
    delete process.env.HEALTH_REDIS_WRITE_TTL_MS;
  });

  afterAll(() => {
    process.env = envSnapshot;
  });

  it("reports up when PING and write probe succeed", async () => {
    const redis = {
      ping: jest.fn().mockResolvedValue("PONG"),
      set: jest.fn().mockResolvedValue("OK"),
      get: jest.fn().mockResolvedValue("1"),
      del: jest.fn().mockResolvedValue(1),
    };
    const indicator = new RedisHealthIndicator(redis as unknown as Redis);

    await expect(indicator.isHealthy("redis")).resolves.toEqual({
      redis: expect.objectContaining({
        status: "up",
        mode: "standalone",
      }),
    });
    expect(redis.ping).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  it("reports down when write probe fails with OOM", async () => {
    const redis = {
      ping: jest.fn().mockResolvedValue("PONG"),
      set: jest.fn().mockRejectedValue(new Error("OOM command not allowed when used memory > 'maxmemory'.")),
      get: jest.fn(),
      del: jest.fn(),
    };
    const indicator = new RedisHealthIndicator(redis as unknown as Redis);

    await expect(indicator.isHealthy("redis")).rejects.toBeInstanceOf(HealthCheckError);
    expect(redis.ping).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it("probes writes across cluster masters when CLUSTER SLOTS is available", async () => {
    const redis = {
      ping: jest.fn().mockResolvedValue("PONG"),
      cluster: jest.fn((subcommand: string) => {
        if (subcommand === "info") {
          return Promise.resolve("cluster_state:ok\n");
        }
        if (subcommand === "slots") {
          return Promise.resolve([
            [0, 8191, ["127.0.0.1", 7000, "node-a"]],
            [8192, 16383, ["127.0.0.1", 7001, "node-b"]],
          ]);
        }
        return Promise.reject(new Error("unexpected subcommand"));
      }),
      set: jest.fn().mockResolvedValue("OK"),
      get: jest.fn().mockResolvedValue("1"),
      del: jest.fn().mockResolvedValue(1),
    };
    const indicator = new RedisHealthIndicator(redis as unknown as Redis);

    const result = await indicator.isHealthy("redis");
    expect(result.redis).toEqual(
      expect.objectContaining({
        status: "up",
        mode: "cluster",
        clusterState: "ok",
        probedMasters: 2,
      })
    );
    expect(redis.cluster).toHaveBeenCalledWith("info");
    expect(redis.cluster).toHaveBeenCalledWith("slots");
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  it("reports down when cluster state is not ok", async () => {
    const redis = {
      ping: jest.fn().mockResolvedValue("PONG"),
      cluster: jest.fn().mockResolvedValue("cluster_state:fail\n"),
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
    };
    const indicator = new RedisHealthIndicator(redis as unknown as Redis);

    await expect(indicator.isHealthy("redis")).rejects.toBeInstanceOf(HealthCheckError);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
