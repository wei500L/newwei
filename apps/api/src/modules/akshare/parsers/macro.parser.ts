import type { AkshareMacroParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for macroeconomic data with period field
 * Handles data with period-based timestamps (e.g., monthly, quarterly data)
 */
export class MacroParser extends BaseParser<AkshareMacroParserConfig> {
  readonly type = "macro";

  parse(config: AkshareMacroParserConfig, payload: unknown, context?: ParserContext): ParsedDataPoint[] {
    const records = this.ensureRecordArray(payload);
    this.assertFieldsExistInPayload(
      records,
      [config.periodField, config.categoryField, ...config.valueFields.map((field) => field.field)],
      context
    );
    const points: ParsedDataPoint[] = [];

    for (const rawRecord of records) {
      const record = rawRecord as Record<string, unknown>;
      const recordedAt = this.parseRequiredDate(
        this.getRequiredField(record, config.periodField, context),
        config.periodField,
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
          dataType: field.dataType ?? "index",
          sourceField,
          meta: record
        });
      }
    }

    return this.deduplicatePoints(points);
  }
}
