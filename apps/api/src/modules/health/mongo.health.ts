import type { MongoConnection } from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from "@nestjs/terminus";

import { MONGO_CONNECTION } from "../config/mongo.provider";

@Injectable()
export class MongoHealthIndicator extends HealthIndicator {
  constructor(@Inject(MONGO_CONNECTION) private readonly mongo: MongoConnection) {
    super();
  }

  async isHealthy(key = "mongo"): Promise<HealthIndicatorResult> {
    const timeoutMs = readEnvInt("HEALTH_MONGO_TIMEOUT_MS", 1500);

    try {
      const db = this.mongo.connection?.db;
      if (!db) {
        const result = this.getStatus(key, false, { message: "MongoDB connection is not ready" });
        throw new HealthCheckError("MongoDB connection is not ready", result);
      }

      const reply = (await withTimeout(
        db.admin().command({ ping: 1 }),
        timeoutMs,
        "MongoDB ping timeout"
      )) as { ok?: number };
      const ok = typeof reply.ok === "number" ? reply.ok === 1 : true;
      if (!ok) {
        const result = this.getStatus(key, false, { message: "MongoDB ping returned non-ok response" });
        throw new HealthCheckError("MongoDB ping failed", result);
      }

      return this.getStatus(key, true);
    } catch (err) {
      if (err instanceof HealthCheckError) {
        throw err;
      }
      const result = this.getStatus(key, false, {
        message: err instanceof Error ? err.message : "Unknown MongoDB error"
      });
      throw new HealthCheckError("MongoDB health check failed", result);
    }
  }
}

function readEnvInt(key: string, fallback: number) {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
