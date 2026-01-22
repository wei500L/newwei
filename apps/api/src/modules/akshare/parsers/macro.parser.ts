import type { AkshareMacroParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint } from "./parser.interface";

/**
 * Parser for macroeconomic data with period field
 * Handles data with period-based timestamps (e.g., monthly, quarterly data)
 */
export class MacroParser extends BaseParser<AkshareMacroParserConfig> {
  readonly type = "macro";

  parse(config: AkshareMacroParserConfig, payload: unknown): ParsedDataPoint[] {
    const records = this.ensureArray(payload);
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;
      const recordedAt = this.parseDate(record[config.periodField]);

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
