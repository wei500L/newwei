import { Body, Controller, Post } from "@nestjs/common";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { RecordSearchTelemetryDto } from "./dto/record-search-telemetry.dto";
import { SearchTelemetryService } from "./search-telemetry.service";

@Controller("search-telemetry")
export class SearchTelemetryController {
  constructor(private readonly service: SearchTelemetryService) {}

  @Post()
  @Permissions("items.read")
  async record(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RecordSearchTelemetryDto,
  ) {
    return this.service.record({
      orgId: user.orgId,
      eventType: body.eventType,
      surface: body.surface,
      vertical: body.vertical,
      queryLength: body.queryLength,
    });
  }
}
