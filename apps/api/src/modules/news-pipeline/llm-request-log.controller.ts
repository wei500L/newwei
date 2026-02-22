import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import {
  LlmRequestLogService,
  type LlmRequestStatus,
  type LlmRequestType,
} from "./llm-request-log.service";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

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

function parsePositiveIntQuery(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException(`${name} must be a positive number`);
  }
  return Math.trunc(parsed);
}

function normalizeRequestType(raw: string | undefined): LlmRequestType | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (
    value === "completion" ||
    value === "embedding" ||
    value === "rerank" ||
    value === "stream" ||
    value === "responses"
  ) {
    return value;
  }
  throw new BadRequestException("requestType must be one of completion, embedding, rerank, stream, responses");
}

function normalizeStatus(raw: string | undefined): LlmRequestStatus | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (value === "success" || value === "error") {
    return value;
  }
  throw new BadRequestException("status must be one of success, error");
}

@ApiTags("observability")
@ApiBearerAuth()
@Controller("llm-logs")
export class LlmRequestLogController {
  constructor(private readonly llmRequestLogService: LlmRequestLogService) {}

  @Get()
  @Permissions("settings.manage")
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("page") pageRaw?: string,
    @Query("pageSize") pageSizeRaw?: string,
    @Query("model") modelRaw?: string,
    @Query("requestType") requestTypeRaw?: string,
    @Query("status") statusRaw?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
  ) {
    const page = parsePositiveIntQuery("page", pageRaw, DEFAULT_PAGE);
    const pageSize = parsePositiveIntQuery("pageSize", pageSizeRaw, DEFAULT_PAGE_SIZE);
    const model = typeof modelRaw === "string" && modelRaw.trim().length > 0 ? modelRaw.trim() : undefined;
    const requestType = normalizeRequestType(requestTypeRaw);
    const status = normalizeStatus(statusRaw);
    const start = parseDateQuery("start", startRaw);
    const end = parseDateQuery("end", endRaw);

    if (start && end && start.getTime() > end.getTime()) {
      throw new BadRequestException("start must be earlier than or equal to end");
    }

    return this.llmRequestLogService.queryLogs(
      {
        orgId: user.orgId,
        model,
        requestType,
        status,
        start,
        end,
      },
      {
        page,
        pageSize,
      },
    );
  }

  @Get("summary")
  @Permissions("settings.manage")
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
  ) {
    const start = parseDateQuery("start", startRaw);
    const end = parseDateQuery("end", endRaw);

    if (start && end && start.getTime() > end.getTime()) {
      throw new BadRequestException("start must be earlier than or equal to end");
    }

    return this.llmRequestLogService.getUsageSummary(user.orgId, {
      start,
      end,
    });
  }
}
