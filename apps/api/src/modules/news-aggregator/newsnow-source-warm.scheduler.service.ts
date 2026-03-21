import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { NewsAggregatorService } from "./news-aggregator.service";
import { NewsnowActiveSourceRegistryService } from "./newsnow-active-source-registry.service";

const logger = createLogger({ name: "newsnow-source-warm-scheduler" });
const NEWSNOW_SOURCE_WARM_CONCURRENCY = 6;

@Injectable()
export class NewsnowSourceWarmSchedulerService {
  constructor(
    private readonly activeSources: NewsnowActiveSourceRegistryService,
    private readonly aggregator: NewsAggregatorService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async refreshScheduled() {
    const sourceIds = this.activeSources.getAllActiveSourceIds();
    if (sourceIds.length === 0) {
      return;
    }

    await this.mapWithConcurrency(
      sourceIds,
      NEWSNOW_SOURCE_WARM_CONCURRENCY,
      async (sourceId) => {
        try {
          await this.aggregator.fetchSource(sourceId, false);
        } catch (error) {
          logger.warn(
            {
              err: error,
              sourceId,
            },
            "NewsNow active source warm failed",
          );
        }
      },
    );
  }

  private async mapWithConcurrency<T>(
    values: T[],
    concurrency: number,
    worker: (value: T, index: number) => Promise<void>,
  ) {
    if (values.length === 0) {
      return;
    }

    const safeConcurrency = Math.max(1, Math.min(concurrency, values.length));
    let cursor = 0;

    await Promise.all(
      Array.from({ length: safeConcurrency }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= values.length) {
            return;
          }
          const value = values[index];
          if (value === undefined) {
            continue;
          }
          await worker(value, index);
        }
      }),
    );
  }
}
