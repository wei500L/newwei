import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from './cache.tokens';

const SLIDING_WINDOW_LUA_SCRIPT = `
local bucket_key = KEYS[1]
local sequence_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])
local cleanup_limit = tonumber(ARGV[5])
local cleanup_threshold = tonumber(ARGV[6])

local window_start = now - window_ms
local window_min = '(' .. tostring(window_start)
local active = redis.call('ZCOUNT', bucket_key, window_min, now)

-- Opportunistic pruning:
-- - Avoid unbounded O(N) deletes (ZREMRANGEBYSCORE) on every request.
-- - Keep correctness by counting via ZCOUNT, then prune expired entries in bounded batches.
if cleanup_limit > 0 and cleanup_threshold > 0 then
  local total = redis.call('ZCARD', bucket_key)
  if (total - active) >= cleanup_threshold then
    local expired = redis.call('ZRANGEBYSCORE', bucket_key, 0, window_start, 'LIMIT', 0, cleanup_limit)
    if #expired > 0 then
      redis.call('ZREM', bucket_key, unpack(expired))
    end
  end
end

if active >= limit then
  redis.call('EXPIRE', bucket_key, ttl_seconds)
  redis.call('EXPIRE', sequence_key, ttl_seconds)
  return {0, active}
end

local sequence = redis.call('INCR', sequence_key)
redis.call('ZADD', bucket_key, now, tostring(now) .. '-' .. sequence)
redis.call('EXPIRE', bucket_key, ttl_seconds)
redis.call('EXPIRE', sequence_key, ttl_seconds)

return {1, active + 1}
`;

const LUA_KEYS = 2;

const COMPENSATE_TIMED_OUT_LUA_SCRIPT = `
local bucket_key = KEYS[1]
local now = tonumber(ARGV[1])
local prefix = ARGV[2]
local members = redis.call('ZRANGEBYSCORE', bucket_key, now, now)
local removed = 0
for i, member in ipairs(members) do
  if string.sub(member, 1, #prefix) == prefix then
    redis.call('ZREM', bucket_key, member)
    removed = removed + 1
  end
end
return removed
`;

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  private readonly evalTimeoutMs: number;
  private readonly slowCallThresholdMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly failOpen: boolean;

  private readonly cleanupLimit: number;
  private readonly cleanupThreshold: number;

  private circuitOpenUntilMs = 0;
  private consecutiveFailures = 0;
  private halfOpenProbeInFlight = false;
  private circuitState: 'closed' | 'open' | 'half_open' = 'closed';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    this.evalTimeoutMs = readEnvNumber('RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS', 100);
    this.slowCallThresholdMs = readEnvNumber('RATE_LIMIT_REDIS_SLOW_MS', 200);
    this.circuitFailureThreshold = readEnvInt(
      'RATE_LIMIT_REDIS_CIRCUIT_FAILURE_THRESHOLD',
      5
    );
    this.circuitOpenMs = readEnvInt('RATE_LIMIT_REDIS_CIRCUIT_OPEN_MS', 5_000);
    this.failOpen = readEnvBoolean('RATE_LIMIT_REDIS_FAIL_OPEN', true);

    this.cleanupLimit = readEnvInt('RATE_LIMIT_REDIS_CLEANUP_LIMIT', 100);
    this.cleanupThreshold = readEnvInt('RATE_LIMIT_REDIS_CLEANUP_THRESHOLD', 1_000);

    const redisAny = this.redis as unknown as {
      defineCommand?: (
        name: string,
        definition: { numberOfKeys: number; lua: string }
      ) => void;
    };
    redisAny.defineCommand?.('consumeSlidingWindow', {
      numberOfKeys: LUA_KEYS,
      lua: SLIDING_WINDOW_LUA_SCRIPT
    });
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (!limit || limit <= 0) {
      return true;
    }
    if (!windowSeconds || windowSeconds <= 0) {
      return true;
    }

    const now = Date.now();
    if (this.circuitState === 'open' && now < this.circuitOpenUntilMs) {
      return this.failOpen;
    }
    if (this.circuitState === 'open' && now >= this.circuitOpenUntilMs) {
      this.circuitState = 'half_open';
    }

    let acquiredHalfOpenProbe = false;
    if (this.circuitState === 'half_open') {
      if (this.halfOpenProbeInFlight) {
        return this.failOpen;
      }
      this.halfOpenProbeInFlight = true;
      acquiredHalfOpenProbe = true;
    }

    const windowMs = windowSeconds * 1000;
    const ttlSeconds = Math.max(Math.ceil(windowSeconds * 2), 1);
    const bucketKey = `rate:${key}`;

    const startedAt = process.hrtime.bigint();
    try {
      const evalPromise = this.evalSlidingWindow(
        bucketKey,
        `${bucketKey}:seq`,
        now,
        windowMs,
        limit,
        ttlSeconds,
        this.cleanupLimit,
        this.cleanupThreshold
      );
      const result = await withTimeout(
        evalPromise,
        this.evalTimeoutMs,
        'RateLimiterService redis.eval timeout'
      );

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (durationMs > this.slowCallThresholdMs) {
        this.recordFailure(`slow redis eval (${Math.round(durationMs)}ms)`);
      } else {
        this.recordSuccess();
      }

      const [allowed] = result;
      return allowed === 1;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'unknown redis error');
      // Fail-open was chosen above, but the in-flight Lua may still complete
      // and consume a quota slot for THIS request (ZADD with now-sequence).
      // Compensate so "released" requests do not silently eat a token and
      // make the limiter stricter than configured under Redis latency spikes.
      if (this.failOpen) {
        void this.compensateTimedOutRequest(bucketKey, now).catch(() => undefined);
      }
      return this.failOpen;
    } finally {
      if (acquiredHalfOpenProbe) {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  /**
   * Best-effort removal of the quota entry our own timed-out request may have
   * written: members are scored at `now` with a `${now}-<seq>` key, so we can
   * target exactly the entries for this timestamp.
   */
  private async compensateTimedOutRequest(bucketKey: string, now: number) {
    await this.redis.eval(
      COMPENSATE_TIMED_OUT_LUA_SCRIPT,
      1,
      bucketKey,
      String(now),
      `${now}-`,
    );
  }

  private recordSuccess() {
    this.consecutiveFailures = 0;
    if (this.circuitState !== 'closed') {
      this.circuitState = 'closed';
      this.circuitOpenUntilMs = 0;
    }
  }

  private recordFailure(reason: string) {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.circuitFailureThreshold) {
      const now = Date.now();
      const previouslyOpen = this.circuitState === 'open' && now < this.circuitOpenUntilMs;
      this.circuitState = 'open';
      this.circuitOpenUntilMs = now + this.circuitOpenMs;
      this.consecutiveFailures = 0;

      if (!previouslyOpen) {
        this.logger.warn(
          `Redis rate limiter circuit opened for ${this.circuitOpenMs}ms (${reason})`
        );
      }
      return;
    }
  }

  private async evalSlidingWindow(
    bucketKey: string,
    sequenceKey: string,
    now: number,
    windowMs: number,
    limit: number,
    ttlSeconds: number,
    cleanupLimit: number,
    cleanupThreshold: number
  ): Promise<[number, number]> {
    const redisAny = this.redis as unknown as {
      consumeSlidingWindow?: (
        bucketKey: string,
        sequenceKey: string,
        now: number,
        windowMs: number,
        limit: number,
        ttlSeconds: number,
        cleanupLimit: number,
        cleanupThreshold: number
      ) => Promise<[number, number]>;
    };

    if (typeof redisAny.consumeSlidingWindow === 'function') {
      return redisAny.consumeSlidingWindow(
        bucketKey,
        sequenceKey,
        now,
        windowMs,
        limit,
        ttlSeconds,
        cleanupLimit,
        cleanupThreshold
      );
    }

    return (await this.redis.eval(
      SLIDING_WINDOW_LUA_SCRIPT,
      LUA_KEYS,
      bucketKey,
      sequenceKey,
      now,
      windowMs,
      limit,
      ttlSeconds,
      cleanupLimit,
      cleanupThreshold
    )) as [number, number];
  }
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readEnvInt(name: string, fallback: number): number {
  const value = readEnvNumber(name, fallback);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function readEnvBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return fallback;
  }
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      promise.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
