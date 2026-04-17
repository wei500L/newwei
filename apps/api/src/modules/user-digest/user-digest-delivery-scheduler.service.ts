import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { settleWithConcurrency } from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";

import { UserDigestDeliveryService } from "./user-digest-delivery.service";
import { USER_DIGEST_ORG_LOCK_TTL_MS } from "./user-digest.constants";

const logger = createLogger({ name: "user-digest-delivery-scheduler" });

type OrgRunStatus = "completed" | "skipped";

@Injectable()
export class UserDigestDeliverySchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly deliveryService: UserDigestDeliveryService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduledDeliveries() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    if (orgs.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.userDigestDeliveryOrgConcurrency;
    logger.info(
      { orgCount: orgs.length, concurrency },
      "User digest delivery scheduler tick started",
    );

    const results = await settleWithConcurrency(orgs, concurrency, async (org) =>
      await this.runOrgWithLock(org.id),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        logger.warn(
          { err: result.reason, orgId: result.item.id },
          "User digest delivery scheduler failed for org",
        );
        continue;
      }
      if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "User digest delivery scheduler tick completed",
    );
  }

  private async runOrgWithLock(orgId: string): Promise<OrgRunStatus> {
    const locked = await this.cache.withLock(
      `cron:user-digest-delivery:org:${orgId}`,
      USER_DIGEST_ORG_LOCK_TTL_MS,
      async () => {
        await this.deliveryService.runDueDeliveriesForOrg(orgId, new Date());
        return "completed" as const;
      },
    );

    if (locked !== null) {
      return locked;
    }

    logger.info(
      { orgId },
      "Skipped user digest delivery because previous org run is still in progress",
    );
    return "skipped";
  }
}
