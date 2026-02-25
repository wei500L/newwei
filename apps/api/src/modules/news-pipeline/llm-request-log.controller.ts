import {
  BadRequestException,
  Controller,
  Get,
  Query,
  StreamableFile,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";

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
const EXPORT_FILENAME = "llm-logs-export.csv";

interface ParsedDateRange {
  start?: Date;
  end?: Date;
}

interface ParsedLogFilter extends ParsedDateRange {
  model?: string;
  feature?: string;
  requestType?: LlmRequestType;
  status?: LlmRequestStatus;
}

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

function normalizeFeature(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value.length > 64 || !/^[a-z0-9_:\-.]+$/.test(value)) {
    throw new BadRequestException(
      "feature must be a lowercase token with [a-z0-9_:. -], max 64 chars",
    );
  }
  return value;
}

function parseDateRange(
  startRaw: string | undefined,
  endRaw: string | undefined,
): ParsedDateRange {
  const start = parseDateQuery("start", startRaw);
  const end = parseDateQuery("end", endRaw);

  if (start && end && start.getTime() > end.getTime()) {
    throw new BadRequestException("start must be earlier than or equal to end");
  }

  return {
    start,
    end,
  };
}

function parseLogFilter(
  modelRaw: string | undefined,
  featureRaw: string | undefined,
  requestTypeRaw: string | undefined,
  statusRaw: string | undefined,
  startRaw: string | undefined,
  endRaw: string | undefined,
): ParsedLogFilter {
  const { start, end } = parseDateRange(startRaw, endRaw);
  return {
    model: typeof modelRaw === "string" && modelRaw.trim().length > 0 ? modelRaw.trim() : undefined,
    feature: normalizeFeature(featureRaw),
    requestType: normalizeRequestType(requestTypeRaw),
    status: normalizeStatus(statusRaw),
    start,
    end,
  };
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
    @Query("feature") featureRaw?: string,
    @Query("requestType") requestTypeRaw?: string,
    @Query("status") statusRaw?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
  ) {
    const page = parsePositiveIntQuery("page", pageRaw, DEFAULT_PAGE);
    const pageSize = parsePositiveIntQuery("pageSize", pageSizeRaw, DEFAULT_PAGE_SIZE);
    const filter = parseLogFilter(
      modelRaw,
      featureRaw,
      requestTypeRaw,
      statusRaw,
      startRaw,
      endRaw,
    );

    return this.llmRequestLogService.queryLogs(
      {
        orgId: user.orgId,
        ...filter,
      },
      {
        page,
        pageSize,
      },
    );
  }

  @Get("export")
  @Permissions("settings.manage")
  @ApiOperation({
    summary: "Export LLM request logs as CSV",
    description:
      "Exports all matched LLM request logs for current organization without pagination using the same filters as GET /llm-logs.",
  })
  @ApiProduces("text/csv")
  @ApiOkResponse({
    description: "CSV stream download",
  })
  @ApiQuery({ name: "model", required: false, type: String })
  @ApiQuery({ name: "feature", required: false, type: String })
  @ApiQuery({
    name: "requestType",
    required: false,
    enum: ["completion", "embedding", "rerank", "stream", "responses"],
  })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["success", "error"],
  })
  @ApiQuery({
    name: "start",
    required: false,
    type: String,
    description: "ISO 8601 datetime",
  })
  @ApiQuery({
    name: "end",
    required: false,
    type: String,
    description: "ISO 8601 datetime",
  })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query("model") modelRaw?: string,
    @Query("feature") featureRaw?: string,
    @Query("requestType") requestTypeRaw?: string,
    @Query("status") statusRaw?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
  ): Promise<StreamableFile> {
    const filter = parseLogFilter(
      modelRaw,
      featureRaw,
      requestTypeRaw,
      statusRaw,
      startRaw,
      endRaw,
    );
    const exportResult = await this.llmRequestLogService.exportLogsCsvStream(
      {
        orgId: user.orgId,
        ...filter,
      },
      {
        actorId: user.id,
      },
    );
    return new StreamableFile(exportResult.stream, {
      type: "text/csv; charset=utf-8",
      disposition: `attachment; filename="${EXPORT_FILENAME}"`,
    });
  }

  @Get("summary")
  @Permissions("settings.manage")
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("feature") featureRaw?: string,
    @Query("start") startRaw?: string,
    @Query("end") endRaw?: string,
  ) {
    const { start, end } = parseDateRange(startRaw, endRaw);
    const feature = normalizeFeature(featureRaw);

    return this.llmRequestLogService.getUsageSummary(user.orgId, {
      start,
      end,
      feature,
    });
  }
}
