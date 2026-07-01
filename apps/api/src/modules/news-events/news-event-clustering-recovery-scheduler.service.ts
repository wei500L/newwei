import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { CacheService } from "../cache/cache.service";

import { NewsEventClusteringRecoveryService } from "./news-event-clustering-recovery.service";

const logger = createLogger({
  name: "news-event-clustering-recovery-scheduler",
});
const CLUSTERING_RECOVERY_SCHEDULER_LOCK_TTL_MS = 4 * 60_000;

@Injectable()
export class NewsEventClusteringRecoverySchedulerService {
  constructor(
    private readonly cache: CacheService,
    private readonly recovery: NewsEventClusteringRecoveryService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async enqueuePendingLlmBackfills() {
    const locked = await this.cache.withLock(
      "cron:news-event-clustering-recovery",
      CLUSTERING_RECOVERY_SCHEDULER_LOCK_TTL_MS,
      async () => {
        try {
          const result = await this.recovery.enqueuePendingLlmBackfills();
          if (
            result.queued > 0 ||
            result.failed > 0 ||
            result.skipped > 0 ||
            result.skippedNotReady
          ) {
            logger.info(
              result,
              "News event clustering recovery scheduler tick completed",
            );
          }
        } catch (error) {
          logger.warn(
            { err: error },
            "News event clustering recovery scheduler tick failed",
          );
        }
      },
    );

    if (locked === null) {
      logger.info(
        "Skipped news event clustering recovery scheduler tick because the previous tick is still running",
      );
    }
  }
}
