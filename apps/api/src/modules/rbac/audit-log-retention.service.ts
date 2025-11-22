import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../config/prisma.service";
import { AuditLogSettingsService } from "../system-settings/audit-log-settings.service";

@Injectable()
export class AuditLogRetentionService {
  private readonly logger = new Logger(AuditLogRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogSettings: AuditLogSettingsService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async handleCron() {
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
    const result = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } }
    });

    if (result.count > 0) {
      this.logger.log(`Deleted ${result.count} audit log(s) older than ${retentionDays} days`);
    }

    return result.count;
  }
}
