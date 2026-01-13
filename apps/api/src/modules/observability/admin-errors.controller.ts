import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";

import { ExceptionEventsService, type ExceptionEventKind } from "./exception-events.service";

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/errors")
export class AdminErrorsController {
  constructor(private readonly exceptionEvents: ExceptionEventsService) {}

  @Get()
  @Permissions("settings.manage")
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("kind") kind?: string,
    @Query("start") start?: string,
    @Query("end") end?: string
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    const parsedOffset = offset ? Number(offset) : undefined;
    const normalizedKind =
      kind === "http" || kind === "graphql" || kind === "unknown"
        ? (kind as ExceptionEventKind)
        : undefined;
    return this.exceptionEvents.list({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
      orgId: user?.orgId,
      kind: normalizedKind,
      start,
      end
    });
  }

  @Get("stats")
  @Permissions("settings.manage")
  async stats(
    @CurrentUser() user: AuthenticatedUser,
    @Query("kind") kind?: string,
    @Query("start") start?: string,
    @Query("end") end?: string
  ) {
    const normalizedKind =
      kind === "http" || kind === "graphql" || kind === "unknown"
        ? (kind as ExceptionEventKind)
        : undefined;
    return this.exceptionEvents.stats({
      orgId: user?.orgId,
      kind: normalizedKind,
      start,
      end
    });
  }
}
