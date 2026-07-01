import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CrawlAdaptiveConcurrencyService } from "./crawl-adaptive-concurrency.service";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlSettingsService } from "./crawl-settings.service";
import {
  CRAWL_QUEUE_HOT_NAME,
  CRAWL_QUEUE_MODE,
  CRAWL_QUEUE_NAME,
  CRAWL_QUEUE_NORMAL_NAME
} from "./crawl.constants";
import { CrawlQueueProcessor } from "./crawl.processor";
import { UpdateCrawlQueueConcurrencyDto } from "./dto/crawl-queue.dto";

type QueueCounts = Record<string, number>;

function mergeCounts(left: QueueCounts, right: QueueCounts): QueueCounts {
  const merged: QueueCounts = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/crawl4ai")
export class Crawl4aiQueueController {
  constructor(
    private readonly crawlQueue: CrawlQueueService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly crawlProcessor: CrawlQueueProcessor,
    private readonly adaptiveConcurrency: CrawlAdaptiveConcurrencyService
  ) {}

  @Get("queue")
  @Permissions("crawl.read")
  async getQueueStats() {
    const [settings, queues, legacyQueue, countsByQueue] = await Promise.all([
      this.crawlSettings.getSettings(),
      this.crawlQueue.getRuntimeStatsByQueue(),
      this.crawlQueue.getLegacyRuntimeStats(),
      this.crawlQueue.getJobCountsByQueue()
    ]);
    const adaptive = await this.adaptiveConcurrency.getStatus(settings);

    const counts = legacyQueue
      ? mergeCounts(
          mergeCounts(countsByQueue.hot, countsByQueue.normal),
          legacyQueue.counts
        )
      : mergeCounts(countsByQueue.hot, countsByQueue.normal);
    const maxConcurrency = settings.maxConcurrency;
    const legacyBlocksPause =
      legacyQueue &&
      (legacyQueue.pending > 0 || (legacyQueue.counts.paused ?? 0) > 0)
        ? legacyQueue.paused
        : true;
    const paused = queues.hot.paused && queues.normal.paused && legacyBlocksPause;
    const effectiveConcurrency = maxConcurrency;
    const pending =
      (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    return {
      queueName: `${CRAWL_QUEUE_HOT_NAME},${CRAWL_QUEUE_NORMAL_NAME}`,
      legacyQueueName: CRAWL_QUEUE_NAME,
      queueMode: CRAWL_QUEUE_MODE,
      queueNames: {
        hot: CRAWL_QUEUE_HOT_NAME,
        normal: CRAWL_QUEUE_NORMAL_NAME,
        legacy: CRAWL_QUEUE_NAME,
      },
      updatedAt: new Date().toISOString(),
      pending,
      counts,
      paused,
      maxConcurrency,
      effectiveConcurrency,
      queues: legacyQueue ? { ...queues, legacy: legacyQueue } : queues,
      adaptive
    };
  }

  @Post("queue/pause")
  @Permissions("settings.manage")
  async pauseQueue() {
    await this.crawlQueue.pauseQueue();
    return this.getQueueStats();
  }

  @Post("queue/resume")
  @Permissions("settings.manage")
  async resumeQueue() {
    await this.crawlQueue.resumeQueue();
    return this.getQueueStats();
  }

  @Post("queue/concurrency")
  @Permissions("settings.manage")
  async updateQueueConcurrency(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateCrawlQueueConcurrencyDto
  ) {
    const settings = await this.crawlSettings.updateMaxConcurrency(user.orgId, user.id, body.maxConcurrency);
    await this.crawlQueue.setGlobalConcurrency(settings.maxConcurrency);
    this.crawlProcessor.setWorkerConcurrency(settings.maxConcurrency);

    return {
      updatedAt: new Date().toISOString(),
      maxConcurrency: settings.maxConcurrency
    };
  }
}
