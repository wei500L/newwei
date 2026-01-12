import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CreateNewsSourceDto, ListNewsSourceDto, UpdateNewsSourceDto } from "./dto/news-source.dto";
import { NewsSourceService } from "./news-source.service";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/news-sources")
export class NewsSourceController {
  constructor(private readonly newsSources: NewsSourceService) {}

  @Get()
  @Permissions("crawl.read")
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListNewsSourceDto) {
    return this.newsSources.listSources(user.orgId, query);
  }

  @Post()
  @Permissions("crawl.write")
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateNewsSourceDto) {
    return this.newsSources.createSource(user.orgId, body);
  }

  @Patch(":id")
  @Permissions("crawl.write")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: UpdateNewsSourceDto
  ) {
    return this.newsSources.updateSource(user.orgId, id, body);
  }

  @Delete(":id")
  @Permissions("crawl.write")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.newsSources.deleteSource(user.orgId, id);
  }

  @Post(":id/run")
  @Permissions("crawl.write")
  async run(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.newsSources.runNow(user.orgId, id);
  }

  @Get(":id/preview")
  @Permissions("crawl.read")
  async preview(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.newsSources.preview(user.orgId, id);
  }
}
