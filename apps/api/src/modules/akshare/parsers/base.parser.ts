import { CommonTimeZone, parseDateTime, toISODateString } from "@modular/utils";

import type { AkshareParserConfig } from "../akshare.types";

import type { IParser, ParsedDataPoint, ParserContext } from "./parser.interface";

/**
 * Abstract base class for Akshare parsers
 * Contains shared utility methods for data normalization and deduplication
 */
export abstract class BaseParser<TConfig extends AkshareParserConfig = AkshareParserConfig>
  implements IParser<TConfig>
{
  abstract readonly type: string;

  abstract parse(config: TConfig, payload: unknown, context?: ParserContext): ParsedDataPoint[];

  /**
   * Normalize a value to a number, handling various input formats
   * @param value Raw value from API response
   * @returns Normalized number or null if invalid
   */
  protected normalizeNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || trimmed === "--" || trimmed === "-" || trimmed === "NaN" || trimmed === "null") {
        return null;
      }
      const sanitized = trimmed.replace(/,/g, "").replace(/%/g, "");
      if (!sanitized) {
        return null;
      }
      const parsed = Number(sanitized);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  /**
   * Parse a date value from various formats
   * Handles ISO strings, compact time formats (HHMMSS, HHMM), and colon-separated times
   * @param value Raw date/time value
   * @returns Parsed Date object
   */
  protected parseDate(value: unknown): Date {
    return this.tryParseDate(value) ?? new Date();
  }

  /**
   * Parse a required date field and fail fast when the value is missing or invalid.
   * This prevents field drifts from silently falling back to the current time.
   */
  protected parseRequiredDate(value: unknown, fieldName: string, context?: ParserContext): Date {
    const parsed = this.tryParseDate(value);
    if (parsed) {
      return parsed;
    }

    const suffix = context?.slug ? ` for ${context.slug}` : "";
    throw new Error(`Invalid or missing date field "${fieldName}"${suffix}`);
  }

  private tryParseDate(value: unknown): Date | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      const compactHhmmssMatch = trimmed.match(/^(\d{2})(\d{2})(\d{2})$/);
      const compactHhmmMatch = trimmed.match(/^(\d{2})(\d{2})$/);
      const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      const match = compactHhmmssMatch ?? compactHhmmMatch ?? colonMatch;
      if (match) {
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = match.length > 3 && typeof match[3] === "string" ? Number(match[3]) : 0;
        if (
          Number.isInteger(hours) &&
          Number.isInteger(minutes) &&
          Number.isInteger(seconds) &&
          hours >= 0 &&
          hours <= 23 &&
          minutes >= 0 &&
          minutes <= 59 &&
          seconds >= 0 &&
          seconds <= 59
        ) {
          const todayShanghai = toISODateString(new Date(), CommonTimeZone.AsiaShanghai);
          const timestamp = `${todayShanghai} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(
            2,
            "0"
          )}:${String(seconds).padStart(2, "0")}`;
          const parsedIntraday = parseDateTime(timestamp, { timeZone: CommonTimeZone.AsiaShanghai });
          if (parsedIntraday) {
            return parsedIntraday;
          }
        }
      }
    }

    const parsed = parseDateTime(value, { timeZone: CommonTimeZone.UTC });
    if (parsed) {
      const year = parsed.getUTCFullYear();
      if (year >= 1000 && year <= 9999) {
        return parsed;
      }
    }
    return null;
  }

  /**
   * Parse a date from separate year, month, and optional day fields
   * @param input Object containing year, month, and optional day values
   * @returns Parsed Date object in UTC, or null if parsing fails
   */
  protected parseYearMonthDate(input: { year: unknown; month: unknown; day?: unknown }): Date | null {
    const year =
      typeof input.year === "number"
        ? input.year
        : typeof input.year === "string"
          ? Number(input.year.trim())
          : Number.NaN;
    const month =
      typeof input.month === "number"
        ? input.month
        : typeof input.month === "string"
          ? Number(input.month.trim())
          : Number.NaN;
    const day =
      input.day === undefined
        ? 1
        : typeof input.day === "number"
          ? input.day
          : typeof input.day === "string"
            ? Number(input.day.trim())
            : Number.NaN;

    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      year >= 1000 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    }

    if (Number.isFinite(year) && Number.isFinite(month)) {
      const parsed = this.parseDate(`${String(year)}-${String(month).padStart(2, "0")}-01`);
      // parseDate returns new Date() on failure, which we need to detect
      // A valid parsed date should have a year matching the input
      if (parsed.getUTCFullYear() === Math.floor(year)) {
        return parsed;
      }
    }

    return null;
  }

  /**
   * Deduplicate data points by timestamp and sourceField
   * @param points Array of parsed data points
   * @returns Deduplicated array of data points
   */
  protected deduplicatePoints(points: ParsedDataPoint[]): ParsedDataPoint[] {
    const seen = new Set<string>();
    return points.filter((point) => {
      const key = `${point.recordedAt.getTime()}|${point.sourceField}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Build source field name with optional category prefix
   * @param field Base field name
   * @param category Optional category value
   * @returns Source field string
   */
  protected buildSourceField(field: string, category?: unknown): string {
    return category ? `${category}:${field}` : field;
  }

  /**
   * Ensure payload is an array
   * @param payload Raw payload
   * @returns Array of records
   */
  protected ensureArray(payload: unknown): unknown[] {
    return Array.isArray(payload) ? payload : [];
  }

  /**
   * Ensure payload is an array of records.
   */
  protected ensureRecordArray(payload: unknown): Record<string, unknown>[] {
    if (Array.isArray(payload)) {
      return payload.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)
      );
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return [payload as Record<string, unknown>];
    }
    return [];
  }

  /**
   * Fail fast when a configured field disappears from the payload schema.
   */
  protected assertFieldsExistInPayload(
    records: Record<string, unknown>[],
    fields: Array<string | undefined>,
    context?: ParserContext
  ): void {
    if (records.length === 0) {
      return;
    }

    const missingFields = fields
      .filter((field): field is string => Boolean(field))
      .filter((field) => !records.some((record) => Object.prototype.hasOwnProperty.call(record, field)));

    if (missingFields.length === 0) {
      return;
    }

    const suffix = context?.slug ? ` for ${context.slug}` : "";
    throw new Error(`Missing configured field(s) in payload${suffix}: ${missingFields.join(", ")}`);
  }

  /**
   * Read a required record field.
   */
  protected getRequiredField(record: Record<string, unknown>, field: string, context?: ParserContext): unknown {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      return record[field];
    }

    const suffix = context?.slug ? ` for ${context.slug}` : "";
    throw new Error(`Missing required field "${field}" in payload record${suffix}`);
  }
}
