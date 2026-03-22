import { Injectable } from "@nestjs/common";
import {
  type ObservabilitySnapshot,
  ObservabilitySnapshotScope,
  Prisma,
} from "@prisma/client";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface ObservabilitySnapshotResult<T> {
  payload: T;
  generatedAt: string;
  expiresAt: string;
}

interface GetObservabilitySnapshotInput<T> {
  orgId: string;
  scope: ObservabilitySnapshotScope;
  variantKey: string;
  ttlSeconds?: number;
  loader: () => Promise<T>;
}

@Injectable()
export class ObservabilitySnapshotService {
  private readonly defaultTtlSeconds = 60;
  private readonly lockTtlMs = 15_000;
  private readonly maxWaitMs = 20_000;
  private readonly retryDelayMs = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getOrCreate<T>(
    input: GetObservabilitySnapshotInput<T>,
  ): Promise<ObservabilitySnapshotResult<T>> {
    const now = new Date();
    const ttlSeconds = this.normalizeTtlSeconds(input.ttlSeconds);

    const fresh = await this.loadFreshSnapshot<T>(
      input.orgId,
      input.scope,
      input.variantKey,
      now,
    );
    if (fresh) {
      return fresh;
    }

    const lockKey = this.buildLockKey(
      input.orgId,
      input.scope,
      input.variantKey,
    );
    const locked = await this.cache.withLock<ObservabilitySnapshotResult<T>>(
      lockKey,
      this.lockTtlMs,
      async () => {
        const reloaded = await this.loadFreshSnapshot<T>(
          input.orgId,
          input.scope,
          input.variantKey,
          new Date(),
        );
        if (reloaded) {
          return reloaded;
        }
        return this.rebuildSnapshot(input, ttlSeconds);
      },
    );
    if (locked) {
      return locked;
    }

    const waitStartedAt = Date.now();
    while (Date.now() - waitStartedAt < this.maxWaitMs) {
      await this.delay(this.retryDelayMs);
      const reloaded = await this.loadFreshSnapshot<T>(
        input.orgId,
        input.scope,
        input.variantKey,
        new Date(),
      );
      if (reloaded) {
        return reloaded;
      }
    }

    return this.rebuildSnapshot(input, ttlSeconds);
  }

  async invalidate(
    orgId: string,
    scope: ObservabilitySnapshotScope,
    variantKey?: string,
  ): Promise<number> {
    if (variantKey) {
      const deleted = await this.prisma.observabilitySnapshot.deleteMany({
        where: {
          orgId,
          scope,
          variantKey,
        },
      });
      return deleted.count;
    }

    const deleted = await this.prisma.observabilitySnapshot.deleteMany({
      where: {
        orgId,
        scope,
      },
    });
    return deleted.count;
  }

  private async loadFreshSnapshot<T>(
    orgId: string,
    scope: ObservabilitySnapshotScope,
    variantKey: string,
    now: Date,
  ): Promise<ObservabilitySnapshotResult<T> | null> {
    const record = await this.prisma.observabilitySnapshot.findUnique({
      where: {
        orgId_scope_variantKey: {
          orgId,
          scope,
          variantKey,
        },
      },
    });
    if (!record || record.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    return this.serializeRecord<T>(record);
  }

  private async rebuildSnapshot<T>(
    input: GetObservabilitySnapshotInput<T>,
    ttlSeconds: number,
  ): Promise<ObservabilitySnapshotResult<T>> {
    const payload = await input.loader();
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + ttlSeconds * 1000);

    const record = await this.prisma.observabilitySnapshot.upsert({
      where: {
        orgId_scope_variantKey: {
          orgId: input.orgId,
          scope: input.scope,
          variantKey: input.variantKey,
        },
      },
      update: {
        payload: payload as Prisma.InputJsonValue,
        generatedAt,
        expiresAt,
        lastRequestedAt: generatedAt,
      },
      create: {
        orgId: input.orgId,
        scope: input.scope,
        variantKey: input.variantKey,
        payload: payload as Prisma.InputJsonValue,
        generatedAt,
        expiresAt,
        lastRequestedAt: generatedAt,
      },
    });

    return this.serializeRecord<T>(record);
  }

  private serializeRecord<T>(
    record: Pick<
      ObservabilitySnapshot,
      "payload" | "generatedAt" | "expiresAt"
    >,
  ): ObservabilitySnapshotResult<T> {
    return {
      payload: record.payload as T,
      generatedAt: record.generatedAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  private buildLockKey(
    orgId: string,
    scope: ObservabilitySnapshotScope,
    variantKey: string,
  ) {
    return `observability-snapshot:${orgId}:${scope}:${variantKey}`;
  }

  private normalizeTtlSeconds(rawTtlSeconds?: number) {
    if (typeof rawTtlSeconds !== "number" || !Number.isFinite(rawTtlSeconds)) {
      return this.defaultTtlSeconds;
    }
    return Math.max(1, Math.floor(rawTtlSeconds));
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
