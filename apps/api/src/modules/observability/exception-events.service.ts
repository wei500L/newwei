import { ExceptionEventModel } from "@modular/mongo";
import { redactSensitiveFields } from "@modular/utils";
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
  operationName?: string;
  messageContains?: string;
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
  operationName?: string;
  messageContains?: string;
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
  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

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
    const operationName = typeof options.operationName === "string" ? options.operationName.trim() : "";
    if (operationName) {
      filter.operationName = operationName;
    }
    const messageContains = typeof options.messageContains === "string" ? options.messageContains.trim() : "";
    if (messageContains) {
      filter.message = { $regex: this.escapeRegex(messageContains), $options: "i" };
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
        // _id DESC is the deterministic tiebreaker for equal timestamps; the
        // page/offset protocol and the result count are unchanged.
        .sort({ timestamp: -1, _id: -1 })
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
        message: redactSensitiveFields(item.message ?? "Unknown error"),
        path: item.path ?? undefined,
        method: item.method ?? undefined,
        operation: item.operation ?? undefined,
        operationName: item.operationName ?? undefined,
        errorName: item.errorName ?? undefined,
        stack: item.stack ? redactSensitiveFields(item.stack) : undefined
      }))
    };
  }

  async stats(options: ExceptionEventStatsOptions = {}): Promise<ExceptionEventStats> {
    const filter = this.buildFilter(options);

    // One aggregate replaces the previous countDocuments + two aggregates:
    // group by (UTC day, kind) first, then fold the compressed buckets into a
    // single row holding total plus two pushed arrays.
    const [grouped] = await ExceptionEventModel.aggregate<{
      total?: unknown;
      byKind?: { kind?: unknown; count?: unknown }[];
      byDay?: { date?: unknown; count?: unknown }[];
    }>([
      { $match: filter },
      {
        $group: {
          _id: {
            day: {
              $dateToString: {
                date: "$timestamp",
                format: "%Y-%m-%d",
                timezone: "UTC"
              }
            },
            kind: "$kind"
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$count" },
          byKind: { $push: { kind: "$_id.kind", count: "$count" } },
          byDay: { $push: { date: "$_id.day", count: "$count" } }
        }
      }
    ]);

    // byKind: merge the per-day counts, count DESC then kind ASC.
    const kindTotals = new Map<string, number>();
    for (const bucket of grouped?.byKind ?? []) {
      const kind = typeof bucket.kind === "string" ? bucket.kind : "unknown";
      kindTotals.set(kind, (kindTotals.get(kind) ?? 0) + Number(bucket.count ?? 0));
    }
    const byKind = Array.from(kindTotals.entries())
      .map(([kind, count]) => ({ kind: kind as ExceptionEventKind, count }))
      .sort((left, right) => {
        if (left.count !== right.count) {
          return right.count - left.count;
        }
        return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
      });

    // byDay: merge the per-kind counts, date DESC, at most 30 dates with data.
    const dayTotals = new Map<string, number>();
    for (const bucket of grouped?.byDay ?? []) {
      if (typeof bucket.date !== "string") {
        continue;
      }
      dayTotals.set(bucket.date, (dayTotals.get(bucket.date) ?? 0) + Number(bucket.count ?? 0));
    }
    const byDay = Array.from(dayTotals.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))
      .slice(0, 30);

    return {
      total: Number(grouped?.total ?? 0),
      byKind,
      byDay
    };
  }
}
