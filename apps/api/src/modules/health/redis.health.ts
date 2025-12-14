import { Inject, Injectable } from "@nestjs/common";
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from "@nestjs/terminus";
import type Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.tokens";

enum RedisHealthMode {
  Standalone = "standalone",
  Cluster = "cluster"
}

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async isHealthy(key = "redis"): Promise<HealthIndicatorResult> {
    const timeoutMs = readEnvInt("HEALTH_REDIS_TIMEOUT_MS", 1500);
    const writeCheckEnabled = readEnvBoolean("HEALTH_REDIS_WRITE_CHECK_ENABLED", true);
    const writeTtlMs = readEnvInt("HEALTH_REDIS_WRITE_TTL_MS", 5_000);

    try {
      const pingStartedAt = Date.now();
      const pong = await withTimeout(this.redis.ping(), timeoutMs, "Redis ping timeout");
      const pingLatencyMs = Date.now() - pingStartedAt;

      if (pong !== "PONG") {
        const result = this.getStatus(key, false, { pingLatencyMs, message: `Unexpected PING reply: ${pong}` });
        throw new HealthCheckError("Redis ping failed", result);
      }

      let mode: RedisHealthMode = RedisHealthMode.Standalone;
      let clusterState: string | undefined;
      let probedMasters: number | undefined;
      let writeLatencyMs: number | undefined;

      const clusterInfo = await tryGetClusterInfo(this.redis, timeoutMs);
      const clusterSlots = writeCheckEnabled ? await tryGetClusterSlots(this.redis, timeoutMs) : undefined;
      if (clusterInfo || (clusterSlots && clusterSlots.length > 0)) {
        mode = RedisHealthMode.Cluster;
      }
      if (clusterInfo) {
        clusterState = parseRedisInfoValue(clusterInfo, "cluster_state") ?? "unknown";
        if (clusterState !== "ok") {
          const result = this.getStatus(key, false, { mode, clusterState, pingLatencyMs });
          throw new HealthCheckError("Redis cluster state not ok", result);
        }
      }

      if (writeCheckEnabled) {
        const writeStartedAt = Date.now();
        if (mode === RedisHealthMode.Cluster) {
          if (clusterSlots && clusterSlots.length > 0) {
            await probeClusterWrites(this.redis, clusterSlots, timeoutMs, writeTtlMs);
            probedMasters = clusterSlots.length;
          } else {
            await probeStandaloneWrite(this.redis, timeoutMs, writeTtlMs);
          }
        } else {
          await probeStandaloneWrite(this.redis, timeoutMs, writeTtlMs);
        }
        writeLatencyMs = Date.now() - writeStartedAt;
      }

      return this.getStatus(key, true, {
        mode,
        clusterState,
        pingLatencyMs,
        writeLatencyMs,
        probedMasters
      });
    } catch (err) {
      if (err instanceof HealthCheckError) {
        throw err;
      }
      const result = this.getStatus(key, false, {
        message: err instanceof Error ? err.message : "Unknown Redis error"
      });
      throw new HealthCheckError("Redis health check failed", result);
    }
  }
}

type ClusterSlotsReply = [number, number, [string, number, string], ...unknown[]][];

async function tryGetClusterInfo(redis: Redis, timeoutMs: number): Promise<string | undefined> {
  try {
    return await withTimeout((redis as unknown as { cluster: (subcommand: "info") => Promise<string> }).cluster("info"), timeoutMs, "Redis CLUSTER INFO timeout");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("cluster support disabled") || message.includes("ERR This instance has cluster support disabled")) {
      return undefined;
    }
    if (message.includes("unknown command") || message.includes("NOPERM")) {
      return undefined;
    }
    return undefined;
  }
}

async function tryGetClusterSlots(redis: Redis, timeoutMs: number): Promise<{ start: number; end: number }[] | undefined> {
  try {
    const raw = await withTimeout(
      (redis as unknown as { cluster: (subcommand: "slots") => Promise<ClusterSlotsReply> }).cluster("slots"),
      timeoutMs,
      "Redis CLUSTER SLOTS timeout"
    );
    const masters = new Map<string, { start: number; end: number }>();
    for (const slot of raw) {
      const [start, end, master] = slot;
      const nodeId = Array.isArray(master) ? String(master[2]) : `${String(master)}`;
      if (!masters.has(nodeId)) {
        masters.set(nodeId, { start, end });
      }
    }
    return [...masters.values()];
  } catch {
    return undefined;
  }
}

async function probeStandaloneWrite(redis: Redis, timeoutMs: number, ttlMs: number): Promise<void> {
  const probeId = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const key = `health:redis:write:${probeId}`;
  const value = "1";
  await withTimeout(redis.set(key, value, "PX", ttlMs), timeoutMs, "Redis write probe timeout");
  const got = await withTimeout(redis.get(key), timeoutMs, "Redis read probe timeout");
  if (got !== value) {
    throw new Error(`Redis write probe mismatch (expected=${value}, got=${got ?? "null"})`);
  }
  redis.del(key).catch(() => undefined);
}

async function probeClusterWrites(
  redis: Redis,
  masters: { start: number; end: number }[],
  timeoutMs: number,
  ttlMs: number
): Promise<void> {
  const probeId = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const value = "1";

  const keys = masters.map(({ start, end }, index) => {
    const tag = findHashTagInSlotRange(start, end);
    return `health:redis:write:{${tag}}:${probeId}:${index}`;
  });

  await Promise.all(
    keys.map(async (key) => {
      await withTimeout(redis.set(key, value, "PX", ttlMs), timeoutMs, "Redis cluster write probe timeout");
      const got = await withTimeout(redis.get(key), timeoutMs, "Redis cluster read probe timeout");
      if (got !== value) {
        throw new Error(`Redis cluster write probe mismatch (key=${key}, expected=${value}, got=${got ?? "null"})`);
      }
      redis.del(key).catch(() => undefined);
    })
  );
}

function parseRedisInfoValue(info: string, key: string): string | undefined {
  const lines = info.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx);
    if (k !== key) continue;
    return line.slice(idx + 1).trim();
  }
  return undefined;
}

function findHashTagInSlotRange(start: number, end: number): string {
  if (start < 0 || end > 16383 || start > end) {
    throw new Error(`Invalid cluster slot range: ${start}-${end}`);
  }

  for (let attempt = 0; attempt < 5_000; attempt++) {
    const tag = `h${attempt.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const slot = computeRedisClusterSlot(tag);
    if (slot >= start && slot <= end) {
      return tag;
    }
  }

  throw new Error(`Unable to find hash tag within slot range: ${start}-${end}`);
}

function computeRedisClusterSlot(keyOrTag: string): number {
  return crc16(Buffer.from(keyOrTag)) % 16384;
}

function crc16(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function readEnvBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
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
