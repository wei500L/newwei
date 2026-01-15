import type { AkshareYearMonthParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for data with separate year and month fields
 * Handles data where date is split across year, month, and optional day columns
 */
export class YearMonthParser extends BaseParser<AkshareYearMonthParserConfig> {
  readonly type = "yearMonth";

  parse(
    config: AkshareYearMonthParserConfig,
    payload: unknown,
    _context?: ParserContext
  ): ParsedDataPoint[] {
    const records = this.ensureArray(payload);
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;
      const recordedAt = this.parseYearMonthDate({
        year: record[config.yearField],
        month: record[config.monthField],
        day: config.dayField ? record[config.dayField] : undefined
      });

      // Skip records with invalid dates to prevent data corruption
      if (recordedAt === null) {
        continue;
      }

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
          dataType: field.dataType ?? "index",
          sourceField,
          meta: record
        });
      }
    }

    return this.deduplicatePoints(points);
  }
}
