import { BadRequestException, Body, Controller, Headers, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { ExceptionEventsService, type ExceptionEventKind } from "./exception-events.service";

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
  constructor(private readonly exceptionEvents: ExceptionEventsService) {}

  @Post("exception-events/client")
  @AllowAuthenticated()
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Headers("x-trace-id") incomingTraceId: string | undefined,
    @Body() body: ReportClientExceptionEventBody
  ) {
    const message = this.normalizeString(body?.message);
    if (!message) {
      throw new BadRequestException("message is required");
    }

    this.exceptionEvents.record({
      kind: this.normalizeKind(body?.kind),
      traceId: this.normalizeString(incomingTraceId) ?? this.normalizeString(body?.traceId) ?? "",
      timestamp: this.normalizeString(body?.timestamp),
      statusCode: this.normalizeStatusCode(body?.statusCode),
      message,
      path: this.normalizeString(body?.path),
      method: this.normalizeMethod(body?.method),
      operation: this.normalizeString(body?.operation),
      operationName: this.normalizeString(body?.operationName),
      errorName: this.normalizeString(body?.errorName),
      // Do not persist client-side stack traces from user traffic to avoid leaking sensitive data.
      stack: undefined,
      orgId: user?.orgId,
      userId: user?.id
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
