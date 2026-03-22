import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { AdminLogsService, type TaskLogStatus } from "./admin-logs.service";

function isTaskLogStatus(value: string): value is TaskLogStatus {
  return (
    value === "pending" ||
    value === "processing" ||
    value === "completed" ||
    value === "failed"
  );
}

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality")
export class TaskLogsController {
  constructor(private readonly adminLogs: AdminLogsService) {}

  @Get("task-logs")
  @Permissions("settings.manage")
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("queue") queue?: string,
    @Query("jobId") jobId?: string,
    @Query("stage") stage?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("sinceMinutes") sinceMinutes?: string,
  ) {
    const normalizedLimitRaw = limit ? Number(limit) : 50;
    const normalizedLimit = Math.min(
      Math.max(
        Number.isFinite(normalizedLimitRaw)
          ? Math.floor(normalizedLimitRaw)
          : 50,
        1,
      ),
      200,
    );

    const normalizedSinceRaw = sinceMinutes ? Number(sinceMinutes) : null;
    const normalizedSinceMinutes =
      normalizedSinceRaw !== null && Number.isFinite(normalizedSinceRaw)
        ? Math.floor(normalizedSinceRaw)
        : null;
    const since =
      normalizedSinceMinutes !== null && normalizedSinceMinutes > 0
        ? new Date(Date.now() - normalizedSinceMinutes * 60 * 1000)
        : undefined;
    const normalizedStatus = typeof status === "string" ? status.trim() : "";

    const response = await this.adminLogs.listTaskLogs(
      {
        orgId: user.orgId,
        queue:
          typeof queue === "string" ? queue.trim() || undefined : undefined,
        jobId:
          typeof jobId === "string" ? jobId.trim() || undefined : undefined,
        stage:
          typeof stage === "string" ? stage.trim() || undefined : undefined,
        status:
          normalizedStatus && isTaskLogStatus(normalizedStatus)
            ? normalizedStatus
            : undefined,
        start: since,
      },
      { page: 1, pageSize: normalizedLimit },
    );

    return response.items;
  }

  @Get("task-logs/summary")
  @Permissions("settings.manage")
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("queue") queue?: string,
    @Query("stage") stage?: string,
    @Query("status") status?: string,
    @Query("sinceMinutes") sinceMinutes?: string,
  ) {
    const normalizedSinceRaw = sinceMinutes ? Number(sinceMinutes) : null;
    const normalizedSinceMinutes =
      normalizedSinceRaw !== null && Number.isFinite(normalizedSinceRaw)
        ? Math.floor(normalizedSinceRaw)
        : null;
    const since =
      normalizedSinceMinutes !== null && normalizedSinceMinutes > 0
        ? new Date(Date.now() - normalizedSinceMinutes * 60 * 1000)
        : undefined;
    const normalizedStatus = typeof status === "string" ? status.trim() : "";

    return this.adminLogs.summarizeTaskLogs({
      orgId: user.orgId,
      queue: typeof queue === "string" ? queue.trim() || undefined : undefined,
      stage: typeof stage === "string" ? stage.trim() || undefined : undefined,
      status:
        normalizedStatus && isTaskLogStatus(normalizedStatus)
          ? normalizedStatus
          : undefined,
      start: since,
    });
  }
}
