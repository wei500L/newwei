import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import { recordSchedulerRun } from "./prometheus-metrics";
import { ClassificationQualityService } from "./classification-quality.service";

const CLASSIFICATION_ALERT_SCHEDULER_INTERVAL_MS = 5 * 60_000;
const CLASSIFICATION_ALERT_LOCK_TTL_SECONDS = 4 * 60;

@Injectable()
export class ClassificationQualityAlertSchedulerService {
  private readonly logger = createLogger({
    name: "classification-quality-alert-scheduler",
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly classificationQuality: ClassificationQualityService,
  ) {}

  @Interval(
    "classification-quality-alert-evaluation",
    CLASSIFICATION_ALERT_SCHEDULER_INTERVAL_MS,
  )
  async evaluate(): Promise<void> {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    for (const org of orgs) {
      await this.evaluateOrg(org.id);
    }
  }

  private async evaluateOrg(orgId: string): Promise<void> {
    const lockKey = `quality:classification:alert-scheduler:${orgId}:1h`;
    const locked = await this.cache.setIfAbsent(
      lockKey,
      { lockedAt: new Date().toISOString() },
      CLASSIFICATION_ALERT_LOCK_TTL_SECONDS,
    );
    if (!locked) {
      return;
    }

    try {
      await this.classificationQuality.getSummary({ orgId, window: "1h" });
      recordSchedulerRun("classification_quality_alerts", "success");
    } catch (error) {
      recordSchedulerRun("classification_quality_alerts", "failure");
      this.logger.warn(
        { err: error, orgId },
        "Scheduled classification quality alert evaluation failed",
      );
    }
  }
}
