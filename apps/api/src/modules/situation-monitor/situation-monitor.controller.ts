import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { SituationMonitorInsightsQueryDto } from "./dto/situation-monitor.dto";
import { SituationMonitorService } from "./situation-monitor.service";

@ApiTags("situation-monitor")
@ApiBearerAuth()
@Controller("situation-monitor")
export class SituationMonitorController {
  constructor(private readonly monitor: SituationMonitorService) {}

  @Get("insights")
  @Permissions("items.read")
  async insights(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SituationMonitorInsightsQueryDto
  ) {
    return this.monitor.getInsights(user.orgId, {
      windowHours: query.windowHours,
      maxItems: query.maxItems,
    });
  }
}

