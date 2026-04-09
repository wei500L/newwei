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
    const [settings, countsByQueue, pausedByQueue, globalConcurrencyByQueue] = await Promise.all([
      this.crawlSettings.getSettings(),
      this.crawlQueue.getJobCountsByQueue(),
      this.crawlQueue.getPausedByQueue(),
      this.crawlQueue.getGlobalConcurrencyByQueue()
    ]);
    const adaptive = await this.adaptiveConcurrency.getStatus(settings);

    const counts = mergeCounts(countsByQueue.hot, countsByQueue.normal);
    const maxConcurrency = settings.maxConcurrency;
    const queues = {
      hot: {
        queueName: CRAWL_QUEUE_HOT_NAME,
        counts: countsByQueue.hot,
        pending:
          (countsByQueue.hot.waiting ?? 0) +
          (countsByQueue.hot.active ?? 0) +
          (countsByQueue.hot.delayed ?? 0),
        paused: pausedByQueue.hot,
        effectiveConcurrency:
          typeof globalConcurrencyByQueue.hot === "number" &&
          Number.isFinite(globalConcurrencyByQueue.hot) &&
          globalConcurrencyByQueue.hot > 0
            ? Math.max(1, Math.round(globalConcurrencyByQueue.hot))
            : maxConcurrency
      },
      normal: {
        queueName: CRAWL_QUEUE_NORMAL_NAME,
        counts: countsByQueue.normal,
        pending:
          (countsByQueue.normal.waiting ?? 0) +
          (countsByQueue.normal.active ?? 0) +
          (countsByQueue.normal.delayed ?? 0),
        paused: pausedByQueue.normal,
        effectiveConcurrency:
          typeof globalConcurrencyByQueue.normal === "number" &&
          Number.isFinite(globalConcurrencyByQueue.normal) &&
          globalConcurrencyByQueue.normal > 0
            ? Math.max(1, Math.round(globalConcurrencyByQueue.normal))
            : maxConcurrency
      }
    };
    const paused = queues.hot.paused && queues.normal.paused;
    const effectiveConcurrency = maxConcurrency;
    const pending = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    return {
      queueName: `${CRAWL_QUEUE_HOT_NAME},${CRAWL_QUEUE_NORMAL_NAME}`,
      legacyQueueName: CRAWL_QUEUE_NAME,
      queueMode: CRAWL_QUEUE_MODE,
      queueNames: {
        hot: CRAWL_QUEUE_HOT_NAME,
        normal: CRAWL_QUEUE_NORMAL_NAME
      },
      updatedAt: new Date().toISOString(),
      pending,
      counts,
      paused,
      maxConcurrency,
      effectiveConcurrency,
      queues,
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
