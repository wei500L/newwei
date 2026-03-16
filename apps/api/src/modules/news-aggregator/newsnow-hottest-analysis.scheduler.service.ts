import { createLogger } from '@modular/utils';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';

import { NewsnowHottestAnalysisService } from './newsnow-hottest-analysis.service';

const logger = createLogger({ name: 'newsnow-hottest-analysis-scheduler' });
const NEWSNOW_ANALYSIS_SCHEDULER_LOCK_TTL_MS = 8 * 60_000;

@Injectable()
export class NewsnowHottestAnalysisSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
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

    await this.cache.withLock(
      'cron:newsnow-hottest-analysis',
      NEWSNOW_ANALYSIS_SCHEDULER_LOCK_TTL_MS,
      async () => {
        const globalSnapshot = await this.hottestAnalysis.ensureGlobalSnapshot();
        for (const org of orgs) {
          try {
            await this.hottestAnalysis.refreshProjectionForOrg({
              orgId: org.id,
              allowAutoBridge: false,
              globalSnapshot,
            });
          } catch (error) {
            logger.warn(
              { err: error, orgId: org.id },
              'NewsNow hottest analysis refresh failed for org',
            );
          }
        }
      },
    );
  }
}
