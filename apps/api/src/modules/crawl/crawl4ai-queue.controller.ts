import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { Permissions } from "../../common/decorators/permissions.decorator";
import { EnvService } from "../config/config.service";

import { CrawlQueueService } from "./crawl-queue.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/crawl4ai")
export class Crawl4aiQueueController {
  constructor(
    private readonly crawlQueue: CrawlQueueService,
    private readonly env: EnvService
  ) {}

  @Get("queue")
  @Permissions("crawl.read")
  async getQueueStats() {
    const counts = await this.crawlQueue.getJobCounts();
    const pending = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    return {
      queueName: CRAWL_QUEUE_NAME,
      updatedAt: new Date().toISOString(),
      pending,
      counts,
      maxConcurrency: this.env.crawl4aiConfig.maxConcurrency
    };
  }
}
