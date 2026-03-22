import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { QualityOverviewService } from "./quality-overview.service";

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality")
export class QualityOverviewController {
  constructor(private readonly overview: QualityOverviewService) {}

  @Get("overview")
  @Permissions("settings.manage")
  async getOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query("windowMinutes") windowMinutes?: string,
  ) {
    const parsedWindow = windowMinutes ? Number(windowMinutes) : undefined;
    return this.overview.getOverview(user.orgId, {
      windowMinutes: Number.isFinite(parsedWindow) ? parsedWindow : undefined,
    });
  }
}
