import type { AkshareYearMonthParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for data with separate year and month fields
 * Handles data where date is split across year, month, and optional day columns
 */
export class YearMonthParser extends BaseParser<AkshareYearMonthParserConfig> {
  readonly type = "yearMonth";

  parse(config: AkshareYearMonthParserConfig, payload: unknown, context?: ParserContext): ParsedDataPoint[] {
    const records = this.ensureRecordArray(payload);
    this.assertFieldsExistInPayload(
      records,
      [config.yearField, config.monthField, config.dayField, config.categoryField, ...config.valueFields.map((field) => field.field)],
      context
    );
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;
      const recordedAt = this.parseYearMonthDate({
        year: this.getRequiredField(record, config.yearField, context),
        month: this.getRequiredField(record, config.monthField, context),
        day: config.dayField ? this.getRequiredField(record, config.dayField, context) : undefined
      });

      if (recordedAt === null) {
        const suffix = context?.slug ? ` for ${context.slug}` : "";
        throw new Error(
          `Invalid year/month date fields "${config.yearField}/${config.monthField}"${suffix}`
        );
      }

      for (const field of config.valueFields) {
        const category = config.categoryField ? this.getRequiredField(record, config.categoryField, context) : undefined;
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
