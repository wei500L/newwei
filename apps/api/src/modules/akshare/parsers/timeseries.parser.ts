import type { AkshareTimeseriesParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for timeseries data with timestamp and value fields
 * Handles data with explicit timestamp field and multiple value columns
 */
export class TimeseriesParser extends BaseParser<AkshareTimeseriesParserConfig> {
  readonly type = "timeseries";

  parse(config: AkshareTimeseriesParserConfig, payload: unknown, context?: ParserContext): ParsedDataPoint[] {
    const records = this.ensureRecordArray(payload);
    this.assertFieldsExistInPayload(
      records,
      [config.timestampField, config.categoryField, ...config.valueFields.map((field) => field.field)],
      context
    );
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;
      const recordedAt = this.parseRequiredDate(
        this.getRequiredField(record, config.timestampField, context),
        config.timestampField,
        context
      );

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
          dataType: field.dataType ?? "price",
          sourceField,
          meta: record
        });
      }
    }

    return this.deduplicatePoints(points);
  }
}
