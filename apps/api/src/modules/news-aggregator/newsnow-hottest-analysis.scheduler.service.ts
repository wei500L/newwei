import { createLogger } from '@modular/utils';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { settleWithConcurrency } from '../../common/multi-tenant-scheduler';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';
import { MultiTenantSchedulerSettingsService } from '../system-settings/multi-tenant-scheduler-settings.service';

import { NewsnowHottestAnalysisService } from './newsnow-hottest-analysis.service';

const logger = createLogger({ name: 'newsnow-hottest-analysis-scheduler' });
const NEWSNOW_ANALYSIS_SCHEDULER_LOCK_TTL_MS = 8 * 60_000;

@Injectable()
export class NewsnowHottestAnalysisSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly hottestAnalysis: NewsnowHottestAnalysisService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshScheduled() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    if (orgs.length === 0) {
      return;
    }

    const locked = await this.cache.withLock(
      'cron:newsnow-hottest-analysis',
      NEWSNOW_ANALYSIS_SCHEDULER_LOCK_TTL_MS,
      async () => {
        const runtime = await this.schedulerSettings.getRuntimeSettings();
        const concurrency = runtime.newsnowHottestAnalysisOrgConcurrency;
        logger.info(
          { orgCount: orgs.length, concurrency },
          'NewsNow hottest analysis scheduler tick started',
        );

        const globalSnapshot = await this.hottestAnalysis.ensureGlobalSnapshot();
        const results = await settleWithConcurrency(orgs, concurrency, async (org) => {
          await this.hottestAnalysis.refreshProjectionForOrg({
            orgId: org.id,
            allowAutoBridge: false,
            globalSnapshot,
          });
        });

        let failedOrgs = 0;
        for (const result of results) {
          if (result.status !== 'rejected') {
            continue;
          }

          failedOrgs += 1;
          logger.warn(
            { err: result.reason, orgId: result.item.id },
            'NewsNow hottest analysis refresh failed for org',
          );
        }

        logger.info(
          { orgCount: orgs.length, concurrency, failedOrgs },
          'NewsNow hottest analysis scheduler tick completed',
        );

        return 'completed' as const;
      },
    );

    if (locked !== null) {
      return;
    }

    logger.info(
      { orgCount: orgs.length },
      'Skipped NewsNow hottest analysis scheduler tick because previous run is still in progress',
    );
  }
}
