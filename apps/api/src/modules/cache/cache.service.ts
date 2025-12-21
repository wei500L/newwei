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

  async set<T>(key: string, value: T, ttlSeconds?: number) {
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.set(key, payload, "EX", ttlSeconds);
    } else {
      await this.redis.set(key, payload);
    }
  }

  async del(key: string) {
    await this.redis.del(key);
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
