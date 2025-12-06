import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CLIENT } from "./cache.module";

const SLIDING_WINDOW_LUA_SCRIPT = `
local bucket_key = KEYS[1]
local sequence_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

-- prune events outside the sliding window
redis.call('ZREMRANGEBYSCORE', bucket_key, 0, now - window_ms)
local current = redis.call('ZCARD', bucket_key)

if current >= limit then
  redis.call('EXPIRE', bucket_key, ttl_seconds)
  redis.call('EXPIRE', sequence_key, ttl_seconds)
  return {0, current}
end

local sequence = redis.call('INCR', sequence_key)
redis.call('ZADD', bucket_key, now, tostring(now) .. '-' .. sequence)
redis.call('EXPIRE', bucket_key, ttl_seconds)
redis.call('EXPIRE', sequence_key, ttl_seconds)

return {1, current + 1}
`;

const LUA_KEYS = 2;

@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async consume(key: string, limit: number, windowSeconds: number) {
    if (!limit || limit <= 0) {
      return true;
    }
    if (!windowSeconds || windowSeconds <= 0) {
      return true;
    }

    const windowMs = windowSeconds * 1000;
    const ttlSeconds = Math.max(Math.ceil(windowSeconds * 2), 1);
    const bucketKey = `rate:${key}`;

    const [allowed] = (await this.redis.eval(
      SLIDING_WINDOW_LUA_SCRIPT,
      LUA_KEYS,
      bucketKey,
      `${bucketKey}:seq`,
      Date.now(),
      windowMs,
      limit,
      ttlSeconds
    )) as [number, number];

    return allowed === 1;
  }
}
