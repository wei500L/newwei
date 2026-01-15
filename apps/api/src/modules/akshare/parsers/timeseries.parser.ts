import type { AkshareTimeseriesParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for timeseries data with timestamp and value fields
 * Handles data with explicit timestamp field and multiple value columns
 */
export class TimeseriesParser extends BaseParser<AkshareTimeseriesParserConfig> {
  readonly type = "timeseries";

  parse(
    config: AkshareTimeseriesParserConfig,
    payload: unknown,
    _context?: ParserContext
  ): ParsedDataPoint[] {
    const records = this.ensureArray(payload);
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;
      const timestampValue = record[config.timestampField];
      const recordedAt = this.parseDate(timestampValue);

      for (const field of config.valueFields) {
        const category = config.categoryField ? record[config.categoryField] : undefined;
        const sourceField = this.buildSourceField(field.field, category);
        const value = this.normalizeNumber(record[field.field]);

        if (value === null) {
          continue;
        }

        points.push({
          recordedAt,
          value,
          unit: field.unit,
          dataType: field.dataType ?? "price",
          sourceField,
          meta: record
        });
      }
    }

    return this.deduplicatePoints(points);
  }
}
