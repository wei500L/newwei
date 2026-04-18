import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";

import {
  SEARCH_TELEMETRY_EVENT_TYPES,
  SEARCH_TELEMETRY_KEY_PREFIX,
  SEARCH_TELEMETRY_RETENTION_SECONDS,
  SEARCH_TELEMETRY_SURFACES,
  type SearchTelemetryEventType,
  type SearchTelemetrySurface,
} from "./search-telemetry.constants";

export interface SearchTelemetrySummaryRequest {
  orgId: string;
  from: string;
  to: string;
  surface?: SearchTelemetrySurface;
}

export interface SearchTelemetryDailyPoint {
  date: string;
  totalEvents: number;
  events: Record<string, number>;
  surfaces: Record<string, number>;
}

export interface SearchTelemetrySummaryResponse {
  from: string;
  to: string;
  surface: SearchTelemetrySurface | "all";
  totals: {
    totalEvents: number;
    eventCounts: Record<string, number>;
    surfaceCounts: Record<string, number>;
    queryLengthBuckets: Record<string, number>;
    loadMoreVerticalCounts: Record<string, number>;
  };
  daily: SearchTelemetryDailyPoint[];
}

@Injectable()
export class SearchTelemetryService {
  constructor(private readonly cache: CacheService) {}

  async record(input: {
    orgId: string;
    eventType: SearchTelemetryEventType;
    surface?: SearchTelemetrySurface;
    vertical?: string;
    queryLength?: number;
  }) {
    const now = new Date();
    const metricKey = this.buildMetricKey(input.orgId, now);
    const fields: [string, number][] = [
      ["events.total", 1],
      [`events.${input.eventType}`, 1],
    ];

    if (input.surface) {
      fields.push([`surface.${input.surface}`, 1]);
    }
    if (input.vertical && input.eventType === "archive_load_more_click") {
      fields.push([`load_more.vertical.${input.vertical}`, 1]);
    }
    if (
      typeof input.queryLength === "number" &&
      Number.isFinite(input.queryLength)
    ) {
      fields.push([
        `query_length.${this.resolveQueryLengthBucket(input.queryLength)}`,
        1,
      ]);
    }

    try {
      await Promise.all(
        fields.map(([field, value]) =>
          this.cache.hincrby(metricKey, field, Math.max(0, Math.floor(value))),
        ),
      );
      await this.cache.expire(metricKey, SEARCH_TELEMETRY_RETENTION_SECONDS);
    } catch {
      // Keep telemetry endpoint non-blocking.
    }

    return { recorded: true };
  }

  async getSummary(
    input: SearchTelemetrySummaryRequest,
  ): Promise<SearchTelemetrySummaryResponse> {
    if (input.surface) {
      throw new Error(
        "surface filtering is not supported by the stored telemetry counters",
      );
    }

    const range = this.resolveDateRange(input.from, input.to);
    const dates = this.buildDateRange(range.from, range.to);
    const keys = dates.map((date) =>
      this.buildMetricKey(input.orgId, this.parseDateOnly(date)),
    );
    const rows = await Promise.all(keys.map((key) => this.cache.hgetall(key)));

    const totals = {
      totalEvents: 0,
      eventCounts: Object.fromEntries(
        SEARCH_TELEMETRY_EVENT_TYPES.map((eventType) => [eventType, 0]),
      ) as Record<string, number>,
      surfaceCounts: Object.fromEntries(
        SEARCH_TELEMETRY_SURFACES.map((surface) => [surface, 0]),
      ) as Record<string, number>,
      queryLengthBuckets: {} as Record<string, number>,
      loadMoreVerticalCounts: {} as Record<string, number>,
    };

    const daily = dates.map((date, index) => {
      const row = rows[index] ?? {};
      const events = Object.fromEntries(
        SEARCH_TELEMETRY_EVENT_TYPES.map((eventType) => [
          eventType,
          this.readFieldCount(row, `events.${eventType}`),
        ]),
      ) as Record<string, number>;
      const surfaces = Object.fromEntries(
        SEARCH_TELEMETRY_SURFACES.map((surface) => [
          surface,
          this.readFieldCount(row, `surface.${surface}`),
        ]),
      ) as Record<string, number>;
      const totalEvents = this.readFieldCount(row, "events.total");

      totals.totalEvents += totalEvents;
      for (const [eventType, count] of Object.entries(events)) {
        totals.eventCounts[eventType] =
          (totals.eventCounts[eventType] ?? 0) + count;
      }
      for (const [surface, count] of Object.entries(surfaces)) {
        totals.surfaceCounts[surface] =
          (totals.surfaceCounts[surface] ?? 0) + count;
      }
      for (const [field, raw] of Object.entries(row)) {
        const count = this.readRawCount(raw);
        if (field.startsWith("query_length.")) {
          const bucket = field.slice("query_length.".length);
          totals.queryLengthBuckets[bucket] =
            (totals.queryLengthBuckets[bucket] ?? 0) + count;
        }
        if (field.startsWith("load_more.vertical.")) {
          const vertical = field.slice("load_more.vertical.".length);
          totals.loadMoreVerticalCounts[vertical] =
            (totals.loadMoreVerticalCounts[vertical] ?? 0) + count;
        }
      }

      return {
        date,
        totalEvents,
        events,
        surfaces,
      } satisfies SearchTelemetryDailyPoint;
    });

    return {
      from: range.from,
      to: range.to,
      surface: input.surface ?? "all",
      totals,
      daily,
    };
  }

  private buildMetricKey(orgId: string, date: Date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${SEARCH_TELEMETRY_KEY_PREFIX}:${orgId}:${year}-${month}-${day}`;
  }

  private resolveQueryLengthBucket(length: number) {
    if (length <= 1) {
      return "len_00_01";
    }
    if (length <= 3) {
      return "len_02_03";
    }
    if (length <= 7) {
      return "len_04_07";
    }
    if (length <= 15) {
      return "len_08_15";
    }
    if (length <= 31) {
      return "len_16_31";
    }
    return "len_32_plus";
  }

  private resolveDateRange(from: string, to: string) {
    const fromDate = this.parseDateOnly(from);
    const toDate = this.parseDateOnly(to);
    if (fromDate.getTime() > toDate.getTime()) {
      throw new Error("from must be less than or equal to to");
    }
    const diffDays =
      Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
    if (diffDays > 31) {
      throw new Error("date range cannot exceed 31 days");
    }
    return {
      from: this.formatDateOnly(fromDate),
      to: this.formatDateOnly(toDate),
    };
  }

  private buildDateRange(from: string, to: string) {
    const values: string[] = [];
    const cursor = this.parseDateOnly(from);
    const end = this.parseDateOnly(to);
    while (cursor.getTime() <= end.getTime()) {
      values.push(this.formatDateOnly(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return values;
  }

  private parseDateOnly(value: string) {
    const normalized = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new Error("date must use YYYY-MM-DD");
    }

    const [yearPart, monthPart, dayPart] = normalized.split("-") as [
      string,
      string,
      string,
    ];
    const year = Number.parseInt(yearPart, 10);
    const month = Number.parseInt(monthPart, 10);
    const day = Number.parseInt(dayPart, 10);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day
    ) {
      throw new Error("invalid date");
    }
    return parsed;
  }

  private formatDateOnly(value: Date) {
    return value.toISOString().slice(0, 10);
  }

  private readFieldCount(
    row: Record<string, string>,
    field: string,
  ): number {
    return this.readRawCount(row[field]);
  }

  private readRawCount(value: string | number | undefined) {
    const parsed =
      typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
}
