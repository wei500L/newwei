import { BadRequestException, Body, Controller, Headers, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { resolveRequestIp } from "../../common/request-ip";
import type { AuthenticatedUser } from "../auth/auth.service";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { EnvService } from "../config/config.service";

import { ExceptionEventsService, type ExceptionEventKind } from "./exception-events.service";

const TRACE_ID_MAX_LENGTH = 128;
const TIMESTAMP_MAX_LENGTH = 64;
const MESSAGE_MAX_LENGTH = 1_000;
const PATH_MAX_LENGTH = 512;
const METHOD_MAX_LENGTH = 16;
const OPERATION_MAX_LENGTH = 120;
const OPERATION_NAME_MAX_LENGTH = 160;
const ERROR_NAME_MAX_LENGTH = 120;

interface ReportClientExceptionEventBody {
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

@ApiTags("observability")
@ApiBearerAuth()
@Controller("observability")
export class ClientExceptionEventsController {
  constructor(
    private readonly exceptionEvents: ExceptionEventsService,
    private readonly rateLimiter: RateLimiterService,
    private readonly env: EnvService
  ) {}

  @Post("exception-events/client")
  @AllowAuthenticated()
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Headers("x-trace-id") incomingTraceId: string | undefined,
    @Body() body: ReportClientExceptionEventBody
  ) {
    const message = this.normalizeString(body?.message, "message", MESSAGE_MAX_LENGTH);
    if (!message) {
      throw new BadRequestException("message is required");
    }
    const traceId =
      this.normalizeString(incomingTraceId, "x-trace-id", TRACE_ID_MAX_LENGTH) ??
      this.normalizeString(body?.traceId, "traceId", TRACE_ID_MAX_LENGTH) ??
      "";
    const timestamp = this.normalizeString(body?.timestamp, "timestamp", TIMESTAMP_MAX_LENGTH);
    const statusCode = this.normalizeStatusCode(body?.statusCode);
    const path = this.normalizeString(body?.path, "path", PATH_MAX_LENGTH);
    const method = this.normalizeMethod(body?.method);
    const operation = this.normalizeString(body?.operation, "operation", OPERATION_MAX_LENGTH);
    const operationName = this.normalizeString(
      body?.operationName,
      "operationName",
      OPERATION_NAME_MAX_LENGTH
    );
    const errorName = this.normalizeString(body?.errorName, "errorName", ERROR_NAME_MAX_LENGTH);

    // Validate first so invalid payloads do not consume ingest quota.
    await this.enforceRateLimit(user, request);

    this.exceptionEvents.record({
      kind: this.normalizeKind(body?.kind),
      traceId,
      timestamp,
      statusCode,
      message,
      path,
      method,
      operation,
      operationName,
      errorName,
      // Do not persist client-side stack traces from user traffic to avoid leaking sensitive data.
      stack: undefined,
      orgId: user?.orgId,
      userId: user?.id
    });

    return { ok: true };
  }

  private async enforceRateLimit(user: AuthenticatedUser, request: Request) {
    const { userLimit, ipLimit, windowSeconds } = this.env.observabilityClientExceptionRateLimit;

    const userAllowed = await this.rateLimiter.consume(
      `observability:client-exception:user:${user.orgId}:${user.id}`,
      userLimit,
      windowSeconds
    );
    if (!userAllowed) {
      throw new TooManyRequestsException(
        "Too many client exception events from this user. Please retry later."
      );
    }

    const ip = resolveRequestIp(request)?.trim();
    if (!ip) {
      return;
    }

    const ipAllowed = await this.rateLimiter.consume(
      `observability:client-exception:ip:${user.orgId}:${ip}`,
      ipLimit,
      windowSeconds
    );
    if (!ipAllowed) {
      throw new TooManyRequestsException(
        "Too many client exception events from this IP. Please retry later."
      );
    }
  }

  private normalizeString(
    value: unknown,
    fieldName: string,
    maxLength: number
  ): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException(
        `${fieldName} is too long (max ${maxLength} characters)`
      );
    }
    return trimmed;
  }

  private normalizeMethod(value: unknown): string | undefined {
    const method = this.normalizeString(value, "method", METHOD_MAX_LENGTH);
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
