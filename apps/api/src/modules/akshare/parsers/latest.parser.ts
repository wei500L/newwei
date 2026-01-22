import type { AkshareLatestParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint } from "./parser.interface";

/**
 * Parser for latest/snapshot data
 * Handles data with optional timestamp field, uses current time if not present
 */
export class LatestParser extends BaseParser<AkshareLatestParserConfig> {
  readonly type = "latest";

  parse(config: AkshareLatestParserConfig, payload: unknown): ParsedDataPoint[] {
    const records = Array.isArray(payload) ? payload : [payload];
    const now = new Date();
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;

      for (const field of config.valueFields) {
        const timestamp =
          config.timestampField && record[config.timestampField]
            ? this.parseDate(record[config.timestampField])
            : now;
        const category = config.categoryField ? record[config.categoryField] : undefined;
        const sourceField = this.buildSourceField(field.field, category);

        points.push({
          recordedAt: timestamp,
          value: this.normalizeNumber(record[field.field]),
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
