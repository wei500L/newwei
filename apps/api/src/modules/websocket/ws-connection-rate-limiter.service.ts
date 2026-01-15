import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.tokens";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { EnvService } from "../config/config.service";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

const WS_BACKOFF_KEY_PREFIX = "ws:backoff:";
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

@Injectable()
export class WsConnectionRateLimiterService {
  private readonly logger = new Logger(WsConnectionRateLimiterService.name);

  private readonly connectRateLimitPerIp: number;
  private readonly connectRateLimitWindowSeconds: number;

  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly env: EnvService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    const wsConfig = this.env.webSocketSecurity;
    this.connectRateLimitPerIp = wsConfig.connectRateLimitPerIp;
    this.connectRateLimitWindowSeconds = wsConfig.connectRateLimitWindowSeconds;
  }

  /**
   * Check if a connection from the given IP is allowed based on rate limits.
   * Returns allowed=true if under limit, allowed=false with retryAfterMs if exceeded.
   */
  async checkConnectionRateLimit(ip: string): Promise<RateLimitResult> {
    if (!ip) {
      return { allowed: true };
    }

    try {
      const key = `ws:connect:${ip}`;
      const allowed = await this.rateLimiter.consume(
        key,
        this.connectRateLimitPerIp,
        this.connectRateLimitWindowSeconds
      );

      if (!allowed) {
        const retryAfterMs = this.connectRateLimitWindowSeconds * 1000;
        return { allowed: false, retryAfterMs };
      }

      return { allowed: true };
    } catch (error) {
      // Fail-open: allow connection if rate limiter fails
      this.logger.warn(
        { ip, error: error instanceof Error ? error.message : String(error) },
        "Rate limit check failed, allowing connection (fail-open)"
      );
      return { allowed: true };
    }
  }

  /**
   * Record a failed authentication attempt for the given IP.
   * Increments the failure counter used for exponential backoff.
   */
  async recordFailedAuth(ip: string): Promise<void> {
    if (!ip) {
      return;
    }

    try {
      const key = `${WS_BACKOFF_KEY_PREFIX}${ip}`;
      const ttlSeconds = this.connectRateLimitWindowSeconds * 2;

      await this.redis.incr(key);
      await this.redis.expire(key, ttlSeconds);
    } catch (error) {
      this.logger.warn(
        { ip, error: error instanceof Error ? error.message : String(error) },
        "Failed to record auth failure for backoff"
      );
    }
  }

  /**
   * Get the backoff delay in milliseconds for the given IP based on failed auth attempts.
   * Uses exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s max.
   */
  async getBackoffDelay(ip: string): Promise<number> {
    if (!ip) {
      return 0;
    }

    try {
      const key = `${WS_BACKOFF_KEY_PREFIX}${ip}`;
      const failureCountStr = await this.redis.get(key);

      if (!failureCountStr) {
        return 0;
      }

      const failureCount = parseInt(failureCountStr, 10);
      if (isNaN(failureCount) || failureCount <= 0) {
        return 0;
      }

      // Exponential backoff: 2^(failures-1) * base, capped at max
      const delay = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, failureCount - 1),
        MAX_BACKOFF_MS
      );

      return delay;
    } catch (error) {
      this.logger.warn(
        { ip, error: error instanceof Error ? error.message : String(error) },
        "Failed to get backoff delay"
      );
      return 0;
    }
  }

  /**
   * Clear the backoff state for the given IP after successful authentication.
   */
  async clearBackoff(ip: string): Promise<void> {
    if (!ip) {
      return;
    }

    try {
      const key = `${WS_BACKOFF_KEY_PREFIX}${ip}`;
      await this.redis.del(key);
    } catch (error) {
      this.logger.warn(
        { ip, error: error instanceof Error ? error.message : String(error) },
        "Failed to clear backoff state"
      );
    }
  }
}
