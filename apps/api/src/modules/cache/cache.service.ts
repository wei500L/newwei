import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

import { REDIS_CLIENT } from './cache.tokens';

@Injectable()
export class CacheService implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async getMany<T>(keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) {
      return [];
    }

    const values = await this.redis.mget(keys);
    return values.map((value) => (value ? (JSON.parse(value) as T) : null));
  }

  async set<T>(key: string, value: T, ttlSeconds?: number) {
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.set(key, payload, "EX", ttlSeconds);
    } else {
      await this.redis.set(key, payload);
    }
  }

  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number) {
    const payload = JSON.stringify(value);
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    const result = await this.redis.set(key, payload, "EX", ttl, "NX");
    return result === "OK";
  }

  async del(key: string) {
    await this.redis.del(key);
  }

  async delMany(keys: string[]) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return 0;
    }
    return this.redis.del(...keys);
  }

  async expire(key: string, ttlSeconds: number) {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await this.redis.expire(key, ttl);
  }

  async zadd(key: string, score: number, member: string) {
    await this.redis.zadd(key, score, member);
  }

  async zcard(key: string) {
    return this.redis.zcard(key);
  }

  async zrange(key: string, start: number, stop: number) {
    return this.redis.zrange(key, start, stop);
  }

  async zrem(key: string, members: string[]) {
    if (!Array.isArray(members) || members.length === 0) {
      return 0;
    }
    return this.redis.zrem(key, ...members);
  }

  async hincrby(key: string, field: string, value: number) {
    return this.redis.hincrby(key, field, value);
  }

  async hgetall(key: string) {
    return this.redis.hgetall(key);
  }

  async incr(key: string, ttlSeconds: number) {
    const value = await this.redis.incr(key);
    if (value === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    return value;
  }

  async wrap<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options?: { lockTtlMs?: number; retryDelayMs?: number; maxWaitMs?: number }
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached) {
      return cached;
    }

    const lockKey = this.lockKey(key);
    const lockTtlMs = options?.lockTtlMs ?? 5000;
    const retryDelayMs = options?.retryDelayMs ?? 50;
    const maxWaitMs = options?.maxWaitMs ?? lockTtlMs;

    let lockToken = await this.acquireLock(lockKey, lockTtlMs);
    if (!lockToken) {
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        await this.delay(retryDelayMs);
        const retryCached = await this.get<T>(key);
        if (retryCached) {
          return retryCached;
        }

        lockToken = await this.acquireLock(lockKey, lockTtlMs);
        if (lockToken) {
          break;
        }
      }
    }

    if (lockToken) {
      try {
        const value = await loader();
        await this.set(key, value, ttlSeconds);
        return value;
      } finally {
        await this.releaseLock(lockKey, lockToken);
      }
    }

    const finalCached = await this.get<T>(key);
    if (finalCached) {
      return finalCached;
    }

    const value = await loader();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async withLock<T>(
    key: string,
    ttlMs: number,
    runner: () => Promise<T>
  ): Promise<T | null> {
    const lockKey = this.lockKey(key);
    const lockToken = await this.acquireLock(lockKey, ttlMs);
    if (!lockToken) {
      return null;
    }

    try {
      return await runner();
    } finally {
      try {
        await this.releaseLock(lockKey, lockToken);
      } catch {
        // best-effort
      }
    }
  }

  private lockKey(key: string) {
    return `lock:${key}`;
  }

  private async acquireLock(key: string, ttlMs: number) {
    const token = randomUUID();
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  private async releaseLock(key: string, token: string) {
    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
    await this.redis.eval(releaseScript, 1, key, token);
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
