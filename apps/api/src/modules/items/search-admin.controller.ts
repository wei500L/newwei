import { Controller, Get, Param, Post } from "@nestjs/common";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import type { SearchReindexJob } from "./search-reindex-job.store";
import { SearchReindexService } from "./search-reindex.service";

@Controller("admin/search")
export class SearchAdminController {
  constructor(private readonly reindexService: SearchReindexService) {}

  @Post("reindex")
  @Permissions("settings.manage")
  async reindex(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SearchReindexJob> {
    return this.reindexService.startReindex(user.orgId);
  }

  @Get("reindex/:jobId")
  @Permissions("settings.manage")
  async getReindexJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param("jobId") jobId: string,
  ): Promise<SearchReindexJob | null> {
    return this.reindexService.getReindexJob(user.orgId, jobId);
  }
}
