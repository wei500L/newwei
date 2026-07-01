import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { ActiveOrgRegistryService } from "../org/active-org-registry.service";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";

import { NewsIndicatorAssociationService } from "./news-indicator-association.service";
import { NewsIndicatorSettingsService } from "./news-indicator-settings.service";

const logger = createLogger({ name: "news-indicator-ingestion" });
const NEWS_INDICATOR_ASSOCIATION_TICK_GATE_TTL_MS =
  5 * 60 * 60_000 + 55 * 60_000;
const NEWS_INDICATOR_ASSOCIATION_ORG_LOCK_TTL_MS = 30 * 60_000;

type NewsIndicatorAssociationSchedulerOrgRunStatus = "completed" | "skipped";

@Injectable()
export class NewsIndicatorAssociationIngestionService {
  constructor(
    private readonly cache: CacheService,
    private readonly activeOrgRegistry: ActiveOrgRegistryService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly settings: NewsIndicatorSettingsService,
    private readonly associations: NewsIndicatorAssociationService,
  ) {}

  @Cron("0 */6 * * *")
  async refreshAssociations() {
    const claimed = await claimSchedulerTick(
      this.cache,
      "cron:news-indicator-association:tick-gate",
      NEWS_INDICATOR_ASSOCIATION_TICK_GATE_TTL_MS,
    );
    if (!claimed) {
      logger.info(
        "Skipped news indicator association refresh because another instance already claimed this interval",
      );
      return;
    }

    const orgs = await this.activeOrgRegistry.listActiveOrgs();

    if (orgs.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.newsIndicatorAssociationOrgConcurrency;
    logger.info(
      { orgCount: orgs.length, concurrency },
      "News indicator association refresh tick started",
    );

    const results = await settleWithConcurrency(
      orgs,
      concurrency,
      async (org) => this.refreshOrgWithLock(org.id),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        logger.warn(
          { err: result.reason, orgId: result.item.id },
          "News indicator association refresh failed",
        );
        continue;
      }
      if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "News indicator association refresh tick completed",
    );
  }

  private async refreshOrgWithLock(
    orgId: string,
  ): Promise<NewsIndicatorAssociationSchedulerOrgRunStatus> {
    const locked = await this.cache.withLock(
      `cron:news-indicator-association:org:${orgId}`,
      NEWS_INDICATOR_ASSOCIATION_ORG_LOCK_TTL_MS,
      async () => {
        const cfg = await this.settings.getSettings(orgId);
        if (!cfg.enabled || !cfg.ingestionEnabled) {
          return "completed" as const;
        }
        await this.associations.refreshOrg(orgId);
        return "completed" as const;
      },
    );

    if (locked !== null) {
      return locked;
    }

    logger.info(
      { orgId },
      "Skipped news indicator association refresh because previous org run is still in progress",
    );
    return "skipped";
  }
}
