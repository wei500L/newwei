import { ensureTraceId, runWithTraceId } from "@modular/utils";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const traceparent = req.headers["traceparent"] as string | undefined;
    const otelTraceId = traceparent?.split("-")?.[1];
    const traceId = ensureTraceId(
      (req.headers["x-trace-id"] as string | undefined) ??
        (req.headers["x-request-id"] as string | undefined) ??
        otelTraceId,
    );
    const normalizedTraceparent =
      traceparent ?? `00-${traceId}-0000000000000000-01`;
    res.setHeader("x-trace-id", traceId);
    res.setHeader("traceparent", normalizedTraceparent);
    (req as Request & { traceId?: string }).traceId = traceId;
    (res.locals as Record<string, unknown>).traceId = traceId;

    runWithTraceId(traceId, () => next());
  }
}
