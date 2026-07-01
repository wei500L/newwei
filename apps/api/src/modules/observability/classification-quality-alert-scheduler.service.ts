import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";

import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { ActiveOrgRegistryService } from "../org/active-org-registry.service";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";

import { ClassificationQualityService } from "./classification-quality.service";
import { recordSchedulerRun } from "./prometheus-metrics";

const CLASSIFICATION_ALERT_SCHEDULER_INTERVAL_MS = 5 * 60_000;
const CLASSIFICATION_ALERT_TICK_GATE_TTL_MS = 4 * 60_000 + 45_000;
const CLASSIFICATION_ALERT_LOCK_TTL_MS = 4 * 60_000;

type ClassificationAlertSchedulerOrgRunStatus =
  | "completed"
  | "failed"
  | "skipped";

@Injectable()
export class ClassificationQualityAlertSchedulerService {
  private readonly logger = createLogger({
    name: "classification-quality-alert-scheduler",
  });

  constructor(
    private readonly activeOrgRegistry: ActiveOrgRegistryService,
    private readonly cache: CacheService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly classificationQuality: ClassificationQualityService,
  ) {}

  @Interval(
    "classification-quality-alert-evaluation",
    CLASSIFICATION_ALERT_SCHEDULER_INTERVAL_MS,
  )
  async evaluate(): Promise<void> {
    const claimed = await claimSchedulerTick(
      this.cache,
      "cron:classification-quality-alert:tick-gate",
      CLASSIFICATION_ALERT_TICK_GATE_TTL_MS,
    );
    if (!claimed) {
      this.logger.info(
        "Skipped classification quality alert scheduler tick because another instance already claimed this interval",
      );
      return;
    }

    const orgs = await this.activeOrgRegistry.listActiveOrgs();
    if (orgs.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.classificationQualityAlertOrgConcurrency;
    this.logger.info(
      { orgCount: orgs.length, concurrency },
      "Classification quality alert scheduler tick started",
    );

    const results = await settleWithConcurrency(
      orgs,
      concurrency,
      async (org) => this.evaluateOrg(org.id),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        this.logger.warn(
          { err: result.reason, orgId: result.item.id },
          "Classification quality alert scheduler failed for org",
        );
        continue;
      }
      if (result.value === "failed") {
        failedOrgs += 1;
      } else if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    this.logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "Classification quality alert scheduler tick completed",
    );
  }

  private async evaluateOrg(
    orgId: string,
  ): Promise<ClassificationAlertSchedulerOrgRunStatus> {
    const lockKey = `quality:classification:alert-scheduler:${orgId}:1h`;
    const locked = await this.cache.withLock(
      lockKey,
      CLASSIFICATION_ALERT_LOCK_TTL_MS,
      async () => {
        try {
          await this.classificationQuality.getSummary({
            orgId,
            window: "1h",
          });
          recordSchedulerRun("classification_quality_alerts", "success");
          return "completed" as const;
        } catch (error) {
          recordSchedulerRun("classification_quality_alerts", "failure");
          this.logger.warn(
            { err: error, orgId },
            "Scheduled classification quality alert evaluation failed",
          );
          return "failed" as const;
        }
      },
    );
    return locked ?? "skipped";
  }
}
