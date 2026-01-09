import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CrawlTemplateService } from "./crawl-template.service";
import { CreateCrawlTemplateDto, ListCrawlTemplateDto, UpdateCrawlTemplateDto } from "./dto/crawl-template.dto";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/crawl-templates")
export class CrawlTemplateController {
  constructor(private readonly templates: CrawlTemplateService) {}

  @Get()
  @Permissions("crawl.read")
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListCrawlTemplateDto) {
    return this.templates.listTemplates(user.orgId, query);
  }

  @Post()
  @Permissions("crawl.write")
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCrawlTemplateDto) {
    return this.templates.createTemplate(user.orgId, body);
  }

  @Patch(":id")
  @Permissions("crawl.write")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: UpdateCrawlTemplateDto
  ) {
    return this.templates.updateTemplate(user.orgId, id, body);
  }

  @Delete(":id")
  @Permissions("crawl.write")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.templates.deleteTemplate(user.orgId, id);
  }
}

