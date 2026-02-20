import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
  UnauthorizedException
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { EnvService } from "../config/config.service";

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
@Controller("internal/observability")
export class InternalExceptionEventsController {
  constructor(
    private readonly env: EnvService,
    private readonly exceptionEvents: ExceptionEventsService
  ) {}

  @Post("exception-events")
  async report(
    @Headers("authorization") authorization: string | undefined,
    @Headers("x-trace-id") incomingTraceId: string | undefined,
    @Body() body: ReportExceptionEventBody
  ) {
    const expected = this.env.liteLlmConfigInternalToken;
    if (!expected) {
      throw new ForbiddenException("LITELLM_CONFIG_INTERNAL_TOKEN is not configured");
    }

    const token = this.extractBearerToken(authorization);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    if (token !== expected) {
      throw new UnauthorizedException("Invalid bearer token");
    }

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

  private extractBearerToken(header: string | undefined): string | null {
    if (!header) {
      return null;
    }
    const trimmed = header.trim();
    if (!trimmed) {
      return null;
    }
    const match = trimmed.match(/^bearer\s+(.+)$/i);
    if (!match?.[1]) {
      return null;
    }
    const token = match[1].trim();
    return token.length > 0 ? token : null;
  }
}
