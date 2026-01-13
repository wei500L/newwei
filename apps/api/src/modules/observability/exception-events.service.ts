import { ExceptionEventModel } from "@modular/mongo";
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
  orgId?: string;
  kind?: ExceptionEventKind;
  start?: string | Date;
  end?: string | Date;
}

export interface ListExceptionEventsResult {
  total: number;
  items: ExceptionEvent[];
}

export interface ExceptionEventStatsOptions {
  orgId?: string;
  kind?: ExceptionEventKind;
  start?: string | Date;
  end?: string | Date;
}

export interface ExceptionEventStats {
  total: number;
  byKind: { kind: ExceptionEventKind; count: number }[];
  byDay: { date: string; count: number }[];
}

type RecordExceptionEventInput = Omit<ExceptionEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
  orgId?: string;
  userId?: string;
};

@Injectable()
export class ExceptionEventsService {
  private parseDate(value?: string | Date) {
    if (!value) {
      return undefined;
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return undefined;
    }
    return date;
  }

  private buildFilter(options: ExceptionEventStatsOptions | ListExceptionEventsOptions) {
    const filter: Record<string, unknown> = {};
    if (options.orgId) {
      filter.orgId = options.orgId;
    }
    if (options.kind) {
      filter.kind = options.kind;
    }
    const start = this.parseDate(options.start);
    const end = this.parseDate(options.end);
    if (start || end) {
      filter.timestamp = {
        ...(start ? { $gte: start } : {}),
        ...(end ? { $lte: end } : {})
      };
    }
    return filter;
  }

  record(input: RecordExceptionEventInput) {
    const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
    const normalizedTimestamp = Number.isNaN(timestamp.getTime())
      ? new Date()
      : timestamp;
    const event: ExceptionEvent = {
      id: input.id ?? randomUUID(),
      kind: input.kind ?? "unknown",
      traceId: input.traceId ?? "",
      timestamp: normalizedTimestamp.toISOString(),
      statusCode: input.statusCode,
      message: input.message ?? "Unknown error",
      path: input.path,
      method: input.method,
      operation: input.operation,
      operationName: input.operationName,
      errorName: input.errorName,
      stack: input.stack ? input.stack.slice(0, 8_000) : undefined
    };

    void ExceptionEventModel.create({
      orgId: input.orgId,
      userId: input.userId,
      ...event,
      timestamp: normalizedTimestamp
    }).catch(() => undefined);
  }

  async list(options: ListExceptionEventsOptions = {}): Promise<ListExceptionEventsResult> {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const filter = this.buildFilter(options);
    const [total, items] = await Promise.all([
      ExceptionEventModel.countDocuments(filter),
      ExceptionEventModel.find(filter)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
    ]);
    return {
      total,
      items: items.map((item) => ({
        id: item.id ?? item._id?.toString(),
        kind: item.kind ?? "unknown",
        traceId: item.traceId ?? "",
        timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
        statusCode: item.statusCode ?? undefined,
        message: item.message ?? "Unknown error",
        path: item.path ?? undefined,
        method: item.method ?? undefined,
        operation: item.operation ?? undefined,
        operationName: item.operationName ?? undefined,
        errorName: item.errorName ?? undefined,
        stack: item.stack ?? undefined
      }))
    };
  }

  async stats(options: ExceptionEventStatsOptions = {}): Promise<ExceptionEventStats> {
    const filter = this.buildFilter(options);
    const [total, byKind, byDay] = await Promise.all([
      ExceptionEventModel.countDocuments(filter),
      ExceptionEventModel.aggregate([
        { $match: filter },
        { $group: { _id: "$kind", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      ExceptionEventModel.aggregate([
        { $match: filter },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$timestamp",
                format: "%Y-%m-%d",
                timezone: "UTC"
              }
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: -1 } },
        { $limit: 30 }
      ])
    ]);

    return {
      total,
      byKind: byKind.map((item) => ({
        kind: (item._id as ExceptionEventKind) ?? "unknown",
        count: item.count ?? 0
      })),
      byDay: byDay.map((item) => ({
        date: item._id as string,
        count: item.count ?? 0
      }))
    };
  }
}
