import type { AkshareParserConfig } from "../akshare.types";

/**
 * Parsed data point from Akshare API response
 */
export interface ParsedDataPoint {
  recordedAt: Date;
  value: number | null;
  unit?: string;
  dataType: string;
  sourceField: string;
  meta?: unknown;
}

/**
 * Context passed to parsers for logging and debugging
 */
export interface ParserContext {
  slug?: string;
}

/**
 * Parser interface for Akshare data parsing strategies
 * Each parser type implements this interface to handle specific data formats
 */
export interface IParser<TConfig extends AkshareParserConfig = AkshareParserConfig> {
  /**
   * The parser type identifier (e.g., "timeseries", "latest", "macro")
   */
  readonly type: string;

  /**
   * Parse raw API payload into normalized data points
   * @param config Parser configuration specific to this parser type
   * @param payload Raw API response payload
   * @param context Optional context for logging/debugging
   * @returns Array of parsed data points
   */
  parse(config: TConfig, payload: unknown, context?: ParserContext): ParsedDataPoint[];
}

/**
 * Type guard to check if a value is a valid parser
 */
export function isParser(value: unknown): value is IParser {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as IParser).type === "string" &&
    "parse" in value &&
    typeof (value as IParser).parse === "function"
  );
}
