import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { settleWithConcurrency } from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";

import { NewsAggregatorService } from "./news-aggregator.service";
import { NewsnowActiveSourceRegistryService } from "./newsnow-active-source-registry.service";

const logger = createLogger({ name: "newsnow-source-warm-scheduler" });
const NEWSNOW_SOURCE_WARM_LOCK_KEY = "cron:newsnow-source-warm";
const NEWSNOW_SOURCE_WARM_LOCK_TTL_MS = 55_000;
const NEWSNOW_SOURCE_WARM_CONCURRENCY = 6;

@Injectable()
export class NewsnowSourceWarmSchedulerService {
  constructor(
    private readonly cache: CacheService,
    private readonly activeSources: NewsnowActiveSourceRegistryService,
    private readonly aggregator: NewsAggregatorService,
    private readonly env: EnvService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async refreshScheduled() {
    // Execution ownership: when API_GO_NEWSNOW_BACKGROUND_MODE=go the Go
    // scheduler owns this minute tick, so this callback returns BEFORE taking
    // the warm lock. Both implementations use the same lock key, so a switch
    // flip that briefly leaves both schedulers alive still warms once.
    if (
      this.env.get<string>("API_GO_NEWSNOW_BACKGROUND_MODE", { infer: true }) ===
      "go"
    ) {
      return;
    }

    const locked = await this.cache.withLock(
      NEWSNOW_SOURCE_WARM_LOCK_KEY,
      NEWSNOW_SOURCE_WARM_LOCK_TTL_MS,
      async () => {
        const sourceIds = this.activeSources.getAllActiveSourceIds();
        if (sourceIds.length === 0) {
          return;
        }

        const results = await settleWithConcurrency(
          sourceIds,
          NEWSNOW_SOURCE_WARM_CONCURRENCY,
          async (sourceId) => {
            await this.aggregator.fetchSource(sourceId, false);
          },
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            continue;
          }
          logger.warn(
            {
              err: result.reason,
              sourceId: result.item,
            },
            "NewsNow active source warm failed",
          );
        }
      },
    );

    if (locked === null) {
      logger.info(
        "Skipped NewsNow source warm tick because previous tick is still in progress",
      );
    }
  }
}
