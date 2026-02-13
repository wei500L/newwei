import { Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { resolveRequestIp } from "../../common/request-ip";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CrawlMetadataService } from "./crawl-metadata.service";
import { CrawlTaskService } from "./crawl-task.service";
import { CrawlMetadataRequestDto } from "./dto/crawl-metadata.dto";
import { CreateCrawlTaskDto } from "./dto/create-crawl-task.dto";
import { CrawlTaskDetailQueryDto, ListCrawlTaskDto } from "./dto/list-crawl-task.dto";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("crawl-tasks")
export class CrawlController {
  constructor(
    private readonly crawlTaskService: CrawlTaskService,
    private readonly metadataService: CrawlMetadataService
  ) {}

  @Permissions("crawl.read")
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListCrawlTaskDto) {
    return this.crawlTaskService.listTasks(user.orgId, query);
  }

  @Permissions("crawl.read")
  @Get(":id")
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Query() query: CrawlTaskDetailQueryDto
  ) {
    return this.crawlTaskService.getTask(user.orgId, id, query, { userId: user.id });
  }

  @Permissions("crawl.write")
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCrawlTaskDto,
    @Req() req: Request
  ) {
    return this.crawlTaskService.createTask(
      user.orgId,
      user.id,
      body,
      resolveRequestIp(req),
      user.permissions
    );
  }

  @Permissions("crawl.write")
  @Delete(":id")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.crawlTaskService.deleteTask(user.orgId, user.id, id);
    return { ok: true };
  }

  @Permissions("crawl.write")
  @Post(":id/retry")
  async retry(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: Request) {
    return this.crawlTaskService.retryTask(
      user.orgId,
      user.id,
      id,
      resolveRequestIp(req),
      user.permissions
    );
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
