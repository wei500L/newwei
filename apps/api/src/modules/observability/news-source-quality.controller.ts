import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { NewsSourceQualityService } from "./news-source-quality.service";

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality")
export class NewsSourceQualityController {
  constructor(private readonly sources: NewsSourceQualityService) {}

  @Get("news-sources")
  @Permissions("settings.manage")
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("windowHours") windowHours?: string,
  ) {
    const parsedWindow = windowHours ? Number(windowHours) : undefined;
    return this.sources.summary(
      user.orgId,
      Number.isFinite(parsedWindow) ? parsedWindow : undefined,
    );
  }
}

