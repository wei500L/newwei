import { createLogger } from "@modular/utils";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type RateLimitPolicy as RateLimitPolicyModel } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface RateLimitPolicy {
  feature: string;
  userLimit: number;
  ipLimit: number;
  windowSeconds: number;
  enabled: boolean;
  description?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RateLimitPolicyInput {
  userLimit: number;
  ipLimit: number;
  windowSeconds: number;
  enabled?: boolean;
  description?: string | null;
}

const CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "rate_limit_policy:";
const MIN_LIMIT = 0;
const MAX_LIMIT = 100_000;
const MIN_WINDOW_SECONDS = 1;
const MAX_WINDOW_SECONDS = 86_400;
const FEATURE_PATTERN = /^[a-z][a-z0-9_.]*$/;

interface RateLimitPolicyCacheEntry {
  policy: RateLimitPolicy | null;
}

@Injectable()
export class RateLimitPolicyService {
  private readonly logger = createLogger({ name: "rate-limit-policy" });

  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  async listPolicies(): Promise<RateLimitPolicy[]> {
    try {
      const records = await this.prisma.rateLimitPolicy.findMany({
        orderBy: { feature: "asc" }
      });
      return records.map((record) => this.toPolicy(record));
    } catch (error) {
      if (this.isSchemaOutOfDateError(error)) {
        this.logger.warn(
          { err: error },
          "RateLimitPolicy schema is out of date; returning empty list (run `pnpm db:migrate`)"
        );
        return [];
      }
      throw error;
    }
  }

  async getPolicy(feature: string): Promise<RateLimitPolicy | null> {
    const normalizedFeature = this.normalizeFeature(feature);
    const cacheKey = this.cacheKey(normalizedFeature);

    let cached: RateLimitPolicyCacheEntry | null = null;
    try {
      cached = await this.cache.get<RateLimitPolicyCacheEntry>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, feature: normalizedFeature },
        "Failed to read rate limit policy from cache; falling back to database"
      );
    }

    if (cached) {
      return cached.policy;
    }

    let record: RateLimitPolicyModel | null = null;
    try {
      record = await this.prisma.rateLimitPolicy.findUnique({
        where: { feature: normalizedFeature }
      });
    } catch (error) {
      if (this.isSchemaOutOfDateError(error)) {
        this.logger.warn(
          { err: error, feature: normalizedFeature },
          "RateLimitPolicy schema is out of date; falling back to default settings (run `pnpm db:migrate`)"
        );
        return null;
      }
      throw error;
    }

    const policy = record ? this.toPolicy(record) : null;
    try {
      await this.cache.set(cacheKey, { policy }, CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, feature: normalizedFeature },
        "Failed to write rate limit policy to cache"
      );
    }
    return policy;
  }

  async createPolicy(
    orgId: string,
    actorId: string,
    feature: string,
    input: RateLimitPolicyInput
  ): Promise<RateLimitPolicy> {
    const normalizedFeature = this.normalizeFeature(feature);
    const existing = await this.prisma.rateLimitPolicy.findUnique({
      where: { feature: normalizedFeature }
    });
    if (existing) {
      throw new ConflictException(`Rate limit policy already exists for ${normalizedFeature}`);
    }

    const normalized = this.normalizePolicy(input);
    const created = await this.prisma.rateLimitPolicy.create({
      data: {
        feature: normalizedFeature,
        userLimit: normalized.userLimit,
        ipLimit: normalized.ipLimit,
        windowSeconds: normalized.windowSeconds,
        enabled: normalized.enabled,
        description: normalized.description ?? undefined,
        updatedById: actorId
      }
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "rate_limit_policy_create",
          metadata: {
            feature: normalizedFeature,
            ...normalized
          }
        }
      },
      { orgId, actorId, resource: "system_settings", action: "rate_limit_policy_create" }
    ).catch(() => undefined);

    const policy = this.toPolicy(created);
    try {
      await this.cache.set(this.cacheKey(normalizedFeature), { policy }, CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, feature: normalizedFeature },
        "Failed to write rate limit policy to cache after create"
      );
    }
    return policy;
  }

  async updatePolicy(
    orgId: string,
    actorId: string,
    feature: string,
    input: Partial<RateLimitPolicyInput>
  ): Promise<RateLimitPolicy> {
    const normalizedFeature = this.normalizeFeature(feature);
    const existing = await this.prisma.rateLimitPolicy.findUnique({
      where: { feature: normalizedFeature }
    });
    if (!existing) {
      throw new NotFoundException(`Rate limit policy not found for ${normalizedFeature}`);
    }

    const merged: RateLimitPolicyInput = {
      userLimit: input.userLimit ?? existing.userLimit,
      ipLimit: input.ipLimit ?? existing.ipLimit,
      windowSeconds: input.windowSeconds ?? existing.windowSeconds,
      enabled: input.enabled ?? existing.enabled,
      description: input.description ?? existing.description ?? undefined
    };
    const normalized = this.normalizePolicy(merged);

    const updated = await this.prisma.rateLimitPolicy.update({
      where: { feature: normalizedFeature },
      data: {
        userLimit: normalized.userLimit,
        ipLimit: normalized.ipLimit,
        windowSeconds: normalized.windowSeconds,
        enabled: normalized.enabled,
        description: normalized.description ?? undefined,
        updatedById: actorId
      }
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "rate_limit_policy_update",
          metadata: {
            feature: normalizedFeature,
            ...normalized
          }
        }
      },
      { orgId, actorId, resource: "system_settings", action: "rate_limit_policy_update" }
    ).catch(() => undefined);

    const policy = this.toPolicy(updated);
    try {
      await this.cache.set(this.cacheKey(normalizedFeature), { policy }, CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, feature: normalizedFeature },
        "Failed to write rate limit policy to cache after update"
      );
    }
    return policy;
  }

  async deletePolicy(orgId: string, actorId: string, feature: string): Promise<void> {
    const normalizedFeature = this.normalizeFeature(feature);
    const existing = await this.prisma.rateLimitPolicy.findUnique({
      where: { feature: normalizedFeature }
    });
    if (!existing) {
      throw new NotFoundException(`Rate limit policy not found for ${normalizedFeature}`);
    }

    await this.prisma.rateLimitPolicy.delete({
      where: { feature: normalizedFeature }
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "rate_limit_policy_delete",
          metadata: {
            feature: normalizedFeature
          }
        }
      },
      { orgId, actorId, resource: "system_settings", action: "rate_limit_policy_delete" }
    ).catch(() => undefined);

    try {
      await this.cache.del(this.cacheKey(normalizedFeature));
    } catch (error) {
      this.logger.warn(
        { err: error, feature: normalizedFeature },
        "Failed to evict rate limit policy cache after delete"
      );
    }
  }

  async invalidateCache(feature?: string) {
    if (feature) {
      const normalizedFeature = this.normalizeFeature(feature);
      try {
        await this.cache.del(this.cacheKey(normalizedFeature));
      } catch (error) {
        this.logger.warn(
          { err: error, feature: normalizedFeature },
          "Failed to evict rate limit policy cache"
        );
      }
      return;
    }
    // Best-effort: rely on TTL for bulk invalidation to avoid blocking.
  }

  private cacheKey(feature: string) {
    return `${CACHE_KEY_PREFIX}${feature}`;
  }

  private normalizeFeature(feature: string) {
    const normalized = feature.trim().toLowerCase();
    if (!normalized || !FEATURE_PATTERN.test(normalized)) {
      throw new BadRequestException("Invalid rate limit feature name");
    }
    return normalized;
  }

  private normalizePolicy(input: RateLimitPolicyInput): RateLimitPolicyInput {
    return {
      userLimit: this.clamp(this.toInt(input.userLimit), MIN_LIMIT, MAX_LIMIT),
      ipLimit: this.clamp(this.toInt(input.ipLimit), MIN_LIMIT, MAX_LIMIT),
      windowSeconds: this.clamp(this.toInt(input.windowSeconds), MIN_WINDOW_SECONDS, MAX_WINDOW_SECONDS),
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      description: input.description?.trim() || undefined
    };
  }

  private toPolicy(record: {
    feature: string;
    userLimit: number;
    ipLimit: number;
    windowSeconds: number;
    enabled: boolean;
    description?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): RateLimitPolicy {
    return {
      feature: record.feature,
      userLimit: record.userLimit,
      ipLimit: record.ipLimit,
      windowSeconds: record.windowSeconds,
      enabled: record.enabled,
      description: record.description ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  private clamp(value: number, min: number, max: number) {
    if (Number.isNaN(value) || value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  private toInt(value: number) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    return 0;
  }

  private isSchemaOutOfDateError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2021" || error.code === "P2022")
    );
  }
}
