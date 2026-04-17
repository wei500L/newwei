import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { NewsEventClusteringFailureService } from "./news-event-clustering-failure.service";
import { NewsEventClusteringRecoveryService } from "./news-event-clustering-recovery.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/news-events/clustering")
export class NewsEventClusteringAdminController {
  constructor(
    private readonly failures: NewsEventClusteringFailureService,
    private readonly recovery: NewsEventClusteringRecoveryService,
  ) {}

  @Get("readiness")
  @Permissions("settings.manage")
  async getReadiness() {
    return this.recovery.getReadiness();
  }

  @Get("overview")
  @Permissions("settings.manage")
  async getOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.failures.getOverview(user.orgId);
  }

  @Get("failures")
  @Permissions("settings.manage")
  async listFailures(
    @CurrentUser() user: AuthenticatedUser,
    @Query("status") status?: string,
    @Query("limit") limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const normalizedStatus =
      status === "pending" ||
      status === "processing" ||
      status === "resolved" ||
      status === "ignored"
        ? status
        : undefined;
    return this.failures.listFailures(user.orgId, {
      status: normalizedStatus,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  }

  @Post("failures/:groupId/vector-backfill")
  @Permissions("settings.manage")
  async vectorBackfill(
    @CurrentUser() user: AuthenticatedUser,
    @Param("groupId") groupId: string,
  ) {
    return this.failures.resolveFailureGroupByVectorBackfill(
      user.orgId,
      user.id,
      groupId,
    );
  }

  @Post("failures/:groupId/llm-backfill")
  @Permissions("settings.manage")
  async llmBackfill(
    @CurrentUser() user: AuthenticatedUser,
    @Param("groupId") groupId: string,
  ) {
    return this.recovery.enqueueLlmBackfill(user.orgId, user.id, groupId);
  }

  @Post("failures/:groupId/ignore")
  @Permissions("settings.manage")
  async ignoreFailure(
    @CurrentUser() user: AuthenticatedUser,
    @Param("groupId") groupId: string,
  ) {
    return this.failures.ignoreFailureGroup(user.orgId, user.id, groupId);
  }
}
