import type { AkshareYieldCurveParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for yield curve data with date and series fields
 * Handles data with multiple yield series (e.g., different maturities)
 */
export class YieldCurveParser extends BaseParser<AkshareYieldCurveParserConfig> {
  readonly type = "yieldCurve";

  parse(config: AkshareYieldCurveParserConfig, payload: unknown, context?: ParserContext): ParsedDataPoint[] {
    const records = this.ensureRecordArray(payload);
    this.assertFieldsExistInPayload(records, [config.dateField, ...config.seriesFields.map((field) => field.field)], context);
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;
      const recordedAt = this.parseRequiredDate(
        this.getRequiredField(record, config.dateField, context),
        config.dateField,
        context
      );

      for (const field of config.seriesFields) {
        const value = this.normalizeNumber(record[field.field]);

        if (value === null) {
          continue;
        }

        points.push({
          recordedAt,
          value,
          unit: field.unit ?? "%",
          dataType: field.dataType ?? "yield",
          sourceField: field.field,
          meta: record
        });
      }
    }

    // YieldCurve doesn't need deduplication as each series field is unique
    return this.deduplicatePoints(points);
  }
}
