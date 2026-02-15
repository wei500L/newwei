import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import {
  CreateNewsSourceDto,
  ListNewsSourceDto,
  ScheduleNewsSourceDto,
  UpdateNewsSourceDto,
} from "./dto/news-source.dto";
import { BatchUpdateNewsSourceFrequencyDto } from "./dto/news-source-batch.dto";
import { ImportNewsSourcesFromOpmlDto } from "./dto/import-opml.dto";
import { PreviewNewsSourceOpmlDto } from "./dto/preview-opml.dto";
import { NewsSourceOpmlService } from "./news-source-opml.service";
import { NewsSourceService } from "./news-source.service";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/news-sources")
export class NewsSourceController {
  constructor(
    private readonly newsSources: NewsSourceService,
    private readonly newsSourceOpml: NewsSourceOpmlService,
  ) {}

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

  @Post("batch/frequency")
  @Permissions("crawl.write")
  async batchUpdateFrequency(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BatchUpdateNewsSourceFrequencyDto
  ) {
    return this.newsSources.updateFrequencyForAll(user.orgId, body.frequencySeconds);
  }

  @Get("opml-presets")
  @Permissions("crawl.read")
  async listOpmlPresets() {
    return this.newsSourceOpml.listPresets();
  }

  @Post("opml/preview")
  @Permissions("crawl.write")
  async previewOpml(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewNewsSourceOpmlDto,
  ) {
    return this.newsSourceOpml.preview({
      orgId: user.orgId,
      presetId: body.presetId,
      opmlContent: body.opmlContent,
      defaultLanguage: body.defaultLanguage,
    });
  }

  @Post("opml/import")
  @Permissions("crawl.write")
  async importOpml(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportNewsSourcesFromOpmlDto,
  ) {
    return this.newsSourceOpml.import({
      orgId: user.orgId,
      entries: body.entries,
      conflictPolicy: body.conflictPolicy,
      runtimeProfile: body.runtimeProfile,
    });
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

  @Post(":id/schedule")
  @Permissions("crawl.write")
  async schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: ScheduleNewsSourceDto
  ) {
    return this.newsSources.schedule(user.orgId, id, body);
  }

  @Get(":id/preview")
  @Permissions("crawl.read")
  async preview(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.newsSources.preview(user.orgId, id);
  }
}
