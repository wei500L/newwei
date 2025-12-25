import { Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { DashboardDemoMetricsService } from "./dashboard-demo-metrics.service";
import { DashboardService } from "./dashboard.service";

@ApiTags("dashboard")
@ApiBearerAuth()
@Controller("dashboard")
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    private readonly demoMetricsService: DashboardDemoMetricsService
  ) {}

  @Permissions("items.read")
  @Get("stats")
  async stats(@CurrentUser() user: AuthenticatedUser) {
    return this.service.stats(user.orgId);
  }

  @Permissions("economicdata.manage")
  @Post("demo-metrics/refresh")
  async refreshDemoMetrics() {
    await this.demoMetricsService.refreshDemoMetrics();
    return { ok: true };
  }
}
