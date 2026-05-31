import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { NewsEventClusteringRecoveryService } from "./news-event-clustering-recovery.service";

const logger = createLogger({
  name: "news-event-clustering-recovery-scheduler",
});

@Injectable()
export class NewsEventClusteringRecoverySchedulerService {
  private running = false;

  constructor(
    private readonly recovery: NewsEventClusteringRecoveryService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async enqueuePendingLlmBackfills() {
    if (this.running) {
      logger.info(
        "Skipped news event clustering recovery scheduler tick because the previous tick is still running",
      );
      return;
    }

    this.running = true;
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
    } finally {
      this.running = false;
    }
  }
}
