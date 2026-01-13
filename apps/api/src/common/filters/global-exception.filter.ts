import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from "@nestjs/common";
import { GqlArgumentsHost } from "@nestjs/graphql";
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { GraphQLError } from "graphql";

import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { ExceptionEventsService } from "../../modules/observability/exception-events.service";

interface NormalizedHttpResponse {
  statusCode: number;
  message: string;
  error?: unknown;
}

type HostContextType = "http" | "graphql" | "rpc" | "ws";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = createLogger({ name: "exceptions" });
  private readonly exposeErrorDetails = process.env.NODE_ENV !== "production";

  constructor(private readonly exceptionEvents: ExceptionEventsService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const traceId = getCurrentTraceId() ?? ensureTraceId();

    if (host.getType() === "http") {
      this.handleHttpException(exception, host, traceId);
      return;
    }

    if (host.getType<HostContextType>() === "graphql") {
      return this.handleGraphqlException(exception, host, traceId);
    }

    this.logger.error({ traceId, err: exception }, "Unhandled exception");
    try {
      this.exceptionEvents.record({
        kind: "unknown",
        traceId,
        message: exception instanceof Error ? exception.message : "Unhandled exception",
        errorName: exception instanceof Error ? exception.name : undefined,
        stack: exception instanceof Error ? exception.stack : undefined
      });
    } catch {
      // ignore failures in error side-channel
    }
    throw exception;
  }

  private handleHttpException(
    exception: unknown,
    host: ArgumentsHost,
    traceId?: string,
  ) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const httpStatus = this.resolveStatus(exception);
    const normalized = this.normalizeResponse(exception, httpStatus);
    const user = (request as Request & { user?: AuthenticatedUser } | undefined)?.user;

    response?.setHeader("x-trace-id", traceId ?? "");
    this.logger.error(
      {
        traceId,
        err: exception,
        statusCode: httpStatus,
        path: request?.url,
        method: request?.method,
        error: normalized.error,
      },
      "Request failed",
    );

    try {
      this.exceptionEvents.record({
        kind: "http",
        traceId: traceId ?? "",
        orgId: user?.orgId,
        userId: user?.id,
        statusCode: httpStatus,
        message: normalized.message,
        path: request?.url,
        method: request?.method,
        errorName: exception instanceof Error ? exception.name : undefined,
        stack: exception instanceof Error ? exception.stack : undefined
      });
    } catch {
      // ignore failures in error side-channel
    }

    response?.status(httpStatus).json({
      ...normalized,
      traceId,
      path: request?.url,
      timestamp: new Date().toISOString(),
    });
  }

  private handleGraphqlException(
    exception: unknown,
    host: ArgumentsHost,
    traceId?: string,
  ) {
    const gqlHost = GqlArgumentsHost.create(host);
    const ctx = gqlHost.getContext<{ req?: Request; res?: Response }>();
    const info = gqlHost.getInfo();

    const statusCode = this.resolveStatus(exception);
    const normalized = this.normalizeResponse(exception, statusCode);
    const user = (ctx?.req as Request & { user?: AuthenticatedUser } | undefined)?.user;

    ctx?.res?.setHeader("x-trace-id", traceId ?? "");
    this.logger.error(
      {
        traceId,
        err: exception,
        statusCode,
        operation: info?.fieldName ?? info?.path?.key,
        operationName: ctx?.req?.body?.operationName,
      },
      "GraphQL request failed",
    );

    try {
      this.exceptionEvents.record({
        kind: "graphql",
        traceId: traceId ?? "",
        orgId: user?.orgId,
        userId: user?.id,
        statusCode,
        message: normalized.message,
        operation: info?.fieldName ?? String(info?.path?.key ?? ""),
        operationName: ctx?.req?.body?.operationName,
        errorName: exception instanceof Error ? exception.name : undefined,
        stack: exception instanceof Error ? exception.stack : undefined
      });
    } catch {
      // ignore failures in error side-channel
    }

    return new GraphQLError(normalized.message, {
      extensions: {
        code: this.resolveGraphqlCode(statusCode),
        http: { status: statusCode },
        traceId,
        ...(this.exposeErrorDetails &&
        exception instanceof Error &&
        !(exception instanceof HttpException)
          ? {
              originalError: {
                name: exception.name,
                message: exception.message,
                stack: exception.stack
              }
            }
          : {})
      },
    });
  }

  private resolveStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private normalizeResponse(
    exception: unknown,
    statusCode: number,
  ): NormalizedHttpResponse {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const error = this.getErrorFromResponse(response, statusCode);
      if (statusCode >= 500) {
        return {
          statusCode,
          message: "Internal server error",
          error
        };
      }

      const message =
        typeof response === "string"
          ? response
          : this.getMessageFromResponse(response) ?? exception.message;

      return {
        statusCode,
        message,
        error
      };
    }

    if (this.exposeErrorDetails && exception instanceof Error) {
      return {
        statusCode,
        message: exception.message || "Internal server error",
        error: {
          name: exception.name,
          message: exception.message,
          stack: exception.stack
        }
      };
    }

    return {
      statusCode,
      message: "Internal server error",
    };
  }

  private getErrorFromResponse(response: unknown, statusCode: number): string {
    if (typeof response === "object" && response !== null) {
      const maybeError = (response as { error?: unknown }).error;
      if (typeof maybeError === "string" && maybeError.trim().length > 0) {
        return maybeError;
      }
    }

    const statusName = HttpStatus[statusCode];
    if (typeof statusName === "string") {
      return statusName
        .split("_")
        .map((segment) => segment.charAt(0) + segment.slice(1).toLowerCase())
        .join(" ");
    }

    return statusCode >= 500 ? "Internal Server Error" : "Error";
  }

  private resolveGraphqlCode(statusCode: number): string {
    const statusName = HttpStatus[statusCode];
    if (typeof statusName === "string") {
      return statusName;
    }
    return "INTERNAL_SERVER_ERROR";
  }

  private getMessageFromResponse(response: unknown): string | undefined {
    if (typeof response !== "object" || response === null) {
      return undefined;
    }

    const maybeMessage = (response as { message?: unknown }).message;
    if (typeof maybeMessage === "string") {
      return maybeMessage;
    }

    if (Array.isArray(maybeMessage)) {
      return maybeMessage.filter((value) => typeof value === "string").join("; ");
    }

    return undefined;
  }
}
