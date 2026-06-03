import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { ActiveOrgRegistryService } from "../org/active-org-registry.service";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";

import { NewsnowHottestAnalysisService } from "./newsnow-hottest-analysis.service";

const logger = createLogger({ name: "newsnow-hottest-analysis-scheduler" });
const NEWSNOW_ANALYSIS_TICK_GATE_TTL_MS = 9 * 60_000 + 45_000;
const NEWSNOW_ANALYSIS_ORG_LOCK_TTL_MS = 8 * 60_000;

type NewsnowHottestSchedulerOrgRunStatus = "completed" | "skipped";

@Injectable()
export class NewsnowHottestAnalysisSchedulerService {
  constructor(
    private readonly activeOrgRegistry: ActiveOrgRegistryService,
    private readonly cache: CacheService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly hottestAnalysis: NewsnowHottestAnalysisService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshScheduled() {
    const claimed = await claimSchedulerTick(
      this.cache,
      "cron:newsnow-hottest-analysis:tick-gate",
      NEWSNOW_ANALYSIS_TICK_GATE_TTL_MS,
    );
    if (!claimed) {
      logger.info(
        "Skipped NewsNow hottest analysis scheduler tick because another instance already claimed this interval",
      );
      return;
    }

    const orgs = await this.activeOrgRegistry.listActiveOrgs();

    if (orgs.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.newsnowHottestAnalysisOrgConcurrency;
    logger.info(
      { orgCount: orgs.length, concurrency },
      "NewsNow hottest analysis scheduler tick started",
    );

    const globalSnapshot = await this.hottestAnalysis.ensureGlobalSnapshot();
    const results = await settleWithConcurrency(
      orgs,
      concurrency,
      async (org) => this.refreshOrgWithLock(org.id, globalSnapshot),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        logger.warn(
          { err: result.reason, orgId: result.item.id },
          "NewsNow hottest analysis refresh failed for org",
        );
        continue;
      }

      if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "NewsNow hottest analysis scheduler tick completed",
    );
  }

  private async refreshOrgWithLock(
    orgId: string,
    globalSnapshot: Awaited<
      ReturnType<NewsnowHottestAnalysisService["ensureGlobalSnapshot"]>
    >,
  ): Promise<NewsnowHottestSchedulerOrgRunStatus> {
    const locked = await this.cache.withLock(
      `cron:newsnow-hottest-analysis:org:${orgId}`,
      NEWSNOW_ANALYSIS_ORG_LOCK_TTL_MS,
      async () => {
        await this.hottestAnalysis.refreshProjectionForOrg({
          orgId,
          allowAutoBridge: false,
          globalSnapshot,
        });
        return "completed" as const;
      },
    );

    if (locked !== null) {
      return locked;
    }

    logger.info(
      { orgId },
      "Skipped NewsNow hottest analysis org refresh because previous org run is still in progress",
    );
    return "skipped";
  }
}
