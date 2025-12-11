import { Inject, Injectable } from "@nestjs/common";
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from "@nestjs/terminus";
import type Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.module";

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async isHealthy(key = "redis"): Promise<HealthIndicatorResult> {
    try {
      const startedAt = Date.now();
      const pong = await this.redis.ping();
      const latencyMs = Date.now() - startedAt;
      const isHealthy = pong === "PONG";
      const result = this.getStatus(key, isHealthy, { latencyMs });

      if (isHealthy) {
        return result;
      }

      throw new HealthCheckError("Redis ping failed", result);
    } catch (err) {
      const result = this.getStatus(key, false, {
        message: err instanceof Error ? err.message : "Unknown Redis error"
      });
      throw new HealthCheckError("Redis health check failed", result);
    }
  }
}
