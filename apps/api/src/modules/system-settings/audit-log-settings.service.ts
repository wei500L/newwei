import { Injectable } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { EnvService } from "../config/config.service";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";

const AUDIT_LOG_RETENTION_KEY = "audit_log_retention_days";
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650; // cap to avoid unbounded values

@Injectable()
export class AuditLogSettingsService {
  private cache: number | null = null;
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs = 30_000;

  constructor(private readonly prisma: PrismaService, private readonly env: EnvService) {}

  async getRetentionDays(): Promise<number> {
    const now = Date.now();
    if (this.cache !== null && now < this.cacheExpiresAt) {
      return this.cache;
    }
    const days = await this.loadRetentionDays();
    this.cache = days;
    this.cacheExpiresAt = now + this.cacheTtlMs;
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

    this.cache = normalized;
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
    return normalized;
  }

  async invalidateCache() {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  private async loadRetentionDays(): Promise<number> {
    const fallback = this.normalize(this.env.auditLogRetentionDays);
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: AUDIT_LOG_RETENTION_KEY }
    });
    if (!record) {
      return fallback;
    }
    const value = record.value as any;
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
