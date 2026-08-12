import type { AkshareMacroParserConfig } from "../akshare.types";

import { BaseParser } from "./base.parser";
import type { ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Parser for macroeconomic data with period field
 * Handles data with period-based timestamps (e.g., monthly, quarterly data)
 */
export class MacroParser extends BaseParser<AkshareMacroParserConfig> {
  readonly type = "macro";

  /**
   * Period fields are calendar dates (月份/季度/年份). Some upstream APIs
   * return a compact "YYYYMM" (e.g. "202401") which the shared date parser
   * would otherwise read as HHMMSS ("20:24:01 today"). Normalize it to a
   * full date here, where the value is known to be a period, so the generic
   * HHMMSS handling keeps priority for intraday time fields in other parsers.
   */
  private normalizeMacroPeriod(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    const match = trimmed.match(/^(1[89]|20|21)(\d{2})(0[1-9]|1[0-2])$/);
    if (!match) {
      return value;
    }
    return `${match[1]}${match[2]}-${match[3]}-01`;
  }

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
        this.normalizeMacroPeriod(
          this.getRequiredField(record, config.periodField, context),
        ),
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
