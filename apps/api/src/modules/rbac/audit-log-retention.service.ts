import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { AuditLogSettingsService } from "../system-settings/audit-log-settings.service";

@Injectable()
export class AuditLogRetentionService {
  private readonly logger = new Logger(AuditLogRetentionService.name);
  private static readonly DELETE_BATCH_SIZE = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogSettings: AuditLogSettingsService,
    private readonly env: EnvService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async handleCron() {
    // Execution ownership: when API_GO_AUDIT_LOG_RETENTION_MODE=go the Go
    // scheduler owns this purge and this callback returns before reading the
    // retention setting. NestJS takes no lock here, so a mixed-version window
    // can run both sides once; the DELETE is idempotent.
    if (
      this.env.get<string>("API_GO_AUDIT_LOG_RETENTION_MODE", { infer: true }) ===
      "go"
    ) {
      return;
    }
    try {
      await this.purgeExpiredAuditLogs();
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        "Failed to purge expired audit logs",
        err?.stack ?? err?.message ?? String(error)
      );
    }
  }

  async purgeExpiredAuditLogs(now: Date = new Date()) {
    const retentionDays = Math.max(1, await this.auditLogSettings.getRetentionDays());
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const batchSize = AuditLogRetentionService.DELETE_BATCH_SIZE;
    let totalDeleted = 0;

    let hasMore = true;
    while (hasMore) {
      const expiredIds = await this.prisma.auditLog.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: batchSize
      });

      if (expiredIds.length === 0) {
        break;
      }

      const { count } = await this.prisma.auditLog.deleteMany({
        where: { id: { in: expiredIds.map(({ id }) => id) } }
      });

      totalDeleted += count;
      hasMore = expiredIds.length >= batchSize;
    }

    if (totalDeleted > 0) {
      this.logger.log(`Deleted ${totalDeleted} audit log(s) older than ${retentionDays} days`);
    }

    return totalDeleted;
  }
}
