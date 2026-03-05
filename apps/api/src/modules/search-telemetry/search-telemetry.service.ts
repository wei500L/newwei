import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";

import {
  SEARCH_TELEMETRY_KEY_PREFIX,
  SEARCH_TELEMETRY_RETENTION_SECONDS,
  type SearchTelemetryEventType,
  type SearchTelemetrySurface,
} from "./search-telemetry.constants";

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
    const fields: Array<[string, number]> = [
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
}
