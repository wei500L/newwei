import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

const AUDIT_LOG_RETENTION_KEY = "audit_log_retention_days";
// The bare retention number is shared with the Go gateway through Redis, so a
// write in either runtime is visible to the other. The TTL replaces the former
// process-local 30 second cache.
const AUDIT_LOG_RETENTION_CACHE_KEY = "audit_log:retention_days";
const AUDIT_LOG_RETENTION_CACHE_TTL_SECONDS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650; // cap to avoid unbounded values

@Injectable()
export class AuditLogSettingsService {
  private readonly logger = createLogger({ name: "audit-log-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly cache: CacheService
  ) {}

  async getRetentionDays(): Promise<number> {
    let cached: number | null = null;
    try {
      cached = await this.cache.get<number>(AUDIT_LOG_RETENTION_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read audit log retention from cache; falling back to database"
      );
    }
    if (typeof cached === "number" && Number.isFinite(cached)) {
      return this.normalize(cached);
    }

    const days = await this.loadRetentionDays();
    try {
      await this.cache.set(
        AUDIT_LOG_RETENTION_CACHE_KEY,
        days,
        AUDIT_LOG_RETENTION_CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write audit log retention to cache");
    }
    return days;
  }

  async updateRetentionDays(orgId: string, actorId: string, days: number): Promise<number> {
    const normalized = this.normalize(days);
    await this.prisma.systemSetting.upsert({
      where: { key: AUDIT_LOG_RETENTION_KEY },
      update: {
        value: normalized,
        updatedById: actorId
      },
      create: {
        key: AUDIT_LOG_RETENTION_KEY,
        value: normalized,
        updatedById: actorId,
        description: "Audit log retention in days"
      }
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "audit_log_retention_update",
          metadata: { retentionDays: normalized }
        }
      },
      { orgId, actorId, resource: "system_settings", action: "audit_log_retention_update" }
    ).catch(() => undefined);

    try {
      await this.cache.set(
        AUDIT_LOG_RETENTION_CACHE_KEY,
        normalized,
        AUDIT_LOG_RETENTION_CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to refresh audit log retention cache");
    }
    return normalized;
  }

  async invalidateCache() {
    await this.cache.del(AUDIT_LOG_RETENTION_CACHE_KEY);
  }

  private async loadRetentionDays(): Promise<number> {
    const fallback = this.normalize(this.env.auditLogRetentionDays);
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: AUDIT_LOG_RETENTION_KEY }
    });
    if (!record) {
      return fallback;
    }
    const value = record.value as unknown;
    if (typeof value === "number") {
      return this.normalize(value);
    }
    if (value && typeof value === "object" && "retentionDays" in value) {
      const maybeDays = (value as { retentionDays?: number }).retentionDays;
      if (typeof maybeDays === "number") {
        return this.normalize(maybeDays);
      }
    }
    return fallback;
  }

  private normalize(value: number) {
    const intValue = Math.floor(value);
    if (Number.isNaN(intValue) || intValue < MIN_RETENTION_DAYS) {
      return MIN_RETENTION_DAYS;
    }
    if (intValue > MAX_RETENTION_DAYS) {
      return MAX_RETENTION_DAYS;
    }
    return intValue;
  }
}
