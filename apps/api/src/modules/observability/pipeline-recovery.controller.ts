import { BadRequestException, Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { PipelineRecoveryService } from "./pipeline-recovery.service";

interface ReplayPipelineBody {
  itemMetaId: string;
  rawItemId?: string;
}

interface RollbackPipelineBody {
  itemMetaId: string;
  rawItemId?: string;
}

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality/pipeline")
export class PipelineRecoveryController {
  constructor(private readonly recovery: PipelineRecoveryService) {}

  @Get("runs")
  @Permissions("settings.manage")
  async runs(
    @CurrentUser() user: AuthenticatedUser,
    @Query("itemMetaId") itemMetaId?: string,
    @Query("limit") limit?: string,
  ) {
    const normalizedItemMetaId = typeof itemMetaId === "string" ? itemMetaId.trim() : "";
    if (!normalizedItemMetaId) {
      throw new BadRequestException("itemMetaId is required");
    }
    const parsedLimit = limit ? Number(limit) : undefined;
    const normalizedLimit =
      parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

    return this.recovery.getRuns(
      user.orgId,
      normalizedItemMetaId,
      normalizedLimit,
    );
  }

  @Post("replay")
  @Permissions("settings.manage")
  async replay(@CurrentUser() user: AuthenticatedUser, @Body() body: ReplayPipelineBody) {
    return this.recovery.replay(user.orgId, body.itemMetaId, body.rawItemId);
  }

  @Post("rollback")
  @Permissions("settings.manage")
  async rollback(@CurrentUser() user: AuthenticatedUser, @Body() body: RollbackPipelineBody) {
    return this.recovery.rollback(user.orgId, body.itemMetaId, body.rawItemId);
  }
}
