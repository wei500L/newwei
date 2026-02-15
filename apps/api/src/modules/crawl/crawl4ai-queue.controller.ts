import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CrawlQueueProcessor } from "./crawl.processor";
import { CrawlQueueService } from "./crawl-queue.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import { CrawlSettingsService } from "./crawl-settings.service";
import { UpdateCrawlQueueConcurrencyDto } from "./dto/crawl-queue.dto";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/crawl4ai")
export class Crawl4aiQueueController {
  constructor(
    private readonly crawlQueue: CrawlQueueService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly crawlProcessor: CrawlQueueProcessor
  ) {}

  @Get("queue")
  @Permissions("crawl.read")
  async getQueueStats() {
    const [counts, paused, maxConcurrency, effectiveConcurrency] = await Promise.all([
      this.crawlQueue.getJobCounts(),
      this.crawlQueue.isPaused(),
      this.crawlSettings.getSettings().then((settings) => settings.maxConcurrency),
      this.crawlQueue.getEffectiveConcurrency()
    ]);
    const pending = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    return {
      queueName: CRAWL_QUEUE_NAME,
      updatedAt: new Date().toISOString(),
      pending,
      counts,
      paused,
      maxConcurrency,
      effectiveConcurrency
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
