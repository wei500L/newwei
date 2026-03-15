import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import {
  AdminLogsService,
  type TaskLogStatus,
} from "./admin-logs.service";
import { type ExceptionEventKind } from "./exception-events.service";

function parseDateQuery(name: string, value: string | undefined): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${name} must be a valid date`);
  }

  return parsed;
}

function parsePositiveIntQuery(name: string, value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException(`${name} must be a positive number`);
  }

  return Math.trunc(parsed);
}

function parseDateRange(startRaw?: string, endRaw?: string) {
  const start = parseDateQuery("start", startRaw);
  const end = parseDateQuery("end", endRaw);

  if (start && end && start.getTime() > end.getTime()) {
    throw new BadRequestException("start must be earlier than or equal to end");
  }

  return { start, end };
}

function normalizeTaskLogStatus(raw: string | undefined): TaskLogStatus | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }

  if (value === "pending" || value === "processing" || value === "completed" || value === "failed") {
    return value;
  }

  throw new BadRequestException("status must be one of pending, processing, completed, failed");
}

function normalizeExceptionEventKind(raw: string | undefined): ExceptionEventKind | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }

  if (value === "http" || value === "graphql" || value === "unknown") {
    return value;
  }

  throw new BadRequestException("kind must be one of http, graphql, unknown");
}

function normalizeText(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/logs")
export class AdminLogsController {
  constructor(private readonly adminLogs: AdminLogsService) {}

  @Get("task")
  @Permissions("settings.manage")
  async listTaskLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Query("queue") queue?: string,
    @Query("jobId") jobId?: string,
    @Query("stage") stage?: string,
    @Query("status") status?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
    @Query("page") pageRaw?: string,
    @Query("pageSize") pageSizeRaw?: string,
  ) {
    const { start, end } = parseDateRange(startRaw, endRaw);
    const page = parsePositiveIntQuery("page", pageRaw, 1);
    const pageSize = parsePositiveIntQuery("pageSize", pageSizeRaw, 20);

    return this.adminLogs.listTaskLogs(
      {
        orgId: user.orgId,
        queue: normalizeText(queue),
        jobId: normalizeText(jobId),
        stage: normalizeText(stage),
        status: normalizeTaskLogStatus(status),
        start,
        end,
      },
      { page, pageSize },
    );
  }

  @Get("task/summary")
  @Permissions("settings.manage")
  async summarizeTaskLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Query("queue") queue?: string,
    @Query("jobId") jobId?: string,
    @Query("stage") stage?: string,
    @Query("status") status?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
  ) {
    const { start, end } = parseDateRange(startRaw, endRaw);

    return this.adminLogs.summarizeTaskLogs({
      orgId: user.orgId,
      queue: normalizeText(queue),
      jobId: normalizeText(jobId),
      stage: normalizeText(stage),
      status: normalizeTaskLogStatus(status),
      start,
      end,
    });
  }

  @Get("errors")
  @Permissions("settings.manage")
  async listErrors(
    @CurrentUser() user: AuthenticatedUser,
    @Query("kind") kind?: string,
    @Query("operationName") operationName?: string,
    @Query("messageContains") messageContains?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
    @Query("page") pageRaw?: string,
    @Query("pageSize") pageSizeRaw?: string,
  ) {
    const { start, end } = parseDateRange(startRaw, endRaw);
    const page = parsePositiveIntQuery("page", pageRaw, 1);
    const pageSize = parsePositiveIntQuery("pageSize", pageSizeRaw, 20);

    return this.adminLogs.listErrors(
      {
        orgId: user.orgId,
        kind: normalizeExceptionEventKind(kind),
        operationName: normalizeText(operationName),
        messageContains: normalizeText(messageContains),
        start,
        end,
      },
      { page, pageSize },
    );
  }

  @Get("errors/summary")
  @Permissions("settings.manage")
  async summarizeErrors(
    @CurrentUser() user: AuthenticatedUser,
    @Query("kind") kind?: string,
    @Query("operationName") operationName?: string,
    @Query("messageContains") messageContains?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
  ) {
    const { start, end } = parseDateRange(startRaw, endRaw);

    return this.adminLogs.summarizeErrors({
      orgId: user.orgId,
      kind: normalizeExceptionEventKind(kind),
      operationName: normalizeText(operationName),
      messageContains: normalizeText(messageContains),
      start,
      end,
    });
  }

  @Get("audit")
  @Permissions("settings.manage")
  async listAuditLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Query("search") search?: string,
    @Query("resource") resource?: string,
    @Query("action") action?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
    @Query("page") pageRaw?: string,
    @Query("pageSize") pageSizeRaw?: string,
  ) {
    const { start, end } = parseDateRange(startRaw, endRaw);
    const page = parsePositiveIntQuery("page", pageRaw, 1);
    const pageSize = parsePositiveIntQuery("pageSize", pageSizeRaw, 20);

    return this.adminLogs.listAuditLogs(
      {
        orgId: user.orgId,
        search: normalizeText(search),
        resource: normalizeText(resource),
        action: normalizeText(action),
        start,
        end,
      },
      { page, pageSize },
    );
  }
}
