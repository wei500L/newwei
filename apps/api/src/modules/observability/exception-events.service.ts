import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";

export type ExceptionEventKind = "http" | "graphql" | "unknown";

export interface ExceptionEvent {
  id: string;
  kind: ExceptionEventKind;
  traceId: string;
  timestamp: string;
  statusCode?: number;
  message: string;
  path?: string;
  method?: string;
  operation?: string;
  operationName?: string;
  errorName?: string;
  stack?: string;
}

export interface ListExceptionEventsOptions {
  limit?: number;
  offset?: number;
}

export interface ListExceptionEventsResult {
  total: number;
  items: ExceptionEvent[];
}

type RecordExceptionEventInput = Omit<ExceptionEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

@Injectable()
export class ExceptionEventsService {
  private readonly maxItems = 200;
  private readonly events: ExceptionEvent[] = [];

  record(input: RecordExceptionEventInput) {
    const event: ExceptionEvent = {
      id: input.id ?? randomUUID(),
      kind: input.kind ?? "unknown",
      traceId: input.traceId ?? "",
      timestamp: input.timestamp ?? new Date().toISOString(),
      statusCode: input.statusCode,
      message: input.message ?? "Unknown error",
      path: input.path,
      method: input.method,
      operation: input.operation,
      operationName: input.operationName,
      errorName: input.errorName,
      stack: input.stack ? input.stack.slice(0, 8_000) : undefined
    };

    this.events.unshift(event);
    if (this.events.length > this.maxItems) {
      this.events.length = this.maxItems;
    }
  }

  list(options: ListExceptionEventsOptions = {}): ListExceptionEventsResult {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    return {
      total: this.events.length,
      items: this.events.slice(offset, offset + limit)
    };
  }
}

