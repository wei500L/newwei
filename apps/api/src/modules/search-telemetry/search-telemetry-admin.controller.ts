import { BadRequestException, Controller, Get, Query } from "@nestjs/common";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { SearchTelemetrySummaryQueryDto } from "./dto/search-telemetry-summary-query.dto";
import { SearchTelemetryService } from "./search-telemetry.service";

@Controller("admin/search-telemetry")
export class SearchTelemetryAdminController {
  constructor(private readonly service: SearchTelemetryService) {}

  @Get("summary")
  @Permissions("settings.manage")
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SearchTelemetrySummaryQueryDto,
  ) {
    try {
      return await this.service.getSummary({
        orgId: user.orgId,
        from: query.from,
        to: query.to,
        surface: query.surface,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid search telemetry query",
      );
    }
  }
}
