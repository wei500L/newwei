import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { ExceptionEventsService } from "./exception-events.service";

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/errors")
export class AdminErrorsController {
  constructor(private readonly exceptionEvents: ExceptionEventsService) {}

  @Get()
  @Permissions("settings.manage")
  async list(@Query("limit") limit?: string, @Query("offset") offset?: string) {
    const parsedLimit = limit ? Number(limit) : undefined;
    const parsedOffset = offset ? Number(offset) : undefined;
    return this.exceptionEvents.list({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined
    });
  }
}

