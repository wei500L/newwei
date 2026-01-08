import { TaskLogModel } from "@modular/mongo";
import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

type TaskLogStatus = "pending" | "processing" | "completed" | "failed";

function isTaskLogStatus(value: string): value is TaskLogStatus {
  return value === "pending" || value === "processing" || value === "completed" || value === "failed";
}

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality")
export class TaskLogsController {
  @Get("task-logs")
  @Permissions("settings.manage")
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("queue") queue?: string,
    @Query("stage") stage?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("sinceMinutes") sinceMinutes?: string
  ) {
    const normalizedLimitRaw = limit ? Number(limit) : 50;
    const normalizedLimit = Math.min(Math.max(Number.isFinite(normalizedLimitRaw) ? Math.floor(normalizedLimitRaw) : 50, 1), 200);

    const normalizedSinceRaw = sinceMinutes ? Number(sinceMinutes) : null;
    const normalizedSinceMinutes =
      normalizedSinceRaw !== null && Number.isFinite(normalizedSinceRaw) ? Math.floor(normalizedSinceRaw) : null;
    const since =
      normalizedSinceMinutes !== null && normalizedSinceMinutes > 0
        ? new Date(Date.now() - normalizedSinceMinutes * 60 * 1000)
        : null;

    const where: Record<string, unknown> = { orgId: user.orgId };
    const normalizedQueue = typeof queue === "string" ? queue.trim() : "";
    if (normalizedQueue) {
      where.queue = normalizedQueue;
    }
    const normalizedStage = typeof stage === "string" ? stage.trim() : "";
    if (normalizedStage) {
      where.stage = normalizedStage;
    }
    const normalizedStatus = typeof status === "string" ? status.trim() : "";
    if (normalizedStatus && isTaskLogStatus(normalizedStatus)) {
      where.status = normalizedStatus;
    }
    if (since) {
      where.createdAt = { $gte: since };
    }

    return TaskLogModel.find(where)
      .sort({ createdAt: -1 })
      .limit(normalizedLimit)
      .lean();
  }
}

