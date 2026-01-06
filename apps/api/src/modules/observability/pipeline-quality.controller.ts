import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { PipelineQualityService } from "./pipeline-quality.service";

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality")
export class PipelineQualityController {
  constructor(private readonly pipelineQuality: PipelineQualityService) {}

  @Get("pipeline")
  @Permissions("settings.manage")
  async pipelineSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("windowMinutes") windowMinutes?: string
  ) {
    const parsedWindow = windowMinutes ? Number(windowMinutes) : undefined;
    return this.pipelineQuality.summary(
      user?.orgId,
      Number.isFinite(parsedWindow) ? parsedWindow : undefined
    );
  }
}
