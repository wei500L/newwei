import type { AkshareLatestParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for latest/snapshot data
 * Handles data with optional timestamp field, uses current time if not present
 */
export class LatestParser extends BaseParser<AkshareLatestParserConfig> {
  readonly type = "latest";

  parse(config: AkshareLatestParserConfig, payload: unknown, context?: ParserContext): ParsedDataPoint[] {
    const records = this.ensureRecordArray(payload);
    this.assertFieldsExistInPayload(
      records,
      [config.timestampField, config.categoryField, ...config.valueFields.map((field) => field.field)],
      context
    );
    const now = new Date();
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;

      for (const field of config.valueFields) {
        const timestamp =
          config.timestampField
            ? this.parseRequiredDate(this.getRequiredField(record, config.timestampField, context), config.timestampField, context)
            : now;
        const category = config.categoryField ? this.getRequiredField(record, config.categoryField, context) : undefined;
        const sourceField = this.buildSourceField(field.field, category);
        const value = this.normalizeNumber(record[field.field]);

        if (value === null) {
          continue;
        }

        points.push({
          recordedAt: timestamp,
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
