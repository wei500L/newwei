import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { LitellmInternalTokenGuard } from "../../common/guards/litellm-internal-token.guard";

import { ExceptionEventsService, type ExceptionEventKind } from "./exception-events.service";

interface ReportExceptionEventBody {
  kind?: unknown;
  traceId?: unknown;
  timestamp?: unknown;
  statusCode?: unknown;
  message?: unknown;
  path?: unknown;
  method?: unknown;
  operation?: unknown;
  operationName?: unknown;
  errorName?: unknown;
  stack?: unknown;
  orgId?: unknown;
  userId?: unknown;
}

@ApiTags("internal")
@Public()
@UseGuards(LitellmInternalTokenGuard)
@Controller("internal/observability")
export class InternalExceptionEventsController {
  constructor(private readonly exceptionEvents: ExceptionEventsService) {}

  @Post("exception-events")
  async report(
    @Headers("x-trace-id") incomingTraceId: string | undefined,
    @Body() body: ReportExceptionEventBody
  ) {
    const message = this.normalizeString(body?.message);
    if (!message) {
      throw new BadRequestException("message is required");
    }

    this.exceptionEvents.record({
      kind: this.normalizeKind(body?.kind),
      traceId: this.normalizeString(body?.traceId) ?? this.normalizeString(incomingTraceId) ?? "",
      timestamp: this.normalizeString(body?.timestamp),
      statusCode: this.normalizeStatusCode(body?.statusCode),
      message,
      path: this.normalizeString(body?.path),
      method: this.normalizeMethod(body?.method),
      operation: this.normalizeString(body?.operation),
      operationName: this.normalizeString(body?.operationName),
      errorName: this.normalizeString(body?.errorName),
      stack: this.normalizeString(body?.stack),
      orgId: this.normalizeString(body?.orgId),
      userId: this.normalizeString(body?.userId)
    });

    return { ok: true };
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeMethod(value: unknown): string | undefined {
    const method = this.normalizeString(value);
    return method ? method.toUpperCase() : undefined;
  }

  private normalizeKind(value: unknown): ExceptionEventKind {
    if (value === "http" || value === "graphql" || value === "unknown") {
      return value;
    }
    return "unknown";
  }

  private normalizeStatusCode(value: unknown): number | undefined {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    const normalized = Math.floor(numeric);
    if (normalized < 100 || normalized > 599) {
      return undefined;
    }
    return normalized;
  }
}
