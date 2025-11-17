import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { CrawlService } from "./crawl.service";
import { CrawlMetadataService } from "./crawl-metadata.service";
import { CreateCrawlTaskDto } from "./dto/create-crawl-task.dto";
import { CrawlTaskDetailQueryDto, ListCrawlTaskDto } from "./dto/list-crawl-task.dto";
import { CrawlMetadataRequestDto } from "./dto/crawl-metadata.dto";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("crawl-tasks")
export class CrawlController {
  constructor(
    private readonly crawlService: CrawlService,
    private readonly metadataService: CrawlMetadataService
  ) {}

  @Permissions("crawl.read")
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListCrawlTaskDto) {
    return this.crawlService.listTasks(user.orgId, query);
  }

  @Permissions("crawl.read")
  @Get(":id")
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Query() query: CrawlTaskDetailQueryDto
  ) {
    return this.crawlService.getTask(user.orgId, id, query);
  }

  @Permissions("crawl.write")
  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCrawlTaskDto) {
    return this.crawlService.createTask(user.orgId, user.id, body);
  }

  @Permissions("crawl.write")
  @Delete(":id")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.crawlService.deleteTask(user.orgId, user.id, id);
    return { ok: true };
  }

  @Permissions("crawl.write")
  @Post(":id/retry")
  async retry(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.crawlService.retryTask(user.orgId, user.id, id);
  }

  @Permissions("crawl.read")
  @Post("metadata")
  async extractMetadata(@CurrentUser() user: AuthenticatedUser, @Body() body: CrawlMetadataRequestDto) {
    const results = await this.metadataService.extract(body);
    return {
      orgId: user.orgId,
      total: results.length,
      results
    };
  }
}
